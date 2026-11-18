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
import {
  MissingFiles,
  sameTabStillActive,
  type MissingHost,
} from './missingFiles.svelte';
import { editionState } from './edition.svelte';
import { settingsState } from './settings.svelte';
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
      case 'tab_transfer_settle_window':
        return Promise.resolve([]);
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
    order: index,
  };
}

function clean(id: string, path: string, index = 0): DocTab {
  const content = Text.of(['same']);
  return { ...dirty(id, path, 'same', index), content, savedContent: content };
}

let win: DocumentWindowState;
let host: GateHost &
  MissingHost & {
    finishWindowClose: ReturnType<typeof vi.fn>;
    closeEmptyWindow: ReturnType<typeof vi.fn<() => Promise<void>>>;
    finishTabClose: ReturnType<
      typeof vi.fn<(tab: DocTab, keepWindow?: boolean) => Promise<void>>
    >;
    focusWindow: ReturnType<typeof vi.fn>;
  };
let gate: CloseGate;
let missing: MissingFiles;
/** Whether a dialog the host reports (not one of the module's own) is up. */
let dialogUp: boolean;
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
  dialogUp = false;
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
    // What the window does: close the tab, and the window with its last tab
    // unless a quit or close is about to take over.
    finishTabClose: vi.fn(async (closing: DocTab, keepWindow?: boolean) => {
      await win.deleteTab(win.tabs.indexOf(closing));
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
    promptRefused: () => missing.otherDialogUp(),
    dialogOpen: () => dialogUp,
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
    missing.requestClose(win.activeTab!);
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

describe('closing a windowed tab that still has input on its way', () => {
  /** A windowed tab whose Rust buffer is `dirty`. */
  function windowedTab(id: string, isDirty: boolean): DocTab {
    const tab = clean(id, `/p/${id}.log`);
    tab.windowed = {
      sessionId: 7,
      totalBytes: 1,
      totalLines: 1,
      fingerprint: null,
      dirty: isDirty,
      topLine: 0,
    };
    return tab;
  }

  it('waits for the input to land, then asks about the tab the input made dirty', async () => {
    const w = windowedTab('w', false);
    open([w], 'w');
    let landed: () => void = () => {};
    win.windowedPending = () => true;
    win.endComposition = () =>
      new Promise<void>((resolve) => {
        landed = () => {
          // The text reaches the core: the tab is dirty now.
          w.windowed!.dirty = true;
          resolve();
        };
      });
    missing.requestClose(win.activeTab!);
    expect(host.finishTabClose).not.toHaveBeenCalled();
    expect(missing.confirmClose).toBe(false);
    landed();
    await Promise.resolve();
    await Promise.resolve();
    expect(missing.confirmClose).toBe(true);
    expect(host.finishTabClose).not.toHaveBeenCalled();
  });

  it('does nothing twice for a repeated close while it waits', async () => {
    open([windowedTab('w', false)], 'w');
    let landed: () => void = () => {};
    const end = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          landed = resolve;
        }),
    );
    win.windowedPending = () => true;
    win.endComposition = end;
    missing.requestClose(win.activeTab!);
    missing.requestClose(win.activeTab!);
    expect(end).toHaveBeenCalledTimes(1);
    landed();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
  });

  it('stops when the active tab is another one by the time the input has landed', async () => {
    open([windowedTab('w', false), clean('c', '/p/c.txt', 1)], 'w');
    let landed: () => void = () => {};
    win.windowedPending = () => true;
    win.endComposition = () =>
      new Promise<void>((resolve) => {
        landed = resolve;
      });
    missing.requestClose(win.activeTab!);
    win.activeIndex = 1;
    landed();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.finishTabClose).not.toHaveBeenCalled();
    expect(missing.confirmClose).toBe(false);
  });

  it('still closes its tab when a reorder moved it while the input landed', async () => {
    open([windowedTab('w', false), clean('c', '/p/c.txt', 1)], 'w');
    let landed: () => void = () => {};
    win.windowedPending = () => true;
    win.endComposition = () =>
      new Promise<void>((resolve) => {
        landed = () => {
          // The input is in the core: nothing is pending any more.
          win.windowedPending = () => false;
          resolve();
        };
      });
    missing.requestClose(win.activeTab!);
    await win.moveTab(tab('w'), 1);
    expect(ids()).toEqual(['c', 'w']);
    landed();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
    // The tab asked about went, from its new place.
    expect(ids()).toEqual(['c']);
  });

  it('stays synchronous with no input pending', () => {
    open([windowedTab('w', false)], 'w');
    win.windowedPending = () => false;
    win.endComposition = vi.fn(() => Promise.resolve());
    missing.requestClose(win.activeTab!);
    expect(win.endComposition).not.toHaveBeenCalled();
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
  });
});

