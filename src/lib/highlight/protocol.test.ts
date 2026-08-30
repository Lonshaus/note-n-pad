// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isCurrent, nextVersion } from './protocol';

describe('nextVersion', () => {
  it('increments monotonically', () => {
    expect(nextVersion(0)).toBe(1);
    expect(nextVersion(41)).toBe(42);
  });
});

describe('isCurrent', () => {
  it('keeps output whose version matches the live document', () => {
    expect(isCurrent(7, 7)).toBe(true);
  });

  it('discards output from a superseded version', () => {
    // Producer parsed version 5 while the document has already advanced to 6.
    expect(isCurrent(5, 6)).toBe(false);
    expect(isCurrent(6, 5)).toBe(false);
  });
});
