// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  docLabel,
  groupOpenDocuments,
  parseInitialTab,
  resolveTabPosition,
  shouldCollapseEmptyWindow,
} from './openDocuments';
import type { NoteSnapshot } from '../state/stickyNote.svelte';
import { settingsState } from '../state/settings.svelte';
import { t } from '../i18n';

function note(over: Partial<NoteSnapshot>): NoteSnapshot {
  return {
    id: 'id',
    content: '',
    file_path: null,
    language: null,
    explicit: false,
    x: null,
    y: null,
    width: null,
    height: null,
    pin_mode: 'none',
    pin_app: null,
    opacity: 1,
    paper: 'classic',
    kind: 'document',
    dirty: false,
    window_group: null,
    tab_index: 0,
    line_ending: 'LF',
    had_bom: false,
    encoding: 'UTF-8',
    project: null,
    large: null,
    range_source: null,
    range_start: null,
    range_end: null,
    range_fp_size: null,
    range_fp_mtime: null,
    range_start_line: null,
    range_end_line: null,
    range_trailing_break: null,
    windowed_index: null,
    windowed_fp_size: null,
    windowed_fp_mtime: null,
    windowed_digest: null,
    windowed_top_line: null,
    windowed_encoding: null,
    windowed_bom: false,
    ...over,
  };
}

