// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A tab on its way out of a window, from the sender's side: the release that
// decides where it goes, the busy check, the freeze, the begin, and how the tab
// leaves or comes back. Driven through the real window state against a fake
// core that answers each command from a script.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { settingsState } from './settings.svelte';
import { editionState } from './edition.svelte';
import { convertController } from './convertController.svelte';
import {
  DocumentWindowState,
  transferBlocker,
  type BlockFacts,
  type DocTab,
  type DragHost,
  type ReleaseAt,
  type TransferBlock,
  type TransferHost,
} from './documentWindow.svelte';
import { pasteLocks } from '../util/pasteLock';
import {
  DROP,
  type BeginResult,
  type CancelResult,
  type DropTarget,
  type SettleAction,
} from '../util/tabTransferWire';
import type { NoteSnapshot } from './stickyNote.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockSave = vi.mocked(save);
vi.stubGlobal('window', globalThis);
/** The script the fake core follows. */
interface Core {
  /** What `tab_drop_target` answers. */
  target: DropTarget;
  /** What `tab_transfer_begin` answers; an error rejects. */
  begin: BeginResult | Error;
  cancel: CancelResult;
  settle: SettleAction[];
  /** Whether `upsert_note` reaches the disk. */
  writesWork: boolean;
  /** Holds every `upsert_note` until it is released. */
  writeGate: Promise<void> | null;
}
let core: Core;
const DOC_TARGET: DropTarget = {
  kind: DROP.doc,
  label: 'doc-other',
  offset: { x: 12.5, y: 7.25 },
};
const NEW_TARGET: DropTarget = {
  kind: DROP.newWindow,
  point: { x: 300.5, y: 200.25 },
};

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
      case 'tab_drop_target':
        return Promise.resolve(core.target);
      case 'tab_transfer_begin':
        return core.begin instanceof Error
          ? Promise.reject(core.begin)
          : Promise.resolve(core.begin);
      case 'tab_transfer_cancel':
        return Promise.resolve(core.cancel);
      case 'tab_transfer_settle_window':
        return Promise.resolve(core.settle);
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
/** The commands sent so far, in order. */
function sent(): string[] {
  return mockInvoke.mock.calls.map(([cmd]) => cmd);
}
/** The arguments of every call of `command`. */
function argsOf(command: string): Record<string, unknown>[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === command)
    .map(([, args]) => (args ?? {}) as Record<string, unknown>);
}
/** The ids of the records written, in order. */
function written(): string[] {
  return argsOf('upsert_note').map((a) => (a.note as NoteSnapshot).id);
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
const WINDOWED = {
  sessionId: 7,
  totalBytes: 100,
  totalLines: 9,
  fingerprint: { size: 100, mtime_ms: 5 },
  dirty: false,
  topLine: 0,
};
/** The calls the host hooks got. */
interface HostCalls {
  lock: [string, unknown][];
  forgotten: string[];
  closed: number;
  viewModes: Map<string, string>;
}
let calls: HostCalls;
/** A transfer host that records what it is asked. */
function transferHost(over: Partial<TransferHost> = {}): TransferHost {
  calls = { lock: [], forgotten: [], closed: 0, viewModes: new Map() };
  return {
    showLock: (id, lock) => {
      calls.lock.push([id, lock]);
    },
    editorStateOf: () => null,
    scrollOf: () => null,
    viewModeOf: (id) => calls.viewModes.get(id) as never,
    setViewMode: (id, mode) => {
      calls.viewModes.set(id, mode);
    },
    forgetTab: (id) => {
      calls.forgotten.push(id);
    },
    dropGeometry: () => null,
    modalOpen: () => false,
    closeWindow: () => {
      calls.closed += 1;
      return Promise.resolve();
    },
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
const RELEASE: ReleaseAt = {
  x: 500.5,
  y: 400.5,
  dpr: 2,
  slot: 0,
  overBar: false,
};

let win: DocumentWindowState;
let readySpy: ReturnType<typeof vi.spyOn>;
/** A window holding tabs `a`, `b`, `c`… with the first one active. */
async function windowOf(...names: string[]): Promise<void> {
  await win.init('g', null, null);
  names.forEach((name, i) => win.tabs.push(tab(name, i)));
  win.activeIndex = 0;
  win.dragHost = FREE;
  win.transferHost = transferHost();
  win.transferListening = true;
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
/** Release tab `id` somewhere outside the window. */
async function out(id: string, over: Partial<ReleaseAt> = {}): Promise<void> {
  await win.releaseTab(at(id), { ...RELEASE, ...over });
}
/** Whether the last thing the editor was told about its lock is that it is off. */
function unlocked(): boolean {
  const last = calls.lock[calls.lock.length - 1];
  return last !== undefined && last[1] === undefined;
}

beforeEach(async () => {
  core = {
    target: DOC_TARGET,
    begin: { kind: 'started', t: 7 },
    cancel: 'cancelled',
    settle: [],
    writesWork: true,
    writeGate: null,
  };
  backend();
  readySpy = vi.spyOn(editionState, 'ready').mockResolvedValue();
  editionState.lite = false;
  mockSave.mockReset();
  win = new DocumentWindowState();
  await settingsState.init();
});

afterEach(() => {
  readySpy.mockRestore();
  for (const tab of win.tabs) {
    pasteLocks.drop(tab.id);
  }
  vi.restoreAllMocks();
});

describe('a release always asks the core where the tab landed', () => {
  it('reorders on the own tab bar and returns to the slot off it', async () => {
    await windowOf('a', 'b', 'c');
    core.target = { kind: DROP.self };
    await out('c', { slot: 0, overBar: true });
    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(sent()).toContain('tab_drop_target');

    await out('b', { slot: 0, overBar: false });
    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(sent()).not.toContain('tab_transfer_begin');
    expect(argsOf('tab_drop_target')).toEqual([
      { clientX: 500.5, clientY: 400.5, dpr: 2, onlyTab: false },
      { clientX: 500.5, clientY: 400.5, dpr: 2, onlyTab: false },
    ]);
  });

  it('asks even for a release inside the own window: the viewport does not decide', async () => {
    await windowOf('a', 'b');
    core.target = DOC_TARGET;
    await out('a', { overBar: true, slot: 1 });
    // A window above the own one took the release: the tab moved, it did not reorder.
    expect(sent()).toContain('tab_transfer_begin');
    expect(ids()).toEqual(['a', 'b']);
  });

  it('does nothing for a cancel', async () => {
    await windowOf('a', 'b');
    core.target = { kind: DROP.cancel };
    await out('b', { overBar: true, slot: 0 });
    expect(ids()).toEqual(['a', 'b']);
    expect(sent()).toEqual(['tab_drop_target']);
  });

  it('treats a core that cannot answer as the own window', async () => {
    await windowOf('a', 'b');
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'tab_drop_target'
        ? Promise.reject(new Error('no'))
        : Promise.resolve(null)) as typeof invoke);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await out('b', { overBar: true, slot: 0 });
    expect(ids()).toEqual(['b', 'a']);
  });

  it("says whether the tab is the window's only one", async () => {
    await windowOf('a');
    core.target = { kind: DROP.self };
    await out('a');
    expect(argsOf('tab_drop_target')[0]).toMatchObject({ onlyTab: true });
  });

  it('moves the window for its only tab and starts no transfer', async () => {
    await windowOf('a');
    core.target = { kind: DROP.moveWindow, point: { x: 60.5, y: 70.25 } };
    await out('a');
    expect(argsOf('tab_move_window')).toEqual([
      { point: { x: 60.5, y: 70.25 } },
    ]);
    expect(sent()).not.toContain('tab_transfer_begin');
    expect(win.tabs[0]?.transferring).toBeUndefined();
  });

  it('moves the window for a busy only tab too: the tab stays in its own window', async () => {
    await windowOf('a');
    at('a').inFlight = 1;
    core.target = { kind: DROP.moveWindow, point: { x: 60.5, y: 70.25 } };
    await out('a');
    expect(sent()).toContain('tab_move_window');
    expect(sent()).not.toContain('tab_transfer_begin');
  });
});

describe('the busy check', () => {
  async function refused(prepare: () => void | (() => void)): Promise<void> {
    await windowOf('a', 'b');
    const undo = prepare();
    core.target = DOC_TARGET;
    await out('a');
    expect(sent()).not.toContain('tab_transfer_begin');
    expect(sent()).not.toContain('upsert_note');
    expect(calls.lock).toEqual([]);
    if (typeof undo === 'function') {
      undo();
    }
  }

  it('refuses a tab with work in flight', async () => {
    await refused(() => {
      at('a').inFlight = 1;
    });
  });

  it('refuses a tab that is being closed', async () => {
    await refused(() => {
      at('a').closing = true;
    });
  });

  it('refuses a tab a sticky note is being handed over into', async () => {
    await refused(() => {
      at('a').handingOver = true;
    });
  });

  it('refuses a tab that is released or already frozen', async () => {
    await refused(() => {
      at('a').released = true;
    });
    await refused(() => {
      at('a').transferring = true;
    });
  });

  it('refuses a tab a paste holds', async () => {
    await refused(() => {
      pasteLocks.begin('a', 'wait');
      return () => pasteLocks.drop('a');
    });
  });

  it('refuses a tab a paste conversion is running on', async () => {
    await refused(() => {
      vi.spyOn(convertController, 'busy').mockImplementation(
        (id) => id === 'a',
      );
    });
  });

  it('refuses a tab with an operation of the window running on it', async () => {
    await windowOf('a', 'b');
    let finish: () => void = () => {};
    win.tabs.push(
      tab('big', 2, {
        content: Text.empty,
        savedContent: Text.empty,
        large: { size: 1 },
      }),
    );
    // An unlock: its session open is parked.
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'windowed_open'
        ? new Promise<unknown>((resolve) => {
            finish = () =>
              resolve({
                session_id: 3,
                total_bytes: 1,
                total_lines: 1,
                fingerprint: { size: 1, mtime_ms: 1 },
              });
          })
        : Promise.resolve(null)) as typeof invoke);
    const unlocking = win.unlockLargeTab(at('big'), 0);
    expect(win.transferBlockerOf(at('big'))).toBe('op');
    finish();
    await unlocking;
    expect(win.transferBlockerOf(at('big'))).toBeNull();
  });

  it('refuses a tab with the range edit box open on it', async () => {
    await windowOf('a');
    win.tabs.push(tab('v', 1, { large: { size: 10 } }));
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'read_range'
        ? Promise.resolve({ text: 'x', lossy: false })
        : cmd === 'file_fingerprint'
          ? Promise.resolve({ size: 1, mtime_ms: 1 })
          : Promise.resolve(null)) as typeof invoke);
    await win.openRangeBox(at('v'), {
      startByte: 0,
      endByte: 1,
      startLine: 1,
      endLine: 1,
    });
    expect(win.transferBlockerOf(at('v'))).toBe('range-box');
  });

  it('refuses a windowed tab with a whole-file operation pending', async () => {
    await windowOf('a');
    win.tabs.push(
      tab('w', 1, {
        content: Text.empty,
        savedContent: Text.empty,
        windowed: { ...WINDOWED },
      }),
    );
    let done: () => void = () => {};
    win.windowedGate(7).begin(
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    expect(win.transferBlockerOf(at('w'))).toBe('windowed-op');
    done();
    await Promise.resolve();
    await Promise.resolve();
    expect(win.transferBlockerOf(at('w'))).toBeNull();
  });

  it('refuses under every drag-start lock', async () => {
    for (const locked of [
      { ...FREE, navigationLocked: () => true },
      { ...FREE, gateVisible: () => true },
      { ...FREE, modalOpen: () => true },
      { ...FREE, closing: () => true },
      { ...FREE, quitting: () => true },
    ]) {
      await refused(() => {
        win.dragHost = locked;
      });
      win = new DocumentWindowState();
    }
  });

  it('refuses while the window has not registered its transfer listeners', async () => {
    await refused(() => {
      win.transferListening = false;
    });
  });
});

