// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parser } from '@lezer/xml';
import {
  countChildren,
  endOfTag,
  findStructuralError,
  scanChildren,
  type ScanRange,
} from './xmlScan';

/** What `@lezer/xml`'s tree says the top-level children of a document are,
 *  mapped to the same shape `scanChildren` returns. Mirrors the prototype's
 *  cross-check (`scancheck.mjs`) exactly, which is what validated this
 *  approach in the first place. */
function lezerChildren(src: string): ScanRange[] {
  const tree = parser.parse(src);
  const out: ScanRange[] = [];
  const cursor = tree.cursor();
  if (!cursor.firstChild()) {
    return out;
  }
  do {
    const name = cursor.name;
    let kind: ScanRange['kind'] | null = null;
    if (name === 'Element') {
      kind = 'element';
    } else if (name === 'Comment') {
      kind = 'comment';
    } else if (name === 'Cdata') {
      kind = 'cdata';
    } else if (name === 'ProcessingInst') {
      kind = 'instruction';
    } else if (name === 'DoctypeDecl') {
      kind = 'doctype';
    } else if (
      name === 'Text' ||
      name === 'EntityReference' ||
      name === 'CharacterReference'
    ) {
      kind = 'text';
    }
    if (kind === 'text' && src.slice(cursor.from, cursor.to).trim() === '') {
      continue;
    }
    if (kind !== null) {
      out.push({ kind, from: cursor.from, to: cursor.to });
    }
  } while (cursor.nextSibling());
  return out;
}

/** The 13 adversarial cases from the prototype's `scancheck.mjs`, plus the
 *  real fixtures `scripts/e2e/e2e-view-mode.sh` writes (reproduced here
 *  rather than read from disk), plus cases the prototype did not cover. */
const AGREES_WITH_LEZER: Record<string, string> = {
  simple: '<root><a/><b>x</b></root>',
  'prolog + doctype': '<?xml version="1.0"?>\n<!DOCTYPE r>\n<r><a/></r>',
  'gt inside attribute': '<r a="x>y" b=\'p>q\'><c/></r>',
  'slash inside attribute': '<r a="x/"><c/></r>',
  'comment between': '<r><!-- c --><a/></r>',
  'cdata with tags': '<r><![CDATA[<a><b>]]><c/></r>',
  'nested same name': '<r><a><a><a/></a></a><b/></r>',
  'self closing nested': '<r><a><b/><b/></a></r>',
  'pi inside': '<r><?php echo 1;?><a/></r>',
  'text around': '<r>before<a/>after</r>',
  unclosed: '<r><a></r>',
  'attribute with newline': '<r><a\n  id="1"\n  x="2"/></r>',
  // Extra cases beyond the prototype's corpus.
  'nested CDATA-looking text': '<r><![CDATA[a<![CDATA[b]]>c]]></r>',
  'attribute value containing <': '<r a="1<2"><c/></r>',
  'comment containing a run of dashes': '<r><!-- pre---post --><a/></r>',
  'prolog only, no root element': '<?xml version="1.0"?>\n',
  'empty document': '',
  'whitespace-only document': '   \n\t  ',
  'deeply nested same-name elements': (() => {
    const depth = 40;
    return '<r>' + '<a>'.repeat(depth) + '<a/>' + '</a>'.repeat(depth) + '</r>';
  })(),
  // Real fixtures from scripts/e2e/e2e-view-mode.sh, reproduced verbatim.
  'doc.xml':
    '<root>\n  <item id="1" lang="zh">x</item>\n  <!-- note -->\n  <empty/>\n</root>\n',
  'named-error.xml':
    '<report>\n  <summary>valid</summary>\n  <parsererror>a field named that</parsererror>\n</report>\n',
  'hostile.xml':
    '<?xml version="1.0"?>\n' +
    '<root xmlns:h="http://www.w3.org/1999/xhtml">\n' +
    "  <h:script>window.__xmlPwned = 'script';</h:script>\n" +
    '  <h:img src="does-not-exist" onerror="window.__xmlPwned = \'img\'"/>\n' +
    '  <item onclick="window.__xmlPwned = \'click\'">plain text</item>\n' +
    '</root>\n',
};

describe('scanChildren agrees with @lezer/xml at the top level', () => {
  for (const [name, src] of Object.entries(AGREES_WITH_LEZER)) {
    it(name, () => {
      expect(scanChildren(src, 0, src.length).children).toEqual(
        lezerChildren(src),
      );
    });
  }
});

