#!/usr/bin/env node
// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Generates the CFBundleDocumentTypes block in src-tauri/Info.plist, which
// overrides the one Tauri derives from bundle.fileAssociations.
//
//   node scripts/gen-doc-types.mjs
//
// Why override it at all: Tauri uses each association's `name` for
// CFBundleTypeName, and macOS shows CFBundleTypeName as the Finder "Kind" of
// every file whose extension has no system UTI of its own — measured on
// Ventura, a .hbs file read back as "Lonshaus.NoteNPad.SourceCode". That field
// cannot simply be renamed: the same `name` becomes the ProgID on Windows,
// where a value with spaces breaks the documented ProgID rules. So the plist
// carries the human-readable `description` instead, and `name` stays what
// Windows needs. Localizing the type name through InfoPlist.strings was tried
// first and has no effect in Ventura.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');
const CONFIG_FILE = path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json');
const INFO_FILE = path.join(REPO_ROOT, 'src-tauri', 'Info.plist');

// Extensions macOS already has a public UTI for. Declaring it lets Launch
// Services bind the type rather than the bare extension, which is what puts the
// app in the "Open With" list for a file that arrived without our extension
// mapping. Kept to the ones Tauri itself emits so the override changes the
// type names and nothing else; the association list is authored so these
// extensions sit in entries of their own.
const SYSTEM_UTIS = {
  txt: 'public.plain-text',
  json: 'public.json',
  xml: 'public.xml',
  svg: 'public.svg-image',
  htm: 'public.html',
  html: 'public.html',
};

// Mirrors Tauri's own FileAssociation::infer_content_types rule: this
// generator's output wholly replaces the block Tauri would have derived, so
// diverging from Tauri's rule here would silently unbind Launch Services
// types for extensions Tauri would still have covered.
/** The UTIs for one association's mapped extensions, or null when none map. */
export function contentTypes(association) {
  const utis = association.ext
    .map((ext) => SYSTEM_UTIS[ext])
    .filter((uti) => uti !== undefined);
  return utis.length > 0 ? [...new Set(utis)] : null;
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stringArray(key, values, indent) {
  const items = values
    .map((value) => `${indent}    <string>${escapeXml(value)}</string>`)
    .join('\n');
  return [
    `${indent}  <key>${key}</key>`,
    `${indent}  <array>`,
    items,
    `${indent}  </array>`,
  ].join('\n');
}

/** Every field this generator reads, so a missing one is named, not a crash. */
function checked(association, index) {
  for (const field of ['ext', 'description', 'role']) {
    if (association[field] === undefined) {
      throw new Error(
        `fileAssociations[${index}] has no "${field}"; every association needs one`,
      );
    }
  }
  return association;
}

/** The `<key>CFBundleDocumentTypes</key>` block, indented to sit in the dict. */
export function buildDocTypes(conf) {
  const indent = '    ';
  const entries = conf.bundle.fileAssociations.map((raw, index) => {
    const association = checked(raw, index);
    const lines = [
      `${indent}  <key>CFBundleTypeName</key>`,
      `${indent}  <string>${escapeXml(association.description)}</string>`,
      stringArray('CFBundleTypeExtensions', association.ext, indent),
    ];
    const utis = contentTypes(association);
    if (utis) {
      lines.push(stringArray('LSItemContentTypes', utis, indent));
    }
    lines.push(
      `${indent}  <key>CFBundleTypeRole</key>`,
      `${indent}  <string>${escapeXml(association.role)}</string>`,
      // Tauri emits this for every association; keeping it means the override
      // does not quietly change how the app ranks against other handlers.
      `${indent}  <key>LSHandlerRank</key>`,
      `${indent}  <string>Default</string>`,
    );
    return [`${indent}<dict>`, ...lines, `${indent}</dict>`].join('\n');
  });
  return [
    `${indent}<key>CFBundleDocumentTypes</key>`,
    `${indent}<array>`,
    ...entries,
    `${indent}</array>`,
  ].join('\n');
}

const BLOCK_PATTERN =
  /^ {4}<key>CFBundleDocumentTypes<\/key>\n {4}<array>\n[\s\S]*?\n {4}<\/array>$/m;

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
  const conf = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const updated = writeDocTypes(
    fs.readFileSync(INFO_FILE, 'utf8'),
    buildDocTypes(conf),
  );
  fs.writeFileSync(INFO_FILE, updated);
  const extensions = conf.bundle.fileAssociations.reduce(
    (total, association) => total + association.ext.length,
    0,
  );
  console.log(
    `wrote ${INFO_FILE}: ${conf.bundle.fileAssociations.length} types, ${extensions} extensions`,
  );
}

// Only generate when run as a script, so the freshness test can import the
// builders without rewriting the file it is about to check.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
