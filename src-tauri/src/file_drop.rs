// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Opening files dropped onto a window from Finder or Explorer, while text
// dragged inside the editor keeps working.
//
// Tauri's drag-drop handler swallows every drag on a window, so how a file
// reaches `handle_drop` differs per platform:
// - Linux: Tauri's own `DragDrop` event.
// - macOS: Tauri's `DragDrop` event, but only for drags that come from another
//   app and carry file URLs; `mac::install` hands every other drag back to
//   WebKit.
// - Windows: the drop handler is disabled on the window, WebView2 delivers the
//   drop to the page, and the page forwards the files with a web message.

use std::fs;
use std::path::PathBuf;
use tauri::Manager;
/// Where the files of one drop go.
#[derive(Debug, PartialEq, Eq)]
pub enum DropRoute {
  /// Open as tabs of this document window.
  IntoWindow(String),
  /// Open a document window per file.
  NewWindows,
  Ignore,
}
/// A document window as `pick_top_doc` sees it.
#[cfg(any(target_os = "macos", windows, test))]
pub struct DocWindow {
  /// Same identity as the entries of the z-order list.
  pub id: isize,
  pub label: String,
  pub minimized: bool,
  pub visible: bool,
}
/// The regular files of a drop as path strings, in drop order. Folders, missing
/// paths and paths that are not valid UTF-8 are skipped.
pub fn drop_plan(paths: &[PathBuf]) -> Vec<String> {
  paths
    .iter()
    .filter(|path| fs::metadata(path).is_ok_and(|meta| meta.is_file()))
    .filter_map(|path| path.to_str().map(str::to_string))
    .collect()
}
/// The destination for a drop onto window `label`. Stickies and the workspace
/// hold no document, so with the open target on "tab" they borrow the topmost
/// document window and otherwise open new ones.
pub fn drop_route(label: &str, open_target: &str, top_doc: Option<&str>) -> DropRoute {
  if label.starts_with("doc-") {
    return DropRoute::IntoWindow(label.to_string());
  }
  if label.starts_with("note-") || label == "workspace" {
    return match top_doc {
      Some(doc) if open_target == "tab" => DropRoute::IntoWindow(doc.to_string()),
      _ => DropRoute::NewWindows,
    };
  }
  DropRoute::Ignore
}
/// The label of the first window in `order` (top to bottom) that is a visible,
/// non-minimized document window.
#[cfg(any(target_os = "macos", windows, test))]
pub fn pick_top_doc(order: &[isize], docs: &[DocWindow]) -> Option<String> {
  order.iter().find_map(|id| {
    docs
      .iter()
      .find(|doc| doc.id == *id && !doc.minimized && doc.visible)
      .map(|doc| doc.label.clone())
  })
}
/// Must run on the main thread: it reads AppKit state on macOS.
#[cfg(target_os = "macos")]
fn top_doc_window(app: &tauri::AppHandle) -> Option<String> {
  use objc2::msg_send;
  use objc2::runtime::{AnyObject, Bool};
  let Some(mtm) = objc2::MainThreadMarker::new() else {
    log::warn!("top_doc_window called off the main thread");
    return None;
  };
  let docs: Vec<DocWindow> = app
    .webview_windows()
    .into_iter()
    .filter(|(label, _)| label.starts_with("doc-"))
    .filter_map(|(label, window)| {
      let ns_window = window.ns_window().ok()? as *mut AnyObject;
      // Safety: both are argument-less NSWindow getters returning BOOL.
      let (minimized, visible): (Bool, Bool) = unsafe {
        (
          msg_send![ns_window, isMiniaturized],
          msg_send![ns_window, isVisible],
        )
      };
      Some(DocWindow {
        id: ns_window as isize,
        label,
        minimized: minimized.as_bool(),
        visible: visible.as_bool(),
      })
    })
    .collect();
  let ns_app = objc2_app_kit::NSApplication::sharedApplication(mtm);
  // Safety: `orderedWindows` is an NSArray of NSWindow, front to back; the
  // pointers are only compared, never retained.
  let order: Vec<isize> = unsafe {
    let windows: *mut AnyObject = msg_send![&*ns_app, orderedWindows];
    let count: usize = msg_send![windows, count];
    (0..count)
      .map(|i| {
        let window: *mut AnyObject = msg_send![windows, objectAtIndex: i];
        window as isize
      })
      .collect()
  };
  pick_top_doc(&order, &docs)
}

