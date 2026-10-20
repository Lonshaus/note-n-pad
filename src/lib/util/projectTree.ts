// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** One node returned by `list_project_dir` (Rust `TreeEntry`). `children` is
 *  always null: a folder's entries come from its own listing. */
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
