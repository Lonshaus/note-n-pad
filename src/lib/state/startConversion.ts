// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { ConversionRequest } from '../util/pasteFlow';
import { convertController } from './convertController.svelte';
/** A paste that makes a document or a sticky note a large file. The paste has
 *  recorded where it goes and holds the tab under a full lock (`request.lockId`);
 *  `request.unlock()` takes the lock off, and is called when the conversion ends,
 *  installed, failed or cancelled. */
export function startConversion(request: ConversionRequest): void {
  convertController.start(request);
}
