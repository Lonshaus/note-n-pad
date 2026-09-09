// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import {
  snapshotContentPolicy,
  SNAPSHOT_CONTENT_MAX,
} from '../util/snapshotPolicy';
import type { NoteSnapshot } from './stickyNote.svelte';
import { t } from '../i18n';
import { settingsState } from './settings.svelte';
import {
  documentWindow,
  windowedRefusalReason,
  windowedSnapshotDirty,
  windowedSnapshotLarge,
  rangeDisplayName,
  LARGE_FILE_THRESHOLD,
  type DocTab,
} from './documentWindow.svelte';
import { READ_ONLY_DESTINATION } from '../util/protocol';

// Mocked so the tests below drive `documentWindow`'s real
// `setBounds`/`switchTo` against a fake Tauri backend instead of
// reimplementing the logic under test. `vi.mock` is hoisted above every
// import in this file by Vitest's transform, so `documentWindow.svelte.ts`'s
// own top-level `import { invoke } from '@tauri-apps/api/core'` binds to it.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

// `beginWindowedRestore`'s grace-period timer uses `window.setTimeout`/
// `clearTimeout`; this file runs under Vitest's default node environment (no
// jsdom), so `window` itself doesn't otherwise exist. `globalThis` already
// carries real timers, so aliasing is enough — no jsdom dependency needed.
vi.stubGlobal('window', globalThis);

/** Minimal ordinary (non-large, non-windowed, non-range) DocTab, for tests
 *  that only care about the windowed-restore-specific fields. */
function baseTab(overrides: Partial<DocTab>): DocTab {
  return {
    id: 'tab-id',
    path: '/tmp/huge.log',
    readOnlyFile: false,
    content: Text.empty,
    savedContent: Text.empty,
    language: null,
    explicit: false,
    lineEnding: 'LF',
    savedLineEnding: 'LF',
    hadBom: false,
    encoding: 'UTF-8',
    lossy: false,
    tabIndex: 0,
    ...overrides,
  };
}

/** Minimal ordinary (non-large, non-windowed, non-range) persisted note, for
 *  tests that only care about the windowed-restore-specific fields returned
 *  by `list_notes`. */
function baseNote(overrides: Partial<NoteSnapshot>): NoteSnapshot {
  return {
    id: 'note-id',
    content: '',
    file_path: '/tmp/huge.log',
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
    window_group: 'g1',
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
    windowed_index: null,
    windowed_fp_size: null,
    windowed_fp_mtime: null,
    windowed_digest: null,
    windowed_top_line: null,
    ...overrides,
  };
}

describe('windowedRefusalReason', () => {
  it('maps the not-utf8 protocol error', () => {
    expect(windowedRefusalReason('not-utf8')).toBe('notUtf8');
  });

  it('maps the too-large protocol error', () => {
    expect(windowedRefusalReason('too-large')).toBe('tooLarge');
  });

  it('falls back to a generic reason for any other error', () => {
    expect(windowedRefusalReason('boom')).toBe('cannot');
    expect(windowedRefusalReason('')).toBe('cannot');
    expect(windowedRefusalReason('fingerprint-mismatch')).toBe('cannot');
  });
});

describe('windowedSnapshotDirty (a windowed tab is never dirty)', () => {
  it('is always false for a windowed tab, even when the live flag is true', () => {
    expect(windowedSnapshotDirty(true, true)).toBe(false);
    expect(windowedSnapshotDirty(true, false)).toBe(false);
  });

  it('passes the live flag through unchanged for a non-windowed tab', () => {
    expect(windowedSnapshotDirty(false, true)).toBe(true);
    expect(windowedSnapshotDirty(false, false)).toBe(false);
  });

  it('feeds snapshotContentPolicy into "empty" for a windowed tab (content is always empty)', () => {
    // A windowed tab's `content` never carries anything (the buffer lives in
    // the Rust piece table), so the always-false dirty this function returns
    // must resolve to 'empty', never 'full' next to a stored `dirty: true` that
    // nothing could ever restore.
    const dirty = windowedSnapshotDirty(true, true);
    expect(snapshotContentPolicy(dirty, 0)).toBe('empty');
  });
});

describe('windowedSnapshotLarge (persist on-disk size, not post-edit size)', () => {
  it('prefers the plain large-tab size when present', () => {
    expect(windowedSnapshotLarge(100, 200, 300)).toBe(100);
  });

  it('falls back to the windowed fingerprint size over the live total bytes', () => {
    // The fingerprint's on-disk size wins even when the live piece table has
    // since shrunk below it (or grown past it) from edits: persisting the
    // post-edit size could wrongly disable the restore lock for a file that
    // shrank back under the windowed-editing ceiling.
    expect(windowedSnapshotLarge(null, 200, 300)).toBe(200);
  });

  it('falls back to totalBytes only when no fingerprint size is available', () => {
    // A session that vanished between the dirty check and the fetch (closed
    // mid-flush) degrades to no fingerprint size; totalBytes is the
    // last-resort fallback so the tab still restores as *something* large.
    expect(windowedSnapshotLarge(null, null, 300)).toBe(300);
  });

  it('is null when nothing is available', () => {
    expect(windowedSnapshotLarge(null, null, null)).toBe(null);
  });
});

