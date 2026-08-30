// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::note_store::{NoteSnapshot, NoteStore};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_WIDTH: f64 = 280.0;
const DEFAULT_HEIGHT: f64 = 230.0;
const CASCADE_STEP: f64 = 28.0;
/// The sticky card's corner radius, matching `border-radius` on `.card` in
/// `StickyApp.svelte`. macOS clips the window's layer to it; a mismatch shows
/// as a sliver of card outside the clip or desktop inside it.
#[cfg(target_os = "macos")]
const STICKY_CORNER_RADIUS: f64 = 10.0;

/// Chrome background colors matching `Canvas` in `src/lib/theme/chrome.ts`
/// (white in light mode, near-black in dark). Setting one of these on a
/// window builder makes GTK's pre-paint frame already match the chrome the
/// frontend is about to draw, instead of flashing its own default white.
const CHROME_LIGHT: Color = Color(255, 255, 255, 255);
const CHROME_DARK: Color = Color(30, 30, 30, 255);

/// The pre-paint background color for a window builder, resolving the
/// `"system"` interface mode against the OS preference right now. Never
/// applied to the sticky window, whose background must stay clear.
fn chrome_background(app: &AppHandle) -> Color {
  let mode = crate::settings::app_settings(app).interface_mode;
  let prefers_dark = crate::platform::system_prefers_dark();
  if crate::platform::interface_is_dark(&mode, prefers_dark) {
    CHROME_DARK
  } else {
    CHROME_LIGHT
  }
}

/// Placement for a new document window: position is optional (absent lets the
/// OS choose), size is always known (falling back to the doc defaults).
struct WindowBounds {
  x: Option<f64>,
  y: Option<f64>,
  width: f64,
  height: f64,
}

/// How long to wait for a window's own frontend to reveal itself before forcing
/// it. Measured on Windows: the frontend does not reveal within seconds, so this
/// timer is the reveal path there rather than a rare backstop, and every new
/// window paid the full wait. Forcing early cannot bring back the white flash
/// this mechanism was built for — `chrome_background` paints the native window
/// in the resolved theme before the frontend ever runs.
const REVEAL_GRACE: std::time::Duration = std::time::Duration::from_millis(250);

/// New windows are created hidden (`.visible(false)`) and revealed by their own
/// frontend once the theme attribute is applied. This force-shows the window
/// once `REVEAL_GRACE` is up, whether the frontend was broken or merely slow.
/// show() is idempotent, so it is harmless once the frontend already revealed
/// the window.
/// LANDMINE: on macOS show() does not make the WKWebView the first responder, so
/// real keystrokes are silently dropped until the user clicks the content — even
/// though the web page's document.activeElement already points at the editor.
/// set_focus() promotes the window/webview to first responder and fixes it; keep
/// it paired with every reveal show().
/// Next inner-size request for one axis: what we last asked for, plus the
/// shortfall the frame actually produced. `None` once it is on target.
fn next_size_request(asked: f64, got: f64, want: f64) -> Option<f64> {
  let err = want - got;
  if err.abs() < 0.5 {
    None
  } else {
    Some(asked + err)
  }
}

/// Make the client area actually measure `want`, for the two windows that carry
/// a menu bar and persist their own size.
///
/// Attaching the menu bar eats into the client area: the frame was sized when
/// `GetMenu` still returned nothing, so the conversion from inner to outer size
/// never allowed for it. The frontend saves `innerSize`, so left uncorrected
/// every relaunch shrank the window by that much again — 20px a time for the
/// document window, 39px for the workspace, whose menu wraps to two rows.
/// Re-requesting is not enough on its own: `AdjustWindowRectEx` only ever
/// allows for a single menu row, so a wrapped menu is still short afterwards.
/// Measure, correct, measure again; three passes is more than either window has
/// been seen to need.
///
/// Called from both sides of the race, because either can come first: at build
/// time for a window that inherits a menu that already exists, and from
/// `install_menu` for the windows that existed before the menu did.
pub(crate) fn fix_inner_size(window: &tauri::WebviewWindow, want: (f64, f64)) {
  let Ok(scale) = window.scale_factor() else {
    return;
  };
  let mut asked = want;
  for _ in 0..3 {
    let Ok(got) = window.inner_size() else {
      return;
    };
    let got = got.to_logical::<f64>(scale);
    let w = next_size_request(asked.0, got.width, want.0);
    let h = next_size_request(asked.1, got.height, want.1);
    if w.is_none() && h.is_none() {
      return;
    }
    asked = (w.unwrap_or(asked.0), h.unwrap_or(asked.1));
    if window
      .set_size(tauri::LogicalSize::new(asked.0, asked.1))
      .is_err()
    {
      return;
    }
  }
}

/// How many rows this window's menu bar is spread over: the number of distinct
/// tops among its top-level items. `1` when the window has no menu bar, so
/// every non-Windows platform reads as "fits".
///
/// Win32 wraps a menu bar that will not fit and never scrolls one, so a
/// workspace narrower than its own menu spends a whole extra row of panel
/// height on it.
#[cfg(target_os = "windows")]
fn menu_bar_rows(window: &tauri::WebviewWindow) -> usize {
  use windows_sys::Win32::Foundation::RECT;
  use windows_sys::Win32::UI::WindowsAndMessaging::{GetMenu, GetMenuItemCount, GetMenuItemRect};
  let Ok(hwnd) = window.hwnd() else {
    return 1;
  };
  let hwnd = hwnd.0 as isize;
  let menu = unsafe { GetMenu(hwnd as _) };
  if menu.is_null() {
    return 1;
  }
  let count = unsafe { GetMenuItemCount(menu) };
  if count <= 0 {
    return 1;
  }
  let mut tops = Vec::with_capacity(count as usize);
  for index in 0..count as u32 {
    let mut rect = RECT {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    };
    if unsafe { GetMenuItemRect(hwnd as _, menu, index, &mut rect) } == 0 {
      return 1;
    }
    tops.push(rect.top);
  }
  distinct_rows(&tops)
}

#[cfg(not(target_os = "windows"))]
fn menu_bar_rows(_window: &tauri::WebviewWindow) -> usize {
  1
}

/// Distinct values in a list of menu item tops, i.e. how many rows they sit on.
/// An empty list is one row, not zero: nothing to wrap.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn distinct_rows(tops: &[i32]) -> usize {
  let mut rows: Vec<i32> = Vec::new();
  for top in tops {
    if !rows.contains(top) {
      rows.push(*top);
    }
  }
  rows.len().max(1)
}

