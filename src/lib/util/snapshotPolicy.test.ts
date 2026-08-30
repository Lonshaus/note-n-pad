// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
  snapshotContentPolicy,
  debounceContentPolicy,
  restoredRangeContent,
  SNAPSHOT_CONTENT_MAX,
  SNAPSHOT_DEBOUNCE_MAX,
} from './snapshotPolicy';

describe('snapshotContentPolicy', () => {
  it('empties a clean buffer regardless of size (disk is the source of truth)', () => {
    expect(snapshotContentPolicy(false, 0)).toBe('empty');
    expect(snapshotContentPolicy(false, 1000)).toBe('empty');
    expect(snapshotContentPolicy(false, SNAPSHOT_CONTENT_MAX)).toBe('empty');
    expect(snapshotContentPolicy(false, SNAPSHOT_CONTENT_MAX + 1)).toBe(
      'empty',
    );
  });

  it('persists a dirty buffer in full up to the ceiling', () => {
    expect(snapshotContentPolicy(true, 0)).toBe('full');
    expect(snapshotContentPolicy(true, 1000)).toBe('full');
  });

  it('treats the exact threshold as full (exclusive ceiling)', () => {
    expect(snapshotContentPolicy(true, SNAPSHOT_CONTENT_MAX)).toBe('full');
  });

  it('skips a dirty oversized buffer (too big to snapshot; quit gate handles it)', () => {
    expect(snapshotContentPolicy(true, SNAPSHOT_CONTENT_MAX + 1)).toBe('skip');
  });
});

describe('debounceContentPolicy', () => {
  it('empties a clean buffer regardless of size (matches the full policy)', () => {
    expect(debounceContentPolicy(false, 0)).toBe('empty');
    expect(debounceContentPolicy(false, SNAPSHOT_DEBOUNCE_MAX)).toBe('empty');
    expect(debounceContentPolicy(false, SNAPSHOT_CONTENT_MAX + 1)).toBe(
      'empty',
    );
  });

  it('persists a small dirty buffer in full (≤ debounce ceiling)', () => {
    expect(debounceContentPolicy(true, 0)).toBe('full');
    expect(debounceContentPolicy(true, 1000)).toBe('full');
  });

  it('treats the exact debounce threshold as full (exclusive ceiling)', () => {
    expect(debounceContentPolicy(true, SNAPSHOT_DEBOUNCE_MAX)).toBe('full');
  });

  it('skips a mid-size dirty buffer the full policy would still persist in full', () => {
    // The defining difference: within the full-snapshot ceiling, so the flush
    // path writes it in full, but the debounce skips it to avoid the stall.
    expect(debounceContentPolicy(true, SNAPSHOT_DEBOUNCE_MAX + 1)).toBe('skip');
    expect(snapshotContentPolicy(true, SNAPSHOT_DEBOUNCE_MAX + 1)).toBe('full');
    expect(debounceContentPolicy(true, SNAPSHOT_CONTENT_MAX)).toBe('skip');
    expect(snapshotContentPolicy(true, SNAPSHOT_CONTENT_MAX)).toBe('full');
  });

  it('skips an oversized dirty buffer, as the full policy also does', () => {
    expect(debounceContentPolicy(true, SNAPSHOT_CONTENT_MAX + 1)).toBe('skip');
    expect(snapshotContentPolicy(true, SNAPSHOT_CONTENT_MAX + 1)).toBe('skip');
  });
});

describe('restoredRangeContent', () => {
  it('restores the stored buffer for a dirty range tab', () => {
    expect(restoredRangeContent(true, 'edited', 'disk')).toBe('edited');
    // Even if the source is gone, a dirty tab keeps its unsaved edits.
    expect(restoredRangeContent(true, 'edited', null)).toBe('edited');
  });

  it('restores the on-disk slice for a clean range tab', () => {
    expect(restoredRangeContent(false, 'stored', 'disk')).toBe('disk');
  });

  it('falls back to the stored buffer when the source is gone', () => {
    expect(restoredRangeContent(false, 'stored', null)).toBe('stored');
    // Clean tabs persist empty content, so the fallback is typically empty.
    expect(restoredRangeContent(false, '', null)).toBe('');
  });
});