describe('rangeDisplayName (derived, not frozen at extraction)', () => {
  // Pinned to `ja` (not `en`) so the assertions below prove the same thing on
  // every machine: pinning to English would make a mutation that hardcodes the
  // English template (bypassing `t()` entirely) pass on every host, since the
  // expected side's `t()` call would resolve to English too. `ja`'s template
  // (`'{name}（{start}–{end} 行目）'`, see `src/lib/i18n/ja.ts`) differs in shape
  // from English, so that mutation is caught regardless of the machine's own
  // locale.
  // Restored afterwards because `settingsState` is a singleton: leaving it
  // pinned would silently apply to any locale-dependent test added later in
  // this file.
  let pinnedLanguageBefore: string;
  beforeEach(() => {
    pinnedLanguageBefore = settingsState.language;
    settingsState.language = 'ja';
  });
  afterEach(() => {
    settingsState.language = pinnedLanguageBefore;
  });

  it('is null for a non-range tab', () => {
    expect(rangeDisplayName(baseTab({}))).toBe(null);
  });

  it('is null for a range tab restored with no start line (older snapshot)', () => {
    const tab = baseTab({
      content: Text.of(['a', 'b', 'c']),
      range: {
        sourcePath: '/tmp/big.log',
        startByte: 0,
        endByte: 10,
        fingerprint: null,
        startLine: null,
      },
    });
    expect(rangeDisplayName(tab)).toBe(null);
  });

  it('derives the end line from the tab content line count, not a stored value', () => {
    const tab = baseTab({
      content: Text.of(['a', 'b', 'c']), // 3 lines
      range: {
        sourcePath: '/tmp/big.log',
        startByte: 0,
        endByte: 10,
        fingerprint: null,
        startLine: 5,
      },
    });
    // Lines 5,6,7 for a 3-line buffer starting at line 5.
    expect(rangeDisplayName(tab)).toBe(
      t('doc.range.displayName', { name: 'big.log', start: 5, end: 7 }),
    );
  });

  it('follows an edit that changes the line count (no rebase needed, unlike endByte)', () => {
    const tab = baseTab({
      content: Text.of(['a', 'b']), // shrunk from 3 to 2 lines after an edit
      range: {
        sourcePath: '/tmp/big.log',
        startByte: 0,
        endByte: 10,
        fingerprint: null,
        startLine: 5,
      },
    });
    expect(rangeDisplayName(tab)).toBe(
      t('doc.range.displayName', { name: 'big.log', start: 5, end: 6 }),
    );
  });

  // `LargeFileView`'s extraction takes the end offset as the start of the line
  // *after* the last selected line, so the extracted content almost always
  // ends with the last selected line's trailing newline — the shape the two
  // tests above (`Text.of(['a','b','c'])`, no trailing newline) don't cover.
  it('does not count the trailing empty line a final newline opens (multi-line range)', () => {
    const tab = baseTab({
      content: Text.of(['line5', 'line6', 'line7', '']), // "line5\nline6\nline7\n"
      range: {
        sourcePath: '/tmp/big.log',
        startByte: 0,
        endByte: 10,
        fingerprint: null,
        startLine: 5,
      },
    });
    expect(rangeDisplayName(tab)).toBe(
      t('doc.range.displayName', { name: 'big.log', start: 5, end: 7 }),
    );
  });

  it('does not count the trailing empty line a final newline opens (single-line range)', () => {
    const tab = baseTab({
      content: Text.of(['line5', '']), // "line5\n"
      range: {
        sourcePath: '/tmp/big.log',
        startByte: 0,
        endByte: 10,
        fingerprint: null,
        startLine: 5,
      },
    });
    expect(rangeDisplayName(tab)).toBe(
      t('doc.range.displayName', { name: 'big.log', start: 5, end: 5 }),
    );
  });

  it('renders a single line for an empty range (Text.empty, no trailing newline to detect)', () => {
    const tab = baseTab({
      content: Text.empty,
      range: {
        sourcePath: '/tmp/big.log',
        startByte: 0,
        endByte: 0,
        fingerprint: null,
        startLine: 5,
      },
    });
    expect(rangeDisplayName(tab)).toBe(
      t('doc.range.displayName', { name: 'big.log', start: 5, end: 5 }),
    );
  });
});

