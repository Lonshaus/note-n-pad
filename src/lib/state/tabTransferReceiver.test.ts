// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A tab arriving at a window, from the receiver's side: what it answers, the
// copy it keeps outside its tabs until the core accepts, where the tab is put,
// and what happens when the transfer ends any other way.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { settingsState } from './settings.svelte';
import { editionState } from './edition.svelte';
import { platform } from './platform.svelte';
import {
  DocumentWindowState,
  type DocTab,
  type DragHost,
  type TransferHost,
} from './documentWindow.svelte';
import {
  IncomingTransfers,
  receiverAnswer,
  type IncomingHost,
} from './incomingTransfer.svelte';
import { pasteLocks } from '../util/pasteLock';
import { toPayload, type TabPayload } from '../util/tabPayload';
import { textFromString } from '../util/text';
import type {
  Answer,
  CommitResult,
  CommittedMeta,
  Point,
  TransferStatus,
} from '../util/tabTransferWire';
import type { NoteSnapshot } from './stickyNote.svelte';
import type { TabBarGeometry } from '../util/tabDrag';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
vi.stubGlobal('window', globalThis);
/** The script the fake core follows. */
interface Core {
  /** What `tab_transfer_claim` answers. */
  claim: { payload: TabPayload; offset?: Point } | null;
  answer: Answer;
  /** What `tab_transfer_committed` answers; an error rejects. */
  committed: CommitResult | Error;
  status: TransferStatus;
  stats: { dirty: boolean; totalBytes: number; totalLines: number } | Error;
  /** Runs when `tab_transfer_committed` is called. */
  onCommitted: ((meta: CommittedMeta) => void) | null;
  /** Runs when `tab_transfer_answer` is called. */
  onAnswer: ((ok: boolean) => void) | null;
}
let core: Core;

function backend(): void {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(((cmd: string, args?: unknown) => {
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
        return Promise.resolve([] satisfies NoteSnapshot[]);
      case 'tab_transfer_claim':
        return Promise.resolve(core.claim);
      case 'tab_transfer_answer':
        core.onAnswer?.((args as { ok: boolean }).ok);
        return Promise.resolve(core.answer);
      case 'tab_transfer_committed':
        core.onCommitted?.((args as { meta: CommittedMeta }).meta);
        return core.committed instanceof Error
          ? Promise.reject(core.committed)
          : Promise.resolve(core.committed);
      case 'tab_transfer_status':
        return Promise.resolve(core.status);
      case 'windowed_stats':
        return core.stats instanceof Error
          ? Promise.reject(core.stats)
          : Promise.resolve(core.stats);
      case 'live_doc_groups':
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  }) as typeof invoke);
}
function sent(): string[] {
  return mockInvoke.mock.calls.map(([cmd]) => cmd);
}
function argsOf(command: string): Record<string, unknown>[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === command)
    .map(([, args]) => (args ?? {}) as Record<string, unknown>);
}
function written(): NoteSnapshot[] {
  return argsOf('upsert_note').map((a) => a.note as NoteSnapshot);
}
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(done()).toBe(true);
}

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
type Extras = Parameters<typeof toPayload>[1];
const NO_EXTRAS: Extras = {
  editor: null,
  scroll: null,
  view: null,
  viewMode: null,
};
/** The payload of an ordinary tab coming from another window. */
function payloadOf(
  id: string,
  over: Partial<DocTab> = {},
  extras: Partial<Extras> = {},
): TabPayload {
  const sender = tab(id, 40, over);
  return JSON.parse(
    JSON.stringify(toPayload(sender, { ...NO_EXTRAS, ...extras })),
  ) as TabPayload;
}
const FREE: DragHost = {
  navigationLocked: () => false,
  gateVisible: () => false,
  modalOpen: () => false,
  closing: () => false,
  quitting: () => false,
};
/** Three tabs of 100 px at the left of a viewport, in a bar 30 px high. */
function geometry(): TabBarGeometry {
  return {
    tabs: [0, 100, 200].map((left) => ({ left, width: 100 })),
    scrollLeft: 0,
    bar: { left: 0, right: 600, top: 0, bottom: 30 },
  };
}
interface HostCalls {
  viewModes: Map<string, string>;
  /** What the window held when the view mode was applied: the order of events. */
  atViewMode: { seed: boolean; inTabs: boolean }[];
  closed: number;
  revealed: number;
  arrived: DocTab[];
}
let calls: HostCalls;
let modal: boolean;
let win: DocumentWindowState;
let incoming: IncomingTransfers;
let receive: boolean;
let readySpy: ReturnType<typeof vi.spyOn>;

