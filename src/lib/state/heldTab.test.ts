// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isOrdinaryTab, pickHeldTab, touchMru } from './heldTab';

const ord = (id: string) => ({ id, large: undefined });
const large = (id: string) => ({ id, large: {} });
const windowed = (id: string) => ({ id, windowed: {} });
const restoring = (id: string) => ({ id, windowedRestore: {} });

describe('isOrdinaryTab', () => {
  it('rejects large, windowed and mid-restore tabs', () => {
    expect(isOrdinaryTab(ord('a'))).toBe(true);
    expect(isOrdinaryTab(large('a'))).toBe(false);
    expect(isOrdinaryTab(windowed('a'))).toBe(false);
    expect(isOrdinaryTab(restoring('a'))).toBe(false);
  });
});

describe('touchMru', () => {
  it('moves an id to the front without duplicates', () => {
    expect(touchMru(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(touchMru([], 'a')).toEqual(['a']);
  });
});

describe('pickHeldTab', () => {
  it('returns the active tab when it is ordinary', () => {
    const tabs = [ord('a'), ord('b')];
    expect(pickHeldTab(tabs, 1, ['a'])?.id).toBe('b');
  });

  it('keeps the last active ordinary tab while a large tab is active', () => {
    const tabs = [ord('a'), large('L'), ord('b')];
    expect(pickHeldTab(tabs, 1, ['b', 'a'])?.id).toBe('b');
    expect(pickHeldTab(tabs, 1, ['a', 'b'])?.id).toBe('a');
  });

  it('skips closed and no longer ordinary tabs in the history', () => {
    const tabs = [ord('b'), windowed('L')];
    expect(pickHeldTab(tabs, 1, ['gone', 'L', 'b'])?.id).toBe('b');
  });

  it('falls back to the first ordinary tab, then to null', () => {
    expect(pickHeldTab([large('L'), ord('x')], 0, [])?.id).toBe('x');
    expect(pickHeldTab([large('L'), restoring('R')], 0, ['L'])).toBeNull();
    expect(pickHeldTab([], 0, [])).toBeNull();
  });
});
