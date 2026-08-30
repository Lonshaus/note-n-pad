// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** A parsed delimiter-separated document. `rows` holds every record as a list
 *  of raw field values; `trailingNewline` records whether the source ended on a
 *  record separator, so serialization can reproduce it. */
export interface ParsedDsv {
  rows: string[][];
  trailingNewline: boolean;
}

/** Options for {@link serializeDsv}. */
export interface SerializeOptions {
  /** Append a final LF when the source carried one. */
  trailingNewline?: boolean;
}

/**
 * Parse delimiter-separated text per RFC 4180 (leniently), matching Python's
 * csv module: quoted fields, escaped quotes (`""`), embedded delimiters/newlines
 * inside quotes, and either CRLF or LF as a record separator.
 *
 * A `"` is special ONLY as the first character of a field. A bare quote later in
 * an unquoted field (e.g. an inch mark, `5" nail`) is a literal character, so a
 * lone quote never accidentally swallows the following newline and merges two
 * records. After a quoted section closes, any trailing characters up to the next
 * delimiter/newline are appended literally. An unterminated quote is consumed to
 * EOF rather than throwing. Empty text yields no rows.
 */
export function parseDsv(text: string, delimiter: string): ParsedDsv {
  if (text === '') {
    return { rows: [], trailingNewline: false };
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // True until something is consumed for the current field; only then may a `"`
  // open a quoted section.
  let fresh = true;
  let trailingNewline = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === '"' && fresh) {
      inQuotes = true;
      fresh = false;
      i += 1;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      fresh = true;
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fresh = true;
      // A CRLF pair is a single record separator.
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 2;
      } else {
        i += 1;
      }
      if (i >= n) {
        trailingNewline = true;
      }
    } else {
      field += ch;
      fresh = false;
      i += 1;
    }
  }
  // Flush the trailing record unless the text already ended on a separator.
  if (!trailingNewline) {
    row.push(field);
    rows.push(row);
  }
  return { rows, trailingNewline };
}

/** Where every record starts, plus what a second pass would otherwise have to
 *  work out. Built for documents too large to hold as `string[][]`: at the
 *  100 MiB table ceiling `parseDsv` produces millions of field strings, while
 *  this is one `Uint32Array`. */
export interface DsvIndex {
  /** Offset of the first character of each record. One entry per record, so its
   *  length is the record count. */
  rowStarts: Uint32Array;
  /** Field count of the widest record, at least 1. The same value `widestRow`
   *  would return, counted during the scan rather than in a second pass. */
  colCount: number;
  /** Whether the text ended on a record separator. */
  trailingNewline: boolean;
}

/**
 * Anything the index can be built over: a plain string, or a rope that can hand
 * out a slice — CodeMirror's `Text` satisfies this structurally. The table view
 * passes the rope, so indexing a 100 MiB document never materialises it as one
 * JS string.
 */
export type DsvSource =
  | string
  | { readonly length: number; sliceString(from: number, to: number): string };

/** How much of a rope to pull in at a time while scanning. Large enough that the
 *  per-slice cost disappears, small enough to stay far below the document. */
const SOURCE_CHUNK = 64 * 1024;

function sliceOf(source: DsvSource, from: number, to: number): string {
  return typeof source === 'string'
    ? source.slice(from, to)
    : source.sliceString(from, to);
}

/** Growth start for the offset array. Doubling from here costs a handful of
 *  copies on a real table and wastes nothing on a small one. */
const ROW_INDEX_SEED = 1024;

/**
 * Scan `text` once and record where each record begins, applying exactly the
 * quoting rules {@link parseDsv} applies — a `"` is special only as a field's
 * first character, `""` escapes, CRLF and LF and lone CR all separate records,
 * an unterminated quote runs to EOF.
 *
 * The two must agree: `rowStarts.length` is `parseDsv(text).rows.length` and
 * `colCount` is `widestRow(rows, 1)` for the same input. `csv.test.ts` asserts
 * that on every fixture rather than trusting two state machines to stay in step
 * by inspection.
 */
