// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { TreeEntry } from './projectTree';
import {
  flatten,
  isInside,
  parentOf,
  reconcileExpanded,
  renameInSet,
  renamePath,
  TreeCache,
  withoutSubtree,
  type DirListing,
} from './treeCache';

function entry(path: string, isDir: boolean): TreeEntry {
  return {
    name: path.split('/').pop() ?? path,
    path,
    is_dir: isDir,
    children: null,
    volume: 1,
    volume_error: null,
    target_volume: null,
    target_volume_error: null,
  };
}

function listing(...entries: TreeEntry[]): DirListing {
  return { entries, error: null };
}
/** Store a listing the way a finished read does. */
function put(cache: TreeCache, root: string, dir: string, l: DirListing): void {
  expect(cache.setDir(root, dir, cache.begin(root, dir), l)).toBe(true);
}

describe('flatten', () => {
  it('shows only what has been read, one level per open folder', () => {
    const cache = new TreeCache();
    put(
      cache,
      '/p',
      '/p',
      listing(entry('/p/a', true), entry('/p/f.txt', false)),
    );
    const rows = flatten(cache, '/p', 'p', new Set(['/p', '/p/a']));
    // `a` is open but not read yet, so it adds no child rows.
    expect(rows.map((r) => [r.name, r.depth, r.expanded])).toEqual([
      ['p', 0, true],
      ['a', 1, true],
      ['f.txt', 1, false],
    ]);
    put(cache, '/p', '/p/a', listing(entry('/p/a/x.txt', false)));
    const more = flatten(cache, '/p', 'p', new Set(['/p', '/p/a']));
    expect(more.map((r) => [r.name, r.depth])).toEqual([
      ['p', 0],
      ['a', 1],
      ['x.txt', 2],
      ['f.txt', 1],
    ]);
    expect(more.every((r) => r.project === '/p')).toBe(true);
    expect(more[0]?.root).toBe(true);
    expect(more.slice(1).every((r) => !r.root && !r.isError)).toBe(true);
  });

  it('marks every folder expandable, read or not, and hides collapsed content', () => {
    const cache = new TreeCache();
    put(
      cache,
      '/p',
      '/p',
      listing(entry('/p/a', true), entry('/p/f.txt', false)),
    );
    put(cache, '/p', '/p/a', listing(entry('/p/a/x.txt', false)));
    const rows = flatten(cache, '/p', 'p', new Set(['/p']));
    expect(rows.map((r) => [r.name, r.expandable, r.expanded])).toEqual([
      ['p', true, true],
      ['a', true, false],
      ['f.txt', false, false],
    ]);
  });

  it('gives every row of several projects a unique path', () => {
    const cache = new TreeCache();
    put(cache, '/a/x', '/a/x', listing(entry('/a/x/y', true)));
    put(cache, '/a/x', '/a/x/y', listing(entry('/a/x/y/f.txt', false)));
    put(cache, '/a/Tools', '/a/Tools', listing(entry('/a/Tools/f.txt', false)));
    put(
      cache,
      '/a/Tools2',
      '/a/Tools2',
      listing(entry('/a/Tools2/f.txt', false)),
    );
    cache.setDir('/gone', '/gone', cache.begin('/gone', '/gone'), {
      entries: [],
      error: 'not a directory',
    });
    const expanded = new Set([
      '/a/x',
      '/a/x/y',
      '/a/Tools',
      '/a/Tools2',
      '/gone',
    ]);
    const rows = ['/a/x', '/a/Tools', '/a/Tools2', '/gone'].flatMap((root) =>
      flatten(cache, root, root, expanded),
    );
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.path)).size).toBe(rows.length);
  });

  it('keeps a root that failed to load, with one muted error row', () => {
    const cache = new TreeCache();
    cache.setDir('/p', '/p', cache.begin('/p', '/p'), {
      entries: [],
      error: 'not a directory: /p',
    });
    const rows = flatten(cache, '/p', 'p', new Set(['/p']));
    expect(rows.map((r) => [r.root, r.isError, r.expandable])).toEqual([
      [true, false, false],
      [false, true, false],
    ]);
    expect(flatten(cache, '/p', 'p', new Set())).toHaveLength(1);
  });

  it('shows the root closed and expandable until its folder is read', () => {
    const rows = flatten(new TreeCache(), '/p', 'p', new Set(['/p']));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expandable).toBe(true);
  });
});

