// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Which menu actions the active tab takes while it is on its way to another
// window: nothing that would change it or its record.

import { splitMenuAction } from './menuBar';
/** The commands that act on the active tab and are refused while it is on its
 *  way. Copy, Select All, the find actions, New Tab, Open, Show in Finder, Copy
 *  Path and Close Tab, Close Window and Quit work as they always do. */
const REFUSED_WHILE_TRANSFERRING: readonly string[] = [
  'save',
  'save-as',
  'set-encoding',
  'set-line-ending',
  'set-language',
  'undo',
  'redo',
  'cut',
  'paste',
];
/** Whether the menu action `action` (with its `:argument`, if any) may run. */
export function menuActionAllowed(
  action: string,
  transferring: boolean,
): boolean {
  if (!transferring) {
    return true;
  }
  const command = splitMenuAction(action)?.command ?? action;
  return !REFUSED_WHILE_TRANSFERRING.includes(command);
}
