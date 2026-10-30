// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { ClipInfo } from '../util/clipRouting';
import { CONVERT_CHUNK } from '../util/convertStream';
import type { ConversionRequest } from '../util/pasteFlow';
import { t } from '../i18n';
import { settingsState } from './settings.svelte';
import {
  ConvertController,
  type ConvertTabInfo,
  type DocConvertHost,
  type StickyConvertHost,
} from './convertController.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
const mockInvoke = vi.mocked(invoke);
const mockSave = vi.mocked(save);

type Handler = (args: Record<string, unknown>) => unknown;
/** The core, as far as a conversion talks to it. */
function core(over: Record<string, Handler> = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, Handler> = {
    convert_begin: () => 'cv1',
    convert_append: () => undefined,
    convert_append_clip: () => undefined,
    convert_append_clip_line: () => undefined,
    convert_finish: () => ({ bytes: 10, editable: true }),
    convert_abort: () => undefined,
    convert_save: () => ({ size: 77, mtime_ms: 1 }),
    convert_handoff_start: () => 5,
    file_fingerprint: () => ({ size: 3, mtime_ms: 4 }),
    ...over,
  };
  mockInvoke.mockImplementation((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    const h = handlers[cmd];
    if (h === undefined) {
      return Promise.resolve(undefined);
    }
    try {
      return Promise.resolve(h((args ?? {}) as Record<string, unknown>));
    } catch (e) {
      return Promise.reject(e);
    }
  });
  return {
    calls,
    named: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    names: () => calls.map((c) => c.cmd),
  };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    await Promise.resolve();
  }
};
const clip = (over: Partial<ClipInfo> = {}): ClipInfo => ({
  id: 'clip1',
  bytes: 5,
  lines: 1,
  utf16_len: 5,
  crlf: 0,
  linewise: false,
  ...over,
});
interface Setup {
  controller: ConvertController;
  /** What the window says of the tab; a test may change it. */
  info: ConvertTabInfo;
  unlock: ReturnType<typeof vi.fn>;
  request: ConversionRequest;
  /** Lets go of the pin of a clip source. */
  release: ReturnType<typeof vi.fn>;
  doc: DocConvertHost & {
    install: ReturnType<typeof vi.fn>;
    showViewer: ReturnType<typeof vi.fn>;
    gone: boolean;
  };
  sticky: StickyConvertHost & {
    flush: ReturnType<typeof vi.fn>;
    openSaved: ReturnType<typeof vi.fn>;
  };
}
function setup(
  opts: {
    dest?: 'document' | 'sticky';
    doc?: string;
    source?: ConversionRequest['source'];
    ranges?: ConversionRequest['ranges'];
    linewise?: boolean;
    tab?: Partial<ConvertTabInfo>;
    /** The language of the note. */
    language?: string | null;
  } = {},
): Setup {
  const controller = new ConvertController();
  const text = opts.doc ?? 'abcdef';
  const info: ConvertTabInfo = {
    path: '',
    encoding: 'UTF-8',
    hadBom: false,
    lineEnding: 'LF',
    language: null,
    ...opts.tab,
  };
  const doc = {
    gone: false,
    tab: (id: string) => (doc.gone || id !== 't1' ? null : info),
    install: vi.fn(() => Promise.resolve()),
    showViewer: vi.fn(() => Promise.resolve()),
  } as unknown as Setup['doc'];
  const sticky = {
    noteId: () => 'note1',
    language: () => opts.language ?? null,
    flush: vi.fn(() => Promise.resolve()),
    openSaved: vi.fn(() => Promise.resolve()),
  } as unknown as Setup['sticky'];
  controller.attachDoc(doc);
  controller.attachSticky(sticky);
  const unlock = vi.fn();
  const release = vi.fn();
  const request: ConversionRequest = {
    dest: opts.dest ?? 'document',
    tabId: opts.dest === 'sticky' ? 'sticky' : 't1',
    doc: Text.of(text.split('\n')),
    ranges: opts.ranges ?? [{ from: 3, to: 3, line: null }],
    linewise: opts.linewise ?? false,
    source: opts.source ?? { kind: 'text', text: 'XY' },
    clip: opts.source?.kind === 'clip' ? { pin: 8, release } : null,
    lockId: 1,
    unlock,
  };
  return { controller, info, unlock, release, request, doc, sticky };
}
/** Waits for a dialog and presses a button of it. */
async function press(
  s: Setup,
  button: 'primary' | 'secondary' | 'cancel',
  kind?: string,
): Promise<void> {
  await flush();
  expect(s.controller.dialog).not.toBeNull();
  if (kind !== undefined) {
    expect(s.controller.dialog?.kind).toBe(kind);
  }
  s.controller.answer(button);
  await flush();
}
/** Starts and confirms (D8). */
async function go(s: Setup): Promise<void> {
  s.controller.start(s.request);
  await press(s, 'primary', 'confirm');
}

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mockInvoke.mockReset();
  mockSave.mockReset();
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  settingsState.defaultEncoding = 'UTF-8';
  settingsState.defaultLineEnding = 'LF';
});
afterEach(() => {
  logged.mockRestore();
});

