// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

mod app_watch;
#[cfg(debug_assertions)]
mod automation;
mod cmdline;
mod ctx_menu;
mod data_files;
mod default_apps;
mod diag;
#[cfg(target_os = "macos")]
mod dock;
mod dock_labels;
mod encoding;
mod file_ops;
mod flush;
mod fonts;
mod fs_ops;
mod i18n;
#[cfg(target_os = "windows")]
mod jumplist;
mod large_file;
mod licenses;
mod linux_clipboard;
mod linux_desktop_actions;
mod locale_store;
mod mac_bookmark;
mod navigation;
mod note_store;
mod path_guard;
mod piece_table;
mod platform;
mod preview_img;
mod privacy;
mod project;
mod range_edit;
mod settings;
mod shortcut;
mod theme_store;
mod webview2_runtime;
mod win_menu_gray;
mod windowed;
mod windows;

use flush::{FlushGate, FlushOutcome};
use note_store::NoteStore;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The six Undo/Redo/Cut/Copy/Paste/Select-All items built by `build_menu`,
/// boxed as trait objects so the same tuple type covers both the predefined
/// (macOS/Windows) and custom (Linux) constructions.
type EditMenuItems = (
  Box<dyn IsMenuItem<Wry>>,
  Box<dyn IsMenuItem<Wry>>,
  Box<dyn IsMenuItem<Wry>>,
  Box<dyn IsMenuItem<Wry>>,
  Box<dyn IsMenuItem<Wry>>,
  Box<dyn IsMenuItem<Wry>>,
);

/// Hard cap on how long a quit waits for stickies to flush before exiting anyway.
const FLUSH_TIMEOUT: Duration = Duration::from_millis(1500);

/// In-flight guard for the quit handshake. A single Cmd+Q can dispatch the quit
/// action more than once, and two overlapping handshakes sharing one `FlushGate`
/// can race so a stale waiter exits past a veto. This lets only the first live
/// handshake through; it is released again only when a handshake is cancelled, so
/// the user can retry the quit after resolving whatever vetoed it.
static QUIT_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// How close together two distinct windows' `CloseRequested` events must land
/// to be treated as a desktop-shell "close all windows" / "Quit N Windows"
/// action rather than two ordinary, unrelated single-window closes. Also used
/// (on every platform) as the deferral before `drop_closed_tabs` actually
/// deletes a closed window's clean tabs, so a quit racing that same window's
/// close still has a chance to preserve them; see `note_store::drop_closed_tabs`.
const BATCH_CLOSE_WINDOW: Duration = Duration::from_millis(300);

/// The most recent window label (and when) to receive a `CloseRequested`,
/// used to recognize a batch close. macOS never needs this: Cmd+Q there is a
/// real app-level event, so a batch close is never inferred from per-window
/// events on that platform.
#[cfg(not(target_os = "macos"))]
static LAST_CLOSE_REQUEST: Mutex<Option<(String, std::time::Instant)>> = Mutex::new(None);

/// Pure decision for whether a `CloseRequested` for `label` at `now` — given
/// the previously recorded `(label, time)`, if any — looks like a
/// desktop-shell batch close: a *different* window label closed within
/// `window` beforehand. Time is passed in rather than read from the clock so
/// this is deterministically testable.
///
/// Not `#[cfg]`-gated (see the module doc note by `BATCH_CLOSE_WINDOW`) so
/// `cargo test` exercises it on every host, but its only real caller is the
/// non-macOS wiring in `handle_window_event`; on macOS itself it is only
/// reachable from `#[cfg(test)]`, which a plain (non-test) build of this
/// crate does not see.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn is_batch_close(
  prev: Option<&(String, std::time::Instant)>,
  label: &str,
  now: std::time::Instant,
  window: Duration,
) -> bool {
  match prev {
    Some((prev_label, prev_at)) => {
      prev_label != label && now.saturating_duration_since(*prev_at) <= window
    }
    None => false,
  }
}

/// Apply one `CloseRequested` to the batch-close tracking state: decide
/// whether it's a batch (via `is_batch_close`) and record it as `last`, in
/// one step. The bug this fixed (see git history) was in the record-update
/// rule, not in `is_batch_close` itself — a test that only calls
/// `is_batch_close` directly, with `prev` supplied by hand, can never see a
/// wrong update rule. Driving several consecutive closes through this
/// function is what exercises the rule for real.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn record_close_and_check_batch(
  last: &mut Option<(String, std::time::Instant)>,
  label: &str,
  now: std::time::Instant,
  window: Duration,
) -> bool {
  let batch = is_batch_close(last.as_ref(), label, now, window);
  *last = Some((label.to_string(), now));
  batch
}

/// The most recent time a `CloseRequested` was recognized as part of a
/// desktop-shell batch close, across every window. Monotonic: set on
/// detection, **never cleared** — in particular not by a vetoed quit, which
/// resets `QUIT_IN_FLIGHT` to `false` within milliseconds while the user may
/// sit in the oversized-tab dialog far longer than that. `should_forget_tabs`
/// reads this instead of `QUIT_IN_FLIGHT` alone for exactly that reason.
///
/// This time-based detection (and the deferred-deletion machinery around it,
/// down to `should_forget_tabs`) is now a fallback behind the same-pass rule
/// in `same_pass_disposition`: the same-pass rule catches a batch close
/// stall-immune and in full, the moment `MainEventsCleared` fires, so this
/// only still matters when the desktop shell spreads its close requests
/// across more than one event-loop pass, which the same-pass rule cannot see.
static LAST_BATCH_CLOSE: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// When each document window currently going through the single-close
/// (`FlushDoc`) flow had its `CloseRequested`, keyed by label. Written in
/// `handle_window_event`, read and removed by `note_store::drop_closed_tabs`
/// once that window's flush finishes and it asks whether to forget its clean
/// tabs. A label with no entry (a close that reached `drop_closed_tabs`
/// without going through `FlushDoc`) falls back to "now" at read time.
/// `Option` only because `HashMap::new` isn't `const`; every access falls
/// back to an empty map via `get_or_insert_with`.
///
/// Same fallback role as `LAST_BATCH_CLOSE` above: it exists for the case
/// the same-pass rule can't see (a batch spread across passes), not the
/// common case any more.
static CLOSE_REQUESTED_AT: Mutex<Option<HashMap<String, std::time::Instant>>> = Mutex::new(None);

/// Every window label (with its `FocusKind`) that received a `CloseRequested`
/// during the event-loop pass currently in progress. Written in
/// `handle_window_event`, drained once per pass by the `MainEventsCleared`
/// handler in `run`, which decides via `same_pass_disposition` whether this
/// was a stall-immune desktop-shell batch close (see the module doc comment
/// by `BATCH_CLOSE_WINDOW` for why wall-clock proximity alone is not enough).
/// Keyed by label so the same window closing twice in one pass counts once.
static PENDING_CLOSE: Mutex<Option<HashMap<String, FocusKind>>> = Mutex::new(None);

/// Set when the time-based fallback (`record_close_and_check_batch`) catches
/// a batch during the pass currently in progress. Read and reset to `false`
/// together with draining `PENDING_CLOSE` at `MainEventsCleared`, and fed
/// into `same_pass_disposition` alongside it — so a close the time-based
/// rule already recognized as a batch is *decided* at the same single point
/// as every other close, instead of short-circuiting straight to
/// `flush_then_exit` from inside `handle_window_event`. Deciding there too
/// was the bug: it could act on the time-based rule alone while this exact
/// close's own record in `PENDING_CLOSE` was still unread.
static TIME_BATCH_THIS_PASS: AtomicBool = AtomicBool::new(false);

/// Monotonically increasing count of event-loop passes (`MainEventsCleared`
/// firings), used only for the diagnostic log in `handle_window_event`: it
/// lets a packaged build's log answer whether the desktop shell's "close all
/// windows" delivered every `CloseRequested` in one pass or spread them
/// across several.
static EVENT_LOOP_PASS: AtomicU64 = AtomicU64::new(0);

/// Whether `drop_closed_tabs` should actually delete a closed window's clean
/// tabs now. `false` (keep them) when a quit is currently in flight, or when
/// a batch close was detected at or after this window's own close request —
/// that batch is what is going to restore these tabs, whether or not the
/// quit it started ultimately completes: a vetoed quit still leaves
/// `last_batch` set, only `quit_in_flight` resets, so checking `last_batch`
/// too is what survives a veto. `true` (forget them) otherwise: an ordinary
/// standalone close with no batch in sight, including one where a batch
/// happened and was abandoned well before this close.
fn should_forget_tabs(
  close_at: std::time::Instant,
  last_batch: Option<std::time::Instant>,
  quit_in_flight: bool,
) -> bool {
  if quit_in_flight {
    return false;
  }
  !matches!(last_batch, Some(t) if t >= close_at)
}

/// Persist every sticky's pending edits before exiting. Broadcasts `flush-request`
/// so each sticky flushes and acks, then waits (off the main thread, so the event
/// and ack IPC can still be pumped) for all acks or a timeout before quitting.
/// `flush-request` means a quit handshake has *started*, not that it is
/// guaranteed to finish: a document window can still veto it (oversized
/// unsaved tab), in which case `flush-cancelled` is broadcast below and every
/// window must undo whatever it did on the assumption the app was exiting.
pub(crate) fn flush_then_exit(app: &tauri::AppHandle) {
  // Reject re-entrant triggers: a single Cmd+Q can dispatch the quit action
  // twice, and a second handshake sharing the gate could race the first and
  // exit past a veto. Only the first live handshake proceeds.
  if QUIT_IN_FLIGHT.swap(true, Ordering::SeqCst) {
    log::debug!("quit handshake already in flight; ignoring re-entrant trigger");
    return;
  }
  // Every sticky and document window flushes its state and acks; the quit is
  // always silent now, and restore brings unsaved documents back afterward.
  let labels: HashSet<String> = app
    .webview_windows()
    .keys()
    .filter(|l| l.starts_with("note-") || l.starts_with("doc-"))
    .cloned()
    .collect();
  if labels.is_empty() {
    // Guard is intentionally not released: we are exiting now.
    app.exit(0);
    return;
  }
  let generation = app.state::<FlushGate>().arm(labels);
  let _ = app.emit("flush-request", ());
  let app = app.clone();
  std::thread::spawn(move || {
    match app.state::<FlushGate>().wait(generation, FLUSH_TIMEOUT) {
      // Completed and TimedOut exit the app, so the guard is never released.
      FlushOutcome::Completed => app.exit(0),
      FlushOutcome::TimedOut => {
        log::warn!("flush handshake timed out; exiting anyway");
        app.exit(0);
      }
      FlushOutcome::Cancelled => {
        // A document window vetoed the quit (oversized unsaved tab that
        // cannot be snapshotted); it calls `request_exit` to resume the
        // quit once the user has saved or discarded the offending tabs.
        // Release the guard so that retried quit can arm a fresh handshake.
        app.state::<FlushGate>().disarm();
        QUIT_IN_FLIGHT.store(false, Ordering::SeqCst);
        // `flush-request` only means a quit handshake started, not that it
        // will complete: every window that heard it must hear this too, so
        // it can undo whatever it did on the assumption the app was exiting
        // (StickyApp's `quitting` latch, in particular).
        let _ = app.emit("flush-cancelled", ());
        log::info!("quit cancelled by a window");
      }
    }
  });
}

/// Re-initiate the quit handshake after a window vetoed it and the state that
/// forced the veto has been resolved.
#[tauri::command]
fn request_exit(app: tauri::AppHandle) {
  flush_then_exit(&app);
}

/// Destroy a document window once its webview has flushed its dirty tabs to
/// snapshots. The OS close of a `doc-` window is intercepted (see
/// `handle_window_event`) and routed through the `close-flush-request`
/// handshake so unsaved edits are snapshotted before the window is torn down;
/// the webview calls this to finish the close. Reentrancy-safe: a second call
/// for an already-destroyed label is a no-op.
///
/// Deliberately no forced-destroy timeout here. A timeout that destroyed the
/// window regardless of the flush would reintroduce the exact data loss this
/// path exists to prevent when a webview is momentarily slow. If a webview is
/// truly wedged the user can still quit, which has its own timeout safety valve.
#[tauri::command]
fn confirm_close(app: tauri::AppHandle, label: String) {
  if let Some(window) = app.get_webview_window(&label) {
    let _ = window.destroy();
  }
}

/// The frontend-owned lists that populate the Format submenu's Encoding and
/// Syntax pickers. The frontend `text.ts` ENCODINGS and `language.ts`
/// languageNames are the single source of truth, so a document window pushes
/// them once via `set_menu_lists`; the Rust menu never hard-codes a second copy.
/// Empty until the first push (the Format menu is doc-focus-only, and a document
/// window always pushes on mount before its menu matters).
#[derive(Default)]
struct MenuLists {
  encodings: Mutex<Vec<String>>,
  languages: Mutex<Vec<String>>,
}

/// The mode-dependent menu-item handles for one built menu. Rebuilding the menu
/// (on a language change or a lists push) swaps a whole fresh set in. Enable
/// state follows the focused window; the check items mirror the focused document
/// window's active tab (line ending / encoding / syntax / always-on-top) or a
/// global setting (word wrap / line numbers).
struct MenuItemRefs {
  new_tab: MenuItem<Wry>,
  open: MenuItem<Wry>,
  save: MenuItem<Wry>,
  save_as: MenuItem<Wry>,
  close: MenuItem<Wry>,
  show_in_finder: MenuItem<Wry>,
  copy_path: MenuItem<Wry>,
  open_recent: Submenu<Wry>,
  find: MenuItem<Wry>,
  find_replace: MenuItem<Wry>,
  find_next: MenuItem<Wry>,
  find_prev: MenuItem<Wry>,
  format_menu: Submenu<Wry>,
  line_ending_lf: CheckMenuItem<Wry>,
  line_ending_crlf: CheckMenuItem<Wry>,
  encoding_items: Vec<(String, CheckMenuItem<Wry>)>,
  language_items: Vec<(Option<String>, CheckMenuItem<Wry>)>,
  word_wrap: CheckMenuItem<Wry>,
  line_numbers: CheckMenuItem<Wry>,
  always_on_top: CheckMenuItem<Wry>,
}

/// Menu items whose enabled/checked state depends on which window is focused.
/// Held in managed state so window-focus events can toggle them after the menu
/// is built. The item handles live behind a `Mutex` so a language-triggered
/// rebuild can replace them without re-`manage`-ing the state (which Tauri would
/// ignore).
struct MenuItems {
  items: Mutex<MenuItemRefs>,
  // Label of the currently focused window, or None when the app is resident
  // with no focused window. Guards focus races so the last focus wins.
  focused: Mutex<Option<String>>,
  // Per-document-window always-on-top state, keyed by window label. Absent means
  // not pinned. A stale entry for a closed window is harmless.
  on_top: Mutex<HashMap<String, bool>>,
  // The language currently pinned at the top of the Format > Syntax submenu
  // (`None` for Plain Text), so `apply` can detect when the focused tab's
  // syntax changed and the submenu needs reordering.
  syntax_pin: Mutex<Option<String>>,
}