describe('the pure busy check', () => {
  const FREE_FACTS: BlockFacts = {
    op: false,
    convert: false,
    rangeBox: false,
    windowedOp: false,
    paste: false,
    locked: false,
  };
  const idle = tab('x', 0);

  it('lets an idle tab go', () => {
    expect(transferBlocker(idle, FREE_FACTS)).toBeNull();
  });

  it.each<[string, DocTab, Partial<BlockFacts>, TransferBlock]>([
    ['released', { ...idle, released: true }, {}, 'released'],
    ['transferring', { ...idle, transferring: true }, {}, 'transferring'],
    ['an operation', idle, { op: true }, 'op'],
    ['work in flight', { ...idle, inFlight: 2 }, {}, 'in-flight'],
    ['closing', { ...idle, closing: true }, {}, 'closing'],
    ['a paste conversion', idle, { convert: true }, 'convert'],
    ['a handoff', { ...idle, handingOver: true }, {}, 'handing-over'],
    ['an edit box', idle, { rangeBox: true }, 'range-box'],
    ['a whole-file operation', idle, { windowedOp: true }, 'windowed-op'],
    ['a paste', idle, { paste: true }, 'paste'],
    ['a drag-start lock', idle, { locked: true }, 'locked'],
  ])('returns the reason for %s', (_name, subject, facts, reason) => {
    expect(transferBlocker(subject, { ...FREE_FACTS, ...facts })).toBe(reason);
  });

  it('does not count work that has finished', () => {
    expect(transferBlocker({ ...idle, inFlight: 0 }, FREE_FACTS)).toBeNull();
  });
});