describe('closing a tab', () => {
  it('asks first when the tab has changes', () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    missing.requestClose(win.activeTab!);
    expect(missing.confirmClose).toBe(true);
    expect(host.finishTabClose).not.toHaveBeenCalled();
  });

  it('does nothing for a tab that is not the active one any more', async () => {
    open([clean('a', '/p/a.txt', 0), clean('b', '/p/b.txt', 1)], 'a');
    const second = tab('b');
    missing.requestClose(second);
    expect(host.finishTabClose).not.toHaveBeenCalled();
    // Moved, the active tab is still the one it asks about.
    await win.moveTab(tab('a'), 1);
    missing.requestClose(win.activeTab!);
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
    expect(win.activeTab?.id).toBe('a');
  });

  it('closes a clean tab at once', () => {
    open([clean('a', '/p/a.txt')], 'a');
    missing.requestClose(win.activeTab!);
    expect(missing.confirmClose).toBe(false);
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
  });

  it('closes without saving on 不儲存 and keeps the tab on cancel', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    missing.requestClose(win.activeTab!);
    missing.cancelClose();
    expect(missing.confirmClose).toBe(false);
    expect(ids()).toEqual(['a']);
    missing.requestClose(win.activeTab!);
    await missing.confirmDiscard();
    expect(ids()).toEqual([]);
    expect(calls('write_file_encoded')).toEqual([]);
  });

  it('saves on 儲存 and then closes, keeping the dialog when the save is cancelled', async () => {
    open([dirty('a', '', 'A')], 'a');
    missing.requestClose(win.activeTab!);
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
  /** Every `write_file_encoded` waits; `disk` is what the last released one wrote. */
  function holdWrites(): {
    pending: { content: string; release: () => void; fail: () => void }[];
    disk: () => string | null;
  } {
    const pending: {
      content: string;
      release: () => void;
      fail: () => void;
    }[] = [];
    let disk: string | null = null;
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation(((cmd: string, args?: unknown) => {
      if (cmd !== 'write_file_encoded') {
        return base(cmd, args as Record<string, unknown> | undefined);
      }
      const content = (args as { content: string }).content;
      return new Promise<null>((resolve, reject) => {
        pending.push({
          content,
          release: () => {
            disk = content;
            resolve(null);
          },
          fail: () => reject(new Error('disk full')),
        });
      });
    }) as typeof invoke);
    return { pending, disk: () => disk };
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('saves again what was typed during the write, and closes once a write finds nothing new', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    missing.requestClose(win.activeTab!);
    const writes = holdWrites();
    const saving = missing.confirmSave();
    await settle();
    win.updateContentById('a', Text.of(['AB']));
    writes.pending[0]!.release();
    await settle();
    expect(writes.pending).toHaveLength(2);
    expect(writes.pending[1]!.content).toBe('AB');
    expect(ids()).toEqual(['a']);
    expect(host.finishTabClose).not.toHaveBeenCalled();
    writes.pending[1]!.release();
    await saving;
    expect(writes.pending).toHaveLength(2);
    expect(writes.disk()).toBe('AB');
    expect(missing.confirmClose).toBe(false);
    expect(ids()).toEqual([]);
  });

  it('closes the asked tab when the window moved to another tab during the write', async () => {
    open([dirty('a', '/p/a.txt', 'A'), dirty('b', '/p/b.txt', 'B', 1)], 'a');
    const a = tab('a');
    missing.requestClose(win.activeTab!);
    const writes = holdWrites();
    const saving = missing.confirmSave();
    await settle();
    win.activeIndex = 1;
    writes.pending[0]!.release();
    await saving;
    expect(missing.confirmClose).toBe(false);
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
    expect(host.finishTabClose.mock.calls[0]![0]).toBe(a);
    expect(ids()).toEqual(['b']);
    expect(win.isDirty(tab('b'))).toBe(true);
  });

  it('keeps the tab and the dialog when the second write fails', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    missing.requestClose(win.activeTab!);
    const writes = holdWrites();
    const saving = missing.confirmSave();
    await settle();
    win.updateContentById('a', Text.of(['AB']));
    writes.pending[0]!.release();
    await settle();
    writes.pending[1]!.fail();
    await saving;
    expect(win.saveFailed?.path).toBe('/p/a.txt');
    expect(missing.confirmClose).toBe(true);
    expect(host.finishTabClose).not.toHaveBeenCalled();
    expect(ids()).toEqual(['a']);
  });

  it('shows the dialog of a tab whose file is gone instead of asking', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    gone.add('/p/a.txt');
    await missing.check();
    // Another dialog was holding it back, so it is not showing yet.
    missing.cancelClose();
    missing.requestClose(win.activeTab!);
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
    missing.requestClose(win.activeTab!);
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
    missing.requestClose(win.activeTab!);
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
      windowed_encoding: null,
      windowed_bom: false,
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
    missing.requestClose(win.activeTab!);
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
    missing.requestClose(win.activeTab!);
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

const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** A user's click on the tab at `index`. */
function click(index: number): Promise<void> {
  return win.switchTo(index, false, true);
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
/** A dirty tab too large to snapshot. */
function huge(id: string, path: string, index = 0): DocTab {
  return dirty(id, path, 'x'.repeat(SNAPSHOT_CONTENT_MAX + 1), index);
}
/** A clean windowed tab. */
function windowedClean(id: string, index = 0): DocTab {
  const found = clean(id, `/p/${id}.log`, index);
  found.windowed = {
    sessionId: 7,
    totalBytes: 1,
    totalLines: 1,
    fingerprint: null,
    dirty: false,
    topLine: 0,
  };
  return found;
}
/** A large-file viewer with an edit box that has changes. */
async function boxOnViewer(): Promise<void> {
  const viewer = clean('v', '/p/big.log', 0);
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

describe('sameTabStillActive', () => {
  it('is true for the same tab and for no other', () => {
    const a = clean('a', '/p/a.txt');
    expect(sameTabStillActive(a, a)).toBe(true);
    expect(sameTabStillActive(a, clean('a', '/p/a.txt'))).toBe(false);
    expect(sameTabStillActive(a, null)).toBe(false);
    expect(sameTabStillActive(null, null)).toBe(false);
    expect(sameTabStillActive(undefined, null)).toBe(false);
  });
});

describe('the close confirmation belongs to the tab it asks about', () => {
  it('keeps the tab and the text typed while the last record is deleted', async () => {
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    missing.requestClose(win.activeTab!);
    const release = holdCommand('delete_note');
    const saving = missing.confirmSave();
    await wait();
    expect(calls('write_file_encoded')).toHaveLength(1);
    win.updateContentById('a', Text.of(['AB']));
    release();
    await saving;

    expect(ids()).toEqual(['a']);
    expect(tab('a').content.toString()).toBe('AB');
    expect(missing.confirmClose).toBe(false);
    await win.flushAll();
  });

  it('opens a file behind it without leaving the tab, and the window survives 不儲存', async () => {
    answers['list_notes'] = [];
    answers['live_doc_groups'] = [];
    answers['stat_file'] = { size: 10 };
    answers['path_writable'] = true;
    answers['read_file_auto'] = {
      content: 'new',
      encoding: 'UTF-8',
      had_bom: false,
      lossy: false,
    };
    await settingsState.init().catch(() => {});
    await win.init('g', null, null);
    open([dirty('a', '/p/a.txt', 'A')], 'a');
    missing.requestClose(win.activeTab!);
    expect(win.holdActive?.()).toBe(true);
    await win.openTab('/p/n.txt');
    expect(win.activeTab?.id).toBe('a');
    expect(win.tabs).toHaveLength(2);

    await missing.confirmDiscard();
    expect(win.tabs).toHaveLength(1);
    expect(win.tabs[0]!.path).toBe('/p/n.txt');
    expect(host.closeEmptyWindow).not.toHaveBeenCalled();
    expect(destroyed).toBe(false);
  });
});

describe('closing a tab by its own button', () => {
  it('closes the tab clicked when the switch to it ends undisturbed', async () => {
    open(
      [
        clean('t0', '/p/0.txt', 0),
        clean('t1', '/p/1.txt', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    await missing.requestCloseAt(1);
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['t0', 't2']);
  });

  it('closes the tab clicked and ends on the tab clicked after it while the switch waited for the write', async () => {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        clean('t1', '/p/1.txt', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    win.updateActiveContent(Text.of(['changed']));
    const release = holdCommand('upsert_note');
    const closing = missing.requestCloseAt(1);
    const other = click(2);
    await wait();
    release();
    await closing;
    await other;

    expect(win.activeTab?.id).toBe('t2');
    expect(ids()).toEqual(['t0', 't2']);
    expect(calls('delete_note')).toEqual([{ id: 't1' }]);
  });

  it('closes the tab clicked and ends on the other tab when its switch gave up', async () => {
    open(
      [
        clean('t0', '/p/0.txt', 0),
        clean('t1', '/p/1.txt', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    // One promise for every switch waiting on the composition.
    let finish: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    win.endComposition = () => ended;
    const closing = missing.requestCloseAt(1);
    const other = click(2);
    finish();
    await closing;
    await other;

    expect(win.activeTab?.id).toBe('t2');
    expect(ids()).toEqual(['t0', 't2']);
    expect(calls('delete_note')).toEqual([{ id: 't1' }]);
    win.endComposition = null;
  });
});

describe('what locks the tabs', () => {
  it('locks navigation for the confirmation, the gate and a dialog of the window, each alone', () => {
    open([clean('a', '/p/a.txt')], 'a');
    expect(missing.navigationLocked()).toBe(false);
    missing.confirmClose = true;
    expect(missing.navigationLocked()).toBe(true);
    missing.confirmClose = false;
    gate.visible = true;
    expect(missing.navigationLocked()).toBe(true);
    gate.visible = false;
    dialogUp = true;
    expect(missing.navigationLocked()).toBe(true);
    dialogUp = false;
    expect(missing.navigationLocked()).toBe(false);
    expect(missing.tabsLocked()).toBe(false);
  });

  it('keeps the tabs of an open edit box locked, though ⌘W still works', async () => {
    await boxOnViewer();
    expect(missing.navigationLocked()).toBe(false);
    expect(missing.tabsLocked()).toBe(true);
    expect(win.holdActive?.()).toBe(true);
    missing.requestClose(win.activeTab!);
    await wait();
    expect(gate.visible).toBe(true);
    expect(gate.reason).toBe('rangeBox');
  });

  it.each([
    ['the close confirmation', () => (missing.confirmClose = true)],
    ['the gate', () => (gate.visible = true)],
  ])('does not close the active tab while %s is up', (_name, raise) => {
    open([clean('a', '/p/a.txt')], 'a');
    raise();
    missing.requestClose(win.activeTab!);
    expect(host.finishTabClose).not.toHaveBeenCalled();
  });

  it('asks nothing of the edit box while a dialog of the window is up', async () => {
    await boxOnViewer();
    dialogUp = true;
    missing.requestClose(win.activeTab!);
    await wait();
    expect(gate.visible).toBe(false);
  });

  it('closes tabs as before with only an error banner showing (no dialog)', async () => {
    open([clean('a', '/p/a.txt', 0), clean('b', '/p/b.txt', 1)], 'a');
    missing.requestClose(win.activeTab!);
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
    await wait();
    expect(ids()).toEqual(['b']);
    await missing.requestCloseAt(0);
    expect(ids()).toEqual([]);
  });

  it.each([
    [
      'a dialog is up',
      async (): Promise<void> => {
        dialogUp = true;
      },
    ],
    ['the edit box is open', boxOnViewer],
  ])(
    'does not switch or close by a close button when %s',
    async (_name, raise) => {
      open([clean('a', '/p/a.txt', 0), clean('b', '/p/b.txt', 1)], 'a');
      await raise();
      const before = ids();
      await missing.requestCloseAt(1);
      expect(win.activeTab?.id).toBe(before[0]);
      expect(ids()).toEqual(before);
      expect(host.finishTabClose).not.toHaveBeenCalled();
    },
  );
});

describe('a quit or close does not raise its question over another dialog', () => {
  const raisers: [string, () => void][] = [
    [
      'the close confirmation',
      () => {
        missing.requestClose(win.activeTab!);
        expect(missing.confirmClose).toBe(true);
      },
    ],
    [
      'a dialog of the window',
      () => {
        dialogUp = true;
      },
    ],
  ];
  let vetoed: ReturnType<typeof vi.fn<() => void>>;

  function watchVeto(): void {
    vetoed = vi.fn<() => void>();
    const keepEmpty = gate.onVetoed;
    gate.onVetoed = () => {
      vetoed();
      keepEmpty?.();
    };
  }

  describe.each(raisers)('with %s up', (_name, raise) => {
    beforeEach(() => {
      open([dirty('a', '/p/a.txt', 'A', 0), huge('x', '/p/x.txt', 1)], 'a');
      raise();
      watchVeto();
    });

    it('calls a quit off at once and stays on the tab', async () => {
      await gate.onFlushRequest();
      expect(win.activeTab?.id).toBe('a');
      expect(gate.visible).toBe(false);
      expect(gate.held).toBe(false);
      expect(calls('flush_cancel')).toHaveLength(1);
      expect(vetoed).toHaveBeenCalledTimes(1);
      expect(sent()).not.toContain('request_exit');
    });

    it('calls a window close off and stays on the tab', async () => {
      await gate.onCloseFlushRequest();
      expect(win.activeTab?.id).toBe('a');
      expect(gate.visible).toBe(false);
      expect(gate.held).toBe(false);
      expect(vetoed).toHaveBeenCalledTimes(1);
      expect(host.finishWindowClose).not.toHaveBeenCalled();
    });
  });

  it('calls the quit off for good when a dialog came up during the save, even after it is gone', async () => {
    open([huge('x', '/p/x.txt')], 'x');
    await gate.onFlushRequest();
    expect(gate.visible).toBe(true);
    const release = holdCommand('write_file_encoded');
    const saving = gate.save();
    await wait();
    dialogUp = true;
    release();
    await saving;

    expect(gate.visible).toBe(false);
    expect(gate.held).toBe(false);
    dialogUp = false;
    await wait();
    expect(sent()).not.toContain('request_exit');
  });

  it('calls off a quit whose input arrived late, even when nothing is left to ask', async () => {
    open([clean('c', '/p/c.txt')], 'c');
    dialogUp = true;
    win.windowedPending = () => true;
    win.endComposition = () => Promise.resolve();
    const quitting = gate.onFlushRequest();
    await wait();
    gate.onFlushCancelled();
    await quitting;

    expect(calls('flush_cancel')).toHaveLength(1);
    expect(sent()).not.toContain('request_exit');
    win.windowedPending = null;
    win.endComposition = null;
  });

  it('still waits behind the dialog of a tab whose file is gone', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), huge('x', '/p/x.txt', 1)], 'a');
    gone.add('/p/a.txt');
    await missing.check();
    expect(missing.current()?.tabId).toBe('a');
    await gate.onFlushRequest();
    expect(gate.held).toBe(true);
    expect(gate.visible).toBe(false);
  });

  describe('a quit held behind the dialog of a missing file', () => {
    async function heldQuit(tabs: DocTab[]): Promise<void> {
      open(tabs, 'a');
      gone.add('/p/a.txt');
      await missing.check();
      win.windowedPending = () => true;
      win.endComposition = () => Promise.resolve();
      const quitting = gate.onFlushRequest();
      await wait();
      gate.onFlushCancelled();
      await quitting;
      win.windowedPending = null;
      win.endComposition = null;
      expect(gate.held).toBe(true);
      watchVeto();
    }

    it('is called off when a dialog is up as the dialog is answered, and an emptied window closes', async () => {
      await heldQuit([dirty('a', '/p/a.txt', 'A')]);
      dialogUp = true;
      await missing.discard();
      await wait();

      expect(gate.held).toBe(false);
      expect(sent()).not.toContain('request_exit');
      expect(host.finishWindowClose).not.toHaveBeenCalled();
      expect(vetoed).toHaveBeenCalledTimes(1);
      expect(host.closeEmptyWindow).toHaveBeenCalledTimes(1);
    });

    it('leaves the window open when it still has tabs', async () => {
      await heldQuit([
        dirty('a', '/p/a.txt', 'A', 0),
        clean('c', '/p/c.txt', 1),
      ]);
      dialogUp = true;
      await missing.discard();
      await wait();

      expect(gate.held).toBe(false);
      expect(sent()).not.toContain('request_exit');
      expect(vetoed).toHaveBeenCalledTimes(1);
      expect(host.closeEmptyWindow).not.toHaveBeenCalled();
    });
  });
});

describe('looking for missing files while a dialog is up', () => {
  it('does not look at all', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('b', '/p/b.txt', 'B', 1)], 'b');
    gone.add('/p/a.txt');
    dialogUp = true;
    await missing.check();

    expect(calls('missing_paths')).toEqual([]);
    expect(win.activeTab?.id).toBe('b');
    expect(tab('a').missing).not.toBe(true);
  });

  it('marks nothing when a dialog came up while it asked, and looks again later', async () => {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('b', '/p/b.txt', 'B', 1)], 'b');
    gone.add('/p/a.txt');
    let release: () => void = () => {};
    holdAnswer = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checking = missing.check();
    dialogUp = true;
    release();
    await checking;

    expect(calls('missing_paths')).toHaveLength(1);
    expect(tab('a').missing).not.toBe(true);
    expect(win.activeTab?.id).toBe('b');

    dialogUp = false;
    holdAnswer = null;
    await missing.check();
    expect(tab('a').missing).toBe(true);
    expect(win.activeTab?.id).toBe('a');
  });

  it('goes on to the next tab of the queue after an answer, whatever dialog is up', async () => {
    open(
      [
        dirty('a', '/p/a.txt', 'A', 0),
        dirty('b', '/p/b.txt', 'B', 1),
        clean('c', '/p/c.txt', 2),
      ],
      'c',
    );
    gone.add('/p/a.txt');
    gone.add('/p/b.txt');
    await missing.check();
    expect(win.activeTab?.id).toBe('a');
    dialogUp = true;
    await missing.discard();
    expect(win.activeTab?.id).toBe('b');
  });
});

describe('a close that waited for typed input', () => {
  it.each([
    [
      'the close confirmation',
      () => {
        missing.confirmClose = true;
      },
      true,
    ],
    [
      'a dialog of the window',
      () => {
        dialogUp = true;
      },
      false,
    ],
  ])('stops when %s came up meanwhile', async (_name, raise, confirming) => {
    open([windowedClean('w')], 'w');
    let landed: () => void = () => {};
    win.windowedPending = () => true;
    win.endComposition = () =>
      new Promise<void>((resolve) => {
        landed = resolve;
      });
    missing.requestClose(win.activeTab!);
    raise();
    landed();
    await wait();

    expect(host.finishTabClose).not.toHaveBeenCalled();
    expect(missing.confirmClose).toBe(confirming);
    win.windowedPending = null;
    win.endComposition = null;
  });
});

describe('the close confirmation is about the tab it was asked for', () => {
  /** Two tabs with changes; closing the first raises the confirmation. */
  async function confirming(): Promise<void> {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('b', '/p/b.txt', 'B', 1)], 'a');
    missing.requestClose(win.activeTab!);
    expect(missing.confirmClose).toBe(true);
    // The user clicks another tab while it is up.
    win.activeIndex = 1;
  }

  it('closes the tab it was asked for, and only that one, on 不儲存', async () => {
    await confirming();
    await missing.confirmDiscard();
    expect(host.finishTabClose).toHaveBeenCalledTimes(1);
    expect(host.finishTabClose.mock.calls[0]![0].id).toBe('a');
    expect(ids()).toEqual(['b']);
    expect(missing.confirmClose).toBe(false);
  });

  it('saves the tab it was asked for, and closes only that one, on 儲存', async () => {
    await confirming();
    const saved = vi.spyOn(win, 'saveTab');
    mockSave.mockResolvedValue('/p/a.txt');
    await missing.confirmSave();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0]![0].id).toBe('a');
    expect(host.finishTabClose.mock.calls[0]![0].id).toBe('a');
    expect(ids()).toEqual(['b']);
  });

  it('closes nothing on 取消, and a later confirmation is about its own tab', async () => {
    await confirming();
    missing.cancelClose();
    expect(host.finishTabClose).not.toHaveBeenCalled();
    win.activeIndex = 1;
    missing.requestClose(win.activeTab!);
    await missing.confirmDiscard();
    expect(host.finishTabClose.mock.calls[0]![0].id).toBe('b');
  });
});

