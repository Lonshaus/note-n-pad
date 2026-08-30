// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Main-thread factory for the highlight worker.
 *
 *  The `new Worker(new URL(...), { type: 'module' })` form is what Vite
 *  statically detects to emit and bundle the worker chunk. Actual wiring of the
 *  worker into the editor happens in a later step; this factory exists now so
 *  the worker is part of the build graph and ships correctly. */
import type { InboundMessage, OutboundMessage } from './protocol';

/** A typed handle around the highlight worker. */
export interface HighlightClient {
  post(message: InboundMessage): void;
  onMessage(listener: (message: OutboundMessage) => void): void;
  terminate(): void;
}

export function createHighlightClient(): HighlightClient {
  const worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), {
    type: 'module',
  });
  return {
    post(message) {
      worker.postMessage(message);
    },
    onMessage(listener) {
      worker.addEventListener(
        'message',
        (event: MessageEvent<OutboundMessage>) => {
          listener(event.data);
        },
      );
    },
    terminate() {
      worker.terminate();
    },
  };
}
