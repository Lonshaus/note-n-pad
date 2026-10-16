// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { featureRows } from './editionFeatures';
import { en } from '../i18n/en';
import { ja } from '../i18n/ja';
import { zhTW } from '../i18n/zh-TW';

const seeds = import.meta.glob<{ strings: Record<string, string> }>(
  '../../../src-tauri/resources/locales/*.json',
  { eager: true, import: 'default' },
);

const labels = (os: string): string[] => featureRows(os).map((r) => r.label);

describe('featureRows', () => {
  it('lists what only the full version has first, then what both have', () => {
    const rows = featureRows('macos');
    const firstShared = rows.findIndex((r) => r.lite);
    expect(rows.slice(0, firstShared).every((r) => !r.lite)).toBe(true);
    expect(rows.slice(firstShared).every((r) => r.lite)).toBe(true);
    expect(rows.slice(0, firstShared).map((r) => r.label)).toEqual([
      'edition.row.largeFiles',
      'edition.row.syntax',
      'edition.row.treeViews',
      'edition.row.themes',
      'edition.row.languageFiles',
      'edition.row.workspace',
    ]);
  });

  it('notes that files over 100 MB open in the ordinary editor', () => {
    const large = featureRows('windows').find(
      (r) => r.label === 'edition.row.largeFiles',
    );
    expect(large?.note).toBe('edition.row.largeFilesNote');
    expect(en['edition.row.largeFilesNote']).toContain('100 MB');
  });

  it('shows the Dock menu on macOS only', () => {
    expect(labels('macos')).toContain('edition.row.dockMenu');
    expect(labels('windows')).not.toContain('edition.row.dockMenu');
    expect(labels('linux')).not.toContain('edition.row.dockMenu');
  });

  it('shows the Jump List on Windows only', () => {
    expect(labels('windows')).toContain('edition.row.jumpList');
    expect(labels('macos')).not.toContain('edition.row.jumpList');
    expect(labels('linux')).not.toContain('edition.row.jumpList');
  });

  it('is otherwise the same on every platform, and never repeats a row', () => {
    const common = (os: string): string[] =>
      labels(os).filter(
        (l) => l !== 'edition.row.dockMenu' && l !== 'edition.row.jumpList',
      );
    expect(common('macos')).toEqual(common('windows'));
    expect(common('macos')).toEqual(common('linux'));
    for (const os of ['macos', 'windows', 'linux']) {
      expect(new Set(labels(os)).size).toBe(labels(os).length);
    }
  });

  it('keeps every shared feature of the Lite list and gives it no cross', () => {
    for (const label of [
      'edition.row.stickies',
      'edition.row.documents',
      'edition.row.markdown',
      'edition.row.table',
      'edition.row.interfaceMode',
      'edition.row.languageEdit',
      'edition.row.trayIcon',
      'edition.row.globalShortcuts',
      'sticky.pin.toApp',
      'sticky.paperColor',
    ]) {
      expect(featureRows('macos').find((r) => r.label === label)?.lite).toBe(
        true,
      );
    }
  });
});

describe('the strings the table uses', () => {
  const keys = [
    'edition.col.feature',
    'edition.col.lite',
    'edition.col.full',
    'edition.mark.yes',
    'edition.mark.no',
    ...new Set(
      ['macos', 'windows', 'linux'].flatMap((os) =>
        featureRows(os).flatMap((r) => [
          r.label,
          ...(r.note === undefined ? [] : [r.note]),
        ]),
      ),
    ),
  ];

  it('are in all 15 locales, none empty', () => {
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
      for (const key of keys) {
        expect(strings[key], `${id} ${key}`).toBeTruthy();
      }
    }
  });

  it('keep the format names as they are', () => {
    for (const strings of [zhTW, ja, en]) {
      expect(strings['edition.row.treeViews']).toContain('JSON');
      expect(strings['edition.row.treeViews']).toContain('XML');
      expect(strings['edition.row.markdown']).toContain('Markdown');
      expect(strings['edition.row.table']).toContain('CSV / TSV');
    }
    for (const seed of Object.values(seeds)) {
      expect(seed.strings['edition.row.table']).toContain('CSV / TSV');
      expect(seed.strings['edition.row.markdown']).toContain('Markdown');
    }
  });
});
