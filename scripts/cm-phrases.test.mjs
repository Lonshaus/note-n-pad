// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Guards the CodeMirror phrase map: every phrase CodeMirror or our search
// panel looks up must have a translation key, and every key must exist in all
// 15 locales. The expected phrase list is extracted from the installed
// CodeMirror packages, so a package upgrade that adds a phrase fails here
// instead of silently showing English in a translated UI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '../src/lib/i18n/en';
import { ja } from '../src/lib/i18n/ja';
import { zhTW } from '../src/lib/i18n/zh-TW';
import { CM_PHRASE_KEYS, buildCmPhrases } from '../src/lib/editor/cmPhraseKeys';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(ROOT, 'src-tauri', 'resources', 'locales');
const CM_PACKAGES = ['search', 'view', 'language', 'autocomplete', 'commands'];
// Every call to `phrase(` or `.phrase(` in the source, as the raw text between
// the call's balanced parentheses plus every string literal found inside them
// (ternary branches and the two-argument `phrase(view, 'Find')` form included).
function phraseCalls(src) {
  const calls = [];
  const re = /\bphrase\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    const literals = [];
    while (i < src.length && depth > 0) {
      const c = src.charAt(i);
      if (c === '"' || c === "'") {
        let j = i + 1;
        let lit = '';
        while (j < src.length && src.charAt(j) !== c) {
          if (src.charAt(j) === '\\') {
            j++;
          }
          lit += src.charAt(j);
          j++;
        }
        literals.push(lit);
        i = j;
      } else if (c === '(') {
        depth++;
      } else if (c === ')') {
        depth--;
      }
      i++;
    }
    calls.push({ args: src.slice(start, i - 1), literals });
  }
  return calls;
}

function distSource(pkg) {
  return fs.readFileSync(
    path.join(ROOT, 'node_modules', '@codemirror', pkg, 'dist', 'index.js'),
    'utf8',
  );
}

const PANEL_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'lib', 'editor', 'searchPanel.ts'),
  'utf8',
);

const EXPECTED = new Set([
  ...CM_PACKAGES.flatMap((pkg) =>
    phraseCalls(distSource(pkg)).flatMap((c) => c.literals),
  ),
  ...phraseCalls(PANEL_SRC).flatMap((c) => c.literals),
]);

describe('CodeMirror phrase map', () => {
  it('covers every phrase CodeMirror and the search panel look up', () => {
    const missing = [...EXPECTED].filter((p) => !(p in CM_PHRASE_KEYS));
    expect(missing).toEqual([]);
  });

  it('extracts the ternary-only and two-argument phrases', () => {
    expect(EXPECTED.has('Unfold line')).toBe(true);
    expect(EXPECTED.has('Find')).toBe(true);
  });

  it('builds the map through the lookup', () => {
    const map = buildCmPhrases((key) => `<${key}>`);
    expect(map['Find']).toBe('<cm.find>');
    expect(Object.keys(map)).toEqual(Object.keys(CM_PHRASE_KEYS));
  });
});

describe('searchPanel.ts phrase calls', () => {
  const calls = phraseCalls(PANEL_SRC);

  it('passes every label as one string literal', () => {
    const bad = calls
      .filter((c) => !/^\s*'[^']*'\s*$/.test(c.args))
      .map((c) => c.args);
    // The helper definition forwards its parameter.
    expect(bad).toEqual(['s']);
  });

  it('carries the panel labels', () => {
    const literals = new Set(calls.flatMap((c) => c.literals));
    for (const label of [
      'Find',
      'Replace',
      'next',
      'previous',
      'all',
      'match case',
      'regexp',
      'by word',
      'in selection',
      'replace',
      'replace all',
      'close',
    ]) {
      expect(literals.has(label)).toBe(true);
    }
  });
});

describe('cm.* translations', () => {
  const keys = Object.values(CM_PHRASE_KEYS);
  const dicts = { 'zh-TW': zhTW, en, ja };
  for (const file of fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json'))) {
    const locale = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'),
    );
    dicts[locale.id] = locale.strings;
  }

  it('covers all 15 locales', () => {
    expect(Object.keys(dicts)).toHaveLength(15);
  });

  it.each(Object.keys(dicts))('%s has every cm key, non-empty', (id) => {
    const dict = dicts[id] ?? {};
    const blank = keys.filter((k) => (dict[k] ?? '').trim() === '');
    expect(blank).toEqual([]);
  });
});
