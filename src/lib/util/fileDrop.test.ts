// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFileDrag, onFileDragOver, onFileDrop } from './fileDrop';

type Spied = DragEvent & {
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
};

function dragEvent(types: string[], files: unknown[] = []): Spied {
  return {
    dataTransfer: { types, files },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as Spied;
}

function installNativeWebview(): ReturnType<typeof vi.fn> {
  const post = vi.fn();
  vi.stubGlobal('chrome', {
    webview: { postMessageWithAdditionalObjects: post },
  });
  return post;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isFileDrag', () => {
  it('is true for files only', () => {
    expect(isFileDrag(['Files'])).toBe(true);
  });

  it('is true when files come with other types', () => {
    expect(isFileDrag(['text/plain', 'Files'])).toBe(true);
  });

  it('is false for text', () => {
    expect(isFileDrag(['text/plain', 'text/html'])).toBe(false);
  });

  it('is false for no types', () => {
    expect(isFileDrag([])).toBe(false);
  });
});

describe('without the native webview', () => {
  it('leaves a file drop alone', () => {
    const e = dragEvent(['Files']);
    onFileDrop(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it('leaves a file dragover alone', () => {
    const e = dragEvent(['Files']);
    onFileDragOver(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores a chrome object that has no webview bridge', () => {
    vi.stubGlobal('chrome', {});
    const e = dragEvent(['Files']);
    onFileDrop(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('with the native webview', () => {
  it('forwards the dropped files with the agreed message', () => {
    const post = installNativeWebview();
    const files = [{ name: 'a.txt' }, { name: 'b.txt' }];
    const e = dragEvent(['Files'], files);
    onFileDrop(e);
    expect(post).toHaveBeenCalledExactlyOnceWith('note-n-pad:file-drop', files);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalledOnce();
  });

  it('accepts a file dragover', () => {
    installNativeWebview();
    const e = dragEvent(['Files']);
    onFileDragOver(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalledOnce();
    expect(e.dataTransfer?.dropEffect).toBe('copy');
  });

  it('leaves a text drag to the editor', () => {
    const post = installNativeWebview();
    const over = dragEvent(['text/plain']);
    const drop = dragEvent(['text/plain']);
    onFileDragOver(over);
    onFileDrop(drop);
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(drop.preventDefault).not.toHaveBeenCalled();
    expect(drop.stopPropagation).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('ignores an event without a data transfer', () => {
    const post = installNativeWebview();
    const e = {
      dataTransfer: null,
      preventDefault: vi.fn(),
    } as unknown as DragEvent;
    onFileDrop(e);
    expect(post).not.toHaveBeenCalled();
  });
});