describe('work that is in flight is counted for the whole of it', () => {
  it('a file write', async () => {
    await windowOf('a');
    let finish: () => void = () => {};
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'write_file_encoded'
        ? new Promise<unknown>((resolve) => {
            finish = () => resolve(null);
          })
        : Promise.resolve(null)) as typeof invoke);
    const saving = win.saveTab(at('a'));
    await until(() => (at('a').inFlight ?? 0) === 1);
    expect(win.transferBlockerOf(at('a'))).toBe('in-flight');
    finish();
    await saving;
    expect(at('a').inFlight).toBeUndefined();
  });

  it('a windowed save, and a failed one', async () => {
    await windowOf('a');
    win.tabs.push(
      tab('w', 1, {
        content: Text.empty,
        savedContent: Text.empty,
        windowed: { ...WINDOWED, dirty: true },
      }),
    );
    let fail: (e: Error) => void = () => {};
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'windowed_save'
        ? new Promise((_resolve, reject) => {
            fail = reject;
          })
        : Promise.resolve(null)) as typeof invoke);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const saving = win.saveWindowed(at('w'), false);
    await until(() => (at('w').inFlight ?? 0) === 1);
    expect(win.transferBlockerOf(at('w'))).toBe('in-flight');
    fail(new Error('boom'));
    await saving;
    expect(at('w').inFlight).toBeUndefined();
  });

  it('a re-decode under another encoding', async () => {
    await windowOf('a');
    let finish: () => void = () => {};
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'read_file_as'
        ? new Promise<unknown>((resolve) => {
            finish = () =>
              resolve({
                content: 'x',
                encoding: 'Big5',
                had_bom: false,
                lossy: false,
              });
          })
        : Promise.resolve(null)) as typeof invoke);
    const decoding = win.setEncoding('Big5');
    await until(() => (at('a').inFlight ?? 0) === 1);
    expect(win.transferBlockerOf(at('a'))).toBe('in-flight');
    finish();
    await decoding;
    expect(at('a').inFlight).toBeUndefined();
  });

  it('an edit box opening', async () => {
    await windowOf('a');
    win.tabs.push(tab('v', 1, { large: { size: 10 } }));
    let finish: () => void = () => {};
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'read_range'
        ? new Promise<unknown>((resolve) => {
            finish = () => resolve({ text: 'x', lossy: false });
          })
        : Promise.resolve(null)) as typeof invoke);
    const opening = win.openRangeBox(at('v'), {
      startByte: 0,
      endByte: 1,
      startLine: 1,
      endLine: 1,
    });
    await until(() => (at('v').inFlight ?? 0) === 1);
    expect(win.transferBlockerOf(at('v'))).toBe('in-flight');
    finish();
    await opening;
    expect(at('v').inFlight).toBeUndefined();
  });
});

