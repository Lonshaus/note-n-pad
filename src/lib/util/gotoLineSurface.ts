// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Where the Edit > Go to Line command opens its box.
/** The surface that takes Go to Line: the range edit box's editor when it is
 *  open (it covers the tab), else the large-file editor, the large-file viewer,
 *  or the ordinary CodeMirror editor. */
export function gotoLineSurface(ctx: {
  boxOpen: boolean;
  windowed: boolean;
  large: boolean;
}): 'box' | 'windowed' | 'large' | 'editor' {
  if (ctx.boxOpen) {
    return 'box';
  }
  if (ctx.windowed) {
    return 'windowed';
  }
  if (ctx.large) {
    return 'large';
  }
  return 'editor';
}
/** Whether the Go to Line key is handled by the keydown while an input method
 *  composes: macOS only (its menu does not fire then), the key matching, and a
 *  surface whose own key handler skips composing keys. */
export function composingGotoSurface(s: {
  mac: boolean;
  composing: boolean;
  matches: boolean;
  surface: 'box' | 'windowed' | 'large' | 'editor';
}): boolean {
  return (
    s.mac &&
    s.composing &&
    s.matches &&
    (s.surface === 'windowed' || s.surface === 'large')
  );
}
