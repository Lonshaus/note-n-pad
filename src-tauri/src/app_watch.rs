// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use serde::Serialize;

/// A running application the user can pin a sticky to. `id` is the platform-
/// neutral identity matched against a sticky's `pin_app`: the bundle id on
/// macOS, the executable path on Windows, and the WM_CLASS on Linux/X11.
#[derive(Debug, Clone, Serialize)]
pub struct RunningApp {
  pub id: String,
  pub name: String,
}

/// The kind of Linux display session, from `XDG_SESSION_TYPE`. Only X11 (native
/// or XWayland with an X-aware compositor) supports reliable foreground/app
/// detection; Wayland exposes no portable "which app is frontmost" query.
// Used on Linux at runtime and by tests on every platform.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
  X11,
  Wayland,
  Unknown,
}

/// Classify a session from an `XDG_SESSION_TYPE` value. Kept pure so the
/// dispatch is unit-testable off any real session.
// Called on Linux; compiled (and tested) on every platform.
#[allow(dead_code)]
pub fn classify_session(xdg_session_type: Option<&str>) -> SessionKind {
  match xdg_session_type
    .map(|s| s.trim().to_ascii_lowercase())
    .as_deref()
  {
    Some("x11") => SessionKind::X11,
    Some("wayland") => SessionKind::Wayland,
    _ => SessionKind::Unknown,
  }
}

/// Display name for a Windows executable path: its file stem (e.g.
/// `C:\...\chrome.exe` -> `chrome`), falling back to the whole path. Splits on
/// both separators and strips a `.exe` suffix explicitly (rather than via
/// `std::path`, whose separator set depends on the host OS) so the result is
/// deterministic and unit-testable on any platform.
// Called on Windows; compiled (and tested) on every platform.
#[allow(dead_code)]
pub fn exe_display_name(path: &str) -> String {
  let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
  let stem = base
    .strip_suffix(".exe")
    .or_else(|| base.strip_suffix(".EXE"))
    .unwrap_or(base);
  if stem.is_empty() {
    path.to_string()
  } else {
    stem.to_string()
  }
}

/// One resolved `.desktop` entry, used to map a WM_CLASS class to a human
/// display name. Built from GIO on Linux; kept as plain owned data so the
/// matching logic (`resolve_display_name`) is testable on every platform.
// Constructed on Linux only.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct DesktopEntry {
  pub startup_wm_class: Option<String>,
  /// Desktop id with the `.desktop` suffix stripped.
  pub desktop_id: Option<String>,
  /// Basename of the first token (the program) of the entry's Exec command.
  pub exec_basename: Option<String>,
  pub name: String,
  pub should_show: bool,
}

/// Resolve a WM_CLASS class string to a `.desktop` display name, matching
/// case-insensitively in precedence: StartupWMClass, then desktop id, then the
/// Exec program basename. First matching tier wins; within a tier, an entry
/// whose `should_show` is true is preferred over one that isn't. No match
/// returns `None` (the caller falls back to the raw class string).
// Called on Linux; compiled (and tested) on every platform.
#[allow(dead_code)]
pub fn resolve_display_name(class: &str, entries: &[DesktopEntry]) -> Option<String> {
  let key_fns: [fn(&DesktopEntry) -> Option<&str>; 3] = [
    |e| e.startup_wm_class.as_deref(),
    |e| e.desktop_id.as_deref(),
    |e| e.exec_basename.as_deref(),
  ];
  for key_of in key_fns {
    let matches: Vec<&DesktopEntry> = entries
      .iter()
      .filter(|e| key_of(e).is_some_and(|k| k.eq_ignore_ascii_case(class)))
      .collect();
    if let Some(chosen) = matches.iter().find(|e| e.should_show).or(matches.first()) {
      return Some(chosen.name.clone());
    }
  }
  None
}

/// Whether a window belongs in the pinnable-app list, based on its
/// `_NET_WM_WINDOW_TYPE` atom names. An absent property (empty slice) passes,
/// as does any list containing NORMAL; anything else (DESKTOP, DOCK, ...) is
/// filtered out. The X11 analogue of macOS's `activationPolicy == Regular`.
// Called on Linux; compiled (and tested) on every platform.
#[allow(dead_code)]
pub fn window_type_allows(types: &[String]) -> bool {
  types.is_empty() || types.iter().any(|t| t == "_NET_WM_WINDOW_TYPE_NORMAL")
}