/// A first guess at the client width this window's menu bar needs to stay on one
/// row, in logical pixels: the widths of its top-level items added up. It reads
/// a little short of what the bar actually asks for, so it is a starting point
/// to widen from, not an answer. `None` when the window has no menu bar.
#[cfg(target_os = "windows")]
fn menu_bar_item_span(window: &tauri::WebviewWindow) -> Option<f64> {
  use windows_sys::Win32::Foundation::RECT;
  use windows_sys::Win32::UI::WindowsAndMessaging::{GetMenu, GetMenuItemCount, GetMenuItemRect};
  let hwnd = window.hwnd().ok()?.0 as isize;
  let menu = unsafe { GetMenu(hwnd as _) };
  if menu.is_null() {
    return None;
  }
  let count = unsafe { GetMenuItemCount(menu) };
  if count <= 0 {
    return None;
  }
  let mut total = 0i32;
  for index in 0..count as u32 {
    let mut rect = RECT {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    };
    if unsafe { GetMenuItemRect(hwnd as _, menu, index, &mut rect) } == 0 {
      return None;
    }
    total += rect.right - rect.left;
  }
  let scale = window.scale_factor().ok()?;
  Some(f64::from(total) / scale)
}

#[cfg(not(target_os = "windows"))]
fn menu_bar_item_span(_window: &tauri::WebviewWindow) -> Option<f64> {
  None
}

/// How far each attempt widens the window when the menu bar still wraps, and how
/// many attempts before giving up and leaving it wrapped. Twelve steps covers
/// far more than the ~8px the first guess is ever short by.
const MENU_FIT_STEP: f64 = 8.0;
const MENU_FIT_MAX_STEPS: u32 = 12;

/// Size the workspace so its menu bar sits on one row, measured rather than
/// baked in: the width it needs depends on the locale (the seven items add up
/// to 422px in Spanish against 298 in Korean), on the system UI font and on the
/// user's text size, none of them known when a default is written down.
///
/// Only ever called with the untouched default width. A stored width the user
/// chose is theirs, wrapped bar or not.
fn fit_menu_bar(window: &tauri::WebviewWindow, width: f64, height: f64) {
  let mut width = menu_bar_item_span(window).map_or(width, |span| width.max(span));
  fix_inner_size(window, (width, height));
  for _ in 0..MENU_FIT_MAX_STEPS {
    if menu_bar_rows(window) <= 1 {
      return;
    }
    width += MENU_FIT_STEP;
    fix_inner_size(window, (width, height));
  }
}

fn show_after_grace(window: tauri::WebviewWindow) {
  std::thread::spawn(move || {
    std::thread::sleep(REVEAL_GRACE);
    if !window.is_visible().unwrap_or(true) {
      let _ = window.show();
      let _ = window.set_focus();
      detach_menu_unless_document(&window);
    }
  });
}
/// Whether a window with this label is a place the drawn-in menu bar belongs:
/// a document window (`doc-*`) or the workspace. Every other window (sticky
/// notes, settings, about) is a small utility window that gets its bar
/// detached instead. Shared by `detach_menu_unless_document` (windows.rs) and
/// `install_menu` (lib.rs) so the two decisions can never drift apart.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn menu_bar_belongs(label: &str) -> bool {
  label.starts_with("doc-") || label == "workspace"
}

/// Detach the inherited menu bar from a window that is not one `menu_bar_belongs`
/// to. A new window inherits the app-wide menu, which on Windows and Linux is
/// drawn inside the window itself — a full menu bar on top of a frameless
/// sticky note. No-op on macOS, where the menu bar is never part of the window,
/// and on document/workspace windows, which are the one place the bar belongs.
///
/// On Windows the bar is only hidden (`hide_menu`): the window keeps the menu,
/// so its accelerators (Save, Find …) still fire — they are dispatched via the
/// menu's global HACCEL app-wide, unaffected by the bar's visibility.
///
/// On Linux the menu is removed outright (`remove_menu`), not just hidden.
/// GTK's `show()` is a `show_all()`, which recursively re-shows every hidden
/// child, including a hidden menu bar — so a merely-hidden bar reappears on
/// the next reveal. Removing it destroys the bar widget instead, so no
/// `show_all()` can bring it back. This also means Linux accelerators for the
/// removed menu are gone on these windows; `StickyApp.svelte` restores the
/// handful the sticky window needs with its own Linux-only key handler, see
/// the comment there for why.
///
/// Called after every reveal, not just at build time, since a window built
/// after a menu rebuild (`install_menu`) inherits the new menu shown.
#[cfg_attr(target_os = "macos", allow(unused_variables))]
pub(crate) fn detach_menu_unless_document(window: &tauri::WebviewWindow) {
  #[cfg(target_os = "linux")]
  {
    if !menu_bar_belongs(window.label()) {
      let _ = window.remove_menu();
    }
  }
  #[cfg(target_os = "windows")]
  {
    if !menu_bar_belongs(window.label()) {
      let _ = window.hide_menu();
    }
  }
}

#[cfg(test)]
mod menu_bar_tests {
  use super::menu_bar_belongs;

  #[test]
  fn document_and_workspace_windows_keep_the_bar() {
    assert!(menu_bar_belongs("doc-abc123"));
    assert!(menu_bar_belongs("workspace"));
  }

  /// The layer clip and the card are two separate radii that have to agree:
  /// the clip is in Rust, the card's own corners are in CSS. A change to
  /// either alone shows as a sliver of card outside the clip, or desktop
  /// inside it, and nothing else would catch it.
  #[cfg(target_os = "macos")]
  #[test]
  fn the_clip_radius_matches_the_card() {
    let css = std::fs::read_to_string(
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/StickyApp.svelte"),
    )
    .expect("StickyApp.svelte is next to the Rust crate");
    // Only the rule's own body. Searching past the closing brace happens to
    // work today -- no other rule spells the radius the same way -- but one
    // `border-radius: 10px;` added anywhere below would keep this green with
    // the card's own corner changed.
    let sticky = css
      .split(".sticky {")
      .nth(1)
      .and_then(|rest| rest.split_once('}'))
      .map(|(body, _)| body)
      .expect("the .sticky rule still exists");
    let want = format!("border-radius: {}px;", super::STICKY_CORNER_RADIUS as i32);
    assert!(
      sticky.contains(&want),
      "`.sticky` no longer says `{want}`; the clip in windows.rs must match it"
    );
  }

  #[test]
  fn utility_windows_lose_the_bar() {
    assert!(!menu_bar_belongs("note-xyz"));
    assert!(!menu_bar_belongs("settings"));
    assert!(!menu_bar_belongs("about"));
  }
}

/// Percent-encode a string so it survives as a URL query value. Encodes every
/// character outside the unreserved set; URLSearchParams decodes it back.
fn percent_encode(value: &str) -> String {
  let mut out = String::with_capacity(value.len());
  for byte in value.bytes() {
    match byte {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
        out.push(byte as char);
      }
      _ => out.push_str(&format!("%{byte:02X}")),
    }
  }
  out
}

/// The actual `NSWindow.setAlphaValue:` send. Caller must be on the main
/// thread -- AppKit APIs are not thread-safe.
#[cfg(target_os = "macos")]
fn macos_set_alpha_value(window: &tauri::WebviewWindow, clamped: f64) -> Result<(), String> {
  use objc2::msg_send;
  use objc2::runtime::AnyObject;
  let ns_window = window.ns_window().map_err(|e| e.to_string())? as *mut AnyObject;
  // Contained unsafe: NSWindow.setAlphaValue: takes a CGFloat (f64 here).
  unsafe {
    let _: () = msg_send![ns_window, setAlphaValue: clamped];
  }
  Ok(())
}

