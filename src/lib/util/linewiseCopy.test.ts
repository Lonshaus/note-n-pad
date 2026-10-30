// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
  lastLinewiseCopy,
  rememberCopy,
  resetLinewiseCopy,
} from './linewiseCopy';

const at = (doc: string, from: number, to = from): EditorState =>
  EditorState.create({ doc, selection: EditorSelection.single(from, to) });

describe('linewiseCopy', () => {
  beforeEach(resetLinewiseCopy);

  it('is set by a copy with nothing selected: the caret line', () => {
    rememberCopy(at('one\ntwo', 5));
    expect(lastLinewiseCopy()).toBe('two');
  });

  it('is cleared by a copy of a selection', () => {
    rememberCopy(at('one\ntwo', 5));
    rememberCopy(at('one\ntwo', 0, 3));
    expect(lastLinewiseCopy()).toBeNull();
  });

  it('is set to the empty line of an empty document, as CodeMirror does', () => {
    rememberCopy(at('one\ntwo', 0, 3));
    rememberCopy(at('', 0));
    expect(lastLinewiseCopy()).toBe('');
  });

  it('is set to an empty line copied from a caret on it', () => {
    rememberCopy(at('a\n\nb', 2));
    expect(lastLinewiseCopy()).toBe('');
  });
});
