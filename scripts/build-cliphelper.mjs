#!/usr/bin/env node
// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Builds the Windows clipboard helper (src-tauri/cliphelper) and copies it to
// src-tauri/binaries/cliphelper-<triple>.exe, where tauri.windows.conf.json's
// externalBin and tauri-build look for it.
//
//   node scripts/build-cliphelper.mjs [--target <triple>] [--stub]
//
// The target is --target, else TAURI_ENV_TARGET_TRIPLE, else rustc's host. A
// target that is not Windows needs no helper, so the script does nothing.
// --stub writes an empty file instead of building, for a Windows-target
// `cargo clippy` on a machine with no Windows linker.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');
const SRC_TAURI = path.join(REPO_ROOT, 'src-tauri');
/** The target triple the build is for. */
export function pickTarget(argv, env, hostTriple) {
  const at = argv.indexOf('--target');
  if (at !== -1) {
    const value = argv[at + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--target needs a triple');
    }
    return value;
  }
  return env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
}
/** Whether `triple` is a Windows target. */
export function isWindows(triple) {
  return triple.includes('-windows-');
}

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('host:'));
  if (line === undefined) {
    throw new Error('rustc -vV printed no host line');
  }
  return line.slice('host:'.length).trim();
}

function main() {
  const argv = process.argv.slice(2);
  const triple = pickTarget(argv, process.env, hostTriple);
  if (!isWindows(triple)) {
    return;
  }
  const outDir = path.join(SRC_TAURI, 'binaries');
  const output = path.join(outDir, `cliphelper-${triple}.exe`);
  fs.mkdirSync(outDir, { recursive: true });
  if (argv.includes('--stub')) {
    fs.writeFileSync(output, '');
    console.log(`wrote the empty stub ${output}`);
    return;
  }
  const targetDir = path.join(SRC_TAURI, 'target', 'cliphelper');
  execFileSync(
    'cargo',
    [
      'build',
      '--release',
      '--manifest-path',
      path.join(SRC_TAURI, 'cliphelper', 'Cargo.toml'),
      '--target',
      triple,
      '--target-dir',
      targetDir,
    ],
    { stdio: 'inherit' },
  );
  fs.copyFileSync(
    path.join(targetDir, triple, 'release', 'cliphelper.exe'),
    output,
  );
  console.log(`wrote ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
