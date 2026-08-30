// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { GFM, parser as baseParser } from '@lezer/markdown';
import { flatten, renderBlockSource, type MdNode } from './core';
import { blockCount, blockEnd, blockStart, scanBlocks } from './scan';

const parser = baseParser.configure(GFM);

/** Parse and convert a whole document — small fixtures only, which is all a
 *  unit test needs; the windowing is what keeps real documents cheap. */
function render(src: string): MdNode[] {
  const { index, refs } = scanBlocks(src);
  const out: MdNode[] = [];
  for (let i = 0; i < blockCount(index); i += 1) {
    const slice = src.slice(blockStart(index, i), blockEnd(index, i));
    out.push(...renderBlockSource((s) => parser.parse(s), slice, refs));
  }
  return out;
}

/** All text a node subtree would show, for assertions that only care that the
 *  characters survived. */
function shown(nodes: MdNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'code':
      case 'html':
        out += node.text;
        break;
      case 'codeblock':
        out += node.text;
        break;
      case 'emphasis':
      case 'strong':
      case 'strike':
      case 'heading':
      case 'paragraph':
      case 'quote':
      case 'link':
        out += shown(node.children);
        break;
      case 'image':
        out += node.alt;
        break;
      case 'list':
        for (const item of node.items) {
          out += shown(item.children);
        }
        break;
      case 'table':
        for (const cell of node.header) {
          out += shown(cell);
        }
        for (const row of node.rows) {
          for (const cell of row) {
            out += shown(cell);
          }
        }
        break;
      default:
        break;
    }
  }
  return out;
}

describe('block rendering', () => {
  it('renders headings with their level and without the hashes', () => {
    const [node] = render('### Third\n');
    expect(node).toEqual({
      kind: 'heading',
      level: 3,
      children: [{ kind: 'text', text: 'Third' }],
    });
  });

  it('renders emphasis, strong, strikethrough and inline code', () => {
    const [para] = render('a **b** c *d* e ~~f~~ g `h`\n');
    expect(para?.kind).toBe('paragraph');
    const kinds =
      para?.kind === 'paragraph' ? para.children.map((c) => c.kind) : [];
    expect(kinds).toEqual([
      'text',
      'strong',
      'text',
      'emphasis',
      'text',
      'strike',
      'text',
      'code',
    ]);
    // The marks themselves are gone; the words are not.
    expect(shown([para as MdNode])).toBe('a b c d e f g h');
  });

  it('renders a fenced code block with its language and body', () => {
    const [node] = render('```js\nconst a = 1;\n```\n');
    expect(node).toEqual({
      kind: 'codeblock',
      info: 'js',
      text: 'const a = 1;',
    });
  });

  it('renders bullet and ordered lists', () => {
    const [bullet] = render('- one\n- two\n');
    expect(bullet?.kind).toBe('list');
    if (bullet?.kind === 'list') {
      expect(bullet.ordered).toBe(false);
      expect(bullet.items).toHaveLength(2);
      expect(shown(bullet.items[0]?.children ?? [])).toBe('one');
    }
    const [ordered] = render('1. a\n2. b\n');
    expect(ordered?.kind === 'list' && ordered.ordered).toBe(true);
  });

  it('marks task list items as checked or not, and plain items as neither', () => {
    const [list] = render('- [ ] todo\n- [x] done\n- plain\n');
    expect(list?.kind).toBe('list');
    if (list?.kind === 'list') {
      expect(list.items.map((i) => i.checked)).toEqual([false, true, null]);
      expect(shown(list.items[1]?.children ?? [])).toBe('done');
    }
  });

  it('renders a blockquote as blocks, not as one run of text', () => {
    const [quote] = render('> para **bold**\n');
    expect(quote?.kind).toBe('quote');
    if (quote?.kind === 'quote') {
      expect(quote.children[0]?.kind).toBe('paragraph');
      expect(shown(quote.children)).toBe('para bold');
    }
  });

  it('renders a table as header cells and rows', () => {
    const [table] = render('| h1 | h2 |\n|----|----|\n| a | b |\n| c | d |\n');
    expect(table?.kind).toBe('table');
    if (table?.kind === 'table') {
      expect(table.header.map((c) => shown(c).trim())).toEqual(['h1', 'h2']);
      expect(table.rows.map((r) => r.map((c) => shown(c).trim()))).toEqual([
        ['a', 'b'],
        ['c', 'd'],
      ]);
    }
  });

  it('renders a horizontal rule', () => {
    expect(render('---\n')[0]).toEqual({ kind: 'rule' });
  });
});

