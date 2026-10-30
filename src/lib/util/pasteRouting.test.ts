// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from '@codemirror/state';
import type { ClipInfo } from './clipRouting';
import { LiveTokens } from './liveTokens';
import { SNAPSHOT_CONTENT_MAX } from './snapshotPolicy';
import {
  BUSY_RETRY_MS,
  PASTE_DOC_LIMIT,
  PASTE_SLOW_MS,
  RedispatchWaiter,
  fieldPaste,
  hasClips,
  pasteDecision,
  pasteErrorText,
  pasteRange,
  pastedSize,
  pastedText,
  resolveClip,
  runWindowedPaste,
  utf8Length,
  windowedPasteAction,
  windowedTextVia,
  type FieldDeps,
  type PasteEventLike,
  type ResolveDeps,
  type TextBegin,
} from './pasteRouting';
import { LARGE_FILE_THRESHOLD } from '../state/documentWindow.svelte';
import { t } from '../i18n';

const info = (over: Partial<ClipInfo> = {}): ClipInfo => ({
  id: '1-0-1',
  bytes: 10,
  lines: 1,
  utf16_len: 10,
  crlf: 0,
  linewise: false,
  ...over,
});
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};
/** A paste event that counts its `getData` calls. */
function pasteEvent(text: string) {
  const getData = vi.fn((type: string) => (type === 'text/plain' ? text : ''));
  const preventDefault = vi.fn();
  const stopImmediatePropagation = vi.fn();
  const e: PasteEventLike = {
    clipboardData: { getData },
    preventDefault,
    stopImmediatePropagation,
  };
  return { e, getData, preventDefault, stopImmediatePropagation };
}

interface Harness {
  deps: ResolveDeps;
  tokens: LiveTokens;
  waiter: RedispatchWaiter;
  clipStatus: ReturnType<typeof vi.fn>;
  textBegin: ReturnType<typeof vi.fn>;
  textEnd: ReturnType<typeof vi.fn>;
  pin: ReturnType<typeof vi.fn>;
  unpin: ReturnType<typeof vi.fn>;
  redispatchPaste: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
  userInput: { fire: () => void; armed: () => boolean };
  /** The core's `clip-gate-revoked` events. */
  revoked: { fire: (token: number) => void; armed: () => boolean };
}
function harness(over: Partial<ResolveDeps> = {}): Harness {
  const tokens = new LiveTokens();
  const waiter = new RedispatchWaiter();
  const clipStatus = vi.fn(() => Promise.resolve<ClipInfo | null>(null));
  const textBegin = vi.fn(() =>
    Promise.resolve<TextBegin>({ kind: 'gate', token: 5 }),
  );
  const textEnd = vi.fn((_token: number) => Promise.resolve(true));
  const pin = vi.fn((_id: string) => Promise.resolve(7));
  const unpin = vi.fn();
  const redispatchPaste = vi.fn(() =>
    Promise.resolve<'send' | 'not-key' | 'not-handled'>('send'),
  );
  const readText = vi.fn(() => Promise.resolve('typed elsewhere'));
  let listener: (() => void) | null = null;
  const userInput = {
    fire: (): void => listener?.(),
    armed: (): boolean => listener !== null,
  };
  let revokeListener: ((token: number) => void) | null = null;
  const revoked = {
    fire: (token: number): void => revokeListener?.(token),
    armed: (): boolean => revokeListener !== null,
  };
  const deps: ResolveDeps = {
    platform: 'macos',
    clipStatus,
    textBegin,
    textEnd,
    onGateRevoked: (cb) => {
      revokeListener = cb;
      return () => {
        revokeListener = null;
      };
    },
    pin,
    unpin,
    redispatchPaste,
    readText,
    focusStill: () => true,
    waiter,
    userInput: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    tokens,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...over,
  };
  return {
    deps,
    tokens,
    waiter,
    clipStatus,
    textBegin,
    textEnd,
    pin,
    unpin,
    redispatchPaste,
    readText,
    userInput,
    revoked,
  };
}

