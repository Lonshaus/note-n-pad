// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The Lite edition's tab rules, driven through the real window state against a
// fake backend: a tab that needs a removed feature is kept (not opened, its
// record never written, rewritten or deleted), a file over 100 MB opens in the
// ordinary editor, and everything returns once the edition is full.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import type { NoteSnapshot } from './stickyNote.svelte';
import { settingsState } from './settings.svelte';
import { editionState } from './edition.svelte';
import { effectiveLanguage } from '../editor/language';
import {
  documentWindow,
  DocumentWindowState,
  LARGE_FILE_THRESHOLD,
  type DocTab,
  opensInLargeViewer,
} from './documentWindow.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
vi.stubGlobal('window', globalThis);

function note(over: Partial<NoteSnapshot>): NoteSnapshot {
  return {
    id: 'id',
    content: '',
    file_path: '/tmp/a.txt',
    language: null,
    explicit: false,
    x: null,
    y: null,
    width: null,
    height: null,
    pin_mode: 'none',
    pin_app: null,
    opacity: 1,
    paper: 'classic',
    kind: 'document',
    dirty: false,
    window_group: 'g',
    tab_index: 0,
    line_ending: 'LF',
    had_bom: false,
    encoding: 'UTF-8',
    project: null,
    large: null,
    range_source: null,
    range_start: null,
    range_end: null,
    range_fp_size: null,
    range_fp_mtime: null,
    range_start_line: null,
    range_end_line: null,
    range_trailing_break: null,
    windowed_index: null,
    windowed_fp_size: null,
    windowed_fp_mtime: null,
    windowed_digest: null,
    windowed_top_line: null,
    ...over,
  };
}

const SIZE = 200 * 1024 * 1024;
const stored = [
  note({ id: 'plain', tab_index: 0, file_path: '/tmp/plain.txt' }),
  note({ id: 'large', tab_index: 1, file_path: '/tmp/big.log', large: SIZE }),
  note({
    id: 'windowed',
    tab_index: 2,
    file_path: '/tmp/win.log',
    large: SIZE,
    windowed_index: { checkpoints: [[0, 0]], total_newlines: 3 },
    windowed_fp_size: SIZE,
    windowed_fp_mtime: 1,
    windowed_digest: '7',
  }),
  note({
    id: 'range',
    tab_index: 3,
    file_path: '',
    dirty: true,
    content: 'unsaved edit',
    range_source: '/tmp/big.log',
    range_start: 0,
    range_end: 10,
    range_fp_size: SIZE,
    range_fp_mtime: 1,
    range_start_line: 1,
    range_end_line: null,
    range_trailing_break: null,
  }),
];
const KEPT_IDS = ['large', 'windowed', 'range'];

/** Commands that touch a stored record. */
const WRITES = ['upsert_note', 'delete_note', 'drop_closed_tabs'];

function backend(over: Record<string, unknown> = {}): void {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(((cmd: string, args?: unknown) => {
    if (cmd in over) {
      const value = over[cmd];
      return typeof value === 'function'
        ? (value as (a?: unknown) => unknown)(args)
        : Promise.resolve(value);
    }
    switch (cmd) {
      case 'load_settings':
        return Promise.resolve({
          settings: {
            theme: 'x',
            interface_mode: 'system',
            editor_font_size: 14,
            editor_word_wrap: true,
            editor_line_numbers: true,
            worker_highlight: false,
            large_open_mode: 'ask',
            ask_long_line_open: false,
            preview_local_resources: false,
            open_target: 'tab',
            editor_font_family: '',
            default_line_ending: 'LF',
            default_encoding: 'UTF-8',
            new_note_shortcut: 'x',
            snapshot_dir: null,
            default_sticky_width: 280,
            default_sticky_height: 230,
            language: 'system',
            show_tray_icon: true,
            open_workspace_on_startup: false,
          },
          repaired_fields: [],
          snapshot_dir_unavailable: false,
        });
      case 'list_notes':
        return Promise.resolve(stored);
      case 'live_doc_groups':
        return Promise.resolve([]);
      case 'path_writable':
        return Promise.resolve(true);
      case 'read_file_as':
      case 'read_file_auto':
        return Promise.resolve({
          content: 'disk text',
          encoding: 'UTF-8',
          had_bom: false,
          lossy: false,
        });
      case 'read_range':
        return Promise.resolve({ text: 'range from disk' });
      case 'stat_file':
        return Promise.resolve({ size: SIZE });
      case 'windowed_reopen':
        return new Promise(() => {});
      default:
        return Promise.resolve(null);
    }
  }) as typeof invoke);
}

