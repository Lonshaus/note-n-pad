<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { open } from '@tauri-apps/plugin-dialog';
  import { settingsState } from './lib/state/settings.svelte';
  import { revealWhenThemed } from './lib/util/reveal';
  import { onFileDragOver, onFileDrop } from './lib/util/fileDrop';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import { t } from './lib/i18n';
  import { debounce } from './lib/util/debounce';
  import { nativeFieldHistory, nativeSelectAll } from './lib/util/menuBar';
  import { installPasteWindow, pasteEnv } from './lib/util/pasteEnv';
  import { fieldPaste } from './lib/util/pasteRouting';
  import { docLabel, groupOpenDocuments } from './lib/util/openDocuments';
  import { guessOsFromUserAgent } from './lib/util/guessOs';
  import {
    addRoot,
    expandedByRoot,
    normalizeRoots,
    projectExpandedFrom,
    projectRootsFrom,
    restoreExpanded,
    revealPaths,
    rootContaining,
    type LoadedProjectRoots,
  } from './lib/util/projectRoots';
  import type { TreeEntry, VisibleRow } from './lib/util/projectTree';
  import {
    flatten,
    parentOf,
    renameInSet,
    TreeCache,
    withoutSubtree,
    type DirListing,
  } from './lib/util/treeCache';
  import {
    applyDropResult,
    confirmMoveDialog,
    dragItems,
    DragGesture,
    dropDecision,
    dropFolder,
    failureDialog,
    folderEntries,
    hoverFeedback,
    modifierOp,
    outcomeDialogs,
    partialDialog,
    refuseDialog,
    runBatch,
    targetVolumeOfPath,
    volumeOfPath,
    type DialogModel,
    type DragItem,
    type DropDecision,
    type DropOp,
    type DropTarget,
  } from './lib/util/treeMove';
  import ConfirmModal from './lib/ConfirmModal.svelte';
  import type { NoteSnapshot } from './lib/state/stickyNote.svelte';

  interface StickyRow {
    id: string;
    paper: string;
    preview: string;
  }

  const win = getCurrentWindow();
  // Paper -> dot color, taken from the sticky paper backgrounds (app.css) so the
  // dot matches the note's card.
  const PAPER_DOT: Record<string, string> = {
    classic: '#fdf6c9',
    white: '#ffffff',
    pink: '#fcdce6',
    blue: '#d6e8fb',
    green: '#d9efd6',
    graphite: '#2b2a25',
  };

  let notes = $state<NoteSnapshot[]>([]);

  const stickyRows = $derived<StickyRow[]>(
    notes
      .filter((n) => n.kind === 'sticky')
      .map((n) => ({
        id: n.id,
        paper: n.paper,
        preview: n.content.split('\n')[0]?.trim() ?? '',
      })),
  );
  // The documents section lists only stray document notes; project-opened files
  // surface in the tree instead.
  const docGroups = $derived(
    groupOpenDocuments(
      notes.filter((n) => n.project === null),
      docLabel,
    ),
  );
  // file_path -> dirty for every open document note (any project). Tree file
  // rows use this to show an "open" marker; both derive from the same fetched
  // notes so they update together on store-changed.
  const openDocs = $derived.by<Map<string, boolean>>(() => {
    const map = new Map<string, boolean>();
    for (const n of notes) {
      if (n.kind === 'document' && n.file_path !== null) {
        map.set(n.file_path, (map.get(n.file_path) ?? false) || n.dirty);
      }
    }
    return map;
  });
  const hostOs = guessOsFromUserAgent(navigator.userAgent);
  // Project folders are matched without regard to case on macOS and Windows.
  const caseInsensitive = hostOs !== 'linux';
  // Projects never overlap, so one expanded set and one row key (the path)
  // serve every project.
  let projectRoots = $state<string[]>([]);
  // Folder listings, read one level at a time. Plain mutable state: every change
  // bumps `cacheVersion`, which the derived rows read.
  const cache = new TreeCache();
  let cacheVersion = $state(0);
  // Paths of expanded folders. Sub-folders default collapsed; a new project's
  // root is added here so it defaults expanded.
  let expanded = $state<Set<string>>(new Set());
  // Tree rows currently selected (Finder-style multi-select: click selects, a
  // file opens on double-click, and the row context menu can open the whole
  // selection). Highlight-plus-menu only. Rebuilt as a fresh Set on every
  // mutation so Svelte 5 tracks the change (in-place Set mutation is not
  // reactive), matching the `expanded` set above.
  let selectedPaths = $state<Set<string>>(new Set());

  function basename(path: string): string {
    return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
  }

  const visibleRows = $derived.by<VisibleRow[]>(() => {
    void cacheVersion;
    return projectRoots.flatMap((root) =>
      flatten(cache, root, basename(root), expanded),
    );
  });

  async function reload(): Promise<void> {
    try {
      notes = await invoke<NoteSnapshot[]>('list_notes');
    } catch (e) {
      // Leave an in-progress inline rename/create's own error alone rather
      // than overwrite it with an unrelated background failure; the debounce
      // below collapses a burst of `store-changed` events into one call, so
      // repeated failures just overwrite this field with the same message
      // instead of stacking notices.
      if (inlineEdit === null) {
        inlineError = String(e);
      }
    }
  }
  // DEV automation only: how many folder reads were issued, and the reads still
  // running.
  let listDirCalls = 0;
  const inflight = new Set<Promise<void>>();
  // Folder to scroll to once its row exists.
  let revealPath: string | null = null;

  function touch(): void {
    cacheVersion += 1;
  }

  const rootVolumeReads = new Map<string, Promise<void>>();
  /** Ask which disk a project folder is on. Its listing does not include the
   *  folder itself, so it is read on its own. */
  function loadRootVolume(root: string, again = false): Promise<void> {
    if (!again && cache.rootVolume(root) !== undefined) {
      return Promise.resolve();
    }
    let read = rootVolumeReads.get(root);
    if (read === undefined) {
      read = invoke<number>('path_volume', { path: root })
        .then(
          (volume) => ({ volume, volumeError: null }),
          (e) => ({ volume: null, volumeError: String(e) }),
        )
        .then((info) => {
          rootVolumeReads.delete(root);
          if (projectRoots.includes(root)) {
            cache.setRootVolume(root, info);
          }
        });
      rootVolumeReads.set(root, read);
    }
    return read;
  }

  async function readDir(root: string, dir: string): Promise<void> {
    const token = cache.begin(root, dir);
    listDirCalls += 1;
    if (dir === root) {
      void loadRootVolume(root, true);
    }
    let listing: DirListing;
    try {
      const entries = await invoke<TreeEntry[]>('list_project_dir', { dir });
      listing = { entries, error: null };
    } catch (e) {
      // Folder moved or deleted: the root keeps a muted error row.
      listing = { entries: [], error: String(e) };
    }
    if (!cache.setDir(root, dir, token, listing)) {
      return;
    }
    syncExpanded(root);
    touch();
    loadPending();
    void scrollToReveal();
  }
  /** Make the open folders agree with what was read: one that is gone is
   *  dropped from the saved state, one spelled with another case than on disk
   *  takes the on-disk spelling. */
  function syncExpanded(root: string): void {
    const kept = cache.reconcile(root, expanded, caseInsensitive);
    if (kept !== expanded) {
      expanded = new Set(kept);
      void persistExpanded();
    }
  }
  /** Read every visible folder that has no listing yet (or a stale one). */
  function loadPending(): void {
    for (const root of projectRoots) {
      for (const dir of cache.dirsToLoad(root, expanded)) {
        const read: Promise<void> = readDir(root, dir).finally(() => {
          inflight.delete(read);
        });
        inflight.add(read);
      }
    }
  }

  async function treeIdle(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.all([...inflight]);
    }
  }

  async function scrollToReveal(): Promise<void> {
    const path = revealPath;
    if (path === null) {
      return;
    }
    // The row spelled exactly so; else the one row that differs only in case.
    const paths = visibleRows.map((r) => r.path);
    const like = paths.filter(
      (p) => caseInsensitive && p.toLowerCase() === path.toLowerCase(),
    );
    const target = paths.includes(path)
      ? path
      : like.length === 1
        ? like[0]
        : undefined;
    if (target === undefined) {
      return;
    }
    revealPath = null;
    await tick();
    const row = [...document.querySelectorAll<HTMLElement>('.tree-li')].find(
      (el) => el.dataset['path'] === target,
    );
    row?.scrollIntoView({ block: 'nearest' });
  }
  /** Read a folder again; its old listing stays on screen until the new one
   *  arrives. */
  function refreshDir(dir: string): void {
    const root = rootContaining(projectRoots, dir, caseInsensitive);
    if (root === null) {
      return;
    }
    cache.invalidate(root, dir);
    loadPending();
  }
  /** Read every folder on screen again: files may have been added, moved or
   *  removed while another app had the focus. Folders that are closed, or open
   *  under a closed one, are left alone; they are read when shown. */
  function refreshOpenFolders(): void {
    for (const root of projectRoots) {
      for (const dir of cache.shownDirs(root, expanded)) {
        refreshDir(dir);
      }
    }
  }

  function refreshAll(): void {
    for (const root of projectRoots) {
      cache.invalidateRoot(root);
    }
    loadPending();
  }
  // Saves run one after another, each built from the state at the time it runs,
  // so the last toggle is the one that sticks.
  let saving: Promise<void> = Promise.resolve();

  function persistExpanded(): Promise<void> {
    saving = saving.then(() =>
      settingsState.save({
        project_expanded: expandedByRoot(
          projectRoots,
          expanded,
          caseInsensitive,
        ),
      }),
    );
    return saving;
  }

  function persistProjects(): Promise<void> {
    saving = saving.then(() =>
      settingsState.save({
        project_roots: projectRoots,
        project_expanded: expandedByRoot(
          projectRoots,
          expanded,
          caseInsensitive,
        ),
      }),
    );
    return saving;
  }

  async function addProject(path: string): Promise<void> {
    const result = addRoot(projectRoots, path, caseInsensitive);
    if (result.kind === 'same') {
      return;
    }
    if (result.kind === 'new' || result.kind === 'merged') {
      // A folder that was folded into another project earlier in this run is a
      // project of its own again.
      await invoke('forget_project_rebinds', { roots: [result.project] });
    }
    // Notes of a project that folds into this one move to it first, so no
    // window is left pointing at a project that is gone.
    for (const change of result.rebinds) {
      await invoke('rebind_project', { from: change.from, to: change.to });
      cache.dropRoot(change.from);
    }
    expanded = revealPaths(
      expanded,
      result.project,
      result.reveal,
      caseInsensitive,
    );
    if (result.kind === 'inside') {
      void persistExpanded();
    } else {
      projectRoots = result.roots;
      void persistProjects();
    }
    syncExpanded(result.project);
    revealPath = result.reveal[0] ?? result.project;
    touch();
    loadPending();
    await treeIdle();
    void scrollToReveal();
  }

  async function removeProject(path: string): Promise<void> {
    projectRoots = projectRoots.filter((r) => r !== path);
    cache.dropRoot(path);
    expanded = withoutSubtree(expanded, path);
    selectedPaths = withoutSubtree(selectedPaths, path);
    touch();
    await persistProjects();
  }

  async function pickProject(): Promise<void> {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== 'string') {
      return;
    }
    await addProject(selected);
  }

  async function clearProject(): Promise<void> {
    for (const root of projectRoots) {
      cache.dropRoot(root);
    }
    projectRoots = [];
    expanded = new Set();
    selectedPaths = new Set();
    touch();
    await persistProjects();
  }

  function toggleFolder(path: string): void {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
      expanded = next;
    } else {
      next.add(path);
      expanded = next;
      // Only this folder's own level is read, and only if it has no listing.
      loadPending();
    }
    void persistExpanded();
  }

  function openFile(path: string, project: string): void {
    void invoke('open_project_file', { path, root: project });
  }
  /** File > Open, routed here when the workspace is the focused window. It holds
   *  no document to fill, so the picked files go wherever an open handed over by
   *  Finder would: `open_picked_files` honours the tab-or-window setting and
   *  reuses the last document window when that setting says tabs. */
  async function pickAndOpen(): Promise<void> {
    const selected = await open({ multiple: true, directory: false });
    if (selected === null) {
      return;
    }
    const paths = Array.isArray(selected) ? selected : [selected];
    await invoke('open_picked_files', { paths });
  }
  /** Replace the selection with a single row. */
  function selectOnly(path: string): void {
    selectedPaths = new Set([path]);
  }
  /** Toggle one row's membership without touching the rest (Cmd/Option-click). */
  function toggleSelected(path: string): void {
    const next = new Set(selectedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    selectedPaths = next;
  }
  /** Selected file rows in visible order (folder members ignored). Backs both the
   *  context-menu "open selected" gate and the actual open. */
  const selectedFiles = $derived.by<VisibleRow[]>(() =>
    visibleRows.filter(
      (r) => !r.isDir && !r.isError && selectedPaths.has(r.path),
    ),
  );
  /** Open every selected file in visible order, each through the row's own
   *  project routing (project-tree files keep opening tabs in the bound window). */
  function openSelectedFiles(): void {
    for (const r of selectedFiles) {
      openFile(r.path, r.project);
    }
  }
  // Row identity carried in a context-menu payload (round-tripped through Rust).
  interface RowPayload {
    path: string;
    project: string;
    depth: number;
    isDir: boolean;
    root: boolean;
  }
  /** Open the native context menu for a workspace row. The payload round-trips
   *  through Rust and comes back with the chosen action as `ctx-action`. */
  function openRowMenu(kind: string, payload: Record<string, unknown>): void {
    void invoke('popup_row_menu', { kind, payload });
  }
  /** Open the tree context menu for a visible tree row (folders, files, roots).
   *  Error placeholder rows have no menu. */
  function openTreeMenu(row: VisibleRow): void {
    if (row.isError) {
      return;
    }
    openRowMenu(row.isDir ? 'tree-folder' : 'tree-file', {
      path: row.path,
      project: row.project,
      depth: row.depth,
      isDir: row.isDir,
      root: row.root,
      // File rows: let Rust label the top item. "Open Selected Files" needs at
      // least two selected files with this row among them; otherwise plain "Open".
      selectionCount: selectedFiles.length,
      targetSelected: selectedPaths.has(row.path),
    });
  }
  // An in-progress inline naming/rename row rendered inside the tree. `anchorPath`
  // is the row it attaches to: a create row renders just below its anchor, a
  // rename row replaces its anchor. `parent` is the directory a create lands in.
  interface InlineEdit {
    kind: 'create-file' | 'create-folder' | 'rename';
    anchorPath: string;
    parent: string;
    project: string;
    targetPath: string;
    depth: number;
    isDir: boolean;
    value: string;
  }
  let inlineEdit = $state<InlineEdit | null>(null);
  // Non-null when the last commit failed (e.g. a name collision); keeps the input
  // open with a red ring and the error as its tooltip.
  let inlineError = $state<string | null>(null);

  async function doCreateFile(
    parent: string,
    project: string,
    name: string,
  ): Promise<void> {
    const path = await invoke<string>('create_file', { parent, name });
    refreshDir(parent);
    await treeIdle();
    // A new file opens immediately, matching the row's project routing.
    openFile(path, project);
  }

  async function doCreateFolder(parent: string, name: string): Promise<void> {
    await invoke('create_folder', { parent, name });
    refreshDir(parent);
    await treeIdle();
  }

  async function doRename(path: string, newName: string): Promise<void> {
    const renamed = await invoke<string>('rename_path', { path, newName });
    const root = rootContaining(projectRoots, path, caseInsensitive);
    if (root === path) {
      // The project folder itself: reading it again shows the load error.
      cache.invalidate(root, root);
      loadPending();
    } else if (root !== null) {
      // A renamed folder keeps what was read below it and stays open.
      cache.renameSubtree(root, path, renamed);
      expanded = renameInSet(expanded, path, renamed);
      selectedPaths = renameInSet(selectedPaths, path, renamed);
      touch();
      void persistExpanded();
      refreshDir(parentOf(path));
    }
    await treeIdle();
  }

  async function doTrash(path: string): Promise<void> {
    await invoke('trash_path', { path });
    const root = rootContaining(projectRoots, path, caseInsensitive);
    if (root !== null && root !== path) {
      cache.dropSubtree(root, path);
      expanded = withoutSubtree(expanded, path);
      selectedPaths = withoutSubtree(selectedPaths, path);
      touch();
      void persistExpanded();
      refreshDir(parentOf(path));
    }
    await treeIdle();
  }
  // A drag of tree rows to a folder. The press is tracked on the window so the
  // drag keeps going outside the row it started on.
  const gesture = new DragGesture();
  interface ActiveDrag {
    items: DragItem[];
    op: DropOp;
    /** The folder a drop would land in, or null when none accepts it. */
    target: string | null;
    cursor: string;
  }
  let drag = $state.raw<ActiveDrag | null>(null);
  let pressedPath = '';
  let lastPointer = { x: 0, y: 0 };
  // A dialog about a drop. Several can be waiting; the first is shown.
  interface DropDialog extends DialogModel {
    onprimary?: (() => void | Promise<void>) | undefined;
  }
  let dialogs = $state.raw<DropDialog[]>([]);
  let dropBusy = false;

  function itemOf(row: VisibleRow): DragItem {
    return {
      path: row.path,
      root: row.project,
      isDir: row.isDir,
      ...volumeOfPath(cache, row.project, row.path),
    };
  }

  function targetOf(path: string, root: string): DropTarget {
    return { path, root, ...targetVolumeOfPath(cache, root, path) };
  }

  function rowAt(x: number, y: number): VisibleRow | undefined {
    const li = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>('.tree-li[data-path]');
    const path = li?.dataset['path'];
    return visibleRows.find((r) => r.path === path && !r.isError);
  }

  function updateDrag(point: {
    clientX: number;
    clientY: number;
    altKey: boolean;
    ctrlKey: boolean;
  }): void {
    if (drag === null) {
      return;
    }
    const op = modifierOp(point, hostOs);
    const row = rowAt(point.clientX, point.clientY);
    let target: string | null = null;
    let cursor = 'default';
    if (row !== undefined) {
      const folder = dropFolder(row);
      const feedback = hoverFeedback(
        dropDecision({
          op,
          items: drag.items,
          target: targetOf(folder, row.project),
          targetChildren: [],
          caseInsensitive,
        }),
        op,
      );
      target = feedback.allowed ? folder : null;
      cursor = feedback.cursor;
    }
    if (op !== drag.op || target !== drag.target || cursor !== drag.cursor) {
      drag = { ...drag, op, target, cursor };
    }
  }

  function endPress(): void {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onDragKey);
    window.removeEventListener('keyup', onDragKey);
  }

  function onRowPointerDown(e: PointerEvent, row: VisibleRow): void {
    if (
      e.button !== 0 ||
      row.root ||
      row.isError ||
      inlineEdit !== null ||
      dialogs.length > 0 ||
      dropBusy
    ) {
      return;
    }
    pressedPath = row.path;
    lastPointer = { x: e.clientX, y: e.clientY };
    gesture.press(e.clientX, e.clientY);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onDragKey);
    window.addEventListener('keyup', onDragKey);
  }

  function onPointerMove(e: PointerEvent): void {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!gesture.move(e.clientX, e.clientY)) {
      return;
    }
    if (drag === null) {
      const rows = dragItems(
        pressedPath,
        visibleRows,
        selectedPaths,
        caseInsensitive,
      );
      if (rows.length === 0) {
        gesture.cancel();
        return;
      }
      drag = {
        items: rows.map(itemOf),
        op: 'move',
        target: null,
        cursor: 'default',
      };
    }
    updateDrag(e);
  }
  /** Esc: the drop does not happen. The button is still down, so its click is
   *  still to come and is ignored. */
  function abortDrag(): void {
    gesture.cancel();
    drag = null;
  }
  /** The system took the pointer away: no button-up and no click will follow. */
  function onPointerCancel(): void {
    endPress();
    gesture.reset();
    drag = null;
  }

  function onDragKey(e: KeyboardEvent): void {
    if (e.type === 'keydown' && e.key === 'Escape') {
      e.preventDefault();
      abortDrag();
    } else {
      updateDrag({
        clientX: lastPointer.x,
        clientY: lastPointer.y,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
      });
    }
  }

  function onPointerUp(e: PointerEvent): void {
    endPress();
    const dropped = gesture.release();
    const active = drag;
    drag = null;
    // The click that follows a drag arrives right after this event.
    setTimeout(() => gesture.forgetClick(), 0);
    const row = rowAt(e.clientX, e.clientY);
    if (dropped && active !== null && row !== undefined) {
      void finishDrop(active.items, row, modifierOp(e, hostOs));
    }
  }

  function showDialogs(models: DropDialog[]): void {
    dialogs = [...dialogs, ...models];
  }

  function dismissDialog(): void {
    dialogs = dialogs.slice(1);
  }

  async function pressPrimary(dialog: DropDialog): Promise<void> {
    dismissDialog();
    await dialog.onprimary?.();
  }
  /** Decide what a drop means, then ask, report, or do it. */
  async function finishDrop(
    items: DragItem[],
    row: VisibleRow,
    op: DropOp,
  ): Promise<void> {
    const root = row.project;
    const folder = dropFolder(row);
    dropBusy = true;
    try {
      await loadRootVolume(root);
      let children: readonly { name: string }[];
      try {
        children = await folderEntries(cache, root, folder, (dir) =>
          invoke<TreeEntry[]>('list_project_dir', { dir }),
        );
      } catch (e) {
        showDialogs([
          failureDialog(
            op,
            items.map((i) => ({ name: basename(i.path), reason: String(e) })),
            t,
          ),
        ]);
        return;
      }
      const target = targetOf(folder, root);
      const decision = dropDecision({
        op,
        items,
        target,
        targetChildren: children,
        caseInsensitive,
      });
      await actOn(decision, target);
    } finally {
      dropBusy = false;
    }
  }

  async function actOn(
    decision: DropDecision,
    target: DropTarget,
  ): Promise<void> {
    switch (decision.kind) {
      case 'noop':
        break;
      case 'refuse':
        showDialogs([refuseDialog(decision.messageKey, t)]);
        break;
      case 'error':
        showDialogs([failureDialog(decision.op, decision.failures, t)]);
        break;
      case 'copyNow':
        await runDrop('copy', decision.items, target);
        break;
      case 'confirmMove':
        showDialogs([
          {
            ...confirmMoveDialog(decision.items, target, t),
            onprimary: () => runDrop('move', decision.items, target),
          },
        ]);
        break;
      case 'partial': {
        const model = partialDialog(decision, target, t);
        showDialogs([
          decision.allowed.length === 0
            ? model
            : {
                ...model,
                onprimary: () => runDrop(decision.op, decision.allowed, target),
              },
        ]);
        break;
      }
    }
  }

  async function runDrop(
    op: DropOp,
    items: DragItem[],
    target: DropTarget,
  ): Promise<void> {
    dropBusy = true;
    try {
      const outcome = await runBatch(
        op,
        items,
        target.path,
        target.root,
        (command, args) => invoke(command, args),
        t,
      );
      applyDropResult(
        {
          cache,
          expanded,
          selected: selectedPaths,
          setState: (nextExpanded, nextSelected) => {
            expanded = nextExpanded;
            selectedPaths = nextSelected;
          },
          touch,
          persistExpanded: () => void persistExpanded(),
          refreshDir,
        },
        op,
        target.root,
        outcome.done,
        target.path,
      );
      showDialogs(outcomeDialogs(op, outcome, t));
      await treeIdle();
    } finally {
      dropBusy = false;
    }
  }
  // Path of a reveal that could not be carried out. The list can outlive the
  // file it names (a document whose file was deleted while the tab stayed
  // open), and a reveal that quietly does nothing reads as a broken menu item.
  let revealFailed = $state<string | null>(null);

  function reveal(path: string): void {
    void invoke('reveal_in_finder', { path }).catch(() => {
      revealFailed = path;
    });
  }

  function startInlineCreate(
    kind: 'create-file' | 'create-folder',
    p: RowPayload,
  ): void {
    // Into a folder row: create as its first child. On a file row: create a
    // sibling in the file's parent directory.
    const intoDir = p.isDir;
    const parent = intoDir ? p.path : parentOf(p.path);
    const depth = intoDir ? p.depth + 1 : p.depth;
    if (intoDir && !expanded.has(p.path)) {
      expanded = new Set(expanded).add(p.path);
      loadPending();
      void persistExpanded();
    }
    inlineError = null;
    inlineEdit = {
      kind,
      anchorPath: p.path,
      parent,
      project: p.project,
      targetPath: '',
      depth,
      isDir: kind === 'create-folder',
      value: '',
    };
  }
  /** Row-hover quick-add: open the same inline naming row the context menu uses,
   *  anchored to this folder row. */
  function quickAdd(
    row: VisibleRow,
    kind: 'create-file' | 'create-folder',
  ): void {
    startInlineCreate(kind, {
      path: row.path,
      project: row.project,
      depth: row.depth,
      isDir: row.isDir,
      root: row.root,
    });
  }

  function startInlineRename(p: RowPayload): void {
    inlineError = null;
    inlineEdit = {
      kind: 'rename',
      anchorPath: p.path,
      parent: '',
      project: p.project,
      targetPath: p.path,
      depth: p.depth,
      isDir: p.isDir,
      value: basename(p.path),
    };
  }

  async function commitInline(): Promise<void> {
    const edit = inlineEdit;
    if (edit === null) {
      return;
    }
    const name = edit.value.trim();
    if (name === '') {
      inlineEdit = null;
      inlineError = null;
      return;
    }
    try {
      if (edit.kind === 'create-file') {
        await doCreateFile(edit.parent, edit.project, name);
      } else if (edit.kind === 'create-folder') {
        await doCreateFolder(edit.parent, name);
      } else {
        await doRename(edit.targetPath, name);
      }
      inlineEdit = null;
      inlineError = null;
    } catch (e) {
      // Keep the input open so the user can fix the name and retry.
      inlineError = String(e);
    }
  }

  function cancelInline(): void {
    inlineEdit = null;
    inlineError = null;
  }

  function onInlineKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitInline();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelInline();
    }
  }
  /** Route a context-menu selection to its handler. `p` is the original row
   *  payload the menu was opened with. */
  function handleCtxAction(
    action: string,
    p: RowPayload & Record<string, unknown>,
  ): void {
    switch (action) {
      case 'open':
        openFile(p.path, p.project);
        break;
      case 'open-selected':
        openSelectedFiles();
        break;
      case 'new-file':
        startInlineCreate('create-file', p);
        break;
      case 'new-folder':
        startInlineCreate('create-folder', p);
        break;
      case 'rename':
        startInlineRename(p);
        break;
      case 'delete':
        // Trash is recoverable, so no confirm dialog.
        void doTrash(p.path);
        break;
      case 'show-in-finder':
        // Tree rows carry `path`; document rows carry `file_path`.
        reveal((p.path as string | undefined) ?? (p.file_path as string));
        break;
      case 'save-doc':
        stickySave(p.id as unknown as string);
        break;
      case 'close':
        stickyClose(p.id as unknown as string);
        break;
      case 'close-tab':
        void invoke('close_doc_tab', {
          group: p.group,
          tabIndex: p.tabIndex,
        });
        break;
    }
  }
  // Per-section collapse state for the three sidebar groups.
  let secOpen = $state({ stickies: true, docs: true, project: true });

  function focusSticky(id: string): void {
    void invoke('focus_note_window', { id });
  }

  function stickySave(id: string): void {
    void invoke('sticky_row_action', { id, action: 'save' });
  }

  function stickyClose(id: string): void {
    void invoke('sticky_row_action', { id, action: 'close' });
  }
  /** Raise the document window holding this tab. The list is built from the
   *  store, which keeps a document after its window is closed (the content lives
   *  on in the snapshot), so a row can outlive its window — those reopen the
   *  group on the clicked tab instead of doing nothing. */
  async function focusDoc(group: string, tabIndex: number): Promise<void> {
    const live = await invoke<string[]>('live_doc_groups', { groups: [group] });
    if (live.length === 0) {
      await invoke('open_document_group', { group, tab: tabIndex });
      return;
    }
    await invoke('focus_doc_tab', { group, tabIndex });
  }
  // Reflect the editor theme and the interface chrome onto the document root.
  $effect(() => {
    applyTheme(settingsState.themeId);
    applyChrome(settingsState.interfaceMode, settingsState.prefersDark);
  });

  onMount(() => {
    const unlistenTheme = settingsState.listen();
    const unlistenChanges = settingsState.listenChanges();
    const unlistenThemes = themeRegistry.listen();
    const unlistenLocales = localeRegistry.listen();
    const uninstallPaste = installPasteWindow();
    // Reveal the window only after the theme is loaded and applied, so a
    // dark-theme window never flashes its default white background.
    void revealWhenThemed();
    void reload();
    // Restore the saved project roots and what was expanded in them, and read
    // the visible folders. A list an older version left with nested projects is
    // folded into the outer ones, and the result is saved back.
    void (async (): Promise<void> => {
      const loaded = await invoke<LoadedProjectRoots>('load_settings');
      const saved = projectRootsFrom(loaded);
      const merged = normalizeRoots(saved, caseInsensitive);
      await invoke('forget_project_rebinds', { roots: merged.roots });
      for (const change of merged.rebinds) {
        await invoke('rebind_project', { from: change.from, to: change.to });
      }
      projectRoots = merged.roots;
      expanded = restoreExpanded(
        merged.roots,
        projectExpandedFrom(loaded),
        merged.reveal,
        caseInsensitive,
      );
      if (merged.rebinds.length > 0 || merged.roots.length !== saved.length) {
        await persistProjects();
      }
      loadPending();
    })();
    // Live sync: any store mutation re-reads the note list (debounced so a burst
    // of mutations collapses into one fetch).
    const refetch = debounce(() => {
      void reload();
    }, 100);
    const unlistenStore = win.listen('store-changed', () => refetch());
    // Coming back to the workspace shows what the file system looks like now.
    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        refreshOpenFolders();
      }
    });
    // Native context-menu selection: Rust echoes the chosen action plus the row
    // payload the menu was opened with.
    const unlistenCtx = win.listen<{
      action: string;
      payload: RowPayload & Record<string, unknown>;
    }>('ctx-action', (event) => {
      handleCtxAction(event.payload.action, event.payload.payload);
    });
    // Persist logical bounds after the user finishes moving or resizing.
    const captureBounds = debounce(() => {
      void (async (): Promise<void> => {
        const scale = await win.scaleFactor();
        const pos = (await win.outerPosition()).toLogical(scale);
        const size = (await win.innerSize()).toLogical(scale);
        await settingsState.save({
          workspace_x: pos.x,
          workspace_y: pos.y,
          workspace_width: size.width,
          workspace_height: size.height,
        });
      })();
    }, 300);
    const unlistenMoved = win.onMoved(() => captureBounds());
    const unlistenResized = win.onResized(() => captureBounds());
    // Closing the workspace only hides it: tree/expansion state survives and
    // the next summon (Cmd+Shift+E / menu / tray) is instant via reveal().
    const unlistenClose = win.onCloseRequested((event) => {
      event.preventDefault();
      void win.hide();
    });
    // Cmd+W (routed from the app menu) hides the workspace, same as its close box.
    const unlistenMenuClose = win.listen('menu-close', () => void win.hide());
    // File > Open reaches whichever window has focus. A launch with nothing
    // restored leaves the workspace and a sticky, and neither holds a document,
    // so without this the menu item is live with nothing to answer it.
    // Edit > Undo/Redo/Select All arrive here as well (the macOS items are no
    // longer native): the inline rename field keeps its own history and
    // selection.
    const unlistenMenuAction = win.listen<string>('menu-action', (event) => {
      if (event.payload === 'open') {
        void pickAndOpen();
      } else if (event.payload === 'undo' || event.payload === 'redo') {
        nativeFieldHistory(event.payload);
      } else if (event.payload === 'select-all') {
        nativeSelectAll();
      }
    });
    // DEV-only automation hook; dynamic import keeps it out of production.
    if (import.meta.env.DEV) {
      void import('./lib/dev/auto').then((m) =>
        m.installWorkspaceAuto({
          getStickyRows: () =>
            stickyRows.map((r) => ({
              id: r.id,
              paper: r.paper,
              preview: r.preview,
            })),
          getDocRows: () =>
            docGroups.flatMap((g) =>
              g.rows.map((r) => ({
                group: r.group,
                tabIndex: r.tabIndex,
                name: r.name,
                dirty: r.dirty,
              })),
            ),
          clickSticky: (id: string) => focusSticky(id),
          stickySave: (id: string) => stickySave(id),
          stickyClose: (id: string) => stickyClose(id),
          clickDoc: (group: string, tabIndex: number) =>
            focusDoc(group, tabIndex),
          addProject: (path: string) => addProject(path),
          removeProject: (path: string) => removeProject(path),
          clearProject: () => clearProject(),
          getTreeRows: () =>
            visibleRows
              .filter((r) => !r.isError)
              .map((r) => ({
                name: r.name,
                path: r.path,
                isDir: r.isDir,
                depth: r.depth,
                expanded: r.expanded,
                root: r.root,
                project: r.project,
                open: !r.isDir && openDocs.has(r.path),
                dirty: !r.isDir && (openDocs.get(r.path) ?? false),
              })),
          toggleFolder: (path: string) => toggleFolder(path),
          getProjectRoots: () => [...projectRoots],
          getExpandedPaths: () => [...expanded].sort(),
          getListDirCalls: () => listDirCalls,
          treeIdle: () => treeIdle(),
          clickFile: (path: string) => {
            // Route with the row's project, matching a real click.
            const row = visibleRows.find(
              (r) => !r.isDir && !r.isError && r.path === path,
            );
            if (row !== undefined) {
              openFile(path, row.project);
            }
          },
          // Context-menu actions drive the same handlers as `ctx-action`, since
          // automation cannot click the native popup.
          ctxCreateFile: (parentPath: string, project: string, name: string) =>
            doCreateFile(parentPath, project, name),
          ctxCreateFolder: (parentPath: string, name: string) =>
            doCreateFolder(parentPath, name),
          ctxRename: (path: string, newName: string) => doRename(path, newName),
          ctxTrash: (path: string) => doTrash(path),
          // The reveal command is always wired up; the hook confirms the surface
          // without opening Finder in tests.
          ctxRevealSupported: () => true,
          inlineEditorOpen: () => inlineEdit !== null,
          getSelectedPaths: () => [...selectedPaths].sort(),
          dragState: () =>
            drag === null
              ? null
              : { target: drag.target, cursor: drag.cursor, op: drag.op },
          dialogState: () => {
            const dialog = dialogs[0];
            return dialog === undefined
              ? null
              : {
                  message: dialog.message,
                  items: dialog.items,
                  buttons: [
                    ...(dialog.primaryLabel === null
                      ? []
                      : [dialog.primaryLabel]),
                    dialog.cancelLabel,
                  ],
                };
          },
          dialogPress: async (label: string) => {
            const dialog = dialogs[0];
            if (dialog === undefined) {
              return false;
            }
            if (label === dialog.primaryLabel && dialog.onprimary) {
              await pressPrimary(dialog);
              return true;
            }
            if (label === dialog.cancelLabel) {
              dismissDialog();
              return true;
            }
            return false;
          },
          // Drive the row-hover quick-add buttons: find the folder row and open
          // the same inline naming flow a real button click would.
          folderQuickAdd: (path: string, kind: 'file' | 'folder') => {
            const row = visibleRows.find(
              (r) => r.isDir && !r.isError && r.path === path,
            );
            if (row !== undefined) {
              quickAdd(
                row,
                kind === 'folder' ? 'create-folder' : 'create-file',
              );
            }
          },
        }),
      );
    }
    return () => {
      uninstallPaste();
      endPress();
      refetch.cancel();
      captureBounds.cancel();
      unlistenTheme();
      void unlistenChanges.then((u) => u());
      void unlistenThemes.then((u) => u());
      void unlistenLocales.then((u) => u());
      void unlistenStore.then((u) => u());
      void unlistenFocus.then((u) => u());
      void unlistenCtx.then((u) => u());
      void unlistenMoved.then((u) => u());
      void unlistenResized.then((u) => u());
      void unlistenClose.then((u) => u());
      void unlistenMenuClose.then((u) => u());
      void unlistenMenuAction.then((u) => u());
    };
  });
