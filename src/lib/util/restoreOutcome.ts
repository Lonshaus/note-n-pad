// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { FILE_NOT_FOUND } from './protocol';
import { resolveTabPosition } from './openDocuments';

/** What a restored tab does with the result of re-reading its file.
 *  - `open`: build the tab (read succeeded, or it is dirty and carries its own
 *    content).
 *  - `deleted-file`: the file is gone; a clean tab opens from its stored
 *    content, as it always has.
 *  - `unreadable`: the file exists but cannot be read; a clean tab would
 *    present as a blank document, so it is not opened. */
export type RestoreOutcome = 'open' | 'deleted-file' | 'unreadable';

/** `readError` is null when the read succeeded, else the core's error text.
 *  A dirty tab always opens: its unsaved content must survive. */
export function restoreOutcome(
  dirty: boolean,
  readError: string | null,
): RestoreOutcome {
  if (readError === null || dirty) {
    return 'open';
  }
  return readError === FILE_NOT_FOUND ? 'deleted-file' : 'unreadable';
}

/** Thrown by `loadTab` for a restored clean tab that must not be opened. */
export class UnreadableRestore extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`unreadable restore ${path}`);
    this.name = 'UnreadableRestore';
    this.path = path;
  }
}

/** Array position of the tab to activate once some restored entries were
 *  dropped. Positions index the tabs actually opened, so the requested stored
 *  index is resolved against the survivors only; a dropped request falls back
 *  to the first tab. */
export function activePositionAfterRestore(
  entryIndices: number[],
  droppedIndices: ReadonlySet<number>,
  initialTab: number | null,
): number {
  return resolveTabPosition(
    entryIndices.filter((i) => !droppedIndices.has(i)),
    initialTab,
  );
}
