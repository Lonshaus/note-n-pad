// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Guards the promise the association list makes: every extension the bundler
 *  registers with the OS is one this app can actually open with the language it
 *  implies. The list is derived from CodeMirror's registry, so a registry update
 *  can silently add junk (`.1`-`.9` from Troff, the `BUILD` filename, the
 *  compound `cmake.in`) or drop a language out from under a declared extension.
 *  Neither shows up until a user double-clicks a file, which is far too late. */
import { describe, expect, it } from 'vitest';
import { languages } from '@codemirror/language-data';
// Read as text rather than an imported module so the assertions run against the
// bytes the bundler will read, with no chance of a resolver reshaping them.
import confSource from '../../../src-tauri/tauri.conf.json?raw';

const conf: {
  bundle: {
    fileAssociations: { ext: string[]; name: string; role: string }[];
  };
} = JSON.parse(confSource);

const groups = conf.bundle.fileAssociations;
const declared = groups.flatMap((group) => group.ext);

// Extensions we claim that CodeMirror's registry has no language for. They open
// as plain text, which is the whole product, and the tabular pair gets the
// table view. Anything else missing from the registry is a mistake.
const NO_LANGUAGE_NEEDED = ['txt', 'log', 'conf', 'csv', 'tsv'];

// Tauri's macOS bundler holds a hardcoded extension-to-UTI map. When a group
// contains any of these six extensions, the bundler writes an
// `LSItemContentTypes` key into that group's `CFBundleDocumentTypes` entry, and
// LaunchServices then discards every `CFBundleTypeExtensions` entry in that
// group, binding only the listed UTIs. A group that mixes a mapped extension
// with unmapped ones silently loses the unmapped ones on macOS. This list was
// measured by building a bundle with one group per extension and reading back
// `LSItemContentTypes` for each.
const UTI_MAPPED = ['txt', 'json', 'svg', 'xml', 'htm', 'html'];

// Extensions CodeMirror's registry does cover, but which are deliberately not
// claimed. Regenerating the list from the registry pulls every one of them back
// in, so they are pinned here with the reason attached.
const DELIBERATELY_EXCLUDED: Record<string, string> = {
  // Troff man-page sections. Matches every rotated log and numbered backup.
  1: 'too generic',
  2: 'too generic',
  3: 'too generic',
  4: 'too generic',
  5: 'too generic',
  6: 'too generic',
  7: 'too generic',
  8: 'too generic',
  9: 'too generic',
  // OpenPGP writes both of these as binary; only the armoured .asc is text.
  pgp: 'binary in practice',
  sig: 'binary in practice',
  // Microsoft Common Console documents — services.msc and friends. The only
  // language claiming it is MscGen, which also owns the unambiguous .mscgen and
  // .mscin, so nothing is lost. Measured on Windows 11: a per-user install that
  // claims .msc leaves the shell with no default handler for it, so a
  // double-click stops opening MMC and offers a chooser instead.
  msc: 'collides with a system file type',
};

describe('fileAssociations', () => {
  const known = new Set(
    languages.flatMap((l) => l.extensions.map((e) => e.toLowerCase())),
  );

  it('only claims extensions the editor supports', () => {
    const unsupported = declared.filter(
      (ext) => !known.has(ext) && !NO_LANGUAGE_NEEDED.includes(ext),
    );
    expect(unsupported).toEqual([]);
  });

  it('claims no extension twice', () => {
    expect(declared.length).toBe(new Set(declared).size);
  });

  it('keeps the deliberately excluded extensions out', () => {
    const reintroduced = declared
      .filter((ext) => ext in DELIBERATELY_EXCLUDED)
      .map((ext) => `${ext}: ${DELIBERATELY_EXCLUDED[ext]}`);
    expect(reintroduced).toEqual([]);
  });

  it('claims nothing the OS cannot match on', () => {
    // A bare number is a Troff man-page section, and matches every rotated log
    // and numbered backup on the machine. A dot means a compound suffix, which
    // neither Windows nor LaunchServices matches as an extension.
    const unmatchable = declared.filter(
      (ext) =>
        /^\d+$/.test(ext) || ext.includes('.') || ext !== ext.toLowerCase(),
    );
    expect(unmatchable).toEqual([]);
  });

  it('keeps UTI-mapped extensions in groups of their own', () => {
    const mixedGroups = groups
      .filter((group) => {
        const mappedCount = group.ext.filter((ext) =>
          UTI_MAPPED.includes(ext),
        ).length;
        return mappedCount > 0 && mappedCount < group.ext.length;
      })
      .map((group) => group.name);
    expect(mixedGroups).toEqual([]);
  });

  it('declares no mimeType', () => {
    // A mimeType widens a group's LSItemContentTypes, and every extension in a
    // group carrying that key stops binding. Note this does not buy back a
    // narrow claim: `txt` maps to public.plain-text on its own, and UTI
    // conformance is hierarchical, so the app is a handler for every type
    // conforming to plain text no matter what. Dropping mimeType is about
    // keeping the six mapped extensions from spreading, nothing more.
    for (const group of groups) {
      expect(group).not.toHaveProperty('mimeType');
    }
  });

  it('opens every claimed extension rather than viewing it', () => {
    for (const group of groups) {
      expect(group.role).toBe('Editor');
    }
  });

  it('namespaces every group name', () => {
    // `name` is the Windows ProgID, written straight into
    // HKCU\Software\Classes. A bare word like "Plain Text" or "Source Code"
    // sits in the same flat namespace as every other application's, so two
    // installers that both picked it overwrite each other. The user-facing
    // string is `description` — Explorer's Type column and macOS's Kind column
    // both ignore `name` — so there is no cost to spelling it out.
    for (const group of groups) {
      expect(group.name).toMatch(/^Lonshaus\.NoteNPad\./);
    }
  });
});
