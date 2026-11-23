// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The order of a window's tabs: the key that carries it through a restart, a
// move inside the window, and every flow that holds a tab across an await while
// the order or the active tab can change under it. Driven through the real
// window state against a fake backend that keeps the stored records.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import type { NoteSnapshot } from './stickyNote.svelte';
import { toPayload } from '../util/tabPayload';
import { settingsState } from './settings.svelte';
import { editionState } from './edition.svelte';
import {
  DocumentWindowState,
  type DocTab,
  type DragHost,
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
    file_path: '/p/a.txt',
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
    windowed_encoding: null,
    windowed_bom: false,
    ...over,
  };
}
/** A tab as the window builds one, with its own place. */
function tab(id: string, index: number, over: Partial<DocTab> = {}): DocTab {
  return {
    id,
    path: `/p/${id}.txt`,
    readOnlyFile: false,
    content: Text.of([id]),
    savedContent: Text.of([id]),
    language: null,
    explicit: false,
    lineEnding: 'LF',
    savedLineEnding: 'LF',
    hadBom: false,
    encoding: 'UTF-8',
    lossy: false,
    tabIndex: index,
    order: index,
    ...over,
  };
}
const SIZE = 200 * 1024 * 1024;
/** The records the fake backend holds, by id. */
let stored: Map<string, NoteSnapshot>;
/** Disk files by path; any other path reads as a file of its own name. */
let files: Map<string, string>;
let readySpy: ReturnType<typeof vi.spyOn>;
let win: DocumentWindowState;

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
            large_select_all: 'visible',
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
        return Promise.resolve([...stored.values()]);
      case 'upsert_note': {
        const { note: written } = args as { note: NoteSnapshot };
        stored.set(written.id, written);
        return Promise.resolve(null);
      }
      case 'delete_note':
        stored.delete((args as { id: string }).id);
        return Promise.resolve(null);
      case 'live_doc_groups':
        return Promise.resolve([]);
      case 'path_writable':
        return Promise.resolve(true);
      case 'stat_file':
        return Promise.resolve({ size: 10 });
      case 'read_file_as':
      case 'read_file_auto': {
        const path = (args as { path: string }).path;
        return Promise.resolve({
          content: files.get(path) ?? path,
          encoding: 'UTF-8',
          had_bom: false,
          lossy: false,
        });
      }
      default:
        return Promise.resolve(null);
    }
  }) as typeof invoke);
}
/** The records `upsert_note` was called with since the last clear. */
function upserts(): NoteSnapshot[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === 'upsert_note')
    .map(([, args]) => (args as { note: NoteSnapshot }).note);
}
/** Ids of the tabs, in display order. */
function ids(w: DocumentWindowState = win): string[] {
  return w.tabs.map((t) => t.id);
}
/** What a restart shows: a new window over the records written so far. */
async function restored(): Promise<string[]> {
  const fresh = new DocumentWindowState();
  await fresh.init('g', null, null);
  return ids(fresh);
}
/** The tab with `id`, as the window's reactive array holds it. */
function at(id: string): DocTab {
  const found = win.tabs.find((t) => t.id === id);
  if (found === undefined) {
    throw new Error(`no tab ${id}`);
  }
  return found;
}
/** A window holding tabs `a`, `b`, `c`… with the first one active. */
async function windowOf(...names: string[]): Promise<void> {
  await win.init('g', null, null);
  names.forEach((name, i) => win.tabs.push(tab(name, i)));
  win.activeIndex = 0;
  mockInvoke.mockClear();
}
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(done()).toBe(true);
}
/** An `endComposition` that parks until the returned function is called, for
 *  every switch waiting on it. */
function parkComposition(): { release: () => void; parked: () => boolean } {
  let release: () => void = () => {};
  let parked = false;
  const ended = new Promise<void>((resolve) => {
    release = resolve;
  });
  win.endComposition = () => {
    parked = true;
    return ended;
  };
  return { release: () => release(), parked: () => parked };
}

