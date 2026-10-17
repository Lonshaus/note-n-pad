// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import {
  childrenOf,
  parseXmlForPreview,
  visibleRowCount,
  visibleRows,
} from './xml';
import type { XmlNode, XmlNodeKind } from './xml';
import { xmlNodeLabel, xmlViewText } from './xmlText';

async function rootsOf(source: string) {
  const parsed = await parseXmlForPreview(
    Text.of(source.split('\n')),
    () => false,
  );
  if (parsed === null || !parsed.ok) {
    throw new Error('expected a clean parse');
  }
  return childrenOf(parsed.root);
}
/** The whole view's text, the way the view builds it: every visible row. */
async function viewText(
  source: string,
  toggled: ReadonlySet<string> = new Set(),
): Promise<string> {
  const roots = await rootsOf(source);
  const count = visibleRowCount(roots, toggled);
  return xmlViewText(visibleRows(roots, toggled, 0, count), toggled);
}

describe('xmlViewText', () => {
  it('shows tags, attributes, indentation and a collapsed child count', async () => {
    const text = await viewText(
      '<?xml version="1.0"?>\n<root a="1" b="2"><kid>x</kid><!-- hi --></root>\n',
    );
    expect(text.split('\n')).toEqual([
      '<?xml?> version="1.0"',
      '<root> a="1" b="2"',
      '  <kid> 1',
      '  <!-- -->  hi ',
    ]);
  });

  it('shows the children of an expanded row and drops the count', async () => {
    const text = await viewText(
      '<root><kid>x</kid></root>\n',
      new Set(['0.0']),
    );
    expect(text.split('\n')).toEqual(['<root>', '  <kid>', '    x']);
  });

  it('covers every row of a document many screens long', async () => {
    const items = Array.from(
      { length: 600 },
      (_, i) => `<item id="${i}">v${i}</item>`,
    );
    const text = await viewText(`<root>${items.join('')}</root>\n`);
    const lines = text.split('\n');
    expect(lines).toHaveLength(601);
    expect(lines[0]).toBe('<root>');
    expect(lines[1]).toBe('  <item> id="0" 1');
    expect(lines[600]).toBe('  <item> id="599" 1');
  });
});

describe('xmlNodeLabel', () => {
  function node(kind: XmlNodeKind, name = ''): XmlNode {
    return { kind, name, attributes: [], value: null, childCount: 0 };
  }

  it('labels every kind of row', () => {
    expect(xmlNodeLabel(node('element', 'root'))).toBe('<root>');
    expect(xmlNodeLabel(node('instruction', 'xml'))).toBe('<?xml?>');
    expect(xmlNodeLabel(node('comment'))).toBe('<!-- -->');
    expect(xmlNodeLabel(node('cdata'))).toBe('CDATA');
    expect(xmlNodeLabel(node('document'))).toBe('#document');
    expect(xmlNodeLabel(node('text'))).toBe('');
  });
});
