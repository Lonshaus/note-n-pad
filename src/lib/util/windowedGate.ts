// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pure gate for a whole-file operation on a windowed session (replace all, or
 *  its undo or redo). The operation runs in the Rust core and can outlive the
 *  editor that started it, so the gate belongs to the session: an editor
 *  mounted while it is pending asks the gate whether it may edit and when it
 *  may read its first window. Free of Svelte and Tauri so it unit-tests alone. */
export interface OpGate {
  /** Whether an operation is pending. */
  pending(): boolean;
  /** The editor must be read-only: input during the operation is dropped,
   *  never queued. */
  readOnly(): boolean;
  /** Whether an edit may be sent to the core now. */
  canApply(): boolean;
  /** Track `op`; it is pending until it settles, whether it resolves or not. */
  begin(op: Promise<unknown>): void;
  /** Run `read` (the first window read) once no operation is pending, so it
   *  never shows pre-operation content. */
  whenIdle<T>(read: () => Promise<T>): Promise<T>;
}
/** A gate, optionally created with an operation already pending. */
export function createOpGate(initial: Promise<unknown> | null = null): OpGate {
  let current: Promise<void> | null = null;
  const gate: OpGate = {
    pending: () => current !== null,
    readOnly: () => current !== null,
    canApply: () => current === null,
    begin(op) {
      // Clears itself in the same turn the operation settles, so anything that
      // continues after awaiting `op` already finds the gate open.
      const done = (): void => {
        if (current === mine) {
          current = null;
        }
      };
      const mine: Promise<void> = op.then(done, done);
      current = mine;
    },
    async whenIdle(read) {
      // Another operation may begin while this one is awaited.
      while (current !== null) {
        await current;
      }
      return read();
    },
  };
  if (initial !== null) {
    gate.begin(initial);
  }
  return gate;
}
