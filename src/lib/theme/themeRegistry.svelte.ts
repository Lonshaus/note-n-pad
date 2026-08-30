// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { nextSeq } from '../util/seq';
import type { Loaded, SkippedFile } from '../util/protocol';
import type { Theme } from './themes';

/** Runtime registry of every theme. Themes are pure data loaded from the Rust
 *  core (the `themes/` app-data dir, seeded from bundled defaults on first run)
 *  and kept in sync through the `themes-changed` broadcast. There is no built-in
 *  vs custom split — the defaults are ordinary data files like any imported or
 *  user-created theme; `isDefault` on each entry only marks whether a restorable
 *  seed exists.
 *
 *  `themes` is reactive `$state`: `applyTheme` resolves through this registry
 *  inside each window's theme `$effect`, so a reload (after add/edit/delete/
 *  restore) re-runs that effect and re-applies the resolved colors automatically.
 *  The list arrives already ordered (by `order`, then name) from Rust. */
class ThemeRegistry {
  themes = $state<Theme[]>([]);
  /** The files in the themes folder the core could not load, refreshed with
   *  `themes`. A theme that fails to load never reaches `themes`, so this is
   *  the only place it is named. */
  skipped = $state<SkippedFile[]>([]);

  get(id: string): Theme | undefined {
    return this.themes.find((t) => t.id === id);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  dark(): Theme[] {
    return this.themes.filter((t) => t.variant === 'dark');
  }

  light(): Theme[] {
    return this.themes.filter((t) => t.variant === 'light');
  }

  /** Load every theme from the core. Call once per window before the first theme
   *  resolution (see reveal.ts), then again on `themes-changed`. */
  async load(): Promise<void> {
    const loaded = await invoke<Loaded<Theme>>('list_themes');
    this.themes = loaded.items;
    this.skipped = loaded.skipped;
  }

  /** Reload whenever any window adds/edits/deletes/imports/restores a theme. */
  listen(): Promise<UnlistenFn> {
    return listen('themes-changed', () => {
      void this.load();
    });
  }

  /** Persist a theme (create or overwrite) and reload. Use for discrete actions
   *  (save-as-new, import). The Rust side validates, ignores the read-only
   *  `isDefault`, and emits `themes-changed`.
   *
   *  Reflects the theme into the local list synchronously *before* the async
   *  round-trip, so a caller that immediately selects it (`setThemeId`) resolves
   *  the id at once instead of racing the settings broadcast — which would apply
   *  before the reload landed and reset the selection to a default. */
  async save(theme: Theme): Promise<void> {
    const i = this.themes.findIndex((t) => t.id === theme.id);
    if (i >= 0) {
      this.themes[i] = theme;
    } else {
      this.themes.push(theme);
    }
    await invoke('save_theme', { theme, seq: nextSeq() });
    await this.load();
  }

  /** Persist an edit without reloading. Live color editing already mutates the
   *  reactive entry in place (so the preview updates), so a reload would only
   *  replace the array with an identical copy mid-edit. Use for debounced edits. */
  async persist(theme: Theme): Promise<void> {
    await invoke('save_theme', { theme, seq: nextSeq() });
  }

  async remove(id: string): Promise<void> {
    await invoke('delete_theme', { id });
    await this.load();
  }

  /** Read + validate a theme file (no persistence); the caller assigns a fresh
   *  id and calls `save` so an import never clobbers an existing theme. */
  async importFile(path: string): Promise<Theme> {
    return await invoke<Theme>('import_theme', { path });
  }

  async exportFile(theme: Theme, path: string): Promise<void> {
    await invoke('export_theme', { theme, path });
  }

  /** Restore a default theme to its seeded values (colors + name). Only valid
   *  for themes whose id has a bundled default (`isDefault`). */
  async restoreDefault(id: string): Promise<void> {
    await invoke('restore_default_theme', { id });
    await this.load();
  }
}

export const themeRegistry = new ThemeRegistry();
