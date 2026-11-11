// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));
const listened: [string, (e: { payload: number }) => void][] = [];
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (e: { payload: number }) => void) => {
    listened.push([name, cb]);
    return Promise.resolve(() => {});
  },
}));

const { installPasteWindow, pasteEnv, pasteFlowDeps, redispatchWaiter } =
  await import('./pasteEnv');
const { convertController } = await import('../state/convertController.svelte');
const { t } = await import('../i18n');
const { liveTokens } = await import('./liveTokens');
const { holdClipStatus, releaseClipStatus } =
  await import('../dev/windowedHold');

describe('the paste routing of a window', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(null);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('puts the first paste listener on the window and renews the held tokens every five seconds', async () => {
    const added: [string, unknown, unknown][] = [];
    const removed: string[] = [];
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: unknown, capture: unknown) =>
        added.push([type, fn, capture]),
      removeEventListener: (type: string) => removed.push(type),
    });
    const stop = installPasteWindow();
    expect(added).toEqual([['paste', redispatchWaiter.handle, true]]);
    const forget = liveTokens.hold('gate', 21);
    await vi.advanceTimersByTimeAsync(5000);
    expect(invoke).toHaveBeenCalledWith('clip_copy_keepalive', {
      tokens: [21],
    });
    forget();
    invoke.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(invoke).not.toHaveBeenCalled();
    stop();
    expect(removed).toEqual(['paste']);
  });

  it('asks the status with the mark, and can hold the answer', async () => {
    invoke.mockResolvedValue({ id: 'x' });
    expect(await pasteEnv.clipStatus(7)).toEqual({ id: 'x' });
    expect(invoke).toHaveBeenCalledWith('clip_status', { mark: 7 });
    holdClipStatus(true);
    let answered = false;
    const pending = pasteEnv.clipStatus(null).then((r) => {
      answered = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(answered).toBe(false);
    releaseClipStatus();
    expect(await pending).toEqual({ id: 'x' });
  });

  it('takes the mark of a paste in one call and tells the gate it is over by its token', async () => {
    invoke.mockResolvedValue(12);
    expect(await pasteEnv.clipPasteMark()).toBe(12);
    expect(invoke).toHaveBeenCalledWith('clip_paste_mark', undefined);
    invoke.mockResolvedValue(true);
    expect(await pasteEnv.textEnd(9)).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('clip_text_end', { token: 9 });
  });

  it('takes the answer of the core to the end of a gate as it is, and a failed call as a gate that was lost', async () => {
    invoke.mockResolvedValue(false);
    expect(await pasteEnv.textEnd(9)).toBe(false);
    invoke.mockRejectedValue('x');
    expect(await pasteEnv.textEnd(9)).toBe(false);
  });

  it('hands the gates the core revokes to the pastes that listen, until they stop', () => {
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    listened.length = 0;
    const stop = installPasteWindow();
    const revoked = listened.filter(([name]) => name === 'clip-gate-revoked');
    expect(revoked).toHaveLength(1);
    const seen: number[] = [];
    const forget = pasteEnv.onGateRevoked((token) => seen.push(token));
    revoked[0]?.[1]({ payload: 5 });
    forget();
    revoked[0]?.[1]({ payload: 6 });
    expect(seen).toEqual([5]);
    stop();
  });

  it('shows a failed read of a clip as a failed paste', () => {
    const report = vi.spyOn(convertController, 'report').mockReturnValue();
    pasteFlowDeps.reportFailure('Permission denied (os error 13)');
    expect(report).toHaveBeenCalledWith(
      t('convert.failed', { error: 'Permission denied (os error 13)' }),
    );
  });

  it('takes no mark when the core fails to number one', async () => {
    invoke.mockRejectedValue('x');
    expect(await pasteEnv.clipPasteMark()).toBeNull();
  });

  describe('the core reading plain text', () => {
    const CHUNK = 1048576;
    /** The core holding `bytes` for gate 4; chunks come from `chunk`, which
     *  defaults to the core's slices. */
    function serve(
      bytes: Uint8Array,
      chunk: (offset: number) => unknown = (offset) =>
        bytes.slice(offset, offset + CHUNK).buffer,
    ) {
      invoke.mockImplementation((cmd, args) => {
        if (cmd === 'ipc_probe') {
          return Promise.resolve(new Uint8Array([0]).buffer);
        }
        if (cmd === 'clip_text_read') {
          return Promise.resolve({ kind: 'text', bytes: bytes.byteLength });
        }
        if (cmd === 'clip_text_chunk') {
          return Promise.resolve(chunk((args as { offset: number }).offset));
        }
        return Promise.reject(new Error(`unexpected ${cmd}`));
      });
    }
    const chunkCalls = () =>
      invoke.mock.calls.filter(([cmd]) => cmd === 'clip_text_chunk');

    it.each([
      [0, 0],
      [1, 1],
      [CHUNK, 1],
      [CHUNK + 1, 2],
      [3 * CHUNK - 2, 3],
    ])(
      'asks for %i bytes in exactly as many chunks as they fill (%i)',
      async (size, calls) => {
        const text = 'x'.repeat(size);
        serve(new TextEncoder().encode(text));
        expect(await pasteEnv.readSystemText(4)).toEqual({
          kind: 'text',
          text,
        });
        expect(chunkCalls()).toHaveLength(calls);
        expect(chunkCalls().map(([, args]) => args)).toEqual(
          Array.from({ length: calls }, (_, i) => ({
            token: 4,
            offset: i * CHUNK,
          })),
        );
        expect(invoke).toHaveBeenCalledWith('clip_text_read', { token: 4 });
      },
    );

    it('decodes a character cut by a chunk boundary, and keeps a leading U+FEFF', async () => {
      const text = '\u{FEFF}' + 'a'.repeat(CHUNK - 4) + '\u{65E5}\u{1F600}end';
      const bytes = new TextEncoder().encode(text);
      expect(bytes.byteLength).toBeGreaterThan(CHUNK);
      serve(bytes);
      expect(await pasteEnv.readSystemText(4)).toEqual({ kind: 'text', text });
      expect(chunkCalls()).toHaveLength(2);
    });

    it('takes chunks of varying sizes until it has every byte', async () => {
      // Chunks made of whole spans fall short of the chunk size by varying
      // amounts; one cuts a character in two.
      const text = 'a'.repeat(CHUNK - 3) + '\u{65E5}'.repeat(680000) + 'end';
      const bytes = new TextEncoder().encode(text);
      const sizes = [CHUNK - 2, CHUNK - 4096, CHUNK - 70000];
      const ends = sizes.map((_, i) =>
        sizes.slice(0, i + 1).reduce((sum, size) => sum + size, 0),
      );
      expect(ends.at(-1)).toBeLessThan(bytes.byteLength);
      ends.push(bytes.byteLength);
      expect(Math.ceil(bytes.byteLength / CHUNK)).toBeLessThan(ends.length);
      serve(bytes, (offset) => {
        const end = ends.find((e) => e > offset) ?? offset;
        return bytes.slice(offset, end).buffer;
      });
      expect(await pasteEnv.readSystemText(4)).toEqual({ kind: 'text', text });
      expect(chunkCalls().map(([, args]) => args)).toEqual(
        [0, ...ends.slice(0, -1)].map((offset) => ({ token: 4, offset })),
      );
    });

    it.each([
      ['a chunk that is not raw bytes', () => [1, 2, 3]],
      ['an empty chunk before the end', () => new ArrayBuffer(0)],
      ['a chunk past the end', () => new Uint8Array(5).buffer],
    ])('takes %s for anything but plain text', async (_, chunk) => {
      serve(new TextEncoder().encode('abcd'), chunk);
      expect(await pasteEnv.readSystemText(4)).toEqual({ kind: 'other' });
    });

    it('takes bytes that are not UTF-8 for anything but plain text', async () => {
      serve(new Uint8Array([0x61, 0xff, 0x62]));
      expect(await pasteEnv.readSystemText(4)).toEqual({ kind: 'other' });
    });

    it('answers none when the core refuses the gate, and other for any other failure', async () => {
      serve(new TextEncoder().encode('abcd'), () => {
        throw 'clip-gate-refused';
      });
      expect(await pasteEnv.readSystemText(4)).toEqual({ kind: 'none' });
      invoke.mockImplementation((cmd) =>
        cmd === 'ipc_probe'
          ? Promise.resolve(new ArrayBuffer(1))
          : Promise.reject('clip-gate-refused'),
      );
      expect(await pasteEnv.readSystemText(4)).toEqual({ kind: 'none' });
      invoke.mockImplementation((cmd) =>
        cmd === 'ipc_probe'
          ? Promise.resolve(new ArrayBuffer(1))
          : Promise.reject('the main thread did not answer'),
      );
      expect(await pasteEnv.readSystemText(4)).toEqual({ kind: 'other' });
    });

    it.each(['other', 'not_key', 'none'] as const)(
      'passes on %s from the core and asks for no chunk',
      async (kind) => {
        invoke.mockImplementation((cmd) =>
          Promise.resolve(cmd === 'ipc_probe' ? new ArrayBuffer(1) : { kind }),
        );
        expect(await pasteEnv.readSystemText(4)).toEqual({ kind });
        expect(chunkCalls()).toHaveLength(0);
      },
    );

    it('has the paste handed to the page when raw bytes cannot cross', async () => {
      for (const probe of [[0], null, undefined]) {
        invoke.mockReset();
        invoke.mockResolvedValue(probe);
        expect(await pasteEnv.readSystemText(4)).toEqual({ kind: 'other' });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith('ipc_probe', undefined);
      }
      invoke.mockReset();
      invoke.mockRejectedValue(new Error('no probe'));
      expect(await pasteEnv.readSystemText(4)).toEqual({ kind: 'other' });
    });
  });

  it('inserts text into a field without a selection API through execCommand', () => {
    const execCommand = vi.fn();
    vi.stubGlobal('document', { execCommand });
    pasteEnv.insertText('42');
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, '42');
  });
});
