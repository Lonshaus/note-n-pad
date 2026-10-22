// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Which edition is running: full, or Lite (the packaged MSIX build while its
// license is a trial, and the sandboxed store build until the full version is
// bought). Everything that cuts a feature asks `is_lite()`; the
// frontend mirrors the answer in `editionState`, kept in sync by `edition_info`
// and the `edition-changed` event.
//
// The flag starts as lite (fail-safe) and `init` settles it in `setup` before
// any window or edition-dependent menu is built, so no consumer ever sees the
// initial value. Gating itself lives at the feature entry points, not here.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

/// The name the app calls itself. The Windows trial is the full package and
/// never changes its name.
pub const fn app_name() -> &'static str {
  "Note&Pad"
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

/// The one decision outside the sandboxed store build: is this process lite?
/// `packaged` is "runs from an MSIX package"; an unpackaged process (any
/// unpackaged Windows build, macOS, Linux) is never lite on its own.
#[cfg_attr(all(target_os = "macos", feature = "storekit"), allow(dead_code))]
pub fn resolve(packaged: bool, license: LicenseRead) -> bool {
  if !packaged {
    return false;
  }
  license != LicenseRead::Full
}

/// Whether this process is lite right now.
pub fn is_lite() -> bool {
  LITE.load(Ordering::Relaxed)
}

/// Whether a build has editions at all, and so the "Full Version Features"
/// window and its Help item: the sandboxed store build and an MSIX package do.
#[cfg_attr(all(target_os = "macos", feature = "storekit"), allow(dead_code))]
pub fn has_editions(storekit: bool, packaged: bool) -> bool {
  storekit || packaged
}

/// Set by `init`.
static HAS_EDITIONS: AtomicBool = AtomicBool::new(false);

/// Whether this process has editions.
pub fn editions_exist() -> bool {
  HAS_EDITIONS.load(Ordering::Relaxed)
}

/// The open-workspace-on-startup setting, taken by whichever of the startup
/// check and a late launch read sees the full edition first.
#[cfg(all(target_os = "macos", feature = "storekit"))]
pub(crate) static STARTUP_WORKSPACE_TOKEN: AtomicBool = AtomicBool::new(false);

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

/// The refusal for something that exists only in a build with editions; `Ok`
/// when `editions`.
pub(crate) fn refuse_unless_editions(editions: bool, what: &str) -> Result<(), String> {
  if editions {
    Ok(())
  } else {
    Err(format!("{what} exists only in a build with editions"))
  }
}

/// Entry-point guard of something that only a build with editions has.
pub(crate) fn require_editions(what: &str) -> Result<(), String> {
  refuse_unless_editions(editions_exist(), what)
}

/// Entry-point guard of a command that belongs to a removed feature.
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
/// edition-dependent menu exists; it may block for the license or store read
/// (3 s at most).
pub fn init(app: &AppHandle) {
  #[cfg(debug_assertions)]
  {
    debug_delay();
    let value = std::env::var("NOTENPAD_EDITION").ok();
    if let Some(lite) = parse_override(value.as_deref()) {
      // So the window can be exercised in a build that has no editions.
      HAS_EDITIONS.store(true, Ordering::Relaxed);
      LITE.store(lite, Ordering::Relaxed);
      return;
    }
  }
  #[cfg(all(target_os = "macos", feature = "storekit"))]
  {
    HAS_EDITIONS.store(true, Ordering::Relaxed);
    let (tx, rx) = std::sync::mpsc::channel();
    let worker_app = app.clone();
    std::thread::spawn(move || {
      crate::storekit::watch(&worker_app);
      let owned_ticket = crate::storekit::state().take_ticket();
      let owned = crate::storekit::read_owned();
      let original_ticket = crate::storekit::state().take_ticket();
      let original = crate::storekit::read_original();
      let _ = tx.send(InitRead {
        owned_ticket,
        owned,
        original_ticket,
        original,
      });
    });
    match rx.recv_timeout(READ_TIMEOUT) {
      Ok(read) => {
        let mut state = crate::storekit::state();
        state.apply(read.owned_ticket, Some(read.owned), None);
        state.apply(read.original_ticket, None, Some(read.original));
        LITE.store(state.lite(), Ordering::Relaxed);
      }
      Err(_) => on_init_timeout(app, rx),
    }
  }
  #[cfg(not(all(target_os = "macos", feature = "storekit")))]
  {
    let (packaged, license) = read_license(app);
    HAS_EDITIONS.store(
      has_editions(cfg!(feature = "storekit"), packaged),
      Ordering::Relaxed,
    );
    LITE.store(resolve(packaged, license), Ordering::Relaxed);
  }
}

