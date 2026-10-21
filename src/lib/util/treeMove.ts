// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { I18nKey } from '../i18n';
import type { HostOs } from './guessOs';
import type { VisibleRow, VolumeInfo } from './projectTree';
import { isInside, parentOf, renameInSet, type TreeCache } from './treeCache';

export type DropOp = 'move' | 'copy';
/** The page's `t()`, passed in so the wording stays testable. */
export type Translate = (
  key: I18nKey,
  params?: Record<string, string | number>,
) => string;
/** One dragged tree row. */
export interface DragItem extends VolumeInfo {
  path: string;
  root: string;
  isDir: boolean;
}
/** The folder something is dropped on. */
export interface DropTarget extends VolumeInfo {
  path: string;
  root: string;
}
/** An item that cannot be handled, with the reason in words. */
export interface Failure {
  name: string;
  reason: string;
}
export type RejectReason = 'sameName' | 'intoSelf';

export type DropDecision =
  /** Every item already sits in the target folder. */
  | { kind: 'noop' }
  | { kind: 'refuse'; messageKey: I18nKey }
  | { kind: 'error'; op: DropOp; failures: Failure[] }
  | { kind: 'copyNow'; items: DragItem[] }
  | { kind: 'confirmMove'; items: DragItem[] }
  | {
      kind: 'partial';
      op: DropOp;
      allowed: DragItem[];
      rejected: { name: string; reason: RejectReason }[];
    };

export function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function fold(text: string, caseInsensitive: boolean): string {
  return caseInsensitive ? text.toLowerCase() : text;
}
/** The operation a drop asks for: macOS copies while Option is held, Windows
 *  while Ctrl is held. */
export function modifierOp(
  event: { altKey: boolean; ctrlKey: boolean },
  os: HostOs | null,
): DropOp {
  if (os === 'macos') {
    return event.altKey ? 'copy' : 'move';
  }
  return os === 'windows' && event.ctrlKey ? 'copy' : 'move';
}

export const DRAG_THRESHOLD = 4;
/** True once the pointer is farther than `threshold` px from where it went
 *  down; up to then the press is a click. */
export function exceedsDragThreshold(
  dx: number,
  dy: number,
  threshold = DRAG_THRESHOLD,
): boolean {
  return Math.hypot(dx, dy) > threshold;
}
/** One press-move-release on a row. A press that never goes past the threshold
 *  is a click; one that does is a drag, and the click the browser sends when it
 *  ends must not select, expand or open anything. */
export class DragGesture {
  private origin: { x: number; y: number } | null = null;
  private moving = false;
  private cancelled = false;
  private swallowing = false;

  get dragging(): boolean {
    return this.moving;
  }
  /** A new press: a click left over from an earlier drag is not this one's. */
  press(x: number, y: number): void {
    this.origin = { x, y };
    this.moving = false;
    this.cancelled = false;
    this.swallowing = false;
  }
  /** Feed a pointer position. True while a drag is under way. */
  move(x: number, y: number): boolean {
    if (this.origin === null || this.cancelled) {
      return false;
    }
    if (
      !this.moving &&
      exceedsDragThreshold(x - this.origin.x, y - this.origin.y)
    ) {
      this.moving = true;
    }
    return this.moving;
  }
  /** Give the drag up (Esc) while the button is still down. The click that
   *  follows when it comes up is still ignored. */
  cancel(): void {
    if (this.moving) {
      this.swallowing = true;
    }
    this.moving = false;
    this.cancelled = true;
  }
  /** The button came up. True when this ended a drag that should drop. */
  release(): boolean {
    const dropped = this.moving;
    if (dropped) {
      this.swallowing = true;
    }
    this.origin = null;
    this.moving = false;
    this.cancelled = false;
    return dropped;
  }
  /** The pointer was taken away: no button-up and no click will follow. */
  reset(): void {
    this.origin = null;
    this.moving = false;
    this.cancelled = false;
    this.swallowing = false;
  }
  /** True once for the click that follows a drag: the caller ignores it. */
  consumeClick(): boolean {
    const swallow = this.swallowing;
    this.swallowing = false;
    return swallow;
  }
  /** No click followed (the button came up elsewhere): forget the drag. */
  forgetClick(): void {
    this.swallowing = false;
  }
}
/** The rows to drag when `pressed` is grabbed: the whole selection when the row
 *  is part of it, else just that row. Project folders and error rows never
 *  move. Of a folder and something inside it, only the folder stays. */
