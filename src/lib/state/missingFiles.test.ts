// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Tabs whose file was deleted or moved away while they held unsaved changes,
// driven through the real window state and close gate against a fake backend:
// which tabs get marked, the one-at-a-time queue, the dialog being bound to its
// tab rather than to whatever is active, the rules for sharing the window with
// the other dialogs, and a marked tab never being written to its old path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { CloseGate, type GateHost } from './closeGate.svelte';
import { DocumentWindowState, type DocTab } from './documentWindow.svelte';
import { MissingFiles } from './missingFiles.svelte';
import { editionState } from './edition.svelte';
import { SNAPSHOT_CONTENT_MAX } from '../util/snapshotPolicy';
import type { NoteSnapshot } from './stickyNote.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockSave = vi.mocked(save);
vi.stubGlobal('window', globalThis);
/** Paths `missing_paths` reports as gone. */
let gone: Set<string>;
/** When set, `missing_paths` waits for it, so a test can interleave. */
let holdAnswer: Promise<void> | null;
/** Extra answers by command. */
let answers: Record<string, unknown>;

function backend(): void {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(((cmd: string, args?: unknown) => {
    if (cmd in answers) {
      return Promise.resolve(answers[cmd]);
    }
    switch (cmd) {
      case 'missing_paths': {
        const paths = (args as { paths: string[] }).paths;
        const reply = paths.filter((p) => gone.has(p));
        return holdAnswer === null
          ? Promise.resolve(reply)
          : holdAnswer.then(() => reply);
      }
      case 'read_range':
        return Promise.resolve({ text: 'one\ntwo\n', lossy: false });
      case 'file_fingerprint':
        return Promise.resolve({ size: 100, mtime_ms: 1 });
      case 'windowed_save':
        return Promise.resolve({
          fingerprint: { size: 1, mtime_ms: 1 },
          total_bytes: 1,
          total_lines: 1,
        });
      default:
        return Promise.resolve(null);
    }
  }) as typeof invoke);
}

function calls(command: string): unknown[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === command)
    .map(([, args]) => args);
}

function sent(): string[] {
  return mockInvoke.mock.calls.map(([cmd]) => cmd);
}
/** An ordinary tab holding `text` that the file on disk does not have. */
function dirty(id: string, path: string, text: string, index = 0): DocTab {
  return {
    id,
    path,
    readOnlyFile: false,
    content: Text.of([text]),
    savedContent: Text.empty,
    language: null,
    explicit: false,
    lineEnding: 'LF',
    savedLineEnding: 'LF',
    hadBom: false,
    encoding: 'UTF-8',
    lossy: false,
    tabIndex: index,
  };
}

function clean(id: string, path: string, index = 0): DocTab {
  const content = Text.of(['same']);
  return { ...dirty(id, path, 'same', index), content, savedContent: content };
}

let win: DocumentWindowState;
let host: GateHost & {
  finishWindowClose: ReturnType<typeof vi.fn>;
  closeEmptyWindow: ReturnType<typeof vi.fn<() => Promise<void>>>;
  finishTabClose: ReturnType<
    typeof vi.fn<(keepWindow?: boolean) => Promise<void>>
  >;
  focusWindow: ReturnType<typeof vi.fn>;
};
let gate: CloseGate;
let missing: MissingFiles;
/** The window was destroyed by closing its last tab. */
let destroyed: boolean;
/** How many times the window was destroyed. */
let destroyCalls: number;

function tab(id: string): DocTab {
  const found = win.tabs.find((t) => t.id === id);
  if (found === undefined) {
    throw new Error(`no tab ${id}`);
  }
  return found;
}

function ids(): string[] {
  return win.tabs.map((t) => t.id);
}
/** Open tabs in `win`, `active` being the id shown. */
function open(tabs: DocTab[], active: string): void {
  for (const t of tabs) {
    win.tabs.push(t);
  }
  win.activeIndex = tabs.findIndex((t) => t.id === active);
}

let readySpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  destroyed = false;
  destroyCalls = 0;
  gone = new Set();
  holdAnswer = null;
  answers = {};
  backend();
  mockSave.mockReset();
  readySpy = vi.spyOn(editionState, 'ready').mockResolvedValue();
  win = new DocumentWindowState();
  host = {
    label: 'doc-g',
    finishWindowClose: vi.fn(() => Promise.resolve()),
    // What the window does: close the active tab, and the window with its last
    // tab unless a quit or close is about to take over.
    finishTabClose: vi.fn(async (keepWindow?: boolean) => {
      await win.deleteTab(win.activeIndex);
      if (win.tabs.length === 0 && keepWindow !== true) {
        destroyed = true;
        destroyCalls += 1;
      }
    }),
    closeEmptyWindow: vi.fn(async () => {
      destroyed = true;
      destroyCalls += 1;
    }),
    focusWindow: vi.fn(() => Promise.resolve()),
    promptBlocked: () => missing.current() !== null,
  };
  gate = new CloseGate(win, host);
  missing = new MissingFiles(win, gate, host);
});

afterEach(() => {
  readySpy.mockRestore();
});

describe('which tabs are checked', () => {
  it('sends the path of every tab with unsaved changes, once, and no other', async () => {
    open(
      [
        dirty('a', '/p/a.txt', 'A', 0),
        dirty('twin', '/p/a.txt', 'T', 1),
        clean('b', '/p/b.txt', 2),
        dirty('u', '', 'untitled', 3),
      ],
      'a',
    );
    await missing.check();
    expect(calls('missing_paths')).toEqual([{ paths: ['/p/a.txt'] }]);
  });

  it('asks nothing when no tab has changes to lose', async () => {
    open([clean('a', '/p/a.txt')], 'a');
    await missing.check();
    expect(calls('missing_paths')).toEqual([]);
  });

  it('marks nothing when every file is still there', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    await missing.check();
    expect(tab('a').missing).not.toBe(true);
    expect(missing.current()).toBeNull();
  });

  it('marks only the tabs whose file is gone', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('b', '/p/b.txt', 'B', 1)], 'a');
    gone.add('/p/b.txt');
    await missing.check();
    expect(tab('a').missing).not.toBe(true);
    expect(tab('b').missing).toBe(true);
  });

  it('marks a windowed tab with changes, and never a viewer', async () => {
    const windowed = dirty('w', '/p/w.log', '', 0);
    windowed.content = Text.empty;
    windowed.windowed = {
      sessionId: 7,
      totalBytes: 1,
      totalLines: 1,
      fingerprint: null,
      dirty: true,
      topLine: 0,
    };
    const viewer = clean('v', '/p/v.log', 1);
    viewer.large = { size: 100 };
    open([windowed, viewer], 'w');
    gone.add('/p/w.log');
    gone.add('/p/v.log');
    await missing.check();
    expect(calls('missing_paths')).toEqual([{ paths: ['/p/w.log'] }]);
    expect(tab('w').missing).toBe(true);
    expect(tab('v').missing).not.toBe(true);
  });
});

describe('the queue', () => {
  it('shows one tab at a time, the next only once the first is dealt with', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('b', '/p/b.txt', 'B', 1)], 'a');
    gone.add('/p/a.txt');
    gone.add('/p/b.txt');
    await missing.check();
    expect(missing.current()?.tabId).toBe('a');
    await missing.discard();
    expect(ids()).toEqual(['b']);
    expect(missing.current()?.tabId).toBe('b');
    await missing.discard();
    expect(missing.current()).toBeNull();
  });

  it('keeps one entry for a tab that is already marked when the app comes forward again', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    gone.add('/p/a.txt');
    await missing.check();
    await missing.check();
    expect(calls('missing_paths')).toHaveLength(1);
    expect(missing.pending()).toHaveLength(1);
  });

  it('does not mark a tab whose answer arrives after it was saved elsewhere', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    gone.add('/p/a.txt');
    let release = (): void => {};
    holdAnswer = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checking = missing.check();
    await win.saveAs('/p/elsewhere.txt');
    // It has changes again, but under another path than the one that was sent.
    tab('a').content = Text.of(['more']);
    release();
    await checking;
    expect(tab('a').missing).not.toBe(true);
    expect(missing.current()).toBeNull();
  });

  it('does not mark a tab that no longer has changes when the answer arrives', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    gone.add('/p/a.txt');
    let release = (): void => {};
    holdAnswer = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checking = missing.check();
    tab('a').savedContent = tab('a').content;
    release();
    await checking;
    expect(tab('a').missing).not.toBe(true);
  });

  it('skips an entry whose tab was saved elsewhere meanwhile', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('b', '/p/b.txt', 'B', 1)], 'a');
    gone.add('/p/a.txt');
    gone.add('/p/b.txt');
    await missing.check();
    expect(missing.current()?.tabId).toBe('a');
    // A was saved by some other route (⌘S) before its turn came round again.
    await win.saveAs('/p/new-a.txt');
    expect(tab('a').missing).toBe(false);
    expect(missing.current()?.tabId).toBe('b');
    expect(missing.pending().map((i) => i.tabId)).toEqual(['b']);
  });

  it('skips an entry whose tab was closed', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('b', '/p/b.txt', 'B', 1)], 'b');
    gone.add('/p/a.txt');
    gone.add('/p/b.txt');
    await missing.check();
    expect(missing.current()?.tabId).toBe('a');
    await win.deleteTab(0);
    expect(missing.current()?.tabId).toBe('b');
  });
});

