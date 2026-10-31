// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The lock a paste puts on a tab while it waits for the clipboard and while a
// conversion to the large-file mode runs. It is the tab's, not the editor's:
// the editor shows one tab at a time, and a switch away and back finds the
// lock where it was. While the paste only waits the editor stays editable (the
// system pastes only into an editable selection), and the lock is a
// transaction filter that lets no document change through but the paste's own.

import { Annotation, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
/** 'wait': the paste waits for the clipboard; 'full': a dialog or a
 *  conversion has the tab, nothing is typed. */
export interface PasteLock {
  id: number;
  phase: 'wait' | 'full';
}
/** Marks the transaction of the paste that holds the lock with this id. */
export const pasteLockOwner = Annotation.define<number>();
/** The extension for the editor's editable compartment: whether it takes input
 *  by itself, and the lock of its tab if there is one. */
export function editableWith(
  editable: boolean,
  lock: PasteLock | undefined,
): Extension {
  if (lock === undefined) {
    return EditorView.editable.of(editable);
  }
  const id = lock.id;
  return [
    EditorView.editable.of(lock.phase === 'wait' ? editable : false),
    EditorState.readOnly.of(true),
    EditorState.transactionFilter.of((tr) =>
      tr.docChanged && tr.annotation(pasteLockOwner) !== id ? [] : tr,
    ),
  ];
}
/** The locks of a window, by tab (a sticky note has one key of its own). */
export class PasteLocks {
  private locks = new Map<string, PasteLock>();
  private next = 0;

  get(key: string): PasteLock | undefined {
    return this.locks.get(key);
  }
  has(key: string): boolean {
    return this.locks.has(key);
  }
  /** Whether any tab is locked. */
  any(): boolean {
    return this.locks.size > 0;
  }
  /** A new lock on a tab that has none. */
  begin(key: string, phase: PasteLock['phase']): PasteLock {
    const lock = { id: (this.next += 1), phase };
    this.locks.set(key, lock);
    return lock;
  }
  /** The lock `id` turns to a full one; false when it is no longer the tab's. */
  upgrade(key: string, id: number): PasteLock | null {
    const lock = this.locks.get(key);
    if (lock === undefined || lock.id !== id) {
      return null;
    }
    const full = { id, phase: 'full' as const };
    this.locks.set(key, full);
    return full;
  }
  /** Takes the lock `id` off; false when it is no longer the tab's. */
  end(key: string, id: number): boolean {
    if (this.locks.get(key)?.id !== id) {
      return false;
    }
    this.locks.delete(key);
    return true;
  }
  /** Forgets the lock of a tab that was closed. */
  drop(key: string): void {
    this.locks.delete(key);
  }
}
/** The locks of this window. */
export const pasteLocks = new PasteLocks();
