// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  addRoot,
  expandedByRoot,
  normalizeRoots,
  pathChain,
  projectExpandedFrom,
  projectRootsFrom,
  reboundProject,
  restoreExpanded,
  revealPaths,
  rootContaining,
} from './projectRoots';
import { withoutSubtree } from './treeCache';

describe('projectRootsFrom', () => {
  it('reads the roots nested under settings', () => {
    const loaded = {
      settings: { project_roots: ['/a', '/b'] },
      repaired_fields: [],
      snapshot_dir_unavailable: false,
    };
    expect(projectRootsFrom(loaded)).toEqual(['/a', '/b']);
  });

  it('returns no roots when none are saved', () => {
    expect(projectRootsFrom({ settings: {} })).toEqual([]);
  });
});

describe('projectExpandedFrom', () => {
  it('reads the saved lists, or none', () => {
    expect(
      projectExpandedFrom({ settings: { project_expanded: { '/a': ['/a'] } } }),
    ).toEqual({ '/a': ['/a'] });
    expect(projectExpandedFrom({ settings: {} })).toEqual({});
  });
});

describe('addRoot', () => {
  it('adds an unrelated folder as a new project', () => {
    const r = addRoot(['/a/x'], '/a/z', false);
    expect(r).toMatchObject({
      roots: ['/a/x', '/a/z'],
      project: '/a/z',
      kind: 'new',
      reveal: [],
      rebinds: [],
    });
  });

  it('leaves the list alone for the same folder', () => {
    const r = addRoot(['/a/x'], '/a/x', false);
    expect(r).toMatchObject({ roots: ['/a/x'], project: '/a/x', kind: 'same' });
    expect(r.reveal).toEqual([]);
    expect(r.rebinds).toEqual([]);
  });

  it('treats a trailing separator as the same folder', () => {
    expect(addRoot(['/a/x'], '/a/x/', false).kind).toBe('same');
  });

  it('does not add a folder inside a project and asks to open down to it', () => {
    const r = addRoot(['/a/x'], '/a/x/y/z', false);
    expect(r).toMatchObject({
      roots: ['/a/x'],
      project: '/a/x',
      kind: 'inside',
      reveal: ['/a/x/y/z'],
      rebinds: [],
    });
  });

  it('folds projects inside the picked folder into it', () => {
    const r = addRoot(['/a/x/y', '/b'], '/a/x', false);
    expect(r).toMatchObject({
      roots: ['/a/x', '/b'],
      project: '/a/x',
      kind: 'merged',
      reveal: ['/a/x/y'],
      rebinds: [{ from: '/a/x/y', to: '/a/x' }],
    });
  });

  it('folds several projects at once, the new one taking the first one place', () => {
    const r = addRoot(['/q', '/a/x/y', '/b', '/a/x/z/w'], '/a/x', false);
    expect(r.roots).toEqual(['/q', '/a/x', '/b']);
    expect(r.reveal).toEqual(['/a/x/y', '/a/x/z/w']);
    expect(r.rebinds).toEqual([
      { from: '/a/x/y', to: '/a/x' },
      { from: '/a/x/z/w', to: '/a/x' },
    ]);
  });

  it('matches whole segments, never a string prefix', () => {
    expect(addRoot(['/a/Tools'], '/a/Tools2', false)).toMatchObject({
      roots: ['/a/Tools', '/a/Tools2'],
      kind: 'new',
    });
    expect(addRoot(['/a/Tools2'], '/a/Tools', false)).toMatchObject({
      roots: ['/a/Tools2', '/a/Tools'],
      kind: 'new',
    });
    expect(addRoot(['/a/Tools'], '/a/Tools2/x', false).kind).toBe('new');
  });

  it('compares case only where the file system ignores it', () => {
    expect(addRoot(['/A/X'], '/a/x/y', true)).toMatchObject({
      roots: ['/A/X'],
      kind: 'inside',
      reveal: ['/A/X/y'],
    });
    expect(addRoot(['/A/X'], '/a/x', true).kind).toBe('same');
    expect(addRoot(['/A/X'], '/a/x/y', false).kind).toBe('new');
  });

  it('handles both separators', () => {
    const r = addRoot(['C:\\Users\\me\\x'], 'C:/Users/me/x/y', true);
    expect(r).toMatchObject({ kind: 'inside', project: 'C:\\Users\\me\\x' });
    expect(r.reveal).toEqual(['C:\\Users\\me\\x\\y']);
    const merged = addRoot(['C:\\Users\\me\\x\\y'], 'c:\\users\\me\\x', true);
    expect(merged.kind).toBe('merged');
    expect(merged.reveal).toEqual(['c:\\users\\me\\x\\y']);
    expect(merged.rebinds).toEqual([
      { from: 'C:\\Users\\me\\x\\y', to: 'c:\\users\\me\\x' },
    ]);
  });
});