describe('the dialog belongs to its tab, not to the active one', () => {
  async function aGoneCActive(): Promise<void> {
    open(
      [dirty('a', '/p/a.txt', 'AAA', 0), dirty('c', '/p/c.txt', 'CCC', 1)],
      'c',
    );
    gone.add('/p/a.txt');
    await missing.check();
    expect(missing.current()?.tabId).toBe('a');
    // The check took the window to A; something else moves it away again.
    expect(win.activeTab?.id).toBe('a');
    await win.switchTo(1);
    expect(win.activeTab?.id).toBe('c');
  }

  it('saves only the tab it is about, to the new path', async () => {
    await aGoneCActive();
    expect(await missing.saveAs('/p/new-a.txt')).toBe(true);
    expect(calls('write_file_encoded')).toEqual([
      {
        path: '/p/new-a.txt',
        content: 'AAA',
        encoding: 'UTF-8',
        withBom: false,
      },
    ]);
    expect(tab('a').path).toBe('/p/new-a.txt');
    expect(tab('a').missing).toBe(false);
    expect(tab('c').path).toBe('/p/c.txt');
    expect(win.isDirty(tab('c'))).toBe(true);
    expect(missing.current()).toBeNull();
  });

  it('discards only the tab it is about, leaving the other and its record', async () => {
    await aGoneCActive();
    await missing.discard();
    expect(ids()).toEqual(['c']);
    expect(calls('delete_note')).toEqual([{ id: 'a' }]);
    expect(win.isDirty(tab('c'))).toBe(true);
    expect(tab('c').path).toBe('/p/c.txt');
    expect(missing.current()).toBeNull();
  });

  it('closes the tab without the save-before-closing question', async () => {
    await aGoneCActive();
    await missing.discard();
    expect(missing.confirmClose).toBe(false);
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
  });

  it('leaves the dialog up when the save dialog is cancelled', async () => {
    await aGoneCActive();
    mockSave.mockResolvedValue(null);
    expect(await missing.saveAs()).toBe(false);
    expect(missing.current()?.tabId).toBe('a');
    expect(tab('a').missing).toBe(true);
    expect(calls('write_file_encoded')).toEqual([]);
  });

  it('moves on when the tab was closed before the button was pressed', async () => {
    await aGoneCActive();
    const item = missing.current();
    expect(item).not.toBeNull();
    await win.deleteTab(0);
    expect(await missing.saveAs('/p/x.txt')).toBe(false);
    expect(calls('write_file_encoded')).toEqual([]);
    expect(ids()).toEqual(['c']);
  });

  it('can bring the window to the tab the dialog is about', async () => {
    await aGoneCActive();
    await missing.revealCurrent();
    expect(win.activeTab?.id).toBe('a');
  });
});

describe('the window stays put while the dialog is up', () => {
  it('locks navigation and ignores a close request', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('c', '/p/c.txt', 'C', 1)], 'c');
    gone.add('/p/a.txt');
    expect(missing.navigationLocked()).toBe(false);
    await missing.check();
    expect(missing.navigationLocked()).toBe(true);
    missing.requestClose();
    expect(missing.confirmClose).toBe(false);
    expect(host.finishTabClose).not.toHaveBeenCalled();
    expect(ids()).toEqual(['a', 'c']);
    expect(win.activeTab?.id).toBe('a');
  });

  it('unlocks once the queue is empty', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    gone.add('/p/a.txt');
    await missing.check();
    await missing.discard();
    expect(missing.navigationLocked()).toBe(false);
  });
});

