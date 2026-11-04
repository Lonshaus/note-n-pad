// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readPageLines, splitLines, type PageSource } from './largePage';

const LOAD_PAGE = 400;
/** A file of `total` short lines, "L<n>\n" each, read through the same two
 *  calls the viewer makes. */
function fileOf(total: number, over: Partial<PageSource> = {}): PageSource {
  const lines = Array.from({ length: total }, (_, i) => `L${i}`);
  return {
    lineToOffset: async (line) => {
      return line >= total ? null : line;
    },
    readText: async (offset) =>
      lines.slice(offset, offset + LOAD_PAGE).join('\n'),
    ...over,
  };
}

describe('readPageLines', () => {
  it('returns the page lines', async () => {
    const got = await readPageLines(1, LOAD_PAGE, fileOf(1000));
    expect(got).toHaveLength(LOAD_PAGE);
    expect(got![0]).toBe('L400');
  });

  it('answers an empty page, not a failure, for a page past the end', async () => {
    const source = fileOf(350);
    expect(await readPageLines(1, LOAD_PAGE, source)).toEqual([]);
    expect(await readPageLines(2, LOAD_PAGE, source)).toEqual([]);
  });

  it('ends without a failure when the line estimate exceeds the true total', async () => {
    // The viewer sizes itself from an estimate of 30,000 lines; the file has 350.
    const source = fileOf(350);
    const pages = Math.ceil(30000 / LOAD_PAGE);
    const results = await Promise.all(
      Array.from({ length: pages }, (_, p) =>
        readPageLines(p, LOAD_PAGE, source),
      ),
    );
    expect(results.some((r) => r === null)).toBe(false);
    expect(results[0]).toHaveLength(350);
    expect(results.slice(1).every((r) => r!.length === 0)).toBe(true);
  });

  it('fails when the line lookup rejects', async () => {
    const source = fileOf(1000, {
      lineToOffset: async () => {
        throw new Error('io');
      },
    });
    expect(await readPageLines(0, LOAD_PAGE, source)).toBeNull();
  });

  describe('line breaks', () => {
    const readOf = (
      text: string,
      eof: boolean,
      pageLines = LOAD_PAGE,
    ): Promise<string[] | null> =>
      readPageLines(0, pageLines, {
        lineToOffset: async () => 0,
        readText: async () => ({ text, eof }),
      });

    it('splits at LF, CRLF and a lone CR', async () => {
      expect(await readOf('a\nb\r\nc\rd', true)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('treats a bare string as a read that reached the end', async () => {
      const got = await readPageLines(0, LOAD_PAGE, {
        lineToOffset: async () => 0,
        readText: async () => 'a\r',
      });
      expect(got).toEqual(['a', '']);
    });

    it('ends a file on a final lone CR with an empty last line', async () => {
      expect(await readOf('a\rb\r', true)).toEqual(['a', 'b', '']);
    });

    it('does not break at a CR that ends a read short of the end', async () => {
      // The next read may begin with the LF of a CRLF.
      expect(await readOf('a\rb\r', false)).toEqual(['a', 'b']);
      expect(await readOf('a\r\r', false)).toEqual(['a', '']);
    });

    it('keeps only the lines of the page', async () => {
      expect(await readOf('a\rb\rc\rd\r', false, 2)).toEqual(['a', 'b']);
    });
  });

  it('fails when the chunk read rejects', async () => {
    const source = fileOf(1000, {
      readText: async () => {
        throw new Error('permission-denied');
      },
    });
    expect(await readPageLines(1, LOAD_PAGE, source)).toBeNull();
  });
});

describe('splitLines', () => {
  it('drops a CR that ends a read short of the end with its incomplete line', () => {
    expect(splitLines('a\rb\r', false)).toEqual(['a', 'b']);
    expect(splitLines('a\rb\r', true)).toEqual(['a', 'b', '']);
    expect(splitLines('a\r\nb', false)).toEqual(['a', 'b']);
  });
});
