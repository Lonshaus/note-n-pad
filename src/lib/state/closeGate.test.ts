// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The gate before a quit, a window close or a tab close, driven through the
// real window state against a fake backend. An edit box with changes holds all
// three back: nothing the box holds can ride along in a snapshot.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { CloseGate, type GateHost } from './closeGate.svelte';
import { DocumentWindowState, type DocTab } from './documentWindow.svelte';
import { SNAPSHOT_CONTENT_MAX } from '../util/snapshotPolicy';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockSave = vi.mocked(save);
vi.stubGlobal('window', globalThis);

const SRC = '/tmp/big.log';
/** What `splice_file` answers: where it wrote, or the error to reject with. */
let splice:
  | {
      fingerprint: { size: number; mtime_ms: number };
      writtenStart: number;
      writtenEnd: number;
    }
  | string;
/** Whether `upsert_note` reaches the disk. */
let snapshotsWork: boolean;

function backend(): void {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(((cmd: string) => {
    switch (cmd) {
      case 'read_range':
        return Promise.resolve({ text: 'one\ntwo\n', lossy: false });
      case 'file_fingerprint':
        return Promise.resolve({ size: 100, mtime_ms: 1 });
      case 'splice_file':
        return typeof splice === 'string'
          ? Promise.reject(splice)
          : Promise.resolve(splice);
      case 'tab_transfer_settle_window':
        return Promise.resolve([]);
      case 'upsert_note':
        return snapshotsWork
          ? Promise.resolve(null)
          : Promise.reject(new Error('disk full'));
      default:
        return Promise.resolve(null);
    }
  }) as typeof invoke);
}
/** Lets everything that is waiting on the microtask queue run. */
function idle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
/** The commands the gate sent, in order. */
function sent(): string[] {
  return mockInvoke.mock.calls.map(([cmd]) => cmd);
}
/** An ordinary tab. */
function tab(over: Partial<DocTab>): DocTab {
  return {
    id: 'plain',
    path: '/tmp/plain.txt',
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
    tabIndex: 0,
    order: 0,
    ...over,
  };
}
/** The large-file viewer tab of the source. */
function viewer(): DocTab {
  return tab({ id: 'viewer', path: SRC, large: { size: 100 } });
}

let win: DocumentWindowState;
let host: GateHost & {
  finishWindowClose: ReturnType<typeof vi.fn>;
  finishTabClose: ReturnType<typeof vi.fn>;
  focusWindow: ReturnType<typeof vi.fn>;
};
let gate: CloseGate;
/** A window on a large-file tab with an open box; `typed` makes it dirty. */
async function withBox(typed: boolean): Promise<void> {
  win.tabs.push(viewer());
  await win.openRangeBox(win.tabs[0]!, {
    startByte: 0,
    endByte: 8,
    startLine: 1,
    endLine: 2,
  });
  if (typed) {
    win.rangeBoxEdited(Text.of(['one', 'two', 'three']));
  }
}

beforeEach(() => {
  splice = {
    fingerprint: { size: 101, mtime_ms: 2 },
    writtenStart: 0,
    writtenEnd: 14,
  };
  snapshotsWork = true;
  backend();
  win = new DocumentWindowState();
  host = {
    label: 'doc-g',
    finishWindowClose: vi.fn(() => Promise.resolve()),
    finishTabClose: vi.fn(() => Promise.resolve()),
    focusWindow: vi.fn(() => Promise.resolve()),
  };
  gate = new CloseGate(win, host);
});
describe('a quit with an edit box that has changes', () => {
  it('vetoes the quit first, then shows the box prompt in this window', async () => {
    await withBox(true);
    await gate.onFlushRequest();

    expect(sent().filter((c) => c.startsWith('flush'))).toEqual([
      'flush_cancel',
    ]);
    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('rangeBox');
    expect(host.focusWindow).toHaveBeenCalledTimes(1);
    expect(sent()).not.toContain('request_exit');
  });

  it('exits after 儲存 wrote the box back', async () => {
    await withBox(true);
    await gate.onFlushRequest();
    await gate.save();

    expect(sent()).toContain('splice_file');
    expect(win.rangeBox).toBeNull();
    expect(gate.visible).toBe(false);
    const order = sent().filter((c) => /^(flush_cancel|request_exit)$/.test(c));
    expect(order).toEqual(['flush_cancel', 'request_exit']);
  });

  it('exits after 放棄變更 dropped the box, without writing the source', async () => {
    await withBox(true);
    await gate.onFlushRequest();
    await gate.discard();

    expect(sent()).not.toContain('splice_file');
    expect(win.rangeBox).toBeNull();
    expect(sent()).toContain('request_exit');
  });

  it('stays vetoed when 取消 is chosen, and the box keeps its text', async () => {
    await withBox(true);
    await gate.onFlushRequest();
    gate.cancel();

    expect(gate.visible).toBe(false);
    expect(win.rangeBoxDirty()).toBe(true);
    expect(sent()).not.toContain('request_exit');
    expect(sent()).not.toContain('flush_ack');
  });

  it('stays vetoed when the source changed: the conflict dialog takes over', async () => {
    await withBox(true);
    splice = 'fingerprint-mismatch';
    await gate.onFlushRequest();
    await gate.save();

    expect(win.rangeConflictVisible()).toBe(true);
    expect(gate.visible).toBe(false);
    expect(sent()).not.toContain('request_exit');
  });

  it('stays vetoed when the write-back fails', async () => {
    await withBox(true);
    splice = 'No space left on device (os error 28)';
    await gate.onFlushRequest();
    await gate.save();

    expect(win.saveFailed?.path).toBe(SRC);
    expect(win.rangeBox).not.toBeNull();
    expect(gate.visible).toBe(false);
    expect(sent()).not.toContain('request_exit');
  });
});

