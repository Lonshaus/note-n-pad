// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Upper bound on a single `read_chunk` request (4 MiB) so a bad `len` can't ask
/// the backend to allocate an unbounded buffer.
const MAX_CHUNK_LEN: u32 = 4 * 1024 * 1024;
/// Byte window the search thread reads per iteration. Large relative to any sane
/// query so a match can straddle at most one chunk boundary.
const SEARCH_CHUNK: usize = 256 * 1024;
/// Emit an index-progress event at most once per this many bytes scanned.
const INDEX_PROGRESS_BYTES: u64 = 4 * 1024 * 1024;
/// Preview length (in characters) for a search hit's line.
const PREVIEW_CHARS: usize = 200;

/// Managed state holding in-flight line indexes and cancellable searches.
#[derive(Default)]
pub struct LargeFileState {
  indexes: Mutex<HashMap<String, LineIndex>>,
  searches: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// A byte-offset index over a file's lines. Checkpoints are `(line, byte offset
/// of that line's start)` recorded every `interval` lines, always seeded with
/// `(0, 0)`. `total_lines` is `None` until the background scan completes.
struct LineIndex {
  path: PathBuf,
  checkpoints: Vec<(u64, u64)>,
  total_lines: Option<u64>,
}

#[derive(Serialize)]
pub struct FileStat {
  pub size: u64,
}

#[derive(Serialize)]
pub struct Chunk {
  pub text: String,
  pub start: u64,
  pub end: u64,
}

#[derive(Clone, Serialize)]
struct IndexProgress {
  id: String,
  lines: u64,
  bytes: u64,
  done: bool,
  /// `true` only on the terminal event of a scan that failed (open error or a
  /// mid-scan I/O error). `false` on every progress event and on a successful
  /// terminal event.
  error: bool,
}

#[derive(Clone, Serialize)]
struct SearchHit {
  search_id: String,
  offset: u64,
  line: u64,
  preview: String,
}

#[derive(Clone, Serialize)]
struct SearchDone {
  search_id: String,
  hits: u64,
  truncated: bool,
  /// `true` when the scan failed (open error or a mid-scan I/O error) instead
  /// of finishing normally; `hits` is then meaningless and must not be read as
  /// "0 matches found".
  error: bool,
}

/// A single search match: absolute byte offset, line number, and a preview of the
/// matched line.
struct Hit {
  offset: u64,
  line: u64,
  preview: String,
}

/// Return whether a byte is a UTF-8 continuation byte (`10xxxxxx`).
fn is_continuation(b: u8) -> bool {
  (b & 0xC0) == 0x80
}

/// Align a raw byte slice read at `offset` to UTF-8 character boundaries. Leading
/// continuation bytes (a character that began before `offset`) are dropped so
/// `start` moves forward; a trailing incomplete-but-valid sequence (a character
/// cut by the read window) is dropped so `end` moves back. Genuinely invalid
/// bytes in between are replaced lossily rather than trimmed.
fn align_chunk(bytes: &[u8], offset: u64) -> Chunk {
  // A UTF-8 character is at most 4 bytes, so at most 3 leading continuations.
  let lead = bytes
    .iter()
    .take(3)
    .take_while(|&&b| is_continuation(b))
    .count();
  let body = &bytes[lead..];
  let start = offset + lead as u64;
  let trailing = incomplete_trailing_len(body);
  let usable = &body[..body.len() - trailing];
  let end = start + usable.len() as u64;
  Chunk {
    text: String::from_utf8_lossy(usable).into_owned(),
    start,
    end,
  }
}

/// Number of trailing bytes that form an incomplete-but-otherwise-valid UTF-8
/// sequence (a multi-byte character cut off at the end of the buffer). Returns 0
/// when the slice ends on a boundary or ends with genuinely invalid bytes (those
/// are left for lossy replacement instead of being trimmed).
fn incomplete_trailing_len(b: &[u8]) -> usize {
  match std::str::from_utf8(b) {
    Ok(_) => 0,
    Err(e) => match e.error_len() {
      // `None` means "unexpected end of input": the tail is a valid prefix
      // of a character, so trim it back to the last full boundary.
      None => b.len() - e.valid_up_to(),
      // `Some` means an invalid byte mid-buffer; leave it for lossy decode.
      Some(_) => 0,
    },
  }
}

/// Read the file's size.
fn stat(path: &Path) -> Result<FileStat, String> {
  let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
  Ok(FileStat { size: meta.len() })
}

/// Read up to `len` bytes from `offset` and return them as boundary-aligned text.
fn read_chunk_at(path: &Path, offset: u64, len: u32) -> Result<Chunk, String> {
  let len = len.min(MAX_CHUNK_LEN) as u64;
  let mut file = File::open(path).map_err(|e| e.to_string())?;
  file
    .seek(SeekFrom::Start(offset))
    .map_err(|e| e.to_string())?;
  let mut buf = Vec::new();
  file
    .take(len)
    .read_to_end(&mut buf)
    .map_err(|e| e.to_string())?;
  Ok(align_chunk(&buf, offset))
}

/// Scan a reader into a line index, invoking `progress(lines, bytes)` after each
/// buffer so the caller can throttle progress reporting. Returns the checkpoints
/// (seeded with `(0, 0)`) and the total line count. Line count follows split
/// semantics: newline count plus one for a non-empty file, zero for an empty one.
fn build_index<R: Read>(
  mut reader: R,
  interval: u32,
  mut progress: impl FnMut(u64, u64),
) -> Result<(Vec<(u64, u64)>, u64), String> {
  let mut checkpoints = vec![(0u64, 0u64)];
  let mut line = 0u64;
  let mut pos = 0u64;
  let mut any = false;
  let mut buf = [0u8; 256 * 1024];
  loop {
    let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    any = true;
    for &b in &buf[..n] {
      pos += 1;
      if b == b'\n' {
        line += 1;
        // `pos` is now one past the newline: the start of the next line.
        if interval != 0 && line % interval as u64 == 0 {
          checkpoints.push((line, pos));
        }
      }
    }
    progress(line, pos);
  }
  let total = if any { line + 1 } else { 0 };
  Ok((checkpoints, total))
}

/// Nearest checkpoint at or before `line`: the last one whose line index does not
/// exceed the target. Checkpoints are ascending, so binary-search the boundary.
fn nearest_checkpoint(checkpoints: &[(u64, u64)], line: u64) -> (u64, u64) {
  let idx = checkpoints.partition_point(|&(l, _)| l <= line);
  checkpoints[idx - 1]
}

/// Byte offset of `target` line's start, scanning forward from a checkpoint that
/// begins at `start_line` / `start_offset`. Errors when `target` lies past the
/// file's last line.
fn offset_of_line<R: Read>(
  mut reader: R,
  start_offset: u64,
  start_line: u64,
  target: u64,
) -> Result<u64, String> {
  if target < start_line {
    return Err("line before checkpoint".to_string());
  }
  let mut need = target - start_line;
  if need == 0 {
    return Ok(start_offset);
  }
  let mut pos = start_offset;
  let mut buf = [0u8; 64 * 1024];
  loop {
    let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      return Err("line out of range".to_string());
    }
    for &b in &buf[..n] {
      pos += 1;
      if b == b'\n' {
        need -= 1;
        if need == 0 {
          // `pos` is one past the newline: the start of `target`.
          return Ok(pos);
        }
      }
    }
  }
}