export function dragItems(
  pressed: string,
  rows: readonly VisibleRow[],
  selected: ReadonlySet<string>,
  caseInsensitive: boolean,
): VisibleRow[] {
  const grabbed = rows.find((r) => r.path === pressed);
  if (grabbed === undefined || grabbed.root || grabbed.isError) {
    return [];
  }
  const picked = rows.filter(
    (r) =>
      !r.root &&
      !r.isError &&
      (selected.has(pressed) ? selected.has(r.path) : r.path === pressed),
  );
  return picked.filter(
    (r) =>
      !picked.some(
        (d) =>
          d.isDir &&
          d.path !== r.path &&
          isInside(r.path, d.path, caseInsensitive),
      ),
  );
}
/** The folder a drop on `row` lands in: the folder itself, or the one holding
 *  a file. */
export function dropFolder(row: VisibleRow): string {
  return row.isDir ? row.path : parentOf(row.path);
}

const REFUSE_PROJECT: Record<DropOp, I18nKey> = {
  move: 'workspace.drop.refuseMoveProject',
  copy: 'workspace.drop.refuseCopyProject',
};
const REFUSE_VOLUME: Record<DropOp, I18nKey> = {
  move: 'workspace.drop.refuseMoveVolume',
  copy: 'workspace.drop.refuseCopyVolume',
};
/** What a drop on `target` does with `items`. */
export function dropDecision(input: {
  op: DropOp;
  items: readonly DragItem[];
  target: DropTarget;
  targetChildren: readonly { name: string }[];
  caseInsensitive: boolean;
}): DropDecision {
  const { op, items, target, targetChildren, caseInsensitive } = input;
  const unreadable: Failure[] =
    target.volumeError === null
      ? items.flatMap((i) =>
          i.volumeError === null
            ? []
            : [{ name: basename(i.path), reason: i.volumeError }],
        )
      : items.map((i) => ({
          name: basename(i.path),
          reason: target.volumeError ?? '',
        }));
  if (unreadable.length > 0) {
    return { kind: 'error', op, failures: unreadable };
  }
  if (items.some((i) => i.root !== target.root)) {
    return { kind: 'refuse', messageKey: REFUSE_PROJECT[op] };
  }
  if (
    items.some(
      (i) =>
        i.volume === null ||
        target.volume === null ||
        i.volume !== target.volume,
    )
  ) {
    return { kind: 'refuse', messageKey: REFUSE_VOLUME[op] };
  }
  const taken = new Set(
    targetChildren.map((c) => fold(c.name, caseInsensitive)),
  );
  const allowed: DragItem[] = [];
  const rejected: { name: string; reason: RejectReason }[] = [];
  for (const item of items) {
    const name = basename(item.path);
    if (
      op === 'move' &&
      fold(parentOf(item.path), caseInsensitive) ===
        fold(target.path, caseInsensitive)
    ) {
      continue;
    }
    if (item.isDir && isInside(target.path, item.path, caseInsensitive)) {
      rejected.push({ name, reason: 'intoSelf' });
    } else if (taken.has(fold(name, caseInsensitive))) {
      rejected.push({ name, reason: 'sameName' });
    } else {
      taken.add(fold(name, caseInsensitive));
      allowed.push(item);
    }
  }
  if (allowed.length + rejected.length === 0) {
    return { kind: 'noop' };
  }
  if (rejected.length > 0) {
    return { kind: 'partial', op, allowed, rejected };
  }
  return op === 'copy'
    ? { kind: 'copyNow', items: allowed }
    : { kind: 'confirmMove', items: allowed };
}
/** Whether the pointer over a folder shows it as a place to drop, and which
 *  cursor goes with it. */