/// The actual AppKit sends that give a sticky its rounded corners. Caller must
/// be on the main thread -- AppKit APIs are not thread-safe.
#[cfg(target_os = "macos")]
fn macos_clip_corners(window: &tauri::WebviewWindow) -> Result<(), String> {
  use objc2::msg_send;
  use objc2::runtime::AnyObject;
  let ns_window = window.ns_window().map_err(|e| e.to_string())? as *mut AnyObject;
  // Contained unsafe: every selector below takes exactly the types spelled
  // here (BOOL as bool, NSColor and NSView as objects, CGFloat as f64).
  unsafe {
    // Clearing the window's own fill is what lets the desktop show through the
    // corners the layer clip cuts away; the webview stays opaque.
    let _: () = msg_send![ns_window, setOpaque: false];
    let clear: *mut AnyObject = msg_send![objc2::class!(NSColor), clearColor];
    let _: () = msg_send![ns_window, setBackgroundColor: clear];
    let content: *mut AnyObject = msg_send![ns_window, contentView];
    if content.is_null() {
      return Err("the sticky window has no content view".to_string());
    }
    let _: () = msg_send![content, setWantsLayer: true];
    let layer: *mut AnyObject = msg_send![content, layer];
    if layer.is_null() {
      return Err("the sticky content view has no layer".to_string());
    }
    let _: () = msg_send![layer, setCornerRadius: STICKY_CORNER_RADIUS];
    let _: () = msg_send![layer, setMasksToBounds: true];
    // The drop shadow is cut from the window's opaque shape, which the two
    // sends above just changed; without this it keeps the old square outline.
    let _: () = msg_send![ns_window, invalidateShadow];
  }
  Ok(())
}

/// Round a sticky window's corners using public AppKit only. Tauri's
/// `transparent(true)` reaches the same look through the `macos-private-api`
/// feature (KVC on WKWebView's `drawsBackground`), which a sandboxed build
/// cannot ship; a three-window comparison showed the public clip renders
/// identically. Marshals onto the main thread the same way `apply_opacity`
/// does, because sticky creation runs on both.
#[cfg(target_os = "macos")]
fn clip_sticky_corners(window: &tauri::WebviewWindow) -> Result<(), String> {
  if objc2::MainThreadMarker::new().is_some() {
    return macos_clip_corners(window);
  }
  let dispatched = window.clone();
  window
    .run_on_main_thread(move || {
      if let Err(e) = macos_clip_corners(&dispatched) {
        log::warn!("failed to clip sticky corners on main thread: {e}");
      }
    })
    .map_err(|e| e.to_string())
}

/// Read a window's native alpha back. The webview cannot see it — the value
/// lives on the window, not in CSS — so a test that a sticky really is as
/// translucent as the setting says has no other source. Returns -1.0 where the
/// platform has no reader wired up.
pub fn window_alpha(window: &tauri::WebviewWindow) -> f64 {
  #[cfg(target_os = "macos")]
  {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let Ok(ns_window) = window.ns_window() else {
      return -1.0;
    };
    // Contained unsafe: NSWindow.alphaValue returns a CGFloat (f64 here).
    unsafe { msg_send![ns_window as *mut AnyObject, alphaValue] }
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = window;
    -1.0
  }
}

/// Set a window's alpha natively on every desktop platform. Value is clamped to
/// the sticky opacity range so we never hit a fully invisible or over-bright
/// window. Each platform uses its native whole-window alpha so the effect (and
/// the window's own drop shadow) matches what the OS draws for a translucent
/// window; a CSS `opacity` on the webview root would fade only the content, not
/// the shadow, so the native path is kept for visual parity with macOS.
pub fn apply_opacity(window: &tauri::WebviewWindow, value: f64) -> Result<(), String> {
  let clamped = value.clamp(0.3, 1.0);
  #[cfg(target_os = "macos")]
  {
    // AppKit (NSWindow.setAlphaValue:) is main-thread-only. This is called both
    // from the main thread (startup restore, and the plain `set_window_opacity`
    // command, which Tauri dispatches synchronously on the thread that received
    // the IPC call) and off it (the `(async)` `new_sticky_note` command, which
    // Tauri runs on its async worker pool), so we must detect which we are on:
    // call directly when already on main to keep that path byte-identical,
    // otherwise marshal onto the main thread.
    // `run_on_main_thread` only posts the closure to the event loop and
    // returns immediately -- it never blocks waiting for it to run -- so
    // dispatching from the main thread itself cannot deadlock.
    if objc2::MainThreadMarker::new().is_some() {
      macos_set_alpha_value(window, clamped)?;
    } else {
      let dispatched = window.clone();
      window
        .run_on_main_thread(move || {
          if let Err(e) = macos_set_alpha_value(&dispatched, clamped) {
            log::warn!("failed to apply window opacity on main thread: {e}");
          }
        })
        .map_err(|e| e.to_string())?;
    }
  }
  #[cfg(target_os = "windows")]
  {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
      GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
      WS_EX_LAYERED,
    };
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
    let alpha = (clamped * 255.0).round() as u8;
    // Contained unsafe: mark the window layered, then set a uniform per-window
    // alpha. LWA_ALPHA fades the whole window (frameless sticky content) at once.
    unsafe {
      let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
      SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED as isize);
      SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);
    }
  }
  #[cfg(target_os = "linux")]
  {
    use gtk::prelude::WidgetExt;
    let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;
    gtk_window.set_opacity(clamped);
  }
  Ok(())
}

/// Position for a new sticky: offset from the focused sticky, else a cascade
/// stepped by how many stickies already exist.
fn cascade_position(app: &AppHandle) -> (f64, f64) {
  for (label, win) in app.webview_windows() {
    if label.starts_with("note-") && win.is_focused().unwrap_or(false) {
      if let (Ok(pos), Ok(scale)) = (win.outer_position(), win.scale_factor()) {
        let logical = pos.to_logical::<f64>(scale);
        return (logical.x + CASCADE_STEP, logical.y + CASCADE_STEP);
      }
    }
  }
  let count = app
    .webview_windows()
    .keys()
    .filter(|l| l.starts_with("note-"))
    .count() as f64;
  let base = 120.0 + count * CASCADE_STEP;
  (base, base)
}