describe('closing a tab', () => {
  it('asks first when the tab has changes', () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    missing.requestClose();
    expect(missing.confirmClose).toBe(true);
    expect(host.finishTabClose).not.toHaveBeenCalled();
  });

  it('closes a clean tab at once', () => {
    open([clean('a', '/p/a.txt')], 'a');
    missing.requestClose();
    expect(missing.confirmClose).toBe(false);
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
  });

  it('closes without saving on 不儲存 and keeps the tab on cancel', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    missing.requestClose();
    missing.cancelClose();
    expect(missing.confirmClose).toBe(false);
    expect(ids()).toEqual(['a']);
    missing.requestClose();
    await missing.confirmDiscard();
    expect(ids()).toEqual([]);
    expect(calls('write_file_encoded')).toEqual([]);
  });

  it('saves on 儲存 and then closes, keeping the dialog when the save is cancelled', async () => {
    open([dirty('a', '', 'A')], 'a');
    missing.requestClose();
    mockSave.mockResolvedValueOnce(null);
    await missing.confirmSave();
    expect(missing.confirmClose).toBe(true);
    expect(ids()).toEqual(['a']);
    mockSave.mockResolvedValueOnce('/p/new.txt');
    await missing.confirmSave();
    expect(missing.confirmClose).toBe(false);
    expect(calls('write_file_encoded')).toHaveLength(1);
    expect(ids()).toEqual([]);
  });

  it('shows the dialog of a tab whose file is gone instead of asking', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    gone.add('/p/a.txt');
    await missing.check();
    // Another dialog was holding it back, so it is not showing yet.
    missing.cancelClose();
    missing.requestClose();
    expect(missing.confirmClose).toBe(false);
    expect(host.finishTabClose).not.toHaveBeenCalled();
    expect(missing.current()?.tabId).toBe('a');
  });
});

describe('sharing the window with the other dialogs', () => {
  it('waits for the close confirmation of another tab, and does not move to its own tab', async () => {
    open(
      [
        dirty('a', '/p/a.txt', 'A', 0),
        dirty('b', '/p/b.txt', 'B', 1),
        dirty('c', '/p/c.txt', 'C', 2),
      ],
      'b',
    );
    missing.requestClose();
    expect(missing.confirmClose).toBe(true);
    gone.add('/p/a.txt');
    await missing.check();
    expect(tab('a').missing).toBe(true);
    expect(missing.current()).toBeNull();
    await missing.revealCurrent();
    expect(win.activeTab?.id).toBe('b');
    await missing.confirmDiscard();
    expect(ids()).toEqual(['a', 'c']);
    // Only B's record went; A and C keep theirs and their changes.
    expect(calls('delete_note')).toEqual([{ id: 'b' }]);
    expect(win.isDirty(tab('a'))).toBe(true);
    expect(win.isDirty(tab('c'))).toBe(true);
    expect(missing.current()?.tabId).toBe('a');
    expect(win.activeTab?.id).toBe('a');
  });

  it('waits for the close gate, and shows once the gate is answered', async () => {
    const huge = dirty('x', '/p/x.txt', '', 0);
    huge.content = Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]);
    open([huge, dirty('a', '/p/a.txt', 'A', 1)], 'x');
    await gate.onFlushRequest();
    expect(gate.visible).toBe(true);
    gone.add('/p/a.txt');
    await missing.check();
    expect(tab('a').missing).toBe(true);
    expect(missing.current()).toBeNull();
    gate.cancel();
    expect(missing.current()?.tabId).toBe('a');
  });

  it('holds a quit back while the dialog is up, then asks about what still blocks', async () => {
    const huge = dirty('x', '/p/x.txt', '', 0);
    huge.content = Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]);
    open([huge, dirty('a', '/p/a.txt', 'A', 1)], 'a');
    gone.add('/p/a.txt');
    await missing.check();
    expect(missing.current()?.tabId).toBe('a');
    await gate.onFlushRequest();
    // The quit is vetoed, but its question waits behind the dialog.
    expect(sent()).toContain('flush_cancel');
    expect(gate.visible).toBe(false);
    expect(sent()).not.toContain('request_exit');
    await missing.discard();
    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('oversized');
    expect(win.activeTab?.id).toBe('x');
  });

  it('carries on with the quit when nothing else blocks once the queue is empty', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), clean('k', '/p/k.txt', 1)], 'a');
    gone.add('/p/a.txt');
    await missing.check();
    // An oversized change elsewhere is what vetoes the quit.
    const huge = dirty('x', '/p/x.txt', '', 2);
    huge.content = Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]);
    win.tabs.push(huge);
    await gate.onFlushRequest();
    expect(gate.visible).toBe(false);
    // Dealt with before the queue empties: nothing is left to ask.
    win.discardChanges(2);
    await missing.discard();
    expect(sent()).toContain('request_exit');
  });

  it('waits behind the write-back conflict dialog, whose tab is marked so it can drop write-anyway', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    gone.add('/p/a.txt');
    tab('a').windowed = {
      sessionId: 3,
      totalBytes: 1,
      totalLines: 1,
      fingerprint: null,
      dirty: true,
      topLine: 0,
    };
    win.windowedConflict = tab('a');
    await missing.check();
    expect(win.windowedConflict?.missing).toBe(true);
    expect(missing.current()).toBeNull();
    win.windowedConflictCancel();
    expect(missing.current()?.tabId).toBe('a');
  });
});