describe('links and images carry a destination but render as text only', () => {
  it('link node carries the raw destination; the shown text does not', () => {
    const [para] = render('see [the docs](http://example.com/x) now\n');
    const link = (para as { kind: 'paragraph'; children: MdNode[] })
      .children[1];
    expect(link).toMatchObject({
      kind: 'link',
      dest: 'http://example.com/x',
    });
    expect(shown([para as MdNode])).toBe('see the docs now');
    expect(shown([para as MdNode])).not.toContain('example.com');
  });

  it('image node carries the raw destination; the shown text does not', () => {
    const [para] = render('![a cat](cat.png)\n');
    const image = (para as { kind: 'paragraph'; children: MdNode[] })
      .children[0];
    expect(image).toMatchObject({
      kind: 'image',
      dest: 'cat.png',
      alt: 'a cat',
    });
    expect(shown([para as MdNode])).toBe('a cat');
    expect(shown([para as MdNode])).not.toContain('cat.png');
  });

  it('resolves a full reference link against its definition', () => {
    const [para] = render(
      'see [the docs][ref] now\n\n[ref]: http://example.com/x\n',
    );
    const link = (para as { kind: 'paragraph'; children: MdNode[] })
      .children[1];
    expect(link).toMatchObject({ dest: 'http://example.com/x' });
    expect(shown([para as MdNode])).toBe('see the docs now');
  });

  it('resolves a collapsed reference using its own text as the label', () => {
    const [para] = render('see [the docs][] now\n\n[the docs]: ./x\n');
    const link = (para as { kind: 'paragraph'; children: MdNode[] })
      .children[1];
    expect(link).toMatchObject({ dest: './x' });
  });

  it('resolves a shortcut reference using its own text as the label', () => {
    const [para] = render('see [the docs] now\n\n[the docs]: ./x\n');
    const link = (para as { kind: 'paragraph'; children: MdNode[] })
      .children[1];
    expect(link).toMatchObject({ dest: './x' });
  });

  it('label lookup is case-insensitive and collapses whitespace', () => {
    const [para] = render('see [The   Docs][a b] now\n\n[A B]: ./x\n');
    const link = (para as { kind: 'paragraph'; children: MdNode[] })
      .children[1];
    expect(link).toMatchObject({ dest: './x' });
  });

  it('falls back to plain text when a reference has no definition', () => {
    const [para] = render('see [the docs][missing] now\n');
    expect(
      (para as { kind: 'paragraph'; children: MdNode[] }).children,
    ).not.toContainEqual(expect.objectContaining({ kind: 'link' }));
    expect(shown([para as MdNode])).toBe('see the docs now');
  });

  it('a reference definition block renders as nothing', () => {
    expect(render('[ref]: http://example.com\n')).toEqual([]);
  });

  it('renders an angle-bracket autolink as a link carrying the URL', () => {
    const [para] = render('see <https://example.com> now\n');
    const link = (para as { kind: 'paragraph'; children: MdNode[] })
      .children[1];
    expect(link).toMatchObject({
      kind: 'link',
      dest: 'https://example.com',
    });
    expect(shown([para as MdNode])).toBe('see https://example.com now');
  });

  it('renders a bare URL (GFM autolink) as a link carrying the URL', () => {
    const [para] = render('see https://example.com now\n');
    const link = (para as { kind: 'paragraph'; children: MdNode[] })
      .children[1];
    expect(link).toMatchObject({
      kind: 'link',
      dest: 'https://example.com',
    });
    expect(shown([para as MdNode])).toBe('see https://example.com now');
  });

  it('a normal inline link still works alongside the autolink fix', () => {
    const [para] = render('see [the docs](http://example.com/x) now\n');
    const link = (para as { kind: 'paragraph'; children: MdNode[] })
      .children[1];
    expect(link).toMatchObject({
      kind: 'link',
      dest: 'http://example.com/x',
    });
    expect(shown([para as MdNode])).toBe('see the docs now');
  });

  it('an image still works alongside the autolink fix', () => {
    const [para] = render('![a cat](cat.png)\n');
    const image = (para as { kind: 'paragraph'; children: MdNode[] })
      .children[0];
    expect(image).toMatchObject({
      kind: 'image',
      dest: 'cat.png',
      alt: 'a cat',
    });
  });

  it('flatten does not silently drop link or image text', () => {
    const nodes: MdNode[] = [
      {
        kind: 'link',
        dest: 'http://e.com',
        children: [{ kind: 'text', text: 'a' }],
      },
      { kind: 'image', dest: 'x.png', alt: 'b' },
    ];
    expect(flatten(nodes)).toBe('ab');
  });
});

