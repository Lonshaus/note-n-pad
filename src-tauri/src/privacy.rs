// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::i18n::Locale;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The bundled policy is written in three languages. Every other interface
/// language reads the English one rather than a machine translation of a legal
/// document.
fn document_for(locale: Locale) -> &'static str {
  match locale {
    Locale::ZhTw => "zh-TW.md",
    Locale::Ja => "ja.md",
    _ => "en.md",
  }
}

/// Absolute path of one bundled policy (see `tauri.conf.json`'s
/// `bundle.resources` mapping and `scripts/gen-privacy.mjs`).
fn resource_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
  Ok(
    app
      .path()
      .resource_dir()
      .map_err(|e| e.to_string())?
      .join("privacy")
      .join(name),
  )
}

/// Read `path`, falling back to the English document when the chosen language's
/// file is unreadable. A policy the user cannot read at all is worse than one
/// in the wrong language, and this is the screen the store requires to work
/// with no network.
fn read_with_fallback(dir: &Path, name: &str) -> Result<String, String> {
  match std::fs::read_to_string(dir.join(name)) {
    Ok(text) => Ok(text),
    Err(e) if name != "en.md" => std::fs::read_to_string(dir.join("en.md"))
      .map_err(|fallback| format!("{name}: {e}; en.md: {fallback}")),
    Err(e) => Err(e.to_string()),
  }
}

/// The privacy policy in the current interface language, read from inside the
/// app so it needs no network.
#[tauri::command]
pub fn read_privacy_policy(app: AppHandle) -> Result<String, String> {
  let locale = crate::i18n::current_locale(&crate::settings::app_settings(&app).language);
  let name = document_for(locale);
  let dir = resource_file(&app, name)?
    .parent()
    .ok_or_else(|| "privacy resource has no parent directory".to_string())?
    .to_path_buf();
  read_with_fallback(&dir, name)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn three_languages_have_their_own_document() {
    assert_eq!(document_for(Locale::ZhTw), "zh-TW.md");
    assert_eq!(document_for(Locale::Ja), "ja.md");
    assert_eq!(document_for(Locale::En), "en.md");
  }

  #[test]
  fn every_other_language_reads_english() {
    // Naming them one by one rather than iterating: a language added later
    // should land here as a deliberate choice, not silently inherit English
    // because the test only checked the ones that existed at the time.
    for locale in [
      Locale::ZhCn,
      Locale::Ru,
      Locale::Es,
      Locale::PtBr,
      Locale::De,
      Locale::Fr,
      Locale::Ko,
      Locale::Pl,
      Locale::Tr,
      Locale::It,
      Locale::Th,
      Locale::Vi,
    ] {
      assert_eq!(document_for(locale), "en.md", "{locale:?} should read English");
    }
  }

  #[test]
  fn a_missing_translation_falls_back_to_english() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("en.md"), "english policy").unwrap();
    assert_eq!(
      read_with_fallback(dir.path(), "ja.md").unwrap(),
      "english policy"
    );
  }

  #[test]
  fn a_present_translation_is_not_replaced() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("en.md"), "english policy").unwrap();
    std::fs::write(dir.path().join("ja.md"), "japanese policy").unwrap();
    assert_eq!(
      read_with_fallback(dir.path(), "ja.md").unwrap(),
      "japanese policy"
    );
  }

  #[test]
  fn a_missing_english_document_is_an_error_not_an_empty_screen() {
    let dir = tempfile::tempdir().unwrap();
    assert!(read_with_fallback(dir.path(), "en.md").is_err());
    // The chosen language failing and the fallback failing both have to show,
    // or the report says only that Japanese was missing.
    let err = read_with_fallback(dir.path(), "ja.md").unwrap_err();
    assert!(err.contains("ja.md"), "{err}");
    assert!(err.contains("en.md"), "{err}");
  }
}
