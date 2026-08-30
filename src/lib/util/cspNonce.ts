// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Reads the per-load CSP nonce Tauri stamps into the served index.html.
// CodeMirror injects its stylesheet at runtime, so under `style-src 'self'` that
// stylesheet is only accepted when it carries a nonce (handed to CodeMirror
// through the EditorView.cspNonce facet).
// Returns the nonce, or '' when there is none.
const TOKEN = '__TAURI_STYLE_NONCE__';
export function readCspNonce(root: ParentNode = document.head): string {
  // `data-nonce`, not `nonce`: WebKit blanks the real `nonce` content attribute
  // right after parsing it ("nonce hiding"), and on macOS 13 the `.nonce` IDL
  // property reflects that blanked attribute instead of keeping the value, so
  // both read as '' at runtime. index.html carries the nonce token a second time
  // in `data-nonce`, which nothing blanks. Selecting on that attribute also
  // pins the right element: style-mod prepends CodeMirror's own <style> to head,
  // so a bare `style` selector matches that one once any editor has mounted.
  const value =
    root.querySelector('style[data-nonce]')?.getAttribute('data-nonce') ?? '';
  // Unreplaced token: `vite dev` serves index.html directly, with no Tauri
  // substitution and no CSP enforcement, so '' is correct there. It also means
  // the token constant has drifted from Tauri's, which the build-time test
  // catches before it can reach a release.
  return value === TOKEN ? '' : value;
}
