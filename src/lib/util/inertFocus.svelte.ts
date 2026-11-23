// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** While `inert()` is true, focus inside `el()` is dropped: WebKit keeps it on
 *  an element whose ancestor turns inert, and keys would go to a hidden field. */
export function dropFocusWhenInert(
  el: () => HTMLElement | null,
  inert: () => boolean,
): void {
  $effect(() => {
    const root = el();
    if (!inert() || root === null) {
      return;
    }
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root.contains(focused)) {
      focused.blur();
    }
  });
}
