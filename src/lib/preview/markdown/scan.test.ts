// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  blockAtOffset,
  blockCount,
  blockEnd,
  blockStart,
  createSlugger,
  headingText,
  MAX_BLOCK,
  normalizeLabel,
  scanBlocks,
  scanLines,
  slugify,
} from './scan';

/** The source of each indexed block, which is what the parser will be handed. */
function blocks(text: string): string[] {
  const { index } = scanBlocks(text);
  const out: string[] = [];
  for (let i = 0; i < blockCount(index); i += 1) {
    out.push(text.slice(blockStart(index, i), blockEnd(index, i)));
  }
  return out;
}

describe('scanBlocks', () => {
  it('splits paragraphs on blank lines', () => {
    expect(blocks('one\n\ntwo\n\nthree\n')).toEqual(['one', 'two', 'three']);
  });

  it('is empty for empty or blank-only text', () => {
    expect(blocks('')).toEqual([]);
    expect(blocks('\n\n  \n')).toEqual([]);
  });

  it('keeps a heading and the paragraph after it apart', () => {
    expect(blocks('# Title\n\nbody text\n')).toEqual(['# Title', 'body text']);
  });

  it('keeps a fenced block whole even when it contains blank lines', () => {
    // Splitting here would leave two halves that each parse as loose text with
    // a stray fence — the failure this exception exists to prevent.
    const src = '```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter\n';
    expect(blocks(src)).toEqual([
      '```js\nconst a = 1;\n\nconst b = 2;\n```',
      'after',
    ]);
  });

  it('handles a tilde fence and a fence with a language tag', () => {
    expect(blocks('~~~\nraw\n\nraw2\n~~~\n')).toEqual([
      '~~~\nraw\n\nraw2\n~~~',
    ]);
  });

  it('keeps a loose list together across blank lines', () => {
    const src = '- one\n\n- two\n\n- three\n\nparagraph\n';
    expect(blocks(src)).toEqual(['- one\n\n- two\n\n- three', 'paragraph']);
  });

  it('keeps an ordered loose list together', () => {
    expect(blocks('1. a\n\n2. b\n\ntext\n')).toEqual(['1. a\n\n2. b', 'text']);
  });

  it('keeps an indented continuation with its block', () => {
    const src = '- item\n\n    continued here\n\nnext para\n';
    expect(blocks(src)).toEqual(['- item\n\n    continued here', 'next para']);
  });

  it('does not glue a following paragraph onto a list', () => {
    expect(blocks('- one\n- two\n\nplain paragraph\n')).toEqual([
      '- one\n- two',
      'plain paragraph',
    ]);
  });

  it('starts a fence as its own block even without a blank line before it', () => {
    expect(blocks('text\n```\ncode\n```\n')).toEqual([
      'text',
      '```\ncode\n```',
    ]);
  });

  it('closes an unterminated fence at the end of the document', () => {
    expect(blocks('```\nnever closed\n')).toEqual(['```\nnever closed']);
  });

  it('keeps a table together', () => {
    const src = '| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n';
    expect(blocks(src)).toEqual(['| a | b |\n|---|---|\n| 1 | 2 |', 'after']);
  });

  it('handles a document with no trailing newline', () => {
    expect(blocks('one\n\ntwo')).toEqual(['one', 'two']);
  });

  it('records offsets that address the original text', () => {
    const src = 'alpha\n\nbeta\n';
    const { index } = scanBlocks(src);
    expect(blockCount(index)).toBe(2);
    expect(src.slice(blockStart(index, 1), blockEnd(index, 1))).toBe('beta');
  });

  it('stores two integers per block and nothing else', () => {
    const { index } = scanBlocks('a\n\nb\n\nc\n');
    expect(index).toBeInstanceOf(Int32Array);
    expect(index.length).toBe(6);
  });
});

describe('scanning a document that is never one string', () => {
  // The app feeds the scanner one line at a time off the document rope. If this
  // path disagreed with the string path the preview would address the wrong
  // offsets, so the two are held to the same result.
  const src =
    '# Title\n\npara one\n\n```js\ncode\n\nmore\n```\n\n- a\n\n- b\n\nlast\n';

  it('over lines gives the same index as over the whole string', () => {
    expect(Array.from(scanLines(src.split('\n')).index)).toEqual(
      Array.from(scanBlocks(src).index),
    );
  });
});

describe('a block is never large enough to be its own freeze', () => {
  it('splits a document that has no blank lines at all', () => {
    // A log file renamed .md: one paragraph of a million characters, which
    // would be a single parse if nothing bounded it.
    const src = `${'lorem ipsum dolor sit\n'.repeat(50_000)}`;
    const { index } = scanBlocks(src);
    expect(blockCount(index)).toBeGreaterThan(1);
    for (let i = 0; i < blockCount(index); i += 1) {
      expect(blockEnd(index, i) - blockStart(index, i)).toBeLessThanOrEqual(
        MAX_BLOCK + 64,
      );
    }
  });

  it('leaves a large fenced block whole', () => {
    // Fenced text is one node to the parser however long it is, so splitting it
    // would break the code for nothing.
    const body = 'const x = 1;\n'.repeat(20_000);
    const { index } = scanBlocks(`\`\`\`js\n${body}\`\`\`\n`);
    expect(blockCount(index)).toBe(1);
    expect(blockEnd(index, 0) - blockStart(index, 0)).toBeGreaterThan(
      MAX_BLOCK,
    );
  });
});

