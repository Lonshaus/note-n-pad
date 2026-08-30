// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use serde::Serialize;

/// Host-platform facts the frontend needs for platform-conditional UI (hiding
/// the macOS-only iCloud option, showing the Wayland pin-degrade note).
#[derive(Debug, Clone, Serialize)]
pub struct PlatformInfo {
  /// `std::env::consts::OS`: `macos` / `windows` / `linux` / ...
  pub os: String,
  /// Lowercased `XDG_SESSION_TYPE` on Linux (`wayland` / `x11`); empty elsewhere.
  pub session: String,
}

/// The current display session string. Only meaningful on Linux; empty on other
/// platforms, which have a single windowing system.
#[cfg(target_os = "linux")]
fn session() -> String {
  std::env::var("XDG_SESSION_TYPE")
    .unwrap_or_default()
    .to_ascii_lowercase()
}

#[cfg(not(target_os = "linux"))]
fn session() -> String {
  String::new()
}

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
  PlatformInfo {
    os: std::env::consts::OS.to_string(),
    session: session(),
  }
}

/// Pure core of the window-chrome dark decision, mirroring the frontend's
/// `interfaceIsDark` in `src/lib/theme/chrome.ts`: `"system"` follows the OS
/// preference, any other mode is dark only if it is literally `"dark"`. An
/// unknown mode string (never emitted by the frontend, but not rejected either)
/// falls through to the `"light"` behavior, same as the frontend's `mode ===
/// 'dark'` check.
pub fn interface_is_dark(interface_mode: &str, prefers_dark: bool) -> bool {
  if interface_mode == "system" {
    prefers_dark
  } else {
    interface_mode == "dark"
  }
}

/// Ask the OS whether it is currently in dark mode. Used to resolve the
/// `"system"` interface mode before a window's first paint, so the pre-reveal
/// background color (see `windows.rs`) already matches the chrome the frontend
/// is about to draw. Any detection failure falls back to light, never panics.
#[cfg(target_os = "macos")]
pub fn system_prefers_dark() -> bool {
  use std::sync::atomic::Ordering;
  // NSApplication/NSAppearance are AppKit and thus main-thread-only, but
  // `create_sticky_window` reaches this from a worker via the `(async)`
  // `new_sticky_note` command. Off the main thread, fall back to the value
  // seeded by `prime_dark_preference` at startup (main thread, see lib.rs's
  // `setup`) -- mirrors the Linux design below.
  if objc2::MainThreadMarker::new().is_none() {
    return LAST_PREFERS_DARK.load(Ordering::Relaxed);
  }
  let prefers_dark = macos_query_prefers_dark();
  LAST_PREFERS_DARK.store(prefers_dark, Ordering::Relaxed);
  prefers_dark
}

/// The actual NSApp appearance query. Caller must be on the main thread.
#[cfg(target_os = "macos")]
fn macos_query_prefers_dark() -> bool {
  use objc2::msg_send;
  use objc2::runtime::AnyClass;
  use objc2::runtime::AnyObject;
  // Contained unsafe: ask NSApp for its effective appearance name and check
  // whether it names a dark variant (e.g. "NSAppearanceNameDarkAqua"). Uses
  // untyped AnyObject sends (like `apply_opacity` above) so no extra
  // objc2-app-kit feature (NSAppearance) is needed for this one lookup.
  unsafe {
    let Some(cls) = AnyClass::get(c"NSApplication") else {
      return false;
    };
    let app: *mut AnyObject = msg_send![cls, sharedApplication];
    if app.is_null() {
      return false;
    }
    let appearance: *mut AnyObject = msg_send![app, effectiveAppearance];
    if appearance.is_null() {
      return false;
    }
    let name: *mut AnyObject = msg_send![appearance, name];
    if name.is_null() {
      return false;
    }
    let utf8: *const std::os::raw::c_char = msg_send![name, UTF8String];
    if utf8.is_null() {
      return false;
    }
    std::ffi::CStr::from_ptr(utf8)
      .to_string_lossy()
      .contains("Dark")
  }
}

