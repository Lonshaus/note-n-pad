// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { nextTabIndex } from './keptTabs';
import type { NoteSnapshot } from '../state/stickyNote.svelte';

function note(over: Partial<NoteSnapshot>): NoteSnapshot {
  return {
    id: 'id',
    content: '',
    file_path: '/x.txt',
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
    window_group: 'g',
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
    range_end_line: null,
    range_trailing_break: null,
    windowed_index: null,
    windowed_fp_size: null,
    windowed_fp_mtime: null,
    windowed_digest: null,
    windowed_top_line: null,
    ...over,
  };
}

describe('nextTabIndex', () => {
  it('is 0 for a group with no stored tabs', () => {
    expect(nextTabIndex([])).toBe(0);
  });

  it('is one above the highest stored index, gaps and order aside', () => {
    expect(
      nextTabIndex([
        note({ id: 'a', tab_index: 5 }),
        note({ id: 'b', tab_index: 1 }),
      ]),
    ).toBe(6);
  });

  it('counts a record that opens no tab', () => {
    const old = note({ id: 'k', tab_index: 7, range_source: '/big.log' });
    expect(nextTabIndex([note({ id: 's', tab_index: 2 }), old])).toBe(8);
  });
});