function writesTo(ids: string[]): unknown[][] {
  return mockInvoke.mock.calls.filter(([cmd, args]) => {
    if (!WRITES.includes(cmd)) {
      return false;
    }
    const a = args as {
      id?: string;
      ids?: string[];
      note?: { id: string };
    };
    return (
      ids.includes(a.id ?? '') ||
      ids.includes(a.note?.id ?? '') ||
      (a.ids ?? []).some((id) => ids.includes(id))
    );
  });
}

let readySpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The real `ready()` memoizes its first load across the whole file.
  readySpy = vi.spyOn(editionState, 'ready').mockResolvedValue();
  documentWindow.tabs.length = 0;
  documentWindow.ready = false;
  documentWindow.keptTabs = 0;
  documentWindow.restoreUnreadable = [];
  documentWindow.activeIndex = 0;
});

afterEach(() => {
  readySpy.mockRestore();
  editionState.lite = false;
});

describe('opensInLargeViewer', () => {
  it('is the 100 MB rule in full and never in lite', () => {
    expect(opensInLargeViewer(LARGE_FILE_THRESHOLD + 1, false)).toBe(true);
    expect(opensInLargeViewer(LARGE_FILE_THRESHOLD, false)).toBe(false);
    expect(opensInLargeViewer(LARGE_FILE_THRESHOLD + 1, true)).toBe(false);
    expect(opensInLargeViewer(10 * 1024 ** 3, true)).toBe(false);
  });
});

describe('a lite window restoring a group that holds kept tabs', () => {
  it('opens only the ordinary tab and counts the rest', async () => {
    editionState.lite = true;
    backend();
    await documentWindow.init('g', null, null);

    expect(documentWindow.tabs.map((t) => t.id)).toEqual(['plain']);
    expect(documentWindow.keptTabs).toBe(3);
    // Nothing for a removed feature was even attempted.
    const attempted = mockInvoke.mock.calls.map(([cmd]) => cmd);
    for (const cmd of ['read_range', 'windowed_reopen', 'stat_file']) {
      expect(attempted).not.toContain(cmd);
    }
  });

  it('never writes, rewrites or deletes a kept record, whatever the window does', async () => {
    editionState.lite = true;
    backend();
    await documentWindow.init('g', null, null);
    documentWindow.updateActiveContent(Text.of(['edited']));

    await documentWindow.flushAll();
    documentWindow.setBounds(1, 2, 300, 200);
    await documentWindow.dropClosedTabs('doc-g');
    await documentWindow.deleteTab(0);
    await documentWindow.dropClosedTabs('doc-g');
    // The ordinary tab was written and deleted as always, so this is not vacuous.
    expect(writesTo(['plain']).length).toBeGreaterThan(0);
    expect(writesTo(KEPT_IDS)).toEqual([]);
  });

  it('keeps counting from the highest stored index so a new tab cannot collide', async () => {
    editionState.lite = true;
    backend();
    await documentWindow.init('g', null, null);
    await documentWindow.newTab();
    expect(documentWindow.tabs.at(-1)?.tabIndex).toBe(4);
  });

  it('opens every tab in full', async () => {
    editionState.lite = false;
    backend();
    await documentWindow.init('g', null, null);
    expect(documentWindow.tabs.map((t) => t.id)).toEqual([
      'plain',
      'large',
      'windowed',
      'range',
    ]);
    expect(documentWindow.keptTabs).toBe(0);
  });

  it('shows no active tab but still counts when every tab is kept', async () => {
    editionState.lite = true;
    backend({
      list_notes: stored.filter((n) => KEPT_IDS.includes(n.id)),
    });
    await documentWindow.init('g', null, null);
    expect(documentWindow.tabs).toEqual([]);
    expect(documentWindow.keptTabs).toBe(3);
    expect(writesTo(KEPT_IDS)).toEqual([]);
  });
});