export function indexDsv(source: DsvSource, delimiter: string): DsvIndex {
  const n = source.length;
  if (n === 0) {
    return {
      rowStarts: new Uint32Array(0),
      colCount: 1,
      trailingNewline: false,
    };
  }
  let capacity = ROW_INDEX_SEED;
  let starts = new Uint32Array(capacity);
  let count = 0;
  const startRow = (offset: number): void => {
    if (count === capacity) {
      capacity *= 2;
      const grown = new Uint32Array(capacity);
      grown.set(starts);
      starts = grown;
    }
    starts[count] = offset;
    count += 1;
  };

  startRow(0);
  let inQuotes = false;
  let fresh = true;
  let fields = 1;
  let colCount = 1;
  let trailingNewline = false;
  // A string is its own single chunk: `slice(0, n)` hands back the same
  // primitive, so the scan below is a plain indexed walk with no copying. A rope
  // is walked 64 KiB at a time.
  const stride = typeof source === 'string' ? n : SOURCE_CHUNK;
  let i = 0;
  while (i < n) {
    const base = i;
    const limit = Math.min(base + stride, n);
    // One character past the limit, so a lookahead from the last consumed
    // position still has something to read — that is where a CRLF pair or a
    // doubled quote straddling a chunk edge would otherwise be misread.
    const chunk = sliceOf(source, base, Math.min(limit + 1, n));
    while (i < limit) {
      const j = i - base;
      const ch = chunk[j]!;
      if (inQuotes) {
        if (ch === '"') {
          if (chunk[j + 1] === '"') {
            i += 2;
          } else {
            inQuotes = false;
            i += 1;
          }
        } else {
          i += 1;
        }
      } else if (ch === '"' && fresh) {
        inQuotes = true;
        fresh = false;
        i += 1;
      } else if (ch === delimiter) {
        fields += 1;
        fresh = true;
        i += 1;
      } else if (ch === '\n' || ch === '\r') {
        if (fields > colCount) {
          colCount = fields;
        }
        fields = 1;
        fresh = true;
        if (ch === '\r' && chunk[j + 1] === '\n') {
          i += 2;
        } else {
          i += 1;
        }
        // A separator at EOF closes the last record instead of opening a new
        // one, which is what `parseDsv` reports as `trailingNewline`.
        if (i >= n) {
          trailingNewline = true;
        } else {
          startRow(i);
        }
      } else {
        fresh = false;
        i += 1;
      }
    }
  }
  if (!trailingNewline && fields > colCount) {
    colCount = fields;
  }
  // `slice`, not `subarray`: the latter keeps the doubled-up buffer alive, and
  // the slack can be as large as the index itself.
  return { rowStarts: starts.slice(0, count), colCount, trailingNewline };
}

/**
 * The source text of record `row`, record separator excluded, ready to hand to
 * {@link parseDsv} on its own. Out-of-range rows give `''`.
 */
export function rowText(
  source: DsvSource,
  index: DsvIndex,
  row: number,
): string {
  const { rowStarts } = index;
  if (row < 0 || row >= rowStarts.length) {
    return '';
  }
  const start = rowStarts[row]!;
  const last = row + 1 === rowStarts.length;
  const end = last ? source.length : rowStarts[row + 1]!;
  let slice = sliceOf(source, start, end);
  // Every record but the last ends where the next one starts, which is past its
  // separator. The last one carries a separator only when the file ends on one:
  // trimming a trailing newline unconditionally eats content instead, from a
  // final field that opened a quote and never closed it.
  if (!last || index.trailingNewline) {
    if (slice.endsWith('\n')) {
      slice = slice.slice(0, -1);
    }
    if (slice.endsWith('\r')) {
      slice = slice.slice(0, -1);
    }
  }
  return slice;
}

/**
 * The fields of record `row`, parsed on demand from the index.
 *
 * A blank record gives `['']`: {@link parseDsv} yields no rows at all for empty
 * text, so without this a blank line would render as no cells instead of one
 * empty cell. Out-of-range rows give `['']` too, which is what an empty document
 * shows — one editable cell.
 */