describe('resolveClip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers a clip with the mark it was given, reading no text', async () => {
    const h = harness();
    h.clipStatus.mockResolvedValue(info({ id: 'a' }));
    const r = await resolveClip(h.deps, Promise.resolve(42), 'web');
    expect(r).toMatchObject({ kind: 'clip', info: info({ id: 'a' }), pin: 7 });
    expect(h.clipStatus).toHaveBeenCalledWith(42);
    expect(h.textBegin).not.toHaveBeenCalled();
    expect(h.redispatchPaste).not.toHaveBeenCalled();
    expect(h.readText).not.toHaveBeenCalled();
  });

  it.each(['1-0-1', '9-4-2', 'whatever'])(
    'takes the clip %s for a clip, not for text',
    async (id) => {
      const h = harness();
      h.clipStatus.mockResolvedValue(info({ id }));
      const r = await resolveClip(h.deps, 7, 'web');
      expect(r.kind).toBe('clip');
      expect(h.readText).not.toHaveBeenCalled();
    },
  );

  it('pins the clip at once, by its id, and holds no token for the pin: it has no deadline', async () => {
    const h = harness();
    h.clipStatus.mockResolvedValue(info({ id: 'p' }));
    const r = await resolveClip(h.deps, 1, 'web');
    expect(h.pin).toHaveBeenCalledWith('p');
    if (r.kind !== 'clip') {
      throw new Error('a clip was expected');
    }
    expect(h.tokens.tokens()).toEqual([]);
    r.release();
    r.release();
    expect(h.tokens.tokens()).toEqual([]);
    expect(h.unpin).toHaveBeenCalledTimes(1);
    expect(h.unpin).toHaveBeenCalledWith(7);
  });

  it('takes a clip that cannot be pinned for text: the core reads it', async () => {
    const h = harness();
    h.clipStatus.mockResolvedValue(info());
    h.pin.mockRejectedValue('not-ours');
    expect(await resolveClip(h.deps, 1, 'core')).toEqual({ kind: 'system' });
    expect(h.tokens.tokens()).toEqual([]);
  });

  it('takes a clip that cannot be pinned for text: the page reads it on the web way', async () => {
    const h = harness();
    h.clipStatus.mockResolvedValue(info());
    h.pin.mockRejectedValue('not-ours');
    const ev = pasteEvent('after the clip');
    h.redispatchPaste.mockImplementation(() => {
      h.waiter.handle(ev.e);
      return Promise.resolve('send');
    });
    const r = await resolveClip(h.deps, 1, 'web');
    expect(r).toEqual({ kind: 'text', text: 'after the clip' });
    expect(h.textBegin).toHaveBeenCalledTimes(1);
  });

  it('asks again when the clip the gate named is gone before it is pinned, and gives up after a few tries', async () => {
    const h = harness();
    h.textBegin.mockResolvedValue({ kind: 'ours', info: info({ id: 'g' }) });
    h.pin.mockRejectedValue('not-ours');
    expect(await resolveClip(h.deps, 1, 'web')).toEqual({ kind: 'none' });
    expect(h.pin).toHaveBeenCalledTimes(4);
  });

  it('leaves external text to the core when asked to', async () => {
    const h = harness();
    const r = await resolveClip(h.deps, 3, 'core');
    expect(r).toEqual({ kind: 'system' });
    expect(h.textBegin).not.toHaveBeenCalled();
    expect(h.redispatchPaste).not.toHaveBeenCalled();
    expect(h.readText).not.toHaveBeenCalled();
  });

  it('passes a clip the gate finds on the clipboard', async () => {
    const h = harness();
    h.textBegin.mockResolvedValue({ kind: 'ours', info: info({ id: 'b' }) });
    const r = await resolveClip(h.deps, 3, 'web');
    expect(r).toMatchObject({ kind: 'clip', info: info({ id: 'b' }), pin: 7 });
    expect(h.pin).toHaveBeenCalledWith('b');
    expect(h.redispatchPaste).not.toHaveBeenCalled();
    expect(h.readText).not.toHaveBeenCalled();
  });

  it('asks the status again after a short wait while a clip is handed over', async () => {
    const h = harness();
    h.textBegin.mockResolvedValueOnce({ kind: 'busy' });
    h.clipStatus
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(info({ id: 'c' }));
    const pending = resolveClip(h.deps, 3, 'web');
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
    expect(await pending).toMatchObject({
      kind: 'clip',
      info: info({ id: 'c' }),
    });
    expect(h.clipStatus).toHaveBeenCalledTimes(2);
  });

  it('has the core send a paste on macOS and takes the text it carries', async () => {
    const h = harness();
    const ev = pasteEvent('from elsewhere');
    h.redispatchPaste.mockImplementation(() => {
      h.waiter.handle(ev.e);
      return Promise.resolve('send');
    });
    const r = await resolveClip(h.deps, 3, 'web');
    expect(r).toEqual({ kind: 'text', text: 'from elsewhere' });
    expect(h.readText).not.toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(ev.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(h.textEnd).toHaveBeenCalledTimes(1);
    expect(h.textEnd).toHaveBeenCalledWith(5);
    expect(h.tokens.tokens()).toEqual([]);
  });

  it('reads the clipboard in the page on Windows', async () => {
    const h = harness({ platform: 'windows' });
    const r = await resolveClip(h.deps, 3, 'web');
    expect(r).toEqual({ kind: 'text', text: 'typed elsewhere' });
    expect(h.readText).toHaveBeenCalledTimes(1);
    expect(h.redispatchPaste).not.toHaveBeenCalled();
    expect(h.textEnd).toHaveBeenCalledWith(5);
  });

  it('pastes nothing when the clipboard has no text to read', async () => {
    const h = harness({ platform: 'windows' });
    h.readText.mockRejectedValue(new Error('empty'));
    expect(await resolveClip(h.deps, 3, 'web')).toEqual({ kind: 'none' });
    expect(h.textEnd).toHaveBeenCalledTimes(1);
  });

  it('reads nothing once the focus has left, and closes the gate', async () => {
    const h = harness({ focusStill: () => false });
    expect(await resolveClip(h.deps, 3, 'web')).toEqual({ kind: 'none' });
    expect(h.redispatchPaste).not.toHaveBeenCalled();
    expect(h.readText).not.toHaveBeenCalled();
    expect(h.textEnd).toHaveBeenCalledTimes(1);
  });

  it('pastes nothing when the core does not send to this window', async () => {
    const h = harness();
    h.redispatchPaste.mockResolvedValue('not-key');
    expect(await resolveClip(h.deps, 3, 'web')).toEqual({ kind: 'none' });
    expect(h.textEnd).toHaveBeenCalledTimes(1);
  });

  it('stops waiting at once when no responder took the paste, and closes the gate', async () => {
    const h = harness();
    h.redispatchPaste.mockResolvedValue('not-handled');
    // No timer moves: nothing waits for the two seconds.
    expect(await resolveClip(h.deps, 3, 'web')).toEqual({ kind: 'none' });
    expect(h.textEnd).toHaveBeenCalledTimes(1);
    expect(h.textEnd).toHaveBeenCalledWith(5);
    expect(h.tokens.tokens()).toEqual([]);
    const late = pasteEvent('after');
    h.waiter.handle(late.e);
    expect(late.getData).not.toHaveBeenCalled();
  });

  it.each(['macos', 'windows'])(
    'drops the text when the core no longer held the gate it read behind (%s)',
    async (platform) => {
      const h = harness({ platform });
      h.textEnd.mockResolvedValue(false);
      h.redispatchPaste.mockImplementation(() => {
        h.waiter.handle(pasteEvent('maybe our clip').e);
        return Promise.resolve('send');
      });
      expect(await resolveClip(h.deps, 3, 'web')).toEqual({ kind: 'none' });
      expect(h.textEnd).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the text when the core still held the gate', async () => {
    const h = harness({ platform: 'windows' });
    h.textEnd.mockResolvedValue(true);
    expect(await resolveClip(h.deps, 3, 'web')).toEqual({
      kind: 'text',
      text: 'typed elsewhere',
    });
  });

  describe('a read that takes long', () => {
    it('releases the editor after two seconds and goes on waiting, the gate open', async () => {
      const h = harness();
      const onSlow = vi.fn();
      let done = false;
      const pending = resolveClip(h.deps, 3, 'web', { onSlow }).then((r) => {
        done = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(PASTE_SLOW_MS - 1);
      expect(onSlow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onSlow).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(done).toBe(false);
      expect(h.textEnd).not.toHaveBeenCalled();
      expect(h.tokens.tokens('gate')).toEqual([5]);
      const ev = pasteEvent('late but not revoked');
      h.waiter.handle(ev.e);
      expect(await pending).toEqual({
        kind: 'text',
        text: 'late but not revoked',
      });
      expect(ev.getData).toHaveBeenCalled();
      expect(h.textEnd).toHaveBeenCalledTimes(1);
    });

    it('does not arm the revoke before the editor is released', async () => {
      const h = harness();
      const pending = resolveClip(h.deps, 3, 'web');
      await vi.advanceTimersByTimeAsync(PASTE_SLOW_MS - 1);
      expect(h.userInput.armed()).toBe(false);
      h.waiter.handle(pasteEvent('x').e);
      await pending;
    });

    it('revokes on the user input that follows: the gate closes, a later paste is left alone', async () => {
      const h = harness();
      const pending = resolveClip(h.deps, 3, 'web');
      await vi.advanceTimersByTimeAsync(PASTE_SLOW_MS);
      expect(h.userInput.armed()).toBe(true);
      h.userInput.fire();
      expect(await pending).toEqual({ kind: 'none' });
      expect(h.textEnd).toHaveBeenCalledTimes(1);
      expect(h.tokens.tokens()).toEqual([]);
      const late = pasteEvent('after the revoke');
      h.waiter.handle(late.e);
      expect(late.getData).not.toHaveBeenCalled();
      expect(late.preventDefault).not.toHaveBeenCalled();
    });

    describe('revoked by the core', () => {
      it('closes the gate in order: first nothing is read any more, then the tokens go, then the core is told', async () => {
        const seen: { read: number; tokens: number[] }[] = [];
        let probe: ReturnType<typeof harness>;
        const textEnd = vi.fn((_token: number) => {
          const late = pasteEvent('probe');
          probe.waiter.handle(late.e);
          seen.push({
            read: late.getData.mock.calls.length,
            tokens: probe.tokens.tokens(),
          });
          return Promise.resolve(true);
        });
        probe = harness({ textEnd });
        const pending = resolveClip(probe.deps, 3, 'web');
        await vi.advanceTimersByTimeAsync(PASTE_SLOW_MS + 1000);
        expect(probe.textEnd).not.toHaveBeenCalled();
        probe.revoked.fire(5);
        expect(await pending).toEqual({ kind: 'none' });
        expect(textEnd).toHaveBeenCalledTimes(1);
        expect(textEnd).toHaveBeenCalledWith(5);
        expect(seen).toEqual([{ read: 0, tokens: [] }]);
      });

      it('leaves a paste that comes after the event to the ordinary paste, and takes one that came before', async () => {
        const h = harness();
        const first = resolveClip(h.deps, 3, 'web');
        await vi.advanceTimersByTimeAsync(PASTE_SLOW_MS + 1000);
        const before = pasteEvent('before the event');
        h.waiter.handle(before.e);
        expect(await first).toEqual({ kind: 'text', text: 'before the event' });
        expect(before.getData).toHaveBeenCalled();
        const g = harness();
        const second = resolveClip(g.deps, 3, 'web');
        await vi.advanceTimersByTimeAsync(PASTE_SLOW_MS + 1000);
        g.revoked.fire(5);
        expect(await second).toEqual({ kind: 'none' });
        const after = pasteEvent('after the event');
        g.waiter.handle(after.e);
        expect(after.getData).not.toHaveBeenCalled();
        expect(after.preventDefault).not.toHaveBeenCalled();
      });

      it('drops a Windows read that comes back after the event', async () => {
        const h = harness({ platform: 'windows' });
        let answer: (text: string) => void = () => {};
        h.readText.mockImplementation(
          () => new Promise<string>((resolve) => (answer = resolve)),
        );
        const pending = resolveClip(h.deps, 3, 'web');
        await vi.advanceTimersByTimeAsync(PASTE_SLOW_MS + 1000);
        h.revoked.fire(5);
        expect(await pending).toEqual({ kind: 'none' });
        answer('too late');
        await settle();
        expect(h.textEnd).toHaveBeenCalledTimes(1);
      });

      it('is not moved by the event of a gate of another paste', async () => {
        const h = harness();
        const pending = resolveClip(h.deps, 3, 'web');
        await vi.advanceTimersByTimeAsync(PASTE_SLOW_MS + 1000);
        h.revoked.fire(99);
        await settle();
        expect(h.textEnd).not.toHaveBeenCalled();
        expect(h.tokens.tokens('gate')).toEqual([5]);
        h.waiter.handle(pasteEvent('still wanted').e);
        expect(await pending).toEqual({ kind: 'text', text: 'still wanted' });
      });

      it('stops listening when the paste is over', async () => {
        const h = harness();
        const pending = resolveClip(h.deps, 3, 'web');
        await settle();
        expect(h.revoked.armed()).toBe(true);
        h.waiter.handle(pasteEvent('x').e);
        await pending;
        expect(h.revoked.armed()).toBe(false);
      });
    });

    it('reads on Windows however long it takes, with no input', async () => {
      const h = harness({ platform: 'windows' });
      let answer: (text: string) => void = () => {};
      h.readText.mockImplementation(
        () => new Promise<string>((resolve) => (answer = resolve)),
      );
      const pending = resolveClip(h.deps, 3, 'web');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.textEnd).not.toHaveBeenCalled();
      expect(h.tokens.tokens('gate')).toEqual([5]);
      answer('a very large text');
      expect(await pending).toEqual({
        kind: 'text',
        text: 'a very large text',
      });
      expect(h.textEnd).toHaveBeenCalledTimes(1);
    });

    it('drops a Windows read that comes back after the user typed', async () => {
      const h = harness({ platform: 'windows' });
      let answer: (text: string) => void = () => {};
      h.readText.mockImplementation(
        () => new Promise<string>((resolve) => (answer = resolve)),
      );
      const pending = resolveClip(h.deps, 3, 'web');
      await vi.advanceTimersByTimeAsync(5000);
      h.userInput.fire();
      expect(await pending).toEqual({ kind: 'none' });
      answer('too late');
      await settle();
      expect(h.textEnd).toHaveBeenCalledTimes(1);
    });
  });
});

