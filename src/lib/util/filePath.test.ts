// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { fileName, retargetPath, type PathRules } from './filePath';

describe('fileName', () => {
  it('takes the last segment of a posix path', () => {
    expect(fileName('/Users/someone/notes/a.txt')).toBe('a.txt');
  });

  it('takes the last segment of a windows path', () => {
    expect(fileName('C:\\Users\\someone\\notes\\a.txt')).toBe('a.txt');
  });

  it('splits on either separator within one path', () => {
    // A path can carry both: a Windows path handed to a posix build, or the
    // other way round, and neither platform should show the rest of the path.
    expect(fileName('C:/Users\\someone/a.txt')).toBe('a.txt');
  });

  it('returns a bare name unchanged', () => {
    expect(fileName('a.txt')).toBe('a.txt');
  });

  it('keeps a name that is only an extension', () => {
    expect(fileName('/Users/someone/.gitignore')).toBe('.gitignore');
  });

  it('is empty when there is no last segment, so the caller picks a stand-in', () => {
    expect(fileName('')).toBe('');
    expect(fileName('/Users/someone/')).toBe('');
    expect(fileName('C:\\Users\\someone\\')).toBe('');
  });
});

describe('retargetPath', () => {
  const posix: PathRules = { caseInsensitive: false, backslash: false };
  const mac: PathRules = { caseInsensitive: true, backslash: false };
  const windows: PathRules = { caseInsensitive: true, backslash: true };

  it('replaces the path itself and everything below it', () => {
    expect(retargetPath('/a/f.txt', '/a/f.txt', '/a/g.txt', posix)).toBe(
      '/a/g.txt',
    );
    expect(retargetPath('/a/y/f.txt', '/a/y', '/a/z', posix)).toBe(
      '/a/z/f.txt',
    );
    expect(retargetPath('/a/y/b/c.txt', '/a/y', '/a/z', posix)).toBe(
      '/a/z/b/c.txt',
    );
  });

  it('matches whole segments, never a string prefix', () => {
    expect(retargetPath('/a/Tools2/f', '/a/Tools', '/a/X', posix)).toBe(
      '/a/Tools2/f',
    );
    expect(retargetPath('/a/Tools2', '/a/Tools', '/a/X', posix)).toBe(
      '/a/Tools2',
    );
    expect(retargetPath('/a/Tools-old/f', '/a/Tools', '/a/X', posix)).toBe(
      '/a/Tools-old/f',
    );
  });

  it('leaves unrelated, shorter and empty paths alone', () => {
    expect(retargetPath('/b/f.txt', '/a', '/c', posix)).toBe('/b/f.txt');
    expect(retargetPath('/a', '/a/y', '/a/z', posix)).toBe('/a');
    expect(retargetPath('', '/a', '/c', posix)).toBe('');
    expect(retargetPath('/a/f', '', '/c', posix)).toBe('/a/f');
  });

  it('ignores case only where the platform does', () => {
    expect(retargetPath('/A/y/f', '/a/Y', '/a/z', mac)).toBe('/a/z/f');
    expect(retargetPath('/A/y/f', '/a/Y', '/a/z', posix)).toBe('/A/y/f');
  });

  it('reads both separators on Windows only', () => {
    expect(retargetPath('C:\\p\\y/f.txt', 'C:/p/y', 'C:\\p\\z', windows)).toBe(
      'C:\\p\\z/f.txt',
    );
    // Elsewhere a backslash is part of a name: `y\\f` is one segment.
    expect(retargetPath('/p/y\\f', '/p/y', '/p/z', posix)).toBe('/p/y\\f');
    expect(retargetPath('/p/y\\f', '/p/y\\f', '/p/z', posix)).toBe('/p/z');
  });

  it('keeps what follows the moved part verbatim', () => {
    expect(retargetPath('/a/y//f.txt', '/a/y', '/a/z', posix)).toBe(
      '/a/z//f.txt',
    );
  });
});
