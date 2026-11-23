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
/** One entry per `splice_file` call to hold: it settles when the test says. */
let holds: Promise<string | null>[];
/** Past this many writes a loop of rewrites is taken for a runaway. */
const SPLICE_RUNAWAY = 20;
/** Hold the next `splice_file` that has no hold yet. */
function hold(): { release: () => void; fail: (error: string) => void } {
  let settle: (error: string | null) => void = () => {};
  holds.push(
    new Promise<string | null>((resolve) => {
      settle = resolve;
    }),
  );
  return { release: () => settle(null), fail: (error) => settle(error) };
}
/** The arguments of every `splice_file` sent so far. */
function splices(): Record<string, unknown>[] {
  return mockInvoke.mock.calls
    .filter(([c]) => c === 'splice_file')
    .map(([, args]) => args as Record<string, unknown>);
}
/** Let everything that can run without a test's say-so run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
        const apply = (): Promise<unknown> => {
          if (spliceError !== null) {
            return Promise.reject(spliceError);
          }
          if (splices().length > SPLICE_RUNAWAY) {
            return Promise.reject('runaway rewrites');
          }
          const expected = a['expected'] as {
            size: number;
            mtime_ms: number;
          } | null;
          const now = fingerprint();
          if (
            expected !== null &&
            (expected.size !== now.size || expected.mtime_ms !== now.mtime_ms)
          ) {
            return Promise.reject('fingerprint-mismatch');
          }
          const start = a['start'] as number;
          const bytes = enc(a['replacement'] as string);
          disk = new Uint8Array([
            ...disk.subarray(0, start),
            ...bytes,
            ...disk.subarray(a['end'] as number),
          ]);
          mtime += 1;
          return Promise.resolve({
            fingerprint: fingerprint(),
            writtenStart: start,
            writtenEnd: start + bytes.length,
          });
        };
        const held = holds.shift();
        return held === undefined
          ? apply()
          : held.then((error) =>
              error === null ? apply() : Promise.reject(error),
            );
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
    order: 0,
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
  holds = [];
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

describe('typing while the write-back is out', () => {
  it('stays editable, then writes what was typed over the span just written, and closes', async () => {
    await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    expect(splices()).toHaveLength(1);
    type('line2\nline3\nline4\nONE\nTWO\n');
    expect(documentWindow.rangeBox?.content.toString()).toBe(
      'line2\nline3\nline4\nONE\nTWO\n',
    );
    first.release();
    expect(await saving).toBe('ok');
    expect(splices()).toHaveLength(2);
    expect(documentWindow.rangeBox).toBeNull();
    expect(fileText()).toBe('line1\nline2\nline3\nline4\nONE\nTWO\nline5\n');
  });

  it('keeps writing until a write finds the buffer as it sent it', async () => {
    await openBox(LF_FILE);
    const first = hold();
    const second = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    type('line2\nline3\nline4\nONE\nTWO\n');
    first.release();
    await settle();
    expect(splices()).toHaveLength(2);
    expect(documentWindow.rangeBox).not.toBeNull();
    type('line2\nline3\nline4\nONE\nTWO\nTHREE\n');
    second.release();
    expect(await saving).toBe('ok');
    expect(splices()).toHaveLength(3);
    expect(documentWindow.rangeBox).toBeNull();
    expect(fileText()).toBe(
      'line1\nline2\nline3\nline4\nONE\nTWO\nTHREE\nline5\n',
    );
  });

  it('closes after one write when the text typed back is the text sent', async () => {
    await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    type('line2\nline3\nline4\nONE\nTWO\n');
    type('line2\nline3\nline4\nONE\n');
    first.release();
    expect(await saving).toBe('ok');
    expect(splices()).toHaveLength(1);
    expect(documentWindow.rangeBox).toBeNull();
  });

  it('sends nothing for a second save while a write is out, and answers with that write', async () => {
    await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const a = documentWindow.rangeBoxSave();
    const b = documentWindow.rangeBoxSave();
    expect(splices()).toHaveLength(1);
    first.release();
    expect(await a).toBe('ok');
    expect(await b).toBe('ok');
    expect(splices()).toHaveLength(1);
    expect(documentWindow.rangeBox).toBeNull();
  });

  it('closes on cancel and does not write again when the write in flight lands', async () => {
    await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    type('line2\nline3\nline4\nONE\nTWO\n');
    documentWindow.rangeBoxCancel();
    expect(documentWindow.rangeBox).toBeNull();
    first.release();
    expect(await saving).toBe('ok');
    expect(splices()).toHaveLength(1);
    expect(fileText()).toBe('line1\nline2\nline3\nline4\nONE\nline5\n');
  });

  it('leaves a box opened after the cancel alone when the write in flight lands', async () => {
    const tab = await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    documentWindow.rangeBoxCancel();
    // Box B: line 5, opened over the file as A's write has not landed yet.
    const startByte = enc('line1\nline2\nline3\nline4\n').length;
    const endByte = startByte + enc('line5\n').length;
    await documentWindow.openRangeBox(tab, {
      startByte,
      endByte,
      startLine: 5,
      endLine: 5,
    });
    const b = documentWindow.rangeBox!;
    type('line5 edited\n');
    const typed = documentWindow.rangeBox!;
    first.release();
    expect(await saving).toBe('ok');
    expect(splices()).toHaveLength(1);
    expect(documentWindow.rangeBox).toBe(typed);
    expect(typed).toMatchObject({
      session: b.session,
      startByte: b.startByte,
      endByte: b.endByte,
      fingerprint: b.fingerprint,
      conflict: false,
    });
    expect(typed.saved).toBe(b.saved);
    expect(typed.content.toString()).toBe('line5 edited\n');
    // B's own save still goes out from its own span and baseline.
    await documentWindow.rangeBoxSave();
    expect(splices()[1]).toMatchObject({
      start: b.startByte,
      end: b.endByte,
      expected: b.fingerprint,
    });
  });

  it('does not hold back the save of a box opened after the cancel while the first write is still out', async () => {
    const tab = await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    documentWindow.rangeBoxCancel();
    const startByte = enc('line1\nline2\nline3\nline4\n').length;
    await documentWindow.openRangeBox(tab, {
      startByte,
      endByte: startByte + enc('line5\n').length,
      startLine: 5,
      endLine: 5,
    });
    type('line5 edited\n');
    const other = documentWindow.rangeBoxSave();
    expect(splices()).toHaveLength(2);
    expect(splices()[1]).toMatchObject({ start: startByte });
    expect(await other).toBe('ok');
    first.release();
    await saving;
    expect(splices()).toHaveLength(2);
  });

  it('raises no conflict on a box opened after the cancel when the write in flight finds the source changed', async () => {
    const tab = await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    documentWindow.rangeBoxCancel();
    const startByte = enc('line1\nline2\nline3\nline4\n').length;
    await documentWindow.openRangeBox(tab, {
      startByte,
      endByte: startByte + enc('line5\n').length,
      startLine: 5,
      endLine: 5,
    });
    type('line5 edited\n');
    const before = documentWindow.rangeBox;
    first.fail('fingerprint-mismatch');
    expect(await saving).toBe('mismatch');
    expect(documentWindow.rangeBox).toBe(before);
    expect(documentWindow.rangeConflictVisible()).toBe(false);
  });

  it('still reports a failure that lands after the box was cancelled, and leaves the box that replaced it alone', async () => {
    const tab = await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    documentWindow.rangeBoxCancel();
    const startByte = enc('line1\nline2\nline3\nline4\n').length;
    await documentWindow.openRangeBox(tab, {
      startByte,
      endByte: startByte + enc('line5\n').length,
      startLine: 5,
      endLine: 5,
    });
    type('line5 edited\n');
    const before = documentWindow.rangeBox;
    first.fail('No space left on device (os error 28)');
    expect(await saving).toBe('error');
    expect(documentWindow.saveFailed).toEqual({
      path: SRC,
      error: 'No space left on device (os error 28)',
    });
    expect(documentWindow.rangeBox).toBe(before);
  });

  it('reports a failure that lands after a plain cancel, with no box left to touch', async () => {
    await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    documentWindow.rangeBoxCancel();
    first.fail('No space left on device (os error 28)');
    expect(await saving).toBe('error');
    expect(documentWindow.saveFailed?.error).toBe(
      'No space left on device (os error 28)',
    );
    expect(documentWindow.rangeBox).toBeNull();
  });

  it('marks the viewer read-only when the source turned read-only under a cancelled write', async () => {
    const tab = await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    documentWindow.rangeBoxCancel();
    first.fail(READ_ONLY_DESTINATION);
    expect(await saving).toBe('error');
    expect(tab.readOnlyFile).toBe(true);
    expect(documentWindow.saveFailed?.error).toBe(READ_ONLY_DESTINATION);
  });

  it('raises the conflict dialog when the rewrite finds the source changed, keeping the box and its text', async () => {
    await openBox(LF_FILE);
    const first = hold();
    const second = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    type('line2\nline3\nline4\nONE\nTWO\n');
    first.release();
    await settle();
    second.fail('fingerprint-mismatch');
    expect(await saving).toBe('mismatch');
    expect(documentWindow.rangeConflictVisible()).toBe(true);
    expect(documentWindow.rangeBox?.content.toString()).toBe(
      'line2\nline3\nline4\nONE\nTWO\n',
    );
  });

  it('reports a failed rewrite, keeps the box and its text, and lets the next save go out', async () => {
    await openBox(LF_FILE);
    const first = hold();
    const second = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    type('line2\nline3\nline4\nONE\nTWO\n');
    first.release();
    await settle();
    second.fail('No space left on device (os error 28)');
    expect(await saving).toBe('error');
    expect(documentWindow.saveFailed?.path).toBe(SRC);
    expect(documentWindow.rangeBox?.content.toString()).toBe(
      'line2\nline3\nline4\nONE\nTWO\n',
    );
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(splices()).toHaveLength(3);
    expect(documentWindow.rangeBox).toBeNull();
    expect(fileText()).toBe('line1\nline2\nline3\nline4\nONE\nTWO\nline5\n');
  });

  it('lets the next save go out after a conflict ended the write', async () => {
    await openBox(LF_FILE);
    const first = hold();
    type('line2\nline3\nline4\nONE\n');
    const saving = documentWindow.rangeBoxSave();
    first.fail('fingerprint-mismatch');
    expect(await saving).toBe('mismatch');
    expect(await documentWindow.rangeConflictForce()).toBe('ok');
    expect(splices()).toHaveLength(2);
    expect(documentWindow.rangeBox).toBeNull();
  });
});

describe('what a rewrite is rebased onto', () => {
  it('sends the fingerprint and the span the first write reported, and keeps the lines it did not touch', async () => {
    const head = 'head\n';
    const body = 'α\r\nβ\rγ\nδ\r\n';
    disk = enc(`${head}${body}tail\n`);
    backend();
    const tab = viewerTab();
    const startByte = enc(head).length;
    await documentWindow.openRangeBox(tab, {
      startByte,
      endByte: startByte + enc(body).length,
      startLine: 2,
      endLine: 5,
    });
    const first = hold();
    // A new line in front shifts the separators of every line after it.
    type('α\nNEW\nβ\nγ\nδ\n');
    const saving = documentWindow.rangeBoxSave();
    type('α\nNEW\nβ\nγ\nδ2\n');
    first.release();
    expect(await saving).toBe('ok');
    const [one, two] = splices() as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(one).toMatchObject({ start: startByte });
    // The mock reports where it wrote: the replacement's bytes (multi-byte).
    const firstText = 'α\r\nNEW\r\nβ\rγ\nδ\r\n';
    expect(one['replacement']).toBe(firstText);
    expect(two).toMatchObject({
      start: startByte,
      end: startByte + enc(firstText).length,
      expected: { size: enc(`${head}${firstText}tail\n`).length, mtime_ms: 2 },
    });
    expect(fileText()).toBe(`${head}α\r\nNEW\r\nβ\rγ\nδ2\r\ntail\n`);
  });
});

describe('a box whose span ends at a line break that the text written lost', () => {
  it('keeps the next line apart when text is typed into an emptied box during the write', async () => {
    await openBox(LF_FILE);
    type('');
    const first = hold();
    const saving = documentWindow.rangeBoxSave();
    type('abc');
    first.release();
    expect(await saving).toBe('ok');
    expect(fileText()).toBe('line1\nabc\nline5\n');
  });

  it('adds no break at the end of a file that had none when it is deleted during the write', async () => {
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
    type('line2\nline3\n');
    const first = hold();
    const saving = documentWindow.rangeBoxSave();
    type('line2\nline3');
    first.release();
    expect(await saving).toBe('ok');
    expect(fileText()).toBe('line1\nline2\nline3');
  });
});

describe('a write-back nothing was typed during', () => {
  it('sends a CRLF source once and closes', async () => {
    await openBox(CRLF_FILE);
    type('line2\nline3\nline4\nZZ');
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(splices()).toHaveLength(1);
    expect(documentWindow.rangeBox).toBeNull();
  });

  it('sends a slice whose closing break the rule added once and closes', async () => {
    await openBox(LF_FILE);
    type('line2\nline3\nline4\nZZ');
    expect(await documentWindow.rangeBoxSave()).toBe('ok');
    expect(splices()).toHaveLength(1);
    expect(splices()[0]!['replacement']).toBe('line2\nline3\nline4\nZZ\n');
    expect(documentWindow.rangeBox).toBeNull();
  });
});
