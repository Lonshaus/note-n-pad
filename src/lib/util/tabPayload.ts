// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A tab packed as plain data to move it to another window, and unpacked there.
// The text is a string; everything else is what the tab holds besides its place
// in a window. A tab is made of the keys listed here: a key of `DocTab` that is
// neither copied nor listed as reset fails the test of this module.

import type { Text } from '@codemirror/state';
import type { ConvertedTab, DocTab } from '../state/documentWindow.svelte';
import type { EditorJson, ScrollRecord } from '../editor/editorSeed';
import { textEq, textFromString } from './text';
import type { ViewMode } from './viewModes';
/** Where a windowed or large tab was last looking (the window state's `viewPos`). */
export interface ViewPos {
  top?: number;
  caretLine?: number;
  caretCol?: number;
}
/** The keys of `DocTab` a move copies. */
export const COPIED_KEYS = [
  'id',
  'path',
  'readOnlyFile',
  'content',
  'savedContent',
  'language',
  'explicit',
  'lineEnding',
  'savedLineEnding',
  'insertLineEnding',
  'hadBom',
  'encoding',
  'lossy',
  'large',
  'windowed',
  'windowedRestore',
  'missing',
  'converted',
] as const satisfies readonly (keyof DocTab)[];
/** The keys of `DocTab` that belong to the window the tab is in, or to what the
 *  window is doing with it: the receiver gives its own or starts them fresh. */
export const RESET_KEYS = [
  'tabIndex',
  'order',
  'transferring',
  'released',
  'inFlight',
  'closing',
  'handingOver',
  'writeFailed',
] as const satisfies readonly (keyof DocTab)[];
/** `DocTab` as plain data. `savedContent` is there only when it differs from
 *  `content`; `savedIsContent` says it does not. */
export interface TabData {
  id: string;
  path: string;
  readOnlyFile: boolean;
  content: string;
  savedContent?: string;
  savedIsContent: boolean;
  language: string | null;
  explicit: boolean;
  lineEnding: DocTab['lineEnding'];
  savedLineEnding: DocTab['savedLineEnding'];
  insertLineEnding?: '\r\n' | '\n';
  hadBom: boolean;
  encoding: string;
  lossy: boolean;
  large?: NonNullable<DocTab['large']>;
  windowed?: NonNullable<DocTab['windowed']>;
  windowedRestore?: NonNullable<DocTab['windowedRestore']>;
  missing?: boolean;
  converted?: ConvertedTab;
}
/** What a tab on its way carries. */
export interface TabPayload {
  tab: TabData;
  /** The editor's selection and history, when it had them for this text. */
  editor: EditorJson | null;
  scroll: ScrollRecord | null;
  /** A windowed or large tab's place. */
  view: ViewPos | null;
  viewMode: ViewMode | null;
}
/** A tab as a window builds it, before the window gives it its place. */
export type UnplacedTab = Omit<DocTab, 'tabIndex' | 'order'>;
/** A plain deep copy of data that holds only JSON values. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
/** Pack `tab` with what its editor and its window keep for it. */
export function toPayload(
  tab: DocTab,
  extras: {
    editor: EditorJson | null;
    scroll: ScrollRecord | null;
    view: ViewPos | null;
    viewMode: ViewMode | null;
  },
): TabPayload {
  const same = textEq(tab.content, tab.savedContent);
  const data: TabData = {
    id: tab.id,
    path: tab.path,
    readOnlyFile: tab.readOnlyFile,
    content: tab.content.toString(),
    savedIsContent: same,
    language: tab.language,
    explicit: tab.explicit,
    lineEnding: tab.lineEnding,
    savedLineEnding: tab.savedLineEnding,
    hadBom: tab.hadBom,
    encoding: tab.encoding,
    lossy: tab.lossy,
  };
  if (!same) {
    data.savedContent = tab.savedContent.toString();
  }
  if (tab.insertLineEnding !== undefined) {
    data.insertLineEnding = tab.insertLineEnding;
  }
  if (tab.large !== undefined) {
    data.large = plain(tab.large);
  }
  if (tab.windowed !== undefined) {
    data.windowed = plain(tab.windowed);
  }
  if (tab.windowedRestore !== undefined) {
    data.windowedRestore = plain(tab.windowedRestore);
  }
  if (tab.missing !== undefined) {
    data.missing = tab.missing;
  }
  if (tab.converted !== undefined) {
    data.converted = plain(tab.converted);
  }
  return {
    tab: data,
    editor: extras.editor,
    scroll: extras.scroll,
    view: extras.view === null ? null : plain(extras.view),
    viewMode: extras.viewMode,
  };
}
/** Unpack a tab; the window that takes it gives it its `tabIndex` and `order`. */
export function fromPayload(payload: TabPayload): UnplacedTab {
  const data = payload.tab;
  const content: Text = textFromString(data.content);
  const tab: UnplacedTab = {
    id: data.id,
    path: data.path,
    readOnlyFile: data.readOnlyFile,
    content,
    savedContent:
      data.savedIsContent || data.savedContent === undefined
        ? content
        : textFromString(data.savedContent),
    language: data.language,
    explicit: data.explicit,
    lineEnding: data.lineEnding,
    savedLineEnding: data.savedLineEnding,
    hadBom: data.hadBom,
    encoding: data.encoding,
    lossy: data.lossy,
  };
  if (data.insertLineEnding !== undefined) {
    tab.insertLineEnding = data.insertLineEnding;
  }
  if (data.large !== undefined) {
    tab.large = plain(data.large);
  }
  if (data.windowed !== undefined) {
    tab.windowed = plain(data.windowed);
  }
  if (data.windowedRestore !== undefined) {
    tab.windowedRestore = plain(data.windowedRestore);
  }
  if (data.missing !== undefined) {
    tab.missing = data.missing;
  }
  if (data.converted !== undefined) {
    tab.converted = plain(data.converted);
  }
  return tab;
}
