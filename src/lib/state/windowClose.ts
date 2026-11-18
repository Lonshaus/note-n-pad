// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Closing a document window. A tab on its way in or out is settled first, so
// the window never goes with one half-moved: an outgoing one is called off (or
// let go when it already landed), an incoming copy is dropped.
/** What closing a window needs of its state. */
export interface SettlingWindow {
  settleTransfers(): Promise<void>;
}
/** Settle the window's transfers, then `finish` closing it. When `finish` throws
 *  `failed` runs first, so what a close in progress held back is let go, and the
 *  error goes on. */
export async function closeDocumentWindow(
  win: SettlingWindow,
  finish: () => Promise<void>,
  failed: () => void = () => {},
): Promise<void> {
  await win.settleTransfers();
  try {
    await finish();
  } catch (error) {
    failed();
    throw error;
  }
}
