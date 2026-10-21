// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect } from 'vitest';
import { appliedTarget } from './windowedApplied';

interface Tab {
  id: string;
  windowed?: { sessionId: number } | undefined;
}

describe('appliedTarget', () => {
  const a: Tab = { id: 'a', windowed: { sessionId: 1 } };
  const b: Tab = { id: 'b', windowed: { sessionId: 2 } };
  const plain: Tab = { id: 'plain' };

  it('is the tab that holds the reported session', () => {
    expect(appliedTarget([plain, a, b], 1)).toBe(a);
    expect(appliedTarget([plain, a, b], 2)).toBe(b);
  });

  it('is nothing when no tab has the session', () => {
    expect(appliedTarget([plain, b], 1)).toBeUndefined();
    expect(appliedTarget([], 1)).toBeUndefined();
  });
});
