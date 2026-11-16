// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Source checks: dialog text wraps inside a dialog of a set size, and the
// buttons stay in view.

function style(path: string): string {
  const source = readFileSync(path, 'utf8');
  return /<style[^>]*>([\s\S]*?)<\/style>/.exec(source)?.[1] ?? '';
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

describe('ConfirmModal', () => {
  const path = 'src/lib/ConfirmModal.svelte';
  const source = style(path);

  it('caps the box in both directions and lays it out as a column', () => {
    const modal = rule(source, '.modal');
    expect(modal).toContain('max-width: min(85%, calc(100% - 2rem));');
    expect(modal).toContain('max-height: calc(85% - 1.7rem);');
    expect(modal).toContain('display: flex;');
    expect(modal).toContain('flex-direction: column;');
  });

  it('scrolls the text and keeps the button row', () => {
    const scroll = rule(source, '.modal-scroll');
    expect(scroll).toContain('flex: 1 1 auto;');
    expect(scroll).toContain('min-height: 0;');
    expect(scroll).toContain('overflow-y: auto;');
    expect(rule(source, '.modal-actions')).toContain('flex: 0 0 auto;');
    const template = readFileSync(path, 'utf8');
    const open = template.indexOf('<div class="modal-scroll">');
    const actions = template.indexOf('<div class="modal-actions">');
    const message = template.indexOf('<p>{message}</p>');
    expect(open).toBeGreaterThan(0);
    expect(message).toBeGreaterThan(open);
    expect(template.indexOf('class="modal-items"')).toBeGreaterThan(open);
    expect(template.indexOf('class="modal-items"')).toBeLessThan(actions);
  });

  it('breaks a long word in the message', () => {
    expect(rule(source, '.modal p')).toContain('overflow-wrap: anywhere;');
  });
});

describe('the settings window card', () => {
  const path = 'src/SettingsApp.svelte';
  const source = style(path);

  it('caps the card inside the window', () => {
    const card = rule(source, '.modal-card');
    expect(card).toContain('max-width: calc(85% - 2rem - 2px);');
    expect(card).toContain('max-height: calc(85% - 2rem - 2px);');
    expect(card).toContain('min-width: 16rem;');
  });

  it('scrolls the title and the body with the card gap and keeps the buttons', () => {
    const scroll = rule(source, '.modal-scroll');
    expect(scroll).toContain('display: flex;');
    expect(scroll).toContain('flex-direction: column;');
    expect(scroll).toContain('gap: 0.7rem;');
    expect(scroll).toContain('flex: 1 1 auto;');
    expect(scroll).toContain('min-height: 0;');
    expect(scroll).toContain('overflow-y: auto;');
    expect(rule(source, '.modal-actions')).toContain('flex: 0 0 auto;');
    const template = readFileSync(path, 'utf8');
    const open = template.indexOf('<div class="modal-scroll">');
    expect(open).toBeGreaterThan(0);
    expect(template.indexOf('class="modal-title"', open)).toBeGreaterThan(open);
    expect(template.indexOf('class="modal-body"', open)).toBeGreaterThan(open);
  });

  it('wraps the body and leaves the title as it was', () => {
    expect(rule(source, '.modal-body')).toContain('overflow-wrap: anywhere;');
    const title = rule(source, '.modal-title');
    expect(title).toContain('font-size: 0.82rem;');
    expect(title).toContain('font-weight: 600;');
    expect(title).not.toContain('overflow');
    expect(title).not.toContain('white-space');
  });
});