describe('a quit with nothing that blocks', () => {
  it('lets a window with no box go: it acks', async () => {
    win.tabs.push(viewer());
    await gate.onFlushRequest();

    expect(sent()).toContain('flush_ack');
    expect(sent()).not.toContain('flush_cancel');
    expect(gate.visible).toBe(false);
  });

  it('lets a window with an unchanged box go too', async () => {
    await withBox(false);
    await gate.onFlushRequest();

    expect(sent()).toContain('flush_ack');
    expect(sent()).not.toContain('flush_cancel');
  });

  it('acks with the window label', async () => {
    await gate.onFlushRequest();
    expect(mockInvoke).toHaveBeenCalledWith('flush_ack', { label: 'doc-g' });
  });
});

describe('closing the window with an edit box that has changes', () => {
  it('shows the box prompt and does not close', async () => {
    await withBox(true);
    await gate.onCloseFlushRequest();

    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('rangeBox');
    expect(host.finishWindowClose).not.toHaveBeenCalled();
    expect(sent()).not.toContain('flush_cancel');
  });

  it('closes after 儲存 wrote the box back', async () => {
    await withBox(true);
    await gate.onCloseFlushRequest();
    await gate.save();

    expect(sent()).toContain('splice_file');
    expect(host.finishWindowClose).toHaveBeenCalledTimes(1);
    expect(sent()).not.toContain('request_exit');
  });

  it('closes after 放棄變更', async () => {
    await withBox(true);
    await gate.onCloseFlushRequest();
    await gate.discard();

    expect(sent()).not.toContain('splice_file');
    expect(host.finishWindowClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the window open on 取消, on a conflict and on a failure', async () => {
    await withBox(true);
    await gate.onCloseFlushRequest();
    gate.cancel();
    expect(host.finishWindowClose).not.toHaveBeenCalled();

    splice = 'fingerprint-mismatch';
    await gate.onCloseFlushRequest();
    await gate.save();
    expect(win.rangeConflictVisible()).toBe(true);

    win.rangeConflictCancel();
    splice = 'No space left on device (os error 28)';
    await gate.onCloseFlushRequest();
    await gate.save();
    expect(host.finishWindowClose).not.toHaveBeenCalled();
  });

  it('reports the close called off on a failed save, and not on one that closes', async () => {
    let calledOff = 0;
    gate.onCallOff = () => {
      calledOff += 1;
    };
    await withBox(true);
    await gate.onCloseFlushRequest();
    splice = 'No space left on device (os error 28)';
    await gate.save();
    expect(host.finishWindowClose).not.toHaveBeenCalled();
    expect(calledOff).toBe(1);

    splice = {
      fingerprint: { size: 101, mtime_ms: 2 },
      writtenStart: 0,
      writtenEnd: 14,
    };
    await gate.onCloseFlushRequest();
    await gate.save();
    expect(host.finishWindowClose).toHaveBeenCalledTimes(1);
    expect(calledOff).toBe(1);
  });

  it('closes at once when the box has no changes', async () => {
    await withBox(false);
    await gate.onCloseFlushRequest();
    expect(host.finishWindowClose).toHaveBeenCalledTimes(1);
    expect(gate.visible).toBe(false);
  });

  it('leaves the close to the quit handshake while one is under way', async () => {
    await withBox(true);
    await gate.onFlushRequest();
    await gate.onCloseFlushRequest();
    expect(host.finishWindowClose).not.toHaveBeenCalled();

    gate.onFlushCancelled();
    await gate.onCloseFlushRequest();
    expect(gate.visible).toBe(true);
  });
});

describe('closing the tab an edit box with changes belongs to', () => {
  it('does not report the window close called off when the tab close is', async () => {
    let calledOff = 0;
    gate.onCallOff = () => {
      calledOff += 1;
    };
    await withBox(true);
    await gate.promptTabClose(win.tabs[0]!);
    gate.cancel();
    splice = 'No space left on device (os error 28)';
    await gate.promptTabClose(win.tabs[0]!);
    await gate.save();
    expect(calledOff).toBe(0);
  });

  it('shows the box prompt and keeps the tab', async () => {
    await withBox(true);
    await gate.promptTabClose(win.tabs[0]!);

    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('rangeBox');
    expect(host.finishTabClose).not.toHaveBeenCalled();
  });

  it('closes the tab after 儲存 or 放棄變更', async () => {
    await withBox(true);
    await gate.promptTabClose(win.tabs[0]!);
    await gate.save();
    expect(sent()).toContain('splice_file');
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);

    await withBox(true);
    await gate.promptTabClose(win.tabs[0]!);
    await gate.discard();
    expect(host.finishTabClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the tab on 取消', async () => {
    await withBox(true);
    await gate.promptTabClose(win.tabs[0]!);
    gate.cancel();
    expect(host.finishTabClose).not.toHaveBeenCalled();
    expect(win.rangeBoxDirty()).toBe(true);
  });

  it('asks about the box alone, not about other tabs', async () => {
    await withBox(true);
    win.tabs.push(
      tab({
        id: 'huge',
        tabIndex: 1,
        path: '/tmp/huge.txt',
        content: Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]),
      }),
    );
    await gate.promptTabClose(win.tabs[0]!);
    await gate.discard();
    expect(gate.visible).toBe(false);
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
  });
});

