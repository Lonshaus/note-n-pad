// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Guards the ordering rule: a decision that a setting controls
// must not run before the stored settings have been folded in. Drives the real
// `SettingsState` class against a mocked Tauri `invoke`, the same way
// `documentWindow.test.ts` drives `documentWindow` — runes compiled for SSR
// don't run fine-grained reactivity, but plain field reads/writes and async
// methods (`ready` / `init()`) work fine under Vitest.
import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { SettingsState } from './settings.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

/** Minimal AppSettings payload; only editor_font_size varies across tests. */
function payload(fontSize: number): Record<string, unknown> {
  // `load_settings` returns the settings wrapped alongside the names of any
  // fields the tolerant loader had to repair, and whether the snapshot folder
  // fell back to the default; the clean case is an empty list and false.
  return {
    settings: settingsPayload(fontSize),
    repaired_fields: [],
    snapshot_dir_unavailable: false,
  };
}

function settingsPayload(fontSize: number): Record<string, unknown> {
  return {
    theme: 'x',
    interface_mode: 'system',
    editor_font_size: fontSize,
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
  };
}

/** Resolves to true only if `p` settles before a turn of the microtask queue. */
function settled(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    Promise.resolve().then(() => false),
  ]);
}

describe('settings readiness (real SettingsState)', () => {
  it('does not resolve before init() is called', async () => {
    mockInvoke.mockReset();
    const s = new SettingsState();
    expect(await settled(s.ready)).toBe(false);
  });

  it('does not resolve while the load is still in flight', async () => {
    mockInvoke.mockReset();
    let finish!: (v: Record<string, unknown>) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const s = new SettingsState();
    void s.init();
    expect(await settled(s.ready)).toBe(false);
    finish(payload(13));
    await s.ready;
    expect(s.editorFontSize).toBe(13);
  });

  it('has applied the settings by the time ready resolves', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(payload(21));
    const s = new SettingsState();
    void s.init();
    await s.ready;
    expect(s.editorFontSize).toBe(21);
  });

  it('resolves even when the load fails, so an awaiting open cannot hang', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockRejectedValue(new Error('no core'));
    const s = new SettingsState();
    void s.init().catch(() => undefined);
    await expect(s.ready).resolves.toBeUndefined();
    // The failed load never applied a payload; the constructor default holds.
    expect(s.editorFontSize).toBe(13);
  });

  it('stays resolved for every later caller', async () => {
    mockInvoke.mockReset();
    // 'x' is not a registered theme id, so `init()`'s validated apply() also
    // triggers a fallback `setThemeId` save — only `load_settings` calls are
    // what this test cares about (`init()` running its load only once).
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'load_settings' ? payload(13) : undefined),
    );
    const s = new SettingsState();
    await s.init();
    await s.ready;
    await s.ready;
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === 'load_settings'),
    ).toHaveLength(1);
  });

  it('flags settingsRepaired and snapshotDirUnavailable from the load payload', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({
      settings: settingsPayload(13),
      repaired_fields: ['editor_font_size'],
      snapshot_dir_unavailable: true,
    });
    const s = new SettingsState();
    void s.init();
    await s.ready;
    expect(s.settingsRepaired).toBe(true);
    expect(s.snapshotDirUnavailable).toBe(true);
  });
});
