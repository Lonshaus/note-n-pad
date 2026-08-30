// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Make a disabled Windows menu item *look* disabled.
//!
//! muda greys items correctly when it first appends them (`MF_GRAYED`), but
//! `set_enabled(false)` afterwards goes through `EnableMenuItem` with
//! `MF_DISABLED`, and Win32 defines that flag as "disable, but do not gray".
//! Every item this app disables at runtime — the whole Format submenu, New Tab,
//! Open, Save As, Show in File Explorer, Copy File Path — therefore renders
//! exactly like a working one on Windows and simply swallows the click, with no
//! hint why. macOS greys the same items, so this is Windows diverging from the
//! reference platform, not a design difference.
//!
//! The repair is a sweep over the live `HMENU` after the app has finished
//! setting its enabled flags: anything marked `MF_DISABLED` without `MF_GRAYED`
//! is re-marked by *position* (`MF_BYCOMMAND` cannot address an item that opens
//! a submenu). Enabling an item later clears both bits, so the sweep never has
//! to undo itself.

/// How deep the sweep follows submenus. The real menu is three levels
/// (bar → Format → Line Endings); the cap only stops a cycle from hanging the
/// UI thread, since Win32 lets two menus share one popup handle.
#[cfg(target_os = "windows")]
const MAX_DEPTH: u32 = 6;

/// Re-mark every disabled-but-not-greyed item in each window's menu bar. Call
/// after any change to the menu's enabled flags. No-op on platforms whose
/// toolkit greys disabled items on its own.
#[cfg(target_os = "windows")]
pub fn gray_disabled_items(app: &tauri::AppHandle) {
  use tauri::Manager;
  use windows_sys::Win32::UI::WindowsAndMessaging::{DrawMenuBar, GetMenu};
  for window in app.webview_windows().values() {
    let Ok(hwnd) = window.hwnd() else {
      continue;
    };
    let hwnd = hwnd.0 as isize;
    let menu = unsafe { GetMenu(hwnd as _) };
    if menu.is_null() {
      continue;
    }
    if sweep(menu, 0) {
      // Only when something actually changed: the menu bar repaints on the UI
      // thread and there is no reason to ask for it on every focus change.
      unsafe { DrawMenuBar(hwnd as _) };
    }
  }
}

#[cfg(not(target_os = "windows"))]
pub fn gray_disabled_items(_app: &tauri::AppHandle) {}

/// Walk one menu level, greying what needs it and recursing into submenus.
/// Returns whether anything changed.
#[cfg(target_os = "windows")]
fn sweep(menu: *mut core::ffi::c_void, depth: u32) -> bool {
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnableMenuItem, GetMenuItemCount, GetMenuState, GetSubMenu, MF_BYPOSITION, MF_DISABLED,
    MF_GRAYED, MF_POPUP,
  };
  if depth >= MAX_DEPTH {
    return false;
  }
  let count = unsafe { GetMenuItemCount(menu) };
  if count <= 0 {
    return false;
  }
  let mut changed = false;
  for index in 0..count as u32 {
    // For an item that opens a submenu the high byte carries the child count,
    // so only the low byte holds the flags.
    let state = unsafe { GetMenuState(menu, index, MF_BYPOSITION) } & 0xFF;
    if state & MF_DISABLED != 0 && state & MF_GRAYED == 0 {
      unsafe { EnableMenuItem(menu, index, MF_BYPOSITION | MF_GRAYED) };
      changed = true;
    }
    if state & MF_POPUP != 0 {
      let sub = unsafe { GetSubMenu(menu, index as i32) };
      if !sub.is_null() {
        changed |= sweep(sub, depth + 1);
      }
    }
  }
  changed
}