/// Whether foreground/app detection works on this platform and session. When it
/// does not (notably Wayland), app-pinned stickies degrade to always-on-top.
#[cfg(target_os = "macos")]
pub fn detection_available() -> bool {
  true
}

#[cfg(target_os = "windows")]
pub fn detection_available() -> bool {
  true
}

#[cfg(target_os = "linux")]
pub fn detection_available() -> bool {
  classify_session(std::env::var("XDG_SESSION_TYPE").ok().as_deref()) == SessionKind::X11
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn detection_available() -> bool {
  false
}

// --- macOS: NSWorkspace ---------------------------------------------------

/// Identity (bundle id) of the frontmost application, or None when unknown.
#[cfg(target_os = "macos")]
pub fn frontmost_id() -> Option<String> {
  use objc2_app_kit::NSWorkspace;
  let ws = NSWorkspace::sharedWorkspace();
  let app = ws.frontmostApplication()?;
  app.bundleIdentifier().map(|s| s.to_string())
}

/// The regular (Dock-visible) applications currently running, sorted by name.
#[cfg(target_os = "macos")]
fn running_apps() -> Vec<RunningApp> {
  use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
  let mut apps = Vec::new();
  let ws = NSWorkspace::sharedWorkspace();
  for app in ws.runningApplications().iter() {
    // Regular activation policy = normal windowed apps; skip agents/daemons.
    if app.activationPolicy() != NSApplicationActivationPolicy::Regular {
      continue;
    }
    let (Some(name), Some(bundle_id)) = (app.localizedName(), app.bundleIdentifier()) else {
      continue;
    };
    apps.push(RunningApp {
      id: bundle_id.to_string(),
      name: name.to_string(),
    });
  }
  apps.sort_by_key(|a| a.name.to_lowercase());
  apps
}

// --- Windows: Win32 foreground window + process image ---------------------

/// Executable path of the frontmost window's process, or None when unknown.
#[cfg(target_os = "windows")]
pub fn frontmost_id() -> Option<String> {
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId,
  };
  // Contained unsafe: read the foreground window and its owning process id.
  unsafe {
    let hwnd = GetForegroundWindow();
    if hwnd.is_null() {
      return None;
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    exe_path_for_pid(pid)
  }
}

/// Resolve a process id to its full executable path.
#[cfg(target_os = "windows")]
fn exe_path_for_pid(pid: u32) -> Option<String> {
  use windows_sys::Win32::Foundation::CloseHandle;
  use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
  };
  if pid == 0 {
    return None;
  }
  // Contained unsafe: open the process for a limited-info query, read its image
  // path, then always close the handle.
  unsafe {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if handle.is_null() {
      return None;
    }
    let mut buf = [0u16; 260];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
    CloseHandle(handle);
    if ok == 0 {
      return None;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
  }
}

/// Enumerate visible top-level windows and map each to its process executable,
/// deduplicated by path. The display name is the executable's file stem.
#[cfg(target_os = "windows")]
fn running_apps() -> Vec<RunningApp> {
  use std::collections::BTreeSet;
  use windows_sys::Win32::Foundation::{HWND, LPARAM};
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
  };

  // windows-sys spells BOOL as a raw i32 (TRUE = 1) rather than exporting the
  // named alias, so the callback signature and return use i32 directly.
  extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> i32 {
    // Contained unsafe: `lparam` is our own &mut Vec; the Win32 reads are FFI.
    unsafe {
      let paths = &mut *(lparam as *mut Vec<String>);
      // Skip hidden windows and title-less tool/helper windows.
      if IsWindowVisible(hwnd) == 0 || GetWindowTextLengthW(hwnd) == 0 {
        return 1;
      }
      let mut pid: u32 = 0;
      GetWindowThreadProcessId(hwnd, &mut pid);
      if let Some(path) = exe_path_for_pid(pid) {
        paths.push(path);
      }
    }
    1
  }

  let mut paths: Vec<String> = Vec::new();
  // Contained unsafe: EnumWindows invokes our callback for each top-level window.
  unsafe {
    EnumWindows(Some(enum_cb), &mut paths as *mut _ as LPARAM);
  }
  let mut seen = BTreeSet::new();
  let mut apps: Vec<RunningApp> = Vec::new();
  for path in paths {
    if seen.insert(path.clone()) {
      let name = exe_display_name(&path);
      apps.push(RunningApp { id: path, name });
    }
  }
  apps.sort_by_key(|a| a.name.to_lowercase());
  apps
}

