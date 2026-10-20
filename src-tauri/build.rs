// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use std::path::PathBuf;
use std::process::Command;

fn main() {
  // The manifest is ours only to declare DPI awareness; see windows/app.manifest.
  let windows =
    tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows/app.manifest"));
  tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
    .expect("failed to run tauri-build");
  let macos = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");
  if macos && std::env::var_os("CARGO_FEATURE_STOREKIT").is_some() {
    build_storekit_bridge();
  }
}

/// The output of `xcrun <args>`, trimmed.
fn xcrun(args: &[&str]) -> String {
  let output = Command::new("xcrun")
    .args(args)
    .output()
    .expect("failed to run xcrun");
  assert!(output.status.success(), "xcrun {args:?} failed");
  String::from_utf8(output.stdout)
    .expect("xcrun printed non-UTF-8")
    .trim()
    .to_owned()
}

/// Compile storekit/NPStore.swift into a static library for the target arch
/// and link it with StoreKit and the system Swift runtime.
fn build_storekit_bridge() {
  println!("cargo:rerun-if-changed=storekit/NPStore.swift");
  let arch = match std::env::var("CARGO_CFG_TARGET_ARCH")
    .expect("CARGO_CFG_TARGET_ARCH")
    .as_str()
  {
    "aarch64" => "arm64".to_owned(),
    other => other.to_owned(),
  };
  // Matches minimumSystemVersion in tauri.conf.json.
  let target = format!("{arch}-apple-macosx13.3");
  let sdk = xcrun(&["--show-sdk-path"]);
  let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
  let lib = out.join("libnpstore.a");
  let status = Command::new("xcrun")
    .args(["swiftc", "-emit-library", "-static", "-parse-as-library"])
    .args([
      "-module-name",
      "NPStore",
      "-O",
      "-target",
      &target,
      "-sdk",
      &sdk,
    ])
    .arg("-o")
    .arg(&lib)
    .arg("storekit/NPStore.swift")
    .status()
    .expect("failed to run swiftc");
  assert!(status.success(), "swiftc failed for {target}");
  println!("cargo:rustc-link-search=native={}", out.display());
  println!("cargo:rustc-link-lib=static=npstore");
  println!("cargo:rustc-link-lib=framework=StoreKit");
  println!("cargo:rustc-link-search=native={sdk}/usr/lib/swift");
  println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