describe('the edition turning full', () => {
  it('opens the kept tabs in stored order, the range tab with its unsaved edits', async () => {
    editionState.lite = true;
    backend();
    await documentWindow.init('g', null, null);
    expect(documentWindow.tabs).toHaveLength(1);

    editionState.lite = false;
    await documentWindow.restoreKeptTabs();

    expect(documentWindow.tabs.map((t) => t.id)).toEqual([
      'plain',
      'large',
      'windowed',
      'range',
    ]);
    expect(documentWindow.keptTabs).toBe(0);
    const range = documentWindow.tabs.find((t) => t.id === 'range')!;
    expect(range.content.toString()).toBe('unsaved edit');
    expect(range.range?.sourcePath).toBe('/tmp/big.log');
    expect(documentWindow.tabs.find((t) => t.id === 'large')?.large).toEqual({
      size: SIZE,
    });
    expect(
      documentWindow.tabs.find((t) => t.id === 'windowed')?.windowedRestore,
    ).toBeDefined();
    // Reading a record back is all it took.
    expect(writesTo(KEPT_IDS)).toEqual([]);
  });

  it('does nothing while still lite, and a second call opens nothing twice', async () => {
    editionState.lite = true;
    backend();
    await documentWindow.init('g', null, null);
    await documentWindow.restoreKeptTabs();
    expect(documentWindow.tabs).toHaveLength(1);
    expect(documentWindow.keptTabs).toBe(3);

    editionState.lite = false;
    await documentWindow.restoreKeptTabs();
    await documentWindow.restoreKeptTabs();
    expect(documentWindow.tabs).toHaveLength(4);
  });

  it('keeps the tab the user was on', async () => {
    editionState.lite = true;
    backend();
    await documentWindow.init('g', null, null);
    editionState.lite = false;
    await documentWindow.restoreKeptTabs();
    expect(documentWindow.activeTab?.id).toBe('plain');
  });

  it('opens a window that held only kept tabs', async () => {
    editionState.lite = true;
    const onlyKept = stored.filter((n) => KEPT_IDS.includes(n.id));
    backend({ list_notes: onlyKept });
    await documentWindow.init('g', null, null);
    expect(documentWindow.tabs).toEqual([]);

    editionState.lite = false;
    await documentWindow.restoreKeptTabs();
    expect(documentWindow.tabs.map((t) => t.id)).toEqual([
      'large',
      'windowed',
      'range',
    ]);
    expect(documentWindow.activeTab?.id).toBe('large');
  });
});

describe('a lite window taking its bounds', () => {
  const bounds = (): { x: number | null } =>
    (documentWindow as unknown as { bounds: { x: number | null } }).bounds;

  it('from the lowest shown tab, not a kept record before it', async () => {
    editionState.lite = true;
    backend({
      list_notes: [
        note({ id: 'kept', tab_index: 0, x: 10, large: SIZE }),
        note({ id: 'shown', tab_index: 1, x: 900 }),
      ],
    });
    await documentWindow.init('g', null, null);
    expect(bounds().x).toBe(900);
  });

  it('from the lowest record when every tab is kept', async () => {
    editionState.lite = true;
    backend({
      list_notes: [
        note({ id: 'kept2', tab_index: 3, x: 500, large: SIZE }),
        note({ id: 'kept', tab_index: 0, x: 10, large: SIZE }),
      ],
    });
    await documentWindow.init('g', null, null);
    expect(bounds().x).toBe(10);
  });

  it('from the lowest record in full', async () => {
    editionState.lite = false;
    backend({
      list_notes: [
        note({ id: 'kept', tab_index: 0, x: 10, large: SIZE }),
        note({ id: 'shown', tab_index: 1, x: 900 }),
      ],
    });
    await documentWindow.init('g', null, null);
    expect(bounds().x).toBe(10);
  });
});
// A group is held back for the trial from one place only: dismissing the
// kept-tabs notice of a window that has nothing else to show.
describe('holding a group back for the trial', () => {
  const heldBack = (): unknown[][] =>
    mockInvoke.mock.calls.filter(([cmd]) => cmd === 'hold_back_group');

  it('invokes hold_back_group before resolving true when only kept tabs were there', async () => {
    editionState.lite = true;
    backend({
      list_notes: stored.filter((n) => KEPT_IDS.includes(n.id)),
    });
    await documentWindow.init('g', null, null);
    expect(documentWindow.keptTabs).toBe(3);

    expect(await documentWindow.dismissKeptTabsAndHoldBack()).toBe(true);
    expect(heldBack()).toEqual([['hold_back_group', { group: 'g' }]]);
    expect(documentWindow.keptTabs).toBe(0);
  });

  it('does not invoke it and resolves false when tabs remain', async () => {
    editionState.lite = true;
    backend();
    await documentWindow.init('g', null, null);

    expect(await documentWindow.dismissKeptTabsAndHoldBack()).toBe(false);
    expect(heldBack()).toEqual([]);
    expect(documentWindow.keptTabs).toBe(0);
  });

  it('is never invoked by closing the last tab or the window', async () => {
    editionState.lite = false;
    backend({ list_notes: [stored[0]] });
    await documentWindow.init('g', null, null);
    expect(documentWindow.tabs).toHaveLength(1);

    await documentWindow.deleteTab(0);
    expect(documentWindow.tabs).toHaveLength(0);
    await documentWindow.dropClosedTabs('doc-g');
    expect(heldBack()).toEqual([]);
  });

  it('is never invoked by closing a window in the trial either', async () => {
    editionState.lite = true;
    backend();
    await documentWindow.init('g', null, null);
    await documentWindow.deleteTab(0);
    await documentWindow.dropClosedTabs('doc-g');
    expect(heldBack()).toEqual([]);
  });
});

