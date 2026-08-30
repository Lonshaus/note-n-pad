// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { LocaleData } from './locale';

// Pure helpers for the locale string editor, kept free of Svelte state and
// Tauri so they stay unit-testable.

/** One editor section: the keys sharing a leading namespace (`settings.*`,
 *  `doc.*`, …). The namespace doubles as the section heading — the editor
 *  already shows raw key names, so a raw group name is consistent and needs no
 *  translation of its own. */
export interface KeyGroup<K extends string = string> {
  name: string;
  keys: K[];
}

/** Split keys into sections by their leading namespace, preserving the master
 *  dictionary's order both between and within sections (so the editor reads in
 *  the same order the dictionary is maintained). Generic in the key type, so
 *  grouping the `I18nKey` union yields groups still typed as `I18nKey`. */
export function groupKeys<K extends string>(keys: readonly K[]): KeyGroup<K>[] {
  const groups: KeyGroup<K>[] = [];
  const byName = new Map<string, KeyGroup<K>>();
  for (const key of keys) {
    const dot = key.indexOf('.');
    const name = dot === -1 ? key : key.slice(0, dot);
    let group = byName.get(name);
    if (group === undefined) {
      group = { name, keys: [] };
      byName.set(name, group);
      groups.push(group);
    }
    group.keys.push(key);
  }
  return groups;
}

/** Write one edited string into a locale, in place.
 *
 *  Emptying a field *removes* the key rather than storing an empty string, so
 *  the lookup falls back to English again — an empty translation would render
 *  as a blank label. Only a completely empty field counts as cleared: a value
 *  of spaces is stored as typed, because some strings are deliberately
 *  space-padded (the `" (Custom)"` suffix) and a translator must be able to
 *  type that leading space without the field resetting under them. */
export function setString(
  locale: LocaleData,
  key: string,
  value: string,
): void {
  if (value === '') {
    delete locale.strings[key];
  } else {
    locale.strings[key] = value;
  }
}

/** The `{name}`-style placeholders a translation must preserve, deduplicated
 *  in first-appearance order. The editor lists these next to a row so a
 *  translator does not silently drop one (which would leave the interpolated
 *  value missing at runtime). */
export function placeholdersOf(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(/\{\w+\}/g)) {
    seen.add(match[0]);
  }
  return [...seen];
}

/** Whether `label` already carries the "customized" suffix, i.e. this locale
 *  has diverged from its bundled seed and can be restored. Mirrors how an
 *  edited default theme is marked. */
export function isCustomized(label: string, suffix: string): boolean {
  return label.endsWith(suffix);
}

/** The label to show after an edit: the suffix is appended once, never twice. */
export function customizedLabel(label: string, suffix: string): string {
  return isCustomized(label, suffix) ? label : label + suffix;
}