/// What the launch store read found, with the ticket each of its two reads took
/// when it started.
#[cfg(all(target_os = "macos", feature = "storekit"))]
struct InitRead {
  owned_ticket: u64,
  owned: crate::store_state::StoreRead,
  original_ticket: u64,
  original: crate::store_state::OriginalRead,
}

/// The launch read outlived `setup`'s wait: the edition stays lite, and the
/// read is applied whenever it lands.
#[cfg(all(target_os = "macos", feature = "storekit"))]
fn on_init_timeout(app: &AppHandle, rx: std::sync::mpsc::Receiver<InitRead>) {
  let late_app = app.clone();
  std::thread::spawn(move || {
    if let Ok(read) = rx.recv() {
      apply_late_init(&late_app, read);
    }
  });
}

/// Apply a late launch read with its own tickets, then open the workspace the
/// startup check skipped while the edition was still lite.
#[cfg(all(target_os = "macos", feature = "storekit"))]
fn apply_late_init(app: &AppHandle, read: InitRead) {
  use crate::store_state::{late_open, takes_token, LateSource};
  crate::storekit::apply(app, read.owned_ticket, Some(read.owned), None);
  let now_lite = crate::storekit::apply(app, read.original_ticket, None, Some(read.original));
  let took = takes_token(LateSource::Init) && STARTUP_WORKSPACE_TOKEN.swap(false, Ordering::SeqCst);
  if late_open(LateSource::Init, took, now_lite) {
    let main_app = app.clone();
    let _ = app.run_on_main_thread(move || {
      let _ = crate::windows::show_workspace(&main_app);
    });
  }
}