/** A shallow comparison at the top level is not enough by itself: an
 *  element whose *inner* boundary is wrong (say, a `>` inside a quoted
 *  attribute value mis-ending the open tag) can still land on the right
 *  overall `to` by coincidence, while every element nested inside it is
 *  wrong. So this recurses: every `element` range on both sides gets its
 *  own children compared too, all the way down. */
function deepScan(text: string, from: number, to: number): unknown[] {
  return scanChildren(text, from, to).children.map((c) => {
    if (c.kind !== 'element') {
      return { kind: c.kind, from: c.from, to: c.to, children: [] };
    }
    const tag = endOfTag(text, c.from, c.to);
    const contentFrom = tag?.end ?? c.to;
    const children =
      (tag?.self ?? true) ? [] : deepScan(text, contentFrom, c.to);
    return { kind: c.kind, from: c.from, to: c.to, children };
  });
}

function deepLezer(src: string): unknown[] {
  function childrenOf(node: {
    firstChild(): boolean;
    nextSibling(): boolean;
    parent(): boolean;
    name: string;
    from: number;
    to: number;
  }): unknown[] {
    const out: unknown[] = [];
    if (!node.firstChild()) {
      return out;
    }
    do {
      const name = node.name;
      let kind: ScanRange['kind'] | null = null;
      if (name === 'Element') {
        kind = 'element';
      } else if (name === 'Comment') {
        kind = 'comment';
      } else if (name === 'Cdata') {
        kind = 'cdata';
      } else if (name === 'ProcessingInst') {
        kind = 'instruction';
      } else if (name === 'DoctypeDecl') {
        kind = 'doctype';
      } else if (
        name === 'Text' ||
        name === 'EntityReference' ||
        name === 'CharacterReference'
      ) {
        kind = 'text';
      }
      if (kind === 'text' && src.slice(node.from, node.to).trim() === '') {
        continue;
      }
      if (kind === 'element') {
        const from = node.from;
        const to = node.to;
        const children = childrenOf(node);
        node.parent();
        out.push({ kind, from, to, children });
      } else if (kind !== null) {
        out.push({ kind, from: node.from, to: node.to, children: [] });
      }
    } while (node.nextSibling());
    return out;
  }
  return childrenOf(parser.parse(src).cursor());
}

// A subset of the corpus above where tag-boundary correctness (quotes,
// self-closing, same-name nesting) is the whole point of the case.
const DEEP_CASES = [
  'gt inside attribute',
  'slash inside attribute',
  'self closing nested',
  'nested same name',
  'cdata with tags',
  'attribute with newline',
  'deeply nested same-name elements',
  'hostile.xml',
];

describe('scanChildren agrees with @lezer/xml at every nesting level', () => {
  for (const name of DEEP_CASES) {
    it(name, () => {
      const src = AGREES_WITH_LEZER[name]!;
      expect(deepScan(src, 0, src.length)).toEqual(deepLezer(src));
    });
  }
});

describe('the one deliberate divergence: an internal DTD subset', () => {
  // @lezer/xml's grammar ends `DoctypeDecl` at the *first* '>', which lands
  // inside the subset (right after `<!ENTITY lol "lol">`) rather than at the
  // subset's real end. Everything past that point — the remaining entity
  // declarations, the `]>`, and the document's actual content — gets folded
  // into a stray `Text` node by lezer. That is a lezer bug, not a scanner
  // bug: this test states, deliberately, that the scanner's answer is the
  // one this app follows.
  const src =
    '<?xml version="1.0"?>\n' +
    '<!DOCTYPE lolz [\n' +
    ' <!ENTITY lol "lol">\n' +
    ' <!ENTITY lol2 "&lol;&lol;">\n' +
    ']>\n' +
    '<lolz>&lol2;</lolz>\n';

  it('the scanner keeps the whole doctype declaration as one span', () => {
    const children = scanChildren(src, 0, src.length).children;
    const doctype = children.find((c) => c.kind === 'doctype');
    expect(doctype).toBeDefined();
    expect(src.slice(doctype!.from, doctype!.to)).toBe(
      '<!DOCTYPE lolz [\n <!ENTITY lol "lol">\n <!ENTITY lol2 "&lol;&lol;">\n]>',
    );
    // The root element is a sibling of the doctype, not swallowed into a
    // stray text node the way lezer's misreading of the doctype produces.
    expect(children.map((c) => c.kind)).toEqual([
      'instruction',
      'doctype',
      'element',
    ]);
  });

  it('disagrees with lezer here, on purpose', () => {
    const mine = scanChildren(src, 0, src.length).children;
    const theirs = lezerChildren(src);
    expect(mine).not.toEqual(theirs);
    // lezer's own tree (walked directly, bypassing `lezerChildren`'s `text`
    // filter) shows the damage: it emits an error node right after the
    // truncated `DoctypeDecl`, where the rest of `<!ENTITY lol2 ...>` got
    // reinterpreted as element content instead of staying part of the
    // declaration.
    const cursor = parser.parse(src).cursor();
    const names: string[] = [];
    if (cursor.firstChild()) {
      do {
        names.push(cursor.name);
      } while (cursor.nextSibling());
    }
    expect(names).toContain('⚠');
    const lezerDoctype = names.indexOf('DoctypeDecl');
    expect(lezerDoctype).toBeGreaterThanOrEqual(0);
    // The scanner's declaration span covers the whole subset, including the
    // second `<!ENTITY>` lezer never got to.
    const doctype = mine.find((c) => c.kind === 'doctype')!;
    expect(src.slice(doctype.from, doctype.to)).toContain('lol2');
  });
});