/// Case-aware substring search over bytes. Case-insensitive matching folds ASCII
/// letters only; non-ASCII bytes compare verbatim.
fn find_sub(hay: &[u8], needle: &[u8], case_sensitive: bool) -> Option<usize> {
  if needle.is_empty() || needle.len() > hay.len() {
    return None;
  }
  // ponytail: O(n*m) windowed scan, fine for interactive search; swap in memmem
  // if large-file search latency ever matters.
  if case_sensitive {
    hay.windows(needle.len()).position(|w| w == needle)
  } else {
    hay
      .windows(needle.len())
      .position(|w| w.eq_ignore_ascii_case(needle))
  }
}

/// Count newline bytes in a slice.
fn count_newlines(b: &[u8]) -> u64 {
  b.iter().filter(|&&c| c == b'\n').count() as u64
}

/// Truncate a string to at most `max` characters (not bytes).
fn truncate_chars(s: &str, max: usize) -> String {
  match s.char_indices().nth(max) {
    Some((idx, _)) => s[..idx].to_string(),
    None => s.to_string(),
  }
}

/// Preview of the line containing the match at `idx` within `buf`, bounded to the
/// surrounding newlines and truncated to `PREVIEW_CHARS`. The line may be clipped
/// when it crosses a read boundary, which is acceptable for a preview.
fn preview_at(buf: &[u8], idx: usize) -> String {
  let start = buf[..idx]
    .iter()
    .rposition(|&b| b == b'\n')
    .map(|p| p + 1)
    .unwrap_or(0);
  let end = buf[idx..]
    .iter()
    .position(|&b| b == b'\n')
    .map(|p| idx + p)
    .unwrap_or(buf.len());
  let line = String::from_utf8_lossy(&buf[start..end]);
  truncate_chars(&line, PREVIEW_CHARS)
}