describe('closing a tab that is on its way to another window', () => {
  /** The cancel of the move waits for the returned function. */
  function parkCancel(answer: 'cancelled' | 'accepted'): () => void {
    let open: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      open = resolve;
    });
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation(((cmd: string, args?: unknown) =>
      cmd === 'tab_transfer_cancel'
        ? parked.then(() => answer)
        : base(cmd, args as never)) as typeof invoke);
    return open;
  }
  /** `b` is frozen and on its way as transfer 7, `a` is shown. */
  async function onItsWay(): Promise<DocTab> {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('b', '/p/b.txt', 'B', 1)], 'a');
    win.dragHost = {
      navigationLocked: () => false,
      gateVisible: () => false,
      modalOpen: () => false,
      closing: () => false,
      quitting: () => false,
    };
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
    win.transferListening = true;
    answers.tab_drop_target = {
      kind: 'doc',
      label: 'doc-x',
      offset: { x: 1, y: 1 },
    };
    answers.tab_transfer_begin = { kind: 'started', t: 7 };
    await win.releaseTab(tab('b'), {
      x: 1,
      y: 1,
      dpr: 1,
      slot: 1,
      overBar: false,
    });
    expect(tab('b').transferring).toBe(true);
    win.activeIndex = 1;
    return tab('b');
  }

  it('raises no confirmation before the move is called off, then asks as for any tab', async () => {
    const b = await onItsWay();
    const release = parkCancel('cancelled');
    missing.requestClose(b);
    await Promise.resolve();
    expect(missing.confirmClose).toBe(false);
    expect(host.finishTabClose).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(missing.confirmClose).toBe(true));
    expect(b.transferring).toBeUndefined();
    expect(ids()).toEqual(['a', 'b']);
  });

  it('asks nothing and deletes nothing when the tab had already landed', async () => {
    const b = await onItsWay();
    const release = parkCancel('accepted');
    missing.requestClose(b);
    release();
    await vi.waitFor(() => expect(ids()).toEqual(['a']));
    expect(missing.confirmClose).toBe(false);
    expect(host.finishTabClose).not.toHaveBeenCalled();
    expect(calls('delete_note')).toEqual([]);
  });

  it("does not run today's close on a transferring tab at once", async () => {
    const b = await onItsWay();
    parkCancel('cancelled');
    missing.requestClose(b);
    expect(host.finishTabClose).not.toHaveBeenCalled();
    expect(missing.confirmClose).toBe(false);
    expect(b.transferring).toBe(true);
  });
});

