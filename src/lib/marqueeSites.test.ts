// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Source checks: every button that shows text runs it as a marquee, and the
// rules the plan adds to rows and menus are still in place.

function svelteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules') {
      continue;
    }
    if (statSync(path).isDirectory()) {
      found.push(...svelteFiles(path));
    } else if (name.endsWith('.svelte')) {
      found.push(path);
    }
  }
  return found;
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}
/** The template of a Svelte file: no script, style or comments. */
function template(path: string): string {
  return read(path)
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}
/** The style block of a Svelte file, or a whole CSS file. */
function css(path: string): string {
  const source = read(path);
  const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source);
  return style === null ? source : (style[1] ?? '');
}
/** The declarations of the rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(
    source,
  );
  if (found === null) {
    throw new Error(`no rule for ${selector}`);
  }
  return found[1] ?? '';
}
/** The end (index of `>`) of the start tag that begins at `from`. */
function tagEnd(source: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < source.length; i += 1) {
    const c = source.charAt(i);
    if (quote !== '') {
      if (c === quote && depth === 0) {
        quote = '';
      } else if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
      }
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
    } else if (depth === 0 && (c === '"' || c === "'")) {
      quote = c;
    } else if (depth === 0 && c === '>') {
      return i;
    }
  }
  throw new Error('unterminated tag');
}

