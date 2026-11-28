// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Which window lies under a screen point, for a tab released outside its own
// window, and where a window goes that is placed at such a point.
//
// Every coordinate value has one frame (see `tab_transfer` for the wire side):
// a screen point has its origin at the top left of the primary screen and is in
// the native units of the platform: points on macOS (Tauri's logical
// coordinates), physical pixels on Windows. The pure helpers are compiled where
// something calls them, and in tests, as `file_drop` does.

use serde::{Deserialize, Serialize};
/// A screen point (or an offset from a window's inner origin), top-left origin.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
  pub x: f64,
  pub y: f64,
}
/// A rectangle in screen points: origin at its top left.
#[cfg(any(target_os = "macos", windows, test))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}
#[cfg(any(target_os = "macos", windows, test))]
impl Rect {
  /// Whether `point` is inside; the right and bottom edges are outside.
  pub fn contains(&self, point: Point) -> bool {
    point.x >= self.x
      && point.x < self.x + self.width
      && point.y >= self.y
      && point.y < self.y + self.height
  }
  /// How far `point` is from the rectangle; 0 inside.
  fn distance_to(&self, point: Point) -> f64 {
    let dx = (self.x - point.x)
      .max(0.0)
      .max(point.x - (self.x + self.width));
    let dy = (self.y - point.y)
      .max(0.0)
      .max(point.y - (self.y + self.height));
    dx.hypot(dy)
  }
}
/// What lies under the release point.
#[cfg_attr(not(any(target_os = "macos", windows, test)), allow(dead_code))]
#[derive(Clone, Debug, PartialEq)]
pub enum Hit {
  /// Another document window; `offset` is the point minus its inner origin.
  Doc { label: String, offset: Point },
  /// The window the tab came from.
  SelfWindow,
  /// Anything else: another app, a sticky, the desktop.
  Outside,
}
/// What a release does.
#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
  Doc { label: String, offset: Point },
  SelfWindow,
  NewWindow,
  MoveWindow,
  Cancel,
}
/// The rule table for a release. Another document window takes the tab; the
/// own window reorders or returns it; anywhere else opens a new window (or moves
/// the window when the tab is its only one). A full-screen window can neither
/// move nor open a window on its own display, so there only another display
/// takes a tab that is not the only one, and every other drop outside is called
/// off.
pub fn drop_decision(hit: &Hit, fullscreen: bool, same_monitor: bool, only_tab: bool) -> Decision {
  match hit {
    Hit::Doc { label, offset } => Decision::Doc {
      label: label.clone(),
      offset: *offset,
    },
    Hit::SelfWindow => Decision::SelfWindow,
    Hit::Outside => {
      if !fullscreen {
        if only_tab {
          Decision::MoveWindow
        } else {
          Decision::NewWindow
        }
      } else if !same_monitor && !only_tab {
        Decision::NewWindow
      } else {
        Decision::Cancel
      }
    }
  }
}
/// The screen point of a client point of the sender: its inner origin plus the
/// client point times `scale` (1 on macOS, where a CSS pixel is a point; the
/// sender's `devicePixelRatio` on Windows).
#[cfg(any(target_os = "macos", windows, test))]
pub fn screen_point(origin: Point, client: Point, scale: f64) -> Point {
  Point {
    x: origin.x + client.x * scale,
    y: origin.y + client.y * scale,
  }
}
/// A point moved between the AppKit frame (bottom-left origin) and the screen
/// frame (top-left origin) of the primary screen, whose frame height is
/// `primary_height`: the flip is its own inverse. Displays above or left of the
/// primary one have a negative y or x in the screen frame and still map one to
/// one.
#[cfg(any(target_os = "macos", test))]
pub fn flip_y(point: Point, primary_height: f64) -> Point {
  Point {
    x: point.x,
    y: primary_height - point.y,
  }
}
/// The AppKit point (bottom-left origin) of a screen point, for the hit test
/// only; `primary_height` is the primary screen's frame height.
#[cfg(any(target_os = "macos", test))]
pub fn appkit_point(point: Point, primary_height: f64) -> Point {
  flip_y(point, primary_height)
}
/// The screen point (top-left origin) of an AppKit point, such as the mouse
/// location.
#[cfg(any(target_os = "macos", test))]
pub fn screen_of_appkit(point: Point, primary_height: f64) -> Point {
  flip_y(point, primary_height)
}
/// The primary screen's frame height, which every flip between the AppKit frame
/// and the screen frame uses.
#[cfg(target_os = "macos")]
pub fn primary_height(mtm: objc2::MainThreadMarker) -> f64 {
  use objc2_app_kit::NSScreen;
  NSScreen::screens(mtm)
    .firstObject()
    .map_or(0.0, |screen| screen.frame().size.height)
}
/// A screen point relative to a window's inner origin, in native units. The
/// receiver turns it into its own CSS pixels.
#[cfg(any(target_os = "macos", windows, test))]
pub fn offset_from(point: Point, origin: Point) -> Point {
  Point {
    x: point.x - origin.x,
    y: point.y - origin.y,
  }
}
/// The hit for a window found at `point`: a document window other than the
/// sender (`owner` is its label and inner origin), the sender, or anything else.
#[cfg(any(target_os = "macos", windows, test))]
pub fn classify(point: Point, owner: Option<(&str, Point)>, sender: &str) -> Hit {
  match owner {
    Some((label, _)) if label == sender => Hit::SelfWindow,
    Some((label, origin)) if label.starts_with("doc-") => Hit::Doc {
      label: label.to_string(),
      offset: offset_from(point, origin),
    },
    _ => Hit::Outside,
  }
}
/// One top-level window of the desktop as the z-order walk sees it.
#[cfg(any(windows, test))]
#[derive(Clone, Debug)]
pub struct StackWindow {
  /// The label and inner origin when it is a window of this app.
  pub owner: Option<(String, Point)>,
  /// The visible frame.
  pub frame: Rect,
  pub visible: bool,
  pub iconic: bool,
  pub cloaked: bool,
  /// Lets the mouse through (`WS_EX_TRANSPARENT`).
  pub click_through: bool,
  /// A layered window drawn with alpha 0.
  pub alpha_zero: bool,
}
#[cfg(any(windows, test))]
impl StackWindow {
  /// Whether a click at a point of the frame would land on this window.
  fn hittable(&self) -> bool {
    self.visible && !self.iconic && !self.cloaked && !self.click_through && !self.alpha_zero
  }
}
/// The topmost window of `stack` (front to back) that a click at `point` would
/// land on.
#[cfg(any(windows, test))]
pub fn pick_window_at(point: Point, stack: &[StackWindow], sender: &str) -> Hit {
  stack
    .iter()
    .find(|window| window.hittable() && window.frame.contains(point))
    .map_or(Hit::Outside, |window| {
      classify(
        point,
        window
          .owner
          .as_ref()
          .map(|(label, origin)| (label.as_str(), *origin)),
        sender,
      )
    })
}
/// `pick_window_at` for a window that follows the pointer: that window is never
/// what is under the pointer, so it is left out of the stack, and the original
/// sender is an ordinary document window.
#[cfg(any(windows, test))]
pub fn pick_window_skipping(point: Point, stack: &[StackWindow], following: &str) -> Hit {
  let rest: Vec<StackWindow> = stack
    .iter()
    .filter(|window| {
      window
        .owner
        .as_ref()
        .map_or(true, |(label, _)| label != following)
    })
    .cloned()
    .collect();
  pick_window_at(point, &rest, following)
}
/// What is under the pointer for a window that follows it: the topmost window,
/// and only when that is the following window itself, the one below it. A window
/// above the following one (pinned on top) wins.
#[cfg(any(target_os = "macos", test))]
pub fn skip_following(first: Hit, below: impl FnOnce() -> Hit) -> Hit {
  if first == Hit::SelfWindow {
    below()
  } else {
    first
  }
}
/// A display: its whole area and the part windows may use.
#[cfg(any(target_os = "macos", windows, test))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Monitor {
  pub full: Rect,
  pub work: Rect,
}
/// The display holding `point`, else the nearest one.
#[cfg(any(target_os = "macos", windows, test))]
pub fn monitor_at(point: Point, monitors: &[Monitor]) -> Option<usize> {
  if let Some(at) = monitors.iter().position(|m| m.full.contains(point)) {
    return Some(at);
  }
  monitors
    .iter()
    .enumerate()
    .min_by(|a, b| {
      a.1
        .full
        .distance_to(point)
        .total_cmp(&b.1.full.distance_to(point))
    })
    .map(|(at, _)| at)
}
/// `point` moved so that a window of `size` with its top left there lies inside
/// `work`; a window larger than the area keeps its top left on the area's.
#[cfg(any(target_os = "macos", windows, test))]
pub fn clamp_into(point: Point, size: (f64, f64), work: Rect) -> Point {
  let right = (work.x + work.width - size.0).max(work.x);
  let bottom = (work.y + work.height - size.1).max(work.y);
  Point {
    x: point.x.clamp(work.x, right),
    y: point.y.clamp(work.y, bottom),
  }
}
/// Where the top left of a window of `size` goes when it is placed at `point`:
/// on the display holding the point, clamped into that display's work area.
#[cfg(any(target_os = "macos", windows, test))]
pub fn placed_at(point: Point, size: (f64, f64), monitors: &[Monitor]) -> Point {
  match monitor_at(point, monitors) {
    Some(at) => clamp_into(point, size, monitors[at].work),
    None => point,
  }
}
/// Whether two points lie on the same display. True when there is none to tell.
#[cfg(any(target_os = "macos", windows, test))]
pub fn same_display(a: Point, b: Point, monitors: &[Monitor]) -> bool {
  monitor_at(a, monitors) == monitor_at(b, monitors)
}
/// The outer position that puts a window's visible top left at `visible`: its
/// frame has an invisible border, the difference between the window rectangle
/// (`GetWindowRect`) and the visible frame (`DWMWA_EXTENDED_FRAME_BOUNDS`).
#[cfg(any(windows, test))]
pub fn outer_for_visible(visible: Point, window_origin: Point, frame_origin: Point) -> Point {
  Point {
    x: visible.x + (window_origin.x - frame_origin.x),
    y: visible.y + (window_origin.y - frame_origin.y),
  }
}
/// The label and inner origin of the window of this app that has window number
/// `number`, if any.
#[cfg(target_os = "macos")]
fn owner_of_number(
  app: &tauri::AppHandle,
  mtm: objc2::MainThreadMarker,
  number: isize,
) -> Option<(String, Point)> {
  use objc2_app_kit::NSApplication;
  use tauri::Manager;
  let ns_window = NSApplication::sharedApplication(mtm).windowWithWindowNumber(number)?;
  let wanted = objc2::rc::Retained::as_ptr(&ns_window) as usize;
  app.webview_windows().into_iter().find_map(|(label, w)| {
    let ptr = w.ns_window().ok()? as usize;
    (ptr == wanted).then(|| (label, inner_origin(&w)))
  })
}
/// The window number under an AppKit point, below the window numbered `below`
/// (0 for none).
#[cfg(target_os = "macos")]
fn number_at(mtm: objc2::MainThreadMarker, at: Point, below: isize) -> isize {
  use objc2_app_kit::NSWindow;
  use objc2_foundation::NSPoint;
  NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(NSPoint::new(at.x, at.y), below, mtm)
}
/// What the release point of a tab of `sender` lands on, and whether the sender
/// is on the same display as the release point. Main thread only.
#[cfg(target_os = "macos")]
pub fn locate(app: &tauri::AppHandle, sender: &tauri::WebviewWindow, point: Point) -> (Hit, bool) {
  let Some(mtm) = objc2::MainThreadMarker::new() else {
    log::warn!("locate called off the main thread");
    return (Hit::SelfWindow, true);
  };
  let at = appkit_point(point, primary_height(mtm));
  let owner = owner_of_number(app, mtm, number_at(mtm, at, 0));
  let hit = classify(
    point,
    owner
      .as_ref()
      .map(|(label, origin)| (label.as_str(), *origin)),
    sender.label(),
  );
  let monitors = monitors(sender);
  let centre = centre_of(sender);
  (hit, same_display(centre, point, &monitors))
}
/// What lies under `point` for a window that follows the pointer: the topmost
/// window, unless that is `following` itself, then the one below it. Main thread
/// only.
#[cfg(target_os = "macos")]
pub fn locate_skipping(
  app: &tauri::AppHandle,
  following: &tauri::WebviewWindow,
  point: Point,
) -> Hit {
  let Some(mtm) = objc2::MainThreadMarker::new() else {
    log::warn!("locate_skipping called off the main thread");
    return Hit::Outside;
  };
  let at = appkit_point(point, primary_height(mtm));
  let hit_of = |number: isize| {
    let owner = owner_of_number(app, mtm, number);
    classify(
      point,
      owner
        .as_ref()
        .map(|(label, origin)| (label.as_str(), *origin)),
      following.label(),
    )
  };
  let first = number_at(mtm, at, 0);
  skip_following(hit_of(first), || hit_of(number_at(mtm, at, first)))
}
/// Every top-level window of the desktop in z-order, front to back, as a hit
/// test sees it.
#[cfg(windows)]
fn desktop_stack(app: &tauri::AppHandle) -> Vec<StackWindow> {
  use tauri::Manager;
  use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
  use windows_sys::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
  };
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetLayeredWindowAttributes, GetWindowLongPtrW, GetWindowRect, IsIconic,
    IsWindowVisible, GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED, WS_EX_TRANSPARENT,
  };
  unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> i32 {
    // Safety: `lparam` is the `Vec` that `EnumWindows` below borrows for the
    // duration of the call.
    let order = unsafe { &mut *(lparam as *mut Vec<isize>) };
    order.push(hwnd as isize);
    1
  }
  let ours: Vec<(isize, String, Point)> = app
    .webview_windows()
    .into_iter()
    .filter_map(|(label, w)| {
      let hwnd = w.hwnd().ok()?.0 as isize;
      Some((hwnd, label, inner_origin(&w)))
    })
    .collect();
  let mut order: Vec<isize> = Vec::new();
  // EnumWindows walks top-level windows in z-order, topmost first.
  unsafe {
    EnumWindows(Some(collect), &mut order as *mut Vec<isize> as LPARAM);
  }
  order
    .into_iter()
    .filter_map(|id| {
      let hwnd = id as HWND;
      let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
      };
      let mut cloaked: u32 = 0;
      // Safety: both out-parameters are live locals of the sizes asked for.
      let framed = unsafe {
        DwmGetWindowAttribute(
          hwnd,
          DWMWA_EXTENDED_FRAME_BOUNDS as u32,
          &mut rect as *mut RECT as *mut core::ffi::c_void,
          std::mem::size_of::<RECT>() as u32,
        )
      } == 0;
      if !framed && unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return None;
      }
      unsafe {
        DwmGetWindowAttribute(
          hwnd,
          DWMWA_CLOAKED as u32,
          &mut cloaked as *mut u32 as *mut core::ffi::c_void,
          std::mem::size_of::<u32>() as u32,
        );
      }
      let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
      let mut alpha: u8 = 255;
      let mut flags: u32 = 0;
      let mut key: u32 = 0;
      let layered = style & WS_EX_LAYERED != 0
        && unsafe { GetLayeredWindowAttributes(hwnd, &mut key, &mut alpha, &mut flags) } != 0
        && flags & LWA_ALPHA != 0;
      Some(StackWindow {
        owner: ours
          .iter()
          .find(|(own, _, _)| *own == id)
          .map(|(_, label, origin)| (label.clone(), *origin)),
        frame: Rect {
          x: f64::from(rect.left),
          y: f64::from(rect.top),
          width: f64::from(rect.right - rect.left),
          height: f64::from(rect.bottom - rect.top),
        },
        visible: unsafe { IsWindowVisible(hwnd) } != 0,
        iconic: unsafe { IsIconic(hwnd) } != 0,
        cloaked: cloaked != 0,
        click_through: style & WS_EX_TRANSPARENT != 0,
        alpha_zero: layered && alpha == 0,
      })
    })
    .collect()
}
/// `locate` for Windows: the z-order walk, front to back.
#[cfg(windows)]
pub fn locate(app: &tauri::AppHandle, sender: &tauri::WebviewWindow, point: Point) -> (Hit, bool) {
  let hit = pick_window_at(point, &desktop_stack(app), sender.label());
  let monitors = monitors(sender);
  let centre = centre_of(sender);
  (hit, same_display(centre, point, &monitors))
}
/// What lies under `point` for a window that follows the pointer, which is never
/// itself what is under it.
#[cfg(windows)]
pub fn locate_skipping(
  app: &tauri::AppHandle,
  following: &tauri::WebviewWindow,
  point: Point,
) -> Hit {
  pick_window_skipping(point, &desktop_stack(app), following.label())
}
/// The page's top left minus the frame's, from the frame height and the content
/// layout rect (window coordinates, bottom-left origin).
#[cfg(any(target_os = "macos", test))]
pub fn layout_inset(frame_height: f64, layout_origin: Point, layout_size: (f64, f64)) -> Point {
  Point {
    x: layout_origin.x,
    y: frame_height - (layout_origin.y + layout_size.1),
  }
}
/// The window's page top left minus its frame top left, in points. The content
/// rect is the whole frame here (Tauri gives windows a full-size content view),
/// so the title bar is read from the content layout rect, where the page is.
#[cfg(target_os = "macos")]
pub fn page_inset(ns: &objc2_app_kit::NSWindow) -> Point {
  let layout = ns.contentLayoutRect();
  layout_inset(
    ns.frame().size.height,
    Point {
      x: layout.origin.x,
      y: layout.origin.y,
    },
    (layout.size.width, layout.size.height),
  )
}
/// The window's inner origin (where its page starts) as a screen point. Main
/// thread only on macOS.
#[cfg(target_os = "macos")]
pub fn inner_origin(window: &tauri::WebviewWindow) -> Point {
  let (Some(mtm), Ok(ptr)) = (objc2::MainThreadMarker::new(), window.ns_window()) else {
    log::warn!("inner_origin called off the main thread");
    return Point { x: 0.0, y: 0.0 };
  };
  // Safety: the pointer is the window's own NSWindow, read on the main thread.
  let ns = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
  let frame = ns.frame();
  let top_left = screen_of_appkit(
    Point {
      x: frame.origin.x,
      y: frame.origin.y + frame.size.height,
    },
    primary_height(mtm),
  );
  let inset = page_inset(ns);
  Point {
    x: top_left.x + inset.x,
    y: top_left.y + inset.y,
  }
}
/// The window's inner origin as a screen point.
#[cfg(windows)]
pub fn inner_origin(window: &tauri::WebviewWindow) -> Point {
  let Ok(position) = window.inner_position() else {
    return Point { x: 0.0, y: 0.0 };
  };
  Point {
    x: f64::from(position.x),
    y: f64::from(position.y),
  }
}
/// The point in the middle of a window's inner area.
#[cfg(any(target_os = "macos", windows))]
fn centre_of(window: &tauri::WebviewWindow) -> Point {
  let origin = inner_origin(window);
  let scale = native_scale(window);
  let Ok(size) = window.inner_size() else {
    return origin;
  };
  Point {
    x: origin.x + f64::from(size.width) / scale / 2.0,
    y: origin.y + f64::from(size.height) / scale / 2.0,
  }
}
/// Native units per physical pixel: the display's scale on macOS (points), 1 on
/// Windows (physical pixels).
#[cfg(any(target_os = "macos", windows))]
fn native_scale(window: &tauri::WebviewWindow) -> f64 {
  #[cfg(target_os = "macos")]
  {
    window.scale_factor().unwrap_or(1.0)
  }
  #[cfg(windows)]
  {
    let _ = window;
    1.0
  }
}
/// Every display in native units.
#[cfg(any(target_os = "macos", windows))]
pub fn monitors(window: &tauri::WebviewWindow) -> Vec<Monitor> {
  let rect =
    |position: &tauri::PhysicalPosition<i32>, size: &tauri::PhysicalSize<u32>, s: f64| Rect {
      x: f64::from(position.x) / s,
      y: f64::from(position.y) / s,
      width: f64::from(size.width) / s,
      height: f64::from(size.height) / s,
    };
  window
    .available_monitors()
    .unwrap_or_default()
    .iter()
    .map(|m| {
      #[cfg(target_os = "macos")]
      let scale = m.scale_factor();
      #[cfg(windows)]
      let scale = 1.0;
      Monitor {
        full: rect(m.position(), m.size(), scale),
        work: rect(&m.work_area().position, &m.work_area().size, scale),
      }
    })
    .collect()
}
/// The outer position (native units) a window of inner `size` (native units)
/// is given to have its top left at `point`, kept on the display under it.
#[cfg(any(target_os = "macos", windows))]
pub fn place(window: &tauri::WebviewWindow, point: Point, size: (f64, f64)) -> Point {
  placed_at(point, size, &monitors(window))
}
/// Set the position of `window` so that its (visible) top left is at `point`.
#[cfg(target_os = "macos")]
pub fn set_top_left(window: &tauri::WebviewWindow, point: Point) -> Result<(), String> {
  window
    .set_position(tauri::LogicalPosition::new(point.x, point.y))
    .map_err(|e| e.to_string())
}
/// `set_top_left` for Windows, allowing for the invisible border.
#[cfg(windows)]
pub fn set_top_left(window: &tauri::WebviewWindow, point: Point) -> Result<(), String> {
  use windows_sys::Win32::Foundation::RECT;
  use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
  use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;
  let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
  let empty = RECT {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  };
  let (mut outer, mut frame) = (empty, empty);
  // Safety: both out-parameters are live locals of the sizes asked for.
  let measured = unsafe {
    GetWindowRect(hwnd as _, &mut outer) != 0
      && DwmGetWindowAttribute(
        hwnd as _,
        DWMWA_EXTENDED_FRAME_BOUNDS as u32,
        &mut frame as *mut RECT as *mut core::ffi::c_void,
        std::mem::size_of::<RECT>() as u32,
      ) == 0
  };
  let position = if measured {
    outer_for_visible(
      point,
      Point {
        x: f64::from(outer.left),
        y: f64::from(outer.top),
      },
      Point {
        x: f64::from(frame.left),
        y: f64::from(frame.top),
      },
    )
  } else {
    point
  };
  window
    .set_position(tauri::PhysicalPosition::new(
      position.x.round() as i32,
      position.y.round() as i32,
    ))
    .map_err(|e| e.to_string())
}
/// The screen point of a client point of `window`: its inner origin plus the
/// client point, scaled by `dpr` on Windows, where a CSS pixel is that many
/// physical pixels, and as it is on macOS, where it is a point.
#[cfg(any(target_os = "macos", windows))]
pub fn release_point(window: &tauri::WebviewWindow, client: Point, dpr: f64) -> Point {
  let scale = if cfg!(windows) { dpr } else { 1.0 };
  screen_point(inner_origin(window), client, scale)
}
/// The outer size of a window in native units.
#[cfg(any(target_os = "macos", windows))]
pub fn outer_size(window: &tauri::WebviewWindow) -> (f64, f64) {
  let scale = native_scale(window);
  window.outer_size().map_or((0.0, 0.0), |s| {
    (f64::from(s.width) / scale, f64::from(s.height) / scale)
  })
}
/// The inner size of a window in native units.
#[cfg(any(target_os = "macos", windows))]
pub fn native_size(window: &tauri::WebviewWindow) -> (f64, f64) {
  let scale = native_scale(window);
  window.inner_size().map_or((0.0, 0.0), |s| {
    (f64::from(s.width) / scale, f64::from(s.height) / scale)
  })
}
/// There is no hit test on this platform: every release counts as inside the
/// sender, and the client point stands in for the screen point.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn release_point(_window: &tauri::WebviewWindow, client: Point, _dpr: f64) -> Point {
  client
}
/// The sender is the only window the platform has no hit test for: every
/// release counts as inside it.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn locate(
  _app: &tauri::AppHandle,
  _sender: &tauri::WebviewWindow,
  _point: Point,
) -> (Hit, bool) {
  (Hit::SelfWindow, true)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn p(x: f64, y: f64) -> Point {
    Point { x, y }
  }
  fn r(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
      x,
      y,
      width,
      height,
    }
  }
  #[test]
  fn the_page_starts_below_the_title_bar_the_layout_rect_leaves_out() {
    // A 600 pt frame whose layout rect leaves the top 32 pt to the title bar.
    assert_eq!(
      layout_inset(600.0, p(0.0, 0.0), (800.0, 568.0)),
      p(0.0, 32.0)
    );
    // No title bar: the page starts at the frame.
    assert_eq!(
      layout_inset(600.0, p(0.0, 0.0), (800.0, 600.0)),
      p(0.0, 0.0)
    );
  }
  fn doc(label: &str, frame: Rect, origin: Point) -> StackWindow {
    StackWindow {
      owner: Some((label.to_string(), origin)),
      frame,
      visible: true,
      iconic: false,
      cloaked: false,
      click_through: false,
      alpha_zero: false,
    }
  }
  fn foreign(frame: Rect) -> StackWindow {
    StackWindow {
      owner: None,
      ..doc("x", frame, p(0.0, 0.0))
    }
  }
  fn doc_hit(label: &str, x: f64, y: f64) -> Hit {
    Hit::Doc {
      label: label.to_string(),
      offset: p(x, y),
    }
  }

  #[test]
  fn the_topmost_window_wins() {
    let stack = vec![
      doc("doc-b", r(0.0, 0.0, 100.0, 100.0), p(0.0, 20.0)),
      doc("doc-c", r(0.0, 0.0, 100.0, 100.0), p(0.0, 20.0)),
    ];
    assert_eq!(
      pick_window_at(p(10.0, 30.0), &stack, "doc-a"),
      doc_hit("doc-b", 10.0, 10.0)
    );
  }

  #[test]
  fn cloaked_click_through_and_alpha_zero_windows_above_a_doc_window_are_skipped() {
    let frame = r(0.0, 0.0, 100.0, 100.0);
    let below = doc("doc-b", frame, p(0.0, 0.0));
    for hide in [
      |w: &mut StackWindow| w.cloaked = true,
      |w: &mut StackWindow| w.click_through = true,
      |w: &mut StackWindow| w.alpha_zero = true,
      |w: &mut StackWindow| w.visible = false,
      |w: &mut StackWindow| w.iconic = true,
    ] {
      let mut above = foreign(frame);
      hide(&mut above);
      assert_eq!(
        pick_window_at(p(5.0, 5.0), &[above, below.clone()], "doc-a"),
        doc_hit("doc-b", 5.0, 5.0)
      );
    }
    // The same window, not hidden in any way, covers the doc window.
    assert_eq!(
      pick_window_at(p(5.0, 5.0), &[foreign(frame), below], "doc-a"),
      Hit::Outside
    );
  }

  #[test]
  fn the_sender_is_self_and_nothing_under_the_point_is_outside() {
    let stack = vec![doc("doc-a", r(0.0, 0.0, 100.0, 100.0), p(0.0, 0.0))];
    assert_eq!(
      pick_window_at(p(50.0, 50.0), &stack, "doc-a"),
      Hit::SelfWindow
    );
    assert_eq!(
      pick_window_at(p(150.0, 50.0), &stack, "doc-a"),
      Hit::Outside
    );
    assert_eq!(pick_window_at(p(1.0, 1.0), &[], "doc-a"), Hit::Outside);
  }

  #[test]
  fn a_window_that_is_not_a_document_window_is_outside() {
    let mut sticky = foreign(r(0.0, 0.0, 100.0, 100.0));
    sticky.owner = Some(("note-1".to_string(), p(0.0, 0.0)));
    assert_eq!(
      pick_window_at(p(5.0, 5.0), &[sticky], "doc-a"),
      Hit::Outside
    );
  }

  #[test]
  fn the_offset_is_in_native_units_on_a_stack_of_mixed_scales() {
    // A 2x display left of a 1x one: native units are the display's own.
    let stack = vec![
      doc("doc-b", r(2000.0, 100.0, 800.0, 600.0), p(2000.0, 140.0)),
      doc("doc-c", r(0.0, 0.0, 1800.0, 1200.0), p(0.0, 56.0)),
    ];
    assert_eq!(
      pick_window_at(p(2210.5, 300.25), &stack, "doc-a"),
      doc_hit("doc-b", 210.5, 160.25)
    );
    assert_eq!(
      pick_window_at(p(300.0, 400.0), &stack, "doc-a"),
      doc_hit("doc-c", 300.0, 344.0)
    );
  }

  #[test]
  fn a_doc_window_above_the_sender_wins_at_a_point_inside_the_senders_frame() {
    let stack = vec![
      doc("doc-b", r(50.0, 50.0, 100.0, 100.0), p(50.0, 80.0)),
      doc("doc-a", r(0.0, 0.0, 200.0, 200.0), p(0.0, 30.0)),
    ];
    assert_eq!(
      pick_window_at(p(60.0, 90.0), &stack, "doc-a"),
      doc_hit("doc-b", 10.0, 10.0)
    );
    assert_eq!(
      pick_window_at(p(10.0, 90.0), &stack, "doc-a"),
      Hit::SelfWindow
    );
  }

  #[test]
  fn every_row_of_the_drop_decision() {
    let doc = doc_hit("doc-b", 1.0, 2.0);
    let on_doc = Decision::Doc {
      label: "doc-b".to_string(),
      offset: p(1.0, 2.0),
    };
    for fullscreen in [false, true] {
      for same in [false, true] {
        for only in [false, true] {
          assert_eq!(drop_decision(&doc, fullscreen, same, only), on_doc);
          assert_eq!(
            drop_decision(&Hit::SelfWindow, fullscreen, same, only),
            Decision::SelfWindow
          );
        }
      }
    }
    let outside = |fullscreen, same, only| drop_decision(&Hit::Outside, fullscreen, same, only);
    assert_eq!(outside(false, true, false), Decision::NewWindow);
    assert_eq!(outside(false, false, false), Decision::NewWindow);
    assert_eq!(outside(false, true, true), Decision::MoveWindow);
    assert_eq!(outside(false, false, true), Decision::MoveWindow);
    assert_eq!(outside(true, false, false), Decision::NewWindow);
    assert_eq!(outside(true, true, false), Decision::Cancel);
    assert_eq!(outside(true, true, true), Decision::Cancel);
    assert_eq!(outside(true, false, true), Decision::Cancel);
  }

  #[test]
  fn the_frames_on_macos() {
    // Primary height H, sender inner origin (X, Y), client (x, y).
    let (h, origin, client) = (900.0, p(120.0, 80.0), p(35.5, 12.25));
    let point = screen_point(origin, client, 1.0);
    assert_eq!(point, p(155.5, 92.25));
    assert_eq!(appkit_point(point, h), p(155.5, h - 92.25));
    let receiver = p(300.0, 150.0);
    assert_eq!(offset_from(point, receiver), p(-144.5, -57.75));
    // The AppKit point is never what an offset is measured from.
    assert_ne!(
      offset_from(appkit_point(point, h), receiver),
      p(-144.5, -57.75)
    );
  }

  #[test]
  fn the_frames_on_windows_scale_the_client_point_by_the_device_pixel_ratio() {
    for dpr in [1.5, 2.25] {
      let (origin, client) = (p(1920.0, 40.0), p(100.0, 60.0));
      let point = screen_point(origin, client, dpr);
      assert_eq!(point, p(1920.0 + 100.0 * dpr, 40.0 + 60.0 * dpr));
      let receiver = p(2200.0, 100.0);
      assert_eq!(
        offset_from(point, receiver),
        p(1920.0 + 100.0 * dpr - 2200.0, 40.0 + 60.0 * dpr - 100.0)
      );
    }
  }

  #[test]
  fn a_windows_release_point_scales_by_the_device_pixel_ratio_and_not_by_the_displays_scale() {
    let source = include_str!("window_at.rs");
    let at = source
      .find("pub fn release_point(window: &tauri::WebviewWindow")
      .unwrap();
    let body = &source[at..];
    let body = &body[..body.find("\n}\n").unwrap()];
    assert!(body.contains("if cfg!(windows) { dpr } else { 1.0 }"));
    assert!(!body.contains("scale_factor"));
  }

  #[test]
  fn classify_names_a_doc_window_the_sender_or_outside() {
    let at = p(30.0, 40.0);
    assert_eq!(
      classify(at, Some(("doc-b", p(10.0, 10.0))), "doc-a"),
      doc_hit("doc-b", 20.0, 30.0)
    );
    assert_eq!(
      classify(at, Some(("doc-a", p(10.0, 10.0))), "doc-a"),
      Hit::SelfWindow
    );
    assert_eq!(
      classify(at, Some(("workspace", p(10.0, 10.0))), "doc-a"),
      Hit::Outside
    );
    assert_eq!(classify(at, None, "doc-a"), Hit::Outside);
  }

  fn displays() -> Vec<Monitor> {
    vec![
      Monitor {
        full: r(0.0, 0.0, 1440.0, 900.0),
        work: r(0.0, 25.0, 1440.0, 800.0),
      },
      Monitor {
        full: r(1440.0, -100.0, 1920.0, 1080.0),
        work: r(1440.0, -100.0, 1920.0, 1040.0),
      },
    ]
  }

  #[test]
  fn the_work_area_clamp_keeps_a_window_inside_the_display_under_the_point() {
    let shown = |point, size| {
      let at = placed_at(point, size, &displays());
      (at.x, at.y)
    };
    // Inside already: unchanged.
    assert_eq!(shown(p(200.0, 200.0), (800.0, 600.0)), (200.0, 200.0));
    // Past the right and bottom edges: pulled back so the window fits.
    assert_eq!(shown(p(1300.0, 800.0), (800.0, 600.0)), (640.0, 225.0));
    // Above the work area (under the menu bar): pushed down onto it.
    assert_eq!(shown(p(200.0, 0.0), (800.0, 600.0)), (200.0, 25.0));
    // On the second display, with the clamp of that display.
    assert_eq!(shown(p(3300.0, 900.0), (800.0, 600.0)), (2560.0, 340.0));
    // A window larger than the area keeps its top left on the area's.
    assert_eq!(shown(p(500.0, 500.0), (2000.0, 1200.0)), (0.0, 25.0));
  }

  #[test]
  fn the_nearest_display_is_used_when_none_holds_the_point() {
    let monitors = displays();
    assert_eq!(monitor_at(p(10.0, 10.0), &monitors), Some(0));
    assert_eq!(monitor_at(p(1500.0, 0.0), &monitors), Some(1));
    // Below the first display and just left of nothing: nearest by distance.
    assert_eq!(monitor_at(p(700.0, 2000.0), &monitors), Some(0));
    assert_eq!(monitor_at(p(5000.0, 400.0), &monitors), Some(1));
    assert_eq!(monitor_at(p(5.0, 5.0), &[]), None);
    let at = placed_at(p(5000.0, 400.0), (800.0, 600.0), &monitors);
    assert!(monitors[1].work.contains(at));
    assert_eq!(placed_at(p(5.0, 5.0), (1.0, 1.0), &[]), p(5.0, 5.0));
  }

  #[test]
  fn two_points_are_on_the_same_display_when_the_same_one_holds_them() {
    let monitors = displays();
    assert!(same_display(p(10.0, 10.0), p(900.0, 800.0), &monitors));
    assert!(!same_display(p(10.0, 10.0), p(1500.0, 10.0), &monitors));
    assert!(same_display(p(10.0, 10.0), p(1500.0, 10.0), &[]));
  }

  #[test]
  fn the_flip_between_appkit_and_the_screen_frame_is_its_own_inverse_everywhere() {
    let h = 900.0;
    for point in [
      p(10.0, 20.0),
      p(-1440.0, 300.0),
      p(100.0, -700.0),
      p(-5.0, 1200.0),
    ] {
      assert_eq!(screen_of_appkit(appkit_point(point, h), h), point);
    }
    // A display above the primary one has a negative y in the screen frame and
    // a y above the primary's height in AppKit.
    assert_eq!(appkit_point(p(0.0, -300.0), h), p(0.0, 1200.0));
    assert_eq!(screen_of_appkit(p(-200.0, 1300.0), h), p(-200.0, -400.0));
  }

  #[test]
  fn a_pointer_over_the_following_window_looks_at_the_window_below_it_only_then() {
    // Topmost is the following window itself: the one below decides.
    assert_eq!(
      skip_following(Hit::SelfWindow, || doc_hit("doc-b", 1.0, 2.0)),
      doc_hit("doc-b", 1.0, 2.0)
    );
    // Topmost is another window, a pinned one above the following window: it
    // wins and nothing below is asked.
    assert_eq!(
      skip_following(doc_hit("doc-pin", 3.0, 4.0), || panic!("asked below")),
      doc_hit("doc-pin", 3.0, 4.0)
    );
    // Topmost is a foreign window: outside, nothing below is asked.
    assert_eq!(
      skip_following(Hit::Outside, || panic!("asked below")),
      Hit::Outside
    );
  }

  #[test]
  fn the_stack_walk_leaves_the_following_window_out_and_a_window_above_it_wins() {
    let frame = r(0.0, 0.0, 100.0, 100.0);
    let stack = vec![
      doc("doc-pin", frame, p(0.0, 20.0)),
      doc("doc-t", frame, p(0.0, 20.0)),
      doc("doc-a", frame, p(0.0, 20.0)),
    ];
    // The window above the following one wins.
    assert_eq!(
      pick_window_skipping(p(5.0, 30.0), &stack, "doc-t"),
      doc_hit("doc-pin", 5.0, 10.0)
    );
    // With it topmost the one below does, and the original sender is a document
    // window like any other.
    assert_eq!(
      pick_window_skipping(p(5.0, 30.0), &stack[1..], "doc-t"),
      doc_hit("doc-a", 5.0, 10.0)
    );
    assert_eq!(
      pick_window_skipping(p(5.0, 30.0), &stack[1..2], "doc-t"),
      Hit::Outside
    );
  }

  #[test]
  fn the_invisible_border_of_a_windows_frame_is_allowed_for() {
    // The window rectangle starts 7 px left of the visible frame.
    assert_eq!(
      outer_for_visible(p(500.0, 300.0), p(493.0, 300.0), p(500.0, 300.0)),
      p(493.0, 300.0)
    );
    assert_eq!(
      outer_for_visible(p(0.0, 0.0), p(-7.0, 0.0), p(0.0, 0.0)),
      p(-7.0, 0.0)
    );
  }
}