function installHosts(): void {
  calls = {
    viewModes: new Map(),
    atViewMode: [],
    closed: 0,
    revealed: 0,
    arrived: [],
  };
  const transfer: TransferHost = {
    showLock: () => {},
    editorStateOf: () => null,
    scrollOf: () => null,
    viewModeOf: () => undefined,
    setViewMode: (id, mode) => {
      calls.viewModes.set(id, mode);
      calls.atViewMode.push({
        seed: win.pendingSeeds.has(id),
        inTabs: win.tabs.some((t) => t.id === id),
      });
    },
    forgetTab: () => {},
    dropGeometry: () => geometry(),
    modalOpen: () => modal,
    closeWindow: () => {
      calls.closed += 1;
      return Promise.resolve();
    },
  };
  win.dragHost = FREE;
  win.transferHost = transfer;
  win.transferListening = true;
  const host: IncomingHost = {
    receive,
    modalOpen: () => modal,
    arrived: (t) => {
      calls.arrived.push(t);
    },
    reveal: () => {
      calls.revealed += 1;
      return Promise.resolve();
    },
    closeWindow: () => {
      calls.closed += 1;
      return Promise.resolve();
    },
  };
  incoming = new IncomingTransfers(win, host);
}
/** A window holding tabs `a`, `b`, `c`… with the first one active. */
async function windowOf(...names: string[]): Promise<void> {
  await win.init('g', null, null);
  names.forEach((name, i) => win.tabs.push(tab(name, i)));
  if (names.length > 0) {
    win.activeIndex = 0;
  }
  installHosts();
  mockInvoke.mockClear();
}
function at(id: string): DocTab {
  const found = win.tabs.find((t) => t.id === id);
  if (found === undefined) {
    throw new Error(`no tab ${id}`);
  }
  return found;
}
function ids(): string[] {
  return win.tabs.map((t) => t.id);
}
/** Make a tab arrive: claim it with `claim` and run the flow to its end. */
async function arrive(
  payload: TabPayload,
  offset?: Point,
  t = 7,
): Promise<void> {
  core.claim = offset === undefined ? { payload } : { payload, offset };
  await incoming.take(t);
}

beforeEach(async () => {
  core = {
    claim: null,
    answer: 'commit',
    committed: 'accepted',
    status: 'gone',
    stats: { dirty: false, totalBytes: 1, totalLines: 1 },
    onCommitted: null,
    onAnswer: null,
  };
  modal = false;
  receive = false;
  platform.os = 'macos';
  backend();
  readySpy = vi.spyOn(editionState, 'ready').mockResolvedValue();
  editionState.lite = false;
  win = new DocumentWindowState();
  await settingsState.init();
});

afterEach(() => {
  readySpy.mockRestore();
  for (const t of win.tabs) {
    pasteLocks.drop(t.id);
  }
  vi.restoreAllMocks();
});

