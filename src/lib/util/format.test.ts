// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { formatFileSize } from './format';

describe('formatFileSize', () => {
  it('shows whole bytes below 1 KiB', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('rolls up to the largest fitting unit', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(100 * 1024 * 1024)).toBe('100 MB');
    expect(formatFileSize(120.5 * 1024 * 1024)).toBe('120.5 MB');
    expect(formatFileSize(1.2 * 1024 * 1024 * 1024)).toBe('1.2 GB');
  });

  it('keeps one decimal place for scaled units', () => {
    // 1536 bytes = 1.5 KiB.
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('clamps negatives to zero', () => {
    expect(formatFileSize(-10)).toBe('0 B');
  });
});
