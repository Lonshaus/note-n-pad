// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  customizedLabel,
  groupKeys,
  isCustomized,
  placeholdersOf,
  setString,
} from './localeEdit';
import type { LocaleData } from './locale';

function locale(strings: Record<string, string>): LocaleData {
  return { id: 'de', label: 'Deutsch (German)', order: 5, strings };
}

describe('groupKeys', () => {
  it('splits by leading namespace, keeping dictionary order', () => {
    const groups = groupKeys([
      'settings.section.general',
      'doc.untitled',
      'settings.language.label',
      'common.open',
    ]);
    expect(groups.map((g) => g.name)).toEqual(['settings', 'doc', 'common']);
    expect(groups[0]?.keys).toEqual([
      'settings.section.general',
      'settings.language.label',
    ]);
  });

  it('treats a key with no dot as its own group', () => {
    expect(groupKeys(['bare'])).toEqual([{ name: 'bare', keys: ['bare'] }]);
  });

  it('returns nothing for no keys', () => {
    expect(groupKeys([])).toEqual([]);
  });
});

describe('setString', () => {
  it('stores an edited value', () => {
    const l = locale({});
    setString(l, 'common.open', 'Öffnen');
    expect(l.strings['common.open']).toBe('Öffnen');
  });

  it('removes the key when the field is cleared, so English takes over', () => {
    const l = locale({ 'common.open': 'Öffnen' });
    setString(l, 'common.open', '');
    expect('common.open' in l.strings).toBe(false);
  });

  it('stores a spaces-only field instead of clearing it', () => {
    // Typing the leading space of " (Custom)" must not reset the field.
    const l = locale({});
    setString(l, 'settings.theme.customSuffix', ' ');
    expect(l.strings['settings.theme.customSuffix']).toBe(' ');
  });

  it('keeps meaningful leading and trailing spaces in a stored value', () => {
    // e.g. the "（自訂）" suffix strings are deliberately space-prefixed.
    const l = locale({});
    setString(l, 'settings.theme.customSuffix', ' (Custom)');
    expect(l.strings['settings.theme.customSuffix']).toBe(' (Custom)');
  });
});

describe('placeholdersOf', () => {
  it('lists the placeholders a translation must keep', () => {
    expect(placeholdersOf('Lines {start}–{end} (~{size})')).toEqual([
      '{start}',
      '{end}',
      '{size}',
    ]);
  });

  it('deduplicates a repeated placeholder', () => {
    expect(placeholdersOf('{x}+{x}')).toEqual(['{x}']);
  });

  it('returns nothing for plain text', () => {
    expect(placeholdersOf('Open')).toEqual([]);
  });
});

describe('customized label marking', () => {
  it('appends the suffix once', () => {
    const once = customizedLabel('Deutsch', '（自訂）');
    expect(once).toBe('Deutsch（自訂）');
    expect(customizedLabel(once, '（自訂）')).toBe(once);
  });

  it('detects an already-customized label', () => {
    expect(isCustomized('Deutsch（自訂）', '（自訂）')).toBe(true);
    expect(isCustomized('Deutsch', '（自訂）')).toBe(false);
  });
});