/** Make `win.tabs` store a proxy of what it is given, as a `$state` array does,
 *  so the raw object is no longer the stored one. */
function proxyStore(): void {
  const wrap = (items: DocTab[]): DocTab[] =>
    items.map((item) => new Proxy(item, {}));
  const tabs = win.tabs;
  const push = tabs.push.bind(tabs);
  const splice = tabs.splice.bind(tabs);
  tabs.push = (...items: DocTab[]) => push(...wrap(items));
  tabs.splice = ((start: number, remove: number, ...items: DocTab[]) =>
    splice(start, remove, ...wrap(items))) as typeof tabs.splice;
}

/** The id of the active tab after every write of `activeIndex`. */
function recordActive(): string[] {
  const seen: string[] = [];
  const own = Object.getOwnPropertyDescriptor(
    DocumentWindowState.prototype,
    'activeIndex',
  )!;
  Object.defineProperty(win, 'activeIndex', {
    configurable: true,
    get: () => own.get!.call(win) as number,
    set: (index: number) => {
      own.set!.call(win, index);
      seen.push(win.activeTab?.id ?? '');
    },
  });
  return seen;
}

beforeEach(async () => {
  stored = new Map();
  files = new Map();
  backend();
  readySpy = vi.spyOn(editionState, 'ready').mockResolvedValue();
  editionState.lite = false;
  win = new DocumentWindowState();
  await settingsState.init();
});

afterEach(() => {
  readySpy.mockRestore();
});

