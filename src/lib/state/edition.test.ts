// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The edition mirror follows the Rust core: the `edition_info` read settles it
// before `ready()` resolves, and `edition-changed` moves it afterwards. Runes
// compiled for SSR do not run fine-grained reactivity, but plain field reads
// and writes and async methods work, which is all that is asserted here.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { EditionState } from './edition.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

type Handler = (event: { payload: boolean }) => void;
let emit: Handler = () => {};

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  emit = () => {};
  mockListen.mockImplementation(async (_name, handler) => {
    emit = handler as unknown as Handler;
    return () => {};
  });
});

describe('EditionState', () => {
  it('starts lite, before anything has been read', () => {
    expect(new EditionState().lite).toBe(true);
  });

  it('takes the value edition_info reports once ready() resolves', async () => {
    mockInvoke.mockResolvedValue(false);
    const state = new EditionState();
    await state.ready();
    expect(mockInvoke).toHaveBeenCalledWith('edition_info');
    expect(state.lite).toBe(false);
  });

  it('shares one load between every caller', async () => {
    mockInvoke.mockResolvedValue(false);
    const state = new EditionState();
    await Promise.all([state.ready(), state.ready()]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledTimes(1);
  });

  it('follows edition-changed in both directions', async () => {
    mockInvoke.mockResolvedValue(true);
    const state = new EditionState();
    await state.ready();
    expect(state.lite).toBe(true);
    emit({ payload: false });
    expect(state.lite).toBe(false);
    emit({ payload: true });
    expect(state.lite).toBe(true);
  });

  it('lets an event that lands during the read win over the read', async () => {
    let finishRead: (lite: boolean) => void = () => {};
    mockInvoke.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishRead = resolve;
      }),
    );
    const state = new EditionState();
    const ready = state.ready();
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    emit({ payload: false });
    finishRead(true);
    await ready;
    expect(state.lite).toBe(false);
  });

  it('stays lite when the edition cannot be read', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInvoke.mockRejectedValue(new Error('no core'));
    const state = new EditionState();
    await state.ready();
    expect(state.lite).toBe(true);
    quiet.mockRestore();
  });
});
