// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isInputLike, shouldFocusEditor } from './editorFocus';

// Minimal Element-like stand-in so these pure predicates run under the default
// node environment (no jsdom).
function el(
  tagName: string,
  opts: { contentEditable?: boolean; role?: string } = {},
): Element {
  return {
    tagName,
    isContentEditable: opts.contentEditable ?? false,
    getAttribute: (name: string) =>
      name === 'role' ? (opts.role ?? null) : null,
  } as unknown as Element;
}

describe('isInputLike', () => {
  it('treats null and BODY as idle (not input-like)', () => {
    expect(isInputLike(null)).toBe(false);
    expect(isInputLike(el('BODY'))).toBe(false);
  });

  it('flags form fields', () => {
    expect(isInputLike(el('INPUT'))).toBe(true);
    expect(isInputLike(el('TEXTAREA'))).toBe(true);
    expect(isInputLike(el('SELECT'))).toBe(true);
  });

  it('flags contenteditable, e.g. the CodeMirror content', () => {
    expect(isInputLike(el('DIV', { contentEditable: true }))).toBe(true);
  });

  it('flags search fields by role', () => {
    expect(isInputLike(el('DIV', { role: 'searchbox' }))).toBe(true);
    expect(isInputLike(el('DIV', { role: 'search' }))).toBe(true);
  });

  it('leaves plain containers and tab strips claimable', () => {
    expect(isInputLike(el('DIV'))).toBe(false);
    expect(isInputLike(el('DIV', { role: 'tab' }))).toBe(false);
    expect(isInputLike(el('BUTTON'))).toBe(false);
  });
});

describe('shouldFocusEditor', () => {
  it('claims focus when idle and no modal', () => {
    expect(shouldFocusEditor(null, false)).toBe(true);
    expect(shouldFocusEditor(el('BODY'), false)).toBe(true);
  });

  it('never claims focus while a modal is open', () => {
    expect(shouldFocusEditor(null, true)).toBe(false);
    expect(shouldFocusEditor(el('BODY'), true)).toBe(false);
  });

  it('does not steal focus from an input-like element', () => {
    expect(shouldFocusEditor(el('INPUT'), false)).toBe(false);
    expect(shouldFocusEditor(el('DIV', { contentEditable: true }), false)).toBe(
      false,
    );
  });
});
