// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

fn main() {
  // The manifest is ours only to declare DPI awareness; see windows/app.manifest.
  let windows =
    tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows/app.manifest"));
  tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
    .expect("failed to run tauri-build");
}