/// Open a frameless sticky window for `note` at its saved bounds (or a cascade
/// fallback), reflecting its pinned and opacity state.
pub fn create_sticky_window(app: &AppHandle, note: &NoteSnapshot) -> Result<(), String> {
  let label = format!("note-{}", note.id);
  let url = WebviewUrl::App(format!("index.html?mode=sticky&note={}", note.id).into());
  // Float on top for a "top" pin, or an "app" pin whose target app is frontmost
  // right now; app_watch keeps the "app" case in sync afterwards.
  let on_top = match note.pin_mode.as_str() {
    "top" => true,
    "app" => {
      if !crate::app_watch::detection_available() {
        // Foreground detection is unavailable (e.g. Wayland): an app-pinned
        // sticky degrades to permanent always-on-top so it stays visible.
        true
      } else {
        note.pin_app.is_some()
          && note.pin_app.as_deref() == crate::app_watch::frontmost_id().as_deref()
      }
    }
    _ => false,
  };
  // Invisible in normal use (sticky windows have no decorations), but it
  // surfaces in the Windows taskbar/Alt-Tab and some Linux WM switchers, so it
  // must still be localized rather than a hardcoded English word. A dedicated
  // singular key: the Dock menu's `DockStickiesSection` is a plural section
  // header ("Sticky Notes"), which would show an identical plural label on
  // every taskbar entry.
  let locale = crate::i18n::current_locale(&crate::settings::app_settings(app).language);
  let title = crate::i18n::tr(locale, crate::i18n::Key::StickyWindowTitle);
  let mut builder = WebviewWindowBuilder::new(app, &label, url)
    .title(title)
    .visible(false)
    .decorations(false)
    .always_on_top(on_top)
    .min_inner_size(180.0, 140.0)
    .inner_size(
      note.width.unwrap_or(DEFAULT_WIDTH),
      note.height.unwrap_or(DEFAULT_HEIGHT),
    );
  // Tauri's own way to clear the window layer. macOS is excluded because there
  // it is gated behind the `macos-private-api` feature, whose only private act
  // is KVC-ing WKWebView's `drawsBackground` to false — not allowed in a
  // sandboxed build. `clip_sticky_corners` below gets the same look from public
  // AppKit, so this call is the other platforms' path only.
  #[cfg(not(target_os = "macos"))]
  {
    builder = builder.transparent(true);
  }
  // The card's rounded corners, and gated because both calls would do harm on
  // macOS. `transparent(true)` clears only the window layer, so the webview
  // layer's opaque default shows through the corners' antialiasing as a 1px
  // white fringe; alpha zero is the documented way to clear it. `shadow(false)`
  // stops Windows 11 drawing its own rounded border at a radius that is not the
  // card's 10px — on macOS the same call would drop the NSWindow shadow.
  #[cfg(windows)]
  {
    builder = builder.background_color(Color(0, 0, 0, 0)).shadow(false);
  }
  let (x, y) = match (note.x, note.y) {
    (Some(x), Some(y)) => (x, y),
    _ => cascade_position(app),
  };
  builder = builder.position(x, y);
  let window = builder.build().map_err(|e| e.to_string())?;
  // Never `?` here: the window is built and still hidden, so returning strands
  // it invisible with its label taken until the app restarts.
  #[cfg(target_os = "macos")]
  if let Err(e) = clip_sticky_corners(&window) {
    log::warn!("failed to clip the corners of {}: {e}", note.id);
  }
  if let Err(e) = apply_opacity(&window, note.opacity) {
    log::warn!("failed to apply opacity to {}: {e}", note.id);
  }
  detach_menu_unless_document(&window);
  show_after_grace(window);
  Ok(())
}

const DOC_DEFAULT_WIDTH: f64 = 800.0;
const DOC_DEFAULT_HEIGHT: f64 = 600.0;

/// Build a normal-chrome document window labeled `doc-{group}`, carrying the
/// window group (and, for a fresh open, an initial file path and project root)
/// in the URL so the frontend can load every tab in the group and restore it.
fn build_document_window(
  app: &AppHandle,
  group: &str,
  initial_path: Option<&str>,
  project: Option<&str>,
  tab: Option<i64>,
  bounds: WindowBounds,
) -> Result<(), String> {
  let WindowBounds {
    x,
    y,
    width,
    height,
  } = bounds;
  let label = format!("doc-{group}");
  let mut query = format!("index.html?mode=document&group={}", percent_encode(group));
  if let Some(path) = initial_path {
    query.push_str(&format!("&path={}", percent_encode(path)));
  }
  if let Some(project) = project {
    query.push_str(&format!("&project={}", percent_encode(project)));
  }
  // Which stored tab the restored window should activate. Carried in the URL
  // rather than emitted after the window exists: an event sent to a window whose
  // frontend has not attached its listeners yet is dropped, and there is no
  // ready signal to wait on.
  if let Some(tab) = tab {
    query.push_str(&format!("&tab={tab}"));
  }
  let url = WebviewUrl::App(query.into());
  // Set a real title at birth so macOS never shows its own empty-title
  // placeholder (e.g. "無題" on Japanese systems) before the frontend loads and
  // sets the tab's name. Untitled windows use our own translated fallback.
  let locale = crate::i18n::current_locale(&crate::settings::app_settings(app).language);
  let title = initial_path
    .and_then(|p| std::path::Path::new(p).file_name().and_then(|n| n.to_str()))
    .filter(|n| !n.is_empty())
    .map(str::to_string)
    .unwrap_or_else(|| crate::i18n::tr(locale, crate::i18n::Key::UntitledDocument).to_string());
  let mut builder = WebviewWindowBuilder::new(app, &label, url)
    .title(title)
    .visible(false)
    .background_color(chrome_background(app))
    .inner_size(width, height);
  if let (Some(x), Some(y)) = (x, y) {
    builder = builder.position(x, y);
  }
  let window = builder.build().map_err(|e| e.to_string())?;
  fix_inner_size(&window, (width, height));
  show_after_grace(window);
  Ok(())
}

/// Open a fresh document window for a file on disk, minting a new window group.
/// The frontend creates the first tab's store entry once the file is read (and
/// records the path in the recent-files menu via `add_recent_file`). A `project`
/// root, when given, tags every tab opened in the fresh window.
pub fn open_document(app: &AppHandle, path: &str, project: Option<&str>) -> Result<(), String> {
  let group = uuid::Uuid::new_v4().to_string();
  build_document_window(
    app,
    &group,
    Some(path),
    project,
    None,
    WindowBounds {
      x: None,
      y: None,
      width: DOC_DEFAULT_WIDTH,
      height: DOC_DEFAULT_HEIGHT,
    },
  )
}

/// Recreate a stored document window (one per group) at the saved bounds of its
/// lowest-tab_index tab on startup restore.
pub fn create_document_window(
  app: &AppHandle,
  plan: &crate::note_store::DocWindowPlan,
  tab: Option<i64>,
) -> Result<(), String> {
  // Restored windows adopt their project from the group's stored notes, so no
  // project rides in the URL here.
  build_document_window(
    app,
    &plan.group,
    None,
    None,
    tab,
    WindowBounds {
      x: plan.x,
      y: plan.y,
      width: plan.width.unwrap_or(DOC_DEFAULT_WIDTH),
      height: plan.height.unwrap_or(DOC_DEFAULT_HEIGHT),
    },
  )
}