#[cfg(windows)]
fn top_doc_window(app: &tauri::AppHandle) -> Option<String> {
  use windows_sys::Win32::Foundation::{HWND, LPARAM};
  use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, IsIconic, IsWindowVisible};
  unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> i32 {
    // Safety: `lparam` is the `Vec` that `EnumWindows` below borrows for the
    // duration of the call.
    let order = unsafe { &mut *(lparam as *mut Vec<isize>) };
    order.push(hwnd as isize);
    1
  }
  let docs: Vec<DocWindow> = app
    .webview_windows()
    .into_iter()
    .filter(|(label, _)| label.starts_with("doc-"))
    .filter_map(|(label, window)| {
      let hwnd = window.hwnd().ok()?.0;
      Some(DocWindow {
        id: hwnd as isize,
        label,
        minimized: unsafe { IsIconic(hwnd as _) } != 0,
        visible: unsafe { IsWindowVisible(hwnd as _) } != 0,
      })
    })
    .collect();
  let mut order: Vec<isize> = Vec::new();
  // EnumWindows walks top-level windows in z-order, topmost first.
  unsafe {
    EnumWindows(Some(collect), &mut order as *mut Vec<isize> as LPARAM);
  }
  pick_top_doc(&order, &docs)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn top_doc_window(app: &tauri::AppHandle) -> Option<String> {
  crate::last_doc_window(app).map(|window| window.label().to_string())
}
/// Open the files dropped onto window `label`. Runs on the main thread.
pub fn handle_drop(app: &tauri::AppHandle, label: &str, paths: &[PathBuf]) {
  let plan = drop_plan(paths);
  if plan.is_empty() {
    return;
  }
  let open_target = crate::settings::app_settings(app).open_target;
  let top_doc = top_doc_window(app);
  let in_new_windows = match drop_route(label, &open_target, top_doc.as_deref()) {
    DropRoute::IntoWindow(target) => open_as_tabs(app, &target, plan),
    DropRoute::NewWindows => plan,
    DropRoute::Ignore => return,
  };
  if in_new_windows.is_empty() {
    return;
  }
  // Off the event loop: building a window from a window-event handler can
  // deadlock on Windows.
  let app = app.clone();
  std::thread::spawn(move || {
    for path in in_new_windows {
      crate::open_in_new_window(&app, &path);
    }
  });
}
/// Send `plan` to document window `target` as tabs; the paths it could not
/// take are returned.
fn open_as_tabs(app: &tauri::AppHandle, target: &str, plan: Vec<String>) -> Vec<String> {
  let Some(window) = app.get_webview_window(target) else {
    return plan;
  };
  let mut refused = Vec::new();
  for path in plan {
    if crate::pending_opens::open_in_window(&window, &path) {
      crate::launch_windows::record_routed_if_starting(window.label());
    } else {
      refused.push(path);
    }
  }
  refused
}
/// Hook a freshly built window up to `handle_drop`. On Windows it must be
/// called on a window built with `disable_drag_drop_handler`.
pub fn attach(window: &tauri::WebviewWindow) {
  #[cfg(target_os = "macos")]
  mac::install(window);
  #[cfg(windows)]
  win::attach(window);
  #[cfg(not(any(target_os = "macos", windows)))]
  let _ = window;
}
/// Hands every drag that is not a file from another app back to WebKit.
#[cfg(target_os = "macos")]
mod mac {
  use objc2::msg_send;
  use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
  use objc2_foundation::NSString;
  use std::ffi::CStr;
  use std::sync::{Once, OnceLock};
  /// The NSDraggingDestination methods wry's webview class overrides.
  const SELECTORS: [&CStr; 4] = [
    c"draggingEntered:",
    c"draggingUpdated:",
    c"draggingExited:",
    c"performDragOperation:",
  ];
  const ENTERED: usize = 0;
  const UPDATED: usize = 1;
  const EXITED: usize = 2;
  const PERFORM: usize = 3;
  /// One method before replacement: wry's and WKWebView's.
  #[derive(Clone, Copy)]
  struct Original {
    wry: Imp,
    webkit: Imp,
  }