/// Store a new value and tell everyone: the flag, every window (`edition-changed`
/// with the new `lite` as payload), and the native menus (app menu, tray, Jump
/// List). Returns whether the value changed; an unchanged value does nothing.
/// The license-changed handler, the store reads and the debug command all come
/// through here.
#[cfg_attr(
  all(
    not(debug_assertions),
    not(target_os = "windows"),
    not(all(target_os = "macos", feature = "storekit"))
  ),
  allow(dead_code)
)]
pub(crate) fn set_lite(app: &AppHandle, lite: bool) -> bool {
  if LITE.swap(lite, Ordering::Relaxed) == lite {
    return false;
  }
  let _ = app.emit("edition-changed", lite);
  let app_for_main = app.clone();
  if let Err(e) = app.run_on_main_thread(move || {
    if lite {
      // The workspace is gone in lite; an open one goes with it.
      if let Some(window) = app_for_main.get_webview_window("workspace") {
        let _ = window.destroy();
      }
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
  set_lite(&app, lite);
  Ok(())
}

#[cfg(not(any(target_os = "windows", all(target_os = "macos", feature = "storekit"))))]
fn read_license(_app: &AppHandle) -> (bool, LicenseRead) {
  (false, LicenseRead::Failed)
}

/// How long `setup` waits for the first license or store read before calling
/// it unreadable (and so lite).
#[cfg(any(target_os = "windows", all(target_os = "macos", feature = "storekit")))]
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
          set_lite(&late_app, resolve(true, late));
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
  use super::{resolve, set_lite, LicenseRead};
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
      set_lite(&app, resolve(true, late.0));
    }
    while changed_rx.recv().is_ok() {
      set_lite(&app, resolve(true, read(&context)));
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn packaged_unreadable_license_is_lite() {
    assert!(resolve(true, LicenseRead::Failed));
  }

  #[test]
  fn packaged_timed_out_read_is_lite() {
    assert!(resolve(true, LicenseRead::TimedOut));
  }

  #[test]
  fn packaged_full_license_is_full() {
    assert!(!resolve(true, LicenseRead::Full));
  }

  #[test]
  fn packaged_trial_is_lite() {
    assert!(resolve(true, LicenseRead::Trial));
  }

  #[test]
  fn unpackaged_is_full_whatever_the_license() {
    for license in [
      LicenseRead::Full,
      LicenseRead::Trial,
      LicenseRead::Failed,
      LicenseRead::TimedOut,
    ] {
      assert!(!resolve(false, license));
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

  #[test]
  fn the_full_build_keeps_its_name() {
    assert_eq!(app_name(), "Note&Pad");
  }

  #[test]
  fn editions_exist_in_the_store_build_and_in_a_package_only() {
    assert!(has_editions(true, false));
    assert!(has_editions(false, true));
    assert!(has_editions(true, true));
    assert!(!has_editions(false, false));
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
  fn refuse_unless_editions_refuses_without_editions() {
    assert!(refuse_unless_editions(true, "x").is_ok());
    assert!(refuse_unless_editions(false, "x").is_err());
  }

  #[test]
  fn the_full_features_window_refuses_without_editions() {
    assert_guarded(
      include_str!("windows.rs"),
      &["show_edition"],
      "crate::edition::require_editions(",
    );
  }

  #[test]
  fn the_edition_window_stays_open_when_the_edition_turns_full() {
    // It shows the edition it is in, and follows `edition-changed`.
    let set_lite = body_of(include_str!("edition.rs"), "set_lite");
    assert!(!set_lite.contains("get_webview_window(\"edition\")"));
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

  #[test]
  fn the_syntax_menu_follows_the_edition() {
    assert_guarded(include_str!("lib.rs"), &["build_menu"], "syntax_entries(");
  }

  const STORE_COMMANDS: &[&str] = &[
    "store_info",
    "store_purchase",
    "store_restore",
    "store_refresh_original",
  ];

  /// The part of `body` compiled into the sandboxed store build.
  fn store_branch(body: &str) -> &str {
    let at = body
      .find("#[cfg(all(target_os = \"macos\", feature = \"storekit\"))]")
      .expect("a store branch");
    let rest = &body[at..];
    &rest[..rest
      .find("#[cfg(not(all(target_os = \"macos\", feature = \"storekit\")))]")
      .expect("a branch without the store")]
  }

  /// The store commands whose StoreKit call can wait on the user indefinitely.
  const INTERACTIVE_STORE_COMMANDS: &[&str] =
    &["store_purchase", "store_restore", "store_refresh_original"];

  #[test]
  fn every_store_command_runs_off_the_main_thread() {
    // StoreKit calls block until the store answers, and the purchase waits on
    // the main thread's run loop. A plain `#[tauri::command]` on a sync `fn`
    // would run on the main thread.
    let lib = include_str!("lib.rs");
    for name in STORE_COMMANDS {
      let at = lib
        .find(&format!("fn {name}("))
        .unwrap_or_else(|| panic!("{name} is listed here but no longer exists"));
      let before = lib[..at].trim_end();
      let off_main = before.ends_with("#[tauri::command(async)]")
        || (before.ends_with("async")
          && before
            .trim_end_matches("async")
            .trim_end()
            .ends_with("#[tauri::command]"));
      assert!(
        off_main,
        "{name} must be #[tauri::command(async)] or an async fn"
      );
    }
  }

  #[test]
  fn an_interactive_store_call_waits_on_the_blocking_pool() {
    // An open purchase sheet or sign-in prompt must not hold an async worker.
    let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lib = include_str!("lib.rs");
    for name in INTERACTIVE_STORE_COMMANDS {
      let branch = flat(store_branch(body_of(lib, name)));
      let caller = branch
        .find("store_state::store_caller_allowed(")
        .unwrap_or_else(|| panic!("{name} must check its caller"));
      let blocking = branch
        .find("tauri::async_runtime::spawn_blocking(move || storekit::")
        .unwrap_or_else(|| panic!("{name} must call StoreKit on the blocking pool"));
      assert!(caller < blocking, "{name} must check its caller first");
      assert_eq!(branch.matches("storekit::").count(), 1, "{name}");
    }
  }

  #[test]
  fn only_the_edition_window_reaches_the_store() {
    let lib = include_str!("lib.rs");
    for name in ["store_purchase", "store_restore", "store_refresh_original"] {
      assert!(
        store_branch(body_of(lib, name)).contains("store_state::store_caller_allowed("),
        "{name} must check its caller in the store build"
      );
    }
  }

  #[test]
  fn retry_signs_in_before_rereading_the_original() {
    let refresh = body_of(include_str!("storekit.rs"), "refresh");
    let sync = refresh
      .find("np_store_sync()")
      .expect("Retry must sync to sign in");
    let original = refresh
      .find("refresh_original()")
      .expect("Retry must re-read the original");
    assert!(
      sync < original,
      "sync must come before the original re-read"
    );
    assert!(refresh.contains("if unsafe { np_store_sync() } == 1 {\n    reread_owned(app);\n  }"));
    assert_eq!(refresh.matches("reread_owned(").count(), 1);
  }

  #[test]
  fn a_build_without_the_store_neither_reads_nor_shows_it() {
    let lib = include_str!("lib.rs");
    let info = body_of(lib, "store_info");
    let without = &info[info
      .find("#[cfg(not(all(target_os = \"macos\", feature = \"storekit\")))]")
      .expect("a branch without the store")..];
    assert!(without.contains("store_state::StoreInfo::unavailable()"));
    for name in ["store_purchase", "store_restore", "store_refresh_original"] {
      let body = body_of(lib, name);
      let without = &body[body
        .find("#[cfg(not(all(target_os = \"macos\", feature = \"storekit\")))]")
        .expect("a branch without the store")..];
      assert!(!without.contains("storekit::"), "{name}");
      assert!(without.contains("\"failed\""), "{name}");
    }
  }

  #[test]
  fn the_store_branch_of_init_never_falls_through_to_the_license_read() {
    let init = body_of(include_str!("edition.rs"), "init");
    assert!(init.contains(
      "  #[cfg(not(all(target_os = \"macos\", feature = \"storekit\")))]\n  {\n    let (packaged, license) = read_license(app);"
    ));
    assert_eq!(init.matches("read_license(").count(), 1);
    assert!(store_branch(init).contains("HAS_EDITIONS.store(true"));
  }

  #[test]
  fn only_the_startup_check_and_the_late_launch_read_take_the_token() {
    let swap = format!("{}.swap(", "STARTUP_WORKSPACE_TOKEN");
    let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sites = Vec::new();
    for entry in std::fs::read_dir(src).unwrap() {
      let path = entry.unwrap().path();
      if path.extension().is_some_and(|ext| ext == "rs") {
        let text = std::fs::read_to_string(&path).unwrap();
        for _ in text.matches(&swap) {
          sites.push(path.file_name().unwrap().to_string_lossy().into_owned());
        }
      }
    }
    sites.sort();
    assert_eq!(sites, vec!["edition.rs", "lib.rs"]);
    assert!(
      flat(body_of(include_str!("edition.rs"), "apply_late_init")).contains(&format!(
        "let took = takes_token(LateSource::Init) && {swap}false, Ordering::SeqCst);"
      ))
    );
    assert!(flat(include_str!("lib.rs")).contains(&format!(
      "edition::workspace_enabled(edition::is_lite()) && edition::{swap}false, Ordering::SeqCst)"
    )));
  }

  #[test]
  fn a_launch_read_that_times_out_writes_nothing_and_takes_no_ticket() {
    let edition = include_str!("edition.rs");
    let init = body_of(edition, "init");
    let lines: Vec<&str> = init.lines().map(str::trim).collect();
    assert!(lines.contains(&"Err(_) => on_init_timeout(app, rx),"));
    assert!(!init.contains("apply_late_init("));
    let timeout = body_of(edition, "on_init_timeout");
    assert!(timeout.contains("apply_late_init("));
    assert!(!timeout.contains("take_ticket("));
    assert!(!timeout.contains(".apply("));
    assert!(!body_of(edition, "apply_late_init").contains("take_ticket("));
  }
}