describe('a tab whose file is gone is never written to its old path', () => {
  it('saves an ordinary tab through a new path', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    gone.add('/p/a.txt');
    await missing.check();
    mockSave.mockResolvedValue('/p/new.txt');
    expect(await win.saveActive()).toBe(true);
    const paths = calls('write_file_encoded').map(
      (args) => (args as { path: string }).path,
    );
    expect(paths).toEqual(['/p/new.txt']);
    expect(tab('a').path).toBe('/p/new.txt');
    expect(tab('a').missing).toBe(false);
  });

  it('saves a windowed tab through a new path, never without one', async () => {
    const windowed = dirty('w', '/p/w.log', '', 0);
    windowed.content = Text.empty;
    windowed.windowed = {
      sessionId: 7,
      totalBytes: 1,
      totalLines: 1,
      fingerprint: { size: 1, mtime_ms: 1 },
      dirty: true,
      topLine: 0,
    };
    open([windowed], 'w');
    gone.add('/p/w.log');
    await missing.check();
    expect(tab('w').missing).toBe(true);
    mockSave.mockResolvedValue('/p/new.log');
    expect(await win.saveActive()).toBe(true);
    expect(calls('windowed_save')).toEqual([
      { sessionId: 7, expected: null, pathOverride: '/p/new.log' },
    ]);
    expect(tab('w').path).toBe('/p/new.log');
    expect(tab('w').missing).toBe(false);
  });

  it('asks where to save when the dialog is cancelled and writes nothing', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    gone.add('/p/a.txt');
    await missing.check();
    mockSave.mockResolvedValue(null);
    expect(await win.saveActive()).toBe(false);
    expect(calls('write_file_encoded')).toEqual([]);
    expect(tab('a').path).toBe('/p/a.txt');
    expect(tab('a').missing).toBe(true);
  });

  it('still saves a tab whose file is there to its own path', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    expect(await win.saveActive()).toBe(true);
    expect(calls('write_file_encoded')).toEqual([
      { path: '/p/a.txt', content: 'A', encoding: 'UTF-8', withBom: false },
    ]);
  });
});

