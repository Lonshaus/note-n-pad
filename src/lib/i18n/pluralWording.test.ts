// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { en } from './en';
import { ja } from './ja';
import { zhTW } from './zh-TW';
import { OLD_SHIPPED } from './pluralOldValues';

const seeds = import.meta.glob<{ strings: Record<string, string> }>(
  '../../../src-tauri/resources/locales/*.json',
  { eager: true, import: 'default' },
);

const rustSource = import.meta.glob<string>(
  '../../../src-tauri/src/locale_store.rs',
  { eager: true, query: '?raw', import: 'default' },
);

function current(locale: string): Record<string, string> {
  const compiled: Record<string, Record<string, string>> = {
    en,
    ja,
    'zh-TW': zhTW,
  };
  if (compiled[locale]) {
    return compiled[locale];
  }
  const entry = Object.entries(seeds).find(([path]) =>
    path.endsWith(`/${locale}.json`),
  );
  if (!entry) {
    throw new Error(`no seed for ${locale}`);
  }
  return entry[1].strings;
}

const COUNT_KEYS = {
  skH: 'skipped.heading',
  skS: 'skipped.snapshotHeading',
  mv: 'settings.general.snapshotMoveBody',
  col: 'settings.general.snapshotCollisionTitle',
  rng: 'large.range.info',
  srch: 'large.search.searching',
  res: 'large.search.results',
  idx: 'status.indexing',
  ln: 'status.lines',
} as const;
const NINE = Object.values(COUNT_KEYS);
// The pairs this rewording changes.
const CHANGED: Record<string, (keyof typeof COUNT_KEYS)[]> = {
  en: ['skH', 'skS', 'mv', 'col', 'rng', 'res', 'idx', 'ln'],
  de: ['skH', 'skS', 'col', 'rng', 'res', 'idx', 'ln'],
  fr: ['skH', 'skS', 'mv', 'col', 'rng', 'res', 'idx', 'ln'],
  es: ['skH', 'skS', 'mv', 'col', 'rng', 'srch', 'res', 'idx', 'ln'],
  it: ['skS', 'col', 'rng', 'srch', 'res', 'idx', 'ln'],
  'pt-BR': ['skH', 'skS', 'mv', 'col', 'rng', 'srch', 'res', 'idx', 'ln'],
  ru: ['mv', 'col', 'rng', 'idx'],
  pl: ['mv', 'col', 'rng', 'idx', 'ln'],
};
const LOCALES = Object.keys(CHANGED);
// Words that read correctly after a number for every count.
const AFTER_COUNT: Record<string, string[]> = {
  en: [
    'file(s)',
    'snapshot(s)',
    'sticky note(s)',
    'line(s)',
    'result(s)',
    'found',
    'sticky or document snapshot(s)',
    'matching snapshot(s)',
  ],
  de: ['gefunden', 'Notizzettel'],
  fr: ['trouvé(s)', 'pense-bête(s)'],
  es: ['nota(s) adhesiva(s)'],
  it: ['file', 'post-it'],
  'pt-BR': ['nota(s) adesiva(s)'],
};

function countIsNumberNeutral(locale: string, template: string): boolean {
  const at = template.indexOf('{count}');
  if (at < 0) {
    return false;
  }
  const rest = template.slice(at + '{count}'.length);
  if (rest === '' || /^[),.…]/.test(rest)) {
    return true;
  }
  return (AFTER_COUNT[locale] ?? []).some((word) => {
    if (!rest.startsWith(` ${word}`)) {
      return false;
    }
    const next = rest.slice(word.length + 1, word.length + 2);
    return next === '' || !/[\p{L}(]/u.test(next);
  });
}

function preSlice(locale: string, key: string): string {
  return OLD_SHIPPED[locale]?.[key] ?? current(locale)[key] ?? '';
}

describe('count strings read correctly for every count', () => {
  for (const locale of LOCALES) {
    for (const [name, key] of Object.entries(COUNT_KEYS)) {
      const listed = CHANGED[locale]?.includes(name as keyof typeof COUNT_KEYS);
      it(`${locale} ${key} (old value ${listed ? 'red' : 'green'})`, () => {
        expect(countIsNumberNeutral(locale, preSlice(locale, key))).toBe(
          !listed,
        );
      });
      it(`${locale} ${key} (now)`, () => {
        expect(countIsNumberNeutral(locale, current(locale)[key] ?? '')).toBe(
          true,
        );
      });
    }
  }

  it('the old-values table covers exactly the changed pairs', () => {
    for (const locale of LOCALES) {
      const covered = NINE.filter((key) => OLD_SHIPPED[locale]?.[key]);
      const expected = (CHANGED[locale] ?? []).map((n) => COUNT_KEYS[n]);
      expect(covered.sort(), locale).toEqual([...expected].sort());
    }
  });
});
// Plural-only wording taken from the old values.
const DENYLIST: Record<string, string> = {
  en: 'them',
  de: 'die Dateien',
  fr: 'les fichiers',
  es: 'Ábrelos',
  it: 'Riaprili',
  'pt-BR': 'os arquivos',
  ru: 'Откройте файлы',
  pl: 'Otwórz pliki',
  tr: 'dosyaları',
  vi: 'các tệp',
};

describe('doc.restoreUnreadable reads correctly for one or several names', () => {
  for (const [locale, bad] of Object.entries(DENYLIST)) {
    it(locale, () => {
      const old = OLD_SHIPPED[locale]?.['doc.restoreUnreadable'] ?? '';
      const now = current(locale)['doc.restoreUnreadable'] ?? '';
      expect(old).toContain(bad);
      expect(now).not.toBe(old);
      expect(now).not.toContain(bad);
      expect(now).toContain(': {names}');
    });
  }
});

describe('the old-values table', () => {
  it('holds only values that are no longer shipped', () => {
    for (const [locale, pairs] of Object.entries(OLD_SHIPPED)) {
      for (const [key, old] of Object.entries(pairs)) {
        expect(current(locale)[key], `${locale} ${key}`).not.toBe(old);
      }
    }
  });

  it('matches REWORDED in locale_store.rs', () => {
    const rust = Object.values(rustSource)[0] ?? '';
    expect(rust).not.toBe('');
    let total = 0;
    for (const [locale, pairs] of Object.entries(OLD_SHIPPED)) {
      for (const [key, old] of Object.entries(pairs)) {
        total += 1;
        const row = `(${JSON.stringify(locale)}, ${JSON.stringify(key)}, ${JSON.stringify(old)}),`;
        expect(rust, `${locale} ${key}`).toContain(row);
      }
    }
    const block = rust.slice(rust.indexOf('const REWORDED'));
    const rows = block.slice(0, block.indexOf('];')).split('\n');
    expect(rows.filter((r) => /^ {2}\(".*"\),$/.test(r)).length).toBe(total);
  });
});