impl MenuItems {
  /// Enable/disable and re-check every mode-dependent item for the focused
  /// window. Reads the focused document window's live tab report (for the Format
  /// checks) and the global settings (for word wrap / line numbers).
  fn apply(&self, app: &tauri::AppHandle, kind: FocusKind, focused_label: Option<&str>) {
    let f = menu_flags(kind);
    let items = self.items.lock().unwrap();
    let _ = items.new_tab.set_enabled(f.new_tab);
    let _ = items.open.set_enabled(f.open);
    let _ = items.save.set_enabled(f.save);
    let _ = items.close.set_enabled(f.close);
    let _ = items.find.set_enabled(f.find);
    let _ = items.find_replace.set_enabled(f.find_replace);
    let _ = items.find_next.set_enabled(f.find_next);
    let _ = items.find_prev.set_enabled(f.find_prev);
    // Document-only items: Save As, the Format submenu, and always-on-top.
    let is_doc = kind == FocusKind::Doc;
    let _ = items.save_as.set_enabled(is_doc);
    let _ = items.format_menu.set_enabled(is_doc);
    let _ = items.always_on_top.set_enabled(is_doc);
    // The focused document window's active tab drives Finder/copy-path enablement
    // (only when it has a saved path) and every Format check mark.
    let active = if is_doc {
      focused_label
        .and_then(|l| l.strip_prefix("doc-"))
        .and_then(|group| {
          let state = app.state::<windows::OpenDocTabs>();
          let map = state.0.lock().unwrap();
          map.get(group).and_then(|w| w.active_tab().cloned())
        })
    } else {
      None
    };
    let has_path = active.as_ref().map(|t| t.has_path).unwrap_or(false);
    let _ = items.show_in_finder.set_enabled(is_doc && has_path);
    let _ = items.copy_path.set_enabled(is_doc && has_path);
    if let Some(tab) = &active {
      let _ = items.line_ending_lf.set_checked(tab.line_ending == "LF");
      let _ = items
        .line_ending_crlf
        .set_checked(tab.line_ending == "CRLF");
      for (label, item) in &items.encoding_items {
        let _ = item.set_checked(*label == tab.encoding);
      }
      for (name, item) in &items.language_items {
        let _ = item.set_checked(name.as_deref() == tab.language.as_deref());
      }
    }
    // Always-on-top mirrors the focused window's tracked state.
    if is_doc {
      if let Some(label) = focused_label {
        let on = *self.on_top.lock().unwrap().get(label).unwrap_or(&false);
        let _ = items.always_on_top.set_checked(on);
      }
    }
    // Word wrap and line numbers mirror the global settings, so they read right
    // even while the Format/View submenus are disabled (non-document focus).
    let s = settings::app_settings(app);
    let _ = items.word_wrap.set_checked(s.editor_word_wrap);
    let _ = items.line_numbers.set_checked(s.editor_line_numbers);
    drop(items);
    // If the focused tab's syntax differs from what's pinned at the top of the
    // Format > Syntax submenu, rebuild the menu so the submenu reorders. The
    // rebuild re-reads the focused tab's language directly, so the recursive
    // `apply` call it makes will find the pin already correct and stop there.
    if is_doc {
      let active_lang = active.and_then(|t| t.language);
      let mut pin = self.syntax_pin.lock().unwrap();
      if *pin != active_lang {
        *pin = active_lang;
        drop(pin);
        let locale = i18n::current_locale(&s.language);
        rebuild_app_menu(app, locale);
      }
    }
    // Last, so it sees the final enabled flags: on Windows a runtime-disabled
    // item is left un-greyed by the toolkit and has to be re-marked by hand.
    win_menu_gray::gray_disabled_items(app);
  }

  /// Swap in the item handles from a freshly rebuilt menu.
  fn replace(&self, refs: MenuItemRefs) {
    *self.items.lock().unwrap() = refs;
  }
}

/// Re-apply the enable/check state for whichever window is currently focused.
/// Called after a document window re-reports its tabs (its active tab's line
/// ending / encoding / syntax may have changed) and after a settings save.
pub(crate) fn reapply_focus_menu(app: &tauri::AppHandle) {
  let Some(items) = app.try_state::<MenuItems>() else {
    return;
  };
  let label = items.focused.lock().unwrap().clone();
  let kind = label.as_deref().map(focus_kind).unwrap_or(FocusKind::None);
  items.apply(app, kind, label.as_deref());
}

/// Re-apply the focused window's menu state only when `group`'s document window
/// is the focused one, so a background window's tab report never clobbers the
/// menu for the window the user is actually looking at.
pub(crate) fn reapply_focus_menu_for_group(app: &tauri::AppHandle, group: &str) {
  let Some(items) = app.try_state::<MenuItems>() else {
    return;
  };
  if items.focused.lock().unwrap().as_deref() == Some(&format!("doc-{group}")) {
    reapply_focus_menu(app);
  }
}

/// The focused window's kind, which decides menu-item availability.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FocusKind {
  Doc,
  Sticky,
  Workspace,
  Settings,
  About,
  None,
}

/// Classify a window label into the kind that drives menu enablement.
fn focus_kind(label: &str) -> FocusKind {
  if label.starts_with("doc-") {
    FocusKind::Doc
  } else if label.starts_with("note-") {
    FocusKind::Sticky
  } else {
    match label {
      "workspace" => FocusKind::Workspace,
      "settings" => FocusKind::Settings,
      "about" => FocusKind::About,
      _ => FocusKind::None,
    }
  }
}

/// Enabled flags for the eight mode-dependent menu items.
struct MenuFlags {
  new_tab: bool,
  open: bool,
  save: bool,
  close: bool,
  find: bool,
  find_replace: bool,
  find_next: bool,
  find_prev: bool,
}

/// Map a focused-window kind to which mode-dependent items are enabled. Document
/// windows get everything; stickies are find-only (no replace) and cannot open or
/// tab; the workspace closes (which hides it) and opens -- it holds no document
/// of its own, but it is the one window a user can be left with when no document
/// is up, and greying Open there leaves no way into a file from inside the app;
/// settings/about and the no-focus tray state disable every mode-dependent item.
fn menu_flags(kind: FocusKind) -> MenuFlags {
  // Order: new_tab, open, save, close, find, find_replace, find_next, find_prev.
  let (nt, op, sv, cl, fd, fr, nx, pv) = match kind {
    FocusKind::Doc => (true, true, true, true, true, true, true, true),
    FocusKind::Sticky => (false, false, true, true, true, false, true, true),
    FocusKind::Workspace => (false, true, false, true, false, false, false, false),
    FocusKind::Settings | FocusKind::About | FocusKind::None => {
      (false, false, false, false, false, false, false, false)
    }
  };
  MenuFlags {
    new_tab: nt,
    open: op,
    save: sv,
    close: cl,
    find: fd,
    find_replace: fr,
    find_next: nx,
    find_prev: pv,
  }
}

/// Emit an event carrying `payload` to whichever window currently has focus.
/// Windows that don't handle the event ignore it silently.
fn emit_to_focused<T: serde::Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: T) {
  if let Some((label, _)) = app
    .webview_windows()
    .into_iter()
    .find(|(_, w)| w.is_focused().unwrap_or(false))
  {
    let _ = app.emit_to(label, event, payload);
  }
}

/// Keep the menu's mode-dependent items in sync with the focused window. On
/// focus-gain the last-focused window wins; on focus-loss or destruction of the
/// tracked window we fall back to the no-focus (all-disabled) state.
/// Label of the document window the user was in most recently. Unlike
/// `MenuItems::focused`, which is cleared the moment focus leaves so the menu
/// can grey out, this survives focus loss — which is the whole point, since the
/// case it exists for is the user being over in Finder when they open a file.
/// Cleared on `Destroyed` so it can never name a window that is gone.
static LAST_DOC_WINDOW: Mutex<Option<String>> = Mutex::new(None);

/// Track the most recent document window for `open_shell_paths`.
fn track_last_doc_window(window: &tauri::Window, event: &tauri::WindowEvent) {
  let label = window.label();
  match event {
    tauri::WindowEvent::Focused(true) if label.starts_with("doc-") => {
      *LAST_DOC_WINDOW.lock().unwrap() = Some(label.to_string());
    }
    tauri::WindowEvent::Destroyed => {
      let mut last = LAST_DOC_WINDOW.lock().unwrap();
      if last.as_deref() == Some(label) {
        *last = None;
      }
    }
    _ => {}
  }
}

/// The tracked document window, if it is still open. Checking with the app
/// handle rather than trusting the stored label alone covers the window being
/// gone without a `Destroyed` event ever reaching us.
fn last_doc_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
  let label = LAST_DOC_WINDOW.lock().unwrap().clone()?;
  app.get_webview_window(&label)
}

fn sync_menu_focus(window: &tauri::Window, event: &tauri::WindowEvent) {
  let (label, gained) = match event {
    tauri::WindowEvent::Focused(true) => (window.label().to_string(), true),
    tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed => {
      (window.label().to_string(), false)
    }
    _ => return,
  };
  let app = window.app_handle();
  let Some(items) = app.try_state::<MenuItems>() else {
    return;
  };
  let mut focused = items.focused.lock().unwrap();
  if gained {
    *focused = Some(label.clone());
    drop(focused);
    items.apply(app, focus_kind(&label), Some(&label));
  } else if focused.as_deref() == Some(label.as_str()) {
    // Only the currently tracked window losing focus resets the menu, so a
    // stale focus-loss from a previously focused window can't clobber the
    // window that just gained focus.
    *focused = None;
    drop(focused);
    items.apply(app, FocusKind::None, None);
  }
}

/// What the same-event-loop-pass batch-close rule decides, given every
/// window label (with its `FocusKind`) that received a `CloseRequested`
/// during one event-loop pass (`PENDING_CLOSE`, drained at
/// `MainEventsCleared`) and whether the time-based fallback
/// (`TIME_BATCH_THIS_PASS`) already caught a batch this same pass. Pure so
/// every combination — including the interaction between the two rules — is
/// exercisable by `cargo test` without a real event loop.
#[derive(Debug, PartialEq, Eq)]
enum SamePassDisposition {
  /// Two or more distinct windows closed in the same pass, or the
  /// time-based fallback already called it a batch: a desktop-shell batch
  /// close. Quit through the flush handshake instead of any single window's
  /// own close flow.
  Quit,
  /// Exactly one document window closed on its own, with no batch signal
  /// from either rule: flush its dirty tabs.
  FlushDoc(String),
  /// Exactly one non-document window closed, or nothing closed at all: let
  /// the OS close proceed normally (already allowed to by `prevent_close`
  /// never having been called for that kind).
  Nothing,
}

/// `time_batch` wins over the label count, and both win over kind: a
/// document window caught in a batch close (by either rule) must not run
/// its single-close flow, since that flow would permanently drop tabs the
/// quit handshake was going to preserve (see `handle_window_event`).
fn same_pass_disposition(
  pending: &HashMap<String, FocusKind>,
  time_batch: bool,
) -> SamePassDisposition {
  if time_batch || pending.len() >= 2 {
    return SamePassDisposition::Quit;
  }
  match pending.iter().next() {
    Some((label, FocusKind::Doc)) => SamePassDisposition::FlushDoc(label.clone()),
    _ => SamePassDisposition::Nothing,
  }
}

/// The app's single window-event handler: keeps the menu's focus-dependent
/// items in sync and, for document windows, intercepts the OS close so their
/// dirty tabs are flushed to snapshots before the window is destroyed (a raw
/// close would drop unsaved content). The intercepted webview flushes and then
/// calls `confirm_close` to finish. Other window kinds (sticky, workspace,
/// settings, about) close normally.
///
/// The batch-close decision (non-macOS only) must run before the document
/// single-close handling below, not after: both `close-flush-request` and
/// `flush-request` land in the same webview event queue, and if the
/// document window's own close were handled first it would flush and drop
/// its tabs via the single-close path before the quit handshake — which was
/// going to preserve them — ever starts.
fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
  sync_menu_focus(window, event);
  track_last_doc_window(window, event);
  // muda caches a menu's light/dark colours per-HWND when the menu is attached
  // and never re-reads them, so a live app-mode switch leaves the native menu
  // bar stale while the title bar follows. `set_theme` re-pushes muda's Auto
  // theme and repaints. It must be `None`, not the reported theme: tao stops
  // firing `ThemeChanged` at all once `preferred_theme` is `Some`.
  #[cfg(target_os = "windows")]
  if let tauri::WindowEvent::ThemeChanged(_) = event {
    window.app_handle().set_theme(None);
  }
  if let tauri::WindowEvent::CloseRequested { api, .. } = event {
    let kind = focus_kind(window.label());
    let now = std::time::Instant::now();
    // One line per close request, at info level so it shows in a packaged
    // build's log: whether the next `MainEventsCleared` sees this pass number
    // repeated by another window's close tells us, from the field, whether a
    // given desktop shell's "close all windows" delivers every close in one
    // event-loop pass or spreads them across several.
    log::info!(
      "close requested: window={} event-loop-pass={} (same pass number as another window's close => same-pass batch)",
      window.label(),
      EVENT_LOOP_PASS.load(Ordering::Relaxed)
    );
    // Non-macOS only: a shell "quit / close all windows" action arrives as
    // separate close requests to each window with no app-level signal. If a
    // second, distinct window closes shortly after the first, treat it as
    // that and route it through the same silent quit as Cmd/Ctrl+Q, instead
    // of leaving each window to show its own save-confirmation UI.
    //
    // This is a stall-immune-detection fallback (see `PENDING_CLOSE` /
    // `same_pass_disposition` below for the primary, same-event-loop-pass
    // rule): wall-clock proximity is wrong in principle, since it measures
    // when the main thread *processed* an event rather than when the event
    // arrived, but it still catches a batch spread across more than one
    // event-loop pass, which the same-pass rule cannot see.
    #[cfg(not(target_os = "macos"))]
    let time_batch = {
      let mut last = LAST_CLOSE_REQUEST.lock().unwrap();
      record_close_and_check_batch(&mut last, window.label(), now, BATCH_CLOSE_WINDOW)
    };
    #[cfg(target_os = "macos")]
    let time_batch = false;

    if time_batch {
      // Monotonic and never cleared, including by a later veto: see
      // `should_forget_tabs` for why `QUIT_IN_FLIGHT` alone is not enough to
      // protect a batch-caught window's tabs from `drop_closed_tabs`.
      *LAST_BATCH_CLOSE.lock().unwrap() = Some(now);
      // Per-pass only: `MainEventsCleared` reads and resets this in the same
      // step it drains `PENDING_CLOSE`, so it can never leak into a later
      // pass.
      TIME_BATCH_THIS_PASS.store(true, Ordering::SeqCst);
    }
    // Prevent the close synchronously — Tauri reads the prevent-close
    // channel right after every window-event handler returns, so this
    // cannot be deferred to `MainEventsCleared` the way the *decision* below
    // is. What to actually do about it — quit, flush this one document, or
    // let the close through — is decided once for the whole pass at
    // `MainEventsCleared`, not here: deciding *and acting* on `time_batch`
    // alone, right here, used to call `flush_then_exit` while this exact
    // close's own record in `PENDING_CLOSE` was still unread, which could
    // race the same-pass rule into missing it. See `same_pass_disposition`.
    if time_batch || kind == FocusKind::Doc {
      api.prevent_close();
    }
    // Record this close for the same-pass rule regardless of kind or
    // `time_batch`: even a close the time-based fallback already caught
    // still needs to be visible here, so a second, later window closing in
    // the same real pass is correctly counted alongside it.
    PENDING_CLOSE
      .lock()
      .unwrap()
      .get_or_insert_with(HashMap::new)
      .insert(window.label().to_string(), kind);

    if kind == FocusKind::Doc {
      // Recorded so `drop_closed_tabs` (called once this window's flush
      // finishes) can tell whether a batch was detected at or after this
      // moment, even though the flush handshake for it may take a while and
      // this window may be gone long before that's decided. Overwriting on
      // every `CloseRequested` for the same label is the whole
      // leak-prevention story: a close that never completes (the user
      // cancels the oversized-tab dialog and never retries) leaves a stale
      // entry, but it can only ever be replaced by a fresher one or removed
      // by a `drop_closed_tabs` call, never accumulate further.
      CLOSE_REQUESTED_AT
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(window.label().to_string(), now);
    }
  }
  // Drop a destroyed document window's tracked always-on-top state so a later
  // window can't inherit a stale check mark.
  if let tauri::WindowEvent::Destroyed = event {
    if let Some(items) = window.app_handle().try_state::<MenuItems>() {
      items.on_top.lock().unwrap().remove(window.label());
    }
    // A destroyed window has nothing left to flush; ack it on its behalf so
    // a quit whose wait list still names it (it was already let through and
    // is mid-destroy when the quit starts) doesn't stall out the full
    // `FLUSH_TIMEOUT` waiting for an ack that will never come. Acking while
    // the gate is unarmed or armed for a different generation is harmless:
    // `ack` only removes the label from `pending` (a no-op if absent) and
    // `wait` is generation-guarded, so a stray ack can't affect an unrelated
    // handshake.
    if let Some(gate) = window.app_handle().try_state::<FlushGate>() {
      gate.ack(window.label());
    }
  }
}

