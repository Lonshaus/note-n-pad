// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The platform side of a tab that follows the pointer: the cursor and the button,
// where a window sits and where it is put, the window that is built for a torn-off
// tab and the one decision of how it is shown. Every rule is in `tab_tearoff`;
// this file only reads and writes the window system.

#[cfg(target_os = "macos")]
use crate::tab_tearoff::mac_restored_outer;
#[cfg(windows)]
use crate::tab_tearoff::windows_tearoff_inner;
#[cfg(any(target_os = "macos", windows))]
use crate::tab_tearoff::{
  held_point, maximized_grab, move_outer_top_left, tearoff_outer_top_left, StepKind, STEP_INTERVAL,
};
use crate::tab_tearoff::{reveal_call, RevealCall, TearSpec};
use crate::tab_transfer::TransferState;
#[cfg(any(target_os = "macos", windows))]
use crate::window_at;
use crate::window_at::Point;
#[cfg(any(target_os = "macos", windows))]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(any(target_os = "macos", windows))]
use std::sync::Arc;
use tauri::{AppHandle, Manager};
/// Reading and writing the window system. Everything here runs on the main
/// thread.
#[cfg(target_os = "macos")]
mod os {
  use crate::window_at::{self, Point};
  use objc2::MainThreadMarker;
  use objc2_app_kit::{NSEvent, NSWindow};
  use objc2_foundation::{NSPoint, NSRect, NSSize};
  /// Run `f` on the window's `NSWindow`.
  pub fn with_ns<R>(window: &tauri::WebviewWindow, f: impl FnOnce(&NSWindow) -> R) -> Option<R> {
    let ptr = window.ns_window().ok()?;
    // Safety: the pointer is the window's own NSWindow, which outlives this call
    // on the main thread that makes it.
    Some(f(unsafe { &*(ptr as *const NSWindow) }))
  }
  /// The pointer and the left button.
  pub fn sample(mtm: MainThreadMarker) -> (Point, bool) {
    let at = NSEvent::mouseLocation();
    let cursor =
      window_at::screen_of_appkit(Point { x: at.x, y: at.y }, window_at::primary_height(mtm));
    (cursor, NSEvent::pressedMouseButtons() & 1 != 0)
  }
  /// The window's page top left minus its outer top left, in points.
  pub fn inner_minus_outer(ns: &NSWindow) -> Point {
    window_at::page_inset(ns)
  }
  /// Put the window's outer top left at `at` (screen frame), synchronously.
  pub fn set_top_left(ns: &NSWindow, mtm: MainThreadMarker, at: Point) {
    let flipped = window_at::appkit_point(at, window_at::primary_height(mtm));
    ns.setFrameTopLeftPoint(NSPoint::new(flipped.x, flipped.y));
  }
  /// Put the window's frame at `at` with `size`, synchronously.
  pub fn set_frame(ns: &NSWindow, mtm: MainThreadMarker, at: Point, size: (f64, f64)) {
    let bottom_left = window_at::appkit_point(
      Point {
        x: at.x,
        y: at.y + size.1,
      },
      window_at::primary_height(mtm),
    );
    let rect = NSRect::new(
      NSPoint::new(bottom_left.x, bottom_left.y),
      NSSize::new(size.0, size.1),
    );
    ns.setFrame_display(rect, true);
  }
  /// The height of the title bar: the frame less the content.
  pub fn title_bar(ns: &NSWindow) -> f64 {
    let frame = ns.frame();
    frame.size.height - ns.contentRectForFrameRect(frame).size.height
  }
  /// How many windows share the native tab group of this one.
  pub fn group_size(ns: &NSWindow) -> usize {
    ns.tabbedWindows().map_or(1, |windows| windows.count())
  }
}
/// Windows: the same reads and writes in physical pixels.
#[cfg(windows)]
mod os {
  use crate::window_at::Point;
  use windows_sys::Win32::Foundation::{POINT, RECT};
  use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, GetWindowPlacement, GetWindowRect, SM_SWAPBUTTON,
    WINDOWPLACEMENT,
  };
  /// The pointer and the primary button, which is the right one when the buttons
  /// are swapped.
  pub fn sample() -> Option<(Point, bool)> {
    let mut at = POINT { x: 0, y: 0 };
    // Safety: the out-parameter is a live local of the size asked for.
    if unsafe { GetCursorPos(&mut at) } == 0 {
      return None;
    }
    let key = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
      VK_RBUTTON
    } else {
      VK_LBUTTON
    };
    let down = unsafe { GetAsyncKeyState(i32::from(key)) } as u16 & 0x8000 != 0;
    Some((
      Point {
        x: f64::from(at.x),
        y: f64::from(at.y),
      },
      down,
    ))
  }
  /// The window's client origin minus its window rectangle's top left.
  pub fn inner_minus_outer(window: &tauri::WebviewWindow) -> Option<Point> {
    let hwnd = window.hwnd().ok()?.0;
    let mut client = POINT { x: 0, y: 0 };
    let mut outer = RECT {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    };
    // Safety: both out-parameters are live locals of the sizes asked for.
    let measured = unsafe {
      ClientToScreen(hwnd as _, &mut client) != 0 && GetWindowRect(hwnd as _, &mut outer) != 0
    };
    measured.then(|| Point {
      x: f64::from(client.x - outer.left),
      y: f64::from(client.y - outer.top),
    })
  }
  /// The width and height of the rectangle the window restores to.
  pub fn restored_outer(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let hwnd = window.hwnd().ok()?.0;
    // Safety: zeroed is a valid `WINDOWPLACEMENT` once its length is set.
    let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
    placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
    if unsafe { GetWindowPlacement(hwnd as _, &mut placement) } == 0 {
      return None;
    }
    let rect = placement.rcNormalPosition;
    Some((
      f64::from(rect.right - rect.left),
      f64::from(rect.bottom - rect.top),
    ))
  }
}
/// Whether the sender is one window of a native tab group, which moving would
/// pull it out of mid-drag. AppKit is asked on the main thread.
#[cfg(target_os = "macos")]
fn in_tab_group(window: &tauri::WebviewWindow) -> bool {
  let ask = |target: &tauri::WebviewWindow| {
    os::with_ns(target, |ns| os::group_size(ns) > 1).unwrap_or(true)
  };
  if objc2::MainThreadMarker::new().is_some() {
    return ask(window);
  }
  let (tx, rx) = std::sync::mpsc::channel();
  let target = window.clone();
  if window
    .run_on_main_thread(move || {
      let _ = tx.send(ask(&target));
    })
    .is_err()
  {
    return true;
  }
  rx.recv().unwrap_or(true)
}
/// Whether the sender may tear a tab off or move live: not full screen, and on
/// macOS not one window of a native tab group (moving it would pull it out of
/// the group mid-drag).
pub fn sender_may_tear(window: &tauri::WebviewWindow) -> bool {
  #[cfg(target_os = "macos")]
  {
    !window.is_fullscreen().unwrap_or(false) && !in_tab_group(window)
  }
  #[cfg(windows)]
  {
    !window.is_fullscreen().unwrap_or(false)
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  {
    let _ = window;
    false
  }
}
/// The window's outer top left in native units.
#[cfg(any(target_os = "macos", windows))]
fn outer_position(window: &tauri::WebviewWindow) -> Result<Point, String> {
  let position = window.outer_position().map_err(|e| e.to_string())?;
  #[cfg(target_os = "macos")]
  let scale = window.scale_factor().map_err(|e| e.to_string())?;
  #[cfg(windows)]
  let scale = 1.0;
  Ok(Point {
    x: f64::from(position.x) / scale,
    y: f64::from(position.y) / scale,
  })
}
/// Build the window that receives a torn-off tab, at the sender's size, and put
/// it under the pointer. The window is on screen but never activated: it is built
/// without focus, and nothing here asks for it.
#[cfg(any(target_os = "macos", windows))]
pub fn open_tearoff(
  app: &AppHandle,
  sender: &tauri::WebviewWindow,
  group: &str,
  project: Option<&str>,
  spec: &TearSpec,
) -> Result<(), String> {
  let size = tearoff_size(app, sender)?;
  let settings = crate::settings::app_settings(app);
  let dark = crate::platform::interface_is_dark(
    &settings.interface_mode,
    crate::platform::system_prefers_dark(),
  );
  // Windows builds the window visible and a step later puts it where the
  // pointer is: the position here is the first guess, in logical pixels.
  #[cfg(windows)]
  let position = {
    let scale = sender.scale_factor().map_err(|e| e.to_string())?;
    let (cursor, _) = os::sample().ok_or("the pointer cannot be read")?;
    let offset = os::inner_minus_outer(sender).ok_or("the window cannot be measured")?;
    let outer =
      tearoff_outer_top_left(cursor, spec.first_tab_client_x, spec.grab, spec.dpr, offset);
    Some((outer.x / scale, outer.y / scale))
  };
  #[cfg(target_os = "macos")]
  let position = None;
  let build = crate::windows::TearBuild {
    dark,
    theme: settings.theme,
    position,
  };
  crate::windows::open_tearoff_document(app, group, project, size, &build)?;
  #[cfg(target_os = "macos")]
  place_new_mac(app, &format!("doc-{group}"), spec)?;
  Ok(())
}
#[cfg(not(any(target_os = "macos", windows)))]
pub fn open_tearoff(
  _app: &AppHandle,
  _sender: &tauri::WebviewWindow,
  _group: &str,
  _project: Option<&str>,
  _spec: &TearSpec,
) -> Result<(), String> {
  Err("a tab cannot be torn off here".to_string())
}
/// The inner size of the tear-off, logical: the sender's inner size, or when it
/// is maximized the size it restores to.
#[cfg(any(target_os = "macos", windows))]
fn tearoff_size(app: &AppHandle, sender: &tauri::WebviewWindow) -> Result<(f64, f64), String> {
  let scale = sender.scale_factor().map_err(|e| e.to_string())?;
  let inner = sender.inner_size().map_err(|e| e.to_string())?;
  if !sender.is_maximized().unwrap_or(false) {
    let logical = inner.to_logical::<f64>(scale);
    return Ok((logical.width, logical.height));
  }
  #[cfg(target_os = "macos")]
  {
    // AppKit's saved frame cannot be read: the remembered content size is what
    // the window restores to.
    Ok(crate::windows::remembered_content_size(app))
  }
  #[cfg(windows)]
  {
    let _ = app;
    let outer = sender.outer_size().map_err(|e| e.to_string())?;
    let restored = os::restored_outer(sender).ok_or("the restored size cannot be read")?;
    Ok(windows_tearoff_inner(
      restored,
      (f64::from(outer.width), f64::from(outer.height)),
      (f64::from(inner.width), f64::from(inner.height)),
      scale,
    ))
  }
}
/// macOS: no native tab, the frame at the pointer, and the window ordered in
/// front without being made key, in one main-thread block.
#[cfg(target_os = "macos")]
fn place_new_mac(app: &AppHandle, label: &str, spec: &TearSpec) -> Result<(), String> {
  let window = app
    .get_webview_window(label)
    .ok_or("the tear-off window is gone")?;
  let (spec, target) = (spec.clone(), window.clone());
  window
    .run_on_main_thread(move || {
      let Some(mtm) = objc2::MainThreadMarker::new() else {
        return;
      };
      os::with_ns(&target, |ns| {
        use objc2_app_kit::NSWindowTabbingMode;
        ns.setTabbingMode(NSWindowTabbingMode::Disallowed);
        let (cursor, _) = os::sample(mtm);
        let at = tearoff_outer_top_left(
          cursor,
          spec.first_tab_client_x,
          spec.grab,
          1.0,
          os::inner_minus_outer(ns),
        );
        os::set_top_left(ns, mtm, at);
        ns.orderFront(None);
      });
    })
    .map_err(|e| e.to_string())
}
/// Start the timer of the follow that was just begun.
pub fn start_timer(app: &AppHandle, state: &TransferState) {
  #[cfg(any(target_os = "macos", windows))]
  {
    let (generation, live) = {
      let book = state.book.lock().unwrap();
      (book.tear.generation(), book.tear.live_flag())
    };
    if let Some(generation) = generation {
      spawn_timer(app.clone(), generation, live, state.gate.clone());
    }
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  let _ = (app, state);
}
/// A thread that wakes every `STEP_INTERVAL` and, when no step is outstanding,
/// has the main thread run one. It touches nothing else.
#[cfg(any(target_os = "macos", windows))]
fn spawn_timer(
  app: AppHandle,
  generation: u64,
  live: Arc<AtomicU64>,
  gate: Arc<crate::tab_tearoff::StepGate>,
) {
  std::thread::spawn(move || loop {
    std::thread::sleep(STEP_INTERVAL);
    if live.load(Ordering::SeqCst) != generation {
      return;
    }
    if gate.try_begin() {
      let (handle, done) = (app.clone(), gate.clone());
      let queued = app.run_on_main_thread(move || {
        follow_step(&handle, generation);
        done.finish();
      });
      if queued.is_err() {
        gate.finish();
        return;
      }
    }
  });
}
/// One step of the follow loop, on the main thread: the pointer, the following
/// window to where it puts it, what lies under the pointer and what the book
/// makes of that.
#[cfg(any(target_os = "macos", windows))]
fn follow_step(app: &AppHandle, generation: u64) {
  let Some(state) = app.try_state::<TransferState>() else {
    return;
  };
  let plan = state
    .book
    .lock()
    .unwrap()
    .tear
    .plan_step(generation, cfg!(windows));
  let Some(plan) = plan else {
    return;
  };
  let Some(window) = app.get_webview_window(&plan.following) else {
    return;
  };
  #[cfg(target_os = "macos")]
  let (cursor, down, offset) = {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
      return;
    };
    let (cursor, down) = os::sample(mtm);
    let Some(offset) = os::with_ns(&window, os::inner_minus_outer) else {
      return;
    };
    (cursor, down, offset)
  };
  #[cfg(windows)]
  let (cursor, down, offset) = {
    let Some((cursor, down)) = os::sample() else {
      return;
    };
    let Some(offset) = os::inner_minus_outer(&window) else {
      return;
    };
    (cursor, down, offset)
  };
  let outer = match plan.kind {
    StepKind::TearOff {
      first_tab_client_x,
      grab,
      scale,
    } => tearoff_outer_top_left(cursor, first_tab_client_x, grab, scale, offset),
    StepKind::Move { grab } => move_outer_top_left(cursor, grab),
  };
  write_outer(&window, outer);
  let hit = window_at::locate_skipping(app, &window, cursor);
  let actions = state
    .book
    .lock()
    .unwrap()
    .finish_step(generation, down, &hit, cfg!(windows));
  crate::tab_transfer::run(app, actions);
}
/// Put the window's outer top left at `at`: a synchronous frame on macOS, so the
/// hit test that follows sees it, and a physical position on Windows.
#[cfg(any(target_os = "macos", windows))]
fn write_outer(window: &tauri::WebviewWindow, at: Point) {
  #[cfg(target_os = "macos")]
  if let Some(mtm) = objc2::MainThreadMarker::new() {
    os::with_ns(window, |ns| os::set_top_left(ns, mtm, at));
  }
  #[cfg(windows)]
  let _ = window.set_position(tauri::PhysicalPosition::new(
    at.x.round() as i32,
    at.y.round() as i32,
  ));
}
/// The calling window, whose only tab is `note`, starts to move with the
/// pointer. Whether it did. A maximized window leaves that state with exactly the
/// size it restores to, and is put under the pointer, before this returns.
pub fn start_move_window(
  window: &tauri::WebviewWindow,
  state: &TransferState,
  spec: &TearSpec,
  note: &str,
  tab_grab_x: f64,
) -> Result<bool, String> {
  #[cfg(any(target_os = "macos", windows))]
  {
    if !sender_may_tear(window) || state.book.lock().unwrap().tear.busy() {
      return Ok(false);
    }
    #[cfg(target_os = "macos")]
    let cursor = {
      let mtm = objc2::MainThreadMarker::new().ok_or("not on the main thread")?;
      os::sample(mtm).0
    };
    #[cfg(windows)]
    let cursor = os::sample().ok_or("the pointer cannot be read")?.0;
    let was_maximized = window.is_maximized().unwrap_or(false);
    let start = outer_position(window)?;
    // The window is held where the button went down, not where the pointer has
    // got to by now: it jumps under the pointer as the follow begins.
    #[cfg(target_os = "macos")]
    let inset =
      os::with_ns(window, os::inner_minus_outer).ok_or("the window cannot be measured")?;
    #[cfg(windows)]
    let inset = os::inner_minus_outer(window).ok_or("the window cannot be measured")?;
    let scale = if cfg!(windows) { spec.dpr } else { 1.0 };
    let held = held_point(start, inset, spec.grab, scale);
    let grab = if was_maximized {
      leave_maximized(window, cursor, held, start)?
    } else {
      Point {
        x: held.x - start.x,
        y: held.y - start.y,
      }
    };
    let generation = state.book.lock().unwrap().tear.start_move(
      spec,
      window.label(),
      note,
      grab,
      was_maximized,
      start,
      tab_grab_x,
    );
    if generation.is_some() {
      start_timer(window.app_handle(), state);
    }
    Ok(generation.is_some())
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  {
    let _ = (window, state, spec, note, tab_grab_x);
    Ok(false)
  }
}
/// Take a maximized window out of that state at the pointer: the grab keeps the
/// fraction of the width at `held`, where the button went down, the window is the
/// size it restores to, and it sits under the pointer at once. The grab, in
/// native units.
#[cfg(target_os = "macos")]
fn leave_maximized(
  window: &tauri::WebviewWindow,
  cursor: Point,
  held: Point,
  start: Point,
) -> Result<Point, String> {
  let mtm = objc2::MainThreadMarker::new().ok_or("not on the main thread")?;
  let (width, _) = window_at::outer_size(window);
  let restored = restored_outer_mac(window)?;
  let grab = maximized_grab(held, start, width, restored.0);
  // A frame set by hand, not `zoom:`: that goes back to AppKit's own saved frame.
  os::with_ns(window, |ns| {
    os::set_frame(ns, mtm, move_outer_top_left(cursor, grab), restored);
  })
  .ok_or("the window has no frame")?;
  Ok(grab)
}
#[cfg(windows)]
fn leave_maximized(
  window: &tauri::WebviewWindow,
  cursor: Point,
  held: Point,
  start: Point,
) -> Result<Point, String> {
  let size = window.outer_size().map_err(|e| e.to_string())?;
  let restored = os::restored_outer(window).ok_or("the restored size cannot be read")?;
  let grab = maximized_grab(held, start, f64::from(size.width), restored.0);
  // On the main thread this is done when it returns, and the position is set
  // before any message is pumped.
  window.unmaximize().map_err(|e| e.to_string())?;
  write_outer(window, move_outer_top_left(cursor, grab));
  Ok(grab)
}
/// The frame a zoomed macOS window restores to: the remembered content size and
/// the window's title bar.
#[cfg(target_os = "macos")]
fn restored_outer_mac(window: &tauri::WebviewWindow) -> Result<(f64, f64), String> {
  let content = crate::windows::remembered_content_size(window.app_handle());
  let title_bar = os::with_ns(window, os::title_bar).ok_or("the window has no frame")?;
  Ok(mac_restored_outer(content, title_bar))
}
/// A zoomed macOS window released at `point`: its restored frame is put at the
/// placed point in one synchronous step.
#[cfg(target_os = "macos")]
pub fn place_zoomed(window: &tauri::WebviewWindow, point: Point) -> Result<(), String> {
  let mtm = objc2::MainThreadMarker::new().ok_or("not on the main thread")?;
  let restored = restored_outer_mac(window)?;
  let placed = window_at::place(window, point, restored);
  os::with_ns(window, |ns| os::set_frame(ns, mtm, placed, restored))
    .ok_or_else(|| "the window has no frame".to_string())
}
/// Put a window that followed the pointer back where it started.
pub fn move_back(app: &AppHandle, label: &str, point: Point, remaximize: bool) {
  #[cfg(any(target_os = "macos", windows))]
  {
    restore(app, label);
    let Some(window) = app.get_webview_window(label) else {
      return;
    };
    let target = window.clone();
    let _ = app.run_on_main_thread(move || {
      if remaximize {
        let _ = target.maximize();
      } else {
        write_outer(&target, point);
      }
    });
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  let _ = (app, label, point, remaximize);
}
/// Whether the calling thread is the one that owns the window.
#[cfg(target_os = "macos")]
fn on_main_thread(_window: &tauri::WebviewWindow) -> bool {
  objc2::MainThreadMarker::new().is_some()
}
#[cfg(windows)]
fn on_main_thread(window: &tauri::WebviewWindow) -> bool {
  use windows_sys::Win32::System::Threading::GetCurrentThreadId;
  use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
  let Ok(hwnd) = window.hwnd() else {
    return false;
  };
  // Safety: a null process id out-parameter is allowed.
  unsafe { GetWindowThreadProcessId(hwnd.0 as _, std::ptr::null_mut()) == GetCurrentThreadId() }
}
/// Make the window invisible in place: it stays where it is, ordered and focused
/// as it was, so a capture it holds is not lost.
#[cfg(target_os = "macos")]
fn native_hide(window: &tauri::WebviewWindow) {
  os::with_ns(window, |ns| ns.setAlphaValue(0.0));
}
#[cfg(windows)]
fn native_hide(window: &tauri::WebviewWindow) {
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
    WS_EX_LAYERED,
  };
  let Ok(hwnd) = window.hwnd() else {
    return;
  };
  let hwnd = hwnd.0 as _;
  // Safety: the handle is the window's own, on the thread that owns it.
  unsafe {
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED as isize);
    SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA);
  }
}
/// Make a window that `native_hide` made invisible visible again; any other
/// window, a sticky at its own opacity among them, is left as it is.
#[cfg(target_os = "macos")]
fn native_restore(window: &tauri::WebviewWindow) {
  os::with_ns(window, |ns| {
    if ns.alphaValue() != 0.0 {
      return;
    }
    ns.setAlphaValue(1.0);
  });
}
#[cfg(windows)]
fn native_restore(window: &tauri::WebviewWindow) {
  use windows_sys::Win32::Graphics::Gdi::{
    RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE,
  };
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetLayeredWindowAttributes, GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW,
    GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED,
  };
  let Ok(hwnd) = window.hwnd() else {
    return;
  };
  let hwnd = hwnd.0 as _;
  // Safety: the handle is the window's own, on the thread that owns it, and every
  // out-parameter is a live local.
  unsafe {
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    let (mut alpha, mut flags) = (0u8, 0u32);
    if ex & WS_EX_LAYERED as isize == 0
      || GetLayeredWindowAttributes(hwnd, std::ptr::null_mut(), &mut alpha, &mut flags) == 0
      || flags & LWA_ALPHA == 0
      || alpha != 0
    {
      return;
    }
    SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !(WS_EX_LAYERED as isize));
    RedrawWindow(
      hwnd,
      std::ptr::null(),
      std::ptr::null_mut(),
      RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN,
    );
  }
}
/// Make the following window invisible: on the main thread at once when this is
/// it, and otherwise queued to it.
pub fn hide(app: &AppHandle, label: &str) {
  #[cfg(any(target_os = "macos", windows))]
  if let Some(window) = app.get_webview_window(label) {
    if on_main_thread(&window) {
      native_hide(&window);
    } else {
      let target = window.clone();
      let _ = window.run_on_main_thread(move || native_hide(&target));
    }
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  let _ = (app, label);
}
/// The one way a window made invisible becomes visible: the book forgets the mark
/// (a follow that still wants it hidden says so at its next step), and the window,
/// if it is invisible, is shown at full alpha. Never called with the book locked.
pub fn restore(app: &AppHandle, label: &str) {
  if let Some(state) = app.try_state::<TransferState>() {
    state.book.lock().unwrap().tear.clear_hidden(label);
  }
  #[cfg(any(target_os = "macos", windows))]
  if let Some(window) = app.get_webview_window(label) {
    if on_main_thread(&window) {
      native_restore(&window);
    } else {
      let target = window.clone();
      let _ = window.run_on_main_thread(move || native_restore(&target));
    }
  }
}
/// Show a tear-off: only while the app is the active one is it shown and focused.
/// Otherwise it is on screen already and any call on it would bring the app
/// forward; it becomes key the next time the user clicks it.
pub fn reveal_tearoff(app: &AppHandle, label: &str) {
  restore(app, label);
  let active = app
    .webview_windows()
    .values()
    .any(|window| window.is_focused().unwrap_or(false));
  if reveal_call(active) == RevealCall::Nothing {
    return;
  }
  if let Some(window) = app.get_webview_window(label) {
    crate::windows::reveal(&window);
  }
  if let Some(state) = app.try_state::<TransferState>() {
    state.book.lock().unwrap().tear.mark_revealed(label);
  }
}

#[cfg(test)]
mod tests {
  /// The text of the item that starts with `head`, up to its closing brace.
  fn body<'a>(source: &'a str, head: &str) -> &'a str {
    let at = source.find(head).unwrap_or_else(|| panic!("{head}"));
    let rest = &source[at..];
    &rest[..rest.find("\n}\n").unwrap()]
  }
  /// The calls that make a window visible, key or maximized, which change tao's
  /// own flags or bring the app forward.
  const ACTIVATING: [&str; 8] = [
    ".show(",
    ".set_visible(",
    ".set_focus(",
    ".set_maximized(",
    ".unmaximize(",
    ".set_focusable(",
    ".set_always_on_top(",
    "makeKeyAndOrderFront",
  ];

  #[test]
  fn the_macos_tear_off_is_untabbed_placed_and_ordered_front_in_one_main_thread_block() {
    let source = include_str!("tab_follow.rs");
    let place = body(source, "fn place_new_mac(");
    let block = &place[place.find("run_on_main_thread").unwrap()..];
    let disallowed = block.find("NSWindowTabbingMode::Disallowed").unwrap();
    let placed = block.find("os::set_top_left(").unwrap();
    let ordered = block.find("orderFront(None)").unwrap();
    assert!(disallowed < placed && placed < ordered);
    // Built hidden and with no position of the builder.
    let open = body(source, "pub fn open_tearoff(\n  app: &AppHandle,\n  sender: &tauri::WebviewWindow,\n  group: &str,\n  project: Option<&str>,\n  spec: &TearSpec,\n) -> Result<(), String> {\n  let size");
    assert!(open.contains("#[cfg(target_os = \"macos\")]\n  let position = None;"));
    let windows = include_str!("windows.rs");
    let build = body(windows, "fn build_document_window(");
    assert!(build.contains(".visible(false)"));
    assert_eq!(build.matches(".position(").count(), 1);
    assert!(build.contains("if receive && tearoff.is_none() {\n    disallow_tabbing(&window);"));
  }

  #[test]
  fn the_windows_tear_off_is_built_visible_and_unfocused_at_a_position_over_the_senders_scale() {
    let source = include_str!("tab_follow.rs");
    let open = body(source, "pub fn open_tearoff(\n  app: &AppHandle,\n  sender: &tauri::WebviewWindow,\n  group: &str,\n  project: Option<&str>,\n  spec: &TearSpec,\n) -> Result<(), String> {\n  let size");
    assert!(open.contains("sender.scale_factor()"));
    assert!(open.contains("Some((outer.x / scale, outer.y / scale))"));
    let windows = include_str!("windows.rs");
    let build = body(windows, "fn build_document_window(");
    assert!(build.contains("builder = builder.focused(false);"));
    assert!(build.contains("#[cfg(windows)]\n    {\n      builder = builder.visible(true);"));
    for source in [source, windows] {
      assert!(!source
        .split("#[cfg(test)]")
        .next()
        .unwrap()
        .contains("ShowWindow"));
    }
  }

  #[test]
  fn nothing_that_changes_the_flags_or_activates_runs_on_the_tear_off_before_its_reveal() {
    let source = include_str!("tab_follow.rs");
    for head in [
      "pub fn open_tearoff(\n  app: &AppHandle,\n  sender: &tauri::WebviewWindow,\n  group: &str,\n  project: Option<&str>,\n  spec: &TearSpec,\n) -> Result<(), String> {\n  let size",
      "fn tearoff_size(",
      "fn place_new_mac(",
      "fn follow_step(",
      "fn write_outer(",
      "fn spawn_timer(",
    ] {
      let text = body(source, head);
      for call in ACTIVATING {
        assert!(!text.contains(call), "{head}: {call}");
      }
    }
    let windows = include_str!("windows.rs");
    let text = body(windows, "pub fn open_tearoff_document(");
    for call in ACTIVATING {
      assert!(!text.contains(call), "open_tearoff_document: {call}");
    }
    // The only way it is shown is the helper that asks whether the app is active.
    let reveal = body(source, "pub fn reveal_tearoff(");
    assert!(reveal.find("RevealCall::Nothing").unwrap() < reveal.find("windows::reveal").unwrap());
  }

  #[test]
  fn the_inner_minus_outer_offset_is_read_inside_the_step_and_never_kept() {
    let source = include_str!("tab_follow.rs");
    let step = body(source, "fn follow_step(");
    assert!(step.contains("os::inner_minus_outer"));
    for kept in ["static ", "thread_local", "OnceLock", "Mutex"] {
      assert!(
        !source
          .replace("#[cfg(test)]", "")
          .split("mod tests")
          .next()
          .unwrap()
          .contains(kept),
        "{kept}"
      );
    }
  }

  #[test]
  fn the_timer_thread_only_asks_the_main_thread_to_step_and_the_hit_test_is_in_the_step() {
    let source = include_str!("tab_follow.rs");
    let timer = body(source, "fn spawn_timer(");
    assert!(timer.contains("run_on_main_thread"));
    for other in ["locate", "sample(", "lock()", "write_outer", "tear."] {
      assert!(!timer.contains(other), "{other}");
    }
    // `locate` is reached from the step alone.
    let production = source.split("#[cfg(test)]").next().unwrap();
    assert_eq!(production.matches("locate_skipping(").count(), 1);
    assert!(body(production, "fn follow_step(").contains("locate_skipping("));
  }

  #[test]
  fn the_step_scales_by_the_plan_and_never_by_the_displays_scale_factor() {
    let source = include_str!("tab_follow.rs");
    let step = body(source, "fn follow_step(");
    assert!(step.contains(
      "scale,\n    } => tearoff_outer_top_left(cursor, first_tab_client_x, grab, scale, offset)"
    ));
    assert!(!step.contains("scale_factor"));
  }

  #[test]
  fn a_windows_window_leaves_the_maximized_state_and_is_moved_before_the_command_returns() {
    let source = include_str!("tab_follow.rs");
    let leave = body(source, "#[cfg(windows)]\nfn leave_maximized(");
    let unmaximized = leave.find("window.unmaximize()").unwrap();
    let moved = leave.find("write_outer(window,").unwrap();
    assert!(unmaximized < moved);
    // The restored size is read before it, and only its width and height.
    assert!(leave.find("os::restored_outer(").unwrap() < unmaximized);
    let restored = body(source, "pub fn restored_outer(");
    assert!(restored.contains("rcNormalPosition"));
    assert!(restored.contains("rect.right - rect.left"));
    for position in ["ptMinPosition", "ptMaxPosition", "rect.left,", "rect.top,"] {
      assert!(!restored.contains(position), "{position}");
    }
  }

  #[test]
  fn a_zoomed_macos_window_gets_its_restored_frame_synchronously_and_never_zoom() {
    let source = include_str!("tab_follow.rs");
    let leave = body(source, "#[cfg(target_os = \"macos\")]\nfn leave_maximized(");
    assert!(leave.contains("restored_outer_mac(window)"));
    assert!(leave.contains("os::set_frame("));
    assert!(!leave.contains("unmaximize"));
    assert!(!leave.contains("zoom("));
    // The frame is the remembered content and the title bar, not the content.
    let restored = body(source, "fn restored_outer_mac(");
    assert!(restored.contains("remembered_content_size("));
    assert!(restored.contains("mac_restored_outer(content, title_bar)"));
  }

  #[test]
  fn a_zoomed_macos_release_places_the_restored_frame_with_its_own_size_and_reads_no_outer_size() {
    let source = include_str!("tab_follow.rs");
    let place = body(source, "pub fn place_zoomed(");
    assert!(place.contains("restored_outer_mac(window)"));
    assert!(place.contains("window_at::place(window, point, restored)"));
    assert!(place.contains("os::set_frame("));
    for old in ["outer_size", "unmaximize"] {
      assert!(!place.contains(old), "{old}");
    }
    let transfer = include_str!("tab_transfer.rs");
    let command = body(transfer, "pub fn tab_move_window(");
    let zoomed = command.find("tab_follow::place_zoomed").unwrap();
    // The old path, which reads the size after an async `unmaximize`, comes after.
    assert!(zoomed < command.find("window.unmaximize()").unwrap());
    assert!(zoomed < command.find("window_at::outer_size(").unwrap());
  }

  #[test]
  fn the_follow_start_checks_the_sender_and_the_book_before_it_moves_anything() {
    let source = include_str!("tab_follow.rs");
    let start = body(source, "pub fn start_move_window(");
    let checked = start.find("sender_may_tear(window)").unwrap();
    assert!(checked < start.find("leave_maximized(").unwrap());
    assert!(start.find("tear.busy()").unwrap() < start.find("leave_maximized(").unwrap());
  }
  #[test]
  fn the_hide_and_restore_helpers_run_on_the_main_thread_or_queue_there_and_never_skip() {
    let source = include_str!("tab_follow.rs");
    for head in ["pub fn hide(", "pub fn restore("] {
      let text = body(source, head);
      assert!(text.contains("on_main_thread(&window)"), "{head}");
      assert!(text.contains("run_on_main_thread"), "{head}");
      // The off-main branch queues the native call: nothing returns early.
      assert!(!text.contains("return"), "{head}");
      assert!(!text.contains("MainThreadMarker"), "{head}");
    }
    let mac = body(source, "#[cfg(target_os = \"macos\")]\nfn on_main_thread(");
    assert!(mac.contains("MainThreadMarker::new().is_some()"));
    let windows = body(source, "#[cfg(windows)]\nfn on_main_thread(");
    assert!(windows.contains("GetWindowThreadProcessId"));
    assert!(windows.contains("GetCurrentThreadId"));
  }

  #[test]
  fn the_restore_helper_clears_the_books_mark_and_is_the_one_way_a_hidden_window_is_shown() {
    let source = include_str!("tab_follow.rs");
    let restore = body(source, "pub fn restore(");
    assert!(restore.contains("tear.clear_hidden(label)"));
    assert!(restore.find("clear_hidden").unwrap() < restore.find("native_restore").unwrap());
    let transfer = include_str!("tab_transfer.rs");
    let run = body(transfer, "fn run_tear(");
    assert!(run.contains("TearAction::Show { label } => crate::tab_follow::restore(app, &label)"));
    assert!(run.contains("TearAction::Hide { label } => crate::tab_follow::hide(app, &label)"));
    let command = body(transfer, "pub fn tab_window_restore(");
    assert!(command.contains("crate::tab_follow::restore(&app, window.label())"));
  }

  #[test]
  fn every_show_path_restores_before_it_shows_or_focuses() {
    let source = include_str!("tab_follow.rs");
    let reveal = body(source, "pub fn reveal_tearoff(");
    let restored = reveal.find("restore(app, label)").unwrap();
    assert!(restored < reveal.find("RevealCall::Nothing").unwrap());
    assert!(restored < reveal.find("windows::reveal").unwrap());
    let back = body(source, "pub fn move_back(");
    assert!(back.find("restore(app, label)").unwrap() < back.find("run_on_main_thread").unwrap());
    let windows = include_str!("windows.rs");
    let itself = body(windows, "pub fn reveal_self(");
    let restore = "crate::tab_follow::restore(window.app_handle(), window.label())";
    assert!(itself.find(restore).unwrap() < itself.find("window.show()").unwrap());
    assert!(itself.find(restore).unwrap() < itself.find("window.set_focus()").unwrap());
    let helper = body(windows, "pub(crate) fn reveal(");
    let restore = "crate::tab_follow::restore(win.app_handle(), win.label())";
    for call in ["win.unminimize()", "win.show()", "win.set_focus()"] {
      assert!(
        helper.find(restore).unwrap() < helper.find(call).unwrap(),
        "{call}"
      );
    }
  }

  #[test]
  fn a_document_window_that_takes_focus_is_restored_by_the_event_handler() {
    let lib = include_str!("lib.rs");
    let handler = body(lib, "fn handle_window_event(");
    let at = handler
      .find("tauri::WindowEvent::Focused(true) = event")
      .unwrap();
    let routed = &handler[at..];
    assert!(routed.contains("window.label().starts_with(\"doc-\")"));
    assert!(routed
      .find("tab_follow::restore(window.app_handle(), window.label())")
      .is_some_and(|r| r < routed.find("CloseRequested").unwrap()));
    assert!(handler[..at].contains("#[cfg(any(target_os = \"macos\", windows))]"));
  }

  #[test]
  fn the_macos_restore_checks_for_alpha_zero_before_it_changes_anything() {
    let source = include_str!("tab_follow.rs");
    let restore = body(source, "#[cfg(target_os = \"macos\")]\nfn native_restore(");
    assert!(restore.find("alphaValue() != 0.0").unwrap() < restore.find("setAlphaValue(").unwrap());
    assert!(restore.contains("return;"));
  }

  #[test]
  fn the_windows_restore_checks_for_a_layered_alpha_of_zero_before_any_style_or_alpha_change() {
    let source = include_str!("tab_follow.rs");
    let restore = body(source, "#[cfg(windows)]\nfn native_restore(");
    let guard = restore.find("GetLayeredWindowAttributes(").unwrap();
    assert!(restore.find("WS_EX_LAYERED as isize == 0").unwrap() < guard);
    let returned = guard + restore[guard..].find("return;").unwrap();
    assert!(restore.contains("alpha != 0"));
    assert!(returned < restore.find("SetLayeredWindowAttributes(").unwrap());
    assert!(returned < restore.find("SetWindowLongPtrW(").unwrap());
    // The repaint comes after the style write, still inside the guarded block.
    let style = restore.find("SetWindowLongPtrW(").unwrap();
    let redraw = restore.find("RedrawWindow(").unwrap();
    assert!(style < redraw);
    assert!(restore[redraw..].contains("RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN"));
  }

  #[test]
  fn only_the_hide_and_restore_helpers_touch_the_alpha_or_the_layered_style() {
    let source = include_str!("tab_follow.rs");
    let mut production = source.split("#[cfg(test)]").next().unwrap().to_string();
    for head in [
      "#[cfg(target_os = \"macos\")]\nfn native_hide(",
      "#[cfg(windows)]\nfn native_hide(",
      "#[cfg(target_os = \"macos\")]\nfn native_restore(",
      "#[cfg(windows)]\nfn native_restore(",
    ] {
      let text = body(&production, head).to_string();
      production = production.replace(&text, "");
    }
    for touched in [
      "setAlphaValue",
      "SetLayeredWindowAttributes",
      "SetWindowLongPtrW",
      "WS_EX_LAYERED",
    ] {
      assert!(!production.contains(touched), "{touched}");
    }
    // A sticky's opacity is applied where it always was, and the follow never
    // reaches it.
    let windows = include_str!("windows.rs");
    let opacity = body(windows, "pub fn apply_opacity(");
    assert!(opacity.contains("let clamped = value.clamp(0.3, 1.0);"));
    assert!(!opacity.contains("tab_follow"));
  }
}