describe('opening a file over 100 MB', () => {
  async function open(lite: boolean): Promise<void> {
    editionState.lite = lite;
    backend({ list_notes: [] });
    await settingsState.init();
    await documentWindow.init('g', null, null);
    await documentWindow.openTab('/tmp/huge.log');
  }

  it('uses the ordinary editor in lite, without even asking the size', async () => {
    await open(true);
    expect(documentWindow.pendingLargeOpen).toBeNull();
    expect(documentWindow.tabs).toHaveLength(1);
    expect(documentWindow.tabs[0]?.large).toBeUndefined();
    expect(documentWindow.tabs[0]?.content.toString()).toBe('disk text');
    const attempted = mockInvoke.mock.calls.map(([cmd]) => cmd);
    expect(attempted).not.toContain('stat_file');
  });

  it('asks the large-file question in full', async () => {
    await open(false);
    expect(documentWindow.pendingLargeOpen).toEqual({
      path: '/tmp/huge.log',
      size: SIZE,
    });
    expect(documentWindow.tabs).toHaveLength(0);
  });

  it('degrades a restored tab that lost its markers to the ordinary editor in lite', async () => {
    editionState.lite = true;
    backend({
      list_notes: [note({ id: 'lost', file_path: '/tmp/huge.log' })],
    });
    await documentWindow.init('g', null, null);
    expect(documentWindow.tabs).toHaveLength(1);
    expect(documentWindow.tabs[0]?.large).toBeUndefined();
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).not.toContain(
      'stat_file',
    );
  });
});