describe('the edit box over a large file', () => {
  async function boxOver(source: string): Promise<void> {
    const viewer = clean('v', source, 0);
    viewer.large = { size: 100 };
    open([viewer], 'v');
    await win.openRangeBox(tab('v'), {
      startByte: 0,
      endByte: 8,
      startLine: 1,
      endLine: 2,
    });
    win.rangeBoxEdited(Text.of(['one', 'two', 'three']));
  }

  it('is marked when its source is gone and the box has changes', async () => {
    await boxOver('/p/big.log');
    gone.add('/p/big.log');
    await missing.check();
    expect(calls('missing_paths')).toEqual([{ paths: ['/p/big.log'] }]);
    expect(win.rangeBox?.missing).toBe(true);
    expect(missing.current()).toEqual({
      tabId: 'v',
      box: true,
      path: '/p/big.log',
    });
  });

  it('is not looked at while the box has no changes', async () => {
    await boxOver('/p/big.log');
    win.rangeBoxEdited(Text.of(['one', 'two', '']));
    gone.add('/p/big.log');
    await missing.check();
    expect(win.rangeBox?.missing).toBe(false);
    expect(calls('missing_paths')).toEqual([]);
  });

  it('is saved to a new file, never spliced back into the source', async () => {
    await boxOver('/p/big.log');
    gone.add('/p/big.log');
    await missing.check();
    const opened = vi.spyOn(win, 'openTab').mockResolvedValue();
    expect(await missing.saveAs('/p/part.txt')).toBe(true);
    expect(calls('splice_file')).toEqual([]);
    expect(calls('write_file_encoded')).toHaveLength(1);
    expect(opened).toHaveBeenCalledWith('/p/part.txt');
    expect(win.rangeBox).toBeNull();
    expect(missing.current()).toBeNull();
  });

  it('is discarded together with the viewer tab it sits on', async () => {
    await boxOver('/p/big.log');
    gone.add('/p/big.log');
    await missing.check();
    await missing.discard();
    expect(win.rangeBox).toBeNull();
    expect(ids()).toEqual([]);
    expect(calls('splice_file')).toEqual([]);
  });

  it('is what closing its viewer tab asks about, instead of the box gate', async () => {
    await boxOver('/p/big.log');
    gone.add('/p/big.log');
    await missing.check();
    // Held back by another dialog, so it is not showing yet.
    missing.cancelClose();
    const blockedBy = vi.spyOn(host, 'promptBlocked').mockReturnValue(false);
    missing.requestClose();
    expect(gate.visible).toBe(false);
    expect(host.finishTabClose).not.toHaveBeenCalled();
    expect(missing.current()?.box).toBe(true);
    blockedBy.mockRestore();
  });
});

