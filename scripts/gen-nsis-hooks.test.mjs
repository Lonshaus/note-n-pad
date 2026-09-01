// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The hook file is generated, committed, and read by the bundler at build time,
// so nothing at build time notices when it drifts from the association list.
// Adding an extension without regenerating would leave that extension's default
// claimed at install and its registry key orphaned on uninstall, which is exactly
// what the hooks exist to prevent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildHook,
  capabilityValues,
  extensionPairs,
} from './gen-nsis-hooks.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json');
const HOOK_FILE = path.join(
  REPO_ROOT,
  'src-tauri',
  'windows',
  'uninstall-cleanup.nsh',
);

const conf = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

/** The lines between `!macro <name>` and its `!macroend`. */
function hookBody(source, hook) {
  const start = source.indexOf(`!macro ${hook}\n`);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('!macroend', start));
}

describe('uninstall-cleanup.nsh', () => {
  it('is up to date with the association list', () => {
    expect(fs.readFileSync(HOOK_FILE, 'utf8')).toBe(buildHook(conf));
  });

  it.each([
    ['NSIS_HOOK_POSTINSTALL', 'NotePadOfferExt'],
    ['NSIS_HOOK_POSTUNINSTALL', 'NotePadCleanExt'],
  ])('covers every declared extension exactly once in %s', (hook, macro) => {
    const body = hookBody(fs.readFileSync(HOOK_FILE, 'utf8'), hook);
    const covered = [
      ...body.matchAll(new RegExp(`!insertmacro ${macro} "([^"]+)"`, 'g')),
    ].map((m) => m[1]);
    expect(covered).toEqual(extensionPairs(conf).map(([ext]) => ext));
  });

  // Without these the app is absent from Windows' Default apps list, and the
  // in-app shortcut to its page has nothing to open.
  it('registers the app capabilities, covering every declared extension', () => {
    const body = hookBody(
      fs.readFileSync(HOOK_FILE, 'utf8'),
      'NSIS_HOOK_POSTINSTALL',
    );
    const capabilities = `Software\\${conf.productName}\\Capabilities`;
    expect(capabilityValues(conf)).toEqual([
      [capabilities, 'ApplicationName', conf.productName],
      [capabilities, 'ApplicationDescription', conf.bundle.shortDescription],
      ...extensionPairs(conf).map(([ext, progId]) => [
        `${capabilities}\\FileAssociations`,
        `.${ext}`,
        progId,
      ]),
      ['Software\\RegisteredApplications', conf.productName, capabilities],
    ]);
    for (const [key, name, value] of capabilityValues(conf)) {
      expect(body).toContain(`WriteRegStr HKCU "${key}" "${name}" "${value}"`);
    }
  });

  it('removes the capabilities it wrote, and only those', () => {
    const body = hookBody(
      fs.readFileSync(HOOK_FILE, 'utf8'),
      'NSIS_HOOK_POSTUNINSTALL',
    );
    expect(body).toContain(
      `DeleteRegValue HKCU "Software\\RegisteredApplications" "${conf.productName}"`,
    );
    expect(body).toContain(
      `DeleteRegKey HKCU "Software\\${conf.productName}\\Capabilities"`,
    );
    // The parent key may hold something this hook never wrote, so it goes only
    // when nothing is left in it.
    expect(body).toContain(
      `DeleteRegKey /ifempty HKCU "Software\\${conf.productName}"`,
    );
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
