// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { TreeEntry, VisibleRow } from './projectTree';
import { TreeCache } from './treeCache';
import {
  applyDropResult,
  confirmMoveDialog,
  DragGesture,
  dragItems,
  dropDecision,
  dropFolder,
  exceedsDragThreshold,
  failureDialog,
  folderEntries,
  hoverFeedback,
  modifierOp,
  outcomeDialogs,
  parseTransferError,
  partialDialog,
  refuseDialog,
  runBatch,
  targetVolumeOfPath,
  volumeOfPath,
  type BatchOutcome,
  type DragItem,
  type DropDecision,
  type DropOp,
  type DropTarget,
  type Invoke,
  type Translate,
} from './treeMove';
/** Words stand in for the texts: the key, then the values that go into it. */
const tr: Translate = (key, params) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`;

function item(path: string, over: Partial<DragItem> = {}): DragItem {
  return {
    path,
    root: '/p',
    isDir: false,
    volume: 1,
    volumeError: null,
    ...over,
  };
}

function folder(path: string, over: Partial<DragItem> = {}): DragItem {
  return item(path, { isDir: true, ...over });
}

function target(path: string, over: Partial<DropTarget> = {}): DropTarget {
  return { path, root: '/p', volume: 1, volumeError: null, ...over };
}

function decide(
  op: DropOp,
  items: DragItem[],
  to: DropTarget,
  children: string[] = [],
  caseInsensitive = false,
): DropDecision {
  return dropDecision({
    op,
    items,
    target: to,
    targetChildren: children.map((name) => ({ name })),
    caseInsensitive,
  });
}

function row(path: string, over: Partial<VisibleRow> = {}): VisibleRow {
  return {
    name: path.split('/').pop() ?? path,
    path,
    isDir: false,
    depth: 1,
    expanded: false,
    expandable: false,
    root: false,
    project: '/p',
    isError: false,
    ...over,
  };
}

describe('modifierOp', () => {
  const keys = (altKey: boolean, ctrlKey: boolean) => ({ altKey, ctrlKey });

  it('copies on macOS while Option is held, never on Ctrl', () => {
    expect(modifierOp(keys(true, false), 'macos')).toBe('copy');
    expect(modifierOp(keys(false, true), 'macos')).toBe('move');
    expect(modifierOp(keys(false, false), 'macos')).toBe('move');
  });

  it('copies on Windows while Ctrl is held, never on Alt', () => {
    expect(modifierOp(keys(false, true), 'windows')).toBe('copy');
    expect(modifierOp(keys(true, false), 'windows')).toBe('move');
    expect(modifierOp(keys(false, false), 'windows')).toBe('move');
  });

  it('moves where the platform is not known', () => {
    expect(modifierOp(keys(true, true), null)).toBe('move');
    expect(modifierOp(keys(true, true), 'linux')).toBe('move');
  });
});

describe('the start of a drag', () => {
  it('needs more than 4 px of travel', () => {
    expect(exceedsDragThreshold(4, 0)).toBe(false);
    expect(exceedsDragThreshold(0, -4)).toBe(false);
    expect(exceedsDragThreshold(3, 3)).toBe(true);
    expect(exceedsDragThreshold(5, 0)).toBe(true);
  });

  it('does not begin while the pointer stays within 4 px', () => {
    const gesture = new DragGesture();
    gesture.press(10, 10);
    expect(gesture.move(12, 12)).toBe(false);
    expect(gesture.move(14, 10)).toBe(false);
    expect(gesture.dragging).toBe(false);
    expect(gesture.release()).toBe(false);
  });

  it('keeps going once begun, even when the pointer comes back', () => {
    const gesture = new DragGesture();
    gesture.press(10, 10);
    expect(gesture.move(30, 10)).toBe(true);
    expect(gesture.move(10, 10)).toBe(true);
  });
});

describe('the click after a drag', () => {
  it('is ignored once, and only after a drag', () => {
    const gesture = new DragGesture();
    gesture.press(0, 0);
    gesture.move(20, 0);
    expect(gesture.release()).toBe(true);
    expect(gesture.consumeClick()).toBe(true);
    expect(gesture.consumeClick()).toBe(false);
  });

  it('is left alone when the press never became a drag', () => {
    const gesture = new DragGesture();
    gesture.press(0, 0);
    gesture.move(2, 2);
    expect(gesture.release()).toBe(false);
    expect(gesture.consumeClick()).toBe(false);
  });

  it('is forgotten when no click arrives', () => {
    const gesture = new DragGesture();
    gesture.press(0, 0);
    gesture.move(20, 0);
    gesture.release();
    gesture.forgetClick();
    expect(gesture.consumeClick()).toBe(false);
  });

  it('is ignored after a drag given up with Esc, which then drops nothing', () => {
    const gesture = new DragGesture();
    gesture.press(0, 0);
    gesture.move(20, 0);
    gesture.cancel();
    expect(gesture.move(40, 0)).toBe(false);
    expect(gesture.release()).toBe(false);
    expect(gesture.consumeClick()).toBe(true);
  });
});

describe('a drag that is given up', () => {
  it('leaves no click to ignore when the pointer was taken away', () => {
    const gesture = new DragGesture();
    gesture.press(0, 0);
    gesture.move(20, 0);
    gesture.reset();
    expect(gesture.consumeClick()).toBe(false);
    expect(gesture.move(40, 0)).toBe(false);
  });

  it('does not let a later, plain click be ignored', () => {
    const gesture = new DragGesture();
    gesture.press(0, 0);
    gesture.move(20, 0);
    gesture.cancel();
    gesture.press(100, 100);
    expect(gesture.release()).toBe(false);
    expect(gesture.consumeClick()).toBe(false);
  });

  it('ignores only its own click after Esc', () => {
    const gesture = new DragGesture();
    gesture.press(0, 0);
    gesture.move(20, 0);
    gesture.cancel();
    expect(gesture.release()).toBe(false);
    expect(gesture.consumeClick()).toBe(true);
    expect(gesture.consumeClick()).toBe(false);
  });
});

describe('dragItems', () => {
  const rows = [
    row('/p', { root: true, isDir: true, depth: 0 }),
    row('/p/a', { isDir: true }),
    row('/p/a/x.txt', { depth: 2 }),
    row('/p/b', { isDir: true }),
    row('/p/b/y.txt', { depth: 2 }),
    row('/p/c.txt'),
  ];
  const paths = (picked: VisibleRow[]) => picked.map((r) => r.path);

  it('takes only the pressed row when it is not selected', () => {
    const picked = dragItems('/p/c.txt', rows, new Set(['/p/a']), false);
    expect(paths(picked)).toEqual(['/p/c.txt']);
  });

  it('takes the whole selection when the pressed row is in it', () => {
    const selected = new Set(['/p/a/x.txt', '/p/b', '/p/c.txt']);
    const picked = dragItems('/p/b', rows, selected, false);
    expect(paths(picked)).toEqual(['/p/a/x.txt', '/p/b', '/p/c.txt']);
  });

  it('keeps only the top folder of a folder and what is inside it', () => {
    const selected = new Set(['/p/a', '/p/a/x.txt', '/p/c.txt']);
    const picked = dragItems('/p/c.txt', rows, selected, false);
    expect(paths(picked)).toEqual(['/p/a', '/p/c.txt']);
  });

  it('does not mistake a folder whose name starts the same for its parent', () => {
    const near = [row('/p/a', { isDir: true }), row('/p/ab.txt')];
    const picked = dragItems(
      '/p/a',
      near,
      new Set(['/p/a', '/p/ab.txt']),
      false,
    );
    expect(paths(picked)).toEqual(['/p/a', '/p/ab.txt']);
  });

  it('never takes a project folder or an error row', () => {
    expect(dragItems('/p', rows, new Set(['/p']), false)).toEqual([]);
    const withRoot = new Set(['/p', '/p/c.txt']);
    expect(paths(dragItems('/p/c.txt', rows, withRoot, false))).toEqual([
      '/p/c.txt',
    ]);
    const broken = [row('/p\u0000error', { isError: true })];
    expect(dragItems('/p\u0000error', broken, new Set(), false)).toEqual([]);
  });

  it('takes nothing for a row that is not shown', () => {
    expect(dragItems('/p/zzz', rows, new Set(), false)).toEqual([]);
  });
});

describe('dropFolder', () => {
  it('is the folder itself, or the folder holding a file', () => {
    expect(dropFolder(row('/p/a', { isDir: true }))).toBe('/p/a');
    expect(dropFolder(row('/p/a/x.txt'))).toBe('/p/a');
    expect(dropFolder(row('/p', { isDir: true, root: true }))).toBe('/p');
    expect(dropFolder(row('/p/x.txt'))).toBe('/p');
  });
});

describe('dropDecision', () => {
  it('moves one item after asking', () => {
    const a = item('/p/a.txt');
    expect(decide('move', [a], target('/p/d'))).toEqual({
      kind: 'confirmMove',
      items: [a],
    });
  });

  it('copies without asking', () => {
    const a = item('/p/a.txt');
    expect(decide('copy', [a], target('/p/d'))).toEqual({
      kind: 'copyNow',
      items: [a],
    });
  });

  it('refuses another project, for a move and for a copy', () => {
    const a = item('/p/a.txt');
    const other = target('/q/d', { root: '/q' });
    expect(decide('move', [a], other)).toEqual({
      kind: 'refuse',
      messageKey: 'workspace.drop.refuseMoveProject',
    });
    expect(decide('copy', [a], other)).toEqual({
      kind: 'refuse',
      messageKey: 'workspace.drop.refuseCopyProject',
    });
  });

  it('refuses the whole batch when any one item is from another project', () => {
    const items = [item('/p/a.txt'), item('/q/b.txt', { root: '/q' })];
    expect(decide('move', items, target('/p/d')).kind).toBe('refuse');
  });

  it('puts another project before another disk', () => {
    const a = item('/p/a.txt');
    const other = target('/q/d', { root: '/q', volume: 2 });
    expect(decide('move', [a], other)).toEqual({
      kind: 'refuse',
      messageKey: 'workspace.drop.refuseMoveProject',
    });
  });

  it('refuses another disk, and a disk that is not known', () => {
    const a = item('/p/a.txt');
    expect(decide('move', [a], target('/p/mnt', { volume: 2 }))).toEqual({
      kind: 'refuse',
      messageKey: 'workspace.drop.refuseMoveVolume',
    });
    expect(decide('copy', [a], target('/p/mnt', { volume: 2 }))).toEqual({
      kind: 'refuse',
      messageKey: 'workspace.drop.refuseCopyVolume',
    });
    expect(decide('move', [a], target('/p/d', { volume: null })).kind).toBe(
      'refuse',
    );
    expect(
      decide('move', [item('/p/a.txt', { volume: null })], target('/p/d')).kind,
    ).toBe('refuse');
  });

  it('refuses the whole batch when any one item is on another disk', () => {
    const items = [item('/p/a.txt'), item('/p/b.txt', { volume: 2 })];
    expect(decide('move', items, target('/p/d')).kind).toBe('refuse');
  });

  it('reports a disk that could not be read with its reason, not as another disk', () => {
    const broken = item('/p/a.txt', { volume: null, volumeError: 'no access' });
    expect(decide('move', [broken], target('/p/d'))).toEqual({
      kind: 'error',
      op: 'move',
      failures: [{ name: 'a.txt', reason: 'no access' }],
    });
    const fine = item('/p/b.txt');
    expect(
      decide(
        'copy',
        [fine, item('/p/c.txt')],
        target('/p/d', { volume: null, volumeError: 'gone' }),
      ),
    ).toEqual({
      kind: 'error',
      op: 'copy',
      failures: [
        { name: 'b.txt', reason: 'gone' },
        { name: 'c.txt', reason: 'gone' },
      ],
    });
  });

  it('lists only the items whose disk could not be read', () => {
    const items = [
      item('/p/a.txt'),
      item('/p/b.txt', { volume: null, volumeError: 'no access' }),
    ];
    expect(decide('move', items, target('/p/d'))).toEqual({
      kind: 'error',
      op: 'move',
      failures: [{ name: 'b.txt', reason: 'no access' }],
    });
  });

  it('lets an item go that does not clash, and names the one that does', () => {
    const a = item('/p/a.txt');
    const b = item('/p/b.txt');
    expect(decide('move', [a, b], target('/p/d'), ['b.txt'])).toEqual({
      kind: 'partial',
      op: 'move',
      allowed: [a],
      rejected: [{ name: 'b.txt', reason: 'sameName' }],
    });
  });

  it('matches names without regard to case where the platform does', () => {
    const a = item('/p/A.txt');
    expect(decide('move', [a], target('/p/d'), ['a.txt'], true).kind).toBe(
      'partial',
    );
    expect(decide('move', [a], target('/p/d'), ['a.txt'], false).kind).toBe(
      'confirmMove',
    );
  });

  it('refuses a folder dropped on itself or below itself', () => {
    const y = folder('/p/y');
    for (const to of ['/p/y', '/p/y/sub']) {
      expect(decide('move', [y], target(to))).toEqual({
        kind: 'partial',
        op: 'move',
        allowed: [],
        rejected: [{ name: 'y', reason: 'intoSelf' }],
      });
      expect(decide('copy', [y], target(to)).kind).toBe('partial');
    }
  });

  it('does not take a folder for the parent of one that only starts like it', () => {
    expect(decide('move', [folder('/p/y')], target('/p/y2')).kind).toBe(
      'confirmMove',
    );
  });

  it('refuses the second of two items with the same name', () => {
    const first = item('/p/a/n.txt');
    const second = item('/p/b/n.txt');
    expect(decide('move', [first, second], target('/p/d'))).toEqual({
      kind: 'partial',
      op: 'move',
      allowed: [first],
      rejected: [{ name: 'n.txt', reason: 'sameName' }],
    });
  });

  it('sets aside an item that already sits in the folder', () => {
    const here = item('/p/d/a.txt');
    expect(decide('move', [here], target('/p/d'), ['a.txt'])).toEqual({
      kind: 'noop',
    });
    const away = item('/p/b.txt');
    expect(decide('move', [here, away], target('/p/d'), ['a.txt'])).toEqual({
      kind: 'confirmMove',
      items: [away],
    });
  });

  it('still counts a name that stays put as taken', () => {
    const here = item('/p/d/a.txt');
    const other = item('/p/e/a.txt');
    expect(decide('move', [here, other], target('/p/d'), ['a.txt'])).toEqual({
      kind: 'partial',
      op: 'move',
      allowed: [],
      rejected: [{ name: 'a.txt', reason: 'sameName' }],
    });
  });

  it('refuses a copy into the folder the item is in, by name', () => {
    const here = item('/p/d/a.txt');
    expect(decide('copy', [here], target('/p/d'), ['a.txt'])).toEqual({
      kind: 'partial',
      op: 'copy',
      allowed: [],
      rejected: [{ name: 'a.txt', reason: 'sameName' }],
    });
  });

  it('does nothing for no items', () => {
    expect(decide('move', [], target('/p/d'))).toEqual({ kind: 'noop' });
  });
});

describe('hoverFeedback', () => {
  it('shows a place that takes the drop with the cursor of the operation', () => {
    const ok = decide('move', [item('/p/a.txt')], target('/p/d'));
    expect(hoverFeedback(ok, 'move')).toEqual({
      allowed: true,
      cursor: 'grabbing',
    });
    const copy = decide('copy', [item('/p/a.txt')], target('/p/d'));
    expect(hoverFeedback(copy, 'copy')).toEqual({
      allowed: true,
      cursor: 'copy',
    });
  });

  it('shows no highlight and a forbidden cursor where nothing can go', () => {
    const forbidden = { allowed: false, cursor: 'not-allowed' };
    const other = decide(
      'move',
      [item('/p/a.txt')],
      target('/q', { root: '/q' }),
    );
    expect(hoverFeedback(other, 'move')).toEqual(forbidden);
    const disk = decide(
      'move',
      [item('/p/a.txt')],
      target('/p/m', { volume: 2 }),
    );
    expect(hoverFeedback(disk, 'move')).toEqual(forbidden);
    const self = decide('move', [folder('/p/y')], target('/p/y/s'));
    expect(hoverFeedback(self, 'move')).toEqual(forbidden);
    const broken = decide(
      'move',
      [item('/p/a.txt')],
      target('/p/d', { volumeError: 'x' }),
    );
    expect(hoverFeedback(broken, 'move')).toEqual(forbidden);
  });

  it('keeps a place that takes part of the batch, and leaves the same folder plain', () => {
    const part = decide(
      'move',
      [item('/p/a.txt'), folder('/p/y')],
      target('/p/y/s'),
    );
    expect(part.kind).toBe('partial');
    expect(hoverFeedback(part, 'move').allowed).toBe(true);
    const same = decide('move', [item('/p/d/a.txt')], target('/p/d'));
    expect(hoverFeedback(same, 'move')).toEqual({
      allowed: false,
      cursor: 'default',
    });
  });
});

describe('volumeOfPath', () => {
  function entry(path: string, volume: number | null, error: string | null) {
    return {
      name: path.split('/').pop() ?? path,
      path,
      is_dir: false,
      children: null,
      volume,
      volume_error: error,
      target_volume: null,
      target_volume_error: null,
    } satisfies TreeEntry;
  }

  it('reads an entry from the listing of the folder holding it', () => {
    const cache = new TreeCache();
    cache.setDir('/p', '/p', cache.begin('/p', '/p'), {
      entries: [entry('/p/a', 7, null), entry('/p/b', null, 'denied')],
      error: null,
    });
    expect(volumeOfPath(cache, '/p', '/p/a')).toEqual({
      volume: 7,
      volumeError: null,
    });
    expect(volumeOfPath(cache, '/p', '/p/b')).toEqual({
      volume: null,
      volumeError: 'denied',
    });
  });

  it('does not know an entry it has not read', () => {
    expect(volumeOfPath(new TreeCache(), '/p', '/p/zzz')).toEqual({
      volume: null,
      volumeError: null,
    });
  });
});

describe('which disk counts for what', () => {
  /** A listing in /p: a link to a folder on disk 2 that itself lives on disk 1,
   *  a dangling link, a plain folder on disk 1, and a disk mounted on a folder. */
  function listed(): TreeCache {
    const entry = (
      path: string,
      isDir: boolean,
      volume: number | null,
      targetVolume: number | null,
    ): TreeEntry => ({
      name: path.split('/').pop() ?? path,
      path,
      is_dir: isDir,
      children: null,
      volume,
      volume_error: null,
      target_volume: targetVolume,
      target_volume_error: null,
    });
    const cache = new TreeCache();
    cache.setDir('/p', '/p', cache.begin('/p', '/p'), {
      entries: [
        entry('/p/portal', true, 1, 2),
        entry('/p/dangling', false, 1, null),
        entry('/p/plain', true, 1, 1),
        entry('/p/mnt', true, 1, 3),
      ],
      error: null,
    });
    cache.setRootVolume('/p', { volume: 1, volumeError: null });
    return cache;
  }

  function dropOn(cache: TreeCache, from: string, onto: string): DropDecision {
    const dragged = row(from, { isDir: from.endsWith('portal') });
    return dropDecision({
      op: 'move',
      items: [
        {
          path: dragged.path,
          root: '/p',
          isDir: dragged.isDir,
          ...volumeOfPath(cache, '/p', dragged.path),
        },
      ],
      target: {
        path: onto,
        root: '/p',
        ...targetVolumeOfPath(cache, '/p', onto),
      },
      targetChildren: [],
      caseInsensitive: false,
    });
  }

  it('takes an item as the disk it is on, not the one a link leads to', () => {
    const cache = listed();
    expect(volumeOfPath(cache, '/p', '/p/portal').volume).toBe(1);
    expect(volumeOfPath(cache, '/p', '/p/dangling').volume).toBe(1);
  });

  it('takes a folder as the disk it leads to', () => {
    const cache = listed();
    expect(targetVolumeOfPath(cache, '/p', '/p/portal').volume).toBe(2);
    expect(targetVolumeOfPath(cache, '/p', '/p/mnt').volume).toBe(3);
    expect(targetVolumeOfPath(cache, '/p', '/p/plain').volume).toBe(1);
  });

  it('reads the project folder from its own record', () => {
    const cache = new TreeCache();
    expect(targetVolumeOfPath(cache, '/p', '/p')).toEqual({
      volume: null,
      volumeError: null,
    });
    cache.setRootVolume('/p', { volume: 5, volumeError: null });
    expect(targetVolumeOfPath(cache, '/p', '/p')).toEqual({
      volume: 5,
      volumeError: null,
    });
  });

  it('does not know a folder it has not read', () => {
    expect(targetVolumeOfPath(new TreeCache(), '/p', '/p/zzz')).toEqual({
      volume: null,
      volumeError: null,
    });
  });

  it('lets a link to another disk be dragged within the project', () => {
    expect(dropOn(listed(), '/p/portal', '/p/plain').kind).toBe('confirmMove');
  });

  it('lets a dangling link be dragged', () => {
    expect(dropOn(listed(), '/p/dangling', '/p/plain').kind).toBe(
      'confirmMove',
    );
  });

  it('refuses a drop into a link to another disk, and into a mounted disk', () => {
    const refused = {
      kind: 'refuse',
      messageKey: 'workspace.drop.refuseMoveVolume',
    };
    expect(dropOn(listed(), '/p/dangling', '/p/portal')).toEqual(refused);
    expect(dropOn(listed(), '/p/dangling', '/p/mnt')).toEqual(refused);
  });
});

describe('the dialogs', () => {
  it('asks about one file, one folder, and several items', () => {
    const to = target('/p/d');
    expect(confirmMoveDialog([item('/p/a.txt')], to, tr)).toEqual({
      message: 'workspace.drop.confirmMoveFile {"name":"a.txt","folder":"d"}',
      items: [],
      primaryLabel: 'workspace.drop.move',
      cancelLabel: 'common.cancel',
    });
    expect(confirmMoveDialog([folder('/p/y')], to, tr).message).toBe(
      'workspace.drop.confirmMoveFolder {"name":"y","folder":"d"}',
    );
    expect(
      confirmMoveDialog([item('/p/a.txt'), folder('/p/y')], to, tr).message,
    ).toBe('workspace.drop.confirmMoveMany {"count":2,"folder":"d"}');
  });

  it('only reports a refusal', () => {
    expect(refuseDialog('workspace.drop.refuseMoveVolume', tr)).toEqual({
      message: 'workspace.drop.refuseMoveVolume',
      items: [],
      primaryLabel: null,
      cancelLabel: 'common.close',
    });
  });

  it('offers the rest of a batch that is partly refused', () => {
    const decision = decide(
      'move',
      [item('/p/a.txt'), item('/p/b.txt'), folder('/p/y')],
      target('/p/y/d'),
      ['b.txt'],
    );
    if (decision.kind !== 'partial') {
      throw new Error('expected a partial decision');
    }
    expect(partialDialog(decision, target('/p/y/d'), tr)).toEqual({
      message: 'workspace.drop.partialMove {"total":3,"count":2,"folder":"d"}',
      items: [
        { label: 'b.txt', detail: 'workspace.drop.reasonSameName' },
        { label: 'y', detail: 'workspace.drop.reasonIntoSelfMove' },
      ],
      primaryLabel: 'workspace.drop.moveRest {"rest":1}',
      cancelLabel: 'workspace.drop.abandonAll',
    });
  });

  it('words a partly refused copy with the copy texts', () => {
    const decision = decide(
      'copy',
      [item('/p/a.txt'), folder('/p/y')],
      target('/p/y/d'),
    );
    if (decision.kind !== 'partial') {
      throw new Error('expected a partial decision');
    }
    const dialog = partialDialog(decision, target('/p/y/d'), tr);
    expect(dialog.message).toContain('workspace.drop.partialCopy');
    expect(dialog.primaryLabel).toBe('workspace.drop.copyRest {"rest":1}');
    expect(dialog.items[0]?.detail).toBe('workspace.drop.reasonIntoSelfCopy');
  });

  it('only reports, with Close, when nothing can go', () => {
    const decision = decide('move', [item('/p/b.txt')], target('/p/d'), [
      'b.txt',
    ]);
    if (decision.kind !== 'partial') {
      throw new Error('expected a partial decision');
    }
    const dialog = partialDialog(decision, target('/p/d'), tr);
    expect(dialog.primaryLabel).toBeNull();
    expect(dialog.cancelLabel).toBe('common.close');
    expect(dialog.items).toEqual([
      { label: 'b.txt', detail: 'workspace.drop.reasonSameName' },
    ]);
  });

  it('puts one failed item in a sentence and several in a list', () => {
    expect(
      failureDialog('move', [{ name: 'a.txt', reason: 'disk full' }], tr),
    ).toEqual({
      message:
        'workspace.drop.failedOneMove {"name":"a.txt","reason":"disk full"}',
      items: [],
      primaryLabel: null,
      cancelLabel: 'common.close',
    });
    const many = failureDialog(
      'copy',
      [
        { name: 'a.txt', reason: 'x' },
        { name: 'b.txt', reason: 'y' },
      ],
      tr,
    );
    expect(many.message).toBe('workspace.drop.failedManyCopy {"count":2}');
    expect(many.items).toEqual([
      { label: 'a.txt', detail: 'x' },
      { label: 'b.txt', detail: 'y' },
    ]);
  });

  it('puts the batch outcomes into the right dialogs', () => {
    const base: BatchOutcome = {
      total: 3,
      done: [{ from: '/p/a', to: '/p/d/a' }],
      stopped: false,
      unfinished: [],
      skipped: [],
    };
    expect(outcomeDialogs('move', base, tr)).toEqual([]);
    const stopped = outcomeDialogs(
      'move',
      {
        ...base,
        stopped: true,
        unfinished: [
          { name: 'b', reason: 'taken' },
          { name: 'c', reason: '' },
        ],
      },
      tr,
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.message).toBe(
      'workspace.drop.halfMove {"total":3,"done":1}',
    );
    expect(stopped[0]?.items).toEqual([
      { label: 'b', detail: 'taken' },
      { label: 'c', detail: '' },
    ]);
    const half = outcomeDialogs('copy', { ...base, stopped: true }, tr);
    expect(half[0]?.message).toContain('workspace.drop.halfCopy');
    const failed = outcomeDialogs(
      'move',
      { ...base, unfinished: [{ name: 'b', reason: 'denied' }] },
      tr,
    );
    expect(failed[0]?.message).toContain('workspace.drop.failedOneMove');
    const links = outcomeDialogs(
      'copy',
      { ...base, skipped: [{ name: 'y/ln', reason: 'no right' }] },
      tr,
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.message).toBe('workspace.drop.linksSkipped');
    expect(links[0]?.items).toEqual([{ label: 'y/ln', detail: 'no right' }]);
    const both = outcomeDialogs(
      'copy',
      {
        ...base,
        unfinished: [{ name: 'b', reason: 'denied' }],
        skipped: [{ name: 'y/ln', reason: 'no right' }],
      },
      tr,
    );
    expect(both).toHaveLength(2);
  });
});

describe('parseTransferError', () => {
  it('knows the refusals and the system reason', () => {
    expect(parseTransferError({ kind: 'SameName' })).toEqual({
      kind: 'SameName',
    });
    expect(parseTransferError({ kind: 'CrossVolume' })).toEqual({
      kind: 'CrossVolume',
    });
    expect(parseTransferError({ kind: 'Other', message: 'disk full' })).toEqual(
      {
        kind: 'Other',
        message: 'disk full',
      },
    );
    expect(parseTransferError('boom')).toEqual({
      kind: 'Other',
      message: 'boom',
    });
    expect(parseTransferError({ kind: 'Unheard' })).toEqual({
      kind: 'Other',
      message: '[object Object]',
    });
  });
});

describe('runBatch', () => {
  const a = item('/p/a.txt');
  const b = item('/p/b.txt');
  const c = item('/p/c.txt');
  /** A backend that answers per source path: a path, an error to reject with. */
  function backend(answers: Record<string, unknown>): {
    invoke: Invoke;
    calls: { command: string; args: Record<string, unknown> }[];
  } {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    return {
      calls,
      invoke: (command, args) => {
        calls.push({ command, args });
        const answer = answers[String(args['src'])];
        if (typeof answer === 'object' && answer !== null && 'fail' in answer) {
          return Promise.reject(answer.fail);
        }
        return Promise.resolve(answer);
      },
    };
  }

  it('moves each item in turn and records where it went', async () => {
    const { invoke, calls } = backend({
      '/p/a.txt': '/p/d/a.txt',
      '/p/b.txt': '/p/d/b.txt',
    });
    const outcome = await runBatch('move', [a, b], '/p/d', '/p', invoke, tr);
    expect(calls).toEqual([
      {
        command: 'move_path',
        args: { src: '/p/a.txt', destDir: '/p/d', root: '/p' },
      },
      {
        command: 'move_path',
        args: { src: '/p/b.txt', destDir: '/p/d', root: '/p' },
      },
    ]);
    expect(outcome).toEqual({
      total: 2,
      done: [
        { from: '/p/a.txt', to: '/p/d/a.txt' },
        { from: '/p/b.txt', to: '/p/d/b.txt' },
      ],
      stopped: false,
      unfinished: [],
      skipped: [],
    });
  });

  it('copies, and notes the links that could not be made', async () => {
    const { invoke, calls } = backend({
      '/p/a.txt': {
        path: '/p/d/a.txt',
        skipped: [{ path: 'a.txt/ln', reason: 'symlinkPrivilege' }],
      },
    });
    const outcome = await runBatch('copy', [a], '/p/d', '/p', invoke, tr);
    expect(calls[0]?.command).toBe('copy_path');
    expect(outcome.done).toEqual([{ from: '/p/a.txt', to: '/p/d/a.txt' }]);
    expect(outcome.skipped).toEqual([
      { name: 'a.txt/ln', reason: 'workspace.drop.reasonSymlinkPrivilege' },
    ]);
  });

  it('stops at a refusal and lists what was never tried', async () => {
    const { invoke, calls } = backend({
      '/p/a.txt': '/p/d/a.txt',
      '/p/b.txt': { fail: { kind: 'SameName' } },
    });
    const outcome = await runBatch('move', [a, b, c], '/p/d', '/p', invoke, tr);
    expect(calls).toHaveLength(2);
    expect(outcome.stopped).toBe(true);
    expect(outcome.done).toEqual([{ from: '/p/a.txt', to: '/p/d/a.txt' }]);
    expect(outcome.unfinished).toEqual([
      { name: 'b.txt', reason: 'workspace.drop.reasonSameName' },
      { name: 'c.txt', reason: '' },
    ]);
  });

  it('puts each refusal into words', async () => {
    for (const [kind, text] of [
      ['CrossProject', 'workspace.drop.refuseCopyProject'],
      ['CrossVolume', 'workspace.drop.refuseCopyVolume'],
      ['IntoSelf', 'workspace.drop.reasonIntoSelfCopy'],
    ] as const) {
      const { invoke } = backend({ '/p/a.txt': { fail: { kind } } });
      const outcome = await runBatch('copy', [a], '/p/d', '/p', invoke, tr);
      expect(outcome.unfinished).toEqual([{ name: 'a.txt', reason: text }]);
    }
  });

  it('goes on after a failure of another kind and lists it', async () => {
    const { invoke, calls } = backend({
      '/p/a.txt': '/p/d/a.txt',
      '/p/b.txt': { fail: { kind: 'Other', message: 'input/output error' } },
      '/p/c.txt': '/p/d/c.txt',
    });
    const outcome = await runBatch('move', [a, b, c], '/p/d', '/p', invoke, tr);
    expect(calls).toHaveLength(3);
    expect(outcome.stopped).toBe(false);
    expect(outcome.done.map((d) => d.from)).toEqual(['/p/a.txt', '/p/c.txt']);
    expect(outcome.unfinished).toEqual([
      { name: 'b.txt', reason: 'input/output error' },
    ]);
  });

  it('lists every unfinished item when a refusal follows another failure', async () => {
    const { invoke } = backend({
      '/p/a.txt': { fail: { kind: 'Other', message: 'denied' } },
      '/p/b.txt': { fail: { kind: 'IntoSelf' } },
      '/p/c.txt': '/p/d/c.txt',
    });
    const outcome = await runBatch('move', [a, b, c], '/p/d', '/p', invoke, tr);
    expect(outcome.stopped).toBe(true);
    expect(outcome.done).toEqual([]);
    expect(outcome.unfinished.map((f) => f.name)).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
    expect(outcome.unfinished[0]?.reason).toBe('denied');
  });

  it('takes a failure that is not an error object as the system reason', async () => {
    const { invoke } = backend({ '/p/a.txt': { fail: 'plain text' } });
    const outcome = await runBatch('move', [a], '/p/d', '/p', invoke, tr);
    expect(outcome.stopped).toBe(false);
    expect(outcome.unfinished).toEqual([
      { name: 'a.txt', reason: 'plain text' },
    ]);
  });
});

describe('applyDropResult', () => {
  function setup() {
    const cache = new TreeCache();
    const entry = (path: string, isDir: boolean): TreeEntry => ({
      name: path.split('/').pop() ?? path,
      path,
      is_dir: isDir,
      children: null,
      volume: 1,
      volume_error: null,
      target_volume: null,
      target_volume_error: null,
    });
    const put = (dir: string, ...entries: TreeEntry[]) =>
      cache.setDir('/p', dir, cache.begin('/p', dir), { entries, error: null });
    put('/p', entry('/p/y', true), entry('/p/z', true));
    put('/p/y', entry('/p/y/inner', true), entry('/p/y/f.txt', false));
    put('/p/y/inner', entry('/p/y/inner/g.txt', false));
    put('/p/z');
    const calls: string[] = [];
    let state: { expanded: Set<string>; selected: Set<string> } | null = null;
    const env = {
      cache,
      expanded: new Set(['/p', '/p/y', '/p/y/inner', '/p/z']),
      selected: new Set(['/p/y', '/p/y/f.txt', '/p/z']),
      setState: (expanded: Set<string>, selected: Set<string>) => {
        state = { expanded, selected };
        calls.push('setState');
      },
      touch: () => calls.push('touch'),
      persistExpanded: vi.fn(() => calls.push('persist')),
      refreshDir: vi.fn((dir: string) => calls.push(`refresh ${dir}`)),
    };
    return { env, calls, state: () => state };
  }

  it('carries a moved folder, its open state and its selection to the new path', () => {
    const { env, calls, state } = setup();
    applyDropResult(
      env,
      'move',
      '/p',
      [{ from: '/p/y', to: '/p/z/y' }],
      '/p/z',
    );
    expect(env.cache.get('/p', '/p/y')).toBeUndefined();
    expect(env.cache.get('/p', '/p/z/y')?.entries.map((e) => e.path)).toEqual([
      '/p/z/y/inner',
      '/p/z/y/f.txt',
    ]);
    expect(
      env.cache.get('/p', '/p/z/y/inner')?.entries.map((e) => e.path),
    ).toEqual(['/p/z/y/inner/g.txt']);
    expect([...(state()?.expanded ?? [])].sort()).toEqual([
      '/p',
      '/p/z',
      '/p/z/y',
      '/p/z/y/inner',
    ]);
    expect([...(state()?.selected ?? [])].sort()).toEqual([
      '/p/z',
      '/p/z/y',
      '/p/z/y/f.txt',
    ]);
    expect(env.persistExpanded).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'setState',
      'touch',
      'persist',
      'refresh /p/z',
      'refresh /p',
    ]);
  });

  it('reads both folders again for every move, once each', () => {
    const { env } = setup();
    applyDropResult(
      env,
      'move',
      '/p',
      [
        { from: '/p/y/f.txt', to: '/p/z/f.txt' },
        { from: '/p/y/inner', to: '/p/z/inner' },
      ],
      '/p/z',
    );
    expect(env.refreshDir.mock.calls.map((c) => c[0]).sort()).toEqual([
      '/p/y',
      '/p/z',
    ]);
  });

  it('only reads the folder a copy landed in', () => {
    const { env, state } = setup();
    applyDropResult(
      env,
      'copy',
      '/p',
      [{ from: '/p/y', to: '/p/z/y' }],
      '/p/z',
    );
    expect(env.refreshDir.mock.calls).toEqual([['/p/z']]);
    expect(env.persistExpanded).not.toHaveBeenCalled();
    expect(state()).toBeNull();
    expect(env.cache.get('/p', '/p/y')).toBeDefined();
  });

  it('does nothing when nothing went through', () => {
    const { env, calls } = setup();
    applyDropResult(env, 'move', '/p', [], '/p/z');
    applyDropResult(env, 'copy', '/p', [], '/p/z');
    expect(calls).toEqual([]);
  });
});

describe('folderEntries', () => {
  const entry = (path: string): TreeEntry => ({
    name: path.split('/').pop() ?? path,
    path,
    is_dir: false,
    children: null,
    volume: 1,
    volume_error: null,
    target_volume: null,
    target_volume_error: null,
  });

  it('uses the listing that was read', async () => {
    const cache = new TreeCache();
    cache.setDir('/p', '/p/d', cache.begin('/p', '/p/d'), {
      entries: [entry('/p/d/a.txt')],
      error: null,
    });
    const list = vi.fn();
    const found = await folderEntries(cache, '/p', '/p/d', list);
    expect(found.map((e) => e.name)).toEqual(['a.txt']);
    expect(list).not.toHaveBeenCalled();
  });

  it('reads a folder that never was, so a name already there is seen', async () => {
    const list = vi.fn(async () => [entry('/p/d/a.txt')]);
    const children = await folderEntries(new TreeCache(), '/p', '/p/d', list);
    expect(list).toHaveBeenCalledWith('/p/d');
    const a = item('/p/a.txt');
    expect(
      dropDecision({
        op: 'move',
        items: [a],
        target: target('/p/d'),
        targetChildren: children,
        caseInsensitive: false,
      }),
    ).toEqual({
      kind: 'partial',
      op: 'move',
      allowed: [],
      rejected: [{ name: 'a.txt', reason: 'sameName' }],
    });
  });

  it('reads again when the listing is marked to be read again', async () => {
    const cache = new TreeCache();
    cache.setDir('/p', '/p/d', cache.begin('/p', '/p/d'), {
      entries: [],
      error: null,
    });
    cache.invalidate('/p', '/p/d');
    const list = vi.fn(async () => [entry('/p/d/a.txt')]);
    const children = await folderEntries(cache, '/p', '/p/d', list);
    expect(list).toHaveBeenCalledWith('/p/d');
    expect(
      dropDecision({
        op: 'move',
        items: [item('/p/a.txt')],
        target: target('/p/d'),
        targetChildren: children,
        caseInsensitive: false,
      }).kind,
    ).toBe('partial');
  });

  it('reads again when the last read failed', async () => {
    const cache = new TreeCache();
    cache.setDir('/p', '/p/d', cache.begin('/p', '/p/d'), {
      entries: [],
      error: 'gone',
    });
    const list = vi.fn(async () => []);
    await folderEntries(cache, '/p', '/p/d', list);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('a batch from start to finish', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((n) => item(`/p/s/${n}.txt`));

  function treeWith(...paths: string[]): TreeCache {
    const cache = new TreeCache();
    for (const dir of ['/p', '/p/s', '/p/d']) {
      cache.setDir('/p', dir, cache.begin('/p', dir), {
        entries: paths.map((path) => ({
          name: path.split('/').pop() ?? path,
          path,
          is_dir: false,
          children: null,
          volume: 1,
          volume_error: null,
          target_volume: null,
          target_volume_error: null,
        })),
        error: null,
      });
    }
    return cache;
  }

  async function run(
    answers: Record<string, unknown>,
    items: DragItem[],
    op: DropOp = 'move',
  ) {
    const invoke: Invoke = (_, args) => {
      const answer = answers[String(args['src'])];
      return typeof answer === 'object' && answer !== null && 'fail' in answer
        ? Promise.reject(answer.fail)
        : Promise.resolve(answer);
    };
    const outcome = await runBatch(op, items, '/p/d', '/p', invoke, tr);
    const refreshed: string[] = [];
    applyDropResult(
      {
        cache: treeWith(),
        expanded: new Set(),
        selected: new Set(),
        setState: () => {},
        touch: () => {},
        persistExpanded: () => {},
        refreshDir: (dir) => refreshed.push(dir),
      },
      op,
      '/p',
      outcome.done,
      '/p/d',
    );
    return { outcome, refreshed, dialogs: outcomeDialogs(op, outcome, tr) };
  }

  it('goes on past a failed second item, names it, and reads the folders again', async () => {
    const { refreshed, dialogs } = await run(
      {
        '/p/s/a.txt': '/p/d/a.txt',
        '/p/s/b.txt': {
          fail: { kind: 'Other', message: 'input/output error' },
        },
        '/p/s/c.txt': '/p/d/c.txt',
      },
      [a, b, c].filter((i): i is DragItem => i !== undefined),
    );
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.message).toBe(
      'workspace.drop.failedOneMove {"name":"b.txt","reason":"input/output error"}',
    );
    expect(refreshed.sort()).toEqual(['/p/d', '/p/s']);
  });

  it('lists several failures one by one', async () => {
    const { dialogs } = await run(
      {
        '/p/s/a.txt': { fail: { kind: 'Other', message: 'denied' } },
        '/p/s/b.txt': { fail: { kind: 'Other', message: 'disk full' } },
        '/p/s/c.txt': { path: '/p/d/c.txt', skipped: [] },
      },
      [a, b, c].filter((i): i is DragItem => i !== undefined),
      'copy',
    );
    expect(dialogs[0]?.message).toBe(
      'workspace.drop.failedManyCopy {"count":2}',
    );
    expect(dialogs[0]?.items).toEqual([
      { label: 'a.txt', detail: 'denied' },
      { label: 'b.txt', detail: 'disk full' },
    ]);
  });

  it('shows the half-done message with every unfinished item when a refusal comes after another failure', async () => {
    const { outcome, dialogs, refreshed } = await run(
      {
        '/p/s/a.txt': '/p/d/a.txt',
        '/p/s/b.txt': { fail: { kind: 'Other', message: 'denied' } },
        '/p/s/c.txt': { fail: { kind: 'SameName' } },
      },
      [a, b, c].filter((i): i is DragItem => i !== undefined),
    );
    expect(outcome.stopped).toBe(true);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.message).toBe(
      'workspace.drop.halfMove {"total":3,"done":1}',
    );
    expect(dialogs[0]?.items.map((i) => i.label)).toEqual(['b.txt', 'c.txt']);
    expect(refreshed.sort()).toEqual(['/p/d', '/p/s']);
  });
});
