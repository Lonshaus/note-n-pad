// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The characters the active keyboard layout types with AltGr (Ctrl+Alt) and
// AltGr+Shift. The windowed editor needs them to tell an AltGr character from a
// Ctrl+Alt shortcut while it queues input: both arrive as a keydown with Ctrl and
// Alt held, and only the layout knows which keys type something.

use serde::Serialize;
use std::collections::HashMap;
/// The characters one key types under Ctrl+Alt and under Ctrl+Alt+Shift; empty
/// when it types nothing there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AltGrEntry {
  pub ctrl_alt: String,
  pub ctrl_alt_shift: String,
}
/// The typewriter-area keys as (`KeyboardEvent.code`, set 1 scan code).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const KEYS: [(&str, u32); 48] = [
  ("Backquote", 0x29),
  ("Digit1", 0x02),
  ("Digit2", 0x03),
  ("Digit3", 0x04),
  ("Digit4", 0x05),
  ("Digit5", 0x06),
  ("Digit6", 0x07),
  ("Digit7", 0x08),
  ("Digit8", 0x09),
  ("Digit9", 0x0A),
  ("Digit0", 0x0B),
  ("Minus", 0x0C),
  ("Equal", 0x0D),
  ("KeyQ", 0x10),
  ("KeyW", 0x11),
  ("KeyE", 0x12),
  ("KeyR", 0x13),
  ("KeyT", 0x14),
  ("KeyY", 0x15),
  ("KeyU", 0x16),
  ("KeyI", 0x17),
  ("KeyO", 0x18),
  ("KeyP", 0x19),
  ("BracketLeft", 0x1A),
  ("BracketRight", 0x1B),
  ("KeyA", 0x1E),
  ("KeyS", 0x1F),
  ("KeyD", 0x20),
  ("KeyF", 0x21),
  ("KeyG", 0x22),
  ("KeyH", 0x23),
  ("KeyJ", 0x24),
  ("KeyK", 0x25),
  ("KeyL", 0x26),
  ("Semicolon", 0x27),
  ("Quote", 0x28),
  ("Backslash", 0x2B),
  ("IntlBackslash", 0x56),
  ("KeyZ", 0x2C),
  ("KeyX", 0x2D),
  ("KeyC", 0x2E),
  ("KeyV", 0x2F),
  ("KeyB", 0x30),
  ("KeyN", 0x31),
  ("KeyM", 0x32),
  ("Comma", 0x33),
  ("Period", 0x34),
  ("Slash", 0x35),
];
/// The table over every key in `KEYS`, asking `chars(scan_code, shift)` what a key
/// types. A key that types nothing under both states has no entry, and control
/// characters (what Ctrl turns a letter into) do not count as typed text.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn build_table(mut chars: impl FnMut(u32, bool) -> String) -> HashMap<String, AltGrEntry> {
  let mut table = HashMap::new();
  for (code, scan) in KEYS {
    let clean = |text: String| {
      if text.chars().any(char::is_control) {
        String::new()
      } else {
        text
      }
    };
    let entry = AltGrEntry {
      ctrl_alt: clean(chars(scan, false)),
      ctrl_alt_shift: clean(chars(scan, true)),
    };
    if !entry.ctrl_alt.is_empty() || !entry.ctrl_alt_shift.is_empty() {
      table.insert(code.to_string(), entry);
    }
  }
  table
}

