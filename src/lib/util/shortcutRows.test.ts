// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  groupShortcutRows,
  recorderScope,
  shownOtherGroups,
  type GroupableRow,
} from './shortcutRows';

function row(
  id: string,
  section: string,
  heading = '',
): GroupableRow & { id: string } {
  return { id, section, other: heading !== '', heading };
}

const rows = [
  row('menu.quit', 'Note&Pad'),
  row('menu.save', 'File'),
  row('menu.open', 'File'),
  row('other.cursor-left', 'Cursor Movement', 'cursor'),
  row('other.new-line', 'Editing', 'editing'),
  row('other.cursor-up', 'Cursor Movement', 'cursor'),
  row('editor.fold', 'Edit'),
];

describe('groupShortcutRows', () => {
  it('keeps registry sections apart from the other groups, in first-seen order', () => {
    const { sections, otherGroups } = groupShortcutRows(rows);
    expect(sections.map((g) => [g.section, g.rows.map((r) => r.id)])).toEqual([
      ['Note&Pad', ['menu.quit']],
      ['File', ['menu.save', 'menu.open']],
      ['Edit', ['editor.fold']],
    ]);
    expect(
      otherGroups.map((g) => [g.heading, g.rows.map((r) => r.id)]),
    ).toEqual([
      ['cursor', ['other.cursor-left', 'other.cursor-up']],
      ['editing', ['other.new-line']],
    ]);
  });

  it('does not merge an other group into a registry section of the same name', () => {
    const { sections, otherGroups } = groupShortcutRows([
      row('menu.find-next', 'Edit'),
      row('other.find-next', 'Edit', 'editing'),
    ]);
    expect(sections).toHaveLength(1);
    expect(otherGroups).toHaveLength(1);
  });

  it('returns nothing for no rows', () => {
    expect(groupShortcutRows([])).toEqual({ sections: [], otherGroups: [] });
  });
});

describe('shownOtherGroups', () => {
  const { otherGroups } = groupShortcutRows(rows);

  it('hides every group while collapsed and shows them all once expanded', () => {
    expect(shownOtherGroups(otherGroups, false)).toEqual([]);
    expect(shownOtherGroups(otherGroups, true)).toHaveLength(2);
  });
});

describe('recorderScope', () => {
  it('takes the strictest scope of the row', () => {
    expect(recorderScope(['global'])).toBe('global');
    expect(recorderScope(['editor'])).toBe('editor');
    expect(recorderScope(['editor', 'window'])).toBe('editor');
    expect(recorderScope(['window'])).toBe('window');
    expect(recorderScope(['menu'])).toBe('menu');
    expect(recorderScope([])).toBe('menu');
  });
});