describe('what the gate asked about before the box', () => {
  it('still vetoes a quit for a tab whose snapshot write failed', async () => {
    snapshotsWork = false;
    win.tabs.push(tab({ id: 'dirty', content: Text.of(['unsaved']) }));
    await gate.onFlushRequest();

    expect(sent()).toContain('flush_cancel');
    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('unwritable');
  });

  it('asks about the box before a tab that is too large to snapshot', async () => {
    await withBox(true);
    win.tabs.push(
      tab({
        id: 'huge',
        tabIndex: 1,
        content: Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]),
      }),
    );
    await gate.onFlushRequest();
    expect(gate.reason).toBe('rangeBox');

    await gate.discard();
    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('oversized');
  });
});

describe('an edit box whose source file is gone', () => {
  it('saves the box to a new file instead of writing back into the source', async () => {
    await withBox(true);
    win.rangeBox = { ...win.rangeBox!, missing: true };
    const opened = vi.spyOn(win, 'openTab').mockResolvedValue();
    mockSave.mockResolvedValue('/tmp/part.txt');
    await gate.onFlushRequest();
    expect(gate.reason).toBe('rangeBox');

    await gate.save();

    expect(sent()).not.toContain('splice_file');
    expect(sent()).toContain('write_file_encoded');
    expect(opened).toHaveBeenCalledWith('/tmp/part.txt');
    expect(win.rangeBox).toBeNull();
    expect(sent()).toContain('request_exit');
  });

  it('keeps the gate and the box when the new file is not chosen', async () => {
    await withBox(true);
    win.rangeBox = { ...win.rangeBox!, missing: true };
    mockSave.mockResolvedValue(null);
    await gate.onFlushRequest();

    await gate.save();

    expect(sent()).not.toContain('splice_file');
    expect(sent()).not.toContain('write_file_encoded');
    expect(win.rangeBox).not.toBeNull();
    expect(sent()).not.toContain('request_exit');
  });

  it('closes no tab when a tab close asked about it: the new file is the active tab then', async () => {
    await withBox(true);
    win.rangeBox = { ...win.rangeBox!, missing: true };
    vi.spyOn(win, 'openTab').mockResolvedValue();
    mockSave.mockResolvedValue('/tmp/part.txt');
    await gate.promptTabClose(win.tabs[0]!);

    await gate.save();

    expect(gate.visible).toBe(false);
    expect(host.finishTabClose).not.toHaveBeenCalled();
  });
});

describe('a prompt that another dialog holds back', () => {
  let blocked: boolean;

  beforeEach(() => {
    blocked = true;
    gate = new CloseGate(win, { ...host, promptBlocked: () => blocked });
  });

  it('is not shown while blocked, and the quit stays vetoed', async () => {
    await withBox(true);
    await gate.onFlushRequest();

    expect(sent()).toContain('flush_cancel');
    expect(gate.visible).toBe(false);
    expect(sent()).not.toContain('request_exit');
    expect(host.focusWindow).not.toHaveBeenCalled();
  });

  it('is shown when resumed, and only once', async () => {
    await withBox(true);
    await gate.onFlushRequest();
    blocked = false;

    await gate.resumeDeferred();
    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('rangeBox');

    gate.cancel();
    await gate.resumeDeferred();
    expect(gate.visible).toBe(false);
  });

  it('keeps a window close waiting and goes on with it after the answer', async () => {
    await withBox(true);
    await gate.onCloseFlushRequest();
    expect(host.finishWindowClose).not.toHaveBeenCalled();
    expect(gate.visible).toBe(false);
    blocked = false;

    await gate.resumeDeferred();
    expect(gate.visible).toBe(true);
    await gate.discard();

    expect(host.finishWindowClose).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no prompt was held back', async () => {
    blocked = false;
    await gate.resumeDeferred();
    expect(gate.visible).toBe(false);
    expect(sent()).not.toContain('request_exit');
  });
});

