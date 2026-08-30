// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Only the compiled locales are complete by construction: `en.ts` and `ja.ts`
// are `satisfies`-checked against the master dictionary, so a missing key is a
// compile error. The bundled data locales have no such check, and `t()` falls
// back to English per key, so a key missing from one of them renders an English
// string in a non-English UI and fails nothing.
//
// This guards only what the app ships. Partial locales stay legitimate at
// runtime — a user import or a user edit may omit keys, and the per-key
// fallback is what makes that safe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { zhTW } from '../src/lib/i18n/zh-TW';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(REPO_ROOT, 'src-tauri', 'resources', 'locales');
const MASTER_KEYS = new Set(Object.keys(zhTW));
const FILES = fs
  .readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('bundled data locales', () => {
  it('ships some', () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(MASTER_KEYS.size).toBeGreaterThan(0);
  });

  it.each(FILES)('%s carries exactly the master key set', (file) => {
    const locale = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'),
    );
    const keys = Object.keys(locale.strings ?? {});
    const present = new Set(keys);
    expect({
      missing: [...MASTER_KEYS].filter((k) => !present.has(k)),
      extra: keys.filter((k) => !MASTER_KEYS.has(k)),
    }).toEqual({ missing: [], extra: [] });
  });

  // A key present but empty renders a blank label rather than falling back,
  // which reads as a broken UI instead of an untranslated one.
  it.each(FILES)('%s translates every key to a non-empty string', (file) => {
    const locale = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'),
    );
    const blank = Object.entries(locale.strings ?? {})
      .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
      .map(([k]) => k);
    expect(blank).toEqual([]);
  });
});
