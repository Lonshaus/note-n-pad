// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// What the tab bar allows while the range edit box is open, and which dialogs
// keep a tab from being dragged.

export type TabBarAction = 'drag' | 'switch' | 'unlock' | 'new';
/** Whether the tab bar takes `action`. With the box open only a drag is left:
 *  reordering, and sending a tab to another window. */
export function tabBarAllowed(action: TabBarAction, boxOpen: boolean): boolean {
  return !boxOpen || action === 'drag';
}
/** Whether a press on the tab bar keeps the focus where it is: with the box
 *  open the box's editor keeps it. */
export function keepsBoxFocus(boxOpen: boolean): boolean {
  return boxOpen;
}
export interface DragModalFacts {
  confirmClose: boolean;
  missingItem: boolean;
  gateVisible: boolean;
  windowedError: boolean;
  otherDialogs: boolean;
  boxConflict: boolean;
}
/** Whether a dialog is up that locks the tab drag. The open box is not one. */
export function dragModalOpen(facts: DragModalFacts): boolean {
  return (
    facts.confirmClose ||
    facts.missingItem ||
    facts.gateVisible ||
    facts.windowedError ||
    facts.otherDialogs ||
    facts.boxConflict
  );
}
