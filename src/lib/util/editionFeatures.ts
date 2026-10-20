// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { I18nKey } from '../i18n';

/** One line of the "Full Version Features" table. `lite` is whether the Lite
 *  edition (the Windows trial, or the sandboxed store build before the
 *  purchase) has the feature; the full version has every row. `note` is a
 *  second line under the feature. */
export interface FeatureRow {
  label: I18nKey;
  lite: boolean;
  note?: I18nKey;
}

/** The table's rows in order: what only the full version has, then what both
 *  have. A row about a platform feature (Dock menu on macOS, Jump List on
 *  Windows) is listed on that platform only; `os` is `platform.os`. */
export function featureRows(os: string): FeatureRow[] {
  const rows: FeatureRow[] = [
    {
      label: 'edition.row.largeFiles',
      lite: false,
      note: 'edition.row.largeFilesNote',
    },
    { label: 'edition.row.syntax', lite: false },
    { label: 'edition.row.treeViews', lite: false },
    { label: 'edition.row.themes', lite: false },
    { label: 'edition.row.languageFiles', lite: false },
    { label: 'edition.row.workspace', lite: false },
    { label: 'edition.row.stickies', lite: true },
    { label: 'edition.row.documents', lite: true },
    { label: 'edition.row.markdown', lite: true },
    { label: 'edition.row.table', lite: true },
    { label: 'edition.row.interfaceMode', lite: true },
    { label: 'edition.row.languageEdit', lite: true },
    { label: 'edition.row.trayIcon', lite: true },
  ];
  if (os === 'macos') {
    rows.push({ label: 'edition.row.dockMenu', lite: true });
  }
  if (os === 'windows') {
    rows.push({ label: 'edition.row.jumpList', lite: true });
  }
  rows.push(
    { label: 'edition.row.globalShortcuts', lite: true },
    { label: 'sticky.pin.toApp', lite: true },
    { label: 'sticky.paperColor', lite: true },
  );
  return rows;
}

/** The status line naming the edition this process is in. */
export function editionStatus(lite: boolean): I18nKey {
  return lite ? 'edition.status.free' : 'edition.status.full';
}

/** What `store_info` returns. */
export interface StoreInfo {
  available: boolean;
  price: string | null;
  originalKnown: boolean;
}

/** Which purchase controls the window shows below the table: none outside the
 *  sandboxed store build or once full, a retry while the store has not
 *  answered about the original version, otherwise Buy and Restore. */
export function storeControls(
  info: StoreInfo | null,
  lite: boolean,
): 'none' | 'retry' | 'buy' {
  if (info === null || !info.available || !lite) {
    return 'none';
  }
  return info.originalKnown ? 'buy' : 'retry';
}

/** What a purchase or restore call returns. */
export type StoreResult =
  'purchased' | 'restored' | 'nothing' | 'cancelled' | 'pending' | 'failed';

const STORE_MESSAGES: Partial<Record<StoreResult, I18nKey>> = {
  pending: 'edition.store.pending',
  nothing: 'edition.store.nothing',
  failed: 'edition.store.failed',
};

/** The status line after a purchase or restore, or `null` for none. */
export function storeMessage(result: StoreResult): I18nKey | null {
  return STORE_MESSAGES[result] ?? null;
}
