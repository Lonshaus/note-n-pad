// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { extensionForLanguage } from '../util/saveDialog';
import { detectByFilename, languageInfos } from './language';
import { LITE_LANGUAGES } from './liteLanguages';

describe('the Lite language table', () => {
  it('equals the metadata of @codemirror/language-data, loaders aside', () => {
    // Failing here means the package changed: run scripts/gen-lite-languages.mjs.
    const fromPackage = languages.map((l) => ({
      name: l.name,
      alias: l.alias,
      extensions: l.extensions,
      filename: l.filename === undefined ? undefined : String(l.filename),
    }));
    const fromTable = LITE_LANGUAGES.map((l) => ({
      name: l.name,
      alias: l.alias,
      extensions: l.extensions,
      filename: l.filename === undefined ? undefined : String(l.filename),
    }));
    expect(fromTable).toEqual(fromPackage);
  });

  it('carries no loader', () => {
    for (const info of LITE_LANGUAGES) {
      expect(Object.keys(info).sort()).toEqual(
        info.filename === undefined
          ? ['alias', 'extensions', 'name']
          : ['alias', 'extensions', 'filename', 'name'],
      );
    }
  });

  it('is what the full build reads too (the package, in tests)', () => {
    expect(languageInfos).toBe(languages);
  });

  it('detects the same language from every path the package knows', () => {
    const paths = [
      ...languages.flatMap((l) => l.extensions.map((e) => `/a/file.${e}`)),
      ...languages.flatMap((l) =>
        l.extensions.map((e) => `/a/FILE.${e.toUpperCase()}`),
      ),
      '/a/Dockerfile',
      '/a/CMakeLists.txt',
      '/a/nginx.conf',
      '/a/Gemfile',
      '/a/PKGBUILD',
      '/a/data.csv',
      '/a/data.TSV',
      '/a/no-extension',
      '/a/.hidden',
      '/a/notes.txt',
    ];
    for (const path of paths) {
      expect(detectByFilename(path, LITE_LANGUAGES), path).toBe(
        detectByFilename(path),
      );
    }
  });

  it('matches a path the way CodeMirror does', () => {
    const paths = [
      ...languages.flatMap((l) => l.extensions.map((e) => `/a/file.${e}`)),
      'Dockerfile',
      'CMakeLists.txt',
      'nginx.conf',
      'BUILD',
      'Jenkinsfile',
    ];
    for (const path of paths) {
      const match = LanguageDescription.matchFilename(languages, path);
      expect(match, path).not.toBeNull();
      expect(detectByFilename(path, LITE_LANGUAGES), path).toBe(match?.name);
    }
  });

  it('detects what Lite acts on: Markdown and the tabular modes', () => {
    expect(detectByFilename('/a/x.md', LITE_LANGUAGES)).toBe('Markdown');
    expect(detectByFilename('/a/x.csv', LITE_LANGUAGES)).toBe('CSV');
    expect(detectByFilename('/a/x.tsv', LITE_LANGUAGES)).toBe('TSV');
  });

  it('gives a JSON sticky the json extension to save as', () => {
    expect(extensionForLanguage('JSON', LITE_LANGUAGES)).toBe('json');
    expect(extensionForLanguage('Python', LITE_LANGUAGES)).toBe('py');
    expect(extensionForLanguage(null, LITE_LANGUAGES)).toBe('txt');
  });

  it('suggests the same extension for every language as the package does', () => {
    for (const { name } of languages) {
      expect(extensionForLanguage(name, LITE_LANGUAGES), name).toBe(
        extensionForLanguage(name),
      );
    }
  });
});
