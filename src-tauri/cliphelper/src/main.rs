// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Holds one clip file's text on the Windows clipboard and renders it to
//! UTF-16 on demand, so the app that made the clip never holds it in memory.
//! No console window; the app talks to it over stdin and stdout.
#![windows_subsystem = "windows"]
// Off Windows only the conversion and its tests are built.
#![cfg_attr(not(windows), allow(dead_code))]

mod convert;
#[cfg(windows)]
mod win;

#[cfg(windows)]
fn main() {
  win::run();
}

#[cfg(not(windows))]
fn main() {
  eprintln!("cliphelper only runs on Windows");
}
