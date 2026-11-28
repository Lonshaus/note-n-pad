// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A tab torn off its bar, from the window state's side: starting the drag's
// transfer, a tab the core sends on, and a tear-off waiting for its role to end.
// Driven through the real window state against a fake core.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { settingsState } from './settings.svelte';
import { editionState } from './edition.svelte';
import { platform } from './platform.svelte';
import {
  DocumentWindowState,
  SEND_WAIT_MS,
  type DocTab,
  type DragHost,
  type TransferHost,
} from './documentWindow.svelte';
import {
  IncomingTransfers,
  type IncomingHost,
} from './incomingTransfer.svelte';
import { CloseGate } from './closeGate.svelte';
import { pasteLocks } from '../util/pasteLock';
import { toPayload, type TabPayload } from '../util/tabPayload';
import {
  BEGIN,
  DROP,
  type Answer,
  type BeginResult,
  type CommitResult,
  type DropTarget,
  type SendPayload,
  type TearOffTarget,
} from '../util/tabTransferWire';
import type { NoteSnapshot } from './stickyNote.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
vi.stubGlobal('window', globalThis);
/** The script the fake core follows. */
interface Core {
  begin: BeginResult | Error;
  /** Holds `tab_transfer_begin` until it is released. */
  beginGate: Promise<void> | null;
  /** Holds every `upsert_note` until it is released. */
  writeGate: Promise<void> | null;
  /** Whether `upsert_note` reaches the disk. */
  writesWork: boolean;
  claim: { payload: TabPayload } | null;
  answer: Answer;
  committed: CommitResult;
}
let core: Core;

