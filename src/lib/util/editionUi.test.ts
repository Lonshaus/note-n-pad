// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { editionUi, editorTabsFor, shownEditorTab } from './editionUi';

describe('editionUi', () => {
  it('shows every removed control in full', () => {
    expect(Object.values(editionUi(false))).toEqual(
      Object.values(editionUi(false)).map(() => true),
    );
  });

  it('hides the large-file open settings in lite and shows them in full', () => {
    expect(editionUi(true).largeFileSettings).toBe(false);
    expect(editionUi(false).largeFileSettings).toBe(true);
  });

  it('hides the large-file unlock and "Edit this range" in lite, shows them in full', () => {
    expect(editionUi(true).largeUnlock).toBe(false);
    expect(editionUi(true).rangeEdit).toBe(false);
    expect(editionUi(false).largeUnlock).toBe(true);
    expect(editionUi(false).rangeEdit).toBe(true);
  });

  it('hides every removed control in lite', () => {
    const ui = editionUi(true);
    expect(Object.values(ui)).toEqual(Object.values(ui).map(() => false));
    expect(Object.keys(ui)).toEqual(Object.keys(editionUi(false)));
  });
});

describe('editor tabs', () => {
  it('lists the theme tab in full only', () => {
    expect(editorTabsFor(false)).toEqual(['general', 'theme']);
    expect(editorTabsFor(true)).toEqual(['general']);
  });

  it('falls back to the first tab when the edition lost the wanted one', () => {
    expect(shownEditorTab('theme', false)).toBe('theme');
    expect(shownEditorTab('theme', true)).toBe('general');
    expect(shownEditorTab('general', true)).toBe('general');
  });
});