describe('input still on its way into a windowed editor', () => {
  /** Pending input that a call of `endComposition` lands. */
  function pendingInput(): { landed: () => void; ended: () => number } {
    let pending = true;
    let ended = 0;
    win.windowedPending = () => pending;
    win.endComposition = () => {
      ended += 1;
      pending = false;
      return Promise.resolve();
    };
    return { landed: () => (pending = false), ended: () => ended };
  }

  it('lets a quit resume only after flush-cancelled, then exits on that one request', async () => {
    win.tabs.push(viewer());
    const input = pendingInput();
    const quit = gate.onFlushRequest();
    // endComposition resolves at once; the veto has not come back round yet.
    await idle();
    expect(sent()).toContain('flush_cancel');
    expect(input.ended()).toBe(1);
    expect(sent()).not.toContain('request_exit');
    expect(sent()).not.toContain('flush_ack');
    gate.onFlushCancelled();
    await quit;
    expect(sent()).toContain('request_exit');
    const order = sent().filter((c) => /^(flush_cancel|request_exit)$/.test(c));
    expect(order).toEqual(['flush_cancel', 'request_exit']);
    expect(gate.visible).toBe(false);
  });

  it('asks about what the landed input left behind instead of exiting', async () => {
    await withBox(true);
    pendingInput();
    const quit = gate.onFlushRequest();
    await idle();
    gate.onFlushCancelled();
    await quit;
    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('rangeBox');
    expect(sent()).not.toContain('request_exit');
  });

  it('quits as before when nothing is pending', async () => {
    win.tabs.push(viewer());
    win.windowedPending = () => false;
    win.endComposition = vi.fn(() => Promise.resolve());
    await gate.onFlushRequest();
    expect(sent()).toContain('flush_ack');
    expect(sent()).not.toContain('flush_cancel');
    expect(win.endComposition).not.toHaveBeenCalled();
  });

  it('lets a window close wait for the input before it looks at what blocks', async () => {
    win.tabs.push(viewer());
    const input = pendingInput();
    await gate.onCloseFlushRequest();
    expect(input.ended()).toBe(1);
    expect(host.finishWindowClose).toHaveBeenCalledTimes(1);
  });

  it('ends no composition for a window close with nothing pending', async () => {
    win.tabs.push(viewer());
    win.windowedPending = () => false;
    win.endComposition = vi.fn(() => Promise.resolve());
    await gate.onCloseFlushRequest();
    expect(win.endComposition).not.toHaveBeenCalled();
    expect(host.finishWindowClose).toHaveBeenCalledTimes(1);
  });
});

describe('a save that text typed during the write overtook', () => {
  it('asks about the same tab again instead of letting the quit through', async () => {
    const huge = 'x'.repeat(SNAPSHOT_CONTENT_MAX + 1);
    win.tabs.push(
      tab({ id: 'huge', path: '/tmp/huge.txt', content: Text.of([huge]) }),
    );
    win.activeIndex = 0;
    let release: () => void = () => {};
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'write_file_encoded') {
        return new Promise<null>((resolve) => {
          release = () => resolve(null);
        });
      }
      return Promise.resolve(cmd === 'tab_transfer_settle_window' ? [] : null);
    }) as typeof invoke);
    await gate.onFlushRequest();
    const saving = gate.save();
    await Promise.resolve();
    win.updateContentById('huge', Text.of([huge + 'y']));
    release();
    await saving;

    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('oversized');
    expect(win.activeTab?.id).toBe('huge');
    expect(sent()).not.toContain('request_exit');
  });
});

describe('放棄變更 of a windowed tab', () => {
  async function discarding(worked: boolean) {
    win.tabs.push(
      tab({
        id: 'w',
        path: '/tmp/w.txt',
        windowed: {
          sessionId: 1,
          totalBytes: 1,
          totalLines: 1,
          fingerprint: { size: 1, mtime_ms: 1 },
          dirty: true,
          topLine: 0,
        },
      }),
    );
    win.activeIndex = 0;
    // A quit finds the dirty windowed tab and raises the dialog about it.
    await gate.onFlushRequest();
    const discard = vi.spyOn(win, 'discardWindowed').mockResolvedValue(worked);
    const prompt = vi.spyOn(gate, 'prompt').mockResolvedValue();
    const vetoed = vi.fn();
    gate.onVetoed = vetoed;
    await gate.discard();
    return { discard, prompt, vetoed };
  }

  it('asks about whatever is left once the session was reopened', async () => {
    const { discard, prompt, vetoed } = await discarding(true);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(vetoed).not.toHaveBeenCalled();
  });

  it('calls off the quit or close when the discard failed, and does not ask about the same tab again', async () => {
    const { discard, prompt, vetoed } = await discarding(false);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
    expect(vetoed).toHaveBeenCalledTimes(1);
    expect(gate.visible).toBe(false);
  });
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** A dirty tab too large to snapshot, which the quit gate asks about. */
function hugeTab(id: string, index: number): DocTab {
  return tab({
    id,
    path: `/tmp/${id}.txt`,
    content: Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]),
    tabIndex: index,
  });
}
/** A small tab with changes. */
function smallTab(id: string, index: number): DocTab {
  return tab({
    id,
    path: `/tmp/${id}.txt`,
    content: Text.of([`${id} text`]),
    tabIndex: index,
  });
}
/** Every `command` waits until the returned function is called. */
function holdCommand(command: string): () => void {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = mockInvoke.getMockImplementation()!;
  mockInvoke.mockImplementation(((cmd: string, args?: unknown) =>
    cmd === command
      ? held.then(() => base(cmd, args as Record<string, unknown>))
      : base(cmd, args as Record<string, unknown>)) as typeof invoke);
  return () => release();
}

