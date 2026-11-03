// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The paste routing wired to this window: the core's commands, the web
// clipboard, the window's listeners and the renewal timer of its tokens.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ClipInfo } from './clipRouting';
import { liveTokens, startKeepalive } from './liveTokens';
import { lastLinewiseCopy } from './linewiseCopy';
import { pasteLocks } from './pasteLock';
import type { PasteFlowDeps } from './pasteFlow';
import {
  RedispatchWaiter,
  type FieldDeps,
  type TextBegin,
} from './pasteRouting';
import { parkClipStatus } from '../dev/windowedHold';
import { t } from '../i18n';
import { convertController } from '../state/convertController.svelte';
import { editionState } from '../state/edition.svelte';
import { platform } from '../state/platform.svelte';
import { startConversion } from '../state/startConversion';
/** The pastes waiting for the page to be handed the clipboard's text. */
export const redispatchWaiter = new RedispatchWaiter();

const USER_INPUT = ['keydown', 'pointerdown', 'input'] as const;
/** Who wants to know of a gate the core revokes. */
const revocationListeners = new Set<(token: number) => void>();

export const pasteEnv: FieldDeps = {
  get platform(): string {
    return platform.os;
  },
  clipStatus: async (mark) => {
    if (import.meta.env.DEV) {
      const parked = parkClipStatus();
      if (parked !== null) {
        await parked;
      }
    }
    return invoke<ClipInfo | null>('clip_status', { mark });
  },
  textBegin: () => invoke<TextBegin>('clip_text_begin'),
  // A failed call counts as a gate that was lost: the text is dropped.
  textEnd: (token) =>
    invoke<boolean>('clip_text_end', { token }).catch(() => false),
  onGateRevoked: (cb) => {
    revocationListeners.add(cb);
    return () => {
      revocationListeners.delete(cb);
    };
  },
  pin: (clipId) => invoke<number>('clip_pin', { clipId }),
  unpin: (pin) => {
    invoke('clip_unpin', { pin }).catch(() => {});
  },
  redispatchPaste: () =>
    invoke<'send' | 'not-key' | 'not-handled'>('clipboard_redispatch_paste'),
  readText: () => navigator.clipboard.readText(),
  waiter: redispatchWaiter,
  userInput: (cb) => {
    for (const type of USER_INPUT) {
      window.addEventListener(type, cb, true);
    }
    return () => {
      for (const type of USER_INPUT) {
        window.removeEventListener(type, cb, true);
      }
    };
  },
  tokens: liveTokens,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Called at the event itself and not awaited: the core numbers the calls in
  // the order it receives them.
  clipPasteMark: () => invoke<number>('clip_paste_mark').catch(() => null),
  hasFocus: () => document.hasFocus(),
  activeElement: () => document.activeElement,
  insertText: (text) => {
    document.execCommand('insertText', false, text);
  },
};
/** What a document or sticky editor's paste needs. */
export const pasteFlowDeps: PasteFlowDeps = {
  env: pasteEnv,
  readChunk: (pin, offset) =>
    invoke<{ text: string; next: number }>('clip_read_chunk', {
      pin,
      offset,
    }),
  isLite: () => editionState.lite,
  startConversion,
  locks: pasteLocks,
  lastLinewise: lastLinewiseCopy,
  reportFailure: (error) => {
    convertController.report(t('convert.failed', { error }));
  },
};
/** What a window of editors installs once: the first listener of `paste` on
 *  the window, the timer that renews the window's tokens and the listener of
 *  the core's `clip-gate-revoked`. Returns the removal. */
export function installPasteWindow(): () => void {
  window.addEventListener('paste', redispatchWaiter.handle, true);
  const stop = startKeepalive((tokens) => {
    invoke('clip_copy_keepalive', { tokens }).catch(() => {});
  });
  const revoked = listen<number>('clip-gate-revoked', (e) => {
    for (const cb of [...revocationListeners]) {
      cb(e.payload);
    }
  });
  return () => {
    window.removeEventListener('paste', redispatchWaiter.handle, true);
    stop();
    void revoked.then((unlisten) => unlisten()).catch(() => {});
  };
}
