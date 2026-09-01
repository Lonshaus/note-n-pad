// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Windows taskbar Jump List: the nearest equivalent of the macOS Dock
// right-click menu (`dock.rs`). Win32 has no API to hand an existing window a
// click from a Jump List item — every entry is a shell link that relaunches
// the executable with one of the `cmdline` flags, which the single-instance
// handler in `lib.rs` intercepts and routes with `cmdline::parse_args`.
//
// Built with the `windows` crate (COM), not `windows-sys` (raw FFI, no COM
// support) which the rest of the Windows-only code otherwise uses.
//
// COM is a per-thread apartment. `rebuild` initializes it, builds and commits
// the whole list, then uninitializes it before returning, so no COM object or
// apartment state is ever held between calls. Every failure path only logs
// and skips the rebuild — a missing Jump List is never a startup failure or a
// panic.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Manager;
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
use windows::Win32::System::Com::StructuredStorage::{
  InitPropVariantFromStringVector, PropVariantClear, PROPVARIANT,
};
use windows::Win32::System::Com::{
  CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
  DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW,
  SetCurrentProcessExplicitAppUserModelID, ShellLink,
};

use crate::dock_labels::sticky_label;
use crate::i18n::{self, Key};
use crate::note_store::NoteStore;

/// The app's AppUserModelID: the same value as the bundle identifier in
/// `tauri.conf.json`. Neither tauri nor tao sets one, and a Jump List only
/// attaches to the taskbar icon when the running process and the list agree
/// on this id, so `set_app_id` claims it explicitly and `build_and_commit`
/// stamps the same id on the list. Both are skipped under a package identity,
/// which brings its own id -- see `has_package_identity`.
const APP_ID: &str = "net.lonshaus.note-n-pad";

/// `GetCurrentPackageFullName`'s answer for an unpackaged process. Spelled out
/// because the `windows` crate exposes it only as a bare `WIN32_ERROR`.
const APPMODEL_ERROR_NO_PACKAGE: u32 = 15700;

/// Whether this process runs from an MSIX package. A packaged process already
/// owns an AppUserModelID -- the package's `<PFN>!App` -- and Explorer keys the
/// taskbar button on that one. Claiming our own id there does not fail; it
/// files the Jump List under the custom id instead, and the taskbar button
/// (still on the package id) shows only Windows' own "pin"/"close" entries.
/// Measured on Windows 11 with the Store package, which is why both the
/// process id claim and `SetAppID` below are skipped when this is true.
pub(crate) fn has_package_identity() -> bool {
  let mut len: u32 = 0;
  // Contained unsafe: the documented length probe. A packaged process answers
  // ERROR_INSUFFICIENT_BUFFER (the name does not fit in zero bytes), an
  // unpackaged one answers APPMODEL_ERROR_NO_PACKAGE.
  let rc = unsafe { GetCurrentPackageFullName(&mut len, None) };
  rc.0 != APPMODEL_ERROR_NO_PACKAGE
}

/// Claim the process AppUserModelID. Must run before any window is created
/// (called at the very top of `run()`); failure just means no Jump List ever
/// attaches, never a startup failure.
pub fn set_app_id() {
  if has_package_identity() {
    return;
  }
  if let Err(e) = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID)) } {
    log::warn!("failed to set AppUserModelID: {e}");
  }
}

/// Build a shell link that relaunches `exe` with `args`, titled `title`. A
/// Jump List reads an item's display title from its property store, not from
/// `IShellLinkW::SetDescription` (which Explorer ignores here).
fn make_link(exe: &HSTRING, args: &str, title: &str) -> windows::core::Result<IShellLinkW> {
  unsafe {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
    link.SetPath(exe)?;
    link.SetArguments(&HSTRING::from(args))?;
    link.SetIconLocation(exe, 0)?;
    let store: IPropertyStore = link.cast()?;
    let title_w = HSTRING::from(title);
    // A single-element vector makes InitPropVariantFromStringVector produce a
    // VT_LPWSTR PROPVARIANT, exactly what PKEY_Title expects.
    let mut pv: PROPVARIANT = InitPropVariantFromStringVector(Some(&[PCWSTR(title_w.as_ptr())]))?;
    let set_result = store.SetValue(&PKEY_Title, &pv);
    // Clear unconditionally: it owns a CoTaskMemAlloc'd copy of the title
    // string regardless of whether SetValue accepted it.
    let _ = PropVariantClear(&mut pv);
    set_result?;
    store.Commit()?;
    Ok(link)
  }
}

/// A fresh, empty `IObjectCollection`, the mutable builder the Jump List APIs
/// consume as a frozen `IObjectArray`.
fn new_collection() -> windows::core::Result<IObjectCollection> {
  unsafe { CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER) }
}

/// Tasks category: always-present shortcuts, independent of app state.
fn build_tasks(exe: &HSTRING, locale: i18n::Locale) -> windows::core::Result<IObjectArray> {
  let tasks = new_collection()?;
  let new_sticky = make_link(exe, "--new-sticky", i18n::tr(locale, Key::TrayNewNote))?;
  unsafe { tasks.AddObject(&new_sticky)? };
  let workspace = make_link(exe, "--workspace", i18n::tr(locale, Key::DockOpenWorkspace))?;
  unsafe { tasks.AddObject(&workspace)? };
  tasks.cast()
}

