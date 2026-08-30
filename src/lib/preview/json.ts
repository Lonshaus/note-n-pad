// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** One node of the JSON tree the preview walks. Children are computed lazily by
 *  {@link childrenOf} rather than materialized here: a ten-million-character
 *  document is a few hundred thousand values, and building a node object for
 *  every one of them up front is the cost the preview exists to avoid. */
export interface JsonNode {
  /** Object key, array index as a string, or null for the document root. */
  key: string | null;
  value: unknown;
}

/** What kind of row the preview should draw for a value. */
export type JsonValueKind =
  'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/** Where a parse failed, when the engine was willing to say. */
export interface JsonErrorPosition {
  /** 1-based. */
  line: number;
  /** 1-based, counted in UTF-16 code units like the rest of the editor. */
  column: number;
}

/** A failed parse: always a message, a position only when one could be had. */
export interface JsonParseError {
  message: string;
  position: JsonErrorPosition | null;
}

export type JsonParseResult =
  { ok: true; root: JsonNode } | { ok: false; error: JsonParseError };

export function kindOf(value: unknown): JsonValueKind {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'object':
      return 'object';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

/** Immediate children of a container node, in document order. Returns an empty
 *  list for scalars, so callers can ask unconditionally. */
export function childrenOf(node: JsonNode): JsonNode[] {
  const value = node.value;
  if (Array.isArray(value)) {
    return value.map((v, i) => ({ key: String(i), value: v }));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
      key: k,
      value: v,
    }));
  }
  return [];
}

/** How many children a node has, without building any of them. */
export function childCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length;
  }
  return 0;
}

/** Turn a character offset into a 1-based line and column. An offset past the
 *  end of the text clamps to the last position rather than reporting a line
 *  that does not exist. */
export function offsetToPosition(
  text: string,
  offset: number,
): JsonErrorPosition {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

/** Pull a character offset out of a JSON.parse message, if the engine put one
 *  there. V8 writes "at position 42" (newer versions add "(line 3 column 5)");
 *  JavaScriptCore, which is what the app actually runs on, writes none of it —
 *  so a null result is the normal case on macOS and Linux, not a failure. */
export function errorOffsetFrom(message: string): number | null {
  const match = /at position (\d+)/.exec(message);
  if (match === null) {
    return null;
  }
  const raw = match[1];
  if (raw === undefined) {
    return null;
  }
  const offset = Number.parseInt(raw, 10);
  return Number.isFinite(offset) ? offset : null;
}

/** Parse `text` for the preview. Never throws: a syntax error comes back as
 *  data so the view can show the message instead of an empty pane. */
export function parseJsonForPreview(text: string): JsonParseResult {
  try {
    return { ok: true, root: { key: null, value: JSON.parse(text) } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const offset = errorOffsetFrom(message);
    return {
      ok: false,
      error: {
        message,
        position: offset === null ? null : offsetToPosition(text, offset),
      },
    };
  }
}
