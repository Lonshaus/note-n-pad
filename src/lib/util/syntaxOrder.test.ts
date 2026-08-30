// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { syntaxOrder } from './syntaxOrder';

describe('syntaxOrder', () => {
  const languages = ['HTML', 'Rust', 'JSON'];

  it('pins Plain Text first and keeps the original order otherwise', () => {
    expect(syntaxOrder(languages, null)).toEqual([
      null,
      'HTML',
      'Rust',
      'JSON',
    ]);
  });

  it('pins the current language first without duplicating it', () => {
    expect(syntaxOrder(languages, 'Rust')).toEqual([
      'Rust',
      null,
      'HTML',
      'JSON',
    ]);
  });

  it('never lists an entry twice', () => {
    const order = syntaxOrder(languages, 'HTML');
    const seen = new Set(order);
    expect(seen.size).toBe(order.length);
  });
});
