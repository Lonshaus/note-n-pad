// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect } from 'vitest';
import { shouldFloatOnTop } from './pinFloat';

describe('shouldFloatOnTop', () => {
  it('top always floats regardless of tracking', () => {
    expect(shouldFloatOnTop('top', false)).toBe(true);
    expect(shouldFloatOnTop('top', true)).toBe(true);
  });

  it('app floats only when follow tracking is unavailable', () => {
    // Tracking works (macOS / Windows / X11): start un-floated, poller decides.
    expect(shouldFloatOnTop('app', false)).toBe(false);
    // Tracking unavailable (Wayland): degrade to permanent on-top.
    expect(shouldFloatOnTop('app', true)).toBe(true);
  });

  it('none never floats', () => {
    expect(shouldFloatOnTop('none', false)).toBe(false);
    expect(shouldFloatOnTop('none', true)).toBe(false);
  });
});
