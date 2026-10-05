// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

/** The part of the `load_settings` reply the workspace needs. The roots sit
 *  under `settings`, not at the top level of the reply. */
export interface LoadedProjectRoots {
  settings: { project_roots?: string[] };
}

/** The saved project roots from a `load_settings` reply, or none. */
export function projectRootsFrom(loaded: LoadedProjectRoots): string[] {
  return loaded.settings.project_roots ?? [];
}
