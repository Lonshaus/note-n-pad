// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The Rust side of storekit/NPStore.swift, in the sandboxed store build only:
// the store state every read applies to, and safe wrappers over the C
// functions. Every wrapper blocks until StoreKit answers, so none of them is
// ever called on the main thread or inside the update callback.
use crate::store_state::{self, OriginalRead, StoreInfo, StoreRead, StoreState, PRODUCT_ID};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use std::ffi::{c_char, c_void, CString};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, WebviewWindow};

extern "C" {
  fn np_store_owned(product_id: *const c_char, timeout_ms: u32) -> i32;
  fn np_store_original(buf: *mut c_char, len: usize, timeout_ms: u32) -> i32;
  fn np_store_refresh_original(buf: *mut c_char, len: usize) -> i32;
  fn np_store_watch(product_id: *const c_char, callback: extern "C" fn());
  fn np_store_price(
    product_id: *const c_char,
    buf: *mut c_char,
    len: usize,
    timeout_ms: u32,
  ) -> i32;
  fn np_store_purchase(product_id: *const c_char, window: *mut c_void) -> i32;
  fn np_store_sync() -> i32;
}

/// How long one non-interactive read waits for StoreKit.
const READ_TIMEOUT_MS: u32 = 10_000;

/// How long the edition window waits for the price.
const PRICE_TIMEOUT_MS: u32 = 5_000;

/// Room for a version or a price.
const BUF_LEN: usize = 256;

static STATE: Mutex<StoreState> = Mutex::new(StoreState::new());

/// The store state. A panic while it was held cannot leave it half-written,
/// since every write is one `apply`.
pub(crate) fn state() -> MutexGuard<'static, StoreState> {
  STATE
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn product_id() -> CString {
  CString::new(PRODUCT_ID).expect("the product id has no NUL")
}

/// Whether the product is owned, from the current entitlements.
pub(crate) fn read_owned() -> StoreRead {
  let id = product_id();
  // SAFETY: `id` is a NUL-terminated string that outlives the call.
  let code = unsafe { np_store_owned(id.as_ptr(), READ_TIMEOUT_MS) };
  store_state::owned_from_code(code)
}

/// The app transaction's original version, without prompting.
pub(crate) fn read_original() -> OriginalRead {
  let mut buf = [0u8; BUF_LEN];
  // SAFETY: `buf` is writable for `buf.len()` bytes for the whole call.
  let code = unsafe { np_store_original(buf.as_mut_ptr().cast(), buf.len(), READ_TIMEOUT_MS) };
  store_state::original_from_code(code, &buf)
}

/// The app transaction refreshed from the store, which may ask the user to
/// sign in.
fn refresh_original() -> OriginalRead {
  let mut buf = [0u8; BUF_LEN];
  // SAFETY: `buf` is writable for `buf.len()` bytes for the whole call.
  let code = unsafe { np_store_refresh_original(buf.as_mut_ptr().cast(), buf.len()) };
  store_state::original_from_code(code, &buf)
}

fn read_price() -> Option<String> {
  let id = product_id();
  let mut buf = [0u8; BUF_LEN];
  // SAFETY: `id` outlives the call and `buf` is writable for `buf.len()` bytes.
  let code = unsafe {
    np_store_price(
      id.as_ptr(),
      buf.as_mut_ptr().cast(),
      buf.len(),
      PRICE_TIMEOUT_MS,
    )
  };
  store_state::price_from_code(code, &buf)
}

/// Apply one read with the ticket it took when it started, and publish the
/// edition if that changed it. The state stays locked until `set_lite` has
/// stored the value, so two reads never publish out of order. Returns whether
/// the edition is lite now.
pub(crate) fn apply(
  app: &AppHandle,
  ticket: u64,
  owned: Option<StoreRead>,
  original: Option<OriginalRead>,
) -> bool {
  let mut state = state();
  if let Some(lite) = state.apply(ticket, owned, original) {
    crate::edition::set_lite(app, lite);
  }
  state.lite()
}

/// Read owned again under a new ticket and apply it.
fn reread_owned(app: &AppHandle) -> bool {
  let ticket = state().take_ticket();
  let owned = read_owned();
  apply(app, ticket, Some(owned), None)
}

