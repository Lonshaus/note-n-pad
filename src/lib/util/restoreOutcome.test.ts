// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { FILE_NOT_FOUND } from './protocol';
import {
  UnreadableRestore,
  activePositionAfterRestore,
  restoreOutcome,
} from './restoreOutcome';

const DENIED = 'Permission denied (os error 13)';

describe('restoreOutcome', () => {
  it('opens when the read succeeded', () => {
    expect(restoreOutcome(false, null)).toBe('open');
    expect(restoreOutcome(true, null)).toBe('open');
  });

  it('treats a missing file as deleted for a clean tab', () => {
    expect(restoreOutcome(false, FILE_NOT_FOUND)).toBe('deleted-file');
  });

  it('refuses a clean tab whose file cannot be read', () => {
    expect(restoreOutcome(false, DENIED)).toBe('unreadable');
    expect(restoreOutcome(false, 'range out of bounds')).toBe('unreadable');
  });

  it('keeps a dirty tab whatever the read error', () => {
    expect(restoreOutcome(true, DENIED)).toBe('open');
    expect(restoreOutcome(true, FILE_NOT_FOUND)).toBe('open');
  });
});

describe('UnreadableRestore', () => {
  it('carries the path', () => {
    const e = new UnreadableRestore('/a/b.md');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(UnreadableRestore);
    expect(e.path).toBe('/a/b.md');
  });
});

describe('activePositionAfterRestore', () => {
  // Tabs A=0 (unreadable), B=1, C=2.
  const entries = [0, 1, 2];
  const dropped = new Set([0]);

  it('keeps the requested tab active after an earlier tab was dropped', () => {
    expect(activePositionAfterRestore(entries, dropped, 2)).toBe(1);
  });

  it('falls back to position 0 when the requested tab was dropped', () => {
    expect(activePositionAfterRestore(entries, dropped, 0)).toBe(0);
  });

  it('is 0 without a request', () => {
    expect(activePositionAfterRestore(entries, dropped, null)).toBe(0);
  });

  it('matches plain resolution when nothing was dropped', () => {
    expect(activePositionAfterRestore(entries, new Set(), 2)).toBe(2);
  });
});