describe('busy', () => {
  it('holds from the start of a prompt that switches tabs, through its dialog, until the gate is hidden', async () => {
    win.tabs.push(tab({}), hugeTab('huge', 1));
    win.activeIndex = 0;
    let release: () => void = () => {};
    win.endComposition = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    expect(gate.busy).toBe(false);
    const prompting = gate.onFlushRequest();
    await settle();
    expect(gate.visible).toBe(false);
    expect(gate.busy).toBe(true);
    release();
    await prompting;
    expect(gate.visible).toBe(true);
    expect(gate.busy).toBe(true);
    gate.cancel();
    expect(gate.busy).toBe(false);
  });

  it('is not left on when the switch throws', async () => {
    win.tabs.push(tab({}), hugeTab('huge', 1));
    win.activeIndex = 0;
    vi.spyOn(win, 'switchTo').mockRejectedValue(new Error('boom'));
    await expect(gate.onFlushRequest()).rejects.toThrow('boom');
    expect(gate.busy).toBe(false);
  });

  it('holds while the save writes', async () => {
    win.tabs.push(hugeTab('huge', 0));
    win.activeIndex = 0;
    await gate.onFlushRequest();
    const release = holdCommand('write_file_encoded');
    const saving = gate.save();
    await settle();
    expect(gate.busy).toBe(true);
    release();
    await saving;
    expect(gate.busy).toBe(false);
  });
});

describe('a tab close asked of a tab the window has left', () => {
  async function boxAndOther(): Promise<void> {
    await withBox(true);
    win.tabs.push(tab({ id: 'other', tabIndex: 1 }));
  }

  it.each([
    ['the tab is still the active one', false],
    ['another tab was switched to during the write', true],
  ])('after the box was saved: %s', async (_name, switchAway) => {
    await boxAndOther();
    const boxTab = win.tabs[0]!;
    const dismissed = vi.fn();
    gate.onDismissed = dismissed;
    await gate.promptTabClose(boxTab);
    const release = holdCommand('splice_file');
    const saving = gate.save();
    await settle();
    if (switchAway) {
      await win.switchTo(1);
    }
    release();
    await saving;

    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
    expect(host.finishTabClose.mock.calls[0]![0]).toBe(boxTab);
    expect(gate.visible).toBe(false);
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(win.tabs).toHaveLength(2);
  });

  it('closes the tab it was asked for when the prompt is raised again after a switch', async () => {
    await boxAndOther();
    const boxTab = win.tabs[0]!;
    const other = win.tabs[1]!;
    const dismissed = vi.fn();
    gate.onDismissed = dismissed;
    let blocked = true;
    host.promptBlocked = () => blocked;
    await gate.promptTabClose(boxTab);
    expect(gate.held).toBe(true);
    win.rangeBoxCancel();
    await win.switchTo(1);
    blocked = false;
    await gate.resumeDeferred();

    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
    expect(host.finishTabClose).toHaveBeenCalledWith(boxTab);
    expect(host.finishTabClose).not.toHaveBeenCalledWith(other);
    expect(gate.visible).toBe(false);
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(win.tabs).toHaveLength(2);
  });

  it('does not apply to a quit or a window close', async () => {
    win.tabs.push(hugeTab('huge', 0));
    win.activeIndex = 0;
    await gate.onFlushRequest();
    await gate.discard();
    expect(sent()).toContain('request_exit');
  });
});
/** The paths every `write_file_encoded` was sent for. */
function writtenPaths(): unknown[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === 'write_file_encoded')
    .map(([, args]) => (args as { path: string }).path);
}

