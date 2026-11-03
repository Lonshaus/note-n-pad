// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Input types that take no text, so a paste has nothing to route.
const NO_TEXT = new Set([
  'checkbox',
  'radio',
  'range',
  'color',
  'button',
  'submit',
  'reset',
  'file',
  'image',
  'hidden',
]);

function svelteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...svelteFiles(path));
    } else if (name.endsWith('.svelte')) {
      found.push(path);
    }
  }
  return found;
}
/** The source of every `<input ...>` and `<textarea ...>` start tag of a
 *  template: the tag ends at the first `>` outside braces and quotes. */
function tags(file: string): string[] {
  const source = readFileSync(file, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const out: string[] = [];
  const open = /<(input|textarea)(?=[\s/>])/g;
  for (let m = open.exec(source); m !== null; m = open.exec(source)) {
    let depth = 0;
    let quote = '';
    let i = m.index;
    for (; i < source.length; i += 1) {
      const c = source.charAt(i);
      if (quote !== '') {
        if (c === quote && depth === 0) {
          quote = '';
        }
      } else if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
      } else if (depth === 0 && (c === '"' || c === "'")) {
        quote = c;
      } else if (depth === 0 && c === '>') {
        break;
      }
    }
    out.push(source.slice(m.index, i + 1));
  }
  return out;
}

function takesText(tag: string): boolean {
  if (tag.startsWith('<textarea')) {
    return true;
  }
  const type = /\stype="([^"]*)"/.exec(tag)?.[1] ?? 'text';
  return !NO_TEXT.has(type);
}

describe('the text fields of the windows', () => {
  const files = svelteFiles('src');
  it('finds the fields', () => {
    const all = files.flatMap((f) => tags(f));
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter(takesText).length).toBeGreaterThan(5);
  });
  it('route every paste through the core', () => {
    const bare: string[] = [];
    for (const file of files) {
      for (const tag of tags(file)) {
        if (
          takesText(tag) &&
          !tag.includes(
            'onpaste={(e) => void fieldPaste(e, e.currentTarget, pasteEnv)}',
          )
        ) {
          bare.push(`${file}: ${tag.replace(/\s+/g, ' ').slice(0, 80)}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });
  it('sit in a window that installs the paste listener', () => {
    for (const app of ['SettingsApp', 'WorkspaceApp']) {
      const source = readFileSync(`src/${app}.svelte`, 'utf8');
      expect(source, app).toContain('installPasteWindow()');
    }
  });
});
