// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { Text } from '@codemirror/state';

export type LineEnding = 'LF' | 'CRLF';

/** Build a CodeMirror `Text` (rope) from a plain string. This is the single
 *  string→Text conversion point (file load, snapshot restore, re-decode), so the
 *  whole-string cost is paid once at a flush boundary, not per keystroke. An empty
 *  string yields the shared `Text.empty` singleton. */
export function textFromString(text: string): Text {
  return text.length === 0 ? Text.empty : Text.of(text.split('\n'));
}

/** Whether two ropes hold identical content, decided as cheaply as possible.
 *  Used by the per-keystroke dirty check, so the fast paths matter: reference
 *  identity (the clean case, where a save shares one rope between content and its
 *  saved baseline) is O(1), a length mismatch is O(1), and only the rare
 *  same-length-different-content case walks the rope via `Text.eq`. */
export function textEq(a: Text, b: Text): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.eq(b);
}

/** Supported encoding labels, kept in sync with the Rust `supported()` list. */
export const ENCODINGS = [
  'UTF-8',
  'UTF-16LE',
  'UTF-16BE',
  'Big5',
  'GB18030',
  'GBK',
  'Shift_JIS',
  'EUC-JP',
  'ISO-2022-JP',
  'EUC-KR',
  'Windows-1252',
  'ISO-8859-15',
  'Windows-1250',
  'Windows-1251',
  'KOI8-R',
  'Windows-1253',
  'Windows-1254',
  'Windows-1255',
  'Windows-1256',
  'Windows-874',
  'Windows-1258',
  'MacRoman',
] as const;

/** Unicode BOM (U+FEFF) as it appears at the start of a decoded UTF-8 string. */
const BOM = '﻿';

/**
 * Strip a leading BOM. Returns the BOM-free text and whether one was present,
 * so a save can re-add it only for files that originally carried one.
 */
export function stripBom(text: string): { text: string; hadBom: boolean } {
  if (text.charCodeAt(0) === 0xfeff) {
    return { text: text.slice(1), hadBom: true };
  }
  return { text, hadBom: false };
}

/** Prepend a BOM unless the text already starts with one. */
export function addBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) {
    return text;
  }
  return BOM + text;
}

/**
 * Detect the dominant line ending. CRLF wins only with a strict majority over
 * standalone LFs; everything else (including no line breaks and lone-CR files)
 * reports LF, matching the LF-normalized buffer the editor holds.
 */
export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  // Standalone LFs: an LF that is not the tail of a CRLF pair.
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? 'CRLF' : 'LF';
}

/** Convert every CRLF and lone CR to LF, the editor's internal representation. */
export function normalizeToLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Re-apply a line ending to LF-normalized text. Input is normalized first so
 * this is safe on any buffer, not only an already-LF one.
 */
export function applyLineEnding(text: string, ending: LineEnding): string {
  const lf = normalizeToLf(text);
  return ending === 'CRLF' ? lf.replace(/\n/g, '\r\n') : lf;
}
