// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

/** Monotonically increasing counter, shared by every caller. Pass the result
 *  as `seq` to a write command that carries a per-id ordering guard on the
 *  Rust side (`upsert_note`, `save_theme`): capture it synchronously, at the
 *  moment the write is issued, before any `await` — JS is single-threaded, so
 *  that ordering is exact even though the command itself now runs off the UI
 *  thread with no guarantee of finishing in call order. A single shared
 *  counter is fine across different ids and different commands: only the
 *  relative order between two writes to the same id ever matters. */
let counter = 0;

export function nextSeq(): number {
  counter += 1;
  return counter;
}
