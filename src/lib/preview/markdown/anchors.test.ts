// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { anchorSlug } from './anchors';
import { scanBlocks } from './scan';

describe('anchorSlug', () => {
  it('is null for anything that is not an anchor', () => {
    expect(anchorSlug('other.md')).toBeNull();
    expect(anchorSlug('https://example.com/#frag')).toBeNull();
    expect(anchorSlug('')).toBeNull();
  });

  it('slugs the fragment so a link matches the heading it names', () => {
    expect(anchorSlug('#getting-started')).toBe('getting-started');
    expect(anchorSlug('#Getting Started')).toBe('getting-started');
  });

  it('decodes a percent-encoded fragment', () => {
    expect(anchorSlug(`#${encodeURIComponent('安裝步驟')}`)).toBe('安裝步驟');
  });

  it('falls back to the literal text on a malformed escape', () => {
    // `decodeURIComponent` throws here; the `%` is then dropped as punctuation.
    expect(anchorSlug('#a%zz')).toBe('azz');
  });

  it('is empty for a bare hash, which names no heading', () => {
    expect(anchorSlug('#')).toBe('');
  });
});

describe('an anchor and the heading it names agree', () => {
  // The two sides slug independently — the scanner over heading lines, this
  // module over link destinations. A rule applied on one side only would leave
  // every link of that shape dead, so they are checked against each other.
  const lookup = (doc: string, dest: string): number | undefined => {
    const slug = anchorSlug(dest);
    return slug === null ? undefined : scanBlocks(doc).headings.get(slug);
  };

  it('matches a plain heading', () => {
    expect(lookup('# Getting Started\n', '#getting-started')).toBe(0);
  });

  it('matches a heading carrying punctuation the slug drops', () => {
    expect(lookup("# What's next?\n", '#whats-next')).toBe(0);
  });

  it('matches a CJK heading through its percent-encoded link', () => {
    const doc = 'intro\n\n## 安裝步驟\n';
    expect(lookup(doc, `#${encodeURIComponent('安裝步驟')}`)).toBe(1);
  });

  it('matches the suffixed second heading of a repeated title', () => {
    const doc = '# Notes\n\ntext\n\n# Notes\n';
    expect(lookup(doc, '#notes')).toBe(0);
    expect(lookup(doc, '#notes-1')).toBe(2);
  });

  it('finds nothing for an anchor naming no heading', () => {
    expect(lookup('# Real\n', '#imaginary')).toBeUndefined();
  });
});
