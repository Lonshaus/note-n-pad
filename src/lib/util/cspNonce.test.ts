// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readCspNonce } from './cspNonce';
import indexHtml from '../../../index.html?raw';
// Vitest runs in the node environment here (no jsdom / happy-dom installed), so
// the search root is a stub. It answers `style[data-nonce]` only, which is what
// the implementation has to ask for: a bare `style` selector matches
// CodeMirror's own prepended <style> in a real window.
function rootWith(nonce: string | null): ParentNode {
  return {
    querySelector: (sel: string) =>
      sel === 'style[data-nonce]' && nonce !== null
        ? { getAttribute: () => nonce }
        : null,
  } as unknown as ParentNode;
}

describe('readCspNonce', () => {
  it('reads the data-nonce attribute', () => {
    expect(readCspNonce(rootWith('abc123'))).toBe('abc123');
  });

  it('returns an empty string when the token was never replaced', () => {
    // `vite dev` serves index.html verbatim; there is no nonce to report.
    expect(readCspNonce(rootWith('__TAURI_STYLE_NONCE__'))).toBe('');
  });

  it('returns an empty string when there is no carrier element', () => {
    expect(readCspNonce(rootWith(null))).toBe('');
  });

  // Without this, a Tauri upgrade that renames the token would leave the nonce
  // unreadable and silently kill every CodeMirror stylesheet under `style-src`.
  it('index.html carries the token the implementation looks for', () => {
    expect(indexHtml).toContain('data-nonce="__TAURI_STYLE_NONCE__"');
  });
});
