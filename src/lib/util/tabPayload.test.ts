// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A tab packed as plain data and unpacked in another window, for every kind of
// tab, and the rule that no field of a tab is left out by accident.

import { describe, expect, it, vi } from 'vitest';
import { Text } from '@codemirror/state';
import {
  DocumentWindowState,
  type DocTab,
} from '../state/documentWindow.svelte';
import { SNAPSHOT_CONTENT_MAX } from './snapshotPolicy';
import { textFromString } from './text';
import {
  COPIED_KEYS,
  RESET_KEYS,
  fromPayload,
  toPayload,
  type TabPayload,
} from './tabPayload';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.stubGlobal('window', globalThis);

type Extras = Parameters<typeof toPayload>[1];
const NO_EXTRAS: Extras = {
  editor: null,
  scroll: null,
  view: null,
  viewMode: null,
};
/** An ordinary tab, clean unless `over` says otherwise. */
function tab(over: Partial<DocTab> = {}): DocTab {
  const content = textFromString('hello\nworld');
  return {
    id: 'a',
    path: '/p/a.txt',
    readOnlyFile: false,
    content,
    savedContent: content,
    language: null,
    explicit: false,
    lineEnding: 'LF',
    savedLineEnding: 'LF',
    hadBom: false,
    encoding: 'UTF-8',
    lossy: false,
    tabIndex: 4,
    order: 2.5,
    ...over,
  };
}
const FINGERPRINT = { size: 100, mtime_ms: 5 };
const WINDOWED = {
  sessionId: 7,
  totalBytes: 100,
  totalLines: 9,
  fingerprint: FINGERPRINT,
  dirty: true,
  topLine: 3,
};
/** Through the wire: what the receiver reads of the sender's payload. */
function sent(payload: TabPayload): TabPayload {
  return JSON.parse(JSON.stringify(payload)) as TabPayload;
}
const win = new DocumentWindowState();
/** What the receiver builds from `source`, with the extras given. */
function arrives(source: DocTab, extras = NO_EXTRAS) {
  const payload = sent(toPayload(source, extras));
  return { payload, tab: fromPayload(payload) as DocTab };
}
/** The fields every kind of tab keeps through a move. */
function expectSame(received: DocTab, source: DocTab): void {
  expect(received.id).toBe(source.id);
  expect(received.path).toBe(source.path);
  expect(received.readOnlyFile).toBe(source.readOnlyFile);
  expect(received.content.toString()).toBe(source.content.toString());
  expect(received.savedContent.toString()).toBe(source.savedContent.toString());
  expect(received.language).toBe(source.language);
  expect(received.explicit).toBe(source.explicit);
  expect(received.lineEnding).toBe(source.lineEnding);
  expect(received.savedLineEnding).toBe(source.savedLineEnding);
  expect(received.hadBom).toBe(source.hadBom);
  expect(received.encoding).toBe(source.encoding);
  expect(received.lossy).toBe(source.lossy);
  expect(received.large).toEqual(source.large);
  expect(received.windowed).toEqual(source.windowed);
  expect(received.windowedRestore).toEqual(source.windowedRestore);
  expect(received.converted).toEqual(source.converted);
  expect(received.missing).toBe(source.missing);
  expect(received.insertLineEnding).toBe(source.insertLineEnding);
  expect(win.isDirty(received)).toBe(win.isDirty(source));
}

