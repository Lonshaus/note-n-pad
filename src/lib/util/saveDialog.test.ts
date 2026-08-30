// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  extensionForLanguage,
  saveDialogOptions,
  suggestedName,
} from './saveDialog';

describe('suggestedName', () => {
  it('uses the file name of a path', () => {
    expect(suggestedName('/Users/x/Desktop/報告.md')).toBe('報告.md');
    expect(suggestedName('C:\\Users\\x\\report.md')).toBe('report.md');
  });

  it('falls back to Untitled for a tab with no path', () => {
    expect(suggestedName('')).toBe('Untitled');
  });

  it('falls back to Untitled for a path ending in a separator', () => {
    expect(suggestedName('/Users/x/Desktop/')).toBe('Untitled');
  });
});

describe('extensionForLanguage', () => {
  it('falls back to txt when no language is set', () => {
    expect(extensionForLanguage(null)).toBe('txt');
  });

  it('resolves a known language to its registry extension', () => {
    expect(extensionForLanguage('JavaScript')).toBe('js');
    expect(extensionForLanguage('CSS')).toBe('css');
  });

  it('resolves the tabular pseudo-languages', () => {
    expect(extensionForLanguage('CSV')).toBe('csv');
    expect(extensionForLanguage('TSV')).toBe('tsv');
  });

  it('overrides the registry where its first extension is not canonical', () => {
    // The registry entry leads with Bazel's BUILD; a Python file must not save
    // as Untitled.BUILD.
    expect(extensionForLanguage('Python')).toBe('py');
  });

  it('falls back to txt for an unrecognized language name', () => {
    expect(extensionForLanguage('NotARealLanguage')).toBe('txt');
  });

  it('falls back to txt for a registry entry with no extensions', () => {
    expect(extensionForLanguage('MySQL')).toBe('txt');
  });
});

describe('saveDialogOptions', () => {
  it('defaults a plain-text sticky to a .txt filename', () => {
    expect(saveDialogOptions(null, 'Untitled').defaultPath).toBe(
      'Untitled.txt',
    );
  });

  it('uses the language extension when one is set', () => {
    expect(saveDialogOptions('JavaScript', 'Untitled').defaultPath).toBe(
      'Untitled.js',
    );
  });

  it('does not append to a name that already carries an extension', () => {
    expect(saveDialogOptions('JavaScript', 'report.md').defaultPath).toBe(
      'report.md',
    );
    expect(saveDialogOptions(null, 'notes.backup.txt').defaultPath).toBe(
      'notes.backup.txt',
    );
  });

  it('appends to a dotfile-style name, which carries no extension', () => {
    expect(saveDialogOptions(null, '.gitignore').defaultPath).toBe(
      '.gitignore.txt',
    );
  });
});