describe('the dialog of a tab that is on its way', () => {
  /** `a` is gone and queued; `c` is active. */
  async function queued(): Promise<void> {
    open([dirty('a', '/p/a.txt', 'A', 0), dirty('c', '/p/c.txt', 'C', 1)], 'c');
    gone.add('/p/a.txt');
    await missing.check();
    expect(missing.current()?.tabId).toBe('a');
  }

  it('is not shown while the tab is frozen, and shows again after a cancel', async () => {
    await queued();
    tab('a').transferring = true;
    expect(missing.current()).toBeNull();
    expect(missing.pending()).toEqual([]);
    expect(missing.navigationLocked()).toBe(false);
    delete tab('a').transferring;
    expect(missing.current()?.tabId).toBe('a');
    expect(missing.pending()).toHaveLength(1);
  });

  it('stays in the queue through a check', async () => {
    await queued();
    tab('a').transferring = true;
    await missing.check();
    delete tab('a').transferring;
    expect(missing.current()?.tabId).toBe('a');
  });

  it('goes with the release of the tab', async () => {
    await queued();
    tab('a').transferring = true;
    await missing.check();
    win.tabs.splice(0, 1);
    await missing.check();
    expect(missing.current()).toBeNull();
    expect(missing.pending()).toEqual([]);
  });

  it('does not hold a quit or close back while the tab is away', async () => {
    await queued();
    tab('a').transferring = true;
    expect(host.promptBlocked?.()).toBe(false);
  });
});