/// Create a blank note in the store and open its sticky window.
pub fn new_sticky(app: &AppHandle, store: &NoteStore) -> Result<NoteSnapshot, String> {
  // New stickies inherit the last-picked paper and last-resized sticky size.
  let defaults = crate::settings::app_settings(app);
  let note = NoteSnapshot {
    id: uuid::Uuid::new_v4().to_string(),
    content: String::new(),
    file_path: None,
    language: None,
    explicit: false,
    x: None,
    y: None,
    width: Some(defaults.default_sticky_width),
    height: Some(defaults.default_sticky_height),
    pin_mode: "none".to_string(),
    pin_app: None,
    opacity: 1.0,
    paper: "classic".to_string(),
    kind: "sticky".to_string(),
    dirty: false,
    window_group: None,
    tab_index: 0,
    line_ending: "LF".to_string(),
    had_bom: false,
    encoding: "UTF-8".to_string(),
    project: None,
    large: None,
    range_source: None,
    range_start: None,
    range_end: None,
    range_fp_size: None,
    range_fp_mtime: None,
    range_start_line: None,
    windowed_index: None,
    windowed_fp_size: None,
    windowed_fp_mtime: None,
    windowed_digest: None,
    windowed_top_line: None,
  };
  store.upsert(note.clone())?;
  create_sticky_window(app, &note)?;
  crate::note_store::emit_store_changed(app, Some(&note.id));
  Ok(note)
}

/// Commands that build a window must be `(async)`: a blocking one runs on the
/// Windows UI thread and `build()` deadlocks against the event loop it occupies.
/// More broadly, any command whose work scales with file size (scan, save,
/// splice, range read/copy) must also be `(async)`, or it blocks repaint on
/// every window while it runs — see `heavy_io_command_threading_tests` in
/// `windowed.rs` and `range_edit.rs` for that half of the rule.
/// `window_command_threading_tests` guards the window-builder half.
#[tauri::command(async)]
pub fn new_sticky_note(app: AppHandle, store: State<NoteStore>) -> Result<NoteSnapshot, String> {
  new_sticky(&app, &store)
}

#[tauri::command(async)]
pub fn open_document_window(app: AppHandle, path: String) -> Result<(), String> {
  open_document(&app, &path, None)
}

/// Open a document window for a group that already exists in the store, exactly
/// as a startup restore would. Used by the sticky-to-document conversion (the
/// note is upserted as a document first, then this opens its real `doc-` window
/// so the sticky window can be destroyed instead of navigated in place) and by
/// the workspace, which lists every stored document — including groups whose
/// window the user closed, whose rows would otherwise do nothing when clicked.
/// `tab` activates one stored `tab_index` instead of the group's first tab.
#[tauri::command(async)]
pub fn open_document_group(
  app: AppHandle,
  store: State<NoteStore>,
  group: String,
  tab: Option<i64>,
) -> Result<(), String> {
  let notes = store.list();
  let plan = crate::note_store::plan_document_windows(&notes)
    .into_iter()
    .find(|p| p.group == group)
    .ok_or_else(|| format!("no stored document group: {group}"))?;
  create_document_window(&app, &plan, tab)
}

#[tauri::command]
pub fn set_window_opacity(window: tauri::WebviewWindow, value: f64) -> Result<(), String> {
  apply_opacity(&window, value)
}

/// Frontend reveal path: shown once the theme is applied (see `show_after_grace`
/// for the white-flash mechanism). set_focus() is mandatory here, not cosmetic —
/// on macOS a bare show() leaves the WKWebView off the responder chain, so real
/// keystrokes are dropped until a mouse click even though the page already
/// focused its editor. Called by `revealWhenThemed` in place of a raw show().
#[tauri::command]
pub fn reveal_self(window: tauri::WebviewWindow) -> Result<(), String> {
  window.show().map_err(|e| e.to_string())?;
  window.set_focus().map_err(|e| e.to_string())?;
  detach_menu_unless_document(&window);
  Ok(())
}

const WORKSPACE_MIN_WIDTH: f64 = 260.0;
const WORKSPACE_MIN_HEIGHT: f64 = 320.0;

/// Raise the existing helper, or reveal a focused window.
pub(crate) fn reveal(win: &tauri::WebviewWindow) {
  let _ = win.unminimize();
  let _ = win.show();
  let _ = win.set_focus();
  detach_menu_unless_document(win);
}

/// Open (or focus, if already open) the singleton workspace window at its
/// remembered bounds.
pub fn show_workspace(app: &AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("workspace") {
    reveal(&win);
    return Ok(());
  }
  let s = crate::settings::app_settings(app);
  let locale = crate::i18n::current_locale(&s.language);
  let url = WebviewUrl::App("index.html?mode=workspace".into());
  // The workspace is a singleton summoned by shortcut/menu/tray: closing it
  // only hides it (the frontend intercepts close), so state survives and a
  // re-summon is instant. System chrome with only the close button active;
  // Cmd+Q quit is unaffected — the workspace is never flush-armed.
  let mut builder = WebviewWindowBuilder::new(app, "workspace", url)
    .title(crate::i18n::tr(locale, crate::i18n::Key::Workspace))
    .visible(false)
    .background_color(chrome_background(app))
    .minimizable(false)
    .maximizable(false)
    .min_inner_size(WORKSPACE_MIN_WIDTH, WORKSPACE_MIN_HEIGHT)
    .inner_size(s.workspace_width, s.workspace_height);
  if let (Some(x), Some(y)) = (s.workspace_x, s.workspace_y) {
    builder = builder.position(x, y);
  }
  let window = builder.build().map_err(|e| e.to_string())?;
  // Never let the *default* width be one the menu bar wraps in. Only the
  // untouched default is widened: any other stored width is one the user chose,
  // and narrowing the panel until the bar wraps is their call to make.
  if s.workspace_width == crate::settings::default_workspace_width() {
    fit_menu_bar(&window, s.workspace_width, s.workspace_height);
  } else {
    fix_inner_size(&window, (s.workspace_width, s.workspace_height));
  }
  detach_menu_unless_document(&window);
  show_after_grace(window);
  Ok(())
}

#[tauri::command(async)]
pub fn show_workspace_window(app: AppHandle) -> Result<(), String> {
  show_workspace(&app)
}

/// Open (or focus) the singleton settings window: system chrome, fixed size,
/// not resizable.
pub fn show_settings(app: &AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("settings") {
    reveal(&win);
    return Ok(());
  }
  let locale = crate::i18n::current_locale(&crate::settings::app_settings(app).language);
  let url = WebviewUrl::App("index.html?mode=settings".into());
  let window = WebviewWindowBuilder::new(app, "settings", url)
    .title(crate::i18n::tr(locale, crate::i18n::Key::SettingsTitle))
    .visible(false)
    .background_color(chrome_background(app))
    .resizable(false)
    .maximizable(false)
    // Sized for the widest pane: the locale editor's list + key/reference +
    // input columns, which need the extra width to avoid horizontal scrolling.
    .inner_size(1080.0, 700.0)
    .build()
    .map_err(|e| e.to_string())?;
  detach_menu_unless_document(&window);
  show_after_grace(window);
  Ok(())
}

#[tauri::command(async)]
pub fn show_settings_window(app: AppHandle) -> Result<(), String> {
  show_settings(&app)
}

