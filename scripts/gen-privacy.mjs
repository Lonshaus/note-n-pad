#!/usr/bin/env node
// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Copies the privacy policy into src-tauri/resources so it ships inside the
// app and can be read with no network.
//
//   node scripts/gen-privacy.mjs
//
// The documents at the repo root stay the originals: they are what the store
// listings link to and what a reader of the repository sees. Bundling a second
// copy rather than pointing the app at a URL is the requirement — Apple asks
// for the policy to be reachable from inside the app, and a link is not
// reachable on a machine that is offline.
//
// The language-switching header each root file carries is stripped: inside the
// app the language follows the interface setting, and those links point at
// files that are not there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');
const OUT_DIR = path.join(REPO_ROOT, 'src-tauri', 'resources', 'privacy');

/** Root file to bundled name. The bundled names are the locale ids the Rust
 *  side resolves against; every other interface language reads `en`. */
export const DOCUMENTS = [
  ['PRIVACY.md', 'en.md'],
  ['PRIVACY.zh-TW.md', 'zh-TW.md'],
  ['PRIVACY.ja.md', 'ja.md'],
];

/** The document without its language-switching line. That line is the second
 *  non-empty one and holds links to sibling files that do not ship. */
export function stripLanguageSwitcher(markdown) {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) =>
    /\]\(PRIVACY[.\w-]*\.md\)/.test(line),
  );
  if (index === -1) {
    return markdown;
  }
  lines.splice(index, 1);
  // The blank line the switcher left behind, so the heading is not followed by
  // two of them.
  if (lines[index]?.trim() === '' && lines[index - 1]?.trim() === '') {
    lines.splice(index, 1);
  }
  return lines.join('\n');
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [source, target] of DOCUMENTS) {
    const from = path.join(REPO_ROOT, source);
    if (!fs.existsSync(from)) {
      throw new Error(`missing ${source} at the repo root`);
    }
    fs.writeFileSync(
      path.join(OUT_DIR, target),
      stripLanguageSwitcher(fs.readFileSync(from, 'utf8')),
    );
  }
  console.log(`wrote ${DOCUMENTS.length} documents into ${OUT_DIR}`);
}

// Only generate when run as a script, so the freshness test can import the
// helpers without rewriting the files it is about to check.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