describe('the freeze', () => {
  it('writes the tab first, awaits the chain of its writes, then locks it', async () => {
    await windowOf('a', 'b');
    let open: () => void = () => {};
    core.writeGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const releasing = out('b');
    await until(() => sent().includes('upsert_note'));
    // The write is still going: nothing is locked, nothing begun.
    expect(calls.lock).toEqual([]);
    expect(at('b').transferring).toBeUndefined();
    expect(sent()).not.toContain('tab_transfer_begin');
    open();
    await releasing;
    expect(calls.lock).toHaveLength(1);
    expect(calls.lock[0]?.[0]).toBe('b');
    expect(calls.lock[0]?.[1]).toMatchObject({ phase: 'full' });
    expect(sent().indexOf('upsert_note')).toBeLessThan(
      sent().indexOf('tab_transfer_begin'),
    );
    expect(at('b').transferring).toBe(true);
    expect(pasteLocks.has('b')).toBe(true);
  });

  it('waits for a write issued before it as well', async () => {
    await windowOf('a', 'b');
    let open: () => void = () => {};
    core.writeGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // An edit's own write, still running.
    win.updateContentById('b', Text.of(['edited']));
    await until(() => written().length === 1);
    const releasing = out('b');
    await until(() => written().length === 2);
    open();
    await releasing;
    expect(sent()).toContain('tab_transfer_begin');
  });

  it('stops as a cancel when the write did not reach the disk', async () => {
    await windowOf('a', 'b');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    core.writesWork = false;
    await out('b');
    expect(sent()).not.toContain('tab_transfer_begin');
    expect(at('b').transferring).toBeUndefined();
    expect(at('b').writeFailed).toBe(true);
    expect(unlocked()).toBe(true);
    expect(pasteLocks.has('b')).toBe(false);
  });

  it('passes the target of the core unchanged to begin and takes the id from `started`', async () => {
    await windowOf('a', 'b');
    core.target = NEW_TARGET;
    core.begin = { kind: 'started', t: 41 };
    win.project = '/proj';
    await out('b');
    const [begin] = argsOf('tab_transfer_begin');
    expect(begin?.target).toBe(NEW_TARGET);
    expect(begin?.project).toBe('/proj');
    expect((begin?.payload as { tab: { id: string } }).tab.id).toBe('b');
    // The tab waits for that transfer: the core calling it off unfreezes it.
    win.onTransferCancel(41);
    expect(at('b').transferring).toBeUndefined();
  });

  it('packs the editor, the scroll, the view position and the view mode', async () => {
    await windowOf('a', 'b');
    win.setViewTopLine('b', 12);
    win.transferHost = transferHost({
      scrollOf: () => ({ pos: 3, yMargin: 1, scrollLeft: 0 }),
      viewModeOf: () => 'markdown',
    });
    await out('b');
    const payload = argsOf('tab_transfer_begin')[0]?.payload as {
      scroll: unknown;
      view: unknown;
      viewMode: unknown;
      editor: unknown;
    };
    expect(payload.scroll).toEqual({ pos: 3, yMargin: 1, scrollLeft: 0 });
    expect(payload.view).toEqual({ top: 12 });
    expect(payload.viewMode).toBe('markdown');
    expect(payload.editor).toBeNull();
  });
});