describe('setBounds persists a pending windowed-restore tab (F1 regression)', () => {
  it('keeps windowed_index/large/fingerprint/digest/topLine non-null in the upserted payload', async () => {
    documentWindow.tabs.length = 0;
    const notes: Record<string, unknown>[] = [];
    mockInvoke.mockImplementation(((cmd: string, args?: unknown) => {
      if (cmd === 'upsert_note') {
        notes.push((args as { note: Record<string, unknown> }).note);
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    documentWindow.tabs.push(
      baseTab({
        id: 'pending-1',
        windowedRestore: {
          index: {
            checkpoints: [
              [0, 0],
              [1_048_576, 12],
            ],
            total_newlines: 5000,
          },
          fingerprint: { size: 200 * 1024 * 1024, mtime_ms: 1_700_000_000_000 },
          digest: '123456789',
          topLine: 42,
          size: 200 * 1024 * 1024,
        },
      }),
    );

    // Mirrors `DocumentApp.svelte`'s move/resize path (`captureBounds` ->
    // `setBounds`), which loops every tab regardless of restore state.
    documentWindow.setBounds(10, 20, 800, 600);
    // setBounds fires upsertTab's promise chain without awaiting it; let the
    // microtask/macrotask queues drain before asserting on its payload.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    expect(note.windowed_index).toEqual({
      checkpoints: [
        [0, 0],
        [1_048_576, 12],
      ],
      total_newlines: 5000,
    });
    expect(note.large).toBe(200 * 1024 * 1024);
    expect(note.windowed_fp_size).toBe(200 * 1024 * 1024);
    expect(note.windowed_fp_mtime).toBe(1_700_000_000_000);
    expect(note.windowed_digest).toBe('123456789');
    expect(note.windowed_top_line).toBe(42);
  });
});

describe('loadTab size gate on the restore fallback path (F2 regression)', () => {
  it('degrades an oversized snapshot with no large/windowed markers to the read-only view', async () => {
    documentWindow.tabs.length = 0;
    const bigSize = LARGE_FILE_THRESHOLD + 1;
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'list_notes':
          return Promise.resolve([
            {
              id: 'huge',
              content: '',
              file_path: '/tmp/huge.log',
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
              window_group: 'g1',
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
              windowed_index: null,
              windowed_fp_size: null,
              windowed_fp_mtime: null,
              windowed_digest: null,
              windowed_top_line: null,
            },
          ]);
        case 'stat_file':
          return Promise.resolve({ size: bigSize });
        case 'read_file_auto':
          // Should never be reached: the size gate must intercept first.
          return Promise.resolve({
            content: 'x'.repeat(10),
            encoding: 'UTF-8',
            had_bom: false,
            lossy: false,
          });
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);

    await documentWindow.init('g1', null, null);

    expect(documentWindow.tabs).toHaveLength(1);
    expect(documentWindow.tabs[0]?.large).toEqual({ size: bigSize });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'read_file_auto',
      expect.anything(),
    );
  });
});

describe('switchTo flush ordering (F4 regression: upsertTab must not become async)', () => {
  it('awaits exactly the write flush() just triggered, not a stale previous one', async () => {
    let writeCompleted = false;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'upsert_note') {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            writeCompleted = true;
            resolve();
          }, 5);
        });
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    documentWindow.tabs.length = 0;
    documentWindow.tabs.push(
      baseTab({ id: 'a', tabIndex: 0 }),
      baseTab({ id: 'b', tabIndex: 1, path: '' }),
    );
    documentWindow.activeIndex = 0;
    // Marks the active tab dirty and schedules the debounced auto-persist,
    // the same way a keystroke would — `switchTo` is what flushes it.
    documentWindow.updateActiveContent(Text.of(['dirty']));

    await documentWindow.switchTo(1);

    expect(writeCompleted).toBe(true);
  });
});

describe('loadTab restores a pending windowed-restore tab', () => {
  it('rebuilds windowedRestore from the persisted checkpoint index, fingerprint, digest, and top line, without hitting stat_file or read_file_auto', async () => {
    documentWindow.tabs.length = 0;
    // Above 2^53: an f64 round trip through `Number` would silently corrupt
    // this (the round-one regression class this test exists to catch).
    const bigDigest = '16045690984833335230';
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'list_notes':
          return Promise.resolve([
            baseNote({
              id: 'pending-1',
              large: 200 * 1024 * 1024,
              windowed_index: {
                checkpoints: [
                  [0, 0],
                  [1_048_576, 12],
                ],
                total_newlines: 5000,
              },
              windowed_fp_size: 200 * 1024 * 1024,
              windowed_fp_mtime: 1_700_000_000_000,
              windowed_digest: bigDigest,
              windowed_top_line: 42,
            }),
          ]);
        case 'windowed_reopen':
          // Never resolves: this test only cares about the restored fields,
          // not the reopen it kicks off as a side effect of becoming active.
          return new Promise(() => {});
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);

    await documentWindow.init('g1', null, null);

    expect(documentWindow.tabs).toHaveLength(1);
    const tab = documentWindow.tabs[0]!;
    expect(tab.windowed).toBeUndefined();
    expect(tab.large).toBeUndefined();
    expect(tab.windowedRestore).toEqual({
      index: {
        checkpoints: [
          [0, 0],
          [1_048_576, 12],
        ],
        total_newlines: 5000,
      },
      fingerprint: { size: 200 * 1024 * 1024, mtime_ms: 1_700_000_000_000 },
      digest: bigDigest,
      topLine: 42,
      size: 200 * 1024 * 1024,
    });
  });
});

