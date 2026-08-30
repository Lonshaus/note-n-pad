// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// macOS Dock right-click menu. Tauri v2 exposes no Dock-menu API, and
// NSApplication has no public Dock-menu setter — AppKit asks the app delegate
// for the menu via `applicationDockMenu:`. Tauri owns the delegate, so we add
// that method (and our menu actions) to the delegate's class at runtime with
// `class_addMethod`.
//
// The system Dock window list only shows titled windows, so the frameless
// stickies never appear there. We list them ourselves: the menu is rebuilt on
// every right-click (AppKit calls `applicationDockMenu:` each time), so add/
// delete of a sticky is reflected immediately with no cache to invalidate.
//
// This is a contained runtime hack: it touches only the delegate class of the
// running process, is macOS-only, and no-ops if the delegate is missing or the
// methods cannot be added. It must run on the main thread (called from setup),
// and AppKit calls both the menu builder and the actions on the main thread.
use std::ptr::null_mut;
use std::sync::OnceLock;

use objc2::ffi::class_addMethod;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel, ClassType, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSControlStateValueOn, NSMenu, NSMenuItem};
use objc2_foundation::NSString;
use tauri::Manager;

use crate::dock_labels::{doc_ref, parse_doc_ref, sticky_label};
use crate::i18n::{self, Key};
use crate::note_store::{NoteSnapshot, NoteStore};

/// App handle for the Dock actions and menu rebuild, set once at install time.
/// The IMPs run on the main thread; `AppHandle` is Send+Sync, so the `OnceLock`
/// is safe.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// A non-clickable section header for the sticky list. Prefers the macOS 14+
/// `+[NSMenuItem sectionHeaderWithTitle:]`, falling back to a disabled plain
/// item (visually equivalent) on older systems where that selector is absent.
///
/// # Safety
///
/// Must run on the main thread.
unsafe fn section_header(mtm: MainThreadMarker, title: &NSString) -> Retained<NSMenuItem> {
  let responds: bool = msg_send![
    NSMenuItem::class(),
    respondsToSelector: sel!(sectionHeaderWithTitle:)
  ];
  if responds {
    NSMenuItem::sectionHeaderWithTitle(title, mtm)
  } else {
    let empty = NSString::from_str("");
    let item =
      NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), title, None, &empty);
    item.setEnabled(false);
    item
  }
}