describe('a dialog asks about the tab it was raised for', () => {
  it.each([
    ['discard', 'quit'],
    ['discard', 'window close'],
    ['save', 'quit'],
    ['save', 'window close'],
  ] as const)(
    '%ss the tab it asked about and goes on with the %s after another tab was switched to',
    async (action, continuation) => {
      win.tabs.push(hugeTab('A', 0), smallTab('B', 1));
      win.activeIndex = 0;
      const vetoed = vi.fn();
      gate.onVetoed = vetoed;
      if (continuation === 'quit') {
        await gate.onFlushRequest();
      } else {
        await gate.onCloseFlushRequest();
      }
      expect(gate.visible).toBe(true);
      await win.switchTo(1);
      await gate[action]();

      expect(win.tabs[1]!.content.toString()).toBe('B text');
      expect(win.isDirty(win.tabs[1]!)).toBe(true);
      expect(writtenPaths()).not.toContain('/tmp/B.txt');
      expect(win.isDirty(win.tabs[0]!)).toBe(false);
      if (continuation === 'quit') {
        expect(sent()).toContain('request_exit');
      } else {
        expect(host.finishWindowClose).toHaveBeenCalledTimes(1);
      }
      expect(vetoed).not.toHaveBeenCalled();
      expect(gate.visible).toBe(false);
    },
  );

  it.each([['discard'], ['save']] as const)(
    '%ss the edit box of a tab close and closes that tab after another tab was switched to',
    async (action) => {
      await withBox(true);
      win.tabs.push(tab({ id: 'other', tabIndex: 1 }));
      const boxTab = win.tabs[0]!;
      const other = win.tabs[1]!;
      await gate.promptTabClose(boxTab);
      await win.switchTo(1);
      await gate[action]();

      if (action === 'save') {
        expect(sent()).toContain('splice_file');
      } else {
        expect(win.rangeBox).toBeNull();
      }
      expect(host.finishTabClose).toHaveBeenCalledTimes(1);
      expect(host.finishTabClose).toHaveBeenCalledWith(boxTab);
      expect(host.finishTabClose).not.toHaveBeenCalledWith(other);
      expect(gate.visible).toBe(false);
    },
  );

  it.each([['discard'], ['save']] as const)(
    '%ss the tab it asked about, not the one that moved into its place while a switch waited',
    async (action) => {
      win.tabs.push(smallTab('X', 0), hugeTab('A', 1), smallTab('B', 2));
      win.activeIndex = 0;
      win.updateActiveContent(Text.of(['X typed']));
      const release = holdCommand('upsert_note');
      const asking = gate.onFlushRequest();
      await settle();
      expect(gate.busy).toBe(true);
      await win.deleteTab(0);
      release();
      await asking;
      expect(win.activeTab?.id).toBe('A');
      await gate[action]();

      const b = win.tabs.find((t) => t.id === 'B')!;
      expect(b.content.toString()).toBe('B text');
      expect(win.isDirty(b)).toBe(true);
      expect(writtenPaths()).not.toContain('/tmp/B.txt');
      if (action === 'discard') {
        expect(win.isDirty(win.tabs.find((t) => t.id === 'A')!)).toBe(false);
      }
      expect(gate.visible).toBe(false);
    },
  );
});
/** A tab too large to snapshot: the gate asks about it. */
function huge(id: string, index: number): DocTab {
  return tab({
    id,
    path: `/tmp/${id}.txt`,
    tabIndex: index,
    order: index,
    content: Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]),
  });
}
/** Two tabs: the huge one first, a plain one active. */
function hugeAndPlain(): void {
  win.tabs.push(huge('huge', 0), tab({ id: 'plain', tabIndex: 1, order: 1 }));
  win.activeIndex = 1;
}
/** A switch that another one wins: once the requested tab is active, the user
 *  has clicked on the plain one. */
function racingSwitch(): void {
  const real = win.switchTo.bind(win);
  let raced = false;
  vi.spyOn(win, 'switchTo').mockImplementation(async (index: number) => {
    await real(index);
    if (!raced) {
      raced = true;
      win.activeIndex = 1;
    }
  });
}

describe('settling the transfers first', () => {
  it('runs before a window close scans for what blocks', async () => {
    hugeAndPlain();
    const order: string[] = [];
    vi.spyOn(win, 'settleTransfers').mockImplementation(() => {
      order.push('settle');
      return Promise.resolve();
    });
    vi.spyOn(win, 'firstOversizedDirtyIndex').mockImplementation(() => {
      order.push('scan');
      return 0;
    });
    await gate.onCloseFlushRequest();
    expect(order[0]).toBe('settle');
    expect(order).toContain('scan');
  });

  it('runs before a quit scans, vetoes or asks', async () => {
    hugeAndPlain();
    const order: string[] = [];
    vi.spyOn(win, 'settleTransfers').mockImplementation(() => {
      order.push('settle');
      return Promise.resolve();
    });
    vi.spyOn(win, 'firstOversizedDirtyIndex').mockImplementation(() => {
      order.push('scan');
      return 0;
    });
    mockInvoke.mockImplementation(((cmd: string) => {
      order.push(cmd);
      return Promise.resolve(null);
    }) as typeof invoke);
    await gate.onFlushRequest();
    expect(order[0]).toBe('settle');
    expect(order.indexOf('settle')).toBeLessThan(order.indexOf('scan'));
    expect(order.indexOf('settle')).toBeLessThan(order.indexOf('flush_cancel'));
  });
});

