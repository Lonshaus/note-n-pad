// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { t } from '../i18n';
/** File name of a path (either separator), or the path itself when it has none. */
export function sourceBaseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}
/** The label of a range: "{name} (lines X–Y)" in the UI language. */
export function rangeLabel(
  sourcePath: string,
  startLine: number,
  endLine: number,
): string {
  return t('doc.range.displayName', {
    name: sourceBaseName(sourcePath),
    start: startLine,
    end: endLine,
  });
}
