// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
  splitMenuAction,
  languageArg,
  tabReportEntry,
  isEditAction,
  editActionSurface,
  isNativeUndoField,
  type FieldLike,
} from './menuBar';

describe('splitMenuAction', () => {
  it('splits a parameterized action on the first colon', () => {
    expect(splitMenuAction('set-encoding:Big5')).toEqual({
      command: 'set-encoding',
      arg: 'Big5',
    });
    expect(splitMenuAction('set-line-ending:CRLF')).toEqual({
      command: 'set-line-ending',
      arg: 'CRLF',
    });
  });

  it('keeps everything after the first colon as the argument', () => {
    // A hypothetical name containing a colon still round-trips.
    expect(splitMenuAction('set-language:C:weird')).toEqual({
      command: 'set-language',
      arg: 'C:weird',
    });
  });

  it('yields an empty argument for the plain-text syntax action', () => {
    expect(splitMenuAction('set-language:')).toEqual({
      command: 'set-language',
      arg: '',
    });
  });

  it('returns null for a plain action with no colon', () => {
    expect(splitMenuAction('save')).toBeNull();
    expect(splitMenuAction('show-in-finder')).toBeNull();
  });
});

describe('languageArg', () => {
  it('maps the empty argument to null (plain text)', () => {
    expect(languageArg('')).toBeNull();
  });

  it('passes a real language name through', () => {
    expect(languageArg('TypeScript')).toBe('TypeScript');
  });
});

describe('tabReportEntry', () => {
  const base = {
    tabIndex: 2,
    name: 'notes.md',
    path: '/tmp/notes.md',
    lineEnding: 'LF' as const,
    encoding: 'UTF-8',
    language: 'Markdown' as string | null,
  };

  it('derives hasPath true for a saved tab and passes fields through', () => {
    expect(tabReportEntry(base)).toEqual({
      tabIndex: 2,
      name: 'notes.md',
      hasPath: true,
      lineEnding: 'LF',
      encoding: 'UTF-8',
      language: 'Markdown',
    });
  });

  it('derives hasPath false for an untitled (empty-path) tab', () => {
    const untitled = { ...base, path: '', language: null };
    expect(tabReportEntry(untitled).hasPath).toBe(false);
    expect(tabReportEntry(untitled).language).toBeNull();
  });
});

describe('isEditAction', () => {
  it('recognizes all six Edit-menu commands', () => {
    expect(isEditAction('undo')).toBe(true);
    expect(isEditAction('redo')).toBe(true);
    expect(isEditAction('cut')).toBe(true);
    expect(isEditAction('copy')).toBe(true);
    expect(isEditAction('paste')).toBe(true);
    expect(isEditAction('select-all')).toBe(true);
  });

  it('rejects unrelated menu actions', () => {
    expect(isEditAction('save')).toBe(false);
    expect(isEditAction('find')).toBe(false);
  });
});

describe('editActionSurface', () => {
  const editor = { isTable: false, isWindowed: false, hasEditorView: true };
  const noView = { isTable: false, isWindowed: false, hasEditorView: false };
  const table = { isTable: true, isWindowed: false, hasEditorView: true };
  const windowed = { isTable: false, isWindowed: true, hasEditorView: false };

  it('routes undo/redo to the editor view by default', () => {
    expect(editActionSurface('undo', editor)).toBe('editor');
    expect(editActionSurface('redo', editor)).toBe('editor');
  });

  it('routes undo/redo to the table when the table view is active', () => {
    expect(editActionSurface('undo', table)).toBe('table');
    expect(editActionSurface('redo', table)).toBe('table');
  });

  it('routes undo/redo to the windowed editor, even without a CM view', () => {
    expect(editActionSurface('undo', windowed)).toBe('windowed');
    expect(editActionSurface('redo', windowed)).toBe('windowed');
  });

  it('routes copy and select-all to the table, but not cut/paste', () => {
    expect(editActionSurface('copy', table)).toBe('table');
    expect(editActionSurface('select-all', table)).toBe('table');
    expect(editActionSurface('cut', table)).toBe('none');
    expect(editActionSurface('paste', table)).toBe('none');
  });

  it('falls back to none when no CM view is mounted (a large-file tab)', () => {
    expect(editActionSurface('undo', noView)).toBe('none');
    expect(editActionSurface('cut', noView)).toBe('none');
    expect(editActionSurface('cut', windowed)).toBe('none');
  });

  it('routes cut/copy/paste/select-all to the editor view outside the table', () => {
    expect(editActionSurface('cut', editor)).toBe('editor');
    expect(editActionSurface('copy', editor)).toBe('editor');
    expect(editActionSurface('paste', editor)).toBe('editor');
    expect(editActionSurface('select-all', editor)).toBe('editor');
  });
});