describe('opening a path whose only stored tab is a kept one', () => {
  it('opens a fresh tab in lite and leaves the stored record alone', async () => {
    editionState.lite = true;
    backend({
      list_notes: [
        note({
          id: 'orphan',
          window_group: 'dead',
          file_path: '/tmp/big.log',
          large: SIZE,
        }),
      ],
    });
    await settingsState.init();
    await documentWindow.init('g', null, null);
    await documentWindow.openTab('/tmp/big.log');

    expect(documentWindow.tabs).toHaveLength(1);
    expect(documentWindow.tabs[0]?.id).not.toBe('orphan');
    expect(documentWindow.tabs[0]?.large).toBeUndefined();
    expect(writesTo(['orphan'])).toEqual([]);
  });
});
// A lite session can hold a large viewer, windowed session or range tab only if
// it was opened while full. The window state does not react to `edition-changed`
// for them: nothing closes, and every operation on them keeps going to the core.
describe('tabs opened while full, after the edition turns lite', () => {
  function windowedTab(): DocTab {
    return {
      id: 'w',
      path: '/tmp/win.log',
      readOnlyFile: false,
      content: Text.empty,
      savedContent: Text.empty,
      language: null,
      explicit: false,
      lineEnding: 'LF',
      savedLineEnding: 'LF',
      hadBom: false,
      encoding: 'UTF-8',
      lossy: false,
      tabIndex: 9,
      windowed: {
        sessionId: 5,
        totalBytes: 10,
        totalLines: 2,
        fingerprint: { size: 10, mtime_ms: 1 },
        dirty: true,
        topLine: 0,
      },
    };
  }

  async function openFullThenTurnLite(over: Record<string, unknown> = {}) {
    editionState.lite = false;
    backend({
      splice_file: { size: 5, mtime_ms: 2 },
      windowed_save: {
        fingerprint: { size: 10, mtime_ms: 2 },
        total_bytes: 10,
        total_lines: 2,
      },
      ...over,
    });
    await documentWindow.init('g', null, null);
    editionState.lite = true;
  }

  it('stay open, and nothing is counted as kept', async () => {
    await openFullThenTurnLite();
    const ids = documentWindow.tabs.map((t) => t.id);
    await documentWindow.restoreKeptTabs();
    expect(documentWindow.tabs.map((t) => t.id)).toEqual(ids);
    expect(ids).toEqual(['plain', 'large', 'windowed', 'range']);
    expect(documentWindow.keptTabs).toBe(0);
    expect(documentWindow.tabs.find((t) => t.id === 'large')?.large).toEqual({
      size: SIZE,
    });
  });

  it('keep writing their snapshot records', async () => {
    await openFullThenTurnLite();
    await documentWindow.flushAll();
    expect(writesTo(['range']).length).toBeGreaterThan(0);
  });

  it('let a range tab save back to its source', async () => {
    await openFullThenTurnLite();
    documentWindow.activeIndex = documentWindow.tabs.findIndex(
      (t) => t.id === 'range',
    );
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).toContain('splice_file');
  });

  it('let a windowed tab save', async () => {
    await openFullThenTurnLite();
    const tab = windowedTab();
    documentWindow.tabs.push(tab);
    expect(await documentWindow.saveWindowed(tab, false)).toBe('ok');
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).toContain(
      'windowed_save',
    );
  });

  it('keep a windowed tab on its session when neither a fresh open nor the baseline reopen works', async () => {
    await openFullThenTurnLite({
      windowed_open: () =>
        Promise.reject(
          'large-file editing is not available in the Lite edition',
        ),
      windowed_index: {
        index: { checkpoints: [[0, 0]], total_newlines: 1 },
        fingerprint: { size: 10, mtime_ms: 1 },
        digest: '7',
      },
      windowed_reopen: () => Promise.reject('reopen failed'),
    });
    const tab = windowedTab();
    documentWindow.tabs.push(tab);
    await documentWindow.discardWindowed(tab);
    expect(mockInvoke).toHaveBeenCalledWith('windowed_index', { sessionId: 5 });
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).toContain(
      'windowed_reopen',
    );
    expect(tab.windowed?.sessionId).toBe(5);
    expect(tab.windowed?.dirty).toBe(true);
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).not.toContain(
      'windowed_close',
    );
  });

  it('swap the session on discard when the new one opens (full)', async () => {
    await openFullThenTurnLite({
      windowed_open: {
        session_id: 6,
        total_bytes: 10,
        total_lines: 2,
        fingerprint: { size: 10, mtime_ms: 1 },
      },
    });
    editionState.lite = false;
    const tab = windowedTab();
    documentWindow.tabs.push(tab);
    await documentWindow.discardWindowed(tab);
    expect(tab.windowed?.sessionId).toBe(6);
    expect(mockInvoke).toHaveBeenCalledWith('windowed_close', { sessionId: 5 });
  });
});

describe('unlocking a large-file tab', () => {
  const OPENED = {
    session_id: 8,
    total_bytes: SIZE,
    total_lines: 10,
    fingerprint: { size: SIZE, mtime_ms: 1 },
  };

  async function onLargeTab(over: Record<string, unknown> = {}): Promise<void> {
    editionState.lite = false;
    backend({ windowed_open: OPENED, ...over });
    await documentWindow.init('g', null, null);
    documentWindow.activeIndex = documentWindow.tabs.findIndex(
      (t) => t.id === 'large',
    );
  }

  const opens = (): number =>
    mockInvoke.mock.calls.filter(([cmd]) => cmd === 'windowed_open').length;

  it('in lite asks the core for nothing and records no refusal', async () => {
    await onLargeTab();
    editionState.lite = true;
    expect(await documentWindow.unlockLargeTab(0)).toBeNull();
    expect(opens()).toBe(0);
    const tab = documentWindow.activeTab!;
    expect(tab.large).toEqual({ size: SIZE });
    expect(tab.large?.unlockRefused).toBeUndefined();
    expect(tab.windowed).toBeUndefined();
  });

  it('works again, from a clean lock, once the edition is full', async () => {
    await onLargeTab();
    editionState.lite = true;
    await documentWindow.unlockLargeTab(0);
    editionState.lite = false;
    expect(await documentWindow.unlockLargeTab(3)).toBeNull();
    expect(opens()).toBe(1);
    const tab = documentWindow.activeTab!;
    expect(tab.large).toBeUndefined();
    expect(tab.windowed?.sessionId).toBe(8);
    expect(tab.windowed?.topLine).toBe(3);
  });

  it('never stores a refusal the edition caused, even one that lands mid-flight', async () => {
    await onLargeTab({
      windowed_open: () => {
        editionState.lite = true;
        return Promise.reject(
          'large-file editing is not available in the Lite edition',
        );
      },
    });
    await documentWindow.unlockLargeTab(0);
    expect(opens()).toBe(1);
    expect(documentWindow.activeTab?.large?.unlockRefused).toBeUndefined();
  });

  it('still records a refusal that is about the file, in full', async () => {
    await onLargeTab({ windowed_open: () => Promise.reject('not-utf8') });
    await documentWindow.unlockLargeTab(0);
    expect(documentWindow.activeTab?.large?.unlockRefused).toBeDefined();
  });
});

