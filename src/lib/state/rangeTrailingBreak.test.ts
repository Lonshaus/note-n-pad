// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A range tab whose slice ended with a line break gets one back when it is
// spliced into the source, so text typed on the buffer's empty last line cannot
// join the next source line. Also pins the line span a persisted range record
// carries for the workspace list. Driven through the real window state against
// a fake file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import type { NoteSnapshot } from './stickyNote.svelte';
import { settingsState } from './settings.svelte';
import { editionState } from './edition.svelte';
import { t } from '../i18n';
import { docLabel } from '../util/openDocuments';
import {
  documentWindow,
  rangeDisplayName,
  type DocTab,
} from './documentWindow.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
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

function backend(stored: NoteSnapshot[] = []): void {
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
        return Promise.resolve(stored);
      case 'live_doc_groups':
        return Promise.resolve([]);
      case 'path_writable':
        return Promise.resolve(true);
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

function record(over: Partial<NoteSnapshot>): NoteSnapshot {
  return {
    id: 'r',
    content: '',
    file_path: '',
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
    dirty: false,
    window_group: 'g',
    tab_index: 0,
    line_ending: 'LF',
    had_bom: false,
    encoding: 'UTF-8',
    project: null,
    large: null,
    range_source: SRC,
    range_start: 6,
    range_end: 24,
    range_fp_size: 30,
    range_fp_mtime: 1,
    range_start_line: 2,
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

async function extract(file: string, a = 2, b = 4): Promise<DocTab> {
  disk = enc(file);
  backend();
  const { startByte, endByte } = span(file);
  expect(
    await documentWindow.createRangeTab(SRC, {
      startByte,
      endByte,
      startLine: a,
      endLine: b,
    }),
  ).toBeNull();
  return documentWindow.tabs[documentWindow.tabs.length - 1]!;
}

function type(tab: DocTab, text: string): void {
  tab.content = Text.of(text.split('\n'));
}

async function restoreFrom(
  file: string,
  over: Partial<NoteSnapshot>,
): Promise<DocTab> {
  disk = enc(file);
  const { startByte, endByte } = span(file);
  backend([
    record({
      range_start: startByte,
      range_end: endByte,
      range_fp_size: disk.length,
      range_fp_mtime: mtime,
      ...over,
    }),
  ]);
  await documentWindow.init('g', null, null);
  return documentWindow.tabs[0]!;
}

let readySpy: ReturnType<typeof vi.spyOn>;
let languageBefore: string;

beforeEach(() => {
  readySpy = vi.spyOn(editionState, 'ready').mockResolvedValue();
  editionState.lite = false;
  languageBefore = settingsState.language;
  settingsState.language = 'ja';
  documentWindow.tabs.length = 0;
  documentWindow.ready = false;
  documentWindow.keptTabs = 0;
  documentWindow.restoreUnreadable = [];
  documentWindow.activeIndex = 0;
  documentWindow.rangeConflict = null;
  mtime = 1;
  written = [];
  upserts = [];
  spliceError = null;
});

afterEach(() => {
  readySpy.mockRestore();
  settingsState.language = languageBefore;
});

function fileText(): string {
  return dec(disk);
}

describe('splicing a range tab whose slice ended with a line break', () => {
  it('keeps the buffer as it always was', async () => {
    const tab = await extract(LF_FILE);
    expect(tab.content.toString()).toBe('line2\nline3\nline4\n');
    expect(tab.savedContent.toString()).toBe('line2\nline3\nline4\n');
    expect(tab.range?.trailingBreak).toBe(true);
    expect(documentWindow.isDirty(tab)).toBe(false);
  });

  it('keeps the next line intact when text is typed on the empty last line', async () => {
    const tab = await extract(LF_FILE);
    type(tab, 'line2\nline3\nline4\nZZ');
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline2\nline3\nline4\nZZ\nline5\n');
  });

  it('adds no second break when text is typed at the end of the last line', async () => {
    const tab = await extract(LF_FILE);
    type(tab, 'line2\nline3\nline4ZZ\n');
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline2\nline3\nline4ZZ\nline5\n');
  });

  it('writes an untouched range back unchanged', async () => {
    const tab = await extract(LF_FILE);
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe(LF_FILE);
    expect(tab.range?.endByte).toBe(span(LF_FILE).endByte);
  });

  it('writes one selected blank line back unchanged', async () => {
    disk = enc('a\n\nc\n');
    backend();
    await documentWindow.createRangeTab(SRC, {
      startByte: 2,
      endByte: 3,
      startLine: 2,
      endLine: 2,
    });
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('a\n\nc\n');
  });

  it('puts back a CRLF break and rebases the end byte over two saves', async () => {
    const tab = await extract(CRLF_FILE);
    expect(tab.lineEnding).toBe('CRLF');
    type(tab, 'line2\nline3\nline4\nZZ');
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe(
      'line1\r\nline2\r\nline3\r\nline4\r\nZZ\r\nline5\r\n',
    );
    expect(tab.range?.endByte).toBe(
      enc('line1\r\nline2\r\nline3\r\nline4\r\nZZ\r\n').length,
    );
    type(tab, 'line2\nline3\nline4\nZZYY');
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe(
      'line1\r\nline2\r\nline3\r\nline4\r\nZZYY\r\nline5\r\n',
    );
    expect(tab.range?.endByte).toBe(
      enc('line1\r\nline2\r\nline3\r\nline4\r\nZZYY\r\n').length,
    );
  });

  it('rebases the end byte over the break it added, for LF', async () => {
    const tab = await extract(LF_FILE);
    type(tab, 'line2\nline3\nline4\nZZ');
    await documentWindow.rangeSave();
    expect(tab.range?.endByte).toBe(
      enc('line1\nline2\nline3\nline4\nZZ\n').length,
    );
    type(tab, 'line2\nline3\nline4\nZZYY');
    await documentWindow.rangeSave();
    expect(fileText()).toBe('line1\nline2\nline3\nline4\nZZYY\nline5\n');
  });
});

describe('a range that reaches the end of a file with no final break', () => {
  it('writes typed text without an added break', async () => {
    disk = enc('line1\nline2\nline3');
    backend();
    await documentWindow.createRangeTab(SRC, {
      startByte: 6,
      endByte: disk.length,
      startLine: 2,
      endLine: 3,
    });
    const tab = documentWindow.tabs[0]!;
    expect(tab.range?.trailingBreak).toBe(false);
    type(tab, 'line2\nline3ZZ');
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline2\nline3ZZ');
  });
});

describe('emptying a range tab', () => {
  it('removes the whole span on save, for LF', async () => {
    const tab = await extract(LF_FILE);
    type(tab, '');
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline5\n');
    expect(tab.range?.endByte).toBe(tab.range?.startByte);
  });

  it('removes the whole span on save, for CRLF', async () => {
    const tab = await extract(CRLF_FILE);
    type(tab, '');
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\r\nline5\r\n');
  });

  it('writes nothing on a second save, and text typed afterwards gets its own break', async () => {
    const tab = await extract(LF_FILE);
    type(tab, '');
    await documentWindow.rangeSave();
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline5\n');
    type(tab, 'new');
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\nnew\nline5\n');
  });
});

describe('restoring a range tab', () => {
  it('opens a clean record without the field as it always did, and saves it unchanged', async () => {
    const tab = await restoreFrom(LF_FILE, {});
    expect(tab.range?.trailingBreak).toBe(true);
    expect(tab.content.toString()).toBe('line2\nline3\nline4\n');
    expect(documentWindow.isDirty(tab)).toBe(false);
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe(LF_FILE);
  });

  it('restores an old dirty record as stored, and saves it with the break', async () => {
    const tab = await restoreFrom(LF_FILE, {
      dirty: true,
      content: 'line2\nline3\nline4\nZZ',
    });
    expect(tab.content.toString()).toBe('line2\nline3\nline4\nZZ');
    expect(documentWindow.isDirty(tab)).toBe(true);
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline2\nline3\nline4\nZZ\nline5\n');
  });

  it('uses the stored flag when the record has one', async () => {
    const tab = await restoreFrom(LF_FILE, {
      range_trailing_break: false,
      dirty: true,
      content: 'line2\nline3\nline4\nZZ',
    });
    expect(tab.range?.trailingBreak).toBe(false);
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline2\nline3\nline4\nZZline5\n');
  });

  it('derives false for an old record whose slice has no final break', async () => {
    const file = 'line1\nline2\nline3';
    disk = enc(file);
    backend([
      record({
        range_start: 6,
        range_end: disk.length,
        range_fp_size: disk.length,
        range_fp_mtime: mtime,
        dirty: true,
        content: 'line2\nline3ZZ',
      }),
    ]);
    await documentWindow.init('g', null, null);
    const tab = documentWindow.tabs[0]!;
    expect(tab.range?.trailingBreak).toBe(false);
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline2\nline3ZZ');
  });

  it('restores a dirty record whose buffer is empty, and removes the span on save', async () => {
    const tab = await restoreFrom(LF_FILE, { dirty: true, content: '' });
    expect(documentWindow.isDirty(tab)).toBe(true);
    expect(await documentWindow.rangeSave()).toBe('ok');
    expect(fileText()).toBe('line1\nline5\n');
  });
});

describe('save as from a range tab', () => {
  const noEditorRequest = (): void => {
    expect('appendRequest' in documentWindow).toBe(false);
  };

  it('writes the buffer as it always did, for LF', async () => {
    const tab = await extract(LF_FILE);
    expect(await documentWindow.saveAs('/tmp/out.txt')).toBe(true);
    expect(written).toEqual([
      { path: '/tmp/out.txt', content: 'line2\nline3\nline4\n' },
    ]);
    expect(tab.range).toBeUndefined();
    expect(tab.content.toString()).toBe('line2\nline3\nline4\n');
    expect(documentWindow.isDirty(tab)).toBe(false);
    noEditorRequest();
  });

  it('writes the buffer as it always did, for CRLF', async () => {
    const tab = await extract(CRLF_FILE);
    type(tab, 'line2\nline3\nline4\nZZ');
    expect(await documentWindow.saveAs('/tmp/out.txt')).toBe(true);
    expect(written[0]!.content).toBe('line2\r\nline3\r\nline4\r\nZZ');
    expect(tab.content.toString()).toBe('line2\nline3\nline4\nZZ');
    noEditorRequest();
  });

  it('leaves the buffer alone after a Backspace at the end, so undo is unaffected', async () => {
    const tab = await extract(LF_FILE);
    type(tab, 'line2\nline3\nline4');
    const before = tab.content.toString();
    expect(await documentWindow.saveAs('/tmp/out.txt')).toBe(true);
    expect(written[0]!.content).toBe('line2\nline3\nline4');
    expect(tab.content.toString()).toBe(before);
    noEditorRequest();
  });

  it('writes an emptied buffer as an empty file', async () => {
    const tab = await extract(LF_FILE);
    type(tab, '');
    expect(await documentWindow.saveAs('/tmp/out.txt')).toBe(true);
    expect(written).toEqual([{ path: '/tmp/out.txt', content: '' }]);
  });
});

describe('save as from the range conflict dialog', () => {
  async function conflict(file: string): Promise<DocTab> {
    const tab = await extract(file);
    spliceError = 'fingerprint-mismatch';
    expect(await documentWindow.rangeSave()).toBe('mismatch');
    expect(documentWindow.rangeConflict).toBe(tab);
    return tab;
  }

  it('writes the buffer as it always did, for LF', async () => {
    const tab = await conflict(LF_FILE);
    expect(await documentWindow.rangeConflictSaveAs('/tmp/out.txt')).toBe(true);
    expect(written).toEqual([
      { path: '/tmp/out.txt', content: 'line2\nline3\nline4\n' },
    ]);
    expect(tab.range).toBeUndefined();
    expect(tab.content.toString()).toBe('line2\nline3\nline4\n');
    expect(documentWindow.isDirty(tab)).toBe(false);
  });

  it('writes the buffer as it always did, for CRLF', async () => {
    const tab = await conflict(CRLF_FILE);
    type(tab, 'line2\nline3\nline4\nZZ');
    expect(await documentWindow.rangeConflictSaveAs('/tmp/out.txt')).toBe(true);
    expect(written[0]!.content).toBe('line2\r\nline3\r\nline4\r\nZZ');
  });
});

describe('the label of a range tab', () => {
  it('shows the selected lines for an untouched tab', async () => {
    const tab = await extract(LF_FILE);
    expect(rangeDisplayName(tab)).toBe(
      t('doc.range.displayName', { name: 'src.txt', start: 2, end: 4 }),
    );
  });

  it('follows text typed on the empty last line', async () => {
    const tab = await extract(LF_FILE);
    type(tab, 'line2\nline3\nline4\nZZ');
    expect(rangeDisplayName(tab)).toBe(
      t('doc.range.displayName', { name: 'src.txt', start: 2, end: 5 }),
    );
  });

  it('counts a selection of one blank line as one line', async () => {
    disk = enc('a\n\nc\n');
    backend();
    await documentWindow.createRangeTab(SRC, {
      startByte: 2,
      endByte: 3,
      startLine: 2,
      endLine: 2,
    });
    expect(rangeDisplayName(documentWindow.tabs[0]!)).toBe(
      t('doc.range.displayName', { name: 'src.txt', start: 2, end: 2 }),
    );
  });
});

describe('persisting a range tab', () => {
  it('stores the flag and the live end line, with empty content when clean', async () => {
    const tab = await extract(LF_FILE);
    type(tab, 'line2\nline3\nline4\nnew5\nnew6\n');
    expect(await documentWindow.rangeSave()).toBe('ok');
    const last = upserts[upserts.length - 1]!;
    expect(last.content).toBe('');
    expect(last.dirty).toBe(false);
    expect(last.range_trailing_break).toBe(true);
    expect(last.range_start_line).toBe(2);
    expect(last.range_end_line).toBe(6);
    expect(docLabel(last)).toBe(
      t('doc.range.displayName', { name: 'src.txt', start: 2, end: 6 }),
    );
    expect(docLabel(last)).toBe(rangeDisplayName(tab));
  });

  it('stores the flag as false when the slice had no final break', async () => {
    disk = enc('line1\nline2');
    backend();
    await documentWindow.createRangeTab(SRC, {
      startByte: 6,
      endByte: 11,
      startLine: 2,
      endLine: 2,
    });
    expect(upserts[upserts.length - 1]!.range_trailing_break).toBe(false);
  });
});
