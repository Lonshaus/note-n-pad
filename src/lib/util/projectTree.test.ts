// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  createProjectLoader,
  flattenTree,
  type LoadedProject,
  type TreeEntry,
} from './projectTree';

function file(path: string): TreeEntry {
  return {
    name: path.split('/').pop() ?? path,
    path,
    is_dir: false,
    children: null,
  };
}

function dir(path: string, children: TreeEntry[] | null): TreeEntry {
  return { name: path.split('/').pop() ?? path, path, is_dir: true, children };
}

describe('flattenTree', () => {
  it('marks every directory expandable, including unloaded ones', () => {
    const rows = flattenTree(
      [dir('/p/a', null), file('/p/f.txt')],
      new Set(),
      1,
      '/p',
    );
    expect(rows.map((r) => [r.name, r.expandable])).toEqual([
      ['a', true],
      ['f.txt', false],
    ]);
  });

  it('recurses into an expanded directory with depth + 1', () => {
    const tree = [dir('/p/a', [dir('/p/a/b', [file('/p/a/b/x.txt')])])];
    const rows = flattenTree(tree, new Set(['/p/a', '/p/a/b']), 1, '/p');
    expect(rows.map((r) => [r.name, r.depth, r.expanded])).toEqual([
      ['a', 1, true],
      ['b', 2, true],
      ['x.txt', 3, false],
    ]);
    expect(rows.every((r) => r.project === '/p' && !r.root && !r.isError)).toBe(
      true,
    );
  });

  it('adds no child rows for an expanded directory that is not loaded yet', () => {
    const rows = flattenTree([dir('/p/a', null)], new Set(['/p/a']), 1, '/p');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expanded).toBe(true);
  });

  it('hides the loaded children of a collapsed directory', () => {
    const rows = flattenTree(
      [dir('/p/a', [file('/p/a/x.txt')])],
      new Set(),
      1,
      '/p',
    );
    expect(rows.map((r) => r.name)).toEqual(['a']);
    expect(rows[0]?.expanded).toBe(false);
  });
});

function project(root: string, tag = ''): LoadedProject {
  return { root, name: root + tag, tree: [], error: null };
}
/** A list function whose promises the test resolves by hand. */
function fakeList() {
  const pending: { root: string; resolve: () => void }[] = [];
  const list = (root: string) =>
    new Promise<LoadedProject>((resolve) => {
      pending.push({ root, resolve: () => resolve(project(root)) });
    });
  return { list, pending };
}

describe('createProjectLoader', () => {
  it('accepts only the load started last when they resolve in reverse order', async () => {
    const { list, pending } = fakeList();
    let current: LoadedProject[] = [];
    const loader = createProjectLoader(list, (p) => {
      current = p;
    });
    const first = loader.load(['/a'], new Set());
    const second = loader.load(['/a', '/b'], new Set());
    pending[1]?.resolve();
    pending[2]?.resolve();
    await second;
    expect(current.map((p) => p.root)).toEqual(['/a', '/b']);
    pending[0]?.resolve();
    await first;
    expect(current.map((p) => p.root)).toEqual(['/a', '/b']);
  });

  it('drops an older load that resolves after a project was removed', async () => {
    const { list, pending } = fakeList();
    let current: LoadedProject[] = [];
    const loader = createProjectLoader(list, (p) => {
      current = p;
    });
    const l1 = loader.load(['/q', '/r'], new Set());
    const l2 = loader.load(['/q'], new Set());
    pending[2]?.resolve();
    await l2;
    expect(current.map((p) => p.root)).toEqual(['/q']);
    pending[0]?.resolve();
    pending[1]?.resolve();
    await l1;
    expect(current.map((p) => p.root)).toEqual(['/q']);
  });

  it('does not accept a load started before invalidate', async () => {
    const { list, pending } = fakeList();
    let current: LoadedProject[] = [];
    let assigned = 0;
    const loader = createProjectLoader(list, (p) => {
      current = p;
      assigned += 1;
    });
    const l1 = loader.load(['/a'], new Set());
    loader.invalidate();
    pending[0]?.resolve();
    await l1;
    expect(assigned).toBe(0);
    expect(current).toEqual([]);
  });

  it('accepts a load started after invalidate', async () => {
    const { list, pending } = fakeList();
    let current: LoadedProject[] = [];
    const loader = createProjectLoader(list, (p) => {
      current = p;
    });
    loader.invalidate();
    const l = loader.load(['/a'], new Set());
    pending[0]?.resolve();
    await l;
    expect(current.map((p) => p.root)).toEqual(['/a']);
  });

  it('lists a root added while a load is in flight in roots order', async () => {
    const { list, pending } = fakeList();
    let current: LoadedProject[] = [];
    const loader = createProjectLoader(list, (p) => {
      current = p;
    });
    const roots = ['/a'];
    const l1 = loader.load(roots, new Set());
    roots.push('/b');
    const l2 = loader.load(roots, new Set());
    pending.forEach((p) => p.resolve());
    await Promise.all([l1, l2]);
    expect(current.map((p) => p.root)).toEqual(['/a', '/b']);
  });

  it('passes the expanded set to the list function', async () => {
    const seen: ReadonlySet<string>[] = [];
    const loader = createProjectLoader(
      (root, expanded) => {
        seen.push(expanded);
        return Promise.resolve(project(root));
      },
      () => {},
    );
    const expanded = new Set(['/a/x']);
    await loader.load(['/a'], expanded);
    expect(seen).toEqual([expanded]);
  });
});
