// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! The test binary's global allocator: per-thread accounting of the largest
//! allocation, live bytes, their peak and the allocations of 64 KiB or more, so
//! parallel tests do not mix. Counters are plain thread-local cells (no heap),
//! and a thread's own frees of another thread's memory just move its live count
//! below zero.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
/// Allocations of this size or more count as big.
const BIG: usize = 64 * 1024;

thread_local! {
  static LARGEST: Cell<usize> = const { Cell::new(0) };
  static LIVE: Cell<i64> = const { Cell::new(0) };
  static PEAK: Cell<i64> = const { Cell::new(0) };
  static BIG_COUNT: Cell<usize> = const { Cell::new(0) };
}

fn grow(bytes: usize) {
  let _ = LIVE.try_with(|live| {
    let now = live.get() + bytes as i64;
    live.set(now);
    let _ = PEAK.try_with(|peak| peak.set(peak.get().max(now)));
  });
}

fn shrink(bytes: usize) {
  let _ = LIVE.try_with(|live| live.set(live.get() - bytes as i64));
}

fn note(size: usize) {
  let _ = LARGEST.try_with(|c| c.set(c.get().max(size)));
  if size >= BIG {
    let _ = BIG_COUNT.try_with(|c| c.set(c.get() + 1));
  }
}

struct Probe;

unsafe impl GlobalAlloc for Probe {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    note(layout.size());
    grow(layout.size());
    unsafe { System.alloc(layout) }
  }
  unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
    note(layout.size());
    grow(layout.size());
    unsafe { System.alloc_zeroed(layout) }
  }
  unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
    shrink(layout.size());
    unsafe { System.dealloc(ptr, layout) }
  }
  unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
    note(new_size);
    if new_size >= layout.size() {
      grow(new_size - layout.size());
    } else {
      shrink(layout.size() - new_size);
    }
    unsafe { System.realloc(ptr, layout, new_size) }
  }
}

#[global_allocator]
static PROBE: Probe = Probe;
/// Forget the largest allocation of this thread so far.
pub fn reset_largest() {
  LARGEST.with(|c| c.set(0));
}
/// The largest single allocation of this thread since `reset_largest`.
pub fn largest() -> usize {
  LARGEST.with(|c| c.get())
}
/// Bytes this thread has allocated and not freed.
pub fn live() -> i64 {
  LIVE.with(|c| c.get())
}
/// Restart the peak at the current live bytes.
pub fn reset_peak() {
  PEAK.with(|peak| peak.set(live()));
}
/// The most live bytes this thread held since `reset_peak`.
pub fn peak() -> i64 {
  PEAK.with(|c| c.get())
}
/// Forget the count of big allocations of this thread so far.
pub fn reset_big() {
  BIG_COUNT.with(|c| c.set(0));
}
/// Allocations of 64 KiB or more by this thread since `reset_big`; a `realloc`
/// counts at its new size.
pub fn big() -> usize {
  BIG_COUNT.with(|c| c.get())
}
