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

  it('inserts text into a field without a selection API through execCommand', () => {
    const execCommand = vi.fn();
    vi.stubGlobal('document', { execCommand });
    pasteEnv.insertText('42');
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, '42');
  });
});
