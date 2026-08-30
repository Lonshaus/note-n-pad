// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { interpolate, resolveLocale } from './locale';

// Built-ins plus every canonical data-locale id, so a mapped system guess counts
// as available unless a case deliberately narrows the set.
const ALL = new Set([
  'zh-TW',
  'ja',
  'en',
  'zh-CN',
  'ko',
  'de',
  'fr',
  'es',
  'pt-BR',
  'it',
  'pl',
  'ru',
  'tr',
  'th',
  'vi',
]);
const BUILTINS = new Set(['zh-TW', 'ja', 'en']);

describe('resolveLocale', () => {
  it('returns an available explicit language unchanged', () => {
    expect(resolveLocale('zh-TW', 'en-US', ALL)).toBe('zh-TW');
    expect(resolveLocale('zh-CN', 'en-US', ALL)).toBe('zh-CN');
    expect(resolveLocale('ja', 'en-US', ALL)).toBe('ja');
    expect(resolveLocale('en', 'ja-JP', ALL)).toBe('en');
    expect(resolveLocale('pt-BR', 'en-US', ALL)).toBe('pt-BR');
    expect(resolveLocale('vi', 'en-US', ALL)).toBe('vi');
  });

  it('honors an imported third-party id when available', () => {
    const ids = new Set(['zh-TW', 'ja', 'en', 'my-lang']);
    expect(resolveLocale('my-lang', 'en-US', ids)).toBe('my-lang');
  });

  it('splits Chinese by script and region for system', () => {
    expect(resolveLocale('system', 'zh-TW', ALL)).toBe('zh-TW');
    expect(resolveLocale('system', 'zh-Hant', ALL)).toBe('zh-TW');
    expect(resolveLocale('system', 'zh-HK', ALL)).toBe('zh-TW');
    expect(resolveLocale('system', 'zh-MO', ALL)).toBe('zh-TW');
    expect(resolveLocale('system', 'zh-Hans', ALL)).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-CN', ALL)).toBe('zh-CN');
    expect(resolveLocale('system', 'zh', ALL)).toBe('zh-CN');
  });

  it('maps the system language by prefix', () => {
    expect(resolveLocale('system', 'ja-JP', ALL)).toBe('ja');
    expect(resolveLocale('system', 'ko-KR', ALL)).toBe('ko');
    expect(resolveLocale('system', 'de-DE', ALL)).toBe('de');
    expect(resolveLocale('system', 'ru-RU', ALL)).toBe('ru');
    // Any Portuguese variant routes to the Brazilian dictionary.
    expect(resolveLocale('system', 'pt-PT', ALL)).toBe('pt-BR');
  });

  it('is case-insensitive on the system language', () => {
    expect(resolveLocale('system', 'ZH-tw', ALL)).toBe('zh-TW');
    expect(resolveLocale('system', 'ZH-hans', ALL)).toBe('zh-CN');
    expect(resolveLocale('system', 'JA', ALL)).toBe('ja');
  });

  it('follows the system for an unknown or deleted explicit language', () => {
    // Unknown/hand-edited no longer snaps to English; it follows the OS guess.
    expect(resolveLocale('eo', 'ja-JP', ALL)).toBe('ja');
    // A deleted data locale (absent from the available set) falls back the same.
    expect(
      resolveLocale('fr', 'de-DE', new Set(['zh-TW', 'ja', 'en', 'de'])),
    ).toBe('de');
  });

  it('falls back to English when the system guess is unavailable', () => {
    // The OS wants German but only the built-ins are installed.
    expect(resolveLocale('system', 'de-DE', BUILTINS)).toBe('en');
    expect(resolveLocale('fr', 'xx', BUILTINS)).toBe('en');
    expect(resolveLocale('system', 'eo', ALL)).toBe('en');
    expect(resolveLocale('system', undefined, ALL)).toBe('en');
    expect(resolveLocale('system', '', ALL)).toBe('en');
  });
});

describe('interpolate', () => {
  it('substitutes named placeholders', () => {
    expect(interpolate('Hi {name}', { name: 'Lon' })).toBe('Hi Lon');
  });

  it('stringifies numeric params', () => {
    expect(interpolate('{count} files', { count: 3 })).toBe('3 files');
  });

  it('replaces every occurrence', () => {
    expect(interpolate('{x}+{x}', { x: 2 })).toBe('2+2');
  });

  it('leaves an unknown placeholder verbatim', () => {
    expect(interpolate('Hi {name}', {})).toBe('Hi {name}');
  });
});
