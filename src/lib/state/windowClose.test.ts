// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { closeDocumentWindow } from './windowClose';

describe('closing a document window', () => {
  it('settles the transfers, then finishes', async () => {
    const order: string[] = [];
    let settled: () => void = () => {};
    const win = {
      settleTransfers: () =>
        new Promise<void>((resolve) => {
          order.push('settle');
          settled = resolve;
        }),
    };
    const closing = closeDocumentWindow(win, () => {
      order.push('finish');
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(order).toEqual(['settle']);
    settled();
    await closing;
    expect(order).toEqual(['settle', 'finish']);
  });

  it('lets go of what the close held back and goes on with the error when finish throws', async () => {
    const failed = vi.fn();
    const win = { settleTransfers: () => Promise.resolve() };
    await expect(
      closeDocumentWindow(
        win,
        () => Promise.reject(new Error('refused')),
        failed,
      ),
    ).rejects.toThrow('refused');
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('does not say it failed when it did not', async () => {
    const failed = vi.fn();
    await closeDocumentWindow(
      { settleTransfers: () => Promise.resolve() },
      () => Promise.resolve(),
      failed,
    );
    expect(failed).not.toHaveBeenCalled();
  });

  it('does not finish when the settling itself fails', async () => {
    const finish = vi.fn(() => Promise.resolve());
    await expect(
      closeDocumentWindow(
        { settleTransfers: () => Promise.reject(new Error('no')) },
        finish,
      ),
    ).rejects.toThrow('no');
    expect(finish).not.toHaveBeenCalled();
  });
});
