// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Error returned when `splice_file` is given an `expected` fingerprint that no
/// longer matches the file on disk. Managed as a constant because the frontend
/// keys its conflict warning off this exact string (protocol value, not prose).
pub const FINGERPRINT_MISMATCH: &str = "fingerprint-mismatch";

/// Streaming copy buffer size (1 MiB): large enough to keep syscall overhead low,
/// small enough that a splice never holds a meaningful fraction of the file in RAM.
const SPLICE_BUF: usize = 1024 * 1024;

/// Hard defensive ceiling on a single `read_range` request (64 MiB). The product
/// caps range editing at 32 MiB in the frontend; this backstop only prevents a bad
/// call from allocating an unbounded buffer.
const READ_RANGE_MAX: u64 = 64 * 1024 * 1024;

/// A byte slice decoded as text plus whether the decode was lossy. `lossy` is
/// true when the bytes were not valid UTF-8 and replacement characters were
/// substituted, so the frontend can refuse to open a would-corrupt edit tab.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReadRange {
  pub text: String,
  pub lossy: bool,
}

/// Cheap identity of a file's on-disk state, used to detect out-of-band edits
/// between reading a range and writing it back. `mtime_ms` is milliseconds since
/// the Unix epoch so it compares cleanly across platforms.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fingerprint {
  pub size: u64,
  pub mtime_ms: u64,
}