  static ORIGINALS: OnceLock<[Original; 4]> = OnceLock::new();
  static INSTALL: Once = Once::new();
  /// Replaces the methods once, from the first webview built.
  pub fn install(window: &tauri::WebviewWindow) {
    INSTALL.call_once(|| {
      let result = window.with_webview(|webview| {
        let object = webview.inner() as *mut AnyObject;
        // The runtime class, not a name: it is wry's class, or a KVO subclass of
        // it once something observes the view.
        // Safety: `inner` is the live WKWebView of the window.
        let class = unsafe { (*object).class() };
        replace_methods(class);
      });
      if let Err(err) = result {
        log::warn!("file drop: could not reach the webview: {err}");
      }
    });
  }

  fn replace_methods(wry: &AnyClass) {
    let Some(webkit) = AnyClass::get(c"WKWebView") else {
      log::warn!("file drop: WKWebView not found, text drag stays disabled");
      return;
    };
    let replacements: [Imp; 4] = unsafe {
      [
        std::mem::transmute::<unsafe extern "C-unwind" fn(_, _, _) -> usize, Imp>(entered),
        std::mem::transmute::<unsafe extern "C-unwind" fn(_, _, _) -> usize, Imp>(updated),
        std::mem::transmute::<unsafe extern "C-unwind" fn(_, _, _), Imp>(exited),
        std::mem::transmute::<unsafe extern "C-unwind" fn(_, _, _) -> Bool, Imp>(perform),
      ]
    };
    let mut originals = Vec::with_capacity(SELECTORS.len());
    for name in SELECTORS {
      let sel = Sel::register(name);
      // The same implementation on both sides means wry does not override the
      // method; replacing it would replace WKWebView's own.
      match (wry.instance_method(sel), webkit.instance_method(sel)) {
        (Some(mine), Some(base))
          if mine.implementation() as usize != base.implementation() as usize =>
        {
          originals.push(Original {
            wry: mine.implementation(),
            webkit: base.implementation(),
          });
        }
        _ => {
          log::warn!("file drop: {name:?} is not overridden by wry, text drag stays disabled");
          return;
        }
      }
    }
    let Ok(originals) = <[Original; 4]>::try_from(originals) else {
      return;
    };
    if ORIGINALS.set(originals).is_err() {
      return;
    }
    for (name, replacement) in SELECTORS.into_iter().zip(replacements) {
      if let Some(method) = wry.instance_method(Sel::register(name)) {
        // Safety: the replacement has the signature of the method it replaces.
        unsafe {
          method.set_implementation(replacement);
        }
      }
    }
  }
  /// A drag from another app that carries file URLs.
  unsafe fn is_external_file_drag(info: *mut AnyObject) -> bool {
    // Safety: `info` is the NSDraggingInfo the drag machinery passed in.
    unsafe {
      let source: *mut AnyObject = msg_send![info, draggingSource];
      let pasteboard: *mut AnyObject = msg_send![info, draggingPasteboard];
      let file_url = NSString::from_str("public.file-url");
      let url: *mut AnyObject = msg_send![pasteboard, stringForType: &*file_url];
      source.is_null() && !url.is_null()
    }
  }
  /// The implementation to run for this drag: wry's for files from outside,
  /// WKWebView's for everything else.
  unsafe fn pick(index: usize, info: *mut AnyObject) -> Imp {
    let originals = ORIGINALS.get().expect("installed before replacing");
    if unsafe { is_external_file_drag(info) } {
      originals[index].wry
    } else {
      originals[index].webkit
    }
  }