</script>

<svelte:window ondragovercapture={onFileDragOver} ondropcapture={onFileDrop} />
<div
  class="workspace"
  class:dragging={drag !== null}
  style:--drag-cursor={drag?.cursor}
>
  <div class="content">
    {#if inlineError !== null && inlineEdit === null}
      <!-- Same field the inline rename/create row's tooltip uses; shown here
           instead only while no inline row is open, so the two never compete
           for the same message. -->
      <p class="empty tree-error">{inlineError}</p>
    {/if}
    <section class="group">
      <h2 class="heading">
        <button
          class="sec-toggle"
          aria-expanded={secOpen.stickies}
          onclick={() => (secOpen.stickies = !secOpen.stickies)}
        >
          <span
            class="sec-chevron"
            class:open={secOpen.stickies}
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </span>
          {t('workspace.section.stickies')}
        </button>
      </h2>
      {#if !secOpen.stickies}
        <!-- collapsed -->
      {:else if stickyRows.length === 0}
        <p class="empty">{t('workspace.stickies.empty')}</p>
      {:else}
        <ul class="list">
          {#each stickyRows as row (row.id)}
            <li
              class="sticky-li"
              oncontextmenu={(e) => {
                e.preventDefault();
                openRowMenu('sticky', { id: row.id });
              }}
            >
              <button class="row" onclick={() => focusSticky(row.id)}>
                <span
                  class="dot"
                  style="background: {PAPER_DOT[row.paper] ?? '#fdf6c9'};"
                  aria-hidden="true"
                ></span>
                {#if row.preview === ''}
                  <span class="label muted">{t('workspace.sticky.blank')}</span>
                {:else}
                  <span class="label">{row.preview}</span>
                {/if}
              </button>
              <button
                class="icon-btn row-action"
                title={t('common.save')}
                aria-label={t('common.save')}
                onclick={(e) => {
                  e.stopPropagation();
                  stickySave(row.id);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"
                  />
                  <path d="M17 21v-8H7v8" />
                  <path d="M7 3v5h8" />
                </svg>
              </button>
              <button
                class="icon-btn row-action danger"
                title={t('common.close')}
                aria-label={t('common.close')}
                onclick={(e) => {
                  e.stopPropagation();
                  stickyClose(row.id);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="group">
      <h2 class="heading">
        <button
          class="sec-toggle"
          aria-expanded={secOpen.docs}
          onclick={() => (secOpen.docs = !secOpen.docs)}
        >
          <span
            class="sec-chevron"
            class:open={secOpen.docs}
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </span>
          {t('workspace.section.docs')}
        </button>
      </h2>
      {#if !secOpen.docs}
        <!-- collapsed -->
      {:else if docGroups.length === 0}
        <p class="empty">{t('workspace.docs.empty')}</p>
      {:else}
        {#each docGroups as g (g.group)}
          <ul class="list">
            {#each g.rows as row (row.id)}
              <li
                oncontextmenu={(e) => {
                  e.preventDefault();
                  openRowMenu('doc', {
                    group: row.group,
                    tabIndex: row.tabIndex,
                    file_path: row.filePath ?? '',
                  });
                }}
              >
                <button
                  class="row"
                  onclick={() => void focusDoc(row.group, row.tabIndex)}
                >
                  <span class="label">{row.name}</span>
                  {#if row.dirty}
                    <span class="dirty" aria-hidden="true">•</span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/each}
      {/if}
    </section>

    <section class="group project">
      <div class="proj-head">
        <h2 class="heading">
          <button
            class="sec-toggle"
            aria-expanded={secOpen.project}
            onclick={() => (secOpen.project = !secOpen.project)}
          >
            <span
              class="sec-chevron"
              class:open={secOpen.project}
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 24 24"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                stroke-width="2.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </span>
            {t('workspace.section.project')}
          </button>
        </h2>
        <div class="proj-actions">
          {#if projectRoots.length > 0}
            <button
              class="icon-btn"
              title={t('workspace.project.refresh')}
              aria-label={t('workspace.project.refresh')}
              onclick={() => refreshAll()}
            >
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M20 8a8 8 0 1 0 1.3 6" />
                <path d="M20 3v5h-5" />
              </svg>
            </button>
          {/if}
          <button
            class="icon-btn"
            title={t('workspace.project.add')}
            aria-label={t('workspace.project.add')}
            onclick={() => pickProject()}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>
      {#if !secOpen.project}
        <!-- collapsed -->
      {:else if projectRoots.length === 0}
        <p class="empty">{t('workspace.project.empty')}</p>
      {:else}
        {#snippet inlineRow(depth: number, isDir: boolean)}
          <div
            class="row inline-row"
            style="padding-left: {0.4 + depth * 0.85}rem;"
          >
            <span class="chevron spacer" aria-hidden="true"></span>
            <span class="node-icon" aria-hidden="true">
              {#if isDir}
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="M3 7a1 1 0 0 1 1-1h4l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z"
                  />
                </svg>
              {:else}
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9l-6-6z"
                  />
                  <path d="M13 3v6h6" />
                </svg>
              {/if}
            </span>
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="inline-input"
              class:error={inlineError !== null}
              title={inlineError ?? undefined}
              bind:value={inlineEdit!.value}
              onkeydown={onInlineKeydown}
              onpaste={(e) => void fieldPaste(e, e.currentTarget, pasteEnv)}
              onblur={cancelInline}
              autofocus
            />
          </div>
        {/snippet}
        <ul class="list tree">
          {#each visibleRows as row (row.path)}
            <li
              class="tree-li"
              class:drop-target={drag?.target === row.path}
              data-path={row.path}
              oncontextmenu={(e) => {
                if (row.isError) {
                  return;
                }
                e.preventDefault();
                openTreeMenu(row);
              }}
            >
              {#if inlineEdit?.kind === 'rename' && inlineEdit.anchorPath === row.path}
                {@render inlineRow(row.depth, row.isDir)}
              {:else if row.isError}
                <p class="empty tree-error">
                  {t('workspace.project.loadError')}
                </p>
              {:else if row.isDir}
                <button
                  class="row"
                  class:root={row.root}
                  class:selected={selectedPaths.has(row.path)}
                  style="padding-left: {0.4 + row.depth * 0.85}rem;"
                  title={row.root ? row.project : undefined}
                  onpointerdown={(e) => onRowPointerDown(e, row)}
                  onclick={(e) => {
                    if (gesture.consumeClick()) {
                      return;
                    }
                    // Cmd/Option-click toggles selection only, never expand.
                    if (e.metaKey || e.altKey) {
                      toggleSelected(row.path);
                      return;
                    }
                    selectOnly(row.path);
                    if (row.expandable) {
                      toggleFolder(row.path);
                    }
                  }}
                >
                  {#if row.expandable}
                    <span
                      class="chevron"
                      class:open={row.expanded}
                      aria-hidden="true"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="12"
                        height="12"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </span>
                  {:else}
                    <span class="chevron spacer" aria-hidden="true"></span>
                  {/if}
                  <span class="node-icon" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path
                        d="M3 7a1 1 0 0 1 1-1h4l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z"
                      />
                    </svg>
                  </span>
                  <span class="label">{row.name}</span>
                </button>
                <button
                  class="icon-btn row-add"
                  title={t('workspace.tree.newFile')}
                  aria-label={t('workspace.tree.newFileAria')}
                  onclick={() => quickAdd(row, 'create-file')}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9l-6-6z"
                    />
                    <path d="M13 3v6h6" />
                    <path d="M12 12v6M9 15h6" />
                  </svg>
                </button>
                <button
                  class="icon-btn row-add"
                  title={t('workspace.tree.newFolder')}
                  aria-label={t('workspace.tree.newFolderAria')}
                  onclick={() => quickAdd(row, 'create-folder')}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M3 7a1 1 0 0 1 1-1h4l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z"
                    />
                    <path d="M12 11v5M9.5 13.5h5" />
                  </svg>
                </button>
                {#if row.root}
                  <button
                    class="icon-btn row-remove danger"
                    title={t('workspace.project.close')}
                    aria-label={t('workspace.project.close')}
                    onclick={() => removeProject(row.project)}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.4"
                      stroke-linecap="round"
                    >
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                {/if}
              {:else}
                {@const dirty = openDocs.get(row.path)}
                <button
                  class="row"
                  class:open={dirty !== undefined}
                  class:selected={selectedPaths.has(row.path)}
                  style="padding-left: {0.4 + row.depth * 0.85}rem;"
                  title={row.path}
                  onpointerdown={(e) => onRowPointerDown(e, row)}
                  onclick={(e) => {
                    if (gesture.consumeClick()) {
                      return;
                    }
                    if (e.metaKey || e.altKey) {
                      toggleSelected(row.path);
                    } else {
                      selectOnly(row.path);
                    }
                  }}
                  ondblclick={() => openFile(row.path, row.project)}
                >
                  <span class="chevron spacer" aria-hidden="true"></span>
                  <span class="node-icon" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path
                        d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9l-6-6z"
                      />
                      <path d="M13 3v6h6" />
                    </svg>
                  </span>
                  <span class="label">{row.name}</span>
                  {#if dirty}
                    <span class="open-dot" aria-hidden="true"></span>
                  {/if}
                </button>
              {/if}
            </li>
            {#if inlineEdit !== null && inlineEdit.kind !== 'rename' && inlineEdit.anchorPath === row.path}
              <li class="tree-li inline-li">
                {@render inlineRow(inlineEdit.depth, inlineEdit.isDir)}
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  {#if dialogs[0] !== undefined}
    {@const dialog = dialogs[0]}
    {#key dialog}
      <ConfirmModal
        message={dialog.message}
        items={dialog.items}
        primaryLabel={dialog.primaryLabel ?? undefined}
        onprimary={dialog.onprimary === undefined
          ? undefined
          : () => pressPrimary(dialog)}
        cancelLabel={dialog.cancelLabel}
        oncancel={() => dismissDialog()}
      />
    {/key}
  {/if}
  {#if revealFailed !== null}
    <!-- Report only: once the file is gone from where the row remembers it,
         there is no action left to offer. -->
    <ConfirmModal
      message={t('doc.revealFailed', { name: basename(revealFailed) })}
      cancelLabel={t('common.close')}
      oncancel={() => (revealFailed = null)}
    />
  {/if}
</div>

<style>
  .workspace {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    box-sizing: border-box;
    background: var(--bg);
    color: var(--fg);
    font-size: 0.85rem;
    /* The report modal's backdrop is `position: absolute; inset: 0`, so it needs
       a positioned ancestor to cover the window rather than the viewport root. */
    position: relative;
    /* ConfirmModal reads its palette from the host; the workspace uses the same
       chrome variables the document window does. */
    --modal-surface: var(--bg);
    --modal-fg: var(--fg);
    --modal-accent: var(--accent);
    --modal-border: var(--topbar-border);
    --modal-hover: var(--topbar-border);
  }
  .sec-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    cursor: default;
  }
  .sec-chevron {
    display: flex;
    align-items: center;
  }
  .sec-chevron svg {
    transition: transform 0.15s ease;
  }
  .sec-chevron.open svg {
    transform: rotate(90deg);
  }
  .content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    flex: 1 1 auto;
    min-height: 0;
    padding: 0.6rem 0.75rem 0.75rem;
    overflow-y: auto;
  }
  .heading {
    margin: 0 0 0.4rem;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.55;
  }
  .empty {
    margin: 0;
    opacity: 0.45;
    font-size: 0.8rem;
  }
  .list {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.3rem 0.4rem;
    border: none;
    border-radius: 5px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: default;
  }
  .row:hover {
    background: var(--topbar-border);
  }
  /* Hovering anywhere on a sticky/tree row highlights the whole row, action
     icons included, so the target of the action stays obvious. Theme-aware via
     the shared --topbar-border / --accent variables. */
  .sticky-li,
  .tree-li {
    border-radius: 5px;
  }
  .sticky-li:hover,
  .tree-li:hover {
    background: var(--topbar-border);
  }
  .tree-li:hover:has(.row.open) {
    background: color-mix(in srgb, var(--accent) 24%, transparent);
  }
  /* The li paints the hover background; inner rows must not stack their own
     translucent layer on top (it reads as a color seam). */
  .sticky-li .row:hover,
  .tree-li .row:hover {
    background: none;
  }
  .tree-li:hover .row.open {
    background: none;
  }
  /* Action buttons never draw their own pill; hovering them only recolors
     the glyph — accent for save, red for close/remove. */
  .sticky-li .row-action:hover,
  .tree-li .row-remove:hover,
  .tree-li .row-add:hover {
    background: none;
    color: var(--accent);
    opacity: 1;
  }
  .sticky-li .danger:hover,
  .tree-li .danger:hover {
    color: var(--danger);
  }
  .dot {
    flex: 0 0 auto;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid rgba(0, 0, 0, 0.2);
  }
  .sticky-li {
    display: flex;
    align-items: center;
  }
  .sticky-li .row {
    flex: 1 1 auto;
    min-width: 0;
  }
  .sticky-li .row-action {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    opacity: 0;
  }
  .sticky-li:hover .row-action {
    opacity: 0.6;
  }
  .row-action:hover {
    opacity: 1;
  }
  .label {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label.muted {
    opacity: 0.45;
  }
  .row.open {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  /* Single-click selection (Finder-style). Painted on the li — the same layer
     the hover background uses — so the row text and the action-icon strip share
     one continuous tint; inner rows never stack their own layer on top. */
  .tree-li:has(.row.selected) {
    background: color-mix(in srgb, var(--accent) 26%, transparent);
  }
  .tree-li:hover:has(.row.selected) {
    background: color-mix(in srgb, var(--accent) 32%, transparent);
  }
  .tree-li:has(.row.selected) .row,
  .tree-li:hover:has(.row.selected) .row {
    background: none;
  }
  /* The folder a drop would land in, while a drag is under way. */
  .tree-li.drop-target,
  .tree-li.drop-target:hover {
    background: color-mix(in srgb, var(--accent) 32%, transparent);
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .workspace.dragging,
  .workspace.dragging * {
    cursor: var(--drag-cursor) !important;
    -webkit-user-select: none;
    user-select: none;
  }
  .open-dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    margin-right: 0.15rem;
    border-radius: 50%;
    background: #e0a500;
  }
  .dirty {
    flex: 0 0 auto;
    color: #e0a500;
    font-size: 1rem;
    line-height: 1;
  }
  .project {
    display: block;
  }
  .proj-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .proj-actions {
    display: flex;
    align-items: center;
    gap: 0.15rem;
  }
  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: none;
    color: inherit;
    font-size: 0.9rem;
    line-height: 1;
    opacity: 0.7;
    cursor: default;
  }
  .icon-btn:hover {
    opacity: 1;
    background: var(--topbar-border);
  }
  .tree {
    margin-bottom: 0;
  }
  .tree-li {
    display: flex;
    align-items: center;
  }
  .tree .row {
    flex: 1 1 auto;
    min-width: 0;
  }
  .row.root .label {
    font-weight: 600;
  }
  .row-remove,
  .row-add {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    opacity: 0;
  }
  .tree-li:hover .row-remove,
  .tree-li:hover .row-add {
    opacity: 0.6;
  }
  .row-remove:hover,
  .row-add:hover {
    opacity: 1;
  }
  .tree-error {
    margin: 0;
    padding: 0.3rem 0.4rem 0.3rem 1.25rem;
  }
  .chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 0.7rem;
    opacity: 0.55;
    transition: transform 0.1s ease;
  }
  .chevron.open {
    transform: rotate(90deg);
  }
  .chevron.spacer {
    visibility: hidden;
  }
  .node-icon {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    opacity: 0.6;
  }
  .inline-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.1rem 0.3rem;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--bg);
    color: inherit;
    font: inherit;
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .inline-input.error {
    border-color: var(--danger);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 30%, transparent);
  }
</style>