describe('a transfer that does not start', () => {
  it('unfreezes the tab and clears preparing after a refused begin', async () => {
    await windowOf('a', 'b');
    core.begin = { kind: 'refused', reason: 'not_ready' };
    await out('b');
    expect(win.preparing).toBeNull();
    expect(win.preparingTab).toBeNull();
    expect(at('b').transferring).toBeUndefined();
    expect(pasteLocks.has('b')).toBe(false);
    expect(unlocked()).toBe(true);
    expect(calls.lock.map((c) => c[1] === undefined)).toEqual([false, true]);
    // The tab is written from here again.
    expect(written().length).toBeGreaterThanOrEqual(2);
    expect(win.dragLocked()).toBe(false);
  });

  it('does the same after a begin that failed', async () => {
    await windowOf('a', 'b');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    core.begin = new Error('gone');
    await out('b');
    expect(win.preparing).toBeNull();
    expect(at('b').transferring).toBeUndefined();
    expect(unlocked()).toBe(true);
    expect(win.dragLocked()).toBe(false);
  });
});

describe('a tab on its way is frozen', () => {
  async function frozen(): Promise<DocTab> {
    await windowOf('a', 'b');
    await out('a');
    expect(at('a').transferring).toBe(true);
    mockInvoke.mockClear();
    return at('a');
  }

  it('takes no content from the editor or the status bar', async () => {
    const t = await frozen();
    win.updateActiveContent(Text.of(['typed']));
    win.updateContentById('a', Text.of(['typed']));
    win.setActiveLanguage('JavaScript');
    win.setLineEnding('CRLF');
    win.toggleLineEnding();
    await win.setEncoding('Big5');
    expect(t.content.toString()).toBe('a');
    expect(t.language).toBeNull();
    expect(t.lineEnding).toBe('LF');
    expect(t.encoding).toBe('UTF-8');
    expect(sent()).toEqual([]);
  });

  it('is saved by nobody', async () => {
    const t = await frozen();
    t.content = Text.of(['changed']);
    expect(await win.saveActive()).toBe(false);
    expect(await win.saveTab(t)).toBe(false);
    expect(await win.saveAsTab(t, '/p/x.txt')).toBe(false);
    expect(await win.saveAs('/p/x.txt')).toBe(false);
    expect(sent()).toEqual([]);
  });

  it('is not discarded, deleted or written', async () => {
    const t = await frozen();
    t.content = Text.of(['changed']);
    win.discardChanges(0);
    await win.deleteTab(0);
    win.setBounds(1, 2, 3, 4);
    await Promise.resolve();
    expect(t.content.toString()).toBe('changed');
    expect(ids()).toEqual(['a', 'b']);
    expect(t.closing).toBeUndefined();
    expect(sent()).not.toContain('delete_note');
    expect(written()).toEqual(['b']);
  });

  it('opens no edit box, and is not opened again by its path', async () => {
    const t = await frozen();
    expect(
      await win.openRangeBox(t, {
        startByte: 0,
        endByte: 1,
        startLine: 1,
        endLine: 1,
      }),
    ).toBeNull();
    await win.openTab('/p/a.txt');
    expect(win.rangeBox).toBeNull();
    expect(ids()).toEqual(['a', 'b']);
    expect(win.activeTab?.id).toBe('a');
    expect(sent()).not.toContain('read_range');
    expect(sent()).not.toContain('stat_file');
  });

  it('does not unlock', async () => {
    await windowOf('a');
    win.tabs.push(
      tab('v', 1, {
        content: Text.empty,
        savedContent: Text.empty,
        large: { size: 1 },
      }),
    );
    await out('v');
    expect(at('v').transferring).toBe(true);
    mockInvoke.mockClear();
    expect(await win.unlockLargeTab(at('v'), 0)).toBeNull();
    expect(sent()).not.toContain('windowed_open');
  });

  it('does not restore a windowed session when the tab is activated', async () => {
    await windowOf('a');
    win.tabs.push(
      tab('r', 1, {
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
    await out('r');
    expect(at('r').transferring).toBe(true);
    mockInvoke.mockClear();
    // Activating the pending restore would reopen a session the receiver opens.
    win.activeIndex = 1;
    await Promise.resolve();
    expect(sent()).not.toContain('windowed_reopen');
    expect(sent()).not.toContain('convert_from_file');
  });

  it('refuses an operation on it through the tab gate', async () => {
    const t = await frozen();
    const run = (
      win as unknown as {
        runTabOp: (t: DocTab, op: () => Promise<number>) => Promise<number>;
      }
    ).runTabOp(t, () => Promise.resolve(1));
    await expect(run).rejects.toThrow('on its way');
  });

  it('does not take a pasted orphan in', async () => {
    const t = await frozen();
    t.content = Text.of(['changed']);
    const adopt = (
      win as unknown as {
        adoptIntoExisting: (t: DocTab, n: NoteSnapshot) => Promise<void>;
      }
    ).adoptIntoExisting;
    await adopt.call(win, t, {} as NoteSnapshot);
    expect(t.content.toString()).toBe('changed');
    expect(sent()).toEqual([]);
  });
});

describe('the tab lands', () => {
  async function started(t = 7, ...names: string[]): Promise<void> {
    await windowOf(...(names.length > 0 ? names : ['a', 'b', 'c']));
    core.begin = { kind: 'started', t };
  }

  it('leaves without its record, session or conversion being touched', async () => {
    await started();
    await out('b');
    mockInvoke.mockClear();
    win.onTransferRelease(7);
    expect(ids()).toEqual(['a', 'c']);
    expect(argsOf('tab_transfer_released')).toEqual([{ t: 7 }]);
    expect(sent()).not.toContain('delete_note');
    expect(sent()).not.toContain('windowed_close');
    expect(sent()).not.toContain('convert_release');
    expect(sent()).not.toContain('upsert_note');
  });

  it('keeps the active tab when another one is released', async () => {
    await started();
    win.activeIndex = 2;
    const mru = [...win.ordinaryMru];
    await out('a');
    win.onTransferRelease(7);
    expect(ids()).toEqual(['b', 'c']);
    expect(win.activeTab?.id).toBe('c');
    expect(win.activeIndex).toBe(1);
    expect(win.ordinaryMru.filter((id) => id !== 'a')).toEqual(
      mru.filter((id) => id !== 'a'),
    );
  });

  it('picks the next tab by the rule of a close when the active one is released', async () => {
    await started();
    win.activeIndex = 1;
    await out('b');
    win.onTransferRelease(7);
    expect(win.activeTab?.id).toBe('c');
    // The last one released: the one before it takes over.
    win.activeIndex = 1;
    core.begin = { kind: 'started', t: 8 };
    await out('c');
    win.onTransferRelease(8);
    expect(win.activeTab?.id).toBe('a');
  });

  it('lets go of everything the window kept for an ordinary tab that was never switched out', async () => {
    await started();
    win.ordinaryMru = ['b', 'a'];
    win.pendingSeeds.set('b', { editor: null, scroll: null });
    await out('b');
    expect(pasteLocks.has('b')).toBe(true);
    win.onTransferRelease(7);
    expect(pasteLocks.has('b')).toBe(false);
    expect(win.pendingSeeds.has('b')).toBe(false);
    expect(win.ordinaryMru).not.toContain('b');
    expect(calls.forgotten).toEqual(['b']);
  });

  it("lets go of a windowed tab's paste lock, view, gate and generation", async () => {
    await windowOf('a');
    win.tabs.push(
      tab('w', 1, {
        content: Text.empty,
        savedContent: Text.empty,
        windowed: { ...WINDOWED },
      }),
    );
    win.setViewTopLine('w', 50);
    win.windowedGate(7);
    win.windowedApplied(7, 1, 1, false, 4);
    core.begin = { kind: 'started', t: 9 };
    await out('w');
    win.onTransferRelease(9);
    expect(pasteLocks.has('w')).toBe(false);
    expect(win.viewTopLine('w')).toBeUndefined();
    // A new gate: the old one went with the session's bookkeeping.
    expect(win.windowedGate(7).pending()).toBe(false);
    // The generation counter is gone: a lower one is taken again.
    win.tabs.push(
      tab('w2', 2, {
        content: Text.empty,
        savedContent: Text.empty,
        windowed: { ...WINDOWED },
      }),
    );
    win.windowedApplied(7, 5, 5, false, 1);
    expect(at('w2').windowed?.totalBytes).toBe(5);
  });

  it('acts once for one transfer, whichever way it is told', async () => {
    await started();
    await out('b');
    mockInvoke.mockClear();
    win.onTransferRelease(7);
    win.onTransferRelease(7);
    win.applyRelease(7);
    expect(argsOf('tab_transfer_released')).toHaveLength(1);
    expect(ids()).toEqual(['a', 'c']);
  });

  it('closes the window through the helper when its last tab leaves', async () => {
    await windowOf('a');
    core.begin = { kind: 'started', t: 7 };
    await out('a');
    expect(calls.closed).toBe(0);
    win.onTransferRelease(7);
    expect(win.tabs).toHaveLength(0);
    expect(calls.closed).toBe(1);
  });

  it('is let go as soon as the core says so, even before begin answered', async () => {
    await windowOf('a', 'b');
    let answer: (r: BeginResult) => void = () => {};
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'tab_drop_target') {
        return Promise.resolve(DOC_TARGET);
      }
      if (cmd === 'tab_transfer_begin') {
        return new Promise((resolve) => {
          answer = resolve as (r: BeginResult) => void;
        });
      }
      return Promise.resolve(null);
    }) as typeof invoke);
    const releasing = out('b');
    await until(() => sent().includes('tab_transfer_begin'));
    // The receiver was quicker than the answer to begin.
    win.onTransferRelease(5);
    expect(ids()).toEqual(['a', 'b']);
    answer({ kind: 'started', t: 5 });
    await releasing;
    expect(ids()).toEqual(['a']);
  });

  it('a tab moved back into the same window passes the busy check', async () => {
    await started();
    await out('b');
    const payload = argsOf('tab_transfer_begin')[0]?.payload;
    win.onTransferRelease(7);
    const { fromPayload } = await import('../util/tabPayload');
    const back = {
      ...fromPayload(payload as never),
      tabIndex: 9,
      order: 9,
    } as DocTab;
    win.tabs.push(back);
    expect(win.transferBlockerOf(win.tabs[win.tabs.length - 1]!)).toBeNull();
  });
});