describe('generations', () => {
  it('discards a read that finishes after a newer read of the same folder', () => {
    const cache = new TreeCache();
    const first = cache.begin('/p', '/p');
    const second = cache.begin('/p', '/p');
    expect(
      cache.setDir('/p', '/p', second, listing(entry('/p/new', false))),
    ).toBe(true);
    expect(
      cache.setDir('/p', '/p', first, listing(entry('/p/old', false))),
    ).toBe(false);
    expect(cache.get('/p', '/p')?.entries.map((e) => e.name)).toEqual(['new']);
  });

  it('discards an older read that finishes first', () => {
    const cache = new TreeCache();
    const first = cache.begin('/p', '/p');
    const second = cache.begin('/p', '/p');
    expect(
      cache.setDir('/p', '/p', first, listing(entry('/p/old', false))),
    ).toBe(false);
    expect(cache.get('/p', '/p')).toBeUndefined();
    expect(
      cache.setDir('/p', '/p', second, listing(entry('/p/new', false))),
    ).toBe(true);
  });

  it('keeps generations of different folders apart', () => {
    const cache = new TreeCache();
    const a = cache.begin('/p', '/p/a');
    const b = cache.begin('/p', '/p/b');
    expect(cache.setDir('/p', '/p/b', b, listing())).toBe(true);
    expect(cache.setDir('/p', '/p/a', a, listing())).toBe(true);
  });

  it('rejects a read that was running when its folder was dropped', () => {
    const cache = new TreeCache();
    put(cache, '/p', '/p', listing(entry('/p/a', true)));
    const token = cache.begin('/p', '/p/a');
    cache.dropSubtree('/p', '/p/a');
    expect(cache.setDir('/p', '/p/a', token, listing())).toBe(false);
    expect(cache.get('/p', '/p/a')).toBeUndefined();
  });

  it('rejects a read that was running when its project was removed', () => {
    const cache = new TreeCache();
    const token = cache.begin('/p', '/p');
    cache.dropRoot('/p');
    expect(cache.setDir('/p', '/p', token, listing())).toBe(false);
    expect(cache.get('/p', '/p')).toBeUndefined();
  });
});

