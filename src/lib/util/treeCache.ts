// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { TreeEntry, VisibleRow } from './projectTree';
/** One folder's listing, or the error that reading it produced. */
export interface DirListing {
  entries: TreeEntry[];
  error: string | null;
}

interface RootState {
  dirs: Map<string, DirListing>;
  /** Folders whose listing is shown but must be read again. */
  stale: Set<string>;
  /** Folder -> token of the read that may still fill it. */
  reading: Map<string, number>;
}
function fold(path: string, caseInsensitive: boolean): string {
  return caseInsensitive ? path.toLowerCase() : path;
}
/** True when `path` is `dir` or lies below it, matched by whole path segment. A
 *  root (`/`, `C:\`) already ends with its separator. */
export function isInside(
  path: string,
  dir: string,
  caseInsensitive = false,
): boolean {
  const p = fold(path, caseInsensitive);
  const d = fold(dir, caseInsensitive);
  if (p === d) {
    return true;
  }
  if (!p.startsWith(d)) {
    return false;
  }
  const next = p.charAt(d.length);
  return /[\\/]$/.test(d) || next === '/' || next === '\\';
}
/** The folder holding `path`, written with the separator `path` uses. The
 *  parent of a child of a root is the root itself (`/`, `C:\`). */
export function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut < 0) {
    return '';
  }
  const parent = path.slice(0, cut);
  return parent === '' || /^[A-Za-z]:$/.test(parent)
    ? path.slice(0, cut + 1)
    : parent;
}
/** `path` with the folder `from` renamed to `to`; unchanged when it is not
 *  inside `from`. */
export function renamePath(
  path: string,
  from: string,
  to: string,
  caseInsensitive = false,
): string {
  return isInside(path, from, caseInsensitive)
    ? to + path.slice(from.length)
    : path;
}
/** `paths` with `from` renamed to `to` in every path inside it. */
export function renameInSet(
  paths: ReadonlySet<string>,
  from: string,
  to: string,
  caseInsensitive = false,
): Set<string> {
  return new Set(
    [...paths].map((p) => renamePath(p, from, to, caseInsensitive)),
  );
}
/** `paths` without `dir` and everything below it. */
export function withoutSubtree(
  paths: ReadonlySet<string>,
  dir: string,
  caseInsensitive = false,
): Set<string> {
  return new Set([...paths].filter((p) => !isInside(p, dir, caseInsensitive)));
}
/** `expanded` made to agree with the folders `entries` lists directly below
 *  `dir`: an open folder that is gone is dropped (with what is below it). A
 *  folder spelled exactly as listed stays as it is; one that only differs in
 *  case takes the on-disk spelling (with what is below it), unless several
 *  listed folders match, when it is left alone. Returns the same set when
 *  nothing changed. */
export function reconcileExpanded(
  expanded: ReadonlySet<string>,
  dir: string,
  entries: readonly TreeEntry[],
  caseInsensitive = false,
): ReadonlySet<string> {
  const listed = entries.filter((e) => e.is_dir).map((e) => e.path);
  const exact = new Set(listed);
  const parent = fold(dir, caseInsensitive);
  let next: Set<string> | null = null;
  for (const path of expanded) {
    // A root is its own parent, so `dir` itself is not one of its children.
    if (
      fold(path, caseInsensitive) === parent ||
      fold(parentOf(path), caseInsensitive) !== parent ||
      exact.has(path)
    ) {
      continue;
    }
    const like = listed.filter(
      (p) => fold(p, caseInsensitive) === fold(path, caseInsensitive),
    );
    const [actual] = like;
    if (actual === undefined) {
      next = withoutSubtree(next ?? expanded, path, caseInsensitive);
    } else if (like.length === 1) {
      next = renameInSet(next ?? expanded, path, actual, caseInsensitive);
    }
  }
  return next ?? expanded;
}
/** The folder listings of every project, read one level at a time. Plain
 *  mutable state: the owner keeps a reactive counter it bumps after a change. */
export class TreeCache {
  private readonly roots = new Map<string, RootState>();
  private counter = 0;

  private state(root: string): RootState {
    let state = this.roots.get(root);
    if (state === undefined) {
      state = { dirs: new Map(), stale: new Set(), reading: new Map() };
      this.roots.set(root, state);
    }
    return state;
  }