/// Populate (or repopulate) the File > Open Recent submenu from `recent`, newest
/// first, ending with a separator and a Clear Menu item (disabled when the list
/// is empty). Each path item carries id `recent:{index}`, resolved back against
/// the live settings list at click time. Existing items are cleared first, so
/// this is safe to call repeatedly as the recent list changes.
fn populate_recent(
  app: &tauri::AppHandle,
  submenu: &Submenu<Wry>,
  locale: i18n::Locale,
  recent: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
  while !submenu.items()?.is_empty() {
    submenu.remove_at(0)?;
  }
  for (i, path) in recent.iter().enumerate() {
    // Show the file name as the label but keep the full path as a tooltip is not
    // supported on menu items, so the whole path is used verbatim; a long path is
    // acceptable here and unambiguous. Trim to the base name for readability.
    let name = std::path::Path::new(path)
      .file_name()
      .and_then(|n| n.to_str())
      .unwrap_or(path);
    // A file name is user content, so it can carry a literal `&` that the
    // native menu would otherwise read as a mnemonic prefix.
    let item = MenuItem::with_id(
      app,
      format!("recent:{i}"),
      escape_menu_label(name),
      true,
      None::<&str>,
    )?;
    submenu.append(&item)?;
  }
  submenu.append(&PredefinedMenuItem::separator(app)?)?;
  let clear = MenuItem::with_id(
    app,
    "recent-clear",
    i18n::tr(locale, i18n::Key::ClearMenu),
    !recent.is_empty(),
    None::<&str>,
  )?;
  submenu.append(&clear)?;
  Ok(())
}

/// Escape a menu label that may carry a literal `&` (the product name
/// `Note&Pad`, or any translated label) for the native menu bar. `&` is the
/// mnemonic-prefix character on Windows and GTK menus, so a bare `&` there is
/// swallowed and the following letter is underlined instead — the item
/// renders as "NotePad". Doubling it (`&&`) escapes it to a literal ampersand
/// on those platforms. macOS menus have no mnemonic syntax, so the label is
/// returned unchanged there. `build_menu` and `build_tray_menu` apply this to
/// every `tr`-sourced label via their own `tr` closure, so no call site needs
/// to remember it individually; the brand literal `"Note&Pad"` still calls it
/// directly since it doesn't go through `tr`.
pub(crate) fn escape_menu_label(label: &str) -> String {
  #[cfg(target_os = "macos")]
  {
    label.to_string()
  }
  #[cfg(not(target_os = "macos"))]
  {
    label.replace('&', "&&")
  }
}

/// Every menu command that carries a keyboard accelerator: the submenu it
/// lives in (`None` for the unlocalized "Note&Pad" brand submenu), the
/// command's own label key, and its accelerator in Tauri's `CmdOrCtrl+…`
/// syntax. `build_menu` looks up each accelerator here instead of hard-coding
/// the string inline, and the Keyboard Shortcuts window (`get_shortcuts`)
/// renders this same table, so the live menu and the shortcuts list can never
/// drift apart.
const ACCELERATOR_TABLE: &[(Option<i18n::Key>, i18n::Key, &str)] = &[
  (None, i18n::Key::Quit, "CmdOrCtrl+Q"),
  (None, i18n::Key::Settings, "CmdOrCtrl+,"),
  (
    Some(i18n::Key::FileMenu),
    i18n::Key::NewSticky,
    "CmdOrCtrl+N",
  ),
  (Some(i18n::Key::FileMenu), i18n::Key::NewTab, "CmdOrCtrl+T"),
  (Some(i18n::Key::FileMenu), i18n::Key::Open, "CmdOrCtrl+O"),
  (Some(i18n::Key::FileMenu), i18n::Key::Save, "CmdOrCtrl+S"),
  (
    Some(i18n::Key::FileMenu),
    i18n::Key::SaveAs,
    "CmdOrCtrl+Shift+S",
  ),
  (Some(i18n::Key::FileMenu), i18n::Key::Close, "CmdOrCtrl+W"),
  (Some(i18n::Key::EditMenu), i18n::Key::Find, "CmdOrCtrl+F"),
  (
    Some(i18n::Key::EditMenu),
    i18n::Key::FindReplace,
    "CmdOrCtrl+Alt+F",
  ),
  (
    Some(i18n::Key::EditMenu),
    i18n::Key::FindNext,
    "CmdOrCtrl+G",
  ),
  (
    Some(i18n::Key::EditMenu),
    i18n::Key::FindPrev,
    "CmdOrCtrl+Shift+G",
  ),
  (
    Some(i18n::Key::ViewMenu),
    i18n::Key::Workspace,
    "CmdOrCtrl+Shift+E",
  ),
];

/// Shortcuts that have no menu item, so `ACCELERATOR_TABLE` cannot carry them:
/// there is no `Option<i18n::Key>` submenu to hang them off of. Each entry
/// names its own section heading rather than a menu's — `TabsSection` and
/// `LargeFileSection` are Keyboard Shortcuts window headings, not real menus.
/// Unlike `ACCELERATOR_TABLE`, this table is hand-maintained: the bindings
/// themselves live in the frontend (not in this Rust menu code), so the
/// binding sites each carry a comment pointing back here as the single place
/// to update when a binding changes.
const NON_MENU_SHORTCUTS: &[(i18n::Key, i18n::Key, &str)] = &[
  (i18n::Key::TabsSection, i18n::Key::NextTab, "Ctrl+Tab"),
  (i18n::Key::TabsSection, i18n::Key::PrevTab, "Ctrl+Shift+Tab"),
  (
    i18n::Key::LargeFileSection,
    i18n::Key::GoToLine,
    "CmdOrCtrl+L",
  ),
];

/// The accelerator `ACCELERATOR_TABLE` records for `item`, or `None` if `item`
/// carries no keyboard shortcut. Looked up by `build_menu` at each accelerated
/// item's construction site.
fn accelerator(item: i18n::Key) -> Option<&'static str> {
  ACCELERATOR_TABLE
    .iter()
    .find(|(_, key, _)| *key == item)
    .map(|(_, _, accel)| *accel)
}

#[cfg(test)]
mod accelerator_table_tests {
  use super::{accelerator, ACCELERATOR_TABLE};
  use crate::i18n::Key;

  #[test]
  fn looks_up_a_representative_spread_of_accelerated_items() {
    assert_eq!(accelerator(Key::Quit), Some("CmdOrCtrl+Q"));
    assert_eq!(accelerator(Key::Save), Some("CmdOrCtrl+S"));
    assert_eq!(accelerator(Key::FindReplace), Some("CmdOrCtrl+Alt+F"));
    assert_eq!(accelerator(Key::Workspace), Some("CmdOrCtrl+Shift+E"));
  }

  #[test]
  fn a_key_with_no_accelerator_returns_none() {
    // About has a menu item but no keyboard shortcut, unlike its App-menu
    // sibling Quit — exactly the case `accelerator` must return `None` for
    // rather than a stale or fabricated accelerator.
    assert_eq!(accelerator(Key::About), None);
    assert_eq!(accelerator(Key::HelpMenu), None);
  }

  #[test]
  fn no_item_key_appears_twice() {
    // A duplicate would mean the table (and so both the menu and the
    // shortcuts window) disagree with themselves about that command's
    // accelerator — the exact drift this table exists to prevent. `Key` has
    // no `Hash` impl, so this dedups with a plain (and, at 13 rows, cheap)
    // O(n²) scan rather than adding one just for this test.
    let mut seen: Vec<Key> = Vec::new();
    for (_, item, _) in ACCELERATOR_TABLE {
      assert!(
        !seen.contains(item),
        "{item:?} appears more than once in ACCELERATOR_TABLE"
      );
      seen.push(*item);
    }
  }

  #[test]
  fn every_accelerator_is_well_formed() {
    // Every token but the last must be one of the three modifiers this app
    // actually uses; the last token is the key itself and must be non-empty.
    for (_, item, accel) in ACCELERATOR_TABLE {
      let tokens: Vec<&str> = accel.split('+').collect();
      let (key, mods) = tokens
        .split_last()
        .expect("accelerator has at least one token");
      assert!(
        !key.is_empty(),
        "{item:?}'s accelerator has an empty key token: {accel:?}"
      );
      for token in mods {
        assert!(
          matches!(*token, "CmdOrCtrl" | "Alt" | "Shift"),
          "{item:?}'s accelerator has an unrecognized modifier {token:?}: {accel:?}"
        );
      }
    }
  }
}

