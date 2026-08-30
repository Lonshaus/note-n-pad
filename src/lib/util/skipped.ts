// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { I18nKey } from '../i18n';
import type { SkipReason } from './protocol';

/** The locale key that explains one `SkipReason`. A `Record` rather than a
 *  `switch` with a default: adding a reason to the protocol then fails the
 *  build here instead of showing the wrong sentence for it. */
const REASON_KEYS: Record<SkipReason, I18nKey> = {
  notJson: 'skipped.reason.notJson',
  unreadable: 'skipped.reason.unreadable',
  unparsable: 'skipped.reason.unparsable',
  invalid: 'skipped.reason.invalid',
  foreignId: 'skipped.reason.foreignId',
  duplicateId: 'skipped.reason.duplicateId',
};

export function skipReasonKey(reason: SkipReason): I18nKey {
  return REASON_KEYS[reason];
}

/** The locale key for the reveal button. The file browser is named differently
 *  on each platform, and the native context menu already says it that way. */
export function revealKey(platform: {
  isMacOS: boolean;
  isWindows: boolean;
}): I18nKey {
  if (platform.isMacOS) {
    return 'skipped.reveal.macos';
  }
  return platform.isWindows ? 'skipped.reveal.windows' : 'skipped.reveal.linux';
}