describe('RedispatchWaiter', () => {
  it('leaves a paste alone when nothing waits', () => {
    const ev = pasteEvent('x');
    new RedispatchWaiter().handle(ev.e);
    expect(ev.getData).not.toHaveBeenCalled();
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('takes the text for the wait whose gate is open', async () => {
    const waiter = new RedispatchWaiter();
    const wait = waiter.expect({ open: true });
    const ev = pasteEvent('abc');
    waiter.handle(ev.e);
    expect(await wait.text).toBe('abc');
    expect(ev.getData).toHaveBeenCalledTimes(1);
  });

  it('never calls getData for a wait whose gate is closed', () => {
    const waiter = new RedispatchWaiter();
    waiter.expect({ open: false });
    const ev = pasteEvent('abc');
    waiter.handle(ev.e);
    expect(ev.getData).not.toHaveBeenCalled();
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('serves the waits in the order they began', async () => {
    const waiter = new RedispatchWaiter();
    const a = waiter.expect({ open: true });
    const b = waiter.expect({ open: true });
    waiter.handle(pasteEvent('1').e);
    waiter.handle(pasteEvent('2').e);
    expect(await a.text).toBe('1');
    expect(await b.text).toBe('2');
  });

  it('forgets a wait that was cancelled', () => {
    const waiter = new RedispatchWaiter();
    waiter.expect({ open: true }).cancel();
    const ev = pasteEvent('x');
    waiter.handle(ev.e);
    expect(ev.getData).not.toHaveBeenCalled();
  });

  it('falls back to the URI list when the text is empty', () => {
    const getData = vi.fn((type: string) =>
      type === 'text/uri-list' ? 'file:///a' : '',
    );
    expect(pastedText({ getData })).toBe('file:///a');
    expect(pastedText(null)).toBe('');
  });
});

describe('pastedSize', () => {
  const doc = Text.of(['héllo', 'wörld', 'end']);
  // 'héllo' is 6 bytes, 'wörld' 6, 'end' 3, and two breaks of one byte.
  const base = {
    dest: 'document' as const,
    doc,
    from: 0,
    to: 0,
    eol: '\n' as const,
    limit: 1,
  };
  const text = (t: string) => ({ kind: 'text' as const, text: t });

  it('counts a document as the file it is written to, without a pasted text', () => {
    const r = pastedSize({ ...base, source: text('') });
    expect(r).toEqual({ size: 17, exact: true });
  });

  it('counts the break of every line as one byte with LF and two with CRLF', () => {
    const lf = pastedSize({ ...base, source: text('') });
    const crlf = pastedSize({ ...base, eol: '\r\n', source: text('') });
    expect(lf.size).toBe(17);
    expect(crlf.size).toBe(19);
  });

  it('takes the replaced selection out and adds the pasted text', () => {
    const r = pastedSize({ ...base, from: 0, to: 5, source: text('xy') });
    // 'héllo' (6 bytes) replaced by 'xy'.
    expect(r.size).toBe(17 - 6 + 2);
  });

  it('counts a clip as its bytes less one for every CRLF it holds', () => {
    const plain = info({ bytes: 100, lines: 3, crlf: 0, utf16_len: 100 });
    const crlf = info({ bytes: 100, lines: 3, crlf: 2, utf16_len: 100 });
    const a = pastedSize({ ...base, source: { kind: 'clip', info: plain } });
    const b = pastedSize({ ...base, source: { kind: 'clip', info: crlf } });
    expect(a.size).toBe(17 + 100);
    expect(b.size).toBe(17 + 98);
  });

  it('adds the clip lines to a CRLF document as the breaks it will be written with', () => {
    const clip = info({ bytes: 100, lines: 5, crlf: 0, utf16_len: 100 });
    const lf = pastedSize({ ...base, source: { kind: 'clip', info: clip } });
    const crlf = pastedSize({
      ...base,
      eol: '\r\n',
      source: { kind: 'clip', info: clip },
    });
    // The two breaks of the document and the four of the clip.
    expect(crlf.size - lf.size).toBe(2 + 4);
  });

  it('counts text with its line breaks unified', () => {
    const r = pastedSize({ ...base, source: text('a\r\nb\rc') });
    // a, \n, b, \n, c: five bytes and two breaks.
    expect(r.size).toBe(17 + 5);
    const w = pastedSize({
      ...base,
      eol: '\r\n',
      source: text('a\r\nb\rc'),
    });
    expect(w.size).toBe(17 + 5 + 2 + 2);
  });

  it('adds the break a line-wise paste leaves after the text', () => {
    const r = pastedSize({ ...base, source: text('ab'), linewise: true });
    expect(r.size).toBe(17 + 2 + 1);
  });

  it('counts a note in UTF-16 units: a clip less its CRLFs', () => {
    const clip = info({ bytes: 500, utf16_len: 400, crlf: 10 });
    const r = pastedSize({
      ...base,
      dest: 'sticky',
      from: 2,
      to: 7,
      source: { kind: 'clip', info: clip },
    });
    expect(r.size).toBe(doc.length - 5 + 390);
    expect(r.exact).toBe(true);
  });

  it('counts a note of text in UTF-16 units, not bytes', () => {
    const r = pastedSize({
      ...base,
      dest: 'sticky',
      source: text('éé\r\n'),
    });
    expect(r.size).toBe(doc.length + 3);
  });

  it('does not read the document when the worst case is under the limit', () => {
    const spy = vi.spyOn(doc, 'iterRange');
    const r = pastedSize({
      ...base,
      limit: 10_000,
      source: text('abc'),
    });
    expect(spy).not.toHaveBeenCalled();
    expect(r.exact).toBe(false);
    expect(r.size).toBeLessThanOrEqual(10_000);
    spy.mockRestore();
  });

  it('reads the document once the worst case is over the limit', () => {
    const spy = vi.spyOn(doc, 'iterRange');
    pastedSize({ ...base, limit: 20, source: text('abc') });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('lands exactly on the limit, and one above it', () => {
    const kept = doc.length - 0;
    expect(kept).toBe(15);
    const at = (extra: number) =>
      pastedSize({
        ...base,
        limit: 17 + extra,
        source: text('x'.repeat(extra)),
      });
    const exactAt = at(40);
    expect(exactAt.size).toBe(17 + 40);
    const decide = (size: number) =>
      pasteDecision({ dest: 'document', full: true, size });
    expect(decide(PASTE_DOC_LIMIT)).toBe('paste');
    expect(decide(PASTE_DOC_LIMIT + 1)).toBe('convert');
  });
});

describe('utf8Length', () => {
  it('matches the encoder, lone surrogates included', () => {
    const enc = new TextEncoder();
    for (const s of [
      '',
      'abc',
      'é',
      '日本語',
      '😀',
      'a\ud800b',
      '\udc00',
      '😀😀',
    ]) {
      expect(utf8Length(s)).toBe(enc.encode(s).length);
    }
  });
});

describe('D8 decision', () => {
  const dests = ['document', 'sticky'] as const;
  it.each(dests)('%s: converts above its limit in the full edition', (dest) => {
    const limit = dest === 'document' ? PASTE_DOC_LIMIT : SNAPSHOT_CONTENT_MAX;
    expect(pasteDecision({ dest, full: true, size: limit })).toBe('paste');
    expect(pasteDecision({ dest, full: true, size: limit + 1 })).toBe(
      'convert',
    );
    expect(pasteDecision({ dest, full: true, size: 0 })).toBe('paste');
  });

  it.each(dests)('%s: never converts in the free edition', (dest) => {
    expect(pasteDecision({ dest, full: false, size: 10 ** 12 })).toBe('paste');
  });

  it('keeps the document limit of the document window', () => {
    expect(PASTE_DOC_LIMIT).toBe(LARGE_FILE_THRESHOLD);
  });
});

describe('pasteRange', () => {
  const doc = Text.of(['one', 'two', 'three']);
  const caret = { from: 5, to: 5, head: 5, empty: true };
  const sel = { from: 1, to: 6, head: 6, empty: false };

  it('puts a line-wise clip at the start of the caret line, with a break after it', () => {
    expect(pasteRange(doc, caret, true)).toEqual({
      from: 4,
      to: 4,
      appendBreak: true,
    });
  });

  it('replaces the selection when it is not collapsed, line-wise or not', () => {
    expect(pasteRange(doc, sel, true)).toEqual({
      from: 1,
      to: 6,
      appendBreak: false,
    });
    expect(pasteRange(doc, sel, false)).toEqual({
      from: 1,
      to: 6,
      appendBreak: false,
    });
  });

  it('inserts at the caret when the clip is not line-wise', () => {
    expect(pasteRange(doc, caret, false)).toEqual({
      from: 5,
      to: 5,
      appendBreak: false,
    });
  });
});

describe('windowedPasteAction', () => {
  const mark = Promise.resolve(8);
  it('leaves a find or goto field to itself', () => {
    expect(
      windowedPasteAction({ focus: 'other', hasClips: true, mark }),
    ).toEqual({ kind: 'field' });
    expect(
      windowedPasteAction({ focus: 'other', hasClips: false, mark }),
    ).toEqual({ kind: 'field' });
  });

  it.each(['editor', 'none'] as const)(
    'queues a paste with %s focus where there are clips, the mark of the event kept',
    (focus) => {
      const r = windowedPasteAction({ focus, hasClips: true, mark });
      expect(r.kind).toBe('queue');
      if (r.kind === 'queue') {
        expect(r.item.kind).toBe('clipPaste');
        expect(r.item.mark).toBe(mark);
      }
    },
  );

  it.each(['editor', 'none'] as const)(
    'pastes natively with %s focus where there are no clips',
    (focus) => {
      expect(windowedPasteAction({ focus, hasClips: false, mark })).toEqual({
        kind: 'native',
      });
    },
  );

  it('knows the hosts that have clips', () => {
    expect(hasClips('macos')).toBe(true);
    expect(hasClips('windows')).toBe(true);
    expect(hasClips('linux')).toBe(false);
    expect(hasClips('')).toBe(false);
  });
});

describe('windowedTextVia', () => {
  it('reads in the page only for a selection that fits, an editor that takes input and has focus', () => {
    for (const fits of [true, false]) {
      for (const editable of [true, false]) {
        for (const focused of [true, false]) {
          expect(windowedTextVia({ fits, editable, focused })).toBe(
            fits && editable && focused ? 'web' : 'core',
          );
        }
      }
    }
  });
});

describe('runWindowedPaste', () => {
  const io = () => {
    const pasteClip = vi.fn((pin: number, i: ClipInfo) =>
      Promise.resolve(`clip ${i.id} ${pin}`),
    );
    const pasteSystem = vi.fn(() => Promise.resolve('system'));
    const clipStatus = vi.fn(() => Promise.resolve<ClipInfo | null>(null));
    const pin = vi.fn((_id: string) => Promise.resolve(9));
    const unpin = vi.fn();
    const report = vi.fn();
    return { pasteClip, pasteSystem, clipStatus, pin, unpin, report };
  };
  const held = (release = vi.fn()) => ({
    kind: 'clip' as const,
    info: info(),
    pin: 4,
    release,
  });

  it('pastes the clip through the pin it holds and lets go of it', async () => {
    const x = io();
    const release = vi.fn();
    expect(await runWindowedPaste(x, held(release))).toEqual({
      kind: 'done',
      value: 'clip 1-0-1 4',
    });
    expect(x.pin).not.toHaveBeenCalled();
    expect(x.pasteSystem).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('pastes the system text when told so', async () => {
    const x = io();
    expect(await runWindowedPaste(x, { kind: 'system' })).toEqual({
      kind: 'done',
      value: 'system',
    });
    expect(x.pasteClip).not.toHaveBeenCalled();
  });

  it('asks for the clip anew, pins it and lets go of that pin, when the system text turns out to be ours', async () => {
    const x = io();
    x.pasteSystem.mockRejectedValueOnce('ours');
    x.clipStatus.mockResolvedValue(info({ id: 'new' }));
    expect(await runWindowedPaste(x, { kind: 'system' })).toEqual({
      kind: 'done',
      value: 'clip new 9',
    });
    expect(x.pin).toHaveBeenCalledWith('new');
    expect(x.unpin).toHaveBeenCalledWith(9);
  });

  it('goes back to the system text when the clip is gone by then, or cannot be pinned', async () => {
    const x = io();
    x.pasteSystem.mockRejectedValueOnce('ours');
    expect(await runWindowedPaste(x, { kind: 'system' })).toEqual({
      kind: 'done',
      value: 'system',
    });
    expect(x.pasteSystem).toHaveBeenCalledTimes(2);
    const y = io();
    y.pasteSystem.mockRejectedValueOnce('ours');
    y.clipStatus.mockResolvedValue(info());
    y.pin.mockRejectedValue('not-ours');
    expect(await runWindowedPaste(y, { kind: 'system' })).toEqual({
      kind: 'done',
      value: 'system',
    });
    expect(y.unpin).not.toHaveBeenCalled();
  });

  it('changes nothing, tells the user and lets go of the pin when the pin is gone', async () => {
    const x = io();
    x.pasteClip.mockRejectedValue('pin-gone');
    const release = vi.fn();
    expect(await runWindowedPaste(x, held(release))).toEqual({ kind: 'gone' });
    expect(x.report).toHaveBeenCalledTimes(1);
    expect(x.report).toHaveBeenCalledWith(t('paste.clipUnreadable'));
    expect(x.report).not.toHaveBeenCalledWith('pin-gone');
    expect(release).toHaveBeenCalledTimes(1);
    expect(x.pasteSystem).not.toHaveBeenCalled();
  });

  it('changes nothing and tells the user when the core could not read the clip', async () => {
    const x = io();
    x.pasteClip.mockRejectedValue('clip-read: Permission denied (os error 13)');
    const release = vi.fn();
    expect(await runWindowedPaste(x, held(release))).toEqual({ kind: 'gone' });
    expect(x.report).toHaveBeenCalledTimes(1);
    expect(x.report).toHaveBeenCalledWith(
      t('paste.clipReadFailed', { detail: 'Permission denied (os error 13)' }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('lets an error with no read prefix through, with the pin let go', async () => {
    const x = io();
    x.pasteClip.mockRejectedValue('No space left on device (os error 28)');
    const release = vi.fn();
    await expect(runWindowedPaste(x, held(release))).rejects.toBe(
      'No space left on device (os error 28)',
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(x.report).not.toHaveBeenCalled();
  });

  it('gives up when the clipboard keeps changing', async () => {
    const x = io();
    x.pasteSystem.mockRejectedValue('ours');
    x.clipStatus.mockResolvedValue(info());
    x.pasteClip.mockRejectedValue('disk full');
    await expect(runWindowedPaste(x, { kind: 'system' })).rejects.toBe(
      'disk full',
    );
    const y = io();
    y.pasteSystem.mockRejectedValue('ours');
    y.clipStatus.mockResolvedValue(null);
    await expect(runWindowedPaste(y, { kind: 'system' })).rejects.toThrow(
      'kept changing',
    );
  });
});

describe('pasteErrorText', () => {
  const os = 'Permission denied (os error 13)';
  const clipRead = t('paste.clipReadFailed', { detail: os });
  const unreadable = t('paste.clipUnreadable');
  const interrupted = t('convert.interrupted');
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logged.mockRestore();
  });
  it.each([
    ['pin-gone', 'pin-gone', unreadable, false],
    ['not-utf8', 'not-utf8', unreadable, false],
    ['clip-stalled', new Error('clip-stalled'), unreadable, false],
    ['line-out-of-range', 'line-out-of-range', unreadable, false],
    ['a read the system failed', `clip-read: ${os}`, clipRead, false],
    ['an operating system error', os, os, false],
    ['an Error object', new Error('no note'), interrupted, true],
    ['unknown-convert', 'unknown-convert', interrupted, true],
    ['a text not listed', 'something new', interrupted, true],
    [
      'an error with no os error',
      'unsupported encoding: X-NEW',
      interrupted,
      true,
    ],
  ])('says the right thing for %s', (_name, error, text, logs) => {
    expect(pasteErrorText(error)).toBe(text);
    expect(logged).toHaveBeenCalledTimes(logs ? 1 : 0);
    if (logs) {
      expect(logged).toHaveBeenCalledWith(
        error instanceof Error ? error.message : error,
      );
    }
  });
  it('never shows an internal code', () => {
    for (const code of ['pin-gone', 'unknown-convert', 'window-gone']) {
      expect(pasteErrorText(code)).not.toContain(code);
    }
  });
});

describe('fieldPaste', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function field(start: number, end: number) {
    const dispatched: Event[] = [];
    return {
      selectionStart: start,
      selectionEnd: end,
      setRangeText: vi.fn(),
      dispatchEvent: (e: Event) => {
        dispatched.push(e);
        return true;
      },
      dispatched,
    };
  }
  /** A `type="number"` field: no selection API, and `setRangeText` throws. */
  function numberField() {
    const dispatched: Event[] = [];
    return {
      selectionStart: null,
      selectionEnd: null,
      setRangeText: vi.fn(() => {
        throw new DOMException('not text', 'InvalidStateError');
      }),
      dispatchEvent: (e: Event) => {
        dispatched.push(e);
        return true;
      },
      dispatched,
    };
  }
  function fieldDeps(over: Partial<FieldDeps> = {}, target?: unknown) {
    const h = harness();
    const insertText = vi.fn<(text: string) => void>();
    const deps: FieldDeps = {
      ...h.deps,
      clipPasteMark: () => Promise.resolve(4),
      hasFocus: () => true,
      activeElement: () => target,
      insertText,
      ...over,
    };
    return { h, deps, insertText };
  }

  it('refuses a clip: the event is prevented and nothing is read or inserted', async () => {
    const f = field(0, 0);
    const { h, deps } = fieldDeps({}, f);
    h.clipStatus.mockResolvedValue(info());
    const ev = pasteEvent('web side');
    await fieldPaste(ev.e, f, deps);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(ev.getData).not.toHaveBeenCalled();
    expect(f.setRangeText).not.toHaveBeenCalled();
    expect(h.clipStatus).toHaveBeenCalledWith(4);
    // The pin it took is given back.
    expect(h.unpin).toHaveBeenCalledWith(7);
  });

  it('inserts external text at the selection the field had at the event', async () => {
    const f = field(2, 5);
    const { h, deps } = fieldDeps({ platform: 'windows' }, f);
    h.readText.mockResolvedValue('abc');
    const ev = pasteEvent('never read');
    const pending = fieldPaste(ev.e, f, deps);
    f.selectionStart = 0;
    f.selectionEnd = 0;
    await pending;
    expect(ev.getData).not.toHaveBeenCalled();
    expect(f.setRangeText).toHaveBeenCalledWith('abc', 2, 5, 'end');
    expect(f.dispatched.map((e) => e.type)).toEqual(['input']);
  });

  it('types external text into a field with no selection API, at its caret', async () => {
    const f = numberField();
    const { h, deps, insertText } = fieldDeps({ platform: 'windows' }, f);
    h.readText.mockResolvedValue('42');
    const ev = pasteEvent('never read');
    await fieldPaste(ev.e, f, deps);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(insertText).toHaveBeenCalledWith('42');
    expect(f.setRangeText).not.toHaveBeenCalled();
    // Typing fires the field's own input event.
    expect(f.dispatched).toEqual([]);
  });

  it('types nothing into a field with no selection API when the focus has moved on or the clipboard holds a clip', async () => {
    const f = numberField();
    const moved = fieldDeps({ platform: 'windows' }, {});
    moved.h.readText.mockResolvedValue('42');
    await fieldPaste(pasteEvent('x').e, f, moved.deps);
    expect(moved.insertText).not.toHaveBeenCalled();
    const clip = fieldDeps({}, f);
    clip.h.clipStatus.mockResolvedValue(info());
    await fieldPaste(pasteEvent('x').e, f, clip.deps);
    expect(clip.insertText).not.toHaveBeenCalled();
  });

  it('keeps setRangeText for a field that has a selection', async () => {
    const f = field(1, 1);
    const { h, deps, insertText } = fieldDeps({ platform: 'windows' }, f);
    h.readText.mockResolvedValue('7');
    await fieldPaste(pasteEvent('x').e, f, deps);
    expect(f.setRangeText).toHaveBeenCalledWith('7', 1, 1, 'end');
    expect(insertText).not.toHaveBeenCalled();
  });

  it('inserts nothing when the focus has moved on', async () => {
    const f = field(0, 0);
    const { h, deps } = fieldDeps({ platform: 'windows' }, {});
    h.readText.mockResolvedValue('abc');
    await fieldPaste(pasteEvent('x').e, f, deps);
    expect(f.setRangeText).not.toHaveBeenCalled();
    expect(h.readText).not.toHaveBeenCalled();
  });

  it('inserts nothing and reads nothing when the window lost the focus', async () => {
    const f = field(0, 0);
    const { h, deps } = fieldDeps(
      { platform: 'windows', hasFocus: () => false },
      f,
    );
    await fieldPaste(pasteEvent('x').e, f, deps);
    expect(h.readText).not.toHaveBeenCalled();
    expect(f.setRangeText).not.toHaveBeenCalled();
    expect(h.textEnd).toHaveBeenCalledTimes(1);
  });

  it('leaves the paste to the field where there are no clips', async () => {
    const f = field(0, 0);
    const { deps } = fieldDeps({ platform: 'linux' }, f);
    const ev = pasteEvent('x');
    await fieldPaste(ev.e, f, deps);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(ev.getData).not.toHaveBeenCalled();
    expect(f.setRangeText).not.toHaveBeenCalled();
  });
});
