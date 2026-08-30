// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { languages } from '@codemirror/language-data';
import { fileExtension } from '../editor/language';

/** Extensions the CodeMirror registry does not give us correctly.
 *  CSV/TSV are display-only pseudo-languages with no CM mode of their own
 *  (matching the labels in language.ts). Python is a genuine registry quirk:
 *  its `extensions` lead with Bazel's `BUILD`, so the first entry would save a
 *  Python file as `Untitled.BUILD`. A registry-wide audit found Python to be
 *  the only entry whose first extension is not the canonical one; every other
 *  anomaly is an empty list, which already falls through to txt. */
const EXTENSION_OVERRIDES: Record<string, string> = {
  CSV: 'csv',
  TSV: 'tsv',
  Python: 'py',
};

/** Extension (no dot) a language name should save as, derived from the same
 *  CodeMirror registry `detectByFilename` reads (single source of truth).
 *  No language (a plain sticky, or an unrecognized name) falls back to txt. */
export function extensionForLanguage(language: string | null): string {
  if (language === null) {
    return 'txt';
  }
  const override = EXTENSION_OVERRIDES[language];
  if (override !== undefined) {
    return override;
  }
  const desc = languages.find((l) => l.name === language);
  return desc?.extensions[0] ?? 'txt';
}

/** The filename a save dialog should start from, given the path a tab already
 *  has. Empty (an untitled tab, or a range tab with no path of its own) falls
 *  back to a neutral name that `saveDialogOptions` then extends. */
export function suggestedName(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? '';
  return base === '' ? 'Untitled' : base;
}

/** Save-dialog options for a note of the given language: a default filename
 *  carrying the right extension, so a plain sticky saved as "測試結果" lands as
 *  `測試結果.txt` instead of an extensionless file. `suggestedName` is left
 *  untouched when it already carries an extension (an existing document's own
 *  name on Save As), so the language's extension is never double-appended.
 *
 *  Deliberately no `filters`: this editor opens and saves anything, and a
 *  filter list would both constrain what the user can type and put an
 *  untranslatable "All Files" label in front of them. */
export function saveDialogOptions(
  language: string | null,
  suggestedName: string,
): { defaultPath: string } {
  const defaultPath =
    fileExtension(suggestedName) !== null
      ? suggestedName
      : `${suggestedName}.${extensionForLanguage(language)}`;
  return { defaultPath };
}
