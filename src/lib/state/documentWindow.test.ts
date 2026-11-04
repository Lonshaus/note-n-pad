// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import {
  snapshotContentPolicy,
  SNAPSHOT_CONTENT_MAX,
} from '../util/snapshotPolicy';
import type { NoteSnapshot } from './stickyNote.svelte';
import { t } from '../i18n';
import { settingsState } from './settings.svelte';
import { editionState } from './edition.svelte';
import {
  documentWindow,
  windowedRefusalReason,
  windowedSnapshotDirty,
  windowedSnapshotLarge,
  LARGE_FILE_THRESHOLD,
  type DocTab,
} from './documentWindow.svelte';
import { READ_ONLY_DESTINATION } from '../util/protocol';
import { detectByFilename } from '../editor/language';
// Mocked so the tests below drive `documentWindow`'s real
// `setBounds`/`switchTo` against a fake Tauri backend instead of
// reimplementing the logic under test. `vi.mock` is hoisted above every
// import in this file by Vitest's transform, so `documentWindow.svelte.ts`'s
// own top-level `import { invoke } from '@tauri-apps/api/core'` binds to it.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockSave = vi.mocked(save);
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
    range_end_line: null,
    range_trailing_break: null,
    windowed_index: null,
    windowed_fp_size: null,
    windowed_fp_mtime: null,
    windowed_digest: null,
    windowed_top_line: null,
    windowed_encoding: null,
    windowed_bom: false,
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
              range_end_line: null,
              range_trailing_break: null,
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

