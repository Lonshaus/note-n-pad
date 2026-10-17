// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { ShortcutScope } from './accelerator';
/** The fields of a `get_shortcuts` row the settings tab groups by. */
export interface GroupableRow {
  section: string;
  other: boolean;
  heading: string;
}

export interface RowGroup<T extends GroupableRow> {
  /** The localized heading. */
  section: string;
  /** Group id of an "other" group; empty for a registry section. */
  heading: string;
  rows: T[];
}
/** Split the rows into registry sections and "Other fixed keys" groups, each
 *  in the order its first row appears (the order the core lists them in). */
export function groupShortcutRows<T extends GroupableRow>(
  rows: readonly T[],
): { sections: RowGroup<T>[]; otherGroups: RowGroup<T>[] } {
  const sections: RowGroup<T>[] = [];
  const otherGroups: RowGroup<T>[] = [];
  for (const row of rows) {
    const target = row.other ? otherGroups : sections;
    const group = target.find((g) =>
      row.other ? g.heading === row.heading : g.section === row.section,
    );
    if (group === undefined) {
      target.push({ section: row.section, heading: row.heading, rows: [row] });
    } else {
      group.rows.push(row);
    }
  }
  return { sections, otherGroups };
}
/** The "Other fixed keys" groups to render: none while the list is collapsed. */
export function shownOtherGroups<T extends GroupableRow>(
  groups: readonly RowGroup<T>[],
  expanded: boolean,
): readonly RowGroup<T>[] {
  return expanded ? groups : [];
}
/** The scope whose recording rules apply to a row. A row handled in several
 *  places takes the strictest: global, then editor. */
export function recorderScope(scopes: readonly string[]): ShortcutScope {
  if (scopes.includes('global')) {
    return 'global';
  }
  if (scopes.includes('editor')) {
    return 'editor';
  }
  return scopes.includes('window') ? 'window' : 'menu';
}
