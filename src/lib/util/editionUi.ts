// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

/** Which parts of the settings, language and large-file screens exist in an
 *  edition. One place decides, so the screens only read it.
 *  `lite` is the free edition, a state of the one build until the full edition
 *  is bought.
 *  The free edition has no theme choice.
 *  The free edition has no worker highlighting, as syntax is gone.
 *  The free edition has no large-file settings.
 *  The free edition cannot start editing a large file.
 *  The free edition cannot open a range of a large file for editing.
 *  The free edition has no workspace to open at startup.
 *  The free edition cannot import, export or delete a language.
 *  Editing a language and restoring its default stay in the free edition. */
export interface EditionUi {
  themeTab: boolean;
  workerHighlight: boolean;
  largeFileSettings: boolean;
  largeUnlock: boolean;
  rangeEdit: boolean;
  openWorkspaceOnStartup: boolean;
  localeImport: boolean;
  localeDelete: boolean;
  localeUpdateFromJson: boolean;
  localeExport: boolean;
}

export function editionUi(lite: boolean): EditionUi {
  const full = !lite;
  return {
    themeTab: full,
    workerHighlight: full,
    largeFileSettings: full,
    largeUnlock: full,
    rangeEdit: full,
    openWorkspaceOnStartup: full,
    localeImport: full,
    localeDelete: full,
    localeUpdateFromJson: full,
    localeExport: full,
  };
}

/** The sub-tabs of Settings > Editor, in order. */
export type EditorTab = 'general' | 'theme';

export function editorTabsFor(lite: boolean): EditorTab[] {
  return editionUi(lite).themeTab ? ['general', 'theme'] : ['general'];
}

/** The tab to show: `wanted` if the edition has it, else the first one. */
export function shownEditorTab(wanted: EditorTab, lite: boolean): EditorTab {
  const tabs = editorTabsFor(lite);
  return tabs.includes(wanted) ? wanted : (tabs[0] ?? 'general');
}