describe('init waits for the edition', () => {
  it('does not read the snapshots until the edition is settled', async () => {
    let settle: () => void = () => {};
    const gate = vi.spyOn(editionState, 'ready').mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((() => Promise.resolve([])) as typeof invoke);
    const done = documentWindow.init('g-edition', null, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockInvoke).not.toHaveBeenCalledWith('list_notes');
    settle();
    await done;
    expect(mockInvoke).toHaveBeenCalledWith('list_notes');
    gate.mockRestore();
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

describe('switchTo and an IME composition', () => {
  afterEach(() => {
    documentWindow.endComposition = null;
  });

  it('changes the active tab only after the composition has ended', async () => {
    mockInvoke.mockImplementation((() =>
      Promise.resolve(undefined)) as typeof invoke);
    documentWindow.tabs.length = 0;
    documentWindow.tabs.push(
      baseTab({ id: 'a', tabIndex: 0 }),
      baseTab({ id: 'b', tabIndex: 1, path: '' }),
    );
    documentWindow.activeIndex = 0;
    let finish: () => void = () => {};
    documentWindow.endComposition = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });

    const switching = documentWindow.switchTo(1);
    await Promise.resolve();
    expect(documentWindow.activeIndex).toBe(0);

    finish();
    await switching;
    expect(documentWindow.activeIndex).toBe(1);
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

describe('a slow-path windowed restore lets go of the kept viewer index', () => {
  it('drops the kept line index when the reopen completes', async () => {
    documentWindow.tabs.length = 0;
    let finishReopen: (v: object) => void = () => {};
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'list_notes':
          return Promise.resolve([
            baseNote({
              id: 'pending-slow',
              large: 150 * 1024 * 1024,
              windowed_index: { checkpoints: [[0, 0]], total_newlines: 10 },
              windowed_fp_size: 150 * 1024 * 1024,
              windowed_fp_mtime: 1_700_000_000_000,
              windowed_digest: '999',
              windowed_top_line: 3,
            }),
          ]);
        case 'windowed_reopen':
          return new Promise((resolve) => {
            finishReopen = resolve as (v: object) => void;
          });
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);
    await documentWindow.init('g1', null, null);
    const tab = documentWindow.tabs[0]!;
    // The grace timer fired: the viewer is up and keeps an index.
    tab.large = { size: 150 * 1024 * 1024 };
    documentWindow.setLargeIndex(tab.id, { id: 'kept', size: 1, mtimeMs: 2 });
    expect(documentWindow.largeIndex(tab.id)).toBeDefined();
    finishReopen({
      session_id: 7,
      total_bytes: 10,
      total_lines: 5000,
      fingerprint: null,
      rescanned: true,
    });
    await vi.waitFor(() => {
      expect(tab.windowed).toBeDefined();
    });
    expect(documentWindow.largeIndex(tab.id)).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith('drop_line_index', { id: 'kept' });
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
// save, using the real write target (the windowed tab's own path), not a
// possibly-empty `path`. The range box's write-back is pinned the same way in
// rangeTrailingBreak.test.ts. The pair after them pins that an error which is
// neither a conflict nor a refusal is reported just the same.
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
// Both paths below reached the same dead end for anything that was not a
// conflict or a refusal: a bare 'error'/false, a tab left dirty, and nothing at
// all on screen to say why. Cmd+S on a windowed tab discards the return value,
// so the user pressed the key and saw no reaction whatsoever. These pin that
// every one of them reports now, and that an unrelated error does not raise the
// read-only flag the padlock is drawn from.
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
/** A windowed tab on `/tmp/original.log`, pushed as the only (active) tab. */
function pushWindowedTab(): DocTab {
  documentWindow.tabs.length = 0;
  documentWindow.saveFailed = null;
  documentWindow.windowedConflict = null;
  const tab = baseTab({
    id: 'windowed-tab',
    path: '/tmp/original.log',
    windowed: {
      sessionId: 9,
      totalBytes: 1000,
      totalLines: 10,
      fingerprint: { size: 1000, mtime_ms: 1 },
      dirty: true,
      topLine: 0,
    },
  });
  documentWindow.tabs.push(tab);
  documentWindow.activeIndex = 0;
  return tab;
}

const SAVED_AS = {
  fingerprint: { size: 1234, mtime_ms: 99 },
  total_bytes: 1234,
  total_lines: 12,
  clean: true,
  generation: 7,
};

describe('a save waits for what was typed into the windowed editor', () => {
  it('writes only after the editor has flushed, for a save and for a save as', async () => {
    pushWindowedTab();
    mockSave.mockResolvedValue('/tmp/copy.txt');
    const order: string[] = [];
    let flushed: () => void = () => {};
    documentWindow.windowedFlushed = () =>
      new Promise<void>((resolve) => {
        order.push('flush started');
        flushed = () => {
          order.push('flushed');
          resolve();
        };
      });
    mockInvoke.mockImplementation(((cmd: string) => {
      order.push(cmd);
      return Promise.resolve(cmd === 'windowed_save' ? SAVED_AS : null);
    }) as typeof invoke);

    try {
      const saving = documentWindow.saveActive();
      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual(['flush started']);
      flushed();
      expect(await saving).toBe(true);
      expect(order.slice(0, 3)).toEqual([
        'flush started',
        'flushed',
        'windowed_save',
      ]);

      order.length = 0;
      const savingAs = documentWindow.saveAs();
      await new Promise((r) => setTimeout(r, 0));
      expect(order).toEqual(['flush started']);
      flushed();
      expect(await savingAs).toBe(true);
      expect(order.slice(0, 3)).toEqual([
        'flush started',
        'flushed',
        'windowed_save',
      ]);
    } finally {
      documentWindow.windowedFlushed = null;
    }
  });
});

describe('saveAs on a windowed tab', () => {
  it('asks the dialog and writes the chosen path with no expected fingerprint', async () => {
    const tab = pushWindowedTab();
    mockSave.mockResolvedValue('/tmp/copy.txt');
    mockInvoke.mockImplementation(((cmd: string) =>
      Promise.resolve(
        cmd === 'windowed_save' ? SAVED_AS : null,
      )) as typeof invoke);

    expect(await documentWindow.saveAs()).toBe(true);

    expect(mockSave).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith('windowed_save', {
      sessionId: 9,
      expected: null,
      pathOverride: '/tmp/copy.txt',
    });
    expect(tab.path).toBe('/tmp/copy.txt');
    expect(tab.language).toBe(detectByFilename('/tmp/copy.txt'));
    expect(tab.windowed?.fingerprint).toEqual(SAVED_AS.fingerprint);
    expect(tab.windowed?.totalBytes).toBe(1234);
    expect(tab.windowed?.totalLines).toBe(12);
    expect(tab.windowed?.dirty).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith('upsert_note', expect.anything());
    expect(mockInvoke).toHaveBeenCalledWith('add_recent_file', {
      path: '/tmp/copy.txt',
    });
  });

  it('writes nothing when the dialog is cancelled', async () => {
    const tab = pushWindowedTab();
    mockSave.mockResolvedValue(null);
    mockInvoke.mockReset();

    expect(await documentWindow.saveAs()).toBe(false);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(tab.path).toBe('/tmp/original.log');
  });

  it('reports a failure with the chosen path, retargets nothing and never raises the conflict modal', async () => {
    const tab = pushWindowedTab();
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'windowed_save'
        ? Promise.reject('fingerprint-mismatch')
        : Promise.resolve(null)) as typeof invoke);

    expect(await documentWindow.saveAs('/tmp/copy.txt')).toBe(false);

    expect(documentWindow.windowedConflictVisible()).toBe(false);
    expect(tab.path).toBe('/tmp/original.log');
    expect(tab.windowed?.fingerprint).toEqual({ size: 1000, mtime_ms: 1 });
    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/copy.txt',
      error: 'fingerprint-mismatch',
    });
  });
});

describe('windowedConflictSaveAs success', () => {
  it('retargets the tab: path, fingerprint, sizes, language and conflict state', async () => {
    const tab = pushWindowedTab();
    documentWindow.windowedConflict = tab;
    mockInvoke.mockImplementation(((cmd: string) =>
      Promise.resolve(
        cmd === 'windowed_save' ? SAVED_AS : null,
      )) as typeof invoke);

    expect(
      await documentWindow.windowedConflictSaveAs('/tmp/picked.json'),
    ).toBe(true);

    expect(tab.path).toBe('/tmp/picked.json');
    expect(tab.language).toBe('JSON');
    expect(tab.windowed?.fingerprint).toEqual(SAVED_AS.fingerprint);
    expect(tab.windowed?.dirty).toBe(false);
    expect(documentWindow.windowedConflictVisible()).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith('upsert_note', expect.anything());
  });

  it('keeps an explicitly chosen language', async () => {
    const tab = pushWindowedTab();
    tab.explicit = true;
    tab.language = 'markdown';
    documentWindow.windowedConflict = tab;
    mockInvoke.mockImplementation(((cmd: string) =>
      Promise.resolve(
        cmd === 'windowed_save' ? SAVED_AS : null,
      )) as typeof invoke);

    await documentWindow.windowedConflictSaveAs('/tmp/picked.json');

    expect(tab.language).toBe('markdown');
  });
});
/** A promise the test settles by hand, to hold an invoke open. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
/** Let every already-resolved promise chain run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
/** A viewer tab on `/tmp/big.log` (1000 bytes at open), the only active tab. */
function pushViewerTab(id: string): DocTab {
  documentWindow.tabs.length = 0;
  documentWindow.saveFailed = null;
  documentWindow.windowedConflict = null;
  const tab = baseTab({ id, path: '/tmp/big.log', large: { size: 1000 } });
  documentWindow.tabs.push(tab);
  documentWindow.activeIndex = 0;
  return tab;
}
const RESTORE: NonNullable<DocTab['windowedRestore']> = {
  index: { checkpoints: [[0, 0]], total_newlines: 10 },
  fingerprint: { size: 1000, mtime_ms: 1 },
  digest: '1',
  topLine: 0,
  size: 1000,
};
// A large-file viewer has no buffer of its own: the generic save used to write
// its empty `content` over the original file.
describe('a large-file viewer never writes its empty buffer over the file', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((() =>
      Promise.resolve(null)) as typeof invoke);
  });

  it('saveActive on a viewer tab writes nothing and returns false', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    documentWindow.tabs.push(
      baseTab({ id: 'h1-viewer-save', large: { size: 1000 } }),
    );
    documentWindow.activeIndex = 0;

    expect(await documentWindow.saveActive()).toBe(false);

    expect(mockInvoke).not.toHaveBeenCalledWith(
      'write_file_encoded',
      expect.anything(),
    );
    expect(documentWindow.saveFailed).toBeNull();
  });

  it('saveActive on a tab that only has windowedRestore writes nothing and returns false', async () => {
    const reopen = deferred<object>();
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'windowed_reopen'
        ? reopen.promise
        : Promise.resolve(null)) as typeof invoke);
    documentWindow.tabs.length = 0;
    const tab = baseTab({ id: 'h1-restore-save', windowedRestore: RESTORE });
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;

    expect(await documentWindow.saveActive()).toBe(false);

    expect(mockInvoke).not.toHaveBeenCalledWith(
      'write_file_encoded',
      expect.anything(),
    );
    reopen.reject('boom');
    await vi.waitFor(() => {
      expect(tab.windowedRestore).toBeUndefined();
    });
  });
});