/// Documents category: one entry per open tab, same source, filtering and
/// ordering as the Dock menu's document section (`dock.rs::build_menu`) —
/// groups with a live `doc-{group}` window and at least one tab, groups
/// sorted, tabs kept in their reported order. `None` when there is nothing to
/// list, since an empty category is rejected by `AppendCategory`.
fn build_documents(
  app: &tauri::AppHandle,
  exe: &HSTRING,
) -> windows::core::Result<Option<IObjectArray>> {
  let open_docs = app.state::<crate::windows::OpenDocTabs>();
  let open_docs = open_docs.0.lock().unwrap();
  let live_windows = app.webview_windows();
  let mut groups: Vec<&String> = open_docs
    .keys()
    .filter(|g| live_windows.contains_key(&format!("doc-{g}")) && !open_docs[*g].tabs.is_empty())
    .collect();
  groups.sort();
  if groups.is_empty() {
    return Ok(None);
  }
  let docs = new_collection()?;
  for group in groups {
    for tab in &open_docs[group].tabs {
      let args = format!("--doc {group} {}", tab.tab_index);
      let link = make_link(exe, &args, &tab.name)?;
      unsafe { docs.AddObject(&link)? };
    }
  }
  Ok(Some(docs.cast()?))
}

/// Stickies category: one entry per sticky note, in store order, labelled by
/// `sticky_label` (same rule the Dock menu uses). `None` when there are none.
fn build_stickies(
  app: &tauri::AppHandle,
  exe: &HSTRING,
  locale: i18n::Locale,
) -> windows::core::Result<Option<IObjectArray>> {
  let notes = app.state::<NoteStore>().list();
  let blank = i18n::tr(locale, Key::DockBlankSticky);
  let stickies = new_collection()?;
  let mut any = false;
  for note in notes.iter().filter(|n| n.kind == "sticky") {
    let label = sticky_label(&note.content, blank);
    let link = make_link(exe, &format!("--note {}", note.id), &label)?;
    unsafe { stickies.AddObject(&link)? };
    any = true;
  }
  if !any {
    return Ok(None);
  }
  Ok(Some(stickies.cast()?))
}

/// Build the whole Jump List and push it to the shell in one commit. Runs
/// entirely inside the COM apartment `rebuild` sets up.
fn build_and_commit(
  app: &tauri::AppHandle,
  exe: &HSTRING,
  locale: i18n::Locale,
) -> windows::core::Result<()> {
  unsafe {
    let list: ICustomDestinationList =
      CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
    if !has_package_identity() {
      list.SetAppID(&HSTRING::from(APP_ID))?;
    }
    let mut min_slots = 0u32;
    // The returned array (destinations the user removed from the list) is not
    // something we act on; requesting it is just part of the required
    // BeginList/CommitList protocol.
    let _removed: IObjectArray = list.BeginList(&mut min_slots)?;
    list.AddUserTasks(&build_tasks(exe, locale)?)?;
    if let Some(docs) = build_documents(app, exe)? {
      list.AppendCategory(
        &HSTRING::from(i18n::tr(locale, Key::DockDocumentsSection)),
        &docs,
      )?;
    }
    if let Some(stickies) = build_stickies(app, exe, locale)? {
      list.AppendCategory(
        &HSTRING::from(i18n::tr(locale, Key::DockStickiesSection)),
        &stickies,
      )?;
    }
    list.CommitList()?;
  }
  Ok(())
}

/// A rebuild is already scheduled, so further triggers can be dropped.
static REBUILD_PENDING: AtomicBool = AtomicBool::new(false);

/// How long a scheduled rebuild waits, so a burst of triggers becomes one
/// commit. Long enough to swallow a typing burst's persists, short enough that
/// opening the taskbar menu right after adding a note shows it.
const COALESCE_DELAY: Duration = Duration::from_millis(400);

/// Coalescing entry point for every rebuild trigger. Safe to call as often as
/// the triggers fire: bursts collapse into one rebuild on the trailing edge.
///
/// This matters because `emit_store_changed` is the choke point for *every*
/// store mutation, including the debounced per-note persist that runs on every
/// typing pause. Rebuilding straight from there would run a full COM commit —
/// which talks to the shell — every few hundred milliseconds while the user is
/// typing in a sticky. The flag is cleared before the work runs, so a change
/// arriving mid-rebuild schedules another pass instead of being dropped.
pub fn rebuild(app: &tauri::AppHandle) {
  if REBUILD_PENDING.swap(true, Ordering::SeqCst) {
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(COALESCE_DELAY);
    REBUILD_PENDING.store(false, Ordering::SeqCst);
    rebuild_now(&app);
  });
}

/// Build the Jump List from current app state and push it to the taskbar. Every
/// failure just logs and leaves the previous list (or none) in place. Runs on
/// its own thread, so the COM apartment it opens is never shared.
fn rebuild_now(app: &tauri::AppHandle) {
  let exe = match std::env::current_exe() {
    Ok(p) => p,
    Err(e) => {
      log::warn!("failed to resolve executable path for jump list: {e}");
      return;
    }
  };
  let exe = HSTRING::from(exe.as_path());
  let settings = crate::settings::app_settings(app);
  let locale = i18n::current_locale(&settings.language);
  // Safety: COM is initialized and torn down together, on this call's thread,
  // with no interface surviving past `CoUninitialize`.
  let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
  if init.is_err() {
    log::warn!("failed to initialize COM for jump list: {init:?}");
    return;
  }
  let result = build_and_commit(app, &exe, locale);
  unsafe { CoUninitialize() };
  if let Err(e) = result {
    log::warn!("failed to rebuild jump list: {e}");
  }
}

#[cfg(test)]
mod tests {
  use super::has_package_identity;

  /// `cargo test` runs from a plain executable, never from an MSIX package, so
  /// the probe must answer false here. If it ever answered true the Jump List
  /// would silently stop attaching for every unpackaged build, because
  /// `set_app_id` would return early.
  #[test]
  fn an_unpackaged_process_is_not_packaged() {
    assert!(!has_package_identity());
  }
}