// --- Linux/X11: read _NET_ACTIVE_WINDOW / _NET_CLIENT_LIST + WM_CLASS ------

#[cfg(target_os = "linux")]
mod x11 {
  use super::{resolve_display_name, window_type_allows, DesktopEntry, RunningApp};
  use x11rb::connection::Connection;
  use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, Window};

  /// Intern a named atom, returning None on any protocol error.
  fn atom(conn: &impl Connection, name: &str) -> Option<u32> {
    conn
      .intern_atom(false, name.as_bytes())
      .ok()?
      .reply()
      .ok()
      .map(|r| r.atom)
  }

  /// The WM_CLASS "class" field of a window (the second of the two
  /// null-separated strings), used as the app identity.
  fn class_of(conn: &impl Connection, win: Window) -> Option<String> {
    let reply = conn
      .get_property(false, win, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256)
      .ok()?
      .reply()
      .ok()?;
    let mut parts = reply.value.split(|&b| b == 0);
    let _instance = parts.next();
    let class = parts.next()?;
    if class.is_empty() {
      return None;
    }
    Some(String::from_utf8_lossy(class).into_owned())
  }

  /// `_NET_WM_WINDOW_TYPE` atom names on a window, empty when the property is
  /// absent or on any protocol error.
  fn window_type_names(
    conn: &impl Connection,
    win: Window,
    net_wm_window_type: u32,
  ) -> Vec<String> {
    let Ok(cookie) = conn.get_property(false, win, net_wm_window_type, AtomEnum::ATOM, 0, 32)
    else {
      return Vec::new();
    };
    let Ok(reply) = cookie.reply() else {
      return Vec::new();
    };
    let Some(atoms) = reply.value32() else {
      return Vec::new();
    };
    atoms
      .filter_map(|a| {
        conn
          .get_atom_name(a)
          .ok()?
          .reply()
          .ok()
          .map(|r| String::from_utf8_lossy(&r.name).into_owned())
      })
      .collect()
  }

  fn active_class_inner() -> Option<String> {
    let (conn, screen) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots[screen].root;
    let net_active = atom(&conn, "_NET_ACTIVE_WINDOW")?;
    let reply = conn
      .get_property(false, root, net_active, AtomEnum::WINDOW, 0, 1)
      .ok()?
      .reply()
      .ok()?;
    let win = reply.value32()?.next()?;
    if win == 0 {
      return None;
    }
    class_of(&conn, win)
  }

  /// Build the GIO `.desktop` lookup table used to resolve display names.
  fn desktop_entries() -> Vec<DesktopEntry> {
    use gio::prelude::*;
    gio::AppInfo::all()
      .into_iter()
      .filter_map(|info| info.downcast::<gio::DesktopAppInfo>().ok())
      .map(|info| {
        let desktop_id = info.id().map(|id| id.to_string()).map(|id| {
          id.strip_suffix(".desktop")
            .map(str::to_string)
            .unwrap_or(id)
        });
        // commandline() is the full "program arg1 arg2 ..." string; take the
        // program token and its basename (not AppInfoExt::executable(), per
        // the resolution contract this mirrors).
        let exec_basename = info.commandline().and_then(|cmd| {
          cmd
            .to_str()
            .and_then(|s| s.split_whitespace().next())
            .map(|prog| prog.rsplit('/').next().unwrap_or(prog).to_string())
        });
        DesktopEntry {
          startup_wm_class: info.startup_wm_class().map(|s| s.to_string()),
          desktop_id,
          exec_basename,
          name: info.name().to_string(),
          should_show: info.should_show(),
        }
      })
      .collect()
  }

  fn client_classes_inner() -> Option<Vec<RunningApp>> {
    let (conn, screen) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots[screen].root;
    let net_list = atom(&conn, "_NET_CLIENT_LIST")?;
    // Absent on window managers that don't set it (unusual, but not fatal):
    // treat every window as NORMAL rather than filtering everything out.
    let net_wm_window_type = atom(&conn, "_NET_WM_WINDOW_TYPE");
    let reply = conn
      .get_property(false, root, net_list, AtomEnum::WINDOW, 0, 1024)
      .ok()?
      .reply()
      .ok()?;
    let mut seen = std::collections::BTreeSet::new();
    let mut classes = Vec::new();
    for win in reply.value32()? {
      let Some(class) = class_of(&conn, win) else {
        continue;
      };
      if let Some(net_wm_window_type) = net_wm_window_type {
        let types = window_type_names(&conn, win, net_wm_window_type);
        if !window_type_allows(&types) {
          continue;
        }
      }
      if seen.insert(class.clone()) {
        classes.push(class);
      }
    }
    let entries = desktop_entries();
    let mut out: Vec<RunningApp> = classes
      .into_iter()
      .map(|class| {
        let name = resolve_display_name(&class, &entries).unwrap_or_else(|| class.clone());
        RunningApp { id: class, name }
      })
      .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    Some(out)
  }

  /// WM_CLASS of the active window, or None on any failure.
  pub fn active_class() -> Option<String> {
    active_class_inner()
  }

  /// Deduplicated, name-resolved list of managed clients that pass the window
  /// type filter, empty on any failure.
  pub fn client_classes() -> Vec<RunningApp> {
    client_classes_inner().unwrap_or_default()
  }
}