describe('a dialog stays on the tab it is about', () => {
  it('leaves the tab active when another switch won while the dialog was raised', async () => {
    hugeAndPlain();
    racingSwitch();
    await gate.onFlushRequest();
    expect(gate.visible).toBe(true);
    expect(win.activeTab?.id).toBe('huge');
  });

  it('does the same for a window close', async () => {
    hugeAndPlain();
    racingSwitch();
    await gate.onCloseFlushRequest();
    expect(gate.visible).toBe(true);
    expect(win.activeTab?.id).toBe('huge');
  });

  it('does the same after the veto of a quit that had input on its way', async () => {
    hugeAndPlain();
    win.windowedPending = () => true;
    win.endComposition = () => Promise.resolve();
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'flush_cancel') {
        setTimeout(() => gate.onFlushCancelled(), 0);
      }
      return Promise.resolve(cmd === 'tab_transfer_settle_window' ? [] : null);
    }) as typeof invoke);
    racingSwitch();
    await gate.onFlushRequest();
    expect(gate.visible).toBe(true);
    expect(win.activeTab?.id).toBe('huge');
  });

  it('does the same after the veto of a quit for a snapshot that failed', async () => {
    win.tabs.push(
      tab({
        id: 'w',
        tabIndex: 0,
        order: 0,
        content: Text.of(['dirty']),
      }),
      tab({ id: 'plain', tabIndex: 1, order: 1 }),
    );
    win.activeIndex = 1;
    snapshotsWork = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    racingSwitch();
    await gate.onFlushRequest();
    expect(gate.visible).toBe(true);
    expect(win.activeTab?.id).toBe('w');
  });

  it('does the same when a held-back prompt is raised again', async () => {
    hugeAndPlain();
    let blocked = true;
    host.promptBlocked = () => blocked;
    await gate.onCloseFlushRequest();
    expect(gate.held).toBe(true);
    blocked = false;
    racingSwitch();
    await gate.resumeDeferred();
    expect(gate.visible).toBe(true);
    expect(win.activeTab?.id).toBe('huge');
  });

  it('looks again when the tab it was about is gone', async () => {
    win.tabs.push(
      huge('huge', 0),
      huge('other', 1),
      tab({ id: 'plain', tabIndex: 2, order: 2 }),
    );
    win.activeIndex = 2;
    const real = win.switchTo.bind(win);
    let removed = false;
    vi.spyOn(win, 'switchTo').mockImplementation(async (index: number) => {
      if (!removed) {
        removed = true;
        win.tabs.splice(0, 1);
        win.activeIndex = 1;
        return;
      }
      await real(index);
    });
    await gate.onFlushRequest();
    expect(gate.visible).toBe(true);
    expect(win.activeTab?.id).toBe('other');
  });

  it('saves and discards the tab it is about, whichever is active afterwards', async () => {
    hugeAndPlain();
    await gate.onFlushRequest();
    expect(win.activeTab?.id).toBe('huge');
    const target = win.tabs[0]!;
    // The user clicks another tab while the dialog is up.
    win.activeIndex = 1;
    const saved = vi.spyOn(win, 'saveTab').mockImplementation((t) => {
      t.savedContent = t.content;
      return Promise.resolve(true);
    });
    await gate.save();
    expect(saved).toHaveBeenCalledWith(target);
    expect(sent()).not.toContain('write_file_encoded');

    hugeAndPlain2();
    await gate.onFlushRequest();
    win.activeIndex = 1;
    const reverted = vi.spyOn(win, 'discardChanges');
    await gate.discard();
    expect(reverted).toHaveBeenCalledWith(0);
  });

  it('saves a tab that cannot be snapshotted as a new file, whichever is active', async () => {
    win.tabs.push(
      tab({ id: 'w', tabIndex: 0, order: 0, content: Text.of(['dirty']) }),
      tab({ id: 'plain', tabIndex: 1, order: 1 }),
    );
    win.activeIndex = 1;
    snapshotsWork = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await gate.onFlushRequest();
    expect(gate.reason).toBe('unwritable');
    const target = win.tabs[0]!;
    win.activeIndex = 1;
    const savedAs = vi.spyOn(win, 'saveAsTab').mockResolvedValue(false);
    await gate.save();
    expect(savedAs).toHaveBeenCalledWith(target);
  });

  it('closes the tab it was about, and no other, when a tab close finishes', async () => {
    await withBox(true);
    win.tabs.push(tab({ id: 'plain', tabIndex: 1, order: 1 }));
    const boxTab = win.tabs[0]!;
    await gate.promptTabClose(boxTab);
    win.activeIndex = 1;
    await gate.discard();
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
    expect(host.finishTabClose).toHaveBeenCalledWith(boxTab);
  });
});
/** The huge tab again, in a window that has been reset. */
function hugeAndPlain2(): void {
  win.tabs.length = 0;
  win.tabs.push(huge('huge', 0), tab({ id: 'plain', tabIndex: 1, order: 1 }));
  win.activeIndex = 1;
  gate = new CloseGate(win, host);
}