/// Build the menu bar in `locale`, returning the built menu (not yet installed;
/// see `install_menu`) alongside the mode-dependent item handles.
/// App/File/Edit/Format/View/Window submenus: File/Edit/Format custom items
/// route to the focused window via `menu-action` (Close keeps its own
/// `menu-close` routing); New Sticky and New Window run the backend path
/// directly. Quit is our own item so Cmd+Q routes through the flush handshake.
/// Only text is localized; accelerators never change. Mode-dependent items
/// start disabled and are toggled by `sync_menu_focus` as focus changes. The
/// Encoding and Syntax submenus are built from the frontend-pushed `MenuLists`,
/// and Open Recent from the settings list.
fn build_menu(
  app: &tauri::AppHandle,
  locale: i18n::Locale,
) -> Result<(MenuItemRefs, Menu<Wry>), Box<dyn std::error::Error>> {
  let tr = |key| escape_menu_label(i18n::tr(locale, key));
  let s = settings::app_settings(app);
  let quit = MenuItem::with_id(
    app,
    "quit",
    tr(i18n::Key::Quit),
    true,
    accelerator(i18n::Key::Quit),
  )?;
  // Custom About/Settings items so both route to our own windows.
  let about = MenuItem::with_id(app, "about", tr(i18n::Key::About), true, None::<&str>)?;
  let settings_item = MenuItem::with_id(
    app,
    "settings",
    tr(i18n::Key::Settings),
    true,
    accelerator(i18n::Key::Settings),
  )?;
  // Brand name; not localized (macOS shows the app name as the first submenu).
  let app_menu = Submenu::with_items(
    app,
    escape_menu_label("Note&Pad"),
    true,
    &[
      &about,
      &PredefinedMenuItem::separator(app)?,
      &settings_item,
      &PredefinedMenuItem::separator(app)?,
      &quit,
    ],
  )?;
  // File items. New Sticky and New Window run backend paths directly; the rest
  // emit `menu-action` to the focused window. Close keeps its own routing so a
  // document window closes its active tab (not the whole window).
  let new_sticky = MenuItem::with_id(
    app,
    "new-sticky",
    tr(i18n::Key::NewSticky),
    true,
    accelerator(i18n::Key::NewSticky),
  )?;
  let new_tab = MenuItem::with_id(
    app,
    "new-tab",
    tr(i18n::Key::NewTab),
    false,
    accelerator(i18n::Key::NewTab),
  )?;
  let open = MenuItem::with_id(
    app,
    "open",
    tr(i18n::Key::Open),
    false,
    accelerator(i18n::Key::Open),
  )?;
  let open_recent = Submenu::with_id(app, "open-recent", tr(i18n::Key::OpenRecent), true)?;
  populate_recent(app, &open_recent, locale, &s.recent_files)?;
  let save = MenuItem::with_id(
    app,
    "save",
    tr(i18n::Key::Save),
    false,
    accelerator(i18n::Key::Save),
  )?;
  let save_as = MenuItem::with_id(
    app,
    "save-as",
    tr(i18n::Key::SaveAs),
    false,
    accelerator(i18n::Key::SaveAs),
  )?;
  let close = MenuItem::with_id(
    app,
    "close",
    tr(i18n::Key::Close),
    false,
    accelerator(i18n::Key::Close),
  )?;
  let show_in_finder = MenuItem::with_id(
    app,
    "show-in-finder",
    tr(i18n::Key::CtxShowInFinder),
    false,
    None::<&str>,
  )?;
  let copy_path = MenuItem::with_id(
    app,
    "copy-path",
    tr(i18n::Key::CopyFilePath),
    false,
    None::<&str>,
  )?;
  let file_menu = Submenu::with_items(
    app,
    tr(i18n::Key::FileMenu),
    true,
    &[
      &new_sticky,
      &new_tab,
      &PredefinedMenuItem::separator(app)?,
      &open,
      &open_recent,
      &PredefinedMenuItem::separator(app)?,
      &close,
      &save,
      &save_as,
      &PredefinedMenuItem::separator(app)?,
      &show_in_finder,
      &copy_path,
    ],
  )?;
  // Edit items: standard roles for native clipboard/undo/select behaviour (which
  // also enables Cmd+C/V in workspace and settings inputs), then our find family
  // which emits `menu-action` to the focused window.
  let find = MenuItem::with_id(
    app,
    "find",
    tr(i18n::Key::Find),
    false,
    accelerator(i18n::Key::Find),
  )?;
  let find_replace = MenuItem::with_id(
    app,
    "find-replace",
    tr(i18n::Key::FindReplace),
    false,
    accelerator(i18n::Key::FindReplace),
  )?;
  let find_next = MenuItem::with_id(
    app,
    "find-next",
    tr(i18n::Key::FindNext),
    false,
    accelerator(i18n::Key::FindNext),
  )?;
  let find_prev = MenuItem::with_id(
    app,
    "find-prev",
    tr(i18n::Key::FindPrev),
    false,
    accelerator(i18n::Key::FindPrev),
  )?;
  // Undo/Redo/Cut/Copy/Paste/Select All: predefined items on macOS (needed for
  // the responder chain) and Windows (already dispatched natively via
  // `execute_edit_command`, see windows/mod.rs). On Linux muda's predefined
  // versions are silent no-ops — Cut/Copy/Paste/SelectAll synthesize an X11 key
  // sequence via `libxdo`, a feature this build does not enable, and Undo/Redo
  // have no GTK implementation at all — so Linux gets custom items instead,
  // routed to the frontend like `find` below (`app.on_menu_event`), which runs
  // the equivalent CodeMirror command. Accelerator text mirrors the bindings
  // already in `DocumentEditor.svelte`'s `historyKeymap`/`defaultKeymap`
  // (Linux redo is Ctrl+Shift+Z, not the Ctrl+Y elsewhere in `historyKeymap`).
  #[cfg(target_os = "linux")]
  let (undo_item, redo_item, cut_item, copy_item, paste_item, select_all_item): EditMenuItems = (
    Box::new(MenuItem::with_id(
      app,
      "undo",
      tr(i18n::Key::Undo),
      true,
      Some("CmdOrCtrl+Z"),
    )?),
    Box::new(MenuItem::with_id(
      app,
      "redo",
      tr(i18n::Key::Redo),
      true,
      Some("CmdOrCtrl+Shift+Z"),
    )?),
    Box::new(MenuItem::with_id(
      app,
      "cut",
      tr(i18n::Key::Cut),
      true,
      Some("CmdOrCtrl+X"),
    )?),
    Box::new(MenuItem::with_id(
      app,
      "copy",
      tr(i18n::Key::Copy),
      true,
      Some("CmdOrCtrl+C"),
    )?),
    Box::new(MenuItem::with_id(
      app,
      "paste",
      tr(i18n::Key::Paste),
      true,
      Some("CmdOrCtrl+V"),
    )?),
    Box::new(MenuItem::with_id(
      app,
      "select-all",
      tr(i18n::Key::SelectAll),
      true,
      Some("CmdOrCtrl+A"),
    )?),
  );
  #[cfg(not(target_os = "linux"))]
  let (undo_item, redo_item, cut_item, copy_item, paste_item, select_all_item): EditMenuItems = (
    Box::new(PredefinedMenuItem::undo(
      app,
      Some(tr(i18n::Key::Undo).as_str()),
    )?),
    Box::new(PredefinedMenuItem::redo(
      app,
      Some(tr(i18n::Key::Redo).as_str()),
    )?),
    Box::new(PredefinedMenuItem::cut(
      app,
      Some(tr(i18n::Key::Cut).as_str()),
    )?),
    Box::new(PredefinedMenuItem::copy(
      app,
      Some(tr(i18n::Key::Copy).as_str()),
    )?),
    Box::new(PredefinedMenuItem::paste(
      app,
      Some(tr(i18n::Key::Paste).as_str()),
    )?),
    Box::new(PredefinedMenuItem::select_all(
      app,
      Some(tr(i18n::Key::SelectAll).as_str()),
    )?),
  );
  let edit_menu = Submenu::with_items(
    app,
    tr(i18n::Key::EditMenu),
    true,
    &[
      undo_item.as_ref(),
      redo_item.as_ref(),
      &PredefinedMenuItem::separator(app)?,
      cut_item.as_ref(),
      copy_item.as_ref(),
      paste_item.as_ref(),
      select_all_item.as_ref(),
      &PredefinedMenuItem::separator(app)?,
      &find,
      &find_replace,
      &find_next,
      &find_prev,
    ],
  )?;
  // Format menu (document-focus only). Line-ending / encoding / syntax checks
  // mirror the active tab (kept in sync via the tab report); word wrap is a
  // global setting. LF/CRLF, encoding labels, and language names are never
  // translated. The encoding and syntax lists come from the frontend push.
  let line_ending_lf =
    CheckMenuItem::with_id(app, "line-ending-lf", "LF", true, false, None::<&str>)?;
  let line_ending_crlf =
    CheckMenuItem::with_id(app, "line-ending-crlf", "CRLF", true, false, None::<&str>)?;
  let line_ending_menu = Submenu::with_items(
    app,
    tr(i18n::Key::LineEndingMenu),
    true,
    &[&line_ending_lf, &line_ending_crlf],
  )?;
  let encoding_menu = Submenu::new(app, tr(i18n::Key::Encoding), true)?;
  let mut encoding_items = Vec::new();
  for label in app.state::<MenuLists>().encodings.lock().unwrap().iter() {
    let item = CheckMenuItem::with_id(
      app,
      format!("enc:{label}"),
      label,
      true,
      false,
      None::<&str>,
    )?;
    encoding_menu.append(&item)?;
    encoding_items.push((label.clone(), item));
  }
  let syntax_menu = Submenu::new(app, tr(i18n::Key::Syntax), true)?;
  let mut language_items = Vec::new();
  let languages = app.state::<MenuLists>().languages.lock().unwrap().clone();
  let current = focused_doc_language(app);
  let order = syntax_order(&languages, current.as_deref());
  for (index, entry) in order.iter().enumerate() {
    let (id, label) = match entry {
      // Plain Text is never translated, matching program-language names.
      None => ("lang:".to_string(), "Plain Text".to_string()),
      Some(name) => (format!("lang:{name}"), name.clone()),
    };
    let item = CheckMenuItem::with_id(app, id, label, true, false, None::<&str>)?;
    syntax_menu.append(&item)?;
    language_items.push((entry.clone(), item));
    // A separator follows the pinned current-syntax entry (index 0).
    if index == 0 {
      syntax_menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
  }
  let word_wrap = CheckMenuItem::with_id(
    app,
    "word-wrap",
    tr(i18n::Key::WordWrap),
    true,
    s.editor_word_wrap,
    None::<&str>,
  )?;
  let format_menu = Submenu::with_items(
    app,
    tr(i18n::Key::FormatMenu),
    false,
    &[
      &line_ending_menu,
      &encoding_menu,
      &syntax_menu,
      &PredefinedMenuItem::separator(app)?,
      &word_wrap,
    ],
  )?;
  // View menu: the Workspace (moved here from Window) and the Line Numbers toggle.
  let workspace = MenuItem::with_id(
    app,
    "workspace",
    tr(i18n::Key::Workspace),
    true,
    accelerator(i18n::Key::Workspace),
  )?;
  let line_numbers = CheckMenuItem::with_id(
    app,
    "line-numbers",
    tr(i18n::Key::LineNumbers),
    true,
    s.editor_line_numbers,
    None::<&str>,
  )?;
  let view_menu = Submenu::with_items(
    app,
    tr(i18n::Key::ViewMenu),
    true,
    &[&workspace, &line_numbers],
  )?;
  // Window menu. Zoom is the predefined Maximize (macOS renders it as "Zoom");
  // always-on-top is per-window (document-focus only); Bring All to Front is the
  // predefined role. On macOS the submenu is registered as the app's Window menu
  // so AppKit appends the live window list automatically.
  let always_on_top = CheckMenuItem::with_id(
    app,
    "always-on-top",
    tr(i18n::Key::AlwaysOnTop),
    false,
    false,
    None::<&str>,
  )?;
  let window_menu = Submenu::with_items(
    app,
    tr(i18n::Key::WindowMenu),
    true,
    &[
      &PredefinedMenuItem::minimize(app, Some(tr(i18n::Key::Minimize).as_str()))?,
      &PredefinedMenuItem::maximize(app, Some(tr(i18n::Key::Zoom).as_str()))?,
      &PredefinedMenuItem::separator(app)?,
      &always_on_top,
      &PredefinedMenuItem::bring_all_to_front(app, Some(tr(i18n::Key::BringAllToFront).as_str()))?,
    ],
  )?;
  #[cfg(target_os = "macos")]
  let _ = window_menu.set_as_windows_menu_for_nsapp();
  // Help menu: Documentation and Report an Issue open the browser (routed to
  // `tauri_plugin_opener` in the menu-event handler); Keyboard Shortcuts,
  // Acknowledgements, and Privacy Policy each open our own window.
  let documentation = MenuItem::with_id(
    app,
    "help-documentation",
    tr(i18n::Key::Documentation),
    true,
    None::<&str>,
  )?;
  let report_issue = MenuItem::with_id(
    app,
    "help-report-issue",
    tr(i18n::Key::ReportIssue),
    true,
    None::<&str>,
  )?;
  let keyboard_shortcuts = MenuItem::with_id(
    app,
    "help-keyboard-shortcuts",
    tr(i18n::Key::KeyboardShortcuts),
    true,
    None::<&str>,
  )?;
  let acknowledgements = MenuItem::with_id(
    app,
    "help-acknowledgements",
    tr(i18n::Key::Acknowledgements),
    true,
    None::<&str>,
  )?;
  let privacy = MenuItem::with_id(
    app,
    "help-privacy",
    tr(i18n::Key::PrivacyPolicy),
    true,
    None::<&str>,
  )?;
  let help_menu = Submenu::with_items(
    app,
    tr(i18n::Key::HelpMenu),
    true,
    &[
      &documentation,
      &report_issue,
      &keyboard_shortcuts,
      &acknowledgements,
      &privacy,
    ],
  )?;
  // On macOS this also gets the system-inserted menu search field; Windows and
  // Linux have no equivalent, so the menu there is just the menu.
  #[cfg(target_os = "macos")]
  let _ = help_menu.set_as_help_menu_for_nsapp();
  let menu = Menu::with_items(
    app,
    &[
      &app_menu,
      &file_menu,
      &edit_menu,
      &format_menu,
      &view_menu,
      &window_menu,
      &help_menu,
    ],
  )?;
  Ok((
    MenuItemRefs {
      new_tab,
      open,
      save,
      save_as,
      close,
      show_in_finder,
      copy_path,
      open_recent,
      find,
      find_replace,
      find_next,
      find_prev,
      format_menu,
      line_ending_lf,
      line_ending_crlf,
      encoding_items,
      language_items,
      word_wrap,
      line_numbers,
      always_on_top,
    },
    menu,
  ))
}

/// Install a freshly built menu app-wide. Every window that has no menu of its
/// own inherits this one — both the windows open right now and any built later,
/// which is what keeps the menu accelerators (Save, Find, Quit …) alive in a
/// sticky or the settings window.
///
/// On macOS that is the whole story: one shared menu bar, drawn by the system
/// outside any window. On Windows and Linux the menu bar is drawn *inside* each
/// window, so the same inheritance paints a full "File / Edit / Format …" bar on
/// top of a frameless sticky note. There the bar is detached on every window
/// `windows::menu_bar_belongs` says it doesn't belong on — see
/// `windows::detach_menu_unless_document` for why Windows only hides it while
/// Linux removes it outright. `set_menu` above re-attaches the menu to every
/// window that has none, so each rebuild must detach it again on those windows,
/// including ones built after this call, which inherit the menu just shown.
fn install_menu(app: &tauri::AppHandle, menu: Menu<Wry>) -> tauri::Result<()> {
  // Attaching the bar takes its height out of the client area of every window
  // that keeps it, and the frontend persists that shrunken figure as the
  // window's size. Measure the windows that will keep the bar first, so the
  // height can be handed back afterwards; see `windows::fix_inner_size`.
  #[cfg(not(target_os = "macos"))]
  let before: Vec<(tauri::WebviewWindow, (f64, f64))> = app
    .webview_windows()
    .into_values()
    .filter(|w| windows::menu_bar_belongs(w.label()))
    .filter_map(|w| {
      let scale = w.scale_factor().ok()?;
      let size = w.inner_size().ok()?.to_logical::<f64>(scale);
      Some((w, (size.width, size.height)))
    })
    .collect();
  app.set_menu(menu)?;
  #[cfg(not(target_os = "macos"))]
  for (_label, window) in app.webview_windows() {
    windows::detach_menu_unless_document(&window);
  }
  #[cfg(not(target_os = "macos"))]
  for (window, size) in before {
    windows::fix_inner_size(&window, size);
  }
  Ok(())
}

/// Build the app menu in `locale`, manage the mode-dependent item state, and wire
/// the one-time menu-event handler. Called once at startup.
fn build_app_menu(
  app: &tauri::AppHandle,
  locale: i18n::Locale,
) -> Result<(), Box<dyn std::error::Error>> {
  let (refs, menu) = build_menu(app, locale)?;
  app.manage(MenuItems {
    items: Mutex::new(refs),
    focused: Mutex::new(None),
    on_top: Mutex::new(HashMap::new()),
    syntax_pin: Mutex::new(None),
  });
  install_menu(app, menu)?;
  app.on_menu_event(|app, event| {
    let id = event.id.as_ref();
    match id {
      "quit" => flush_then_exit(app),
      "new-sticky" => {
        let store = app.state::<NoteStore>();
        let _ = windows::new_sticky(app, &store);
      }
      "new-tab" | "open" | "save" | "save-as" | "show-in-finder" | "copy-path" | "find"
      | "find-replace" | "find-next" | "find-prev" | "undo" | "redo" | "cut" | "copy" | "paste"
      | "select-all" => {
        emit_to_focused(app, "menu-action", id.to_string());
      }
      "line-ending-lf" => emit_to_focused(app, "menu-action", "set-line-ending:LF".to_string()),
      "line-ending-crlf" => emit_to_focused(app, "menu-action", "set-line-ending:CRLF".to_string()),
      "word-wrap" => toggle_word_wrap(app),
      "line-numbers" => toggle_line_numbers(app),
      "always-on-top" => toggle_always_on_top(app),
      "recent-clear" => clear_recent(app),
      "workspace" => {
        let _ = windows::show_workspace(app);
      }
      "settings" => {
        let _ = windows::show_settings(app);
      }
      "about" => {
        let _ = windows::show_about(app);
      }
      "help-documentation" => {
        navigation::open_externally("https://github.com/Lonshaus/note-n-pad");
      }
      "help-report-issue" => {
        navigation::open_externally("https://github.com/Lonshaus/note-n-pad/issues");
      }
      "help-keyboard-shortcuts" => {
        let _ = windows::show_shortcuts(app);
      }
      "help-acknowledgements" => {
        let _ = windows::show_acknowledgements(app);
      }
      "help-privacy" => {
        let _ = windows::show_privacy(app);
      }
      "close" => {
        // Route Close to the focused window; its frontend decides tab-vs-window.
        emit_to_focused(app, "menu-close", ());
      }
      _ if id.starts_with("enc:") => {
        emit_to_focused(app, "menu-action", format!("set-encoding:{}", &id[4..]));
      }
      _ if id.starts_with("lang:") => {
        emit_to_focused(app, "menu-action", format!("set-language:{}", &id[5..]));
      }
      _ if id.starts_with("recent:") => open_recent(app, id),
      _ if id.starts_with("ctx:") => ctx_menu::route_ctx_event(app, id),
      _ => {}
    }
  });
  Ok(())
}

/// Toggle the global word-wrap setting from the Format menu, persisting it so
/// every window's editor reacts to `settings-changed` and the menu check updates.
fn toggle_word_wrap(app: &tauri::AppHandle) {
  let current = settings::app_settings(app).editor_word_wrap;
  let patch = serde_json::json!({ "editor_word_wrap": !current });
  if let Err(e) = settings::save_settings(app.clone(), patch) {
    log::warn!("failed to toggle word wrap: {e}");
  }
}

/// Toggle the global line-numbers setting from the View menu, same path as word
/// wrap.
fn toggle_line_numbers(app: &tauri::AppHandle) {
  let current = settings::app_settings(app).editor_line_numbers;
  let patch = serde_json::json!({ "editor_line_numbers": !current });
  if let Err(e) = settings::save_settings(app.clone(), patch) {
    log::warn!("failed to toggle line numbers: {e}");
  }
}

/// Toggle always-on-top for the focused document window, tracking the per-window
/// state and reflecting it in the menu check.
fn toggle_always_on_top(app: &tauri::AppHandle) {
  let Some((label, win)) = focused_window(app) else {
    return;
  };
  if focus_kind(&label) != FocusKind::Doc {
    return;
  }
  let items = app.state::<MenuItems>();
  let next = {
    let mut map = items.on_top.lock().unwrap();
    let next = !*map.get(&label).unwrap_or(&false);
    map.insert(label.clone(), next);
    next
  };
  let _ = win.set_always_on_top(next);
  let _ = items.items.lock().unwrap().always_on_top.set_checked(next);
}

/// Open the recent file at the index carried by a `recent:{index}` menu id,
/// resolved against the live settings list. Opens it in a fresh document window
/// (which re-records it, moving it to the front of the list).
fn open_recent(app: &tauri::AppHandle, id: &str) {
  let Some(index) = id
    .strip_prefix("recent:")
    .and_then(|n| n.parse::<usize>().ok())
  else {
    return;
  };
  let recent = settings::app_settings(app).recent_files;
  if let Some(path) = recent.get(index) {
    let _ = windows::open_document(app, path, None);
  }
}

/// Clear the File > Open Recent list and repopulate the (now empty) submenu.
fn clear_recent(app: &tauri::AppHandle) {
  if let Err(e) = settings::clear_recent_files(app) {
    log::warn!("failed to clear recent files: {e}");
    return;
  }
  refresh_recent_menu(app, &[]);
}

/// Record a freshly opened file in the recent list and repopulate the submenu.
/// The single entry point for both backend opens (New Window / Open Recent) and
/// the frontend `add_recent_file` command.
pub(crate) fn record_recent(app: &tauri::AppHandle, path: &str) {
  match settings::push_recent_file(app, path) {
    Ok(recent) => refresh_recent_menu(app, &recent),
    Err(e) => log::warn!("failed to record recent file: {e}"),
  }
}

/// Repopulate the live Open Recent submenu from `recent`. No-op if the menu has
/// not been built yet.
fn refresh_recent_menu(app: &tauri::AppHandle, recent: &[String]) {
  let Some(items) = app.try_state::<MenuItems>() else {
    return;
  };
  let locale = i18n::current_locale(&settings::app_settings(app).language);
  let guard = items.items.lock().unwrap();
  if let Err(e) = populate_recent(app, &guard.open_recent, locale, recent) {
    log::warn!("failed to refresh recent menu: {e}");
  }
}

/// The currently focused window and its label, if any.
fn focused_window(app: &tauri::AppHandle) -> Option<(String, tauri::WebviewWindow)> {
  app
    .webview_windows()
    .into_iter()
    .find(|(_, w)| w.is_focused().unwrap_or(false))
}

/// The focused document window's active tab's syntax language (`None` for
/// Plain Text, and also `None` when no document window is focused or it has
/// no active tab). Drives which entry the Format > Syntax submenu pins at top.
fn focused_doc_language(app: &tauri::AppHandle) -> Option<String> {
  let (label, _) = focused_window(app)?;
  if focus_kind(&label) != FocusKind::Doc {
    return None;
  }
  let group = label.strip_prefix("doc-")?;
  let state = app.state::<windows::OpenDocTabs>();
  let map = state.0.lock().unwrap();
  map.get(group)?.active_tab()?.language.clone()
}

/// Order the Format > Syntax submenu entries so `current` (`None` for Plain
/// Text) is pinned first, followed by every other entry (Plain Text plus
/// `languages`, in their original order) with the current one omitted so it
/// is never listed twice. When `current` is Plain Text or unset, the order is
/// unchanged from before pinning existed (Plain Text was already first).
fn syntax_order(languages: &[String], current: Option<&str>) -> Vec<Option<String>> {
  let base = std::iter::once(None).chain(languages.iter().cloned().map(Some));
  let pinned = current.map(str::to_string);
  let mut order = vec![pinned.clone()];
  order.extend(base.filter(|entry| *entry != pinned));
  order
}

#[cfg(test)]
mod syntax_order_tests {
  use super::syntax_order;

  fn langs() -> Vec<String> {
    vec!["HTML".into(), "Rust".into(), "JSON".into()]
  }

  #[test]
  fn plain_text_current_keeps_original_order() {
    let order = syntax_order(&langs(), None);
    assert_eq!(
      order,
      vec![
        None,
        Some("HTML".into()),
        Some("Rust".into()),
        Some("JSON".into()),
      ]
    );
  }

  #[test]
  fn language_current_is_pinned_and_not_duplicated() {
    let order = syntax_order(&langs(), Some("Rust"));
    assert_eq!(
      order,
      vec![
        Some("Rust".into()),
        None,
        Some("HTML".into()),
        Some("JSON".into()),
      ]
    );
  }

  #[test]
  fn unknown_current_is_still_pinned_without_duplicating_entries() {
    let order = syntax_order(&langs(), Some("Cobol"));
    assert_eq!(
      order,
      vec![
        Some("Cobol".into()),
        None,
        Some("HTML".into()),
        Some("Rust".into()),
        Some("JSON".into()),
      ]
    );
  }
}

/// Receive the frontend's encoding and syntax lists (the single source of truth
/// in `text.ts` / `language.ts`) so the Format submenus can be built from them.
/// A document window pushes these once on mount; the first push that changes the
/// stored lists rebuilds the app menu to populate the (initially empty) Encoding
/// and Syntax submenus. Idempotent: an unchanged push is a no-op, so every doc
/// window pushing costs nothing after the first.
/// Record a file the frontend just opened (Open dialog in tab mode, or the
/// workspace project tree) in the recent list. Backend-initiated opens (New
/// Window path, Open Recent) record via `record_recent` directly.
#[tauri::command]
fn add_recent_file(app: tauri::AppHandle, path: String) {
  record_recent(&app, &path);
}

#[tauri::command]
fn set_menu_lists(app: tauri::AppHandle, encodings: Vec<String>, languages: Vec<String>) {
  let lists = app.state::<MenuLists>();
  let changed = {
    let mut enc = lists.encodings.lock().unwrap();
    let mut lang = lists.languages.lock().unwrap();
    if *enc == encodings && *lang == languages {
      false
    } else {
      *enc = encodings;
      *lang = languages;
      true
    }
  };
  if changed {
    let locale = i18n::current_locale(&settings::app_settings(&app).language);
    rebuild_app_menu(&app, locale);
  }
}

/// One row of the Keyboard Shortcuts window: the current-locale section
/// heading, the command's label, and its accelerator in Tauri's
/// `CmdOrCtrl+…` syntax (the window converts that into a platform-correct
/// display on its own side).
#[derive(serde::Serialize)]
struct ShortcutRow {
  section: String,
  label: String,
  accelerator: String,
}

/// Every accelerated command in `ACCELERATOR_TABLE`, translated into `locale`,
/// for the Keyboard Shortcuts window. `None` sections (the "Note&Pad" brand
/// submenu) render with the same unlocalized brand name `build_menu` uses for
/// that submenu's title. Pulled out of the `#[tauri::command]` wrapper below
/// so the translation and section-mapping logic is testable without an
/// `AppHandle`.
fn shortcut_rows(locale: i18n::Locale) -> Vec<ShortcutRow> {
  let menu_rows = ACCELERATOR_TABLE
    .iter()
    .map(|(section, item, accel)| ShortcutRow {
      section: section.map_or_else(
        || "Note&Pad".to_string(),
        |key| i18n::tr(locale, key).to_string(),
      ),
      label: i18n::tr(locale, *item).to_string(),
      accelerator: (*accel).to_string(),
    });
  // Appended after the menu rows so the window groups menu sections first,
  // then the non-menu sections (Tabs, Large File Viewer), by first appearance.
  let non_menu_rows = NON_MENU_SHORTCUTS
    .iter()
    .map(|(section, item, accel)| ShortcutRow {
      section: i18n::tr(locale, *section).to_string(),
      label: i18n::tr(locale, *item).to_string(),
      accelerator: (*accel).to_string(),
    });
  menu_rows.chain(non_menu_rows).collect()
}

#[tauri::command]
fn get_shortcuts(app: tauri::AppHandle) -> Vec<ShortcutRow> {
  let locale = i18n::current_locale(&settings::app_settings(&app).language);
  shortcut_rows(locale)
}

#[cfg(test)]
mod shortcut_rows_tests {
  use super::{shortcut_rows, NON_MENU_SHORTCUTS};
  use crate::i18n::Locale;

  #[test]
  fn row_count_matches_both_tables() {
    assert_eq!(
      shortcut_rows(Locale::En).len(),
      super::ACCELERATOR_TABLE.len() + NON_MENU_SHORTCUTS.len()
    );
  }

  #[test]
  fn a_none_section_maps_to_the_unlocalized_brand_name() {
    let rows = shortcut_rows(Locale::En);
    let quit = rows.iter().find(|r| r.label == "Quit Note&Pad").unwrap();
    assert_eq!(quit.section, "Note&Pad");
  }

  #[test]
  fn a_some_section_translates_to_its_menu_heading() {
    let rows = shortcut_rows(Locale::ZhTw);
    let save = rows.iter().find(|r| r.label == "儲存").unwrap();
    assert_eq!(save.section, "檔案");
    assert_eq!(save.accelerator, "CmdOrCtrl+S");
  }

  #[test]
  fn non_menu_rows_are_present_with_their_own_section() {
    let rows = shortcut_rows(Locale::En);
    let next_tab = rows.iter().find(|r| r.label == "Next Tab").unwrap();
    assert_eq!(next_tab.section, "Tabs");
    assert_eq!(next_tab.accelerator, "Ctrl+Tab");
    let prev_tab = rows.iter().find(|r| r.label == "Previous Tab").unwrap();
    assert_eq!(prev_tab.section, "Tabs");
    assert_eq!(prev_tab.accelerator, "Ctrl+Shift+Tab");
    let goto = rows.iter().find(|r| r.label == "Go to Line").unwrap();
    assert_eq!(goto.section, "Large File Viewer");
    assert_eq!(goto.accelerator, "CmdOrCtrl+L");
  }

  #[test]
  fn no_accelerator_is_claimed_by_both_tables() {
    // A shared accelerator string would mean a menu command and a non-menu
    // command both claim the same chord.
    for (_, _, menu_accel) in super::ACCELERATOR_TABLE {
      for (_, _, non_menu_accel) in NON_MENU_SHORTCUTS {
        assert_ne!(
          menu_accel, non_menu_accel,
          "{menu_accel} appears in both ACCELERATOR_TABLE and NON_MENU_SHORTCUTS"
        );
      }
    }
  }

  #[test]
  fn every_locale_has_distinct_sections_and_labels_within_each_section() {
    use crate::i18n::{tr, Key};
    let locales = [
      Locale::ZhTw,
      Locale::ZhCn,
      Locale::Ja,
      Locale::En,
      Locale::Ru,
      Locale::Es,
      Locale::PtBr,
      Locale::De,
      Locale::Fr,
      Locale::Ko,
      Locale::Pl,
      Locale::Tr,
      Locale::It,
      Locale::Th,
      Locale::Vi,
    ];
    // Distinct section keys: `ACCELERATOR_TABLE`'s `Option<Key>` column
    // (`None` is the unlocalized "Note&Pad" brand submenu) plus
    // `NON_MENU_SHORTCUTS`'s section-key column.
    let mut section_keys: Vec<Option<Key>> = Vec::new();
    for (section, _, _) in super::ACCELERATOR_TABLE {
      if !section_keys.contains(section) {
        section_keys.push(*section);
      }
    }
    for (section, _, _) in NON_MENU_SHORTCUTS {
      let section = Some(*section);
      if !section_keys.contains(&section) {
        section_keys.push(section);
      }
    }
    for locale in locales {
      // Two different section keys must never translate to the same string,
      // or `ShortcutsApp.svelte`'s `{#each sections as group (group.section)}`
      // would merge two unrelated groups under one heading in that locale.
      let mut seen: Vec<(Option<Key>, String)> = Vec::new();
      for key in &section_keys {
        let text = key.map_or_else(|| "Note&Pad".to_string(), |k| tr(locale, k).to_string());
        if let Some((other_key, _)) = seen.iter().find(|(_, t)| *t == text) {
          panic!("{locale:?} sections {other_key:?} and {key:?} both translate to {text:?}");
        }
        seen.push((*key, text));
      }
      // Within each section, labels must be distinct (Svelte's keyed each
      // uses `row.label` as the key inside a section).
      let rows = shortcut_rows(locale);
      let mut sections: Vec<&str> = Vec::new();
      for row in &rows {
        if !sections.contains(&row.section.as_str()) {
          sections.push(&row.section);
        }
      }
      for section in &sections {
        let mut seen_labels: Vec<&str> = Vec::new();
        for row in rows.iter().filter(|r| r.section == *section) {
          assert!(
            !seen_labels.contains(&row.label.as_str()),
            "{locale:?} section {section} has a duplicate label: {}",
            row.label
          );
          seen_labels.push(&row.label);
        }
      }
    }
  }
}

/// Stable id for the single tray icon, so a language change can look it up and
/// swap its menu.
const TRAY_ID: &str = "main";

/// Side of the menu bar template icon, in pixels. The bytes beside it are raw
/// RGBA and carry no header to read this from, so a test asserts the two agree.
#[cfg(target_os = "macos")]
const TRAY_TEMPLATE_SIZE: u32 = 44;

/// Rebuild the app and tray menus in `locale` after a language change. The
/// managed `MenuItems` handles are swapped for the fresh menu's, then the
/// current focus state is re-applied so enable/disable keeps working. The
/// one-time menu-event handlers survive `set_menu`, so they are not re-wired.
/// Rebuild only the app menu bar in `locale`, swapping in the fresh item handles
/// and re-applying the current focus state. Used by a language change and by the
/// one-time frontend push of the encoding/syntax lists (which the empty startup
/// menu could not yet populate).
fn rebuild_app_menu(app: &tauri::AppHandle, locale: i18n::Locale) {
  // The frontend can push its encoding/syntax lists before setup has managed
  // MenuItems, and `state()` aborts the process rather than returning. Nothing
  // to rebuild yet either: the menu build still to come reads the pushed lists.
  let Some(items) = app.try_state::<MenuItems>() else {
    return;
  };
  match build_menu(app, locale) {
    Ok((refs, menu)) => {
      items.replace(refs);
      let _ = install_menu(app, menu);
      // Re-apply enable/check state for whichever window is currently focused.
      let label = items.focused.lock().unwrap().clone();
      let kind = label.as_deref().map(focus_kind).unwrap_or(FocusKind::None);
      items.apply(app, kind, label.as_deref());
    }
    Err(e) => log::warn!("failed to rebuild app menu: {e}"),
  }
}
#[cfg(test)]
mod rebuild_app_menu_guard_tests {
  // Reads the source because the failure has nothing to assert at runtime: the
  // process is gone. `state()` here aborted every Windows launch — 0xC0000409,
  // which reads as memory corruption in the event log — while every test stayed
  // green, because no test starts the app.
  const SOURCE: &str = include_str!("lib.rs");

  #[test]
  fn rebuild_app_menu_reads_menu_items_without_aborting() {
    let at = SOURCE
      .find("fn rebuild_app_menu")
      .expect("rebuild_app_menu no longer exists in lib.rs");
    let rest = &SOURCE[at..];
    let end = rest
      .find("\n}\n")
      .expect("could not find the end of rebuild_app_menu");
    let body = &rest[..end];
    assert!(
      body.contains("try_state::<MenuItems>()"),
      "rebuild_app_menu must reach MenuItems through try_state: the frontend can \
       push its encoding/syntax lists before setup has managed it"
    );
    assert!(
      !body.contains(".state::<MenuItems>()"),
      "rebuild_app_menu must not call state::<MenuItems>(): it aborts the process \
       rather than returning, and the app never opens a window"
    );
  }
}

/// Labels of the menu last handed to the tray icon, newest first in build order.
/// Tauri has `set_menu` and no getter, so without this there is no way to read
/// back what the icon is actually carrying — which is the only thing that shows
/// a language change reached the tray rather than just the window menus.
static TRAY_MENU_LABELS: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> =
  std::sync::OnceLock::new();

pub(crate) fn tray_menu_labels() -> Vec<String> {
  TRAY_MENU_LABELS
    .get_or_init(Default::default)
    .lock()
    .unwrap()
    .clone()
}

fn record_tray_menu(menu: &Menu<Wry>) {
  let mut labels = Vec::new();
  if let Ok(items) = menu.items() {
    for item in items {
      if let Some(item) = item.as_menuitem() {
        if let Ok(text) = item.text() {
          labels.push(text);
        }
      }
    }
  }
  *TRAY_MENU_LABELS
    .get_or_init(Default::default)
    .lock()
    .unwrap() = labels;
}

pub(crate) fn rebuild_menus(app: &tauri::AppHandle, locale: i18n::Locale) {
  rebuild_app_menu(app, locale);
  if let Some(tray) = app.tray_by_id(TRAY_ID) {
    match build_tray_menu(app, locale) {
      Ok(menu) => {
        record_tray_menu(&menu);
        let _ = tray.set_menu(Some(menu));
      }
      Err(e) => log::warn!("failed to rebuild tray menu: {e}"),
    }
  }
  // Windows Jump List: labels are locale-dependent, same as the tray menu.
  #[cfg(target_os = "windows")]
  jumplist::rebuild(app);
}

/// Focus every open sticky window.
fn show_all_notes(app: &tauri::AppHandle) {
  for (label, win) in app.webview_windows() {
    if label.starts_with("note-") {
      // Via `reveal`, not a bare show(): on GTK, show() re-shows every hidden
      // child, which would bring the menu bar back onto a sticky.
      windows::reveal(&win);
    }
  }
}

/// Build the tray menu in `locale`. Split out so a language change can swap it
/// onto the existing tray icon without rebuilding the whole tray.
fn build_tray_menu(
  app: &tauri::AppHandle,
  locale: i18n::Locale,
) -> Result<Menu<Wry>, Box<dyn std::error::Error>> {
  let tr = |key| escape_menu_label(i18n::tr(locale, key));
  let new_item = MenuItem::with_id(
    app,
    "new_note",
    tr(i18n::Key::TrayNewNote),
    true,
    None::<&str>,
  )?;
  let show_item = MenuItem::with_id(
    app,
    "show_all",
    tr(i18n::Key::TrayShowAll),
    true,
    None::<&str>,
  )?;
  let workspace_item = MenuItem::with_id(
    app,
    "workspace",
    tr(i18n::Key::Workspace),
    true,
    None::<&str>,
  )?;
  let settings_item =
    MenuItem::with_id(app, "settings", tr(i18n::Key::Settings), true, None::<&str>)?;
  // Distinct id from the menu-bar Quit ("quit"): sharing one id made a single
  // Cmd+Q dispatch to both handlers, double-triggering the quit handshake.
  let quit_item = MenuItem::with_id(
    app,
    "tray-quit",
    tr(i18n::Key::TrayQuit),
    true,
    None::<&str>,
  )?;
  Menu::with_items(
    app,
    &[
      &new_item,
      &show_item,
      &workspace_item,
      &settings_item,
      &quit_item,
    ],
  )
  .map_err(Into::into)
}

fn build_tray(
  app: &tauri::AppHandle,
  locale: i18n::Locale,
) -> Result<(), Box<dyn std::error::Error>> {
  let menu = build_tray_menu(app, locale)?;
  record_tray_menu(&menu);
  let tray = TrayIconBuilder::with_id(TRAY_ID);
  // The menu bar draws its items in one colour, picked from the bar's own
  // appearance; a template image is how an app hands it a shape to colour.
  // The window icon cannot serve here — it is full colour on a white plate,
  // which the bar renders as a white square beside the system's own symbols.
  #[cfg(target_os = "macos")]
  let tray = tray
    .icon(tauri::image::Image::new(
      include_bytes!("../icons/tray-macos-template.rgba"),
      TRAY_TEMPLATE_SIZE,
      TRAY_TEMPLATE_SIZE,
    ))
    .icon_as_template(true);
  // Elsewhere a tray icon is expected to be the app's own, in colour.
  #[cfg(not(target_os = "macos"))]
  let tray = tray.icon(app.default_window_icon().unwrap().clone());
  tray
    .menu(&menu)
    .show_menu_on_left_click(true)
    .on_menu_event(move |app, event| match event.id.as_ref() {
      "new_note" => {
        let store = app.state::<NoteStore>();
        let _ = windows::new_sticky(app, &store);
      }
      "show_all" => show_all_notes(app),
      "workspace" => {
        let _ = windows::show_workspace(app);
      }
      "settings" => {
        let _ = windows::show_settings(app);
      }
      "tray-quit" => flush_then_exit(app),
      _ => {}
    })
    .build(app)?;
  Ok(())
}

/// Show or hide the tray/status-bar icon, respecting the user's preference. The
/// tray is always built at startup so its menu handlers stay wired; toggling
/// visibility is the cleanest way to honor the setting without rebuilding it.
pub(crate) fn set_tray_visible(app: &tauri::AppHandle, visible: bool) {
  if let Some(tray) = app.tray_by_id(TRAY_ID) {
    let _ = tray.set_visible(visible);
  }
}

/// Bring the running instance to the foreground when a second launch is
/// intercepted by the single-instance plugin (Windows/Linux only). Reveals the
/// workspace if it is open, otherwise raises every sticky/document window,
/// otherwise opens a fresh sticky so the launch is never a no-op. Does not touch
/// the quit handshake or tray: it only shows/focuses existing windows.
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn activate_existing(app: &tauri::AppHandle) {
  if let Some(win) = app.get_webview_window("workspace") {
    windows::reveal(&win);
    return;
  }
  let mut raised = false;
  for (label, win) in app.webview_windows() {
    if label.starts_with("note-") || label.starts_with("doc-") {
      // Via `reveal` for the same reason as `show_all_notes`.
      windows::reveal(&win);
      raised = true;
    }
  }
  if !raised {
    let store = app.state::<NoteStore>();
    let _ = windows::new_sticky(app, &store);
  }
}

/// Open files the shell handed over: a double-click on an associated file,
/// "Open with", or a drop onto the executable. Routed by the same open-target
/// setting as File > Open, so the two entry points cannot disagree.
///
/// With the setting on "tab" the files join the document window the user was in
/// most recently; with no document window open there is nothing to join, so they
/// fall back to a window each. Files after the first also fall back, rather than
/// joining the window the first one just created: that window's first tab does
/// not exist until the frontend has read the file, so targeting it here would be
/// a race.
///
/// Not platform-gated, because the two delivery mechanisms differ but the
/// handling does not: Windows and Linux receive paths on the command line,
/// macOS receives them as `file://` URLs through `RunEvent::Opened`.
/// Route files the user picked in a panel exactly as the shell's handover does.
/// The workspace holds no document of its own, so Open there is the same
/// situation as a file arriving from Finder: it honours the tab-or-window
/// setting and reuses the last document window when that setting says tabs.
#[tauri::command]
fn open_picked_files(app: tauri::AppHandle, paths: Vec<String>) {
  open_shell_paths(&app, paths);
}

fn open_shell_paths<I>(app: &tauri::AppHandle, paths: I)
where
  I: IntoIterator<Item = String>,
{
  let as_tabs = settings::app_settings(app).open_target == "tab";
  for path in paths {
    if as_tabs {
      if let Some(window) = last_doc_window(app) {
        if window
          .emit_to(window.label(), "open-file-here", &path)
          .is_ok()
        {
          windows::reveal(&window);
          continue;
        }
      }
    }
    if let Err(err) = windows::open_document(app, &path, None) {
      log::warn!("could not open {path} handed over by the shell: {err}");
    }
  }
}

/// Carry out one parsed command-line action. Shared by both launch paths, which
/// differ only in what an unrecognized command line means (see the callers).
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn apply_launch_action(app: &tauri::AppHandle, action: cmdline::Action) {
  match action {
    cmdline::Action::NewSticky => {
      let store = app.state::<NoteStore>();
      let _ = windows::new_sticky(app, &store);
    }
    cmdline::Action::Workspace => {
      let _ = windows::show_workspace(app);
    }
    cmdline::Action::Note(id) => {
      let store = app.state::<NoteStore>();
      let _ = windows::focus_note_window(app.clone(), store, id);
    }
    cmdline::Action::Doc(group, tab_index) => {
      let _ = windows::focus_doc_tab(app.clone(), group, tab_index);
    }
    cmdline::Action::OpenFiles(paths) => open_shell_paths(app, paths),
    cmdline::Action::None => {}
  }
}

/// Route a second launch's command line (Jump List or a bare relaunch) to the
/// action it names, falling back to `activate_existing` for anything the
/// parser does not recognize — including the common case of a plain
/// double-launch with no flags at all.
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn handle_second_launch(app: &tauri::AppHandle, argv: Vec<String>) {
  match cmdline::parse_args(&argv) {
    cmdline::Action::None => activate_existing(app),
    action => apply_launch_action(app, action),
  }
}

/// Route the command line the app was started with. The single-instance plugin
/// only sees a *second* launch, so without this a Jump List task clicked while
/// the app is closed starts the app and then does nothing — which is the usual
/// case, since a closed app is exactly when the Jump List gets used. An
/// unrecognized command line is an ordinary startup here, not a request to
/// raise anything, so it does nothing rather than activating.
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn handle_first_launch(app: &tauri::AppHandle) {
  let argv: Vec<String> = std::env::args().collect();
  apply_launch_action(app, cmdline::parse_args(&argv));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Install the diagnostic logger first, before anything else can call into
  // `log`; it replaces the debug-only `tauri-plugin-log` registration that
  // used to leave every release build with no logging at all.
  diag::init();
  // Must run before any window (and so any taskbar association) exists.
  #[cfg(target_os = "windows")]
  jumplist::set_app_id();
  #[allow(unused_mut)]
  let mut builder = tauri::Builder::default();
  // The single-instance plugin must be registered first so it can intercept a
  // second launch before any window is created. macOS is excluded: it handles
  // reactivation through the Reopen event below, so its behavior is unchanged.
  #[cfg(any(target_os = "windows", target_os = "linux"))]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      handle_second_launch(app, argv);
    }));
  }
  // The opener plugin is not a dependency on Windows; see `open_externally`.
  #[cfg(not(target_os = "windows"))]
  {
    builder = builder.plugin(tauri_plugin_opener::init());
  }
  builder
    .plugin(tauri_plugin_dialog::init())
    // CSP cannot stop a top-level navigation; this hook is the only guard
    // between a document's link and the window loading a remote page.
    .plugin(navigation::plugin())
    .plugin(
      tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
          // Only one shortcut is ever registered, so no id check is needed.
          if event.state() == ShortcutState::Pressed {
            let store = app.state::<NoteStore>();
            let _ = windows::new_sticky(app, &store);
          }
        })
        .build(),
    )
    .on_window_event(handle_window_event)
    // The Markdown preview's only route to a local image. See `preview_img`
    // for the gates; `img-src` in tauri.conf.json must list both origin forms.
    .register_uri_scheme_protocol("docimg", preview_img::respond)
    .setup(|app| {
      // Installed first, before any other setup work, so a panic anywhere
      // below (or later, at runtime) still gets its payload and location
      // captured into the ring and dumped to disk. Chains to the previous
      // hook so the default panic message is still printed.
      let panic_handle = app.handle().clone();
      let previous_hook = std::panic::take_hook();
      std::panic::set_hook(Box::new(move |info| {
        let payload = info
          .payload()
          .downcast_ref::<&str>()
          .map(|s| s.to_string())
          .or_else(|| info.payload().downcast_ref::<String>().cloned())
          .unwrap_or_else(|| "unknown panic payload".to_string());
        diag::record_panic(
          &panic_handle,
          &payload,
          info.location().map(|l| l.to_string()),
        );
        previous_hook(info);
      }));
      let handle = app.handle();
      // Without the WebView2 Runtime not one window can be built, so the launch
      // would end in a panic with nothing on screen. Say so in a native message
      // box — the only surface available when no webview can exist — and stop.
      #[cfg(target_os = "windows")]
      if !webview2_runtime::runtime_installed() {
        let locale = i18n::current_locale(&settings::app_settings(handle).language);
        webview2_runtime::report_missing(
          i18n::tr(locale, i18n::Key::WebView2MissingTitle),
          &format!(
            "{}\n\n{}",
            i18n::tr(locale, i18n::Key::WebView2MissingBody),
            webview2_runtime::DOWNLOAD_URL
          ),
        );
        std::process::exit(1);
      }
      // Seed the 10 bundled default themes into app data on first run only;
      // a themes dir that already exists (even emptied by the user) is left
      // untouched so deleted defaults never come back.
      if let Err(e) = theme_store::seed_on_startup(handle) {
        log::warn!("failed to seed default themes: {e}");
      }
      // Seed the bundled data locales on first run only, same policy as themes;
      // the three compiled locales (en/ja/zh-TW) are never files, so they are
      // unaffected and always available even after every data locale is deleted.
      if let Err(e) = locale_store::seed_on_startup(handle) {
        log::warn!("failed to seed default locales: {e}");
      }
      // Fold a legacy "local"/"icloud" snapshot_location into the new
      // snapshot_dir path setting (a no-op once already migrated), then
      // resolve the active snapshots dir from settings.
      note_store::migrate_legacy_snapshot_location_setting(handle);
      let fallback = note_store::SnapshotFallback::default();
      let dir =
        note_store::startup_snapshot_dir(handle, &settings::app_settings(handle), &fallback)?;
      app.manage(fallback);
      // `NoteStore::load` only fails when `dir` exists but cannot be listed
      // (e.g. permissions). Falling back to an empty store for the same `dir`
      // is safe: nothing on disk is touched, and every write into `dir` would
      // fail the same way, so no data is destroyed by starting empty.
      let (store, snapshot_skips) = match NoteStore::load_reporting(dir.clone()) {
        Ok(loaded) => loaded,
        Err(e) => {
          log::warn!("failed to load snapshot store from {}: {e}", dir.display());
          (NoteStore::empty(dir), Vec::new())
        }
      };
      let notes = store.list();
      app.manage(store);
      // Snapshots are loaded before any window exists, so anything skipped is
      // held here until the report window asks for it.
      let had_snapshot_skips = !snapshot_skips.is_empty();
      app.manage(note_store::StartupSkips::holding(snapshot_skips));
      app.manage(FlushGate::default());
      app.manage(ctx_menu::CtxPending::default());
      app.manage(large_file::LargeFileState::default());
      app.manage(windowed::WindowedState::default());
      app.manage(windows::OpenDocTabs::default());
      app.manage(MenuLists::default());
      app.manage(preview_img::PreviewBases::default());
      let store = app.state::<NoteStore>();
      // Migrate any group-less document to its own solo group (keyed by its id)
      // so future restores keep it grouped. A store that cannot be written to
      // (read-only dir, full disk) only loses the migration, never the launch.
      for note in &notes {
        if note.kind == "document" && note.window_group.is_none() {
          let mut migrated = note.clone();
          migrated.window_group = Some(note.id.clone());
          if let Err(e) = store.upsert(migrated) {
            log::warn!(
              "failed to migrate document {} to a solo group: {e}",
              note.id
            );
          }
        }
      }
      // Restore windows: one per sticky, one per document group. Nothing in here
      // may propagate: this runs inside `setup`, whose error is unwrapped by the
      // `.expect` on `build()` below, so one window that refuses to build would
      // panic the whole launch and leave no way back in.
      let mut opened = 0usize;
      for note in &notes {
        if note.kind != "document" {
          match windows::create_sticky_window(handle, note) {
            Ok(()) => opened += 1,
            Err(e) => log::warn!("failed to restore sticky {}: {e}", note.id),
          }
        }
      }
      for plan in note_store::plan_document_windows(&notes) {
        match windows::create_document_window(handle, &plan, None) {
          Ok(()) => opened += 1,
          Err(e) => log::warn!("failed to restore document window {}: {e}", plan.group),
        }
      }
      // A fresh install has nothing to restore, and so does a store whose every
      // window failed above. Either way the app must not sit there windowless.
      if opened == 0 {
        if let Err(e) = windows::new_sticky(handle, &store) {
          log::warn!("failed to open the fallback sticky: {e}");
        }
      }
      // Resolve the UI locale and entry-point preferences once from settings.
      let startup = settings::app_settings(handle);
      let locale = i18n::current_locale(&startup.language);
      build_tray(handle, locale)?;
      // Hide the tray icon if the user turned it off; it is still built so its
      // menu handlers stay wired and a later toggle just flips visibility.
      if !startup.show_tray_icon {
        set_tray_visible(handle, false);
      }
      build_app_menu(handle, locale)?;
      // macOS Dock right-click menu (Open Workspace); no-op on load failure.
      #[cfg(target_os = "macos")]
      dock::install(handle);
      // Windows taskbar Jump List, the Dock menu's equivalent there; no-op on
      // load failure. Later rebuilds are driven by `rebuild_menus`,
      // `emit_store_changed`, and `report_doc_tabs`.
      #[cfg(target_os = "windows")]
      jumplist::rebuild(handle);
      // ponytail: on some machines the very first Jump List rebuild above runs
      // before the taskbar button has bound to our AppUserModelID, so Explorer
      // never picks up the list until the app is relaunched. Unverified on real
      // hardware — the fix is a second, delayed rebuild once the first window
      // has had time to show. This one always runs a full COM commit: the
      // 400ms coalescing window in `rebuild` only merges calls that land close
      // together, and by the time this fires (1.5s in) the first rebuild's
      // pending flag has long since cleared. That is the point, not a cost to
      // avoid — a second full rebuild is exactly what re-attaches the list if
      // the first one silently missed the binding.
      #[cfg(target_os = "windows")]
      {
        let handle = handle.clone();
        std::thread::spawn(move || {
          std::thread::sleep(Duration::from_millis(1500));
          jumplist::rebuild(&handle);
        });
      }
      // Follow the frontmost app so "pin to app" stickies float only over it.
      app_watch::start(handle.clone());
      // Register the global new-note accelerator from settings.
      let accel = startup.new_note_shortcut.clone();
      if let Err(e) = handle.global_shortcut().register(accel.as_str()) {
        log::warn!("failed to register global shortcut '{accel}': {e}");
      }
      // A snapshot that could not be read is reported in its own window, opened
      // last so it lands on top of everything the restore just built.
      if had_snapshot_skips {
        if let Err(e) = windows::show_load_problems(handle) {
          log::warn!("failed to open the load-problems window: {e}");
        }
      }
      // Optionally open the workspace at startup. Done last, after every sticky
      // and document window is restored, so the workspace opens on top of them
      // rather than being buried; as the explicitly requested window it does
      // take focus, which is the expected behavior for this opt-in.
      if startup.open_workspace_on_startup {
        let _ = windows::show_workspace(handle);
      }
      // Whatever the app was launched with, applied after the restore above so
      // a requested window opens on top rather than behind the restored ones.
      #[cfg(any(target_os = "windows", target_os = "linux"))]
      handle_first_launch(handle);
      // Main thread: the only place GTK/AppKit may be read.
      platform::prime_dark_preference();
      // Debug-only E2E automation socket; inert unless NOTE_N_PAD_AUTOMATION=1.
      #[cfg(debug_assertions)]
      automation::start(handle.clone());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      fs_ops::path_writable,
      fs_ops::read_file,
      fs_ops::write_file,
      encoding::read_file_auto,
      encoding::read_file_as,
      encoding::write_file_encoded,
      note_store::list_notes,
      note_store::take_startup_skips,
      windows::show_load_problems_window,
      data_files::delete_data_file,
      data_files::reveal_data_file,
      note_store::get_note,
      note_store::upsert_note,
      note_store::delete_note,
      note_store::drop_closed_tabs,
      note_store::set_snapshot_dir,
      note_store::preview_snapshot_dir_move,
      note_store::get_snapshot_dir,
      settings::load_settings,
      settings::save_settings,
      theme_store::list_themes,
      theme_store::save_theme,
      theme_store::delete_theme,
      theme_store::import_theme,
      theme_store::export_theme,
      theme_store::restore_default_theme,
      locale_store::list_locales,
      locale_store::save_locale,
      locale_store::delete_locale,
      locale_store::import_locale,
      locale_store::read_locale_file,
      locale_store::export_locale,
      locale_store::restore_default_locale,
      licenses::list_acknowledgements,
      privacy::read_privacy_policy,
      windows::new_sticky_note,
      windows::open_document_window,
      windows::open_document_group,
      set_menu_lists,
      add_recent_file,
      windows::set_window_opacity,
      windows::reveal_self,
      windows::show_workspace_window,
      windows::show_settings_window,
      windows::show_about_window,
      windows::show_shortcuts_window,
      windows::show_acknowledgements_window,
      windows::show_privacy_window,
      get_shortcuts,
      shortcut::set_new_note_shortcut,
      windows::focus_note_window,
      windows::focus_doc_tab,
      windows::report_doc_tabs,
      windows::close_doc_tab,
      windows::live_doc_groups,
      windows::sticky_row_action,
      ctx_menu::popup_row_menu,
      large_file::stat_file,
      large_file::read_chunk,
      large_file::start_line_index,
      large_file::line_to_offset,
      large_file::index_line_count,
      large_file::drop_line_index,
      large_file::stream_search,
      large_file::cancel_search,
      range_edit::file_fingerprint,
      range_edit::splice_file,
      range_edit::read_range,
      range_edit::copy_range,
      windowed::windowed_open,
      windowed::windowed_reopen,
      windowed::windowed_index,
      windowed::windowed_read,
      windowed::windowed_apply,
      windowed::windowed_undo,
      windowed::windowed_redo,
      windowed::windowed_save,
      windowed::windowed_close,
      file_ops::create_file,
      file_ops::create_folder,
      file_ops::rename_path,
      file_ops::trash_path,
      file_ops::reveal_in_finder,
      project::list_project_tree,
      project::open_project_file,
      open_picked_files,
      app_watch::list_running_apps,
      platform::platform_info,
      default_apps::default_apps_page_supported,
      default_apps::open_default_apps_page,
      fonts::installed_font_families,
      linux_clipboard::read_clipboard_text,
      preview_img::set_preview_base,
      navigation::open_external_link,
      navigation::open_preview_link,
      flush::flush_ack,
      flush::flush_cancel,
      request_exit,
      confirm_close,
      #[cfg(debug_assertions)]
      automation::automation_result
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| match event {
      // Closing all windows must not quit the app; only an explicit exit
      // (tray Quit -> app.exit) carries an exit code and is allowed through.
      tauri::RunEvent::ExitRequested { api, code, .. } if code.is_none() => {
        api.prevent_exit();
      }
      // Every `CloseRequested` queued in one event-loop pass is delivered
      // before this fires, no matter how long a handler in between stalls
      // (see the module doc comment by `BATCH_CLOSE_WINDOW`), which is what
      // makes this a stall-immune way to recognize a desktop-shell batch
      // close: drain everything `handle_window_event` recorded this pass and
      // decide once for the whole set.
      tauri::RunEvent::MainEventsCleared => {
        EVENT_LOOP_PASS.fetch_add(1, Ordering::Relaxed);
        // Both per-pass records are read and reset together, right here, so
        // `same_pass_disposition` decides from a single consistent snapshot
        // of this pass rather than the caller half-deciding on one of them
        // (see `TIME_BATCH_THIS_PASS`'s doc comment for the bug that was).
        let time_batch = TIME_BATCH_THIS_PASS.swap(false, Ordering::SeqCst);
        let pending = PENDING_CLOSE.lock().unwrap().take().unwrap_or_default();
        // The overwhelmingly common case: nothing closed this pass. Must
        // stay cheap — no allocation, no logging — since this fires on every
        // single pass of the event loop, not just ones with a close in them.
        // `pending.unwrap_or_default()` above doesn't allocate for an empty
        // map, so this check is the only added cost on that path.
        if time_batch || !pending.is_empty() {
          log::info!(
            "same-pass close decision: {} window(s) closed in this pass, time-based fallback={}",
            pending.len(),
            time_batch
          );
          match same_pass_disposition(&pending, time_batch) {
            SamePassDisposition::Quit => flush_then_exit(app_handle),
            SamePassDisposition::FlushDoc(label) => {
              if let Some(window) = app_handle.get_webview_window(&label) {
                let _ = window.emit_to(&label, "close-flush-request", ());
              }
            }
            SamePassDisposition::Nothing => {}
          }
        }
      }
      // macOS never puts opened files on the command line: Finder sends them as
      // an Apple Event, which arrives here. Fires for the launch that opened the
      // file as well as for later opens into the running app, so this is the
      // only hook file associations need on macOS.
      #[cfg(target_os = "macos")]
      tauri::RunEvent::Opened { urls } => {
        open_shell_paths(
          app_handle,
          urls
            .iter()
            // Non-file URLs (a custom scheme) would arrive here too; they are
            // not ours to open, so they are dropped rather than guessed at.
            .filter_map(|url| url.to_file_path().ok())
            .map(|path| path.to_string_lossy().into_owned()),
        );
      }
      #[cfg(target_os = "macos")]
      tauri::RunEvent::Reopen {
        has_visible_windows,
        ..
      } if !has_visible_windows => {
        let store = app_handle.state::<NoteStore>();
        let _ = windows::new_sticky(app_handle, &store);
      }
      _ => {}
    });
}

