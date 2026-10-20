// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** The disk something is on: its identifier, or why that could not be read. */
export interface VolumeInfo {
  volume: number | null;
  volumeError: string | null;
}
/** One node returned by `list_project_dir` (Rust `TreeEntry`). `children` is
 *  always null: a folder's entries come from its own listing. `volume` is the
 *  disk the entry itself is on (a link reports its own); null with a
 *  `volume_error` when that could not be read. A folder's `target_volume` is the
 *  disk it leads to (a disk mounted on it, or the folder a link points to); a
 *  file has none. */
export interface TreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeEntry[] | null;
  volume: number | null;
  volume_error: string | null;
  target_volume: number | null;
  target_volume_error: string | null;
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