/// Modification time in milliseconds since the Unix epoch. Filesystems that do not
/// expose an mtime (or report one before the epoch) degrade to 0 rather than
/// failing, so a splice can still proceed on such volumes.
fn mtime_ms(meta: &fs::Metadata) -> u64 {
  meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Read a file's fingerprint from its metadata.
fn fingerprint_of(path: &Path) -> Result<Fingerprint, String> {
  let meta = fs::metadata(path).map_err(|e| e.to_string())?;
  Ok(Fingerprint {
    size: meta.len(),
    mtime_ms: mtime_ms(&meta),
  })
}

/// Copy exactly `n` bytes from `reader` to `writer` through `buf`. Errors if the
/// reader hits EOF before `n` bytes are produced.
fn copy_exact<R: Read, W: Write>(
  reader: &mut R,
  writer: &mut W,
  mut n: u64,
  buf: &mut [u8],
) -> Result<(), String> {
  while n > 0 {
    let want = n.min(buf.len() as u64) as usize;
    let got = reader.read(&mut buf[..want]).map_err(|e| e.to_string())?;
    if got == 0 {
      return Err("unexpected EOF while copying range".to_string());
    }
    writer.write_all(&buf[..got]).map_err(|e| e.to_string())?;
    n -= got as u64;
  }
  Ok(())
}

/// Stream the spliced file into `tmp`: original `[0, start)`, then `replacement`,
/// then original `[end, EOF)`. Never loads the whole file into memory, and fsyncs
/// the temp file. Putting it in `src`'s place is `fs_ops::replace_with`'s job.
fn perform_splice(
  src: &Path,
  out: &mut File,
  start: u64,
  end: u64,
  replacement: &[u8],
) -> Result<(), String> {
  let mut source = File::open(src).map_err(|e| e.to_string())?;
  let mut buf = vec![0u8; SPLICE_BUF];
  copy_exact(&mut source, out, start, &mut buf)?;
  out.write_all(replacement).map_err(|e| e.to_string())?;
  source
    .seek(SeekFrom::Start(end))
    .map_err(|e| e.to_string())?;
  io::copy(&mut source, out).map_err(|e| e.to_string())?;
  // fsync the data before swapping it in so a crash can't leave a truncated file.
  // ponytail: file-level fsync only; the parent-dir fsync for full rename
  // durability is skipped here, unlike the atomic-write path in fs_ops.
  out.sync_all().map_err(|e| e.to_string())
}

/// Run `perform_splice` and remove the temp file if it fails, so a failed splice
/// never leaves a partial file behind. Past that point the temp is complete and
/// `fs_ops::replace_with` owns it.
fn splice_write(
  src: &Path,
  label: &str,
  start: u64,
  end: u64,
  replacement: &[u8],
) -> Result<(), String> {
  // Through `fs_ops::replace_with` so this writer answers a sandboxed folder and
  // a linked destination the same way every other one does. Exclusive: if two
  // splices of one file ever race onto the same staged name (the nanos suffix
  // in `label` is not unique on coarse clocks), fail loudly instead of quietly
  // truncating the other writer's file.
  crate::fs_ops::replace_with(src, label, true, None, |out| {
    perform_splice(src, out, start, end, replacement)
  })
}

/// Splice `[start, end)` of `path` with `replacement`. `start`/`end` are byte
/// offsets that the caller guarantees fall on UTF-8 character boundaries; this
/// layer does not validate the file's encoding (the frontend guarantees the
/// replacement bytes keep the file's encoding consistent). `start == end` is a
/// pure insertion; an empty `replacement` is a pure deletion. Returns the
/// fingerprint of the rewritten file so the caller can rebase its range view.
fn splice_at(
  path: &Path,
  start: u64,
  end: u64,
  replacement: &str,
  expected: Option<Fingerprint>,
) -> Result<Fingerprint, String> {
  let meta = fs::metadata(path).map_err(|e| e.to_string())?;
  let size = meta.len();
  if start > end || end > size {
    return Err("range out of bounds".to_string());
  }
  if let Some(exp) = expected {
    let current = Fingerprint {
      size,
      mtime_ms: mtime_ms(&meta),
    };
    if current != exp {
      return Err(FINGERPRINT_MISMATCH.to_string());
    }
  }
  // `fs_ops::stage` puts the replacement in the same directory so the final
  // rename stays on one filesystem (and is therefore atomic), and validates the
  // path. The nanosecond label makes staged names distinct across runs but is
  // not a uniqueness guarantee on coarse clocks; staging exclusively turns any
  // residual collision into a clean error.
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  splice_write(
    path,
    &format!(".splice-{nanos}"),
    start,
    end,
    replacement.as_bytes(),
  )?;
  fingerprint_of(path)
}

/// Read `[start, end)` of `path` as text, for seeding a range-edit view. Reports
/// whether the decode was lossy (invalid UTF-8 replaced) so the caller can refuse
/// an edit tab that would corrupt the file on write-back. Rejects ranges larger
/// than `READ_RANGE_MAX` as a defensive backstop.
fn read_range_at(path: &Path, start: u64, end: u64) -> Result<ReadRange, String> {
  let meta = fs::metadata(path).map_err(|e| e.to_string())?;
  let size = meta.len();
  if start > end || end > size {
    return Err("range out of bounds".to_string());
  }
  let len = end - start;
  if len > READ_RANGE_MAX {
    return Err("range exceeds maximum readable size".to_string());
  }
  let mut file = File::open(path).map_err(|e| e.to_string())?;
  file
    .seek(SeekFrom::Start(start))
    .map_err(|e| e.to_string())?;
  let mut buf = vec![0u8; len as usize];
  file.read_exact(&mut buf).map_err(|e| e.to_string())?;
  let (text, lossy) = match String::from_utf8(buf) {
    Ok(s) => (s, false),
    Err(e) => (String::from_utf8_lossy(&e.into_bytes()).into_owned(), true),
  };
  Ok(ReadRange { text, lossy })
}

/// Stream `[start, end)` of `src` into `tmp` and fsync it. Putting it in the
/// destination's place is `fs_ops::replace_with`'s job.
fn perform_copy_range(src: &Path, start: u64, end: u64, out: &mut File) -> Result<(), String> {
  let mut source = File::open(src).map_err(|e| e.to_string())?;
  source
    .seek(SeekFrom::Start(start))
    .map_err(|e| e.to_string())?;
  let mut buf = vec![0u8; SPLICE_BUF];
  copy_exact(&mut source, out, end - start, &mut buf)?;
  // fsync the data before swapping it in so a crash can't leave a truncated file.
  out.sync_all().map_err(|e| e.to_string())
}

/// Run `perform_copy_range` and remove the temp file if it fails, so a failed
/// copy never leaves a partial file behind or truncates an existing `dest`. Past
/// that point the temp is complete and `fs_ops::replace_with` owns it.
fn copy_range_write(
  src: &Path,
  start: u64,
  end: u64,
  label: &str,
  dest: &Path,
) -> Result<(), String> {
  crate::fs_ops::replace_with(dest, label, true, None, |out| {
    perform_copy_range(src, start, end, out)
  })
}

/// Stream `[start, end)` of `src` verbatim into `dest`. Byte-for-byte faithful
/// (no decode), so a "save range" preserves the original bytes even when they
/// are not valid UTF-8. Never loads the whole slice into memory. Writes through
/// a temp file beside `dest` and renames it into place, so a failure part-way
/// through (disk full, source shrinking under us, an I/O error) never leaves an
/// existing `dest` truncated in place.
fn copy_range_to(src: &Path, start: u64, end: u64, dest: &Path) -> Result<(), String> {
  let meta = fs::metadata(src).map_err(|e| e.to_string())?;
  let size = meta.len();
  if start > end || end > size {
    return Err("range out of bounds".to_string());
  }
  // Same staging convention as `splice_at`: same directory (so the rename stays
  // on one filesystem), nanosecond label, exclusive so a residual collision is a
  // clean error instead of silent corruption.
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  copy_range_write(src, start, end, &format!(".copy-{nanos}"), dest)
}

#[tauri::command]
pub fn file_fingerprint(path: String) -> Result<Fingerprint, String> {
  fingerprint_of(Path::new(&path))
}

#[tauri::command(async)]
pub fn splice_file(
  path: String,
  start: u64,
  end: u64,
  replacement: String,
  expected: Option<Fingerprint>,
) -> Result<Fingerprint, String> {
  splice_at(Path::new(&path), start, end, &replacement, expected)
}

#[tauri::command(async)]
pub fn read_range(path: String, start: u64, end: u64) -> Result<ReadRange, String> {
  read_range_at(Path::new(&path), start, end)
}

#[tauri::command(async)]
pub fn copy_range(path: String, start: u64, end: u64, dest: String) -> Result<(), String> {
  copy_range_to(Path::new(&path), start, end, Path::new(&dest))
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  /// Write `content` to a fresh file in `dir` and return its path.
  fn write_file(dir: &Path, name: &str, content: &[u8]) -> std::path::PathBuf {
    let path = dir.join(name);
    fs::write(&path, content).unwrap();
    path
  }

  /// Assert no leftover `.tmp` splice temp files remain in `dir`.
  fn assert_no_temp(dir: &Path) {
    let leftovers: Vec<_> = fs::read_dir(dir)
      .unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
      .collect();
    assert!(leftovers.is_empty(), "temp files left behind");
  }

  #[test]
  fn splice_head_range() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"HELLO world");
    splice_at(&path, 0, 5, "hi", None).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"hi world");
    assert_no_temp(dir.path());
  }

  #[test]
  fn splice_tail_range() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"hello WORLD");
    splice_at(&path, 6, 11, "there", None).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"hello there");
  }

  #[test]
  fn splice_middle_range() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abcXYZdef");
    splice_at(&path, 3, 6, "123", None).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"abc123def");
  }

  #[test]
  fn splice_pure_insertion_when_start_equals_end() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abcdef");
    splice_at(&path, 3, 3, "___", None).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"abc___def");
  }

  #[test]
  fn splice_pure_deletion_with_empty_replacement() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abcXYZdef");
    splice_at(&path, 3, 6, "", None).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"abcdef");
  }

  #[test]
  fn splice_whole_file_replacement() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"old content");
    let size = fs::metadata(&path).unwrap().len();
    splice_at(&path, 0, size, "brand new", None).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"brand new");
  }

  #[test]
  fn splice_rejects_start_after_end() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abcdef");
    assert!(splice_at(&path, 4, 2, "x", None).is_err());
    // File is untouched after a rejected splice.
    assert_eq!(fs::read(&path).unwrap(), b"abcdef");
  }

  #[test]
  fn splice_rejects_end_past_size() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abcdef");
    assert!(splice_at(&path, 0, 100, "x", None).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"abcdef");
  }

  #[test]
  fn splice_passes_with_matching_fingerprint() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abcdef");
    let fp = fingerprint_of(&path).unwrap();
    splice_at(&path, 0, 3, "XYZ", Some(fp)).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"XYZdef");
  }

  #[test]
  fn splice_rejects_changed_size_fingerprint() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abcdef");
    let mut fp = fingerprint_of(&path).unwrap();
    fp.size += 1;
    let err = splice_at(&path, 0, 3, "XYZ", Some(fp)).unwrap_err();
    assert_eq!(err, FINGERPRINT_MISMATCH);
    assert_eq!(fs::read(&path).unwrap(), b"abcdef");
  }

  #[test]
  fn splice_rejects_changed_mtime_fingerprint() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abcdef");
    let mut fp = fingerprint_of(&path).unwrap();
    // A different mtime with the same size still counts as an out-of-band edit.
    fp.mtime_ms = fp.mtime_ms.wrapping_add(1000);
    let err = splice_at(&path, 0, 3, "XYZ", Some(fp)).unwrap_err();
    assert_eq!(err, FINGERPRINT_MISMATCH);
  }

  #[test]
  fn splice_skips_check_when_expected_is_none() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abcdef");
    // No fingerprint supplied: the check is skipped even though the file could
    // have changed since it was read.
    splice_at(&path, 0, 3, "XYZ", None).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"XYZdef");
  }

  #[test]
  fn splice_large_file_leaves_surrounding_bytes_intact() {
    let dir = tempdir().unwrap();
    // ~8 MiB of a repeating pattern spanning many copy buffers.
    let mut content = Vec::with_capacity(8 * 1024 * 1024);
    for i in 0..(8 * 1024 * 1024u64) {
      content.push((i % 251) as u8);
    }
    let path = write_file(dir.path(), "big.bin", &content);
    let start = 3 * 1024 * 1024u64;
    let end = 5 * 1024 * 1024u64;
    splice_at(&path, start, end, "MID", None).unwrap();
    let result = fs::read(&path).unwrap();
    // Prefix and suffix bytes must be byte-for-byte unchanged.
    assert_eq!(&result[..start as usize], &content[..start as usize]);
    assert_eq!(&result[start as usize..start as usize + 3], b"MID");
    assert_eq!(&result[start as usize + 3..], &content[end as usize..]);
  }

  #[test]
  fn splice_cleans_up_temp_on_failure() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abc");
    // `start` past EOF forces `copy_exact` to fail mid-stream (bypassing the
    // outer validation), exercising the cleanup path directly.
    let result = splice_write(&path, ".splice-test", 10, 10, b"x");
    assert!(result.is_err());
    assert!(!dir.path().join(".f.txt.splice-test.tmp").exists());
    assert_no_temp(dir.path());
  }

  /// The second writer must carry metadata over too; `fs_ops` doing it alone
  /// would mean an attribute survives one kind of save and not the other.
  #[cfg(unix)]
  #[test]
  fn splice_carries_over_extended_attributes() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"HELLO world");
    crate::fs_ops::set_test_xattr(&path, "user.note_n_pad_test", b"kept");

    splice_at(&path, 0, 5, "hi", None).unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"hi world");
    assert_eq!(
      crate::fs_ops::read_test_xattr(&path, "user.note_n_pad_test").as_deref(),
      Some(b"kept".as_slice()),
      "the attribute must survive the edit"
    );
  }

  #[test]
  fn splice_keeps_a_symlink_pointing_at_its_target() {
    // Renaming a temp over the link itself would leave the real file holding
    // the pre-edit bytes and the link gone.
    let dir = tempdir().unwrap();
    let real = write_file(dir.path(), "real.txt", b"HELLO world");
    let link = dir.path().join("link.txt");
    if !crate::fs_ops::linktest::symlink(&real, &link) {
      return; // this platform will not make one for us
    }

    splice_at(&link, 0, 5, "hi", None).unwrap();

    assert!(
      fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink(),
      "the link must still be a link"
    );
    assert_eq!(
      fs::read(&real).unwrap(),
      b"hi world",
      "the target was edited"
    );
    assert_no_temp(dir.path());
  }

  #[test]
  fn splice_keeps_a_hard_link_shared() {
    let dir = tempdir().unwrap();
    let a = write_file(dir.path(), "a.txt", b"HELLO world");
    let b = dir.path().join("b.txt");
    fs::hard_link(&a, &b).unwrap();

    splice_at(&a, 0, 5, "hi", None).unwrap();

    assert_eq!(
      crate::fs_ops::linktest::links(&a),
      2,
      "the two names must still share one file"
    );
    assert_eq!(
      fs::read(&b).unwrap(),
      b"hi world",
      "the other link sees the edit"
    );
    assert_no_temp(dir.path());
  }

  #[test]
  fn read_range_extracts_slice() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abcdefghij");
    let out = read_range_at(&path, 2, 6).unwrap();
    assert_eq!(out.text, "cdef");
    assert!(!out.lossy);
  }

  #[test]
  fn read_range_rejects_over_size() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "f.txt", b"abc");
    assert!(read_range_at(&path, 0, 100).is_err());
  }

  #[test]
  fn read_range_flags_valid_utf8_as_not_lossy() {
    let dir = tempdir().unwrap();
    // Multi-byte UTF-8 that decodes cleanly must not be flagged lossy.
    let path = write_file(dir.path(), "f.txt", "héllo".as_bytes());
    let out = read_range_at(&path, 0, "héllo".len() as u64).unwrap();
    assert_eq!(out.text, "héllo");
    assert!(!out.lossy);
  }

  #[test]
  fn read_range_decodes_lossily_and_flags_it() {
    let dir = tempdir().unwrap();
    // A lone 0xFF is invalid UTF-8; lossy decode replaces it and sets the flag.
    let path = write_file(dir.path(), "f.bin", &[0x61, 0xFF, 0x62]);
    let out = read_range_at(&path, 0, 3).unwrap();
    assert!(out.text.starts_with('a') && out.text.ends_with('b'));
    assert!(out.text.contains(char::REPLACEMENT_CHARACTER));
    assert!(out.lossy);
  }

  #[test]
  fn copy_range_keeps_a_symlink_pointing_at_its_target() {
    // The rename path would replace the link itself, leaving the real file
    // untouched and the link gone — the same defect `fs_ops` already avoids.
    let dir = tempdir().unwrap();
    let src = write_file(dir.path(), "src.bin", b"abcdef");
    let real = write_file(dir.path(), "real.bin", b"old");
    let link = dir.path().join("link.bin");
    if !crate::fs_ops::linktest::symlink(&real, &link) {
      return; // this platform will not make one for us
    }

    copy_range_to(&src, 1, 4, &link).unwrap();

    assert!(
      fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink(),
      "the link must still be a link"
    );
    assert_eq!(
      fs::read(&real).unwrap(),
      b"bcd",
      "the target must carry the bytes"
    );
  }

  #[test]
  fn copy_range_keeps_a_hard_link_shared() {
    let dir = tempdir().unwrap();
    let src = write_file(dir.path(), "src.bin", b"abcdef");
    let a = write_file(dir.path(), "a.bin", b"old");
    let b = dir.path().join("b.bin");
    fs::hard_link(&a, &b).unwrap();

    copy_range_to(&src, 1, 4, &a).unwrap();

    assert_eq!(
      crate::fs_ops::linktest::links(&a),
      2,
      "the two names must still share one file"
    );
    assert_eq!(
      fs::read(&b).unwrap(),
      b"bcd",
      "the other link sees the write"
    );
  }

  #[test]
  fn copy_range_writes_bytes_verbatim() {
    let dir = tempdir().unwrap();
    // Invalid UTF-8 bytes must survive the copy unchanged (byte-faithful).
    let path = write_file(dir.path(), "src.bin", &[0x61, 0xFF, 0x62, 0xFE, 0x63]);
    let dest = dir.path().join("out.bin");
    copy_range_to(&path, 1, 4, &dest).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), &[0xFF, 0x62, 0xFE]);
  }

  #[test]
  fn copy_range_rejects_end_past_size() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "src.txt", b"abc");
    let dest = dir.path().join("out.txt");
    assert!(copy_range_to(&path, 0, 100, &dest).is_err());
  }

  #[test]
  fn copy_range_replaces_existing_destination_contents() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "src.txt", b"HELLO world");
    // dest already exists with unrelated, longer content.
    let dest = write_file(
      dir.path(),
      "out.txt",
      b"stale previous contents, much longer",
    );
    copy_range_to(&path, 6, 11, &dest).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"world");
    assert_no_temp(dir.path());
  }

  #[test]
  fn copy_range_failure_mid_copy_leaves_existing_destination_intact() {
    let dir = tempdir().unwrap();
    // Source has only 10 bytes; requesting 20 forces `copy_exact` to write a
    // short first chunk into the temp file and then hit EOF on the next read,
    // a genuine mid-copy abort rather than a failure before the first byte.
    let path = write_file(dir.path(), "src.txt", b"abcdefghij");
    let dest = write_file(dir.path(), "out.txt", b"original destination contents");
    let result = copy_range_write(&path, 0, 20, ".copy-test", &dest);
    assert!(result.is_err());
    assert_eq!(fs::read(&dest).unwrap(), b"original destination contents");
  }

  #[test]
  fn copy_range_cleans_up_temp_on_failure() {
    let dir = tempdir().unwrap();
    let path = write_file(dir.path(), "src.txt", b"abcdefghij");
    let dest = dir.path().join("out.txt");
    let result = copy_range_write(&path, 0, 20, ".copy-test", &dest);
    assert!(result.is_err());
    assert!(!dir.path().join(".out.txt.copy-test.tmp").exists());
    assert_no_temp(dir.path());
  }
}