describe('ensureWindowedRestore kicks off the reopen for the active restored tab', () => {
  it('calls windowed_reopen with the persisted index/fingerprint/digest as soon as the tab becomes active', async () => {
    documentWindow.tabs.length = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'list_notes':
          return Promise.resolve([
            baseNote({
              id: 'pending-2',
              large: 150 * 1024 * 1024,
              windowed_index: { checkpoints: [[0, 0]], total_newlines: 10 },
              windowed_fp_size: 150 * 1024 * 1024,
              windowed_fp_mtime: 1_700_000_000_000,
              windowed_digest: '999',
              windowed_top_line: 3,
            }),
          ]);
        case 'windowed_reopen':
          return new Promise(() => {});
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);

    await documentWindow.init('g1', null, null);

    // `init` sets `activeIndex` to 0, which is this tab: the setter must have
    // kicked off `beginWindowedRestore` synchronously (up to its first
    // `await`), so the reopen call is already recorded by now even though
    // its promise never resolves in this test.
    expect(mockInvoke).toHaveBeenCalledWith('windowed_reopen', {
      path: '/tmp/huge.log',
      index: { checkpoints: [[0, 0]], total_newlines: 10 },
      fingerprint: { size: 150 * 1024 * 1024, mtime_ms: 1_700_000_000_000 },
      digest: '999',
    });
  });
});

describe('loadTab size gate is a strict ">"', () => {
  it('does not degrade a file exactly at LARGE_FILE_THRESHOLD to the read-only view', async () => {
    documentWindow.tabs.length = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'list_notes':
          return Promise.resolve([
            baseNote({ id: 'exact', file_path: '/tmp/exact.log' }),
          ]);
        case 'stat_file':
          return Promise.resolve({ size: LARGE_FILE_THRESHOLD });
        // A restored snapshot always carries a stored `encoding`, so the
        // decode step below routes through `read_file_as`, never the
        // encoding-autodetect `read_file_auto`.
        case 'read_file_as':
          return Promise.resolve({
            content: 'ok',
            encoding: 'UTF-8',
            had_bom: false,
            lossy: false,
          });
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);

    await documentWindow.init('g1', null, null);

    expect(documentWindow.tabs).toHaveLength(1);
    expect(documentWindow.tabs[0]?.large).toBeUndefined();
    expect(documentWindow.tabs[0]?.content.toString()).toBe('ok');
  });
});

describe('deleteTab kicks off the restore of the tab that becomes active (P2 regression)', () => {
  it('reopens a pending windowed-restore tab left behind at the same numeric activeIndex after closing the active tab in front of it', async () => {
    documentWindow.tabs.length = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'delete_note':
          return Promise.resolve(undefined);
        case 'windowed_reopen':
          return new Promise(() => {});
        default:
          return Promise.resolve(undefined);
      }
    }) as typeof invoke);

    documentWindow.tabs.push(
      baseTab({ id: 'ordinary', tabIndex: 0, path: '/tmp/a.txt' }),
      baseTab({
        id: 'pending',
        tabIndex: 1,
        path: '/tmp/huge.log',
        windowedRestore: {
          index: { checkpoints: [[0, 0]], total_newlines: 10 },
          fingerprint: { size: 200 * 1024 * 1024, mtime_ms: 1_700_000_000_000 },
          digest: '42',
          topLine: 0,
          size: 200 * 1024 * 1024,
        },
      }),
    );
    documentWindow.activeIndex = 0;
    mockInvoke.mockClear();

    // Closing the active tab (index 0) leaves the pending-restore tab at
    // index 0 — `activeIndex`'s numeric value (0) does not change, so only a
    // funnel that re-checks on every deleteTab, not just on a changed index,
    // notices the newly active tab needs its restore kicked off.
    await documentWindow.deleteTab(0);

    expect(documentWindow.activeIndex).toBe(0);
    expect(documentWindow.tabs[0]?.id).toBe('pending');
    expect(mockInvoke).toHaveBeenCalledWith('windowed_reopen', {
      path: '/tmp/huge.log',
      index: { checkpoints: [[0, 0]], total_newlines: 10 },
      fingerprint: { size: 200 * 1024 * 1024, mtime_ms: 1_700_000_000_000 },
      digest: '42',
    });
  });
});

describe('saveActive on a rejected write_file_encoded (save-failure notice)', () => {
  it('leaves the tab dirty and records the failure for the UI to read', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    const tab = baseTab({
      id: 'dirty-tab',
      path: '/tmp/readonly.txt',
      content: Text.of(['changed']),
      savedContent: Text.of(['original']),
    });
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'write_file_encoded') {
        return Promise.reject(new Error('Permission denied (os error 13)'));
      }
      return Promise.resolve(null);
    }) as typeof invoke);

    const result = await documentWindow.saveActive();

    expect(result).toBe(false);
    expect(documentWindow.isDirty(tab)).toBe(true);
    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/readonly.txt',
      error: 'Error: Permission denied (os error 13)',
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'upsert_note',
      expect.anything(),
    );
  });
});

