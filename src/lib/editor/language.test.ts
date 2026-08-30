// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import {
  detectByContent,
  detectByFilename,
  docHasLongLine,
  fileExtension,
  LONG_LINE_THRESHOLD,
  nextLongLineState,
  restoredLanguage,
} from './language';

describe('fileExtension', () => {
  const cases: [string, string | null][] = [
    ['/a/b/foo.rs', 'rs'],
    ['C:\\x\\foo.TS', 'ts'],
    ['README.md', 'md'],
    ['foo.tar.gz', 'gz'],
    ['noext', null],
    ['.bashrc', null],
    ['', null],
  ];
  it.each(cases)('%s -> %s', (path, expected) => {
    expect(fileExtension(path)).toBe(expected);
  });
});

describe('detectByFilename', () => {
  const cases: [string, string | null][] = [
    ['/a/b/main.rs', 'Rust'],
    ['app.ts', 'TypeScript'],
    ['index.html', 'HTML'],
    ['data.json', 'JSON'],
    ['README.md', 'Markdown'],
    ['script.PY', 'Python'],
    ['noext', null],
    ['archive.zzz', null],
  ];
  it.each(cases)('%s -> %s', (path, expected) => {
    expect(detectByFilename(path)).toBe(expected);
  });
});

describe('detectByContent', () => {
  const cases: [string, string, string | null][] = [
    ['bash shebang', '#!/bin/bash\necho hi\n', 'Shell'],
    ['sh shebang', '#!/bin/sh\nls\n', 'Shell'],
    ['python env shebang', '#!/usr/bin/env python\nprint(1)\n', 'Python'],
    ['python3 shebang', '#!/usr/bin/python3\nx = 1\n', 'Python'],
    ['node shebang', '#!/usr/bin/env node\nconsole.log(1)\n', 'JavaScript'],
    ['xml declaration', '<?xml version="1.0"?>\n<root/>\n', 'XML'],
    ['doctype html', '<!DOCTYPE html>\n<html></html>\n', 'HTML'],
    ['html tag', '<html lang="en"></html>\n', 'HTML'],
    ['json object', '{\n  "a": 1,\n  "b": [2, 3]\n}\n', 'JSON'],
    ['json array', '[1, 2, 3]', 'JSON'],
    ['markdown heading + list', '# Title\n\n- one\n- two\n', 'Markdown'],
    ['markdown heading + fence', '## Section\n\n```js\nx\n```\n', 'Markdown'],
    ['rust fn main', 'fn main() {\n    println!("hi");\n}\n', 'Rust'],
    ['rust use std', 'use std::collections::HashMap;\n', 'Rust'],
    ['python import', 'import os\nimport sys\n', 'Python'],
    ['python def', 'def greet(name):\n    return name\n', 'Python'],
    [
      'typescript annotation',
      "import { x } from './x';\nconst n: string = 'a';\n",
      'TypeScript',
    ],
    [
      'typescript interface',
      'interface Foo {\n  a: number;\n}\n',
      'TypeScript',
    ],
    ['javascript import', "import x from './x';\nx();\n", 'JavaScript'],
    ['javascript arrow', 'const add = (a, b) => a + b;\n', 'JavaScript'],
    ['css block', 'body {\n  color: red;\n  margin: 0;\n}\n', 'CSS'],
    // Ambiguous / plain text -> null.
    ['empty', '', null],
    ['whitespace', '   \n\n', null],
    ['prose', 'The quick brown fox jumps over the lazy dog.\n', null],
    ['bare heading no cue', '# Just a title\nsome prose here\n', null],
    ['broken json', '{ not valid json', null],
    ['random symbols', '<< >> == !!\n', null],
  ];
  it.each(cases)('%s', (_name, content, expected) => {
    expect(detectByContent(content)).toBe(expected);
  });
});

describe('restoredLanguage', () => {
  it('re-detects from filename when the tab was never set by hand', () => {
    expect(restoredLanguage('Python', false, 'Rust')).toBe('Rust');
    expect(restoredLanguage(null, false, 'Rust')).toBe('Rust');
  });
  it('keeps a manual choice verbatim, ignoring detection', () => {
    expect(restoredLanguage('Python', true, 'Rust')).toBe('Python');
  });
  it('keeps a manual plain-text choice (null) instead of re-detecting', () => {
    expect(restoredLanguage(null, true, 'Rust')).toBe(null);
  });
});

describe('detectByFilename tabular labels', () => {
  it('labels .csv and .tsv as display-only languages', () => {
    expect(detectByFilename('/tmp/data.csv')).toBe('CSV');
    expect(detectByFilename('/tmp/data.TSV')).toBe('TSV');
  });
});

describe('docHasLongLine', () => {
  it('load detection: a single over-threshold line trips the gate', () => {
    const doc = Text.of(['a'.repeat(LONG_LINE_THRESHOLD + 1)]);
    expect(docHasLongLine(doc)).toBe(true);
  });
  it('a line exactly at the threshold does not trip the gate', () => {
    const doc = Text.of(['a'.repeat(LONG_LINE_THRESHOLD)]);
    expect(docHasLongLine(doc)).toBe(false);
  });
  it('mixed lines: one long line among short ones trips the gate', () => {
    const doc = Text.of(['short', 'a'.repeat(LONG_LINE_THRESHOLD + 5), 'tail']);
    expect(docHasLongLine(doc)).toBe(true);
  });
  it('an all-short document leaves the gate off', () => {
    expect(docHasLongLine(Text.of(['abc', 'def', 'ghi']))).toBe(false);
  });
});

describe('nextLongLineState', () => {
  const never = (): boolean => {
    throw new Error('rescan should not run');
  };
  it('edit adds a long line: the gate turns on without a rescan', () => {
    expect(
      nextLongLineState(false, LONG_LINE_THRESHOLD + 1, 0, false, never),
    ).toBe(true);
  });
  it('typing into an existing long line keeps the gate on without a rescan', () => {
    expect(
      nextLongLineState(true, LONG_LINE_THRESHOLD + 2, 0, false, never),
    ).toBe(true);
  });
  it('insertion elsewhere while a long line remains keeps the gate on', () => {
    // Touched lines short, nothing removed, no line break -> long line untouched.
    expect(nextLongLineState(true, 10, 0, false, never)).toBe(true);
  });
  it('a long line shortened back under the threshold lifts the gate', () => {
    // Touched line now short, characters removed -> rescan finds no long line.
    expect(nextLongLineState(true, 50, 100, false, () => false)).toBe(false);
  });
  it('shortening one long line while another remains keeps the gate on', () => {
    expect(nextLongLineState(true, 50, 100, false, () => true)).toBe(true);
  });
  it('an edit that keeps every line short leaves the gate off', () => {
    expect(nextLongLineState(false, 20, 5, false, never)).toBe(false);
  });
  it('Enter splitting the only long line lifts the gate (rescan)', () => {
    // Newline inserted (removed 0), both halves now short, no other long line.
    expect(nextLongLineState(true, 7500, 0, true, () => false)).toBe(false);
  });
  it('Enter splitting one long line while another remains keeps the gate', () => {
    expect(nextLongLineState(true, 7500, 0, true, () => true)).toBe(true);
  });
  it('a line break inserted into a short line never false-triggers', () => {
    // Gate was off; splitting short lines cannot create a long one.
    expect(nextLongLineState(false, 40, 0, true, never)).toBe(false);
  });
  it('pasting multi-line text that splits a long line short lifts the gate', () => {
    // Line break inserted, halves short -> rescan; no long line remains.
    expect(nextLongLineState(true, 200, 0, true, () => false)).toBe(false);
  });
});
