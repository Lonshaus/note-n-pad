// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The hook file is generated, committed, and read by the bundler at build time,
// so nothing at build time notices when it drifts from the association list.
// Adding an extension without regenerating would leave that extension's registry
// key orphaned on uninstall, which is exactly the bug the hook exists to fix.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildHook, extensionPairs } from './gen-nsis-hooks.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json');
const HOOK_FILE = path.join(
  REPO_ROOT,
  'src-tauri',
  'windows',
  'uninstall-cleanup.nsh',
);

const conf = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

describe('uninstall-cleanup.nsh', () => {
  it('is up to date with the association list', () => {
    expect(fs.readFileSync(HOOK_FILE, 'utf8')).toBe(buildHook(conf));
  });

  it('covers every declared extension exactly once', () => {
    const covered = [
      ...fs
        .readFileSync(HOOK_FILE, 'utf8')
        .matchAll(/NotePadCleanExt "([^"]+)"/g),
    ].map((m) => m[1]);
    expect(covered).toEqual(extensionPairs(conf).map(([ext]) => ext));
  });

  it('is wired into the bundler', () => {
    expect(conf.bundle.windows?.nsis?.installerHooks).toBe(
      'windows/uninstall-cleanup.nsh',
    );
  });

  it('still matches the install mode the hook assumes', () => {
    // The hook writes HKCU. Tauri's default is a per-user install; switching to
    // perMachine would move the keys to HKLM and silently stop the cleanup.
    const mode = conf.bundle.windows?.nsis?.installMode;
    expect(mode === undefined || mode === 'currentUser').toBe(true);
  });
});
