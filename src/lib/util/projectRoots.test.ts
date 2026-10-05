// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { projectRootsFrom } from './projectRoots';

describe('projectRootsFrom', () => {
  it('reads the roots nested under settings', () => {
    const loaded = {
      settings: { project_roots: ['/a', '/b'] },
      repaired_fields: [],
      snapshot_dir_unavailable: false,
    };
    expect(projectRootsFrom(loaded)).toEqual(['/a', '/b']);
  });

  it('returns no roots when none are saved', () => {
    expect(projectRootsFrom({ settings: {} })).toEqual([]);
  });
});
