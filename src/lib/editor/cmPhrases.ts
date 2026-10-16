// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { EditorState, type Extension } from '@codemirror/state';
import { t } from '../i18n';
import { buildCmPhrases } from './cmPhraseKeys';
// CodeMirror's UI text in the active UI language. Reads `t()`, so calling it
// inside an `$effect` re-runs on a language change; feed the result to a
// Compartment.
export function cmPhraseExtension(): Extension {
  return EditorState.phrases.of(buildCmPhrases(t));
}
// Fingerprint of the current phrases, to tell whether a reconfigure is needed.
export function cmPhraseSignature(): string {
  return JSON.stringify(buildCmPhrases(t));
}
