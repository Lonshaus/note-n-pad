// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Force the GTK/WebKit stack onto XWayland before any GTK or Tauri init.
  // Under native Wayland, GTK's keep-above (always-on-top) is silently ignored
  // with no error returned, so the sticky "pin on top" feature cannot work.
  // Running through XWayland is the only mechanism that honors always-on-top
  // across every desktop environment, so we default the backend to X11 — but
  // respect an explicit GDK_BACKEND the user already set (advanced escape hatch).
  #[cfg(target_os = "linux")]
  if std::env::var_os("GDK_BACKEND").is_none() {
    std::env::set_var("GDK_BACKEND", "x11");
  }
  note_n_pad_lib::run();
}
