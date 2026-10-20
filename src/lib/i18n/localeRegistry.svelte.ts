// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Loaded, SkippedFile } from '../util/protocol';
import { BUILTIN_IDS, type LocaleData } from './locale';

/** Runtime registry of the pure-data locales — the bundled defaults seeded into
 *  the `locales/` app-data dir on first run, plus any user imports, kept in sync
 *  through the `locales-changed` broadcast. The three compiled locales
 *  (`en`/`ja`/`zh-TW`) are never data files, so they never appear here; they are
 *  merged in by `availableIds` and resolved by `t()` from their compiled dicts.
 *
 *  `locales` is reactive `$state`, so `t()` (via `settingsState.resolvedLocale`)
 *  and the settings language list both re-run when a locale is imported or
 *  deleted. The list arrives already ordered (by `order`, then id) from Rust. */
class LocaleRegistry {
  locales = $state<LocaleData[]>([]);
  /** The files in the locales folder the core could not load, refreshed with
   *  `locales`. A locale that fails to load never reaches `locales`, so this is
   *  the only place it is named. */
  skipped = $state<SkippedFile[]>([]);

  get(id: string): LocaleData | undefined {
    return this.locales.find((l) => l.id === id);
  }

  /** Every selectable locale id: the three built-ins plus every loaded data
   *  locale. `resolveLocale` needs this to honor a selection and to detect when
   *  a stored id was deleted. Always contains the built-ins, so English (the
   *  final fallback) is guaranteed present. */
  availableIds(): Set<string> {
    return new Set<string>([...BUILTIN_IDS, ...this.locales.map((l) => l.id)]);
  }

  /** Load every data locale from the core. Call once per window before the
   *  first `t()` resolution (see reveal.ts), then again on `locales-changed`. */
  async load(): Promise<void> {
    const loaded = await invoke<Loaded<LocaleData>>('list_locales');
    this.locales = loaded.items;
    this.skipped = loaded.skipped;
  }

  /** Reload whenever any window imports or deletes a locale. */
  listen(): Promise<UnlistenFn> {
    return listen('locales-changed', () => {
      void this.load();
    });
  }

  /** Install a locale file into the data dir (Rust validates, rejects the
   *  reserved built-in ids, and emits `locales-changed`), then reload so the
   *  new locale is immediately selectable. */
  async importFile(path: string): Promise<LocaleData> {
    const locale = await invoke<LocaleData>('import_locale', { path });
    await this.load();
    return locale;
  }

  /** Read + validate a locale file without installing it — the source for
   *  "update from JSON", which merges someone else's corrected translations
   *  into the locale open in the editor. */
  async readFile(path: string): Promise<LocaleData> {
    return await invoke<LocaleData>('read_locale_file', { path });
  }

  async exportFile(locale: LocaleData, path: string): Promise<void> {
    await invoke('export_locale', { locale, path });
  }

  async remove(id: string): Promise<void> {
    await invoke('delete_locale', { id });
    await this.load();
  }

  /** Persist a locale and reload, so the new strings take effect everywhere.
   *  The editor buffers edits in a draft and calls this only on an explicit
   *  save — typing must not retranslate the UI mid-keystroke. */
  async save(locale: LocaleData): Promise<void> {
    await invoke('save_locale', { locale: $state.snapshot(locale) });
    await this.load();
  }

  /** Restore a bundled locale to its shipped strings and label, discarding
   *  edits. Only valid where `isDefault` is true. */
  async restoreDefault(id: string): Promise<void> {
    await invoke('restore_default_locale', { id });
    await this.load();
  }
}

export const localeRegistry = new LocaleRegistry();
