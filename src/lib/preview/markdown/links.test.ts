// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { linkKind, showsAsLink } from './links';

describe('linkKind', () => {
  it('names the three schemes the OS may be handed', () => {
    expect(linkKind('http://example.com/a')).toBe('external');
    expect(linkKind('https://example.com/a')).toBe('external');
    expect(linkKind('mailto:someone@example.com')).toBe('external');
    expect(linkKind('HTTPS://EXAMPLE.COM/A')).toBe('external');
  });

  it('blocks every other scheme rather than calling it a path', () => {
    for (const dest of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'about:blank',
      'ftp://example.com/a',
      'x-note-n-pad-evil:whatever',
      // A Windows drive letter parses as a scheme, which is the safe reading:
      // the Rust guard refuses a colon in a destination anyway.
      'C:\\Windows\\win.ini',
    ]) {
      expect(linkKind(dest)).toBe('blocked');
    }
  });

  it('is not walked past by case or by leading control characters', () => {
    // Both are stripped by the URL parser before a browser reads a scheme, so
    // a check that trusted the raw first character would call these relative
    // paths and hand them to the document-opening command.
    expect(linkKind(' JavaScript:alert(1)')).toBe('blocked');
    expect(linkKind('\u0001\t\nJAVASCRIPT:alert(1)')).toBe('blocked');
    expect(linkKind('  https://example.com/a  ')).toBe('external');
  });

  it('treats an in-document anchor as neither a file nor a link', () => {
    expect(linkKind('#heading')).toBe('anchor');
    expect(linkKind(' #heading')).toBe('anchor');
  });

  it('leaves everything else for the Rust core to resolve or refuse', () => {
    expect(linkKind('b.md')).toBe('relative');
    expect(linkKind('./sub/b.md')).toBe('relative');
    expect(linkKind('a%20b.md')).toBe('relative');
    // Refused there, not here: this only says nothing local claimed it.
    expect(linkKind('../secret.md')).toBe('relative');
    expect(linkKind('//evil.example/x')).toBe('relative');
  });

  it('blocks an empty destination instead of opening the folder', () => {
    expect(linkKind('')).toBe('blocked');
    expect(linkKind('   ')).toBe('blocked');
  });
});

describe('showsAsLink', () => {
  it('keeps a relative link behind the images setting alone', () => {
    expect(showsAsLink('relative', true, false, false)).toBe(true);
    expect(showsAsLink('relative', false, false, false)).toBe(false);
    // The new allowance must not reach `relative`: it has no document folder
    // to resolve against wherever it is granted.
    expect(showsAsLink('relative', false, true, false)).toBe(false);
  });

  it('opens an external link under either the images setting or the new allowance', () => {
    expect(showsAsLink('external', true, false, false)).toBe(true);
    expect(showsAsLink('external', false, true, false)).toBe(true);
    expect(showsAsLink('external', false, false, false)).toBe(false);
  });

  it('opens an anchor with a target regardless of either setting', () => {
    expect(showsAsLink('anchor', false, false, true)).toBe(true);
    expect(showsAsLink('anchor', false, false, false)).toBe(false);
  });

  it('never shows a blocked destination as a link', () => {
    expect(showsAsLink('blocked', true, true, false)).toBe(false);
  });
});