describe('blockAtOffset', () => {
  const src = 'alpha\n\nbeta\n\ngamma\n';
  const { index } = scanBlocks(src);

  it('finds the block containing an offset', () => {
    expect(blockAtOffset(index, 0)).toBe(0);
    expect(blockAtOffset(index, 8)).toBe(1);
    expect(blockAtOffset(index, 14)).toBe(2);
  });

  it('clamps past the end to the last block', () => {
    expect(blockAtOffset(index, 9999)).toBe(2);
  });
});

describe('reference definitions', () => {
  it('collects a definition with and without a title', () => {
    const { refs } = scanBlocks('[a]: ./cat.png\n\n[b]: ./dog.png "Dog"\n');
    expect(refs.get('a')).toBe('./cat.png');
    expect(refs.get('b')).toBe('./dog.png');
  });

  it('matches labels case-insensitively with whitespace collapsed', () => {
    const { refs } = scanBlocks('[My  Label]: ./x.png\n');
    expect(refs.get(normalizeLabel('my label'))).toBe('./x.png');
    expect(refs.get('my label')).toBe('./x.png');
  });

  it('does not collect a definition inside a fenced code block', () => {
    const { refs } = scanBlocks('```\n[a]: ./cat.png\n```\n');
    expect(refs.size).toBe(0);
  });

  it('stops collecting past the cap', () => {
    const src = Array.from(
      { length: 5000 },
      (_, i) => `[label${i}]: ./x${i}.png\n`,
    ).join('\n');
    const { refs } = scanBlocks(src);
    expect(refs.size).toBeLessThan(5000);
  });

  it('collects consecutive definitions with no blank line between them', () => {
    const { refs } = scanBlocks('[a]: /url-a\n[b]: /url-b\n[c]: /url-c\n');
    expect(refs.get('a')).toBe('/url-a');
    expect(refs.get('b')).toBe('/url-b');
    expect(refs.get('c')).toBe('/url-c');
  });

  it('does not feed one definition to the incomplete one above it', () => {
    // `[a]:` has no destination and CommonMark drops it. Taking the next line
    // as its destination would lose `b` as well as give `a` a junk value.
    const { refs } = scanBlocks('[a]:\n[b]: /url-b\n');
    expect(refs.has('a')).toBe(false);
    expect(refs.get('b')).toBe('/url-b');
  });

  it('recovers a label-only line following an incomplete one', () => {
    const { refs } = scanBlocks('[a]:\n[b]:\n/url-b\n');
    expect(refs.has('a')).toBe(false);
    expect(refs.get('b')).toBe('/url-b');
  });

  it('collects the multi-line form, destination on the next line', () => {
    const { refs } = scanBlocks('[a]:\n  /url-a\n');
    expect(refs.get('a')).toBe('/url-a');
  });

  it('collects a run mixing single-line and multi-line definitions', () => {
    const { refs } = scanBlocks('[a]: /url-a\n[b]:\n/url-b\n[c]: /url-c\n');
    expect(refs.get('a')).toBe('/url-a');
    expect(refs.get('b')).toBe('/url-b');
    expect(refs.get('c')).toBe('/url-c');
  });

  it('ends the definition run at the first paragraph line in the block', () => {
    const { refs } = scanBlocks('[a]: /url-a\nsome more text\n[b]: /url-b\n');
    expect(refs.get('a')).toBe('/url-a');
    expect(refs.has('b')).toBe(false);
  });

  it('does not treat a definition-looking line mid-paragraph as one', () => {
    const { refs } = scanBlocks('some text\n[a]: /url-a\n');
    expect(refs.size).toBe(0);
  });

  it('does not collect definition-looking lines inside a fence, even consecutive ones', () => {
    const { refs } = scanBlocks('```\n[a]: /url-a\n[b]: /url-b\n```\n');
    expect(refs.size).toBe(0);
  });

  it('keeps first-wins for a duplicate label in the consecutive form', () => {
    const { refs } = scanBlocks('[a]: /url-a\n[a]: /url-b\n');
    expect(refs.get('a')).toBe('/url-a');
  });

  it('does not crash or add a ref for a bare label at end of document', () => {
    const { refs } = scanBlocks('[a]:\n');
    expect(refs.size).toBe(0);
  });

  it('does not resume the definition run after a blank line and an indented continuation', () => {
    const { refs } = scanBlocks('[a]: /url-a\n\n    continued\n[b]: /url-b\n');
    expect(refs.get('a')).toBe('/url-a');
    expect(refs.has('b')).toBe(false);
  });
});

