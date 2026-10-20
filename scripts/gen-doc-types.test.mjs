// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Info.plist is generated, committed, and merged into the bundle at build time,
// and it *replaces* the document types Tauri derives from the association list
// rather than adding to them. So an extension added to tauri.conf.json without
// regenerating would keep working on Windows and Linux and silently not be
// declared on macOS at all.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDocTypes, contentTypes, readDocTypes } from './gen-doc-types.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json');
const INFO_FILE = path.join(REPO_ROOT, 'src-tauri', 'Info.plist');

const conf = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const plist = fs.readFileSync(INFO_FILE, 'utf8');

describe('Info.plist document types', () => {
  it('is up to date with the association list', () => {
    expect(readDocTypes(plist)).toBe(buildDocTypes(conf));
  });

  it('declares every extension exactly once, as the config does', () => {
    // Scoped to the generated block: CFBundleLocalizations is a list of bare
    // strings too, and counting those as extensions would hide a real gap.
    const declared = [
      ...readDocTypes(plist).matchAll(
        /<key>CFBundleTypeExtensions<\/key>\n\s*<array>([\s\S]*?)<\/array>/g,
      ),
    ].flatMap((m) => [...m[1].matchAll(/<string>([^<]+)</g)].map((e) => e[1]));
    const expected = conf.bundle.fileAssociations.flatMap((a) => a.ext);
    expect(declared).toEqual(expected);
  });

  it('shows a human-readable Kind, never the Windows ProgID', () => {
    // The whole point: macOS shows CFBundleTypeName as the Finder "Kind" for
    // any extension without a system UTI, so the identifier-shaped `name` must
    // not reach the plist.
    const names = [
      ...plist.matchAll(/<key>CFBundleTypeName<\/key>\n\s*<string>([^<]+)</g),
    ].map((m) => m[1]);
    expect(names).toEqual(
      conf.bundle.fileAssociations.map((a) => a.description),
    );
    for (const name of names) {
      expect(name).not.toMatch(/^Lonshaus\./);
    }
  });

  it('keeps the system UTIs of whichever extensions have one', () => {
    expect(contentTypes({ ext: ['txt'] })).toEqual(['public.plain-text']);
    expect(contentTypes({ ext: ['htm', 'html'] })).toEqual(['public.html']);
    expect(contentTypes({ ext: ['md', 'markdown'] })).toBeNull();
    expect(contentTypes({ ext: ['json', 'nope'] })).toEqual(['public.json']);
  });

  it('names a missing field instead of emitting a broken plist', () => {
    // `escapeXml(undefined)` would throw something unreadable, and an entry
    // with no role or description would otherwise reach the plist half-formed.
    const missing = {
      bundle: { fileAssociations: [{ ext: ['zz'], role: 'Editor' }] },
    };
    expect(() => buildDocTypes(missing)).toThrow(/description/);
    const noRole = {
      bundle: { fileAssociations: [{ ext: ['zz'], description: 'Z' }] },
    };
    expect(() => buildDocTypes(noRole)).toThrow(/role/);
  });

  it('leaves the localization keys alone', () => {
    expect(plist).toContain('<key>CFBundleLocalizations</key>');
    expect(plist).toContain('<key>CFBundleDevelopmentRegion</key>');
  });
});