/// Stream-search a reader chunk by chunk, carrying a `query.len() - 1` byte tail
/// across boundaries so a match straddling two chunks is still found. Reports each
/// hit through `on_hit` and returns `(hit count, truncated)` where `truncated` is
/// true only when `max_results` capped the results. Cancellation via `cancel`
/// stops early and reports `truncated = false`.
fn search_stream<R: Read>(
  mut reader: R,
  query: &[u8],
  case_sensitive: bool,
  max_results: u32,
  chunk_size: usize,
  cancel: &AtomicBool,
  mut on_hit: impl FnMut(Hit),
) -> Result<(u64, bool), String> {
  let m = query.len();
  let overlap = m - 1;
  let mut carry: Vec<u8> = Vec::new();
  // Absolute offset and line index of the first byte of `combined`.
  let mut base_offset: u64 = 0;
  let mut line_at_base: u64 = 0;
  let mut hits = 0u64;
  let mut buf = vec![0u8; chunk_size];
  loop {
    if cancel.load(Ordering::Relaxed) {
      return Ok((hits, false));
    }
    let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      return Ok((hits, false));
    }
    let mut combined = std::mem::take(&mut carry);
    combined.extend_from_slice(&buf[..n]);
    // Every match found here uses at least one byte from the new read (the
    // carry alone is shorter than the query), so none was reportable before.
    let mut from = 0;
    while let Some(rel) = find_sub(&combined[from..], query, case_sensitive) {
      let idx = from + rel;
      on_hit(Hit {
        offset: base_offset + idx as u64,
        line: line_at_base + count_newlines(&combined[..idx]),
        preview: preview_at(&combined, idx),
      });
      hits += 1;
      if hits >= max_results as u64 {
        return Ok((hits, true));
      }
      if cancel.load(Ordering::Relaxed) {
        return Ok((hits, false));
      }
      from = idx + m;
      if from > combined.len() {
        break;
      }
    }
    // Keep the last `overlap` bytes as carry; advance base/line past the rest.
    let keep = overlap.min(combined.len());
    let consumed = combined.len() - keep;
    line_at_base += count_newlines(&combined[..consumed]);
    base_offset += consumed as u64;
    carry = combined[consumed..].to_vec();
  }
}

#[tauri::command]
pub fn stat_file(path: String) -> Result<FileStat, String> {
  stat(Path::new(&path))
}

