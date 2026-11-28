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
  TEAROFF_EVENT,
  HOVER_EVENT,
  TRANSFER_EVENT,
  committedMeta,
  type BeginResult,
  type CommittedMeta,
  type DropTarget,
  type HoverAckArgs,
  type HoverPayload,
  type SendPayload,
  type SettleAction,
  type TearOffEndPayload,
  type TearOffTarget,
  type TransferEventPayload,
  type WindowReady,
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
const DROP_TEAR =
  '{"kind":"tear_off","id":"drag-1","grab":{"x":20.5,"y":14.25},"firstTabClientX":4.5,"escOffset":{"x":101.5,"y":15.25},"dpr":2.0,"width":90.5,"title":"a.txt"}';
// The same two literals are pinned by `src-tauri/src/tab_transfer.rs`.
const HOVER_PLAIN = '{"x":10.5,"y":20.0,"width":90.0}';
const HOVER_FOLLOW =
  '{"x":10.5,"y":20.0,"width":90.0,"follow":{"generation":3,"title":"a.txt","grabX":20.5}}';
const SEND_EVENT =
  '{"note":"n","target":{"kind":"doc","label":"doc-b","offset":{"x":40.5,"y":10.25}}}';
const END_EVENT = '{"id":"drag-1"}';
const ROLE_END_EVENT = '{"id":null}';
const READY =
  '{"queued":[{"kind":"path","value":"a.txt"},{"kind":"transfer","value":4},{"kind":"handoff","value":9}],"tearOffRoleEnded":true,"revealed":false}';

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
      ['cancel', 'doc', 'move_window', 'new_window', 'self', 'tear_off'].sort(),
    );
  });

  it('carry a tab that left its bar as `tear_off` with camelCase fields', () => {
    const target: TearOffTarget = {
      kind: DROP.tearOff,
      id: 'drag-1',
      grab: { x: 20.5, y: 14.25 },
      firstTabClientX: 4.5,
      escOffset: { x: 101.5, y: 15.25 },
      dpr: 2,
      width: 90.5,
      title: 'a.txt',
    };
    // `2.0` and `2` are the same number on the wire.
    expect(JSON.parse(JSON.stringify(target))).toEqual(JSON.parse(DROP_TEAR));
    expect(Object.keys(JSON.parse(DROP_TEAR)).sort()).toEqual([
      'dpr',
      'escOffset',
      'firstTabClientX',
      'grab',
      'id',
      'kind',
      'title',
      'width',
    ]);
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

describe('the events of a tab that follows the pointer', () => {
  it('are named and shaped as the core emits them', () => {
    expect(TEAROFF_EVENT).toEqual({
      send: 'tab-transfer-send',
      end: 'tab-tearoff-end',
    });
    const send: SendPayload = JSON.parse(SEND_EVENT);
    expect(send).toEqual({
      note: 'n',
      target: { kind: DROP.doc, label: 'doc-b', offset: { x: 40.5, y: 10.25 } },
    });
    const end: TearOffEndPayload = JSON.parse(END_EVENT);
    expect(end).toEqual({ id: 'drag-1' });
    const role: TearOffEndPayload = JSON.parse(ROLE_END_EVENT);
    expect(role.id).toBeNull();
  });

  it('come back from `doc_window_ready` with the queue and what became of the role', () => {
    const ready: WindowReady = JSON.parse(READY);
    expect(ready.queued).toEqual([
      { kind: 'path', value: 'a.txt' },
      { kind: QUEUED_TRANSFER, value: 4 },
      { kind: 'handoff', value: 9 },
    ]);
    expect(ready.tearOffRoleEnded).toBe(true);
    expect(ready.revealed).toBe(false);
  });
});

describe('the hover event', () => {
  it('has no follow object when the sender itself leads the drag', () => {
    expect(HOVER_EVENT).toEqual({
      hover: 'tab-transfer-hover',
      end: 'tab-transfer-hover-end',
    });
    const plain: HoverPayload = JSON.parse(HOVER_PLAIN);
    expect(plain).toEqual({ x: 10.5, y: 20, width: 90 });
    expect(plain.follow).toBeUndefined();
  });

  it('carries the generation, the title and the grab of a follow of the core', () => {
    const hover: HoverPayload = JSON.parse(HOVER_FOLLOW);
    expect(hover.follow).toEqual({
      generation: 3,
      title: 'a.txt',
      grabX: 20.5,
    });
    expect(Object.keys(JSON.parse(HOVER_FOLLOW).follow).sort()).toEqual([
      'generation',
      'grabX',
      'title',
    ]);
  });

  it('is answered with the generation it came with and whether the window takes the tab', () => {
    const ack: HoverAckArgs = { generation: 3, accepted: true };
    expect(JSON.parse(JSON.stringify(ack))).toEqual({
      generation: 3,
      accepted: true,
    });
  });
});
