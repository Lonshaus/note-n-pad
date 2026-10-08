// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use std::str::FromStr;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

/// Parse and validate an accelerator string using the global-shortcut plugin's
/// own grammar, so what we accept here is exactly what registration accepts.
pub fn parse_accelerator(accel: &str) -> Result<Shortcut, String> {
  Shortcut::from_str(accel).map_err(|e| format!("invalid shortcut '{accel}': {e}"))
}
/// A global shortcut needs Command/Control/Alt, or must be a bare F1-F24.
pub fn is_allowed_shortcut(shortcut: &Shortcut) -> bool {
  const F_KEYS: [Code; 24] = [
    Code::F1,
    Code::F2,
    Code::F3,
    Code::F4,
    Code::F5,
    Code::F6,
    Code::F7,
    Code::F8,
    Code::F9,
    Code::F10,
    Code::F11,
    Code::F12,
    Code::F13,
    Code::F14,
    Code::F15,
    Code::F16,
    Code::F17,
    Code::F18,
    Code::F19,
    Code::F20,
    Code::F21,
    Code::F22,
    Code::F23,
    Code::F24,
  ];
  if shortcut.mods.is_empty() {
    return F_KEYS.contains(&shortcut.key);
  }
  shortcut
    .mods
    .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER | Modifiers::META)
}
/// Whether `accel` parses and satisfies `is_allowed_shortcut`.
pub fn is_allowed_accelerator(accel: &str) -> bool {
  parse_accelerator(accel).is_ok_and(|s| is_allowed_shortcut(&s))
}

/// Re-register the global new-note accelerator atomically enough that runtime
/// registration and the persisted setting can never diverge: register the new
/// shortcut (old stays active), persist, and only then drop the old one. If
/// persisting fails the new registration is rolled back, so both a rejected
/// accelerator and a failed write leave the working shortcut untouched.
#[tauri::command]
pub fn set_new_note_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
  let new = parse_accelerator(&shortcut)?;
  if !is_allowed_shortcut(&new) {
    return Err(format!(
      "shortcut '{shortcut}' needs Command, Control or Alt (or be a bare F1-F24)"
    ));
  }
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
  use super::{is_allowed_accelerator, parse_accelerator};

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

  #[test]
  fn allows_modified_combos_and_bare_function_keys() {
    for accel in [
      "CmdOrCtrl+Shift+N",
      "CmdOrCtrl+Alt+M",
      "Alt+J",
      "Ctrl+J",
      "F5",
      "F24",
    ] {
      assert!(is_allowed_accelerator(accel), "should allow {accel}");
    }
  }

  #[test]
  fn rejects_unmodified_and_shift_only_combos() {
    for accel in ["Enter", "N", "Shift+N", "Shift+F5", "Shift+Enter", "Space"] {
      assert!(!is_allowed_accelerator(accel), "should reject {accel}");
    }
  }

  #[test]
  fn rejects_unparseable_accelerators() {
    assert!(!is_allowed_accelerator(""));
    assert!(!is_allowed_accelerator("NotAKey"));
  }
}