// The generic message and the read-only-file message are both driven off
// `saveFailed.error`, so the caller (DocumentApp) must be able to tell them
// apart by exact string match against the Rust protocol value: this pins that
// contract, and that the tab's own flag catches up so the pen/badge agree.
describe('saveActive on a read-only-destination refusal', () => {
  it('selects the read-only protocol string over a generic error and flags the tab', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    const tab = baseTab({
      id: 'dirty-tab',
      path: '/tmp/readonly.txt',
      readOnlyFile: false,
      content: Text.of(['changed']),
      savedContent: Text.of(['original']),
    });
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'write_file_encoded') {
        // A Tauri command's Err(String) rejects with the bare string, not an
        // Error object — matching the exact `String(e) === ...` check the
        // production code makes (see `splice`'s own FINGERPRINT_MISMATCH use).
        return Promise.reject(READ_ONLY_DESTINATION);
      }
      return Promise.resolve(null);
    }) as typeof invoke);

    const result = await documentWindow.saveActive();

    expect(result).toBe(false);
    // DocumentApp picks doc.saveReadOnly over the generic doc.saveFailed by
    // an exact match against this field, so pinning the field itself is what
    // proves the read-only message wins over the generic one.
    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/readonly.txt',
      error: READ_ONLY_DESTINATION,
    });
    expect(tab.readOnlyFile).toBe(true);
  });
});

// A read-only destination gets the same doc.saveReadOnly modal as an ordinary
// save, using the real write target (the range's source, and the windowed
// tab's own path respectively), not the tab's own possibly-empty `path`.
// The pair below pins that; the pair after them pins that an error which is
// neither a conflict nor a refusal is reported just the same.
describe('splice on a read-only-destination refusal', () => {
  it('populates saveFailed with the source path and flags the tab, still returning error', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    const tab = baseTab({
      id: 'range-tab',
      path: '',
      readOnlyFile: false,
      content: Text.of(['changed']),
      savedContent: Text.of(['original']),
      range: {
        sourcePath: '/tmp/source.log',
        startByte: 0,
        endByte: 10,
        fingerprint: null,
        startLine: 1,
      },
    });
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'splice_file') {
        return Promise.reject(READ_ONLY_DESTINATION);
      }
      return Promise.resolve(null);
    }) as typeof invoke);

    const result = await documentWindow.rangeSave();

    expect(result).toBe('error');
    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/source.log',
      error: READ_ONLY_DESTINATION,
    });
    expect(tab.readOnlyFile).toBe(true);
  });
});

describe('saveWindowed on a read-only-destination refusal', () => {
  it('populates saveFailed with the tab path and flags the tab, still returning error', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    const tab = baseTab({
      id: 'windowed-tab',
      path: '/tmp/huge-readonly.log',
      readOnlyFile: false,
      windowed: {
        sessionId: 7,
        totalBytes: 1000,
        totalLines: 10,
        fingerprint: null,
        dirty: true,
        topLine: 0,
      },
    });
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'windowed_save') {
        return Promise.reject(READ_ONLY_DESTINATION);
      }
      return Promise.resolve(null);
    }) as typeof invoke);

    const result = await documentWindow.saveWindowedActive();

    expect(result).toBe('error');
    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/huge-readonly.log',
      error: READ_ONLY_DESTINATION,
    });
    expect(tab.readOnlyFile).toBe(true);
  });
});

describe('windowedConflictSaveAs on a read-only-destination refusal', () => {
  it('reports the path the user picked, not the tab it came from', async () => {
    // The user named this path by hand, so the tab keeps its old path and
    // reporting `tab.path` would name the wrong file.
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    const tab = baseTab({
      id: 'conflict-tab',
      path: '/tmp/original.log',
      readOnlyFile: false,
      windowed: {
        sessionId: 9,
        totalBytes: 1000,
        totalLines: 10,
        fingerprint: null,
        dirty: true,
        topLine: 0,
      },
    });
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    documentWindow.windowedConflict = tab;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'windowed_save') {
        return Promise.reject(READ_ONLY_DESTINATION);
      }
      return Promise.resolve(null);
    }) as typeof invoke);

    const result =
      await documentWindow.windowedConflictSaveAs('/tmp/picked.log');

    expect(result).toBe(false);
    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/picked.log',
      error: READ_ONLY_DESTINATION,
    });
    // The conflict modal is left up underneath, which is the whole reason the
    // failure dialog has to be the last one in DocumentApp's dialog section:
    // they share a z-index, so whichever renders later covers the other.
    expect(documentWindow.windowedConflict).toBe(tab);
  });
});

// The three paths below reached the same dead end for anything that was not a
// conflict or a refusal: a bare 'error'/false, a tab left dirty, and nothing at
// all on screen to say why. Cmd+S on a range or windowed tab discards the
// return value, so the user pressed the key and saw no reaction whatsoever.
// These pin that every one of them reports now, and that an unrelated error
// does not raise the read-only flag the padlock is drawn from.
describe('splice reports a failure that is not a refusal', () => {
  it('populates saveFailed with the source path and leaves the read-only flag alone', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    const tab = baseTab({
      id: 'range-tab',
      path: '',
      readOnlyFile: false,
      content: Text.of(['changed']),
      savedContent: Text.of(['original']),
      range: {
        sourcePath: '/tmp/source.log',
        startByte: 0,
        endByte: 10,
        fingerprint: null,
        startLine: 1,
      },
    });
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'splice_file') {
        return Promise.reject('No space left on device (os error 28)');
      }
      return Promise.resolve(null);
    }) as typeof invoke);

    const result = await documentWindow.rangeSave();

    expect(result).toBe('error');
    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/source.log',
      error: 'No space left on device (os error 28)',
    });
    expect(tab.readOnlyFile).toBe(false);
  });
});