describe('D8, the question', () => {
  it('asks first, with the text of the plan and a Continue and a Cancel button', async () => {
    core();
    const s = setup();
    s.controller.start(s.request);
    await flush();
    const d = s.controller.dialog;
    expect(d?.kind).toBe('confirm');
    expect(d?.message).toBe(t('convert.confirm'));
    expect(d?.primary).toBe(t('convert.continue'));
    expect(d?.cancel).toBe(t('common.cancel'));
    expect(d?.secondary).toBeUndefined();
    expect(s.unlock).not.toHaveBeenCalled();
  });
  it('writes nothing and unlocks when it is cancelled', async () => {
    const c = core();
    const s = setup();
    s.controller.start(s.request);
    await press(s, 'cancel', 'confirm');
    expect(c.names()).toEqual([]);
    expect(s.unlock).toHaveBeenCalledTimes(1);
    expect(s.controller.dialog).toBeNull();
    expect(s.controller.busy('t1')).toBe(false);
  });
  it('asks the questions of two tabs one after the other', async () => {
    core();
    const a = setup();
    a.controller.start(a.request);
    a.controller.start({ ...a.request, tabId: 't2' });
    await flush();
    const first = a.controller.dialog?.id;
    a.controller.answer('cancel');
    await flush();
    expect(a.controller.dialog?.kind).toBe('confirm');
    expect(a.controller.dialog?.id).not.toBe(first);
  });
});

describe('D16, the baseline of the file is taken at the paste', () => {
  const tooBig = { convert_finish: () => ({ bytes: 9, editable: false }) };
  it('asks for the fingerprint of the file before the question is shown', async () => {
    const c = core();
    const s = setup({ tab: { path: '/d/a.txt' } });
    s.controller.start(s.request);
    await flush();
    expect(s.controller.dialog?.kind).toBe('confirm');
    expect(c.named('file_fingerprint')).toEqual([
      { cmd: 'file_fingerprint', args: { path: '/d/a.txt' } },
    ]);
    expect(c.names()).toEqual(['file_fingerprint']);
  });
  it('asks for nothing for a tab with no file', async () => {
    const c = core();
    const s = setup();
    s.controller.start(s.request);
    await flush();
    expect(c.names()).toEqual([]);
  });
  it('checks the save against the file as it was at the paste, and finds a change made during the question', async () => {
    let now = { size: 3, mtime_ms: 4 };
    let compared: unknown = null;
    const c = core({
      ...tooBig,
      file_fingerprint: () => now,
      convert_save: (a) => {
        compared = a.expected;
        if (
          a.expected !== null &&
          JSON.stringify(a.expected) !== JSON.stringify(now)
        ) {
          throw 'fingerprint-mismatch';
        }
        return { size: 77, mtime_ms: 1 };
      },
    });
    const s = setup({ tab: { path: '/d/a.txt' } });
    s.controller.start(s.request);
    await flush();
    // Another program writes the file while the question is up.
    now = { size: 9, mtime_ms: 9 };
    await press(s, 'primary', 'confirm');
    await press(s, 'primary', 'tooBig');
    expect(compared).toEqual({ size: 3, mtime_ms: 4 });
    expect(s.controller.dialog?.kind).toBe('conflict');
    expect(c.named('file_fingerprint')).toHaveLength(1);
    expect(s.doc.showViewer).not.toHaveBeenCalled();
  });
  it('asks again, with the new path, when the tab was saved elsewhere during the question', async () => {
    const c = core({
      ...tooBig,
      file_fingerprint: (a) =>
        a.path === '/d/b.txt'
          ? { size: 5, mtime_ms: 6 }
          : { size: 3, mtime_ms: 4 },
    });
    const s = setup({ tab: { path: '/d/a.txt' } });
    s.controller.start(s.request);
    await flush();
    s.info.path = '/d/b.txt';
    await press(s, 'primary', 'confirm');
    expect(c.named('file_fingerprint').map((x) => x.args.path)).toEqual([
      '/d/a.txt',
      '/d/b.txt',
    ]);
    await press(s, 'primary', 'tooBig');
    expect(c.named('convert_save')[0]?.args).toMatchObject({
      target: '/d/b.txt',
      expected: { size: 5, mtime_ms: 6 },
    });
  });
  it('asks once the tab has a file when it had none at the paste', async () => {
    const c = core();
    const s = setup();
    s.controller.start(s.request);
    await flush();
    s.info.path = '/d/new.txt';
    await press(s, 'primary', 'confirm');
    expect(c.named('file_fingerprint')).toEqual([
      { cmd: 'file_fingerprint', args: { path: '/d/new.txt' } },
    ]);
  });
  it('goes on without a baseline when the fingerprint cannot be had', async () => {
    const c = core({
      ...tooBig,
      file_fingerprint: () => {
        throw 'gone';
      },
    });
    const s = setup({ tab: { path: '/d/a.txt' } });
    await go(s);
    await press(s, 'primary', 'tooBig');
    expect(c.named('convert_save')[0]?.args.expected).toBeNull();
  });
});