describe('saveAs on a large-file viewer tab copies the original bytes', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(((cmd: string) =>
      Promise.resolve(
        cmd === 'stat_file' ? { size: 1500 } : null,
      )) as typeof invoke);
  });

  it('copies up to the size on disk now, not the size at open, and retargets the tab', async () => {
    const tab = pushViewerTab('h1-copy');

    expect(await documentWindow.saveAs('/tmp/copy.json')).toBe(true);

    expect(mockInvoke).toHaveBeenCalledWith('stat_file', {
      path: '/tmp/big.log',
    });
    expect(mockInvoke).toHaveBeenCalledWith('copy_range', {
      path: '/tmp/big.log',
      start: 0,
      end: 1500,
      dest: '/tmp/copy.json',
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'write_file_encoded',
      expect.anything(),
    );
    expect(tab.path).toBe('/tmp/copy.json');
    expect(tab.language).toBe(detectByFilename('/tmp/copy.json'));
    expect(tab.large?.size).toBe(1500);
    expect(mockInvoke).toHaveBeenCalledWith(
      'upsert_note',
      expect.objectContaining({
        note: expect.objectContaining({ file_path: '/tmp/copy.json' }),
      }),
    );
    expect(mockInvoke).toHaveBeenCalledWith('add_recent_file', {
      path: '/tmp/copy.json',
    });
  });

  it('keeps an explicitly chosen language', async () => {
    const tab = pushViewerTab('h1-copy-explicit');
    tab.explicit = true;
    tab.language = 'markdown';

    await documentWindow.saveAs('/tmp/copy.json');

    expect(tab.language).toBe('markdown');
  });

  it('reports a failed copy with the chosen path and keeps the tab on the original', async () => {
    const tab = pushViewerTab('h1-copy-fail');
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'copy_range') {
        return Promise.reject('No space left on device (os error 28)');
      }
      return Promise.resolve(cmd === 'stat_file' ? { size: 1500 } : null);
    }) as typeof invoke);

    expect(await documentWindow.saveAs('/tmp/copy.log')).toBe(false);

    expect(documentWindow.saveFailed).toEqual({
      path: '/tmp/copy.log',
      error: 'No space left on device (os error 28)',
    });
    expect(tab.path).toBe('/tmp/big.log');
    expect(tab.large?.size).toBe(1000);
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'upsert_note',
      expect.anything(),
    );
  });

  it('succeeds without copying when the chosen path is the file itself', async () => {
    const tab = pushViewerTab('h1-copy-same');

    expect(await documentWindow.saveAs('/tmp/big.log')).toBe(true);

    expect(mockInvoke).not.toHaveBeenCalledWith(
      'copy_range',
      expect.anything(),
    );
    expect(tab.path).toBe('/tmp/big.log');
  });
});