describe('normalizeRoots', () => {
  it('keeps a list with no overlap as it is', () => {
    const n = normalizeRoots(['/a', '/b'], false);
    expect(n).toEqual({ roots: ['/a', '/b'], rebinds: [], reveal: [] });
  });

  it('folds a nested list, whichever order it was saved in', () => {
    const inner = normalizeRoots(['/a/x/y', '/a/x'], false);
    expect(inner.roots).toEqual(['/a/x']);
    expect(inner.rebinds).toEqual([{ from: '/a/x/y', to: '/a/x' }]);
    expect(inner.reveal).toEqual([{ project: '/a/x', paths: ['/a/x/y'] }]);
    const outer = normalizeRoots(['/a/x', '/a/x/y'], false);
    expect(outer.roots).toEqual(['/a/x']);
    expect(outer.rebinds).toEqual([{ from: '/a/x/y', to: '/a/x' }]);
    expect(outer.reveal).toEqual([{ project: '/a/x', paths: ['/a/x/y'] }]);
  });

  it('folds three levels into the outermost and drops duplicates', () => {
    const n = normalizeRoots(['/a/x/y/z', '/a/x/y', '/q', '/a/x', '/q'], false);
    expect(n.roots).toEqual(['/a/x', '/q']);
    expect(n.rebinds).toEqual([
      { from: '/a/x/y/z', to: '/a/x/y' },
      { from: '/a/x/y', to: '/a/x' },
    ]);
  });
});

describe('expanded state', () => {
  it('opens a project that has no saved list and keeps the others as saved', () => {
    const set = restoreExpanded(
      ['/a', '/b', '/c'],
      { '/a': ['/a', '/a/s'], '/b': [] },
      [],
      false,
    );
    expect([...set].sort()).toEqual(['/a', '/a/s', '/c']);
  });

  it('keeps the saved folders of a folded project and opens down to it', () => {
    const merged = normalizeRoots(['/a/x/y', '/a/x'], false);
    const set = restoreExpanded(
      merged.roots,
      { '/a/x/y': ['/a/x/y', '/a/x/y/q'], '/a/x': ['/a/x/m'] },
      merged.reveal,
      false,
    );
    expect([...set].sort()).toEqual(['/a/x', '/a/x/m', '/a/x/y', '/a/x/y/q']);
  });

  it('opens the whole way down to a revealed folder', () => {
    const set = revealPaths(new Set(['/o']), '/a/x', ['/a/x/p/q'], false);
    expect([...set].sort()).toEqual(['/a/x', '/a/x/p', '/a/x/p/q', '/o']);
  });

  it('lists the way down from a project to a folder', () => {
    expect(pathChain('/a/x', '/a/x/p/q', false)).toEqual([
      '/a/x',
      '/a/x/p',
      '/a/x/p/q',
    ]);
    expect(pathChain('/a/x', '/a/x', false)).toEqual(['/a/x']);
    expect(pathChain('/a/x', '/a/xy/p', false)).toEqual([]);
  });

  it('saves each project its own folders, and none for a removed project', () => {
    const expanded = new Set(['/a', '/a/s', '/b', '/b/t', '/b2']);
    expect(expandedByRoot(['/a', '/b'], expanded, false)).toEqual({
      '/a': ['/a', '/a/s'],
      '/b': ['/b', '/b/t'],
    });
    // Removing the project clears its folders, and only its own.
    const after = withoutSubtree(expanded, '/b');
    expect(expandedByRoot(['/a'], after, false)).toEqual({
      '/a': ['/a', '/a/s'],
    });
    expect([...after].sort()).toEqual(['/a', '/a/s', '/b2']);
  });

  it('saves an empty list for a collapsed project', () => {
    expect(expandedByRoot(['/a'], new Set(), false)).toEqual({ '/a': [] });
  });
});

