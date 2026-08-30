#!/usr/bin/env node
// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Generates src-tauri/resources/licenses.json: the full third-party licence
// index for the acknowledgements screen, which renders it.
// Zero deps, matching the style of scripts/auto.mjs.
//
//   node scripts/gen-licenses.mjs
//
// Requires `cargo-bundle-licenses` (cargo install cargo-bundle-licenses) and a
// populated ~/.cargo/registry/src cache (the same one cargo build already used).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');
const SRC_TAURI = path.join(REPO_ROOT, 'src-tauri');
const OUTPUT_FILE = path.join(SRC_TAURI, 'resources', 'licenses.json');
const CANONICAL_DIR = path.join(SCRIPT_DIR, 'license-texts');

// Every OS/arch Note&Pad bundles for (see tauri.conf.json's `bundle` config).
// `cargo tree` needs no toolchain installed for a target — it works from
// Cargo.lock/metadata alone — so this union is cheap to compute for targets
// nobody has built locally. Switching to "ship everything cargo-bundle-licenses
// finds" (471 entries, including build-script/proc-macro/Android/UEFI-only
// crates that never reach a desktop binary) is a one-line change: skip the
// shipped-set filter below and use every entry cargo-bundle-licenses emits.
const DESKTOP_TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
];

// `normal,no-proc-macro` excludes build/dev edges (as `normal` alone does)
// *and* proc-macro subtrees. A proc-macro crate is compiled for the host and
// run at compile time — its own code, and everything it depends on, is never
// linked into the shipped binary (e.g. `selectors` is only reachable via
// `tauri-macros`, a proc-macro, and never ships). Without `no-proc-macro` the
// filter below silently claims compile-time-only crates as distributed.
const CARGO_TREE_EDGES = 'normal,no-proc-macro';

const NOT_FOUND = 'NOT FOUND';

// The two crates whose real licence text exists under a filename
// cargo-bundle-licenses doesn't try (see the file-by-file check that found
// this): the tool reports "NOT FOUND" for one of their declared licences even
// though the crate ships real text under an unusual name. Read the real file
// instead of falling back to a generic canonical text.
const VENDORED_LICENSE_OVERRIDES = {
  brotli: ['LICENSE.BSD-3-Clause'],
  encoding_rs: ['LICENSE-WHATWG'],
};

/** Run a command and return its stdout as a string; stderr is inherited so warnings are visible. */
function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf8');
}

