// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Which edition is running: full, or Lite (the macOS Lite build, and the
// packaged MSIX build while its license is a trial). Everything that cuts a
// feature asks `is_lite()`; the frontend mirrors the answer in `editionState`,
// kept in sync by `edition_info` and the `edition-changed` event.
//
// The flag starts as lite (fail-safe) and `init` settles it in `setup` before
// any window or edition-dependent menu is built, so no consumer ever sees the
// initial value. Gating itself lives at the feature entry points, not here.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

/// The macOS Lite build: the answer is lite, constant.
const LITE_FEATURE: bool = cfg!(feature = "lite");

/// The name the app calls itself. Compile-time, like the bundle name: only the
/// macOS Lite build is named "Note&Pad Lite"; the Windows trial is the full
/// package and never changes its name.
pub const fn app_name() -> &'static str {
  if LITE_FEATURE {
    "Note&Pad Lite"
  } else {
    "Note&Pad"
  }
}

/// Lite until `init` says otherwise.
static LITE: AtomicBool = AtomicBool::new(true);

/// What the package license read returned. `Full` is
/// `IsActive && !IsTrial`; anything the read could not confirm is not `Full`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum LicenseRead {
  Full,
  Trial,
  Failed,
  TimedOut,
}

/// The one decision: is this process lite? `packaged` is "runs from an MSIX
/// package"; an unpackaged process (any unpackaged Windows build, macOS full,
/// Linux) is never lite on its own.
pub fn resolve(lite_feature: bool, packaged: bool, license: LicenseRead) -> bool {
  if lite_feature {
    return true;
  }
  if !packaged {
    return false;
  }
  license != LicenseRead::Full
}

/// Whether this process is lite right now.
pub fn is_lite() -> bool {
  LITE.load(Ordering::Relaxed)
}

/// What every refusal ends with. The frontend tells a refusal the edition caused
/// from one about the file by it (`LITE_REFUSAL` in `util/protocol.ts`).
pub(crate) const LITE_REFUSAL: &str = "is not available in the Lite edition";

/// The refusal a removed feature gives when `lite`; `Ok` otherwise. Pure so the
/// decision is testable without flipping the process-wide flag.
pub(crate) fn refuse_if(lite: bool, feature: &str) -> Result<(), String> {
  if lite {
    Err(format!("{feature} {LITE_REFUSAL}"))
  } else {
    Ok(())
  }
}

/// The refusal for something that exists only in lite; `Ok` when `lite`.
pub(crate) fn refuse_unless_lite(lite: bool, what: &str) -> Result<(), String> {
  if lite {
    Ok(())
  } else {
    Err(format!("{what} is only available in the Lite edition"))
  }
}

/// Entry-point guard of something that only the Lite edition has.
pub(crate) fn require_lite(what: &str) -> Result<(), String> {
  refuse_unless_lite(is_lite(), what)
}

/// Entry-point guard of a command that belongs to a removed feature.
#[cfg(not(feature = "lite"))]
pub(crate) fn require_full(feature: &str) -> Result<(), String> {
  refuse_if(is_lite(), feature)
}

/// Whether the workspace window and every way into it (View menu item, tray
/// item, Dock item, Jump List task, `--workspace`, open on startup) exist.
pub(crate) fn workspace_enabled(lite: bool) -> bool {
  !lite
}

/// The value of `NOTENPAD_EDITION`: `lite` or `full`, anything else is no override.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn parse_override(value: Option<&str>) -> Option<bool> {
  match value {
    Some("lite") => Some(true),
    Some("full") => Some(false),
    _ => None,
  }
}

/// The value of `NOTENPAD_EDITION_DELAY_MS`: a whole number of milliseconds.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn parse_delay_ms(value: Option<&str>) -> Option<u64> {
  value.and_then(|v| v.trim().parse().ok())
}

/// Debug builds: sleep for `NOTENPAD_EDITION_DELAY_MS`, standing in for a slow
/// license read so the startup ordering can be tested on any platform.
#[cfg(debug_assertions)]
fn debug_delay() {
  let value = std::env::var("NOTENPAD_EDITION_DELAY_MS").ok();
  if let Some(ms) = parse_delay_ms(value.as_deref()) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
  }
}

/// Settle the flag. Called once from `setup`, before the first window or
/// edition-dependent menu exists; it may block for the license read (3 s at
/// most).
pub fn init(app: &AppHandle) {
  #[cfg(debug_assertions)]
  {
    debug_delay();
    let value = std::env::var("NOTENPAD_EDITION").ok();
    if let (false, Some(lite)) = (LITE_FEATURE, parse_override(value.as_deref())) {
      LITE.store(lite, Ordering::Relaxed);
      return;
    }
  }
  let (packaged, license) = if LITE_FEATURE {
    (false, LicenseRead::Failed)
  } else {
    read_license(app)
  };
  LITE.store(resolve(LITE_FEATURE, packaged, license), Ordering::Relaxed);
}

