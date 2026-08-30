// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Path containment for preview resources: decides whether a destination
//! written in a Markdown document may be loaded from disk.

use std::path::{Path, PathBuf};

/// Percent-decode a Markdown destination. An invalid escape is left literal
/// rather than guessed at; a decode that is not UTF-8 is an error. Also used by
/// `preview_img` to undo the one transport-level encoding the frontend applies.
pub(crate) fn percent_decode(s: &str) -> Result<String, String> {
  let bytes = s.as_bytes();
  let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      let hi = (bytes[i + 1] as char).to_digit(16);
      let lo = (bytes[i + 2] as char).to_digit(16);
      if let (Some(hi), Some(lo)) = (hi, lo) {
        out.push((hi * 16 + lo) as u8);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8(out).map_err(|_| "destination is not valid UTF-8".to_string())
}

/// Resolve `requested` — a destination exactly as it appears in the Markdown
/// source — against `base`, the folder holding the document. Returns the real
/// file to read, or an error if it is not contained in `base`.
///
/// Known limit: a non-UTF-8 filename cannot be addressed, because destinations
/// reach this function as `String`.
pub fn resolve_within(base: &Path, requested: &str) -> Result<PathBuf, String> {
  // Decoding comes first: `%2e%2e%2f` is `../`, so every check below would be
  // bypassable if it ran against the raw text.
  let decoded = percent_decode(requested)?;
  if decoded.contains('\0') {
    return Err("destination contains a NUL byte".to_string());
  }
  // A leading separator is never a relative destination: `//host/x` is a
  // protocol-relative URL and `\\server\share` a UNC path. Rejecting them here
  // also means no network share is ever contacted.
  if decoded.starts_with('/') || decoded.starts_with('\\') || Path::new(&decoded).is_absolute() {
    return Err("destination must be relative".to_string());
  }
  // One colon rule covers three things: URL schemes (`file:`, `http:`), Windows
  // drive-relative paths (`C:foo`), and NTFS alternate data streams
  // (`ok.md:evil`). Cost: a Unix file legitimately named `a:b.md`.
  if decoded.contains(':') {
    return Err("destination must not contain a scheme, drive, or stream name".to_string());
  }
  // Canonicalizing is what resolves `..`, `.`, and symlinks; a lexical check
  // cannot see a symlink inside the folder that points out of it. Both sides go
  // through it so they come back in the same form (verbatim `\\?\` on Windows)
  // and so a case-insensitive volume settles case itself — nothing is
  // lowercased here, which would be wrong on Linux.
  let base_real = base
    .canonicalize()
    .map_err(|e| format!("document folder is unreadable: {e}"))?;
  // Joined onto `base`, not `base_real`: a Windows verbatim path skips
  // normalization, so `.` and `..` inside one would not resolve.
  let target_real = base
    .join(&decoded)
    .canonicalize()
    .map_err(|e| format!("destination is unreadable: {e}"))?;
  // Component-wise, never a string prefix: `/home/u/notes-secret` must not pass
  // a check against `/home/u/notes`.
  if !target_real.starts_with(&base_real) {
    return Err("destination is outside the document folder".to_string());
  }
  if !target_real.is_file() {
    return Err("destination is not a regular file".to_string());
  }
  Ok(target_real)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use tempfile::{tempdir, TempDir};

  struct Fixture {
    _dir: TempDir,
    base: PathBuf,
  }

  /// Builds `<tmp>/notes` as the document folder, with a sibling folder whose
  /// name has `notes` as a string prefix and a secret file one level up.
  fn fixture() -> Fixture {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let base = root.join("notes");
    fs::create_dir(&base).unwrap();
    fs::write(base.join("a.md"), "x").unwrap();
    fs::write(base.join("a b.md"), "x").unwrap();
    fs::create_dir(base.join("sub")).unwrap();
    fs::write(base.join("sub").join("b.md"), "x").unwrap();
    fs::write(root.join("secret.md"), "x").unwrap();
    fs::create_dir(root.join("notes-secret")).unwrap();
    fs::write(root.join("notes-secret").join("x.md"), "x").unwrap();
    Fixture { _dir: dir, base }
  }

  fn err(f: &Fixture, requested: &str) -> String {
    resolve_within(&f.base, requested).unwrap_err()
  }

  #[test]
  fn rejects_parent_escape() {
    let f = fixture();
    assert!(resolve_within(&f.base, "../secret.md").is_err());
    assert!(resolve_within(&f.base, "../../etc/passwd").is_err());
    assert!(resolve_within(&f.base, "sub/../../secret.md").is_err());
  }

  #[test]
  fn rejects_percent_encoded_escape() {
    let f = fixture();
    assert!(resolve_within(&f.base, "%2e%2e%2fsecret.md").is_err());
    assert!(resolve_within(&f.base, "..%2fsecret.md").is_err());
    assert!(resolve_within(&f.base, "%2E%2E/secret.md").is_err());
  }

  #[test]
  fn rejects_sibling_prefix_folder() {
    let f = fixture();
    assert!(resolve_within(&f.base, "../notes-secret/x.md").is_err());
  }

  #[test]
  fn rejects_absolute_paths() {
    let f = fixture();
    assert!(err(&f, "/etc/passwd").contains("must be relative"));
    // Which guard catches this differs by platform — on Windows it is absolute,
    // elsewhere only the colon rule sees it. The colon rule stays pinned by
    // `a.md:evil` in rejects_unc_path_and_alternate_data_stream.
    assert!(resolve_within(&f.base, "C:\\Windows\\win.ini").is_err());
  }

  #[test]
  fn rejects_scheme_or_authority() {
    let f = fixture();
    assert!(err(&f, "file:///etc/passwd").contains("scheme"));
    assert!(err(&f, "http://evil/x").contains("scheme"));
    assert!(err(&f, "//evil.example/x").contains("must be relative"));
  }

  #[test]
  fn rejects_unc_path_and_alternate_data_stream() {
    let f = fixture();
    assert!(err(&f, "\\\\server\\share\\x").contains("must be relative"));
    assert!(err(&f, "a.md:evil").contains("scheme"));
    assert!(err(&f, "C:sub").contains("scheme"));
  }

  #[test]
  fn rejects_nul_byte() {
    let f = fixture();
    // Exact match, not a substring: the OS error for a NUL in a filename also
    // says "NUL", so a loose assertion would pass without this guard.
    assert_eq!(err(&f, "a%00.md"), "destination contains a NUL byte");
    assert_eq!(err(&f, "a\0.md"), "destination contains a NUL byte");
  }

  #[test]
  fn rejects_directory_target() {
    let f = fixture();
    assert!(resolve_within(&f.base, "sub").is_err());
    assert!(resolve_within(&f.base, ".").is_err());
  }

  #[test]
  fn rejects_invalid_utf8_escape() {
    let f = fixture();
    assert!(err(&f, "%ff.md").contains("UTF-8"));
  }

  #[test]
  #[cfg(unix)]
  fn rejects_symlink_pointing_out_of_base() {
    let f = fixture();
    let outside = f.base.parent().unwrap().join("secret.md");
    std::os::unix::fs::symlink(outside, f.base.join("link.md")).unwrap();
    assert!(resolve_within(&f.base, "link.md").is_err());
  }

  #[test]
  fn accepts_plain_file() {
    let f = fixture();
    let want = f.base.join("a.md").canonicalize().unwrap();
    assert_eq!(resolve_within(&f.base, "a.md").unwrap(), want);
  }

  #[test]
  fn accepts_file_in_subdirectory() {
    let f = fixture();
    let want = f.base.join("sub").join("b.md").canonicalize().unwrap();
    assert_eq!(resolve_within(&f.base, "sub/b.md").unwrap(), want);
  }

  #[test]
  fn accepts_dot_slash_prefix() {
    let f = fixture();
    let want = f.base.join("a.md").canonicalize().unwrap();
    assert_eq!(resolve_within(&f.base, "./a.md").unwrap(), want);
  }

  #[test]
  fn accepts_percent_encoded_space() {
    let f = fixture();
    let want = f.base.join("a b.md").canonicalize().unwrap();
    assert_eq!(resolve_within(&f.base, "a%20b.md").unwrap(), want);
  }

  #[test]
  #[cfg(unix)]
  fn accepts_symlink_inside_base() {
    let f = fixture();
    std::os::unix::fs::symlink(f.base.join("a.md"), f.base.join("link.md")).unwrap();
    let want = f.base.join("a.md").canonicalize().unwrap();
    assert_eq!(resolve_within(&f.base, "link.md").unwrap(), want);
  }
}
