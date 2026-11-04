// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Compartment,
  EditorSelection,
  EditorState,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import type { ClipInfo } from './clipRouting';
import { LiveTokens } from './liveTokens';
import {
  PasteFlow,
  registerPasteTarget,
  routePastedText,
  type ConversionRequest,
  type PasteEvent,
  type PasteHost,
} from './pasteFlow';
import { PasteLocks, editableWith, type PasteLock } from './pasteLock';
import {
  PASTE_SLOW_MS,
  RedispatchWaiter,
  type FieldDeps,
  type TextBegin,
} from './pasteRouting';
import { SNAPSHOT_CONTENT_MAX } from './snapshotPolicy';
import { Text } from '@codemirror/state';
import { pasteSpec } from './replayKeys';
import { t } from '../i18n';

const clipInfo = (over: Partial<ClipInfo> = {}): ClipInfo => ({
  id: 'c1',
  bytes: 5,
  lines: 1,
  utf16_len: 5,
  crlf: 0,
  linewise: false,
  ...over,
});
const target = {};
/** A tab held in a state, locked through the compartment the editors use. */
function makeHost(doc: string, dest: 'document' | 'sticky' = 'document') {
  const locks = new PasteLocks();
  const compartment = new Compartment();
  let state = EditorState.create({
    doc,
    extensions: [
      history(),
      EditorState.allowMultipleSelections.of(true),
      compartment.of(editableWith(true, undefined)),
    ],
    selection: EditorSelection.cursor(doc.length),
  });
  const applied: TransactionSpec[] = [];
  const shown: (PasteLock | undefined)[] = [];
  let gone = false;
  const host: PasteHost = {
    dest,
    stateOf: () => (gone ? null : state),
    apply: (_tab, spec) => {
      applied.push(spec);
      state = state.update(spec).state;
    },
    showLock: (_tab, lock) => {
      shown.push(lock);
      state = state.update({
        effects: compartment.reconfigure(editableWith(true, lock)),
      }).state;
    },
    eolOf: () => '\n',
  };
  return {
    host,
    locks,
    applied,
    shown,
    get state() {
      return state;
    },
    set state(next: EditorState) {
      state = next;
    },
    vanish: () => {
      gone = true;
    },
  };
}
function setup(
  doc: string,
  opts: {
    platform?: string;
    lite?: boolean;
    dest?: 'document' | 'sticky';
    linewise?: string | null;
  } = {},
) {
  const tab = makeHost(doc, opts.dest ?? 'document');
  const waiter = new RedispatchWaiter();
  const clipStatus = vi.fn(() => Promise.resolve<ClipInfo | null>(null));
  const textBegin = vi.fn(() =>
    Promise.resolve<TextBegin>({ kind: 'gate', token: 3 }),
  );
  const textEnd = vi.fn((_token: number) => Promise.resolve(true));
  const pin = vi.fn((_id: string) => Promise.resolve(5));
  const unpin = vi.fn();
  const redispatchPaste = vi.fn(() =>
    Promise.resolve<'send' | 'not-key' | 'not-handled'>('send'),
  );
  const readText = vi.fn(() => Promise.resolve('read text'));
  const readChunk = vi.fn(
    (_pin: number, _offset: number): Promise<{ text: string; next: number }> =>
      Promise.reject(new Error('no clip')),
  );
  const startConversion = vi.fn<(r: ConversionRequest) => void>();
  const reportFailure = vi.fn<(error: string) => void>();
  const env: FieldDeps = {
    platform: opts.platform ?? 'macos',
    clipStatus,
    textBegin,
    textEnd,
    onGateRevoked: () => () => {},
    pin,
    unpin,
    redispatchPaste,
    readText,
    waiter,
    userInput: () => () => {},
    tokens: new LiveTokens(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    clipPasteMark: vi.fn(() => Promise.resolve(9)),
    hasFocus: () => true,
    activeElement: () => target,
    insertText: () => {},
  };
  const flow = new PasteFlow(tab.host, {
    env,
    readChunk,
    isLite: () => opts.lite === true,
    startConversion,
    locks: tab.locks,
    lastLinewise: () => opts.linewise ?? null,
    reportFailure,
  });
  const event = (text = '') => {
    const getData = vi.fn((type: string) =>
      type === 'text/plain' ? text : '',
    );
    const preventDefault = vi.fn();
    const e: PasteEvent = { clipboardData: { getData }, preventDefault };
    return { e, getData, preventDefault };
  };
  const view = () => ({ state: tab.state, contentDOM: target });
  return {
    tab,
    flow,
    env,
    clipStatus,
    textBegin,
    textEnd,
    pin,
    unpin,
    redispatchPaste,
    readText,
    readChunk,
    startConversion,
    reportFailure,
    event,
    view,
    waiter,
  };
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 400; i += 1) {
    await Promise.resolve();
  }
};

