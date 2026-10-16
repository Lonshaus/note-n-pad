// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  modeBlockedBy,
  defaultViewModeFor,
  previewCharLimit,
  viewModesFor,
} from './viewModes';

describe('viewModesFor', () => {
  it('offers the table view for delimiter-separated files, table first', () => {
    expect(viewModesFor('/tmp/a.csv', false)).toEqual(['table', 'source']);
    expect(viewModesFor('/tmp/a.tsv', false)).toEqual(['table', 'source']);
  });

  it('offers a preview for the three previewable formats, source first', () => {
    expect(viewModesFor('/tmp/a.json', false)).toEqual(['source', 'json']);
    expect(viewModesFor('/tmp/a.xml', false)).toEqual(['source', 'xml']);
    expect(viewModesFor('/tmp/a.md', false)).toEqual(['source', 'markdown']);
    expect(viewModesFor('/tmp/a.markdown', false)).toEqual([
      'source',
      'markdown',
    ]);
  });

  it('ignores extension case', () => {
    expect(viewModesFor('/tmp/NOTES.JSON', false)).toEqual(['source', 'json']);
    expect(viewModesFor('/tmp/DATA.CsV', false)).toEqual(['table', 'source']);
    expect(viewModesFor('/tmp/README.MD', false)).toEqual([
      'source',
      'markdown',
    ]);
  });

  it('offers nothing but source for anything else', () => {
    expect(viewModesFor('/tmp/a.txt', false)).toEqual(['source']);
    expect(viewModesFor('/tmp/a.jsonl', false)).toEqual(['source']);
    expect(viewModesFor('/tmp/a.mdx', false)).toEqual(['source']);
  });

  it('handles paths with no extension and no path at all', () => {
    expect(viewModesFor('/tmp/Makefile', false)).toEqual(['source']);
    expect(viewModesFor('', false)).toEqual(['source']);
    expect(viewModesFor(null, false)).toEqual(['source']);
  });

  it('does not treat a dotfile name as an extension', () => {
    // '.json' here is the whole file name, not a suffix — but it is also a
    // perfectly good JSON file, so it stays previewable. What must not happen
    // is a crash or an empty list.
    expect(viewModesFor('/tmp/.json', false)).toEqual(['source', 'json']);
    expect(viewModesFor('/tmp/.gitignore', false)).toEqual(['source']);
  });

  it('reads the extension after the last dot', () => {
    expect(viewModesFor('/tmp/archive.tar.json', false)).toEqual([
      'source',
      'json',
    ]);
    expect(viewModesFor('/tmp/json.txt', false)).toEqual(['source']);
  });
});

describe('defaultViewModeFor', () => {
  it('opens tabular files in the table view', () => {
    expect(defaultViewModeFor('/tmp/a.csv', false)).toBe('table');
  });

  it('opens previewable files in the editor, not the preview', () => {
    expect(defaultViewModeFor('/tmp/a.json', false)).toBe('source');
    expect(defaultViewModeFor('/tmp/a.md', false)).toBe('source');
  });

  it('falls back to source for everything else', () => {
    expect(defaultViewModeFor('/tmp/a.txt', false)).toBe('source');
    expect(defaultViewModeFor(null, false)).toBe('source');
  });
});

describe('modeBlockedBy', () => {
  const small = { windowed: false, length: 10 };
  const huge = { windowed: false, length: 500_000_000 };
  const windowed = { windowed: true, length: 10 };

  it('never blocks the editor itself', () => {
    expect(modeBlockedBy('source', small)).toBe(null);
    expect(modeBlockedBy('source', huge)).toBe(null);
    expect(modeBlockedBy('source', windowed)).toBe(null);
  });

  it('blocks every alternative view on a windowed tab, table included', () => {
    for (const mode of ['table', 'json', 'xml', 'markdown'] as const) {
      expect(modeBlockedBy(mode, windowed)).toBe('windowed');
    }
  });

  it('blocks previews past their own ceiling', () => {
    for (const mode of ['json', 'xml', 'markdown'] as const) {
      expect(modeBlockedBy(mode, huge)).toBe('too-large');
    }
  });

  it('holds each preview to its own ceiling, not a shared one', () => {
    // Markdown parses only what is on screen; JSON and XML still build the
    // whole document. A length that is fine for one is not fine for the other,
    // and one shared number could not say so.
    const between = { windowed: false, length: 30_000_000 };
    expect(modeBlockedBy('markdown', between)).toBe(null);
    expect(modeBlockedBy('json', between)).toBe('too-large');
    expect(modeBlockedBy('xml', between)).toBe('too-large');
  });

  it('never blocks the table view for size — it has no limit of its own', () => {
    expect(modeBlockedBy('table', huge)).toBe(null);
    expect(
      modeBlockedBy('table', { windowed: false, length: 500_000_000 }),
    ).toBe(null);
  });

  it('allows a preview exactly at its ceiling and blocks one past it', () => {
    for (const mode of ['json', 'xml', 'markdown'] as const) {
      const limit = previewCharLimit(mode);
      expect(modeBlockedBy(mode, { windowed: false, length: limit })).toBe(
        null,
      );
      expect(modeBlockedBy(mode, { windowed: false, length: limit + 1 })).toBe(
        'too-large',
      );
    }
  });

  it('reports the windowed reason when both rules would apply', () => {
    expect(
      modeBlockedBy('json', {
        windowed: true,
        length: 500_000_000,
      }),
    ).toBe('windowed');
  });

  it('leaves everything alone on an ordinary small document', () => {
    for (const mode of ['table', 'json', 'xml', 'markdown'] as const) {
      expect(modeBlockedBy(mode, small)).toBe(null);
    }
  });
});

describe('previewCharLimit', () => {
  it('keeps the measured ceiling for the formats that parse eagerly', () => {
    expect(previewCharLimit('json')).toBe(10_000_000);
    expect(previewCharLimit('xml')).toBe(10_000_000);
  });

  it('lets markdown past it, because nothing whole-document is built', () => {
    expect(previewCharLimit('markdown')).toBeGreaterThan(
      previewCharLimit('json'),
    );
  });

  it('has no ceiling for the views that are not previews', () => {
    expect(previewCharLimit('source')).toBe(Number.POSITIVE_INFINITY);
    expect(previewCharLimit('table')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('view modes in lite', () => {
  it('drop the JSON and XML tree views, whatever the extension case', () => {
    for (const path of ['/a.json', '/a.JSON', '/a.xml', '/a.Xml']) {
      expect(viewModesFor(path, false)).toHaveLength(2);
      expect(viewModesFor(path, true)).toEqual(['source']);
    }
  });

  it('keep the table and the Markdown preview', () => {
    expect(viewModesFor('/a.csv', true)).toEqual(['table', 'source']);
    expect(viewModesFor('/a.tsv', true)).toEqual(['table', 'source']);
    expect(viewModesFor('/a.md', true)).toEqual(['source', 'markdown']);
    expect(viewModesFor('/a.markdown', true)).toEqual(['source', 'markdown']);
  });

  it('open a table file in the table and the rest in the source', () => {
    expect(defaultViewModeFor('/a.csv', true)).toBe('table');
    expect(defaultViewModeFor('/a.json', true)).toBe('source');
  });
});
