// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
  splitMenuAction,
  languageArg,
  tabReportEntry,
  isEditAction,
  editActionSurface,
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