describe('after the window restored its tabs', () => {
  function stored(over: Partial<NoteSnapshot>): NoteSnapshot {
    return {
      id: 'r',
      content: 'unsaved text',
      file_path: '/p/gone.txt',
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
      dirty: true,
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

  function restoreBackend(notes: NoteSnapshot[]): void {
    answers = {
      list_notes: notes,
      path_writable: true,
      stat_file: { size: 10 },
    };
    mockInvoke.mockImplementation(((cmd: string, args?: unknown) => {
      if (cmd === 'read_file_as' || cmd === 'read_file_auto') {
        return Promise.reject(new Error('No such file or directory'));
      }
      if (cmd in answers) {
        return Promise.resolve(answers[cmd]);
      }
      if (cmd === 'missing_paths') {
        const paths = (args as { paths: string[] }).paths;
        return Promise.resolve(paths.filter((p) => gone.has(p)));
      }
      return Promise.resolve(null);
    }) as typeof invoke);
  }

  it('marks a restored tab whose file was deleted meanwhile, with no focus event', async () => {
    restoreBackend([stored({})]);
    gone.add('/p/gone.txt');
    await win.init('g', null, null);
    await vi.waitFor(() => expect(tab('r').missing).toBe(true));
    expect(missing.current()?.tabId).toBe('r');
    // The restored text is still there, and saving never goes to the old path.
    expect(tab('r').content.toString()).toBe('unsaved text');
    mockSave.mockResolvedValue('/p/new.txt');
    expect(await win.saveActive()).toBe(true);
    const paths = calls('write_file_encoded').map(
      (args) => (args as { path: string }).path,
    );
    expect(paths).toEqual(['/p/new.txt']);
  });

  it('marks nothing when the restored file is still there', async () => {
    restoreBackend([stored({})]);
    await win.init('g', null, null);
    await vi.waitFor(() => expect(calls('missing_paths')).toHaveLength(1));
    expect(tab('r').missing).not.toBe(true);
    expect(missing.current()).toBeNull();
  });
});

describe("the window goes to the dialog's tab when what held it back is gone", () => {
  it('moves there when the close gate is cancelled', async () => {
    const huge = dirty('x', '/p/x.txt', '', 0);
    huge.content = Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]);
    open([huge, dirty('a', '/p/a.txt', 'A', 1)], 'x');
    await gate.onFlushRequest();
    gone.add('/p/a.txt');
    await missing.check();
    expect(win.activeTab?.id).toBe('x');
    gate.cancel();
    await vi.waitFor(() => expect(win.activeTab?.id).toBe('a'));
  });

  it('moves there when the close gate ends because its save was declined', async () => {
    const huge = dirty('x', '', '', 0);
    huge.content = Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]);
    open([huge, dirty('a', '/p/a.txt', 'A', 1)], 'x');
    await gate.onFlushRequest();
    gone.add('/p/a.txt');
    await missing.check();
    expect(win.activeTab?.id).toBe('x');
    mockSave.mockResolvedValue(null);
    await gate.save();
    expect(gate.visible).toBe(false);
    await vi.waitFor(() => expect(win.activeTab?.id).toBe('a'));
  });

  it('moves there when a windowed save conflict is cancelled', async () => {
    const windowed = dirty('w', '/p/w.log', '', 0);
    windowed.content = Text.empty;
    windowed.windowed = {
      sessionId: 7,
      totalBytes: 1,
      totalLines: 1,
      fingerprint: null,
      dirty: true,
      topLine: 0,
    };
    open([windowed, dirty('a', '/p/a.txt', 'A', 1)], 'w');
    win.windowedConflict = tab('w');
    gone.add('/p/a.txt');
    await missing.check();
    expect(win.activeTab?.id).toBe('w');
    win.windowedConflictCancel();
    await vi.waitFor(() => expect(win.activeTab?.id).toBe('a'));
  });

  it('moves there when the range box conflict is dismissed', async () => {
    const viewer = clean('v', '/p/big.log', 0);
    viewer.large = { size: 100 };
    open([viewer, dirty('a', '/p/a.txt', 'A', 1)], 'v');
    await win.openRangeBox(tab('v'), {
      startByte: 0,
      endByte: 8,
      startLine: 1,
      endLine: 2,
    });
    win.rangeBox = { ...win.rangeBox!, conflict: true };
    gone.add('/p/a.txt');
    await missing.check();
    expect(win.activeTab?.id).toBe('v');
    win.rangeConflictCancel();
    await vi.waitFor(() => expect(win.activeTab?.id).toBe('a'));
  });

  it('moves there when the close confirmation of another tab is cancelled', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('b', '/p/b.txt', 'B', 1)], 'b');
    missing.requestClose();
    gone.add('/p/a.txt');
    await missing.check();
    expect(win.activeTab?.id).toBe('b');
    missing.cancelClose();
    await vi.waitFor(() => expect(win.activeTab?.id).toBe('a'));
  });

  it('moves to the next tab once the first is dealt with', async () => {
    open(
      [
        dirty('a', '/p/a.txt', 'A', 0),
        dirty('b', '/p/b.txt', 'B', 1),
        dirty('c', '/p/c.txt', 'C', 2),
      ],
      'a',
    );
    gone.add('/p/a.txt');
    gone.add('/p/c.txt');
    await missing.check();
    await missing.discard();
    expect(missing.current()?.tabId).toBe('c');
    expect(win.activeTab?.id).toBe('c');
  });

  it('returns after a file is opened while the dialog is up', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('c', '/p/c.txt', 'C', 1)], 'c');
    gone.add('/p/a.txt');
    await missing.check();
    expect(win.activeTab?.id).toBe('a');
    vi.spyOn(win, 'openTab').mockImplementation(async () => {
      win.tabs.push(clean('n', '/p/n.txt', 2));
      await win.switchTo(2);
    });
    await missing.openFile('/p/n.txt');
    expect(ids()).toEqual(['a', 'c', 'n']);
    expect(win.activeTab?.id).toBe('a');
  });

  it('stays on the opened file when no dialog is up', async () => {
    open([clean('c', '/p/c.txt', 0)], 'c');
    vi.spyOn(win, 'openTab').mockImplementation(async () => {
      win.tabs.push(clean('n', '/p/n.txt', 1));
      await win.switchTo(1);
    });
    await missing.openFile('/p/n.txt');
    expect(win.activeTab?.id).toBe('n');
  });
});