describe('the data flow of a conversion', () => {
  it('sends the document before, what is pasted, and the document after, in order, then finishes and installs', async () => {
    const c = core();
    const s = setup();
    await go(s);
    expect(c.names()).toEqual([
      'convert_begin',
      'convert_append',
      'convert_append',
      'convert_append',
      'convert_finish',
    ]);
    expect(c.named('convert_append').map((x) => x.args.text)).toEqual([
      'abc',
      'XY',
      'def',
    ]);
    expect(c.named('convert_append')[0]?.args.id).toBe('cv1');
    expect(s.doc.install).toHaveBeenCalledWith('t1', 'cv1');
    expect(c.named('convert_abort')).toEqual([]);
    expect(s.unlock).toHaveBeenCalledTimes(1);
    expect(s.controller.dialog).toBeNull();
  });
  it('writes the breaks the document has: CRLF for a CRLF document, LF for a note', async () => {
    const c = core();
    const s = setup({ tab: { lineEnding: 'CRLF' } });
    await go(s);
    expect(c.named('convert_begin')[0]?.args.eol).toBe('\r\n');
    const n = core();
    const note = setup({ dest: 'sticky' });
    await go(note);
    expect(n.named('convert_begin')[0]?.args.eol).toBe('\n');
  });
  it('sends a clip as a clip, in its place, and a line-wise break after it', async () => {
    const c = core();
    const s = setup({
      doc: 'one\ntwo',
      source: { kind: 'clip', info: clip() },
      ranges: [{ from: 4, to: 4, line: null }],
      linewise: true,
    });
    await go(s);
    const sent = c.calls
      .filter((x) => x.cmd.startsWith('convert_append'))
      .map((x) => (x.cmd === 'convert_append' ? x.args.text : '#clip1'));
    expect(sent).toEqual(['one\n', '#clip1', '\n', 'two']);
    expect(c.named('convert_append_clip')[0]?.args).toEqual({
      id: 'cv1',
      pin: 8,
    });
    // The clip is in the file: the pin goes back before the question about the
    // file, and only once.
    expect(s.release).toHaveBeenCalledTimes(1);
  });
  it('sends one line of the clip to each selection when the lines match, always through the pin', async () => {
    const c = core();
    const s = setup({
      doc: 'ab\ncd\nef',
      source: { kind: 'clip', info: clip({ lines: 3 }) },
      ranges: [
        { from: 1, to: 1, line: 1 },
        { from: 4, to: 5, line: 2 },
        { from: 7, to: 7, line: 3 },
      ],
    });
    await go(s);
    const sent = c.calls
      .filter((x) => x.cmd.startsWith('convert_append'))
      .map((x) =>
        x.cmd === 'convert_append'
          ? x.args.text
          : `#${x.cmd}:${x.args.pin}:${x.args.line}`,
      );
    expect(sent).toEqual([
      'a',
      '#convert_append_clip_line:8:0',
      'b\nc',
      '#convert_append_clip_line:8:1',
      '\ne',
      '#convert_append_clip_line:8:2',
      'f',
    ]);
    expect(c.named('convert_append_clip')).toEqual([]);
  });
  it('gives the pin back when the question is not continued', async () => {
    core();
    const s = setup({ source: { kind: 'clip', info: clip() } });
    s.controller.start(s.request);
    await press(s, 'cancel', 'confirm');
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.unlock).toHaveBeenCalledTimes(1);
  });
  it('holds the pin through the question and does not give it back before', async () => {
    core();
    const s = setup({ source: { kind: 'clip', info: clip() } });
    s.controller.start(s.request);
    await flush();
    expect(s.release).not.toHaveBeenCalled();
  });
  it('gives the pin back when the conversion is given up on the way', async () => {
    let free: () => void = () => {};
    core({
      convert_append: () =>
        new Promise<void>((resolve) => {
          free = resolve;
        }),
    });
    const s = setup({ source: { kind: 'clip', info: clip() } });
    await go(s);
    s.controller.cancelTab('t1');
    free();
    await flush();
    expect(s.release).toHaveBeenCalled();
  });
  it('puts the pasted text at every selection', async () => {
    const c = core();
    const s = setup({
      ranges: [
        { from: 1, to: 1, line: null },
        { from: 4, to: 5, line: null },
      ],
    });
    await go(s);
    expect(c.named('convert_append').map((x) => x.args.text)).toEqual([
      'a',
      'XY',
      'bcd',
      'XY',
      'f',
    ]);
  });
  it('sends blocks of at most a mebi-unit that never cut a surrogate pair, one at a time', async () => {
    const huge = `${'a'.repeat(CONVERT_CHUNK - 1)}😀${'b'.repeat(CONVERT_CHUNK + 7)}`;
    let running = 0;
    let overlap = false;
    const c = core({
      convert_append: () => {
        running += 1;
        overlap = overlap || running > 1;
        return new Promise((resolve) =>
          setTimeout(() => {
            running -= 1;
            resolve(undefined);
          }, 0),
        );
      },
    });
    const s = setup({
      doc: huge,
      ranges: [{ from: huge.length, to: huge.length, line: null }],
      source: { kind: 'text', text: 'z' },
    });
    s.controller.start(s.request);
    await flush();
    s.controller.answer('primary');
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const blocks = c.named('convert_append').map((x) => x.args.text as string);
    expect(blocks.length).toBeGreaterThan(2);
    for (const b of blocks) {
      expect(b.length).toBeLessThanOrEqual(CONVERT_CHUNK);
      expect(b.charCodeAt(b.length - 1) & 0xfc00).not.toBe(0xd800);
      expect(b.charCodeAt(0) & 0xfc00).not.toBe(0xdc00);
    }
    expect(blocks.join('')).toBe(`${huge}z`);
    expect(overlap).toBe(false);
    expect(s.doc.install).toHaveBeenCalled();
  });
});

