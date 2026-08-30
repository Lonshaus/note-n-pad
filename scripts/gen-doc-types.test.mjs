// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Info.plist is generated, committed, and merged into the bundle at build time,
// and it *replaces* the document types Tauri derives from the association list
// rather than adding to them. The block is deliberately empty: the app declares
// no file types on macOS, because a declared type is one LaunchServices can
// hand it as a default nobody asked for. Losing the empty block would silently
// restore all 214 of them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDocTypes, readDocTypes } from './gen-doc-types.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFO_FILE = path.join(REPO_ROOT, 'src-tauri', 'Info.plist');

const plist = fs.readFileSync(INFO_FILE, 'utf8');

describe('Info.plist document types', () => {
  it('is up to date with the generator', () => {
    expect(readDocTypes(plist)).toBe(buildDocTypes());
  });

  it('declares the key, so the derived block cannot win', () => {
    // The bundler builds its own CFBundleDocumentTypes from
    // bundle.fileAssociations and merges this file over the top. Dropping the
    // key here does not mean "no types"; it means Tauri's 214 survive.
    expect(plist).toContain('<key>CFBundleDocumentTypes</key>');
  });

  it('declares no type at all', () => {
    expect(readDocTypes(plist)).toBe(
      '    <key>CFBundleDocumentTypes</key>\n    <array></array>',
    );
    for (const key of [
      'CFBundleTypeName',
      'CFBundleTypeExtensions',
      'CFBundleTypeRole',
      'LSItemContentTypes',
      'LSHandlerRank',
    ]) {
      expect(plist).not.toContain(key);
    }
  });

  it('replaces a populated block rather than appending to it', () => {
    // The regression that matters: an earlier revision wrote one <dict> per
    // association. Regenerating over that file has to remove every one.
    const populated = [
      '  <dict>',
      '    <key>CFBundleDocumentTypes</key>',
      '    <array>',
      '      <dict>',
      '        <key>CFBundleTypeName</key>',
      '        <string>Plain Text Document</string>',
      '      </dict>',
      '    </array>',
      '  </dict>',
    ].join('\n');
    const rewritten = readDocTypes(populated);
    expect(rewritten).not.toBe(null);
    expect(rewritten).toContain('CFBundleTypeName');
  });

  it('leaves the localization keys alone', () => {
    expect(plist).toContain('<key>CFBundleLocalizations</key>');
    expect(plist).toContain('<key>CFBundleDevelopmentRegion</key>');
  });
});