function backend(): void {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(((cmd: string) => {
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
      case 'tab_transfer_begin': {
        const reply =
          core.begin instanceof Error
            ? Promise.reject(core.begin)
            : Promise.resolve(core.begin);
        return core.beginGate === null
          ? reply
          : core.beginGate.then(() => reply);
      }
      case 'tab_transfer_claim':
        return Promise.resolve(core.claim);
      case 'tab_transfer_answer':
        return Promise.resolve(core.answer);
      case 'tab_transfer_committed':
        return Promise.resolve(core.committed);
      case 'upsert_note': {
        const reply = core.writesWork
          ? Promise.resolve(null)
          : Promise.reject(new Error('disk full'));
        return core.writeGate === null
          ? reply
          : core.writeGate.then(() => reply);
      }
      case 'live_doc_groups':
        return Promise.resolve([]);
      case 'path_writable':
        return Promise.resolve(true);
      case 'stat_file':
        return Promise.resolve({ size: 10 });
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
const FREE: DragHost = {
  navigationLocked: () => false,
  gateVisible: () => false,
  modalOpen: () => false,
  closing: () => false,
  quitting: () => false,
};
const START: TearOffTarget = {
  kind: DROP.tearOff,
  id: 'drag-1',
  grab: { x: 20, y: 14 },
  firstTabClientX: 4,
  escOffset: { x: 101, y: 15 },
  dpr: 2,
  width: 90,
  title: 'a.txt',
};
const DOC_TARGET: Extract<DropTarget, { kind: 'doc' }> = {
  kind: DROP.doc,
  label: 'doc-other',
  offset: { x: 40, y: 10 },
};
const SEND: SendPayload = { note: 'n', target: DOC_TARGET };

let win: DocumentWindowState;
let readySpy: ReturnType<typeof vi.spyOn>;
let locks: unknown[];
let revealed: number;
/** A window holding tabs `names`, the first one active. */
async function windowOf(...names: string[]): Promise<void> {
  await win.init('g', null, null);
  names.forEach((name, i) => win.tabs.push(tab(name, i)));
  if (names.length > 0) {
    win.activeIndex = 0;
  }
  win.dragHost = FREE;
  const host: TransferHost = {
    showLock: (_id, lock) => {
      locks.push(lock);
    },
    editorStateOf: () => null,
    scrollOf: () => null,
    viewModeOf: () => undefined,
    setViewMode: () => {},
    forgetTab: () => {},
    dropGeometry: () => null,
    modalOpen: () => false,
    closeWindow: () => Promise.resolve(),
  };
  win.transferHost = host;
  win.transferListening = true;
  win.revealSelf = () => {
    revealed += 1;
    return Promise.resolve();
  };
  mockInvoke.mockClear();
}
function at(id: string): DocTab {
  const found = win.tabs.find((t) => t.id === id);
  if (found === undefined) {
    throw new Error(`no tab ${id}`);
  }
  return found;
}

beforeEach(async () => {
  core = {
    begin: { kind: BEGIN.started, t: 7 },
    beginGate: null,
    writeGate: null,
    writesWork: true,
    claim: null,
    answer: 'commit',
    committed: 'accepted',
  };
  locks = [];
  revealed = 0;
  platform.os = 'macos';
  backend();
  readySpy = vi.spyOn(editionState, 'ready').mockResolvedValue();
  editionState.lite = false;
  win = new DocumentWindowState();
  await settingsState.init();
});

afterEach(() => {
  vi.useRealTimers();
  readySpy.mockRestore();
  for (const t of win.tabs) {
    pasteLocks.drop(t.id);
  }
  vi.restoreAllMocks();
});

describe('detaching a tab through the transfer machinery', () => {
  it('begins a transfer to the tear-off target and says it started', async () => {
    await windowOf('a', 'b');
    const result = await win.detachTab(at('b'), START, () => false);
    expect(result).toBe('started');
    const [begin] = argsOf('tab_transfer_begin');
    expect(begin?.target).toEqual(START);
    expect((begin?.payload as TabPayload).tab.id).toBe('b');
    expect(at('b').transferring).toBe(true);
  });

  it('holds `preparing` while it runs, so a close settles it first', async () => {
    await windowOf('a', 'b');
    let open!: () => void;
    core.beginGate = new Promise((resolve) => {
      open = resolve;
    });
    const detaching = win.detachTab(at('b'), START, () => false);
    await until(
      () => win.preparing !== null && sent().includes('tab_transfer_begin'),
    );
    expect(win.preparingTab).toBe(at('b'));
    open();
    expect(await detaching).toBe('started');
    expect(win.preparing).toBeNull();
  });

  it('is `notStarted` for a window without a host and for a busy tab', async () => {
    await windowOf('a', 'b');
    win.transferHost = null;
    expect(await win.detachTab(at('b'), START, () => false)).toBe('notStarted');
    win.transferHost = {
      showLock: () => {},
      editorStateOf: () => null,
      scrollOf: () => null,
      viewModeOf: () => undefined,
      setViewMode: () => {},
      forgetTab: () => {},
      dropGeometry: () => null,
      modalOpen: () => false,
      closeWindow: () => Promise.resolve(),
    };
    at('b').inFlight = 1;
    expect(await win.detachTab(at('b'), START, () => false)).toBe('notStarted');
    expect(sent()).not.toContain('tab_transfer_begin');
  });

  it('is `notStarted` when the tab is gone or busy by the time its writes settled', async () => {
    await windowOf('a', 'b');
    let open!: () => void;
    core.writeGate = new Promise((resolve) => {
      open = resolve;
    });
    const gone = win.detachTab(at('b'), START, () => false);
    await until(() => sent().includes('upsert_note'));
    win.tabs.splice(1, 1);
    open();
    expect(await gone).toBe('notStarted');
    core.writeGate = null;
    win.tabs.push(tab('c', 2));
    let release!: () => void;
    core.writeGate = new Promise((resolve) => {
      release = resolve;
    });
    const busy = win.detachTab(at('c'), START, () => false);
    await until(() => argsOf('upsert_note').length > 1);
    at('c').inFlight = 1;
    release();
    expect(await busy).toBe('notStarted');
    expect(sent()).not.toContain('tab_transfer_begin');
  });

  it('is `notStarted` when the stored record could not be written', async () => {
    await windowOf('a', 'b');
    core.writesWork = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await win.detachTab(at('b'), START, () => false)).toBe('notStarted');
    expect(sent()).not.toContain('tab_transfer_begin');
  });

  it('is `notStarted`, and gives the tab back, when the core refuses or fails', async () => {
    await windowOf('a', 'b');
    core.begin = { kind: BEGIN.refused, reason: 'not_ready' };
    expect(await win.detachTab(at('b'), START, () => false)).toBe('notStarted');
    expect(at('b').transferring).toBeUndefined();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    core.begin = new Error('no');
    expect(await win.detachTab(at('b'), START, () => false)).toBe('notStarted');
    expect(at('b').transferring).toBeUndefined();
    expect(win.preparing).toBeNull();
  });

  it('asks the core nothing when Esc came during its awaits, and leaves the tab free', async () => {
    await windowOf('a', 'b');
    let open!: () => void;
    core.writeGate = new Promise((resolve) => {
      open = resolve;
    });
    let esc = false;
    const detaching = win.detachTab(at('b'), START, () => esc);
    await until(() => sent().includes('upsert_note'));
    esc = true;
    open();
    expect(await detaching).toBe('notStarted');
    expect(sent()).not.toContain('tab_transfer_begin');
    expect(at('b').transferring).toBeUndefined();
    expect(locks).toEqual([]);
  });

  it('does not stop a begin that is in flight when Esc comes: the core was asked', async () => {
    await windowOf('a', 'b');
    let open!: () => void;
    core.beginGate = new Promise((resolve) => {
      open = resolve;
    });
    let esc = false;
    const detaching = win.detachTab(at('b'), START, () => esc);
    await until(() => sent().includes('tab_transfer_begin'));
    esc = true;
    open();
    expect(await detaching).toBe('started');
    expect(at('b').transferring).toBe(true);
  });
});

describe('a tab the core sends on', () => {
  async function tearOffWindow(): Promise<void> {
    await windowOf('n');
    win.tearOffRole = true;
    win.dragHost = { ...FREE };
  }

  it('ends the role, then sends the tab with that note id to the bar it names', async () => {
    await tearOffWindow();
    await win.onTransferSend(SEND);
    expect(win.tearOffRole).toBe(false);
    const [begin] = argsOf('tab_transfer_begin');
    expect(begin?.target).toEqual(DOC_TARGET);
    expect((begin?.payload as TabPayload).tab.id).toBe('n');
    expect(revealed).toBe(0);
  });

  it('waits until the tab is in and nothing is putting it in', async () => {
    await tearOffWindow();
    let installed!: () => void;
    win.committing = new Promise<void>((resolve) => {
      installed = resolve;
    });
    const sending = win.onTransferSend(SEND);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sent()).not.toContain('tab_transfer_begin');
    win.committing = null;
    installed();
    await sending;
    expect(sent()).toContain('tab_transfer_begin');
  });

  it('waits for what ends by itself on the tab, and sends then', async () => {
    await tearOffWindow();
    at('n').inFlight = 1;
    const sending = win.onTransferSend(SEND);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sent()).not.toContain('tab_transfer_begin');
    at('n').inFlight = 0;
    await sending;
    expect(sent()).toContain('tab_transfer_begin');
    expect(revealed).toBe(0);
  });

  it('shows the window with the tab when a dialog holds it', async () => {
    await tearOffWindow();
    win.dragHost = { ...FREE, modalOpen: () => true };
    await win.onTransferSend(SEND);
    expect(sent()).not.toContain('tab_transfer_begin');
    expect(revealed).toBe(1);
    expect(win.tearOffRole).toBe(false);
  });

  it('shows the window with the tab when the wait runs out', async () => {
    vi.useFakeTimers();
    await tearOffWindow();
    at('n').inFlight = 1;
    const sending = win.onTransferSend(SEND);
    await vi.advanceTimersByTimeAsync(SEND_WAIT_MS + 100);
    await sending;
    expect(sent()).not.toContain('tab_transfer_begin');
    expect(revealed).toBe(1);
  });

  it('shows the window with the tab when the core does not start the transfer', async () => {
    await tearOffWindow();
    core.begin = { kind: BEGIN.refused, reason: 'not_ready' };
    await win.onTransferSend(SEND);
    expect(sent()).toContain('tab_transfer_begin');
    expect(revealed).toBe(1);
    expect(at('n').transferring).toBeUndefined();
  });

  it('shows the window with the tab when the transfer is called off later, not when it lands', async () => {
    await tearOffWindow();
    await win.onTransferSend(SEND);
    expect(revealed).toBe(0);
    win.onTransferCancel(7);
    await until(() => revealed === 1);
    // A transfer that landed shows nothing.
    await windowOf('m');
    core.begin = { kind: BEGIN.started, t: 8 };
    await win.onTransferSend({ note: 'm', target: DOC_TARGET });
    win.applyRelease(8);
    expect(revealed).toBe(1);
  });

  it('sends nothing and shows nothing while the window is closing or quitting', async () => {
    for (const host of [
      { ...FREE, closing: () => true },
      { ...FREE, quitting: () => true },
    ]) {
      await tearOffWindow();
      win.dragHost = host;
      await win.onTransferSend(SEND);
      expect(sent()).not.toContain('tab_transfer_begin');
      expect(revealed).toBe(0);
    }
  });

  it('shows nothing and sends nothing for a tab it does not hold', async () => {
    vi.useFakeTimers();
    await tearOffWindow();
    const sending = win.onTransferSend({ note: 'other', target: DOC_TARGET });
    await vi.advanceTimersByTimeAsync(SEND_WAIT_MS + 100);
    await sending;
    expect(sent()).not.toContain('tab_transfer_begin');
    expect(revealed).toBe(0);
  });
});

describe('a tear-off waiting for its role to end', () => {
  let calls: { revealed: number; arrived: DocTab[] };
  let incoming: IncomingTransfers;
  function payloadOf(id: string): TabPayload {
    return JSON.parse(
      JSON.stringify(
        toPayload(tab(id, 40), {
          editor: null,
          scroll: null,
          view: null,
          viewMode: null,
        }),
      ),
    ) as TabPayload;
  }
  async function tearOff(): Promise<void> {
    await windowOf();
    calls = { revealed: 0, arrived: [] };
    const host: IncomingHost = {
      receive: true,
      modalOpen: () => false,
      arrived: (t) => {
        calls.arrived.push(t);
      },
      reveal: () => {
        calls.revealed += 1;
        return Promise.resolve();
      },
      closeWindow: () => Promise.resolve(),
    };
    incoming = new IncomingTransfers(win, host);
    win.tearOffRole = true;
    win.tearOffFirst = 7;
  }
  function answers(): boolean[] {
    return argsOf('tab_transfer_answer').map((a) => a.ok as boolean);
  }

  it('is locked for every drag, for itself, until the role ends', async () => {
    await tearOff();
    expect(win.dragLocked()).toBe(true);
    expect(win.lockedForIncoming(7)).toBe(false);
    expect(win.lockedForIncoming(8)).toBe(true);
    win.endTearOffRole();
    expect(win.dragLocked()).toBe(false);
    expect(win.tearOffFirst).toBeNull();
  });

  it('answers its routed first transfer ok and installs the tab without showing the window', async () => {
    await tearOff();
    core.claim = { payload: payloadOf('x') };
    await incoming.take(7);
    expect(answers()).toEqual([true]);
    expect(win.tabs.map((t) => t.id)).toEqual(['x']);
    expect(calls.arrived).toHaveLength(1);
    // The role lasted: the core shows the window, never the tab that arrived.
    expect(calls.revealed).toBe(0);
  });

  it('refuses every other transfer that comes while the role lasts', async () => {
    await tearOff();
    core.claim = { payload: payloadOf('y') };
    core.answer = 'expired';
    await incoming.take(8);
    expect(answers()).toEqual([false]);
    expect(win.tabs).toHaveLength(0);
  });

  it('answers again, and shows the window as any other, once the role ended', async () => {
    await tearOff();
    core.claim = { payload: payloadOf('x') };
    await incoming.take(7);
    win.endTearOffRole();
    core.claim = { payload: payloadOf('z') };
    await incoming.take(9);
    expect(answers()).toEqual([true, true]);
    expect(win.tabs.map((t) => t.id)).toEqual(['x', 'z']);
    expect(calls.revealed).toBe(1);
  });

  it('keeps no other lock: a dialog still refuses its own tab', async () => {
    await tearOff();
    win.dragHost = { ...FREE, modalOpen: () => true };
    core.claim = { payload: payloadOf('x') };
    core.answer = 'expired';
    await incoming.take(7);
    expect(answers()).toEqual([false]);
  });
});

describe('a close or quit that is called off', () => {
  function gateOf(): { gate: CloseGate; calledOff: () => number } {
    const gate = new CloseGate(win, {
      label: 'doc-g',
      finishWindowClose: () => Promise.resolve(),
      finishTabClose: () => Promise.resolve(),
      focusWindow: () => Promise.resolve(),
    });
    let n = 0;
    gate.onCallOff = () => {
      n += 1;
    };
    return { gate, calledOff: () => n };
  }

  it('is reported when the gate is cancelled, the quit is vetoed or the close fails', async () => {
    await windowOf('a');
    const { gate, calledOff } = gateOf();
    gate.cancel();
    expect(calledOff()).toBe(1);
    gate.onFlushCancelled();
    expect(calledOff()).toBe(2);
    gate.abandonClose();
    expect(calledOff()).toBe(3);
  });

  it('is told to the core from a page in its tear-off role, and not from another', () => {
    const app = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'DocumentApp.svelte',
      ),
      'utf8',
    );
    const at = app.indexOf('gate.onCallOff = () => {');
    expect(at).toBeGreaterThan(-1);
    const handler = app.slice(at, app.indexOf('\n  };', at));
    expect(handler).toContain(
      'tearOffCloseCalledOff(documentWindow.tearOffRole, () => {',
    );
    expect(handler).toContain("invoke('tab_tearoff_close_vetoed')");
  });
});
