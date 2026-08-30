// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Registry mapping language identifiers to Lezer parsers.
 *
 *  Only languages backed by a real `@lezer/*` parser are listed here. Legacy
 *  CodeMirror stream languages (which have no standalone Lezer grammar) are out
 *  of scope for the background worker and are intentionally absent.
 *
 *  Parsers are loaded through dynamic `import()` so the bundler code-splits each
 *  grammar into its own chunk; a document only pays for the grammar it uses. */
import type { Parser } from '@lezer/common';

/** Canonical language ids the worker can highlight. */
export const SUPPORTED_LANGUAGES = [
  'json',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'css',
  'sass',
  'html',
  'xml',
  'markdown',
  'python',
  'rust',
  'go',
  'java',
  'cpp',
  'php',
  'yaml',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Common name/extension aliases mapped onto canonical ids. */
const ALIASES: Record<string, SupportedLanguage> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  jsonc: 'json',
  scss: 'sass',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'cpp',
  c: 'cpp',
  yml: 'yaml',
};

/** Resolve a free-form language string (case-insensitive, alias-aware) to a
 *  canonical supported id, or `null` when no Lezer parser covers it. Pure. */
export function resolveLanguageId(input: string): SupportedLanguage | null {
  const key = input.trim().toLowerCase();
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(key)) {
    return key as SupportedLanguage;
  }
  return ALIASES[key] ?? null;
}

/** Load the Lezer parser for a canonical language id. TypeScript and JSX/TSX
 *  reuse the JavaScript grammar with the matching dialect enabled. */
export async function loadParser(language: SupportedLanguage): Promise<Parser> {
  switch (language) {
    case 'javascript': {
      return (await import('@lezer/javascript')).parser;
    }
    case 'typescript': {
      return (await import('@lezer/javascript')).parser.configure({
        dialect: 'ts',
      });
    }
    case 'jsx': {
      return (await import('@lezer/javascript')).parser.configure({
        dialect: 'jsx',
      });
    }
    case 'tsx': {
      return (await import('@lezer/javascript')).parser.configure({
        dialect: 'jsx ts',
      });
    }
    case 'json': {
      return (await import('@lezer/json')).parser;
    }
    case 'css': {
      return (await import('@lezer/css')).parser;
    }
    case 'sass': {
      return (await import('@lezer/sass')).parser;
    }
    case 'html': {
      return (await import('@lezer/html')).parser;
    }
    case 'xml': {
      return (await import('@lezer/xml')).parser;
    }
    case 'markdown': {
      return (await import('@lezer/markdown')).parser;
    }
    case 'python': {
      return (await import('@lezer/python')).parser;
    }
    case 'rust': {
      return (await import('@lezer/rust')).parser;
    }
    case 'go': {
      return (await import('@lezer/go')).parser;
    }
    case 'java': {
      return (await import('@lezer/java')).parser;
    }
    case 'cpp': {
      return (await import('@lezer/cpp')).parser;
    }
    case 'php': {
      return (await import('@lezer/php')).parser;
    }
    case 'yaml': {
      return (await import('@lezer/yaml')).parser;
    }
  }
}
