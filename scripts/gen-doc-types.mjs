#!/usr/bin/env node
// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Writes an empty CFBundleDocumentTypes block into src-tauri/Info.plist, which
// is how the app declares no file types at all on macOS.
//
//   node scripts/gen-doc-types.mjs
//
// The app must not become the handler of a file type nobody asked it to handle.
// On Windows that is achievable: the installer hands back the default it took
// and registers under OpenWithProgids instead. macOS has no equivalent —
// measured on Ventura, copying the app into /Applications made it the default
// for 202 of the 214 declared extensions, 43 of them taken from TextEdit and
// QuickTime, and LSHandlerRank "Alternate" changed nothing. Rank only loses to
// an app claiming the same type through a stronger route, so the only way not
// to take a default is not to declare the type.
//
// The cost, also measured: the app no longer appears in Get Info's "Open with"
// popup. A user associates an extension by hand through "Other...", switching
// the Enable popup to "All Applications", then "Change All...". That writes an
// extension-keyed entry into com.apple.launchservices.secure.plist, which never
// consults CFBundleDocumentTypes, so opening works from then on.
//
// bundle.fileAssociations stays in tauri.conf.json: Windows still needs it for
// the ProgIDs and the OpenWithProgids entries.
//
// An empty block rather than no block: the bundler derives its own
// CFBundleDocumentTypes from bundle.fileAssociations first and merges this file
// over the top, so the key has to be present to win.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');
const INFO_FILE = path.join(REPO_ROOT, 'src-tauri', 'Info.plist');

/** The `<key>CFBundleDocumentTypes</key>` block, indented to sit in the dict. */
export function buildDocTypes() {
  return ['    <key>CFBundleDocumentTypes</key>', '    <array></array>'].join(
    '\n',
  );
}

// Either form: the empty array this now writes, or the multi-entry block that
// preceded it, whose closing tag is the only one at this indent.
const BLOCK_PATTERN =
  /^ {4}<key>CFBundleDocumentTypes<\/key>\n {4}<array>(?:<\/array>|[\s\S]*?\n {4}<\/array>)$/m;

/** The block currently in `text`, or null when it has none. */
export function readDocTypes(text) {
  const found = text.match(BLOCK_PATTERN);
  return found ? found[0] : null;
}

/** `text` with the block replaced, or added just before the closing dict. */
export function writeDocTypes(text, block) {
  if (BLOCK_PATTERN.test(text)) {
    return text.replace(BLOCK_PATTERN, block);
  }
  return text.replace(/^ {2}<\/dict>$/m, `${block}\n  </dict>`);
}

function main() {
  const updated = writeDocTypes(
    fs.readFileSync(INFO_FILE, 'utf8'),
    buildDocTypes(),
  );
  fs.writeFileSync(INFO_FILE, updated);
  console.log(`wrote ${INFO_FILE}: 0 types declared`);
}

// Only generate when run as a script, so the freshness test can import the
// builders without rewriting the file it is about to check.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
