// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { appName, brandTemplate } from './brand';
import { translate } from '.';
import { en } from './en';
import { ja } from './ja';
import { zhTW } from './zh-TW';

const seeds = import.meta.glob<{ strings: Record<string, string> }>(
  '../../../src-tauri/resources/locales/*.json',
  { eager: true, import: 'default' },
);

// The three strings that name the app on the WebView side.
const NAMED_KEYS = [
  'skipped.windowHint',
  'settings.general.snapshotMoveBody',
  'acknowledgements.intro',
] as const;

describe('appName', () => {
  it('is Note&Pad Lite in the Lite build and Note&Pad otherwise', () => {
    expect(appName(true)).toBe('Note&Pad Lite');
    expect(appName(false)).toBe('Note&Pad');
    // This test build is not a Lite build.
    expect(appName()).toBe('Note&Pad');
  });
});

describe('brandTemplate', () => {
  it('turns every Note&Pad into Note&Pad Lite when lite', () => {
    expect(brandTemplate('Note&Pad and Note&Pad', true)).toBe(
      'Note&Pad Lite and Note&Pad Lite',
    );
  });

  it('leaves the template alone when not lite', () => {
    expect(brandTemplate('Note&Pad is here', false)).toBe('Note&Pad is here');
  });

  it('is idempotent', () => {
    const once = brandTemplate('Open Note&Pad', true);
    expect(brandTemplate(once, true)).toBe(once);
    expect(brandTemplate('Note&Pad Lite', true)).toBe('Note&Pad Lite');
  });

  it('moves a Turkish suffix to follow Lite, keeping the apostrophe it had', () => {
    for (const [before, after] of [
      ['Note&Pad’ten Çık', 'Note&Pad Lite’tan Çık'],
      ["Note&Pad'den", "Note&Pad Lite'tan"],
      ["Note&Pad'de görünmez", "Note&Pad Lite'ta görünmez"],
      ['Note&Pad’te', 'Note&Pad Lite’ta'],
      ['Note&Pad’i yeniden', 'Note&Pad Lite’ı yeniden'],
      ['Note&Pad’e', 'Note&Pad Lite’a'],
      ['Note&Pad’in', 'Note&Pad Lite’ın'],
      ['Note&Pad’nin', 'Note&Pad Lite’ın'],
      ['Note&Pad’le', 'Note&Pad Lite’la'],
      ["Note&Pad'la", "Note&Pad Lite'la"],
    ]) {
      expect(brandTemplate(before!, true), before).toBe(after);
      // Stable when applied again, and untouched in the full build.
      expect(brandTemplate(after!, true), after).toBe(after);
      expect(brandTemplate(before!, false), before).toBe(before);
    }
  });

  it('only remaps a whole known suffix', () => {
    expect(brandTemplate('Note&Pad’s', true)).toBe('Note&Pad Lite’s');
    expect(brandTemplate('Note&Pad’dene', true)).toBe('Note&Pad Lite’dene');
    expect(brandTemplate('Note&Pad’', true)).toBe('Note&Pad Lite’');
  });

  it('brands every Note&Pad in every string of every language, once', () => {
    const dictionaries: Record<string, string>[] = [
      zhTW,
      ja,
      en,
      ...Object.values(seeds).map((seed) => seed.strings),
    ];
    for (const strings of dictionaries) {
      for (const [key, raw] of Object.entries(strings)) {
        const branded = brandTemplate(raw, true);
        expect(branded, key).not.toMatch(/Note&Pad(?! Lite)/);
        expect(branded, key).not.toContain('Lite Lite');
        expect(brandTemplate(branded, true), key).toBe(branded);
      }
    }
  });

  it('turns the Turkish "Note&Pad\'de" of the snapshot message into "Lite\'ta"', () => {
    const tr = Object.entries(seeds).find(([path]) =>
      path.endsWith('/tr.json'),
    )![1].strings;
    expect(tr['settings.general.snapshotMoveBody']).toContain("Note&Pad'de");
    expect(
      brandTemplate(tr['settings.general.snapshotMoveBody']!, true),
    ).toContain("Note&Pad Lite'ta");
  });

  it('says Lite exactly once in the three named strings of every language', () => {
    const dictionaries: [string, Record<string, string>][] = [
      ['zh-TW', zhTW],
      ['ja', ja],
      ['en', en],
      ...Object.entries(seeds).map(
        ([path, seed]): [string, Record<string, string>] => [
          path,
          seed.strings,
        ],
      ),
    ];
    expect(dictionaries).toHaveLength(15);
    for (const [id, strings] of dictionaries) {
      for (const key of NAMED_KEYS) {
        const raw = strings[key];
        expect(raw, `${id} ${key}`).toContain('Note&Pad');
        const branded = brandTemplate(raw!, true);
        expect(branded, `${id} ${key}`).toContain('Note&Pad Lite');
        expect(branded, `${id} ${key}`).not.toContain('Lite Lite');
        expect(branded.split('Note&Pad').length, `${id} ${key}`).toBe(
          raw!.split('Note&Pad').length,
        );
        expect(branded.split('Note&Pad Lite').length, `${id} ${key}`).toBe(
          raw!.split('Note&Pad').length,
        );
      }
    }
  });
});

describe('t() in the Lite build', () => {
  it('brands the template but never a value put into it', () => {
    const text = translate(
      'doc.saveFailed',
      { name: 'Note&Pad.md', error: '/x/Note&Pad/y' },
      true,
    );
    expect(text).toContain('Note&Pad.md');
    expect(text).toContain('/x/Note&Pad/y');
    expect(text).not.toContain('Note&Pad Lite');
  });

  it('brands a template that names the app', () => {
    expect(translate('acknowledgements.intro', undefined, true)).toContain(
      'Note&Pad Lite',
    );
    expect(translate('acknowledgements.intro', undefined, false)).not.toContain(
      'Lite',
    );
  });
});
