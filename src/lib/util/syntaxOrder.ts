// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Order the syntax picker's entries so `current` (`null` for Plain Text) is
 *  pinned first, followed by every other entry (Plain Text plus `languages`,
 *  in their original order) with the current one omitted so it is never
 *  listed twice. Mirrors the Format > Syntax menu's pinning in the Rust menu
 *  builder. When `current` is Plain Text or unset, the order is unchanged
 *  from before pinning existed (Plain Text was already first). */
export function syntaxOrder(
  languages: readonly string[],
  current: string | null,
): (string | null)[] {
  const base: (string | null)[] = [null, ...languages];
  return [current, ...base.filter((entry) => entry !== current)];
}
