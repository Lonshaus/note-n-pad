// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! The `docimg` URI scheme: the only way a Markdown preview can load an image
//! off disk. Every request is gated on the `preview_local_resources` setting,
//! on a base folder the document window registered for itself, and on
//! `path_guard::resolve_within`. Nothing here trusts the frontend: a webview
//! that asks with the setting off is refused just the same.

use crate::path_guard::{percent_decode, resolve_within};
use crate::settings;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, State, UriSchemeContext, Wry};

/// Upper bound on one served image, 32 MiB. Well past any image a document
/// sensibly inlines, and low enough that a preview cannot be talked into
/// buffering an arbitrary file into memory.
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// Lowercased extension to the `Content-Type` served for it. SVG is absent on
/// purpose: it is a script-bearing document, and serving one from the app
/// origin would be an XSS vector rather than a picture.
const IMAGE_TYPES: &[(&str, &str)] = &[
  ("png", "image/png"),
  ("jpg", "image/jpeg"),
  ("jpeg", "image/jpeg"),
  ("gif", "image/gif"),
  ("webp", "image/webp"),
  ("avif", "image/avif"),
  ("bmp", "image/bmp"),
];

/// The folder each document webview may load preview images from, keyed by
/// webview label. Absent means that webview gets nothing.
#[derive(Default)]
pub struct PreviewBases(Mutex<HashMap<String, PathBuf>>);

impl PreviewBases {
  /// The folder registered for `label`, if any. Also read by `navigation` for
  /// relative document links, which resolve against the same base.
  pub(crate) fn base_for(&self, label: &str) -> Option<PathBuf> {
    self.0.lock().unwrap().get(label).cloned()
  }
}

/// Register (or, with `dir` empty or absent, clear) the calling webview's
/// preview base folder.
///
/// Stored as handed in rather than canonicalized: `resolve_within` canonicalizes
/// both sides itself, and a Windows verbatim (`\\?\`) base would skip the
/// normalization it relies on — `sub/img.png` under one never opens.
///
/// Plain `#[tauri::command]`, not `(async)`: the `(async)` form in this codebase
/// exists for window-creating commands only, and this creates none.
#[tauri::command]
pub fn set_preview_base(
  webview: tauri::Webview,
  state: State<'_, PreviewBases>,
  dir: Option<String>,
) -> Result<(), String> {
  let label = webview.label().to_string();
  let mut bases = state.0.lock().unwrap();
  let Some(dir) = dir.filter(|d| !d.is_empty()) else {
    bases.remove(&label);
    return Ok(());
  };
  let path = PathBuf::from(dir);
  if !path.is_absolute() || !path.is_dir() {
    bases.remove(&label);
    return Err("preview base must be an existing absolute folder".to_string());
  }
  bases.insert(label, path);
  Ok(())
}

/// One image cleared for serving.
struct Served {
  body: Vec<u8>,
  content_type: &'static str,
}

/// Every decision the `docimg` handler makes, with no webview or app handle in
/// sight so `cargo test` can drive each refusal. `Err(())` carries no reason:
/// the caller turns it into a bare 403, and a reason could only leak one.
///
/// `max_bytes` is a parameter rather than the constant so the size guard is
/// testable without writing a 32 MiB fixture.
fn serve(
  enabled: bool,
  base: Option<&Path>,
  requested: &str,
  max_bytes: u64,
) -> Result<Served, ()> {
  if !enabled {
    return Err(());
  }
  let base = base.ok_or(())?;
  let path = resolve_within(base, requested).map_err(|_| ())?;
  let ext = path
    .extension()
    .and_then(|e| e.to_str())
    .unwrap_or_default()
    .to_ascii_lowercase();
  let content_type = IMAGE_TYPES
    .iter()
    .find(|(e, _)| *e == ext)
    .map(|(_, t)| *t)
    .ok_or(())?;
  let file = File::open(&path).map_err(|_| ())?;
  // Bounded read rather than a metadata size check: the file can grow between
  // the two, and this caps the allocation regardless.
  let mut body = Vec::new();
  file
    .take(max_bytes + 1)
    .read_to_end(&mut body)
    .map_err(|_| ())?;
  if body.len() as u64 > max_bytes {
    return Err(());
  }
  Ok(Served { body, content_type })
}

/// The destination out of a `docimg://localhost/?p=…` query, decoded back to
/// exactly what the Markdown source wrote. The frontend percent-encodes it
/// once for transport; the Markdown-level decode is `resolve_within`'s job, so
/// this undoes only the transport layer.
fn requested_dest(query: Option<&str>) -> Option<String> {
  query?
    .split('&')
    .find_map(|pair| pair.strip_prefix("p="))
    .and_then(|v| percent_decode(v).ok())
}

