// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { I18nKey } from '../i18n';
import type { RecordRejection } from './accelerator';
/** A dictionary key plus the values its `{placeholders}` take. */
export interface ShortcutMessage {
  key: I18nKey;
  params?: Record<string, string>;
}
/** Every failure with no message of its own: a save error, an unknown or
 *  malformed code, or a thrown non-string. */
const GENERIC: ShortcutMessage = { key: 'settings.sticky.shortcutError' };
/** The row an id belongs to for a conflict message: the row itself, or the
 *  merged row that lists the id among its aliases. */
interface NamedRow {
  id: string;
  label: string;
  alias_ids: readonly string[];
}
/** The message for a key combination the recorder itself refused. */
export function rejectionMessage(
  reason: RecordRejection,
  isMacOS: boolean,
): ShortcutMessage {
  switch (reason) {
    case 'needs-modifier':
      return {
        key: isMacOS
          ? 'settings.shortcuts.err.needsModifierMac'
          : 'settings.shortcuts.err.needsModifierWin',
      };
    case 'mac-option':
      return { key: 'settings.shortcuts.err.macOption' };
    case 'unreachable':
      return { key: 'settings.shortcuts.err.unreachable' };
    case 'punctuation':
      return { key: 'settings.shortcuts.err.punctuation' };
    case 'unsupported-key':
      return { key: 'settings.shortcuts.err.unsupportedKey' };
    case 'no-layout-char':
      return { key: 'settings.shortcuts.err.noLayoutChar' };
    default:
      return GENERIC;
  }
}
/** The message for an error the Rust core returned from `set_shortcut`,
 *  `reset_shortcut`, `reset_all_shortcuts` (the codes of `SetError::code`, or
 *  `global-register:<detail>`). Anything else gets the generic message. */
export function setErrorMessage(
  error: unknown,
  isMacOS: boolean,
  rows: readonly NamedRow[],
): ShortcutMessage {
  const code = typeof error === 'string' ? error : '';
  if (code.startsWith('conflict:')) {
    const id = code.slice('conflict:'.length);
    const row = rows.find((r) => r.id === id || r.alias_ids.includes(id));
    return row === undefined
      ? GENERIC
      : { key: 'settings.shortcuts.err.conflict', params: { name: row.label } };
  }
  if (code.startsWith('global-register:')) {
    return { key: 'settings.shortcuts.err.globalRegister' };
  }
  switch (code) {
    case 'fixed':
      return { key: 'settings.shortcuts.err.fixed' };
    case 'needs-modifier':
      return rejectionMessage('needs-modifier', isMacOS);
    case 'mac-option':
      return rejectionMessage('mac-option', isMacOS);
    case 'unreachable':
      return rejectionMessage('unreachable', isMacOS);
    default:
      // `invalid:*`, `unknown-id` and a raw settings save error.
      return GENERIC;
  }
}
