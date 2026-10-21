// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Tabs following a file or folder that was renamed, driven through the real
// window state against a fake backend: which tabs move, what else moves with
// them, and the record each one writes so a snapshot carrying the old path
// cannot win.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { DocumentWindowState, type DocTab } from './documentWindow.svelte';
import type { PathRules } from '../util/filePath';
import type { NoteSnapshot } from './stickyNote.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
vi.stubGlobal('window', globalThis);

const posix: PathRules = { caseInsensitive: false, backslash: false };

function tab(id: string, path: string, over: Partial<DocTab> = {}): DocTab {
  return {
    id,
    path,
    readOnlyFile: false,
    content: Text.of(['text']),
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
/** Every record written for `id`, with the sequence it was sent with. */
function writes(id: string): { note: NoteSnapshot; seq: number }[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === 'upsert_note')
    .map(([, args]) => args as { note: NoteSnapshot; seq: number })
    .filter((a) => a.note.id === id);
}

let win: DocumentWindowState;

function byId(id: string): DocTab {
  const found = win.tabs.find((t) => t.id === id);
  if (found === undefined) {
    throw new Error(`no tab ${id}`);
  }
  return found;
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((() => Promise.resolve(null)) as typeof invoke);
  win = new DocumentWindowState();
});

describe('retargetPaths', () => {
  it('moves the tab of a renamed file and leaves the others', () => {
    win.tabs.push(tab('a', '/p/f.txt'), tab('b', '/p/other.txt'));
    win.retargetPaths('/p/f.txt', '/p/g.txt', posix);
    expect(byId('a').path).toBe('/p/g.txt');
    expect(byId('b').path).toBe('/p/other.txt');
  });

  it('moves every tab below a renamed folder, but not a folder that only starts alike', () => {
    win.tabs.push(
      tab('a', '/p/y/f.txt'),
      tab('b', '/p/y/deep/g.txt'),
      tab('c', '/p/y2/f.txt'),
      tab('u', ''),
    );
    win.retargetPaths('/p/y', '/p/z', posix);
    expect(win.tabs.map((t) => t.path)).toEqual([
      '/p/z/f.txt',
      '/p/z/deep/g.txt',
      '/p/y2/f.txt',
      '',
    ]);
  });

  it('detects the language again from the new name, unless one was chosen', () => {
    win.tabs.push(
      tab('auto', '/p/f.txt', { language: null }),
      tab('chosen', '/p/g.txt', { language: 'Python', explicit: true }),
    );
    win.retargetPaths('/p/f.txt', '/p/f.json', posix);
    win.retargetPaths('/p/g.txt', '/p/g.json', posix);
    expect(byId('auto').language).toBe('JSON');
    expect(byId('chosen').language).toBe('Python');
  });

  it('tells the Rust session of a windowed tab where its file went', () => {
    win.tabs.push(
      tab('w', '/p/y/big.log', {
        windowed: {
          sessionId: 7,
          totalBytes: 1,
          totalLines: 1,
          fingerprint: null,
          dirty: true,
          topLine: 0,
        },
      }),
      tab('plain', '/p/y/a.txt'),
    );
    win.retargetPaths('/p/y', '/p/z', posix);
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === 'windowed_set_path'),
    ).toEqual([['windowed_set_path', { sessionId: 7, path: '/p/z/big.log' }]]);
  });

  it('does not touch a windowed session whose file did not move', () => {
    win.tabs.push(
      tab('w', '/p/big.log', {
        windowed: {
          sessionId: 7,
          totalBytes: 1,
          totalLines: 1,
          fingerprint: null,
          dirty: false,
          topLine: 0,
        },
      }),
    );
    win.retargetPaths('/p/other', '/p/else', posix);
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === 'windowed_set_path'),
    ).toEqual([]);
  });

  it('moves the source of the range box with its file', async () => {
    const viewer = tab('v', '/p/y/big.log', {
      large: { size: 100 },
      content: Text.empty,
    });
    win.tabs.push(viewer);
    mockInvoke.mockImplementation(((cmd: string) =>
      Promise.resolve(
        cmd === 'read_range' ? { text: 'one\n', lossy: false } : null,
      )) as typeof invoke);
    await win.openRangeBox(byId('v'), {
      startByte: 0,
      endByte: 4,
      startLine: 1,
      endLine: 1,
    });
    win.retargetPaths('/p/y', '/p/z', posix);
    expect(win.rangeBox?.sourcePath).toBe('/p/z/big.log');
    expect(byId('v').path).toBe('/p/z/big.log');
  });

  it('writes each moved tab again at once, newer than anything sent before', async () => {
    win.tabs.push(
      tab('a', '/p/y/f.txt', { tabIndex: 0 }),
      tab('b', '/p/y/g.txt', { tabIndex: 1 }),
      tab('c', '/p/q/h.txt', { tabIndex: 2 }),
    );
    await win.flushAll();
    const before = Math.max(
      ...['a', 'b'].flatMap((id) => writes(id).map((w) => w.seq)),
    );
    win.retargetPaths('/p/y', '/p/z', posix);
    // The writes start at once; let their snapshots finish.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [id, path] of [
      ['a', '/p/z/f.txt'],
      ['b', '/p/z/g.txt'],
    ] as const) {
      const last = writes(id).at(-1);
      expect(last?.note.file_path).toBe(path);
      expect(last?.seq).toBeGreaterThan(before);
    }
    // A tab that did not move is not written again.
    expect(writes('c')).toHaveLength(1);
  });

  it('writes nothing when no tab was on the renamed path', () => {
    win.tabs.push(tab('a', '/p/f.txt'));
    win.retargetPaths('/q/x', '/q/y', posix);
    expect(mockInvoke.mock.calls).toEqual([]);
  });
});
