// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use std::str::FromStr;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// Parse and validate an accelerator string using the global-shortcut plugin's
/// own grammar, so what we accept here is exactly what registration accepts.
pub fn parse_accelerator(accel: &str) -> Result<Shortcut, String> {
  Shortcut::from_str(accel).map_err(|e| format!("invalid shortcut '{accel}': {e}"))
}

/// Re-register the global new-note accelerator atomically enough that runtime
/// registration and the persisted setting can never diverge: register the new
/// shortcut (old stays active), persist, and only then drop the old one. If
/// persisting fails the new registration is rolled back, so both a rejected
/// accelerator and a failed write leave the working shortcut untouched.
#[tauri::command]
pub fn set_new_note_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
  let new = parse_accelerator(&shortcut)?;
  let current = crate::settings::app_settings(&app).new_note_shortcut;
  if shortcut == current {
    return Ok(());
  }
  let gs = app.global_shortcut();
  gs.register(new).map_err(|e| e.to_string())?;
  if let Err(e) = crate::settings::save_settings(
    app.clone(),
    serde_json::json!({ "new_note_shortcut": shortcut }),
  ) {
    let _ = gs.unregister(new);
    return Err(e);
  }
  // The old accelerator was registered at startup from the same validated
  // settings, so parsing it again should always succeed; ignore a stray error.
  if let Ok(old) = parse_accelerator(&current) {
    let _ = gs.unregister(old);
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::parse_accelerator;

  #[test]
  fn accepts_valid_accelerators() {
    for accel in ["CmdOrCtrl+Shift+N", "Alt+F4", "CmdOrCtrl+,", "Super+Up"] {
      assert!(parse_accelerator(accel).is_ok(), "should accept {accel}");
    }
  }

  #[test]
  fn rejects_bare_modifier() {
    assert!(parse_accelerator("Shift+Ctrl").is_err());
  }

  #[test]
  fn rejects_garbage() {
    assert!(parse_accelerator("").is_err());
    assert!(parse_accelerator("NotAKey").is_err());
  }
}