describe('dirsToLoad', () => {
  it('asks for one read per folder, however often it is asked', () => {
    const cache = new TreeCache();
    const expanded = new Set(['/p']);
    expect(cache.dirsToLoad('/p', expanded)).toEqual(['/p']);
    const token = cache.begin('/p', '/p');
    // Running reads are not asked for again.
    expect(cache.dirsToLoad('/p', expanded)).toEqual([]);
    cache.setDir(
      '/p',
      '/p',
      token,
      listing(entry('/p/a', true), entry('/p/b', true)),
    );
    expect(cache.dirsToLoad('/p', expanded)).toEqual([]);
    // Expanding a folder asks for exactly that folder.
    expanded.add('/p/a');
    expect(cache.dirsToLoad('/p', expanded)).toEqual(['/p/a']);
    const a = cache.begin('/p', '/p/a');
    expect(cache.dirsToLoad('/p', expanded)).toEqual([]);
    cache.setDir('/p', '/p/a', a, listing());
    // Collapsing and opening it again reads nothing: the listing is kept.
    expanded.delete('/p/a');
    expect(cache.dirsToLoad('/p', expanded)).toEqual([]);
    expanded.add('/p/a');
    expect(cache.dirsToLoad('/p', expanded)).toEqual([]);
  });

  it('reads the project folder even while it is collapsed, but nothing below', () => {
    const cache = new TreeCache();
    const expanded = new Set(['/p/a']);
    expect(cache.dirsToLoad('/p', expanded)).toEqual(['/p']);
    put(cache, '/p', '/p', listing(entry('/p/a', true)));
    expect(cache.dirsToLoad('/p', expanded)).toEqual([]);
  });

  it('follows a restored expanded set level by level and skips folders that are gone', () => {
    const cache = new TreeCache();
    const expanded = new Set(['/p', '/p/a', '/p/a/b', '/p/gone', '/p/gone/c']);
    put(cache, '/p', '/p', listing(entry('/p/a', true)));
    expect(cache.dirsToLoad('/p', expanded)).toEqual(['/p/a']);
    put(cache, '/p', '/p/a', listing(entry('/p/a/b', true)));
    expect(cache.dirsToLoad('/p', expanded)).toEqual(['/p/a/b']);
    put(cache, '/p', '/p/a/b', listing());
    expect(cache.dirsToLoad('/p', expanded)).toEqual([]);
  });

  it('does not read below a folder that failed to load', () => {
    const cache = new TreeCache();
    put(cache, '/p', '/p', listing(entry('/p/a', true)));
    cache.setDir('/p', '/p/a', cache.begin('/p', '/p/a'), {
      entries: [],
      error: 'denied',
    });
    expect(cache.dirsToLoad('/p', new Set(['/p', '/p/a']))).toEqual([]);
  });

  it('asks again only for an invalidated folder, keeping its listing meanwhile', () => {
    const cache = new TreeCache();
    const expanded = new Set(['/p', '/p/a']);
    put(cache, '/p', '/p', listing(entry('/p/a', true), entry('/p/b', true)));
    put(cache, '/p', '/p/a', listing(entry('/p/a/x', false)));
    cache.invalidate('/p', '/p/a');
    expect(cache.dirsToLoad('/p', expanded)).toEqual(['/p/a']);
    expect(cache.get('/p', '/p/a')?.entries).toHaveLength(1);
    put(cache, '/p', '/p/a', listing());
    expect(cache.dirsToLoad('/p', expanded)).toEqual([]);
    cache.invalidateRoot('/p');
    expect(cache.dirsToLoad('/p', expanded)).toEqual(['/p', '/p/a']);
  });
});

describe('shownDirs', () => {
  function tree(): TreeCache {
    const cache = new TreeCache();
    put(cache, '/p', '/p', listing(entry('/p/x', true), entry('/p/z', true)));
    put(cache, '/p', '/p/x', listing(entry('/p/x/y', true)));
    put(cache, '/p', '/p/x/y', listing(entry('/p/x/y/f.txt', false)));
    put(cache, '/p', '/p/z', listing(entry('/p/z/f.txt', false)));
    return cache;
  }

  it('lists the open, read folders from the root down', () => {
    const open = new Set(['/p', '/p/x', '/p/x/y']);
    expect(tree().shownDirs('/p', open)).toEqual(['/p', '/p/x', '/p/x/y']);
  });

  it('leaves out an open folder under a closed one', () => {
    // x is closed while y, below it, is still remembered as open.
    const open = new Set(['/p', '/p/x/y', '/p/z']);
    expect(tree().shownDirs('/p', open)).toEqual(['/p', '/p/z']);
  });

  it('lists nothing of a closed project', () => {
    expect(tree().shownDirs('/p', new Set(['/p/x']))).toEqual([]);
  });

  it('leaves out an open folder that was never read, and what is below it', () => {
    const cache = new TreeCache();
    put(cache, '/p', '/p', listing(entry('/p/x', true)));
    const open = new Set(['/p', '/p/x', '/p/x/y']);
    expect(cache.shownDirs('/p', open)).toEqual(['/p']);
  });

  it('stops at a folder that could not be read', () => {
    const cache = new TreeCache();
    put(cache, '/p', '/p', { entries: [entry('/p/sub', true)], error: 'gone' });
    put(cache, '/p', '/p/sub', listing());
    expect(cache.shownDirs('/p', new Set(['/p', '/p/sub']))).toEqual(['/p']);
  });
});

