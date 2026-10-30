// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { routeOpen, orphanCandidates, documentGroup } from './openRouting';
import type { NoteSnapshot } from '../state/stickyNote.svelte';
/** Minimal document note carrying only the fields the router reads. */
function doc(over: Partial<NoteSnapshot>): NoteSnapshot {
  return {
    id: 'id',
    content: '',
    file_path: '/x.txt',
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

describe('documentGroup', () => {
  it('falls back to the note id when window_group is unset', () => {
    expect(documentGroup(doc({ id: 'solo', window_group: null }))).toBe('solo');
    expect(documentGroup(doc({ id: 'solo', window_group: 'g1' }))).toBe('g1');
  });
});

describe('orphanCandidates', () => {
  it('matches the path across other groups, ignoring this group and stickies', () => {
    const notes = [
      doc({ id: 'a', file_path: '/x.txt', window_group: 'mine' }),
      doc({ id: 'b', file_path: '/x.txt', window_group: 'other' }),
      doc({ id: 'c', file_path: '/y.txt', window_group: 'other' }),
      doc({
        id: 's',
        file_path: '/x.txt',
        kind: 'sticky',
        window_group: 'other',
      }),
    ];
    const got = orphanCandidates(notes, '/x.txt', 'mine').map((n) => n.id);
    expect(got).toEqual(['b']);
  });
});

describe('routeOpen', () => {
  it('is fresh when no other group holds the path', () => {
    const notes = [doc({ id: 'a', window_group: 'mine' })];
    expect(routeOpen(notes, '/x.txt', 'mine', new Set()).kind).toBe('fresh');
  });

  it('switches to a live window holding the path', () => {
    const notes = [doc({ id: 'b', window_group: 'other', tab_index: 3 })];
    const route = routeOpen(notes, '/x.txt', 'mine', new Set(['other']));
    expect(route).toEqual({ kind: 'switch', group: 'other', tabIndex: 3 });
  });

  it('adopts an orphan whose window is dead', () => {
    const note = doc({ id: 'b', window_group: 'dead', dirty: true });
    const route = routeOpen([note], '/x.txt', 'mine', new Set());
    expect(route).toEqual({ kind: 'adopt', note });
  });

  it('adopts a solo (group-less) orphan by its own id', () => {
    const note = doc({ id: 'solo', window_group: null, dirty: true });
    const route = routeOpen([note], '/x.txt', 'mine', new Set());
    expect(route).toEqual({ kind: 'adopt', note });
  });

  it('prefers a dirty orphan over a clean one when several match', () => {
    const clean = doc({ id: 'clean', window_group: 'g1' });
    const dirty = doc({ id: 'dirty', window_group: 'g2', dirty: true });
    const route = routeOpen([clean, dirty], '/x.txt', 'mine', new Set());
    expect(route).toEqual({ kind: 'adopt', note: dirty });
  });

  it('routes the chosen dirty orphan to switch when its window is live', () => {
    const clean = doc({ id: 'clean', window_group: 'g1' });
    const dirty = doc({
      id: 'dirty',
      window_group: 'g2',
      dirty: true,
      tab_index: 2,
    });
    const route = routeOpen([clean, dirty], '/x.txt', 'mine', new Set(['g2']));
    expect(route).toEqual({ kind: 'switch', group: 'g2', tabIndex: 2 });
  });
});

describe('orphan large-file records', () => {
  const large = doc({ id: 'large', window_group: 'g1', large: 200_000_000 });
  const windowed = doc({
    id: 'windowed',
    window_group: 'g1',
    large: 200_000_000,
    windowed_index: { checkpoints: [[0, 0]], total_newlines: 1 },
  });

  it('are adopted, in the trial too: no edition leaves them out', () => {
    for (const note of [large, windowed]) {
      expect(orphanCandidates([note], '/x.txt', 'mine')).toEqual([note]);
      expect(routeOpen([note], '/x.txt', 'mine', new Set())).toEqual({
        kind: 'adopt',
        note,
      });
    }
  });

  it('are switched to when their window is live', () => {
    expect(routeOpen([large], '/x.txt', 'mine', new Set(['g1']))).toEqual({
      kind: 'switch',
      group: 'g1',
      tabIndex: 0,
    });
  });
});