/// WM_CLASS of the frontmost window under X11, or None (Wayland degrades here).
#[cfg(target_os = "linux")]
pub fn frontmost_id() -> Option<String> {
  if !detection_available() {
    return None;
  }
  x11::active_class()
}

/// The managed X11 clients, or an empty list under Wayland / on failure.
#[cfg(target_os = "linux")]
fn running_apps() -> Vec<RunningApp> {
  if !detection_available() {
    return Vec::new();
  }
  x11::client_classes()
}

// --- Other platforms ------------------------------------------------------

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn frontmost_id() -> Option<String> {
  None
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn running_apps() -> Vec<RunningApp> {
  Vec::new()
}

// --- Cross-platform command + pin follow-along ----------------------------

#[tauri::command]
pub fn list_running_apps() -> Vec<RunningApp> {
  running_apps()
}

/// Toggle always-on-top for every app-pinned sticky so each floats only while
/// the application it is bound to is frontmost.
fn apply_app_pins(app: &tauri::AppHandle, front: Option<&str>) {
  use crate::note_store::NoteStore;
  use tauri::Manager;
  let store = app.state::<NoteStore>();
  for note in store.list() {
    if note.pin_mode != "app" {
      continue;
    }
    let label = format!("note-{}", note.id);
    if let Some(win) = app.get_webview_window(&label) {
      let on_top = front.is_some() && note.pin_app.as_deref() == front;
      let _ = win.set_always_on_top(on_top);
    }
  }
}

/// Spawn a 500 ms poller that follows the frontmost application and refreshes
/// app-pinned stickies whenever it changes. When foreground detection is
/// unavailable (e.g. Wayland) there is nothing to follow: app-pinned stickies
/// are created always-on-top by `create_sticky_window`, so the poller is
/// skipped entirely.
pub fn start(app: tauri::AppHandle) {
  if !detection_available() {
    return;
  }
  use std::time::Duration;
  std::thread::spawn(move || {
    let mut last: Option<String> = None;
    loop {
      std::thread::sleep(Duration::from_millis(500));
      let front = frontmost_id();
      if front == last {
        continue;
      }
      last = front.clone();
      apply_app_pins(&app, front.as_deref());
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn classifies_session_type() {
    assert_eq!(classify_session(Some("x11")), SessionKind::X11);
    assert_eq!(classify_session(Some("X11")), SessionKind::X11);
    assert_eq!(classify_session(Some(" wayland ")), SessionKind::Wayland);
    assert_eq!(classify_session(Some("tty")), SessionKind::Unknown);
    assert_eq!(classify_session(None), SessionKind::Unknown);
  }

  #[test]
  fn exe_display_name_takes_file_stem() {
    assert_eq!(
      exe_display_name(r"C:\Program Files\Chrome\chrome.exe"),
      "chrome"
    );
    assert_eq!(exe_display_name("/usr/bin/firefox"), "firefox");
    // A path with no stem falls back to the whole string.
    assert_eq!(exe_display_name(""), "");
  }

  fn entry(
    startup_wm_class: Option<&str>,
    desktop_id: Option<&str>,
    exec_basename: Option<&str>,
    name: &str,
    should_show: bool,
  ) -> DesktopEntry {
    DesktopEntry {
      startup_wm_class: startup_wm_class.map(String::from),
      desktop_id: desktop_id.map(String::from),
      exec_basename: exec_basename.map(String::from),
      name: name.to_string(),
      should_show,
    }
  }

  #[test]
  fn resolves_by_startup_wm_class_first() {
    let entries = [entry(
      Some("firefox_firefox"),
      Some("firefox_firefox"),
      Some("firefox"),
      "Firefox",
      true,
    )];
    assert_eq!(
      resolve_display_name("firefox_firefox", &entries),
      Some("Firefox".to_string())
    );
  }

  #[test]
  fn resolves_by_desktop_id_when_no_startup_wm_class() {
    // org.gnome.Nautilus: no StartupWMClass, matched by desktop id basename.
    let entries = [entry(
      None,
      Some("org.gnome.Nautilus"),
      Some("nautilus"),
      "Files",
      true,
    )];
    assert_eq!(
      resolve_display_name("org.gnome.Nautilus", &entries),
      Some("Files".to_string())
    );
  }

  #[test]
  fn resolves_by_exec_basename_when_neither_matches() {
    // gnome-text-editor: file is org.gnome.TextEditor.desktop, reachable only
    // through Exec=gnome-text-editor.
    let entries = [entry(
      None,
      Some("org.gnome.TextEditor"),
      Some("gnome-text-editor"),
      "Text Editor",
      true,
    )];
    assert_eq!(
      resolve_display_name("gnome-text-editor", &entries),
      Some("Text Editor".to_string())
    );
  }

  #[test]
  fn resolves_case_insensitively() {
    let entries = [entry(Some("Firefox_Firefox"), None, None, "Firefox", true)];
    assert_eq!(
      resolve_display_name("firefox_firefox", &entries),
      Some("Firefox".to_string())
    );
  }

  #[test]
  fn prefers_should_show_entry_on_tie() {
    let entries = [
      entry(Some("gjs"), None, None, "Hidden Helper", false),
      entry(Some("gjs"), None, None, "Gjs", true),
    ];
    assert_eq!(
      resolve_display_name("gjs", &entries),
      Some("Gjs".to_string())
    );
  }

  #[test]
  fn no_match_returns_none() {
    let entries = [entry(Some("firefox_firefox"), None, None, "Firefox", true)];
    assert_eq!(resolve_display_name("gjs", &entries), None);
  }

  #[test]
  fn window_type_allows_absent_property() {
    assert!(window_type_allows(&[]));
  }

  #[test]
  fn window_type_allows_normal() {
    assert!(window_type_allows(&[
      "_NET_WM_WINDOW_TYPE_NORMAL".to_string()
    ]));
  }

  #[test]
  fn window_type_rejects_desktop() {
    assert!(!window_type_allows(&[
      "_NET_WM_WINDOW_TYPE_DESKTOP".to_string()
    ]));
  }

  #[test]
  fn window_type_allows_normal_among_others() {
    assert!(window_type_allows(&[
      "_NET_WM_WINDOW_TYPE_UTILITY".to_string(),
      "_NET_WM_WINDOW_TYPE_NORMAL".to_string(),
    ]));
  }

  #[test]
  fn window_type_rejects_unrelated_type_alone() {
    assert!(!window_type_allows(&[
      "_NET_WM_WINDOW_TYPE_DOCK".to_string()
    ]));
  }
}
