// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { TEXT_FIELD_ATTRS } from './textFieldAttrs';

describe('TEXT_FIELD_ATTRS', () => {
  it('switches off autocapitalize, autocorrect and spellcheck', () => {
    expect(TEXT_FIELD_ATTRS).toEqual({
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
    });
  });
});
