// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use std::str::FromStr;
use tauri_plugin_global_shortcut::Shortcut;
/// Parse an accelerator string using the global-shortcut plugin's own grammar,
/// so what we accept here is exactly what registration accepts.
pub fn parse_accelerator(accel: &str) -> Result<Shortcut, String> {
  Shortcut::from_str(accel).map_err(|e| format!("invalid shortcut '{accel}': {e}"))
}

#[cfg(test)]
mod tests {
  use super::parse_accelerator;

  #[test]
  fn accepts_valid_accelerators() {
    for accel in ["Super+Shift+N", "Alt+F4", "Ctrl+,", "Super+ArrowUp"] {
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