describe('a tab that arrived marked as missing', () => {
  it('joins the queue and asks the question in this window too', async () => {
    open([clean('c', '/p/c.txt', 0)], 'c');
    const arrived = dirty('m', '/p/m.txt', 'M', 1);
    arrived.missing = true;
    win.tabs.push(arrived);
    missing.enqueue(arrived);
    expect(missing.current()?.tabId).toBe('m');
    // Once.
    missing.enqueue(arrived);
    expect(missing.pending()).toHaveLength(1);
  });

  it('does not queue a tab that is not marked', async () => {
    open([clean('c', '/p/c.txt', 0)], 'c');
    const plain = dirty('m', '/p/m.txt', 'M', 1);
    win.tabs.push(plain);
    missing.enqueue(plain);
    expect(missing.current()).toBeNull();
  });
});

describe('close buttons and tab clicks while a write holds the switches', () => {
  const until = (done: () => boolean): Promise<void> =>
    vi.waitFor(() => expect(done()).toBe(true));
  /** The tab at the active place after every write of `activeIndex`. */
  function recordActive(onWrite?: (id: string | undefined) => void): string[] {
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
        onWrite?.(win.activeTab?.id);
      },
    });
    return seen;
  }
  /** Holds `upsert_note`, then writes the active tab: the write is out. */
  async function holdWrite(): Promise<() => void> {
    const release = holdCommand('upsert_note');
    win.updateActiveContent(Text.of(['changed']));
    void win.flushAll();
    await wait();
    expect(win.writesPending).toBeGreaterThan(0);
    return release;
  }
  /** The write of a tab's file waits, and fails when told to. */
  function holdFailingWrite(): { fail: () => void } {
    let fail: () => void = () => {};
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation(((cmd: string, args?: unknown) =>
      cmd === 'write_file_encoded'
        ? new Promise<null>((_resolve, reject) => {
            fail = () => reject(new Error('disk full'));
          })
        : base(cmd, args as never)) as typeof invoke);
    return { fail: () => fail() };
  }
  /** `delete_note` of the tab `id` rejects with `error`. */
  function failDelete(id: string, error: Error): void {
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation(((cmd: string, args?: unknown) =>
      cmd === 'delete_note' && (args as { id: string }).id === id
        ? Promise.reject(error)
        : base(cmd, args as never)) as typeof invoke);
  }
  /** t0 clean, t1 and t2 with changes and t2 active, a write held. */
  async function askingSetup(): Promise<() => void> {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        dirty('t1', '/p/1.txt', 'one', 1),
        dirty('t2', '/p/2.txt', 'two', 2),
      ],
      't2',
    );
    return holdWrite();
  }
  /** t1 is asked about on its own tab, t0 was the last tab clicked. */
  async function askedWhileT0Clicked(): Promise<void> {
    const release = await askingSetup();
    void missing.requestCloseAt(1);
    void click(0);
    release();
    await until(() => missing.confirmClose && win.activeTab?.id === 't1');
  }

  it('ends on the last tab clicked while a write held the switches', async () => {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        clean('t1', '/p/1.txt', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    const release = await holdWrite();
    const first = click(1);
    const second = click(2);
    release();
    await first;
    await second;

    expect(win.activeTab?.id).toBe('t2');
    expect(ids()).toEqual(['t0', 't1', 't2']);
  });

  it('a click on the active tab is the last tab clicked', async () => {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        clean('t1', '/p/1.txt', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    const release = await holdWrite();
    const first = click(1);
    const second = click(0);
    release();
    await first;
    await second;

    expect(win.activeTab?.id).toBe('t0');
  });

  it('a click on the active tab before a close keeps the window there', async () => {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        clean('t1', '/p/1.txt', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    const release = await holdWrite();
    const seen = recordActive();
    const clicking = click(0);
    const closing = missing.requestCloseAt(2);
    release();
    await clicking;
    await closing;

    expect(ids()).toEqual(['t0', 't1']);
    expect(win.activeTab?.id).toBe('t0');
    expect(seen).not.toContain('t2');
  });

  it('closes the tab clicked before, and ends on the tab clicked after', async () => {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        clean('t1', '/p/1.txt', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    const release = await holdWrite();
    const seen = recordActive();
    const closing = missing.requestCloseAt(1);
    const clicking = click(2);
    release();
    await closing;
    await clicking;

    expect(ids()).toEqual(['t0', 't2']);
    expect(win.activeTab?.id).toBe('t2');
    expect(seen).not.toContain('t1');
  });

  it('closes the tab clicked after, and stays on the tab clicked before', async () => {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        clean('t1', '/p/1.txt', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    const release = await holdWrite();
    const seen = recordActive();
    const clicking = click(2);
    const closing = missing.requestCloseAt(1);
    release();
    await clicking;
    await closing;

    expect(ids()).toEqual(['t0', 't2']);
    expect(win.activeTab?.id).toBe('t2');
    expect(seen).not.toContain('t1');
  });

  it.each([['confirmDiscard'], ['confirmSave']] as const)(
    'asks on the tab it closes, then goes to the tab clicked after it (%s)',
    async (answer) => {
      await askedWhileT0Clicked();
      expect(ids()).toEqual(['t0', 't1', 't2']);

      await missing[answer]();
      await until(() => missing.closeQueueIdle);

      expect(ids()).toEqual(['t0', 't2']);
      expect(win.activeTab?.id).toBe('t0');
    },
  );

  it('a failed save inside the dialog keeps where it goes afterwards', async () => {
    await askedWhileT0Clicked();
    const writing = holdFailingWrite();
    const saving = missing.confirmSave();
    await wait();
    writing.fail();
    await saving;

    expect(missing.confirmClose).toBe(true);
    expect(win.activeTab?.id).toBe('t1');
    expect(missing.closeQueueIdle).toBe(false);
    await missing.confirmDiscard();
    await until(() => missing.closeQueueIdle);
    expect(win.activeTab?.id).toBe('t0');
  });

  it('stays on the tab it asked about when the close is cancelled', async () => {
    await askedWhileT0Clicked();
    missing.cancelClose();
    await until(() => missing.closeQueueIdle);

    expect(ids()).toEqual(['t0', 't1', 't2']);
    expect(win.activeTab?.id).toBe('t1');
  });

  it.each([['t0'], ['t2']])(
    'does not leave a dialog that came up after the answer (the file of %s is gone)',
    async (goneId) => {
      await askedWhileT0Clicked();
      gone.add(`/p/${goneId.slice(1)}.txt`);
      await missing.check();
      expect(missing.current()).toBeNull();

      await missing.confirmDiscard();
      await until(() => missing.closeQueueIdle);

      expect(missing.current()?.tabId).toBe(goneId);
      expect(win.activeTab?.id).toBe(goneId);
      expect(ids()).toEqual(['t0', 't2']);
    },
  );

  it('closes every tab whose close button was clicked in one wait', async () => {
    // Without a question.
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        clean('t1', '/p/1.txt', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    let release = await holdWrite();
    const first = missing.requestCloseAt(1);
    const second = missing.requestCloseAt(2);
    release();
    await first;
    await second;
    expect(ids()).toEqual(['t0']);

    // Each asking its own question, in click order.
    win.tabs.push(
      dirty('t1', '/p/1.txt', 'one', 1),
      dirty('t2', '/p/2.txt', 'two', 2),
    );
    release = await holdWrite();
    void missing.requestCloseAt(1);
    void missing.requestCloseAt(2);
    release();
    await until(() => missing.confirmClose && win.activeTab?.id === 't1');
    expect(ids()).toEqual(['t0', 't1', 't2']);

    await missing.confirmDiscard();
    await until(() => missing.confirmClose && win.activeTab?.id === 't2');
    expect(ids()).toEqual(['t0', 't2']);

    await missing.confirmDiscard();
    await until(() => missing.closeQueueIdle);
    expect(ids()).toEqual(['t0']);
  });

  it('a tab click during the close’s own switch does not drop the close', async () => {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        dirty('t1', '/p/1.txt', 'one', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    win.updateActiveContent(Text.of(['changed']));
    const closing = missing.requestCloseAt(1);
    const release = holdCommand('upsert_note');
    await wait();
    expect(win.pendingSwitches).toBe(1);
    const clicking = click(2);
    release();
    await clicking;
    await until(() => missing.confirmClose && win.activeTab?.id === 't1');

    await missing.confirmDiscard();
    await closing;
    expect(ids()).toEqual(['t0', 't2']);
    expect(win.activeTab?.id).toBe('t2');
  });

  it('a tab click during the close’s own switch does not drop a close that was clicked after a tab', async () => {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        dirty('t1', '/p/1.txt', 'one', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    // A write of another tab holds the switches, not the flush of every tab.
    const release = holdCommand('upsert_note');
    win.updateContentById('t1', Text.of(['one!']));
    await wait();
    expect(win.writesPending).toBe(1);
    const first = click(2);
    const closing = missing.requestCloseAt(1);
    // Where the click lands, the tab is written again and that write is held.
    let release2: () => void = () => {};
    let held = false;
    recordActive((id) => {
      if (id === 't2' && !held) {
        held = true;
        release2 = holdCommand('upsert_note');
        win.updateActiveContent(Text.of(['typed']));
      }
    });
    release();
    await first;
    await wait();
    expect(win.pendingSwitches).toBe(1);
    const second = click(0);
    release2();
    await second;
    await until(() => missing.confirmClose && win.activeTab?.id === 't1');

    await missing.confirmDiscard();
    await closing;
    expect(ids()).toEqual(['t0', 't2']);
    expect(win.activeTab?.id).toBe('t0');
  });

  describe('a deferred close that ends without closing', () => {
    /** A windowed tab whose input has not reached the core. */
    function windowedWithInput(id: string, index: number): DocTab {
      const found = clean(id, `/p/${id}.log`, index);
      found.windowed = {
        sessionId: 7,
        totalBytes: 1,
        totalLines: 1,
        fingerprint: null,
        dirty: false,
        topLine: 0,
      };
      return found;
    }

    it('does not block later closes when a click landed during the wait', async () => {
      open(
        [
          windowedWithInput('w', 0),
          clean('c', '/p/c.txt', 1),
          clean('d', '/p/d.txt', 2),
        ],
        'w',
      );
      let landed: () => void = () => {};
      let calls = 0;
      win.windowedPending = () => true;
      win.endComposition = () => {
        calls += 1;
        if (calls > 1) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          landed = () => {
            // The input is in the core: the tab has changes now.
            tab('w').windowed!.dirty = true;
            win.windowedPending = () => false;
            resolve();
          };
        });
      };
      const closing = missing.requestCloseAt(0);
      await wait();
      expect(calls).toBe(1);
      await click(1);
      expect(win.activeTab?.id).toBe('c');
      landed();
      await until(() => missing.confirmClose);
      expect(win.activeTab?.id).toBe('w');

      await missing.confirmDiscard();
      await closing;
      expect(ids()).toEqual(['c', 'd']);
      expect(win.activeTab?.id).toBe('c');

      await missing.requestCloseAt(1);
      expect(ids()).toEqual(['c']);
      expect(missing.closeQueueIdle).toBe(true);
      win.windowedPending = null;
      win.endComposition = null;
    });

    it('does not block later closes when the tab’s move completed during the wait', async () => {
      open(
        [
          clean('a', '/p/a.txt', 0),
          clean('b', '/p/b.txt', 1),
          clean('c', '/p/c.txt', 2),
        ],
        'a',
      );
      const a = tab('a');
      a.transferring = true;
      let finish: () => void = () => {};
      vi.spyOn(win, 'settleTab').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const closing = missing.requestCloseAt(0);
      await wait();
      // The move completes: the tab is in the other window.
      win.tabs.splice(0, 1);
      win.activeIndex = 0;
      finish();
      await closing;

      expect(ids()).toEqual(['b', 'c']);
      expect(missing.closeQueueIdle).toBe(true);
      await missing.requestCloseAt(1);
      expect(ids()).toEqual(['b']);
    });
  });

  describe('a switch made by a dialog is not a click', () => {
    it('the gate’s own switch while it asks about an edit box', async () => {
      const viewer = clean('A', '/p/A.log', 1);
      viewer.large = { size: 100 };
      open(
        [
          clean('t0', '/p/0.txt', 0),
          viewer,
          clean('B', '/p/B.txt', 2),
          clean('C', '/p/C.txt', 3),
          dirty('D', '/p/D.txt', 'dee', 4),
        ],
        'D',
      );
      const release = await holdWrite();
      void missing.requestCloseAt(1);
      void missing.requestCloseAt(4);
      await win.openRangeBox(tab('A'), {
        startByte: 0,
        endByte: 8,
        startLine: 1,
        endLine: 2,
      });
      win.rangeBoxEdited(Text.of(['one', 'two', 'three']));
      release();
      await until(() => gate.visible);
      expect(gate.reason).toBe('rangeBox');
      expect(win.activeTab?.id).toBe('A');

      await gate.discard();
      await until(() => missing.confirmClose);
      expect(win.activeTab?.id).toBe('D');
      expect(ids()).toEqual(['t0', 'B', 'C', 'D']);

      await missing.confirmDiscard();
      await until(() => missing.closeQueueIdle);
      expect(win.activeTab?.id).toBe('C');
    });

    it('the switches of the dialog of a missing file', async () => {
      open(
        [clean('t0', '/p/0.txt', 0), dirty('t1', '/p/1.txt', 'one', 1)],
        't0',
      );
      const samples: number[] = [];
      win.endComposition = () => {
        samples.push(win.pendingClicks);
        return Promise.resolve();
      };
      gone.add('/p/1.txt');
      const before = win.clickSeq;
      await missing.check();
      expect(win.activeTab?.id).toBe('t1');
      expect(missing.current()?.tabId).toBe('t1');
      expect(win.clickSeq).toBe(before);
      expect(win.clicksInWait).toBe(0);

      win.activeIndex = 0;
      await missing.discard();
      expect(ids()).toEqual(['t0']);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((n) => n === 0)).toBe(true);
      expect(win.clickSeq).toBe(before);
      expect(win.clicksInWait).toBe(0);
      expect(win.pendingClicks).toBe(0);
      win.endComposition = null;
    });

    it('the switch of the gate for a quit', async () => {
      open([clean('t0', '/p/0.txt', 0), huge('h', '/p/h.txt', 1)], 't0');
      const samples: number[] = [];
      win.endComposition = () => {
        samples.push(win.pendingClicks);
        return Promise.resolve();
      };
      const before = win.clickSeq;
      await gate.onFlushRequest();
      expect(gate.visible).toBe(true);
      expect(win.activeTab?.id).toBe('h');
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((n) => n === 0)).toBe(true);
      expect(win.clickSeq).toBe(before);
      expect(win.clicksInWait).toBe(0);
      expect(win.pendingClicks).toBe(0);
      win.endComposition = null;
    });
  });

  it('a queued close does not close a tab while a dialog is up', async () => {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        clean('t1', '/p/1.txt', 1),
        clean('t2', '/p/2.txt', 2),
      ],
      't0',
    );
    const release = await holdWrite();
    void missing.requestCloseAt(1);
    const clicking = click(2);
    dialogUp = true;
    release();
    await clicking;
    await until(() => missing.closeQueueIdle);

    expect(ids()).toEqual(['t0', 't1', 't2']);
    expect(calls('delete_note')).toEqual([]);
  });

  it('⌘W while a queued close asks does not end it', async () => {
    await askedWhileT0Clicked();
    missing.requestClose(tab('t1'));
    expect(missing.confirmClose).toBe(true);
    await wait();
    expect(missing.closeQueueIdle).toBe(false);

    await missing.confirmDiscard();
    await until(() => missing.closeQueueIdle);
    expect(win.activeTab?.id).toBe('t0');
  });

  it('⌘W during the question of the first of two queued closes does not end it', async () => {
    open(
      [
        dirty('t0', '/p/0.txt', 'zero', 0),
        dirty('t1', '/p/1.txt', 'one', 1),
        dirty('t2', '/p/2.txt', 'two', 2),
      ],
      't0',
    );
    const release = await holdWrite();
    void missing.requestCloseAt(1);
    void missing.requestCloseAt(2);
    release();
    await until(() => missing.confirmClose && win.activeTab?.id === 't1');
    missing.requestClose(tab('t1'));
    await wait();
    expect(missing.closeQueueIdle).toBe(false);

    await missing.confirmDiscard();
    await until(() => missing.confirmClose && win.activeTab?.id === 't2');
    await missing.confirmDiscard();
    await until(() => missing.closeQueueIdle);
    expect(ids()).toEqual(['t0']);
  });

  describe('a failed close', () => {
    const failure = new Error('delete failed');
    let logged: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      logged.mockRestore();
    });

    it('does not block later closes', async () => {
      open(
        [
          dirty('t0', '/p/0.txt', 'zero', 0),
          clean('t1', '/p/1.txt', 1),
          clean('t2', '/p/2.txt', 2),
        ],
        't0',
      );
      const release = await holdWrite();
      failDelete('t1', failure);
      const closing = missing.requestCloseAt(1);
      release();
      await closing;

      expect(logged).toHaveBeenCalledWith(expect.anything(), failure);
      expect(ids()).toEqual(['t0', 't1', 't2']);
      expect(missing.closeQueueIdle).toBe(true);
      await missing.requestCloseAt(2);
      expect(ids()).toEqual(['t0', 't1']);
    });

    it('does not drop the closes after it when a tab was clicked', async () => {
      open(
        [
          dirty('t0', '/p/0.txt', 'zero', 0),
          clean('t1', '/p/1.txt', 1),
          clean('t2', '/p/2.txt', 2),
          clean('t3', '/p/3.txt', 3),
        ],
        't0',
      );
      const release = await holdWrite();
      failDelete('t1', failure);
      const clicking = click(2);
      const first = missing.requestCloseAt(1);
      const second = missing.requestCloseAt(3);
      release();
      await clicking;
      await first;
      await second;

      expect(logged).toHaveBeenCalledWith(expect.anything(), failure);
      expect(ids()).toEqual(['t0', 't1', 't2']);
      expect(win.activeTab?.id).toBe('t2');
      expect(missing.closeQueueIdle).toBe(true);
      await missing.requestCloseAt(2);
      expect(ids()).toEqual(['t0', 't1']);
    });
  });

  it('a tab close taken over by a quit does not block later closes', async () => {
    const viewer = clean('t1', '/p/1.log', 1);
    viewer.large = { size: 100 };
    open(
      [dirty('t0', '/p/0.txt', 'zero', 0), viewer, clean('t2', '/p/2.txt', 2)],
      't0',
    );
    const release = await holdWrite();
    const closing = missing.requestCloseAt(1);
    await win.openRangeBox(tab('t1'), {
      startByte: 0,
      endByte: 8,
      startLine: 1,
      endLine: 2,
    });
    win.rangeBoxEdited(Text.of(['one', 'two', 'three']));
    release();
    await until(() => gate.visible);
    expect(gate.reason).toBe('rangeBox');
    expect(win.activeTab?.id).toBe('t1');
    expect(missing.closeQueueIdle).toBe(false);

    await gate.onFlushRequest();
    gate.cancel();
    await closing;
    expect(missing.closeQueueIdle).toBe(true);

    win.rangeBoxCancel();
    await missing.requestCloseAt(2);
    expect(ids()).toEqual(['t0', 't1']);
  });

  it('a close that kept its tab leaves no jump behind', async () => {
    await askedWhileT0Clicked();
    const releaseDelete = holdCommand('delete_note');
    const discarding = missing.confirmDiscard();
    await wait();
    win.updateContentById('t1', Text.of(['typed']));
    releaseDelete();
    await discarding;
    await until(() => missing.closeQueueIdle);

    expect(missing.confirmClose).toBe(false);
    expect(ids()).toEqual(['t0', 't1', 't2']);
    expect(win.activeTab?.id).toBe('t1');

    missing.requestClose(tab('t1'));
    expect(missing.confirmClose).toBe(true);
    await missing.confirmDiscard();
    expect(ids()).toEqual(['t0', 't2']);
    expect(win.activeTab?.id).toBe('t2');
  });

  /** `win.settleTab` holds one promise per call, released by index. */
  function holdSettles(): (index: number) => void {
    const releases: (() => void)[] = [];
    vi.spyOn(win, 'settleTab').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    return (index) => releases[index]!();
  }

  it('a deferred close started elsewhere does not end a queued close', async () => {
    open([clean('t0', '/p/0.txt', 0), clean('X', '/p/X.txt', 1)], 'X');
    const x = tab('X');
    x.transferring = true;
    const release = holdSettles();
    void missing.requestCloseAt(1);
    await wait();
    expect(missing.requestClose(x)).toBe(true);
    await wait();

    x.transferring = true;
    release(1);
    await wait();
    expect(missing.closeQueueIdle).toBe(false);
    expect(ids()).toEqual(['t0', 'X']);

    x.transferring = false;
    release(0);
    await until(() => missing.closeQueueIdle);
    expect(ids()).toEqual(['t0']);
  });

  it('a stale owner’s report does not end a later queued close of the same tab', async () => {
    open([clean('t0', '/p/0.txt', 0), dirty('X', '/p/X.txt', 'ex', 1)], 'X');
    const x = tab('X');
    x.transferring = true;
    const release = holdSettles();
    void missing.requestCloseAt(1);
    await wait();

    x.transferring = false;
    missing.requestClose(x);
    expect(missing.confirmClose).toBe(true);
    missing.cancelClose();
    await until(() => missing.closeQueueIdle);

    x.transferring = true;
    void missing.requestCloseAt(1);
    await wait();
    release(0);
    await wait();
    expect(missing.closeQueueIdle).toBe(false);

    x.transferring = false;
    release(1);
    await until(() => missing.confirmClose);
    await missing.confirmDiscard();
    expect(ids()).toEqual(['t0']);
    await until(() => missing.closeQueueIdle);
  });
});
