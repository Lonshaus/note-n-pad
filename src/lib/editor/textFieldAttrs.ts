// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Attributes for a text field that takes search terms or numbers, not prose:
 *  the platform must not capitalize or autocorrect what is typed. The same set
 *  CodeMirror puts on its own content element. */
export const TEXT_FIELD_ATTRS = {
  autocapitalize: 'off',
  autocorrect: 'off',
  spellcheck: 'false',
} as const;
