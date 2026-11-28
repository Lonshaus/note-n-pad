// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A window made for a tab torn off its bar is on screen before any setting is
// read: the core puts the resolved interface mode and theme in its URL, and the
// page stamps them on its root before it mounts.
/** What the URL of a tear-off says about how it looks. */
export interface TearOffStamp {
  theme: string;
  colorScheme: 'light' | 'dark';
}
/** The stamp in a URL's query string, or null when the window is no tear-off. */
export function tearOffStamp(search: string): TearOffStamp | null {
  const params = new URLSearchParams(search);
  const theme = params.get('tearoffTheme');
  const mode = params.get('tearoffMode');
  if (
    params.get('tearoff') !== '1' ||
    theme === null ||
    (mode !== 'light' && mode !== 'dark')
  ) {
    return null;
  }
  return { theme, colorScheme: mode };
}
/** A close or quit the window had begun was called off: a tear-off still waiting
 *  in its role tells the core, which shows it. Whether it did. */
export function tearOffCloseCalledOff(
  inRole: boolean,
  tellCore: () => void,
): boolean {
  if (inRole) {
    tellCore();
  }
  return inRole;
}

/** Stamp `data-theme` and the color scheme on `root`, synchronously, for a
 *  tear-off. Whether it was one. */
export function stampTearOff(root: HTMLElement, search: string): boolean {
  const stamp = tearOffStamp(search);
  if (stamp === null) {
    return false;
  }
  root.setAttribute('data-theme', stamp.theme);
  root.style.colorScheme = stamp.colorScheme;
  return true;
}
