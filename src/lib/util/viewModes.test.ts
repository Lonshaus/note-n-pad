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
    expect(viewModesFor('/tmp/a.csv')).toEqual(['table', 'source']);
    expect(viewModesFor('/tmp/a.tsv')).toEqual(['table', 'source']);
  });

  it('offers a preview for the three previewable formats, source first', () => {
    expect(viewModesFor('/tmp/a.json')).toEqual(['source', 'json']);
    expect(viewModesFor('/tmp/a.xml')).toEqual(['source', 'xml']);
    expect(viewModesFor('/tmp/a.md')).toEqual(['source', 'markdown']);
    expect(viewModesFor('/tmp/a.markdown')).toEqual(['source', 'markdown']);
  });

  it('ignores extension case', () => {
    expect(viewModesFor('/tmp/NOTES.JSON')).toEqual(['source', 'json']);
    expect(viewModesFor('/tmp/DATA.CsV')).toEqual(['table', 'source']);
    expect(viewModesFor('/tmp/README.MD')).toEqual(['source', 'markdown']);
  });

  it('offers nothing but source for anything else', () => {
    expect(viewModesFor('/tmp/a.txt')).toEqual(['source']);
    expect(viewModesFor('/tmp/a.jsonl')).toEqual(['source']);
    expect(viewModesFor('/tmp/a.mdx')).toEqual(['source']);
  });

  it('handles paths with no extension and no path at all', () => {
    expect(viewModesFor('/tmp/Makefile')).toEqual(['source']);
    expect(viewModesFor('')).toEqual(['source']);
    expect(viewModesFor(null)).toEqual(['source']);
  });

  it('does not treat a dotfile name as an extension', () => {
    // '.json' here is the whole file name, not a suffix — but it is also a
    // perfectly good JSON file, so it stays previewable. What must not happen
    // is a crash or an empty list.
    expect(viewModesFor('/tmp/.json')).toEqual(['source', 'json']);
    expect(viewModesFor('/tmp/.gitignore')).toEqual(['source']);
  });

  it('reads the extension after the last dot', () => {
    expect(viewModesFor('/tmp/archive.tar.json')).toEqual(['source', 'json']);
    expect(viewModesFor('/tmp/json.txt')).toEqual(['source']);
  });
});

describe('defaultViewModeFor', () => {
  it('opens tabular files in the table view', () => {
    expect(defaultViewModeFor('/tmp/a.csv')).toBe('table');
  });

  it('opens previewable files in the editor, not the preview', () => {
    expect(defaultViewModeFor('/tmp/a.json')).toBe('source');
    expect(defaultViewModeFor('/tmp/a.md')).toBe('source');
  });

  it('falls back to source for everything else', () => {
    expect(defaultViewModeFor('/tmp/a.txt')).toBe('source');
    expect(defaultViewModeFor(null)).toBe('source');
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