describe('closing', () => {
  /** What a window around the gate tells a tab bar. */
  function wire(): void {
    win.dragHost = {
      navigationLocked: () => false,
      gateVisible: () => gate.visible,
      modalOpen: () => false,
      closing: () => gate.closing,
      quitting: () => gate.quitting,
    };
  }

  it('is set by a window close and kept until the window is gone', async () => {
    let during = false;
    host.finishWindowClose.mockImplementation(() => {
      during = gate.closing;
      return Promise.resolve();
    });
    win.tabs.push(tab({ id: 'plain' }));
    await gate.onCloseFlushRequest();
    expect(during).toBe(true);
    expect(gate.closing).toBe(true);
  });

  it('is not set while a quit has the window', async () => {
    win.tabs.push(tab({ id: 'plain' }));
    await gate.onFlushRequest();
    await gate.onCloseFlushRequest();
    expect(gate.closing).toBe(false);
    expect(host.finishWindowClose).not.toHaveBeenCalled();
  });

  it('survives a held-back prompt and the dialog, and ends with the window close', async () => {
    hugeAndPlain();
    wire();
    let blocked = true;
    host.promptBlocked = () => blocked;
    await gate.onCloseFlushRequest();
    expect(gate.held).toBe(true);
    expect(gate.closing).toBe(true);
    expect(win.dragLocked()).toBe(true);
    blocked = false;
    await gate.resumeDeferred();
    expect(gate.visible).toBe(true);
    expect(gate.closing).toBe(true);
    let during = false;
    host.finishWindowClose.mockImplementation(() => {
      during = gate.closing;
      return Promise.resolve();
    });
    vi.spyOn(win, 'discardChanges').mockImplementation((index) => {
      win.tabs[index]!.content = win.tabs[index]!.savedContent;
    });
    await gate.discard();
    expect(host.finishWindowClose).toHaveBeenCalledTimes(1);
    expect(during).toBe(true);
  });

  it('is cleared when the dialog is cancelled', async () => {
    hugeAndPlain();
    await gate.onCloseFlushRequest();
    expect(gate.closing).toBe(true);
    gate.cancel();
    expect(gate.closing).toBe(false);
  });

  it('is cleared when a save fails or is declined', async () => {
    hugeAndPlain();
    await gate.onCloseFlushRequest();
    vi.spyOn(win, 'saveTab').mockResolvedValue(false);
    await gate.save();
    expect(gate.closing).toBe(false);
    expect(gate.visible).toBe(false);
  });

  it('is cleared when a quit takes the shutdown over, and nothing else is left', async () => {
    hugeAndPlain();
    wire();
    await gate.onCloseFlushRequest();
    expect(gate.closing).toBe(true);
    // A quit starts while the close dialog is up: it vetoes itself and asks.
    await gate.onFlushRequest();
    expect(gate.closing).toBe(false);
    expect(gate.quitting).toBe(true);
    vi.spyOn(win, 'saveTab').mockImplementation((t) => {
      t.savedContent = t.content;
      return Promise.resolve(true);
    });
    await gate.save();
    expect(sent()).toContain('request_exit');
    // The quit goes round again and is vetoed by another window.
    gate.onFlushCancelled();
    expect(gate.closing).toBe(false);
    expect(gate.quitting).toBe(false);
    expect(gate.visible).toBe(false);
    expect(win.dragLocked()).toBe(false);
    const { receiverAnswer } = await import('./incomingTransfer.svelte');
    expect(
      receiverAnswer({
        ready: true,
        indexSettled: true,
        locked: win.dragLocked(),
        holdsId: false,
      }),
    ).toBe(true);
  });

  it('is left alone by a vetoed quit', async () => {
    hugeAndPlain();
    await gate.onCloseFlushRequest();
    gate.onFlushCancelled();
    expect(gate.closing).toBe(true);
  });

  it('is cleared when the close failed to finish', async () => {
    hugeAndPlain();
    await gate.onCloseFlushRequest();
    expect(gate.closing).toBe(true);
    gate.abandonClose();
    expect(gate.closing).toBe(false);
  });

  it('keeps a tab bar from starting a drag, and the window from taking a tab', async () => {
    hugeAndPlain();
    wire();
    expect(win.dragLocked()).toBe(false);
    await gate.onCloseFlushRequest();
    expect(win.dragLocked()).toBe(true);
    const { receiverAnswer } = await import('./incomingTransfer.svelte');
    expect(
      receiverAnswer({
        ready: true,
        indexSettled: true,
        locked: win.dragLocked(),
        holdsId: false,
      }),
    ).toBe(false);
  });
});