export function rowFields(
  source: DsvSource,
  index: DsvIndex,
  row: number,
  delimiter: string,
): string[] {
  return parseDsv(rowText(source, index, row), delimiter).rows[0] ?? [''];
}

/**
 * The fields of records `[start, end)`, clamped to what the index holds. The
 * point of the whole index: a viewport's worth of rows is parsed instead of the
 * document.
 */
export function windowFields(
  source: DsvSource,
  index: DsvIndex,
  start: number,
  end: number,
  delimiter: string,
): string[][] {
  const first = Math.max(0, start);
  const last = Math.min(end, Math.max(index.rowStarts.length, 1));
  const out: string[][] = [];
  for (let r = first; r < last; r += 1) {
    out.push(rowFields(source, index, r, delimiter));
  }
  return out;
}

/** Replace `[from, to)` of the document with `insert`. What the table view hands
 *  back instead of a whole new document: an edit must not rewrite bytes it did
 *  not touch, or changing one cell re-quotes the entire file. */
export interface DsvChange {
  from: number;
  to: number;
  insert: string;
}

/** Half-open span of one field's raw source, quotes included. Replacing
 *  `"a,b"` means replacing all five characters; swapping only what is inside
 *  the quotes leaves an orphan pair behind. */
export interface FieldSpan {
  from: number;
  to: number;
}

/** Span of record `row`'s own text, separator excluded. An empty document
 *  reports one empty record at offset 0, which is the row the view shows. */
function recordSpan(
  source: DsvSource,
  index: DsvIndex,
  row: number,
): FieldSpan {
  const { rowStarts } = index;
  if (rowStarts.length === 0) {
    return { from: 0, to: 0 };
  }
  const from = rowStarts[row]!;
  return { from, to: from + rowText(source, index, row).length };
}

/** True for a row the view shows, including the phantom row of an empty file. */
function hasRow(index: DsvIndex, row: number): boolean {
  return row >= 0 && row < Math.max(index.rowStarts.length, 1);
}

/**
 * Where each field of record `row` starts and ends in the source, quotes
 * included. A blank record has one empty field, matching {@link rowFields}.
 * Rows the view does not show give `[]`.
 */
export function fieldSpans(
  source: DsvSource,
  index: DsvIndex,
  row: number,
  delimiter: string,
): FieldSpan[] {
  return scanRow(source, index, row, delimiter).spans;
}

/** Field spans plus whether the record ran out while still inside a quoted
 *  field. That only happens on a malformed file, and it matters in one place:
 *  text appended after such a field lands inside the quotes instead of after
 *  them, so the quote has to be closed first. */
function scanRow(
  source: DsvSource,
  index: DsvIndex,
  row: number,
  delimiter: string,
): { spans: FieldSpan[]; unterminated: boolean } {
  if (!hasRow(index, row)) {
    return { spans: [], unterminated: false };
  }
  const { from: base } = recordSpan(source, index, row);
  const text = rowText(source, index, row);
  const spans: FieldSpan[] = [];
  let start = 0;
  let inQuotes = false;
  let fresh = true;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        i += 1;
      }
    } else if (ch === '"' && fresh) {
      inQuotes = true;
      fresh = false;
      i += 1;
    } else if (ch === delimiter) {
      spans.push({ from: base + start, to: base + i });
      i += 1;
      start = i;
      fresh = true;
    } else {
      fresh = false;
      i += 1;
    }
  }
  spans.push({ from: base + start, to: base + text.length });
  return { spans, unterminated: inQuotes };
}

/**
 * Set one cell. Columns past the row's width are reached by adding the
 * delimiters that make them exist, which is what the grid version did by
 * padding with empty fields. `null` when the row is not one the view shows.
 */
export function setCellChange(
  source: DsvSource,
  index: DsvIndex,
  row: number,
  col: number,
  value: string,
  delimiter: string,
): DsvChange | null {
  const { spans, unterminated } = scanRow(source, index, row, delimiter);
  if (spans.length === 0 || col < 0) {
    return null;
  }
  const field = serializeField(value, delimiter);
  const target = spans[col];
  if (target !== undefined) {
    return { from: target.from, to: target.to, insert: field };
  }
  const end = spans[spans.length - 1]!.to;
  return {
    from: end,
    to: end,
    insert:
      (unterminated ? '"' : '') +
      delimiter.repeat(col - spans.length + 1) +
      field,
  };
}

