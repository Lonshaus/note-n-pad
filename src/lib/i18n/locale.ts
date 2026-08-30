// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Pure i18n helpers with no dependency on Svelte state, Tauri, or the editor,
// so they stay unit-testable in isolation.

/** A concrete UI language id the app renders in. Three ids are compiled into
 *  the binary (`en`/`ja`/`zh-TW`, the guaranteed floor); every other id is a
 *  pure-data locale loaded at runtime (a bundled default seeded on first run,
 *  or a user import), so the type is an open string, not a closed union. */
export type Locale = string;

/** The stored language preference: a concrete locale id, or `system` to follow
 *  the OS/browser UI language. */
export type Language = string;

/** One UI language as pure data — the frontend shape of the Rust `LocaleData`.
 *  `strings` is an open key→value map (not keyed by `I18nKey`) because a data
 *  locale may be partial; missing keys fall back to English at lookup time. */
export interface LocaleData {
  id: string;
  label: string;
  order: number;
  strings: Record<string, string>;
  /** Whether a bundled seed exists for this id, i.e. edits can be restored.
   *  Reported by `list_locales`; absent on a locale built client-side. */
  isDefault?: boolean;
}

/** The three locales compiled into the binary, in language-menu display order.
 *  They are always present and can never be deleted (they are not data files),
 *  so they guarantee the UI always has a readable language. `zh-TW` is also the
 *  key authority the `I18nKey` union derives from. */
export const BUILTIN_IDS: readonly Locale[] = ['zh-TW', 'ja', 'en'];

/** Native display labels for the compiled locales: `Native name (English name)`,
 *  English shown bare. Data locales carry their own `label`; these constants
 *  cover the built-ins. A language menu always names each language in its own
 *  native form, so these never route through `t()`. */
export const BUILTIN_LABELS: Record<Locale, string> = {
  'zh-TW': '正體中文 (Traditional Chinese)',
  ja: '日本語 (Japanese)',
  en: 'English',
};

// Non-Chinese OS UI language prefixes, mapped to a canonical locale id. Order is
// irrelevant because no prefix is a prefix of another. The `zh` family needs
// script/region logic and is handled separately in `fromSystem`.
const PREFIX_MAP: readonly [string, Locale][] = [
  ['ja', 'ja'],
  ['ko', 'ko'],
  ['de', 'de'],
  ['fr', 'fr'],
  ['es', 'es'],
  ['pt', 'pt-BR'],
  ['it', 'it'],
  ['pl', 'pl'],
  ['ru', 'ru'],
  ['tr', 'tr'],
  ['th', 'th'],
  ['vi', 'vi'],
  ['en', 'en'],
];

/** Resolve the stored preference into a concrete, currently-available locale id.
 *  An explicit preference is honored when that id is available (a built-in or a
 *  loaded data locale — including a third-party import). Otherwise — `system`,
 *  or a stored id that was deleted or never existed — the OS/browser UI language
 *  is mapped to the closest locale, used only if it too is available; the final
 *  fallback is English, which is always compiled in. `availableIds` must always
 *  contain the three built-ins. */
export function resolveLocale(
  language: Language,
  systemLang: string | undefined,
  availableIds: ReadonlySet<string>,
): Locale {
  if (language !== 'system' && availableIds.has(language)) {
    return language;
  }
  const guess = fromSystem(systemLang);
  return availableIds.has(guess) ? guess : 'en';
}

// Map an OS UI language tag to a canonical locale id. The `zh` macrolanguage
// splits by script/region: Traditional for Hant / Taiwan / Hong Kong / Macau,
// Simplified for everything else — including bare `zh`, which CLDR likely-subtags
// expands to `zh-Hans-CN`, so Simplified is the standards-aligned default.
function fromSystem(systemLang: string | undefined): Locale {
  const lang = (systemLang ?? '').toLowerCase();
  if (lang.startsWith('zh')) {
    if (
      lang.startsWith('zh-hant') ||
      lang.startsWith('zh-tw') ||
      lang.startsWith('zh-hk') ||
      lang.startsWith('zh-mo')
    ) {
      return 'zh-TW';
    }
    return 'zh-CN';
  }
  for (const [prefix, locale] of PREFIX_MAP) {
    if (lang.startsWith(prefix)) {
      return locale;
    }
  }
  return 'en';
}

/** Substitute `{name}` placeholders in a template with the given params.
 *  Minimal by design: no pluralization or ICU-style rules. An unknown
 *  placeholder is left verbatim so a missing param is visible, not silent. */
export function interpolate(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}
