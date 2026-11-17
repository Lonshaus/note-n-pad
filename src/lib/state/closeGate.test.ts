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
      case 'upsert_note':
        return snapshotsWork
          ? Promise.resolve(null)
          : Promise.reject(new Error('disk full'));
      default:
        return Promise.resolve(null);
    }
  }) as typeof invoke);
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
/** Puts the gate dialog up for the tab at `index`, as its prompt would. */
function showFor(index: number): void {
  (gate as unknown as { askedTab: DocTab | null }).askedTab =
    win.tabs[index] ?? null;
  gate.visible = true;
}

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
  it('shows the box prompt and keeps the tab', async () => {
    await withBox(true);
    await gate.promptTabClose();

    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('rangeBox');
    expect(host.finishTabClose).not.toHaveBeenCalled();
  });

  it('closes the tab after 儲存 or 放棄變更', async () => {
    await withBox(true);
    await gate.promptTabClose();
    await gate.save();
    expect(sent()).toContain('splice_file');
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);

    await withBox(true);
    await gate.promptTabClose();
    await gate.discard();
    expect(host.finishTabClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the tab on 取消', async () => {
    await withBox(true);
    await gate.promptTabClose();
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
    await gate.promptTabClose();
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
    await gate.promptTabClose();

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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
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
      return Promise.resolve(null);
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
    const discard = vi
      .spyOn(win, 'discardWindowedActive')
      .mockResolvedValue(worked);
    const prompt = vi.spyOn(gate, 'prompt').mockResolvedValue();
    const vetoed = vi.fn();
    gate.onVetoed = vetoed;
    showFor(0);
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
    const dismissed = vi.fn();
    gate.onDismissed = dismissed;
    await gate.promptTabClose();
    const release = holdCommand('splice_file');
    const saving = gate.save();
    await settle();
    if (switchAway) {
      await win.switchTo(1);
    }
    release();
    await saving;

    expect(host.finishTabClose).toHaveBeenCalledTimes(switchAway ? 0 : 1);
    expect(gate.visible).toBe(false);
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(win.tabs).toHaveLength(2);
  });

  it('closes nothing when the prompt is raised again after a switch', async () => {
    await boxAndOther();
    const dismissed = vi.fn();
    gate.onDismissed = dismissed;
    let blocked = true;
    host.promptBlocked = () => blocked;
    await gate.promptTabClose();
    expect(gate.held).toBe(true);
    win.rangeBoxCancel();
    await win.switchTo(1);
    blocked = false;
    await gate.resumeDeferred();

    expect(host.finishTabClose).not.toHaveBeenCalled();
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

describe('a dialog asks about the tab it was raised for', () => {
  it.each([['discard'], ['save']] as const)(
    'does not %s another tab that was switched to while a quit asks',
    async (action) => {
      win.tabs.push(hugeTab('A', 0), smallTab('B', 1));
      win.activeIndex = 0;
      await gate.onFlushRequest();
      expect(gate.visible).toBe(true);
      await win.switchTo(1);
      await gate[action]();

      expect(win.tabs[1]!.content.toString()).toBe('B text');
      expect(win.isDirty(win.tabs[1]!)).toBe(true);
      expect(sent()).not.toContain('write_file_encoded');
      expect(sent()).not.toContain('request_exit');
      expect(gate.visible).toBe(false);
    },
  );

  it.each([['discard'], ['save']] as const)(
    'does not %s the edit box of a tab close after another tab was switched to',
    async (action) => {
      await withBox(true);
      win.tabs.push(tab({ id: 'other', tabIndex: 1 }));
      await gate.promptTabClose();
      await win.switchTo(1);
      await gate[action]();

      expect(sent()).not.toContain('splice_file');
      expect(win.rangeBox).not.toBeNull();
      expect(win.rangeBoxDirty()).toBe(true);
      expect(host.finishTabClose).not.toHaveBeenCalled();
      expect(gate.visible).toBe(false);
    },
  );

  it.each([['discard'], ['save']] as const)(
    'does not %s the tab that moved into its place while a switch waited',
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
      expect(win.activeTab?.id).toBe('B');
      await gate[action]();

      expect(win.activeTab?.content.toString()).toBe('B text');
      expect(win.isDirty(win.activeTab!)).toBe(true);
      expect(sent()).not.toContain('write_file_encoded');
      expect(gate.visible).toBe(false);
    },
  );
});
