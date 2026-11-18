// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { menuActionAllowed } from './menuActionGate';

describe('the menu actions of a tab on its way', () => {
  it('refuses the ones that change the tab', () => {
    for (const action of [
      'save',
      'save-as',
      'set-encoding:Big5',
      'set-line-ending:CRLF',
      'set-language:JavaScript',
      'set-language:',
      'undo',
      'redo',
      'cut',
      'paste',
    ]) {
      expect(menuActionAllowed(action, true), action).toBe(false);
    }
  });

  it('allows the others', () => {
    for (const action of [
      'copy',
      'select-all',
      'find',
      'find-replace',
      'find-next',
      'find-prev',
      'new-tab',
      'open',
      'show-in-finder',
      'copy-path',
    ]) {
      expect(menuActionAllowed(action, true), action).toBe(true);
    }
  });

  it('allows everything while no tab is on its way', () => {
    for (const action of ['save', 'paste', 'set-encoding:Big5', 'undo']) {
      expect(menuActionAllowed(action, false), action).toBe(true);
    }
  });
});
