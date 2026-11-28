// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { stampTearOff, tearOffCloseCalledOff, tearOffStamp } from './tearOff';

const QUERY =
  '?mode=document&group=g&receive=1&tearoff=1&tearoffMode=dark&tearoffTheme=ink';

describe('the stamp of a tear-off', () => {
  it('is the resolved mode and the theme id the core put in the URL', () => {
    expect(tearOffStamp(QUERY)).toEqual({ theme: 'ink', colorScheme: 'dark' });
    expect(
      tearOffStamp('?tearoff=1&tearoffMode=light&tearoffTheme=my%20theme'),
    ).toEqual({ theme: 'my theme', colorScheme: 'light' });
  });

  it('is none for a window that is no tear-off or whose URL is incomplete', () => {
    expect(tearOffStamp('?mode=document&group=g&receive=1')).toBeNull();
    expect(tearOffStamp('?tearoff=1&tearoffMode=dark')).toBeNull();
    expect(tearOffStamp('?tearoff=1&tearoffTheme=ink')).toBeNull();
    // `system` is resolved by the core: the page takes only light or dark.
    expect(
      tearOffStamp('?tearoff=1&tearoffMode=system&tearoffTheme=ink'),
    ).toBeNull();
  });

  it('is put on the root as `data-theme` and the color scheme, synchronously', () => {
    const attributes = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
      style: { colorScheme: '' },
    } as unknown as HTMLElement;
    expect(stampTearOff(root, QUERY)).toBe(true);
    expect(attributes.get('data-theme')).toBe('ink');
    expect(root.style.colorScheme).toBe('dark');
    const other = { setAttribute: () => {}, style: { colorScheme: '' } };
    expect(
      stampTearOff(other as unknown as HTMLElement, '?mode=document'),
    ).toBe(false);
    expect(other.style.colorScheme).toBe('');
  });
});

describe('a close that was called off', () => {
  it('is told to the core by a tear-off still in its role, and by no other window', () => {
    const told: string[] = [];
    expect(tearOffCloseCalledOff(true, () => told.push('core'))).toBe(true);
    expect(tearOffCloseCalledOff(false, () => told.push('core'))).toBe(false);
    expect(told).toEqual(['core']);
  });
});
