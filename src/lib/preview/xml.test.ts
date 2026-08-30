// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import {
  childrenOf,
  childrenSlice,
  disposeXmlPreview,
  isIgnorableText,
  isRowOpen,
  parseXmlForPreview,
  visibleRowCount,
  visibleRows,
  type XmlNode,
} from './xml';

// Fixtures are real XML parsed by the real scan: anything else would test a
// hand-built tree rather than the one the app renders.
async function rootOf(source: string): Promise<XmlNode> {
  const parsed = await parseXmlForPreview(
    Text.of(source.split('\n')),
    () => false,
  );
  if (parsed === null || !parsed.ok) {
    throw new Error(`expected a clean parse of ${JSON.stringify(source)}`);
  }
  return parsed.root;
}

/** The rows the view actually renders: the `#document` wrapper is dropped. */
async function rowsOf(source: string): Promise<XmlNode[]> {
  return childrenOf(await rootOf(source));
}

async function errorOf(source: string) {
  const parsed = await parseXmlForPreview(
    Text.of(source.split('\n')),
    () => false,
  );
  if (parsed === null || parsed.ok) {
    throw new Error(`expected a syntax error in ${JSON.stringify(source)}`);
  }
  return parsed.error;
}

describe('node kinds', () => {
  it('maps every kind the view can draw', async () => {
    const root = await rootOf(
      '<?xml version="1.0"?>\n' +
        '<root>text<![CDATA[ raw ]]><!-- note --><?pi go now?><kid/></root>\n',
    );
    expect(root.kind).toBe('document');
    expect(root.value).toBeNull();
    const rows = childrenOf(root);
    expect(rows.map((r) => r.kind)).toEqual(['instruction', 'element']);
    expect(rows[0]?.name).toBe('xml');
    expect(rows[0]?.value).toBe('version="1.0"');

    const inside = childrenOf(rows[1]!);
    expect(inside.map((r) => r.kind)).toEqual([
      'text',
      'cdata',
      'comment',
      'instruction',
      'element',
    ]);
    expect(inside[0]?.value).toBe('text');
    expect(inside[1]?.value).toBe(' raw ');
    expect(inside[2]?.value).toBe(' note ');
    expect(inside[3]?.name).toBe('pi');
    expect(inside[3]?.value).toBe('go now');
    expect(inside[4]?.name).toBe('kid');
    expect(inside[4]?.value).toBeNull();
  });

  it('names an element the same whether or not it self-closes', async () => {
    expect((await rowsOf('<item/>'))[0]?.name).toBe('item');
    expect((await rowsOf('<item></item>'))[0]?.name).toBe('item');
  });
});

describe('attributes', () => {
  it('reads names and values, quotes stripped', async () => {
    const el = (await rowsOf('<item id="7" lang=\'zh\'/>'))[0];
    expect(el?.attributes).toEqual([
      { name: 'id', value: '7' },
      { name: 'lang', value: 'zh' },
    ]);
  });

  it('keeps a value that contains > and =', async () => {
    const el = (await rowsOf('<q test="a>b" eq=\'x=y>z\'/>'))[0];
    expect(el?.attributes).toEqual([
      { name: 'test', value: 'a>b' },
      { name: 'eq', value: 'x=y>z' },
    ]);
  });

  it('decodes only the predefined entities in a value', async () => {
    const el = (
      await rowsOf('<a t="&lt;&amp;&gt;&quot;&apos;&#65; &lol;"/>')
    )[0];
    expect(el?.attributes[0]?.value).toBe('<&>"\'A &lol;');
  });

  it('is empty for an element without attributes', async () => {
    expect((await rowsOf('<a/>'))[0]?.attributes).toEqual([]);
  });
});