describe('rootContaining', () => {
  it('finds the project that holds a path, by whole segment', () => {
    const roots = ['/a/Tools', '/a/Tools2'];
    expect(rootContaining(roots, '/a/Tools2/x', false)).toBe('/a/Tools2');
    expect(rootContaining(roots, '/a/Tools/x', false)).toBe('/a/Tools');
    expect(rootContaining(roots, '/a/Tools3/x', false)).toBeNull();
    expect(rootContaining(roots, '/A/TOOLS', true)).toBe('/a/Tools');
  });
});

describe('reboundProject', () => {
  it('moves only a window bound to the folded project', () => {
    expect(reboundProject('/a/x/y', '/a/x/y', '/a/x')).toBe('/a/x');
    expect(reboundProject('/a/x/z', '/a/x/y', '/a/x')).toBe('/a/x/z');
    expect(reboundProject(null, '/a/x/y', '/a/x')).toBeNull();
  });
});

describe('project roots at a drive or at /', () => {
  it('keeps the separator of a drive root, whichever one it uses', () => {
    expect(addRoot([], 'C:\\', true)).toMatchObject({
      roots: ['C:\\'],
      project: 'C:\\',
      kind: 'new',
    });
    expect(addRoot([], 'e:/', true).project).toBe('e:/');
    expect(normalizeRoots(['E:\\'], true).roots).toEqual(['E:\\']);
    expect(normalizeRoots(['E:/'], true).roots).toEqual(['E:/']);
  });

  it('keeps / as a project', () => {
    expect(addRoot([], '/', false)).toMatchObject({
      roots: ['/'],
      project: '/',
      kind: 'new',
    });
    expect(addRoot(['/'], '/', false).kind).toBe('same');
  });

  it('puts a child under a drive root at C:\\name', () => {
    const r = addRoot(['C:\\'], 'C:\\Users\\me', true);
    expect(r).toMatchObject({ kind: 'inside', project: 'C:\\' });
    expect(r.reveal).toEqual(['C:\\Users\\me']);
    const slash = addRoot(['C:/'], 'c:/Users', true);
    expect(slash.reveal).toEqual(['C:/Users']);
    expect(addRoot(['/'], '/etc/hosts', false).reveal).toEqual(['/etc/hosts']);
  });

  it('folds projects into a drive root or / when it is added', () => {
    const drive = addRoot(['C:\\Users', 'D:\\x'], 'C:\\', true);
    expect(drive.roots).toEqual(['C:\\', 'D:\\x']);
    expect(drive.reveal).toEqual(['C:\\Users']);
    expect(drive.rebinds).toEqual([{ from: 'C:\\Users', to: 'C:\\' }]);
    const posix = addRoot(['/a', '/b'], '/', false);
    expect(posix.roots).toEqual(['/']);
    expect(posix.reveal).toEqual(['/a', '/b']);
  });

  it('lists the way down from a root, the root keeping its separator', () => {
    expect(pathChain('C:\\', 'C:\\Users\\me', true)).toEqual([
      'C:\\',
      'C:\\Users',
      'C:\\Users\\me',
    ]);
    expect(pathChain('/', '/etc/x', false)).toEqual(['/', '/etc', '/etc/x']);
    expect(pathChain('C:\\', 'D:\\x', true)).toEqual([]);
  });

  it('finds the project and splits the expanded set at a root', () => {
    expect(rootContaining(['C:\\', 'D:\\'], 'D:\\x\\y', true)).toBe('D:\\');
    expect(rootContaining(['/'], '/etc', false)).toBe('/');
    expect(
      expandedByRoot(['C:\\'], new Set(['C:\\', 'C:\\Users']), true),
    ).toEqual({ 'C:\\': ['C:\\', 'C:\\Users'] });
  });

  it('opens the way down below a root', () => {
    const set = revealPaths(new Set(), 'C:\\', ['C:\\Users\\me'], true);
    expect([...set].sort()).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\me']);
  });
});

describe('reveal paths and case', () => {
  it('names the root part as stored and the rest as picked', () => {
    const r = addRoot(['/x'], '/X/Y', true);
    expect(r.kind).toBe('inside');
    expect(r.reveal).toEqual(['/x/Y']);
    const merged = addRoot(['/X/Y/Z'], '/x', true);
    expect(merged.project).toBe('/x');
    expect(merged.reveal).toEqual(['/x/Y/Z']);
  });

  it('opens the stored root and the folders below it for such a reveal', () => {
    const set = revealPaths(new Set(), '/x', ['/x/Y'], true);
    expect([...set].sort()).toEqual(['/x', '/x/Y']);
  });
});