describe('saveWindowed reports a failure that is not a refusal', () => {
  it('populates saveFailed with the tab path and leaves the read-only flag alone', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    const tab = baseTab({
      id: 'windowed-tab',
      path: '/tmp/huge.log',
      readOnlyFile: false,
      windowed: {
        sessionId: 7,
        totalBytes: 1000,
        totalLines: 10,
        fingerprint: null,
        dirty: true,
        topLine: 0,
      },
    });
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'windowed_save') {
        return Promise.reject('Input/output error (os error 5)');
      }
      return Promise.resolve(null);
    }) as typeof invoke);

    const result = await documentWindow.saveWindowedActive();

    expect(result).toBe('error');
    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/huge.log',
      error: 'Input/output error (os error 5)',
    });
    expect(tab.readOnlyFile).toBe(false);
  });
});

describe('windowedConflictSaveAs reports a failure that is not a refusal', () => {
  it('names the path the user picked, not the tab it came from', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    const tab = baseTab({
      id: 'conflict-tab',
      path: '/tmp/original.log',
      readOnlyFile: false,
      windowed: {
        sessionId: 9,
        totalBytes: 1000,
        totalLines: 10,
        fingerprint: null,
        dirty: true,
        topLine: 0,
      },
    });
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    documentWindow.windowedConflict = tab;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'windowed_save') {
        return Promise.reject('No space left on device (os error 28)');
      }
      return Promise.resolve(null);
    }) as typeof invoke);

    const result =
      await documentWindow.windowedConflictSaveAs('/tmp/picked.log');

    expect(result).toBe(false);
    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/picked.log',
      error: 'No space left on device (os error 28)',
    });
    expect(documentWindow.windowedConflict).toBe(tab);
  });
});

// A failed `read_range`/`copy_range` used to be indistinguishable from a
// successful extraction or a cancelled save (both were swallowed to the same
// `null`/`false` the success/cancel paths already returned). These confirm
// the three outcomes are now distinguishable: a genuine failure rejects
// instead of resolving.
describe('createRangeTab distinguishes failure from success and refusal', () => {
  beforeEach(() => {
    documentWindow.tabs.length = 0;
  });

  it('rejects when read_range fails, instead of resolving null like a success', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'read_range') {
        return Promise.reject(new Error('file gone'));
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    await expect(
      documentWindow.createRangeTab('/tmp/big.log', {
        startByte: 0,
        endByte: 10,
        startLine: 0,
        endLine: 1,
      }),
    ).rejects.toThrow('file gone');
    // No tab was opened for the failed read.
    expect(documentWindow.tabs).toHaveLength(0);
  });

  it('resolves null on a real success (contrast with the failure above)', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'read_range') {
        return Promise.resolve({ text: 'hello', lossy: false });
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    const result = await documentWindow.createRangeTab('/tmp/big.log', {
      startByte: 0,
      endByte: 10,
      startLine: 0,
      endLine: 1,
    });

    expect(result).toBe(null);
    expect(documentWindow.tabs).toHaveLength(1);
  });

  it('resolves a message when the range is refused for being lossy (contrast with the failure above)', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'read_range') {
        return Promise.resolve({ text: '�', lossy: true });
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    const result = await documentWindow.createRangeTab('/tmp/big.log', {
      startByte: 0,
      endByte: 10,
      startLine: 0,
      endLine: 1,
    });

    expect(result).toBe(t('doc.range.lossyRefusal'));
    expect(documentWindow.tabs).toHaveLength(0);
  });

  it('queries path_writable against the source file, not the (empty) tab path', async () => {
    mockInvoke.mockImplementation(((cmd: string, args?: unknown) => {
      if (cmd === 'read_range') {
        return Promise.resolve({ text: 'hello', lossy: false });
      }
      if (cmd === 'path_writable') {
        expect(args).toEqual({ path: '/tmp/big.log' });
        return Promise.resolve(false);
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    await documentWindow.createRangeTab('/tmp/big.log', {
      startByte: 0,
      endByte: 10,
      startLine: 0,
      endLine: 1,
    });

    expect(documentWindow.tabs[0]?.readOnlyFile).toBe(true);
  });
});

describe('saveRangeAs distinguishes failure from success and cancellation', () => {
  it('rejects when copy_range fails, instead of resolving false like a cancel', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'copy_range') {
        return Promise.reject(new Error('disk full'));
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    await expect(
      documentWindow.saveRangeAs('/tmp/big.log', {
        startByte: 0,
        endByte: 10,
        pathOverride: '/tmp/out.log',
      }),
    ).rejects.toThrow('disk full');
  });

  it('resolves true on a real success (contrast with the failure above)', async () => {
    mockInvoke.mockImplementation((() =>
      Promise.resolve(undefined)) as typeof invoke);

    const result = await documentWindow.saveRangeAs('/tmp/big.log', {
      startByte: 0,
      endByte: 10,
      pathOverride: '/tmp/out.log',
    });

    expect(result).toBe(true);
  });
});

// A failed `read_file_as` used to be swallowed silently (the encoding picker
// just snapped back with no explanation). Confirms the failure is now
// reported through `encodingFailed` instead of vanishing.
describe('setEncoding reports a failed re-decode instead of silently reverting', () => {
  it('sets encodingFailed to the tab path and leaves the encoding unchanged', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.encodingFailed = null;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'read_file_as') {
        return Promise.reject(new Error('permission denied'));
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);
    documentWindow.tabs.push(
      baseTab({ id: 'a', tabIndex: 0, path: '/tmp/a.txt', encoding: 'UTF-8' }),
    );
    documentWindow.activeIndex = 0;

    await documentWindow.setEncoding('Shift-JIS');

    expect(documentWindow.encodingFailed).toBe('/tmp/a.txt');
    expect(documentWindow.tabs[0]?.encoding).toBe('UTF-8');
  });
});

