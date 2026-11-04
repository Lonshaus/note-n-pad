// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Guards the generator's lookup of vendored licence texts: the cargo registry
// is found under $CARGO_HOME, and a missing source folder or licence file fails
// loudly instead of silently falling back to a generic text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { npmInvocation, vendoredOverrideText } from './gen-licenses.mjs';

describe('vendored licence override lookup', () => {
  const originalCargoHome = process.env.CARGO_HOME;
  let tempHome = null;
  /** Point CARGO_HOME at a temp registry; `files` are created inside `brotli-1.0.0`, none when null. */
  function makeRegistry(files) {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cargo-home-'));
    if (files !== null) {
      const dir = path.join(
        tempHome,
        'registry',
        'src',
        'index.crates.io-test',
        'brotli-1.0.0',
      );
      fs.mkdirSync(dir, { recursive: true });
      for (const file of files) {
        fs.writeFileSync(path.join(dir, file), `text of ${file}`);
      }
    }
    process.env.CARGO_HOME = tempHome;
  }

  afterEach(() => {
    if (originalCargoHome === undefined) {
      delete process.env.CARGO_HOME;
    } else {
      process.env.CARGO_HOME = originalCargoHome;
    }
    if (tempHome !== null) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = null;
    }
  });

  it('reads the real text from the registry under CARGO_HOME', () => {
    makeRegistry(['LICENSE.BSD-3-Clause']);
    expect(vendoredOverrideText('brotli', '1.0.0')).toBe(
      'text of LICENSE.BSD-3-Clause',
    );
  });

  it('throws naming the crate when its source folder is missing', () => {
    makeRegistry(null);
    expect(() => vendoredOverrideText('brotli', '1.0.0')).toThrow(/brotli/);
  });

  it('throws naming the crate when its licence file is missing', () => {
    makeRegistry([]);
    expect(() => vendoredOverrideText('brotli', '1.0.0')).toThrow(/brotli/);
  });

  it('returns null for a crate without an override', () => {
    makeRegistry([]);
    expect(vendoredOverrideText('serde', '1.0.0')).toBeNull();
  });
});

describe('npm invocation', () => {
  let tempDir = null;
  afterEach(() => {
    if (tempDir !== null) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('runs npm_execpath through the current node when it is set', () => {
    expect(
      npmInvocation({ npm_execpath: '/x/npm-cli.js' }, 'win32', '/n/node'),
    ).toEqual({ cmd: '/n/node', prefixArgs: ['/x/npm-cli.js'] });
  });

  it('starts plain npm on other platforms', () => {
    expect(npmInvocation({}, 'darwin', '/n/node')).toEqual({
      cmd: 'npm',
      prefixArgs: [],
    });
  });

  it('runs the npm-cli.js beside node.exe on Windows', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-node-dir-'));
    const cli = path.join(tempDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '');
    const nodeExe = path.join(tempDir, 'node.exe');
    expect(npmInvocation({}, 'win32', nodeExe)).toEqual({
      cmd: nodeExe,
      prefixArgs: [cli],
    });
  });

  it('throws when no npm-cli.js sits beside node.exe on Windows', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-node-dir-'));
    expect(() =>
      npmInvocation({}, 'win32', path.join(tempDir, 'node.exe')),
    ).toThrow(/npm-cli\.js not found/);
  });
});