describe('the language of a tab opened in lite', () => {
  it('is the real one for a restored tab, plain text only while lite', async () => {
    editionState.lite = true;
    backend({
      list_notes: [note({ id: 'py', file_path: '/tmp/a.py', tab_index: 0 })],
    });
    await documentWindow.init('g', null, null);
    const tab = documentWindow.tabs[0]!;
    expect(tab.language).toBe('Python');
    expect(effectiveLanguage(tab.language)).toBeNull();
    editionState.lite = false;
    expect(effectiveLanguage(tab.language)).toBe('Python');
  });

  it('is the real one for a file opened in lite, in the tab and in its snapshot', async () => {
    editionState.lite = true;
    backend({ list_notes: [] });
    await settingsState.init();
    await documentWindow.init('g', null, null);
    await documentWindow.openTab('/tmp/b.js');
    const tab = documentWindow.tabs[0]!;
    expect(tab.language).toBe('JavaScript');
    // What a later full session restores from.
    const written = mockInvoke.mock.calls
      .filter(([cmd]) => cmd === 'upsert_note')
      .map(([, args]) => (args as { note: NoteSnapshot }).note);
    expect(written.at(-1)?.language).toBe('JavaScript');
    editionState.lite = false;
    expect(effectiveLanguage(tab.language)).toBe('JavaScript');
  });
});

describe('a restore that the edition interrupts', () => {
  const cleanRange = note({
    id: 'crange',
    tab_index: 0,
    file_path: '',
    range_source: '/tmp/big.log',
    range_start: 0,
    range_end: 10,
    range_fp_size: SIZE,
    range_fp_mtime: 1,
    range_start_line: 1,
    range_end_line: null,
    range_trailing_break: null,
  });
  const refused = (): Promise<never> => {
    editionState.lite = true;
    return Promise.reject('range editing is not available in the Lite edition');
  };

  it('keeps a range record when the edition turns lite mid-restore', async () => {
    editionState.lite = false;
    backend({ list_notes: [cleanRange], read_range: refused });
    await documentWindow.init('g', null, null);
    expect(writesTo(['crange'])).toEqual([]);
    expect(documentWindow.restoreUnreadable).toEqual([]);
    expect(documentWindow.tabs).toEqual([]);
    expect(documentWindow.keptTabs).toBe(1);
  });

  it('keeps it too when the flip lands during the return to full', async () => {
    editionState.lite = true;
    backend({ list_notes: [cleanRange], read_range: refused });
    await documentWindow.init('g', null, null);
    expect(documentWindow.keptTabs).toBe(1);
    editionState.lite = false;
    await documentWindow.restoreKeptTabs();
    expect(writesTo(['crange'])).toEqual([]);
    expect(documentWindow.restoreUnreadable).toEqual([]);
    expect(documentWindow.keptTabs).toBe(1);
  });

  it('keeps a range record whose read fails for another reason once the edition is lite', async () => {
    editionState.lite = false;
    backend({
      list_notes: [cleanRange],
      read_range: () => {
        editionState.lite = true;
        return Promise.reject('permission-denied');
      },
    });
    await documentWindow.init('g', null, null);
    expect(writesTo(['crange'])).toEqual([]);
    expect(documentWindow.restoreUnreadable).toEqual([]);
    expect(documentWindow.tabs).toEqual([]);
    expect(documentWindow.keptTabs).toBe(1);
  });

  it('still reports and drops a record that is really unreadable in full', async () => {
    editionState.lite = false;
    backend({
      list_notes: [cleanRange],
      read_range: () => Promise.reject('permission-denied'),
    });
    await documentWindow.init('g', null, null);
    expect(writesTo(['crange']).length).toBe(1);
    expect(documentWindow.restoreUnreadable).toEqual(['/tmp/big.log']);
  });
});

