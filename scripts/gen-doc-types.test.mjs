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

describe('Info.lite.plist document types', () => {
  const liteConf = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, 'src-tauri', 'tauri.lite.conf.json'),
      'utf8',
    ),
  );
  const litePlist = fs.readFileSync(
    path.join(REPO_ROOT, 'src-tauri', 'Info.lite.plist'),
    'utf8',
  );

  it('is up to date with the Lite association list', () => {
    // Adding an extension to tauri.lite.conf.json without running
    // `node scripts/gen-doc-types.mjs --lite` fails here.
    expect(readDocTypes(litePlist)).toBe(buildDocTypes(liteConf));
  });

  it('declares exactly the kept extensions, each once', () => {
    const declared = [
      ...readDocTypes(litePlist).matchAll(
        /<key>CFBundleTypeExtensions<\/key>\n\s*<array>([\s\S]*?)<\/array>/g,
      ),
    ].flatMap((m) => [...m[1].matchAll(/<string>([^<]+)</g)].map((e) => e[1]));
    expect(declared.sort()).toEqual(
      [
        ...['txt', 'text', 'log', 'conf', 'ini', 'cfg', 'mbox'],
        ...['md', 'markdown', 'mkd'],
        ...['csv', 'tsv'],
      ].sort(),
    );
  });

  it('only narrows the full list: nothing the full app lacks', () => {
    const full = new Set(conf.bundle.fileAssociations.flatMap((a) => a.ext));
    for (const association of liteConf.bundle.fileAssociations) {
      for (const ext of association.ext) {
        expect(full.has(ext), ext).toBe(true);
      }
    }
  });

  it('holds nothing but the document types, so the base keeps the rest', () => {
    // Merged after the base plist, it replaces only the keys it names.
    const keys = [...litePlist.matchAll(/^ {4}<key>([^<]+)<\/key>/gm)].map(
      (m) => m[1],
    );
    expect(keys).toEqual(['CFBundleDocumentTypes']);
    expect(litePlist).not.toContain('CFBundleLocalizations');
  });

  it('is what the Lite config merges, after the base plist', () => {
    expect(liteConf.bundle.macOS.infoPlist).toBe('Info.lite.plist');
  });
});

describe('the Lite bundle config', () => {
  const liteConf = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, 'src-tauri', 'tauri.lite.conf.json'),
      'utf8',
    ),
  );

  it('has its own identity and the shared version', () => {
    expect(liteConf.productName).toBe('Note&Pad Lite');
    expect(liteConf.mainBinaryName).toBe('Note&Pad Lite');
    expect(liteConf.identifier).toBe('net.lonshaus.note-n-pad-lite');
    expect(liteConf.identifier).not.toBe(conf.identifier);
    expect(liteConf.version).toBe(conf.version);
    expect(liteConf.version).toBe('1.1.0');
  });

  it('builds the frontend as Lite', () => {
    expect(liteConf.build.beforeBuildCommand).toBe(
      'NOTENPAD_LITE=1 npm run build',
    );
  });

  it('uses its own icon folder, with the file names of the full set', () => {
    expect(liteConf.bundle.icon).toEqual(
      conf.bundle.icon.map((file) => file.replace('icons/', 'icons-lite/')),
    );
  });

  it('ships the Lite policy folder and not the full one', () => {
    expect(liteConf.bundle.resources['resources/privacy-lite/*']).toBe(
      'privacy-lite/',
    );
    expect(liteConf.bundle.resources['resources/privacy/*']).toBeNull();
    expect(conf.bundle.resources['resources/privacy/*']).toBe('privacy/');
  });
});
