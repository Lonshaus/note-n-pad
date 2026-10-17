// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  keptTabsToLoad,
  partitionRestorable,
  requiresFullEdition,
  windowBoundsRecord,
} from './keptTabs';
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

const large = note({ id: 'large', tab_index: 1, large: 200_000_000 });
const windowed = note({
  id: 'windowed',
  tab_index: 2,
  large: 200_000_000,
  windowed_index: { checkpoints: [[0, 0]], total_newlines: 1 },
});
const range = note({
  id: 'range',
  tab_index: 3,
  range_source: '/big.log',
  dirty: true,
  content: 'unsaved edit',
});
const plain = note({ id: 'plain', tab_index: 0 });

describe('requiresFullEdition', () => {
  it('is true for a large viewer, windowed editing and a range tab', () => {
    expect(requiresFullEdition(large)).toBe(true);
    expect(requiresFullEdition(windowed)).toBe(true);
    expect(requiresFullEdition(range)).toBe(true);
  });

  it('is false for an ordinary tab and for a sticky', () => {
    expect(requiresFullEdition(plain)).toBe(false);
    expect(requiresFullEdition(note({ kind: 'sticky', large: 1 }))).toBe(false);
  });
});

describe('partitionRestorable', () => {
  const all = [plain, large, windowed, range];

  it('opens everything in full', () => {
    const got = partitionRestorable(all, false);
    expect(got.restorable).toEqual(all);
    expect(got.kept).toEqual([]);
  });

  it('keeps every tab that needs a removed feature in lite', () => {
    const got = partitionRestorable(all, true);
    expect(got.restorable).toEqual([plain]);
    expect(got.kept.map((n) => n.id)).toEqual(['large', 'windowed', 'range']);
  });

  it('hands the kept records back as the very objects it was given', () => {
    // Nothing is copied or edited on the way, so nothing can be written back.
    const got = partitionRestorable(all, true);
    expect(got.kept[2]).toBe(range);
    expect(range.content).toBe('unsaved edit');
    expect(range.dirty).toBe(true);
  });
});

describe('keptTabsToLoad', () => {
  const other = note({ id: 'other', window_group: 'h', large: 1 });
  const solo = note({ id: 'solo', window_group: null, large: 1 });

  it('returns the group kept tabs that are not open, in stored order', () => {
    const got = keptTabsToLoad(
      [range, other, windowed, plain, large],
      'g',
      new Set(),
    );
    expect(got.map((n) => n.id)).toEqual(['large', 'windowed', 'range']);
  });

  it('skips a tab that is already open', () => {
    const got = keptTabsToLoad([large, range], 'g', new Set(['large']));
    expect(got.map((n) => n.id)).toEqual(['range']);
  });

  it('treats a group-less record as the group of its own id', () => {
    expect(keptTabsToLoad([solo], 'solo', new Set())).toEqual([solo]);
    expect(keptTabsToLoad([solo], 'g', new Set())).toEqual([]);
  });
});

describe('windowBoundsRecord', () => {
  const keptFirst = note({
    id: 'k',
    tab_index: 0,
    x: 10,
    range_source: '/big.log',
  });
  const shownLater = note({ id: 's', tab_index: 1, x: 900 });
  const shownLatest = note({ id: 's2', tab_index: 4, x: 700 });

  it('is the lowest shown tab in lite, skipping a kept one before it', () => {
    expect(windowBoundsRecord([keptFirst, shownLater, shownLatest], true)).toBe(
      shownLater,
    );
  });

  it('is the lowest tab overall in full', () => {
    expect(
      windowBoundsRecord([keptFirst, shownLater, shownLatest], false),
    ).toBe(keptFirst);
  });

  it('falls back to the lowest kept tab when every tab is kept', () => {
    const second = note({ id: 'k2', tab_index: 2, large: 1 });
    expect(windowBoundsRecord([keptFirst, second], true)).toBe(keptFirst);
  });
});
