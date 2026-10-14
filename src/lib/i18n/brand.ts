// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

const NAME = 'Note&Pad';
const LITE_NAME = 'Note&Pad Lite';

/** What the app calls itself: "Note&Pad Lite" in the Lite build (`__LITE__`, a
 *  compile-time constant like the bundle name), else "Note&Pad". The Windows
 *  trial is the full package and never changes its name. */
export function appName(lite: boolean = __LITE__): string {
  return lite ? LITE_NAME : NAME;
}

/** Turkish case suffixes that follow the brand after an apostrophe, mapped to
 *  the form that follows "Lite" instead: it is read /layt/, ends in a voiceless
 *  "t" after a back vowel, so "Note&Pad’ten" becomes "Note&Pad Lite’tan". No
 *  other language writes a suffix after an apostrophe on the name (checked over
 *  every locale), so this applies to all of them. Mirrors `LITE_SUFFIXES` in
 *  the Rust `i18n.rs`. */
const LITE_SUFFIXES: Record<string, string> = {
  ten: 'tan',
  den: 'tan',
  te: 'ta',
  de: 'ta',
  nin: 'ın',
  in: 'ın',
  le: 'la',
  la: 'la',
  i: 'ı',
  e: 'a',
};

const NAME_WITH_SUFFIX = /Note&Pad(?! Lite)(?:([’'])(\p{L}+)(?!\p{L}))?/gu;

/** `template` with every "Note&Pad" turned into "Note&Pad Lite" when `lite`.
 *  Applied to a translation template before any `{param}` is filled in, so a
 *  file name or path holding "Note&Pad" is never touched. Idempotent: a
 *  "Note&Pad" that already reads "Note&Pad Lite" is left alone. A Turkish
 *  suffix on the name follows the new last word (`LITE_SUFFIXES`). */
export function brandTemplate(template: string, lite: boolean): string {
  if (!lite) {
    return template;
  }
  return template.replace(
    NAME_WITH_SUFFIX,
    (whole: string, apostrophe?: string, word?: string) => {
      const mapped = word === undefined ? undefined : LITE_SUFFIXES[word];
      return mapped === undefined
        ? LITE_NAME + whole.slice(NAME.length)
        : `${LITE_NAME}${apostrophe}${mapped}`;
    },
  );
}