static UPDATES: OnceLock<Sender<()>> = OnceLock::new();

/// Called by StoreKit's update listener; only wakes the re-read thread.
extern "C" fn on_store_update() {
  let _ = std::panic::catch_unwind(|| {
    if let Some(updates) = UPDATES.get() {
      let _ = updates.send(());
    }
  });
}

/// Start listening for store updates (a purchase approved later, a refund, a
/// purchase from another device) and re-read owned after each one. Only the
/// first call does anything.
pub(crate) fn watch(app: &AppHandle) {
  let (tx, rx) = channel();
  if UPDATES.set(tx).is_err() {
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    while rx.recv().is_ok() {
      reread_owned(&app);
    }
  });
  let id = product_id();
  // SAFETY: `id` outlives the call, which copies it, and the callback is a
  // plain `extern "C"` function that never unwinds.
  unsafe { np_store_watch(id.as_ptr(), on_store_update) };
}

pub(crate) fn info() -> StoreInfo {
  let price = read_price();
  let original_known = store_state::original_known(state().original());
  StoreInfo {
    available: true,
    price,
    original_known,
  }
}

/// A +1 reference to an NSWindow, taken and given back on the main thread.
struct RetainedWindow(*mut c_void);
// SAFETY: the pointer is only retained and released on the main thread, and
// AppKit only uses it there.
unsafe impl Send for RetainedWindow {}

impl RetainedWindow {
  fn as_ptr(&self) -> *mut c_void {
    self.0
  }
}

/// Retain `window`'s NSWindow on the main thread, for the purchase sheet.
fn retain_window(app: &AppHandle, window: &WebviewWindow) -> Option<RetainedWindow> {
  let (tx, rx) = channel();
  let window = window.clone();
  app
    .run_on_main_thread(move || {
      let retained = window.ns_window().ok().and_then(|ptr| {
        // SAFETY: Tauri hands out a live NSWindow, and this is the main thread.
        unsafe { Retained::retain(ptr.cast::<AnyObject>()) }
      });
      let _ = tx.send(retained.map(|r| RetainedWindow(Retained::into_raw(r).cast())));
    })
    .ok()?;
  rx.recv().ok().flatten()
}

/// Give back the reference `retain_window` took, on the main thread.
fn release_window(app: &AppHandle, window: RetainedWindow) {
  let _ = app.run_on_main_thread(move || {
    // SAFETY: the one +1 `retain_window` took, given back once.
    drop(unsafe { Retained::from_raw(window.as_ptr().cast::<AnyObject>()) });
  });
}

/// Buy the product, with the sheet on `window`.
pub(crate) fn purchase(app: &AppHandle, window: &WebviewWindow) -> &'static str {
  let retained = retain_window(app, window);
  let id = product_id();
  let ptr = retained
    .as_ref()
    .map_or(std::ptr::null_mut(), RetainedWindow::as_ptr);
  // SAFETY: `id` outlives the call, and `ptr` is null or a window retained
  // until after it returns.
  let code = unsafe { np_store_purchase(id.as_ptr(), ptr) };
  if let Some(retained) = retained {
    release_window(app, retained);
  }
  match code {
    1 => {
      reread_owned(app);
      "purchased"
    }
    2 => "cancelled",
    3 => "pending",
    _ => "failed",
  }
}

/// Sync with the store, then re-read owned and, if the store never answered
/// about it, the original version.
pub(crate) fn restore(app: &AppHandle) -> &'static str {
  // SAFETY: no arguments.
  match unsafe { np_store_sync() } {
    1 => {
      let mut lite = reread_owned(app);
      let known = store_state::original_known(state().original());
      if !known {
        let ticket = state().take_ticket();
        let original = refresh_original();
        lite = apply(app, ticket, None, Some(original));
      }
      if lite {
        "nothing"
      } else {
        "restored"
      }
    }
    2 => "cancelled",
    _ => "failed",
  }
}

/// Ask the store for the original version again: "known" or "unknown".
pub(crate) fn refresh(app: &AppHandle) -> &'static str {
  let ticket = state().take_ticket();
  let original = refresh_original();
  apply(app, ticket, None, Some(original));
  if store_state::original_known(state().original()) {
    "known"
  } else {
    "unknown"
  }
}