describe('what the receiver answers', () => {
  const OK = { ready: true, indexSettled: true, locked: false, holdsId: false };

  it('takes a tab when nothing is in the way', () => {
    expect(receiverAnswer(OK)).toBe(true);
  });

  it.each([
    ['the window has not loaded its tabs', { ready: false }],
    ['it does not know its tab indices yet', { indexSettled: false }],
    ['a drag-start lock holds it', { locked: true }],
    ['it already holds the tab', { holdsId: true }],
  ])('refuses when %s', (_why, change) => {
    expect(receiverAnswer({ ...OK, ...change })).toBe(false);
  });

  it('answers false to the core for a dialog, a gate, a close and a quit', async () => {
    for (const host of [
      { ...FREE, modalOpen: () => true },
      { ...FREE, gateVisible: () => true },
      { ...FREE, navigationLocked: () => true },
      { ...FREE, closing: () => true },
      { ...FREE, quitting: () => true },
    ]) {
      win = new DocumentWindowState();
      await windowOf('a');
      win.dragHost = host;
      const answers: boolean[] = [];
      core.onAnswer = (ok) => answers.push(ok);
      core.answer = 'expired';
      await arrive(payloadOf('x'));
      expect(answers).toEqual([false]);
      expect(win.tabs).toHaveLength(1);
    }
  });

  it('answers false while the window is not ready or its index not settled', async () => {
    win = new DocumentWindowState();
    installHosts();
    const answers: boolean[] = [];
    core.onAnswer = (ok) => answers.push(ok);
    core.answer = 'expired';
    await arrive(payloadOf('x'));
    expect(answers).toEqual([false]);
  });

  it('answers false for a tab it already holds, in its tabs or among its copies', async () => {
    await windowOf('a', 'x');
    const answers: boolean[] = [];
    core.onAnswer = (ok) => answers.push(ok);
    core.answer = 'expired';
    await arrive(payloadOf('x'));
    expect(answers).toEqual([false]);
    win.tabs.length = 0;
    win.holdIncoming(3, payloadOf('y'), null);
    await arrive(payloadOf('y'), undefined, 4);
    expect(answers).toEqual([false, false]);
  });
});

describe('a tab at commit', () => {
  it('is an incoming copy outside the tabs: nothing of the window changes', async () => {
    await windowOf('a', 'b');
    const before = {
      held: win.heldTab?.id,
      mru: [...win.ordinaryMru],
      active: win.activeTab?.id,
    };
    let during: Record<string, unknown> = {};
    core.onCommitted = () => {
      during = {
        tabs: ids(),
        copies: [...win.incoming.keys()],
        held: win.heldTab?.id,
        mru: [...win.ordinaryMru],
        active: win.activeTab?.id,
        empty: win.isEmpty,
        committing: win.committing !== null,
        locked: win.dragLocked(),
      };
    };
    await arrive(payloadOf('x'));
    expect(during).toEqual({
      tabs: ['a', 'b'],
      copies: [7],
      held: before.held,
      mru: before.mru,
      active: before.active,
      empty: false,
      committing: true,
      locked: true,
    });
    // It is cleared in a `finally`.
    expect(win.committing).toBeNull();
    expect(win.incoming.size).toBe(0);
  });

  it('is not written, reported or counted before the core accepts', async () => {
    await windowOf('a');
    core.onCommitted = () => {
      expect(sent()).not.toContain('upsert_note');
      expect(ids()).toEqual(['a']);
    };
    await arrive(payloadOf('x'));
  });

  it('keeps the window from being empty and its first copy from closing it', async () => {
    await windowOf();
    core.onCommitted = () => {
      expect(win.tabs).toHaveLength(0);
      expect(win.isEmpty).toBe(false);
    };
    await arrive(payloadOf('x'));
    expect(ids()).toEqual(['x']);
  });

  it('reserves a tab index above every tab and every copy', async () => {
    await windowOf('a', 'b');
    let meta: CommittedMeta | null = null;
    core.onCommitted = (m) => {
      meta = m;
    };
    await arrive(payloadOf('x'));
    expect(meta).toMatchObject({ tabIndex: 2, group: 'g', project: null });
    expect(meta!.bounds).toEqual({
      x: null,
      y: null,
      width: null,
      height: null,
    });
  });

  it("reports the receiver's project and bounds", async () => {
    await windowOf('a');
    win.project = '/proj';
    win.setBounds(10, 20, 300, 400);
    let meta: CommittedMeta | null = null;
    core.onCommitted = (m) => {
      meta = m;
    };
    await arrive(payloadOf('x'));
    expect(meta).toMatchObject({
      project: '/proj',
      bounds: { x: 10, y: 20, width: 300, height: 400 },
    });
  });
});