describe('dropSubtree and renameSubtree', () => {
  it('drops a folder and what is below it, not a sibling with the same prefix', () => {
    const cache = new TreeCache();
    put(cache, '/p', '/p/Tools', listing());
    put(cache, '/p', '/p/Tools/sub', listing());
    put(cache, '/p', '/p/Tools2', listing());
    cache.dropSubtree('/p', '/p/Tools');
    expect(cache.get('/p', '/p/Tools')).toBeUndefined();
    expect(cache.get('/p', '/p/Tools/sub')).toBeUndefined();
    expect(cache.get('/p', '/p/Tools2')).toBeDefined();
  });

  it('files a renamed folder and its listings under the new name', () => {
    const cache = new TreeCache();
    put(
      cache,
      '/p',
      '/p/Tools',
      listing(entry('/p/Tools/sub', true), entry('/p/Tools/f.txt', false)),
    );
    put(
      cache,
      '/p',
      '/p/Tools/sub',
      listing(entry('/p/Tools/sub/g.txt', false)),
    );
    put(cache, '/p', '/p/Tools2', listing(entry('/p/Tools2/h.txt', false)));
    cache.renameSubtree('/p', '/p/Tools', '/p/Utils');
    expect(cache.get('/p', '/p/Tools')).toBeUndefined();
    expect(cache.get('/p', '/p/Tools/sub')).toBeUndefined();
    expect(cache.get('/p', '/p/Utils')?.entries.map((e) => e.path)).toEqual([
      '/p/Utils/sub',
      '/p/Utils/f.txt',
    ]);
    expect(cache.get('/p', '/p/Utils/sub')?.entries.map((e) => e.path)).toEqual(
      ['/p/Utils/sub/g.txt'],
    );
    // A sibling whose name only starts the same is left alone.
    expect(cache.get('/p', '/p/Tools2')?.entries.map((e) => e.path)).toEqual([
      '/p/Tools2/h.txt',
    ]);
  });

  it('rejects a read that was running under the old name', () => {
    const cache = new TreeCache();
    put(cache, '/p', '/p/a', listing());
    const token = cache.begin('/p', '/p/a');
    cache.renameSubtree('/p', '/p/a', '/p/b');
    expect(cache.setDir('/p', '/p/a', token, listing())).toBe(false);
  });
});

describe('path helpers', () => {
  it('matches whole segments only', () => {
    expect(isInside('/a/Tools', '/a/Tools')).toBe(true);
    expect(isInside('/a/Tools/x', '/a/Tools')).toBe(true);
    expect(isInside('C:\\a\\Tools\\x', 'C:\\a\\Tools')).toBe(true);
    expect(isInside('/a/Tools2', '/a/Tools')).toBe(false);
    expect(isInside('/a/Tool', '/a/Tools')).toBe(false);
  });

  it('renames a prefix at a segment boundary', () => {
    expect(renamePath('/a/Tools/x', '/a/Tools', '/a/Bin')).toBe('/a/Bin/x');
    expect(renamePath('/a/Tools2/x', '/a/Tools', '/a/Bin')).toBe('/a/Tools2/x');
    const renamed = renameInSet(
      new Set(['/a/Tools', '/a/Tools/s', '/a/Tools2']),
      '/a/Tools',
      '/a/Bin',
    );
    expect([...renamed].sort()).toEqual(['/a/Bin', '/a/Bin/s', '/a/Tools2']);
  });

  it('removes a subtree from a set without touching a look-alike sibling', () => {
    const rest = withoutSubtree(
      new Set(['/a/Tools', '/a/Tools/s', '/a/Tools2']),
      '/a/Tools',
    );
    expect([...rest]).toEqual(['/a/Tools2']);
  });

  it('finds the parent with the path own separator', () => {
    expect(parentOf('/a/b/c.txt')).toBe('/a/b');
    expect(parentOf('C:\\a\\b')).toBe('C:\\a');
  });

  it('drops open folders that are no longer listed as folders', () => {
    const open = new Set([
      '/p',
      '/p/a',
      '/p/a/deep',
      '/p/gone',
      '/p/gone/deep',
      '/p/file',
    ]);
    const kept = reconcileExpanded(open, '/p', [
      entry('/p/a', true),
      entry('/p/file', false),
    ]);
    expect([...kept].sort()).toEqual(['/p', '/p/a', '/p/a/deep']);
    // Nothing to drop: the same set comes back.
    expect(reconcileExpanded(kept, '/p', [entry('/p/a', true)])).toBe(kept);
  });
});