describe('PasteFlow without clips (Linux)', () => {
  it('reads the text of the event once and pastes it as one transaction', () => {
    const s = setup('abc', { platform: 'linux' });
    const ev = s.event('XY');
    expect(s.flow.onPaste('t', s.view(), ev.e)).toBe(true);
    expect(ev.getData).toHaveBeenCalledTimes(1);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(s.tab.applied).toHaveLength(1);
    expect(s.tab.state.doc.toString()).toBe('abcXY');
    expect(s.clipStatus).not.toHaveBeenCalled();
    expect(s.tab.locks.any()).toBe(false);
  });

  it('is one undo step', () => {
    const s = setup('abc', { platform: 'linux' });
    s.flow.onPaste('t', s.view(), s.event('XY').e);
    let state = s.tab.state;
    undo({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    expect(state.doc.toString()).toBe('abc');
  });

  it('pastes the remembered line above the caret line as CodeMirror does', () => {
    const s = setup('one\ntwo', { platform: 'linux', linewise: 'two' });
    s.tab.state = s.tab.state.update({ selection: { anchor: 1 } }).state;
    s.flow.onPaste('t', s.view(), s.event('two').e);
    expect(s.tab.state.doc.toString()).toBe('two\none\ntwo');
  });

  it('leaves an empty paste to the editor', () => {
    const s = setup('abc', { platform: 'linux' });
    const ev = s.event('');
    expect(s.flow.onPaste('t', s.view(), ev.e)).toBe(false);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('converts a note that the paste makes too big, in the full edition', () => {
    const s = setup('abc', { platform: 'linux', dest: 'sticky' });
    const big = 'x'.repeat(SNAPSHOT_CONTENT_MAX + 1);
    s.flow.onPaste('sticky', s.view(), s.event(big).e);
    expect(s.tab.applied).toHaveLength(0);
    expect(s.startConversion).toHaveBeenCalledTimes(1);
    const req = s.startConversion.mock.calls[0]?.[0];
    expect(req?.source).toEqual({ kind: 'text', text: big });
    expect(req?.ranges).toEqual([{ from: 3, to: 3, line: 1 }]);
    expect(req?.dest).toBe('sticky');
    expect(s.tab.locks.get('sticky')?.phase).toBe('full');
  });

  it('pastes the same note as it is in the free edition', () => {
    const s = setup('abc', { platform: 'linux', dest: 'sticky', lite: true });
    const big = 'x'.repeat(SNAPSHOT_CONTENT_MAX + 1);
    s.flow.onPaste('sticky', s.view(), s.event(big).e);
    expect(s.startConversion).not.toHaveBeenCalled();
    expect(s.tab.state.doc.length).toBe(3 + big.length);
  });

  it('pastes the text routed from the menu through the same decision', () => {
    const s = setup('abc', { platform: 'linux', dest: 'sticky' });
    s.flow.pasteText(
      'sticky',
      s.tab.state,
      'y'.repeat(SNAPSHOT_CONTENT_MAX + 1),
    );
    expect(s.startConversion).toHaveBeenCalledTimes(1);
    const t = setup('abc', { platform: 'linux' });
    t.flow.pasteText('t', t.tab.state, 'zz');
    expect(t.tab.state.doc.toString()).toBe('abczz');
  });
});

describe('PasteFlow where clips exist', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the paste and never reads the event', async () => {
    const s = setup('abc');
    const ev = s.event('web text');
    expect(s.flow.onPaste('t', s.view(), ev.e)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.getData).not.toHaveBeenCalled();
    s.clipStatus.mockResolvedValue(clipInfo());
    await settle();
    expect(ev.getData).not.toHaveBeenCalled();
  });

  it('takes the mark at the event', () => {
    const s = setup('abc');
    s.flow.onPaste('t', s.view(), s.event().e);
    expect(s.env.clipPasteMark).toHaveBeenCalledTimes(1);
  });

  it('locks the tab while waiting: editable, but no document change gets through', async () => {
    const s = setup('abc');
    s.redispatchPaste.mockReturnValue(new Promise(() => {}));
    s.flow.onPaste('t', s.view(), s.event().e);
    await settle();
    expect(s.tab.locks.get('t')?.phase).toBe('wait');
    expect(s.tab.state.facet(EditorView.editable)).toBe(true);
    const typed = s.tab.state.update({ changes: { from: 0, insert: 'Q' } });
    expect(typed.state.doc.toString()).toBe('abc');
  });

  it('refuses a second paste while the tab is locked', async () => {
    const s = setup('abc');
    s.redispatchPaste.mockReturnValue(new Promise(() => {}));
    s.flow.onPaste('t', s.view(), s.event().e);
    await settle();
    const calls = s.clipStatus.mock.calls.length;
    const second = s.event('again');
    expect(s.flow.onPaste('t', s.view(), second.e)).toBe(true);
    expect(second.preventDefault).toHaveBeenCalled();
    await settle();
    expect(s.clipStatus.mock.calls.length).toBe(calls);
  });

  it('pastes external text in one locked transaction and unlocks', async () => {
    const s = setup('abc');
    const sent = s.event('from elsewhere');
    s.redispatchPaste.mockImplementation(() => {
      s.waiter.handle({
        clipboardData: sent.e.clipboardData,
        preventDefault: sent.preventDefault,
        stopImmediatePropagation: () => {},
      });
      return Promise.resolve('send');
    });
    const pressed = s.event('web side');
    s.flow.onPaste('t', s.view(), pressed.e);
    await settle();
    expect(pressed.getData).not.toHaveBeenCalled();
    expect(sent.getData).toHaveBeenCalledTimes(1);
    expect(s.tab.applied).toHaveLength(1);
    expect(s.tab.state.doc.toString()).toBe('abcfrom elsewhere');
    expect(s.tab.locks.any()).toBe(false);
    expect(s.tab.shown.at(-1)).toBeUndefined();
    expect(s.tab.state.readOnly).toBe(false);
  });

  it('pastes at the place the paste was pressed, not where the selection went meanwhile', async () => {
    const s = setup('abc', { platform: 'windows' });
    s.tab.state = s.tab.state.update({ selection: { anchor: 1 } }).state;
    let release: (t: string) => void = () => {};
    s.readText.mockImplementation(
      () => new Promise<string>((r) => (release = r)),
    );
    s.flow.onPaste('t', s.view(), s.event().e);
    await settle();
    s.tab.state = s.tab.state.update({ selection: { anchor: 3 } }).state;
    release('Z');
    await settle();
    expect(s.tab.state.doc.toString()).toBe('aZbc');
  });

  it('releases the tab after two seconds and pastes at the selection by then', async () => {
    const s = setup('abc', { platform: 'windows' });
    let release: (t: string) => void = () => {};
    s.readText.mockImplementation(
      () => new Promise<string>((r) => (release = r)),
    );
    s.flow.onPaste('t', s.view(), s.event().e);
    await vi.advanceTimersByTimeAsync(PASTE_SLOW_MS);
    expect(s.tab.locks.any()).toBe(false);
    expect(s.tab.state.readOnly).toBe(false);
    s.tab.state = s.tab.state.update({
      changes: { from: 0, insert: '>' },
      selection: { anchor: 4 },
    }).state;
    release('LATE');
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(s.tab.state.doc.toString()).toBe('>abcLATE');
  });

  it('pastes nothing when the clipboard has no text', async () => {
    const s = setup('abc', { platform: 'windows' });
    s.readText.mockRejectedValue(new Error('none'));
    s.flow.onPaste('t', s.view(), s.event().e);
    await settle();
    expect(s.tab.applied).toHaveLength(0);
    expect(s.tab.locks.any()).toBe(false);
  });

  it('lets go of the lock when the tab is gone', async () => {
    const s = setup('abc', { platform: 'windows' });
    let release: (t: string) => void = () => {};
    s.readText.mockImplementation(
      () => new Promise<string>((r) => (release = r)),
    );
    s.flow.onPaste('t', s.view(), s.event().e);
    await settle();
    s.tab.vanish();
    release('x');
    await settle();
    expect(s.tab.applied).toHaveLength(0);
    expect(s.tab.locks.any()).toBe(false);
  });

  describe('a clip', () => {
    const chunks = (parts: string[]) => {
      let sent = 0;
      return (_pin: number, offset: number) => {
        let at = 0;
        for (const part of parts) {
          if (at === offset) {
            sent += 1;
            return Promise.resolve({ text: part, next: at + part.length });
          }
          at += part.length;
        }
        return Promise.reject(new Error(`no chunk at ${offset} (${sent})`));
      };
    };

    it('is read back a block at a time and pasted in one transaction', async () => {
      const s = setup('abc');
      const parts = ['12\n34', '56\n7', '89'];
      const bytes = parts.join('').length;
      s.clipStatus.mockResolvedValue(clipInfo({ bytes, lines: 3 }));
      s.readChunk.mockImplementation(chunks(parts));
      const ev = s.event('never');
      s.flow.onPaste('t', s.view(), ev.e);
      await settle();
      expect(ev.getData).not.toHaveBeenCalled();
      expect(s.readChunk.mock.calls.map((c) => c[1])).toEqual([0, 5, 9]);
      expect(s.tab.applied).toHaveLength(1);
      expect(s.tab.state.doc.toString()).toBe('abc12\n3456\n789');
      expect(s.tab.locks.any()).toBe(false);
      expect(s.redispatchPaste).not.toHaveBeenCalled();
      expect(s.readText).not.toHaveBeenCalled();
    });

    it('stays locked while it is read, with no change but its own accepted', async () => {
      const s = setup('abc');
      s.clipStatus.mockResolvedValue(clipInfo({ bytes: 4 }));
      let give: (v: { text: string; next: number }) => void = () => {};
      s.readChunk.mockImplementation(() => new Promise((r) => (give = r)));
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      expect(s.tab.locks.get('t')?.phase).toBe('wait');
      expect(
        s.tab.state
          .update({ changes: { from: 0, insert: 'Q' } })
          .state.doc.toString(),
      ).toBe('abc');
      give({ text: 'wxyz', next: 4 });
      await settle();
      expect(s.tab.state.doc.toString()).toBe('abcwxyz');
    });

    it('goes above the caret line, with a break, when it is a line-wise copy', async () => {
      const s = setup('one\ntwo');
      s.tab.state = s.tab.state.update({ selection: { anchor: 5 } }).state;
      s.clipStatus.mockResolvedValue(clipInfo({ bytes: 3, linewise: true }));
      s.readChunk.mockImplementation(chunks(['new']));
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      expect(s.tab.state.doc.toString()).toBe('one\nnew\ntwo');
      expect(s.tab.state.selection.main.head).toBe(9);
    });

    it('replaces a selection even when the clip is line-wise', async () => {
      const s = setup('one\ntwo');
      s.tab.state = s.tab.state.update({
        selection: { anchor: 0, head: 3 },
      }).state;
      s.clipStatus.mockResolvedValue(clipInfo({ bytes: 3, linewise: true }));
      s.readChunk.mockImplementation(chunks(['new']));
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      expect(s.tab.state.doc.toString()).toBe('new\ntwo');
    });

    it('asks the conversion when the document would pass the limit', async () => {
      const s = setup('abc');
      s.clipStatus.mockResolvedValue(
        clipInfo({ bytes: 101 * 1024 * 1024, utf16_len: 101 * 1024 * 1024 }),
      );
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      expect(s.readChunk).not.toHaveBeenCalled();
      expect(s.startConversion).toHaveBeenCalledTimes(1);
      const req = s.startConversion.mock.calls[0]?.[0];
      expect(req?.source.kind).toBe('clip');
      expect(req?.dest).toBe('document');
      expect(req?.tabId).toBe('t');
      expect(req?.ranges).toEqual([{ from: 3, to: 3, line: null }]);
      expect(req?.linewise).toBe(false);
      expect(req?.doc.toString()).toBe('abc');
      expect(s.tab.state.facet(EditorView.editable)).toBe(false);
      expect(s.tab.locks.get('t')?.phase).toBe('full');
      req?.unlock();
      expect(s.tab.locks.any()).toBe(false);
      expect(s.tab.state.readOnly).toBe(false);
    });

    it('records a line-wise clip as the start of the caret line with a break', async () => {
      const s = setup('one\ntwo');
      s.tab.state = s.tab.state.update({ selection: { anchor: 5 } }).state;
      s.clipStatus.mockResolvedValue(
        clipInfo({
          bytes: 200 * 1024 * 1024,
          utf16_len: 200 * 1024 * 1024,
          linewise: true,
        }),
      );
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      const req = s.startConversion.mock.calls[0]?.[0];
      expect(req?.ranges).toEqual([{ from: 4, to: 4, line: null }]);
      expect(req?.linewise).toBe(true);
    });

    it('in the free edition reads any size back in blocks of at most 1 MiB, with no confirmation', async () => {
      const s = setup('abc', { dest: 'sticky', lite: true });
      const block = 1024 * 1024;
      const total = 20 * block;
      s.clipStatus.mockResolvedValue(
        clipInfo({ bytes: total, utf16_len: total, lines: 1 }),
      );
      const asked: number[] = [];
      s.readChunk.mockImplementation((_pin, offset) => {
        asked.push(offset);
        const size = Math.min(block, total - offset);
        return Promise.resolve({ text: 'x'.repeat(size), next: offset + size });
      });
      const ev = s.event('never');
      s.flow.onPaste('sticky', s.view(), ev.e);
      await settle();
      expect(ev.getData).not.toHaveBeenCalled();
      expect(s.startConversion).not.toHaveBeenCalled();
      expect(asked).toHaveLength(20);
      expect(asked.every((o, i) => o === i * block)).toBe(true);
      expect(s.tab.applied).toHaveLength(1);
      expect(s.tab.state.doc.length).toBe(3 + total);
    });

    it('in the full edition converts the same note instead of reading it', async () => {
      const s = setup('abc', { dest: 'sticky' });
      const total = 20 * 1024 * 1024;
      s.clipStatus.mockResolvedValue(
        clipInfo({ bytes: total, utf16_len: total }),
      );
      s.flow.onPaste('sticky', s.view(), s.event().e);
      await settle();
      expect(s.readChunk).not.toHaveBeenCalled();
      expect(s.startConversion).toHaveBeenCalledTimes(1);
    });

    it('goes on with the text of the clipboard when the clip is replaced before it is pinned', async () => {
      const s = setup('abc', { platform: 'windows' });
      s.clipStatus.mockResolvedValueOnce(clipInfo({ bytes: 4 }));
      s.pin.mockRejectedValue('not-ours');
      s.readText.mockResolvedValue('instead');
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      expect(s.readChunk).not.toHaveBeenCalled();
      expect(s.tab.state.doc.toString()).toBe('abcinstead');
      expect(s.tab.locks.any()).toBe(false);
    });

    it('reads the clip through the pin it took and gives the pin back', async () => {
      const s = setup('abc');
      s.clipStatus.mockResolvedValue(clipInfo({ id: 'k', bytes: 6 }));
      s.readChunk.mockImplementation(chunks(['xy', 'zw', 'uv']));
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      // One pin, taken once, serves every read.
      expect(s.pin).toHaveBeenCalledTimes(1);
      expect(s.pin).toHaveBeenCalledWith('k');
      expect(s.readChunk.mock.calls.map((c) => c[0])).toEqual([5, 5, 5]);
      expect(s.unpin).toHaveBeenCalledTimes(1);
      expect(s.unpin).toHaveBeenCalledWith(5);
    });

    it('holds the pin while the clip is read, renewing nothing: a pin has no deadline', async () => {
      const s = setup('abc');
      s.clipStatus.mockResolvedValue(clipInfo({ bytes: 4 }));
      s.readChunk.mockImplementation(() => new Promise(() => {}));
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      expect(s.env.tokens.tokens()).toEqual([]);
      expect(s.unpin).not.toHaveBeenCalled();
    });

    it('pastes nothing, unlocks, gives the pin back and tells the user when the pin is gone', async () => {
      const s = setup('abc');
      s.clipStatus.mockResolvedValue(clipInfo({ bytes: 4 }));
      s.readChunk.mockRejectedValue('pin-gone');
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      expect(s.tab.applied).toHaveLength(0);
      expect(s.tab.state.doc.toString()).toBe('abc');
      expect(s.tab.locks.any()).toBe(false);
      expect(s.unpin).toHaveBeenCalledWith(5);
      expect(s.reportFailure).toHaveBeenCalledTimes(1);
      expect(s.reportFailure).toHaveBeenCalledWith(t('paste.clipUnreadable'));
    });

    it.each([
      [
        'an operating system error as it came',
        'Permission denied (os error 13)',
        'Permission denied (os error 13)',
      ],
      [
        'a read the system failed with its detail',
        'clip-read: Permission denied (os error 13)',
        t('paste.clipReadFailed', {
          detail: 'Permission denied (os error 13)',
        }),
      ],
      [
        'text that is not UTF-8 as unreadable',
        'not-utf8',
        t('paste.clipUnreadable'),
      ],
    ])('tells the user %s', async (_name, error, text) => {
      const s = setup('abc');
      s.clipStatus.mockResolvedValue(clipInfo({ bytes: 4 }));
      s.readChunk.mockRejectedValue(error);
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      expect(s.tab.applied).toHaveLength(0);
      expect(s.tab.locks.any()).toBe(false);
      expect(s.unpin).toHaveBeenCalledWith(5);
      expect(s.reportFailure).toHaveBeenCalledTimes(1);
      expect(s.reportFailure).toHaveBeenCalledWith(text);
    });

    it('tells the user when the clip stops giving text', async () => {
      const s = setup('abc');
      s.clipStatus.mockResolvedValue(clipInfo({ bytes: 4 }));
      s.readChunk.mockResolvedValue({ text: 'x', next: 0 });
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      expect(s.reportFailure).toHaveBeenCalledTimes(1);
      expect(s.reportFailure).toHaveBeenCalledWith(t('paste.clipUnreadable'));
      expect(s.tab.locks.any()).toBe(false);
    });

    it('tells nobody when the failure is not a read: the host cannot apply the paste', async () => {
      const s = setup('abc');
      s.clipStatus.mockResolvedValue(clipInfo({ bytes: 4 }));
      s.readChunk.mockImplementation(chunks(['wxyz']));
      s.tab.host.apply = () => {
        throw new Error('apply failed');
      };
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      expect(s.reportFailure).not.toHaveBeenCalled();
      expect(s.tab.locks.any()).toBe(false);
      expect(s.unpin).toHaveBeenCalledWith(5);
    });

    it('hands the pin to the conversion, which gives it back', async () => {
      const s = setup('abc');
      s.clipStatus.mockResolvedValue(
        clipInfo({ bytes: 101 * 1024 * 1024, utf16_len: 101 * 1024 * 1024 }),
      );
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      const req = s.startConversion.mock.calls[0]?.[0];
      expect(req?.clip?.pin).toBe(5);
      expect(s.unpin).not.toHaveBeenCalled();
      req?.clip?.release();
      expect(s.unpin).toHaveBeenCalledWith(5);
    });

    describe('over several selections, as the text of a paste is pasted', () => {
      const cases: {
        name: string;
        doc: string;
        sel: [number, number?][];
        clip: string;
        linewise?: boolean;
        expected: string;
      }[] = [
        {
          name: 'one line to each selection when the clip has as many lines',
          doc: 'one\ntwo\nthree',
          sel: [[3], [7], [13]],
          clip: 'a\nb\nc',
          expected: 'onea\ntwob\nthreec',
        },
        {
          name: 'the whole clip in each selection otherwise',
          doc: 'one\ntwo',
          sel: [[3], [7]],
          clip: 'a\nb\nc',
          expected: 'onea\nb\nc\ntwoa\nb\nc',
        },
        {
          name: 'one line to each replaced selection',
          doc: 'one\ntwo',
          sel: [
            [0, 3],
            [4, 7],
          ],
          clip: 'AA\nBB',
          expected: 'AA\nBB',
        },
        {
          name: 'a line-wise clip above each caret line once',
          doc: 'one\ntwo',
          sel: [[1], [2], [5]],
          clip: 'X',
          linewise: true,
          expected: 'X\none\nX\ntwo',
        },
        {
          name: 'a line-wise clip of as many lines as there are carets, one to each line',
          doc: 'one\ntwo',
          sel: [[1], [5]],
          clip: 'X\nY',
          linewise: true,
          expected: 'X\none\nY\ntwo',
        },
      ];
      for (const c of cases) {
        it(c.name, async () => {
          const s = setup(c.doc);
          s.tab.state = s.tab.state.update({
            selection: EditorSelection.create(
              c.sel.map(([a, h]) => EditorSelection.range(a, h ?? a)),
            ),
          }).state;
          const reference = (): string =>
            s.tab.state
              .update(
                pasteSpec(s.tab.state, c.clip, c.linewise ? c.clip : null),
              )
              .state.doc.toString();
          const want = reference();
          s.clipStatus.mockResolvedValue(
            clipInfo({
              bytes: c.clip.length,
              lines: c.clip.split('\n').length,
              linewise: c.linewise === true,
            }),
          );
          s.readChunk.mockImplementation(chunks([c.clip]));
          s.flow.onPaste('t', s.view(), s.event().e);
          await settle();
          expect(s.tab.state.doc.toString()).toBe(want);
          expect(want).toBe(c.expected);
          expect(s.tab.applied).toHaveLength(1);
        });
      }
    });

    it('does not apply a clip read for a tab that was closed', async () => {
      const s = setup('abc');
      s.clipStatus.mockResolvedValue(clipInfo({ bytes: 4 }));
      let give: (v: { text: string; next: number }) => void = () => {};
      s.readChunk.mockImplementation(() => new Promise((r) => (give = r)));
      s.flow.onPaste('t', s.view(), s.event().e);
      await settle();
      s.tab.locks.drop('t');
      give({ text: 'wxyz', next: 4 });
      await settle();
      expect(s.tab.applied).toHaveLength(0);
    });
  });
});

describe('routePastedText', () => {
  it('hands the text to the editor registered for the view', () => {
    const view = {};
    const got: string[] = [];
    const forget = registerPasteTarget(view, (text) => got.push(text));
    expect(routePastedText(view, 'abc')).toBe(true);
    expect(got).toEqual(['abc']);
    forget();
    expect(routePastedText(view, 'abc')).toBe(false);
  });

  it('makes the menu paste take the same decision as an event: a note that grows too big converts', () => {
    const s = setup('abc', { platform: 'linux', dest: 'sticky' });
    const view = {};
    registerPasteTarget(view, (text) =>
      s.flow.pasteText('sticky', s.tab.state, text),
    );
    routePastedText(view, 'q'.repeat(SNAPSHOT_CONTENT_MAX + 1));
    expect(s.startConversion).toHaveBeenCalledTimes(1);
    expect(s.tab.applied).toHaveLength(0);
  });

  it('leaves a view that is not ours to the caller', () => {
    expect(routePastedText({}, 'x')).toBe(false);
  });
});
