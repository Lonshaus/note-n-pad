// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** One node returned by `list_project_tree` (Rust `TreeEntry`). */
export interface TreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeEntry[] | null;
}
/** A flattened, currently-visible tree row for rendering and automation. A
 *  `root` row is a project's top-level folder node; `project` is the root path
 *  the row belongs to; an `isError` row is the muted load-failure placeholder. */
export interface VisibleRow {
  name: string;
  path: string;
  isDir: boolean;
  depth: number;
  expanded: boolean;
  expandable: boolean;
  root: boolean;
  project: string;
  isError: boolean;
}
/** One project's loaded tree (or the error that loading it produced). */
export interface LoadedProject {
  root: string;
  name: string;
  tree: TreeEntry[];
  error: string | null;
}
/** Flatten loaded entries into visible rows. Every directory is expandable; an
 *  expanded directory recurses only once its children have been loaded. */
export function flattenTree(
  entries: TreeEntry[],
  expanded: ReadonlySet<string>,
  depth: number,
  project: string,
): VisibleRow[] {
  const out: VisibleRow[] = [];
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
      project,
      isError: false,
    });
    if (isOpen && entry.children !== null) {
      out.push(...flattenTree(entry.children, expanded, depth + 1, project));
    }
  }
  return out;
}

export interface ProjectLoader {
  /** Load every root; the result is assigned only if no newer load or
   *  invalidation happened meanwhile. */
  load: (
    roots: readonly string[],
    expanded: ReadonlySet<string>,
  ) => Promise<void>;
  /** Drop every load that is still in flight. */
  invalidate: () => void;
}
/** Window-wide tree loader. Each `load` takes the next generation; a result from
 *  an older generation is discarded so a slow earlier load never overwrites a
 *  newer one or brings back a removed or cleared project. */
export function createProjectLoader(
  list: (root: string, expanded: ReadonlySet<string>) => Promise<LoadedProject>,
  assign: (projects: LoadedProject[]) => void,
): ProjectLoader {
  let generation = 0;
  return {
    async load(roots, expanded) {
      generation += 1;
      const mine = generation;
      const loaded = await Promise.all(roots.map((r) => list(r, expanded)));
      if (mine === generation) {
        assign(loaded);
      }
    },
    invalidate() {
      generation += 1;
    },
  };
}