#[tauri::command]
pub fn read_chunk(path: String, offset: u64, len: u32) -> Result<Chunk, String> {
  read_chunk_at(Path::new(&path), offset, len)
}

/// Start building a line index in the background. Returns an id immediately; the
/// index is seeded and filled in when the scan finishes, emitting throttled
/// `large-index-progress` events along the way.
#[tauri::command]
pub fn start_line_index(
  app: AppHandle,
  state: State<LargeFileState>,
  path: String,
  interval_lines: u32,
) -> Result<String, String> {
  if interval_lines == 0 {
    return Err("interval_lines must be greater than zero".to_string());
  }
  let id = uuid::Uuid::new_v4().to_string();
  let path_buf = PathBuf::from(&path);
  state.indexes.lock().unwrap().insert(
    id.clone(),
    LineIndex {
      path: path_buf.clone(),
      checkpoints: vec![(0, 0)],
      total_lines: None,
    },
  );
  let thread_id = id.clone();
  std::thread::spawn(move || {
    let file = match File::open(&path_buf) {
      Ok(f) => f,
      Err(e) => {
        log::warn!("line index open failed: {e}");
        let _ = app.emit(
          "large-index-progress",
          IndexProgress {
            id: thread_id,
            lines: 0,
            bytes: 0,
            done: true,
            error: true,
          },
        );
        return;
      }
    };
    let mut last_emit = 0u64;
    let result = build_index(BufReader::new(file), interval_lines, |lines, bytes| {
      if bytes - last_emit >= INDEX_PROGRESS_BYTES {
        last_emit = bytes;
        let _ = app.emit(
          "large-index-progress",
          IndexProgress {
            id: thread_id.clone(),
            lines,
            bytes,
            done: false,
            error: false,
          },
        );
      }
    });
    let (checkpoints, total, bytes) = match result {
      Ok((cp, total)) => {
        let bytes = cp.last().map(|&(_, o)| o).unwrap_or(0);
        (cp, total, bytes)
      }
      Err(e) => {
        log::warn!("line index scan failed: {e}");
        let _ = app.emit(
          "large-index-progress",
          IndexProgress {
            id: thread_id,
            lines: 0,
            bytes: 0,
            done: true,
            error: true,
          },
        );
        return;
      }
    };
    // Only publish if the index wasn't dropped mid-scan.
    if let Some(entry) = app
      .state::<LargeFileState>()
      .indexes
      .lock()
      .unwrap()
      .get_mut(&thread_id)
    {
      entry.checkpoints = checkpoints;
      entry.total_lines = Some(total);
    }
    let _ = app.emit(
      "large-index-progress",
      IndexProgress {
        id: thread_id,
        lines: total,
        bytes,
        done: true,
        error: false,
      },
    );
  });
  Ok(id)
}

/// Byte offset where `line` begins, using the index's nearest checkpoint and
/// scanning forward from there.
#[tauri::command]
pub fn line_to_offset(state: State<LargeFileState>, id: String, line: u64) -> Result<u64, String> {
  let (path, checkpoint) = {
    let map = state.indexes.lock().unwrap();
    let index = map.get(&id).ok_or_else(|| "unknown index id".to_string())?;
    (
      index.path.clone(),
      nearest_checkpoint(&index.checkpoints, line),
    )
  };
  let mut file = File::open(&path).map_err(|e| e.to_string())?;
  file
    .seek(SeekFrom::Start(checkpoint.1))
    .map_err(|e| e.to_string())?;
  offset_of_line(BufReader::new(file), checkpoint.1, checkpoint.0, line)
}

/// The index's total line count once known, otherwise `None` while it is still
/// being built.
#[tauri::command]
pub fn index_line_count(state: State<LargeFileState>, id: String) -> Result<Option<u64>, String> {
  let map = state.indexes.lock().unwrap();
  let index = map.get(&id).ok_or_else(|| "unknown index id".to_string())?;
  Ok(index.total_lines)
}

