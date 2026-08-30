<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount, tick } from 'svelte';
  import {
    serializeDsv,
    indexDsv,
    rowFields,
    windowFields,
    setCellChange,
    insertRowChange,
    deleteRowChange,
    clearRowChange,
    insertColChange,
    deleteColChange,
    clearColChange,
    clearAllChange,
    copyAll,
    copyColumn,
  } from '../util/csv';
  import type { DsvChange, DsvIndex } from '../util/csv';
  import type { Text } from '@codemirror/state';
  import { computeVisibleWindow, lineToScrollTop } from '../util/largeView';
  import {
    blockTopFor,
    engineScrollLimit,
    MAX_SCROLL_HEIGHT,
    rowLayout,
    shouldCommitCell,
  } from '../util/tableRows';
  import { t } from '../i18n';

  interface Props {
    /** The document itself, not a copy of it: `toString()` on a 100 MiB table is
     *  a 180 MB string, and the index never needs one. */
    content: Text;
    delimiter: string;
    /** What changed and where, not a whole new document: a table edit must not
     *  rewrite bytes it did not touch. */
    onchange: (changes: DsvChange[]) => void;
    onundo: () => void;
    onredo: () => void;
    oncursor: (row: number, col: number) => void;
    dark: boolean;
  }

  let { content, delimiter, onchange, onundo, onredo, oncursor, dark }: Props =
    $props();

  const index = $derived(indexDsv(content, delimiter));
  const colCount = $derived(index.colCount);

  const colIndexes = $derived(
    Array.from({ length: colCount }, (_unused, i) => i),
  );

  // Header-row styling is display-only, per-tab runtime state (not persisted).
  let headerRow = $state(false);

  // Root element, used to locate a cell when the menu is opened by automation.
  let rootEl: HTMLDivElement;
  // The table itself. Observed alongside the pane: the pane's own box does not
  // move when a row changes height, but the table's does, and that is the only
  // signal a row-height change gives.
  let gridEl: HTMLTableElement | undefined = $state();

  // Row virtualization: rendering every row cost ~12s of frozen
  // window at 100k rows. Only the viewport's rows are built; two spacer rows
  // stand in for the rest so the scrollbar still measures the whole document.
  const OVERSCAN = 10;
  let scrollEl: HTMLDivElement;
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  // Seeded from the CSS, then replaced by a real measurement: zoom and font
  // size move it.
  let rowHeight = $state(23);
  // The cell edit typed but not yet committed. Not $state: nothing renders off
  // it. Held here rather than read back off the input, because by the time the
  // window narrows that element may be unreachable or never have taken focus.
  //
  // `index` is the identity of the document it was typed against. One instance
  // serves every tab, and `index` is a fresh object on any content change, so
  // this one reference check covers a tab switch, a switch away and back, an
  // edit committed elsewhere, and a structural change that moved the row —
  // every case where committing by row number would write somewhere it should
  // not.
  let pendingEdit: {
    r: number;
    c: number;
    value: string;
    document: DsvIndex;
  } | null = null;

  // At least one row: an empty document still shows one editable cell.
  const rowCount = $derived(Math.max(index.rowStarts.length, 1));
  // Asked of the engine once on mount, so no per-platform constant has to be
  // right. Seeded with the measured value for the first render.
  let scrollCap = $state(MAX_SCROLL_HEIGHT);
  const trueHeight = $derived(rowCount * rowHeight);
  const contentHeight = $derived(Math.min(trueHeight, scrollCap));
  const compressed = $derived(contentHeight < trueHeight);
  // The column-head strip and append bar put `scrollTop` ~42px ahead of the
  // data rows' own axis; under two rows, so the overscan absorbs it.
  const view = $derived(
    computeVisibleWindow(
      scrollTop,
      rowHeight,
      viewportHeight,
      rowCount,
      contentHeight,
      OVERSCAN,
    ),
  );

  // The promoted header row renders even when scrolled past: sticky only pins
  // an element that is there.
  const layout = $derived(
    rowLayout(
      view.startLine,
      view.endLine,
      rowCount,
      rowHeight,
      [headerRow ? 0 : null],
      blockTopFor(
        view.startLine,
        view.firstVisible,
        scrollTop,
        rowHeight,
        compressed,
      ),
      contentHeight,
    ),
  );
  const pinnedRows = $derived(
    layout.pinned.map((r) => ({
      r,
      cells: rowFields(content, index, r, delimiter),
    })),
  );
  const windowRows = $derived(
    windowFields(content, index, view.startLine, view.endLine, delimiter).map(
      (cells, i) => ({ r: view.startLine + i, cells }),
    ),
  );

  function onGridScroll(): void {
    scrollTop = scrollEl.scrollTop;
    commitPendingIfLeaving();
  }

  // A removed input fires no blur, so a pending edit on a row leaving the
  // window would vanish with no commit and no dirty flag. Commit it here.
  // Call from every path that narrows the window, not just scrolling: a shorter
  // pane drops rows off the bottom with no scroll event. Call it last, once the
  // derived window is up to date.
  function commitPendingIfLeaving(): void {
    const p = pendingEdit;
    if (p === null || (p.r >= view.startLine && p.r < view.endLine)) {
      return;
    }
    pendingEdit = null;
    // The document changed under the edit, so row `p.r` no longer means what it
    // meant when it was typed. Dropping it matches what the user already sees:
    // the input was re-rendered from the new content when it changed.
    if (p.document !== index) {
      return;
    }
    commitCell(p.r, p.c, p.value);
  }

  // Measured, not read off the stylesheet. Forces layout, so mount/resize only.
  // Writes only on a real change: this runs inside a ResizeObserver, and a
  // no-op write there re-renders, which resizes, which calls it again.
  function measureRowHeight(): void {
    const measured = scrollEl
      ?.querySelector<HTMLElement>('.cell')
      ?.closest('tr')?.offsetHeight;
    if (measured !== undefined && measured > 0 && measured !== rowHeight) {
      rowHeight = measured;
    }
  }

  function measurePane(): void {
    if (scrollEl.clientHeight !== viewportHeight) {
      viewportHeight = scrollEl.clientHeight;
    }
  }

  onMount(() => {
    const observer = new ResizeObserver(() => {
      measurePane();
      measureRowHeight();
      commitPendingIfLeaving();
    });
    observer.observe(scrollEl);
    if (gridEl !== undefined) {
      observer.observe(gridEl);
    }
    scrollCap = engineScrollLimit(document);
    measurePane();
    measureRowHeight();
    return () => observer.disconnect();
  });

  // The in-table context menu: the target cell (r, c) plus its viewport anchor.
  // Null when closed. `variant` picks which operation group(s) to show: a gutter
  // column head opens 'col', a row head opens 'row', a data cell opens 'cell'
  // (both groups, separated).
  let menu = $state<{
    r: number;
    c: number;
    variant: 'row' | 'col' | 'cell';
    x: number;
    y: number;
  } | null>(null);

  // Row/column/whole-table selection for copy/clear shortcuts. Null when nothing
  // is selected. Indices go stale on any structural change, so every mutation and
  // edit path deselects first.
  type Selection = { kind: 'row' | 'col'; index: number } | { kind: 'all' };
  let selection = $state<Selection | null>(null);

  export function deselect(): void {
    selection = null;
  }

  // Crosshair hover: the hovered data cell lights up its whole row and whole
  // column, with a fainter tint than an actual selection. The promoted header
  // row acts like the column-head gutter: hovering it triggers nothing, but it
  // lights along with its column.
  let hover = $state<{ r: number; c: number } | null>(null);

  function cellHovered(r: number, c: number): boolean {
    if (hover === null) {
      return false;
    }
    if (isHeaderCell(r)) {
      return hover.c === c;
    }
    return hover.r === r || hover.c === c;
  }

  // Focusing a cell deselects (the shared convention) and reports the 1-based
  // cell position so the status bar tracks the table cursor.
  function onCellFocus(r: number, c: number): void {
    deselect();
    oncursor(r + 1, c + 1);
  }

  // A selected data cell is any cell in the selected row (or column). Drives the
  // tinted highlight and lets the gutter/header cell wear a stronger tint.
  function cellSelected(r: number, c: number): boolean {
    if (selection === null) {
      return false;
    }
    if (selection.kind === 'all') {
      return true;
    }
    return selection.kind === 'row'
      ? selection.index === r
      : selection.index === c;
  }

  // Clicking a row/column gutter cell toggles its selection; clicking a
  // different one moves it. Focus the root so the scoped key handler receives
  // shortcuts even when no cell input is focused.
  function toggleSelect(kind: 'row' | 'col', index: number): void {
    if (
      selection !== null &&
      selection.kind === kind &&
      selection.index === index
    ) {
      selection = null;
    } else {
      selection = { kind, index };
    }
    rootEl?.focus();
  }

  // Clicking the corner toggles a whole-table selection.
  function toggleSelectAll(): void {
    selection =
      selection !== null && selection.kind === 'all' ? null : { kind: 'all' };
    rootEl?.focus();
  }

  function onCornerKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleSelectAll();
    }
  }

  // Build the clipboard text for the current selection: a whole-table selection
  // becomes the full grid in the tab's delimiter; a row becomes one RFC-quoted
  // record line; a column becomes one RFC-quoted value per line.
  function selectionText(): string {
    if (selection === null) {
      return '';
    }
    if (selection.kind === 'row') {
      return serializeDsv(
        [rowFields(content, index, selection.index, delimiter)],
        delimiter,
      );
    }
    if (selection.kind === 'all') {
      return copyAll(content, index, delimiter);
    }
    return copyColumn(content, index, selection.index, delimiter);
  }

  function emit(change: DsvChange | null): void {
    if (change !== null) {
      onchange([change]);
    }
  }

  function emitAll(changes: DsvChange[]): void {
    if (changes.length > 0) {
      onchange(changes);
    }
  }

  function commitCell(r: number, c: number, value: string): void {
    const current = rowFields(content, index, r, delimiter)[c] ?? '';
    if (value === current) {
      return;
    }
    emit(setCellChange(content, index, r, c, value, delimiter));
  }

  function onCellKeydown(e: KeyboardEvent, r: number, c: number): void {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === 'Enter') {
      // Commit and leave the field; blur runs the commit handler.
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      // Restore the displayed value and leave without committing. Dropping the
      // pending edit is what makes it "without": assigning to `input.value`
      // hands back a copy with any newline stripped, so a blur that still
      // committed would write that stripped copy over a quoted multi-line
      // field — the very thing Escape is there to avoid.
      e.preventDefault();
      pendingEdit = null;
      input.value = rowFields(content, index, r, delimiter)[c] ?? '';
      input.blur();
    }
    // Tab keeps its native focus movement; blur commits the outgoing cell.
  }

  function onCellBlur(e: FocusEvent, r: number, c: number): void {
    const pending = pendingEdit;
    pendingEdit = null;
    // Only a cell that was actually typed into. See `shouldCommitCell`: an
    // `<input>` hands back a copy with any newline stripped, so committing on a
    // bare focus-and-blur deleted a quoted multi-line field's newline with
    // nothing having been edited.
    if (!shouldCommitCell(pending, r, c, index)) {
      return;
    }
    commitCell(r, c, (e.currentTarget as HTMLInputElement).value);
  }

  // Open the menu at a viewport point, clamped so it stays fully on screen.
  // The gutter menus carry one cross-axis item so the table can grow at its
  // edges: the top strip's 'col' menu adds "Insert Row Below" (the strip passes
  // r = -1, so the shared 'row-below' action inserts at index 0; a header cell
  // passes r = 0 and inserts right below the header), and the left gutter's
  // 'row' menu adds "Insert Column Right" (row heads pass c = -1, so
  // 'col-right' inserts at index 0).
  function openMenuAt(
    r: number,
    c: number,
    x: number,
    y: number,
    variant: 'row' | 'col' | 'cell',
  ): void {
    // Opening the menu invalidates any selection (a mutation may follow).
    selection = null;
    const w = 200;
    // Height scales with the visible item count: ~36px per item plus 8px of
    // vertical padding; every variant carries one ~9px group separator.
    const count = variant === 'cell' ? 6 : 4;
    const h = 8 + count * 36 + 9;
    menu = {
      r,
      c,
      variant,
      x: Math.min(x, window.innerWidth - w),
      y: Math.min(y, window.innerHeight - h),
    };
  }

  // A header cell is the promoted first data row while the header toggle is on.
  function isHeaderCell(r: number): boolean {
    return headerRow && r === 0;
  }

  // First click on an unselected header column selects the whole column instead
  // of focusing the input; a second click (column already selected, or caret
  // already in the field) falls through so the title text becomes editable.
  function onHeaderCellPointerDown(e: MouseEvent, c: number): void {
    const input = e.currentTarget as HTMLInputElement;
    if (document.activeElement === input) {
      return;
    }
    const alreadySelected = selection?.kind === 'col' && selection.index === c;
    if (!alreadySelected) {
      e.preventDefault();
      toggleSelect('col', c);
    }
  }

  function onCellContextMenu(e: MouseEvent, r: number, c: number): void {
    e.preventDefault();
    if (isHeaderCell(r)) {
      openMenuAt(0, c, e.clientX, e.clientY, 'col');
    } else {
      openMenuAt(r, c, e.clientX, e.clientY, 'cell');
    }
  }

  function closeMenu(): void {
    menu = null;
  }

  function runMenu(action: string): void {
    const m = menu;
    if (m === null) {
      return;
    }
    switch (action) {
      case 'row-above':
        emit(insertRowChange(content, index, m.r, delimiter));
        break;
      case 'row-below':
        emit(insertRowChange(content, index, m.r + 1, delimiter));
        break;
      case 'row-delete':
        emit(deleteRowChange(content, index, m.r));
        break;
      case 'col-left':
        emitAll(insertColChange(content, index, m.c, delimiter));
        break;
      case 'col-right':
        emitAll(insertColChange(content, index, m.c + 1, delimiter));
        break;
      case 'col-delete':
        emitAll(deleteColChange(content, index, m.c, delimiter));
        break;
    }
    closeMenu();
  }

  function onGutterKeydown(
    e: KeyboardEvent,
    kind: 'row' | 'col',
    index: number,
  ): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleSelect(kind, index);
    }
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    if (menu !== null && e.key === 'Escape') {
      closeMenu();
    }
  }

  // Selection shortcuts, scoped to the table view (this handler lives on the
  // root element, which is focused when a selection is made). Only fires while a
  // selection exists, so ordinary editing keys pass through untouched.
  function onRootKeydown(e: KeyboardEvent): void {
    // Undo/redo route through CM's shared history. This runs before the
    // selection guard and fires for events bubbling from a focused cell input,
    // where preventDefault also suppresses the input's native undo. A cell being
    // edited is blurred first so its pending value commits as its own step.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      const focused = document.activeElement;
      if (
        focused instanceof HTMLInputElement &&
        focused.classList.contains('cell')
      ) {
        focused.blur();
      }
      if (e.shiftKey) {
        onredo();
      } else {
        onundo();
      }
      return;
    }
    if (selection === null) {
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      selection = null;
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      copySelection();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      clearSelection();
    }
  }

  // Automation surface for selection. selectRow/selectCol set (not toggle) so
  // E2E is deterministic; the UI click path toggles via toggleSelect.
  export function selectRow(r: number): void {
    selection = { kind: 'row', index: r };
    rootEl?.focus();
  }

  export function selectCol(c: number): void {
    selection = { kind: 'col', index: c };
    rootEl?.focus();
  }

  export function selectAll(): void {
    selection = { kind: 'all' };
    rootEl?.focus();
  }

  export function getSelection(): Selection | null {
    return selection;
  }

  // Copy the selection to the clipboard and return the exact text written, so
  // E2E can assert without clipboard-read access.
  export function copySelection(): string {
    const text = selectionText();
    void navigator.clipboard.writeText(text);
    return text;
  }

  // Clear the selected row's/column's cell CONTENTS (never removes the line);
  // the selection stays valid since indices do not shift.
  export function clearSelection(): void {
    if (selection === null) {
      return;
    }
    if (selection.kind === 'row') {
      emit(clearRowChange(content, index, selection.index, delimiter));
      return;
    }
    if (selection.kind === 'all') {
      emitAll(clearAllChange(content, index, delimiter));
    } else {
      emitAll(clearColChange(content, index, selection.index, delimiter));
    }
  }

  // Automation surface: open the menu targeting a cell, and report whether it is
  // open. Position is looked up from the live cell (falls back to the origin).
  export async function openMenu(r: number, c: number): Promise<void> {
    const find = (): HTMLElement | null =>
      rootEl?.querySelector<HTMLElement>(
        `.cell[data-r="${r}"][data-c="${c}"]`,
      ) ?? null;
    let cell = find();
    if (cell === null) {
      // Not in the DOM at all: scroll it in first. `lineToScrollTop` is the
      // documented inverse of the window's own mapping; `r * rowHeight` only
      // happens to agree with it.
      scrollEl.scrollTop = lineToScrollTop(
        r,
        rowCount,
        rowHeight,
        contentHeight,
        viewportHeight,
      );
      onGridScroll();
      await tick();
      cell = find();
    }
    const rect = cell?.getBoundingClientRect();
    openMenuAt(r, c, rect?.left ?? 0, rect?.bottom ?? 0, 'cell');
  }

  export function menuOpen(): boolean {
    return menu !== null;
  }

  // Automation/host surface for the header-row toggle (component-local $state).
  export function setHeaderRow(on: boolean): void {
    headerRow = on;
  }

  export function getHeaderRow(): boolean {
    return headerRow;
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet plusIcon()}
  <svg
    viewBox="0 0 24 24"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
{/snippet}

