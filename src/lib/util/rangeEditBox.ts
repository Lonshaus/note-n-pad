// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** The range edit box: a slice of a large file edited in a modal box over the
 *  viewer tab it came from. Pure state and transitions, kept free of Svelte and
 *  Tauri so they are unit-testable in isolation. Nothing here is persisted. */
import type { Text } from '@codemirror/state';
import type { Fingerprint } from '../state/documentWindow.svelte';
import { rangeWriteBytes, sliceEndsWithBreak } from './rangeEdit';
import {
  detectLineEnding,
  normalizeToLf,
  textEq,
  textFromString,
  type LineEnding,
} from './text';
import { scanBreaks, type LineBreak } from './windowedEdit';
/** An open edit box. `fingerprint` is the source's identity when the slice was
 *  read, the baseline the write-back's conflict check compares against. */
export interface RangeBox {
  /** Identifies this opening of a box. A write-back only acts on the box that
   *  is open when it finishes if that box carries the id it was sent from. */
  session: number;
  /** The large-file tab the box belongs to. */
  tabId: string;
  sourcePath: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  fingerprint: Fingerprint | null;
  /** Whether the slice ended with a line break; see `rangeWriteText`. */
  trailingBreak: boolean;
  lineEnding: LineEnding;
  /** The slice as read, LF-normalized: what the buffer is diffed against. */
  saved: Text;
  /** The separator of each line break of the slice as read, in order. */
  breaks: LineBreak[];
  /** The buffer being edited. */
  content: Text;
  /** The last write-back found the source changed; the conflict dialog is up. */
  conflict: boolean;
  /** The source file was found deleted or moved away while the box held
   *  changes. The box then offers no write-back into it. */
  missing: boolean;
}
/** What opening a box needs: the span and lines it was selected by, the source
 *  fingerprint, and the slice's text exactly as read. */
export interface RangeBoxInit {
  tabId: string;
  sourcePath: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  fingerprint: Fingerprint | null;
  text: string;
}

let lastSession = 0;

export function openRangeBox(init: RangeBoxInit): RangeBox {
  const content = textFromString(normalizeToLf(init.text));
  lastSession += 1;
  return {
    session: lastSession,
    tabId: init.tabId,
    sourcePath: init.sourcePath,
    startByte: init.startByte,
    endByte: init.endByte,
    startLine: init.startLine,
    endLine: init.endLine,
    fingerprint: init.fingerprint,
    trailingBreak: sliceEndsWithBreak(init.text),
    lineEnding: detectLineEnding(init.text),
    saved: content,
    breaks: scanBreaks(init.text),
    content,
    conflict: false,
    missing: false,
  };
}
/** What can happen to an open box. */
export type RangeBoxEvent =
  | { kind: 'edit'; content: Text }
  | { kind: 'saved' }
  | { kind: 'mismatch' }
  | { kind: 'conflict-dismissed' }
  | { kind: 'cancel' };
/** The box after `event`; null once it is closed. A box that is not open
 *  stays closed. */
export function nextRangeBox(
  box: RangeBox | null,
  event: RangeBoxEvent,
): RangeBox | null {
  if (box === null) {
    return null;
  }
  switch (event.kind) {
    case 'edit':
      return { ...box, content: event.content };
    case 'mismatch':
      return { ...box, conflict: true };
    case 'conflict-dismissed':
      return { ...box, conflict: false };
    case 'saved':
    case 'cancel':
      return null;
  }
}
/** Whether the buffer differs from the slice as read. */
export function isRangeBoxDirty(box: RangeBox): boolean {
  return !textEq(box.content, box.saved);
}
/** The text the box writes back into the source. */
export function rangeBoxWriteText(box: RangeBox): string {
  return rangeWriteBytes(
    box.saved.toString(),
    box.content.toString(),
    box.breaks,
    box.trailingBreak,
    box.lineEnding,
  );
}
/** Where the source's write of the box's text landed, as the core reports it. */
export interface RangeWriteOutcome {
  fingerprint: Fingerprint;
  writtenStart: number;
  writtenEnd: number;
}
/** What to do once a write-back succeeded: `sent` is the buffer the write was
 *  made from, `current` the buffer now. */
export function nextWriteBack(sent: Text, current: Text): 'done' | 'rewrite' {
  return textEq(sent, current) ? 'done' : 'rewrite';
}
/** The box after its text `written` replaced the span: the span, the
 *  fingerprint and the slice as read are now what was just written, so the
 *  next write-back diffs against it. `trailingBreak` stays as it was: it tells
 *  whether the span ends at a line break of the file, not what was written. */
export function rebaseRangeBox(
  box: RangeBox,
  written: string,
  outcome: RangeWriteOutcome,
): RangeBox {
  return {
    ...box,
    fingerprint: outcome.fingerprint,
    startByte: outcome.writtenStart,
    endByte: outcome.writtenEnd,
    saved: textFromString(normalizeToLf(written)),
    breaks: scanBreaks(written),
  };
}