export function hoverFeedback(
  decision: DropDecision,
  op: DropOp,
): { allowed: boolean; cursor: string } {
  if (decision.kind === 'noop') {
    return { allowed: false, cursor: 'default' };
  }
  const refused =
    decision.kind === 'refuse' ||
    decision.kind === 'error' ||
    (decision.kind === 'partial' && decision.allowed.length === 0);
  if (refused) {
    return { allowed: false, cursor: 'not-allowed' };
  }
  return { allowed: true, cursor: op === 'copy' ? 'copy' : 'grabbing' };
}
/** The disk an item of the tree is on, for moving or copying it: the item
 *  itself, so a link counts where it lives and not where it points. Comes with
 *  the listing of the folder holding it. */
export function volumeOfPath(
  cache: TreeCache,
  root: string,
  path: string,
): VolumeInfo {
  const entry = cache
    .get(root, parentOf(path))
    ?.entries.find((e) => e.path === path);
  return entry === undefined
    ? { volume: null, volumeError: null }
    : { volume: entry.volume, volumeError: entry.volume_error };
}
/** The disk a drop on a folder lands on: where the folder leads, so a disk
 *  mounted on it or the target of a link counts. The project folder's own is
 *  kept apart, since its listing does not include it. */
export function targetVolumeOfPath(
  cache: TreeCache,
  root: string,
  path: string,
): VolumeInfo {
  const unknown: VolumeInfo = { volume: null, volumeError: null };
  if (path === root) {
    return cache.rootVolume(root) ?? unknown;
  }
  const entry = cache
    .get(root, parentOf(path))
    ?.entries.find((e) => e.path === path);
  return entry === undefined
    ? unknown
    : { volume: entry.target_volume, volumeError: entry.target_volume_error };
}
/** What is in `folder`: its listing when that is up to date, else a fresh read
 *  (the folder was never opened, could not be read, or is marked to be read
 *  again). */
export async function folderEntries(
  cache: TreeCache,
  root: string,
  folder: string,
  list: (dir: string) => Promise<readonly { name: string }[]>,
): Promise<readonly { name: string }[]> {
  const listing = cache.get(root, folder);
  if (
    listing !== undefined &&
    listing.error === null &&
    !cache.isStale(root, folder)
  ) {
    return listing.entries;
  }
  return list(folder);
}

export interface DialogModel {
  message: string;
  items: { label: string; detail: string }[];
  /** The main action, or null when the dialog only reports. */
  primaryLabel: string | null;
  cancelLabel: string;
}

function report(
  tr: Translate,
  message: string,
  items: { label: string; detail: string }[] = [],
): DialogModel {
  return {
    message,
    items,
    primaryLabel: null,
    cancelLabel: tr('common.close'),
  };
}
/** A refusal that only reports (another project, another disk). */
export function refuseDialog(key: I18nKey, tr: Translate): DialogModel {
  return report(tr, tr(key));
}
/** The question before a move. */
export function confirmMoveDialog(
  items: readonly DragItem[],
  target: DropTarget,
  tr: Translate,
): DialogModel {
  const folder = basename(target.path);
  const [only] = items;
  const message =
    items.length === 1 && only !== undefined
      ? tr(
          only.isDir
            ? 'workspace.drop.confirmMoveFolder'
            : 'workspace.drop.confirmMoveFile',
          { name: basename(only.path), folder },
        )
      : tr('workspace.drop.confirmMoveMany', {
          count: items.length,
          folder,
        });
  return {
    message,
    items: [],
    primaryLabel: tr('workspace.drop.move'),
    cancelLabel: tr('common.cancel'),
  };
}