describe('headingText', () => {
  it('reads every ATX level', () => {
    for (let level = 1; level <= 6; level += 1) {
      expect(headingText(`${'#'.repeat(level)} Title`)).toBe('Title');
    }
  });

  it('rejects seven hashes, which is a paragraph', () => {
    expect(headingText('####### Title')).toBeNull();
  });

  it('requires the space after the hashes', () => {
    expect(headingText('#Title')).toBeNull();
  });

  it('allows up to three leading spaces and no more', () => {
    expect(headingText('   # Title')).toBe('Title');
    expect(headingText('    # Title')).toBeNull();
  });

  it('drops the closing hash sequence', () => {
    expect(headingText('## Title ##')).toBe('Title');
    expect(headingText('## Title #')).toBe('Title');
  });

  it('keeps hashes that are part of the text', () => {
    expect(headingText('## C# notes')).toBe('C# notes');
  });

  it('returns empty text for a bare hash rather than null', () => {
    expect(headingText('#')).toBe('');
  });

  it('is not fooled by a line that only looks like one', () => {
    expect(headingText('a # b')).toBeNull();
    expect(headingText('')).toBeNull();
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Getting Started')).toBe('getting-started');
  });

  it('collapses whitespace runs into one hyphen', () => {
    expect(slugify('A   B\tC')).toBe('a-b-c');
  });

  it('drops punctuation but keeps hyphens and underscores', () => {
    expect(slugify('What is it, really?')).toBe('what-is-it-really');
    expect(slugify('well-known_thing')).toBe('well-known_thing');
  });

  it('strips inline emphasis and code markers', () => {
    expect(slugify('The **bold** and `code` bits')).toBe(
      'the-bold-and-code-bits',
    );
  });

  it('keeps the text of an inline link, not its URL', () => {
    expect(slugify('See [the docs](https://example.com)')).toBe('see-the-docs');
  });

  it('keeps CJK text instead of slugging it away', () => {
    expect(slugify('安裝步驟')).toBe('安裝步驟');
    expect(slugify('安裝 步驟')).toBe('安裝-步驟');
  });

  it('is empty for a heading made only of punctuation', () => {
    expect(slugify('!!! ???')).toBe('');
  });
});

describe('createSlugger', () => {
  it('suffixes repeats the way GitHub does', () => {
    const slug = createSlugger();
    expect(slug('Notes')).toBe('notes');
    expect(slug('Notes')).toBe('notes-1');
    expect(slug('Notes')).toBe('notes-2');
  });

  it('counts per slug, not globally', () => {
    const slug = createSlugger();
    expect(slug('A')).toBe('a');
    expect(slug('B')).toBe('b');
    expect(slug('A')).toBe('a-1');
  });

  it('treats headings that differ only in case or punctuation as repeats', () => {
    const slug = createSlugger();
    expect(slug('Set up')).toBe('set-up');
    expect(slug('SET UP!')).toBe('set-up-1');
  });

  it('starts clean for each document', () => {
    expect(createSlugger()('Notes')).toBe('notes');
    expect(createSlugger()('Notes')).toBe('notes');
  });
});

describe('heading index', () => {
  const headingsOf = (text: string): Map<string, number> =>
    scanBlocks(text).headings;

  it('maps a heading to the block that holds it', () => {
    const h = headingsOf('# One\n\npara\n\n## Two\n');
    expect(h.get('one')).toBe(0);
    expect(h.get('two')).toBe(2);
  });

  it('points at the block a heading interrupting a paragraph lands in', () => {
    // No blank line, so the scanner keeps all three lines as one block.
    const h = headingsOf('para\n# Inline\nmore\n');
    expect(blockCount(scanBlocks('para\n# Inline\nmore\n').index)).toBe(1);
    expect(h.get('inline')).toBe(0);
  });

  it('ignores headings inside a fenced code block', () => {
    expect(headingsOf('```\n# Not a heading\n```\n').size).toBe(0);
  });

  it('ignores a closing fence line, which is not a heading', () => {
    expect(headingsOf('```\ncode\n```\n\n# Real\n').get('real')).toBe(1);
  });

  it('keeps the first of two headings with the same text, suffixing the second', () => {
    const h = headingsOf('# Notes\n\ntext\n\n# Notes\n');
    expect(h.get('notes')).toBe(0);
    expect(h.get('notes-1')).toBe(2);
  });

  it('skips a heading whose text slugs to nothing', () => {
    expect(headingsOf('# ???\n').size).toBe(0);
  });

  it('keeps the ordinal of a heading on the line that overflows its block', () => {
    // The length check records the block on this very line, so collecting the
    // heading after it would put the jump one block too far. A heading this
    // long is the smallest input that lands the two on the same line.
    const slug = 'a'.repeat(MAX_BLOCK + 4);
    expect(headingsOf(`# ${slug}\n`).get(slug)).toBe(0);
  });

  it('caps the map so an all-headings document cannot grow it without bound', () => {
    const lines = [];
    for (let i = 0; i < 4200; i += 1) {
      lines.push(`# H${i}\n`);
    }
    expect(headingsOf(lines.join('\n')).size).toBe(4096);
  });
});
