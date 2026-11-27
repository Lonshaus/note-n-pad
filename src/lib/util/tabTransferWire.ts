// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The shapes a tab on its way between windows goes through the core as: the
// mirror of `src-tauri/src/tab_transfer.rs`, which pins the same JSON in its own
// tests. Enums are tagged with `kind` in snake_case; structs are camelCase.
/** A point in native units (see the core's `window_at`). */
export interface Point {
  x: number;
  y: number;
}
/** The `kind` of every `DropTarget`. */
export const DROP = {
  self: 'self',
  doc: 'doc',
  newWindow: 'new_window',
  moveWindow: 'move_window',
  cancel: 'cancel',
  tearOff: 'tear_off',
} as const;
/** What `tab_drop_target` answers; `begin` takes the `doc` and `new_window`
 *  variants back unchanged. */
export type DropTarget =
  | { kind: typeof DROP.self }
  | { kind: typeof DROP.doc; label: string; offset: Point }
  | { kind: typeof DROP.newWindow; point: Point }
  | { kind: typeof DROP.moveWindow; point: Point }
  | { kind: typeof DROP.cancel };
/** A tab that left its bar: a window of its own that follows the pointer. Every
 *  value is in client CSS pixels of the sender. */
export interface TearOffTarget {
  kind: typeof DROP.tearOff;
  /** Minted by the page; names this drag in events and commands. */
  id: string;
  /** The pointer's distance from the dragged tab's left edge as drawn, and its
   *  client y. */
  grab: Point;
  /** Where the first tab of a bar starts: the bar's left plus the tab's left. */
  firstTabClientX: number;
  /** Where the tab goes back to in the sender on Esc. */
  escOffset: Point;
  dpr: number;
  /** The dragged tab's width. */
  width: number;
  /** The dragged tab's display name. */
  title: string;
}
/** The targets a transfer can begin for. */
export type TransferTarget =
  | Extract<DropTarget, { kind: typeof DROP.doc | typeof DROP.newWindow }>
  | TearOffTarget;
/** Whether the core started what a drag asked for. */
export type StartResult = 'started' | 'notStarted';
/** Why `tab_transfer_begin` did not start. */
export type BeginRefusal = 'busy' | 'quitting' | 'not_ready';
/** The `kind` of every `BeginResult`. */
export const BEGIN = { started: 'started', refused: 'refused' } as const;
export type BeginResult =
  | { kind: typeof BEGIN.started; t: number }
  | { kind: typeof BEGIN.refused; reason: BeginRefusal };
/** What `tab_transfer_claim` answers: the packed tab and, for an existing
 *  window, where it was dropped (the core's offset, in native units). */
export interface Claimed<Payload = unknown> {
  payload: Payload;
  offset?: Point;
}
export type Answer = 'commit' | 'expired';
export type CommitResult = 'accepted' | 'rejected';
export type CancelResult = 'cancelled' | 'accepted';
export type TransferStatus = 'pending' | 'accepted' | 'gone';
/** A window's bounds; each field is a number or null. */
export interface TransferBounds {
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
}
/** Where the receiver put the tab (`tab_transfer_committed`). */
export interface CommittedMeta {
  tabIndex: number;
  order: number;
  group: string;
  project: string | null;
  bounds: TransferBounds;
}
/** The `kind` of every `SettleAction`. */
export const SETTLE = {
  unfreeze: 'unfreeze',
  dropIncoming: 'drop_incoming',
  release: 'release',
} as const;
/** What `tab_transfer_settle_window` says to do with one transfer. */
export type SettleAction =
  | { kind: typeof SETTLE.unfreeze; t: number; noteId: string }
  | { kind: typeof SETTLE.dropIncoming; t: number }
  | { kind: typeof SETTLE.release; t: number; noteId: string };
/** The events of a transfer, each with `{ t }`. */
export const TRANSFER_EVENT = {
  in: 'tab-transfer-in',
  release: 'tab-transfer-release',
  cancel: 'tab-transfer-cancel',
  abort: 'tab-transfer-abort',
} as const;
export interface TransferEventPayload {
  t: number;
}
/** The events of a tab that follows the pointer. */
export const TEAROFF_EVENT = {
  send: 'tab-transfer-send',
  end: 'tab-tearoff-end',
} as const;
/** `tab-transfer-send`: send the tab `note` on to the bar the core names. */
export interface SendPayload {
  note: string;
  target: Extract<DropTarget, { kind: typeof DROP.doc }>;
}
/** `tab-tearoff-end`: the follow `id` is over for its sender, or, with no id,
 *  the tear-off's own waiting role is. */
export interface TearOffEndPayload {
  id: string | null;
}
/** The events of a tab dragged over a window: not part of a transfer, so no `t`. */
export const HOVER_EVENT = {
  hover: 'tab-transfer-hover',
  end: 'tab-transfer-hover-end',
} as const;
/** What a hover of the core's follow loop adds: the receiver answers it with
 *  `tab_hover_ack` and draws the tab under the pointer. Absent from the hover of
 *  a drag the sender itself leads. */
export interface HoverFollow {
  /** The follow the hover belongs to; the answer carries it back. */
  generation: number;
  /** The dragged tab's display name. */
  title: string;
  /** The pointer's distance from the dragged tab's left edge, in CSS pixels. */
  grabX: number;
}
/** Where the dragged tab is over the receiving window: `x` and `y` are the
 *  offset from its inner origin in native units, `width` is the tab's width in
 *  CSS pixels. */
export interface HoverPayload {
  x: number;
  y: number;
  width: number;
  follow?: HoverFollow;
}
/** What `tab_hover_ack` takes: whether the window takes the tab of the follow
 *  `generation`. */
export interface HoverAckArgs {
  generation: number;
  accepted: boolean;
}
/** The `kind` of a transfer in the queue `doc_window_ready` hands over. */
export const QUEUED_TRANSFER = 'transfer';
export interface QueuedTransfer {
  kind: typeof QUEUED_TRANSFER;
  value: number;
}
/** What the core queued for a window that was still loading. */
export type QueuedItem =
  | { kind: 'path'; value: string }
  | { kind: 'handoff'; value: number }
  | QueuedTransfer;
/** What `doc_window_ready` answers. */
export interface WindowReady {
  queued: QueuedItem[];
  /** The tear-off role of the window ended before it could hear of it. */
  tearOffRoleEnded: boolean;
  /** The core showed the window itself when the role ended. */
  revealed: boolean;
}
/** What `windowed_stats` answers. */
export interface WindowedStats {
  dirty: boolean;
  totalBytes: number;
  totalLines: number;
}
/** The `committed` metadata, keys as the core reads them. */
export function committedMeta(
  tabIndex: number,
  order: number,
  group: string,
  project: string | null,
  bounds: TransferBounds,
): CommittedMeta {
  return { tabIndex, order, group, project, bounds };
}