describe('a large tab does one thing at a time (switching modes vs Save As)', () => {
  const OPENED = {
    session_id: 5,
    total_bytes: 1000,
    total_lines: 10,
    fingerprint: { size: 1000, mtime_ms: 1 },
  };

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('Save As waits for an unlock in flight, then saves the edit session to the new path', async () => {
    const open = deferred<object>();
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'windowed_open':
          return open.promise;
        case 'windowed_save':
          return Promise.resolve(SAVED_AS);
        case 'stat_file':
          return Promise.resolve({ size: 1500 });
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);
    const tab = pushViewerTab('h1-unlock-then-saveas');

    const unlocking = documentWindow.unlockLargeTab(0);
    const saving = documentWindow.saveAs('/tmp/new.log');
    await settle();

    expect(mockInvoke).not.toHaveBeenCalledWith(
      'copy_range',
      expect.anything(),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'windowed_save',
      expect.anything(),
    );

    open.resolve(OPENED);
    expect(await unlocking).toBeNull();
    expect(await saving).toBe(true);

    expect(mockInvoke).toHaveBeenCalledWith('windowed_save', {
      sessionId: 5,
      expected: null,
      pathOverride: '/tmp/new.log',
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'copy_range',
      expect.anything(),
    );
    expect(tab.path).toBe('/tmp/new.log');
    expect(tab.windowed?.sessionId).toBe(5);
  });

  it('an unlock waits for a view-mode copy in flight, then opens the new path', async () => {
    const copy = deferred<null>();
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'copy_range':
          return copy.promise;
        case 'windowed_open':
          return Promise.resolve(OPENED);
        case 'stat_file':
          return Promise.resolve({ size: 1500 });
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);
    const tab = pushViewerTab('h1-saveas-then-unlock');

    const saving = documentWindow.saveAs('/tmp/new.log');
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('copy_range', expect.anything());
    });
    const unlocking = documentWindow.unlockLargeTab(0);
    await settle();

    expect(mockInvoke).not.toHaveBeenCalledWith(
      'windowed_open',
      expect.anything(),
    );

    copy.resolve(null);
    expect(await saving).toBe(true);
    expect(await unlocking).toBeNull();

    expect(mockInvoke).toHaveBeenCalledWith('windowed_open', {
      path: '/tmp/new.log',
    });
    expect(tab.path).toBe('/tmp/new.log');
    expect(tab.windowed?.sessionId).toBe(5);
  });

  it('a Save As queued behind an unlock does nothing once its tab is closed', async () => {
    const open = deferred<object>();
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'windowed_open':
          return open.promise;
        case 'stat_file':
          return Promise.resolve({ size: 1500 });
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);
    pushViewerTab('h1-unlock-then-close');
    const unlocking = documentWindow.unlockLargeTab(0);
    const saving = documentWindow.saveAs('/tmp/new.log');
    await settle();
    documentWindow.tabs.length = 0;
    open.resolve(OPENED);
    expect(await unlocking).toBeNull();
    expect(await saving).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith('windowed_close', {
      sessionId: 5,
    });
    for (const cmd of [
      'copy_range',
      'windowed_save',
      'upsert_note',
      'add_recent_file',
    ]) {
      expect(mockInvoke).not.toHaveBeenCalledWith(cmd, expect.anything());
    }
  });

  it('a viewer copy that finishes after its tab closed writes no record and starts no unlock', async () => {
    const copy = deferred<null>();
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'copy_range':
          return copy.promise;
        case 'stat_file':
          return Promise.resolve({ size: 1500 });
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);
    const tab = pushViewerTab('h1-copy-then-close');
    const saving = documentWindow.saveAs('/tmp/new.log');
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('copy_range', expect.anything());
    });
    const unlocking = documentWindow.unlockLargeTab(0);
    documentWindow.tabs.length = 0;
    copy.resolve(null);
    expect(await saving).toBe(true);
    expect(await unlocking).toBeNull();
    expect(tab.path).toBe('/tmp/big.log');
    for (const cmd of ['upsert_note', 'add_recent_file', 'windowed_open']) {
      expect(mockInvoke).not.toHaveBeenCalledWith(cmd, expect.anything());
    }
  });

  it('Save As waits for a restore in flight, then saves the edit session to the new path', async () => {
    const reopen = deferred<object>();
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'windowed_reopen':
          return reopen.promise;
        case 'windowed_save':
          return Promise.resolve(SAVED_AS);
        case 'stat_file':
          return Promise.resolve({ size: 1500 });
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    const tab = baseTab({
      id: 'h1-restore-then-saveas',
      windowedRestore: RESTORE,
    });
    documentWindow.tabs.push(tab);
    // Becoming active starts the restore.
    documentWindow.activeIndex = 0;
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'windowed_reopen',
        expect.anything(),
      );
    });
    // What the grace timer does when the reopen is slow: the viewer shows.
    tab.large = { size: RESTORE.size };

    const saving = documentWindow.saveAs('/tmp/new.log');
    await settle();

    expect(mockInvoke).not.toHaveBeenCalledWith(
      'copy_range',
      expect.anything(),
    );

    reopen.resolve({ ...OPENED, rescanned: false });
    expect(await saving).toBe(true);

    expect(mockInvoke).toHaveBeenCalledWith('windowed_save', {
      sessionId: 5,
      expected: null,
      pathOverride: '/tmp/new.log',
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'copy_range',
      expect.anything(),
    );
    expect(tab.path).toBe('/tmp/new.log');
    expect(tab.windowed?.sessionId).toBe(5);
  });
});
// A failed `read_range`/`copy_range` used to be indistinguishable from a
// successful extraction or a cancelled save (both were swallowed to the same
// `null`/`false` the success/cancel paths already returned). These confirm
// the three outcomes are now distinguishable: a genuine failure rejects
// instead of resolving.
describe('openRangeBox distinguishes failure from success and refusal', () => {
  const viewer = (): DocTab =>
    baseTab({ id: 'v', path: '/tmp/big.log', large: { size: 1000 } });
  const info = { startByte: 0, endByte: 10, startLine: 1, endLine: 2 };

  beforeEach(() => {
    documentWindow.tabs.length = 0;
    documentWindow.rangeBox = null;
  });

  it('rejects when read_range fails, instead of resolving null like a success', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'read_range') {
        return Promise.reject(new Error('file gone'));
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    await expect(documentWindow.openRangeBox(viewer(), info)).rejects.toThrow(
      'file gone',
    );
    // No box was opened for the failed read.
    expect(documentWindow.rangeBox).toBeNull();
  });

  it('resolves null on a real success (contrast with the failure above)', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'read_range') {
        return Promise.resolve({ text: 'hello', lossy: false });
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    const result = await documentWindow.openRangeBox(viewer(), info);

    expect(result).toBe(null);
    expect(documentWindow.rangeBox?.content.toString()).toBe('hello');
    expect(documentWindow.rangeBox?.tabId).toBe('v');
    expect(documentWindow.rangeBox?.sourcePath).toBe('/tmp/big.log');
    // The box is not a tab.
    expect(documentWindow.tabs).toHaveLength(0);
  });

  it('resolves a message when the range is refused for being lossy (contrast with the failure above)', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'read_range') {
        return Promise.resolve({ text: '�', lossy: true });
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    const result = await documentWindow.openRangeBox(viewer(), info);

    expect(result).toBe(t('doc.range.lossyRefusal'));
    expect(documentWindow.rangeBox).toBeNull();
  });

  it('keeps going without a fingerprint when it cannot be taken', async () => {
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'read_range') {
        return Promise.resolve({ text: 'hello', lossy: false });
      }
      if (cmd === 'file_fingerprint') {
        return Promise.reject(new Error('gone'));
      }
      return Promise.resolve(undefined);
    }) as typeof invoke);

    expect(await documentWindow.openRangeBox(viewer(), info)).toBeNull();
    expect(documentWindow.rangeBox?.fingerprint).toBeNull();
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

  it('resolves false without copying when the dialog is cancelled', async () => {
    mockSave.mockResolvedValueOnce(null);
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((() =>
      Promise.resolve(undefined)) as typeof invoke);

    const result = await documentWindow.saveRangeAs('/tmp/big.log', {
      startByte: 0,
      endByte: 10,
    });

    expect(result).toBe(false);
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).not.toContain(
      'copy_range',
    );
  });
});
// The saved slice is a file like any other: it opens through the normal open
// flow, as a new tab of this window.
describe('saveRangeAs opens the saved file as a new tab', () => {
  let readySpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    readySpy.mockRestore();
  });

  beforeEach(async () => {
    readySpy = vi.spyOn(editionState, 'ready').mockResolvedValue();
    documentWindow.tabs.length = 0;
    documentWindow.activeIndex = 0;
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(((cmd: string, args?: unknown) => {
      switch (cmd) {
        case 'copy_range':
          return Promise.resolve(undefined);
        case 'list_notes':
          return Promise.resolve([]);
        case 'live_doc_groups':
          return Promise.resolve([]);
        case 'path_writable':
          return Promise.resolve(true);
        case 'stat_file':
          return Promise.resolve({ size: 10 });
        case 'read_file_auto':
        case 'read_file_as':
          expect((args as { path: string }).path).toBe('/tmp/out.log');
          return Promise.resolve({
            content: 'slice',
            encoding: 'UTF-8',
            had_bom: false,
            lossy: false,
          });
        default:
          return Promise.resolve(undefined);
      }
    }) as typeof invoke);
    // `init` throws on the bare mock answer but still settles `ready`.
    await settingsState.init().catch(() => {});
    // Opening a file waits for the window to know its tab indices.
    await documentWindow.init('g', null, null);
  });

  it('resolves true and opens the new path, after the copy, with the slice as its content', async () => {
    const ok = await documentWindow.saveRangeAs('/tmp/big.log', {
      startByte: 0,
      endByte: 10,
      pathOverride: '/tmp/out.log',
    });

    expect(ok).toBe(true);
    expect(documentWindow.tabs.map((tab) => tab.path)).toEqual([
      '/tmp/out.log',
    ]);
    expect(documentWindow.activeTab?.content.toString()).toBe('slice');
    const calls = mockInvoke.mock.calls.map(([cmd]) => cmd);
    expect(calls.indexOf('copy_range')).toBeLessThan(
      calls.indexOf('read_file_auto'),
    );
  });

  it('opens nothing when the copy fails', async () => {
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'copy_range'
        ? Promise.reject(new Error('disk full'))
        : Promise.resolve(undefined)) as typeof invoke);

    await expect(
      documentWindow.saveRangeAs('/tmp/big.log', {
        startByte: 0,
        endByte: 10,
        pathOverride: '/tmp/out.log',
      }),
    ).rejects.toThrow('disk full');
    expect(documentWindow.tabs).toHaveLength(0);
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
/** Full `load_settings` payload, so `settingsState.init()` resolves `ready` —
 *  every open awaits it inside `route`. `ask_long_line_open` is false so a plain
 *  open pushes its tab instead of staging the long-line gate. */
