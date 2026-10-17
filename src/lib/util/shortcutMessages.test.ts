// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { RecordRejection } from './accelerator';
import { rejectionMessage, setErrorMessage } from './shortcutMessages';
import { en } from '../i18n/en';
import { ja } from '../i18n/ja';
import { zhTW } from '../i18n/zh-TW';

const GENERIC = 'settings.sticky.shortcutError';
// Typed as a record so a new `RecordRejection` fails the type check here.
const REJECTIONS: Record<RecordRejection, true> = {
  'needs-modifier': true,
  'mac-option': true,
  unreachable: true,
  punctuation: true,
  'unsupported-key': true,
  'no-layout-char': true,
};

const rows = [
  { id: 'menu.save', label: 'Save', alias_ids: [] },
  {
    id: 'other.doc-start',
    label: 'Cursor Document Start',
    alias_ids: ['fixed.doc-start-home'],
  },
];

describe('rejectionMessage', () => {
  it.each(Object.keys(REJECTIONS) as RecordRejection[])(
    'has its own message for %s on both platforms',
    (reason) => {
      for (const mac of [true, false]) {
        const message = rejectionMessage(reason, mac);
        expect(message.key).not.toBe(GENERIC);
        expect(message.key.startsWith('settings.shortcuts.err.')).toBe(true);
      }
    },
  );

  it('words the modifier requirement per platform', () => {
    expect(rejectionMessage('needs-modifier', true).key).toBe(
      'settings.shortcuts.err.needsModifierMac',
    );
    expect(rejectionMessage('needs-modifier', false).key).toBe(
      'settings.shortcuts.err.needsModifierWin',
    );
  });
});

describe('setErrorMessage', () => {
  it.each([
    ['fixed', 'settings.shortcuts.err.fixed'],
    ['mac-option', 'settings.shortcuts.err.macOption'],
    ['unreachable', 'settings.shortcuts.err.unreachable'],
    [
      'global-register:already registered',
      'settings.shortcuts.err.globalRegister',
    ],
  ])('maps the code %s', (code, key) => {
    expect(setErrorMessage(code, true, rows).key).toBe(key);
  });

  it('maps needs-modifier by platform', () => {
    expect(setErrorMessage('needs-modifier', true, rows).key).toBe(
      'settings.shortcuts.err.needsModifierMac',
    );
    expect(setErrorMessage('needs-modifier', false, rows).key).toBe(
      'settings.shortcuts.err.needsModifierWin',
    );
  });

  it('names the row that holds the key, by id or by alias', () => {
    expect(setErrorMessage('conflict:menu.save', false, rows)).toEqual({
      key: 'settings.shortcuts.err.conflict',
      params: { name: 'Save' },
    });
    expect(
      setErrorMessage('conflict:fixed.doc-start-home', true, rows),
    ).toEqual({
      key: 'settings.shortcuts.err.conflict',
      params: { name: 'Cursor Document Start' },
    });
  });

  it.each([
    'invalid:not a key',
    'unknown-id',
    'conflict:no.such.row',
    'failed to write settings.json',
    '',
  ])('falls back to the generic message for %j', (code) => {
    expect(setErrorMessage(code, false, rows).key).toBe(GENERIC);
  });

  it('falls back to the generic message for a thrown non-string', () => {
    expect(setErrorMessage(new Error('boom'), false, rows).key).toBe(GENERIC);
    expect(setErrorMessage(undefined, false, rows).key).toBe(GENERIC);
  });
});

describe('the message keys', () => {
  it('exist, non-empty, in every compiled locale', () => {
    const keys = new Set<string>();
    for (const reason of Object.keys(REJECTIONS) as RecordRejection[]) {
      keys.add(rejectionMessage(reason, true).key);
      keys.add(rejectionMessage(reason, false).key);
    }
    keys.add(setErrorMessage('fixed', true, rows).key);
    keys.add(setErrorMessage('global-register:x', true, rows).key);
    keys.add(setErrorMessage('conflict:menu.save', true, rows).key);
    keys.add(GENERIC);
    for (const dict of [zhTW, en, ja] as Record<string, string>[]) {
      for (const key of keys) {
        expect(dict[key], key).toBeTruthy();
      }
    }
    expect(en['settings.shortcuts.err.conflict']).toContain('{name}');
    expect(zhTW['settings.shortcuts.err.conflict']).toContain('{name}');
    expect(ja['settings.shortcuts.err.conflict']).toContain('{name}');
  });
});
