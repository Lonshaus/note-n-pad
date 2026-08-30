// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Clipboard *read* for the Linux custom Edit-menu Paste item (and Ctrl+V,
//! which the item's accelerator now intercepts). WebKitGTK blocks
//! `navigator.clipboard.readText()`, so the frontend falls back to this
//! command; every other platform keeps using the WebView's own clipboard API
//! and never calls it.

#[cfg(target_os = "linux")]
use std::sync::mpsc;
#[cfg(target_os = "linux")]
use std::time::Duration;

/// How long the command waits for the X11/Wayland clipboard owner to answer
/// before giving up. `gtk_clipboard_request_text` is asynchronous and never
/// blocks the GTK main loop itself; this bounds only our side of the wait, so
/// an unresponsive owner yields `None` instead of hanging the command forever
/// (the UI itself stays responsive either way).
#[cfg(target_os = "linux")]
const CLIPBOARD_READ_TIMEOUT: Duration = Duration::from_secs(2);

/// Read the system clipboard as text. `None` on any platform other than
/// Linux, or on Linux when there is no text on the clipboard, the request
/// times out, or the GTK call could not be scheduled at all.
/// LANDMINE: this must stay `async`. A synchronous command runs on the main
/// thread, where waiting on the reply deadlocks against the very closure
/// `run_on_main_thread` queued to produce it — measured as a guaranteed
/// timeout, never a read. Async commands run on the async runtime instead, so
/// the main loop is free to serve the clipboard request. The blocking wait
/// below therefore occupies a runtime worker, never the UI thread.
#[tauri::command]
pub async fn read_clipboard_text(app: tauri::AppHandle) -> Option<String> {
  read_clipboard_text_impl(app)
}

#[cfg(target_os = "linux")]
fn read_clipboard_text_impl(app: tauri::AppHandle) -> Option<String> {
  // `gtk::Clipboard::get` starts with `assert_initialized_main_thread!()`, and
  // `request_text`'s callback must run on the GTK main loop, so both are
  // dispatched via `run_on_main_thread` rather than called from this command's
  // worker thread directly.
  let (tx, rx) = mpsc::channel();
  if let Err(e) = app.run_on_main_thread(move || {
    let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
    clipboard.request_text(move |_clipboard, text| {
      let _ = tx.send(text.map(|s| s.to_string()));
    });
  }) {
    log::warn!("clipboard: could not reach the main thread: {e}");
    return None;
  }
  match rx.recv_timeout(CLIPBOARD_READ_TIMEOUT) {
    Ok(Some(text)) => {
      log::info!("clipboard: read {} chars", text.chars().count());
      Some(text)
    }
    Ok(None) => {
      log::info!("clipboard: owner answered with no text");
      None
    }
    Err(e) => {
      log::warn!("clipboard: no answer within the timeout: {e}");
      None
    }
  }
}

#[cfg(not(target_os = "linux"))]
fn read_clipboard_text_impl(_app: tauri::AppHandle) -> Option<String> {
  None
}