/// The registered `docimg` handler. Refusals are an empty 403 with no detail.
pub fn respond(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
  let app = ctx.app_handle();
  // Read fresh per request so toggling the setting off takes effect at once;
  // a settings file read per image is cheap next to decoding the image.
  let enabled = settings::app_settings(app).preview_local_resources;
  let base = app
    .try_state::<PreviewBases>()
    .and_then(|bases| bases.base_for(ctx.webview_label()));
  let dest = requested_dest(request.uri().query()).unwrap_or_default();
  match serve(enabled, base.as_deref(), &dest, MAX_IMAGE_BYTES) {
    Ok(s) => Response::builder()
      .header(header::CONTENT_TYPE, s.content_type)
      // The type comes from the extension, never sniffed from the bytes; this
      // stops the webview from second-guessing it.
      .header("X-Content-Type-Options", "nosniff")
      .body(s.body)
      .unwrap_or_default(),
    Err(()) => Response::builder()
      .status(StatusCode::FORBIDDEN)
      .body(Vec::new())
      .unwrap_or_default(),
  }
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

  /// `<tmp>/notes` holding one real PNG, one SVG, one text file, and a big
  /// file; `secret.png` sits one level up, outside the base.
  fn fixture() -> Fixture {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let base = root.join("notes");
    fs::create_dir(&base).unwrap();
    fs::write(base.join("a.png"), b"PNGDATA").unwrap();
    fs::write(base.join("a.svg"), b"<svg onload=\"x\"/>").unwrap();
    fs::write(base.join("a.txt"), b"text").unwrap();
    fs::write(base.join("big.png"), vec![0u8; 64]).unwrap();
    fs::write(root.join("secret.png"), b"PNGDATA").unwrap();
    Fixture { _dir: dir, base }
  }

  fn serve_ok(f: &Fixture, requested: &str) -> Served {
    serve(true, Some(&f.base), requested, MAX_IMAGE_BYTES).unwrap()
  }

  #[test]
  fn setting_off_refuses_an_otherwise_valid_image() {
    let f = fixture();
    // The same request succeeds with the setting on, so this pins the gate
    // itself rather than some unrelated failure.
    assert!(serve(true, Some(&f.base), "a.png", MAX_IMAGE_BYTES).is_ok());
    assert!(serve(false, Some(&f.base), "a.png", MAX_IMAGE_BYTES).is_err());
  }

  #[test]
  fn no_registered_base_refuses() {
    assert!(serve(true, None, "a.png", MAX_IMAGE_BYTES).is_err());
  }

  #[test]
  fn non_image_extension_refuses() {
    let f = fixture();
    assert!(serve(true, Some(&f.base), "a.txt", MAX_IMAGE_BYTES).is_err());
  }

  #[test]
  fn svg_refuses() {
    let f = fixture();
    // The file is there and readable — only the allowlist keeps it out.
    assert!(f.base.join("a.svg").is_file());
    assert!(serve(true, Some(&f.base), "a.svg", MAX_IMAGE_BYTES).is_err());
  }

  #[test]
  fn oversize_refuses() {
    let f = fixture();
    // 64 bytes on disk against a 63-byte cap, and the same file passes at 64.
    assert!(serve(true, Some(&f.base), "big.png", 63).is_err());
    assert!(serve(true, Some(&f.base), "big.png", 64).is_ok());
  }

  #[test]
  fn escaping_the_base_refuses() {
    let f = fixture();
    assert!(serve(true, Some(&f.base), "../secret.png", MAX_IMAGE_BYTES).is_err());
  }

  #[test]
  fn contained_png_is_served_with_its_type() {
    let f = fixture();
    let s = serve_ok(&f, "a.png");
    assert_eq!(s.content_type, "image/png");
    assert_eq!(s.body, b"PNGDATA");
  }

  #[test]
  fn extension_match_is_case_insensitive() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("b.PNG"), b"x").unwrap();
    let s = serve(true, Some(dir.path()), "b.PNG", MAX_IMAGE_BYTES).unwrap();
    assert_eq!(s.content_type, "image/png");
  }

  #[test]
  fn query_yields_the_destination_the_source_wrote() {
    assert_eq!(requested_dest(Some("p=a.png")), Some("a.png".to_string()));
    // The frontend encodes once; a destination that itself contains a percent
    // escape must survive as written, for `resolve_within` to decode.
    assert_eq!(
      requested_dest(Some("p=sub%2Fa%2520b.png")),
      Some("sub/a%20b.png".to_string())
    );
    assert_eq!(
      requested_dest(Some("p=%E5%9C%96.png")),
      Some("圖.png".to_string())
    );
  }

  #[test]
  fn a_missing_or_wrong_query_yields_nothing() {
    assert_eq!(requested_dest(None), None);
    assert_eq!(requested_dest(Some("q=a.png")), None);
    // `pp=` must not be read as `p=`, which a `contains` check would allow.
    assert_eq!(requested_dest(Some("pp=a.png")), None);
  }
}