describe('roots', () => {
  it('finds the parent of a child of a root as the root itself', () => {
    expect(parentOf('/etc')).toBe('/');
    expect(parentOf('C:\\Users')).toBe('C:\\');
    expect(parentOf('c:/Users')).toBe('c:/');
    expect(parentOf('C:\\Users\\me')).toBe('C:\\Users');
    expect(parentOf('/a/b')).toBe('/a');
  });

  it('holds everything below a root, by whole segment', () => {
    expect(isInside('/etc', '/')).toBe(true);
    expect(isInside('/', '/')).toBe(true);
    expect(isInside('C:\\Users\\me', 'C:\\')).toBe(true);
    expect(isInside('C:\\', 'C:\\')).toBe(true);
    expect(isInside('c:/Users', 'C:/', true)).toBe(true);
    expect(isInside('D:\\Users', 'C:\\')).toBe(false);
    expect(isInside('C:Users', 'C:\\')).toBe(false);
  });

  it('reads the children of a root as open folders of it', () => {
    const open = new Set(['C:\\', 'C:\\Users', 'C:\\Gone']);
    const kept = reconcileExpanded(open, 'C:\\', [entry('C:\\Users', true)]);
    expect([...kept].sort()).toEqual(['C:\\', 'C:\\Users']);
    const posix = reconcileExpanded(new Set(['/', '/etc', '/gone']), '/', [
      entry('/etc', true),
    ]);
    expect([...posix].sort()).toEqual(['/', '/etc']);
  });

  it('drops and renames below a root without losing its separator', () => {
    expect(
      [...withoutSubtree(new Set(['/', '/a', '/b']), '/a')].sort(),
    ).toEqual(['/', '/b']);
    expect(renamePath('C:\\a\\x', 'C:\\a', 'C:\\b')).toBe('C:\\b\\x');
  });

  it('lists a project at a root with its children as rows', () => {
    const cache = new TreeCache();
    put(cache, 'C:\\', 'C:\\', listing(entry('C:\\Users', true)));
    const rows = flatten(cache, 'C:\\', 'C:', new Set(['C:\\']));
    expect(rows.map((r) => r.path)).toEqual(['C:\\', 'C:\\Users']);
  });
});

describe('case-insensitive open folders', () => {
  it('renames an open folder to the on-disk spelling, with what is below it', () => {
    const open = new Set(['/p', '/p/Y', '/p/Y/Deep', '/p/other']);
    const kept = reconcileExpanded(
      open,
      '/p',
      [entry('/p/y', true), entry('/p/other', true)],
      true,
    );
    expect([...kept].sort()).toEqual(['/p', '/p/other', '/p/y', '/p/y/Deep']);
    // Where case counts, the differently spelled folder is a missing one.
    const exact = reconcileExpanded(
      open,
      '/p',
      [entry('/p/y', true), entry('/p/other', true)],
      false,
    );
    expect([...exact].sort()).toEqual(['/p', '/p/other']);
  });

  it('settles a whole revealed chain level by level as folders are read', () => {
    const cache = new TreeCache();
    put(cache, '/p', '/p', listing(entry('/p/a', true)));
    put(cache, '/p', '/p/a', listing(entry('/p/a/b', true)));
    const open = new Set(['/p', '/p/A', '/p/A/B']);
    const kept = cache.reconcile('/p', open, true);
    expect([...kept].sort()).toEqual(['/p', '/p/a', '/p/a/b']);
    // The rows then show both folders open.
    const rows = flatten(cache, '/p', 'p', kept);
    expect(rows.map((r) => [r.path, r.expanded])).toEqual([
      ['/p', true],
      ['/p/a', true],
      ['/p/a/b', true],
    ]);
  });

  it('leaves folders alone that are being read again or are stale', () => {
    const cache = new TreeCache();
    put(cache, '/p', '/p', listing(entry('/p/a', true)));
    cache.invalidate('/p', '/p');
    const open = new Set(['/p', '/p/renamed']);
    expect(cache.reconcile('/p', open, true)).toBe(open);
  });
});