describe('returning to full with the ordinary tab between kept ones', () => {
  it('puts every tab back at its stored position and keeps the active one', async () => {
    const group = [
      note({ id: 'k0', tab_index: 0, file_path: '/tmp/big.log', large: SIZE }),
      note({ id: 'mid', tab_index: 1, file_path: '/tmp/mid.txt' }),
      note({ id: 'k2', tab_index: 2, file_path: '/tmp/big2.log', large: SIZE }),
    ];
    editionState.lite = true;
    backend({ list_notes: group });
    await documentWindow.init('g', null, null);
    expect(documentWindow.tabs.map((t) => t.id)).toEqual(['mid']);
    editionState.lite = false;
    await documentWindow.restoreKeptTabs();
    expect(documentWindow.tabs.map((t) => t.id)).toEqual(['k0', 'mid', 'k2']);
    expect(documentWindow.activeTab?.id).toBe('mid');
  });
});

describe('discarding a dirty windowed tab after the edition turned lite', () => {
  it('clears the edits through windowed_reopen, since windowed_open is refused', async () => {
    editionState.lite = false;
    backend({
      windowed_index: {
        index: { checkpoints: [[0, 0]], total_newlines: 3 },
        fingerprint: { size: 10, mtime_ms: 1 },
        digest: '7',
      },
      windowed_reopen: {
        session_id: 9,
        total_bytes: 10,
        total_lines: 2,
        fingerprint: { size: 10, mtime_ms: 1 },
        rescanned: false,
      },
      windowed_open: () =>
        Promise.reject(
          'large-file editing is not available in the Lite edition',
        ),
    });
    const tab: DocTab = {
      id: 'w',
      path: '/tmp/win.log',
      readOnlyFile: false,
      content: Text.empty,
      savedContent: Text.empty,
      language: null,
      explicit: false,
      lineEnding: 'LF',
      savedLineEnding: 'LF',
      hadBom: false,
      encoding: 'UTF-8',
      lossy: false,
      tabIndex: 9,
      windowed: {
        sessionId: 5,
        totalBytes: 10,
        totalLines: 2,
        fingerprint: { size: 10, mtime_ms: 1 },
        dirty: true,
        topLine: 0,
      },
    };
    documentWindow.tabs.push(tab);
    editionState.lite = true;

    await documentWindow.discardWindowed(tab);

    expect(tab.windowed?.sessionId).toBe(9);
    expect(tab.windowed?.dirty).toBe(false);
    const attempted = mockInvoke.mock.calls.map(([cmd]) => cmd);
    expect(attempted).not.toContain('windowed_open');
    expect(mockInvoke).toHaveBeenCalledWith('windowed_close', { sessionId: 5 });
    expect(documentWindow.isDirty(tab)).toBe(false);
  });
});

describe('a refusal that arrives before the edition-changed event', () => {
  const refusal = 'range editing is not available in the Lite edition';
  const cleanRange = note({
    id: 'crange',
    tab_index: 0,
    file_path: '',
    range_source: '/tmp/big.log',
    range_start: 0,
    range_end: 10,
    range_fp_size: SIZE,
    range_fp_mtime: 1,
    range_start_line: 1,
    range_end_line: null,
    range_trailing_break: null,
  });

  it('keeps a range record while isLite() still says full', async () => {
    editionState.lite = false;
    backend({
      list_notes: [cleanRange],
      read_range: () => Promise.reject(refusal),
    });
    await documentWindow.init('g', null, null);
    expect(writesTo(['crange'])).toEqual([]);
    expect(documentWindow.restoreUnreadable).toEqual([]);
    expect(documentWindow.keptTabs).toBe(1);
  });

  it('is not stored as the reason a large tab cannot be edited', async () => {
    editionState.lite = false;
    backend({
      windowed_open: () =>
        Promise.reject(
          'large-file editing is not available in the Lite edition',
        ),
    });
    await documentWindow.init('g', null, null);
    documentWindow.activeIndex = documentWindow.tabs.findIndex(
      (t) => t.id === 'large',
    );
    await documentWindow.unlockLargeTab(0);
    expect(documentWindow.activeTab?.large?.unlockRefused).toBeUndefined();
  });
});