#[cfg(test)]
mod tests {
  use super::{
    escape_menu_label, focus_kind, is_batch_close, menu_flags, record_close_and_check_batch,
    same_pass_disposition, should_forget_tabs, FocusKind, SamePassDisposition, BATCH_CLOSE_WINDOW,
  };
  use std::collections::HashMap;
  use std::time::{Duration, Instant};

  // Raw RGBA carries no header, so an icon regenerated at another size reaches
  // `Image::new` as a buffer that does not match the dimensions handed with it.
  #[cfg(target_os = "macos")]
  #[test]
  fn tray_template_bytes_match_its_declared_size() {
    let side = super::TRAY_TEMPLATE_SIZE as usize;
    assert_eq!(
      include_bytes!("../icons/tray-macos-template.rgba").len(),
      side * side * 4
    );
  }

  #[test]
  fn classifies_window_labels() {
    assert_eq!(focus_kind("doc-abc123"), FocusKind::Doc);
    assert_eq!(focus_kind("note-abc123"), FocusKind::Sticky);
    assert_eq!(focus_kind("workspace"), FocusKind::Workspace);
    assert_eq!(focus_kind("settings"), FocusKind::Settings);
    assert_eq!(focus_kind("about"), FocusKind::About);
    assert_eq!(focus_kind("unknown"), FocusKind::None);
  }