#[cfg(target_os = "windows")]
pub fn system_prefers_dark() -> bool {
  use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
  let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect();
  let value: Vec<u16> = "AppsUseLightTheme"
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect();
  let mut data: u32 = 0;
  let mut size: u32 = std::mem::size_of::<u32>() as u32;
  // Contained unsafe: a single read-only registry query, ignored on any error
  // (missing key on older builds, wrong type, etc.) in favor of the light
  // fallback.
  let ok = unsafe {
    RegGetValueW(
      HKEY_CURRENT_USER,
      subkey.as_ptr(),
      value.as_ptr(),
      RRF_RT_REG_DWORD,
      std::ptr::null_mut(),
      &mut data as *mut u32 as *mut _,
      &mut size,
    )
  };
  // AppsUseLightTheme: 0 means dark, 1 (or missing/error) means light.
  ok == 0 && data == 0
}

/// What the OS last said, for callers that may not ask it themselves (i.e. off
/// the main thread, where GTK/AppKit may not be touched).
#[cfg(any(target_os = "linux", target_os = "macos"))]
static LAST_PREFERS_DARK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Seeds the cache from the main thread during setup. No-op elsewhere.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn prime_dark_preference() {
  let _ = system_prefers_dark();
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn prime_dark_preference() {}

#[cfg(target_os = "linux")]
pub fn system_prefers_dark() -> bool {
  use gtk::glib::object::ObjectExt;
  use std::sync::atomic::Ordering;
  // gtk-rs panics rather than erroring when touched off the main thread, and
  // window builders now ask for this from a worker thread.
  if !gtk::is_initialized_main_thread() {
    return LAST_PREFERS_DARK.load(Ordering::Relaxed);
  }
  let Some(settings) = gtk::Settings::default() else {
    return LAST_PREFERS_DARK.load(Ordering::Relaxed);
  };
  // Read the property directly (rather than a generated getter) so this does
  // not depend on the exact accessor name gtk-rs happens to generate for it.
  let prefers_dark = settings.property::<bool>("gtk-application-prefer-dark-theme");
  LAST_PREFERS_DARK.store(prefers_dark, Ordering::Relaxed);
  prefers_dark
}

/// Mobile targets (Android/iOS) have no OS dark-mode probe wired up here; the
/// desktop-only window chrome that consumes this never builds for them
/// anyway, but the fallback keeps this function total across every target.
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn system_prefers_dark() -> bool {
  false
}

#[cfg(test)]
mod tests {
  use super::interface_is_dark;

  #[test]
  fn system_mode_follows_os_preference() {
    assert!(interface_is_dark("system", true));
    assert!(!interface_is_dark("system", false));
  }

  #[test]
  fn dark_mode_is_always_dark() {
    assert!(interface_is_dark("dark", true));
    assert!(interface_is_dark("dark", false));
  }

  #[test]
  fn light_mode_is_never_dark() {
    assert!(!interface_is_dark("light", true));
    assert!(!interface_is_dark("light", false));
  }

  #[test]
  fn unknown_mode_falls_back_to_light() {
    assert!(!interface_is_dark("bogus", true));
    assert!(!interface_is_dark("bogus", false));
  }
}

/// Exercises `LAST_PREFERS_DARK` directly, the one piece of the off-main-thread
/// fallback that is a pure value rather than an AppKit/GTK call. Whether the
/// current thread counts as "main" is not assertable from a `#[cfg(test)]`
/// harness (there is no Tauri window and no guarantee about which thread runs
/// a given test), and there is no Tauri test harness wired up in this crate, so
/// `system_prefers_dark`'s live query and its main-thread branch are not
/// covered here.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod dark_preference_cache_tests {
  use super::LAST_PREFERS_DARK;
  use std::sync::atomic::Ordering;

  #[test]
  fn cache_round_trips_through_store_and_load() {
    LAST_PREFERS_DARK.store(true, Ordering::Relaxed);
    assert!(LAST_PREFERS_DARK.load(Ordering::Relaxed));
    LAST_PREFERS_DARK.store(false, Ordering::Relaxed);
    assert!(!LAST_PREFERS_DARK.load(Ordering::Relaxed));
  }
}