/// Release a line index and its memory.
#[tauri::command]
pub fn drop_line_index(state: State<LargeFileState>, id: String) {
  state.indexes.lock().unwrap().remove(&id);
}

/// Start a background plain-text search, emitting `large-search-hit` per match and
/// a final `large-search-done`. Registers a cancellation flag under `search_id`.
#[tauri::command]
pub fn stream_search(
  app: AppHandle,
  state: State<LargeFileState>,
  path: String,
  query: String,
  case_sensitive: bool,
  max_results: u32,
  search_id: String,
) -> Result<(), String> {
  if query.is_empty() {
    return Err("query must not be empty".to_string());
  }
  let cancel = Arc::new(AtomicBool::new(false));
  state
    .searches
    .lock()
    .unwrap()
    .insert(search_id.clone(), cancel.clone());
  let path_buf = PathBuf::from(&path);
  std::thread::spawn(move || {
    let done = |hits: u64, truncated: bool, error: bool| {
      let _ = app.emit(
        "large-search-done",
        SearchDone {
          search_id: search_id.clone(),
          hits,
          truncated,
          error,
        },
      );
      app
        .state::<LargeFileState>()
        .searches
        .lock()
        .unwrap()
        .remove(&search_id);
    };
    let file = match File::open(&path_buf) {
      Ok(f) => f,
      Err(e) => {
        log::warn!("search open failed: {e}");
        done(0, false, true);
        return;
      }
    };
    let emit_id = search_id.clone();
    let result = search_stream(
      BufReader::new(file),
      query.as_bytes(),
      case_sensitive,
      max_results,
      SEARCH_CHUNK,
      &cancel,
      |hit| {
        let _ = app.emit(
          "large-search-hit",
          SearchHit {
            search_id: emit_id.clone(),
            offset: hit.offset,
            line: hit.line,
            preview: hit.preview,
          },
        );
      },
    );
    match result {
      Ok((hits, truncated)) => done(hits, truncated, false),
      Err(e) => {
        log::warn!("search scan failed: {e}");
        done(0, false, true);
      }
    }
  });
  Ok(())
}

