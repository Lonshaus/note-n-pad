// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The range edit box writes its text back over the slice it was opened on. A
// slice that ended with a line break gets one back when it is spliced into the
// source, so text typed on the buffer's empty last line cannot join the next
// source line. Driven through the real window state against a fake file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import type { NoteSnapshot } from './stickyNote.svelte';
import { settingsState } from './settings.svelte';
import { editionState } from './edition.svelte';
import { READ_ONLY_DESTINATION } from '../util/protocol';
import {
  documentWindow,
  RANGE_SPLICED_EVENT,
  type DocTab,
} from './documentWindow.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockEmit = vi.mocked(emit);
vi.stubGlobal('window', globalThis);

const SRC = '/tmp/src.txt';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
/** The fake source file and everything the window wrote. */
let disk: Uint8Array;
let mtime: number;
let written: { path: string; content: string }[];
let upserts: NoteSnapshot[];
let spliceError: string | null;

function fingerprint(): { size: number; mtime_ms: number } {
  return { size: disk.length, mtime_ms: mtime };
}

function backend(): void {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(((cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
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
        return Promise.resolve([]);
      case 'live_doc_groups':
        return Promise.resolve([]);
      case 'path_writable':
        return Promise.resolve(true);
      case 'stat_file':
        return Promise.resolve({ size: 10 });
      case 'read_file_auto':
      case 'read_file_as': {
        const file = written.find((w) => w.path === a['path']);
        return Promise.resolve({
          content: file?.content ?? '',
          encoding: 'UTF-8',
          had_bom: false,
          lossy: false,
        });
      }
      case 'read_range':
        return Promise.resolve({
          text: dec(disk.subarray(a['start'] as number, a['end'] as number)),
          lossy: false,
        });
      case 'file_fingerprint':
        return Promise.resolve(fingerprint());
      case 'splice_file': {
        if (spliceError !== null) {
          return Promise.reject(spliceError);
        }
        disk = new Uint8Array([
          ...disk.subarray(0, a['start'] as number),
          ...enc(a['replacement'] as string),
          ...disk.subarray(a['end'] as number),
        ]);
        mtime += 1;
        return Promise.resolve(fingerprint());
      }
      case 'write_file_encoded':
        written.push({
          path: a['path'] as string,
          content: a['content'] as string,
        });
        return Promise.resolve(null);
      case 'upsert_note':
        upserts.push(a['note'] as NoteSnapshot);
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  }) as typeof invoke);
}

const LF_FILE = 'line1\nline2\nline3\nline4\nline5\n';
const CRLF_FILE = LF_FILE.replace(/\n/g, '\r\n');
/** Byte span of lines 2-4 (1-based) as the viewer resolves it: from the start
 *  of line 2 to the start of line 5. */
function span(file: string): { startByte: number; endByte: number } {
  const lines = file.split(/(?<=\n)/);
  const startByte = enc(lines.slice(0, 1).join('')).length;
  const endByte = enc(lines.slice(0, 4).join('')).length;
  return { startByte, endByte };
}
/** The large-file viewer tab of the fake source, active in the window. */
function viewerTab(): DocTab {
  const tab: DocTab = {
    id: 'viewer',
    path: SRC,
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
    large: { size: disk.length },
  };
  documentWindow.tabs.push(tab);
  documentWindow.activeIndex = 0;
  return tab;
}
/** Open the box on lines `a`-`b` of `file`, as the viewer's button does. */
async function openBox(file: string, a = 2, b = 4): Promise<DocTab> {
  disk = enc(file);
  backend();
  const tab = viewerTab();
  const { startByte, endByte } = span(file);
  expect(
    await documentWindow.openRangeBox(tab, {
      startByte,
      endByte,
      startLine: a,
      endLine: b,
    }),
  ).toBeNull();
  return tab;
}

function type(text: string): void {
  documentWindow.rangeBoxEdited(Text.of(text.split('\n')));
}

let readySpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  readySpy = vi.spyOn(editionState, 'ready').mockResolvedValue();
  editionState.lite = false;
  documentWindow.tabs.length = 0;
  documentWindow.ready = false;
  documentWindow.activeIndex = 0;
  documentWindow.rangeBox = null;
  documentWindow.saveFailed = null;
  mtime = 1;
  written = [];
  upserts = [];
  spliceError = null;
  mockEmit.mockClear();
});

afterEach(() => {
  readySpy.mockRestore();
});

function fileText(): string {
  return dec(disk);
}