/**
 * Insert a blank record, as wide as the widest record in the file. Appending
 * past the last row depends on how the file ends: a file that already ends on a
 * separator takes `record + separator`, one that does not takes
 * `separator + record`, so neither gains nor loses a trailing newline.
 */
export function insertRowChange(
  source: DsvSource,
  index: DsvIndex,
  at: number,
  delimiter: string,
): DsvChange {
  const blank = delimiter.repeat(index.colCount - 1);
  const rowCount = Math.max(index.rowStarts.length, 1);
  const target = Math.max(0, Math.min(at, rowCount));
  if (target < index.rowStarts.length) {
    const from = index.rowStarts[target]!;
    return { from, to: from, insert: `${blank}\n` };
  }
  const end = source.length;
  if (index.trailingNewline) {
    return { from: end, to: end, insert: `${blank}\n` };
  }
  // A file whose last field never closed its quote: the separator about to be
  // appended would land inside that field instead of after it, so close it
  // first. Only reachable on a malformed file, and only here — a file ending on
  // a separator cannot still be inside a quote.
  const last = Math.max(index.rowStarts.length, 1) - 1;
  const open = scanRow(source, index, last, delimiter).unterminated;
  return { from: end, to: end, insert: `${open ? '"' : ''}\n${blank}` };
}

/**
 * Delete a record. The last record of a file that does not end on a separator
 * takes the separator in front of it with it, so the file does not gain a
 * trailing newline it never had.
 */
export function deleteRowChange(
  source: DsvSource,
  index: DsvIndex,
  at: number,
): DsvChange | null {
  const { rowStarts } = index;
  if (rowStarts.length === 0 || at < 0 || at >= rowStarts.length) {
    return null;
  }
  const to = at + 1 < rowStarts.length ? rowStarts[at + 1]! : source.length;
  let from = rowStarts[at]!;
  if (at + 1 === rowStarts.length && at > 0 && !index.trailingNewline) {
    if (sliceOf(source, from - 1, from) === '\n') {
      from -= 1;
    }
    if (from > 0 && sliceOf(source, from - 1, from) === '\r') {
      from -= 1;
    }
  }
  return { from, to, insert: '' };
}

/**
 * Empty every field of a record, keeping its own width — which is that row's
 * field count, not the file's widest. `null` when there is nothing to change.
 */
export function clearRowChange(
  source: DsvSource,
  index: DsvIndex,
  row: number,
  delimiter: string,
): DsvChange | null {
  const spans = fieldSpans(source, index, row, delimiter);
  if (spans.length === 0) {
    return null;
  }
  const { from, to } = recordSpan(source, index, row);
  const insert = delimiter.repeat(spans.length - 1);
  if (sliceOf(source, from, to) === insert) {
    return null;
  }
  return { from, to, insert };
}

/** One field's raw text, or `''` when this record has no such field. Walks the
 *  record once without building a span list, which at table sizes is one array
 *  and a field's worth of objects per record that never has to exist. */
function rawField(text: string, col: number, delimiter: string): string {
  let field = 0;
  let start = 0;
  let inQuotes = false;
  let fresh = true;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        i += 1;
      }
    } else if (ch === '"' && fresh) {
      inQuotes = true;
      fresh = false;
      i += 1;
    } else if (ch === delimiter) {
      if (field === col) {
        return text.slice(start, i);
      }
      field += 1;
      i += 1;
      start = i;
      fresh = true;
    } else {
      fresh = false;
      i += 1;
    }
  }
  return field === col ? text.slice(start) : '';
}

/**
 * Whether a raw field is already exactly what serializing it would write, decided
 * without decoding it.
 *
 * Two shapes qualify. Text with no quote character at all: the delimiter cannot
 * appear in it (it would have had to be quoted) and neither can CR or LF, which
 * end a record, so serialization would leave it alone. And a properly closed
 * quoted field whose quotes are all doubled and whose contents actually need the
 * quotes — a field quoted for no reason is the case serialization rewrites.
 */
