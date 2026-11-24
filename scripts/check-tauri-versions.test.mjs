// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// No CI step runs the Tauri CLI, so a Dependabot update of only the npm package
// or only the crate would pass CI and fail at the first build.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkResult,
  readCrateVersions,
  readNpmVersions,
  tauriPairs,
} from './check-tauri-versions.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');
const SCRIPT = path.join(SCRIPT_DIR, 'check-tauri-versions.mjs');
const DIALOG_LINE =
  'tauri-plugin-dialog (v2.7.1) : @tauri-apps/plugin-dialog (v2.8.4)';

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('tauriPairs', () => {
  it('accepts a patch difference', () => {
    const pairs = tauriPairs(
      { '@tauri-apps/api': '2.12.4' },
      { tauri: ['2.12.5'] },
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.mismatch).toBe(false);
  });

  it('flags a minor difference on a plugin', () => {
    const pairs = tauriPairs(
      { '@tauri-apps/plugin-dialog': '2.8.4' },
      { 'tauri-plugin-dialog': ['2.7.1'] },
    );
    expect(pairs).toEqual([
      {
        npm: '@tauri-apps/plugin-dialog',
        npmVersion: '2.8.4',
        crate: 'tauri-plugin-dialog',
        crateVersions: ['2.7.1'],
        mismatch: true,
      },
    ]);
  });

  it('flags a major difference', () => {
    const pairs = tauriPairs(
      { '@tauri-apps/api': '3.0.0' },
      { tauri: ['2.12.5'] },
    );
    expect(pairs[0]?.mismatch).toBe(true);
  });

  it('pairs nothing when one side is missing or the name has no crate', () => {
    expect(
      tauriPairs(
        { '@tauri-apps/plugin-fs': '2.0.0', '@tauri-apps/cli': '2.12.4' },
        { 'tauri-plugin-opener': ['2.0.0'], tauri: ['2.12.5'] },
      ),
    ).toEqual([]);
  });

  it('flags a crate locked at two versions when one differs', () => {
    const pairs = tauriPairs(
      { '@tauri-apps/api': '2.12.4' },
      { tauri: ['2.12.5', '2.11.0'] },
    );
    expect(pairs[0]?.mismatch).toBe(true);
  });
});

describe('checkResult', () => {
  it('reports a mismatch in the CLI form with status 1', () => {
    const pairs = tauriPairs(
      { '@tauri-apps/plugin-dialog': '2.8.4' },
      { 'tauri-plugin-dialog': ['2.7.1'] },
    );
    expect(checkResult(pairs)).toEqual({ status: 1, lines: [DIALOG_LINE] });
  });

  it('passes matching pairs with status 0', () => {
    const pairs = tauriPairs(
      { '@tauri-apps/api': '2.12.4' },
      { tauri: ['2.12.5'] },
    );
    const result = checkResult(pairs);
    expect(result.status).toBe(0);
    expect(result.lines).toHaveLength(1);
  });

  it('fails when no pair was compared', () => {
    expect(checkResult([]).status).toBe(1);
  });
});

describe('readCrateVersions', () => {
  const lock =
    '[[package]]\nname = "tauri"\nversion = "2.12.5"\nsource = "x"\n\n' +
    '[[package]]\nname = "a"\nversion = "1.0.0"\n\n' +
    '[[package]]\nname = "a"\nversion = "2.0.0"\n';

  it('collects every locked version by name', () => {
    expect(readCrateVersions(lock)).toEqual({
      tauri: ['2.12.5'],
      a: ['1.0.0', '2.0.0'],
    });
  });

  it('accepts CRLF line endings', () => {
    expect(readCrateVersions(lock.replaceAll('\n', '\r\n'))).toEqual(
      readCrateVersions(lock),
    );
  });
});

describe('current tree', () => {
  it('pairs the API and the dialog plugin, both matching', () => {
    const lock = fs.readFileSync(
      path.join(REPO_ROOT, 'src-tauri', 'Cargo.lock'),
      'utf8',
    );
    const pairs = tauriPairs(
      readNpmVersions(REPO_ROOT),
      readCrateVersions(lock),
    );
    expect(pairs.map((pair) => [pair.npm, pair.crate])).toEqual([
      ['@tauri-apps/api', 'tauri'],
      ['@tauri-apps/plugin-dialog', 'tauri-plugin-dialog'],
    ]);
    for (const pair of pairs) {
      expect(pair.npmVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(pair.crateVersions.length).toBeGreaterThan(0);
      expect(pair.mismatch).toBe(false);
    }
  });
});

describe('script process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-tauri-'));
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exits 1 and prints the CLI-form line on a mismatch', () => {
    const pkgDir = path.join(
      root,
      'node_modules',
      '@tauri-apps',
      'plugin-dialog',
    );
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@tauri-apps/plugin-dialog': '^2' } }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ version: '2.8.4' }),
    );
    fs.writeFileSync(
      path.join(root, 'src-tauri', 'Cargo.lock'),
      '[[package]]\nname = "tauri-plugin-dialog"\nversion = "2.7.1"\n',
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(DIALOG_LINE);
  });

  it('exits 1 with a message when a declared package is not installed', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'check-tauri-'));
    try {
      fs.writeFileSync(
        path.join(bare, 'package.json'),
        JSON.stringify({ dependencies: { '@tauri-apps/api': '^2' } }),
      );
      fs.mkdirSync(path.join(bare, 'src-tauri'));
      fs.writeFileSync(
        path.join(bare, 'src-tauri', 'Cargo.lock'),
        '[[package]]\nname = "tauri"\nversion = "2.12.5"\n',
      );
      const result = run(bare);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        '@tauri-apps/api is declared in package.json but not installed',
      );
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('exits 0 on the repo', () => {
    expect(run().status).toBe(0);
  });
});
