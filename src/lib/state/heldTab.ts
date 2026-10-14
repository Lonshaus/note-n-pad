// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** The tab kinds that do not render through the ordinary CodeMirror editor. */
interface TabKind {
  large?: unknown;
  windowed?: unknown;
  windowedRestore?: unknown;
}
/** Whether a tab renders through the ordinary editor: not a large-file viewer,
 *  not a windowed tab, and not a windowed tab still mid-restore. */
export function isOrdinaryTab(tab: TabKind): boolean {
  return (
    tab.large === undefined &&
    tab.windowed === undefined &&
    tab.windowedRestore === undefined
  );
}
/** Move `id` to the front of a most-recently-active list. */
export function touchMru(mru: readonly string[], id: string): string[] {
  return [id, ...mru.filter((x) => x !== id)];
}
/** The ordinary tab the (possibly hidden) editor holds: the active tab when it
 *  is ordinary, else the most recently active surviving ordinary tab, else the
 *  first ordinary tab. Null when the window has no ordinary tab left. */
export function pickHeldTab<T extends TabKind & { id: string }>(
  tabs: readonly T[],
  activeIndex: number,
  mru: readonly string[],
): T | null {
  const active = tabs[activeIndex];
  if (active !== undefined && isOrdinaryTab(active)) {
    return active;
  }
  for (const id of mru) {
    const tab = tabs.find((t) => t.id === id);
    if (tab !== undefined && isOrdinaryTab(tab)) {
      return tab;
    }
  }
  return tabs.find((t) => isOrdinaryTab(t)) ?? null;
}