/// Store a new value and tell everyone: the flag, every window (`edition-changed`
/// with the new `lite` as payload), and the native menus (app menu, tray, Jump
/// List). Returns whether the value changed; an unchanged value does nothing.
/// The license-changed handler and the debug command both come through here.
#[cfg_attr(
  all(not(debug_assertions), not(target_os = "windows")),
  allow(dead_code)
)]
pub(crate) fn set_lite(app: &AppHandle, lite: bool) -> bool {
  if LITE.swap(lite, Ordering::Relaxed) == lite {
    return false;
  }
  let _ = app.emit("edition-changed", lite);
  if !lite {
    // Document windows that were not opened (or were closed) in lite because
    // every tab they held was kept come back; the windows still open reload
    // their kept tabs themselves on `edition-changed`. Off this thread: a
    // window cannot be built from the event loop on Windows.
    let reopen_app = app.clone();
    std::thread::spawn(move || crate::windows::reopen_kept_groups(&reopen_app));
  }
  let app_for_main = app.clone();
  if let Err(e) = app.run_on_main_thread(move || {
    if lite {
      // The workspace is gone in lite; an open one goes with it.
      if let Some(window) = app_for_main.get_webview_window("workspace") {
        let _ = window.destroy();
      }
    } else if let Some(window) = app_for_main.get_webview_window("edition") {
      // The full version has nothing to compare itself with.
      let _ = window.destroy();
    }
    let locale =
      crate::i18n::current_locale(&crate::settings::app_settings(&app_for_main).language);
    crate::rebuild_menus(&app_for_main, locale);
    log::info!(
      "edition-changed: {}; menus rebuilt",
      if lite { "lite" } else { "full" }
    );
  }) {
    log::warn!("edition-changed: could not reach the main thread: {e}");
  }
  true
}

#[tauri::command]
pub fn edition_info() -> bool {
  is_lite()
}

/// Debug builds only: flip the edition at runtime through the same path a
/// license change takes, so the unlock can be tested before publishing.
#[cfg(debug_assertions)]
#[tauri::command]
pub fn debug_set_edition(app: AppHandle, lite: bool) -> Result<(), String> {
  if LITE_FEATURE && !lite {
    return Err("the Lite build is always lite".to_string());
  }
  set_lite(&app, lite);
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn read_license(_app: &AppHandle) -> (bool, LicenseRead) {
  (false, LicenseRead::Failed)
}

/// How long `setup` waits for the first license read before calling it
/// unreadable (and so lite).
#[cfg(target_os = "windows")]
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Packaged processes read the package license on a worker thread, which keeps
/// running to watch for changes. Unpackaged ones have no license to read.
#[cfg(target_os = "windows")]
fn read_license(app: &AppHandle) -> (bool, LicenseRead) {
  if !crate::jumplist::has_package_identity() {
    return (false, LicenseRead::Failed);
  }
  let (tx, rx) = std::sync::mpsc::channel();
  let worker_app = app.clone();
  std::thread::spawn(move || store::watch(worker_app, tx));
  let license = match rx.recv_timeout(READ_TIMEOUT) {
    Ok(license) => license,
    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
      // The read can still land after the wait; keep listening so it is applied.
      let late_app = app.clone();
      std::thread::spawn(move || {
        if let Ok(late) = rx.recv() {
          set_lite(&late_app, resolve(LITE_FEATURE, true, late));
        }
      });
      LicenseRead::TimedOut
    }
    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => LicenseRead::Failed,
  };
  (true, license)
}

#[cfg(target_os = "windows")]
mod store {
  use super::{resolve, set_lite, LicenseRead, LITE_FEATURE};
  use std::sync::mpsc::{channel, Sender};
  use tauri::AppHandle;
  use windows::core::IInspectable;
  use windows::Foundation::TypedEventHandler;
  use windows::Services::Store::StoreContext;

  /// One read of the app license. Not active, or any API error, is not full.
  fn read(context: &StoreContext) -> LicenseRead {
    let license = match context.GetAppLicenseAsync().and_then(|op| op.get()) {
      Ok(license) => license,
      Err(e) => {
        log::warn!("edition: could not read the package license: {e}");
        return LicenseRead::Failed;
      }
    };
    match (license.IsActive(), license.IsTrial()) {
      (Ok(true), Ok(false)) => LicenseRead::Full,
      (Ok(true), Ok(true)) => LicenseRead::Trial,
      _ => LicenseRead::Failed,
    }
  }