function fieldIsCanonical(
  text: string,
  from: number,
  to: number,
  delimiter: string,
): boolean {
  if (to - from < 2 || text[from] !== '"' || text[to - 1] !== '"') {
    // Without a quote to open it there is nothing serialization would change;
    // anything else that starts or ends with one is malformed.
    for (let i = from; i < to; i += 1) {
      if (text[i] === '"') {
        return false;
      }
    }
    return true;
  }
  let needsQuotes = false;
  let i = from + 1;
  const end = to - 1;
  while (i < end) {
    const ch = text[i]!;
    if (ch === '"') {
      // A lone quote inside means this is not a well-formed quoted field; the
      // closing quote it appeared to have belongs to something else.
      if (text[i + 1] !== '"' || i + 1 >= end) {
        return false;
      }
      needsQuotes = true;
      i += 2;
      continue;
    }
    if (ch === delimiter || ch === '\n' || ch === '\r') {
      needsQuotes = true;
    }
    i += 1;
  }
  return needsQuotes;
}

/** Whether a whole record is already exactly what serializing it would write.
 *  Walks it once and allocates nothing, so the common case of a record that
 *  needs no rewriting costs one scan. */
function rowIsCanonical(text: string, delimiter: string): boolean {
  let start = 0;
  let inQuotes = false;
  let fresh = true;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        i += 1;
      }
    } else if (ch === '"' && fresh) {
      inQuotes = true;
      fresh = false;
      i += 1;
    } else if (ch === delimiter) {
      if (!fieldIsCanonical(text, start, i, delimiter)) {
        return false;
      }
      i += 1;
      start = i;
      fresh = true;
    } else {
      fresh = false;
      i += 1;
    }
  }
  return fieldIsCanonical(text, start, text.length, delimiter);
}

/** A record re-emitted in serialized form, scanning it once. Each field is
 *  decided as it is passed, so no span list is built and no field is examined
 *  twice.
 *
 *  Kept per record on purpose: pushing every field and delimiter into one array
 *  for the whole document was measured slower and needed three times the memory,
 *  because the array grows by fields rather than by records. */
function rebuildRow(text: string, delimiter: string): string {
  const parts: string[] = [];
  let start = 0;
  let inQuotes = false;
  let fresh = true;
  let i = 0;
  const take = (to: number): void => {
    parts.push(
      fieldIsCanonical(text, start, to, delimiter)
        ? text.slice(start, to)
        : serializeField(
            parseDsv(text.slice(start, to), delimiter).rows[0]?.[0] ?? '',
            delimiter,
          ),
    );
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        i += 1;
      }
    } else if (ch === '"' && fresh) {
      inQuotes = true;
      fresh = false;
      i += 1;
    } else if (ch === delimiter) {
      take(i);
      i += 1;
      start = i;
      fresh = true;
    } else {
      fresh = false;
      i += 1;
    }
  }
  take(text.length);
  return parts.join(delimiter);
}

/** A raw field re-emitted the way serialization would write it, decoding only
 *  the fields that are not already in that form. */
function reserializeField(raw: string, delimiter: string): string {
  if (fieldIsCanonical(raw, 0, raw.length, delimiter)) {
    return raw;
  }
  return serializeField(parseDsv(raw, delimiter).rows[0]?.[0] ?? '', delimiter);
}

/**
 * The whole table as delimiter-separated text, for the clipboard.
 *
 * Re-serialized rather than handed over verbatim: a file whose last field never
 * closed its quote is not valid CSV, and the receiving application would read
 * the tail as one field. Built a record at a time, so the fields of one record
 * are the only ones alive at once — the point of the index.
 */
export function copyAll(
  source: DsvSource,
  index: DsvIndex,
  delimiter: string,
): string {
  const parts: string[] = [];
  for (const row of everyRow(index)) {
    const text = rowText(source, index, row);
    parts.push(
      rowIsCanonical(text, delimiter) ? text : rebuildRow(text, delimiter),
    );
  }
  // serializeDsv adds no trailing newline of its own; trim one defensively so
  // the copy carries no blank tail line.
  return parts.join('\n').replace(/\n$/, '');
}