describe('writing back a box whose slice ended with a line break', () => {
  it('opens clean, with the slice as read', async () => {
    await openBox(LF_FILE);
    const box = documentWindow.rangeBox!;
    expect(box.content.toString()).toBe('line2\nline3\nline4\n');
    expect(box.saved.toString()).toBe('line2\nline3\nline4\n');
    expect(box.trailingBreak).toBe(true);
    expect(documentWindow.rangeBoxDirty()).toBe(false);
  });

  it('keeps the next line intact when text is typed on the empty last line', async () => {
    await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline2\nline3\nline4\nZZ\nline5\n');
  });

  it('adds no second break when text is typed at the end of the last line', async () => {
    await openBox(LF_FILE);
    type('line2\nline3\nline4ZZ\n');
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline2\nline3\nline4ZZ\nline5\n');
  });

  it('writes an untouched slice back unchanged', async () => {
    await openBox(LF_FILE);
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(fileText()).toBe(LF_FILE);
  });

  it('writes one selected blank line back unchanged', async () => {
    disk = enc('a\n\nc\n');
    backend();
    const tab = viewerTab();
    await documentWindow.openRangeBox(tab, {
      startByte: 2,
      endByte: 3,
      startLine: 2,
      endLine: 2,
    });
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(fileText()).toBe('a\n\nc\n');
  });

  it('puts back a CRLF break', async () => {
    await openBox(CRLF_FILE);
    expect(documentWindow.rangeBox?.lineEnding).toBe('CRLF');
    type('line2\nline3\nline4\nZZ');
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(fileText()).toBe(
      'line1\r\nline2\r\nline3\r\nline4\r\nZZ\r\nline5\r\n',
    );
  });
});

describe('a box that reaches the end of a file with no final break', () => {
  it('writes typed text without an added break', async () => {
    disk = enc('line1\nline2\nline3');
    backend();
    const tab = viewerTab();
    await documentWindow.openRangeBox(tab, {
      startByte: 6,
      endByte: disk.length,
      startLine: 2,
      endLine: 3,
    });
    expect(documentWindow.rangeBox?.trailingBreak).toBe(false);
    type('line2\nline3ZZ');
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline2\nline3ZZ');
  });
});

describe('emptying a box', () => {
  it('removes the whole span on save, for LF', async () => {
    await openBox(LF_FILE);
    type('');
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline5\n');
  });

  it('removes the whole span on save, for CRLF', async () => {
    await openBox(CRLF_FILE);
    type('');
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(fileText()).toBe('line1\r\nline5\r\n');
  });
});

describe('a successful write-back', () => {
  it('closes the box, adds no tab, and tells every window to reindex', async () => {
    const tab = await openBox(LF_FILE);
    type('line2\nline3\nline4\nnew5\nnew6\n');
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(documentWindow.rangeBox).toBeNull();
    expect(documentWindow.tabs).toEqual([tab]);
    expect(mockEmit).toHaveBeenCalledWith(RANGE_SPLICED_EVENT, SRC);
  });

  it('keeps the viewer tab in step with the rewritten file', async () => {
    const tab = await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    await documentWindow.rangeBoxSave();
    expect(tab.large?.size).toBe(disk.length);
  });

  it('writes nothing about the box to the snapshot store', async () => {
    await openBox(LF_FILE);
    type('line2\nline3\nline4\nTYPED-IN-THE-BOX');
    await documentWindow.flushAll();
    await documentWindow.rangeBoxSave();
    expect(JSON.stringify(upserts)).not.toContain('TYPED-IN-THE-BOX');
    for (const note of upserts) {
      expect(note.range_source).toBeNull();
      expect(note.range_start).toBeNull();
      expect(note.range_end).toBeNull();
    }
  });
});

describe('cancelling a box', () => {
  it('drops the text and leaves the source untouched', async () => {
    await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    expect(documentWindow.rangeBoxDirty()).toBe(true);
    documentWindow.rangeBoxCancel();
    expect(documentWindow.rangeBox).toBeNull();
    expect(fileText()).toBe(LF_FILE);
  });
});