/// Guards the broader "heavy file I/O must not run on the UI thread" rule (see
/// the doc comment on `windows.rs`'s window-builder rule, which this extends).
/// Same technique as `window_command_threading_tests` in `windows.rs`: reads its
/// own source text and asserts each listed command is `#[tauri::command(async)]`,
/// since a blocking one would run splice/copy I/O proportional to file size on
/// the main thread and freeze every window's repaint until it finishes.
#[cfg(test)]
mod heavy_io_command_threading_tests {
  const SOURCE: &str = include_str!("range_edit.rs");
  const MUST_RUN_OFF_THE_MAIN_THREAD: &[&str] = &["splice_file", "read_range", "copy_range"];

  #[test]
  fn every_heavy_io_command_is_async() {
    for name in MUST_RUN_OFF_THE_MAIN_THREAD {
      let needle = format!("pub fn {name}");
      let at = SOURCE
        .find(&needle)
        .unwrap_or_else(|| panic!("{name} is listed here but no longer exists in range_edit.rs"));
      let attribute = SOURCE[..at].trim_end();
      assert!(
        attribute.ends_with("#[tauri::command(async)]"),
        "{name} must be #[tauri::command(async)]: a blocking command doing \
         O(file size) work freezes repaint on every window while it runs"
      );
    }
  }

  #[test]
  fn the_guard_would_notice_a_dropped_async() {
    // Proves the assertion above can fail, against a command not in the list.
    let at = SOURCE
      .find("pub fn file_fingerprint")
      .expect("file_fingerprint");
    let attribute = SOURCE[..at].trim_end();
    assert!(attribute.ends_with("#[tauri::command]"));
    assert!(!attribute.ends_with("#[tauri::command(async)]"));
  }
}
