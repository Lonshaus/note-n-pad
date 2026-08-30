// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect } from 'vitest';
import { Text } from '@codemirror/state';
import {
  detectLineEnding,
  normalizeToLf,
  applyLineEnding,
  stripBom,
  addBom,
  textFromString,
  textEq,
  type LineEnding,
} from './text';

describe('detectLineEnding', () => {
  const cases: [string, string, LineEnding][] = [
    ['empty string', '', 'LF'],
    ['no line breaks', 'single line', 'LF'],
    ['pure LF', 'a\nb\nc', 'LF'],
    ['pure CRLF', 'a\r\nb\r\nc', 'CRLF'],
    ['lone CR only', 'a\rb\rc', 'LF'],
    ['CRLF majority', 'a\r\nb\r\nc\nd', 'CRLF'],
    ['LF majority', 'a\r\nb\nc\nd', 'LF'],
    ['tie favours LF', 'a\r\nb\nc', 'LF'],
    ['consecutive LFs', 'a\n\n\nb', 'LF'],
    ['consecutive CRLFs', 'a\r\n\r\n\r\nb', 'CRLF'],
    ['trailing CRLF', 'a\r\n', 'CRLF'],
    ['trailing LF', 'a\n', 'LF'],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(detectLineEnding(input)).toBe(expected);
  });
});

describe('normalizeToLf', () => {
  const cases: [string, string, string][] = [
    ['empty string', '', ''],
    ['already LF', 'a\nb', 'a\nb'],
    ['CRLF to LF', 'a\r\nb', 'a\nb'],
    ['lone CR to LF', 'a\rb', 'a\nb'],
    ['mixed endings', 'a\r\nb\nc\rd', 'a\nb\nc\nd'],
    ['consecutive CRLF', 'a\r\n\r\nb', 'a\n\nb'],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(normalizeToLf(input)).toBe(expected);
  });
});

describe('applyLineEnding', () => {
  const cases: [string, string, LineEnding, string][] = [
    ['LF stays LF', 'a\nb', 'LF', 'a\nb'],
    ['LF to CRLF', 'a\nb', 'CRLF', 'a\r\nb'],
    ['re-normalizes then applies CRLF', 'a\r\nb\nc', 'CRLF', 'a\r\nb\r\nc'],
    ['re-normalizes then applies LF', 'a\r\nb\rc', 'LF', 'a\nb\nc'],
    ['empty string', '', 'CRLF', ''],
    ['no line breaks', 'abc', 'CRLF', 'abc'],
    ['consecutive to CRLF', 'a\n\nb', 'CRLF', 'a\r\n\r\nb'],
  ];
  it.each(cases)('%s', (_name, input, ending, expected) => {
    expect(applyLineEnding(input, ending)).toBe(expected);
  });

  it('round-trips CRLF through normalize and apply', () => {
    const original = 'x\r\ny\r\nz';
    const lf = normalizeToLf(original);
    expect(applyLineEnding(lf, 'CRLF')).toBe(original);
  });
});

describe('stripBom', () => {
  const cases: [string, string, { text: string; hadBom: boolean }][] = [
    ['no bom', 'abc', { text: 'abc', hadBom: false }],
    ['empty string', '', { text: '', hadBom: false }],
    ['leading bom', '﻿abc', { text: 'abc', hadBom: true }],
    ['bom-only file', '﻿', { text: '', hadBom: true }],
    ['bom mid-text is not stripped', 'a﻿b', { text: 'a﻿b', hadBom: false }],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(stripBom(input)).toEqual(expected);
  });
});

describe('addBom', () => {
  const cases: [string, string, string][] = [
    ['adds to plain text', 'abc', '﻿abc'],
    ['adds to empty string', '', '﻿'],
    ['idempotent when already present', '﻿abc', '﻿abc'],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(addBom(input)).toBe(expected);
  });

  it('round-trips with stripBom', () => {
    const withBom = addBom('hello\r\nworld');
    const { text, hadBom } = stripBom(withBom);
    expect(hadBom).toBe(true);
    expect(text).toBe('hello\r\nworld');
  });
});

describe('textFromString', () => {
  it('round-trips content through toString', () => {
    for (const s of ['', 'a', 'a\nb\nc', 'line\n', '\n\n', 'no trailing']) {
      expect(textFromString(s).toString()).toBe(s);
    }
  });

  it('reuses the Text.empty singleton for an empty string', () => {
    expect(textFromString('')).toBe(Text.empty);
  });

  it('reports length as the character count, not the line count', () => {
    expect(textFromString('a\nbc').length).toBe(4);
  });
});

describe('textEq', () => {
  it('is true for the same reference (O(1) clean-tab path)', () => {
    const doc = textFromString('shared\nbuffer');
    expect(textEq(doc, doc)).toBe(true);
  });

  it('is true for distinct ropes with identical content', () => {
    expect(textEq(textFromString('a\nb'), textFromString('a\nb'))).toBe(true);
  });

  it('is false when lengths differ', () => {
    expect(textEq(textFromString('abc'), textFromString('ab'))).toBe(false);
  });

  it('is false for same-length different content', () => {
    expect(textEq(textFromString('abc'), textFromString('abd'))).toBe(false);
  });
});