{#snippet menuIcon(kind: 'ins' | 'del', transform: string)}
  <!-- One flat base per shape, reused across all six items via CSS transform:
       insert = a row bar with a plus on the insertion side; delete = the target
       bar carrying an X. Row/column and above/below/left/right come from the
       rotate/scale passed in, so no shape is duplicated. -->
  <svg
    class="menu-icon"
    viewBox="0 0 16 16"
    width="15"
    height="15"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="transform: {transform};"
  >
    {#if kind === 'ins'}
      <rect x="2.5" y="9" width="11" height="4.4" rx="1" />
      <path d="M8 3v4M6 5h4" />
    {:else}
      <rect x="2.5" y="4.6" width="11" height="6.8" rx="1" />
      <path d="M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6" />
    {/if}
  </svg>
{/snippet}

<div
  class="table-view"
  class:dark
  role="grid"
  tabindex="-1"
  bind:this={rootEl}
  onkeydown={onRootKeydown}
  oncontextmenu={(e) => e.preventDefault()}
>
  <div class="toolbar">
    <label class="toggle" title={t('table.headerRow.title')}>
      <input type="checkbox" bind:checked={headerRow} />
      {t('table.headerRow.label')}
    </label>
  </div>
  <div class="grid-scroll" bind:this={scrollEl} onscroll={onGridScroll}>
    <div class="grid-shell">
      <table class="grid" bind:this={gridEl}>
        <tbody>
          {#if !headerRow}
            <!-- Gutter column-head row. Suppressed when the header toggle is on:
                 the promoted first data row becomes the top sticky row instead. -->
            <tr>
              <th
                class="corner"
                class:sel={selection?.kind === 'all'}
                role="button"
                tabindex="-1"
                aria-label={t('table.selectAll')}
                onclick={toggleSelectAll}
                onkeydown={onCornerKeydown}
              ></th>
              {#each colIndexes as c (c)}
                <th
                  class="col-head"
                  class:sel={selection?.kind === 'all' ||
                    (selection?.kind === 'col' && selection.index === c)}
                  class:hov={hover?.c === c}
                  role="button"
                  tabindex="-1"
                  aria-label={t('table.selectCol')}
                  onclick={() => toggleSelect('col', c)}
                  onkeydown={(e) => onGutterKeydown(e, 'col', c)}
                  oncontextmenu={(e) => {
                    e.preventDefault();
                    openMenuAt(-1, c, e.clientX, e.clientY, 'col');
                  }}
                ></th>
              {/each}
            </tr>
          {/if}
          {#each pinnedRows as entry (entry.r)}
            {@render dataRow(entry.r, entry.cells)}
          {/each}
          {#if layout.topSpacer > 0}
            <tr class="vspacer" style="height: {layout.topSpacer}px;"
              ><td colspan={colCount + 1}></td></tr
            >
          {/if}
          {#each windowRows as entry (entry.r)}
            {@render dataRow(entry.r, entry.cells)}
          {/each}
          {#if layout.bottomSpacer > 0}
            <tr class="vspacer" style="height: {layout.bottomSpacer}px;"
              ><td colspan={colCount + 1}></td></tr
            >
          {/if}
          <tr class="append-row">
            <td class="append-cell" colspan={colCount + 1}>
              <button
                class="ins wide"
                tabindex="-1"
                title={t('table.addRow.title')}
                aria-label={t('table.addRow.aria')}
                onclick={() => {
                  selection = null;
                  emit(insertRowChange(content, index, rowCount, delimiter));
                }}
              >
                {@render plusIcon()}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <button
        class="ins col-strip"
        tabindex="-1"
        title={t('table.addCol.title')}
        aria-label={t('table.addCol.aria')}
        onclick={() => {
          selection = null;
          emitAll(insertColChange(content, index, colCount, delimiter));
        }}
      >
        {@render plusIcon()}
      </button>
    </div>
  </div>
</div>

{#snippet dataRow(r: number, row: string[])}
  <tr>
    {#if isHeaderCell(r)}
      <!-- The header row's left gutter cell doubles as the select-all corner;
           a header row has no per-row selection entry. -->
      <th
        class="corner"
        class:sel={selection?.kind === 'all'}
        role="button"
        tabindex="-1"
        aria-label={t('table.selectAll')}
        onclick={toggleSelectAll}
        onkeydown={onCornerKeydown}
      ></th>
    {:else}
      <td
        class="row-head"
        class:sel={selection?.kind === 'all' ||
          (selection?.kind === 'row' && selection.index === r)}
        class:hov={hover?.r === r}
        role="button"
        tabindex="-1"
        aria-label={t('table.selectRow')}
        onclick={() => toggleSelect('row', r)}
        onkeydown={(e) => onGutterKeydown(e, 'row', r)}
        oncontextmenu={(e) => {
          e.preventDefault();
          openMenuAt(r, -1, e.clientX, e.clientY, 'row');
        }}
      ></td>
    {/if}
    {#each colIndexes as c (c)}
      <td
        class:header-cell={isHeaderCell(r)}
        class:sel-cell={cellSelected(r, c)}
        class:hov-cell={cellHovered(r, c)}
        onmouseenter={() => {
          if (!isHeaderCell(r)) {
            hover = { r, c };
          }
        }}
        onmouseleave={() => (hover = null)}
      >
        <input
          class="cell"
          data-r={r}
          data-c={c}
          value={row[c] ?? ''}
          spellcheck="false"
          onfocus={() => onCellFocus(r, c)}
          onmousedown={(e) => {
            if (isHeaderCell(r)) {
              onHeaderCellPointerDown(e, c);
            }
          }}
          oninput={(e) => {
            pendingEdit = {
              r,
              c,
              value: e.currentTarget.value,
              document: index,
            };
          }}
          onkeydown={(e) => onCellKeydown(e, r, c)}
          onblur={(e) => onCellBlur(e, r, c)}
          oncontextmenu={(e) => onCellContextMenu(e, r, c)}
        />
      </td>
    {/each}
  </tr>
{/snippet}

{#if menu !== null}
  <div
    class="menu-backdrop"
    role="presentation"
    onclick={closeMenu}
    oncontextmenu={(e) => {
      e.preventDefault();
      closeMenu();
    }}
  ></div>
  <div
    class="ctx-menu"
    role="menu"
    tabindex="-1"
    style="left: {menu.x}px; top: {menu.y}px;"
  >
    {#if menu.variant !== 'col'}
      <button
        class="ctx-item"
        role="menuitem"
        onclick={() => runMenu('row-above')}
      >
        {@render menuIcon('ins', 'none')}
        {t('table.menu.rowAbove')}
      </button>
      <button
        class="ctx-item"
        role="menuitem"
        onclick={() => runMenu('row-below')}
      >
        {@render menuIcon('ins', 'scaleY(-1)')}
        {t('table.menu.rowBelow')}
      </button>
      <button
        class="ctx-item danger"
        role="menuitem"
        onclick={() => runMenu('row-delete')}
      >
        {@render menuIcon('del', 'none')}
        {t('table.menu.rowDelete')}
      </button>
    {/if}
    {#if menu.variant === 'cell'}
      <div class="ctx-sep"></div>
    {/if}
    {#if menu.variant !== 'row'}
      <button
        class="ctx-item"
        role="menuitem"
        onclick={() => runMenu('col-left')}
      >
        {@render menuIcon('ins', 'rotate(-90deg)')}
        {t('table.menu.colLeft')}
      </button>
      <button
        class="ctx-item"
        role="menuitem"
        onclick={() => runMenu('col-right')}
      >
        {@render menuIcon('ins', 'rotate(90deg)')}
        {t('table.menu.colRight')}
      </button>
      <button
        class="ctx-item danger"
        role="menuitem"
        onclick={() => runMenu('col-delete')}
      >
        {@render menuIcon('del', 'rotate(90deg)')}
        {t('table.menu.colDelete')}
      </button>
    {/if}
    {#if menu.variant === 'col'}
      <div class="ctx-sep"></div>
      <button
        class="ctx-item"
        role="menuitem"
        onclick={() => runMenu('row-below')}
      >
        {@render menuIcon('ins', 'scaleY(-1)')}
        {t('table.menu.rowBelow')}
      </button>
    {/if}
    {#if menu.variant === 'row'}
      <div class="ctx-sep"></div>
      <button
        class="ctx-item"
        role="menuitem"
        onclick={() => runMenu('col-right')}
      >
        {@render menuIcon('ins', 'rotate(90deg)')}
        {t('table.menu.colRight')}
      </button>
    {/if}
  </div>
{/if}

<style>
  .table-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg);
    color: var(--fg);
    --grid-line: var(--topbar-border);
    --gutter-bg: color-mix(in srgb, var(--fg) 5%, var(--bg));
    --cell-focus: var(--accent);
  }
  /* The root is programmatically focused to receive selection shortcuts; no ring. */
  .table-view:focus {
    outline: none;
  }
  .toolbar {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    height: 28px;
    padding: 0 0.6rem;
    border-bottom: 1px solid var(--grid-line);
    font-size: 0.75rem;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    cursor: default;
    user-select: none;
  }
  .toggle input {
    margin: 0;
  }
  .grid-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .grid {
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  .grid th,
  .grid td {
    border: 1px solid var(--grid-line);
    padding: 0;
  }
  /* Stands in for the rows outside the window: just their height. */
  .vspacer td {
    border: none;
  }
  /* First data row promoted to the top sticky header row when the toggle is on:
     bold, tinted, and pinned so it stays above the scrolling data cells. */
  td.header-cell {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--gutter-bg);
  }
  td.header-cell .cell {
    font-weight: 600;
  }
  /* Column-selected header cell wears the same stronger tint as a col-head, and
     must win over its own opaque background (color-mix onto gutter-bg). */
  td.header-cell.sel-cell {
    background: color-mix(in srgb, var(--accent) 32%, var(--gutter-bg));
  }
  .corner {
    position: sticky;
    top: 0;
    left: 0;
    z-index: 3;
    width: 34px;
    background: var(--gutter-bg);
  }
  .col-head {
    position: sticky;
    top: 0;
    z-index: 2;
    height: 22px;
    background: var(--gutter-bg);
    text-align: center;
  }
  .grid-shell {
    position: relative;
    display: inline-block;
    /* Reserve the lane for the vertical append strip on the right. */
    padding-right: 21px;
  }
  .ins.col-strip {
    position: absolute;
    top: 0;
    right: 0;
    /* Stop above the horizontal append bar so the two stay symmetric. */
    bottom: 21px;
    display: flex;
    /* The glyph sticks near the top of the visible lane rather than sitting at
       the middle of it: this strip is as tall as the whole table, so a centred
       glyph on a 270,000-row file sat about three million pixels down and could
       not be clicked at all. */
    align-items: flex-start;
    justify-content: center;
    width: 21px;
    padding: 0;
    border: 1px solid var(--grid-line);
    border-radius: 0;
    background: var(--gutter-bg);
    /* The base .ins opacity would dim the background too (the horizontal bar
       gets its background from the cell instead) — dim only the glyph. */
    opacity: 1;
  }
  .ins.col-strip svg {
    position: sticky;
    top: 4px;
    opacity: 0.4;
  }
  .ins.col-strip:hover {
    background:
      linear-gradient(rgba(127, 127, 127, 0.22), rgba(127, 127, 127, 0.22)),
      var(--gutter-bg);
  }
  .ins.col-strip:hover svg {
    opacity: 1;
  }
  .row-head {
    position: sticky;
    left: 0;
    z-index: 1;
    width: 34px;
    background: var(--gutter-bg);
    text-align: center;
  }
  .grid button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: none;
    color: inherit;
    cursor: default;
  }
  /* Append affordances: a slim ＋ that lifts on hover. */
  .ins {
    opacity: 0.4;
  }
  .ins:hover {
    opacity: 1;
    background: rgba(127, 127, 127, 0.22);
  }
  .append-cell {
    background: var(--gutter-bg);
  }
  .ins.wide {
    width: 100%;
    height: 20px;
    border-radius: 0;
  }
  .cell {
    display: block;
    box-sizing: border-box;
    width: 100%;
    min-width: 96px;
    height: 22px;
    padding: 0 0.35rem;
    border: none;
    outline: none;
    background: none;
    color: inherit;
    font: inherit;
  }
  .cell:focus {
    box-shadow: inset 0 0 0 2px var(--cell-focus);
  }
  /* Selected row/column: a low-alpha accent tint on the data cells, and a
     stronger tint on the driving gutter/header cell. Both use color-mix so the
     result reads consistently in either theme. The focus ring (an inset
     box-shadow) still shows on top of this background. */
  td.sel-cell {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .row-head.sel,
  .col-head.sel,
  .corner.sel {
    background: color-mix(in srgb, var(--accent) 32%, var(--gutter-bg));
  }
  /* Crosshair hover: the hovered cell's whole row and column wear a fainter
     tint than a real selection, and never override one (:not keeps precedence
     order-independent). The matching gutter cells tint a notch stronger. */
  td.hov-cell:not(.sel-cell) {
    background: color-mix(in srgb, var(--accent) 7%, transparent);
  }
  td.header-cell.hov-cell:not(.sel-cell) {
    background: color-mix(in srgb, var(--accent) 7%, var(--gutter-bg));
  }
  .row-head.hov:not(.sel),
  .col-head.hov:not(.sel) {
    background: color-mix(in srgb, var(--accent) 16%, var(--gutter-bg));
  }
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 19;
  }
  .ctx-menu {
    position: fixed;
    z-index: 20;
    display: flex;
    flex-direction: column;
    min-width: 190px;
    padding: 4px;
    border: 1px solid var(--topbar-border);
    border-radius: 7px;
    background: var(--bg);
    color: var(--fg);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
    font-size: 0.8rem;
  }
  .ctx-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 10px;
    border: none;
    border-radius: 4px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    white-space: nowrap;
    cursor: default;
  }
  /* The glyph inherits the item's text color (currentColor) so it tracks the
     theme and the danger hover state. */
  .menu-icon {
    flex: 0 0 auto;
    opacity: 0.75;
  }
  .ctx-item:hover {
    background: var(--topbar-border);
  }
  .ctx-item.danger:hover {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 14%, transparent);
  }
  .ctx-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--topbar-border);
  }
</style>
