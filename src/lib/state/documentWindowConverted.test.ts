// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The tabs a paste turns into large files: how they are installed, saved for the
// first time, restored, discarded and closed (the part of the conversion that
// lives in the document window state).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { NoteSnapshot } from './stickyNote.svelte';
import { editionState } from './edition.svelte';
import { convertController } from './convertController.svelte';
import {
  documentWindow,
  LARGE_FILE_THRESHOLD,
  type ClaimedHandoff,
  type ConvertedTab,
  type DocTab,
} from './documentWindow.svelte';
import { t } from '../i18n';
import { applyToSavedState } from '../util/pasteFlow';
import { pasteSpec } from '../util/replayKeys';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.stubGlobal('window', globalThis);

const mockInvoke = vi.mocked(invoke);
const mockSave = vi.mocked(save);

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;
const OPEN = {
  session_id: 41,
  total_bytes: 900,
  total_lines: 9,
  fingerprint: { size: 900, mtime_ms: 5 },
};
const SAVED = {
  fingerprint: { size: 901, mtime_ms: 6 },
  total_bytes: 901,
  total_lines: 9,
  clean: true,
  generation: 3,
  conv: null as null | { encoding: string; bom: boolean; in_place: boolean },
};
const INDEX = {
  index: { checkpoints: [[0, 0]], total_newlines: 8 },
  fingerprint: { size: 901, mtime_ms: 6 },
  digest: '77',
};
const DEFAULTS: Record<string, Handler> = {
  windowed_open_converted: () => OPEN,
  windowed_reopen_converted: () => ({ ...OPEN, session_id: 42 }),
  convert_from_file: () => 'cvf1',
  windowed_save: () => SAVED,
  windowed_index: () => INDEX,
  windowed_set_encoding: (a) => ({
    encoding: a.encoding,
    bom: a.withBom,
    in_place: true,
  }),
  stat_file: () => ({ size: 10 }),
  read_file_auto: () => ({
    content: 'disk\n',
    encoding: 'UTF-8',
    had_bom: false,
    lossy: false,
  }),
  path_writable: () => true,
  list_notes: () => [],
};
function backend(over: Record<string, Handler> = {}) {
  const calls: { cmd: string; args: Args }[] = [];
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(((cmd: string, args?: Args) => {
    calls.push({ cmd, args: args ?? {} });
    const h = over[cmd] ?? DEFAULTS[cmd];
    if (h === undefined) {
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(h(args ?? {}));
    } catch (e) {
      return Promise.reject(e);
    }
  }) as typeof invoke);
  return {
    calls,
    named: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    names: () => calls.map((c) => c.cmd),
    /** The records written, oldest first. */
    records: () =>
      calls
        .filter((c) => c.cmd === 'upsert_note')
        .map((c) => c.args.note as NoteSnapshot),
  };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    await Promise.resolve();
  }
};
function reset(): void {
  documentWindow.tabs.length = 0;
  documentWindow.saveFailed = null;
  documentWindow.discardFailed = null;
  documentWindow.windowedConflict = null;
  convertController.cancelAll();
  while (convertController.dialog !== null) {
    convertController.answer('cancel');
  }
  editionState.lite = false;
  mockSave.mockReset();
}
function baseTab(over: Partial<DocTab>): DocTab {
  return {
    id: 'doc1',
    path: '/d/a.txt',
    readOnlyFile: false,
    content: Text.of(['hello']),
    savedContent: Text.of(['hello']),
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
function pushTab(over: Partial<DocTab> = {}): DocTab {
  reset();
  const tab = baseTab(over);
  documentWindow.tabs.push(tab);
  documentWindow.activeIndex = 0;
  return tab;
}
/** A tab a paste made, unsaved, as `installConverted` leaves it. */
function pushConverted(
  conv: Partial<ConvertedTab> = {},
  over: Partial<DocTab> = {},
): DocTab {
  const target = conv.target === undefined ? '/d/a.txt' : conv.target;
  return pushTab({
    path: target ?? '',
    content: Text.empty,
    savedContent: Text.empty,
    insertLineEnding: '\n',
    windowed: {
      sessionId: 41,
      totalBytes: 900,
      totalLines: 9,
      fingerprint: { size: 900, mtime_ms: 5 },
      dirty: true,
      topLine: 0,
    },
    converted: {
      target,
      encoding: 'UTF-8',
      bom: false,
      origin: target === null ? 'untitled' : 'document',
      saved: false,
      ...conv,
    },
    ...over,
  });
}
function note(over: Partial<NoteSnapshot>): NoteSnapshot {
  return {
    id: 'doc1',
    content: '',
    file_path: '/d/a.txt',
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
    window_group: 'g1',
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

beforeEach(() => {
  vi.spyOn(editionState, 'ready').mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

describe('installConverted turns a tab into an unsaved large-file tab', () => {
  it('opens the session over the conversion file in the encoding of the tab, unsaved', async () => {
    const b = backend();
    const tab = pushTab({
      encoding: 'Shift_JIS',
      hadBom: false,
      lineEnding: 'CRLF',
    });
    await documentWindow.installConverted('doc1', 'cv9');
    expect(b.named('windowed_open_converted')[0]?.args).toEqual({
      convertId: 'cv9',
      target: '/d/a.txt',
      encoding: 'Shift_JIS',
      withBom: false,
      dirty: true,
    });
    expect(tab.windowed).toMatchObject({ sessionId: 41, dirty: true });
    expect(tab.converted).toEqual({
      target: '/d/a.txt',
      encoding: 'Shift_JIS',
      bom: false,
      origin: 'document',
      saved: false,
    });
    expect(tab.insertLineEnding).toBe('\r\n');
    expect(tab.encoding).toBe('Shift_JIS');
    expect(tab.content.length).toBe(0);
    // The quit and close gates see an unsaved large-file tab.
    expect(documentWindow.firstOversizedDirtyIndex()).toBe(0);
    expect(documentWindow.isDirty(tab)).toBe(true);
  });
  it('is an untitled tab without a target, with a BOM kept', async () => {
    backend();
    const tab = pushTab({ path: '', hadBom: true });
    await documentWindow.installConverted('doc1', 'cv9');
    expect(tab.converted).toMatchObject({
      target: null,
      bom: true,
      origin: 'untitled',
    });
    expect(tab.hadBom).toBe(true);
  });
  it('leaves the tab as it was when the session cannot be opened', async () => {
    backend({
      windowed_open_converted: () => {
        throw 'too-large';
      },
    });
    const tab = pushTab();
    const content = tab.content;
    await expect(documentWindow.installConverted('doc1', 'cv9')).rejects.toBe(
      'too-large',
    );
    expect(tab.windowed).toBeUndefined();
    expect(tab.converted).toBeUndefined();
    expect(tab.content).toBe(content);
    expect(documentWindow.isDirty(tab)).toBe(false);
  });
  it('drops the session of a tab that was closed during the open', async () => {
    let finish: (v: unknown) => void = () => {};
    const b = backend({
      windowed_open_converted: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    pushTab();
    const done = documentWindow.installConverted('doc1', 'cv9');
    await flush();
    documentWindow.tabs.length = 0;
    finish(OPEN);
    await expect(done).rejects.toThrow('the tab is gone');
    expect(b.named('windowed_close')[0]?.args).toEqual({ sessionId: 41 });
  });
  it('is the host a conversion talks to', async () => {
    backend();
    pushTab({ encoding: 'Shift_JIS', lineEnding: 'CRLF' });
    const host = documentWindow.convertHost();
    expect(host.tab('doc1')).toEqual({
      path: '/d/a.txt',
      encoding: 'Shift_JIS',
      hadBom: false,
      lineEnding: 'CRLF',
      language: null,
    });
    expect(host.tab('other')).toBeNull();
    await host.install('doc1', 'cv9');
    expect(documentWindow.tabs[0]?.converted?.saved).toBe(false);
  });
});

describe('an unsaved converted tab leaves its record as it was', () => {
  it('writes nothing on persist, switch, update by id, flush all and bounds', async () => {
    const b = backend();
    pushTab({ id: 'other', tabIndex: 1, path: '/d/o.txt' });
    const tab = baseTab({ id: 'doc1' });
    documentWindow.tabs.push(tab);
    await documentWindow.switchTo(1);
    await documentWindow.installConverted('doc1', 'cv9');
    b.calls.length = 0;
    documentWindow.windowedTopLineChanged(3);
    documentWindow.updateContentById('doc1', Text.of(['x']));
    documentWindow.setBounds(1, 2, 3, 4);
    await documentWindow.switchTo(0);
    await documentWindow.switchTo(1);
    await documentWindow.flushAll();
    await flush();
    const written = b.records().map((r) => r.id);
    expect(written).not.toContain('doc1');
    // The tab next to it is written as always.
    expect(written).toContain('other');
  });
  it('writes the tab once it is saved', async () => {
    const b = backend();
    const tab = pushConverted({ saved: true });
    documentWindow.setBounds(1, 2, 3, 4);
    await flush();
    expect(b.records().map((r) => r.id)).toEqual([tab.id]);
  });
});

describe('the first save of a converted tab', () => {
  it('saveActive(path) of an untitled tab writes that path, never an in-place save', async () => {
    const b = backend();
    const tab = pushConverted({ target: null });
    expect(await documentWindow.saveActive('/d/new.txt')).toBe(true);
    const saves = b.named('windowed_save');
    expect(saves).toHaveLength(1);
    expect(saves[0]?.args).toEqual({
      sessionId: 41,
      expected: null,
      pathOverride: '/d/new.txt',
    });
    expect(tab.path).toBe('/d/new.txt');
    expect(tab.converted).toBeUndefined();
    expect(tab.windowed?.dirty).toBe(false);
    const record = b.records().at(-1);
    expect(record).toMatchObject({
      id: 'doc1',
      file_path: '/d/new.txt',
      windowed_encoding: null,
    });
    expect(record?.windowed_index).not.toBeNull();
    expect(b.named('convert_sticky_saved')).toEqual([]);
  });
  it('saveActive() asks where an untitled tab goes and never writes without a path', async () => {
    const b = backend();
    pushConverted({ target: null });
    mockSave.mockResolvedValueOnce('/d/asked.txt');
    expect(await documentWindow.saveActive()).toBe(true);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(
      b.named('windowed_save').some((c) => c.args.pathOverride === null),
    ).toBe(false);
    expect(b.named('windowed_save')[0]?.args.pathOverride).toBe('/d/asked.txt');
  });
  it('saveActive() of an untitled tab writes nothing when the dialog is cancelled', async () => {
    const b = backend();
    const tab = pushConverted({ target: null });
    mockSave.mockResolvedValueOnce(null);
    expect(await documentWindow.saveActive()).toBe(false);
    expect(b.named('windowed_save')).toEqual([]);
    expect(tab.converted?.saved).toBe(false);
  });
  it('saveAs(path) gives the record of a tab with a path, and is the first save', async () => {
    const b = backend();
    const tab = pushConverted();
    expect(await documentWindow.saveAs('/d/copy.txt')).toBe(true);
    expect(tab.converted).toBeUndefined();
    expect(b.records().at(-1)).toMatchObject({ file_path: '/d/copy.txt' });
  });
  it('a conflict "save as new" is a first save too', async () => {
    const b = backend();
    const tab = pushConverted();
    documentWindow.windowedConflict = tab;
    expect(await documentWindow.windowedConflictSaveAs('/d/other.txt')).toBe(
      true,
    );
    expect(tab.converted).toBeUndefined();
    expect(b.records().at(-1)).toMatchObject({ file_path: '/d/other.txt' });
  });
  it('a save in place writes the target with the comparison', async () => {
    const b = backend();
    const tab = pushConverted();
    expect(await documentWindow.saveActive()).toBe(true);
    expect(b.named('windowed_save')[0]?.args).toEqual({
      sessionId: 41,
      expected: { size: 900, mtime_ms: 5 },
      pathOverride: null,
    });
    expect(tab.converted).toBeUndefined();
  });
  it('a note takes its record away at the first save, by either way, once', async () => {
    for (const via of ['saveActive', 'saveAs'] as const) {
      const b = backend();
      const tab = pushConverted(
        { target: null, origin: 'sticky', noteId: 'n1' },
        { id: `tab-${via}` },
      );
      await documentWindow[via]('/d/n.txt');
      expect(b.named('convert_sticky_saved')).toEqual([
        { cmd: 'convert_sticky_saved', args: { noteId: 'n1' } },
      ]);
      // The record of the tab is written after the note's is gone.
      expect(b.names().indexOf('convert_sticky_saved')).toBeLessThan(
        b.names().indexOf('upsert_note'),
      );
      expect(tab.converted).toBeUndefined();
    }
  });
  it('does not take the note away twice when the tab stays converted', async () => {
    const b = backend({
      windowed_save: () => ({
        ...SAVED,
        conv: { encoding: 'Shift_JIS', bom: false, in_place: true },
      }),
    });
    pushConverted({
      target: null,
      origin: 'sticky',
      noteId: 'n1',
      encoding: 'Shift_JIS',
    });
    await documentWindow.saveAs('/d/n.txt');
    await documentWindow.saveActive();
    expect(b.named('convert_sticky_saved')).toHaveLength(1);
  });
  it('keeps a tab that is written in another encoding converted, with its record carrying the encoding', async () => {
    const b = backend({
      windowed_save: () => ({
        ...SAVED,
        conv: { encoding: 'Shift_JIS', bom: false, in_place: true },
      }),
    });
    const tab = pushConverted({ encoding: 'Shift_JIS' });
    await documentWindow.saveActive();
    expect(tab.converted).toEqual({
      target: '/d/a.txt',
      encoding: 'Shift_JIS',
      bom: false,
      origin: 'document',
      saved: true,
    });
    const record = b.records().at(-1);
    expect(record).toMatchObject({
      file_path: '/d/a.txt',
      windowed_encoding: 'Shift_JIS',
      windowed_bom: false,
    });
    // The encoding tells this record from a plain one; the index is not kept.
    expect(b.named('windowed_index').length).toBeGreaterThan(0);
    expect(record?.windowed_index).toBeNull();
    expect(record?.windowed_fp_size).not.toBeNull();
    expect(record?.windowed_digest).not.toBeNull();
    expect(record?.large).toBe(INDEX.fingerprint.size);
  });
  it('keeps the BOM of a UTF-8 file with one', async () => {
    const b = backend({
      windowed_save: () => ({
        ...SAVED,
        conv: { encoding: 'UTF-8', bom: true, in_place: true },
      }),
    });
    pushConverted({ encoding: 'UTF-8', bom: true });
    await documentWindow.saveActive();
    expect(b.records().at(-1)).toMatchObject({
      windowed_encoding: 'UTF-8',
      windowed_bom: true,
    });
  });
  it('a plain tab is saved as it always was', async () => {
    const b = backend();
    const tab = pushTab({
      windowed: {
        sessionId: 41,
        totalBytes: 1,
        totalLines: 1,
        fingerprint: { size: 1, mtime_ms: 1 },
        dirty: true,
        topLine: 0,
      },
    });
    await documentWindow.saveActive();
    expect(tab.converted).toBeUndefined();
    expect(b.records().at(-1)).toMatchObject({ windowed_encoding: null });
  });
});

describe('D13, a save that cannot write the text in the encoding', () => {
  const unmappableOnce = () => {
    let first = true;
    return {
      windowed_save: (): unknown => {
        if (first) {
          first = false;
          throw 'unmappable';
        }
        return SAVED;
      },
    };
  };
  const shiftJis = { encoding: 'Shift_JIS' };
  it('asks with the file and the encoding, and offers the three ways out', async () => {
    backend(unmappableOnce());
    pushConverted(shiftJis);
    const saving = documentWindow.saveActive();
    await flush();
    const d = convertController.dialog;
    expect(d?.kind).toBe('unmappable');
    expect(d?.message).toBe(
      t('convert.unmappable', { name: 'a.txt', encoding: 'Shift_JIS' }),
    );
    expect(d?.primary).toBe(t('convert.unmappable.utf8'));
    expect(d?.secondary).toBe(t('convert.unmappable.saveAs'));
    expect(d?.cancel).toBe(t('common.cancel'));
    convertController.answer('cancel');
    expect(await saving).toBe(false);
  });
  it('"UTF-8 to the original path" changes the encoding of the session and saves again', async () => {
    const b = backend(unmappableOnce());
    const tab = pushConverted(shiftJis);
    const saving = documentWindow.saveActive();
    await flush();
    convertController.answer('primary');
    expect(await saving).toBe(true);
    expect(b.named('windowed_set_encoding')[0]?.args).toEqual({
      sessionId: 41,
      encoding: 'UTF-8',
      withBom: false,
    });
    expect(b.named('windowed_save')).toHaveLength(2);
    expect(b.named('windowed_save')[1]?.args.pathOverride).toBeNull();
    expect(tab.encoding).toBe('UTF-8');
    expect(tab.converted).toBeUndefined();
  });
  it('"save as UTF-8" asks for a file and writes it there', async () => {
    const b = backend(unmappableOnce());
    const tab = pushConverted(shiftJis);
    mockSave.mockResolvedValueOnce('/d/u.txt');
    const saving = documentWindow.saveActive();
    await flush();
    convertController.answer('secondary');
    expect(await saving).toBe(true);
    expect(b.named('windowed_set_encoding')).toHaveLength(1);
    expect(b.named('windowed_save')[1]?.args.pathOverride).toBe('/d/u.txt');
    expect(tab.path).toBe('/d/u.txt');
  });
  it('"save as UTF-8" with the dialog cancelled changes neither the session nor the tab', async () => {
    const b = backend(unmappableOnce());
    const tab = pushConverted(shiftJis);
    const before = {
      encoding: tab.encoding,
      hadBom: tab.hadBom,
      converted: { ...tab.converted },
    };
    mockSave.mockResolvedValueOnce(null);
    const saving = documentWindow.saveActive();
    await flush();
    convertController.answer('secondary');
    expect(await saving).toBe(false);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(b.named('windowed_set_encoding')).toEqual([]);
    expect(b.named('windowed_save')).toHaveLength(1);
    expect(tab.encoding).toBe(before.encoding);
    expect(tab.hadBom).toBe(before.hadBom);
    expect({ ...tab.converted }).toEqual(before.converted);
    expect(documentWindow.saveFailed).toBeNull();
  });
  it('"save as UTF-8" switches the session only once a path is chosen, then saves', async () => {
    const b = backend(unmappableOnce());
    pushConverted(shiftJis);
    mockSave.mockResolvedValueOnce('/d/u.txt');
    const saving = documentWindow.saveActive();
    await flush();
    convertController.answer('secondary');
    expect(await saving).toBe(true);
    const sequence = b
      .names()
      .filter((n) => n === 'windowed_set_encoding' || n === 'windowed_save');
    expect(sequence).toEqual([
      'windowed_save',
      'windowed_set_encoding',
      'windowed_save',
    ]);
    const setAt = mockInvoke.mock.calls.findIndex(
      (c) => c[0] === 'windowed_set_encoding',
    );
    expect(mockSave.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvoke.mock.invocationCallOrder[setAt] ?? 0,
    );
  });
  it('"cancel" leaves the tab unsaved and says nothing', async () => {
    const b = backend(unmappableOnce());
    const tab = pushConverted(shiftJis);
    const saving = documentWindow.saveActive();
    await flush();
    convertController.answer('cancel');
    expect(await saving).toBe(false);
    expect(b.named('windowed_set_encoding')).toEqual([]);
    expect(b.named('windowed_save')).toHaveLength(1);
    expect(tab.converted?.saved).toBe(false);
    expect(tab.windowed?.dirty).toBe(true);
    expect(documentWindow.saveFailed).toBeNull();
  });
  it('without a target "UTF-8 to the original path" asks for a file, as a save as does', async () => {
    let first = true;
    const b = backend({
      windowed_save: () => {
        if (first) {
          first = false;
          throw 'unmappable';
        }
        return SAVED;
      },
    });
    const tab = pushConverted({ target: null, ...shiftJis });
    mockSave.mockResolvedValueOnce('/d/second.txt');
    const saving = documentWindow.saveWindowed(tab, false);
    await flush();
    convertController.answer('primary');
    expect(await saving).toBe('ok');
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(b.named('windowed_set_encoding')).toHaveLength(1);
    expect(b.named('windowed_save')[1]?.args.pathOverride).toBe(
      '/d/second.txt',
    );
  });
  it('a save as that fails is saved again to the same path with "UTF-8"', async () => {
    let first = true;
    const b = backend({
      windowed_save: (a) => {
        if (first) {
          first = false;
          throw 'unmappable';
        }
        return { ...SAVED, path: a.pathOverride };
      },
    });
    const tab = pushConverted({ target: null, ...shiftJis });
    const saving = documentWindow.saveAs('/d/first.txt');
    await flush();
    convertController.answer('primary');
    expect(await saving).toBe(true);
    expect(b.named('windowed_save')[1]?.args.pathOverride).toBe('/d/first.txt');
    expect(tab.path).toBe('/d/first.txt');
  });
});

describe('a restart restores a converted tab by what its record says', () => {
  const big = 200 * 1024 * 1024;
  const record = (over: Partial<NoteSnapshot> = {}) =>
    note({
      id: 'r1',
      large: big,
      windowed_index: { checkpoints: [[0, 0]], total_newlines: 5 },
      windowed_fp_size: big,
      windowed_fp_mtime: 7,
      windowed_digest: '5',
      windowed_top_line: 4,
      ...over,
    });
  it('row 1, converted and unsaved: the record of before the paste, as it was', async () => {
    reset();
    backend({
      list_notes: () => [
        note({
          id: 'r0',
          content: 'before the paste',
          dirty: true,
          file_path: '/d/a.txt',
        }),
      ],
    });
    await documentWindow.init('g1', null, null);
    const tab = documentWindow.tabs[0]!;
    expect(tab.content.toString()).toBe('before the paste');
    expect(documentWindow.isDirty(tab)).toBe(true);
    expect(tab.windowedRestore).toBeUndefined();
  });
  it('row 2, saved as UTF-8 without BOM: a plain large-file tab', async () => {
    reset();
    const b = backend({
      list_notes: () => [record()],
      windowed_reopen: () => ({ ...OPEN, rescanned: false }),
    });
    await documentWindow.init('g1', null, null);
    await vi.waitFor(() => {
      expect(documentWindow.tabs[0]?.windowed).toBeDefined();
    });
    const tab = documentWindow.tabs[0]!;
    expect(tab.converted).toBeUndefined();
    expect(b.named('windowed_reopen')).toHaveLength(1);
    expect(b.named('convert_from_file')).toEqual([]);
  });
  it('row 3, saved in another encoding: through the decoded file, never windowed_reopen', async () => {
    reset();
    const b = backend({
      list_notes: () => [
        record({ windowed_encoding: 'Shift_JIS', windowed_bom: false }),
      ],
    });
    await documentWindow.init('g1', null, null);
    await vi.waitFor(() => {
      expect(documentWindow.tabs[0]?.windowed).toBeDefined();
    });
    const tab = documentWindow.tabs[0]!;
    expect(b.names().filter((n) => n.startsWith('windowed_'))).toEqual([
      'windowed_reopen_converted',
      'windowed_index',
    ]);
    expect(b.named('convert_from_file')[0]?.args).toEqual({
      path: '/d/a.txt',
      encoding: 'Shift_JIS',
      withBom: false,
    });
    expect(b.named('windowed_reopen_converted')[0]?.args).toEqual({
      convertId: 'cvf1',
      target: '/d/a.txt',
      encoding: 'Shift_JIS',
      withBom: false,
    });
    expect(b.named('windowed_reopen')).toEqual([]);
    expect(b.named('windowed_open_converted')).toEqual([]);
    expect(tab.encoding).toBe('Shift_JIS');
    expect(tab.windowed?.dirty).toBe(false);
    expect(tab.converted).toEqual({
      target: '/d/a.txt',
      encoding: 'Shift_JIS',
      bom: false,
      origin: 'document',
      saved: true,
    });
  });
  it('row 3 again, with a BOM', async () => {
    reset();
    const b = backend({
      list_notes: () => [
        record({ windowed_encoding: 'UTF-8', windowed_bom: true }),
      ],
    });
    await documentWindow.init('g1', null, null);
    await vi.waitFor(() => {
      expect(documentWindow.tabs[0]?.converted).toBeDefined();
    });
    expect(b.named('convert_from_file')[0]?.args.withBom).toBe(true);
    expect(documentWindow.tabs[0]?.hadBom).toBe(true);
  });
  it('row 3, a record with only the encoding: restored as a large-file tab through the decoded file', async () => {
    reset();
    const b = backend({
      list_notes: () => [
        record({
          windowed_index: null,
          windowed_encoding: 'Shift_JIS',
          windowed_bom: false,
        }),
      ],
    });
    await documentWindow.init('g1', null, null);
    await vi.waitFor(() => {
      expect(documentWindow.tabs[0]?.windowed).toBeDefined();
    });
    const tab = documentWindow.tabs[0]!;
    expect(b.named('convert_from_file')).toHaveLength(1);
    expect(b.named('windowed_reopen_converted')).toHaveLength(1);
    expect(b.named('windowed_reopen')).toEqual([]);
    expect(tab.converted).toMatchObject({
      encoding: 'Shift_JIS',
      saved: true,
    });
    expect(tab.large).toBeUndefined();
  });
  it('row 3, an older record with both the index and the encoding: restored the same way', async () => {
    reset();
    const b = backend({
      list_notes: () => [
        record({ windowed_encoding: 'Shift_JIS', windowed_bom: false }),
      ],
    });
    await documentWindow.init('g1', null, null);
    await vi.waitFor(() => {
      expect(documentWindow.tabs[0]?.windowed).toBeDefined();
    });
    expect(b.named('convert_from_file')).toHaveLength(1);
    expect(b.named('windowed_reopen_converted')).toHaveLength(1);
    expect(b.named('windowed_reopen')).toEqual([]);
  });
  it('a snapshot taken while the restore of an encoding-only record is pending still has its size, and loads again as an encoded restore', async () => {
    reset();
    const only = record({
      id: 'r-only',
      windowed_index: null,
      windowed_encoding: 'Shift_JIS',
      windowed_bom: true,
    });
    const first = backend({
      list_notes: () => [only],
      convert_from_file: () => new Promise(() => {}),
    });
    await documentWindow.init('g1', null, null);
    first.calls.length = 0;
    documentWindow.setBounds(1, 2, 3, 4);
    await flush();
    const written = first.records()[0];
    expect(written).toMatchObject({
      windowed_index: null,
      windowed_encoding: 'Shift_JIS',
      windowed_bom: true,
      large: big,
      windowed_fp_size: big,
    });
    reset();
    backend({
      list_notes: () => [written!],
      convert_from_file: () => new Promise(() => {}),
    });
    await documentWindow.init('g1', null, null);
    expect(documentWindow.tabs[0]?.windowedRestore).toMatchObject({
      index: null,
      encoding: 'Shift_JIS',
      bom: true,
      size: big,
    });
  });
  it('row 4, discarded: an ordinary clean tab of the file, with its own record', async () => {
    const b = backend();
    const tab = pushConverted();
    await documentWindow.discardWindowed(tab);
    expect(tab.windowed).toBeUndefined();
    expect(tab.converted).toBeUndefined();
    expect(b.records().at(-1)).toMatchObject({
      id: 'doc1',
      dirty: false,
      file_path: '/d/a.txt',
      windowed_index: null,
      windowed_encoding: null,
    });
  });
  it('a failed restore of an encoded record falls back to the view with the reason', async () => {
    reset();
    backend({
      list_notes: () => [
        record({ windowed_encoding: 'Shift_JIS', windowed_bom: false }),
      ],
      convert_from_file: () => {
        throw 'cannot decode';
      },
    });
    await documentWindow.init('g1', null, null);
    await vi.waitFor(() => {
      expect(documentWindow.tabs[0]?.large?.unlockRefused).toBeDefined();
    });
    expect(documentWindow.tabs[0]?.converted).toBeUndefined();
  });
  it('keeps the encoding in the record written while the restore is pending', async () => {
    reset();
    const b = backend({
      list_notes: () => [
        record({
          id: 'r-pending',
          windowed_encoding: 'Shift_JIS',
          windowed_bom: true,
        }),
      ],
      convert_from_file: () => new Promise(() => {}),
    });
    await documentWindow.init('g1', null, null);
    b.calls.length = 0;
    documentWindow.setBounds(1, 2, 3, 4);
    await flush();
    expect(b.records()[0]).toMatchObject({
      windowed_encoding: 'Shift_JIS',
      windowed_bom: true,
    });
  });
  it('writes the encoding again after the restore, and discard works without windowed_open, also in the free edition', async () => {
    reset();
    const b = backend({
      list_notes: () => [
        record({
          id: 'r-lite',
          windowed_encoding: 'Shift_JIS',
          windowed_bom: false,
        }),
      ],
    });
    await documentWindow.init('g1', null, null);
    await vi.waitFor(() => {
      expect(documentWindow.tabs[0]?.converted).toBeDefined();
    });
    await flush();
    expect(b.records().at(-1)).toMatchObject({
      windowed_encoding: 'Shift_JIS',
    });
    b.calls.length = 0;
    editionState.lite = true;
    const tab = documentWindow.tabs[0]!;
    tab.windowed!.dirty = true;
    await documentWindow.discardWindowed(tab);
    expect(b.named('windowed_open')).toEqual([]);
    expect(b.named('windowed_reopen_converted')).toHaveLength(1);
    expect(b.named('convert_from_file')).toHaveLength(1);
    expect(tab.windowed?.dirty).toBe(false);
    expect(documentWindow.firstOversizedDirtyIndex()).toBe(-1);
  });
  it('reopens in the free edition too', async () => {
    const b = backend();
    editionState.lite = true;
    reset();
    editionState.lite = true;
    const tab = baseTab({
      content: Text.empty,
      savedContent: Text.empty,
      encoding: 'Shift_JIS',
      windowedRestore: {
        index: { checkpoints: [[0, 0]], total_newlines: 1 },
        fingerprint: { size: 1, mtime_ms: 1 },
        digest: '1',
        topLine: 0,
        size: 1,
        encoding: 'Shift_JIS',
        bom: false,
      },
    });
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    await vi.waitFor(() => {
      expect(tab.windowed).toBeDefined();
    });
    expect(b.named('windowed_reopen_converted')).toHaveLength(1);
    expect(b.named('windowed_reopen')).toEqual([]);
  });
});

describe('discarding the changes of a converted tab', () => {
  it('unsaved with a path: reopens the file in place as an ordinary tab, never through windowed_open', async () => {
    const b = backend();
    const tab = pushConverted();
    await documentWindow.discardWindowed(tab);
    expect(b.named('windowed_open')).toEqual([]);
    expect(b.named('windowed_close')[0]?.args).toEqual({ sessionId: 41 });
    expect(tab.id).toBe('doc1');
    expect(tab.windowed).toBeUndefined();
    expect(tab.converted).toBeUndefined();
    expect(tab.path).toBe('/d/a.txt');
    expect(tab.content.toString()).toBe('disk\n');
    expect(documentWindow.isDirty(tab)).toBe(false);
    expect(documentWindow.firstOversizedDirtyIndex()).toBe(-1);
  });
  it('unsaved with a path in a file that is too big for the editor: the view', async () => {
    backend({ stat_file: () => ({ size: LARGE_FILE_THRESHOLD + 1 }) });
    const tab = pushConverted();
    await documentWindow.discardWindowed(tab);
    expect(tab.large).toEqual({ size: LARGE_FILE_THRESHOLD + 1 });
    expect(tab.windowed).toBeUndefined();
  });
  it('unsaved with a path in a file that is gone: a blank tab that knows its file is missing', async () => {
    backend({
      stat_file: () => {
        throw 'file-not-found';
      },
      read_file_auto: () => {
        throw 'file-not-found';
      },
    });
    const tab = pushConverted();
    expect(await documentWindow.discardWindowed(tab)).toBe(true);
    expect(tab.path).toBe('/d/a.txt');
    expect(tab.missing).toBe(true);
    expect(tab.windowed).toBeUndefined();
    expect(documentWindow.discardFailed).toBeNull();
    expect(documentWindow.firstOversizedDirtyIndex()).toBe(-1);
  });
  it('unsaved with a path in a file that exists but cannot be read: the tab stays as it is and the failure is reported', async () => {
    const b = backend({
      stat_file: () => {
        throw 'Permission denied (os error 13)';
      },
      read_file_auto: () => {
        throw 'Permission denied (os error 13)';
      },
    });
    const tab = pushConverted();
    expect(await documentWindow.discardWindowed(tab)).toBe(false);
    expect(documentWindow.discardFailed).toEqual({
      name: 'a.txt',
      error: 'Permission denied (os error 13)',
    });
    expect(tab.windowed?.sessionId).toBe(41);
    expect(tab.converted?.saved).toBe(false);
    expect(tab.missing).toBeUndefined();
    expect(tab.path).toBe('/d/a.txt');
    // The session is not closed nor the tab replaced.
    expect(b.named('windowed_close')).toEqual([]);
    expect(b.named('upsert_note')).toEqual([]);
  });
  it('unsaved and untitled: a blank untitled ordinary tab', async () => {
    const b = backend();
    const tab = pushConverted({ target: null }, { lineEnding: 'CRLF' });
    await documentWindow.discardWindowed(tab);
    expect(b.named('windowed_open')).toEqual([]);
    expect(tab.path).toBe('');
    expect(tab.content.length).toBe(0);
    expect(tab.lineEnding).toBe('CRLF');
    expect(tab.windowed).toBeUndefined();
    expect(tab.converted).toBeUndefined();
    expect(documentWindow.firstOversizedDirtyIndex()).toBe(-1);
  });
  it('unsaved from a note: the tab goes and the note comes back', async () => {
    const b = backend();
    const tab = pushConverted({
      target: null,
      origin: 'sticky',
      noteId: 'n1',
    });
    await documentWindow.discardWindowed(tab);
    expect(documentWindow.tabs).toHaveLength(0);
    expect(b.named('convert_release')).toEqual([
      { cmd: 'convert_release', args: { noteId: 'n1' } },
    ]);
    expect(b.named('windowed_close')).toHaveLength(1);
    expect(b.named('windowed_open')).toEqual([]);
    expect(documentWindow.firstOversizedDirtyIndex()).toBe(-1);
  });
  it('saved in another encoding: decoded again into a new session, also in the free edition', async () => {
    const b = backend();
    editionState.lite = false;
    const tab = pushConverted({
      saved: true,
      encoding: 'Shift_JIS',
      bom: false,
    });
    editionState.lite = true;
    await documentWindow.discardWindowed(tab);
    expect(b.named('windowed_open')).toEqual([]);
    expect(b.named('windowed_reopen')).toEqual([]);
    expect(b.named('convert_from_file')[0]?.args).toEqual({
      path: '/d/a.txt',
      encoding: 'Shift_JIS',
      withBom: false,
    });
    expect(b.named('windowed_reopen_converted')).toHaveLength(1);
    expect(b.named('windowed_close')[0]?.args).toEqual({ sessionId: 41 });
    expect(tab.windowed).toMatchObject({ sessionId: 42, dirty: false });
    expect(tab.converted?.saved).toBe(true);
    expect(documentWindow.firstOversizedDirtyIndex()).toBe(-1);
  });
  it('keeps the session when the file cannot be decoded again', async () => {
    backend({
      convert_from_file: () => {
        throw 'gone';
      },
    });
    const tab = pushConverted({ saved: true, encoding: 'Shift_JIS' });
    expect(await documentWindow.discardWindowed(tab)).toBe(false);
    expect(tab.windowed?.sessionId).toBe(41);
    expect(documentWindow.discardFailed).toEqual({
      name: 'a.txt',
      error: 'gone',
    });
  });
  it('keeps the session and reports it when a plain windowed tab cannot be opened again', async () => {
    const b = backend({
      windowed_open: () => {
        throw 'Permission denied (os error 13)';
      },
    });
    const tab = pushTab({
      windowed: {
        sessionId: 41,
        totalBytes: 1,
        totalLines: 1,
        fingerprint: { size: 1, mtime_ms: 1 },
        dirty: true,
        topLine: 0,
      },
    });
    expect(await documentWindow.discardWindowed(tab)).toBe(false);
    expect(tab.windowed?.sessionId).toBe(41);
    expect(tab.windowed?.dirty).toBe(true);
    expect(b.named('windowed_close')).toEqual([]);
    expect(documentWindow.discardFailed).toEqual({
      name: 'a.txt',
      error: 'Permission denied (os error 13)',
    });
  });
  it('keeps the session and reports it when the free edition cannot reopen the baseline', async () => {
    const b = backend({
      windowed_index: () => {
        throw 'the session is gone';
      },
    });
    const tab = pushTab({
      windowed: {
        sessionId: 41,
        totalBytes: 1,
        totalLines: 1,
        fingerprint: { size: 1, mtime_ms: 1 },
        dirty: true,
        topLine: 0,
      },
    });
    editionState.lite = true;
    expect(await documentWindow.discardWindowed(tab)).toBe(false);
    expect(tab.windowed?.sessionId).toBe(41);
    expect(b.named('windowed_close')).toEqual([]);
    expect(documentWindow.discardFailed).toEqual({
      name: 'a.txt',
      error: 'the session is gone',
    });
  });
  it('names an untitled tab in the report, and dismissing it clears the state', async () => {
    backend({
      convert_from_file: () => {
        throw 'gone';
      },
    });
    const tab = pushConverted(
      { saved: true, encoding: 'Shift_JIS' },
      { path: '' },
    );
    await documentWindow.discardWindowed(tab);
    expect(documentWindow.discardFailed?.name).toBe(t('doc.untitled'));
    documentWindow.dismissDiscardFailed();
    expect(documentWindow.discardFailed).toBeNull();
  });
  it('says it worked, for a plain windowed tab and a tab that is not windowed', async () => {
    backend({ windowed_open: () => ({ ...OPEN, session_id: 43 }) });
    const tab = pushTab({
      windowed: {
        sessionId: 41,
        totalBytes: 1,
        totalLines: 1,
        fingerprint: { size: 1, mtime_ms: 1 },
        dirty: true,
        topLine: 0,
      },
    });
    expect(await documentWindow.discardWindowed(tab)).toBe(true);
    expect(await documentWindow.discardWindowed(baseTab({}))).toBe(true);
    expect(documentWindow.discardFailed).toBeNull();
  });
  it('a plain windowed tab still goes through windowed_open', async () => {
    const b = backend();
    const tab = pushTab({
      windowed: {
        sessionId: 41,
        totalBytes: 1,
        totalLines: 1,
        fingerprint: { size: 1, mtime_ms: 1 },
        dirty: true,
        topLine: 0,
      },
    });
    await documentWindow.discardWindowed(tab);
    expect(b.named('windowed_open')).toHaveLength(1);
  });
});

describe('closing a converted tab without saving', () => {
  it('lets a note go back when its tab is closed unsaved', async () => {
    const b = backend();
    pushConverted({ target: null, origin: 'sticky', noteId: 'n1' });
    await documentWindow.deleteTab(0);
    expect(b.named('convert_release')).toEqual([
      { cmd: 'convert_release', args: { noteId: 'n1' } },
    ]);
    expect(b.named('windowed_close')).toHaveLength(1);
    expect(b.named('delete_note')).toHaveLength(1);
    expect(documentWindow.tabs).toHaveLength(0);
  });
  it('does not release a note whose tab was saved, or a tab of a document', async () => {
    const b = backend();
    pushConverted({
      target: '/d/a.txt',
      origin: 'sticky',
      noteId: 'n1',
      saved: true,
    });
    await documentWindow.deleteTab(0);
    pushConverted();
    await documentWindow.deleteTab(0);
    expect(b.named('convert_release')).toEqual([]);
  });
  it('gives up a conversion still under way for the tab', async () => {
    backend();
    const tab = pushTab();
    const cancel = vi.spyOn(convertController, 'cancelTab');
    await documentWindow.deleteTab(0);
    expect(cancel).toHaveBeenCalledWith(tab.id);
  });
});

describe('a note handed over as a tab', () => {
  const claimed = (over: Partial<ClaimedHandoff> = {}): ClaimedHandoff => ({
    convert_id: 'cv5',
    note_id: 'n1',
    language: null,
    encoding: 'UTF-8',
    line_ending: 'LF',
    ...over,
  });
  it('opens a tab over the file, unsaved, with no target', async () => {
    reset();
    const b = backend();
    const id = await documentWindow.openClaimed(claimed());
    expect(b.named('windowed_open_converted')[0]?.args).toEqual({
      convertId: 'cv5',
      target: null,
      encoding: 'UTF-8',
      withBom: false,
      dirty: true,
    });
    const tab = documentWindow.tabs.find((x) => x.id === id);
    expect(tab?.converted).toEqual({
      target: null,
      encoding: 'UTF-8',
      bom: false,
      origin: 'sticky',
      noteId: 'n1',
      saved: false,
    });
    expect(tab?.lineEnding).toBe('LF');
    expect(tab?.insertLineEnding).toBe('\n');
    expect(tab?.language).toBeNull();
    expect(tab?.windowed?.dirty).toBe(true);
    expect(documentWindow.activeTab?.id).toBe(id);
    expect(b.records()).toEqual([]);
  });
  it('takes the language, the encoding and the line ending the handoff brings', async () => {
    reset();
    const b = backend();
    const id = await documentWindow.openClaimed(
      claimed({
        language: 'markdown',
        encoding: 'Shift_JIS',
        line_ending: 'CRLF',
      }),
    );
    expect(b.named('windowed_open_converted')[0]?.args).toMatchObject({
      convertId: 'cv5',
      encoding: 'Shift_JIS',
      withBom: false,
    });
    const tab = documentWindow.tabs.find((x) => x.id === id);
    expect(tab?.language).toBe('markdown');
    expect(tab?.encoding).toBe('Shift_JIS');
    expect(tab?.converted?.encoding).toBe('Shift_JIS');
    expect(tab?.converted?.bom).toBe(false);
    expect(tab?.lineEnding).toBe('CRLF');
    expect(tab?.savedLineEnding).toBe('CRLF');
    expect(tab?.insertLineEnding).toBe('\r\n');
    expect(tab?.hadBom).toBe(false);
  });
  it('gives back null when it cannot be opened', async () => {
    reset();
    backend({
      windowed_open_converted: () => {
        throw 'refused';
      },
    });
    expect(await documentWindow.openClaimed(claimed())).toBeNull();
    expect(documentWindow.tabs).toHaveLength(0);
  });
});

describe('a paste too big to edit, saved and shown in the view', () => {
  it('makes the tab the view of the saved file, with a record of its own', async () => {
    const b = backend();
    const tab = pushTab({ path: '' });
    await documentWindow.showConvertedViewer('doc1', '/d/big.txt', 600);
    expect(tab.path).toBe('/d/big.txt');
    expect(tab.large).toEqual({ size: 600 });
    expect(tab.content.length).toBe(0);
    expect(documentWindow.isDirty(tab)).toBe(false);
    expect(b.records().at(-1)).toMatchObject({
      file_path: '/d/big.txt',
      large: 600,
    });
  });
});

describe('a paste that finishes while another tab is shown', () => {
  it('puts the pasted text into the tab, makes it unsaved and writes a record with it', async () => {
    const b = backend();
    const a = baseTab({ id: 'a', tabIndex: 0 });
    const other = baseTab({ id: 'b', tabIndex: 1, path: '/d/b.txt' });
    reset();
    documentWindow.tabs.push(a, other);
    documentWindow.activeIndex = 1;
    const states = new Map<string, EditorState>([
      ['a', EditorState.create({ doc: 'hello' })],
    ]);
    const spec = pasteSpec(states.get('a')!, ' there', null);
    applyToSavedState(states, 'a', spec, (id, doc) =>
      documentWindow.updateContentById(id, doc),
    );
    await flush();
    expect(a.content.toString()).toBe(' therehello');
    expect(documentWindow.isDirty(a)).toBe(true);
    expect(b.records().at(-1)).toMatchObject({
      id: 'a',
      content: ' therehello',
      dirty: true,
    });
  });
  it('does nothing for a tab with no saved state', () => {
    const called = vi.fn();
    applyToSavedState(new Map(), 'x', {}, called);
    expect(called).not.toHaveBeenCalled();
  });
});

describe('the automation reading of a converted tab', () => {
  it('shows what a paste left on the tab and what the session writes', async () => {
    backend();
    pushConverted({ encoding: 'Shift_JIS' });
    const info = await documentWindow.convertTabInfo();
    expect(info.converted).toMatchObject({
      encoding: 'Shift_JIS',
      saved: false,
    });
    expect(info.dirty).toBe(true);
    expect(info.conv).toEqual({
      encoding: 'Shift_JIS',
      bom: false,
      in_place: true,
    });
  });
});