/// Open (or focus) the singleton about window: system chrome, small fixed size,
/// not resizable.
pub fn show_about(app: &AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("about") {
    reveal(&win);
    return Ok(());
  }
  let locale = crate::i18n::current_locale(&crate::settings::app_settings(app).language);
  let url = WebviewUrl::App("index.html?mode=about".into());
  let window = WebviewWindowBuilder::new(app, "about", url)
    .title(crate::i18n::tr(locale, crate::i18n::Key::About))
    .visible(false)
    .background_color(chrome_background(app))
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .inner_size(360.0, 260.0)
    .build()
    .map_err(|e| e.to_string())?;
  detach_menu_unless_document(&window);
  show_after_grace(window);
  Ok(())
}

/// Open (or focus) the singleton window listing what the core could not load.
/// Its own window rather than a panel inside another one: the report is a list
/// of file names beside their actions, and the windows that exist at launch are
/// a 280x230 sticky and whatever size the user last left the workspace, neither
/// of which can show that without cutting the names.
pub fn show_load_problems(app: &AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("load-problems") {
    reveal(&win);
    return Ok(());
  }
  let url = WebviewUrl::App("index.html?mode=loadProblems".into());
  // No title: a system alert carries its heading in its body, not in the bar.
  let window = WebviewWindowBuilder::new(app, "load-problems", url)
    .title("")
    .visible(false)
    .background_color(chrome_background(app))
    .minimizable(false)
    .maximizable(false)
    .inner_size(520.0, 420.0)
    .min_inner_size(360.0, 240.0)
    .build()
    .map_err(|e| e.to_string())?;
  detach_menu_unless_document(&window);
  show_after_grace(window);
  Ok(())
}

#[tauri::command(async)]
pub fn show_load_problems_window(app: AppHandle) -> Result<(), String> {
  show_load_problems(&app)
}

#[tauri::command(async)]
pub fn show_about_window(app: AppHandle) -> Result<(), String> {
  show_about(&app)
}

/// Open (or focus) the singleton Keyboard Shortcuts window: system chrome,
/// resizable so a long shortcut list can be scrolled or the window grown.
pub fn show_shortcuts(app: &AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("shortcuts") {
    reveal(&win);
    return Ok(());
  }
  let locale = crate::i18n::current_locale(&crate::settings::app_settings(app).language);
  let url = WebviewUrl::App("index.html?mode=shortcuts".into());
  let window = WebviewWindowBuilder::new(app, "shortcuts", url)
    .title(crate::i18n::tr(locale, crate::i18n::Key::KeyboardShortcuts))
    .visible(false)
    .background_color(chrome_background(app))
    .inner_size(420.0, 560.0)
    .build()
    .map_err(|e| e.to_string())?;
  detach_menu_unless_document(&window);
  show_after_grace(window);
  Ok(())
}

#[tauri::command(async)]
pub fn show_shortcuts_window(app: AppHandle) -> Result<(), String> {
  show_shortcuts(&app)
}

/// Open (or focus) the singleton Acknowledgements window: system chrome,
/// resizable and wider than the shortcuts window since licence text runs long.
pub fn show_acknowledgements(app: &AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("acknowledgements") {
    reveal(&win);
    return Ok(());
  }
  let locale = crate::i18n::current_locale(&crate::settings::app_settings(app).language);
  let url = WebviewUrl::App("index.html?mode=acknowledgements".into());
  let window = WebviewWindowBuilder::new(app, "acknowledgements", url)
    .title(crate::i18n::tr(locale, crate::i18n::Key::Acknowledgements))
    .visible(false)
    .background_color(chrome_background(app))
    .inner_size(680.0, 600.0)
    .build()
    .map_err(|e| e.to_string())?;
  detach_menu_unless_document(&window);
  show_after_grace(window);
  Ok(())
}

#[tauri::command(async)]
pub fn show_acknowledgements_window(app: AppHandle) -> Result<(), String> {
  show_acknowledgements(&app)
}

/// Open (or focus) the singleton Privacy Policy window: system chrome,
/// resizable and the same size as the Acknowledgements window since the
/// bundled policy text runs long too.
pub fn show_privacy(app: &AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("privacy") {
    reveal(&win);
    return Ok(());
  }
  let locale = crate::i18n::current_locale(&crate::settings::app_settings(app).language);
  let url = WebviewUrl::App("index.html?mode=privacy".into());
  let window = WebviewWindowBuilder::new(app, "privacy", url)
    .title(crate::i18n::tr(locale, crate::i18n::Key::PrivacyPolicy))
    .visible(false)
    .background_color(chrome_background(app))
    .inner_size(680.0, 600.0)
    .build()
    .map_err(|e| e.to_string())?;
  detach_menu_unless_document(&window);
  show_after_grace(window);
  Ok(())
}

#[tauri::command(async)]
pub fn show_privacy_window(app: AppHandle) -> Result<(), String> {
  show_privacy(&app)
}