  unsafe extern "C-unwind" fn entered(
    this: *mut AnyObject,
    sel: Sel,
    info: *mut AnyObject,
  ) -> usize {
    let imp = unsafe { pick(ENTERED, info) };
    let call: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize =
      unsafe { std::mem::transmute(imp) };
    unsafe { call(this, sel, info) }
  }

  unsafe extern "C-unwind" fn updated(
    this: *mut AnyObject,
    sel: Sel,
    info: *mut AnyObject,
  ) -> usize {
    let imp = unsafe { pick(UPDATED, info) };
    let call: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize =
      unsafe { std::mem::transmute(imp) };
    unsafe { call(this, sel, info) }
  }

  unsafe extern "C-unwind" fn exited(this: *mut AnyObject, sel: Sel, info: *mut AnyObject) {
    let imp = unsafe { pick(EXITED, info) };
    let call: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) =
      unsafe { std::mem::transmute(imp) };
    unsafe { call(this, sel, info) }
  }

  unsafe extern "C-unwind" fn perform(
    this: *mut AnyObject,
    sel: Sel,
    info: *mut AnyObject,
  ) -> Bool {
    let imp = unsafe { pick(PERFORM, info) };
    let call: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool =
      unsafe { std::mem::transmute(imp) };
    unsafe { call(this, sel, info) }
  }
}
/// Receives the files the page forwards. WebView2 keeps its own drop target, so
/// text dragged inside the page works as usual.
#[cfg(windows)]
mod win {
  use std::path::PathBuf;
  use tauri::webview::PlatformWebview;
  use tauri::Manager;
  use webview2_com::take_pwstr;
  use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
    ICoreWebView2WebMessageReceivedEventArgs2,
  };
  use webview2_com::WebMessageReceivedEventHandler;
  use windows_core::{Interface, PWSTR};
  /// What `src/lib/util/fileDrop.ts` posts along with the dropped files.
  const MESSAGE: &str = "note-n-pad:file-drop";

  pub fn attach(window: &tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let result = window.with_webview(move |webview| {
      if let Err(err) = unsafe { listen(&webview, app, label) } {
        log::warn!("file drop: could not listen for dropped files: {err}");
      }
    });
    if let Err(err) = result {
      log::warn!("file drop: could not reach the webview: {err}");
    }
  }

  unsafe fn listen(
    webview: &PlatformWebview,
    app: tauri::AppHandle,
    label: String,
  ) -> windows_core::Result<()> {
    let core = unsafe { webview.controller().CoreWebView2()? };
    let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
      if let Some(paths) = args.and_then(|args| unsafe { dropped_paths(&args) }) {
        super::handle_drop(&app, &label, &paths);
      }
      Ok(())
    }));
    let mut token = 0i64;
    unsafe { core.add_WebMessageReceived(&handler, &mut token) }
  }
  /// The paths attached to a file-drop message; `None` for any other message.
  unsafe fn dropped_paths(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Option<Vec<PathBuf>> {
    let mut message = PWSTR::null();
    unsafe { args.TryGetWebMessageAsString(&mut message) }.ok()?;
    if take_pwstr(message) != MESSAGE {
      return None;
    }
    let Ok(args) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else {
      log::warn!("file drop: this WebView2 runtime cannot attach files to messages");
      return None;
    };
    let objects = unsafe { args.AdditionalObjects() }.ok()?;
    let mut count = 0u32;
    unsafe { objects.Count(&mut count) }.ok()?;
    let mut paths = Vec::new();
    for index in 0..count {
      let Ok(file) =
        unsafe { objects.GetValueAtIndex(index) }.and_then(|o| o.cast::<ICoreWebView2File>())
      else {
        continue;
      };
      let mut path = PWSTR::null();
      if unsafe { file.Path(&mut path) }.is_ok() {
        paths.push(PathBuf::from(take_pwstr(path)));
      }
    }
    Some(paths)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;

  fn touch(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, "x").unwrap();
    path
  }

  fn as_str(path: &Path) -> String {
    path.to_str().unwrap().to_string()
  }

  #[test]
  fn plan_keeps_the_drop_order() {
    let dir = tempfile::tempdir().unwrap();
    let b = touch(dir.path(), "b.txt");
    let a = touch(dir.path(), "a.txt");
    let c = touch(dir.path(), "c.txt");
    let plan = drop_plan(&[b.clone(), a.clone(), c.clone()]);
    assert_eq!(plan, vec![as_str(&b), as_str(&a), as_str(&c)]);
  }

  #[test]
  fn plan_skips_folders() {
    let dir = tempfile::tempdir().unwrap();
    let file = touch(dir.path(), "a.txt");
    let folder = dir.path().join("sub");
    fs::create_dir(&folder).unwrap();
    assert_eq!(drop_plan(&[folder, file.clone()]), vec![as_str(&file)]);
  }

  #[test]
  fn plan_skips_missing_paths() {
    let dir = tempfile::tempdir().unwrap();
    let file = touch(dir.path(), "a.txt");
    let missing = dir.path().join("gone.txt");
    assert_eq!(drop_plan(&[missing, file.clone()]), vec![as_str(&file)]);
  }

  #[cfg(unix)]
  #[test]
  fn plan_keeps_a_symlink_to_a_file_and_skips_other_links() {
    let dir = tempfile::tempdir().unwrap();
    let file = touch(dir.path(), "a.txt");
    let link = dir.path().join("link.txt");
    std::os::unix::fs::symlink(&file, &link).unwrap();
    let folder = dir.path().join("sub");
    fs::create_dir(&folder).unwrap();
    let folder_link = dir.path().join("folder-link");
    std::os::unix::fs::symlink(&folder, &folder_link).unwrap();
    let dangling = dir.path().join("dangling");
    std::os::unix::fs::symlink(dir.path().join("gone"), &dangling).unwrap();
    assert_eq!(
      drop_plan(&[link.clone(), folder_link, dangling]),
      vec![as_str(&link)]
    );
  }

  #[test]
  fn plan_is_empty_when_everything_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    assert!(drop_plan(&[dir.path().to_path_buf(), dir.path().join("gone")]).is_empty());
    assert!(drop_plan(&[]).is_empty());
  }

  #[test]
  fn a_document_window_takes_its_own_drop() {
    for target in ["tab", "window"] {
      for top in [None, Some("doc-b")] {
        assert_eq!(
          drop_route("doc-a", target, top),
          DropRoute::IntoWindow("doc-a".to_string())
        );
      }
    }
  }

  #[test]
  fn a_sticky_or_the_workspace_joins_the_top_document_in_tab_mode() {
    for label in ["note-1", "workspace"] {
      assert_eq!(
        drop_route(label, "tab", Some("doc-b")),
        DropRoute::IntoWindow("doc-b".to_string())
      );
    }
  }

  #[test]
  fn a_sticky_or_the_workspace_opens_new_windows_without_a_top_document() {
    for label in ["note-1", "workspace"] {
      assert_eq!(drop_route(label, "tab", None), DropRoute::NewWindows);
    }
  }

  #[test]
  fn a_sticky_or_the_workspace_opens_new_windows_in_window_mode() {
    for label in ["note-1", "workspace"] {
      assert_eq!(
        drop_route(label, "window", Some("doc-b")),
        DropRoute::NewWindows
      );
      assert_eq!(drop_route(label, "window", None), DropRoute::NewWindows);
    }
  }

  #[test]
  fn other_windows_ignore_drops() {
    for label in ["settings", "about", "privacy", "edition"] {
      assert_eq!(drop_route(label, "tab", Some("doc-b")), DropRoute::Ignore);
    }
  }

  fn doc(id: isize, label: &str, minimized: bool, visible: bool) -> DocWindow {
    DocWindow {
      id,
      label: label.to_string(),
      minimized,
      visible,
    }
  }

  #[test]
  fn the_first_matching_document_in_z_order_wins() {
    let docs = [doc(1, "doc-a", false, true), doc(2, "doc-b", false, true)];
    assert_eq!(pick_top_doc(&[2, 1], &docs), Some("doc-b".to_string()));
    assert_eq!(pick_top_doc(&[1, 2], &docs), Some("doc-a".to_string()));
  }

  #[test]
  fn a_minimized_top_document_is_skipped() {
    let docs = [doc(1, "doc-a", false, true), doc(2, "doc-b", true, true)];
    assert_eq!(pick_top_doc(&[2, 1], &docs), Some("doc-a".to_string()));
  }

  #[test]
  fn an_invisible_document_is_skipped() {
    let docs = [doc(1, "doc-a", false, true), doc(2, "doc-b", false, false)];
    assert_eq!(pick_top_doc(&[2, 1], &docs), Some("doc-a".to_string()));
  }

  #[test]
  fn windows_that_are_not_documents_are_passed_over() {
    let docs = [doc(2, "doc-b", false, true)];
    assert_eq!(pick_top_doc(&[9, 8, 2], &docs), Some("doc-b".to_string()));
  }

  #[test]
  fn no_matching_document_is_none() {
    let docs = [doc(1, "doc-a", true, true), doc(2, "doc-b", false, false)];
    assert_eq!(pick_top_doc(&[9, 2, 1], &docs), None);
    assert_eq!(pick_top_doc(&[], &docs), None);
    assert_eq!(pick_top_doc(&[1], &[]), None);
  }
  // The checks below read source because the failure modes are a deadlock, a
  // missing platform hook and a silent upgrade, with nothing to assert at
  // runtime.

  fn body_of<'a>(source: &'a str, signature: &str) -> &'a str {
    let at = source
      .find(signature)
      .unwrap_or_else(|| panic!("{signature} is gone"));
    let rest = &source[at..];
    &rest[..rest.find("\n}\n").unwrap()]
  }

  #[test]
  fn windows_are_only_built_off_the_calling_thread() {
    let body = body_of(include_str!("file_drop.rs"), "pub fn handle_drop");
    let spawn = body
      .find("std::thread::spawn")
      .expect("handle_drop no longer spawns a thread");
    let build = body
      .find("open_in_new_window")
      .expect("handle_drop no longer opens new windows");
    assert!(
      spawn < build,
      "open_in_new_window must run inside std::thread::spawn: building a window \
       from the event loop can deadlock on Windows"
    );
  }

  #[test]
  fn simulate_drop_runs_on_the_main_thread() {
    let body = body_of(include_str!("automation.rs"), "fn simulate_drop");
    let hop = body
      .find("run_on_main_thread")
      .expect("simulate_drop no longer hops to the main thread");
    let call = body
      .find("handle_drop")
      .expect("simulate_drop no longer calls handle_drop");
    assert!(
      hop < call,
      "handle_drop must be called inside run_on_main_thread: AppKit is main-thread only"
    );
  }

  #[test]
  fn every_drop_window_is_built_without_the_tauri_handler_and_attached() {
    let source = include_str!("windows.rs");
    for builder in [
      "pub fn create_sticky_window",
      "fn build_document_window",
      "pub fn show_workspace(",
    ] {
      let body = body_of(source, builder);
      assert!(
        body.contains("#[cfg(windows)]\n  let builder = builder.disable_drag_drop_handler();"),
        "{builder} must disable the drag-drop handler, on Windows only"
      );
      assert!(
        body.contains("crate::file_drop::attach("),
        "{builder} no longer attaches file drop"
      );
    }
  }

  #[test]
  fn the_message_matches_the_page() {
    let page = include_str!("../../src/lib/util/fileDrop.ts");
    assert!(page.contains("'note-n-pad:file-drop'"));
    assert!(
      include_str!("file_drop.rs").contains("const MESSAGE: &str = \"note-n-pad:file-drop\";")
    );
  }

  #[test]
  fn wry_stays_on_the_version_the_drop_hooks_were_checked_against() {
    let lock = include_str!("../Cargo.lock");
    assert!(
      lock.contains("name = \"wry\"\nversion = \"0.57.0\"\n"),
      "wry changed: re-check the macOS method replacement in file_drop::mac and \
       the Windows web message route before updating this version"
    );
  }
}