// `countChildren` excludes `doctype` the same way `xml.ts`'s `isRowKind`
// does — a doctype is never a row, so a caller counting rows never counts
// it either. Raw `scanChildren` output still includes it, so the
// comparisons below filter it out first.
function rowEligible(children: readonly ScanRange[]): number {
  return children.filter((c) => c.kind !== 'doctype').length;
}

describe('countChildren matches a drained scanChildren', () => {
  for (const [name, src] of Object.entries(AGREES_WITH_LEZER)) {
    it(name, () => {
      expect(countChildren(src, 0, src.length)).toBe(
        rowEligible(scanChildren(src, 0, src.length).children),
      );
    });
  }

  it('matches at every nesting level too, not just the top', () => {
    function checkLevel(text: string, from: number, to: number): void {
      const children = scanChildren(text, from, to).children;
      expect(countChildren(text, from, to)).toBe(rowEligible(children));
      for (const child of children) {
        if (child.kind !== 'element') {
          continue;
        }
        const tag = endOfTag(text, child.from, child.to);
        if (tag !== null && !tag.self) {
          checkLevel(text, tag.end, child.to);
        }
      }
    }
    checkLevel(
      AGREES_WITH_LEZER['deeply nested same-name elements']!,
      0,
      AGREES_WITH_LEZER['deeply nested same-name elements']!.length,
    );
    checkLevel(
      AGREES_WITH_LEZER['hostile.xml']!,
      0,
      AGREES_WITH_LEZER['hostile.xml']!.length,
    );
  });
});

/** `endOfTag` boxes `scanTagEnd`'s internal scratch record into a fresh
 *  object per call specifically so a caller can hold onto more than one
 *  result at a time. This is the test that would catch a regression to
 *  returning the scratch object itself. */
describe('endOfTag results stay independent of each other', () => {
  it('a later call does not mutate an earlier live result', () => {
    const src = '<a></a><bb></bb>';
    const first = endOfTag(src, 0, src.length)!;
    expect(first.end).toBe(3);
    const second = endOfTag(src, 7, src.length)!;
    expect(second.end).toBe(11);
    // `first` must read exactly as it did before `second` was computed.
    expect(first.end).toBe(3);
    expect(first.close).toBe(false);
    expect(second.close).toBe(false);
  });
});

describe('findStructuralError', () => {
  it('is null for a well-formed document', () => {
    expect(findStructuralError('<root><a/><b>x</b></root>')).toBeNull();
  });

  it('finds a mismatched close tag', () => {
    const src = '<a><b></c></a>';
    expect(findStructuralError(src)?.from).toBe(6);
  });

  it('finds a close tag with no open element', () => {
    expect(findStructuralError('</a>')?.from).toBe(0);
  });

  it('finds an element never closed, reported at its own start', () => {
    const src = '<a><b>';
    expect(findStructuralError(src)?.from).toBe(3); // <b>'s own start
  });

  it('reports an empty document at offset 0', () => {
    expect(findStructuralError('')?.from).toBe(0);
  });

  it('does not flag a bare & in text, unlike @lezer/xml', () => {
    // See xml.test.ts for the documented reason: only structural damage is
    // in scope for this scanner.
    expect(findStructuralError('<a>x & y</a>')).toBeNull();
  });

  it('does not mistake CDATA content that looks like a doctype for one', () => {
    const src = '<root><![CDATA[<!DOCTYPE x [ ]]><a>hidden</a><b>]</b></root>';
    expect(findStructuralError(src)).toBeNull();
  });

  it('an entity-declaring internal subset is well-formed', () => {
    const src =
      '<?xml version="1.0"?>\n' +
      '<!DOCTYPE lolz [\n <!ENTITY lol "lol">\n]>\n' +
      '<lolz>&lol;</lolz>\n';
    expect(findStructuralError(src)).toBeNull();
  });
});
