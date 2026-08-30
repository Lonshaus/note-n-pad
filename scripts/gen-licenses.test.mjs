// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Guards the one thing about src-tauri/resources/licenses.json that its Rust
// tests cannot see: whether it is still current. Those tests check the file is
// internally consistent (every package has a licence text, every index is in
// range) — all of which stays true forever after the dependency tree moves on
// without it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lockfileDigests } from './gen-licenses.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_FILE = path.join(
  REPO_ROOT,
  'src-tauri',
  'resources',
  'licenses.json',
);

describe('licenses.json freshness', () => {
  it('was generated from the lockfiles currently in the repo', () => {
    const { inputs } = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    expect(
      inputs,
      'src-tauri/resources/licenses.json is stale: a dependency changed since it ' +
        'was generated. Run `npm run licenses` and commit the result.',
    ).toEqual(lockfileDigests());
  });
});
