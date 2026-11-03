// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The clip reservations and read gates this window holds open. The core drops
// one that is not renewed within its lease, so a root timer sends them all
// every few seconds for as long as their owner is alive. Free of the DOM and
// Tauri, so it unit-tests in isolation.
/** A clip copy reserved ahead of time, or a gate held open for a clipboard
 *  read. */
export type TokenKind = 'reservation' | 'gate';
/** Milliseconds between two renewals; the core's lease is 15 seconds. */
export const KEEPALIVE_MS = 5000;

export class LiveTokens {
  private sources = new Map<
    symbol,
    { kind: TokenKind; list: () => number[] }
  >();
  /** Registers a source of tokens read at every renewal; returns its removal. */
  add(kind: TokenKind, list: () => number[]): () => void {
    const id = Symbol('tokens');
    this.sources.set(id, { kind, list });
    return () => {
      this.sources.delete(id);
    };
  }
  /** Registers one token until the returned function is called. */
  hold(kind: TokenKind, token: number): () => void {
    return this.add(kind, () => [token]);
  }
  /** Every token held now, of one kind or all. */
  tokens(kind?: TokenKind): number[] {
    const out: number[] = [];
    for (const source of this.sources.values()) {
      if (kind === undefined || source.kind === kind) {
        out.push(...source.list());
      }
    }
    return out;
  }
}
/** The tokens of this window. */
export const liveTokens = new LiveTokens();
/** Sends the held tokens every `ms` while any exists; returns the stop. */
export function startKeepalive(
  send: (tokens: number[]) => void,
  source: LiveTokens = liveTokens,
  ms: number = KEEPALIVE_MS,
): () => void {
  const timer = setInterval(() => {
    const tokens = source.tokens();
    if (tokens.length > 0) {
      send(tokens);
    }
  }, ms);
  return () => clearInterval(timer);
}
/** A clip copy with a reservation made first: `run` gets the token, which is
 *  renewed until it ends, or null when the core refused one. The core releases
 *  it when the copy is done. */
export async function withReservation<T>(
  reserve: () => Promise<{ token: number }>,
  run: (token: number | null) => Promise<T>,
  source: LiveTokens = liveTokens,
): Promise<T> {
  let token: number | null = null;
  try {
    token = (await reserve()).token;
  } catch {
    // The copy goes ahead; a paste is not made to wait for it.
  }
  const forget = token === null ? null : source.hold('reservation', token);
  try {
    return await run(token);
  } finally {
    forget?.();
  }
}