describe('text', () => {
  it('skips whitespace-only text between elements', async () => {
    const rows = await rowsOf('<root>\n  <a/>\n  <b/>\n</root>');
    expect(childrenOf(rows[0]!).map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('keeps whitespace that is inside CDATA', async () => {
    const rows = childrenOf((await rowsOf('<root><![CDATA[   ]]></root>'))[0]!);
    expect(rows.map((r) => r.kind)).toEqual(['cdata']);
    expect(rows[0]?.value).toBe('   ');
  });

  it('merges a run of text and references into one row', async () => {
    // A DOM parser hands these over as a single text node; so does this.
    const rows = childrenOf((await rowsOf('<p>a &amp; b &#66; c</p>'))[0]!);
    expect(rows.map((r) => r.kind)).toEqual(['text']);
    expect(rows[0]?.value).toBe('a & b B c');
  });

  it('leaves an out-of-range character reference as typed', async () => {
    const rows = childrenOf((await rowsOf('<p>&#9999999999;</p>'))[0]!);
    expect(rows[0]?.value).toBe('&#9999999999;');
  });
});

describe('childrenOf', () => {
  it('walks nested levels one at a time', async () => {
    const root = (await rowsOf('<a><b><c/></b></a>'))[0]!;
    expect(root.childCount).toBe(1);
    const b = childrenOf(root)[0]!;
    expect(b.name).toBe('b');
    expect(b.childCount).toBe(1);
    expect(childrenOf(b).map((k) => k.name)).toEqual(['c']);
  });

  it('counts only the children it would render', async () => {
    const root = (await rowsOf('<root>\n  <kid/>\n</root>'))[0];
    expect(root?.childCount).toBe(1);
  });

  it('returns nothing for a node it never produced', () => {
    expect(
      childrenOf({
        kind: 'element',
        name: 'ghost',
        attributes: [],
        value: null,
        childCount: 3,
      }),
    ).toEqual([]);
  });

  it('returns nothing for a leaf', async () => {
    const text = childrenOf((await rowsOf('<p>hello</p>'))[0]!)[0]!;
    expect(text.kind).toBe('text');
    expect(childrenOf(text)).toEqual([]);
  });
});

describe('isIgnorableText', () => {
  it('is true only for whitespace-only text rows', async () => {
    const text = childrenOf((await rowsOf('<p>hello</p>'))[0]!)[0]!;
    expect(isIgnorableText(text)).toBe(false);
    expect(isIgnorableText({ ...text, value: ' \n\t ' })).toBe(true);
    expect(isIgnorableText({ ...text, kind: 'cdata', value: '  ' })).toBe(
      false,
    );
  });
});

describe('errors', () => {
  it('reports an unclosed element with a line and column', async () => {
    const error = await errorOf('<root>\n  <kid>\n</root>\n');
    expect(error.reason).toBe('syntax');
    expect(error.position).not.toBeNull();
    expect(error.position?.line).toBe(3);
    expect(error.position?.column).toBe(1);
    expect(error.message).toBe('</root>');
  });

  it('reports a mismatched close tag', async () => {
    const error = await errorOf('<a><b></c></a>');
    expect(error.position).toEqual({ line: 1, column: 7 });
  });

  it('does not flag a bare & in text as an error, unlike @lezer/xml', async () => {
    // @lezer/xml's grammar requires every `&` in content to start a
    // Reference production and reports a syntax error otherwise. This
    // module deliberately checks for less: only the three structural
    // problems a scan can see without a grammar (mismatched close tag, close
    // tag with no open element, element never closed) stop the preview.
    // `decodeReferences` already leaves a `&` that is not valid reference
    // syntax exactly as typed, so the text renders unharmed either way.
    const rows = await rowsOf('<a>x & y</a>');
    expect(rows[0]?.name).toBe('a');
    expect(childrenOf(rows[0]!)[0]?.value).toBe('x & y');
  });

  it('reports an empty document', async () => {
    expect((await errorOf('')).position).toEqual({ line: 1, column: 1 });
  });

  it('reports a close tag with no open element', async () => {
    const error = await errorOf('</a>');
    expect(error.position).toEqual({ line: 1, column: 1 });
  });

  it('reports the innermost element still open at end of document', async () => {
    const error = await errorOf('<a><b>');
    expect(error.position).toEqual({ line: 1, column: 4 }); // <b>'s own start
  });

  it('does not mistake an element named parsererror for one', async () => {
    // A lint log or an XSLT corpus may legitimately carry this name. The old
    // DOM path needed a namespace check to tell the two apart; this path has no
    // way to confuse them, and this test is what keeps it that way.
    const rows = await rowsOf(
      '<report><parsererror>a field named that</parsererror></report>',
    );
    expect(rows[0]?.name).toBe('report');
    const inner = childrenOf(rows[0]!)[0];
    expect(inner?.name).toBe('parsererror');
    expect(childrenOf(inner!)[0]?.value).toBe('a field named that');
  });
});

describe('declared entities', () => {
  const BOMB =
    '<?xml version="1.0"?>\n' +
    '<!DOCTYPE lolz [\n' +
    ' <!ENTITY lol "lol">\n' +
    ' <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">\n' +
    ' <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">\n' +
    ']>\n' +
    '<lolz>&lol3;</lolz>\n';

  it('parses a document that declares its own entities', async () => {
    const rows = await rowsOf(BOMB);
    const lolz = rows.find((r) => r.name === 'lolz');
    expect(lolz).toBeDefined();
  });

  it('renders a declared entity reference as the literal text', async () => {
    // The whole reason this module dropped `DOMParser`: expansion happened
    // inside the parser, before any size check could run. Nothing here resolves
    // a declared entity, so the document is boring rather than fatal.
    const rows = await rowsOf(BOMB);
    const lolz = rows.find((r) => r.name === 'lolz')!;
    const text = childrenOf(lolz)[0];
    expect(text?.kind).toBe('text');
    expect(text?.value).toBe('&lol3;');
  });

  it('does not skip content that merely reads like a doctype', async () => {
    // The subset is left out of the parse by range, so mistaking content for
    // one would swallow whatever markup sits between the brackets — here a
    // whole element. Only a prolog may precede a real doctype.
    const rows = await rowsOf(
      '<root><![CDATA[<!DOCTYPE x [ ]]><a>hidden</a><b>]</b></root>',
    );
    const inside = childrenOf(rows[0]!);
    expect(inside.map((r) => r.kind)).toEqual(['cdata', 'element', 'element']);
    expect(childrenOf(inside[1]!)[0]?.value).toBe('hidden');
  });

  it('keeps the whole output proportional to the source', async () => {
    const rows = await rowsOf(BOMB);
    let chars = 0;
    walk(rows, (node) => {
      chars += node.name.length + (node.value ?? '').length;
      for (const attr of node.attributes) {
        chars += attr.name.length + attr.value.length;
      }
    });
    // Expanded, `&lol3;` alone is a thousand characters; unexpanded, the whole
    // tree is smaller than the file.
    expect(chars).toBeLessThan(BOMB.length);
  });
});

describe('the shape the view sees', () => {
  it('is strings, numbers and arrays of them, nothing else', async () => {
    // The point of the layer: a rendered row cannot reach a parser node.
    const rows = await rowsOf(
      '<root a="1">text<![CDATA[x]]><!-- c --><?pi d?><kid k="2"/></root>',
    );
    let seen = 0;
    walk(rows, (node) => {
      seen += 1;
      for (const value of Object.values(node)) {
        const type = typeof value;
        expect(
          type === 'string' ||
            type === 'number' ||
            type === 'boolean' ||
            value === null ||
            Array.isArray(value),
        ).toBe(true);
      }
      expect(JSON.parse(JSON.stringify(node))).toEqual(node);
    });
    expect(seen).toBeGreaterThan(5);
  });
});

describe('cancellation', () => {
  it('drops the result when the document has moved on', async () => {
    const source = '<root><item id="1">x</item></root>';
    expect(
      await parseXmlForPreview(Text.of(source.split('\n')), () => true),
    ).toBeNull();
  });
});

/** A root with `n` numbered, unattributed sibling elements — a stand-in for
 *  the 115,556-child document that motivated virtualization, kept small
 *  enough to parse fast in a test. */
async function wideRoot(n: number): Promise<XmlNode> {
  let kids = '';
  for (let i = 0; i < n; i += 1) {
    kids += `<i${i}/>`;
  }
  return (await rowsOf(`<root>${kids}</root>`))[0]!;
}

describe('childrenSlice', () => {
  it('returns exactly the requested range and agrees with childrenOf for a small tree', async () => {
    const root = (await rowsOf('<root><a/><b/><c/><d/></root>'))[0]!;
    const all = childrenOf(root);
    expect(childrenSlice(root, 1, 3).map((n) => n.name)).toEqual(
      all.slice(1, 3).map((n) => n.name),
    );
    expect(childrenSlice(root, 0, 4).map((n) => n.name)).toEqual(
      all.map((n) => n.name),
    );
  });

  it('returns an empty range for from >= to, and clamps past the end', async () => {
    const root = (await rowsOf('<root><a/><b/></root>'))[0]!;
    expect(childrenSlice(root, 1, 1)).toEqual([]);
    expect(childrenSlice(root, 1, 10).map((n) => n.name)).toEqual(['b']);
  });

  it('returns nothing for a node it never produced', () => {
    expect(
      childrenSlice(
        {
          kind: 'element',
          name: 'ghost',
          attributes: [],
          value: null,
          childCount: 3,
        },
        0,
        3,
      ),
    ).toEqual([]);
  });

  it('slices a distant range of a wide root without walking the whole thing', async () => {
    const n = 2000;
    const root = await wideRoot(n);
    expect(root.childCount).toBe(n);
    const start = performance.now();
    const tail = childrenSlice(root, n - 10, n);
    const elapsed = performance.now() - start;
    expect(tail.map((k) => k.name)).toEqual(
      Array.from({ length: 10 }, (_unused, i) => `i${n - 10 + i}`),
    );
    // Not a hard perf assertion, just a sanity check that this stayed a slice
    // and not a full walk-and-convert of all 2000 children.
    expect(elapsed).toBeLessThan(500);
  });
});

describe('visibleRowCount', () => {
  it('counts a collapsed subtree as one row', async () => {
    const roots = childrenOf(await rootOf('<a><b><c/></b></a>'));
    // Depth 0 defaults open, depth 1+ defaults closed: <a> shows, <b> is a
    // single collapsed row, <c> is never counted individually beyond that.
    expect(visibleRowCount(roots, new Set())).toBe(2);
  });

  it('adds the real count of a toggled-open descendant instead of one', async () => {
    const roots = childrenOf(await rootOf('<a><b><c/><d/></b></a>'));
    // <a> (row 0) then <b> (row 1, closed) = 2 rows.
    expect(visibleRowCount(roots, new Set())).toBe(2);
    // Opening <b> (path "0.0": first child of root 0) adds its own 2 children.
    expect(visibleRowCount(roots, new Set(['0.0']))).toBe(4);
  });

  it('closing a depth-0 root drops its subtree to one row', async () => {
    const roots = childrenOf(await rootOf('<a><b/><c/></a>'));
    expect(visibleRowCount(roots, new Set())).toBe(3);
    expect(visibleRowCount(roots, new Set(['0']))).toBe(1);
  });

  it('a node with a large childCount contributes childCount rows without materializing them', async () => {
    const n = 5000;
    const root = await wideRoot(n);
    const start = performance.now();
    const count = visibleRowCount([root], new Set());
    const elapsed = performance.now() - start;
    // root itself is depth 0 (open by default) with n collapsed children.
    expect(count).toBe(1 + n);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('visibleRows (locating a row by flat index)', () => {
  it('matches a hand-flattened list for a small tree with one expanded branch', async () => {
    const roots = childrenOf(await rootOf('<a><b><c/><d/></b><e/></a>'));
    const toggled = new Set(['0.0']); // open <b>
    const total = visibleRowCount(roots, toggled);
    // 0: a, 1: b, 2: c, 3: d, 4: e
    expect(total).toBe(5);
    const names = ['a', 'b', 'c', 'd', 'e'];
    const depths = [0, 1, 2, 2, 1];
    for (let i = 0; i < total; i += 1) {
      const row = visibleRows(roots, toggled, i, i + 1)[0]!;
      expect(row.node.name).toBe(names[i]);
      expect(row.depth).toBe(depths[i]);
    }
  });

  it('locates a row deep inside a collapsed run after a toggled-open sibling, without scanning up to it', async () => {
    // Build: root -> [open0 (with 3 kids), 3000 plain siblings...]
    let kids = '<open0><k0/><k1/><k2/></open0>';
    const n = 3000;
    for (let i = 0; i < n; i += 1) {
      kids += `<i${i}/>`;
    }
    const root = (await rowsOf(`<root>${kids}</root>`))[0]!;
    const roots = [root];
    const toggled = new Set(['0.0']); // open <open0>
    // Rows: 0 root, 1 open0, 2-4 k0..k2, 5.. i0..i2999.
    const target = 5 + (n - 1); // last plain sibling, i2999
    const start = performance.now();
    const row = visibleRows(roots, toggled, target, target + 1)[0]!;
    const elapsed = performance.now() - start;
    expect(row.node.name).toBe(`i${n - 1}`);
    expect(row.depth).toBe(1);
    expect(elapsed).toBeLessThan(200);
  });

  it('a range request returns exactly that many rows in order', async () => {
    const roots = childrenOf(await rootOf('<a><b/><c/><d/><e/></a>'));
    const rows = visibleRows(roots, new Set(), 1, 4);
    expect(rows.map((r) => r.node.name)).toEqual(['b', 'c', 'd']);
  });
});

describe('expansion state keyed by path', () => {
  it('survives the rows being rebuilt from a fresh parse', async () => {
    const source = '<a><b><c/></b></a>';
    const rootsA = childrenOf(await rootOf(source));
    const toggled = new Set(['0.0']); // path, not identity
    expect(visibleRowCount(rootsA, toggled)).toBe(3);

    // A completely separate parse: none of these XmlNode objects are the same
    // ones `toggled` was built against.
    const rootsB = childrenOf(await rootOf(source));
    expect(rootsB[0]).not.toBe(rootsA[0]);
    expect(visibleRowCount(rootsB, toggled)).toBe(3);
    const row = visibleRows(rootsB, toggled, 1, 2)[0]!;
    expect(row.node.name).toBe('b');
    expect(isRowOpen(row.path, row.depth, toggled)).toBe(true);
  });

  it('isRowOpen: depth 0 defaults open, deeper defaults closed, toggling flips either', () => {
    const toggled = new Set(['0', '1.2']);
    expect(isRowOpen('0', 0, toggled)).toBe(false); // toggled closed
    expect(isRowOpen('1', 0, toggled)).toBe(true); // default open
    expect(isRowOpen('1.2', 1, toggled)).toBe(true); // toggled open
    expect(isRowOpen('1.3', 1, toggled)).toBe(false); // default closed
  });
});

describe('the shape virtualization adds is still just data', () => {
  it('childrenSlice and visibleRows rows stay JSON round-trippable', async () => {
    const root = (
      await rowsOf(
        '<root a="1">text<![CDATA[x]]><!-- c --><?pi d?><kid k="2"/></root>',
      )
    )[0]!;
    const sliced = childrenSlice(root, 0, root.childCount);
    for (const node of sliced) {
      expect(JSON.parse(JSON.stringify(node))).toEqual(node);
    }
    const rows = visibleRows([root], new Set(), 0, root.childCount);
    for (const row of rows) {
      expect(typeof row.path).toBe('string');
      expect(typeof row.depth).toBe('number');
      expect(JSON.parse(JSON.stringify(row.node))).toEqual(row.node);
    }
  });
});

describe('disposeXmlPreview', () => {
  it('releases for every node, not just the root', async () => {
    const root = await rootOf('<a><b><c/></b></a>');
    const a = childrenOf(root)[0]!;
    const b = childrenOf(a)[0]!;
    disposeXmlPreview(root);
    expect(childrenOf(root)).toEqual([]);
    expect(childrenOf(a)).toEqual([]);
    expect(childrenOf(b)).toEqual([]);
  });

  it('does not walk a document that is no longer there', async () => {
    const root = await rootOf('<a><b/><c/></a>');
    disposeXmlPreview(root);
    expect(childrenSlice(root, 0, 2)).toEqual([]);
  });

  it('is idempotent, and harmless on a stray node', async () => {
    const root = await rootOf('<a/>');
    disposeXmlPreview(root);
    expect(() => {
      disposeXmlPreview(root);
    }).not.toThrow();
    expect(() => {
      disposeXmlPreview({
        kind: 'element',
        name: 'ghost',
        attributes: [],
        value: null,
        childCount: 0,
      });
    }).not.toThrow();
  });

  it('leaves another open preview of the same text alone', async () => {
    const source = '<a><b/></a>';
    const rootA = await rootOf(source);
    const rootB = await rootOf(source);
    disposeXmlPreview(rootA);
    expect(childrenOf(rootA)).toEqual([]);
    expect(childrenOf(rootB).map((n) => n.name)).toEqual(['a']);
  });
});

function walk(nodes: XmlNode[], visit: (node: XmlNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(childrenOf(node), visit);
  }
}