describe('a tab of every kind through a move', () => {
  it('an ordinary clean tab stays clean and shares one rope again', () => {
    const source = tab();
    const { tab: received } = arrives(source);
    expectSame(received, source);
    expect(win.isDirty(received)).toBe(false);
    expect(received.savedContent).toBe(received.content);
  });

  it('an ordinary dirty tab stays dirty with both texts', () => {
    const source = tab({
      content: textFromString('hello!\nworld'),
      savedContent: textFromString('hello\nworld'),
      lineEnding: 'CRLF',
      savedLineEnding: 'LF',
      encoding: 'Big5',
      hadBom: true,
      lossy: true,
      readOnlyFile: true,
      language: 'JavaScript',
      explicit: true,
    });
    const { tab: received, payload } = arrives(source);
    expectSame(received, source);
    expect(win.isDirty(received)).toBe(true);
    expect(payload.tab.savedContent).toBe('hello\nworld');
    expect(payload.tab.savedIsContent).toBe(false);
  });

  it('a clean tab sends no second copy of its text', () => {
    const { payload } = arrives(tab());
    expect(payload.tab.savedContent).toBeUndefined();
    expect(payload.tab.savedIsContent).toBe(true);
  });

  it('a dirty tab over the snapshot ceiling keeps its whole text', () => {
    const big = 'x'.repeat(SNAPSHOT_CONTENT_MAX + 1);
    const source = tab({
      content: textFromString(big),
      savedContent: Text.empty,
    });
    const { tab: received } = arrives(source);
    expect(received.content.length).toBe(SNAPSHOT_CONTENT_MAX + 1);
    expect(win.isDirty(received)).toBe(true);
  });

  it('a large read-only tab keeps its size and the reason it cannot be unlocked', () => {
    const source = tab({
      content: Text.empty,
      savedContent: Text.empty,
      large: { size: 300_000_000, unlockRefused: 'not UTF-8' },
    });
    const { tab: received } = arrives(source);
    expectSame(received, source);
    expect(received.large).toEqual({
      size: 300_000_000,
      unlockRefused: 'not UTF-8',
    });
    expect(win.isDirty(received)).toBe(false);
  });

  it('a windowed tab with unsaved edits keeps its session and its dirty flag', () => {
    const source = tab({
      content: Text.empty,
      savedContent: Text.empty,
      insertLineEnding: '\r\n',
      lineEnding: 'CRLF',
      savedLineEnding: 'CRLF',
      windowed: { ...WINDOWED },
    });
    const { tab: received } = arrives(source);
    expectSame(received, source);
    expect(received.windowed?.sessionId).toBe(7);
    expect(win.isDirty(received)).toBe(true);
  });

  it('a pending windowed restore keeps what the restore needs', () => {
    const source = tab({
      content: Text.empty,
      savedContent: Text.empty,
      windowedRestore: {
        index: { checkpoints: [[0, 0]], total_newlines: 9, line_rule: 1 },
        fingerprint: FINGERPRINT,
        digest: '123456789012345678',
        topLine: 4,
        size: 100,
      },
    });
    const { tab: received } = arrives(source);
    expectSame(received, source);
    expect(received.windowedRestore?.digest).toBe('123456789012345678');
  });

  it('an unsaved converted tab from a sticky keeps the sticky it came from', () => {
    const source = tab({
      path: '',
      content: Text.empty,
      savedContent: Text.empty,
      windowed: { ...WINDOWED },
      converted: {
        target: null,
        encoding: 'UTF-8',
        bom: false,
        origin: 'sticky',
        noteId: 'sticky-1',
        saved: false,
      },
    });
    const { tab: received } = arrives(source);
    expectSame(received, source);
    expect(received.converted?.noteId).toBe('sticky-1');
    expect(received.converted?.saved).toBe(false);
  });

  it('a tab converted in place keeps the target it writes to', () => {
    const source = tab({
      content: Text.empty,
      savedContent: Text.empty,
      windowed: { ...WINDOWED, dirty: false },
      converted: {
        target: '/p/a.txt',
        encoding: 'Shift_JIS',
        bom: false,
        origin: 'document',
        saved: true,
      },
    });
    const { tab: received } = arrives(source);
    expectSame(received, source);
    expect(received.converted?.target).toBe('/p/a.txt');
  });

  it('a missing tab stays marked missing', () => {
    const source = tab({
      content: textFromString('edits'),
      savedContent: Text.empty,
      missing: true,
    });
    expectSame(arrives(source).tab, source);
  });

  it('carries the view position and the view mode', () => {
    const view = { top: 12, caretLine: 40, caretCol: 3 };
    const { payload } = arrives(tab(), {
      editor: null,
      scroll: { pos: 5, yMargin: 2, scrollLeft: 0 },
      view,
      viewMode: 'markdown',
    });
    expect(payload.view).toEqual(view);
    expect(payload.viewMode).toBe('markdown');
    expect(payload.scroll).toEqual({ pos: 5, yMargin: 2, scrollLeft: 0 });
  });
});

describe('what a move leaves behind', () => {
  it('copies no key of the window or of what the window was doing with the tab', () => {
    const source = tab({
      transferring: true,
      released: true,
      inFlight: 2,
      closing: true,
      handingOver: true,
      writeFailed: true,
    });
    const received = arrives(source).tab as DocTab;
    for (const key of RESET_KEYS) {
      expect(key in received, key).toBe(false);
    }
  });

  it('lists every key of a tab as copied or reset', () => {
    // Every key is set: a key added to `DocTab` fails the type of this object
    // first, and then the list below until it is placed.
    const full: Required<DocTab> = {
      id: 'a',
      path: '/p/a.txt',
      readOnlyFile: true,
      content: textFromString('a'),
      savedContent: textFromString('b'),
      language: 'X',
      explicit: true,
      lineEnding: 'CRLF',
      savedLineEnding: 'LF',
      insertLineEnding: '\r\n',
      hadBom: true,
      encoding: 'Big5',
      lossy: true,
      tabIndex: 1,
      order: 1,
      large: { size: 1 },
      windowed: { ...WINDOWED },
      windowedRestore: {
        index: null,
        fingerprint: FINGERPRINT,
        digest: '1',
        topLine: 0,
        size: 1,
      },
      writeFailed: true,
      missing: true,
      converted: {
        target: null,
        encoding: 'UTF-8',
        bom: false,
        origin: 'untitled',
        saved: false,
      },
      inFlight: 1,
      closing: true,
      transferring: true,
      released: true,
      handingOver: true,
    };
    expect(Object.keys(full).sort()).toEqual(
      [...COPIED_KEYS, ...RESET_KEYS].sort(),
    );
    const received = arrives(full).tab;
    for (const key of COPIED_KEYS) {
      expect(key in received, key).toBe(true);
    }
  });
});