  #[test]
  fn doc_enables_every_item() {
    let f = menu_flags(FocusKind::Doc);
    assert!(f.new_tab && f.open && f.save && f.close);
    assert!(f.find && f.find_replace && f.find_next && f.find_prev);
  }

  #[test]
  fn sticky_is_find_only_without_tabs() {
    let f = menu_flags(FocusKind::Sticky);
    assert!(f.save && f.close && f.find && f.find_next && f.find_prev);
    assert!(!f.new_tab && !f.open && !f.find_replace);
  }

  #[test]
  fn workspace_closes_and_opens() {
    let f = menu_flags(FocusKind::Workspace);
    assert!(f.close);
    // Open stays live here on purpose: a launch with no document restores the
    // workspace and a sticky, and every other way into a file is greyed out,
    // so disabling this one strands the user inside the app.
    assert!(f.open);
    assert!(!f.new_tab && !f.save);
    assert!(!f.find && !f.find_replace && !f.find_next && !f.find_prev);
  }

  #[test]
  fn settings_about_and_no_focus_disable_everything() {
    for kind in [FocusKind::Settings, FocusKind::About, FocusKind::None] {
      let f = menu_flags(kind);
      assert!(!f.new_tab && !f.open && !f.save && !f.close);
      assert!(!f.find && !f.find_replace && !f.find_next && !f.find_prev);
    }
  }

