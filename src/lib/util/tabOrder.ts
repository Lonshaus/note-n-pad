// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** The two fields of a stored record that place its tab in a window. */
interface Ordered {
  tab_order?: number | null;
  tab_index: number;
}
/** A record's sort key: its `tab_order`, or its `tab_index` when it has none. */
export function orderOf(note: Ordered): number {
  return note.tab_order ?? note.tab_index;
}
/** Sorts records by their order key, then by `tab_index`. */
export function compareTabOrder(a: Ordered, b: Ordered): number {
  const ka = orderOf(a);
  const kb = orderOf(b);
  if (ka !== kb) {
    return ka < kb ? -1 : 1;
  }
  return a.tab_index - b.tab_index;
}
/** The key of a tab added after every tab holding `orders`. */
export function newKey(orders: readonly number[]): number {
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}
/** `key` when it lies strictly between `left` and `right` (a null side is open). */
function strictlyBetween(
  key: number,
  left: number | null,
  right: number | null,
): number | null {
  const clear =
    Number.isFinite(key) &&
    (left === null || key > left) &&
    (right === null || key < right);
  return clear ? key : null;
}
/** A key strictly between two neighbours (`null` is no neighbour on that side),
 *  or null when there is no number left between them. */
export function keyBetween(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) {
    return right === null ? 0 : strictlyBetween(right - 1, left, right);
  }
  if (right === null) {
    return strictlyBetween(left + 1, left, right);
  }
  return strictlyBetween((left + right) / 2, left, right);
}
