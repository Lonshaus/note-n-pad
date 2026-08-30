// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { Theme } from './themes';

/** Read a color value off a theme by its `THEME_COLOR_FIELDS` path (e.g.
 *  `'editorBg'` or `'syntax.keyword'`). Kept separate from `setColor` so both
 *  ends of the custom-theme color editor share one path format. */
export function getColor(
  theme: Theme,
  path: keyof Theme | `syntax.${string}`,
): string {
  if (path.startsWith('syntax.')) {
    const key = path.slice('syntax.'.length) as keyof Theme['syntax'];
    return theme.syntax[key];
  }
  return theme[path as keyof Theme] as string;
}

/** Set a color value on a theme in place, at the given `THEME_COLOR_FIELDS`
 *  path. Mutates `theme` (and `theme.syntax` for syntax paths) so a reactive
 *  `$state` theme re-renders through the existing `applyTheme` effect. */
export function setColor(
  theme: Theme,
  path: keyof Theme | `syntax.${string}`,
  value: string,
): void {
  if (path.startsWith('syntax.')) {
    const key = path.slice('syntax.'.length) as keyof Theme['syntax'];
    theme.syntax[key] = value;
    return;
  }
  (theme as unknown as Record<string, string>)[path] = value;
}
