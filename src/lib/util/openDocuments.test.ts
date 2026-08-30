// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
  groupOpenDocuments,
  parseInitialTab,
  resolveTabPosition,
  shouldCollapseEmptyWindow,
} from './openDocuments';
import type { NoteSnapshot } from '../state/stickyNote.svelte';

function note(over: Partial<NoteSnapshot>): NoteSnapshot {
  return {
    id: 'id',
    content: '',
    file_path: null,
    language: null,
    explicit: false,
    x: null,
    y: null,
    width: null,
    height: null,
    pin_mode: 'none',
    pin_app: null,
    opacity: 1,
    paper: 'classic',
    kind: 'document',
    dirty: false,
    window_group: null,
    tab_index: 0,
    line_ending: 'LF',
    had_bom: false,
    encoding: 'UTF-8',
    project: null,
    large: null,
    range_source: null,
    range_start: null,
    range_end: null,
    range_fp_size: null,
    range_fp_mtime: null,
    range_start_line: null,
    windowed_index: null,
    windowed_fp_size: null,
    windowed_fp_mtime: null,
    windowed_digest: null,
    windowed_top_line: null,
    ...over,
  };
}

describe('groupOpenDocuments', () => {
  it('groups tabs by window_group and keeps first-appearance order', () => {
    const groups = groupOpenDocuments([
      note({ id: 'a', window_group: 'g1', file_path: '/x/a.txt' }),
      note({ id: 'b', window_group: 'g2', file_path: '/x/b.txt' }),
      note({ id: 'c', window_group: 'g1', file_path: '/x/c.txt' }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['g1', 'g2']);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('sorts rows within a group by tab_index', () => {
    const groups = groupOpenDocuments([
      note({ id: 'a', window_group: 'g', tab_index: 2, file_path: '/a.txt' }),
      note({ id: 'b', window_group: 'g', tab_index: 0, file_path: '/b.txt' }),
      note({ id: 'c', window_group: 'g', tab_index: 1, file_path: '/c.txt' }),
    ]);
    expect(groups[0]!.rows.map((r) => r.tabIndex)).toEqual([0, 1, 2]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('falls back to the note id when window_group is null', () => {
    const groups = groupOpenDocuments([
      note({ id: 'solo', window_group: null, file_path: '/s.txt' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group).toBe('solo');
  });

  it('names a tab by its basename and empty/null path as Untitled', () => {
    const groups = groupOpenDocuments([
      note({
        id: 'a',
        window_group: 'g',
        tab_index: 0,
        file_path: '/dir/a.txt',
      }),
      note({ id: 'b', window_group: 'g', tab_index: 1, file_path: null }),
      note({ id: 'c', window_group: 'g', tab_index: 2, file_path: '' }),
      note({
        id: 'd',
        window_group: 'g',
        tab_index: 3,
        file_path: 'C:\\docs\\d.md',
      }),
    ]);
    expect(groups[0]!.rows.map((r) => r.name)).toEqual([
      'a.txt',
      'Untitled',
      'Untitled',
      'd.md',
    ]);
  });

  it('carries the raw file path for context-menu reveal', () => {
    const groups = groupOpenDocuments([
      note({ id: 'a', window_group: 'g', tab_index: 0, file_path: '/x/a.txt' }),
      note({ id: 'b', window_group: 'g', tab_index: 1, file_path: null }),
    ]);
    expect(groups[0]!.rows.map((r) => r.filePath)).toEqual(['/x/a.txt', null]);
  });

  it('carries the dirty flag', () => {
    const groups = groupOpenDocuments([
      note({ id: 'a', window_group: 'g', tab_index: 0, dirty: true }),
      note({ id: 'b', window_group: 'g', tab_index: 1, dirty: false }),
    ]);
    expect(groups[0]!.rows.map((r) => r.dirty)).toEqual([true, false]);
  });

  it('ignores non-document notes', () => {
    const groups = groupOpenDocuments([
      note({ id: 'sticky', kind: 'sticky' }),
      note({
        id: 'doc',
        kind: 'document',
        window_group: 'g',
        file_path: '/d.txt',
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(1);
    expect(groups[0]!.rows[0]!.id).toBe('doc');
  });
});

describe('shouldCollapseEmptyWindow', () => {
  it('stays open while a failed-open report is on screen', () => {
    // Closing here would take the report with it and the open would look like
    // nothing happened — the same flash-close the long-line flag exists for.
    expect(shouldCollapseEmptyWindow(true, 0, false, false, true)).toBe(false);
  });

  it('collapses a fresh single-file window that opened nothing', () => {
    expect(shouldCollapseEmptyWindow(true, 0, false, false, false)).toBe(true);
  });
  it('keeps the window alive while the long-line dialog is pending', () => {
    // The flash-close regression: a long-line file staged its confirm (tabs 0)
    // and the window must survive so the user can answer it.
    expect(shouldCollapseEmptyWindow(true, 0, false, true, false)).toBe(false);
  });
  it('keeps the window alive while the large-file confirm is pending', () => {
    expect(shouldCollapseEmptyWindow(true, 0, true, false, false)).toBe(false);
  });
  it('never collapses once a tab opened', () => {
    expect(shouldCollapseEmptyWindow(true, 1, false, false, false)).toBe(false);
  });
  it('does not collapse a window with no initial path', () => {
    expect(shouldCollapseEmptyWindow(false, 0, false, false, false)).toBe(
      false,
    );
  });
});

describe('parseInitialTab', () => {
  it('reads an integer tab parameter', () => {
    expect(parseInitialTab('2')).toBe(2);
  });

  it('keeps tab 0 distinct from an absent parameter', () => {
    expect(parseInitialTab('0')).toBe(0);
    expect(parseInitialTab(null)).toBeNull();
  });

  it('rejects a non-integer parameter', () => {
    expect(parseInitialTab('later')).toBeNull();
    expect(parseInitialTab('1.5')).toBeNull();
  });
});

describe('resolveTabPosition', () => {
  it('finds the array position of a stored tab_index', () => {
    expect(resolveTabPosition([0, 1, 2], 2)).toBe(2);
  });

  it('does not confuse tab_index with array position', () => {
    // Tab 0 was closed, so the surviving tabs carry 1 and 2.
    expect(resolveTabPosition([1, 2], 2)).toBe(1);
  });

  it('falls back to the first tab without a request', () => {
    expect(resolveTabPosition([0, 1], null)).toBe(0);
  });

  it('falls back to the first tab when the requested tab is gone', () => {
    expect(resolveTabPosition([0, 1], 7)).toBe(0);
  });
});