describe('where an accepted tab is put', () => {
  it('goes between the tabs the offset falls between', async () => {
    await windowOf('a', 'b', 'c');
    // The boundary of the second and third tabs.
    await arrive(payloadOf('x'), { x: 200, y: 15 });
    expect(ids()).toEqual(['a', 'b', 'x', 'c']);
    expect(at('x').order).toBe(1.5);
  });

  it('goes first when the offset is over the first tab', async () => {
    await windowOf('a', 'b');
    await arrive(payloadOf('x'), { x: 10, y: 15 });
    expect(ids()).toEqual(['x', 'a', 'b']);
    expect(at('x').order).toBe(-1);
  });

  it('is appended when the offset is below the tab bar', async () => {
    await windowOf('a', 'b', 'c');
    await arrive(payloadOf('x'), { x: 50, y: 300 });
    expect(ids()).toEqual(['a', 'b', 'c', 'x']);
    expect(at('x').order).toBe(3);
  });

  it('is appended when there is no offset', async () => {
    await windowOf('a', 'b', 'c');
    await arrive(payloadOf('x'));
    expect(ids()).toEqual(['a', 'b', 'c', 'x']);
  });

  it('is appended when the offset is past the last tab', async () => {
    await windowOf('a', 'b', 'c');
    await arrive(payloadOf('x'), { x: 450, y: 10 });
    expect(ids()).toEqual(['a', 'b', 'c', 'x']);
  });

  it('turns the offset into a point of the window by its own device pixel ratio on Windows', async () => {
    await windowOf('a', 'b', 'c');
    platform.os = 'windows';
    vi.stubGlobal('devicePixelRatio', 2);
    try {
      // 400 physical px is 200 CSS px: the boundary of the second and third tab.
      await arrive(payloadOf('x'), { x: 400, y: 30 });
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal('window', globalThis);
    }
    expect(ids()).toEqual(['a', 'b', 'x', 'c']);
  });

  it('writes every tab with its position when no key is left between the neighbours', async () => {
    await windowOf();
    win.tabs.push(
      tab('a', 0, { order: 1 }),
      tab('b', 1, { order: 1 + Number.EPSILON }),
      tab('c', 2, { order: 2 }),
    );
    win.activeIndex = 0;
    await arrive(payloadOf('x'), { x: 100, y: 10 });
    expect(ids()).toEqual(['a', 'x', 'b', 'c']);
    expect(win.tabs.map((t) => t.order)).toEqual([0, 1, 2, 3]);
    await until(() => written().length === 4);
    expect(written().map((n) => [n.id, n.tab_order])).toEqual([
      ['a', 0],
      ['x', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });
});

describe('an accepted tab', () => {
  it('has its seed stored before it is one of the tabs', async () => {
    await windowOf('a');
    const seeded = payloadOf(
      'x',
      {},
      {
        editor: { selection: { ranges: [], main: 0 } },
        scroll: { pos: 1, yMargin: 2, scrollLeft: 3 },
        viewMode: 'markdown',
      },
    );
    await arrive(seeded);
    expect(calls.atViewMode).toEqual([{ seed: true, inTabs: false }]);
    expect(win.takeSeed('x')).toEqual({
      editor: { selection: { ranges: [], main: 0 } },
      scroll: { pos: 1, yMargin: 2, scrollLeft: 3 },
    });
    // The editor takes it once.
    expect(win.takeSeed('x')).toBeUndefined();
  });

  it('stores no seed for a tab that came without an editor state or scroll', async () => {
    await windowOf('a');
    await arrive(payloadOf('x'));
    expect(win.pendingSeeds.has('x')).toBe(false);
  });

  it('applies its view mode through the window and its view position', async () => {
    await windowOf('a');
    await arrive(
      payloadOf('x', {}, { viewMode: 'json', view: { top: 12, caretLine: 3 } }),
    );
    expect(calls.viewModes.get('x')).toBe('json');
    expect(win.viewTopLine('x')).toBe(12);
  });

  it('is written from this window, with its place', async () => {
    await windowOf('a');
    await arrive(payloadOf('x'));
    await until(() => written().length === 1);
    expect(written()[0]).toMatchObject({
      id: 'x',
      window_group: 'g',
      tab_index: 1,
      tab_order: 1,
    });
  });

  it('keeps its text, its saved text and its state', async () => {
    await windowOf('a');
    await arrive(
      payloadOf('x', {
        content: textFromString('edited'),
        savedContent: textFromString('saved'),
        encoding: 'Big5',
        lineEnding: 'CRLF',
      }),
    );
    expect(at('x').content.toString()).toBe('edited');
    expect(at('x').savedContent.toString()).toBe('saved');
    expect(win.isDirty(at('x'))).toBe(true);
    expect(at('x').encoding).toBe('Big5');
    expect(at('x').lineEnding).toBe('CRLF');
    expect(at('x').transferring).toBeUndefined();
  });

  it('is activated, and revealed with the window told of it', async () => {
    await windowOf('a', 'b');
    await arrive(payloadOf('x'), { x: 10, y: 10 });
    await until(() => win.activeTab?.id === 'x');
    expect(calls.arrived.map((t) => t.id)).toEqual(['x']);
    expect(calls.revealed).toBe(1);
  });

  it('is inserted but not activated while a dialog is up', async () => {
    await windowOf('a', 'b');
    modal = true;
    await arrive(payloadOf('x'), { x: 10, y: 10 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ids()).toEqual(['x', 'a', 'b']);
    expect(win.activeTab?.id).toBe('a');
    // The window is still revealed.
    expect(calls.revealed).toBe(1);
  });

  it('keeps the active tab and the MRU until the activation when it goes before it', async () => {
    await windowOf('a', 'b');
    win.activeIndex = 1;
    const mru = [...win.ordinaryMru];
    // The copy is accepted by the window, not yet activated.
    const copy = win.holdIncoming(9, payloadOf('x'), { x: 10, y: 10 });
    const tab = win.acceptIncoming(9, false);
    expect(tab?.id).toBe('x');
    expect(ids()).toEqual(['x', 'a', 'b']);
    expect(copy.tab).toBe(tab);
    expect(win.activeTab?.id).toBe('b');
    expect(win.activeIndex).toBe(2);
    expect(win.ordinaryMru).toEqual(mru);
  });

  it('becomes the active tab of a window that had none', async () => {
    await windowOf();
    await arrive(payloadOf('x'));
    expect(win.activeTab?.id).toBe('x');
    expect(win.heldTab?.id).toBe('x');
  });

  it("is marked missing again for the window's queue", async () => {
    await windowOf('a');
    await arrive(payloadOf('x', { missing: true }));
    expect(calls.arrived[0]?.missing).toBe(true);
  });

  it('a pending windowed restore starts only once the tab is the active one', async () => {
    await windowOf('a');
    modal = true;
    await arrive(
      payloadOf('r', {
        content: Text.empty,
        savedContent: Text.empty,
        windowedRestore: {
          index: null,
          fingerprint: { size: 1, mtime_ms: 1 },
          digest: '1',
          topLine: 0,
          size: 1,
        },
      }),
    );
    expect(sent()).not.toContain('windowed_reopen');
    expect(at('r').windowedRestore).toBeDefined();
  });

  it('has the totals of its windowed session read again', async () => {
    await windowOf('a');
    core.stats = { dirty: true, totalBytes: 999, totalLines: 55 };
    await arrive(
      payloadOf('w', {
        content: Text.empty,
        savedContent: Text.empty,
        windowed: {
          sessionId: 7,
          totalBytes: 1,
          totalLines: 1,
          fingerprint: { size: 1, mtime_ms: 1 },
          dirty: false,
          topLine: 0,
        },
      }),
    );
    expect(argsOf('windowed_stats')).toEqual([{ sessionId: 7 }]);
    expect(at('w').windowed).toMatchObject({
      dirty: true,
      totalBytes: 999,
      totalLines: 55,
    });
    expect(win.isDirty(at('w'))).toBe(true);
  });

  it('is refused when the core no longer has its windowed session', async () => {
    await windowOf('a');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    core.stats = new Error('unknown-session');
    core.answer = 'expired';
    const answers: boolean[] = [];
    core.onAnswer = (ok) => answers.push(ok);
    await arrive(
      payloadOf('w', {
        content: Text.empty,
        savedContent: Text.empty,
        windowed: {
          sessionId: 7,
          totalBytes: 1,
          totalLines: 1,
          fingerprint: { size: 1, mtime_ms: 1 },
          dirty: false,
          topLine: 0,
        },
      }),
    );
    expect(answers).toEqual([false]);
    expect(ids()).toEqual(['a']);
  });

  it('shares one rope between its text and its seeded document once the editor built it', async () => {
    await windowOf('a');
    await arrive(payloadOf('x'));
    const doc = textFromString('x');
    win.seededDoc('x', doc);
    expect(at('x').content).toBe(doc);
    expect(at('x').savedContent).toBe(doc);
    // A document that is not the tab's text is not taken.
    win.seededDoc('x', textFromString('other'));
    expect(at('x').content).toBe(doc);
  });

  it('has its seed deleted when the tab is closed before the editor took it', async () => {
    await windowOf('a');
    await arrive(
      payloadOf('x', {}, { scroll: { pos: 0, yMargin: 0, scrollLeft: 0 } }),
    );
    expect(win.pendingSeeds.has('x')).toBe(true);
    await win.deleteTab(win.tabs.findIndex((t) => t.id === 'x'));
    expect(win.pendingSeeds.has('x')).toBe(false);
  });
});

describe('a transfer that does not end accepted', () => {
  it('drops a rejected tab without writing anything', async () => {
    await windowOf('a');
    core.committed = 'rejected';
    await arrive(payloadOf('x'));
    expect(ids()).toEqual(['a']);
    expect(win.incoming.size).toBe(0);
    expect(sent()).not.toContain('upsert_note');
    expect(win.committing).toBeNull();
    expect(calls.arrived).toEqual([]);
    expect(calls.revealed).toBe(0);
  });

  it('closes a window left with nothing through the helper', async () => {
    await windowOf();
    core.committed = 'rejected';
    await arrive(payloadOf('x'));
    expect(win.isEmpty).toBe(true);
    expect(calls.closed).toBe(1);
  });

  it('does not close a window that has tabs', async () => {
    await windowOf('a');
    core.committed = 'rejected';
    await arrive(payloadOf('x'));
    expect(calls.closed).toBe(0);
  });

  it('makes no `committed` call for a copy dropped while the window made ready', async () => {
    await windowOf('a');
    win.endComposition = () => {
      incoming.onAbort(7);
      return Promise.resolve();
    };
    await arrive(payloadOf('x'));
    expect(sent()).not.toContain('tab_transfer_committed');
    expect(ids()).toEqual(['a']);
  });

  it('inserts when `committed` failed but the core says it was accepted', async () => {
    await windowOf('a');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    core.committed = new Error('lost');
    core.status = 'accepted';
    await arrive(payloadOf('x'));
    expect(argsOf('tab_transfer_status')).toEqual([{ t: 7 }]);
    expect(ids()).toEqual(['a', 'x']);
  });

  it.each<TransferStatus>(['pending', 'gone'])(
    'drops the copy when `committed` failed and the core says %s',
    async (status) => {
      await windowOf('a');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      core.committed = new Error('lost');
      core.status = status;
      await arrive(payloadOf('x'));
      expect(ids()).toEqual(['a']);
      expect(win.incoming.size).toBe(0);
      expect(sent()).not.toContain('upsert_note');
    },
  );

  it('keeps an accepted tab even when its copy was dropped meanwhile', async () => {
    await windowOf('a');
    core.onCommitted = () => {
      win.dropIncoming(7);
    };
    await arrive(payloadOf('x'));
    expect(ids()).toEqual(['a', 'x']);
  });

  it('drops the copy the core aborted', async () => {
    await windowOf('a');
    win.holdIncoming(3, payloadOf('x'), null);
    expect(win.isEmpty).toBe(false);
    incoming.onAbort(3);
    expect(win.incoming.size).toBe(0);
    expect(win.wasDropped(3)).toBe(true);
    expect(calls.closed).toBe(0);
  });

  it('closes a window whose only copy the core aborted', async () => {
    await windowOf();
    win.holdIncoming(3, payloadOf('x'), null);
    incoming.onAbort(3);
    expect(calls.closed).toBe(1);
  });
});

describe('a window made for the tab', () => {
  beforeEach(() => {
    receive = true;
  });

  it('closes on an abort, a null claim and a refusal, and shows itself only after accepted', async () => {
    // A null claim.
    await windowOf();
    core.claim = null;
    await incoming.take(7);
    expect(calls.closed).toBe(1);
    expect(calls.revealed).toBe(0);
    // A refusal (the window answers false, or the core says it expired).
    win = new DocumentWindowState();
    await windowOf();
    core.answer = 'expired';
    await arrive(payloadOf('x'));
    expect(calls.closed).toBe(1);
    expect(calls.revealed).toBe(0);
    // An abort that arrives first.
    win = new DocumentWindowState();
    await windowOf();
    incoming.onAbort(7);
    expect(calls.closed).toBe(1);
    // A rejection at the end.
    win = new DocumentWindowState();
    await windowOf();
    core.answer = 'commit';
    core.committed = 'rejected';
    await arrive(payloadOf('x'));
    expect(calls.closed).toBe(1);
    expect(calls.revealed).toBe(0);
  });

  it('reveals only when the tab is in', async () => {
    await windowOf();
    core.onCommitted = () => {
      expect(calls.revealed).toBe(0);
    };
    await arrive(payloadOf('x'));
    expect(calls.revealed).toBe(1);
    expect(calls.closed).toBe(0);
    expect(ids()).toEqual(['x']);
  });
});

describe('a rename while a tab is on its way in', () => {
  it('reaches a claimed payload before it is a copy', async () => {
    await windowOf('a');
    let seen = '';
    win.endComposition = () => {
      incoming.retargetPaths('/p', '/q');
      return Promise.resolve();
    };
    core.onCommitted = () => {
      seen = [...win.incoming.values()][0]?.tab.path ?? '';
    };
    await arrive(payloadOf('x'));
    expect(seen).toBe('/q/x.txt');
    expect(at('x').path).toBe('/q/x.txt');
  });

  it('reaches a copy the window holds', async () => {
    await windowOf('a');
    const copy = win.holdIncoming(3, payloadOf('x'), null);
    win.retargetPaths('/p', '/q');
    expect(copy.tab.path).toBe('/q/x.txt');
    expect(copy.tab.language).toBeNull();
    // Nothing is written for a tab that is not the window's yet.
    expect(sent()).not.toContain('upsert_note');
  });
});
