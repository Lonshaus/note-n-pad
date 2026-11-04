// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  RANGE_EDIT_MAX,
  resolveByteRange,
  rangeWithinLimit,
  rangeWriteBytes,
  rangeWriteText,
  sliceEndsWithBreak,
} from './rangeEdit';
import { scanBreaks } from './windowedEdit';
import { normalizeToLf } from './text';

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

  it('is true for a final lone CR', () => {
    expect(sliceEndsWithBreak('y\r')).toBe(true);
    expect(sliceEndsWithBreak('a\rb\r')).toBe(true);
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

  it('keeps the break of a slice that ended in a lone CR when text is typed on its last line', () => {
    const trailingBreak = sliceEndsWithBreak('x\ny\r');
    expect(rangeWriteText('x\nyTyped', trailingBreak, 'LF')).toBe(
      'x\nyTyped\n',
    );
    expect(rangeWriteText('x\nyTyped', trailingBreak, 'CRLF')).toBe(
      'x\r\nyTyped\r\n',
    );
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

describe('rangeWriteBytes', () => {
  /** What the box writes for `slice` edited into `buffer`. */
  const write = (
    slice: string,
    buffer: string,
    ending: 'LF' | 'CRLF' = 'LF',
    trailing = /[\r\n]$/.test(slice),
  ) =>
    rangeWriteBytes(
      normalizeToLf(slice),
      buffer,
      scanBreaks(slice),
      trailing,
      ending,
    );

  it('writes the slice back exactly when the buffer is unchanged', () => {
    for (const slice of [
      'a\rb\nc\r\nd',
      'a\rb\nc\r\nd\r',
      '\r\r\n\n\r',
      'x',
      '',
      'a\r',
    ]) {
      for (const ending of ['LF', 'CRLF'] as const) {
        expect(write(slice, normalizeToLf(slice), ending)).toBe(slice);
      }
    }
  });

  it('keeps every other line’s own separator when one line changes', () => {
    const slice = 'a\rb\nc\r\nd\re\n';
    expect(write(slice, 'a\nbX\nc\nd\ne\n')).toBe('a\rbX\nc\r\nd\re\n');
    // The changed line’s own break is one of the lines between: file separator.
    expect(write(slice, 'a\nb\nc\nd\neY\n', 'CRLF')).toBe(
      'a\rb\nc\r\nd\reY\r\n',
    );
    expect(write(slice, 'aZ\nb\nc\nd\ne\n')).toBe('aZ\nb\nc\r\nd\re\n');
  });

  it('gives the lines between the kept ones the file’s separator', () => {
    const slice = 'a\rb\nc\r\nd\n';
    expect(write(slice, 'a\nNEW\nNEW2\nd\n')).toBe('a\rNEW\nNEW2\nd\n');
    expect(write(slice, 'a\nNEW\nNEW2\nd\n', 'CRLF')).toBe(
      'a\rNEW\r\nNEW2\r\nd\n',
    );
  });

  it('rewrites a kept CR that an empty LF line now follows (empty and non-empty middle)', () => {
    // Line `b` deleted: `a\r` would meet the kept `\n` of the empty line.
    expect(write('a\rb\n\n', 'a\n\n')).toBe('a\n\n');
    expect(write('a\rb\n\n', 'a\n\n', 'CRLF')).toBe('a\r\n\n');
    // A new empty line typed right after a kept CR line.
    expect(write('a\rb\n', 'a\n\nb\n')).toBe('a\n\nb\n');
    // A CRLF file: the new empty line’s break starts with a CR, nothing joins.
    expect(write('a\rb\n', 'a\n\nb\n', 'CRLF')).toBe('a\r\r\nb\n');
    // Middle lines that are not empty need no rewrite.
    expect(write('a\rb\n\n', 'a\nc\n\n')).toBe('a\rc\n\n');
  });

  it('takes the run of kept CRs before the junction too, for an LF file only', () => {
    expect(write('x\r\r\rb\n\n', 'x\n\n\n\n')).toBe('x\n\n\n\n');
    expect(write('x\r\r\rb\n\n', 'x\n\n\n\n', 'CRLF')).toBe('x\r\r\r\n\n');
    // A run that reaches the box's first byte carries on into the file: the
    // splice rewrites the CRs before the box when this text starts with LF.
    expect(write('\r\rb\n\nz', '\n\n\nz')).toBe('\n\n\nz');
    expect(write('\r\rb\n\n', '\n\n')).toBe('\r\r');
  });

  it('handles lines that are identical but moved, and a buffer that only grows or shrinks', () => {
    expect(write('a\rb\nc\r\n', 'c\nb\na\n')).toBe('c\nb\na\n');
    expect(write('a\rb\r', 'a\nb\nc\n')).toBe('a\rb\rc\n');
    expect(write('a\rb\nc\rd\r', 'a\nb\n')).toBe('a\rb\n');
    expect(write('a\rb\r', '')).toBe('');
  });

  it('adds the trailing break in the file separator, as before', () => {
    expect(write('x\ny\r', 'x\nyTyped')).toBe('x\nyTyped\n');
    expect(write('x\ny\r', 'x\nyTyped', 'CRLF')).toBe('x\nyTyped\r\n');
    expect(write('x\ny', 'x\nyTyped')).toBe('x\nyTyped');
  });
});