  /// The worker thread: subscribe to license changes, read once and hand the
  /// result to `setup` through `first`, then re-read on every change for the
  /// life of the process (the StoreContext must stay alive for the
  /// subscription). A first read that outlived `setup`'s wait goes through the
  /// change path instead, so a slow Store still ends up right.
  pub(super) fn watch(app: AppHandle, first: Sender<LicenseRead>) {
    let context = match StoreContext::GetDefault() {
      Ok(context) => context,
      Err(e) => {
        log::warn!("edition: no Store context: {e}");
        let _ = first.send(LicenseRead::Failed);
        return;
      }
    };
    let (changed_tx, changed_rx) = channel::<()>();
    let handler = TypedEventHandler::<StoreContext, IInspectable>::new(move |_, _| {
      let _ = changed_tx.send(());
      Ok(())
    });
    if let Err(e) = context.OfflineLicensesChanged(&handler) {
      log::warn!("edition: could not subscribe to license changes: {e}");
    }
    if let Err(late) = first.send(read(&context)) {
      set_lite(&app, resolve(LITE_FEATURE, true, late.0));
    }
    while changed_rx.recv().is_ok() {
      set_lite(&app, resolve(LITE_FEATURE, true, read(&context)));
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lite_feature_is_always_lite() {
    for license in [
      LicenseRead::Full,
      LicenseRead::Trial,
      LicenseRead::Failed,
      LicenseRead::TimedOut,
    ] {
      assert!(resolve(true, false, license));
      assert!(resolve(true, true, license));
    }
  }

  #[test]
  fn packaged_unreadable_license_is_lite() {
    assert!(resolve(false, true, LicenseRead::Failed));
  }

  #[test]
  fn packaged_timed_out_read_is_lite() {
    assert!(resolve(false, true, LicenseRead::TimedOut));
  }

  #[test]
  fn packaged_full_license_is_full() {
    assert!(!resolve(false, true, LicenseRead::Full));
  }

  #[test]
  fn packaged_trial_is_lite() {
    assert!(resolve(false, true, LicenseRead::Trial));
  }

  #[test]
  fn unpackaged_is_full_whatever_the_license() {
    for license in [
      LicenseRead::Full,
      LicenseRead::Trial,
      LicenseRead::Failed,
      LicenseRead::TimedOut,
    ] {
      assert!(!resolve(false, false, license));
    }
  }

  #[test]
  fn override_parses_lite_and_full_only() {
    assert_eq!(parse_override(Some("lite")), Some(true));
    assert_eq!(parse_override(Some("full")), Some(false));
    assert_eq!(parse_override(Some("Lite")), None);
    assert_eq!(parse_override(Some("")), None);
    assert_eq!(parse_override(None), None);
  }

  #[test]
  fn delay_parses_whole_milliseconds_only() {
    assert_eq!(parse_delay_ms(Some("2000")), Some(2000));
    assert_eq!(parse_delay_ms(Some(" 15 ")), Some(15));
    assert_eq!(parse_delay_ms(Some("-1")), None);
    assert_eq!(parse_delay_ms(Some("2s")), None);
    assert_eq!(parse_delay_ms(None), None);
  }

  #[cfg(feature = "lite")]
  #[test]
  fn the_lite_build_is_named_lite() {
    assert_eq!(app_name(), "Note&Pad Lite");
  }

  #[cfg(not(feature = "lite"))]
  #[test]
  fn the_full_build_keeps_its_name() {
    assert_eq!(app_name(), "Note&Pad");
  }

  #[test]
  fn the_flag_starts_lite() {
    // Nothing in the test binary calls `init` or `set_lite`.
    assert!(is_lite());
  }
}

/// Each removed feature is cut at its entry points, which are Tauri commands and
/// menu builders that need a running app to call. So these read the sources, as
/// `heavy_io_command_threading_tests` does, and assert every listed entry point
/// carries its guard; deleting one makes the matching test fail.
#[cfg(test)]
mod gate_tests {
  use super::*;

  fn body_of<'a>(source: &'a str, name: &str) -> &'a str {
    let needle = format!("fn {name}(");
    let at = source
      .find(&needle)
      .unwrap_or_else(|| panic!("{name} is listed here but no longer exists"));
    let rest = &source[at..];
    &rest[..rest.find("\n}\n").expect("end of function")]
  }

