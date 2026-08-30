// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  RANGE_EDIT_MAX,
  replacementByteLength,
  resolveByteRange,
  rangeWithinLimit,
} from './rangeEdit';

describe('replacementByteLength', () => {
  it('counts LF bytes for an LF tab', () => {
    // "ab\ncd" → 5 bytes.
    expect(replacementByteLength('ab\ncd', 'LF')).toBe(5);
  });

  it('counts the extra CR byte per line for a CRLF tab', () => {
    // The LF buffer "ab\ncd" writes back as "ab\r\ncd" → 6 bytes.
    expect(replacementByteLength('ab\ncd', 'CRLF')).toBe(6);
  });

  it('counts multi-byte UTF-8 characters by their byte length', () => {
    // "é" is 2 bytes; "日" is 3 bytes.
    expect(replacementByteLength('é日', 'LF')).toBe(5);
  });

  it('adds one byte per newline when restoring CRLF on many lines', () => {
    // Three newlines → three extra CR bytes over the LF length (6 chars + 3).
    expect(replacementByteLength('a\nb\nc\nd', 'CRLF')).toBe(10);
  });
});

describe('resolveByteRange', () => {
  it('uses the after-last-line offset as the exclusive end', () => {
    expect(resolveByteRange(100, 500, 10_000)).toEqual({
      startByte: 100,
      endByte: 500,
    });
  });

  it('falls back to the file size when the end line is past EOF', () => {
    expect(resolveByteRange(100, null, 800)).toEqual({
      startByte: 100,
      endByte: 800,
    });
  });
});

describe('rangeWithinLimit', () => {
  it('accepts a range below the limit', () => {
    expect(rangeWithinLimit(0, 100, 200)).toBe(true);
  });

  it('accepts a range exactly at the limit', () => {
    expect(rangeWithinLimit(0, 200, 200)).toBe(true);
  });

  it('rejects a range above the limit', () => {
    expect(rangeWithinLimit(0, 201, 200)).toBe(false);
  });

  it('measures the span, not the absolute offsets', () => {
    expect(rangeWithinLimit(1_000_000, 1_000_050, 100)).toBe(true);
    expect(rangeWithinLimit(0, RANGE_EDIT_MAX + 1, RANGE_EDIT_MAX)).toBe(false);
  });
});