/** One column as one quoted value per line, a record at a time. */
export function copyColumn(
  source: DsvSource,
  index: DsvIndex,
  col: number,
  delimiter: string,
): string {
  const parts: string[] = [];
  for (const row of everyRow(index)) {
    const text = rowText(source, index, row);
    parts.push(reserializeField(rawField(text, col, delimiter), delimiter));
  }
  return parts.join('\n');
}

/** Every row the view shows, for the operations that touch all of them. */
function everyRow(index: DsvIndex): number[] {
  const count = Math.max(index.rowStarts.length, 1);
  return Array.from({ length: count }, (_unused, r) => r);
}

/**
 * Insert a blank column at `at` in every record: one change per row, ascending,
 * so they never overlap. A record with fewer fields than `at` grows the
 * delimiters that make that column exist, which is what padding the grid did.
 */
export function insertColChange(
  source: DsvSource,
  index: DsvIndex,
  at: number,
  delimiter: string,
): DsvChange[] {
  if (at < 0) {
    return [];
  }
  const changes: DsvChange[] = [];
  for (const row of everyRow(index)) {
    const { spans, unterminated } = scanRow(source, index, row, delimiter);
    const target = spans[at];
    if (target !== undefined) {
      changes.push({ from: target.from, to: target.from, insert: delimiter });
      continue;
    }
    const end = spans[spans.length - 1]!.to;
    changes.push({
      from: end,
      to: end,
      insert:
        (unterminated ? '"' : '') + delimiter.repeat(at - spans.length + 1),
    });
  }
  return changes;
}

/**
 * Delete column `at` from every record that has it. The field leaves with one
 * delimiter: the one after it, or the one before it when it is the last field.
 * A record whose only field goes becomes empty. Records without that column
 * produce no change at all, rather than an empty one.
 */
export function deleteColChange(
  source: DsvSource,
  index: DsvIndex,
  at: number,
  delimiter: string,
): DsvChange[] {
  if (at < 0) {
    return [];
  }
  const changes: DsvChange[] = [];
  for (const row of everyRow(index)) {
    const spans = fieldSpans(source, index, row, delimiter);
    const target = spans[at];
    if (target === undefined) {
      continue;
    }
    const next = spans[at + 1];
    if (next !== undefined) {
      changes.push({ from: target.from, to: next.from, insert: '' });
    } else {
      const previous = spans[at - 1];
      const from = previous === undefined ? target.from : previous.to;
      changes.push({ from, to: target.to, insert: '' });
    }
  }
  return changes;
}

/** Empty column `c` in every record that has it, leaving the delimiters alone. */
export function clearColChange(
  source: DsvSource,
  index: DsvIndex,
  c: number,
  delimiter: string,
): DsvChange[] {
  if (c < 0) {
    return [];
  }
  const changes: DsvChange[] = [];
  for (const row of everyRow(index)) {
    const target = fieldSpans(source, index, row, delimiter)[c];
    if (target === undefined || target.from === target.to) {
      continue;
    }
    changes.push({ from: target.from, to: target.to, insert: '' });
  }
  return changes;
}

/** Empty every field of every record, each keeping its own width. */
export function clearAllChange(
  source: DsvSource,
  index: DsvIndex,
  delimiter: string,
): DsvChange[] {
  const changes: DsvChange[] = [];
  for (const row of everyRow(index)) {
    const change = clearRowChange(source, index, row, delimiter);
    if (change !== null) {
      changes.push(change);
    }
  }
  return changes;
}

/**
 * Serialize rows back to delimiter-separated text. A field is quoted only when
 * it contains the delimiter, a quote, CR or LF; quotes are always doubled.
 * Records join with LF to match the app's LF-normalized buffer.
 *
 * Parse then serialize preserves semantic content but normalizes quoting style;
 * the two documented non-identity cases are: (a) a lone empty field `[['']]`
 * serializes to `''` (unquoted, ambiguous), and (b) a field with a bare quote or
 * unnecessary quotes is re-emitted minimally quoted (e.g. `5" nail` -> `"5"" nail"`).
 * Both are quoting normalization, not data loss: re-parsing reaches a fixpoint.
 */
