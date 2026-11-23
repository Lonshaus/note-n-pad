#!/usr/bin/env node
// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Fails when a Tauri npm package and its Rust crate differ in major or minor.
//
//   node scripts/check-tauri-versions.mjs [root]
//
// The Tauri CLI refuses to build on such a mismatch, and no CI step runs the CLI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');
const PLUGIN_PREFIX = '@tauri-apps/plugin-';
/** The crate an npm package pairs with, or undefined when it has none. */
function crateFor(npmName) {
  if (npmName === '@tauri-apps/api') {
    return 'tauri';
  }
  if (npmName.startsWith(PLUGIN_PREFIX)) {
    return `tauri-plugin-${npmName.slice(PLUGIN_PREFIX.length)}`;
  }
  return undefined;
}

function majorMinor(version) {
  return version.split('.').slice(0, 2).join('.');
}
/**
 * Every npm package whose crate is also present, as
 * `{ npm, npmVersion, crate, crateVersions, mismatch }`. `npm` maps name to
 * version, `crates` maps name to the list of locked versions.
 */
export function tauriPairs(npm, crates) {
  const pairs = [];
  for (const [name, npmVersion] of Object.entries(npm)) {
    const crate = crateFor(name);
    const crateVersions = crate === undefined ? undefined : crates[crate];
    if (crate === undefined || crateVersions === undefined) {
      continue;
    }
    pairs.push({
      npm: name,
      npmVersion,
      crate,
      crateVersions,
      mismatch: crateVersions.some(
        (v) => majorMinor(v) !== majorMinor(npmVersion),
      ),
    });
  }
  return pairs;
}
/** The installed version of every `@tauri-apps/*` package the project declares. */
export function readNpmVersions(root) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  const names = Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
  }).filter((name) => name.startsWith('@tauri-apps/'));
  const versions = {};
  for (const name of names) {
    const installed = path.join(root, 'node_modules', name, 'package.json');
    if (!fs.existsSync(installed)) {
      throw new Error(`${name} is declared in package.json but not installed`);
    }
    versions[name] = JSON.parse(fs.readFileSync(installed, 'utf8')).version;
  }
  return versions;
}
/** Every locked crate version of a `Cargo.lock` text, by crate name. */
export function readCrateVersions(lockText) {
  const versions = {};
  // `\r?\n` because a Windows checkout may have converted the line endings.
  const entry = /\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/g;
  for (const [, name, version] of lockText.matchAll(entry)) {
    (versions[name] ??= []).push(version);
  }
  return versions;
}
/** `{ status, lines }`: status 1 on a mismatch or when nothing was compared. */
export function checkResult(pairs) {
  const bad = pairs.filter((pair) => pair.mismatch);
  if (bad.length > 0) {
    return {
      status: 1,
      lines: bad.map(
        (pair) =>
          `${pair.crate} (v${pair.crateVersions.join(', v')}) : ${pair.npm} (v${pair.npmVersion})`,
      ),
    };
  }
  if (pairs.length === 0) {
    return { status: 1, lines: ['no Tauri npm/crate pair found'] };
  }
  const names = pairs
    .map((pair) => `${pair.npm} (v${pair.npmVersion}) = ${pair.crate}`)
    .join(', ');
  return { status: 0, lines: [`Tauri npm/crate versions match: ${names}`] };
}

export function main(root) {
  const lock = fs.readFileSync(
    path.join(root, 'src-tauri', 'Cargo.lock'),
    'utf8',
  );
  const { status, lines } = checkResult(
    tauriPairs(readNpmVersions(root), readCrateVersions(lock)),
  );
  console.log(lines.join('\n'));
  return status;
}
// Only check when run as a script, so the tests can import the parts.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv[2] ?? REPO_ROOT);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
