// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The first settings load corrects a stored theme id nothing can resolve and
// writes the correction back. Lite has no theme choice, so it must not: the
// stored choice belongs to the full edition and has to survive a lite session.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { SettingsState } from './settings.svelte';
import { editionState } from './edition.svelte';
import { themeRegistry } from '../theme/themeRegistry.svelte';
import type { Theme } from '../theme/themes';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

function theme(id: string, variant: 'light' | 'dark'): Theme {
  const c = '#111111';
  return {
    id,
    name: id,
    variant,
    editorBg: c,
    editorFg: c,
    uiBg: c,
    uiFg: c,
    uiAccent: c,
    uiBorder: c,
    danger: c,
    syntax: {
      keyword: c,
      string: c,
      number: c,
      comment: c,
      function: c,
      type: c,
      variable: c,
      operator: c,
      const: c,
    },
  };
}

function payload(storedTheme: string, interfaceMode = 'system'): unknown {
  return {
    settings: {
      theme: storedTheme,
      interface_mode: interfaceMode,
      editor_font_size: 14,
      editor_word_wrap: true,
      editor_line_numbers: true,
      worker_highlight: false,
      large_open_mode: 'ask',
      ask_long_line_open: true,
      preview_local_resources: false,
      open_target: 'tab',
      editor_font_family: '',
      default_line_ending: 'LF',
      default_encoding: 'UTF-8',
      new_note_shortcut: 'x',
      snapshot_dir: null,
      default_sticky_width: 280,
      default_sticky_height: 230,
      language: 'system',
      show_tray_icon: true,
      open_workspace_on_startup: false,
    },
    repaired_fields: [],
    snapshot_dir_unavailable: false,
  };
}

const saved = (): unknown[][] =>
  mockInvoke.mock.calls.filter(([cmd]) => cmd === 'save_settings');

beforeEach(() => {
  themeRegistry.themes = [theme('paper', 'light'), theme('ink', 'dark')];
  mockInvoke.mockReset();
});

afterEach(() => {
  themeRegistry.themes = [];
  editionState.lite = false;
});

describe('the stored theme id on the first settings load', () => {
  it('is left as it is, and never written back, in lite', async () => {
    editionState.lite = true;
    mockInvoke.mockResolvedValue(payload('my-own-theme'));
    const s = new SettingsState();
    await s.init();
    expect(s.themeId).toBe('my-own-theme');
    expect(saved()).toEqual([]);
  });

  it('is corrected to a default and written back in full', async () => {
    editionState.lite = false;
    mockInvoke.mockResolvedValue(payload('my-own-theme'));
    const s = new SettingsState();
    await s.init();
    expect(s.themeId).toBe('paper');
    expect(saved()).toEqual([
      ['save_settings', { settings: { theme: 'paper' } }],
    ]);
  });
});

describe('whether the editor is dark', () => {
  it('follows the interface mode in lite, whatever theme is stored', async () => {
    editionState.lite = true;
    mockInvoke.mockResolvedValue(payload('paper', 'dark'));
    const s = new SettingsState();
    await s.init();
    expect(s.isDark).toBe(true);
  });

  it('follows the chosen theme in full', async () => {
    editionState.lite = false;
    mockInvoke.mockResolvedValue(payload('paper', 'dark'));
    const s = new SettingsState();
    await s.init();
    expect(s.isDark).toBe(false);
  });
});
