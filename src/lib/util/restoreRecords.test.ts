// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  isCleanOldRange,
  isOldRangeRecord,
  needsRewrite,
} from './restoreRecords';
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

const plain = note({});
const large = note({ large: 200_000_000 });
const windowed = note({
  large: 200_000_000,
  windowed_index: { checkpoints: [[0, 0]], total_newlines: 1 },
});
const dirtyRange = note({ range_source: '/big.log', dirty: true });
const cleanRange = note({ range_source: '/big.log' });

describe('old range records', () => {
  it('are the document records with a range source', () => {
    expect(isOldRangeRecord(dirtyRange)).toBe(true);
    expect(isOldRangeRecord(cleanRange)).toBe(true);
    expect(isOldRangeRecord(plain)).toBe(false);
    expect(isOldRangeRecord(large)).toBe(false);
    expect(isOldRangeRecord(note({ kind: 'sticky', range_source: '/x' }))).toBe(
      false,
    );
  });

  it('hold nothing to restore when nothing was left unsaved', () => {
    expect(isCleanOldRange(cleanRange)).toBe(true);
    expect(isCleanOldRange(dirtyRange)).toBe(false);
    expect(isCleanOldRange(plain)).toBe(false);
  });
});

describe('needsRewrite', () => {
  it('is true for an old range record in either edition', () => {
    for (const trial of [false, true]) {
      expect(needsRewrite(dirtyRange, trial)).toBe(true);
    }
  });

  it('is true for a large or windowed record in the trial only', () => {
    expect(needsRewrite(large, true)).toBe(true);
    expect(needsRewrite(windowed, true)).toBe(true);
    expect(needsRewrite(large, false)).toBe(false);
    expect(needsRewrite(windowed, false)).toBe(false);
  });

  it('is false for an ordinary record and for a sticky', () => {
    for (const trial of [false, true]) {
      expect(needsRewrite(plain, trial)).toBe(false);
      expect(needsRewrite(note({ kind: 'sticky', large: 1 }), trial)).toBe(
        false,
      );
    }
  });
});