export function serializeDsv(
  rows: string[][],
  delimiter: string,
  options: SerializeOptions = {},
): string {
  const text = rows
    .map((row) => row.map((v) => serializeField(v, delimiter)).join(delimiter))
    .join('\n');
  if (options.trailingNewline === true && rows.length > 0) {
    return `${text}\n`;
  }
  return text;
}

/** Serialize a single field per RFC 4180: quote only when the value contains the
 *  delimiter, a quote, CR or LF; embedded quotes are doubled. Shared by
 *  {@link serializeDsv} and one-value-per-line column copies. */
export function serializeField(value: string, delimiter: string): string {
  const needsQuote =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r');
  if (needsQuote) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Return the delimiter a tabular file uses, or null for a non-tabular path.
 *  Untitled tabs (empty path) are never tabular. */
export function dsvDelimiterFor(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv')) {
    return ',';
  }
  if (lower.endsWith('.tsv')) {
    return '\t';
  }
  return null;
}

/** Set one cell, padding the target row with empty fields when it is short.
 *  Returns a new grid; out-of-range rows leave the grid unchanged. */
export function setCell(
  rows: string[][],
  r: number,
  c: number,
  value: string,
): string[][] {
  if (r < 0 || r >= rows.length) {
    return rows;
  }
  return rows.map((row, ri) => {
    if (ri !== r) {
      return row;
    }
    const next = row.slice();
    while (next.length <= c) {
      next.push('');
    }
    next[c] = value;
    return next;
  });
}

/** Widest row, at least `floor`. Reduced, not spread into `Math.max`: one
 *  argument per row overruns the engine's argument limit at table row counts. */
export function widestRow(rows: readonly string[][], floor: number): number {
  return rows.reduce((widest, row) => Math.max(widest, row.length), floor);
}

/** Insert a blank row (as wide as the widest existing row) at `at`. */
export function insertRow(rows: string[][], at: number): string[][] {
  const cols = rows.length > 0 ? widestRow(rows, 1) : 1;
  const blank = new Array<string>(cols).fill('');
  const next = rows.slice();
  next.splice(Math.max(0, Math.min(at, next.length)), 0, blank);
  return next;
}

/** Delete the row at `at`, or return the grid unchanged when out of range. */
export function deleteRow(rows: string[][], at: number): string[][] {
  if (at < 0 || at >= rows.length) {
    return rows;
  }
  const next = rows.slice();
  next.splice(at, 1);
  return next;
}

/** Insert a blank column at `at` in every row, padding short rows first. */
export function insertCol(rows: string[][], at: number): string[][] {
  return rows.map((row) => {
    const next = row.slice();
    while (next.length < at) {
      next.push('');
    }
    next.splice(at, 0, '');
    return next;
  });
}

/** Delete the column at `at` from every row that has it. */
export function deleteCol(rows: string[][], at: number): string[][] {
  return rows.map((row) => {
    if (at < 0 || at >= row.length) {
      return row;
    }
    const next = row.slice();
    next.splice(at, 1);
    return next;
  });
}

/** Clear every field of the row at `r` to an empty string, preserving its width.
 *  Out-of-range rows leave the grid unchanged. */
export function clearRow(rows: string[][], r: number): string[][] {
  if (r < 0 || r >= rows.length) {
    return rows;
  }
  return rows.map((row, ri) => (ri === r ? row.map(() => '') : row));
}

/** Clear the field at column `c` in every row that has it to an empty string. */
export function clearCol(rows: string[][], c: number): string[][] {
  return rows.map((row) => {
    if (c < 0 || c >= row.length) {
      return row;
    }
    const next = row.slice();
    next[c] = '';
    return next;
  });
}

/** Clear every field of every row to an empty string, preserving each row's
 *  width (and any raggedness). Returns a new grid. */
export function clearAll(rows: string[][]): string[][] {
  return rows.map((row) => row.map(() => ''));
}