  fn assert_guarded(source: &str, names: &[&str], guard: &str) {
    for name in names {
      assert!(
        body_of(source, name).contains(guard),
        "{name} must carry `{guard}`"
      );
    }
  }

  #[test]
  fn the_refusal_text_is_the_one_the_frontend_recognises() {
    let protocol = include_str!("../../src/lib/util/protocol.ts");
    let declared = protocol
      .split("export const LITE_REFUSAL =")
      .nth(1)
      .and_then(|rest| rest.split(';').next())
      .expect("LITE_REFUSAL in protocol.ts");
    assert_eq!(declared.trim(), format!("'{LITE_REFUSAL}'"));
    assert!(refuse_if(true, "anything")
      .unwrap_err()
      .ends_with(LITE_REFUSAL));
  }

  #[test]
  fn refuse_if_refuses_lite_and_lets_full_through() {
    assert!(refuse_if(true, "x").unwrap_err().contains("Lite"));
    assert!(refuse_if(false, "x").is_ok());
  }

  #[test]
  fn the_workspace_exists_only_in_full() {
    assert!(!workspace_enabled(true));
    assert!(workspace_enabled(false));
  }

  /// Every `pub fn` of `source` whose body carries the lite refusal.
  fn guarded(source: &str) -> Vec<String> {
    source
      .match_indices("pub fn ")
      .filter_map(|(at, _)| {
        let rest = &source[at + "pub fn ".len()..];
        let name = &rest[..rest.find('(')?];
        let end = rest.find("\n}\n")?;
        rest[..end]
          .contains("crate::edition::require_full(")
          .then(|| name.to_string())
      })
      .collect()
  }

  #[test]
  fn only_the_openers_of_a_removed_feature_refuse_in_lite() {
    // A lite session can only hold a large viewer, windowed session or range
    // tab that was opened while full, so everything that works on one stays
    // allowed. The guard list is exactly the commands that start a new one.
    assert_eq!(guarded(include_str!("windowed.rs")), vec!["windowed_open"]);
    assert_eq!(guarded(include_str!("range_edit.rs")), vec!["read_range"]);
    assert!(guarded(include_str!("large_file.rs")).is_empty());
  }

  #[test]
  fn commands_on_an_existing_handle_are_not_refused_in_lite() {
    for (source, names) in [
      (
        include_str!("large_file.rs"),
        &[
          "stat_file",
          "read_chunk",
          "start_line_index",
          "line_to_offset",
          "index_line_count",
          "stream_search",
        ][..],
      ),
      (
        include_str!("range_edit.rs"),
        &["file_fingerprint", "splice_file", "copy_range"][..],
      ),
      (
        include_str!("windowed.rs"),
        &[
          "windowed_reopen",
          "windowed_index",
          "windowed_read",
          "windowed_apply",
          "windowed_undo",
          "windowed_redo",
          "windowed_save",
          "windowed_find",
          "windowed_search",
          "windowed_replace_all",
        ][..],
      ),
    ] {
      for name in names {
        assert!(
          !body_of(source, name).contains("require_full("),
          "{name} works on an existing handle and must not refuse in lite"
        );
      }
    }
  }

  #[test]
  fn the_openers_carry_the_refusal() {
    assert_guarded(
      include_str!("windowed.rs"),
      &["windowed_open"],
      "crate::edition::require_full(",
    );
    assert_guarded(
      include_str!("range_edit.rs"),
      &["read_range"],
      "crate::edition::require_full(",
    );
  }

  #[test]
  fn theme_commands_refuse_in_lite() {
    assert_guarded(
      include_str!("theme_store.rs"),
      &[
        "save_theme",
        "delete_theme",
        "import_theme",
        "export_theme",
        "restore_default_theme",
      ],
      "crate::edition::require_full(",
    );
    assert!(body_of(include_str!("theme_store.rs"), "list_themes").contains("for_edition("));
  }

  #[test]
  fn locale_commands_refuse_in_lite() {
    let source = include_str!("locale_store.rs");
    assert_guarded(
      source,
      &["import_locale", "read_locale_file", "export_locale"],
      "crate::edition::require_full(",
    );
    assert_guarded(source, &["delete_locale"], "delete_allowed(");
    // Editing and restoring the default stay available.
    for name in ["save_locale", "restore_default_locale"] {
      assert!(!body_of(source, name).contains("edition::"), "{name}");
    }
  }

  #[test]
  fn deleting_a_data_file_follows_the_edition() {
    assert_guarded(
      include_str!("data_files.rs"),
      &["delete_data_file"],
      "delete_allowed(",
    );
  }

