// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** The parts of a keydown the Esc decision reads. */
export interface EscapeKey {
  key: string;
  isComposing: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}
/** Whether a dialog (`ConfirmModal`) acts on this keydown: a plain Esc only,
 *  never one with a modifier or one that ends an IME composition. */
export function modalActsOnEscape(e: EscapeKey): boolean {
  return (
    e.key === 'Escape' &&
    !e.isComposing &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey
  );
}
/** Whether a popup over the sticky closes on this keydown. A dialog on top
 *  owns the Esc it acts on and the popup closes on the next one; an Esc the
 *  dialog ignores closes the popup as before. */
export function popupClosesOnEscape(e: EscapeKey, modalOpen: boolean): boolean {
  return e.key === 'Escape' && !(modalOpen && modalActsOnEscape(e));
}
