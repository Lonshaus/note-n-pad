// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The policy ships twice: the documents at the repo root are what the store
// listings link to, and the copies under src-tauri/resources are what the app
// shows with no network. Editing one and forgetting the other would put a
// stale policy in front of every offline reader with nothing else to notice.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENTS,
  LITE_DOCUMENTS,
  stripLanguageSwitcher,
} from './gen-privacy.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'src-tauri', 'resources', 'privacy');
const LITE_OUT_DIR = path.join(
  REPO_ROOT,
  'src-tauri',
  'resources',
  'privacy-lite',
);

describe('bundled privacy policy', () => {
  it('matches the documents at the repo root', () => {
    for (const [source, target] of DOCUMENTS) {
      const want = stripLanguageSwitcher(
        fs.readFileSync(path.join(REPO_ROOT, source), 'utf8'),
      );
      const bundled = path.join(OUT_DIR, target);
      expect(fs.existsSync(bundled), `${target} is missing`).toBe(true);
      expect(fs.readFileSync(bundled, 'utf8'), `${target} is stale`).toBe(want);
    }
  });

  it('carries no link to a document that does not ship', () => {
    // The root files open with a row of links to their siblings. Those files
    // are not in the bundle, so in the app that row is three dead links.
    for (const [, target] of DOCUMENTS) {
      const text = fs.readFileSync(path.join(OUT_DIR, target), 'utf8');
      expect(/\]\(PRIVACY[.\w-]*\.md\)/.test(text), target).toBe(false);
    }
  });
});

describe('bundled Lite privacy policy', () => {
  it('matches the Lite documents at the repo root', () => {
    for (const [source, target] of LITE_DOCUMENTS) {
      const want = stripLanguageSwitcher(
        fs.readFileSync(path.join(REPO_ROOT, source), 'utf8'),
      );
      const bundled = path.join(LITE_OUT_DIR, target);
      expect(fs.existsSync(bundled), `${target} is missing`).toBe(true);
      expect(fs.readFileSync(bundled, 'utf8'), `${target} is stale`).toBe(want);
    }
  });

  it('carries no link to a document that does not ship', () => {
    for (const [, target] of LITE_DOCUMENTS) {
      const text = fs.readFileSync(path.join(LITE_OUT_DIR, target), 'utf8');
      expect(/\]\(PRIVACY[.\w-]*\.md\)/.test(text), target).toBe(false);
    }
  });

  it('is a policy of its own, in the same three languages as the full one', () => {
    expect(LITE_DOCUMENTS.map(([, target]) => target)).toEqual(
      DOCUMENTS.map(([, target]) => target),
    );
    for (const [source, target] of LITE_DOCUMENTS) {
      expect(source).toMatch(/^PRIVACY-Lite/);
      const text = fs.readFileSync(path.join(LITE_OUT_DIR, target), 'utf8');
      expect(text, target).toContain('Note&Pad Lite');
    }
  });

  it('is not the full policy under another name', () => {
    for (const [index, [, target]] of LITE_DOCUMENTS.entries()) {
      const lite = fs.readFileSync(path.join(LITE_OUT_DIR, target), 'utf8');
      const full = fs.readFileSync(
        path.join(OUT_DIR, DOCUMENTS[index][1]),
        'utf8',
      );
      expect(lite).not.toBe(full);
    }
  });
});

describe('stripLanguageSwitcher', () => {
  it('removes the switcher without eating the heading', () => {
    expect(
      stripLanguageSwitcher(
        '# Privacy Policy\n\nEnglish · [正體中文](PRIVACY.zh-TW.md)\n\nLast updated: today\n',
      ),
    ).toBe('# Privacy Policy\n\nLast updated: today\n');
  });

  it('leaves a document with no switcher alone', () => {
    const text = '# Privacy Policy\n\nLast updated: today\n';
    expect(stripLanguageSwitcher(text)).toBe(text);
  });
});
