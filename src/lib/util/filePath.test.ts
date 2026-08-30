// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { fileName } from './filePath';

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