describe('a rejected upsert_note must not poison lastSave (flush-rejection regression)', () => {
  it('still lets switchTo change the active tab after the outgoing tab failed to save', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'upsert_note') {
        return Promise.reject(new Error('disk full'));
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    documentWindow.tabs.length = 0;
    documentWindow.tabs.push(
      baseTab({ id: 'a', tabIndex: 0 }),
      baseTab({ id: 'b', tabIndex: 1, path: '' }),
    );
    documentWindow.activeIndex = 0;
    // Dirties the active tab and schedules the debounced auto-persist, the
    // same way a keystroke would; switchTo flushes it before switching.
    documentWindow.updateActiveContent(Text.of(['dirty']));

    await expect(documentWindow.switchTo(1)).resolves.toBeUndefined();

    expect(documentWindow.activeIndex).toBe(1);
    expect(documentWindow.snapshotFailed).toBe(true);
  });

  it('flushAll attempts every dirty tab and resolves even when one of them fails', async () => {
    const attempted: string[] = [];
    mockInvoke.mockImplementation(((cmd: string, args?: unknown) => {
      if (cmd === 'upsert_note') {
        const id = (args as { note: { id: string } }).note.id;
        attempted.push(id);
        if (id === 'fails') {
          return Promise.reject(new Error('disk full'));
        }
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    documentWindow.tabs.length = 0;
    documentWindow.tabs.push(
      baseTab({ id: 'fails', tabIndex: 0, content: Text.of(['dirty']) }),
      baseTab({ id: 'ok', tabIndex: 1, path: '', content: Text.of(['dirty']) }),
    );
    documentWindow.activeIndex = 0;

    await expect(documentWindow.flushAll()).resolves.toBeUndefined();

    expect(attempted.sort()).toEqual(['fails', 'ok']);
  });
});

describe('the write-failure quit/close gate (firstUnwritableDirtyIndex / firstBlockingDirty)', () => {
  it('flags a dirty tab whose snapshot write failed, distinct from oversized', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'upsert_note') {
        return Promise.reject(new Error('disk full'));
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    documentWindow.tabs.length = 0;
    documentWindow.tabs.push(
      baseTab({ id: 'a', tabIndex: 0, content: Text.of(['dirty']) }),
    );
    documentWindow.activeIndex = 0;

    // Not known until a write is actually attempted (unlike oversized, which
    // is known from content size alone).
    expect(documentWindow.firstUnwritableDirtyIndex()).toBe(-1);
    expect(documentWindow.firstBlockingDirty()).toBeNull();

    await documentWindow.flushAll();

    expect(documentWindow.firstUnwritableDirtyIndex()).toBe(0);
    expect(documentWindow.firstBlockingDirty()).toEqual({
      index: 0,
      oversized: false,
    });
  });

  it('clears the flag once a retried write succeeds, dropping it from the gate', async () => {
    let fail = true;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'upsert_note') {
        return fail
          ? Promise.reject(new Error('disk full'))
          : Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    documentWindow.tabs.length = 0;
    documentWindow.tabs.push(
      baseTab({ id: 'a', tabIndex: 0, content: Text.of(['dirty']) }),
    );
    documentWindow.activeIndex = 0;

    await documentWindow.flushAll();
    expect(documentWindow.firstUnwritableDirtyIndex()).toBe(0);

    fail = false;
    await documentWindow.flushAll();
    expect(documentWindow.firstUnwritableDirtyIndex()).toBe(-1);
    expect(documentWindow.firstBlockingDirty()).toBeNull();
  });

  it("discarding the failed tab's changes clears it (clean tabs never block)", async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'upsert_note') {
        return Promise.reject(new Error('disk full'));
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    documentWindow.tabs.length = 0;
    documentWindow.tabs.push(
      baseTab({ id: 'a', tabIndex: 0, content: Text.of(['dirty']) }),
    );
    documentWindow.activeIndex = 0;

    await documentWindow.flushAll();
    expect(documentWindow.firstUnwritableDirtyIndex()).toBe(0);

    documentWindow.discardChanges(0);
    // The revert makes the tab clean immediately; the follow-up upsert it
    // fires (still rejecting) is irrelevant once nothing is dirty.
    expect(documentWindow.firstUnwritableDirtyIndex()).toBe(-1);
  });

  it('walks multiple unwritable tabs one at a time, in index order', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'upsert_note') {
        return Promise.reject(new Error('disk full'));
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    documentWindow.tabs.length = 0;
    documentWindow.tabs.push(
      baseTab({ id: 'a', tabIndex: 0, content: Text.of(['dirty a']) }),
      baseTab({ id: 'b', tabIndex: 1, content: Text.of(['dirty b']) }),
    );
    documentWindow.activeIndex = 0;

    await documentWindow.flushAll();

    expect(documentWindow.firstBlockingDirty()).toEqual({
      index: 0,
      oversized: false,
    });

    documentWindow.discardChanges(0);
    expect(documentWindow.firstBlockingDirty()).toEqual({
      index: 1,
      oversized: false,
    });

    documentWindow.discardChanges(1);
    expect(documentWindow.firstBlockingDirty()).toBeNull();
  });

  it('firstBlockingDirty prefers an oversized tab over an unwritable one', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'upsert_note') {
        return Promise.reject(new Error('disk full'));
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    documentWindow.tabs.length = 0;
    documentWindow.tabs.push(
      // Index 0: within the ceiling, its write is actually attempted and fails.
      baseTab({ id: 'small', tabIndex: 0, content: Text.of(['dirty']) }),
      // Index 1: over the ceiling — known oversized before any write attempt.
      baseTab({
        id: 'huge',
        tabIndex: 1,
        content: Text.of(['x'.repeat(SNAPSHOT_CONTENT_MAX + 1)]),
      }),
    );
    documentWindow.activeIndex = 0;

    await documentWindow.flushAll();

    expect(documentWindow.firstUnwritableDirtyIndex()).toBe(0);
    expect(documentWindow.firstOversizedDirtyIndex()).toBe(1);
    // Oversized wins even though the unwritable tab comes first: it is known
    // in advance and must be handled before a write is even attempted.
    expect(documentWindow.firstBlockingDirty()).toEqual({
      index: 1,
      oversized: true,
    });
  });
});