  #[test]
  fn refuse_unless_lite_refuses_full_and_lets_lite_through() {
    assert!(refuse_unless_lite(true, "x").is_ok());
    assert!(refuse_unless_lite(false, "x").unwrap_err().contains("Lite"));
  }

  #[test]
  fn the_full_features_window_refuses_when_full() {
    assert_guarded(
      include_str!("windows.rs"),
      &["show_edition"],
      "crate::edition::require_lite(",
    );
  }

  #[test]
  fn the_edition_window_closes_when_the_edition_turns_full() {
    let set_lite = body_of(include_str!("edition.rs"), "set_lite");
    assert!(set_lite.contains("get_webview_window(\"edition\")"));
  }

  #[test]
  fn the_workspace_command_refuses_in_lite() {
    assert_guarded(
      include_str!("windows.rs"),
      &["show_workspace"],
      "crate::edition::require_full(",
    );
  }

  #[test]
  fn every_workspace_entry_point_checks_the_edition() {
    let lib = include_str!("lib.rs");
    assert_guarded(
      lib,
      &["build_menu", "build_tray_menu"],
      "workspace_enabled(",
    );
    assert_guarded(lib, &["get_menu_accelerators"], "workspace_enabled(");
    assert_guarded(lib, &["trigger_menu_accelerator"], "workspace_enabled(");
    assert_guarded(
      lib,
      &["handle_second_launch", "handle_first_launch"],
      "for_edition(",
    );
    assert!(
      lib.contains("startup.open_workspace_on_startup && edition::workspace_enabled("),
      "the open-workspace-on-startup setting must be ignored in lite"
    );
    assert_guarded(
      include_str!("dock.rs"),
      &["build_menu"],
      "workspace_enabled(",
    );
    assert_guarded(
      include_str!("jumplist.rs"),
      &["build_tasks"],
      "workspace_enabled(",
    );
    assert_guarded(
      include_str!("shortcuts.rs"),
      &["get_shortcuts"],
      "rows_for_edition(",
    );
    assert_guarded(
      include_str!("shortcuts.rs"),
      &["resolve_current"],
      "workspace_enabled(",
    );
  }
  /// The commands of a cut feature are compiled out of the Lite binary, and the
  /// ones Lite keeps from the same modules stay in it.
  #[test]
  fn the_lite_binary_registers_only_the_commands_it_keeps() {
    let lib = include_str!("lib.rs");
    let start = lib.find("generate_handler![").unwrap();
    let handlers = &lib[start..start + lib[start..].find("])").unwrap()];
    let lines: Vec<&str> = handlers.lines().map(str::trim).collect();
    let cut_modules = ["large_file::", "range_edit::", "windowed::", "project::"];
    let cut_commands = [
      "theme_store::save_theme",
      "theme_store::delete_theme",
      "theme_store::import_theme",
      "theme_store::export_theme",
      "theme_store::restore_default_theme",
      "locale_store::import_locale",
      "locale_store::read_locale_file",
      "locale_store::export_locale",
      "windows::show_workspace_window",
      "windows::sticky_row_action",
      "windows::close_doc_tab",
      "ctx_menu::popup_row_menu",
      "file_ops::create_file",
      "file_ops::create_folder",
      "file_ops::rename_path",
      "file_ops::trash_path",
      "open_picked_files",
      "altgr::altgr_table",
    ];
    let kept_commands = [
      "theme_store::list_themes",
      "locale_store::list_locales",
      "locale_store::save_locale",
      "locale_store::delete_locale",
      "locale_store::restore_default_locale",
      "file_ops::reveal_in_finder",
      "windows::focus_doc_tab",
      "windows::live_doc_groups",
      "windows::open_document_group",
    ];
    let attribute = "#[cfg(not(feature = \"lite\"))]";
    for (i, line) in lines.iter().enumerate() {
      let name = line.trim_end_matches(',');
      let cut = cut_modules.iter().any(|m| name.starts_with(m)) || cut_commands.contains(&name);
      if cut {
        assert_eq!(
          lines[i - 1],
          attribute,
          "{name} must not be in the Lite build"
        );
      }
      if kept_commands.contains(&name) {
        assert_ne!(lines[i - 1], attribute, "{name} is kept in the Lite build");
      }
    }
    for name in cut_commands.iter().chain(&kept_commands) {
      assert!(
        lines.iter().any(|l| l.trim_end_matches(',') == *name),
        "{name}"
      );
    }
  }

  #[test]
  fn the_syntax_menu_follows_the_edition() {
    assert_guarded(include_str!("lib.rs"), &["build_menu"], "syntax_entries(");
  }
}