describe('editActionSurface for the JSON, XML and Markdown views', () => {
  const overlay = {
    isTable: false,
    isWindowed: false,
    hasEditorView: true,
    isOverlay: true,
  };

  it('replays undo/redo on the source editor behind the view', () => {
    expect(editActionSurface('undo', overlay)).toBe('overlay');
    expect(editActionSurface('redo', overlay)).toBe('overlay');
  });

  it('owns select-all and copy, and never reaches the hidden editor for the rest', () => {
    expect(editActionSurface('select-all', overlay)).toBe('overlay');
    expect(editActionSurface('copy', overlay)).toBe('overlay');
    expect(editActionSurface('cut', overlay)).toBe('none');
    expect(editActionSurface('paste', overlay)).toBe('none');
  });

  it('has nothing to undo without a mounted editor view', () => {
    expect(
      editActionSurface('undo', { ...overlay, hasEditorView: false }),
    ).toBe('none');
  });
});

describe('editActionSurface with focus in a text field', () => {
  it('hands undo/redo to the field in every view', () => {
    const base = { isWindowed: false, hasEditorView: true, fieldFocused: true };
    expect(editActionSurface('undo', { ...base, isTable: false })).toBe(
      'field',
    );
    expect(editActionSurface('redo', { ...base, isTable: true })).toBe('field');
    expect(
      editActionSurface('undo', { ...base, isTable: false, isOverlay: true }),
    ).toBe('field');
    expect(
      editActionSurface('redo', {
        ...base,
        isTable: false,
        isWindowed: true,
      }),
    ).toBe('field');
  });

  it('leaves the other commands to their usual surface', () => {
    const ctx = {
      isTable: false,
      isWindowed: false,
      hasEditorView: true,
      fieldFocused: true,
    };
    expect(editActionSurface('copy', ctx)).toBe('editor');
  });
});

describe('isNativeUndoField', () => {
  function el(
    tagName: string,
    extra: Partial<FieldLike> = {},
    inCm = false,
  ): FieldLike {
    return {
      tagName,
      closest: (selector) => (inCm && selector === '.cm-content' ? {} : null),
      ...extra,
    };
  }

  it('accepts text inputs and textareas', () => {
    expect(isNativeUndoField(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isNativeUndoField(el('INPUT', { type: 'search' }))).toBe(true);
    expect(isNativeUndoField(el('TEXTAREA'))).toBe(true);
  });

  it('rejects inputs that take no text', () => {
    expect(isNativeUndoField(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isNativeUndoField(el('SELECT'))).toBe(false);
  });

  it('accepts a contenteditable outside CodeMirror, rejects CodeMirror content', () => {
    expect(isNativeUndoField(el('DIV', { isContentEditable: true }))).toBe(
      true,
    );
    expect(
      isNativeUndoField(el('DIV', { isContentEditable: true }, true)),
    ).toBe(false);
  });

  it('rejects nothing-focused and plain elements', () => {
    expect(isNativeUndoField(null)).toBe(false);
    expect(isNativeUndoField(el('DIV', { isContentEditable: false }))).toBe(
      false,
    );
    expect(isNativeUndoField(el('BODY'))).toBe(false);
  });
});

describe('editActionSurface for select-all', () => {
  const source = { isTable: false, isWindowed: false, hasEditorView: true };
  const windowed = { isTable: false, isWindowed: true, hasEditorView: false };
  const viewer = {
    isTable: false,
    isWindowed: false,
    hasEditorView: false,
    isViewer: true,
  };
  const table = { isTable: true, isWindowed: false, hasEditorView: true };
  const overlay = {
    isTable: false,
    isWindowed: false,
    hasEditorView: true,
    isOverlay: true,
  };

  it('selects the on-screen span in a windowed tab, with or without a view', () => {
    expect(editActionSurface('select-all', windowed)).toBe('windowed');
    expect(
      editActionSurface('select-all', { ...windowed, hasEditorView: true }),
    ).toBe('windowed');
  });

  it('selects the fully visible rows in a large-file viewer tab', () => {
    expect(editActionSurface('select-all', viewer)).toBe('viewer');
  });

  it('keeps the viewer and windowed routes to select-all alone', () => {
    expect(editActionSurface('copy', viewer)).toBe('none');
    expect(editActionSurface('copy', windowed)).toBe('none');
    expect(editActionSurface('paste', viewer)).toBe('none');
  });

  it('keeps the table, view and source routes', () => {
    expect(editActionSurface('select-all', table)).toBe('table');
    expect(editActionSurface('select-all', overlay)).toBe('overlay');
    expect(editActionSurface('select-all', source)).toBe('editor');
  });

  it('hands select-all to a focused text field in every context', () => {
    for (const ctx of [source, windowed, viewer, table, overlay]) {
      expect(
        editActionSurface('select-all', { ...ctx, fieldFocused: true }),
      ).toBe('field');
    }
  });

  it('keeps select-all native while a dialog is open', () => {
    for (const ctx of [source, windowed, viewer, table, overlay]) {
      expect(editActionSurface('select-all', { ...ctx, modalOpen: true })).toBe(
        'field',
      );
    }
  });

  it('leaves copy to its usual surface when a field is focused', () => {
    expect(editActionSurface('copy', { ...table, fieldFocused: true })).toBe(
      'table',
    );
  });
});
