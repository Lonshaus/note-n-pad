// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { Extension, Text } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

/**
 * Above this content size highlighting is forced off. Compares
 * `content.length`, i.e. UTF-16 code units, as a deliberate approximation of
 * the 10 MB product rule.
 */
export const MAX_HIGHLIGHT_CHARS = 10_000_000;

/**
 * Above this single-line length (UTF-16 code units) the synchronous Lezer
 * language layer is forced off for the whole document. Re-parsing a deeply
 * nested single line on every keystroke grows sharply past this knee (a nested
 * 10k-char line already costs ~7ms/key, ~21ms at pathological sizes); worker
 * highlighting takes over so typing stays responsive.
 */
export const LONG_LINE_THRESHOLD = 10_000;

/** True when any line in `doc` exceeds LONG_LINE_THRESHOLD. Walks line metadata
 *  only (no string materialization), so it is cheap enough to run on load and
 *  on the rare full rescan. */
export function docHasLongLine(doc: Text): boolean {
  for (let i = 1; i <= doc.lines; i++) {
    if (doc.line(i).length > LONG_LINE_THRESHOLD) {
      return true;
    }
  }
  return false;
}

/** Next long-line gate state after an edit. Inputs: the previous gate state,
 *  the longest new length among the lines the edit touched, how many code units
 *  the edit removed, and whether the inserted text carried a line break. A full
 *  rescan is needed only when the gate was on and a previously long line may
 *  have shrunk — which happens both when characters were removed and when a line
 *  break was inserted (splitting a long line into shorter ones). A pure
 *  insertion without a line break can only lengthen a line, so it never lifts
 *  the gate and skips the rescan. The caller passes `rescan` so it runs lazily.
 *  Pure so the load/edit/shorten/split/mixed transitions are unit-tested. */
export function nextLongLineState(
  prev: boolean,
  affectedMaxLen: number,
  removed: number,
  insertedLineBreak: boolean,
  rescan: () => boolean,
): boolean {
  if (affectedMaxLen > LONG_LINE_THRESHOLD) {
    return true;
  }
  if (!prev) {
    return false;
  }
  if (removed === 0 && !insertedLineBreak) {
    return true;
  }
  return rescan();
}

// Display-only labels for tabular files: CM's registry has no CSV/TSV mode,
// so these names resolve to no highlighting (loadLanguage returns null) but
// still label the tab correctly in the status bar.
const TABULAR_LABELS: Record<string, string> = { csv: 'CSV', tsv: 'TSV' };

/** Sorted list of language names for the picker. */
export const languageNames: string[] = [
  ...languages.map((l) => l.name),
  ...Object.values(TABULAR_LABELS),
].sort((a, b) => a.localeCompare(b));

/** Lowercased file extension, or null for no-extension names and dotfiles. */
export function fileExtension(path: string): string | null {
  const base = path.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  return base.slice(dot + 1).toLowerCase();
}

/** Match a path to a language name via CM's registry, or null. */
export function detectByFilename(path: string): string | null {
  const match = LanguageDescription.matchFilename(languages, path);
  if (match !== null) {
    return match.name;
  }
  // matchFilename is case-sensitive on the extension; fall back to a
  // case-insensitive extension lookup so "foo.PY" still resolves.
  const ext = fileExtension(path);
  if (ext === null) {
    return null;
  }
  const byExt = languages.find((l) => l.extensions.includes(ext));
  if (byExt !== undefined) {
    return byExt.name;
  }
  return TABULAR_LABELS[ext] ?? null;
}

/** Language a restored tab shows. A manual choice (`explicit`) is kept verbatim,
 *  including null which means the user pinned plain text; a never-touched tab
 *  re-detects from its filename so renames still change its language. */
export function restoredLanguage(
  snapLanguage: string | null,
  snapExplicit: boolean,
  detected: string | null,
): string | null {
  return snapExplicit ? snapLanguage : detected;
}

/** True when the trimmed content parses as a JSON object or array. */
function isStrictJson(trimmed: string): boolean {
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * A ranked series of cheap checks returning a language name, or null when
 * unsure (null means plain text). Names line up with the CM registry.
 */
export function detectByContent(content: string): string | null {
  const trimmed = content.trimStart();
  if (trimmed === '') {
    return null;
  }

  // Shebang wins outright.
  if (trimmed.startsWith('#!')) {
    const firstLine = trimmed.slice(0, trimmed.indexOf('\n') + 1 || undefined);
    if (/\bpython[0-9.]*\b/.test(firstLine)) {
      return 'Python';
    }
    if (/\bnode\b/.test(firstLine)) {
      return 'JavaScript';
    }
    return 'Shell';
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('<?xml')) {
    return 'XML';
  }
  if (lower.startsWith('<!doctype html') || lower.startsWith('<html')) {
    return 'HTML';
  }

  if (isStrictJson(trimmed)) {
    return 'JSON';
  }

  // Markdown: a heading plus another markdown cue (list item or code fence).
  const hasHeading = /(^|\n)#{1,2} /.test(content);
  const hasMdCue = /(^|\n)- /.test(content) || content.includes('```');
  if (hasHeading && hasMdCue) {
    return 'Markdown';
  }

  if (content.includes('fn main(') || content.includes('use std::')) {
    return 'Rust';
  }

  // ES module imports are unambiguously JS/TS (Python imports have no `from '...'`).
  const esImport = /(^|\n)import\s.+\sfrom\s+['"]/.test(content);

  // Python: bare import at line start, or a def line ending in a colon.
  if (
    !esImport &&
    (/(^|\n)import \w/.test(content) ||
      /(^|\n)def \w[^\n]*:\s*(\n|$)/.test(content))
  ) {
    return 'Python';
  }

  // JS/TS: ES imports, const/arrow shapes, or an interface declaration.
  const looksLikeJs =
    esImport ||
    /(^|\n)\s*const\s+\w/.test(content) ||
    content.includes('=>') ||
    /(^|\n)\s*interface\s+\w/.test(content);
  if (looksLikeJs) {
    // Prefer TypeScript when type annotations or interfaces appear.
    if (
      /(^|\n)\s*interface\s+\w/.test(content) ||
      /:\s*(string|number|boolean)\b/.test(content)
    ) {
      return 'TypeScript';
    }
    return 'JavaScript';
  }

  // CSS: a "selector { prop: value; }" block.
  if (/[^{}]+\{[^{}]*[\w-]+\s*:[^{};]+;[^{}]*\}/.test(content)) {
    return 'CSS';
  }

  return null;
}

/** Resolve a language name to a loadable CM extension, or null. */
export async function loadLanguage(name: string): Promise<Extension | null> {
  const desc = languages.find((l) => l.name === name);
  if (desc === undefined) {
    return null;
  }
  return await desc.load();
}
