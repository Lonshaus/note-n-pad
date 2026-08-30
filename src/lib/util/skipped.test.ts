// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { zhTW } from '../i18n/zh-TW';
import type { SkipReason } from './protocol';
import { revealKey, skipReasonKey } from './skipped';

const REASONS: SkipReason[] = [
  'notJson',
  'unreadable',
  'unparsable',
  'invalid',
  'foreignId',
  'duplicateId',
];

describe('skipReasonKey', () => {
  it('maps every reason to a distinct key', () => {
    const keys = REASONS.map(skipReasonKey);
    expect(new Set(keys).size).toBe(REASONS.length);
  });

  it('maps every reason to a key that exists', () => {
    // A key with no string would render as `undefined` in the panel rather
    // than fail anywhere the type checker can see.
    for (const reason of REASONS) {
      expect(zhTW[skipReasonKey(reason)]).toBeTruthy();
    }
  });
});

describe('revealKey', () => {
  it('names the file browser the platform actually has', () => {
    expect(revealKey({ isMacOS: true, isWindows: false })).toBe(
      'skipped.reveal.macos',
    );
    expect(revealKey({ isMacOS: false, isWindows: true })).toBe(
      'skipped.reveal.windows',
    );
    expect(revealKey({ isMacOS: false, isWindows: false })).toBe(
      'skipped.reveal.linux',
    );
  });
});