describe('the core calls a transfer off', () => {
  it('unfreezes the tab and writes it on `tab-transfer-cancel`', async () => {
    await windowOf('a', 'b');
    core.begin = { kind: 'started', t: 7 };
    await out('b');
    mockInvoke.mockClear();
    win.onTransferCancel(7);
    expect(at('b').transferring).toBeUndefined();
    expect(unlocked()).toBe(true);
    expect(pasteLocks.has('b')).toBe(false);
    await until(() => written().length === 1);
    expect(written()).toEqual(['b']);
    expect(win.dragLocked()).toBe(false);
  });

  it('unfreezes a tab whose cancel came before begin answered', async () => {
    await windowOf('a', 'b');
    win.onTransferCancel(7);
    core.begin = { kind: 'started', t: 7 };
    await out('b');
    expect(at('b').transferring).toBeUndefined();
    expect(unlocked()).toBe(true);
  });
});

describe('a close of the dimmed tab', () => {
  it('calls the move off and gives the tab back', async () => {
    await windowOf('a', 'b');
    core.begin = { kind: 'started', t: 7 };
    core.cancel = 'cancelled';
    await out('b');
    mockInvoke.mockClear();
    await win.settleTab(at('b'));
    expect(argsOf('tab_transfer_cancel')).toEqual([{ t: 7 }]);
    expect(at('b').transferring).toBeUndefined();
    expect(unlocked()).toBe(true);
    expect(ids()).toEqual(['a', 'b']);
  });

  it('lets the tab go when it has already landed', async () => {
    await windowOf('a', 'b');
    core.begin = { kind: 'started', t: 7 };
    core.cancel = 'accepted';
    await out('b');
    mockInvoke.mockClear();
    await win.settleTab(at('b'));
    expect(ids()).toEqual(['a']);
    expect(argsOf('tab_transfer_released')).toEqual([{ t: 7 }]);
    expect(sent()).not.toContain('delete_note');
  });

  it('waits for a move that is still being set up', async () => {
    await windowOf('a', 'b');
    let open: () => void = () => {};
    core.writeGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    core.begin = { kind: 'started', t: 7 };
    core.cancel = 'cancelled';
    const releasing = out('b');
    await until(() => sent().includes('upsert_note'));
    const settling = win.settleTab(at('b'));
    await Promise.resolve();
    expect(sent()).not.toContain('tab_transfer_cancel');
    open();
    await releasing;
    await settling;
    expect(sent()).toContain('tab_transfer_cancel');
    expect(at('b').transferring).toBeUndefined();
  });

  it('does nothing for a tab that is not on its way', async () => {
    await windowOf('a');
    await win.settleTab(at('a'));
    expect(sent()).toEqual([]);
  });
});