#[cfg(target_os = "windows")]
fn layout_chars(
  layout: windows_sys::Win32::UI::Input::KeyboardAndMouse::HKL,
  scan: u32,
  shift: bool,
) -> String {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyExW, ToUnicodeEx, MAPVK_VSC_TO_VK_EX, VK_CONTROL, VK_MENU, VK_SHIFT,
  };
  // SAFETY: plain calls into user32 with a layout handle the OS gave us and
  // buffers that outlive each call.
  unsafe {
    let vk = MapVirtualKeyExW(scan, MAPVK_VSC_TO_VK_EX, layout);
    if vk == 0 {
      return String::new();
    }
    let mut state = [0u8; 256];
    state[VK_CONTROL as usize] = 0x80;
    state[VK_MENU as usize] = 0x80;
    if shift {
      state[VK_SHIFT as usize] = 0x80;
    }
    let mut buf = [0u16; 8];
    // Bit 2: leave the thread's keyboard state (a pending dead key) alone.
    let flags = 0x4;
    let count = ToUnicodeEx(
      vk,
      scan,
      state.as_ptr(),
      buf.as_mut_ptr(),
      buf.len() as i32,
      flags,
      layout,
    );
    if count < 0 {
      // A dead key: a second call clears the state it left.
      ToUnicodeEx(
        vk,
        scan,
        state.as_ptr(),
        buf.as_mut_ptr(),
        buf.len() as i32,
        flags,
        layout,
      );
      return String::new();
    }
    String::from_utf16_lossy(&buf[..count as usize])
  }
}
/// The AltGr characters of the keyboard layout active on the calling thread,
/// keyed by `KeyboardEvent.code`. Empty off Windows, where Ctrl+Alt is never a
/// character modifier.
#[tauri::command]
pub fn altgr_table() -> HashMap<String, AltGrEntry> {
  #[cfg(target_os = "windows")]
  {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
    // SAFETY: a plain call into user32.
    let layout = unsafe { GetKeyboardLayout(0) };
    build_table(|scan, shift| layout_chars(layout, scan, shift))
  }
  #[cfg(not(target_os = "windows"))]
  {
    HashMap::new()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  /// A layout typing `@` on Q and `Ą` on Shift+A under AltGr, and nothing else.
  fn german_like(scan: u32, shift: bool) -> String {
    match (scan, shift) {
      (0x10, false) => "@".to_string(),
      (0x1E, true) => "Ą".to_string(),
      _ => String::new(),
    }
  }

  #[test]
  fn keys_are_keyed_by_event_code_with_both_states() {
    let table = build_table(german_like);
    assert_eq!(
      table["KeyQ"],
      AltGrEntry {
        ctrl_alt: "@".to_string(),
        ctrl_alt_shift: String::new()
      }
    );
    assert_eq!(
      table["KeyA"],
      AltGrEntry {
        ctrl_alt: String::new(),
        ctrl_alt_shift: "Ą".to_string()
      }
    );
  }

  #[test]
  fn a_key_that_types_nothing_has_no_entry() {
    let table = build_table(german_like);
    assert_eq!(table.len(), 2);
    assert!(!table.contains_key("KeyF"));
    assert!(build_table(|_, _| String::new()).is_empty());
  }

  #[test]
  fn control_characters_are_not_typed_text() {
    // Ctrl turns Ctrl+Alt+F into ACK on a layout without AltGr.
    let table = build_table(|scan, shift| match (scan, shift) {
      (0x21, false) => "\u{6}".to_string(),
      (0x10, false) => "@".to_string(),
      _ => String::new(),
    });
    assert!(!table.contains_key("KeyF"));
    assert!(table.contains_key("KeyQ"));
  }

  #[test]
  fn the_shift_state_reaches_the_layout() {
    let mut asked = Vec::new();
    build_table(|scan, shift| {
      if scan == 0x10 {
        asked.push(shift);
      }
      String::new()
    });
    assert_eq!(asked, vec![false, true]);
  }

  #[test]
  fn every_code_and_scan_code_is_listed_once() {
    let mut codes: Vec<&str> = KEYS.iter().map(|(code, _)| *code).collect();
    let mut scans: Vec<u32> = KEYS.iter().map(|(_, scan)| *scan).collect();
    codes.sort_unstable();
    scans.sort_unstable();
    codes.dedup();
    scans.dedup();
    assert_eq!(codes.len(), KEYS.len());
    assert_eq!(scans.len(), KEYS.len());
  }

  #[test]
  fn the_command_is_empty_off_windows() {
    if cfg!(not(target_os = "windows")) {
      assert!(altgr_table().is_empty());
    }
  }
}