function loadedSettings(): Record<string, unknown> {
  return {
    settings: {
      theme: 'x',
      interface_mode: 'system',
      editor_font_size: 14,
      editor_word_wrap: true,
      editor_line_numbers: true,
      worker_highlight: false,
      large_open_mode: 'ask',
      large_select_all: 'visible',
      ask_long_line_open: false,
      preview_local_resources: false,
      open_target: 'tab',
      editor_font_family: '',
      default_line_ending: 'LF',
      default_encoding: 'UTF-8',
      new_note_shortcut: 'x',
      snapshot_dir: null,
      default_sticky_width: 280,
      default_sticky_height: 230,
      language: 'system',
      show_tray_icon: true,
      open_workspace_on_startup: false,
    },
    repaired_fields: [],
    snapshot_dir_unavailable: false,
  };
}
/** Yield until `done()` holds, or give up after a bounded number of turns. Used
 *  to park on a state the code under test reaches in its own microtasks rather
 *  than guessing how many awaits deep it is. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(done()).toBe(true);
}
// A fresh window loads its file asynchronously, and an open that arrives while
// it is still awaiting must not be undone by init's own tab selection. This
// reproduces the ordering that reached CI: the second open's switchTo lands
// first, init's trailing write lands second and pointed the window back at tab
// 0, where a .txt host tab reports no table and no rows.
describe('init does not reset the active tab over a concurrent open', () => {
  it('leaves the window on the tab the second open switched to', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.activeIndex = 0;
    let release: (() => void) | null = null;
    let upserts = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'load_settings':
          return Promise.resolve(loadedSettings());
        case 'list_notes':
          return Promise.resolve([]);
        case 'read_file_auto':
          return Promise.resolve({
            content: 'x',
            encoding: 'UTF-8',
            lossy: false,
            had_bom: false,
          });
        case 'upsert_note':
          upserts += 1;
          // Gate the first upsert only: openNormal pushes and switches before
          // it, so init parks here with the host tab already at index 0.
          if (upserts === 1) {
            return new Promise<null>((resolve) => {
              release = (): void => resolve(null);
            });
          }
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);
    await settingsState.init();

    const initDone = documentWindow.init('g-race', '/tmp/host.txt', null);
    await until(() => release !== null);
    // Not awaited: its switchTo parks on `lastSave`, which is the very promise
    // the gate holds, so awaiting it here would deadlock. `tabs.push` and the
    // synchronous head of switchTo run in one turn, so a second tab appearing
    // is the pin.
    const secondDone = documentWindow.openTab('/tmp/second.csv');
    await until(() => documentWindow.tabs.length === 2);
    release!();
    await Promise.all([initDone, secondDone]);

    expect(documentWindow.tabs[0]?.path).toBe('/tmp/host.txt');
    expect(documentWindow.tabs[1]?.path).toBe('/tmp/second.csv');
    expect(documentWindow.activeIndex).toBe(1);
  });
});
// The other half of the same statement: init's write was also what kicked the
// lazy reopen, and a fresh window's first tab can be an adopted orphan carrying
// a windowed restore. `switchTo(0)` returns early there, so without an explicit
// kick nothing ever reopens it and the window renders blank forever.
describe('a fresh window that adopts an orphaned windowed tab still restores it', () => {
  it('calls windowed_reopen for the adopted tab', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.activeIndex = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      switch (cmd) {
        case 'load_settings':
          return Promise.resolve(loadedSettings());
        case 'list_notes':
          return Promise.resolve([
            baseNote({
              id: 'orphan-1',
              file_path: '/tmp/adopted.log',
              window_group: 'g-dead',
              large: 150 * 1024 * 1024,
              windowed_index: { checkpoints: [[0, 0]], total_newlines: 7 },
              windowed_fp_size: 150 * 1024 * 1024,
              windowed_fp_mtime: 1_700_000_000_000,
              windowed_digest: 'adopted',
            }),
          ]);
        case 'live_doc_groups':
          return Promise.resolve([]);
        case 'windowed_reopen':
          return new Promise(() => {});
        default:
          return Promise.resolve(null);
      }
    }) as typeof invoke);
    await settingsState.init();
    // The spy's history is not cleared between tests in this file, and earlier
    // tests already record windowed_reopen calls, so clear it here or this
    // assertion can match one of theirs.
    mockInvoke.mockClear();

    await documentWindow.init('g-new', '/tmp/adopted.log', null);

    expect(mockInvoke).toHaveBeenCalledWith('windowed_reopen', {
      path: '/tmp/adopted.log',
      index: { checkpoints: [[0, 0]], total_newlines: 7 },
      fingerprint: { size: 150 * 1024 * 1024, mtime_ms: 1_700_000_000_000 },
      digest: 'adopted',
    });
  });
});
// The moved write still does its original job. The starting activeIndex differs
// from the expected position so the assertion cannot pass on a leftover value.
describe('init still selects the stored tab when restoring a window group', () => {
  it('resolves initialTab against the restored entries', async () => {
    documentWindow.tabs.length = 0;
    documentWindow.activeIndex = 0;
    mockInvoke.mockImplementation(((cmd: string) => {
      if (cmd === 'list_notes') {
        return Promise.resolve([
          baseNote({ id: 'a', file_path: '/tmp/a.txt', tab_index: 4 }),
          baseNote({ id: 'b', file_path: '/tmp/b.txt', tab_index: 9 }),
        ]);
      }
      return Promise.resolve(null);
    }) as typeof invoke);

    await documentWindow.init('g1', null, null, 9);

    expect(documentWindow.tabs.length).toBe(2);
    expect(documentWindow.activeIndex).toBe(1);
  });
});
// A large tab's bytes are never rewritten or re-decoded, so the line ending is
// the file's own (detected) and the encoding stays what it was.
describe('large and windowed tabs: line ending and encoding', () => {
  const largeTab = (): DocTab =>
    baseTab({ id: 'big', large: { size: 200 * 1024 * 1024 } });
  const windowedTab = (): DocTab =>
    baseTab({
      id: 'win',
      windowed: {
        sessionId: 7,
        totalBytes: 1,
        totalLines: 1,
        fingerprint: null,
        dirty: false,
        topLine: 0,
      },
    });
  const crlf = { lineEnding: 'CRLF', insert: '\r\n' } as const;

  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(null);
    settingsState.defaultLineEnding = 'LF';
  });

  function select(tab: DocTab): void {
    documentWindow.tabs.length = 0;
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
  }

  it('a windowed tab takes the detected ending, not the setting', () => {
    settingsState.defaultLineEnding = 'LF';
    const tab = windowedTab();
    select(tab);
    expect(documentWindow.windowedEndingDetected(7, crlf)).toBe('\r\n');
    expect(tab.lineEnding).toBe('CRLF');
    expect(tab.savedLineEnding).toBe('CRLF');
    expect(tab.insertLineEnding).toBe('\r\n');
  });

  it('a sample without a line break falls back to the setting', () => {
    settingsState.defaultLineEnding = 'CRLF';
    const tab = windowedTab();
    select(tab);
    expect(documentWindow.windowedEndingDetected(7, null)).toBe('\r\n');
    expect(tab.lineEnding).toBe('CRLF');
    settingsState.defaultLineEnding = 'LF';
  });

  it('an already detected windowed tab keeps its value', () => {
    const tab = windowedTab();
    tab.insertLineEnding = '\n';
    select(tab);
    expect(documentWindow.windowedEndingDetected(7, crlf)).toBe('\n');
    expect(tab.lineEnding).toBe('LF');
  });

  it('a viewer tab takes the detected ending from its first chunk', () => {
    const tab = largeTab();
    select(tab);
    documentWindow.largeEndingDetected('/tmp/huge.log', crlf);
    expect(tab.lineEnding).toBe('CRLF');
    expect(tab.insertLineEnding).toBe('\r\n');
  });

  it('a viewer chunk without a line break leaves the tab undetected', () => {
    const tab = largeTab();
    select(tab);
    documentWindow.largeEndingDetected('/tmp/huge.log', null);
    expect(tab.insertLineEnding).toBeUndefined();
    expect(tab.lineEnding).toBe('LF');
  });

  it.each([
    ['large', largeTab],
    ['windowed', windowedTab],
  ] as const)(
    'setLineEnding and toggleLineEnding do nothing on a %s tab',
    (_name, make) => {
      const tab = make();
      tab.insertLineEnding = '\n';
      select(tab);
      documentWindow.setLineEnding('CRLF');
      expect(tab.lineEnding).toBe('LF');
      documentWindow.toggleLineEnding();
      expect(tab.lineEnding).toBe('LF');
      expect(tab.savedLineEnding).toBe('LF');
      expect(tab.insertLineEnding).toBe('\n');
    },
  );

  it.each([
    ['large', largeTab],
    ['windowed', windowedTab],
  ] as const)(
    'setEncoding does not read or change a %s tab',
    async (_name, make) => {
      const tab = make();
      select(tab);
      const seq = documentWindow.reloadSeq;
      await documentWindow.setEncoding('Windows-1252');
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(tab.encoding).toBe('UTF-8');
      expect(tab.content.toString()).toBe('');
      expect(documentWindow.reloadSeq).toBe(seq);
    },
  );

  it('a normal tab still changes its line ending', () => {
    const tab = baseTab({ id: 'plain' });
    select(tab);
    documentWindow.setLineEnding('CRLF');
    expect(tab.lineEnding).toBe('CRLF');
  });
});

describe('the ordinary editor holds a tab while a large or windowed tab is active', () => {
  function setup(): void {
    documentWindow.tabs.length = 0;
    documentWindow.ordinaryMru = [];
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    documentWindow.tabs.push(
      baseTab({ id: 'a', tabIndex: 0, path: '/tmp/a.txt' }),
      baseTab({ id: 'L', tabIndex: 1, path: '/tmp/l.log', large: { size: 1 } }),
      baseTab({ id: 'b', tabIndex: 2, path: '/tmp/b.txt' }),
    );
    documentWindow.activeIndex = 0;
  }

  it('holds the last active ordinary tab behind a large tab', () => {
    setup();
    documentWindow.activeIndex = 2;
    documentWindow.activeIndex = 1;
    expect(documentWindow.heldTab?.id).toBe('b');
    documentWindow.activeIndex = 0;
    documentWindow.activeIndex = 1;
    expect(documentWindow.heldTab?.id).toBe('a');
  });

  it('re-points the held tab when it closes, and ends with none', async () => {
    setup();
    documentWindow.activeIndex = 2;
    documentWindow.activeIndex = 0;
    await documentWindow.deleteTab(0);
    // tab L is now active; b is the surviving ordinary tab
    expect(documentWindow.activeTab?.id).toBe('L');
    expect(documentWindow.heldTab?.id).toBe('b');
    // closing the last ordinary tab leaves nothing to hold
    await documentWindow.deleteTab(1);
    expect(documentWindow.heldTab).toBeNull();
  });

  it('writes an editor document to the tab it names, not the active one', () => {
    setup();
    documentWindow.activeIndex = 1;
    documentWindow.updateContentById('a', Text.of(['held text']));
    expect(documentWindow.tabs[0]?.content.toString()).toBe('held text');
    expect(documentWindow.tabs[1]?.content.toString()).toBe('');
  });

  it('records which tab a reload was meant for', () => {
    setup();
    documentWindow.activeIndex = 1;
    documentWindow.forceEditorReload();
    expect(documentWindow.reloadTargetId).toBe('L');
  });
});

describe('a large-file viewer tab keeps its line index', () => {
  function setup(): void {
    documentWindow.tabs.length = 0;
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    documentWindow.tabs.push(
      baseTab({ id: 'L', tabIndex: 0, path: '/tmp/l.log', large: { size: 1 } }),
      baseTab({ id: 'a', tabIndex: 1, path: '/tmp/a.txt' }),
    );
    documentWindow.activeIndex = 0;
  }
  const ref = { id: 'idx', size: 1, mtimeMs: 2 };

  it('stores the index and releases it when the tab closes', async () => {
    setup();
    documentWindow.setLargeIndex('L', ref);
    expect(documentWindow.largeIndex('L')).toEqual(ref);
    documentWindow.setViewTopLine('L', 709);
    await documentWindow.deleteTab(0);
    expect(mockInvoke).toHaveBeenCalledWith('drop_line_index', { id: 'idx' });
    expect(documentWindow.largeIndex('L')).toBeUndefined();
    expect(documentWindow.viewTopLine('L')).toBeUndefined();
  });

  it('releases an index reported for a tab that is gone or not a viewer', () => {
    setup();
    documentWindow.setLargeIndex('gone', ref);
    documentWindow.setLargeIndex('a', { ...ref, id: 'idx2' });
    expect(mockInvoke).toHaveBeenCalledWith('drop_line_index', { id: 'idx' });
    expect(mockInvoke).toHaveBeenCalledWith('drop_line_index', { id: 'idx2' });
    expect(documentWindow.largeIndex('gone')).toBeUndefined();
    expect(documentWindow.largeIndex('a')).toBeUndefined();
  });

  it('drops the index when the file is rewritten but keeps the position', () => {
    setup();
    documentWindow.setLargeIndex('L', ref);
    documentWindow.setViewTopLine('L', 5);
    documentWindow.refreshLargeTabs('/tmp/l.log');
    expect(mockInvoke).toHaveBeenCalledWith('drop_line_index', { id: 'idx' });
    expect(documentWindow.largeIndex('L')).toBeUndefined();
    expect(documentWindow.viewTopLine('L')).toBe(5);
  });

  it('drops every kept index when the window closes', async () => {
    setup();
    documentWindow.setLargeIndex('L', ref);
    await documentWindow.dropClosedTabs('main');
    expect(mockInvoke).toHaveBeenCalledWith('drop_line_index', { id: 'idx' });
  });
});

describe('where a windowed tab was looking is remembered per tab', () => {
  it('keeps the top line and the caret apart', () => {
    documentWindow.setViewTopLine('w', 165);
    documentWindow.setViewCaret('w', 170, 5);
    expect(documentWindow.viewTopLine('w')).toBe(165);
    expect(documentWindow.viewCaret('w')).toEqual({ line: 170, col: 5 });
    expect(documentWindow.viewCaret('other')).toBeUndefined();
  });
});

describe('runWindowedOp (a whole-file operation outliving its editor)', () => {
  function windowedTab(sessionId: number): DocTab {
    return baseTab({
      id: `op-tab-${sessionId}`,
      path: '/tmp/huge.log',
      windowed: {
        sessionId,
        totalBytes: 1000,
        totalLines: 10,
        fingerprint: null,
        dirty: false,
        topLine: 0,
      },
    });
  }

  it('keeps the session gate pending until the totals and dirty flag are recorded', async () => {
    documentWindow.tabs.length = 0;
    const tab = windowedTab(31);
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    type Totals = {
      total_bytes: number;
      total_lines: number;
      clean: boolean;
      generation: number;
    };
    let finish: (r: Totals) => void = () => {};
    const run = (): Promise<Totals> =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const op = documentWindow.runWindowedOp(31, run, () => true);
    const gate = documentWindow.windowedGate(31);
    expect(gate.pending()).toBe(true);
    expect(gate.canApply()).toBe(false);
    // An editor mounted now (a tab switched away and back) waits to read.
    const read = vi.fn(() => Promise.resolve(tab.windowed?.totalBytes));
    const mounted = gate.whenIdle(read);
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    finish({
      total_bytes: 5000,
      total_lines: 77,
      clean: false,
      generation: 1,
    });
    await op;
    // The read happens only after the tab learned the replaced totals.
    await expect(mounted).resolves.toBe(5000);
    expect(tab.windowed?.totalLines).toBe(77);
    expect(tab.windowed?.dirty).toBe(true);
    expect(gate.pending()).toBe(false);
  });

  it('leaves the tab clean when the operation changed nothing', async () => {
    documentWindow.tabs.length = 0;
    const tab = windowedTab(32);
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    await documentWindow.runWindowedOp(
      32,
      () =>
        Promise.resolve({
          count: 0,
          total_bytes: 1000,
          total_lines: 10,
          clean: true,
          generation: 0,
        }),
      (r) => r.count > 0,
    );
    expect(tab.windowed?.dirty).toBe(false);
    expect(documentWindow.windowedGate(32).pending()).toBe(false);
  });

  it('opens the gate again when the operation fails', async () => {
    documentWindow.tabs.length = 0;
    const tab = windowedTab(33);
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    await expect(
      documentWindow.runWindowedOp(
        33,
        () => Promise.reject(new Error('disk full')),
        () => true,
      ),
    ).rejects.toThrow('disk full');
    await documentWindow.windowedGate(33).whenIdle(() => Promise.resolve());
    expect(documentWindow.windowedGate(33).canApply()).toBe(true);
    expect(tab.windowed?.dirty).toBe(false);
  });

  it('passes the clean flag of the result on to the tab', async () => {
    documentWindow.tabs.length = 0;
    const tab = windowedTab(34);
    tab.windowed!.dirty = true;
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    await documentWindow.runWindowedOp(
      34,
      () =>
        Promise.resolve({
          total_bytes: 900,
          total_lines: 9,
          clean: true,
          generation: 3,
        }),
      () => true,
    );
    expect(tab.windowed?.dirty).toBe(false);
    expect(tab.windowed?.totalBytes).toBe(900);
    await documentWindow.runWindowedOp(
      34,
      () =>
        Promise.resolve({
          total_bytes: 950,
          total_lines: 9,
          clean: false,
          generation: 4,
        }),
      () => true,
    );
    expect(tab.windowed?.dirty).toBe(true);
  });
});

describe('windowedApplied (the dirty flag follows the clean flag)', () => {
  function windowedTab(sessionId: number): DocTab {
    return baseTab({
      id: `applied-tab-${sessionId}`,
      path: '/tmp/huge.log',
      windowed: {
        sessionId,
        totalBytes: 1000,
        totalLines: 10,
        fingerprint: null,
        dirty: false,
        topLine: 0,
      },
    });
  }

  it('sets dirty for a changed result and clears it for a clean one', () => {
    documentWindow.tabs.length = 0;
    const tab = windowedTab(41);
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    documentWindow.windowedApplied(41, 1100, 11, false, 1);
    expect(tab.windowed?.dirty).toBe(true);
    expect(tab.windowed?.totalBytes).toBe(1100);
    expect(tab.windowed?.totalLines).toBe(11);
    documentWindow.windowedApplied(41, 1000, 10, true, 2);
    expect(tab.windowed?.dirty).toBe(false);
    expect(tab.windowed?.totalBytes).toBe(1000);
  });

  it('ignores a result older than one already applied', () => {
    documentWindow.tabs.length = 0;
    const tab = windowedTab(42);
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    documentWindow.windowedApplied(42, 1000, 10, true, 5);
    documentWindow.windowedApplied(42, 1100, 11, false, 4);
    expect(tab.windowed?.dirty).toBe(false);
    expect(tab.windowed?.totalBytes).toBe(1000);
    // The same generation is not older.
    documentWindow.windowedApplied(42, 1200, 12, false, 5);
    expect(tab.windowed?.dirty).toBe(true);
  });

  it('applies a result to the tab that owns the session, not the active one', () => {
    documentWindow.tabs.length = 0;
    const a = windowedTab(51);
    const b = windowedTab(52);
    documentWindow.tabs.push(a, b);
    documentWindow.activeIndex = 1;
    documentWindow.windowedApplied(51, 1200, 12, false, 1);
    expect(a.windowed?.dirty).toBe(true);
    expect(a.windowed?.totalBytes).toBe(1200);
    expect(b.windowed?.dirty).toBe(false);
    expect(b.windowed?.totalBytes).toBe(1000);
  });

  it('ignores a result for a closed session and keeps its generation out of the books', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((() =>
      Promise.resolve(null)) as typeof invoke);
    documentWindow.tabs.length = 0;
    const a = windowedTab(53);
    const b = windowedTab(54);
    documentWindow.tabs.push(a, b);
    documentWindow.activeIndex = 1;
    await documentWindow.deleteTab(0);
    expect(documentWindow.tabs).toEqual([b]);
    documentWindow.windowedApplied(53, 9999, 99, false, 100);
    expect(b.windowed?.dirty).toBe(false);
    expect(b.windowed?.totalBytes).toBe(1000);
    // A later result of the other session, with a far lower generation, lands.
    documentWindow.windowedApplied(54, 1100, 11, false, 1);
    expect(b.windowed?.dirty).toBe(true);
    expect(b.windowed?.totalBytes).toBe(1100);
    // Had the ignored result's generation been recorded, a tab that holds the
    // same session id again would drop a lower one.
    const again = windowedTab(53);
    documentWindow.tabs.push(again);
    documentWindow.windowedApplied(53, 1300, 13, false, 1);
    expect(again.windowed?.dirty).toBe(true);
    expect(again.windowed?.totalBytes).toBe(1300);
  });

  it('ignores a save result for a closed session', async () => {
    documentWindow.tabs.length = 0;
    const tab = windowedTab(55);
    const other = windowedTab(56);
    tab.windowed!.dirty = true;
    documentWindow.tabs.push(tab, other);
    documentWindow.activeIndex = 1;
    let finish: (v: typeof SAVED_AS) => void = () => {};
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'windowed_save'
        ? new Promise<typeof SAVED_AS>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(null)) as typeof invoke);
    const saving = documentWindow.saveWindowed(tab, false);
    // The tab is closed while the write runs.
    await documentWindow.deleteTab(0);
    finish({ ...SAVED_AS, clean: true, generation: 100 });
    expect(await saving).toBe('ok');
    expect(other.windowed?.dirty).toBe(false);
    expect(other.windowed?.totalBytes).toBe(1000);
    expect(other.windowed?.fingerprint).toBeNull();
    expect(tab.windowed?.dirty).toBe(true);
  });

  it('save-as applies to the tab that owns the session while another tab is active', async () => {
    documentWindow.tabs.length = 0;
    const a = windowedTab(57);
    const b = windowedTab(58);
    a.windowed!.dirty = true;
    b.windowed!.dirty = true;
    documentWindow.tabs.push(a, b);
    documentWindow.activeIndex = 1;
    documentWindow.windowedConflict = a;
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(((cmd: string) =>
      Promise.resolve(
        cmd === 'windowed_save' ? { ...SAVED_AS, generation: 3 } : null,
      )) as typeof invoke);
    expect(await documentWindow.windowedConflictSaveAs('/tmp/a-copy.log')).toBe(
      true,
    );
    expect(a.path).toBe('/tmp/a-copy.log');
    expect(a.windowed?.dirty).toBe(false);
    expect(a.windowed?.fingerprint).toEqual(SAVED_AS.fingerprint);
    expect(b.path).toBe('/tmp/huge.log');
    expect(b.windowed?.dirty).toBe(true);
    expect(b.windowed?.fingerprint).toBeNull();
  });

  it('save-as for a tab closed while the write ran changes no other tab', async () => {
    documentWindow.tabs.length = 0;
    const a = windowedTab(59);
    const b = windowedTab(60);
    b.windowed!.dirty = true;
    documentWindow.tabs.push(a, b);
    documentWindow.activeIndex = 1;
    documentWindow.windowedConflict = a;
    let finish: (v: typeof SAVED_AS) => void = () => {};
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'windowed_save'
        ? new Promise<typeof SAVED_AS>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(null)) as typeof invoke);
    const saving = documentWindow.windowedConflictSaveAs('/tmp/a-copy.log');
    await documentWindow.deleteTab(0);
    finish({ ...SAVED_AS, clean: true, generation: 100 });
    await saving;
    expect(b.path).toBe('/tmp/huge.log');
    expect(b.windowed?.dirty).toBe(true);
    expect(b.windowed?.fingerprint).toBeNull();
    expect(b.windowed?.totalBytes).toBe(1000);
  });

  it('keeps a save result older than a newer edit from clearing dirty', async () => {
    documentWindow.tabs.length = 0;
    const tab = windowedTab(43);
    documentWindow.tabs.push(tab);
    documentWindow.activeIndex = 0;
    documentWindow.windowedApplied(43, 1100, 11, false, 9);
    mockInvoke.mockImplementation(((cmd: string) =>
      Promise.resolve(
        cmd === 'windowed_save'
          ? { ...SAVED_AS, clean: true, generation: 8 }
          : null,
      )) as typeof invoke);
    expect(await documentWindow.saveWindowed(tab, false)).toBe('ok');
    expect(tab.windowed?.dirty).toBe(true);
    expect(tab.windowed?.fingerprint).toEqual(SAVED_AS.fingerprint);
  });
});