/// The fixed-title singleton windows and the i18n key each one's title comes
/// from. Doc windows (title is the file name) and stickies (no title bar) are
/// intentionally not part of this table. Extracted from `retitle_fixed_windows`
/// so the label-to-key mapping is unit-testable without an `AppHandle`.
fn fixed_window_titles() -> [(&'static str, crate::i18n::Key); 6] {
  [
    ("workspace", crate::i18n::Key::Workspace),
    ("settings", crate::i18n::Key::SettingsTitle),
    ("about", crate::i18n::Key::About),
    ("shortcuts", crate::i18n::Key::KeyboardShortcuts),
    ("acknowledgements", crate::i18n::Key::Acknowledgements),
    ("privacy", crate::i18n::Key::PrivacyPolicy),
  ]
}

/// Retitle the fixed-title singleton windows after a language change. Missing
/// windows are simply skipped.
pub fn retitle_fixed_windows(app: &AppHandle, locale: crate::i18n::Locale) {
  for (label, key) in fixed_window_titles() {
    if let Some(win) = app.get_webview_window(label) {
      let _ = win.set_title(crate::i18n::tr(locale, key));
    }
  }
}

/// Whether `label` names an open sticky window (`note-{uuid}`), as opposed to a
/// fixed singleton or a document window. Extracted so the retitle sweep's
/// selection logic is unit-testable without an `AppHandle`, the same way
/// `fixed_window_titles()` is — mirrors the prefix check `cascade_position`
/// already uses to count open stickies.
fn is_sticky_window_label(label: &str) -> bool {
  label.starts_with("note-")
}

/// Retitle every open sticky window after a language change. Unlike the fixed
/// singleton windows above, a sticky's label is dynamic (`note-{uuid}`), so it
/// can't sit in `fixed_window_titles`'s static table — sweep the live window
/// list instead and match by prefix. Document windows are deliberately not
/// swept here: their title follows the active tab's file name and is owned by
/// the frontend, not this Rust-side title.
pub fn retitle_sticky_windows(app: &AppHandle, locale: crate::i18n::Locale) {
  let title = crate::i18n::tr(locale, crate::i18n::Key::StickyWindowTitle);
  for (label, window) in app.webview_windows() {
    if is_sticky_window_label(&label) {
      let _ = window.set_title(title);
    }
  }
}

/// Focus a sticky's window from the workspace list, recreating it from the store
/// when it is not currently open.
#[tauri::command(async)]
pub fn focus_note_window(
  app: AppHandle,
  store: State<NoteStore>,
  id: String,
) -> Result<(), String> {
  if let Some(win) = app.get_webview_window(&format!("note-{id}")) {
    reveal(&win);
    return Ok(());
  }
  if let Some(note) = store.get(&id) {
    create_sticky_window(&app, &note)?;
  }
  Ok(())
}

/// Validate a workspace sticky-row action. Only "save" and "close" cross into a
/// sticky window; any other payload is rejected before the emit.
fn validate_sticky_action(action: &str) -> Result<&str, String> {
  match action {
    "save" | "close" => Ok(action),
    _ => Err(format!("unknown sticky action: {action}")),
  }
}

/// Trigger a sticky's own save/close flow from the workspace list without
/// reimplementing either. Ensures the sticky window exists (recreating it from
/// the store when closed) and reveals it so any save dialog or confirm modal is
/// visible, then emits the action for StickyApp to run.
#[tauri::command(async)]
pub fn sticky_row_action(
  app: AppHandle,
  store: State<NoteStore>,
  id: String,
  action: String,
) -> Result<(), String> {
  let action = validate_sticky_action(&action)?;
  let label = format!("note-{id}");
  let win = match app.get_webview_window(&label) {
    Some(win) => win,
    None => {
      let note = store
        .get(&id)
        .ok_or_else(|| format!("no such note: {id}"))?;
      create_sticky_window(&app, &note)?;
      app
        .get_webview_window(&label)
        .ok_or_else(|| "sticky window creation failed".to_string())?
    }
  };
  reveal(&win);
  app
    .emit_to(label, "workspace-sticky-action", action)
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// One open tab as reported by a document window. `tab_index` and `name` drive
/// the Dock menu; the rest (whether the tab has a saved path, its line ending,
/// encoding label, and syntax language) drive the Format/File menu checks and
/// enablement for the active tab. The extra fields default so any partial report
/// still deserializes.
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTabInfo {
  pub tab_index: i64,
  // Read only by the macOS Dock menu and the Windows Jump List, both of which
  // are platform-gated; it still has to be deserialized everywhere so the
  // report's shape stays one thing across platforms.
  #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
  pub name: String,
  #[serde(default)]
  pub has_path: bool,
  #[serde(default)]
  pub line_ending: String,
  #[serde(default)]
  pub encoding: String,
  #[serde(default)]
  pub language: Option<String>,
}

/// The open tabs of a document window, plus which one is active.
#[derive(Default)]
pub struct DocWindowTabs {
  pub active: Option<i64>,
  pub tabs: Vec<DocTabInfo>,
}

impl DocWindowTabs {
  /// The active tab's info, if the reported active index matches a known tab.
  pub fn active_tab(&self) -> Option<&DocTabInfo> {
    let active = self.active?;
    self.tabs.iter().find(|t| t.tab_index == active)
  }
}

/// Open document tabs keyed by window group, reported live by each window. The
/// Dock menu lists these rather than the store so untitled tabs (never persisted)
/// still appear. A stale entry for a closed window is harmless: the Dock lists
/// only groups whose `doc-{group}` window is currently open.
#[derive(Default)]
pub struct OpenDocTabs(pub std::sync::Mutex<std::collections::HashMap<String, DocWindowTabs>>);

/// A document window reports its open tabs and active tab so the Dock menu can
/// list and mark them, and the app menu's Format/File items can track the active
/// tab. Re-applies the menu when the reporting window is the focused one, so a
/// line-ending / encoding / syntax / save change updates the checks immediately.
#[tauri::command]
pub fn report_doc_tabs(app: AppHandle, group: String, active: Option<i64>, tabs: Vec<DocTabInfo>) {
  app
    .state::<OpenDocTabs>()
    .0
    .lock()
    .unwrap()
    .insert(group.clone(), DocWindowTabs { active, tabs });
  crate::reapply_focus_menu_for_group(&app, &group);
  // The Windows Jump List lists open document tabs from this same live
  // report, same as the Dock menu; keep it current with every push.
  #[cfg(target_os = "windows")]
  crate::jumplist::rebuild(&app);
}

/// Focus a document window and ask it to switch to the tab at `tab_index`.
#[tauri::command]
pub fn focus_doc_tab(app: AppHandle, group: String, tab_index: i64) -> Result<(), String> {
  let label = format!("doc-{group}");
  if let Some(win) = app.get_webview_window(&label) {
    reveal(&win);
    let _ = app.emit_to(label, "workspace-switch-tab", tab_index);
  }
  Ok(())
}

/// From `groups`, return those whose document window (`doc-{group}`) is currently
/// open. The frontend open router uses this to tell a live window (focus it)
/// apart from an orphaned snapshot whose window is gone (adopt it).
#[tauri::command]
pub fn live_doc_groups(app: AppHandle, groups: Vec<String>) -> Vec<String> {
  let labels: Vec<String> = app.webview_windows().into_keys().collect();
  filter_live_groups(&labels, &groups)
}

/// Pure core of `live_doc_groups`: keep each group whose `doc-{group}` label is
/// present among the open window labels, preserving the input order.
fn filter_live_groups(labels: &[String], groups: &[String]) -> Vec<String> {
  groups
    .iter()
    .filter(|g| labels.iter().any(|l| *l == format!("doc-{g}")))
    .cloned()
    .collect()
}

/// Ask a document window to close the tab at `tab_index` from the workspace. The
/// window runs its own `requestCloseTab` flow, so a dirty tab still prompts.
#[tauri::command]
pub fn close_doc_tab(app: AppHandle, group: String, tab_index: i64) -> Result<(), String> {
  let label = format!("doc-{group}");
  if let Some(win) = app.get_webview_window(&label) {
    reveal(&win);
    let _ = app.emit_to(label, "workspace-close-tab", tab_index);
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::{
    filter_live_groups, fixed_window_titles, is_sticky_window_label, validate_sticky_action,
    DocTabInfo, DocWindowTabs,
  };

  #[test]
  fn menu_item_tops_count_the_rows_they_sit_on() {
    // Seven items, one row.
    assert_eq!(super::distinct_rows(&[2, 2, 2, 2, 2, 2, 2]), 1);
    // The Spanish bar at the default width: five items, then two wrapped.
    assert_eq!(super::distinct_rows(&[2, 2, 2, 2, 2, 21, 21]), 2);
    // No menu bar at all still counts as fitting.
    assert_eq!(super::distinct_rows(&[]), 1);
  }

  #[test]
  fn a_short_client_area_is_asked_for_again_with_the_shortfall_added() {
    // The document window: asked for 639, the menu bar ate 20 of it.
    assert_eq!(super::next_size_request(639.0, 619.0, 639.0), Some(659.0));
    // The workspace wants 560 and its menu wraps to two rows, so it converges
    // in three: the whole 39px shortfall, then the single row the re-request
    // won back, then on target.
    assert_eq!(super::next_size_request(560.0, 521.0, 560.0), Some(599.0));
    assert_eq!(super::next_size_request(599.0, 579.5, 560.0), Some(579.5));
    assert_eq!(super::next_size_request(579.5, 560.0, 560.0), None);
  }

  #[test]
  fn a_client_area_already_on_target_is_left_alone() {
    assert_eq!(super::next_size_request(560.0, 560.0, 560.0), None);
    assert_eq!(super::next_size_request(560.0, 560.4, 560.0), None);
  }

  #[test]
  fn acknowledgements_label_maps_to_its_own_title_key() {
    let entry = fixed_window_titles()
      .into_iter()
      .find(|(label, _)| *label == "acknowledgements");
    assert_eq!(
      entry.map(|(_, key)| key),
      Some(crate::i18n::Key::Acknowledgements)
    );
  }

  #[test]
  fn every_fixed_window_label_is_distinct() {
    let labels: Vec<&str> = fixed_window_titles().iter().map(|(l, _)| *l).collect();
    let mut sorted = labels.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(labels.len(), sorted.len());
  }

  #[test]
  fn is_sticky_window_label_matches_only_the_note_prefix() {
    assert!(is_sticky_window_label("note-abc-123"));
    assert!(!is_sticky_window_label("doc-abc-123"));
    assert!(!is_sticky_window_label("workspace"));
    assert!(!is_sticky_window_label("settings"));
  }

  #[test]
  fn doc_tab_info_deserializes_full_report() {
    let json = r#"{"tabIndex":3,"name":"a.rs","hasPath":true,"lineEnding":"CRLF","encoding":"Big5","language":"Rust"}"#;
    let info: DocTabInfo = serde_json::from_str(json).unwrap();
    assert_eq!(info.tab_index, 3);
    assert_eq!(info.name, "a.rs");
    assert!(info.has_path);
    assert_eq!(info.line_ending, "CRLF");
    assert_eq!(info.encoding, "Big5");
    assert_eq!(info.language.as_deref(), Some("Rust"));
  }

  #[test]
  fn doc_tab_info_defaults_missing_menu_fields() {
    // An older/partial report (only the Dock fields) still deserializes, with the
    // menu fields defaulting: no path, empty line ending/encoding, no language.
    let info: DocTabInfo = serde_json::from_str(r#"{"tabIndex":0,"name":"x"}"#).unwrap();
    assert!(!info.has_path);
    assert_eq!(info.line_ending, "");
    assert_eq!(info.encoding, "");
    assert_eq!(info.language, None);
  }

  #[test]
  fn active_tab_matches_by_index_or_none() {
    let tabs = DocWindowTabs {
      active: Some(2),
      tabs: vec![
        DocTabInfo {
          tab_index: 1,
          name: "one".into(),
          has_path: false,
          line_ending: "LF".into(),
          encoding: "UTF-8".into(),
          language: None,
        },
        DocTabInfo {
          tab_index: 2,
          name: "two".into(),
          has_path: true,
          line_ending: "CRLF".into(),
          encoding: "Big5".into(),
          language: Some("Rust".into()),
        },
      ],
    };
    assert_eq!(tabs.active_tab().unwrap().name, "two");
    // No active index, or an index with no matching tab, yields None.
    let none = DocWindowTabs {
      active: None,
      tabs: tabs.tabs.clone(),
    };
    assert!(none.active_tab().is_none());
    let stale = DocWindowTabs {
      active: Some(99),
      tabs: tabs.tabs,
    };
    assert!(stale.active_tab().is_none());
  }

  #[test]
  fn accepts_known_actions() {
    assert_eq!(validate_sticky_action("save"), Ok("save"));
    assert_eq!(validate_sticky_action("close"), Ok("close"));
  }

  #[test]
  fn rejects_unknown_actions() {
    assert!(validate_sticky_action("delete").is_err());
    assert!(validate_sticky_action("").is_err());
  }

  #[test]
  fn live_groups_keeps_only_open_windows_in_order() {
    let labels = vec![
      "doc-g1".to_string(),
      "workspace".to_string(),
      "doc-g3".to_string(),
      "note-x".to_string(),
    ];
    let groups = vec!["g1".to_string(), "g2".to_string(), "g3".to_string()];
    // g2 has no doc window; g1 and g3 do, and input order is preserved.
    assert_eq!(filter_live_groups(&labels, &groups), vec!["g1", "g3"]);
  }

  #[test]
  fn live_groups_empty_when_no_doc_windows_match() {
    let labels = vec!["workspace".to_string(), "settings".to_string()];
    let groups = vec!["g1".to_string()];
    assert!(filter_live_groups(&labels, &groups).is_empty());
  }
}

#[cfg(test)]
mod window_command_threading_tests {
  // Reads the source because the failure is a deadlock, with nothing to assert
  // at runtime. Catches a dropped `(async)`, not a new command missing from the
  // list below — add one here when you add one there.
  const SOURCE: &str = include_str!("windows.rs");
  const MUST_RUN_OFF_THE_MAIN_THREAD: &[&str] = &[
    "new_sticky_note",
    "open_document_window",
    "open_document_group",
    "show_workspace_window",
    "show_settings_window",
    "show_about_window",
    "show_shortcuts_window",
    "show_acknowledgements_window",
    "show_privacy_window",
    "focus_note_window",
    "sticky_row_action",
  ];

  #[test]
  fn building_a_sticky_never_propagates_an_opacity_failure() {
    // Guards the call site in `create_sticky_window` only; `set_window_opacity`
    // should propagate, the user asked for that change.
    let at = SOURCE
      .find("fn create_sticky_window")
      .expect("create_sticky_window no longer exists in windows.rs");
    let body = &SOURCE[at..];
    let call = body
      .find("apply_opacity(")
      .expect("create_sticky_window no longer applies opacity");
    let line_end = body[call..]
      .find('\n')
      .map(|i| call + i)
      .unwrap_or(body.len());
    let line = &body[call..line_end];
    assert!(
      !line.contains(")?"),
      "create_sticky_window must not propagate an opacity failure: the window \
       is already built and hidden, so returning strands it with its label \
       taken. Found: {line}"
    );
  }

  #[test]
  fn every_window_creating_command_is_async() {
    for name in MUST_RUN_OFF_THE_MAIN_THREAD {
      let needle = format!("pub fn {name}");
      let at = SOURCE
        .find(&needle)
        .unwrap_or_else(|| panic!("{name} is listed here but no longer exists in windows.rs"));
      let attribute = SOURCE[..at].trim_end();
      assert!(
        attribute.ends_with("#[tauri::command(async)]"),
        "{name} must be #[tauri::command(async)]: a blocking command that builds \
         a window deadlocks the Windows UI thread"
      );
    }
  }

  #[test]
  fn the_guard_would_notice_a_dropped_async() {
    // Proves the assertion above can fail, against a command not in the list.
    let at = SOURCE
      .find("pub fn set_window_opacity")
      .expect("set_window_opacity");
    let attribute = SOURCE[..at].trim_end();
    assert!(attribute.ends_with("#[tauri::command]"));
    assert!(!attribute.ends_with("#[tauri::command(async)]"));
  }
}
