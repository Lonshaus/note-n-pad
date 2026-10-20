// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  RANGE_EDIT_MAX,
  resolveByteRange,
  rangeWithinLimit,
  rangeWriteText,
  sliceEndsWithBreak,
} from './rangeEdit';

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

describe('sliceEndsWithBreak', () => {
  it('is true for a final LF or CRLF', () => {
    expect(sliceEndsWithBreak('a\n')).toBe(true);
    expect(sliceEndsWithBreak('a\r\n')).toBe(true);
  });

  it('is false without a final break', () => {
    expect(sliceEndsWithBreak('a\nb')).toBe(false);
    expect(sliceEndsWithBreak('')).toBe(false);
  });
});

describe('rangeWriteText', () => {
  it('adds one break to a buffer that lost its final one', () => {
    expect(rangeWriteText('line2\nline3\nline4\nZZ', true, 'LF')).toBe(
      'line2\nline3\nline4\nZZ\n',
    );
  });

  it('leaves a buffer that already ends with a break alone', () => {
    expect(rangeWriteText('line2\nline3\nline4ZZ\n', true, 'LF')).toBe(
      'line2\nline3\nline4ZZ\n',
    );
    expect(rangeWriteText('a\n\n', true, 'LF')).toBe('a\n\n');
  });

  it('writes nothing for an empty buffer', () => {
    expect(rangeWriteText('', true, 'LF')).toBe('');
    expect(rangeWriteText('', true, 'CRLF')).toBe('');
  });

  it('adds nothing when the slice had no final break', () => {
    expect(rangeWriteText('a\nZZ', false, 'LF')).toBe('a\nZZ');
  });

  it('writes the file line ending, including the added break', () => {
    expect(rangeWriteText('a\nZZ', true, 'CRLF')).toBe('a\r\nZZ\r\n');
    expect(rangeWriteText('a\nb\n', true, 'CRLF')).toBe('a\r\nb\r\n');
    expect(rangeWriteText('a\nZZ', false, 'CRLF')).toBe('a\r\nZZ');
  });
});