  get(root: string, dir: string): DirListing | undefined {
    return this.roots.get(root)?.dirs.get(dir);
  }
  /** Start reading `dir`. The returned token goes back with the result. */
  begin(root: string, dir: string): number {
    this.counter += 1;
    this.state(root).reading.set(dir, this.counter);
    return this.counter;
  }
  /** Store a read result. False when a newer read of the folder started, or the
   *  folder was dropped, since `token` was handed out: the result is discarded. */
  setDir(
    root: string,
    dir: string,
    token: number,
    listing: DirListing,
  ): boolean {
    const state = this.roots.get(root);
    if (state?.reading.get(dir) !== token) {
      return false;
    }
    state.reading.delete(dir);
    state.stale.delete(dir);
    state.dirs.set(dir, listing);
    return true;
  }
  /** Mark one folder to be read again. Its old listing stays on screen. */
  invalidate(root: string, dir: string): void {
    const state = this.roots.get(root);
    if (state?.dirs.has(dir)) {
      state.stale.add(dir);
    }
  }
  /** Mark every listed folder of a project to be read again. */
  invalidateRoot(root: string): void {
    const state = this.roots.get(root);
    if (state !== undefined) {
      for (const dir of state.dirs.keys()) {
        state.stale.add(dir);
      }
    }
  }
  /** Forget `dir` and everything below it, including reads still running. */
  dropSubtree(root: string, dir: string): void {
    const state = this.roots.get(root);
    if (state === undefined) {
      return;
    }
    for (const key of [...state.dirs.keys()]) {
      if (isInside(key, dir)) {
        state.dirs.delete(key);
        state.stale.delete(key);
      }
    }
    for (const key of [...state.reading.keys()]) {
      if (isInside(key, dir)) {
        state.reading.delete(key);
      }
    }
  }
  /** Forget a whole project. */
  dropRoot(root: string): void {
    this.roots.delete(root);
  }
  /** Keep what was read of the folder `from` and below it, now filed under `to`.
   *  A read still running for the old name is discarded. */
  renameSubtree(root: string, from: string, to: string): void {
    const state = this.roots.get(root);
    if (state === undefined) {
      return;
    }
    const moved: [string, DirListing][] = [];
    const wasStale: string[] = [];
    for (const [key, listing] of [...state.dirs]) {
      if (isInside(key, from)) {
        state.dirs.delete(key);
        if (state.stale.delete(key)) {
          wasStale.push(renamePath(key, from, to));
        }
        moved.push([
          renamePath(key, from, to),
          {
            error: listing.error,
            entries: listing.entries.map((e) => ({
              ...e,
              path: renamePath(e.path, from, to),
            })),
          },
        ]);
      }
    }
    for (const key of [...state.reading.keys()]) {
      if (isInside(key, from)) {
        state.reading.delete(key);
      }
    }
    for (const [key, listing] of moved) {
      state.dirs.set(key, listing);
    }
    for (const key of wasStale) {
      state.stale.add(key);
    }
  }
  /** `expanded` reconciled with every listing of the project that is read and
   *  up to date, walking down through the open folders (see `reconcileExpanded`). */
  reconcile(
    root: string,
    expanded: ReadonlySet<string>,
    caseInsensitive: boolean,
  ): ReadonlySet<string> {
    const state = this.roots.get(root);
    let current = expanded;
    const visit = (dir: string): void => {
      const listing = state?.dirs.get(dir);
      if (
        listing === undefined ||
        listing.error !== null ||
        state?.stale.has(dir) === true ||
        state?.reading.has(dir) === true
      ) {
        return;
      }
      current = reconcileExpanded(
        current,
        dir,
        listing.entries,
        caseInsensitive,
      );
      for (const entry of listing.entries) {
        if (entry.is_dir && current.has(entry.path)) {
          visit(entry.path);
        }
      }
    };
    visit(root);
    return current;
  }
  /** Folders to read now: the project folder, then every open folder reached
   *  through open folders, that has no listing yet or a stale one, and is not
   *  being read already. A folder that is not listed as a folder is not read. */
  dirsToLoad(root: string, expanded: ReadonlySet<string>): string[] {
    const out: string[] = [];
    const state = this.roots.get(root);
    const visit = (dir: string, open: boolean): void => {
      const listing = state?.dirs.get(dir);
      const reading = state?.reading.has(dir) ?? false;
      if (listing === undefined || state?.stale.has(dir) === true) {
        if (!reading) {
          out.push(dir);
        }
      }
      if (listing === undefined || listing.error !== null || !open) {
        return;
      }
      for (const entry of listing.entries) {
        if (entry.is_dir && expanded.has(entry.path)) {
          visit(entry.path, true);
        }
      }
    };
    visit(root, expanded.has(root));
    return out;
  }
  /** The folders of a project that are on screen and already read: open, with
   *  every folder above them up to the root open too. An open folder below a
   *  closed one is not on screen and is left out. */
  shownDirs(root: string, expanded: ReadonlySet<string>): string[] {
    const out: string[] = [];
    const state = this.roots.get(root);
    const visit = (dir: string): void => {
      const listing = state?.dirs.get(dir);
      if (listing === undefined) {
        return;
      }
      out.push(dir);
      if (listing.error !== null) {
        return;
      }
      for (const entry of listing.entries) {
        if (entry.is_dir && expanded.has(entry.path)) {
          visit(entry.path);
        }
      }
    };
    if (expanded.has(root)) {
      visit(root);
    }
    return out;
  }
}
/** The visible rows of one project: its folder row, then, while it is open, the
 *  rows below it. Each folder shows only what has been read of it. */
export function flatten(
  cache: TreeCache,
  root: string,
  name: string,
  expanded: ReadonlySet<string>,
): VisibleRow[] {
  const listing = cache.get(root, root);
  const rootOpen = expanded.has(root);
  const out: VisibleRow[] = [
    {
      name,
      path: root,
      isDir: true,
      depth: 0,
      expanded: rootOpen,
      // A root whose folder failed to load is kept but not expandable.
      expandable: (listing?.error ?? null) === null,
      root: true,
      project: root,
      isError: false,
    },
  ];
  if (!rootOpen || listing === undefined) {
    return out;
  }
  if (listing.error !== null) {
    out.push({
      name: '',
      path: `${root}\u0000error`,
      isDir: false,
      depth: 1,
      expanded: false,
      expandable: false,
      root: false,
      project: root,
      isError: true,
    });
    return out;
  }
  const walk = (entries: readonly TreeEntry[], depth: number): void => {
    for (const entry of entries) {
      const isOpen = entry.is_dir && expanded.has(entry.path);
      out.push({
        name: entry.name,
        path: entry.path,
        isDir: entry.is_dir,
        depth,
        expanded: isOpen,
        expandable: entry.is_dir,
        root: false,
        project: root,
        isError: false,
      });
      if (isOpen) {
        walk(cache.get(root, entry.path)?.entries ?? [], depth + 1);
      }
    }
  };
  walk(listing.entries, 1);
  return out;
}