// Nothing else covers the composition: `applyLineEnding` and `detectLineEnding`
// have their own unit tests, and Rust covers the byte write, but no test until
// here asserted what `saveActive` actually hands to `write_file_encoded` — so a
// tab opened from a CRLF file could have been written back as LF with every
// existing test still green.
describe('saveActive line endings in the write_file_encoded payload', () => {
  /** Runs `saveActive` against a tab holding <lines> with <lineEnding> and
   *  returns the `content` the write received. The buffer is always LF, the way
   *  the editor holds it; the terminator is applied on the way out. */
  async function savedContentFor(
    lineEnding: 'LF' | 'CRLF',
    lines: string[],
  ): Promise<string> {
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    documentWindow.tabs.push(
      baseTab({
        id: 'save-tab',
        path: '/tmp/doc.txt',
        content: Text.of(lines),
        savedContent: Text.empty,
        lineEnding,
        savedLineEnding: lineEnding,
      }),
    );
    documentWindow.activeIndex = 0;
    mockInvoke.mockClear();
    mockInvoke.mockImplementation((() =>
      Promise.resolve(null)) as typeof invoke);

    expect(await documentWindow.saveActive()).toBe(true);

    const call = mockInvoke.mock.calls.find(
      (c) => c[0] === 'write_file_encoded',
    );
    return (call?.[1] as { content: string }).content;
  }

  it('writes CRLF terminators for a CRLF tab, and no bare LF', async () => {
    const out = await savedContentFor('CRLF', ['one', 'two', 'three']);
    expect(out).toBe('one\r\ntwo\r\nthree');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('writes LF terminators for an LF tab, and no CR at all', async () => {
    const out = await savedContentFor('LF', ['one', 'two', 'three']);
    expect(out).toBe('one\ntwo\nthree');
    expect(out).not.toContain('\r');
  });

  it('follows toggleLineEnding, flipping every terminator and nothing else', async () => {
    await savedContentFor('LF', ['one', 'two', 'three']);
    documentWindow.toggleLineEnding();
    expect(documentWindow.tabs[0]?.lineEnding).toBe('CRLF');
    mockInvoke.mockClear();

    expect(await documentWindow.saveActive()).toBe(true);

    const call = mockInvoke.mock.calls.find(
      (c) => c[0] === 'write_file_encoded',
    );
    const out = (call?.[1] as { content: string }).content;
    expect(out).toBe('one\r\ntwo\r\nthree');
    expect(out.split(/\r\n/).join('\n')).toBe('one\ntwo\nthree');
  });
});
