// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { settingsState } from '../state/settings.svelte';
import { interpolate } from './locale';
import { localeRegistry } from './localeRegistry.svelte';
import { zhTW } from './zh-TW';
import { ja } from './ja';
import { en } from './en';

// Self-built typed dictionary, no i18n framework. The master key set lives in
// `zh-TW.ts`; the other two compiled locales are `satisfies`-checked against it,
// so a missing translation in a built-in is a compile error.
//
// Only three locales are compiled in — the guaranteed floor (`en`/`ja`/`zh-TW`).
// Every other language is a pure-data locale loaded at runtime from the Rust
// core (`localeRegistry`); its `strings` map is not compile-checked, so a
// missing key falls back per-key to English here rather than breaking the UI.
//
// Upgrade path (deliberately not built yet): when a string needs count-dependent
// forms, add a pluralization layer inside `t()` rather than branching at each
// call site.

/** Union of every translatable string key, derived from the master locale. */
export type I18nKey = keyof typeof zhTW;

/** Every translatable key, in master-dictionary order. The locale editor uses
 *  this as its row list, so a data locale is edited against the full key set
 *  even where it currently has no translation. */
export const I18N_KEYS = Object.keys(zhTW) as I18nKey[];

/** The English text for a key — the editor's reference column, and the same
 *  string `t()` falls back to when a data locale lacks the key. */
export function englishText(key: I18nKey): string {
  return en[key];
}

/** The compiled locales, keyed by id. Complete by construction (`satisfies`),
 *  so they are the floor every lookup can fall back to. */
const BUILTIN_DICTS: Record<string, Record<I18nKey, string>> = {
  'zh-TW': zhTW,
  ja,
  en,
};

/** The compiled strings of a built-in locale, or `undefined` for a data-only
 *  locale. The editor materializes a built-in's first draft from these, so
 *  editing e.g. English starts from the shipped English rather than blank. */
export function builtinStrings(
  id: string,
): Record<I18nKey, string> | undefined {
  return BUILTIN_DICTS[id];
}

/** Translate a key in the active locale. Reads `settingsState.resolvedLocale`
 *  (a `$derived`) and `localeRegistry` (reactive `$state`), so calling `t()`
 *  inside a component template re-runs when the language changes or a locale is
 *  edited/imported/deleted. Pass `params` to fill `{name}` placeholders.
 *
 *  Resolution order is data file → compiled locale → compiled English. A data
 *  file *shadows* a compiled locale rather than replacing it, which is what
 *  makes the built-in languages editable while keeping them unbreakable:
 *  whatever an edit omits still resolves, and deleting the override restores
 *  the shipped strings outright. */
export function t(
  key: I18nKey,
  params?: Record<string, string | number>,
): string {
  const locale = settingsState.resolvedLocale;
  const template =
    localeRegistry.get(locale)?.strings[key] ??
    BUILTIN_DICTS[locale]?.[key] ??
    en[key];
  if (params === undefined) {
    return template;
  }
  return interpolate(template, params);
}
