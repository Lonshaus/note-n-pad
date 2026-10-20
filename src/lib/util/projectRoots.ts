// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** The part of the `load_settings` reply the workspace needs. The roots sit
 *  under `settings`, not at the top level of the reply. */
export interface LoadedProjectRoots {
  settings: {
    project_roots?: string[];
    project_expanded?: Record<string, string[]>;
  };
}
/** The saved project roots from a `load_settings` reply, or none. */
export function projectRootsFrom(loaded: LoadedProjectRoots): string[] {
  return loaded.settings.project_roots ?? [];
}
/** The saved expanded folders per project root from a `load_settings` reply. */
export function projectExpandedFrom(
  loaded: LoadedProjectRoots,
): Record<string, string[]> {
  return loaded.settings.project_expanded ?? {};
}
/** A project that was folded into another one. */
export interface RootChange {
  from: string;
  to: string;
}

export interface AddRootResult {
  /** The project list after the add. */
  roots: string[];
  /** The project the picked folder now belongs to. */
  project: string;
  /** What happened: the folder is already a project (`same`), lies inside one
   *  (`inside`), is a new project (`new`), or is the parent of existing
   *  projects that now fold into it (`merged`). */
  kind: 'same' | 'inside' | 'new' | 'merged';
  /** Folders (paths as the tree shows them) to open down to. */
  reveal: string[];
  /** Projects folded into `project`; their notes move to it. */
  rebinds: RootChange[];
}

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s !== '');
}

function sameSegment(a: string, b: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/** True when `outer` is a prefix of `inner`, segment by segment. */
function isPrefix(
  outer: string[],
  inner: string[],
  caseInsensitive: boolean,
): boolean {
  return (
    outer.length <= inner.length &&
    outer.every((s, i) => sameSegment(s, inner[i] ?? '', caseInsensitive))
  );
}
/** `path` without trailing separators, except on a root: `/` and `C:\` keep
 *  one, since `C:` alone names the current folder of the drive. */
function stripTrailingSeparators(path: string): string {
  if (/^[A-Za-z]:[\\/]+$/.test(path)) {
    return path.slice(0, 3);
  }
  if (/^[\\/]+$/.test(path)) {
    return path.slice(0, 1);
  }
  return path.replace(/[\\/]+$/, '');
}
/** `root` joined with `parts`, using the separator the root itself uses. */
function joinUnder(root: string, parts: string[]): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = stripTrailingSeparators(root);
  if (parts.length === 0) {
    return base;
  }
  // A root already ends with its separator.
  return (/[\\/]$/.test(base) ? base : base + sep) + parts.join(sep);
}
/** The folders from `root` down to `path`, both included, as the tree names
 *  them. Empty when `path` is not inside `root`. */
export function pathChain(
  root: string,
  path: string,
  caseInsensitive: boolean,
): string[] {
  const rootParts = segments(root);
  const pathParts = segments(path);
  if (!isPrefix(rootParts, pathParts, caseInsensitive)) {
    return [];
  }
  const chain = [stripTrailingSeparators(root)];
  for (let i = rootParts.length; i < pathParts.length; i += 1) {
    chain.push(joinUnder(root, pathParts.slice(rootParts.length, i + 1)));
  }
  return chain;
}
/** The project in `roots` that holds `path` (or is it), or null. */
export function rootContaining(
  roots: readonly string[],
  path: string,
  caseInsensitive: boolean,
): string | null {
  const parts = segments(path);
  return (
    roots.find((r) => isPrefix(segments(r), parts, caseInsensitive)) ?? null
  );
}
/** Add `picked` to the project list. Projects never overlap: a folder inside an
 *  existing project is not added (the caller opens the tree down to it), and a
 *  folder above existing projects replaces them. Comparison is by whole path
 *  segment, so `/a/Tools` and `/a/Tools2` are unrelated; `caseInsensitive` is
 *  for file systems that ignore case. */
