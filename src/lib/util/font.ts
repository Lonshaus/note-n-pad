// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Shared monospace stack; a chosen family is layered in front of this tail.
// `ui-monospace` maps to each OS's system monospace (SF Mono / Cascadia /
// system default), then explicit per-platform faces cover older hosts:
// macOS (SF Mono, Menlo), Windows (Cascadia Mono, Consolas), Linux
// (Noto Sans Mono, DejaVu Sans Mono). CJK glyphs fall through to the system
// monospace fallback on each platform, which is adequate for a code editor.
export const DEFAULT_FONT_STACK =
  "ui-monospace, 'SF Mono', Menlo, 'Cascadia Mono', Consolas, 'Noto Sans Mono', 'DejaVu Sans Mono', monospace";

// Monospace faces offered in the font picker, spanning macOS, Windows, and
// Linux plus common cross-platform developer fonts. The picker filters this
// down to the faces the host can actually render (see availableFonts).
export const FONT_CANDIDATES: readonly string[] = [
  'SF Mono',
  'Menlo',
  'Monaco',
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  'Noto Sans Mono',
  'DejaVu Sans Mono',
  'Ubuntu Mono',
  'Liberation Mono',
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'Courier New',
];

// Sample rendered when measuring a face's width. Long, mixed-case, and
// digit-heavy so a real face and its generic fallback differ by a wide margin,
// which cuts false matches from two fonts happening to share one glyph's width.
const SAMPLE_TEXT = 'mMwWiIl1 0Oo@#—gqjpy ABCxyz 0123456789';

/** Filter font candidates down to the faces the host actually has installed.
 *  `measure` returns the rendered width of a fixed sample for a given CSS
 *  font-family value; it is injected so the filtering stays a pure, testable
 *  function (production passes a canvas `measureText` wrapper).
 *
 *  A face is present when it shifts the rendered width away from at least one
 *  generic baseline. Two baselines are required: a platform's generic
 *  `monospace` can itself BE one of the candidates (macOS maps `monospace` to
 *  Menlo), so a candidate whose width equals the `monospace` baseline is not
 *  necessarily absent — measuring it against the `sans-serif` baseline, which it
 *  never coincides with, still reveals it. */
export function availableFonts(
  candidates: readonly string[],
  measure: (fontFamily: string) => number,
): string[] {
  const monoBaseline = measure('monospace');
  const sansBaseline = measure('sans-serif');
  return candidates.filter((family) => {
    const overMono = measure(`'${family}', monospace`);
    const overSans = measure(`'${family}', sans-serif`);
    return overMono !== monoBaseline || overSans !== sansBaseline;
  });
}

/** Filter font candidates down to the faces present in an authoritative
 *  installed-families list (e.g. from `fc-list` on Linux), matching
 *  case-insensitively since fontconfig family names and our candidate spelling
 *  do not always agree on case. */
export function filterInstalledFonts(
  candidates: readonly string[],
  installed: readonly string[],
): string[] {
  const installedLower = new Set(installed.map((f) => f.toLowerCase()));
  return candidates.filter((family) =>
    installedLower.has(family.toLowerCase()),
  );
}

/** Build a width measurer backed by a single 2D canvas context, rendering the
 *  sample at 72px (a large size scales up per-glyph differences, so two distinct
 *  faces rarely measure equal by chance). Suitable as `availableFonts`'
 *  `measure` argument. Returns 0 for every family when no context is available,
 *  which makes `availableFonts` report nothing installed. */
export function makeCanvasMeasurer(): (fontFamily: string) => number {
  const ctx = document.createElement('canvas').getContext('2d');
  return (fontFamily) => {
    if (ctx === null) {
      return 0;
    }
    ctx.font = `72px ${fontFamily}`;
    return ctx.measureText(SAMPLE_TEXT).width;
  };
}

/** Resolve a chosen family into a CSS font-family value. Empty falls back to the
 *  built-in stack; a name containing spaces is quoted so it is a valid token. */
export function cssFontFamily(name: string): string {
  const n = name.trim();
  if (n === '') {
    return DEFAULT_FONT_STACK;
  }
  const primary = /\s/.test(n) ? `'${n}'` : n;
  return `${primary}, ${DEFAULT_FONT_STACK}`;
}
