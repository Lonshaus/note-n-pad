// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The wire shapes of a tab transfer. The literals below are the same ones the
// core pins in `src-tauri/src/tab_transfer.rs`: a change of tagging or casing on
// one side alone fails a test on the other.

import { describe, expect, it } from 'vitest';
import {
  BEGIN,
  DROP,
  QUEUED_TRANSFER,
  SETTLE,
  TRANSFER_EVENT,
  committedMeta,
  type BeginResult,
  type CommittedMeta,
  type DropTarget,
  type SettleAction,
  type TransferEventPayload,
} from './tabTransferWire';

const DROP_SELF = '{"kind":"self"}';
const DROP_DOC = '{"kind":"doc","label":"doc-b","offset":{"x":12.5,"y":7.25}}';
const DROP_NEW = '{"kind":"new_window","point":{"x":100.5,"y":200.25}}';
const DROP_MOVE = '{"kind":"move_window","point":{"x":100.5,"y":200.25}}';
const DROP_CANCEL = '{"kind":"cancel"}';
const BEGIN_STARTED = '{"kind":"started","t":7}';
const BEGIN_REFUSED_BUSY = '{"kind":"refused","reason":"busy"}';
const BEGIN_REFUSED_QUITTING = '{"kind":"refused","reason":"quitting"}';
const BEGIN_REFUSED_NOT_READY = '{"kind":"refused","reason":"not_ready"}';
const COMMITTED_META =
  '{"tabIndex":3,"order":1.5,"group":"g-b","project":"/proj","bounds":{"x":1.5,"y":null,"width":300.5,"height":null}}';
const SETTLE_ACTIONS =
  '[{"kind":"unfreeze","t":1,"noteId":"n"},{"kind":"drop_incoming","t":2},{"kind":"release","t":3,"noteId":"m"}]';
const EVENT = '{"t":9}';

describe('the drop targets the core answers', () => {
  it('are tagged by `kind` in snake_case', () => {
    const parsed = (literal: string): DropTarget => JSON.parse(literal);
    expect(parsed(DROP_SELF).kind).toBe(DROP.self);
    expect(parsed(DROP_DOC)).toEqual({
      kind: DROP.doc,
      label: 'doc-b',
      offset: { x: 12.5, y: 7.25 },
    });
    expect(parsed(DROP_NEW)).toEqual({
      kind: DROP.newWindow,
      point: { x: 100.5, y: 200.25 },
    });
    expect(parsed(DROP_MOVE)).toEqual({
      kind: DROP.moveWindow,
      point: { x: 100.5, y: 200.25 },
    });
    expect(parsed(DROP_CANCEL).kind).toBe(DROP.cancel);
    expect(Object.values(DROP).sort()).toEqual(
      ['cancel', 'doc', 'move_window', 'new_window', 'self'].sort(),
    );
  });
});

describe('what begin answers', () => {
  it('is `started` with the transfer id, or `refused` with a reason', () => {
    const parsed = (literal: string): BeginResult => JSON.parse(literal);
    expect(parsed(BEGIN_STARTED)).toEqual({ kind: BEGIN.started, t: 7 });
    expect(parsed(BEGIN_REFUSED_BUSY)).toEqual({
      kind: BEGIN.refused,
      reason: 'busy',
    });
    expect(parsed(BEGIN_REFUSED_QUITTING)).toEqual({
      kind: BEGIN.refused,
      reason: 'quitting',
    });
    expect(parsed(BEGIN_REFUSED_NOT_READY)).toEqual({
      kind: BEGIN.refused,
      reason: 'not_ready',
    });
  });
});

describe('where the receiver put the tab', () => {
  it('is written with the camelCase keys the core reads', () => {
    const meta: CommittedMeta = committedMeta(3, 1.5, 'g-b', '/proj', {
      x: 1.5,
      y: null,
      width: 300.5,
      height: null,
    });
    expect(JSON.stringify(meta)).toBe(COMMITTED_META);
  });
});

describe('what settling a window answers', () => {
  it('is a list tagged by `kind` in snake_case with camelCase fields', () => {
    const parsed: SettleAction[] = JSON.parse(SETTLE_ACTIONS);
    expect(parsed).toEqual([
      { kind: SETTLE.unfreeze, t: 1, noteId: 'n' },
      { kind: SETTLE.dropIncoming, t: 2 },
      { kind: SETTLE.release, t: 3, noteId: 'm' },
    ]);
  });
});

describe('the events of a transfer', () => {
  it('are named as the core emits them and carry `{ t }`', () => {
    expect(TRANSFER_EVENT).toEqual({
      in: 'tab-transfer-in',
      release: 'tab-transfer-release',
      cancel: 'tab-transfer-cancel',
      abort: 'tab-transfer-abort',
    });
    const payload: TransferEventPayload = JSON.parse(EVENT);
    expect(payload).toEqual({ t: 9 });
    expect(QUEUED_TRANSFER).toBe('transfer');
  });
});
