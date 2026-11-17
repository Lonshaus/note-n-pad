// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

export interface DocumentSize {
  width: number;
  height: number;
}

export interface RememberStep {
  /** The size the window now counts as having. */
  known: DocumentSize;
  /** Whether the reported size is to be remembered for new windows. */
  write: boolean;
}
/**
 * Decide whether a size report is a resize to remember. A report while the
 * window is maximized, full screen or minimized is ignored (it is not the
 * window's own frame; a minimized window reports 0x0 on Windows). Otherwise a
 * size different from `known` is written and becomes `known`.
 */
export function rememberStep(
  known: DocumentSize,
  next: DocumentSize,
  skip: boolean,
): RememberStep {
  if (skip) {
    return { known, write: false };
  }
  if (next.width === known.width && next.height === known.height) {
    return { known, write: false };
  }
  return { known: next, write: true };
}
