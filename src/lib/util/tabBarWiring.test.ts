// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Source checks for the tab bar of the document window. A component is not
// mounted in these tests, so the wiring a drag depends on is read from the file.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, '..', '..', 'DocumentApp.svelte'),
  'utf8',
);
/** The text of the `<style>` block. */
function styles(): string {
  const match = /<style>([\s\S]*?)<\/style>/.exec(source);
  expect(match).not.toBeNull();
  return match![1]!;
}
/** The body of the first CSS rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(
    styles(),
  );
  expect(match, `rule ${selector}`).not.toBeNull();
  return match![1]!;
}
/** The start tag that carries `marker`: from its `<` to its `>` outside braces
 *  and quotes. */
function startTag(marker: string): string {
  const at = source.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const open = source.lastIndexOf('<', at);
  let depth = 0;
  let quote = '';
  for (let i = open; i < source.length; i += 1) {
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
      return source.slice(open, i + 1);
    }
  }
  throw new Error(`no end of the tag with ${marker}`);
}
const STOPS_THE_DRAG = 'onpointerdown={(e) => e.stopPropagation()}';

describe('the tab bar of a document window', () => {
  it('cannot be selected as text', () => {
    const bar = rule('.tabbar');
    expect(bar).toContain('user-select: none;');
    expect(bar).toContain('-webkit-user-select: none;');
  });

  it('keeps a press on the close button or the lock from starting a drag', () => {
    expect(startTag('class="tab-close"')).toContain(STOPS_THE_DRAG);
    expect(startTag('class="tab-lock"')).toContain(STOPS_THE_DRAG);
  });

  it('forwards the pointer events of a tab and stops the browser drag', () => {
    const tab = startTag('class="tab"');
    for (const handler of [
      'onpointerdown=',
      'onpointermove=',
      'onpointerup=',
      'onpointercancel=',
      'onlostpointercapture=',
      'ondragstart={(e) => e.preventDefault()}',
    ]) {
      expect(tab).toContain(handler);
    }
    expect(tab).toContain('onclick={() => onTabClick(i)}');
  });

  it('cancels a drag on Escape and on a window blur', () => {
    expect(source).toContain("cancelDrag('escape')");
    expect(source).toContain("onblur={() => cancelDrag('blur')}");
  });

  it('tells the window state what keeps a tab from being dragged', () => {
    const start = source.indexOf('documentWindow.dragHost = {');
    expect(start).toBeGreaterThan(-1);
    const host = source.slice(start, source.indexOf('};', start));
    expect(host).toContain('missing.navigationLocked()');
    expect(host).toContain('gate.visible');
    expect(host).toContain('anyModalOpen');
  });

  it('reports the tab index and the order key of each tab to automation', () => {
    const start = source.indexOf('getTabs: () =>');
    expect(start).toBeGreaterThan(-1);
    const getter = source.slice(start, source.indexOf('switchTab:', start));
    expect(getter).toContain('tabIndex: t.tabIndex,');
    expect(getter).toContain('order: t.order,');
  });
});