const REASON_KEY: Record<DropOp, Record<RejectReason, I18nKey>> = {
  move: {
    sameName: 'workspace.drop.reasonSameName',
    intoSelf: 'workspace.drop.reasonIntoSelfMove',
  },
  copy: {
    sameName: 'workspace.drop.reasonSameName',
    intoSelf: 'workspace.drop.reasonIntoSelfCopy',
  },
};
/** Some items cannot go: which, and why. With none left to go it only reports. */
export function partialDialog(
  decision: Extract<DropDecision, { kind: 'partial' }>,
  target: DropTarget,
  tr: Translate,
): DialogModel {
  const { op, allowed, rejected } = decision;
  const message = tr(
    op === 'move' ? 'workspace.drop.partialMove' : 'workspace.drop.partialCopy',
    {
      total: allowed.length + rejected.length,
      count: rejected.length,
      folder: basename(target.path),
    },
  );
  const items = rejected.map((r) => ({
    label: r.name,
    detail: tr(REASON_KEY[op][r.reason]),
  }));
  if (allowed.length === 0) {
    return report(tr, message, items);
  }
  return {
    message,
    items,
    primaryLabel: tr(
      op === 'move' ? 'workspace.drop.moveRest' : 'workspace.drop.copyRest',
      { rest: allowed.length },
    ),
    cancelLabel: tr('workspace.drop.abandonAll'),
  };
}
/** Items that failed for a reason of their own: one sentence for one item, a
 *  list for several. */
export function failureDialog(
  op: DropOp,
  failures: readonly Failure[],
  tr: Translate,
): DialogModel {
  const [only] = failures;
  if (failures.length === 1 && only !== undefined) {
    return report(
      tr,
      tr(
        op === 'move'
          ? 'workspace.drop.failedOneMove'
          : 'workspace.drop.failedOneCopy',
        { name: only.name, reason: only.reason },
      ),
    );
  }
  return report(
    tr,
    tr(
      op === 'move'
        ? 'workspace.drop.failedManyMove'
        : 'workspace.drop.failedManyCopy',
      { count: failures.length },
    ),
    failures.map((f) => ({ label: f.name, detail: f.reason })),
  );
}

export interface BatchOutcome {
  total: number;
  /** Items that went through, with the path they have now. */
  done: { from: string; to: string }[];
  /** A refusal stopped the batch before the last item. */
  stopped: boolean;
  /** Items that did not go through, with the reason (empty for items never
   *  tried). */
  unfinished: Failure[];
  /** Links a copy left out. */
  skipped: Failure[];
}
/** The dialogs a finished batch calls for, in the order to show them. */
export function outcomeDialogs(
  op: DropOp,
  outcome: BatchOutcome,
  tr: Translate,
): DialogModel[] {
  const out: DialogModel[] = [];
  if (outcome.stopped) {
    out.push(
      report(
        tr,
        tr(
          op === 'move' ? 'workspace.drop.halfMove' : 'workspace.drop.halfCopy',
          { total: outcome.total, done: outcome.done.length },
        ),
        outcome.unfinished.map((f) => ({ label: f.name, detail: f.reason })),
      ),
    );
  } else if (outcome.unfinished.length > 0) {
    out.push(failureDialog(op, outcome.unfinished, tr));
  }
  if (outcome.skipped.length > 0) {
    out.push(
      report(
        tr,
        tr('workspace.drop.linksSkipped'),
        outcome.skipped.map((f) => ({ label: f.name, detail: f.reason })),
      ),
    );
  }
  return out;
}

export type TransferErrorInfo =
  | { kind: 'CrossProject' | 'CrossVolume' | 'SameName' | 'IntoSelf' }
  | { kind: 'Other'; message: string };
