// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

//! Startup check for the Microsoft Edge WebView2 Runtime.
//!
//! Windows 11 ships the runtime; Windows 10 does not, and Microsoft's rollout
//! to it is best-effort — it never covered builds before 1803, and an
//! administrator can suppress it through the WebView2 install policy. Without
//! the runtime every window fails to build, which used to end the launch with
//! no window and no message at all. Checking first turns that into a sentence
//! the user can act on.
//!
//! Detection defers to `tauri::webview_version()`, the same call Tauri's own
//! webview creation path uses, so this check can never disagree with the one
//! Tauri makes on its own. Only the message box is Windows-only.

#[cfg(target_os = "windows")]
mod win {
  pub use std::iter::once;
  pub use std::ptr::null_mut;
  pub use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
}
#[cfg(target_os = "windows")]
use win::*;

/// Microsoft's permanent link to the Evergreen bootstrapper.
#[cfg(target_os = "windows")]
pub const DOWNLOAD_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

/// Whether a usable WebView2 Runtime is available on this machine, by
/// Tauri's own reckoning — the same `webview_runtime_installed` check it
/// runs before building a webview.
#[cfg(target_os = "windows")]
pub fn runtime_installed() -> bool {
  match tauri::webview_version() {
    Ok(v) => {
      log::info!("WebView2 Runtime {v} detected");
      true
    }
    Err(e) => {
      log::warn!("no usable WebView2 Runtime found: {e}");
      false
    }
  }
}

/// Show a native message box. Native because the whole point is that no
/// webview can be created, so every in-app surface is unavailable.
#[cfg(target_os = "windows")]
pub fn report_missing(title: &str, body: &str) {
  let title: Vec<u16> = title.encode_utf16().chain(once(0)).collect();
  let body: Vec<u16> = body.encode_utf16().chain(once(0)).collect();
  unsafe {
    MessageBoxW(
      null_mut(),
      body.as_ptr(),
      title.as_ptr(),
      MB_OK | MB_ICONERROR,
    );
  }
}