describe('groupOpenDocuments', () => {
  it('groups tabs by window_group and keeps first-appearance order', () => {
    const groups = groupOpenDocuments(
      [
        note({ id: 'a', window_group: 'g1', file_path: '/x/a.txt' }),
        note({ id: 'b', window_group: 'g2', file_path: '/x/b.txt' }),
        note({ id: 'c', window_group: 'g1', file_path: '/x/c.txt' }),
      ],
      docLabel,
    );
    expect(groups.map((g) => g.group)).toEqual(['g1', 'g2']);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('sorts rows within a group by tab_index', () => {
    const groups = groupOpenDocuments(
      [
        note({ id: 'a', window_group: 'g', tab_index: 2, file_path: '/a.txt' }),
        note({ id: 'b', window_group: 'g', tab_index: 0, file_path: '/b.txt' }),
        note({ id: 'c', window_group: 'g', tab_index: 1, file_path: '/c.txt' }),
      ],
      docLabel,
    );
    expect(groups[0]!.rows.map((r) => r.tabIndex)).toEqual([0, 1, 2]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('falls back to the note id when window_group is null', () => {
    const groups = groupOpenDocuments(
      [note({ id: 'solo', window_group: null, file_path: '/s.txt' })],
      docLabel,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group).toBe('solo');
  });

  it('names a tab by its basename and empty/null path as the translated Untitled', () => {
    const groups = groupOpenDocuments(
      [
        note({
          id: 'a',
          window_group: 'g',
          tab_index: 0,
          file_path: '/dir/a.txt',
        }),
        note({ id: 'b', window_group: 'g', tab_index: 1, file_path: null }),
        note({ id: 'c', window_group: 'g', tab_index: 2, file_path: '' }),
        note({
          id: 'd',
          window_group: 'g',
          tab_index: 3,
          file_path: 'C:\\docs\\d.md',
        }),
      ],
      docLabel,
    );
    expect(groups[0]!.rows.map((r) => r.name)).toEqual([
      'a.txt',
      t('doc.untitled'),
      t('doc.untitled'),
      'd.md',
    ]);
  });

  it('names rows with the label function it is given', () => {
    const groups = groupOpenDocuments(
      [note({ id: 'a', window_group: 'g', file_path: '/x/a.txt' })],
      (n) => `<${n.id}>`,
    );
    expect(groups[0]!.rows[0]!.name).toBe('<a>');
  });

  it('carries the raw file path for context-menu reveal', () => {
    const groups = groupOpenDocuments(
      [
        note({
          id: 'a',
          window_group: 'g',
          tab_index: 0,
          file_path: '/x/a.txt',
        }),
        note({ id: 'b', window_group: 'g', tab_index: 1, file_path: null }),
      ],
      docLabel,
    );
    expect(groups[0]!.rows.map((r) => r.filePath)).toEqual(['/x/a.txt', null]);
  });

  it('carries the dirty flag', () => {
    const groups = groupOpenDocuments(
      [
        note({ id: 'a', window_group: 'g', tab_index: 0, dirty: true }),
        note({ id: 'b', window_group: 'g', tab_index: 1, dirty: false }),
      ],
      docLabel,
    );
    expect(groups[0]!.rows.map((r) => r.dirty)).toEqual([true, false]);
  });

  it('ignores non-document notes', () => {
    const groups = groupOpenDocuments(
      [
        note({ id: 'sticky', kind: 'sticky' }),
        note({
          id: 'doc',
          kind: 'document',
          window_group: 'g',
          file_path: '/d.txt',
        }),
      ],
      docLabel,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(1);
    expect(groups[0]!.rows[0]!.id).toBe('doc');
  });
});

describe('shouldCollapseEmptyWindow', () => {
  it('stays open while a failed-open report is on screen', () => {
    // Closing here would take the report with it and the open would look like
    // nothing happened — the same flash-close the long-line flag exists for.
    expect(shouldCollapseEmptyWindow(true, 0, false, false, true)).toBe(false);
  });

  it('collapses a fresh single-file window that opened nothing', () => {
    expect(shouldCollapseEmptyWindow(true, 0, false, false, false)).toBe(true);
  });
  it('keeps the window alive while the long-line dialog is pending', () => {
    // The flash-close regression: a long-line file staged its confirm (tabs 0)
    // and the window must survive so the user can answer it.
    expect(shouldCollapseEmptyWindow(true, 0, false, true, false)).toBe(false);
  });
  it('keeps the window alive while the large-file confirm is pending', () => {
    expect(shouldCollapseEmptyWindow(true, 0, true, false, false)).toBe(false);
  });
  it('never collapses once a tab opened', () => {
    expect(shouldCollapseEmptyWindow(true, 1, false, false, false)).toBe(false);
  });
  it('does not collapse a window with no initial path', () => {
    expect(shouldCollapseEmptyWindow(false, 0, false, false, false)).toBe(
      false,
    );
  });
});

describe('parseInitialTab', () => {
  it('reads an integer tab parameter', () => {
    expect(parseInitialTab('2')).toBe(2);
  });

  it('keeps tab 0 distinct from an absent parameter', () => {
    expect(parseInitialTab('0')).toBe(0);
    expect(parseInitialTab(null)).toBeNull();
  });

  it('rejects a non-integer parameter', () => {
    expect(parseInitialTab('later')).toBeNull();
    expect(parseInitialTab('1.5')).toBeNull();
  });
});

describe('resolveTabPosition', () => {
  it('finds the array position of a stored tab_index', () => {
    expect(resolveTabPosition([0, 1, 2], 2)).toBe(2);
  });

  it('does not confuse tab_index with array position', () => {
    // Tab 0 was closed, so the surviving tabs carry 1 and 2.
    expect(resolveTabPosition([1, 2], 2)).toBe(1);
  });

  it('falls back to the first tab without a request', () => {
    expect(resolveTabPosition([0, 1], null)).toBe(0);
  });

  it('falls back to the first tab when the requested tab is gone', () => {
    expect(resolveTabPosition([0, 1], 7)).toBe(0);
  });
});

describe('docLabel', () => {
  let languageBefore: string;
  beforeEach(() => {
    languageBefore = settingsState.language;
  });
  afterEach(() => {
    settingsState.language = languageBefore;
  });

  it('shows an untitled tab as the translated label, whatever the language', () => {
    const expected: Record<string, string> = {
      'zh-TW': '未命名',
      en: 'Untitled',
      ja: '無題',
    };
    for (const [language, label] of Object.entries(expected)) {
      settingsState.language = language;
      expect(docLabel(note({ file_path: null }))).toBe(label);
      expect(docLabel(note({ file_path: '' }))).toBe(label);
    }
  });

  it('shows a clean range record (empty content) as its source and line span', () => {
    const clean = note({
      file_path: '',
      content: '',
      range_source: '/x/big.log',
      range_start: 0,
      range_end: 10,
      range_start_line: 2,
      range_end_line: 4,
    });
    const expected: Record<string, string> = {
      'zh-TW': 'big.log（第 2–4 行）',
      en: 'big.log (lines 2–4)',
      ja: 'big.log（2–4 行目）',
    };
    for (const [language, label] of Object.entries(expected)) {
      settingsState.language = language;
      expect(docLabel(clean)).toBe(label);
    }
  });

  it('shows a range record without an end line as the source name alone', () => {
    expect(
      docLabel(
        note({
          file_path: '',
          range_source: 'C:\\logs\\big.log',
          range_start_line: 2,
          range_end_line: null,
        }),
      ),
    ).toBe('big.log');
    expect(
      docLabel(
        note({
          file_path: '',
          range_source: '/x/big.log',
          range_start_line: null,
          range_end_line: 4,
        }),
      ),
    ).toBe('big.log');
  });
});
