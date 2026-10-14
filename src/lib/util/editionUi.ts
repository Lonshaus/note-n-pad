// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

/** Which parts of the settings, language and large-file screens exist in an
 *  edition. One place decides, so the screens only read it. Lite has no theme
 *  choice, no worker highlighting (syntax is gone), no large-file open
 *  settings, no way to start editing a large file or to open a range of it for
 *  editing, no workspace to open at startup, and no way to import, export or
 *  delete a language; editing a language and restoring its default stay. */
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
