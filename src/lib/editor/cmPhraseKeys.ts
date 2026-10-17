// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { I18nKey } from '../i18n';
// Every phrase CodeMirror (and our own search panel) looks up through
// `state.phrase()`, mapped to the i18n key that carries its translation. The
// keys are CodeMirror's own English source strings and are case-sensitive.
export const CM_PHRASE_KEYS = {
  Find: 'cm.find',
  Replace: 'cm.replaceField',
  next: 'cm.next',
  previous: 'cm.previous',
  all: 'cm.all',
  'match case': 'cm.matchCase',
  regexp: 'cm.regexp',
  'by word': 'cm.byWord',
  'in selection': 'cm.inSelection',
  replace: 'cm.replace',
  'replace all': 'cm.replaceAll',
  close: 'cm.close',
  'Go to line': 'cm.gotoLine',
  go: 'cm.go',
  'folded code': 'cm.foldedCode',
  unfold: 'cm.unfold',
  'Fold line': 'cm.foldLine',
  'Unfold line': 'cm.unfoldLine',
  'Folded lines': 'cm.foldedLines',
  'Unfolded lines': 'cm.unfoldedLines',
  'Control character': 'cm.controlChar',
  'current match': 'cm.currentMatch',
  'on line': 'cm.onLine',
  'replaced match on line $': 'cm.replacedOne',
  'replaced $ matches': 'cm.replacedMany',
  Completions: 'cm.completions',
  'Selection deleted': 'cm.selectionDeleted',
  to: 'cm.to',
} as const satisfies Record<string, I18nKey>;
// The phrase map handed to `EditorState.phrases`, resolved through `lookup`.
export function buildCmPhrases(
  lookup: (key: I18nKey) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [phrase, key] of Object.entries(CM_PHRASE_KEYS)) {
    out[phrase] = lookup(key);
  }
  return out;
}