interface Element {
  start: number;
  end: number;
  open: string;
  inner: string;
}
/** Every `<name ...>...</name>` element, at any depth, in document order. */
function elements(source: string, name: string): Element[] {
  const found: Element[] = [];
  const opening = new RegExp(`<${name}(?=[\\s/>])`, 'g');
  for (let m = opening.exec(source); m !== null; m = opening.exec(source)) {
    const openEnd = tagEnd(source, m.index);
    const open = source.slice(m.index, openEnd + 1);
    if (open.endsWith('/>')) {
      found.push({ start: m.index, end: openEnd + 1, open, inner: '' });
      continue;
    }
    const scan = new RegExp(`<${name}(?=[\\s/>])|</${name}\\s*>`, 'g');
    scan.lastIndex = openEnd + 1;
    let depth = 1;
    for (let n = scan.exec(source); n !== null; n = scan.exec(source)) {
      if (n[0].startsWith('</')) {
        depth -= 1;
      } else if (
        !source.slice(n.index, tagEnd(source, n.index) + 1).endsWith('/>')
      ) {
        depth += 1;
      }
      if (depth === 0) {
        found.push({
          start: m.index,
          end: n.index + n[0].length,
          open,
          inner: source.slice(openEnd + 1, n.index),
        });
        break;
      }
    }
  }
  return found;
}
/** `source` without every element of `name` that `drop` accepts. */
function withoutElements(
  source: string,
  name: string,
  drop: (el: Element) => boolean,
): string {
  let out = source;
  for (;;) {
    const hit = elements(out, name).find(drop);
    if (hit === undefined) {
      return out;
    }
    out = out.slice(0, hit.start) + out.slice(hit.end);
  }
}
/** `source` without any start or end tag. */
function withoutTags(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    if (source.charAt(i) === '<' && /[a-zA-Z/]/.test(source.charAt(i + 1))) {
      i = tagEnd(source, i) + 1;
    } else {
      out += source.charAt(i);
      i += 1;
    }
  }
  return out;
}
// Parts that sit beside a marquee, not text of the button's own.
const FIXED_PART = /class="(?:rline|dirty|dirty-dot|open-dot)"/;
// Buttons that show a glyph or a number, not a label.
const LEFT_ALONE = /class="(?:twisty|gutter)"/;
/** The text a button shows outside its marquee elements, trimmed. */
function strayText(inner: string): string {
  let rest = inner;
  rest = withoutElements(rest, 'span', (el) => el.open.includes('use:marquee'));
  rest = withoutElements(
    rest,
    'span',
    (el) => el.open.includes('aria-hidden="true"') || FIXED_PART.test(el.open),
  );
  rest = withoutElements(rest, 'svg', () => true);
  rest = rest.replace(/\{@render[^}]*\}/g, '').replace(/\{[#:/][^}]*\}/g, '');
  return withoutTags(rest).trim();
}
/** Whether `text` is more than a glyph such as `×`, `−` or `+`. */
function isWords(text: string): boolean {
  return text.includes('{') || /\p{L}/u.test(text);
}

const FILES = svelteFiles('src');

describe('buttons that show text run it as a marquee', () => {
  it('finds the buttons it is meant to check', () => {
    const count = FILES.reduce(
      (n, file) => n + elements(template(file), 'button').length,
      0,
    );
    expect(count).toBeGreaterThan(80);
  });

  for (const file of FILES) {
    const buttons = elements(template(file), 'button');
    if (buttons.length === 0) {
      continue;
    }
    it(`${file}: no button shows text outside a marquee`, () => {
      for (const button of buttons) {
        if (LEFT_ALONE.test(button.open)) {
          continue;
        }
        const stray = strayText(button.inner);
        expect(
          isWords(stray) ? stray : '',
          `${button.open} shows text outside use:marquee`,
        ).toBe('');
      }
    });
  }

  it('gives every use:marquee element one child element and no text of its own', () => {
    let seen = 0;
    for (const file of FILES) {
      const source = template(file);
      for (const el of elements(source, 'span')) {
        if (!el.open.includes('use:marquee')) {
          continue;
        }
        seen += 1;
        expect(el.open, `${file}: ${el.open}`).toMatch(
          /class="[^"]*\bmarquee\b/,
        );
        const inner = el.inner.trim();
        const child = elements(inner, 'span')[0];
        expect(child, `${file}: ${el.open} has no child`).toBeDefined();
        expect(child?.start, `${file}: ${el.open} has text first`).toBe(0);
        expect(child?.end, `${file}: ${el.open} has more than one child`).toBe(
          inner.length,
        );
      }
    }
    expect(seen).toBeGreaterThan(60);
  });
});

describe('the rest of the marquee wiring', () => {
  it('attaches a marquee to every search panel button and cleans up', () => {
    const source = read('src/lib/editor/searchPanel.ts');
    const at = source.indexOf('const button = (');
    expect(at).toBeGreaterThan(0);
    const body = source.slice(at, source.indexOf('const label = (', at));
    expect(body).toContain('attachMarquee(');
    expect(source).toMatch(/\n {2}destroy\(\): void \{/);
    expect(source).toContain('handle.destroy()');
  });

  it('adds the go-to-line marquee to both editors', () => {
    for (const file of [
      'src/lib/editor/DocumentEditor.svelte',
      'src/lib/editor/Editor.svelte',
    ]) {
      const source = read(file);
      expect(source, file).toContain(
        "import { dialogMarquee } from './dialogMarquee';",
      );
      expect(source, file).toMatch(/\n\s+dialogMarquee,\n/);
    }
  });

  it('still binds gotoLine twice in keymap.ts', () => {
    const source = read('src/lib/editor/keymap.ts');
    expect(source.match(/run: gotoLine/g)).toHaveLength(2);
    for (const entry of [
      "{ id: 'goto-line', run: gotoLine, profiles: TEXT }",
      "{ key: 'Mod-Alt-g', run: gotoLine }",
    ]) {
      expect(source.split(entry), entry).toHaveLength(2);
    }
  });

  it('reads the dialog button text without the copy', () => {
    expect(read('src/DocumentApp.svelte')).toContain(
      "button.querySelector('.marquee > :first-child')",
    );
  });
});

describe('the rules the buttons rely on', () => {
  const button = (body: string): void => {
    expect(body).toContain('max-width: 100%;');
    expect(body).toContain('overflow: hidden;');
    expect(body).toMatch(/flex-shrink: 0;|flex: 0 0 auto;/);
  };

  it('app.css has the marquee and the CodeMirror button rules', () => {
    const source = css('src/app.css');
    const marquee = rule(source, '.marquee');
    for (const line of [
      'position: relative;',
      'display: block;',
      'overflow: hidden;',
      'white-space: nowrap;',
      'min-width: 0;',
    ]) {
      expect(marquee).toContain(line);
    }
    expect(rule(source, '.marquee > :first-child')).toContain(
      'display: inline-block;',
    );
    for (const selector of [
      '.cm-panel.cm-search .cm-button',
      '.cm-dialog .cm-button',
    ]) {
      const body = rule(source, selector);
      button(body);
      expect(body, selector).toContain('white-space: nowrap;');
    }
  });

  const rows: [string, string[]][] = [
    [
      'src/SettingsApp.svelte',
      [
        '.subtabs',
        '.segmented',
        '.size-row',
        '.shortcut-actions',
        '.shortcut-row',
        '.snapshot-actions',
      ],
    ],
    ['src/lib/large/RangeEditBox.svelte', ['.actions']],
    ['src/lib/LoadProblems.svelte', ['.row-actions']],
    ['src/LoadProblemsApp.svelte', ['.row-actions']],
  ];
  for (const [file, selectors] of rows) {
    for (const selector of selectors) {
      it(`${file}: ${selector} wraps`, () => {
        expect(rule(css(file), selector)).toContain('flex-wrap: wrap;');
      });
    }
  }
  for (const file of [
    'src/lib/LoadProblems.svelte',
    'src/LoadProblemsApp.svelte',
  ]) {
    it(`${file}: .row-actions is capped at its space`, () => {
      expect(rule(css(file), '.row-actions')).toContain('max-width: 100%;');
    });
  }

  const buttons: [string, string[]][] = [
    [
      'src/SettingsApp.svelte',
      [
        '.rail-item',
        '.subtab',
        '.segment',
        '.recorder',
        '.btn',
        '.group-toggle',
      ],
    ],
    ['src/SettingsApp.svelte', ['.theme-option']],
    ['src/lib/ConfirmModal.svelte', ['.btn']],
    ['src/lib/i18n/LocaleEditor.svelte', ['.btn']],
    ['src/EditionApp.svelte', ['.action']],
    ['src/lib/large/FindPanels.svelte', ['.search-result']],
    ['src/lib/large/LargeFileView.svelte', ['.range-bar .cm-button']],
    ['src/lib/large/RangeEditBox.svelte', ['.btn']],
    ['src/lib/LoadProblems.svelte', ['.summary', '.link']],
    ['src/LoadProblemsApp.svelte', ['.link', '.close']],
    ['src/lib/table/TableView.svelte', ['.ctx-item']],
    ['src/StickyApp.svelte', ['.pin-item']],
    ['src/WorkspaceApp.svelte', ['.sec-toggle', '.row']],
  ];
  for (const [file, selectors] of buttons) {
    for (const selector of selectors) {
      it(`${file}: ${selector} holds a button to its space`, () => {
        button(rule(css(file), selector));
      });
    }
  }

  it('SettingsApp: the other rule changes are in', () => {
    const source = css('src/SettingsApp.svelte');
    expect(rule(source, '.segmented')).toContain('max-width: 100%;');
    expect(rule(source, '.shortcut-name')).toContain('flex: 1 1 0;');
    const option = rule(source, '.theme-option');
    expect(option).not.toContain('text-overflow');
    expect(option).toContain('display: flex;');
    expect(option).toContain('align-items: center;');
    expect(rule(source, '.theme-side')).toContain('min-width: 0;');
  });

  it('FindPanels: .rprev keeps its white-space and drops the ellipsis', () => {
    const body = rule(css('src/lib/large/FindPanels.svelte'), '.rprev');
    expect(body).toContain('white-space: pre;');
    expect(body).not.toContain('text-overflow');
  });

  it('WorkspaceApp: .label has no ellipsis and the Project heading gives way', () => {
    const source = css('src/WorkspaceApp.svelte');
    expect(rule(source, '.label')).not.toContain('text-overflow');
    expect(rule(source, '.proj-head .heading')).toContain('min-width: 0;');
  });

  it('the table and pin menus keep their box and stay inside the window', () => {
    expect(rule(css('src/lib/table/TableView.svelte'), '.ctx-menu')).toContain(
      'max-width: calc(100vw - 8px - 10px);',
    );
    expect(
      rule(css('src/lib/table/TableView.svelte'), '.ctx-item .marquee'),
    ).toContain('flex: 1 1 auto;');
    expect(rule(css('src/StickyApp.svelte'), '.pin-menu')).toContain(
      'max-width: calc(100vw - 12px - 6px);',
    );
    const table = read('src/lib/table/TableView.svelte');
    expect(table).toContain('use:fitMenu');
    expect(table).toContain('function fitMenu(');
  });
});