describe('a box whose source changed in the meantime', () => {
  it('raises the conflict dialog and keeps the box with its text', async () => {
    await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    spliceError = 'fingerprint-mismatch';
    expect(await documentWindow.rangeBoxSave()).toBe('mismatch');
    expect(documentWindow.rangeConflictVisible()).toBe(true);
    expect(documentWindow.rangeBox?.content.toString()).toBe(
      'line2\nline3\nline4\nZZ',
    );
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('writes anyway on force, past the check, and closes the box', async () => {
    await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    spliceError = 'fingerprint-mismatch';
    await documentWindow.rangeBoxSave();
    spliceError = null;
    expect(await documentWindow.rangeConflictForce()).toBe('ok');
    const splice = mockInvoke.mock.calls.filter(([c]) => c === 'splice_file');
    expect(splice.at(-1)![1]).toMatchObject({ expected: null });
    expect(documentWindow.rangeBox).toBeNull();
    expect(fileText()).toBe('line1\nline2\nline3\nline4\nZZ\nline5\n');
  });

  it('goes back to the box with its text when the dialog is cancelled', async () => {
    await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    spliceError = 'fingerprint-mismatch';
    await documentWindow.rangeBoxSave();
    documentWindow.rangeConflictCancel();
    expect(documentWindow.rangeConflictVisible()).toBe(false);
    expect(documentWindow.rangeBox?.content.toString()).toBe(
      'line2\nline3\nline4\nZZ',
    );
  });

  async function conflict(file: string): Promise<void> {
    // Opening the saved file waits for the window to know its tab indices.
    backend();
    await settingsState.init();
    await documentWindow.init('g', null, null);
    await openBox(file);
    spliceError = 'fingerprint-mismatch';
    expect(await documentWindow.rangeBoxSave()).toBe('mismatch');
  }

  it('save as writes the text as a new file and opens it as a new tab, for LF', async () => {
    await conflict(LF_FILE);
    expect(await documentWindow.rangeConflictSaveAs('/tmp/out.txt')).toBe(true);
    expect(written).toEqual([
      { path: '/tmp/out.txt', content: 'line2\nline3\nline4\n' },
    ]);
    expect(fileText()).toBe(LF_FILE);
    expect(documentWindow.rangeBox).toBeNull();
    expect(documentWindow.tabs.map((t) => t.path)).toEqual([
      SRC,
      '/tmp/out.txt',
    ]);
    expect(documentWindow.activeTab?.path).toBe('/tmp/out.txt');
  });

  it('save as keeps the line ending of the source, for CRLF', async () => {
    await conflict(CRLF_FILE);
    type('line2\nline3\nline4\nZZ');
    expect(await documentWindow.rangeConflictSaveAs('/tmp/out.txt')).toBe(true);
    expect(written[0]!.content).toBe('line2\r\nline3\r\nline4\r\nZZ');
  });

  it('save as that fails keeps the dialog up and the box with its text', async () => {
    await conflict(LF_FILE);
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'write_file_encoded'
        ? Promise.reject('disk full')
        : Promise.resolve(null)) as typeof invoke);
    expect(await documentWindow.rangeConflictSaveAs('/tmp/out.txt')).toBe(
      false,
    );
    expect(documentWindow.rangeConflictVisible()).toBe(true);
    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/out.txt',
      error: 'disk full',
    });
  });
});

describe('a write-back that fails for another reason', () => {
  it('reports the source and keeps the box, leaving the padlock alone', async () => {
    const tab = await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    spliceError = 'No space left on device (os error 28)';
    expect(await documentWindow.rangeBoxSave()).toBe('error');
    expect(documentWindow.saveFailed).toEqual({
      path: SRC,
      error: 'No space left on device (os error 28)',
    });
    expect(documentWindow.rangeBox).not.toBeNull();
    expect(documentWindow.rangeConflictVisible()).toBe(false);
    expect(tab.readOnlyFile).toBe(false);
  });

  it('flags the viewer tab when the source turned read-only', async () => {
    const tab = await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    spliceError = READ_ONLY_DESTINATION;
    expect(await documentWindow.rangeBoxSave()).toBe('error');
    expect(documentWindow.saveFailed).toEqual({
      path: SRC,
      error: READ_ONLY_DESTINATION,
    });
    expect(tab.readOnlyFile).toBe(true);
  });
});

describe('closing the tab a box belongs to', () => {
  it('drops the box with it', async () => {
    await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    await documentWindow.deleteTab(0);
    expect(documentWindow.rangeBox).toBeNull();
    expect(documentWindow.rangeBoxBlocking()).toBeNull();
  });
});

describe('the gate before closing', () => {
  it('reports a box with changes, ahead of everything else', async () => {
    await openBox(LF_FILE);
    expect(documentWindow.firstBlockingDirty()).toBeNull();
    type('line2\nline3\nline4\nZZ');
    expect(documentWindow.firstBlockingDirty()).toEqual({
      index: 0,
      oversized: false,
      rangeBox: true,
    });
  });

  it('stops reporting it once the text is typed back to the slice', async () => {
    await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    type('line2\nline3\nline4\n');
    expect(documentWindow.firstBlockingDirty()).toBeNull();
  });
});