/// Build a fresh Dock menu: the workspace item, then (each divided by a
/// separator) a document section and a sticky section, both omitted when empty.
/// Every action item targets the delegate, where the added methods live. The
/// returned menu is owned by the caller; its items and their represented-object
/// strings are retained by the menu graph and released together when AppKit
/// drops the menu.
///
/// # Safety
///
/// Must run on the main thread; `delegate` must be the live app delegate.
unsafe fn build_menu(
  mtm: MainThreadMarker,
  app: &tauri::AppHandle,
  delegate: *mut AnyObject,
) -> Retained<NSMenu> {
  let settings = crate::settings::app_settings(app);
  let locale = i18n::current_locale(&settings.language);
  let empty = NSString::from_str("");
  let menu = NSMenu::new(mtm);
  let notes = app.state::<NoteStore>().list();
  let windows = app.webview_windows();
  // The current key window, driving the document/sticky checkmarks. None when
  // the app is in the background, so nothing is marked then.
  let focused_label: Option<String> = windows
    .iter()
    .find(|(_, win)| win.is_focused().unwrap_or(false))
    .map(|(label, _)| label.clone());
  // Workspace: a plain action button whose click opens the workspace. Shown
  // only while the workspace window is not visible — a visible one already sits
  // in the system window list at the top of the Dock menu, so listing it here
  // too would be a duplicate. (Closing the workspace only hides it, so "not
  // visible" covers both a never-opened and a closed workspace.)
  let workspace_visible = windows
    .get("workspace")
    .map(|w| w.is_visible().unwrap_or(false))
    .unwrap_or(false);
  if !workspace_visible {
    let ws_title = NSString::from_str(i18n::tr(locale, Key::DockOpenWorkspace));
    let ws_item = NSMenuItem::initWithTitle_action_keyEquivalent(
      NSMenuItem::alloc(mtm),
      &ws_title,
      Some(sel!(noteNPadOpenWorkspace:)),
      &empty,
    );
    ws_item.setTarget(Some(&*delegate));
    menu.addItem(&ws_item);
  }
  // Documents: one item per open tab, from each live window's own report (so
  // untitled tabs, which are never persisted to the store, still appear). Groups
  // are sorted for a stable order; tabs keep their reported (tab-bar) order.
  // Every open tab is listed even when a window has only one — same logic as
  // the stickies section, so the two regions read consistently.
  let open_docs = app.state::<crate::windows::OpenDocTabs>();
  let open_docs = open_docs.0.lock().unwrap();
  let mut doc_groups: Vec<&String> = open_docs
    .keys()
    .filter(|g| windows.contains_key(&format!("doc-{g}")) && !open_docs[*g].tabs.is_empty())
    .collect();
  doc_groups.sort();
  if !doc_groups.is_empty() {
    if menu.numberOfItems() > 0 {
      menu.addItem(&NSMenuItem::separatorItem(mtm));
    }
    let header = NSString::from_str(i18n::tr(locale, Key::DockDocumentsSection));
    menu.addItem(&section_header(mtm, &header));
    // The key document window, whose active tab gets the checkmark.
    let key_doc_group = focused_label
      .as_deref()
      .and_then(|l| l.strip_prefix("doc-"));
    for group in doc_groups {
      let win = &open_docs[group];
      for tab in &win.tabs {
        let title = NSString::from_str(&tab.name);
        let item = NSMenuItem::initWithTitle_action_keyEquivalent(
          NSMenuItem::alloc(mtm),
          &title,
          Some(sel!(noteNPadFocusDoc:)),
          &empty,
        );
        item.setTarget(Some(&*delegate));
        if key_doc_group == Some(group.as_str()) && win.active == Some(tab.tab_index) {
          item.setState(NSControlStateValueOn);
        }
        // Carry "group\ttab_index" so `focus_doc` can route the click.
        let rep = NSString::from_str(&doc_ref(group, tab.tab_index));
        item.setRepresentedObject(Some(&rep));
        menu.addItem(&item);
      }
    }
  }
  drop(open_docs);
  // Stickies: one item per sticky note, in store order. No cap.
  let stickies: Vec<&NoteSnapshot> = notes.iter().filter(|n| n.kind == "sticky").collect();
  if !stickies.is_empty() {
    if menu.numberOfItems() > 0 {
      menu.addItem(&NSMenuItem::separatorItem(mtm));
    }
    let header = NSString::from_str(i18n::tr(locale, Key::DockStickiesSection));
    menu.addItem(&section_header(mtm, &header));
    let active_sticky = focused_label
      .as_deref()
      .and_then(|l| l.strip_prefix("note-"));
    let blank = i18n::tr(locale, Key::DockBlankSticky);
    for note in stickies {
      let title = NSString::from_str(&sticky_label(&note.content, blank));
      let item = NSMenuItem::initWithTitle_action_keyEquivalent(
        NSMenuItem::alloc(mtm),
        &title,
        Some(sel!(noteNPadFocusNote:)),
        &empty,
      );
      item.setTarget(Some(&*delegate));
      if active_sticky == Some(note.id.as_str()) {
        item.setState(NSControlStateValueOn);
      }
      // Carry the note id on the item. setRepresentedObject retains the string,
      // so the menu item owns it and our local Retained drops here without a
      // leak; `focus_note` reads it back off the clicked item.
      let id = NSString::from_str(&note.id);
      item.setRepresentedObject(Some(&id));
      menu.addItem(&item);
    }
  }
  menu
}

/// `-[delegate applicationDockMenu:]`: rebuild and return the menu each call.
extern "C-unwind" fn dock_menu(
  this: *mut AnyObject,
  _cmd: Sel,
  _sender: *mut AnyObject,
) -> *mut NSMenu {
  let Some(mtm) = MainThreadMarker::new() else {
    return null_mut();
  };
  let Some(app) = APP.get() else {
    return null_mut();
  };
  // Safety: AppKit calls this on the main thread with the delegate as `this`.
  let menu = unsafe { build_menu(mtm, app, this) };
  // Hand AppKit an autoreleased menu: it retains the menu while shown and
  // releases it after, so nothing leaks and no old menu dangles across
  // rebuilds. The current run-loop autorelease pool drains it if AppKit does
  // not take ownership.
  Retained::autorelease_return(menu)
}