/// Signal a running search to stop. No-op if the id is unknown or already done.
#[tauri::command]
pub fn cancel_search(state: State<LargeFileState>, search_id: String) {
  if let Some(flag) = state.searches.lock().unwrap().get(&search_id) {
    flag.store(true, Ordering::Relaxed);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Cursor;
  use tempfile::tempdir;

  #[test]
  fn align_drops_leading_partial_char() {
    // "a中b" = 61 E4 B8 AD 62; reading from byte 2 lands mid-"中".
    let chunk = align_chunk(&[0xB8, 0xAD, 0x62], 2);
    assert_eq!(chunk.text, "b");
    assert_eq!(chunk.start, 4);
    assert_eq!(chunk.end, 5);
  }

  #[test]
  fn align_drops_trailing_partial_char() {
    // "a" + first two bytes of "中": the cut character is trimmed off the end.
    let chunk = align_chunk(&[0x61, 0xE4, 0xB8], 0);
    assert_eq!(chunk.text, "a");
    assert_eq!(chunk.start, 0);
    assert_eq!(chunk.end, 1);
  }

  #[test]
  fn align_keeps_whole_emoji() {
    // "😀" = F0 9F 98 80, a full 4-byte character read whole.
    let chunk = align_chunk(&[0xF0, 0x9F, 0x98, 0x80], 10);
    assert_eq!(chunk.text, "😀");
    assert_eq!(chunk.start, 10);
    assert_eq!(chunk.end, 14);
  }

  #[test]
  fn align_replaces_invalid_bytes_lossily() {
    // A stray invalid byte in the middle is replaced, not trimmed or panicked.
    let chunk = align_chunk(&[0x61, 0xFF, 0x62], 0);
    assert!(chunk.text.starts_with('a') && chunk.text.ends_with('b'));
    assert_eq!(chunk.end - chunk.start, 3);
  }

  #[test]
  fn read_chunk_aligns_across_multibyte_boundary() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("multi.txt");
    // "a中b😀c" — offsets: a=0, 中=1..4, b=4, 😀=5..9, c=9.
    std::fs::write(&path, "a中b😀c").unwrap();
    // Start mid-"中" (offset 2) with a length that cuts mid-"😀".
    let chunk = read_chunk_at(&path, 2, 5).unwrap();
    // No half characters: valid round-trip, boundaries advanced past "中".
    assert!(chunk.text.chars().all(|c| c != char::REPLACEMENT_CHARACTER));
    assert_eq!(chunk.start, 4);
    assert!(chunk.text.starts_with('b'));
  }

  #[test]
  fn read_chunk_past_eof_is_empty() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("small.txt");
    std::fs::write(&path, "abc").unwrap();
    let chunk = read_chunk_at(&path, 100, 10).unwrap();
    assert_eq!(chunk.text, "");
    assert_eq!(chunk.start, 100);
    assert_eq!(chunk.end, 100);
  }

  #[test]
  fn index_counts_lines_without_trailing_newline() {
    let (_, total) = build_index(Cursor::new("line0\nline1\nline2"), 1, |_, _| {}).unwrap();
    assert_eq!(total, 3);
  }

  #[test]
  fn index_counts_lines_with_trailing_newline() {
    let (_, total) = build_index(Cursor::new("a\nb\n"), 1, |_, _| {}).unwrap();
    assert_eq!(total, 3);
  }

  #[test]
  fn index_empty_file_has_zero_lines() {
    let (cp, total) = build_index(Cursor::new(""), 1, |_, _| {}).unwrap();
    assert_eq!(total, 0);
    assert_eq!(cp, vec![(0, 0)]);
  }

  #[test]
  fn offset_of_line_within_and_across_interval() {
    // "line0\nline1\nline2": line starts at bytes 0, 6, 12.
    let content = "line0\nline1\nline2";
    // Interval 2 records checkpoints for lines 0 and 2 only, so line 1 must be
    // reached by scanning forward from the line-0 checkpoint.
    let (cp, _) = build_index(Cursor::new(content), 2, |_, _| {}).unwrap();
    assert_eq!(cp, vec![(0, 0), (2, 12)]);
    // Line 1 is inside the interval (scanned from checkpoint 0).
    let c0 = nearest_checkpoint(&cp, 1);
    let mut r = Cursor::new(content);
    r.seek(SeekFrom::Start(c0.1)).unwrap();
    assert_eq!(offset_of_line(r, c0.1, c0.0, 1).unwrap(), 6);
    // Line 2 lands exactly on a checkpoint.
    let c2 = nearest_checkpoint(&cp, 2);
    let mut r = Cursor::new(content);
    r.seek(SeekFrom::Start(c2.1)).unwrap();
    assert_eq!(offset_of_line(r, c2.1, c2.0, 2).unwrap(), 12);
  }

  #[test]
  fn offset_of_line_out_of_range_errors() {
    let content = "a\nb";
    let (cp, _) = build_index(Cursor::new(content), 1, |_, _| {}).unwrap();
    let c = nearest_checkpoint(&cp, 5);
    let mut r = Cursor::new(content);
    r.seek(SeekFrom::Start(c.1)).unwrap();
    assert!(offset_of_line(r, c.1, c.0, 5).is_err());
  }

  #[test]
  fn search_finds_match_across_chunk_boundary() {
    // Chunk size 2 forces "ABC" to straddle a boundary.
    let cancel = AtomicBool::new(false);
    let mut hits = Vec::new();
    let (count, truncated) =
      search_stream(Cursor::new("xxABCxx"), b"ABC", true, 100, 2, &cancel, |h| {
        hits.push(h.offset)
      })
      .unwrap();
    assert_eq!(count, 1);
    assert!(!truncated);
    assert_eq!(hits, vec![2]);
  }

  #[test]
  fn search_is_case_insensitive_when_requested() {
    let cancel = AtomicBool::new(false);
    let mut hits = Vec::new();
    let (count, _) = search_stream(
      Cursor::new("hello ABC world"),
      b"abc",
      false,
      100,
      4,
      &cancel,
      |h| hits.push(h.offset),
    )
    .unwrap();
    assert_eq!(count, 1);
    assert_eq!(hits, vec![6]);
  }

  #[test]
  fn search_reports_line_numbers() {
    let cancel = AtomicBool::new(false);
    let mut hits = Vec::new();
    let (count, _) = search_stream(
      Cursor::new("a\nb\nfind me\nd"),
      b"find",
      true,
      100,
      3,
      &cancel,
      |h| hits.push((h.line, h.preview.clone())),
    )
    .unwrap();
    assert_eq!(count, 1);
    // Line number is correct even though the match straddles read boundaries.
    assert_eq!(hits[0].0, 2);
    // Preview is best-effort within the buffer, so it starts on the hit line.
    assert!(hits[0].1.starts_with("find"));
  }

  #[test]
  fn search_preview_is_whole_line_within_one_buffer() {
    // A chunk large enough to hold the line yields the full preview.
    let cancel = AtomicBool::new(false);
    let mut previews = Vec::new();
    search_stream(
      Cursor::new("a\nb\nfind me\nd"),
      b"find",
      true,
      100,
      64,
      &cancel,
      |h| previews.push(h.preview),
    )
    .unwrap();
    assert_eq!(previews, vec!["find me".to_string()]);
  }

  #[test]
  fn search_truncates_at_max_results() {
    let cancel = AtomicBool::new(false);
    let mut count_seen = 0;
    let (count, truncated) =
      search_stream(Cursor::new("a a a a a"), b"a", true, 2, 2, &cancel, |_| {
        count_seen += 1
      })
      .unwrap();
    assert_eq!(count, 2);
    assert!(truncated);
    assert_eq!(count_seen, 2);
  }

  #[test]
  fn search_stops_when_cancelled() {
    // Cancelling inside the hit callback stops the scan after the first match.
    let cancel = AtomicBool::new(false);
    let mut hits = 0;
    let (count, truncated) = search_stream(
      Cursor::new("a a a a a"),
      b"a",
      true,
      100,
      2,
      &cancel,
      |_| {
        hits += 1;
        cancel.store(true, Ordering::Relaxed);
      },
    )
    .unwrap();
    assert_eq!(count, 1);
    assert_eq!(hits, 1);
    assert!(!truncated);
  }

  #[test]
  fn search_pre_cancelled_finds_nothing() {
    let cancel = AtomicBool::new(true);
    let (count, truncated) =
      search_stream(Cursor::new("aaaa"), b"a", true, 100, 2, &cancel, |_| {}).unwrap();
    assert_eq!(count, 0);
    assert!(!truncated);
  }

  /// A reader that always fails, standing in for a mid-scan I/O error (e.g. the
  /// file disappearing or a disk read failure).
  struct FailingReader;

  impl Read for FailingReader {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
      Err(std::io::Error::other("simulated read failure"))
    }
  }

  #[test]
  fn index_mid_scan_failure_errors() {
    // This is the condition `start_line_index`'s worker thread matches on to emit
    // the terminal `large-index-progress` event with `error: true` instead of
    // returning silently.
    assert!(build_index(FailingReader, 1, |_, _| {}).is_err());
  }

  #[test]
  fn search_mid_scan_failure_errors() {
    // This is the condition `stream_search`'s worker thread matches on to call
    // `done(0, false, true)` instead of the success terminal call
    // `done(hits, truncated, false)` — the two are no longer the same signal.
    let cancel = AtomicBool::new(false);
    assert!(search_stream(FailingReader, b"x", true, 100, 64, &cancel, |_| {}).is_err());
  }
}