/** Read a checked-in canonical licence text for an SPDX id, or null if we don't have one. */
function canonicalText(spdxId) {
  const file = path.join(CANONICAL_DIR, `${spdxId}.txt`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Find `<name>-<version>`'s extracted source directory under the local cargo registry cache. */
function findRegistrySrcDir(name, version) {
  const base = path.join(os.homedir(), '.cargo', 'registry', 'src');
  if (!fs.existsSync(base)) {
    return null;
  }
  for (const indexDir of fs.readdirSync(base)) {
    const candidate = path.join(base, indexDir, `${name}-${version}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Real licence text for a package in VENDORED_LICENSE_OVERRIDES, or null. */
function vendoredOverrideText(name, version) {
  const filenames = VENDORED_LICENSE_OVERRIDES[name];
  if (!filenames) {
    return null;
  }
  const dir = findRegistrySrcDir(name, version);
  if (!dir) {
    return null;
  }
  for (const filename of filenames) {
    const file = path.join(dir, filename);
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8');
    }
  }
  return null;
}

/** The union of `name@version` pairs reachable via normal (non-dev, non-build) deps for every desktop target. */
function shippedCrateSet() {
  const shipped = new Set();
  for (const target of DESKTOP_TARGETS) {
    const output = run(
      'cargo',
      ['tree', '-e', CARGO_TREE_EDGES, '--target', target, '--prefix', 'none'],
      SRC_TAURI,
    );
    const lines = output.split('\n').filter((line) => line.trim().length > 0);
    // The first line is always the root package itself (this crate), never a
    // third-party dependency, so it is always skipped.
    for (const line of lines.slice(1)) {
      const match = line.match(/^(\S+) v(\S+)/);
      if (match) {
        shipped.add(`${match[1]}@${match[2]}`);
      }
    }
  }
  return shipped;
}

/** `name@version` -> declared Cargo.toml authors, from `cargo metadata`. */
function cargoAuthorsMap() {
  const metadata = JSON.parse(
    run('cargo', ['metadata', '--format-version', '1'], SRC_TAURI),
  );
  const map = new Map();
  for (const pkg of metadata.packages) {
    map.set(`${pkg.name}@${pkg.version}`, pkg.authors ?? []);
  }
  return map;
}

/** One package's licence texts, in declaration order, filling gaps as described in the module doc. */
function cargoLicenseTexts(entry) {
  return entry.licenses.map((licence) => {
    if (licence.text && licence.text !== NOT_FOUND) {
      return licence.text;
    }
    const vendored = vendoredOverrideText(
      entry.package_name,
      entry.package_version,
    );
    if (vendored) {
      return vendored;
    }
    const canonical = canonicalText(licence.license);
    if (canonical) {
      return canonical;
    }
    throw new Error(
      `no licence text for cargo package ${entry.package_name}@${entry.package_version} ` +
        `(${licence.license}); add scripts/license-texts/${licence.license}.txt`,
    );
  });
}

/** All cargo packages actually shipped, as { name, version, ecosystem, license, repository, authors, texts }. */
function cargoPackages() {
  const shipped = shippedCrateSet();
  const authorsMap = cargoAuthorsMap();
  const bundle = JSON.parse(
    run(
      'cargo',
      ['bundle-licenses', '--format', 'json', '--output', '-'],
      SRC_TAURI,
    ),
  );
  return bundle.third_party_libraries
    .filter((entry) =>
      shipped.has(`${entry.package_name}@${entry.package_version}`),
    )
    .map((entry) => ({
      name: entry.package_name,
      version: entry.package_version,
      ecosystem: 'cargo',
      license: entry.license,
      repository: entry.repository ?? '',
      authors:
        authorsMap.get(`${entry.package_name}@${entry.package_version}`) ?? [],
      texts: cargoLicenseTexts(entry),
    }));
}

/** Every distinct { name, version } in the production npm dependency tree. */
function npmProductionPackages() {
  const tree = JSON.parse(
    run('npm', ['ls', '--omit=dev', '--all', '--json'], REPO_ROOT),
  );
  const versions = new Map();
  const walk = (node) => {
    for (const [name, info] of Object.entries(node.dependencies ?? {})) {
      if (info.version) {
        versions.set(`${name}@${info.version}`, {
          name,
          version: info.version,
        });
      }
      walk(info);
    }
  };
  walk(tree);
  return [...versions.values()];
}

/** Licence-file basenames present directly in `dir` (case-insensitive, may be more than one for dual licences). */
function licenseFilesIn(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const patterns = [
    /^licen[cs]e(\.(md|txt))?$/i,
    /^licen[cs]e[-_]mit$/i,
    /^licen[cs]e[-_]apache(-2\.0)?$/i,
    /^copying$/i,
  ];
  return fs
    .readdirSync(dir)
    .filter((name) => patterns.some((pattern) => pattern.test(name)))
    .sort();
}

/** Split a simple SPDX "A OR B", "A/B" expression into its component ids (no AND/parens support needed today). */
function splitLicenseExpression(expression) {
  return expression
    .split(/\s+OR\s+|\//i)
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Person names from package.json's `author`/`contributors` fields, deduped. */
function npmAuthors(pkgJson) {
  const names = new Set();
  const addPerson = (person) => {
    if (!person) {
      return;
    }
    if (typeof person === 'string') {
      names.add(person.replace(/\s*[<(].*$/, '').trim());
    } else if (typeof person === 'object' && person.name) {
      names.add(person.name);
    }
  };
  addPerson(pkgJson.author);
  for (const contributor of pkgJson.contributors ?? []) {
    addPerson(contributor);
  }
  return [...names];
}

/** A `git+https://...git` repository field normalized to a plain URL. */
function npmRepository(pkgJson) {
  const repo = pkgJson.repository;
  const raw = typeof repo === 'string' ? repo : (repo?.url ?? '');
  return raw.replace(/^git\+/, '').replace(/\.git$/, '');
}

/** One npm package's licence texts: its own file(s), or the canonical text of its declared licence. */
function npmLicenseTexts(name, version, dir, pkgJson) {
  const files = licenseFilesIn(dir);
  if (files.length > 0) {
    return files.map((file) => fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  const declared = typeof pkgJson.license === 'string' ? pkgJson.license : '';
  const ids = splitLicenseExpression(declared);
  if (ids.length === 0) {
    throw new Error(
      `no licence file and no declared license for npm package ${name}@${version}`,
    );
  }
  return ids.map((id) => {
    const canonical = canonicalText(id);
    if (!canonical) {
      throw new Error(
        `no licence text for npm package ${name}@${version} (declared ${declared}); ` +
          `add scripts/license-texts/${id}.txt`,
      );
    }
    return canonical;
  });
}

/** All production npm packages, plus svelte (a devDependency whose compiled output ships in dist/). */
function npmPackages() {
  const packages = npmProductionPackages();
  const result = packages.map(({ name, version }) => {
    const dir = path.join(REPO_ROOT, 'node_modules', name);
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    // The tree can name a version that is not the hoisted one when two versions
    // of a package coexist, in which case this reads the wrong package's
    // licence. Nothing in the current tree does that, and attributing the wrong
    // text is worse than failing, so it stops rather than guessing.
    if (pkgJson.version !== version) {
      throw new Error(
        `npm package ${name}@${version} is not the copy at node_modules/${name} ` +
          `(that one is ${pkgJson.version}); resolve the nested copy before attributing it`,
      );
    }
    return {
      name,
      version,
      ecosystem: 'npm',
      license: typeof pkgJson.license === 'string' ? pkgJson.license : '',
      repository: npmRepository(pkgJson),
      authors: npmAuthors(pkgJson),
      texts: npmLicenseTexts(name, version, dir, pkgJson),
    };
  });

  // svelte is a devDependency, but Svelte 5's compiler output imports
  // `svelte/internal/client`, which Vite bundles straight into dist/ — so its
  // runtime ships in every build even though `npm ls --omit=dev` never lists
  // it. No other devDependency contributes runtime code (checked by hand).
  // Guarded so that promoting svelte to a real dependency lists it once, not twice.
  if (result.some((pkg) => pkg.name === 'svelte')) {
    return result;
  }
  const rootPkgJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const svelteVersion = rootPkgJson.devDependencies.svelte.replace(/^\D*/, '');
  const svelteDir = path.join(REPO_ROOT, 'node_modules', 'svelte');
  const sveltePkgJson = JSON.parse(
    fs.readFileSync(path.join(svelteDir, 'package.json'), 'utf8'),
  );
  result.push({
    name: 'svelte',
    version: sveltePkgJson.version ?? svelteVersion,
    ecosystem: 'npm',
    license:
      typeof sveltePkgJson.license === 'string' ? sveltePkgJson.license : '',
    repository: npmRepository(sveltePkgJson),
    authors: npmAuthors(sveltePkgJson),
    texts: [fs.readFileSync(path.join(svelteDir, 'LICENSE.md'), 'utf8')],
  });

  return result;
}

/** Plain ordinal string comparison — stable across machines/Node builds, unlike locale-aware `localeCompare`. */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort by ecosystem, then name, then version — the order the output format requires. */
function sortPackages(packages) {
  return [...packages].sort(
    (a, b) =>
      compareStrings(a.ecosystem, b.ecosystem) ||
      compareStrings(a.name, b.name) ||
      compareStrings(a.version, b.version),
  );
}

/** Deduplicate every package's texts against a shared pool, by exact string equality, in first-use order. */
function buildTextsAndIndices(sortedPackages) {
  const texts = [];
  const indexOf = new Map();
  const packages = sortedPackages.map((pkg) => {
    // A dual-licensed package declares several licences that can carry the
    // same text (dunce declares three, all identical), so the same pooled
    // index would otherwise be listed two or three times for one package —
    // showing the reader the same licence twice, and giving the UI duplicate
    // keys to render. Keep first use only.
    const seen = new Set();
    const indices = [];
    for (const text of pkg.texts) {
      let index = indexOf.get(text);
      if (index === undefined) {
        index = texts.length;
        texts.push(text);
        indexOf.set(text, index);
      }
      if (!seen.has(index)) {
        seen.add(index);
        indices.push(index);
      }
    }
    const { texts: _omit, ...rest } = pkg;
    return { ...rest, texts: indices };
  });
  return { texts, packages };
}

/**
 * SHA-256 of the two dependency lockfiles, stamped into the output so a stale
 * licenses.json can be detected without regenerating it (which needs
 * cargo-bundle-licenses and a populated registry cache). Every dependency
 * change moves at least one of these two files, so a mismatch means the
 * generator has not been re-run since. See scripts/gen-licenses.test.mjs.
 */
export function lockfileDigests() {
  const digest = (file) =>
    crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return {
    cargoLock: digest(path.join(SRC_TAURI, 'Cargo.lock')),
    npmLock: digest(path.join(REPO_ROOT, 'package-lock.json')),
  };
}

function main() {
  const packages = sortPackages([...cargoPackages(), ...npmPackages()]);
  for (const pkg of packages) {
    if (pkg.texts.length === 0) {
      throw new Error(
        `package ${pkg.ecosystem}:${pkg.name}@${pkg.version} has zero licence texts`,
      );
    }
  }
  const { texts, packages: indexedPackages } = buildTextsAndIndices(packages);
  // `inputs` first so the freshness stamp is the head of the file rather than
  // buried after 600 KB of licence text.
  const output = `${JSON.stringify({ inputs: lockfileDigests(), texts, packages: indexedPackages }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, output);
  const cargoCount = indexedPackages.filter(
    (p) => p.ecosystem === 'cargo',
  ).length;
  const npmCount = indexedPackages.filter((p) => p.ecosystem === 'npm').length;
  console.log(
    `wrote ${OUTPUT_FILE}: ${indexedPackages.length} packages (${cargoCount} cargo, ${npmCount} npm), ${texts.length} distinct texts`,
  );
}

// Only generate when run as a script. The freshness test imports this module
// for `lockfileDigests`, and importing it must not rewrite the output file.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