export function addRoot(
  roots: readonly string[],
  picked: string,
  caseInsensitive: boolean,
): AddRootResult {
  const pickedParts = segments(picked);
  for (const root of roots) {
    const rootParts = segments(root);
    if (!isPrefix(rootParts, pickedParts, caseInsensitive)) {
      continue;
    }
    const same = rootParts.length === pickedParts.length;
    return {
      roots: [...roots],
      project: root,
      kind: same ? 'same' : 'inside',
      reveal: same
        ? []
        : [joinUnder(root, pickedParts.slice(rootParts.length))],
      rebinds: [],
    };
  }
  const project = stripTrailingSeparators(picked);
  const absorbed = roots.filter((r) =>
    isPrefix(pickedParts, segments(r), caseInsensitive),
  );
  if (absorbed.length === 0) {
    return {
      roots: [...roots, project],
      project,
      kind: 'new',
      reveal: [],
      rebinds: [],
    };
  }
  // The new project takes the place of the first project it swallows.
  const merged: string[] = [];
  for (const root of roots) {
    if (!absorbed.includes(root)) {
      merged.push(root);
    } else if (root === absorbed[0]) {
      merged.push(project);
    }
  }
  return {
    roots: merged,
    project,
    kind: 'merged',
    reveal: absorbed.map((a) =>
      joinUnder(project, segments(a).slice(pickedParts.length)),
    ),
    rebinds: absorbed.map((from) => ({ from, to: project })),
  };
}

export interface NormalizedRoots {
  roots: string[];
  /** Projects folded into another one, in the order to apply them. */
  rebinds: RootChange[];
  /** Folders to open down to: where the folded projects now sit. */
  reveal: { project: string; paths: string[] }[];
}
/** Make a saved project list non-overlapping by adding its roots one by one: a
 *  list an older version left with nested projects folds into the outer ones. */
export function normalizeRoots(
  saved: readonly string[],
  caseInsensitive: boolean,
): NormalizedRoots {
  let roots: string[] = [];
  const rebinds: RootChange[] = [];
  const reveal: { project: string; paths: string[] }[] = [];
  for (const picked of saved) {
    const result = addRoot(roots, picked, caseInsensitive);
    roots = result.roots;
    rebinds.push(...result.rebinds);
    if (result.kind === 'inside') {
      rebinds.push({ from: picked, to: result.project });
    }
    if (result.reveal.length > 0) {
      reveal.push({ project: result.project, paths: result.reveal });
    }
  }
  return { roots, rebinds, reveal };
}
/** The expanded set to start from: each saved project's list, plus the project
 *  itself when it has none (a new project opens expanded). A folded project's
 *  list is kept, since its folders are folders of the project above it now, and
 *  `reveal` opens the way down to where it sits. */
export function restoreExpanded(
  roots: readonly string[],
  saved: Readonly<Record<string, string[]>>,
  reveal: readonly { project: string; paths: string[] }[],
  caseInsensitive: boolean,
): Set<string> {
  const expanded = new Set<string>();
  for (const list of Object.values(saved)) {
    for (const path of list) {
      expanded.add(path);
    }
  }
  for (const root of roots) {
    if (saved[root] === undefined) {
      expanded.add(root);
    }
  }
  for (const entry of reveal) {
    for (const path of entry.paths) {
      for (const folder of pathChain(entry.project, path, caseInsensitive)) {
        expanded.add(folder);
      }
    }
  }
  return expanded;
}
/** `expanded` with the way down to every one of `paths` (inside `project`)
 *  opened, the project itself included. */
export function revealPaths(
  expanded: ReadonlySet<string>,
  project: string,
  paths: readonly string[],
  caseInsensitive: boolean,
): Set<string> {
  const next = new Set(expanded);
  next.add(project);
  for (const path of paths) {
    for (const folder of pathChain(project, path, caseInsensitive)) {
      next.add(folder);
    }
  }
  return next;
}
/** The expanded set split per project, for saving. A project that is collapsed
 *  with nothing open still gets an empty list, which tells a later start that
 *  the user closed it. */
export function expandedByRoot(
  roots: readonly string[],
  expanded: ReadonlySet<string>,
  caseInsensitive: boolean,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const root of roots) {
    const rootParts = segments(root);
    out[root] = [...expanded]
      .filter((p) => isPrefix(rootParts, segments(p), caseInsensitive))
      .sort();
  }
  return out;
}
/** The project a window bound to `current` is bound to after `from` was folded
 *  into `to`. */
export function reboundProject(
  current: string | null,
  from: string,
  to: string,
): string | null {
  return current === from ? to : current;
}