describe('case-variant sibling folders', () => {
  const siblings = [entry('/r/Foo', true), entry('/r/foo', true)];

  it('keeps each of two siblings open when both are', () => {
    const open = new Set(['/r', '/r/Foo', '/r/Foo/a', '/r/foo']);
    expect(reconcileExpanded(open, '/r', siblings, true)).toBe(open);
    expect(reconcileExpanded(open, '/r', [...siblings].reverse(), true)).toBe(
      open,
    );
  });

  it('keeps one sibling open without renaming it to the other', () => {
    const upper = new Set(['/r', '/r/Foo']);
    expect(reconcileExpanded(upper, '/r', siblings, true)).toBe(upper);
    const lower = new Set(['/r', '/r/foo']);
    expect(reconcileExpanded(lower, '/r', siblings, true)).toBe(lower);
  });

  it('prefers the exact spelling over a spelling that differs in case', () => {
    const open = new Set(['/r', '/r/foo']);
    const listed = [entry('/r/Foo', true), entry('/r/foo', true)];
    expect(reconcileExpanded(open, '/r', listed, true)).toBe(open);
  });

  it('leaves a spelling alone that several listed folders match', () => {
    const open = new Set(['/r', '/r/FOO', '/r/FOO/x']);
    expect(reconcileExpanded(open, '/r', siblings, true)).toBe(open);
  });

  it('still renames a spelling that exactly one listed folder matches', () => {
    const open = new Set(['/r', '/r/FOO', '/r/FOO/x']);
    const kept = reconcileExpanded(open, '/r', [entry('/r/Foo', true)], true);
    expect([...kept].sort()).toEqual(['/r', '/r/Foo', '/r/Foo/x']);
  });

  it('drops a spelling whose on-disk spelling is already open', () => {
    const open = new Set(['/r', '/r/Foo', '/r/Foo/a', '/r/foo']);
    const kept = reconcileExpanded(open, '/r', [entry('/r/foo', true)], true);
    expect([...kept].sort()).toEqual(['/r', '/r/foo']);
  });

  it('keeps what is open below the on-disk spelling that stays', () => {
    const open = new Set(['/r', '/r/Foo', '/r/Foo/a', '/r/foo', '/r/foo/b']);
    const kept = reconcileExpanded(open, '/r', [entry('/r/foo', true)], true);
    expect([...kept].sort()).toEqual(['/r', '/r/foo', '/r/foo/b']);
  });

  it('still renames when the on-disk spelling is not open', () => {
    const open = new Set(['/r', '/r/Foo', '/r/Foo/a']);
    const kept = reconcileExpanded(open, '/r', [entry('/r/foo', true)], true);
    expect([...kept].sort()).toEqual(['/r', '/r/foo', '/r/foo/a']);
  });

  it('keeps both open in a project walk', () => {
    const cache = new TreeCache();
    put(cache, '/r', '/r', listing(...siblings));
    put(cache, '/r', '/r/Foo', listing(entry('/r/Foo/a', true)));
    const open = new Set(['/r', '/r/Foo', '/r/foo', '/r/Foo/a']);
    expect(cache.reconcile('/r', open, true)).toBe(open);
  });
});
