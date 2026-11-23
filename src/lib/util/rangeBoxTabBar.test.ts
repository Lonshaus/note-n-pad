// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  dragModalOpen,
  keepsBoxFocus,
  tabBarAllowed,
  type DragModalFacts,
  type TabBarAction,
} from './rangeBoxTabBar';

describe('tabBarAllowed', () => {
  it('allows only a drag while the box is open', () => {
    expect(tabBarAllowed('drag', true)).toBe(true);
    expect(tabBarAllowed('switch', true)).toBe(false);
    expect(tabBarAllowed('unlock', true)).toBe(false);
    expect(tabBarAllowed('new', true)).toBe(false);
  });

  it.each<TabBarAction>(['drag', 'switch', 'unlock', 'new'])(
    'allows %s while the box is closed',
    (action) => {
      expect(tabBarAllowed(action, false)).toBe(true);
    },
  );
});

describe('keepsBoxFocus', () => {
  it('keeps the focus in the box only while it is open', () => {
    expect(keepsBoxFocus(true)).toBe(true);
    expect(keepsBoxFocus(false)).toBe(false);
  });
});

describe('dragModalOpen', () => {
  const none: DragModalFacts = {
    confirmClose: false,
    missingItem: false,
    gateVisible: false,
    windowedError: false,
    otherDialogs: false,
    boxConflict: false,
  };

  it('is false when nothing is up', () => {
    expect(dragModalOpen(none)).toBe(false);
  });

  it.each(Object.keys(none) as (keyof DragModalFacts)[])(
    'is true when only %s is',
    (key) => {
      expect(dragModalOpen({ ...none, [key]: true })).toBe(true);
    },
  );
});
