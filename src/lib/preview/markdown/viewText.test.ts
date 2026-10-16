// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { GFM, parser as baseParser } from '@lezer/markdown';
import { scanLines } from './scan';
import { markdownViewText } from './viewText';

const parser = baseParser.configure(GFM);

function viewText(src: string): string {
  const doc = Text.of(src.split('\n'));
  const { index, refs } = scanLines(doc.iterLines());
  return markdownViewText(doc, index, refs, (s) => parser.parse(s));
}

describe('markdownViewText', () => {
  it('drops the marks and separates blocks with a blank line', () => {
    expect(viewText('# Title\n\nSome **bold** and `code`.\n')).toBe(
      'Title\n\nSome bold and code.',
    );
  });

  it('keeps list markers and renders tables as tab-separated rows', () => {
    const text = viewText(
      '- one\n- two\n\n1. first\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    );
    expect(text).toBe('• one\n• two\n\n1. first\n\na\tb\n1\t2');
  });

  it('shows a link as its label and an image as its alt text', () => {
    expect(
      viewText('See [the docs](https://example.com) ![logo](a.png)\n'),
    ).toBe('See the docs logo');
  });

  it('covers every block of a document many screens long', () => {
    const blocks = Array.from(
      { length: 500 },
      (_, i) => `## Heading ${i}\n\nParagraph ${i}.\n`,
    );
    const text = viewText(blocks.join('\n'));
    const parts = text.split('\n\n');
    expect(parts).toHaveLength(1000);
    expect(parts[0]).toBe('Heading 0');
    expect(parts[999]).toBe('Paragraph 499.');
  });
});