describe('the close gate answered while a tab waits', () => {
  function oversized(id: string, path: string, index: number): DocTab {
    const huge = dirty(id, path, '', index);
    huge.content = Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]);
    return huge;
  }

  it('discards only the tab the gate is about, and leaves the missing one alone', async () => {
    open([oversized('x', '/p/x.txt', 0), dirty('a', '/p/a.txt', 'A', 1)], 'x');
    await gate.onFlushRequest();
    expect(gate.visible).toBe(true);
    gone.add('/p/a.txt');
    await missing.check();
    expect(missing.current()).toBeNull();
    await gate.discard();
    expect(win.isDirty(tab('x'))).toBe(false);
    expect(win.isDirty(tab('a'))).toBe(true);
    expect(tab('a').missing).toBe(true);
    expect(ids()).toEqual(['x', 'a']);
    expect(calls('delete_note')).toEqual([]);
    expect(calls('write_file_encoded')).toEqual([]);
  });

  it('goes to the missing tab when the gate closes a tab', async () => {
    const viewer = clean('v', '/p/big.log', 2);
    viewer.large = { size: 100 };
    open(
      [dirty('a', '/p/a.txt', 'A', 0), dirty('c', '/p/c.txt', 'C', 1), viewer],
      'v',
    );
    await win.openRangeBox(tab('v'), {
      startByte: 0,
      endByte: 8,
      startLine: 1,
      endLine: 2,
    });
    win.rangeBoxEdited(Text.of(['one', 'two', 'three']));
    missing.requestClose();
    await vi.waitFor(() => expect(gate.visible).toBe(true));
    gone.add('/p/a.txt');
    await missing.check();
    expect(win.activeTab?.id).toBe('v');
    await gate.discard();
    expect(ids()).toEqual(['a', 'c']);
    await vi.waitFor(() => expect(win.activeTab?.id).toBe('a'));
  });
});

describe('a quit or close held back behind the dialog of the last tab', () => {
  async function lastTabGone(): Promise<void> {
    const huge = dirty('x', '/p/x.txt', '', 0);
    huge.content = Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]);
    open([huge], 'x');
    gone.add('/p/x.txt');
    await missing.check();
    expect(missing.current()?.tabId).toBe('x');
  }

  it('goes on to the quit when that tab is discarded, without destroying the window first', async () => {
    await lastTabGone();
    await gate.onFlushRequest();
    expect(sent()).not.toContain('request_exit');
    await missing.discard();
    expect(ids()).toEqual([]);
    expect(destroyed).toBe(false);
    expect(sent()).toContain('request_exit');
  });

  it('goes on to the window close the same way', async () => {
    await lastTabGone();
    await gate.onCloseFlushRequest();
    expect(host.finishWindowClose).not.toHaveBeenCalled();
    await missing.discard();
    expect(destroyed).toBe(false);
    expect(host.finishWindowClose).toHaveBeenCalledTimes(1);
  });

  it('closes the window once when the quit it was kept for is vetoed', async () => {
    await lastTabGone();
    await gate.onFlushRequest();
    await missing.discard();
    expect(destroyed).toBe(false);
    // Another window vetoes the quit: the empty window must not stay behind.
    gate.onFlushCancelled();
    await vi.waitFor(() => expect(destroyed).toBe(true));
    gate.onFlushCancelled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroyCalls).toBe(1);
    expect(win.tabs).toHaveLength(0);
  });

  it('closes the window when the gate of this window is cancelled', async () => {
    await lastTabGone();
    await gate.onFlushRequest();
    await missing.discard();
    expect(destroyed).toBe(false);
    gate.cancel();
    await vi.waitFor(() => expect(destroyed).toBe(true));
    expect(destroyCalls).toBe(1);
  });

  it('keeps the window while the quit goes through, and when it got a tab since', async () => {
    await lastTabGone();
    await gate.onFlushRequest();
    await missing.discard();
    expect(sent()).toContain('request_exit');
    expect(destroyCalls).toBe(0);
    // A tab opened meanwhile is a reason to keep the window after a veto.
    win.tabs.push(clean('n', '/p/n.txt', 1));
    gate.onFlushCancelled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroyCalls).toBe(0);
  });

  it('does nothing about a veto when no window was kept', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    gate.onFlushCancelled();
    gate.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroyCalls).toBe(0);
  });

  it('closes the window with its last tab when nothing was held back', async () => {
    await lastTabGone();
    await missing.discard();
    expect(destroyed).toBe(true);
    expect(sent()).not.toContain('request_exit');
  });
});