describe('markup in the document is content, never markup', () => {
  it('keeps an HTML block as the characters the author typed', () => {
    const [node] = render('<script>window.pwned = 1</script>\n');
    expect(node).toEqual({
      kind: 'html',
      text: '<script>window.pwned = 1</script>',
    });
  });

  it('keeps an inline HTML tag as text', () => {
    const [para] = render('before <img src=x onerror=alert(1)> after\n');
    expect(shown([para as MdNode])).toContain('<img src=x onerror=alert(1)>');
  });

  it('produces no node that carries anything but text', () => {
    // Whatever the document contains, every leaf is a string, number, boolean,
    // null, or an array of more nodes — `dest` included. There is no field a
    // renderer could hand to innerHTML even if it wanted to.
    const nodes = render(
      '# <b>t</b>\n\n<script>x</script>\n\n- <img onerror=y>\n\n> <iframe></iframe>\n\n`<svg/>`\n\n' +
        '[x](http://e.com "onerror=alert(1)") ![y](z.png "onerror=alert(1)")\n',
    );
    const seen = new Set<string>();
    const walk = (list: MdNode[]): void => {
      for (const node of list) {
        seen.add(node.kind);
        for (const [key, value] of Object.entries(node)) {
          if (key === 'kind') {
            continue;
          }
          const ok =
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            value === null ||
            Array.isArray(value);
          expect(ok).toBe(true);
        }
        if ('children' in node) {
          walk(node.children);
        }
        if (node.kind === 'list') {
          for (const item of node.items) {
            walk(item.children);
          }
        }
      }
    };
    walk(nodes);
    expect(seen.has('link')).toBe(true);
    expect(seen.has('image')).toBe(true);
  });
});

describe('a block parses correctly from its own slice', () => {
  // The whole design rests on this: a block cut out of the document and parsed
  // alone must render the same as it would in context.
  it('renders a fenced block that contains blank lines', () => {
    const [node] = render('```js\nconst a = 1;\n\nconst b = 2;\n```\n');
    expect(node).toEqual({
      kind: 'codeblock',
      info: 'js',
      text: 'const a = 1;\n\nconst b = 2;',
    });
  });

  it('renders a loose list as one list, not several', () => {
    const nodes = render('- one\n\n- two\n\n- three\n');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind === 'list' && nodes[0].items).toHaveLength(3);
  });

  it('keeps separate paragraphs separate', () => {
    const nodes = render('first para\n\nsecond para\n');
    expect(nodes.map((n) => n.kind)).toEqual(['paragraph', 'paragraph']);
  });
});