describe('settling the window', () => {
  it('waits for a transfer that is being set up before it asks the core', async () => {
    await windowOf('a', 'b');
    let open: () => void = () => {};
    core.writeGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    core.begin = { kind: 'started', t: 7 };
    const releasing = out('b');
    await until(() => sent().includes('upsert_note'));
    const settling = win.settleTransfers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent()).not.toContain('tab_transfer_settle_window');
    open();
    await releasing;
    await settling;
    expect(sent()).toContain('tab_transfer_settle_window');
  });

  it('waits for a tab being put in before it asks the core', async () => {
    await windowOf('a', 'b');
    let commitDone: () => void = () => {};
    win.committing = new Promise<void>((resolve) => {
      commitDone = resolve;
    });
    const settling = win.settleTransfers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent()).not.toContain('tab_transfer_settle_window');
    win.committing = null;
    commitDone();
    await settling;
    expect(sent()).toContain('tab_transfer_settle_window');
  });

  it('unfreezes a tab whose transfer the core called off', async () => {
    await windowOf('a', 'b');
    core.begin = { kind: 'started', t: 7 };
    await out('b');
    core.settle = [{ kind: 'unfreeze', t: 7, noteId: 'b' }];
    mockInvoke.mockClear();
    await win.settleTransfers();
    expect(at('b').transferring).toBeUndefined();
    expect(unlocked()).toBe(true);
    expect(pasteLocks.has('b')).toBe(false);
    expect(ids()).toEqual(['a', 'b']);
    await until(() => written().length === 1);
    expect(written()).toEqual(['b']);
  });

  it('lets a tab go that the core says landed already', async () => {
    await windowOf('a', 'b');
    core.begin = { kind: 'started', t: 7 };
    await out('b');
    core.settle = [{ kind: 'release', t: 7, noteId: 'b' }];
    mockInvoke.mockClear();
    await win.settleTransfers();
    expect(ids()).toEqual(['a']);
    expect(argsOf('tab_transfer_released')).toEqual([{ t: 7 }]);
    // The event that follows finds nothing to do.
    win.onTransferRelease(7);
    expect(argsOf('tab_transfer_released')).toHaveLength(1);
  });

  it('drops an incoming copy the core called off', async () => {
    await windowOf('a');
    core.settle = [{ kind: 'drop_incoming', t: 3 }];
    await win.settleTransfers();
    expect(win.wasDropped(3)).toBe(true);
  });

  it('is quiet when the core cannot be asked', async () => {
    await windowOf('a');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInvoke.mockImplementation((() =>
      Promise.reject(new Error('no'))) as typeof invoke);
    await expect(win.settleTransfers()).resolves.toBeUndefined();
  });

  it('is awaited by a flush of all tabs only after the put-in', async () => {
    await windowOf('a');
    let done: () => void = () => {};
    win.committing = new Promise<void>((resolve) => {
      done = resolve;
    });
    let flushed = false;
    const flushing = win.flushAll().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushed).toBe(false);
    done();
    await flushing;
    expect(flushed).toBe(true);
  });
});

describe('what keeps a window from taking part in a transfer', () => {
  it('counts a transfer on its way out, in preparation or in', async () => {
    await windowOf('a', 'b');
    expect(win.dragLocked()).toBe(false);
    win.committing = Promise.resolve();
    expect(win.dragLocked()).toBe(true);
    win.committing = null;
    win.transferListening = false;
    expect(win.dragLocked()).toBe(true);
    win.transferListening = true;
    core.begin = { kind: 'started', t: 7 };
    await out('b');
    expect(win.dragLocked()).toBe(true);
    win.onTransferCancel(7);
    expect(win.dragLocked()).toBe(false);
  });
});