describe('the order key through a restart', () => {
  it('(a) keeps a legacy pair in order when only the moved record is rewritten', async () => {
    stored.set('a', note({ id: 'a', file_path: '/p/a.txt', tab_index: 30 }));
    stored.set('b', note({ id: 'b', file_path: '/p/b.txt', tab_index: 31 }));
    await win.init('g', null, null);
    expect(ids()).toEqual(['a', 'b']);
    mockInvoke.mockClear();

    await win.moveTab(at('b'), 0);
    // Only the second record was written; the first still has no key.
    expect(upserts().map((n) => n.id)).toEqual(['b']);
    expect(upserts()[0]).toMatchObject({ tab_index: 31, tab_order: 29 });
    expect(stored.get('a')?.tab_order).toBeUndefined();
    expect(await restored()).toEqual(['b', 'a']);
  });

  it('(b) restores in display order after tabs were opened and closed', async () => {
    await win.init('g', null, null);
    for (const name of ['a', 'b', 'c', 'd']) {
      await win.openTab(`/p/${name}.txt`);
    }
    expect(ids().length).toBe(4);
    const [b, c] = [win.tabs[1]!, win.tabs[2]!];
    await win.deleteTab(win.tabs.indexOf(b));
    await win.deleteTab(win.tabs.indexOf(c));
    await win.openTab('/p/e.txt');
    expect(win.tabs.map((t) => t.path)).toEqual([
      '/p/a.txt',
      '/p/d.txt',
      '/p/e.txt',
    ]);

    const display = ids();
    expect(await restored()).toEqual(display);
  });

  it('(c) restores in display order after a move to first, middle and last', async () => {
    await win.init('g', null, null);
    for (let i = 0; i < 4; i += 1) {
      await win.newTab();
    }
    const [a, b, c, d] = win.tabs.map((t) => t.id);
    expect(ids()).toEqual([a, b, c, d]);

    await win.moveTab(at(d!), 0);
    expect(ids()).toEqual([d, a, b, c]);
    expect(await restored()).toEqual(ids());

    await win.moveTab(at(d!), 2);
    expect(ids()).toEqual([a, b, d, c]);
    expect(await restored()).toEqual(ids());

    await win.moveTab(at(a!), 3);
    expect(ids()).toEqual([b, d, c, a]);
    expect(await restored()).toEqual(ids());
  });

  it('(d) writes every tab with its position when no key is left between two neighbours', async () => {
    await windowOf();
    const right = 1 + Number.EPSILON;
    win.tabs.push(tab('a', 0, { order: 1 }), tab('b', 1, { order: right }));
    win.tabs.push(tab('c', 2, { order: 2 }));
    win.activeIndex = 0;
    mockInvoke.mockClear();

    await win.moveTab(at('c'), 1);

    expect(ids()).toEqual(['a', 'c', 'b']);
    expect(upserts().map((n) => [n.id, n.tab_order])).toEqual([
      ['a', 0],
      ['c', 1],
      ['b', 2],
    ]);
    expect(win.tabs.map((t) => t.order)).toEqual([0, 1, 2]);
  });

  it('(e) puts an adopted orphan last whatever key its record had', async () => {
    stored.set(
      'orphan',
      note({
        id: 'orphan',
        window_group: 'dead',
        file_path: '/p/o.txt',
        tab_index: 5,
        tab_order: 0.5,
      }),
    );
    await win.init('g', null, null);
    for (const name of ['a', 'b', 'c']) {
      win.tabs.push(tab(name, win.tabs.length));
    }
    win.activeIndex = 0;

    await win.openTab('/p/o.txt');

    expect(ids()).toEqual(['a', 'b', 'c', 'orphan']);
    expect(at('orphan').order).toBe(3);
    expect(stored.get('orphan')?.tab_order).toBe(3);
    expect(win.activeTab?.id).toBe('orphan');
  });

  it('(e) keeps its key on a tab that is rebuilt in place', async () => {
    await windowOf('a', 'b', 'c');
    const converted = tab('b', 1, {
      path: '/p/b.txt',
      windowed: {
        sessionId: 4,
        totalBytes: 1,
        totalLines: 1,
        fingerprint: null,
        dirty: true,
        topLine: 0,
      },
      converted: {
        target: '/p/b.txt',
        encoding: 'UTF-8',
        bom: false,
        origin: 'document',
        saved: false,
      },
    });
    win.tabs.splice(1, 1, converted);

    await win.discardWindowed(at('b'));
    // The rebuilt tab is the ordinary one of the file, in its old place.
    expect(at('b').windowed).toBeUndefined();
    expect(at('b').tabIndex).toBe(1);
    expect(at('b').order).toBe(1);
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('gives a tab the key above every other, and 0 to the first', async () => {
    await win.init('g', null, null);
    await win.newTab();
    expect(win.tabs.map((t) => t.order)).toEqual([0]);
    await win.newTab();
    expect(win.tabs.map((t) => t.order)).toEqual([0, 1]);
    win.tabs.splice(0, 1);
    await win.newTab();
    expect(win.tabs.map((t) => t.order)).toEqual([1, 2]);
  });

  it('writes the key with the record', async () => {
    await windowOf('a', 'b');
    await win.moveTab(at('b'), 0);
    expect(upserts()[0]).toMatchObject({ id: 'b', tab_order: -1 });
  });
});

describe('moveTab', () => {
  it('puts the key between the new neighbours', async () => {
    await windowOf('a', 'b', 'c', 'd');
    await win.moveTab(at('d'), 1);
    expect(ids()).toEqual(['a', 'd', 'b', 'c']);
    expect(at('d').order).toBe(0.5);
    await win.moveTab(at('a'), 3);
    expect(ids()).toEqual(['d', 'b', 'c', 'a']);
    expect(at('a').order).toBe(3);
    await win.moveTab(at('a'), 0);
    expect(at('a').order).toBe(-0.5);
    expect(win.tabs.map((t) => t.tabIndex).sort()).toEqual([0, 1, 2, 3]);
  });

  it('keeps the active tab and the order of the editor MRU', async () => {
    await windowOf('a', 'b', 'c');
    win.activeIndex = 1;
    const mru = [...win.ordinaryMru];
    expect(mru[0]).toBe('b');

    await win.moveTab(at('a'), 2);
    expect(ids()).toEqual(['b', 'c', 'a']);
    expect(win.activeTab?.id).toBe('b');
    expect(win.activeIndex).toBe(0);
    expect(win.ordinaryMru).toEqual(mru);
    expect(win.heldTab?.id).toBe('b');

    await win.moveTab(at('b'), 2);
    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(win.activeTab?.id).toBe('b');
    expect(win.activeIndex).toBe(2);
    expect(win.ordinaryMru).toEqual(mru);
  });

  it('does not start the restore of a windowed tab it only moves', async () => {
    await windowOf('a', 'b');
    win.tabs.push(
      tab('w', 2, {
        windowedRestore: {
          index: null,
          fingerprint: { size: SIZE, mtime_ms: 1 },
          digest: '1',
          topLine: 0,
          size: SIZE,
        },
      }),
    );
    mockInvoke.mockClear();
    await win.moveTab(at('w'), 0);
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).not.toContain(
      'windowed_reopen',
    );
  });

  it('writes only the moved tab', async () => {
    await windowOf('a', 'b', 'c');
    await win.moveTab(at('c'), 0);
    expect(upserts().map((n) => n.id)).toEqual(['c']);
  });

  it('changes nothing for a tab that is gone, a place it holds or one outside', async () => {
    await windowOf('a', 'b', 'c');
    const gone = tab('x', 9);
    await win.moveTab(gone, 0);
    await win.moveTab(at('b'), 1);
    await win.moveTab(at('b'), -1);
    await win.moveTab(at('b'), 3);
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(win.tabs.map((t) => t.order)).toEqual([0, 1, 2]);
    expect(upserts()).toEqual([]);
  });

  describe.each<[string, DragHost]>([
    [
      'a missing-file dialog',
      {
        navigationLocked: () => true,
        gateVisible: () => false,
        modalOpen: () => false,
        closing: () => false,
        quitting: () => false,
      },
    ],
    [
      'the close gate',
      {
        navigationLocked: () => false,
        gateVisible: () => true,
        modalOpen: () => false,
        closing: () => false,
        quitting: () => false,
      },
    ],
    [
      'another dialog',
      {
        navigationLocked: () => false,
        gateVisible: () => false,
        modalOpen: () => true,
        closing: () => false,
        quitting: () => false,
      },
    ],
  ])('under %s', (_name, host) => {
    it('refuses to move and writes nothing', async () => {
      await windowOf('a', 'b', 'c');
      win.dragHost = host;
      expect(win.dragLocked()).toBe(true);

      await win.moveTab(at('c'), 0);

      expect(ids()).toEqual(['a', 'b', 'c']);
      expect(win.tabs.map((t) => t.order)).toEqual([0, 1, 2]);
      expect(upserts()).toEqual([]);
    });
  });

  it('moves once the lock is gone', async () => {
    await windowOf('a', 'b');
    let locked = true;
    win.dragHost = {
      navigationLocked: () => locked,
      gateVisible: () => false,
      modalOpen: () => false,
      closing: () => false,
      quitting: () => false,
    };
    await win.moveTab(at('b'), 0);
    expect(ids()).toEqual(['a', 'b']);
    locked = false;
    await win.moveTab(at('b'), 0);
    expect(ids()).toEqual(['b', 'a']);
  });
});

describe('a tab is held by identity across an await', () => {
  it('switchTo lands on its tab after a reorder', async () => {
    await windowOf('a', 'b', 'c');
    const wait = parkComposition();

    const switching = win.switchTo(2);
    await until(wait.parked);
    await win.moveTab(at('c'), 0);
    expect(ids()).toEqual(['c', 'a', 'b']);
    wait.release();
    await switching;

    expect(win.activeTab?.id).toBe('c');
  });

  it('switchTo gives up when another switch won meanwhile', async () => {
    await windowOf('a', 'b', 'c');
    const wait = parkComposition();
    const seen = recordActive();

    const switching = win.switchTo(2);
    await until(wait.parked);
    // The other switch is a click, which takes the screen.
    void win.switchTo(1, false, true);
    wait.release();
    await switching;
    await until(() => win.activeTab?.id === 'b');

    expect(win.activeTab?.id).toBe('b');
    expect(seen).not.toContain('c');
  });

  it('switchTo gives up when its tab was closed meanwhile', async () => {
    await windowOf('a', 'b', 'c');
    const wait = parkComposition();

    const switching = win.switchTo(2);
    await until(wait.parked);
    win.tabs.splice(2, 1);
    wait.release();
    await switching;

    expect(win.activeTab?.id).toBe('a');
  });

  it('deleteTab closes its tab after a reorder', async () => {
    await windowOf('a', 'b', 'c');
    let finish: () => void = () => {};
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'delete_note'
        ? new Promise<void>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(null)) as typeof invoke);

    const closing = win.deleteTab(0);
    await until(() => mockInvoke.mock.calls.some(([c]) => c === 'delete_note'));
    await win.moveTab(at('a'), 2);
    expect(ids()).toEqual(['b', 'c', 'a']);
    finish();
    await closing;

    expect(ids()).toEqual(['b', 'c']);
    // The active tab went, from the end of the bar: the window shows the new last.
    expect(win.activeTab?.id).toBe('c');
  });

  it('deleteTab does nothing more for a tab that is already gone', async () => {
    await windowOf('a', 'b', 'c');
    let finish: () => void = () => {};
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'delete_note'
        ? new Promise<void>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(null)) as typeof invoke);

    const closing = win.deleteTab(1);
    await until(() => mockInvoke.mock.calls.some(([c]) => c === 'delete_note'));
    win.tabs.splice(1, 1);
    finish();
    await closing;

    expect(ids()).toEqual(['a', 'c']);
    expect(win.activeTab?.id).toBe('a');
  });

  it('an open adopts into the tab it switched to, not the one now at that place', async () => {
    stored.set(
      'orphan',
      note({
        id: 'orphan',
        window_group: 'dead',
        file_path: '/p/b.txt',
        dirty: true,
        content: 'orphan text',
        tab_index: 7,
      }),
    );
    await windowOf('a', 'b');
    const wait = parkComposition();

    const opening = win.openTab('/p/b.txt');
    await until(wait.parked);
    await win.moveTab(at('b'), 0);
    expect(ids()).toEqual(['b', 'a']);
    wait.release();
    await opening;

    expect(at('b').content.toString()).toBe('orphan text');
    expect(at('a').content.toString()).toBe('a');
    expect(win.activeTab?.id).toBe('b');
  });

  it('an open does not adopt into a tab that was closed meanwhile', async () => {
    stored.set(
      'orphan',
      note({
        id: 'orphan',
        window_group: 'dead',
        file_path: '/p/b.txt',
        dirty: true,
        content: 'orphan text',
        tab_index: 7,
      }),
    );
    await windowOf('a', 'b');
    const wait = parkComposition();

    const opening = win.openTab('/p/b.txt');
    await until(wait.parked);
    const closed = at('b');
    win.tabs.splice(1, 1);
    wait.release();
    await opening;

    expect(ids()).toEqual(['a']);
    expect(closed.content.toString()).toBe('b');
    expect(stored.has('orphan')).toBe(true);
  });

  it('unlockLargeTab unlocks the tab it is given, not the active one', async () => {
    await windowOf('a');
    win.tabs.push(
      tab('l1', 1, { path: '/p/l1.log', large: { size: SIZE } }),
      tab('l2', 2, { path: '/p/l2.log', large: { size: SIZE } }),
    );
    win.activeIndex = 1;
    backend({
      windowed_open: {
        session_id: 9,
        total_bytes: 1,
        total_lines: 1,
        fingerprint: { size: 1, mtime_ms: 1 },
      },
    });

    expect(await win.unlockLargeTab(at('l2'), 0)).toBeNull();

    expect(at('l2').windowed?.sessionId).toBe(9);
    expect(at('l2').large).toBeUndefined();
    expect(at('l1').large).toEqual({ size: SIZE });
    expect(at('l1').windowed).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith('windowed_open', {
      path: '/p/l2.log',
    });
  });

  it('confirmLargeOpen unlocks its own tab, and no other, once it is the active one', async () => {
    await windowOf('a');
    backend({
      stat_file: { size: SIZE },
      windowed_open: {
        session_id: 9,
        total_bytes: 1,
        total_lines: 1,
        fingerprint: { size: 1, mtime_ms: 1 },
      },
    });
    await win.openTab('/p/huge.log');
    expect(win.pendingLargeOpen).not.toBeNull();

    win.confirmLargeOpen(true);
    await until(() => at('a') !== undefined && win.tabs.length === 2);
    await until(() => win.tabs[1]?.windowed !== undefined);

    expect(win.activeTab?.path).toBe('/p/huge.log');
    expect(win.tabs[0]?.windowed).toBeUndefined();
  });

  it('confirmLargeOpen unlocks its tab when the window stores a proxy of it', async () => {
    await windowOf('a');
    proxyStore();
    backend({
      stat_file: { size: SIZE },
      windowed_open: {
        session_id: 9,
        total_bytes: 1,
        total_lines: 1,
        fingerprint: { size: 1, mtime_ms: 1 },
      },
    });
    await win.openTab('/p/huge.log');

    win.confirmLargeOpen(true);
    await until(() => win.tabs.length === 2);
    await until(() => win.tabs[1]?.windowed !== undefined);

    expect(win.activeTab?.path).toBe('/p/huge.log');
    expect(win.tabs[1]?.large).toBeUndefined();
  });

  it('acceptIncoming activates the tab and returns it when the window stores a proxy of it', async () => {
    await windowOf('a', 'b');
    proxyStore();
    const sender = tab('x', 40);
    const payload = JSON.parse(
      JSON.stringify(
        toPayload(sender, {
          editor: null,
          scroll: null,
          view: null,
          viewMode: null,
        }),
      ),
    ) as Parameters<typeof win.holdIncoming>[1];
    win.holdIncoming(9, payload, null);

    const accepted = win.acceptIncoming(9, true);
    await until(() => win.activeTab?.id === 'x');

    expect(accepted).toBe(win.tabs.find((t) => t.id === 'x'));
    expect(win.tabs.indexOf(accepted!)).toBe(win.activeIndex);
  });

  it('confirmLargeOpen leaves another large tab alone when the switch lost', async () => {
    await windowOf('a');
    win.tabs.push(
      tab('other', 1, { path: '/p/other.log', large: { size: SIZE } }),
    );
    backend({
      stat_file: { size: SIZE },
      windowed_open: {
        session_id: 9,
        total_bytes: 1,
        total_lines: 1,
        fingerprint: { size: 1, mtime_ms: 1 },
      },
    });
    await win.openTab('/p/huge.log');
    const wait = parkComposition();

    win.confirmLargeOpen(true);
    await until(wait.parked);
    // The user went to the other large tab while the new one was switching in.
    void win.switchTo(1, false, true);
    wait.release();
    await until(
      () =>
        mockInvoke.mock.calls.filter(([c]) => c === 'upsert_note').length >= 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(at('other').large).toEqual({ size: SIZE });
    expect(at('other').windowed).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalledWith('windowed_open', {
      path: '/p/other.log',
    });
  });

  it('openRangeBox opens nothing over a tab that was closed while it read', async () => {
    await windowOf('a');
    win.tabs.push(tab('v', 1, { path: '/p/v.log', large: { size: SIZE } }));
    let finish: () => void = () => {};
    backend({
      read_range: () =>
        new Promise((resolve) => {
          finish = () => resolve({ text: 'slice', lossy: false });
        }),
    });
    const viewer = at('v');

    const opening = win.openRangeBox(viewer, {
      startByte: 0,
      endByte: 5,
      startLine: 1,
      endLine: 1,
    });
    await until(() => mockInvoke.mock.calls.some(([c]) => c === 'read_range'));
    win.tabs.splice(1, 1);
    finish();

    expect(await opening).toBeNull();
    expect(win.rangeBox).toBeNull();
  });
});