describe('returning to full', () => {
  it('twice in quick succession opens every kept tab once', async () => {
    editionState.lite = true;
    backend();
    await documentWindow.init('g', null, null);
    editionState.lite = false;
    await Promise.all([
      documentWindow.restoreKeptTabs(),
      documentWindow.restoreKeptTabs(),
    ]);
    expect(documentWindow.tabs.map((t) => t.id)).toEqual([
      'plain',
      'large',
      'windowed',
      'range',
    ]);
  });

  it('catches up when it happens while the restore is still loading', async () => {
    editionState.lite = true;
    backend({
      // Loading the one ordinary tab is where the edition turns full.
      read_file_as: () => {
        editionState.lite = false;
        return Promise.resolve({
          content: 'disk text',
          encoding: 'UTF-8',
          had_bom: false,
          lossy: false,
        });
      },
    });
    await documentWindow.init('g', null, null);
    expect(documentWindow.tabs.map((t) => t.id)).toEqual([
      'plain',
      'large',
      'windowed',
      'range',
    ]);
    expect(documentWindow.keptTabs).toBe(0);
  });
});

describe('the large-file question when the edition turns lite under it', () => {
  it('opens the file in the ordinary editor, not the viewer', async () => {
    editionState.lite = false;
    backend({ list_notes: [] });
    await settingsState.init();
    await documentWindow.init('g', null, null);
    await documentWindow.openTab('/tmp/huge.log');
    expect(documentWindow.pendingLargeOpen).not.toBeNull();

    editionState.lite = true;
    documentWindow.confirmLargeOpen(false);

    await vi.waitFor(() => expect(documentWindow.tabs).toHaveLength(1));
    expect(documentWindow.pendingLargeOpen).toBeNull();
    expect(documentWindow.tabs[0]?.large).toBeUndefined();
    expect(documentWindow.tabs[0]?.content.toString()).toBe('disk text');
  });
});

describe('tab indices handed out after a restore', () => {
  const plain = (id: string, tab_index: number): NoteSnapshot =>
    note({ id, tab_index, file_path: `/tmp/${id}.txt` });
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('stay above every stored tab when the restore throws midway', async () => {
    backend({ list_notes: [plain('a', 0), plain('b', 3), plain('c', 5)] });
    const win = new DocumentWindowState();
    const proto = win as unknown as {
      loadTab: (...args: unknown[]) => Promise<DocTab>;
    };
    const real = proto.loadTab.bind(win);
    let calls = 0;
    vi.spyOn(proto, 'loadTab').mockImplementation((...args: unknown[]) => {
      calls += 1;
      return calls === 1 ? real(...args) : Promise.reject(new Error('boom'));
    });
    await expect(win.init('g', null, null)).rejects.toThrow('boom');
    await win.newTab();
    expect(win.tabs.map((t) => t.tabIndex)).toEqual([0, 6]);
  });

  it('wait for the stored indices when asked for before list_notes returns', async () => {
    let release: (v: NoteSnapshot[]) => void = () => {};
    backend({
      list_notes: () =>
        new Promise<NoteSnapshot[]>((r) => {
          release = r;
        }),
    });
    const win = new DocumentWindowState();
    const init = win.init('g', null, null);
    const opened = win.newTab();
    await flush();
    expect(win.tabs).toHaveLength(0);
    release([plain('a', 0), plain('b', 3)]);
    await Promise.all([init, opened]);
    const indices = win.tabs.map((t) => t.tabIndex).sort((x, y) => x - y);
    expect(indices).toEqual([0, 3, 4]);
  });

  it('stay above every stored tab when a new tab opens mid-restore', async () => {
    let release: () => void = () => {};
    let held = false;
    backend({
      list_notes: [plain('a', 0), plain('b', 3)],
      path_writable: () => {
        if (held) {
          return Promise.resolve(true);
        }
        held = true;
        return new Promise((r) => {
          release = () => r(true);
        });
      },
    });
    const win = new DocumentWindowState();
    const init = win.init('g', null, null);
    await flush();
    await win.newTab();
    expect(win.tabs.map((t) => t.tabIndex)).toEqual([4]);
    release();
    await init;
    const indices = win.tabs.map((t) => t.tabIndex).sort((x, y) => x - y);
    expect(indices).toEqual([0, 3, 4]);
  });
});
