// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Message protocol for the background syntax-highlight worker.
 *
 *  This module is intentionally free of any editor-engine dependency (no
 *  CodeMirror, no DOM). It defines only the wire types and the pure version
 *  coordination logic, so a future non-CodeMirror editor surface can reuse the
 *  exact same worker and protocol without change. */

/** A single text replacement, expressed in coordinates of the document as it
 *  stood *before* the batch is applied. Ranges within one batch are sorted by
 *  `from` and must not overlap. */
export interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** One highlighted range. `cls` is the space-separated CSS class string
 *  produced by `@lezer/highlight`'s `classHighlighter` (e.g. `tok-keyword`). */
export interface SpanRange {
  from: number;
  to: number;
  cls: string;
}

/** Load a whole document and (re)start highlighting from scratch. */
export interface InitMessage {
  type: 'init';
  docText: string;
  language: string;
  version: number;
}

/** Apply an incremental edit batch. The main thread bumps `version` on every
 *  batch so the worker can discard output for superseded document states. */
export interface EditsMessage {
  type: 'edits';
  changes: Edit[];
  version: number;
}

/** The currently visible byte range, which the worker highlights first. */
export interface ViewportMessage {
  type: 'viewport';
  from: number;
  to: number;
}

/** Abort in-flight parsing without discarding the document. */
export interface CancelMessage {
  type: 'cancel';
}

/** Tear the worker session down for good. */
export interface DisposeMessage {
  type: 'dispose';
}

export type InboundMessage =
  InitMessage | EditsMessage | ViewportMessage | CancelMessage | DisposeMessage;

/** Highlighted ranges for `[from, to)` of the document at `version`. */
export interface SpansMessage {
  type: 'spans';
  version: number;
  from: number;
  to: number;
  ranges: SpanRange[];
}

/** Coarse parse progress, in bytes, for the document at `version`. */
export interface ProgressMessage {
  type: 'progress';
  version: number;
  parsedBytes: number;
  total: number;
}

/** The document at `version` has been fully parsed. */
export interface DoneMessage {
  type: 'done';
  version: number;
}

/** A non-recoverable failure (e.g. unknown language). */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type OutboundMessage =
  SpansMessage | ProgressMessage | DoneMessage | ErrorMessage;

/** Next document version. The main thread owns the counter and increments it
 *  once per edit batch. */
export function nextVersion(version: number): number {
  return version + 1;
}

/** Whether output produced for `produced` still describes the live document.
 *  The worker calls this before emitting so stale results from a superseded
 *  version are dropped instead of racing the newer parse. */
export function isCurrent(produced: number, current: number): boolean {
  return produced === current;
}
