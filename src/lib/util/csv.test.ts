// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { DsvChange } from './csv';
import {
  copyAll,
  copyColumn,
  clearAllChange,
  clearColChange,
  deleteColChange,
  insertColChange,
  clearRowChange,
  deleteRowChange,
  fieldSpans,
  insertRowChange,
  setCellChange,
  indexDsv,
  rowFields,
  rowText,
  windowFields,
  parseDsv,
  serializeDsv,
  dsvDelimiterFor,
  setCell,
  widestRow,
  insertRow,
  deleteRow,
  insertCol,
  deleteCol,
  serializeField,
  clearRow,
  clearCol,
  clearAll,
} from './csv';

const COMMA = ',';
const TAB = '\t';

describe('parseDsv', () => {
  it('empty text yields no rows', () => {
    expect(parseDsv('', COMMA)).toEqual({ rows: [], trailingNewline: false });
  });

  it('a single empty field is one row, distinct from empty text', () => {
    expect(parseDsv('""', COMMA)).toEqual({
      rows: [['']],
      trailingNewline: false,
    });
  });

  it('parses plain rows', () => {
    expect(parseDsv('a,b,c\nd,e,f', COMMA).rows).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  it('detects a trailing newline and drops the empty final record', () => {
    const parsed = parseDsv('a,b\n', COMMA);
    expect(parsed.rows).toEqual([['a', 'b']]);
    expect(parsed.trailingNewline).toBe(true);
  });

  it('reports no trailing newline when the text ends on data', () => {
    expect(parseDsv('a,b', COMMA).trailingNewline).toBe(false);
  });

  it('unquotes a field with an embedded delimiter', () => {
    expect(parseDsv('"a,b",c', COMMA).rows).toEqual([['a,b', 'c']]);
  });

  it('unquotes an embedded newline inside a quoted field', () => {
    expect(parseDsv('"line1\nline2",b', COMMA).rows).toEqual([
      ['line1\nline2', 'b'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseDsv('"say ""hi""",b', COMMA).rows).toEqual([['say "hi"', 'b']]);
  });

  it('tolerates CRLF record separators', () => {
    const parsed = parseDsv('a,b\r\nc,d\r\n', COMMA);
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parsed.trailingNewline).toBe(true);
  });

  it('tolerates a lone CR record separator', () => {
    expect(parseDsv('a,b\rc,d', COMMA).rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles an unterminated quote leniently (consume to EOF)', () => {
    expect(parseDsv('"abc', COMMA).rows).toEqual([['abc']]);
  });

  it('treats a bare quote mid-field as a literal character', () => {
    expect(parseDsv('a"b', COMMA).rows).toEqual([['a"b']]);
    expect(parseDsv('a"b"c', COMMA).rows).toEqual([['a"b"c']]);
  });

  it('does not let an inch mark swallow the next record', () => {
    // Odd quote count used to merge two records; it must stay two rows.
    expect(parseDsv('10,5" nail\nfoo,bar', COMMA).rows).toEqual([
      ['10', '5" nail'],
      ['foo', 'bar'],
    ]);
  });

  it('appends trailing junk after a closing quote literally (lenient)', () => {
    expect(parseDsv('"a"x,b', COMMA).rows).toEqual([['ax', 'b']]);
  });

  it('preserves ragged rows as-is', () => {
    expect(parseDsv('a,b,c\nd\ne,f', COMMA).rows).toEqual([
      ['a', 'b', 'c'],
      ['d'],
      ['e', 'f'],
    ]);
  });

  it('splits TSV rows on tabs', () => {
    expect(parseDsv('a\tb\tc', TAB).rows).toEqual([['a', 'b', 'c']]);
  });

  it('keeps a comma literal in TSV fields', () => {
    expect(parseDsv('a,x\tb', TAB).rows).toEqual([['a,x', 'b']]);
  });
});

describe('serializeDsv', () => {
  it('serializes plain rows joined with LF', () => {
    expect(
      serializeDsv(
        [
          ['a', 'b'],
          ['c', 'd'],
        ],
        COMMA,
      ),
    ).toBe('a,b\nc,d');
  });

  it('quotes only fields that need it', () => {
    expect(serializeDsv([['a,b', 'plain', 'has"quote']], COMMA)).toBe(
      '"a,b",plain,"has""quote"',
    );
  });

  it('quotes fields with embedded newlines', () => {
    expect(serializeDsv([['x\ny']], COMMA)).toBe('"x\ny"');
  });

  it('appends a trailing newline when requested', () => {
    expect(serializeDsv([['a', 'b']], COMMA, { trailingNewline: true })).toBe(
      'a,b\n',
    );
  });

  it('omits the trailing newline by default', () => {
    expect(serializeDsv([['a', 'b']], COMMA)).toBe('a,b');
  });

  it('serializes empty rows to empty text', () => {
    expect(serializeDsv([], COMMA, { trailingNewline: true })).toBe('');
  });

  it('quotes a TSV field containing a tab', () => {
    expect(serializeDsv([['a\tb', 'c']], TAB)).toBe('"a\tb"\tc');
  });
});

describe('round-trip', () => {
  const cases: [string, string, string][] = [
    ['plain', 'a,b,c\nd,e,f', COMMA],
    ['quoted commas', '"a,b",c\nd,"e,f"', COMMA],
    ['embedded newline', '"line1\nline2",b', COMMA],
    ['doubled quotes', '"say ""hi""",b', COMMA],
    ['trailing newline', 'a,b\nc,d\n', COMMA],
    ['no trailing newline', 'a,b\nc,d', COMMA],
    ['ragged rows', 'a,b,c\nd\ne,f', COMMA],
    ['tsv', 'a\tb\tc\nd\te\tf', TAB],
  ];
  it.each(cases)('%s reproduces semantic content', (_name, text, delimiter) => {
    const parsed = parseDsv(text, delimiter);
    const out = serializeDsv(parsed.rows, delimiter, {
      trailingNewline: parsed.trailingNewline,
    });
    // Re-parsing the output yields the same rows and trailing-newline flag.
    expect(parseDsv(out, delimiter)).toEqual(parsed);
  });

  it('normalizes a bare quote to minimal quoting, then reaches a fixpoint', () => {
    const parsed = parseDsv('10,5" nail\nfoo,bar', COMMA);
    const out = serializeDsv(parsed.rows, COMMA, {
      trailingNewline: parsed.trailingNewline,
    });
    expect(out).toBe('10,"5"" nail"\nfoo,bar');
    // One normalization pass; re-parsing the output yields the same rows.
    expect(parseDsv(out, COMMA).rows).toEqual(parsed.rows);
  });

  it('normalizes CRLF input to an LF buffer on round-trip', () => {
    const parsed = parseDsv('a,b\r\nc,d\r\n', COMMA);
    expect(
      serializeDsv(parsed.rows, COMMA, {
        trailingNewline: parsed.trailingNewline,
      }),
    ).toBe('a,b\nc,d\n');
  });

  it('collapses a lone empty field to empty text (unquoted, ambiguous)', () => {
    // A single empty cell carries no semantic content, so it serializes to ''
    // and reparses as an empty grid — the one intentional non-identity case.
    const parsed = parseDsv('""', COMMA);
    expect(
      serializeDsv(parsed.rows, COMMA, {
        trailingNewline: parsed.trailingNewline,
      }),
    ).toBe('');
  });

  it('empty text round-trips to empty text', () => {
    const parsed = parseDsv('', COMMA);
    expect(
      serializeDsv(parsed.rows, COMMA, {
        trailingNewline: parsed.trailingNewline,
      }),
    ).toBe('');
  });
});

describe('dsvDelimiterFor', () => {
  const cases: [string, string | null][] = [
    ['data.csv', ','],
    ['data.tsv', '\t'],
    ['/a/b/table.CSV', ','],
    ['C:\\x\\sheet.TSV', '\t'],
    ['notes.txt', null],
    ['noext', null],
    ['', null],
  ];
  it.each(cases)('%s -> %j', (path, expected) => {
    expect(dsvDelimiterFor(path)).toBe(expected);
  });
});

describe('setCell', () => {
  it('replaces a cell without mutating the input', () => {
    const rows = [['a', 'b']];
    const next = setCell(rows, 0, 1, 'z');
    expect(next).toEqual([['a', 'z']]);
    expect(rows).toEqual([['a', 'b']]);
  });

  it('pads a short row up to the target column', () => {
    expect(setCell([['a']], 0, 2, 'z')).toEqual([['a', '', 'z']]);
  });

  it('leaves the grid unchanged for an out-of-range row', () => {
    const rows = [['a']];
    expect(setCell(rows, 5, 0, 'z')).toBe(rows);
  });
});

describe('insertRow / deleteRow', () => {
  it('inserts a blank row as wide as the widest row', () => {
    expect(insertRow([['a', 'b']], 1)).toEqual([
      ['a', 'b'],
      ['', ''],
    ]);
  });

  it('inserts a single blank cell into an empty grid', () => {
    expect(insertRow([], 0)).toEqual([['']]);
  });

  it('deletes a row', () => {
    expect(deleteRow([['a'], ['b'], ['c']], 1)).toEqual([['a'], ['c']]);
  });

  it('leaves the grid unchanged deleting out of range', () => {
    const rows = [['a']];
    expect(deleteRow(rows, 3)).toBe(rows);
  });
});

describe('insertCol / deleteCol', () => {
  it('inserts a blank column across every row', () => {
    expect(
      insertCol(
        [
          ['a', 'b'],
          ['c', 'd'],
        ],
        1,
      ),
    ).toEqual([
      ['a', '', 'b'],
      ['c', '', 'd'],
    ]);
  });

  it('pads a short row before inserting the column', () => {
    expect(insertCol([['a']], 2)).toEqual([['a', '', '']]);
  });

  it('deletes a column from every row that has it', () => {
    expect(deleteCol([['a', 'b', 'c'], ['d']], 1)).toEqual([['a', 'c'], ['d']]);
  });
});

describe('serializeField', () => {
  it('leaves a plain value unquoted', () => {
    expect(serializeField('abc', COMMA)).toBe('abc');
  });

  it('quotes a value containing the delimiter', () => {
    expect(serializeField('a,b', COMMA)).toBe('"a,b"');
    // A comma is not special under the tab delimiter.
    expect(serializeField('a,b', TAB)).toBe('a,b');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(serializeField('5" nail', COMMA)).toBe('"5"" nail"');
  });

  it('quotes values with CR or LF', () => {
    expect(serializeField('a\nb', COMMA)).toBe('"a\nb"');
    expect(serializeField('a\rb', COMMA)).toBe('"a\rb"');
  });
});

describe('clearRow', () => {
  it('empties every field of the target row, preserving width', () => {
    expect(
      clearRow(
        [
          ['a', 'b', 'c'],
          ['d', 'e', 'f'],
        ],
        0,
      ),
    ).toEqual([
      ['', '', ''],
      ['d', 'e', 'f'],
    ]);
  });

  it('returns the grid unchanged when out of range', () => {
    const grid = [['a']];
    expect(clearRow(grid, 5)).toBe(grid);
    expect(clearRow(grid, -1)).toBe(grid);
  });
});

describe('clearCol', () => {
  it('empties the target column in every row that has it', () => {
    expect(
      clearCol(
        [
          ['a', 'b', 'c'],
          ['d', 'e'],
        ],
        1,
      ),
    ).toEqual([
      ['a', '', 'c'],
      ['d', ''],
    ]);
  });

  it('leaves rows too short to contain the column untouched', () => {
    expect(clearCol([['a'], ['b', 'c']], 1)).toEqual([['a'], ['b', '']]);
  });
});

describe('clearAll', () => {
  it('empties every cell without mutating the input', () => {
    const rows = [
      ['a', 'b'],
      ['c', 'd'],
    ];
    expect(clearAll(rows)).toEqual([
      ['', ''],
      ['', ''],
    ]);
    expect(rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('preserves each row width on a ragged grid', () => {
    expect(clearAll([['a', 'b', 'c'], ['d'], ['e', 'f']])).toEqual([
      ['', '', ''],
      [''],
      ['', ''],
    ]);
  });

  it('returns an empty grid for an empty grid', () => {
    expect(clearAll([])).toEqual([]);
  });
});

describe('widestRow', () => {
  it('returns the widest row, never below the floor', () => {
    expect(widestRow([['a', 'b', 'c'], ['d'], ['e', 'f']], 1)).toBe(3);
    expect(widestRow([['a']], 4)).toBe(4);
    expect(widestRow([], 1)).toBe(1);
  });

  it('survives a row count that would overrun a spread call', () => {
    // `Math.max(1, ...rows.map(...))` throws RangeError here; a table file with
    // this many rows is exactly what the view has to open.
    const rows = Array.from({ length: 300_000 }, () => ['a', 'b']);
    rows[299_999] = ['a', 'b', 'c'];
    expect(widestRow(rows, 1)).toBe(3);
  });
});

/** Every fixture the parser has to get right, reused to pin the index to it.
 *  Two state machines walking the same quoting rules drift silently; only a
 *  shared corpus catches that. */
const FIXTURES: ReadonlyArray<readonly [string, string, string]> = [
  ['empty', '', ','],
  ['one field', 'a', ','],
  ['one row', 'a,b,c', ','],
  ['two rows', 'a,b\nc,d', ','],
  ['trailing newline', 'a,b\n', ','],
  ['blank line in the middle', 'a\n\nb', ','],
  ['CRLF', 'a,b\r\nc,d\r\n', ','],
  ['lone CR', 'a,b\rc,d', ','],
  ['ragged rows', 'a\nb,c,d\ne,f', ','],
  ['quoted delimiter', '"a,b",c', ','],
  ['quoted newline', '"a\nb",c\nd,e', ','],
  ['quoted CRLF', '"a\r\nb",c\r\nd,e', ','],
  ['escaped quote', '"a""b",c', ','],
  ['bare quote mid-field', '5" nail,c\nd,e', ','],
  ['quote after a quoted section closes', '"a"b,c', ','],
  ['unterminated quote', 'a,"b\nc', ','],
  ['empty fields', ',,\n,,', ','],
  ['tab delimited', 'a\tb\nc\td', '\t'],
  ['quoted tab', '"a\tb"\tc', '\t'],
  ['only a newline', '\n', ','],
  ['only newlines', '\n\n\n', ','],
];

describe('indexDsv', () => {
  it.each(FIXTURES)('agrees with parseDsv: %s', (_name, text, delimiter) => {
    const parsed = parseDsv(text, delimiter);
    const index = indexDsv(text, delimiter);
    expect(index.rowStarts.length).toBe(parsed.rows.length);
    expect(index.trailingNewline).toBe(parsed.trailingNewline);
    expect(index.colCount).toBe(
      widestRow(parsed.rows.length > 0 ? parsed.rows : [['']], 1),
    );
  });

  it.each(FIXTURES)(
    'slices back to the same fields: %s',
    (_name, text, delimiter) => {
      const parsed = parseDsv(text, delimiter);
      const index = indexDsv(text, delimiter);
      for (let r = 0; r < parsed.rows.length; r += 1) {
        // `parseDsv('')` yields no rows at all, so a blank record parses to
        // nothing rather than to one empty field. Anything slicing a row out of
        // the index has to put that record back itself.
        const fields = parseDsv(rowText(text, index, r), delimiter).rows[0] ?? [
          '',
        ];
        expect(fields).toEqual(parsed.rows[r]);
      }
    },
  );

  it('points at the first character of each record', () => {
    const text = 'ab,c\r\nde\nf';
    const index = indexDsv(text, ',');
    expect(Array.from(index.rowStarts)).toEqual([0, 6, 9]);
  });

  it('grows past its seed capacity', () => {
    // 3000 records is past two doublings of ROW_INDEX_SEED, so a broken grow
    // shows up as a truncated or zero-filled tail rather than a clean failure.
    const rows = 3000;
    const text = Array.from({ length: rows }, (_, i) => `${i},x`).join('\n');
    const index = indexDsv(text, ',');
    expect(index.rowStarts.length).toBe(rows);
    expect(rowText(text, index, rows - 1)).toBe(`${rows - 1},x`);
    expect(rowText(text, index, 0)).toBe('0,x');
  });

  it('keeps a newline the last field never closed a quote around', () => {
    // The trailing newline here is content, not a separator: the quote opened
    // and never closed, so nothing ended the record but EOF. Trimming it eats a
    // character and shifts every field span in that record.
    const text = '"\n';
    const index = indexDsv(text, ',');
    expect(index.trailingNewline).toBe(false);
    expect(rowText(text, index, 0)).toBe('"\n');
    expect(rowFields(text, index, 0, ',')).toEqual(['\n']);
  });

  it('gives an empty string outside the record range', () => {
    const index = indexDsv('a\nb', ',');
    expect(rowText('a\nb', index, -1)).toBe('');
    expect(rowText('a\nb', index, 2)).toBe('');
  });
});

describe('rowFields and windowFields', () => {
  it('gives one empty cell for a blank record', () => {
    // parseDsv('') has no rows at all, so without the floor a blank line would
    // render as no cells rather than one empty cell.
    const text = 'a\n\nb';
    const index = indexDsv(text, ',');
    expect(rowFields(text, index, 1, ',')).toEqual(['']);
  });

  it('gives one empty cell for an empty document', () => {
    const index = indexDsv('', ',');
    expect(index.rowStarts.length).toBe(0);
    expect(rowFields('', index, 0, ',')).toEqual(['']);
    expect(windowFields('', index, 0, 1, ',')).toEqual([['']]);
  });

  it('gives one empty cell past the last record', () => {
    const text = 'a\nb';
    const index = indexDsv(text, ',');
    expect(rowFields(text, index, 5, ',')).toEqual(['']);
  });

  it('parses only the requested window', () => {
    const text = 'r0\nr1\nr2\nr3\nr4';
    const index = indexDsv(text, ',');
    expect(windowFields(text, index, 1, 3, ',')).toEqual([['r1'], ['r2']]);
  });

  it('clamps a window that runs past either end', () => {
    const text = 'a\nb';
    const index = indexDsv(text, ',');
    expect(windowFields(text, index, -5, 99, ',')).toEqual([['a'], ['b']]);
    expect(windowFields(text, index, 2, 2, ',')).toEqual([]);
  });

  it.each(FIXTURES)(
    'a full window equals the full parse: %s',
    (_n, text, d) => {
      const parsed = parseDsv(text, d);
      const index = indexDsv(text, d);
      const expected = parsed.rows.length > 0 ? parsed.rows : [['']];
      expect(windowFields(text, index, 0, expected.length, d)).toEqual(
        expected,
      );
    },
  );
});

describe('indexing a rope instead of a string', () => {
  /** The shape the table view actually passes: CodeMirror's `Text`, reduced to
   *  what the index needs. Records every slice so a test can assert the scan
   *  never pulls the whole document in at once. */
  function rope(text: string) {
    const spans: Array<[number, number]> = [];
    return {
      length: text.length,
      sliceString(from: number, to: number): string {
        spans.push([from, to]);
        return text.slice(from, to);
      },
      spans,
    };
  }

  it.each(FIXTURES)('matches the string path: %s', (_n, text, d) => {
    const fromString = indexDsv(text, d);
    const src = rope(text);
    const fromRope = indexDsv(src, d);
    expect(Array.from(fromRope.rowStarts)).toEqual(
      Array.from(fromString.rowStarts),
    );
    expect(fromRope.colCount).toBe(fromString.colCount);
    expect(fromRope.trailingNewline).toBe(fromString.trailingNewline);
    for (let r = 0; r < fromString.rowStarts.length; r += 1) {
      expect(rowFields(src, fromRope, r, d)).toEqual(
        rowFields(text, fromString, r, d),
      );
    }
  });

  it('never slices the whole document at once', () => {
    // Well past one chunk, so a scan that quietly materialised the source would
    // show up as a single span covering everything.
    const text = Array.from({ length: 30_000 }, (_u, i) => `${i},x,y`).join(
      '\n',
    );
    expect(text.length).toBeGreaterThan(200_000);
    const src = rope(text);
    indexDsv(src, ',');
    const widest = src.spans.reduce(
      (w, [from, to]) => Math.max(w, to - from),
      0,
    );
    expect(widest).toBeLessThan(text.length);
  });

  it('reads a CRLF that straddles a chunk boundary', () => {
    // The CR is the last character the first chunk holds and the LF is the first
    // of the next, which is exactly where a chunked reader loses the pair and
    // counts two records instead of one separator.
    const text = `${'x'.repeat(65_535)}\r\ny`;
    expect(text[65_535]).toBe('\r');
    expect(text[65_536]).toBe('\n');
    const fromRope = indexDsv(rope(text), ',');
    expect(Array.from(fromRope.rowStarts)).toEqual(
      Array.from(indexDsv(text, ',').rowStarts),
    );
    expect(fromRope.rowStarts.length).toBe(2);
  });

  it('reads an escaped quote that straddles a chunk boundary', () => {
    // The doubled quote sits across the edge and a newline follows it inside the
    // still-open field. Misread the pair as a closing quote and that newline
    // becomes a record separator, so the shape shows up as a row count.
    const text = `"${'x'.repeat(65_534)}""\ny",z`;
    expect(text[65_535]).toBe('"');
    expect(text[65_536]).toBe('"');
    const src = rope(text);
    const fromRope = indexDsv(src, ',');
    expect(fromRope.rowStarts.length).toBe(1);
    expect(Array.from(fromRope.rowStarts)).toEqual(
      Array.from(indexDsv(text, ',').rowStarts),
    );
    expect(rowFields(src, fromRope, 0, ',')).toEqual(
      rowFields(text, indexDsv(text, ','), 0, ','),
    );
  });
});

describe('range edits', () => {
  /** Apply one change the way CodeMirror would. */
  function apply(text: string, change: DsvChange | null): string {
    if (change === null) {
      return text;
    }
    return text.slice(0, change.from) + change.insert + text.slice(change.to);
  }

  /** What the old whole-document path produced, for a semantic cross-check. */
  function whole(text: string, delimiter: string, rows: string[][]): string {
    const { trailingNewline } = parseDsv(text, delimiter);
    return serializeDsv(rows, delimiter, { trailingNewline });
  }

  function grid(text: string, delimiter: string): string[][] {
    const rows = parseDsv(text, delimiter).rows;
    return rows.length > 0 ? rows : [['']];
  }

  it('spans a quoted field including its quotes', () => {
    const text = 'a,"b,c",d';
    const index = indexDsv(text, ',');
    const spans = fieldSpans(text, index, 0, ',');
    expect(spans.map((s) => text.slice(s.from, s.to))).toEqual([
      'a',
      '"b,c"',
      'd',
    ]);
  });

  it('spans an empty record as one empty field', () => {
    const text = 'a\n\nb';
    const index = indexDsv(text, ',');
    expect(fieldSpans(text, index, 1, ',')).toEqual([{ from: 2, to: 2 }]);
  });

  it.each(FIXTURES)('setCell matches the grid version: %s', (_n, text, d) => {
    const index = indexDsv(text, d);
    const rows = grid(text, d);
    for (let r = 0; r < rows.length; r += 1) {
      for (const c of [0, 1, 4]) {
        for (const v of ['X', 'has,comma', 'has"quote', '']) {
          const applied = apply(text, setCellChange(text, index, r, c, v, d));
          expect(parseDsv(applied, d).rows).toEqual(
            parseDsv(whole(text, d, setCell(rows, r, c, v)), d).rows,
          );
        }
      }
    }
  });

  it.each(FIXTURES)('insertRow matches the grid version: %s', (_n, text, d) => {
    const index = indexDsv(text, d);
    const rows = grid(text, d);
    for (let at = 0; at <= rows.length; at += 1) {
      const applied = apply(text, insertRowChange(text, index, at, d));
      const expected = whole(text, d, insertRow(rows, at));
      expect(parseDsv(applied, d).rows).toEqual(parseDsv(expected, d).rows);
      // Appending a blank record to a file that ended without a separator adds
      // one, exactly as the whole-document path did; compare against that
      // rather than against the file it started as.
      expect(parseDsv(applied, d).trailingNewline).toBe(
        parseDsv(expected, d).trailingNewline,
      );
    }
  });

  it.each(FIXTURES)('deleteRow matches the grid version: %s', (_n, text, d) => {
    const index = indexDsv(text, d);
    const rows = grid(text, d);
    for (let at = 0; at < rows.length; at += 1) {
      const applied = apply(text, deleteRowChange(text, index, at));
      expect(parseDsv(applied, d).rows).toEqual(
        parseDsv(whole(text, d, deleteRow(rows, at)), d).rows,
      );
    }
  });

  it.each(FIXTURES)('clearRow matches the grid version: %s', (_n, text, d) => {
    const index = indexDsv(text, d);
    const rows = grid(text, d);
    for (let r = 0; r < rows.length; r += 1) {
      const applied = apply(text, clearRowChange(text, index, r, d));
      expect(parseDsv(applied, d).rows).toEqual(
        parseDsv(whole(text, d, clearRow(rows, r)), d).rows,
      );
    }
  });

  it('leaves every byte it did not touch alone', () => {
    // Quotes that serialization would drop. The old path rewrote the whole
    // document, so editing one cell re-quoted the rest of the file; this is the
    // behaviour the range edits exist to change.
    const text = '"a",b\n"c",d';
    const index = indexDsv(text, ',');
    expect(apply(text, setCellChange(text, index, 0, 1, 'X', ','))).toBe(
      '"a",X\n"c",d',
    );
    expect(whole(text, ',', setCell(grid(text, ','), 0, 1, 'X'))).toBe(
      'a,X\nc,d',
    );
  });

  it('keeps a file that ends without a newline ending without one', () => {
    const text = 'a\nb';
    const index = indexDsv(text, ',');
    expect(apply(text, insertRowChange(text, index, 2, ','))).toBe('a\nb\n');
    expect(apply(text, deleteRowChange(text, index, 1))).toBe('a');
  });

  it('keeps a file that ends on a newline ending on one', () => {
    const text = 'a\nb\n';
    const index = indexDsv(text, ',');
    expect(apply(text, insertRowChange(text, index, 2, ','))).toBe('a\nb\n\n');
    expect(apply(text, deleteRowChange(text, index, 1))).toBe('a\n');
  });

  it('pads out to a column past the row width', () => {
    const text = 'a,b';
    const index = indexDsv(text, ',');
    expect(apply(text, setCellChange(text, index, 0, 3, 'X', ','))).toBe(
      'a,b,,X',
    );
  });

  it('quotes a value that needs it', () => {
    const text = 'a,b';
    const index = indexDsv(text, ',');
    expect(apply(text, setCellChange(text, index, 0, 0, 'x,y', ','))).toBe(
      '"x,y",b',
    );
  });

  it('clears a row to its own width, not the file width', () => {
    const text = 'a,b,c\nd,e';
    const index = indexDsv(text, ',');
    expect(apply(text, clearRowChange(text, index, 1, ','))).toBe('a,b,c\n,');
  });

  it('reports nothing to do rather than an empty edit', () => {
    const text = 'a,b\n,';
    const index = indexDsv(text, ',');
    expect(clearRowChange(text, index, 1, ',')).toBeNull();
    expect(setCellChange(text, index, 9, 0, 'x', ',')).toBeNull();
    expect(deleteRowChange(text, index, 9)).toBeNull();
    expect(fieldSpans(text, index, 9, ',')).toEqual([]);
  });

  it('edits the phantom row of an empty document', () => {
    const index = indexDsv('', ',');
    expect(apply('', setCellChange('', index, 0, 0, 'x', ','))).toBe('x');
    expect(apply('', insertRowChange('', index, 1, ','))).toBe('\n');
    expect(deleteRowChange('', index, 0)).toBeNull();
  });
});

describe('column range edits', () => {
  /** Apply a whole change set the way CodeMirror does, back to front so an
   *  earlier change cannot shift a later one's offsets. */
  function applyAll(text: string, changes: DsvChange[]): string {
    let out = text;
    for (let i = changes.length - 1; i >= 0; i -= 1) {
      const c = changes[i]!;
      out = out.slice(0, c.from) + c.insert + out.slice(c.to);
    }
    return out;
  }

  function whole(text: string, delimiter: string, rows: string[][]): string {
    const { trailingNewline } = parseDsv(text, delimiter);
    return serializeDsv(rows, delimiter, { trailingNewline });
  }

  function grid(text: string, delimiter: string): string[][] {
    const rows = parseDsv(text, delimiter).rows;
    return rows.length > 0 ? rows : [['']];
  }

  it.each(FIXTURES)('insertCol matches the grid version: %s', (_n, text, d) => {
    const index = indexDsv(text, d);
    for (const at of [0, 1, 2, 5]) {
      const applied = applyAll(text, insertColChange(text, index, at, d));
      expect(parseDsv(applied, d).rows).toEqual(
        parseDsv(whole(text, d, insertCol(grid(text, d), at)), d).rows,
      );
    }
  });

  it.each(FIXTURES)('deleteCol matches the grid version: %s', (_n, text, d) => {
    const index = indexDsv(text, d);
    for (const at of [0, 1, 2, 5]) {
      const applied = applyAll(text, deleteColChange(text, index, at, d));
      expect(parseDsv(applied, d).rows).toEqual(
        parseDsv(whole(text, d, deleteCol(grid(text, d), at)), d).rows,
      );
    }
  });

  it.each(FIXTURES)('clearCol matches the grid version: %s', (_n, text, d) => {
    const index = indexDsv(text, d);
    for (const c of [0, 1, 2, 5]) {
      const applied = applyAll(text, clearColChange(text, index, c, d));
      expect(parseDsv(applied, d).rows).toEqual(
        parseDsv(whole(text, d, clearCol(grid(text, d), c)), d).rows,
      );
    }
  });

  it.each(FIXTURES)('clearAll matches the grid version: %s', (_n, text, d) => {
    const index = indexDsv(text, d);
    const applied = applyAll(text, clearAllChange(text, index, d));
    expect(parseDsv(applied, d).rows).toEqual(
      parseDsv(whole(text, d, clearAll(grid(text, d))), d).rows,
    );
  });

  it('leaves the fields it does not touch byte-identical', () => {
    const text = '"a",b,"c"\n"d",e,"f"';
    const index = indexDsv(text, ',');
    expect(applyAll(text, clearColChange(text, index, 1, ','))).toBe(
      '"a",,"c"\n"d",,"f"',
    );
    expect(applyAll(text, deleteColChange(text, index, 1, ','))).toBe(
      '"a","c"\n"d","f"',
    );
    expect(applyAll(text, insertColChange(text, index, 1, ','))).toBe(
      '"a",,b,"c"\n"d",,e,"f"',
    );
  });

  it('takes the delimiter in front when the last column goes', () => {
    const text = 'a,b\nc,d';
    const index = indexDsv(text, ',');
    expect(applyAll(text, deleteColChange(text, index, 1, ','))).toBe('a\nc');
  });

  it('empties a record whose only column goes', () => {
    const text = 'a\nb';
    const index = indexDsv(text, ',');
    expect(applyAll(text, deleteColChange(text, index, 0, ','))).toBe('\n');
  });

  it('skips records that do not have the column', () => {
    const text = 'a,b,c\nd';
    const index = indexDsv(text, ',');
    expect(deleteColChange(text, index, 2, ',')).toHaveLength(1);
    expect(clearColChange(text, index, 2, ',')).toHaveLength(1);
    expect(applyAll(text, deleteColChange(text, index, 2, ','))).toBe('a,b\nd');
  });

  it('grows the delimiters a short record needs to reach the column', () => {
    const text = 'a,b';
    const index = indexDsv(text, ',');
    expect(applyAll(text, insertColChange(text, index, 4, ','))).toBe('a,b,,,');
  });

  it('produces changes in ascending, non-overlapping order', () => {
    const text = 'a,b,c\nd,e,f\ng,h,i';
    const index = indexDsv(text, ',');
    for (const changes of [
      insertColChange(text, index, 1, ','),
      deleteColChange(text, index, 1, ','),
      clearColChange(text, index, 1, ','),
      clearAllChange(text, index, ','),
    ]) {
      let previous = -1;
      for (const c of changes) {
        expect(c.from).toBeGreaterThanOrEqual(previous);
        expect(c.to).toBeGreaterThanOrEqual(c.from);
        previous = c.to;
      }
    }
  });

  it('reports nothing to do rather than empty edits', () => {
    const text = 'a,,c\nd,,f';
    const index = indexDsv(text, ',');
    expect(clearColChange(text, index, 1, ',')).toEqual([]);
    expect(clearAllChange(',\n,', indexDsv(',\n,', ','), ',')).toEqual([]);
    expect(insertColChange(text, index, -1, ',')).toEqual([]);
    expect(deleteColChange(text, index, 9, ',')).toEqual([]);
  });
});

describe('clipboard text', () => {
  /** The shortcut that hands a field over without decoding it must never
   *  disagree with actually decoding and re-serializing. Checked over every
   *  small text these pieces can build, not just the fixtures. */
  it('re-emits every field exactly as a decode would', () => {
    const pieces = ['', 'a', ',', '"', '""', '\n', 'a"b', 'a,b', ' '];
    const texts = new Set<string>();
    for (const a of pieces) {
      for (const b of pieces) {
        texts.add(a + b);
        texts.add(`"${a}${b}"`);
        texts.add(`${a}"${b}`);
        texts.add(`${a},${b}`);
      }
    }
    for (const text of texts) {
      const rows = parseDsv(text, ',').rows;
      const slow = serializeDsv(rows.length > 0 ? rows : [['']], ',').replace(
        /\n$/,
        '',
      );
      expect(copyAll(text, indexDsv(text, ','), ',')).toBe(slow);
    }
  });

  /** What the whole-document path produced, kept as the reference so a change
   *  in what lands on the clipboard cannot pass unnoticed. */
  function oldAll(text: string, d: string): string {
    const rows = parseDsv(text, d).rows;
    return serializeDsv(rows.length > 0 ? rows : [['']], d).replace(/\n$/, '');
  }

  function oldColumn(text: string, d: string, c: number): string {
    const rows = parseDsv(text, d).rows;
    return (rows.length > 0 ? rows : [['']])
      .map((row) => serializeField(row[c] ?? '', d))
      .join('\n');
  }

  it.each(FIXTURES)('copies the whole table as before: %s', (_n, text, d) => {
    expect(copyAll(text, indexDsv(text, d), d)).toBe(oldAll(text, d));
  });

  it.each(FIXTURES)('copies a column as before: %s', (_n, text, d) => {
    for (const c of [0, 1, 5]) {
      expect(copyColumn(text, indexDsv(text, d), c, d)).toBe(
        oldColumn(text, d, c),
      );
    }
  });

  it('closes a quote the file never closed', () => {
    // Handing the raw text over would put invalid CSV on the clipboard and the
    // receiving application would read the tail as one field.
    const text = 'a,"b\nc';
    expect(copyAll(text, indexDsv(text, ','), ',')).toBe('a,"b\nc"');
  });

  it('normalises quoting, as the whole-document path did', () => {
    const text = '"a",b\n"c",d\n';
    expect(copyAll(text, indexDsv(text, ','), ',')).toBe('a,b\nc,d');
  });

  it('copies an empty document as one empty cell', () => {
    expect(copyAll('', indexDsv('', ','), ',')).toBe('');
    expect(copyColumn('', indexDsv('', ','), 0, ',')).toBe('');
  });
});
