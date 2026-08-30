// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Guards the shape contract between gen-licenses.mjs and the acknowledgements
// screen. The screen keys its inner loop by position now, but the data should
// not carry the duplicates that made that necessary: one package pointing at
// the same pooled text twice shows the reader the same licence twice, and it
// used to throw at render time and take all 338 entries down with it, leaving a
// blank screen. A render-time failure like that is invisible to
// component tests — Vitest compiles Svelte in SSR mode — so the guard lives on
// the data instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, 'src-tauri', 'resources', 'licenses.json'),
    'utf8',
  ),
);

const label = (p) => `${p.ecosystem}:${p.name}@${p.version}`;

describe('licenses.json render contract', () => {
  it('has packages to show', () => {
    expect(index.packages.length).toBeGreaterThan(0);
    expect(index.texts.length).toBeGreaterThan(0);
  });

  it('never points one package at the same licence text twice', () => {
    const offenders = index.packages
      .filter((p) => new Set(p.texts).size !== p.texts.length)
      .map((p) => `${label(p)} ${JSON.stringify(p.texts)}`);
    expect(offenders).toEqual([]);
  });

  it('gives every package a distinct name+version key', () => {
    const seen = new Set();
    const clashes = [];
    for (const p of index.packages) {
      if (seen.has(p.name + p.version)) {
        clashes.push(p.name + p.version);
      }
      seen.add(p.name + p.version);
    }
    expect(clashes).toEqual([]);
  });

  it('resolves every text index', () => {
    const bad = index.packages
      .filter((p) => p.texts.some((i) => index.texts[i] === undefined))
      .map(label);
    expect(bad).toEqual([]);
  });

  it('gives every package at least one licence text', () => {
    const empty = index.packages.filter((p) => p.texts.length === 0).map(label);
    expect(empty).toEqual([]);
  });
});