  #[test]
  fn escapes_menu_label_for_current_target() {
    // Behavior is cfg-dependent: doubled on non-macOS (mnemonic escape),
    // unchanged on macOS (no mnemonic syntax there).
    #[cfg(target_os = "macos")]
    {
      assert_eq!(escape_menu_label("Note&Pad"), "Note&Pad");
      assert_eq!(escape_menu_label("no ampersand"), "no ampersand");
      assert_eq!(escape_menu_label(""), "");
    }
    #[cfg(not(target_os = "macos"))]
    {
      assert_eq!(escape_menu_label("Note&Pad"), "Note&&Pad");
      assert_eq!(escape_menu_label("no ampersand"), "no ampersand");
      assert_eq!(escape_menu_label(""), "");
    }
  }

  #[test]
  fn single_window_close_is_not_a_batch() {
    assert!(!is_batch_close(
      None,
      "note-a",
      Instant::now(),
      BATCH_CLOSE_WINDOW
    ));
  }

  #[test]
  fn two_distinct_windows_within_the_window_is_a_batch() {
    let t0 = Instant::now();
    let prev = ("note-a".to_string(), t0);
    let now = t0 + Duration::from_millis(50);
    assert!(is_batch_close(
      Some(&prev),
      "note-b",
      now,
      BATCH_CLOSE_WINDOW
    ));
  }

