// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { docimgUrl, previewImagesReady } from './images';

/** What the Rust side does to recover the destination: read the `p` parameter
 *  and undo exactly one percent-encoding. */
function destOf(url: string): string {
  const query = url.slice(url.indexOf('?') + 1);
  const value = query
    .split('&')
    .find((pair) => pair.startsWith('p='))
    ?.slice(2);
  return decodeURIComponent(value ?? '');
}

describe('docimgUrl', () => {
  it('uses the scheme origin off Windows and the http one on it', () => {
    expect(docimgUrl('a.png', false)).toBe('docimg://localhost/?p=a.png');
    expect(docimgUrl('a.png', true)).toBe('http://docimg.localhost/?p=a.png');
  });

  it('round-trips a destination carrying URL punctuation and non-ASCII', () => {
    const dests = [
      'my image.png',
      'a#b.png',
      'a?b.png',
      'a&b=c.png',
      'sub/圖 片.png',
      // Already percent-encoded in the source: the escape must survive as the
      // literal characters `%20`, for the Rust guard to decode itself.
      'a%20b.png',
      '../secret.png',
    ];
    for (const dest of dests) {
      for (const windows of [false, true]) {
        expect(destOf(docimgUrl(dest, windows))).toBe(dest);
      }
    }
  });

  it('leaves no separator unencoded for a second parameter to hide behind', () => {
    // A destination containing `&p=` must not smuggle in a second `p`.
    const url = docimgUrl('a&p=../secret.png', false);
    expect(url.split('&')).toHaveLength(1);
    expect(destOf(url)).toBe('a&p=../secret.png');
  });
});

describe('previewImagesReady', () => {
  const DIR = '/docs';

  it('is false with the setting off, however registered', () => {
    expect(previewImagesReady(false, DIR, DIR)).toBe(false);
  });

  it('is false until the registration lands', () => {
    // The bug this guards: rendering here sends a request the core refuses,
    // and the node latches that refusal for the rest of its life.
    expect(previewImagesReady(true, DIR, null)).toBe(false);
  });

  it('is true once the core has confirmed this document folder', () => {
    expect(previewImagesReady(true, DIR, DIR)).toBe(true);
  });

  it('is false while the registered folder is still the previous one', () => {
    expect(previewImagesReady(true, DIR, '/other')).toBe(false);
  });

  it('is false for an unsaved tab, whose folder is null on both sides', () => {
    expect(previewImagesReady(true, null, null)).toBe(false);
  });
});
