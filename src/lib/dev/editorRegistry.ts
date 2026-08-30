// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { EditorView } from '@codemirror/view';

// The most recently mounted editor view, so the DEV automation hook can drive it.
// Pure module (no side effects) — tree-shaken out of production, where nothing
// calls into it.
let current: EditorView | null = null;

export function setActiveView(view: EditorView | null): void {
  current = view;
}

export function activeView(): EditorView | null {
  return current;
}