  #[test]
  fn two_distinct_windows_outside_the_window_is_not_a_batch() {
    let t0 = Instant::now();
    let prev = ("note-a".to_string(), t0);
    let now = t0 + Duration::from_millis(400);
    assert!(!is_batch_close(
      Some(&prev),
      "note-b",
      now,
      BATCH_CLOSE_WINDOW
    ));
  }

  #[test]
  fn two_distinct_doc_labels_is_a_batch() {
    let pending = HashMap::from([
      ("doc-a".to_string(), FocusKind::Doc),
      ("doc-b".to_string(), FocusKind::Doc),
    ]);
    assert_eq!(
      same_pass_disposition(&pending, false),
      SamePassDisposition::Quit
    );
  }

  #[test]
  fn one_doc_and_one_sticky_label_is_still_a_batch() {
    // Mixed kinds still count: what matters is distinct windows in the same
    // pass, not what kind they are.
    let pending = HashMap::from([
      ("doc-a".to_string(), FocusKind::Doc),
      ("note-a".to_string(), FocusKind::Sticky),
    ]);
    assert_eq!(
      same_pass_disposition(&pending, false),
      SamePassDisposition::Quit
    );
  }

  #[test]
  fn exactly_one_doc_label_flushes_that_document() {
    let pending = HashMap::from([("doc-a".to_string(), FocusKind::Doc)]);
    assert_eq!(
      same_pass_disposition(&pending, false),
      SamePassDisposition::FlushDoc("doc-a".to_string())
    );
  }

  #[test]
  fn exactly_one_sticky_label_does_nothing() {
    let pending = HashMap::from([("note-a".to_string(), FocusKind::Sticky)]);
    assert_eq!(
      same_pass_disposition(&pending, false),
      SamePassDisposition::Nothing
    );
  }

  #[test]
  fn empty_pending_does_nothing() {
    let pending = HashMap::new();
    assert_eq!(
      same_pass_disposition(&pending, false),
      SamePassDisposition::Nothing
    );
  }

  #[test]
  fn time_batch_overrides_a_single_doc_label_into_a_quit() {
    // The regression this fix exists for: the time-based fallback already
    // recognized a batch, but this same close's own record in `pending` is
    // just one document label. Ignoring `time_batch` here would wrongly
    // flush-and-destroy the very window the batch quit was meant to protect.
    let pending = HashMap::from([("doc-a".to_string(), FocusKind::Doc)]);
    assert_eq!(
      same_pass_disposition(&pending, true),
      SamePassDisposition::Quit
    );
  }

  #[test]
  fn time_batch_with_empty_pending_is_still_a_quit() {
    // The window the time-based fallback caught prevented its own close and
    // is recorded in `pending`, in the real caller, but the pure function
    // must not depend on that being true: `time_batch` alone is enough.
    let pending = HashMap::new();
    assert_eq!(
      same_pass_disposition(&pending, true),
      SamePassDisposition::Quit
    );
  }

  #[test]
  fn two_distinct_windows_exactly_at_the_window_is_a_batch() {
    // Pins the comparison as inclusive (`<=`): changing it to `<` must fail
    // this test.
    let t0 = Instant::now();
    let prev = ("note-a".to_string(), t0);
    let now = t0 + BATCH_CLOSE_WINDOW;
    assert!(is_batch_close(
      Some(&prev),
      "note-b",
      now,
      BATCH_CLOSE_WINDOW
    ));
  }

  #[test]
  fn same_label_twice_is_not_a_batch() {
    let t0 = Instant::now();
    let prev = ("note-a".to_string(), t0);
    let now = t0 + Duration::from_millis(50);
    assert!(!is_batch_close(
      Some(&prev),
      "note-a",
      now,
      BATCH_CLOSE_WINDOW
    ));
  }
  // G1: drives the actual record-update rule (`record_close_and_check_batch`),
  // not just `is_batch_close`, through a batch of four consecutive distinct
  // windows. Reverting the old `if batch { *last = None } else { ... }`
  // record-keeping must fail this: the third and fourth windows would look
  // like the start of a fresh chain and come back `false`.
  #[test]
  fn three_or_more_consecutive_windows_are_all_recognized_as_a_batch() {
    let mut last: Option<(String, Instant)> = None;
    let t0 = Instant::now();
    let step = Duration::from_millis(50);
    let results: Vec<bool> = ["note-a", "note-b", "note-c", "note-d"]
      .iter()
      .enumerate()
      .map(|(i, label)| {
        let now = t0 + step * i as u32;
        record_close_and_check_batch(&mut last, label, now, BATCH_CLOSE_WINDOW)
      })
      .collect();
    // The first window has nothing prior, so it's never itself a batch; every
    // window after it, including the third and fourth, must be.
    assert_eq!(results, vec![false, true, true, true]);
  }

  #[test]
  fn should_forget_tabs_normal_close_with_no_batch_ever() {
    let close_at = Instant::now();
    assert!(should_forget_tabs(close_at, None, false));
  }

  #[test]
  fn should_forget_tabs_batch_detected_at_or_after_close_keeps_tabs() {
    // Pins the `>=` boundary: `last_batch` equal to `close_at` (not after it)
    // must still block the deletion. Mutating `>=` to `>` must fail this.
    let close_at = Instant::now();
    let last_batch = close_at;
    assert!(!should_forget_tabs(close_at, Some(last_batch), false));
  }

  #[test]
  fn should_forget_tabs_vetoed_batch_still_keeps_tabs() {
    // The exact bug being fixed: `quit_in_flight` has already reset to false
    // (the veto ran), but `last_batch` — set after this window's own close
    // request — must still block the deletion.
    let close_at = Instant::now();
    let last_batch = close_at + Duration::from_millis(10);
    assert!(!should_forget_tabs(close_at, Some(last_batch), false));
  }

  #[test]
  fn should_forget_tabs_stale_abandoned_batch_does_not_leak_forever() {
    // A batch happened ten minutes ago and nothing came of it; a later,
    // unrelated normal close must not be blocked by that stale record.
    let last_batch = Instant::now();
    let close_at = last_batch + Duration::from_secs(600);
    assert!(should_forget_tabs(close_at, Some(last_batch), false));
  }

  #[test]
  fn should_forget_tabs_quit_in_flight_keeps_tabs_regardless_of_batch_record() {
    let close_at = Instant::now();
    assert!(!should_forget_tabs(close_at, None, true));
  }
}

/// Regression guard for the Content-Security-Policy declared in the committed
/// `tauri.conf.json`. Nothing at runtime would report a mistake here: if the IPC
/// origins fall out of `connect-src`, Tauri catches the blocked fetch, logs a
/// single warning, and transparently falls back to the postMessage transport, so
/// the app keeps working and the regression stays invisible.
#[cfg(test)]
mod csp_config_tests {
  use serde_json::Value;

  fn csp() -> Value {
    let text =
      std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).unwrap();
    let conf: Value = serde_json::from_str(&text).unwrap();
    conf["app"]["security"]["csp"].clone()
  }

  #[test]
  fn csp_is_a_directive_object() {
    assert!(
      csp().is_object(),
      "app.security.csp must be a directive object, got {}",
      csp()
    );
  }

  #[test]
  fn default_src_is_self() {
    assert_eq!(csp()["default-src"], "'self'");
  }

  #[test]
  fn connect_src_keeps_both_ipc_origins() {
    let connect = csp()["connect-src"].as_str().unwrap().to_owned();
    assert!(
      connect.contains("ipc:"),
      "connect-src lost `ipc:`: {connect}"
    );
    assert!(
      connect.contains("http://ipc.localhost"),
      "connect-src lost `http://ipc.localhost`: {connect}"
    );
  }

  /// Same invisible-failure risk as `connect-src`, one step worse: a blocked
  /// image is just a broken image, so the preview would look merely empty.
  /// Both origin forms are needed — `docimg://` everywhere but Windows and
  /// Android, `http://docimg.localhost` there.
  #[test]
  fn img_src_keeps_self_and_both_docimg_origins() {
    let img = csp()["img-src"].as_str().unwrap().to_owned();
    assert!(img.contains("'self'"), "img-src lost `'self'`: {img}");
    assert!(img.contains("docimg:"), "img-src lost `docimg:`: {img}");
    assert!(
      img.contains("http://docimg.localhost"),
      "img-src lost `http://docimg.localhost`: {img}"
    );
  }
}

/// Regression guard for the WebView2-missing check in `webview2_runtime`. That
/// check only runs before any window is built, and Tauri builds every window
/// declared in `app.windows` before it calls the user `setup` hook — so the
/// guard is reached first only because this array is empty today. Adding a
/// window entry here would silently restore the original crash: launch would
/// panic building the window instead of showing the native "runtime missing"
/// message.
#[cfg(test)]
mod webview2_guard_placement_tests {
  use serde_json::Value;

  #[test]
  fn app_windows_is_empty() {
    let text =
      std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).unwrap();
    let conf: Value = serde_json::from_str(&text).unwrap();
    let windows = conf["app"]["windows"].as_array().unwrap();
    assert!(
      windows.is_empty(),
      "app.windows must stay empty: the WebView2 guard in webview2_runtime \
       relies on running before any window is built, and a declared window \
       here is built before that guard runs"
    );
  }
}

/// Regression guard for the static Windows CRT. Dropping `+crt-static` makes
/// the binary import VCRUNTIME140.dll again, and that failure is silent on this
/// side: the build still succeeds and every test still passes. It surfaces only
/// on a machine with no Visual C++ redistributable, where the loader fails
/// before `main` and the launch shows nothing at all — not even the WebView2
/// message box, which never gets to run.
#[cfg(test)]
mod windows_crt_config_tests {
  /// The `rustflags` line of one `[target.<triple>]` section, if it has one.
  fn target_rustflags(config: &str, triple: &str) -> Option<String> {
    let rest = config.split_once(&format!("[target.{triple}]"))?.1;
    let section = rest.split_once("\n[").map_or(rest, |(head, _)| head);
    section
      .lines()
      .find(|line| line.trim_start().starts_with("rustflags"))
      .map(str::to_owned)
  }

  #[test]
  fn every_windows_target_links_the_crt_statically() {
    let config =
      std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/.cargo/config.toml")).unwrap();
    for triple in ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] {
      let flags = target_rustflags(&config, triple)
        .unwrap_or_else(|| panic!("{triple} has no rustflags in .cargo/config.toml"));
      assert!(
        flags.contains("+crt-static"),
        "{triple} must keep `+crt-static`: without it the binary imports \
         VCRUNTIME140.dll and cannot start on a machine that has no Visual C++ \
         redistributable"
      );
    }
  }
}