describe('a conversion that fails', () => {
  it('deletes the conversion file, leaves the tab alone, unlocks and says why', async () => {
    const c = core({
      convert_append: () => {
        throw 'No space left on device (os error 28)';
      },
    });
    const s = setup();
    await go(s);
    expect(c.named('convert_abort')).toEqual([
      { cmd: 'convert_abort', args: { id: 'cv1' } },
    ]);
    expect(s.doc.install).not.toHaveBeenCalled();
    expect(s.unlock).toHaveBeenCalledTimes(1);
    expect(s.controller.dialog?.kind).toBe('error');
    expect(s.controller.dialog?.message).toBe(
      t('convert.failed', { error: 'No space left on device (os error 28)' }),
    );
  });
  it('fails as any failure does when the pin is gone, with the pin and the file given back', async () => {
    const c = core({
      convert_append_clip: () => {
        throw 'pin-gone';
      },
    });
    const s = setup({ source: { kind: 'clip', info: clip() } });
    await go(s);
    expect(c.named('convert_abort')).toHaveLength(1);
    expect(s.doc.install).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalled();
    expect(s.unlock).toHaveBeenCalledTimes(1);
    expect(s.controller.dialog?.message).toBe(
      t('convert.failed', { error: t('paste.clipUnreadable') }),
    );
    expect(s.controller.dialog?.message).not.toContain('pin-gone');
  });
  it('reports a clip line the core does not have like any failure', async () => {
    core({
      convert_append_clip_line: () => {
        throw 'line-out-of-range';
      },
    });
    const s = setup({
      source: { kind: 'clip', info: clip({ lines: 2 }) },
      ranges: [
        { from: 1, to: 1, line: 1 },
        { from: 2, to: 2, line: 2 },
      ],
    });
    await go(s);
    expect(s.controller.dialog?.message).toBe(
      t('convert.failed', { error: t('paste.clipUnreadable') }),
    );
  });
  it('reports a tab that could not be installed, with the file the core owns', async () => {
    const c = core();
    const s = setup();
    s.doc.install.mockRejectedValue(new Error('too-large'));
    await go(s);
    expect(c.named('convert_abort')).toEqual([]);
    expect(s.unlock).toHaveBeenCalledTimes(1);
    expect(s.controller.dialog?.message).toBe(
      t('convert.failed', { error: t('convert.interrupted') }),
    );
  });
  it('says the conversion was interrupted, not an internal code, and logs the code', async () => {
    core({
      convert_finish: () => {
        throw 'unknown-convert';
      },
    });
    const s = setup();
    await go(s);
    expect(s.controller.dialog?.message).toBe(
      t('convert.failed', { error: t('convert.interrupted') }),
    );
    expect(s.controller.dialog?.message).not.toContain('unknown-convert');
    expect(logged).toHaveBeenCalledWith('unknown-convert');
  });
  it('says the same when the note is gone or the tab goes while it is installed, without "Error:"', async () => {
    core();
    const note = setup({ dest: 'sticky' });
    note.sticky.noteId = () => null;
    await go(note);
    expect(note.controller.dialog?.message).toBe(
      t('convert.failed', { error: t('convert.interrupted') }),
    );
    expect(note.controller.dialog?.message).not.toContain('Error:');
    expect(logged).toHaveBeenCalledWith('no note');
    const tab = setup();
    tab.doc.install.mockRejectedValue(new Error('the tab is gone'));
    await go(tab);
    expect(tab.controller.dialog?.message).toBe(
      t('convert.failed', { error: t('convert.interrupted') }),
    );
    expect(logged).toHaveBeenCalledWith('the tab is gone');
  });
  it('says what could not be read, with the system error, when the clip fails to read', async () => {
    core({
      convert_append_clip: () => {
        throw 'clip-read: Permission denied (os error 13)';
      },
    });
    const s = setup({ source: { kind: 'clip', info: clip() } });
    await go(s);
    expect(s.controller.dialog?.message).toBe(
      t('convert.failed', {
        error: t('paste.clipReadFailed', {
          detail: 'Permission denied (os error 13)',
        }),
      }),
    );
  });
  it('stops, deletes the file and says nothing when the tab is closed on the way', async () => {
    let release: () => void = () => {};
    const c = core({
      convert_append: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const s = setup();
    await go(s);
    s.controller.cancelTab('t1');
    release();
    await flush();
    expect(c.named('convert_append')).toHaveLength(1);
    expect(c.named('convert_finish')).toEqual([]);
    expect(c.named('convert_abort')).toHaveLength(1);
    expect(s.unlock).toHaveBeenCalledTimes(1);
    expect(s.controller.dialog).toBeNull();
  });
  it('answers the question of a tab that is closed meanwhile', async () => {
    const c = core();
    const s = setup();
    s.controller.start(s.request);
    await flush();
    s.controller.cancelTab('t1');
    await flush();
    expect(s.controller.dialog).toBeNull();
    expect(c.names()).toEqual([]);
    expect(s.unlock).toHaveBeenCalledTimes(1);
  });
  it('stops when the tab is gone from the window', async () => {
    const c = core();
    const s = setup();
    s.controller.start(s.request);
    await flush();
    s.doc.gone = true;
    s.controller.answer('primary');
    await flush();
    expect(c.names()).toEqual([]);
    expect(s.unlock).toHaveBeenCalledTimes(1);
  });
  it('gives up every conversion when the window closes', async () => {
    core();
    const s = setup();
    s.controller.start(s.request);
    await flush();
    s.controller.cancelAll();
    await flush();
    expect(s.unlock).toHaveBeenCalledTimes(1);
    expect(s.controller.dialog).toBeNull();
  });
});

describe('D16, the result is too big to edit', () => {
  const tooBig = { convert_finish: () => ({ bytes: 9, editable: false }) };
  it('asks with both buttons', async () => {
    core(tooBig);
    const s = setup({ tab: { path: '/d/a.txt' } });
    await go(s);
    await flush();
    const d = s.controller.dialog;
    expect(d?.kind).toBe('tooBig');
    expect(d?.message).toBe(t('convert.tooBig'));
    expect(d?.primary).toBe(t('convert.tooBig.save'));
    expect(d?.cancel).toBe(t('convert.tooBig.discard'));
  });
  it('pastes nothing and deletes the file with "do not paste"', async () => {
    const c = core(tooBig);
    const s = setup({ tab: { path: '/d/a.txt' } });
    await go(s);
    await press(s, 'cancel', 'tooBig');
    expect(c.named('convert_save')).toEqual([]);
    expect(c.named('convert_abort')).toHaveLength(1);
    expect(s.doc.install).not.toHaveBeenCalled();
    expect(s.doc.showViewer).not.toHaveBeenCalled();
    expect(s.unlock).toHaveBeenCalledTimes(1);
  });
  it('saves a document to its own path, keeping its encoding and mark, and shows the view', async () => {
    const c = core(tooBig);
    const s = setup({
      tab: { path: '/d/a.txt', encoding: 'Shift_JIS', hadBom: false },
    });
    await go(s);
    await press(s, 'primary', 'tooBig');
    expect(mockSave).not.toHaveBeenCalled();
    expect(c.named('convert_save')[0]?.args).toEqual({
      convertId: 'cv1',
      target: '/d/a.txt',
      encoding: 'Shift_JIS',
      withBom: false,
      expected: { size: 3, mtime_ms: 4 },
    });
    expect(s.doc.showViewer).toHaveBeenCalledWith('t1', '/d/a.txt', 77);
    expect(c.named('convert_abort')).toEqual([]);
    expect(s.unlock).toHaveBeenCalledTimes(1);
  });
  it('asks where an untitled document goes, and does not paste when that is cancelled', async () => {
    const c = core(tooBig);
    const s = setup();
    mockSave.mockResolvedValueOnce(null);
    await go(s);
    await press(s, 'primary', 'tooBig');
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(c.named('convert_save')).toEqual([]);
    expect(c.named('convert_abort')).toHaveLength(1);
    expect(s.doc.showViewer).not.toHaveBeenCalled();
  });
  it('saves an untitled document where it is asked to, with no baseline to compare', async () => {
    const c = core(tooBig);
    const s = setup();
    mockSave.mockResolvedValueOnce('/d/new.txt');
    await go(s);
    await press(s, 'primary', 'tooBig');
    expect(c.named('convert_save')[0]?.args.target).toBe('/d/new.txt');
    expect(c.named('convert_save')[0]?.args.expected).toBeNull();
    expect(s.doc.showViewer).toHaveBeenCalledWith('t1', '/d/new.txt', 77);
  });
  it('saves a note where it is asked to and opens the file as a document', async () => {
    const c = core(tooBig);
    const s = setup({ dest: 'sticky' });
    mockSave.mockResolvedValueOnce('/d/note.txt');
    await go(s);
    await press(s, 'primary', 'tooBig');
    expect(c.named('convert_save')[0]?.args).toMatchObject({
      target: '/d/note.txt',
      encoding: 'UTF-8',
      withBom: false,
    });
    expect(s.sticky.openSaved).toHaveBeenCalledWith('/d/note.txt');
    expect(c.named('convert_handoff_start')).toEqual([]);
  });

  describe('when the file was changed by another program', () => {
    const mismatch = (): Record<string, Handler> => {
      let first = true;
      return {
        ...tooBig,
        convert_save: () => {
          if (first) {
            first = false;
            throw 'fingerprint-mismatch';
          }
          return { size: 77, mtime_ms: 1 };
        },
      };
    };
    it('shows the conflict question of a save of a large file, with its three buttons', async () => {
      core(mismatch());
      const s = setup({ tab: { path: '/d/a.txt' } });
      await go(s);
      await press(s, 'primary', 'tooBig');
      await flush();
      const d = s.controller.dialog;
      expect(d?.kind).toBe('conflict');
      expect(d?.message).toBe(t('doc.windowedConflict.message'));
      expect(d?.primary).toBe(t('doc.conflict.writeAnyway'));
      expect(d?.secondary).toBe(t('doc.conflict.saveAsNew'));
      expect(d?.cancel).toBe(t('common.cancel'));
    });
    it('"write anyway" writes again without the comparison', async () => {
      const c = core(mismatch());
      const s = setup({ tab: { path: '/d/a.txt' } });
      await go(s);
      await press(s, 'primary', 'tooBig');
      await press(s, 'primary', 'conflict');
      const saves = c.named('convert_save');
      expect(saves).toHaveLength(2);
      expect(saves[0]?.args.expected).toEqual({ size: 3, mtime_ms: 4 });
      expect(saves[1]?.args.expected).toBeNull();
      expect(saves[1]?.args.target).toBe('/d/a.txt');
      expect(s.doc.showViewer).toHaveBeenCalledWith('t1', '/d/a.txt', 77);
    });
    it('"save as new" writes to the file chosen', async () => {
      const c = core(mismatch());
      const s = setup({ tab: { path: '/d/a.txt' } });
      mockSave.mockResolvedValueOnce('/d/b.txt');
      await go(s);
      await press(s, 'primary', 'tooBig');
      await press(s, 'secondary', 'conflict');
      expect(c.named('convert_save')[1]?.args).toMatchObject({
        target: '/d/b.txt',
        expected: null,
      });
      expect(s.doc.showViewer).toHaveBeenCalledWith('t1', '/d/b.txt', 77);
    });
    it('"cancel" pastes nothing', async () => {
      const c = core(mismatch());
      const s = setup({ tab: { path: '/d/a.txt' } });
      await go(s);
      await press(s, 'primary', 'tooBig');
      await press(s, 'cancel', 'conflict');
      expect(c.named('convert_save')).toHaveLength(1);
      expect(c.named('convert_abort')).toHaveLength(1);
      expect(s.doc.showViewer).not.toHaveBeenCalled();
      expect(s.unlock).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the text has no form in the encoding', () => {
    const unmappable = (): Record<string, Handler> => {
      return {
        ...tooBig,
        convert_save: (args) => {
          if (args.encoding !== 'UTF-8') {
            throw 'unmappable';
          }
          return { size: 77, mtime_ms: 1 };
        },
      };
    };
    const sjis = { path: '/d/a.txt', encoding: 'Shift_JIS' };
    it('shows the D13 question with the file and the encoding, in English', async () => {
      core(unmappable());
      const s = setup({ tab: sjis });
      await go(s);
      await press(s, 'primary', 'tooBig');
      await flush();
      const d = s.controller.dialog;
      expect(d?.kind).toBe('unmappable');
      expect(d?.message).toBe(
        t('convert.unmappable', { name: 'a.txt', encoding: 'Shift_JIS' }),
      );
      expect(d?.primary).toBe(t('convert.unmappable.utf8'));
      expect(d?.secondary).toBe(t('convert.unmappable.saveAs'));
      expect(d?.cancel).toBe(t('common.cancel'));
    });
    it('"UTF-8 to the original path" saves again as UTF-8 to the same file', async () => {
      const c = core(unmappable());
      const s = setup({ tab: sjis });
      await go(s);
      await press(s, 'primary', 'tooBig');
      await press(s, 'primary', 'unmappable');
      expect(c.named('convert_save')[1]?.args).toMatchObject({
        target: '/d/a.txt',
        encoding: 'UTF-8',
        withBom: false,
      });
      expect(s.doc.showViewer).toHaveBeenCalledWith('t1', '/d/a.txt', 77);
    });
    it('"save as UTF-8" asks for a file and writes it as UTF-8', async () => {
      const c = core(unmappable());
      const s = setup({ tab: sjis });
      mockSave.mockResolvedValueOnce('/d/u.txt');
      await go(s);
      await press(s, 'primary', 'tooBig');
      await press(s, 'secondary', 'unmappable');
      expect(c.named('convert_save')[1]?.args).toMatchObject({
        target: '/d/u.txt',
        encoding: 'UTF-8',
      });
      expect(s.doc.showViewer).toHaveBeenCalledWith('t1', '/d/u.txt', 77);
    });
    it('"cancel" pastes nothing', async () => {
      const c = core(unmappable());
      const s = setup({ tab: sjis });
      await go(s);
      await press(s, 'primary', 'tooBig');
      await press(s, 'cancel', 'unmappable');
      expect(c.named('convert_save')).toHaveLength(1);
      expect(c.named('convert_abort')).toHaveLength(1);
      expect(s.doc.showViewer).not.toHaveBeenCalled();
    });
  });

  it('reports a read-only destination like any save does, and pastes nothing', async () => {
    const c = core({
      ...tooBig,
      convert_save: () => {
        throw 'read-only-destination';
      },
    });
    const s = setup({ tab: { path: '/d/a.txt' } });
    await go(s);
    await press(s, 'primary', 'tooBig');
    expect(s.controller.dialog?.kind).toBe('error');
    expect(s.controller.dialog?.message).toBe(
      t('doc.saveReadOnly', { name: 'a.txt' }),
    );
    expect(s.controller.dialog?.message).not.toContain(
      t('convert.interrupted'),
    );
    expect(c.named('convert_abort')).toHaveLength(1);
    expect(s.doc.showViewer).not.toHaveBeenCalled();
  });
  it.each([
    '/d/a.txt is not a file that can be replaced',
    'Permission denied (os error 13)',
  ])('reports a save that fails with %s as a save failure', async (error) => {
    const c = core({
      ...tooBig,
      convert_save: () => {
        throw error;
      },
    });
    const s = setup({ tab: { path: '/d/a.txt' } });
    await go(s);
    await press(s, 'primary', 'tooBig');
    expect(s.controller.dialog?.kind).toBe('error');
    expect(s.controller.dialog?.message).toBe(
      t('doc.saveFailed', { name: 'a.txt', error }),
    );
    expect(s.controller.dialog?.message).not.toContain(
      t('convert.interrupted'),
    );
    expect(c.named('convert_abort')).toHaveLength(1);
    expect(s.doc.showViewer).not.toHaveBeenCalled();
  });
});

describe('a note handed to a document window', () => {
  it('has its record written, then hands the finished file over, and stays locked', async () => {
    const c = core();
    const s = setup({ dest: 'sticky' });
    await go(s);
    expect(s.sticky.flush).toHaveBeenCalledTimes(1);
    expect(c.named('convert_handoff_start')[0]?.args).toEqual({
      noteId: 'note1',
      convertId: 'cv1',
      language: null,
      encoding: 'UTF-8',
      lineEnding: 'LF',
    });
    expect(c.names().indexOf('convert_finish')).toBeLessThan(
      c.names().indexOf('convert_handoff_start'),
    );
    expect(s.doc.install).not.toHaveBeenCalled();
    expect(s.unlock).not.toHaveBeenCalled();
    expect(c.named('convert_abort')).toEqual([]);
  });
  it('unlocks and tells the user when the core gives the note back', async () => {
    core();
    const s = setup({ dest: 'sticky' });
    await go(s);
    s.controller.reclaimed('someone-else');
    await flush();
    expect(s.unlock).not.toHaveBeenCalled();
    s.controller.reclaimed('note1');
    await flush();
    expect(s.unlock).toHaveBeenCalledTimes(1);
    expect(s.controller.dialog?.kind).toBe('error');
    expect(s.controller.dialog?.message).toBe(t('convert.reclaimed'));
    s.controller.reclaimed('note1');
    expect(s.unlock).toHaveBeenCalledTimes(1);
  });
  it('unlocks and reports a handoff the core refused (it deleted the file)', async () => {
    const c = core({
      convert_handoff_start: () => {
        throw new Error('no window');
      },
    });
    const s = setup({ dest: 'sticky' });
    await go(s);
    expect(s.unlock).toHaveBeenCalledTimes(1);
    expect(c.named('convert_abort')).toEqual([]);
    expect(s.controller.dialog?.message).toBe(
      t('convert.failed', { error: t('convert.interrupted') }),
    );
  });
});

describe('a note takes the default encoding and line ending', () => {
  const prefer = (): void => {
    settingsState.defaultEncoding = 'Shift_JIS';
    settingsState.defaultLineEnding = 'CRLF';
  };
  it('writes the breaks of the default and hands over its language, encoding and line ending', async () => {
    prefer();
    const c = core();
    const s = setup({ dest: 'sticky', language: 'markdown' });
    await go(s);
    expect(c.named('convert_begin')[0]?.args.eol).toBe('\r\n');
    expect(c.named('convert_handoff_start')[0]?.args).toEqual({
      noteId: 'note1',
      convertId: 'cv1',
      language: 'markdown',
      encoding: 'Shift_JIS',
      lineEnding: 'CRLF',
    });
  });
  it('hands over UTF-8 and LF when those are the defaults', async () => {
    const c = core();
    const s = setup({ dest: 'sticky', language: 'rust' });
    await go(s);
    expect(c.named('convert_begin')[0]?.args.eol).toBe('\n');
    expect(c.named('convert_handoff_start')[0]?.args).toMatchObject({
      language: 'rust',
      encoding: 'UTF-8',
      lineEnding: 'LF',
    });
  });
  it('saves a result too big to edit in the default encoding, with the default breaks', async () => {
    prefer();
    const c = core({ convert_finish: () => ({ bytes: 9, editable: false }) });
    const s = setup({ dest: 'sticky' });
    mockSave.mockResolvedValueOnce('/d/note.txt');
    await go(s);
    await press(s, 'primary', 'tooBig');
    expect(c.named('convert_begin')[0]?.args.eol).toBe('\r\n');
    expect(c.named('convert_save')[0]?.args).toMatchObject({
      target: '/d/note.txt',
      encoding: 'Shift_JIS',
      withBom: false,
    });
    expect(s.sticky.openSaved).toHaveBeenCalledWith('/d/note.txt');
  });
  it('asks D13 when the default encoding cannot hold the text', async () => {
    prefer();
    core({
      convert_finish: () => ({ bytes: 9, editable: false }),
      convert_save: () => {
        throw 'unmappable';
      },
    });
    const s = setup({ dest: 'sticky' });
    mockSave.mockResolvedValueOnce('/d/note.txt');
    await go(s);
    await press(s, 'primary', 'tooBig');
    await flush();
    const d = s.controller.dialog;
    expect(d?.kind).toBe('unmappable');
    expect(d?.message).toBe(
      t('convert.unmappable', { name: 'note.txt', encoding: 'Shift_JIS' }),
    );
  });
});

describe('the question about a save that cannot write some text (D13)', () => {
  it('turns the buttons into utf8, saveAs and cancel', async () => {
    core();
    const c = new ConvertController();
    for (const [button, expected] of [
      ['primary', 'utf8'],
      ['secondary', 'saveAs'],
      ['cancel', 'cancel'],
    ] as const) {
      const asked = c.askUnmappable('x.txt', 'Shift_JIS');
      await flush();
      expect(c.dialog?.message).toBe(
        t('convert.unmappable', { name: 'x.txt', encoding: 'Shift_JIS' }),
      );
      c.answer(button);
      expect(await asked).toBe(expected);
    }
  });
});