const TYPED = ['CrossProject', 'CrossVolume', 'SameName', 'IntoSelf'];
/** What `move_path` or `copy_path` rejected with. */
export function parseTransferError(error: unknown): TransferErrorInfo {
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    const { kind } = error;
    if (typeof kind === 'string' && TYPED.includes(kind)) {
      return { kind } as TransferErrorInfo;
    }
    if (kind === 'Other' && 'message' in error) {
      return { kind: 'Other', message: String(error.message) };
    }
  }
  return { kind: 'Other', message: String(error) };
}
/** True for a refusal that says the tree is not what the drop was checked
 *  against; the rest of the batch is not tried. */
export function isRefusal(error: TransferErrorInfo): boolean {
  return error.kind !== 'Other';
}

function describeError(
  op: DropOp,
  error: TransferErrorInfo,
  tr: Translate,
): string {
  switch (error.kind) {
    case 'CrossProject':
      return tr(REFUSE_PROJECT[op]);
    case 'CrossVolume':
      return tr(REFUSE_VOLUME[op]);
    case 'SameName':
      return tr(REASON_KEY[op].sameName);
    case 'IntoSelf':
      return tr(REASON_KEY[op].intoSelf);
    case 'Other':
      return error.message;
  }
}
export type Invoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
/** Hand the items to `move_path` or `copy_path` one at a time. A refusal that
 *  says the tree changed stops the batch; any other failure is noted and the
 *  rest carry on. */
export async function runBatch(
  op: DropOp,
  items: readonly DragItem[],
  targetDir: string,
  root: string,
  invoke: Invoke,
  tr: Translate,
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = {
    total: items.length,
    done: [],
    stopped: false,
    unfinished: [],
    skipped: [],
  };
  for (const [at, item] of items.entries()) {
    try {
      const result = await invoke(op === 'move' ? 'move_path' : 'copy_path', {
        src: item.path,
        destDir: targetDir,
        root,
      });
      if (op === 'move') {
        outcome.done.push({ from: item.path, to: String(result) });
      } else {
        const copied = result as {
          path: string;
          skipped: { path: string; reason: string }[];
        };
        outcome.done.push({ from: item.path, to: copied.path });
        for (const link of copied.skipped) {
          outcome.skipped.push({
            name: link.path,
            reason: tr('workspace.drop.reasonSymlinkPrivilege'),
          });
        }
      }
    } catch (e) {
      const error = parseTransferError(e);
      outcome.unfinished.push({
        name: basename(item.path),
        reason: describeError(op, error, tr),
      });
      if (isRefusal(error)) {
        outcome.stopped = true;
        for (const rest of items.slice(at + 1)) {
          outcome.unfinished.push({ name: basename(rest.path), reason: '' });
        }
        break;
      }
    }
  }
  return outcome;
}
/** What the page shows and stores, handed in so a finished drop can be applied
 *  without the component. */
export interface DropEnv {
  cache: TreeCache;
  expanded: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  setState(expanded: Set<string>, selected: Set<string>): void;
  touch(): void;
  persistExpanded(): void;
  refreshDir(dir: string): void;
}
/** Bring the tree in line with what a batch did. A move carries what was read
 *  of a folder, its open state and its selection to the new path, then both
 *  folders are read again; a copy only reads the folder it landed in. */
export function applyDropResult(
  env: DropEnv,
  op: DropOp,
  root: string,
  done: readonly { from: string; to: string }[],
  targetDir: string,
): void {
  if (done.length === 0) {
    return;
  }
  if (op === 'copy') {
    env.refreshDir(targetDir);
    return;
  }
  let expanded = new Set(env.expanded);
  let selected = new Set(env.selected);
  const refresh = new Set([targetDir]);
  for (const move of done) {
    env.cache.renameSubtree(root, move.from, move.to);
    expanded = renameInSet(expanded, move.from, move.to);
    selected = renameInSet(selected, move.from, move.to);
    refresh.add(parentOf(move.from));
  }
  env.setState(expanded, selected);
  env.touch();
  env.persistExpanded();
  for (const dir of refresh) {
    env.refreshDir(dir);
  }
}