/// `-[delegate noteNPadOpenWorkspace:]`: the workspace item's action.
extern "C-unwind" fn open_workspace(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) {
  if let Some(app) = APP.get() {
    let _ = crate::windows::show_workspace(app);
  }
}

/// `-[delegate noteNPadFocusNote:]`: focus the sticky window named by the clicked
/// item's represented-object id. A no-op if the window is not open.
extern "C-unwind" fn focus_note(_this: *mut AnyObject, _cmd: Sel, sender: *mut AnyObject) {
  let Some(app) = APP.get() else {
    return;
  };
  if sender.is_null() {
    return;
  }
  // Safety: sender is the clicked NSMenuItem; its represented object is the
  // NSString id we stored when building the menu (borrowed, not owned here).
  let item: &NSMenuItem = unsafe { &*(sender as *const NSMenuItem) };
  let Some(obj) = item.representedObject() else {
    return;
  };
  let id = {
    // Safety: our sticky items always carry an NSString represented object.
    let s: &NSString = unsafe { &*(Retained::as_ptr(&obj) as *const NSString) };
    s.to_string()
  };
  if let Some(win) = app.get_webview_window(&format!("note-{id}")) {
    crate::windows::reveal(&win);
  }
}

/// `-[delegate noteNPadFocusDoc:]`: focus the document window and switch to the
/// tab named by the clicked item's `group\ttab_index` represented object. A
/// no-op if the window is not open (handled inside `focus_doc_tab`).
extern "C-unwind" fn focus_doc(_this: *mut AnyObject, _cmd: Sel, sender: *mut AnyObject) {
  let Some(app) = APP.get() else {
    return;
  };
  if sender.is_null() {
    return;
  }
  // Safety: sender is the clicked NSMenuItem carrying an NSString represented
  // object (borrowed, not owned here).
  let item: &NSMenuItem = unsafe { &*(sender as *const NSMenuItem) };
  let Some(obj) = item.representedObject() else {
    return;
  };
  let rep = {
    // Safety: our document items always carry an NSString represented object.
    let s: &NSString = unsafe { &*(Retained::as_ptr(&obj) as *const NSString) };
    s.to_string()
  };
  if let Some((group, tab_index)) = parse_doc_ref(&rep) {
    let _ = crate::windows::focus_doc_tab(app.clone(), group, tab_index);
  }
}

/// Install the Dock menu on the running app. No-op if the delegate is missing.
/// Must be called on the main thread (e.g. from Tauri's `setup`).
pub fn install(app: &tauri::AppHandle) {
  let _ = APP.set(app.clone());
  let Some(mtm) = MainThreadMarker::new() else {
    log::warn!("dock menu install off the main thread; skipping");
    return;
  };
  let ns_app = NSApplication::sharedApplication(mtm);
  // Contained unsafe: read the delegate pointer and add our methods to its
  // class. All AppKit calls run on the main thread.
  unsafe {
    let delegate: *mut AnyObject = msg_send![&*ns_app, delegate];
    if delegate.is_null() {
      log::warn!("no app delegate; skipping dock menu");
      return;
    }
    let cls: *mut AnyClass = {
      let c: *const AnyClass = msg_send![delegate, class];
      c as *mut AnyClass
    };
    let dock_imp: Imp = std::mem::transmute(
      dock_menu as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut NSMenu,
    );
    let ws_imp: Imp = std::mem::transmute(
      open_workspace as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
    );
    let focus_imp: Imp =
      std::mem::transmute(focus_note as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject));
    let focus_doc_imp: Imp =
      std::mem::transmute(focus_doc as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject));
    let ok_menu = class_addMethod(cls, sel!(applicationDockMenu:), dock_imp, c"@@:@".as_ptr());
    let ok_ws = class_addMethod(cls, sel!(noteNPadOpenWorkspace:), ws_imp, c"v@:@".as_ptr());
    let ok_focus = class_addMethod(cls, sel!(noteNPadFocusNote:), focus_imp, c"v@:@".as_ptr());
    let ok_focus_doc = class_addMethod(
      cls,
      sel!(noteNPadFocusDoc:),
      focus_doc_imp,
      c"v@:@".as_ptr(),
    );
    if !ok_menu.as_bool() || !ok_ws.as_bool() || !ok_focus.as_bool() || !ok_focus_doc.as_bool() {
      log::warn!("failed to add dock menu methods to the delegate class");
    }
  }
}
