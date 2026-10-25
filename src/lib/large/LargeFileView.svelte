<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onDestroy, onMount, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { cssFontFamily } from '../util/font';
  import { Lru } from '../util/lru';
  import {
    computeVisibleWindow,
    fullyVisibleSpan,
    joinSelectedRows,
    lineToScrollTop,
    type SelectedRow,
    scrollAxisHeight,
  } from '../util/largeView';
  import { moveResultCursor, parseGotoRange } from '../util/largeSearch';
  import { detectBreakStyle } from '../util/windowedEdit';
  import { readPageLines, splitLines } from '../util/largePage';
  import {
    RANGE_EDIT_MAX,
    rangeWithinLimit,
    resolveByteRange,
  } from '../util/rangeEdit';
  import { formatFileSize } from '../util/format';
  import {
    canReuseIndex,
    type IndexScanState,
    type LargeIndexRef,
  } from '../util/largeIndex';
  import { t } from '../i18n';
  import FindPanels, { type FindResult } from './FindPanels.svelte';
  import { platform } from '../state/platform.svelte';
  import { isLite } from '../state/edition.svelte';
  import { editionUi } from '../util/editionUi';
  import { shortcutsState } from '../state/shortcuts.svelte';
  import { matchWindowShortcut } from '../util/windowShortcut';

  /** Byte span + line labels of a range selection, handed to the app to edit. */
  export interface RangeExtract {
    startByte: number;
    endByte: number;
    startLine: number;
    endLine: number;
  }

  /** Byte span of a range selection, handed to the app's save-range path. */
  export interface RangeSaveAs {
    startByte: number;
    endByte: number;
    pathOverride?: string;
  }

  interface Props {
    // The tab this view shows; the kept index is reported against it.
    tabId: string;
    path: string;
    size: number;
    fontSize: number;
    fontFamily: string;
    onstatus: (s: LargeStatus) => void;
    // The first chunk's line-ending style (null: no line break in it), so the
    // tab shows the file's own ending instead of the user's default.
    ondetectending: (style: ReturnType<typeof detectBreakStyle>) => void;
    // Resolves null when the range opened in the edit box, or a message to show
    // in the range toolbar when it was refused (e.g. a lossy, non-UTF-8 slice).
    // Rejects on a genuine read failure.
    onextract: (info: RangeExtract) => Promise<string | null>;
    // Resolves true on success (the saved file opens as a new tab), false when
    // the save dialog was cancelled. Rejects on a genuine write failure.
    onsaverange: (info: RangeSaveAs) => Promise<boolean>;
    // Fired once if the background line-index scan fails (open error or a
    // mid-scan I/O error), so the app can surface it via its existing
    // openFailed/revealFailed-style notice.
    onindexerror: () => void;
    // The 0-based line to open scrolled to (the line the tab was left at).
    initialTopLine?: number;
    // The line index this tab kept from an earlier mount, if any. It is reused
    // when the file is unchanged, so coming back to the tab does not rescan.
    indexRef?: LargeIndexRef | undefined;
    // Fired with the index this view started (to keep), or null once a kept
    // one was found stale and dropped.
    onindexchange?: (tabId: string, ref: LargeIndexRef | null) => void;
    // Fired with the first visible line as the view scrolls.
    ontopline?: (line: number) => void;
  }

  export interface LargeStatus {
    totalLines: number | null;
    indexedLines: number;
    firstLine: number;
    indexing: boolean;
    /** A page in view could not be read. Blank lines are what a failed read
     *  renders as, and a blank page is indistinguishable from an empty stretch
     *  of file, so the status bar is where the difference is stated. */
    readFailed: boolean;
  }

  let {
    tabId,
    path,
    size,
    fontSize,
    fontFamily,
    onstatus,
    ondetectending,
    onextract,
    onsaverange,
    onindexerror,
    initialTopLine = 0,
    indexRef,
    onindexchange,
    ontopline,
  }: Props = $props();

  /** Boundary-aligned text slice returned by the Rust `read_chunk` command. */
  interface Chunk {
    text: string;
    start: number;
    end: number;
  }
  /** What the Rust `index_line_count` answers. */
  type IndexStatus =
    | { state: 'running' }
    | { state: 'done'; lines: number }
    | { state: 'failed' };
  /** The Rust `file_fingerprint` answer. */
  interface Fingerprint {
    size: number;
    mtime_ms: number;
  }

  interface IndexProgress {
    id: string;
    lines: number;
    bytes: number;
    done: boolean;
    error: boolean;
  }

  /** A streaming-search match emitted by the Rust `stream_search` command. `line`
   *  is 0-based, matching the line index; the UI shows it 1-based. */
  interface SearchHitPayload {
    search_id: string;
    offset: number;
    line: number;
    preview: string;
  }

  interface SearchDonePayload {
    search_id: string;
    hits: number;
    truncated: boolean;
    error: boolean;
  }

  /** One result row: `line` is 1-based (as displayed and returned to DEV hooks). */
  type SearchResult = FindResult;

  // Bytes read per backend request; also the LRU key grid is line-page based.
  const READ_LEN = 1024 * 1024;
  // Lines grouped into a page; a page is the unit that is loaded and cached.
  const LOAD_PAGE = 400;
  // Resident page cache (~16 pages ≈ a few MB of decoded text).
  const PAGE_CACHE_MAX = 16;
  // Checkpoint spacing handed to the Rust line index.
  const INTERVAL_LINES = 1000;
  // Cap on streaming-search results; the backend stops and reports truncation.
  const SEARCH_MAX = 5000;
  // How long a jumped-to line stays tinted, in milliseconds.
  const HIGHLIGHT_MS = 1200;

  // Equal row height derived from the editor font; line math depends on it being
  // exact, so rows are pinned to this pixel height.
  const lineHeight = $derived(Math.round(fontSize * 1.5));

  let indexId: string | null = null;
  // The kept index being checked for reuse: its progress is heard before it is adopted.
  let candidateId: string | null = null;
  // Set once the app tab owns the index, so a destroy leaves it alive.
  let indexKept = false;
  let destroyed = false;
  let unlisten: UnlistenFn | null = null;
  let unlistenHit: UnlistenFn | null = null;
  let unlistenDone: UnlistenFn | null = null;
  let loadToken = 0;
  let lastPage = -1;
  // Average bytes per line, seeded from the first read; drives the pre-index
  // height estimate and per-page read sizing.
  let avgBytes = 80;
  const pageCache = new Lru<number, string[]>(PAGE_CACHE_MAX);

  let wrap = $state<HTMLDivElement | null>(null);
  let container = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let totalLines = $state<number | null>(null);
  let indexedLines = $state(0);
  let estTotalLines = $state(1);
  let loaded = $state<{ startLine: number; lines: string[] }>({
    startLine: 0,
    lines: [],
  });

  // Goto/search overlays are mutually exclusive: only one is ever open.
  let panel = $state<'none' | 'goto' | 'search'>('none');
  let gotoValue = $state('');
  let panels = $state<ReturnType<typeof FindPanels> | null>(null);
  let searchQuery = $state('');
  let searchCase = $state(false);
  // The query and case the shown results were searched with, for highlighting.
  let resultQuery = $state('');
  let resultCase = $state(false);
  let results = $state<SearchResult[]>([]);
  let cursor = $state(-1);
  let searching = $state(false);
  let searchFinished = $state(false);
  let searchFailed = $state(false);
  let truncated = $state(false);
  // True once the background index scan has failed; keeps the "indexing"
  // status from spinning forever after a failure with no total line count.
  let indexFailed = $state(false);
  // Raised when a page in view could not be read, lowered again the moment a
  // batch loads cleanly. A failed read renders as blank lines, which look no
  // different from an empty stretch of the file.
  let readFailed = $state(false);
  // The 0-based line currently tinted after a jump, or null.
  let highlightLine = $state<number | null>(null);
  // Current line-range selection (0-based inclusive, ordered), or null. `anchor`
  // is the click that started it, so Shift+click extends from there.
  let sel = $state<{ start: number; end: number } | null>(null);
  let anchor = $state<number | null>(null);
  // Hint shown in the range toolbar when extraction is refused (range too big).
  let rangeError = $state('');

  const selCount = $derived(sel === null ? 0 : sel.end - sel.start + 1);
  // Rough pre-extraction size estimate from the seeded average line length; the
  // exact byte span is only known after the async line→offset lookups.
  const selEstBytes = $derived(selCount * avgBytes);
  // Id of the in-flight search; hits/done for any other id are ignored.
  let currentSearchId: string | null = null;
  let highlightTimer: number | null = null;

  const searchStatus = $derived(
    searching
      ? t('large.search.searching', { count: results.length })
      : searchFailed
        ? t('large.search.failed')
        : searchFinished
          ? t('large.search.results', { count: results.length }) +
            (truncated ? t('large.search.truncatedSuffix') : '')
          : '',
  );

  // Precise count once the index finishes, otherwise the running estimate.
  const effectiveTotal = $derived(totalLines ?? estTotalLines);
  // Scroll-axis height, capped so it never exceeds the browser's per-element
  // scroll-height limit; scroll position maps onto it proportionally.
  const spacerHeight = $derived(scrollAxisHeight(effectiveTotal, lineHeight));
  const visible = $derived(
    computeVisibleWindow(
      scrollTop,
      lineHeight,
      viewportHeight,
      effectiveTotal,
      spacerHeight,
      0,
    ),
  );
  // Pin the first-visible row to the current scroll offset, then lay the loaded
  // window out around it at the fixed row height. Local alignment stays exact
  // inside the window while the axis as a whole is proportionally scaled.
  const contentOffset = $derived(
    scrollTop - (visible.firstVisible - loaded.startLine) * lineHeight,
  );

  function publishStatus(): void {
    onstatus({
      totalLines,
      indexedLines,
      firstLine: visible.firstVisible + 1,
      // A failed scan never sets `totalLines`, so without the extra check the
      // status bar would show "indexing…" forever.
      indexing: totalLines === null && !indexFailed,
      readFailed,
    });
  }
  /** Byte offset where `line` begins. Line 0 is trivially 0; otherwise the Rust
   *  index resolves it (scanning from the nearest checkpoint). Resolves null when
   *  the line lies past the file's end; rejects on a real failure. */
  async function lineOffset(line: number): Promise<number | null> {
    if (line <= 0) {
      return 0;
    }
    if (indexId === null) {
      throw new Error('no line index');
    }
    return await invoke<number | null>('line_to_offset', { id: indexId, line });
  }
  /** Like `lineOffset`, but null for a failure too: callers that treat both the
   *  same (a range selection) read it this way. */
  async function lineToOffset(line: number): Promise<number | null> {
    try {
      return await lineOffset(line);
    } catch {
      return null;
    }
  }
  /** Read one page's lines, anchored at its first line's byte offset. The offset
   *  is a line start, so the chunk begins exactly on that line and the first
   *  `LOAD_PAGE` split pieces are whole lines. A page past the end of the file
   *  is empty; null means a read really failed. */
  function readPage(page: number): Promise<string[] | null> {
    return readPageLines(page, LOAD_PAGE, {
      lineToOffset: lineOffset,
      // ponytail: one bounded read per page; a page whose lines exceed the read
      // under-fills and shows blanks until scrolled — fine for a viewer. Bump the
      // multiplier only if very long lines ever leave visible gaps.
      readText: async (offset) => {
        const len = Math.min(
          2 * 1024 * 1024,
          Math.max(READ_LEN, avgBytes * LOAD_PAGE * 2),
        );
        const chunk = await invoke<Chunk>('read_chunk', { path, offset, len });
        return { text: chunk.text, eof: chunk.end >= size };
      },
    });
  }

  async function getPage(page: number): Promise<string[] | null> {
    const cached = pageCache.get(page);
    if (cached !== undefined) {
      return cached;
    }
    const lines = await readPage(page);
    // A page that could not be read is deliberately not cached. The cause is
    // usually momentary -- a volume asleep, a network share that blinked --
    // and nothing in here ever clears the cache, so a cached blank would keep
    // being served long after the file became readable again, until the LRU
    // happened to evict it.
    if (lines !== null) {
      pageCache.set(page, lines);
    }
    return lines;
  }

  /** Ensure the page containing the first visible line (and its neighbours) is
   *  loaded. Reloads only when the visible page changes, so scrolling within a
   *  page is a synchronous reslice. */
  async function syncLoad(): Promise<void> {
    const page = Math.floor(visible.firstVisible / LOAD_PAGE);
    if (page === lastPage) {
      return;
    }
    lastPage = page;
    const token = (loadToken += 1);
    const pages = [page - 1, page, page + 1].filter((p) => p >= 0);
    const parts = await Promise.all(pages.map((p) => getPage(p)));
    if (token !== loadToken) {
      return;
    }
    // Decided per batch rather than per page: the three pages load together,
    // so setting the flag page by page would raise and lower it within one
    // scroll. A batch where every page arrived clears it, which is what makes
    // a momentary failure disappear on its own once the pages are re-read.
    const failed = parts.some((part) => part === null);
    if (failed !== readFailed) {
      readFailed = failed;
      publishStatus();
    }
    loaded = {
      startLine: pages[0]! * LOAD_PAGE,
      lines: parts.map((part) => part ?? []).flat(),
    };
  }

  function onScroll(): void {
    if (container === null) {
      return;
    }
    scrollTop = container.scrollTop;
    publishStatus();
    ontopline?.(visible.firstVisible);
    void syncLoad();
  }

  /** Scroll a line into view at the top of the viewport (used by Cmd+L / DEV). */
  export async function scrollToLine(line: number): Promise<void> {
    if (container === null) {
      return;
    }
    container.scrollTop = lineToScrollTop(
      line,
      effectiveTotal,
      lineHeight,
      spacerHeight,
      viewportHeight,
    );
    scrollTop = container.scrollTop;
    publishStatus();
    await syncLoad();
  }

  /** The text currently rendered in the viewport, for E2E content assertions. */
  export function visibleText(): string {
    const from = visible.firstVisible - loaded.startLine;
    const to = from + visible.visibleCount;
    return loaded.lines.slice(Math.max(0, from), Math.max(0, to)).join('\n');
  }

  /** Tint a line briefly after a jump so the eye can find it. */
  function highlight(line: number): void {
    highlightLine = line;
    if (highlightTimer !== null) {
      clearTimeout(highlightTimer);
    }
    highlightTimer = window.setTimeout(() => {
      highlightLine = null;
      highlightTimer = null;
    }, HIGHLIGHT_MS);
  }

  function clearSelection(): void {
    sel = null;
    anchor = null;
    rangeError = '';
  }

  /** Gutter click: plain click sets a single-line selection (re-clicking the same
   *  start cancels); Shift+click extends the range from the anchor. */
  function onGutterClick(line: number, e: MouseEvent): void {
    rangeError = '';
    if (e.shiftKey && anchor !== null) {
      sel = { start: Math.min(anchor, line), end: Math.max(anchor, line) };
    } else if (anchor === line) {
      clearSelection();
    } else {
      anchor = line;
      sel = { start: line, end: line };
    }
  }

  /** Resolve the current selection to an exact `[startByte, endByte)` span. The
   *  end uses the offset of the line after the last selected line, falling back to
   *  EOF when that line is past the file's end. Returns null when the start offset
   *  can't be resolved (no index / read failure). */
  async function selectionByteRange(): Promise<{
    startByte: number;
    endByte: number;
  } | null> {
    if (sel === null) {
      return null;
    }
    const startOffset = await lineToOffset(sel.start);
    if (startOffset === null) {
      return null;
    }
    const endOffset = await lineToOffset(sel.end + 1);
    return resolveByteRange(startOffset, endOffset, size);
  }
  /** Open the selection in the edit box, refusing (with a hint) when the span
   *  exceeds RANGE_EDIT_MAX. */
  async function triggerRangeEdit(): Promise<void> {
    if (sel === null || !editionUi(isLite()).rangeEdit) {
      return;
    }
    const { start, end } = sel;
    const range = await selectionByteRange();
    if (range === null) {
      // `lineToOffset` answers null for a file that has been moved, deleted or
      // made unreadable since it was indexed. Returning quietly here is what a
      // click on this button looked like when the file was gone: nothing at all.
      rangeError = t('large.range.extractFailed');
      return;
    }
    if (!rangeWithinLimit(range.startByte, range.endByte, RANGE_EDIT_MAX)) {
      rangeError = t('large.range.tooBig', {
        size: formatFileSize(range.endByte - range.startByte),
        max: formatFileSize(RANGE_EDIT_MAX),
      });
      return;
    }
    let refusal: string | null;
    try {
      refusal = await onextract({
        startByte: range.startByte,
        endByte: range.endByte,
        startLine: start + 1,
        endLine: end + 1,
      });
    } catch {
      // A genuine read failure (deleted, permissions, volume gone) is distinct
      // from a refusal: it throws instead of resolving, so it lands here
      // rather than being mistaken for a successful extraction.
      rangeError = t('large.range.extractFailed');
      return;
    }
    // A refused extraction keeps the selection and toolbar up with the reason, so
    // the user can fall back to "save range" without re-selecting.
    if (refusal !== null) {
      rangeError = refusal;
      return;
    }
    clearSelection();
  }

  /** Save the selection straight to a new file, which then opens as a new tab.
   *  Same size ceiling as extraction (the slice is read whole into memory). */
  async function triggerRangeSaveAs(pathOverride?: string): Promise<boolean> {
    const range = await selectionByteRange();
    if (range === null) {
      // Same as the extract path: a resolved-to-null range means the file is no
      // longer readable, which has to be said rather than read as "nothing
      // happened". A missing selection cannot reach here — the toolbar this
      // button lives on only renders while there is one.
      rangeError = t('large.range.saveFailed');
      return false;
    }
    if (!rangeWithinLimit(range.startByte, range.endByte, RANGE_EDIT_MAX)) {
      rangeError = t('large.range.tooBig', {
        size: formatFileSize(range.endByte - range.startByte),
        max: formatFileSize(RANGE_EDIT_MAX),
      });
      return false;
    }
    const info: RangeSaveAs =
      pathOverride === undefined
        ? { startByte: range.startByte, endByte: range.endByte }
        : {
            startByte: range.startByte,
            endByte: range.endByte,
            pathOverride,
          };
    let ok: boolean;
    try {
      ok = await onsaverange(info);
    } catch {
      // A genuine write failure (disk full, permissions, volume gone) is
      // distinct from the user cancelling the dialog: it throws instead of
      // resolving `false`, so it lands here rather than reading as "Cancel".
      rangeError = t('large.range.saveFailed');
      return false;
    }
    if (ok) {
      clearSelection();
    }
    return ok;
  }

  /** Cancel any in-flight search and clear its results. */
  function resetSearch(): void {
    if (currentSearchId !== null) {
      const id = currentSearchId;
      currentSearchId = null;
      void invoke('cancel_search', { searchId: id });
    }
    results = [];
    cursor = -1;
    searching = false;
    searchFinished = false;
    searchFailed = false;
    truncated = false;
  }

  /** Start a fresh streaming search for the current query. Each run gets a unique
   *  id (the Rust cancel flags collide on reused ids), cancelling the previous. */
  function runSearch(): void {
    const query = searchQuery;
    if (query === '') {
      return;
    }
    resetSearch();
    resultQuery = query;
    resultCase = searchCase;
    const id = crypto.randomUUID();
    currentSearchId = id;
    searching = true;
    void invoke('stream_search', {
      path,
      query,
      caseSensitive: searchCase,
      maxResults: SEARCH_MAX,
      searchId: id,
    }).catch(() => {
      if (currentSearchId === id) {
        searching = false;
        searchFailed = true;
      }
    });
  }

  /** Jump to the result at `index`, scrolling it into view and tinting the row. */
  function jumpToResult(index: number): void {
    const r = results[index];
    if (r === undefined) {
      return;
    }
    cursor = index;
    const line = r.line - 1;
    void scrollToLine(line).then(() => highlight(line));
  }

  function stepResult(delta: number): void {
    const next = moveResultCursor(cursor, results.length, delta);
    if (next >= 0) {
      jumpToResult(next);
    }
  }

  // Enter re-searches on a changed query, otherwise advances to the next hit.
  let lastSearched = '';
  function searchOrNext(): void {
    if (searchFinished && searchQuery === lastSearched && results.length > 0) {
      stepResult(1);
    } else {
      lastSearched = searchQuery;
      runSearch();
    }
  }

  function openGoto(): void {
    resetSearch();
    panel = 'goto';
    gotoValue = '';
    requestAnimationFrame(() => panels?.focusGoto());
  }

  function closeGoto(): void {
    if (panel === 'goto') {
      panel = 'none';
    }
  }

  function submitGoto(): void {
    const target = parseGotoRange(gotoValue, effectiveTotal);
    if (target !== null && target.kind === 'line') {
      void scrollToLine(target.line);
    } else if (target !== null) {
      // "A-B" selects the range and scrolls its first line into view.
      anchor = target.range.start;
      sel = { start: target.range.start, end: target.range.end };
      rangeError = '';
      void scrollToLine(target.range.start);
    }
    closeGoto();
  }

  function openSearch(): void {
    panel = 'search';
    requestAnimationFrame(() => panels?.focusQuery());
  }

  function closeSearch(): void {
    resetSearch();
    if (panel === 'search') {
      panel = 'none';
    }
  }

  function onGotoKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeGoto();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submitGoto();
    }
  }

  function onSearchKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepResult(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepResult(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (panels?.isQueryFocused() === true) {
        searchOrNext();
      } else {
        stepResult(1);
      }
    }
  }
  // The rendered rows' text elements, in order.
  function rowTexts(): HTMLElement[] {
    return wrap === null
      ? []
      : Array.from(wrap.querySelectorAll<HTMLElement>('.row .text'));
  }
  // Characters between the start of `el` and a boundary point inside it.
  function offsetIn(el: HTMLElement, node: Node, offset: number): number {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(node, offset);
    return r.toString().length;
  }
  // The rendered rows fully on screen become the selection.
  function selectVisibleRows(): void {
    const sel = document.getSelection();
    if (wrap === null || container === null || sel === null) {
      return;
    }
    const texts = rowTexts();
    // clientHeight leaves out a horizontal scrollbar covering the last row.
    const viewTop = container.getBoundingClientRect().top + container.clientTop;
    // The find panel floats over the bottom rows, full width.
    const panelTop = wrap
      .querySelector('.search-panel')
      ?.getBoundingClientRect().top;
    const span = fullyVisibleSpan(
      texts.map((el) => {
        const r = el.closest('.row')?.getBoundingClientRect();
        return { top: r?.top ?? 0, bottom: r?.bottom ?? 0 };
      }),
      viewTop,
      Math.min(viewTop + container.clientHeight, panelTop ?? Infinity),
    );
    const a = span === null ? undefined : texts[span.first];
    const b = span === null ? undefined : texts[span.last];
    if (a === undefined || b === undefined) {
      return;
    }
    const next = document.createRange();
    next.setStart(a, 0);
    next.setEnd(b, b.childNodes.length);
    sel.removeAllRanges();
    sel.addRange(next);
  }
  // A native select-all (keyboard) starts before the viewer and ends at or
  // after the last rendered row; narrow it to the rows fully on screen.
  function onSelectionChange(): void {
    const sel = document.getSelection();
    if (wrap === null || container === null || sel === null) {
      return;
    }
    if (sel.rangeCount === 0 || sel.isCollapsed) {
      return;
    }
    const range = sel.getRangeAt(0);
    const texts = rowTexts();
    const lastText = texts[texts.length - 1];
    if (lastText === undefined) {
      return;
    }
    const root = document.createRange();
    root.selectNode(wrap);
    // Chromium ends a select-all inside the last text node, WebKit after it.
    const endNode = lastText.lastChild ?? lastText;
    const endOffset =
      endNode.nodeType === Node.TEXT_NODE
        ? (endNode.textContent ?? '').length
        : endNode.childNodes.length;
    if (
      range.compareBoundaryPoints(Range.START_TO_START, root) >= 0 ||
      range.comparePoint(endNode, endOffset) !== 0
    ) {
      return;
    }
    selectVisibleRows();
  }
  // Copies the selected rows' text only: a multi-row selection otherwise
  // carries the gutter numbers in WebKit.
  function onCopy(e: ClipboardEvent): void {
    const sel = document.getSelection();
    if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) {
      return;
    }
    const range = sel.getRangeAt(0);
    const rows: SelectedRow[] = [];
    for (const el of rowTexts()) {
      if (!range.intersectsNode(el)) {
        continue;
      }
      const len = el.textContent?.length ?? 0;
      const row: SelectedRow = { text: el.textContent ?? '' };
      if (el.contains(range.startContainer)) {
        row.from = offsetIn(el, range.startContainer, range.startOffset);
      }
      if (el.contains(range.endContainer)) {
        row.to = offsetIn(el, range.endContainer, range.endOffset);
      }
      // A boundary touching a non-empty row without selecting from it.
      if (len > 0 && ((row.from ?? 0) >= len || row.to === 0)) {
        continue;
      }
      rows.push(row);
    }
    if (rows.length === 0 || e.clipboardData === null) {
      return;
    }
    e.preventDefault();
    e.clipboardData.setData('text/plain', joinSelectedRows(rows));
  }
  // The shortcut registry's `goto-line` key opens goto. Cmd/Ctrl+F is a native
  // menu accelerator (it never reaches this listener), so DocumentApp routes it
  // to `openSearch` instead.
  function onWindowKeydown(e: KeyboardEvent): void {
    const accel = shortcutsState.accel('goto-line');
    if (accel !== null && matchWindowShortcut(e, accel, platform.os)) {
      e.preventDefault();
      openGoto();
    }
  }

  // DEV/automation surface, driven by DocumentApp's hooks.
  export function largeGotoOpen(): void {
    openGoto();
  }
  export function largeGotoVisible(): boolean {
    return panel === 'goto';
  }
  export function largeGoto(line: number): void {
    void scrollToLine(Math.max(0, Math.round(line) - 1));
  }
  // Edit > Select All (the macOS item is custom): the rows fully on screen, the
  // same rows the narrowing above picks.
  export function selectAllVisible(): void {
    selectVisibleRows();
  }
  export function largeSearchOpen(): void {
    openSearch();
  }
  export function largeSearchVisible(): boolean {
    return panel === 'search';
  }
  export function largeSearch(query: string, caseSensitive: boolean): void {
    searchQuery = query;
    searchCase = caseSensitive;
    lastSearched = query;
    runSearch();
  }
  export function largeSearchResults(): SearchResult[] {
    return results.map((r) => ({ line: r.line, preview: r.preview }));
  }
  export function largeSearchDone(): boolean {
    return searchFinished;
  }
  export function largeSearchJump(index: number): void {
    jumpToResult(index);
  }
  export function largeSearchClose(): void {
    closeSearch();
  }
  export function largeSelectRange(startLine: number, endLine: number): void {
    const s = Math.max(0, Math.round(startLine) - 1);
    const e = Math.max(0, Math.round(endLine) - 1);
    anchor = s;
    sel = { start: Math.min(s, e), end: Math.max(s, e) };
    rangeError = '';
  }
  export function largeGetRange(): {
    startLine: number;
    endLine: number;
  } | null {
    return sel === null
      ? null
      : { startLine: sel.start + 1, endLine: sel.end + 1 };
  }
  export function largeRangeEdit(): void {
    void triggerRangeEdit();
  }
  export function largeRangeSaveAs(targetPath: string): Promise<boolean> {
    return triggerRangeSaveAs(targetPath);
  }
  /** The scan ended without a line count: stop the "indexing" status and tell
   *  the app once. */
  function failIndex(): void {
    if (indexFailed) {
      return;
    }
    indexFailed = true;
    onindexerror();
  }
  /** The scan ended with `lines` lines. A finish heard while the view is open
   *  rescales the axis from the estimate to the precise count, so the scroll is
   *  re-anchored to keep the line at the top of the viewport where it is. */
  function finishIndex(lines: number, reanchor: boolean): void {
    indexedLines = lines;
    const anchorLine = visible.firstVisible;
    totalLines = lines;
    if (reanchor && container !== null) {
      const height = scrollAxisHeight(lines, lineHeight);
      container.scrollTop = lineToScrollTop(
        anchorLine,
        lines,
        lineHeight,
        height,
        viewportHeight,
      );
      scrollTop = container.scrollTop;
    }
  }

  async function readStatus(id: string): Promise<IndexStatus | null> {
    try {
      return await invoke<IndexStatus>('index_line_count', { id });
    } catch {
      // The id is gone on the Rust side.
      return null;
    }
  }

  function scanState(status: IndexStatus | null): IndexScanState {
    return status === null ? 'unknown' : status.state;
  }
  /** Reuse the index this tab kept when the file is unchanged, otherwise
   *  (re)build it. The index id and the file's size and mtime from before the
   *  scan go back to the tab, which keeps them across unmounts. */
  async function resolveIndex(
    id: string,
    kept: LargeIndexRef | undefined,
  ): Promise<void> {
    let current: { size: number; mtimeMs: number } | null = null;
    try {
      const f = await invoke<Fingerprint>('file_fingerprint', { path });
      current = { size: f.size, mtimeMs: f.mtime_ms };
    } catch {
      current = null;
    }
    if (destroyed) {
      return;
    }
    if (kept !== undefined) {
      candidateId = kept.id;
      const status = await readStatus(kept.id);
      candidateId = null;
      if (canReuseIndex(kept, current, scanState(status))) {
        indexId = kept.id;
        indexKept = true;
        if (status?.state === 'done') {
          finishIndex(status.lines, false);
        }
        return;
      }
      void invoke('drop_line_index', { id: kept.id });
      onindexchange?.(id, null);
    }
    try {
      indexId = await invoke<string>('start_line_index', {
        path,
        intervalLines: INTERVAL_LINES,
      });
    } catch {
      indexId = null;
    }
    if (indexId === null) {
      return;
    }
    if (current !== null) {
      indexKept = true;
      onindexchange?.(id, { id: indexId, ...current });
    } else if (destroyed) {
      void invoke('drop_line_index', { id: indexId });
    }
    // The progress events may have gone by before the id was known.
    const status = await readStatus(indexId);
    if (status?.state === 'done') {
      finishIndex(status.lines, true);
    } else if (status?.state === 'failed') {
      failIndex();
    }
  }

  onMount(() => {
    let disposed = false;
    // The tab at mount time: the prop moves on when the view is reused.
    const mountedTabId = tabId;
    const startLine = initialTopLine;
    const kept = indexRef;
    let observer: ResizeObserver | null = null;
    // Only mounted while a large tab is active, so this shortcut never fires in
    // the normal editor (which has no LargeFileView).
    window.addEventListener('keydown', onWindowKeydown);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('copy', onCopy);
    if (container !== null) {
      // Keep the visible-line math and status in step with the pane height.
      observer = new ResizeObserver(() => {
        if (container !== null) {
          viewportHeight = container.clientHeight;
          publishStatus();
        }
      });
      observer.observe(container);
    }
    void (async (): Promise<void> => {
      if (container !== null) {
        viewportHeight = container.clientHeight;
      }
      // Subscribe before looking at the index, so a scan that ends while it is
      // being resolved is still heard (and one that ended earlier is read back
      // from its status).
      unlisten = await listen<IndexProgress>('large-index-progress', (e) => {
        if (e.payload.id !== indexId && e.payload.id !== candidateId) {
          return;
        }
        indexedLines = e.payload.lines;
        if (e.payload.done && e.payload.error) {
          failIndex();
        } else if (e.payload.done) {
          finishIndex(e.payload.lines, true);
        }
        publishStatus();
      });
      if (disposed) {
        return;
      }
      await resolveIndex(mountedTabId, kept);
      if (disposed) {
        return;
      }
      unlistenHit = await listen<SearchHitPayload>('large-search-hit', (e) => {
        if (e.payload.search_id !== currentSearchId) {
          return;
        }
        results.push({ line: e.payload.line + 1, preview: e.payload.preview });
      });
      unlistenDone = await listen<SearchDonePayload>(
        'large-search-done',
        (e) => {
          if (e.payload.search_id !== currentSearchId) {
            return;
          }
          searching = false;
          if (e.payload.error) {
            searchFailed = true;
          } else {
            searchFinished = true;
            truncated = e.payload.truncated;
          }
        },
      );
      // Seed the average line length from the first read so the height estimate
      // and page sizing are grounded before the index finishes.
      try {
        const first = await invoke<Chunk>('read_chunk', {
          path,
          offset: 0,
          len: READ_LEN,
        });
        const lines = splitLines(first.text, first.end >= size);
        const newlines = Math.max(1, lines.length - 1);
        avgBytes = Math.max(
          1,
          Math.round((first.end - first.start) / newlines),
        );
        estTotalLines = Math.max(1, Math.round(size / avgBytes));
        pageCache.set(0, lines.slice(0, LOAD_PAGE));
        if (!disposed) {
          ondetectending(detectBreakStyle(first.text));
        }
      } catch {
        // Leave the defaults; a failed read just yields an empty view.
      }
      if (disposed) {
        return;
      }
      lastPage = -1;
      if (startLine > 0) {
        // The axis height follows the line count, which only reaches the DOM
        // after a tick; scrolling before it would be clamped to the old height.
        await tick();
        await scrollToLine(startLine);
      } else {
        await syncLoad();
      }
      publishStatus();
    })();
    return () => {
      disposed = true;
      destroyed = true;
      observer?.disconnect();
      window.removeEventListener('keydown', onWindowKeydown);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('copy', onCopy);
    };
  });

  onDestroy(() => {
    unlisten?.();
    unlistenHit?.();
    unlistenDone?.();
    if (highlightTimer !== null) {
      clearTimeout(highlightTimer);
    }
    if (currentSearchId !== null) {
      void invoke('cancel_search', { searchId: currentSearchId });
    }
    if (indexId !== null && !indexKept) {
      // The Rust index is not garbage-collected; release it explicitly. One the
      // tab keeps is released by the tab when it closes.
      void invoke('drop_line_index', { id: indexId });
    }
  });
</script>

<div
  bind:this={wrap}
  class="large-wrap"
  style="--doc-font-size: {fontSize}px; --doc-font-family: {cssFontFamily(
    fontFamily,
  )}; --line-height: {lineHeight}px;"
>
  <div bind:this={container} class="large" onscroll={onScroll}>
    <div class="spacer" style="height: {spacerHeight}px;">
      <div class="content" style="transform: translateY({contentOffset}px);">
        {#each loaded.lines as text, i (loaded.startLine + i)}
          <div
            class="row"
            class:hl={loaded.startLine + i === highlightLine}
            class:sel={sel !== null &&
              loaded.startLine + i >= sel.start &&
              loaded.startLine + i <= sel.end}
          >
            <button
              type="button"
              class="gutter"
              title={t('large.gutter.title')}
              onclick={(e) => onGutterClick(loaded.startLine + i, e)}
            >
              {loaded.startLine + i + 1}
            </button>
            <span class="text">{text}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>

  {#if sel !== null}
    <div class="range-bar cm-panel">
      <span class="range-info"
        >{t('large.range.info', {
          start: sel.start + 1,
          end: sel.end + 1,
          count: selCount,
          size: formatFileSize(selEstBytes),
        })}</span
      >
      {#if editionUi(isLite()).rangeEdit}
        <button class="cm-button" onclick={() => void triggerRangeEdit()}
          >{t('large.range.edit')}</button
        >
      {/if}
      <button class="cm-button" onclick={() => void triggerRangeSaveAs()}
        >{t('large.range.saveAs')}</button
      >
      <button class="cm-button" onclick={clearSelection}
        >{t('common.cancel')}</button
      >
      {#if rangeError !== ''}
        <span class="range-error">{rangeError}</span>
      {/if}
    </div>
  {/if}

  <FindPanels
    bind:this={panels}
    {panel}
    bind:gotoValue
    ongotokeydown={onGotoKeydown}
    bind:query={searchQuery}
    bind:caseSensitive={searchCase}
    status={searchStatus}
    {results}
    {cursor}
    {resultQuery}
    {resultCase}
    onsearch={searchOrNext}
    onjump={jumpToResult}
    onclose={closeSearch}
    onsearchkeydown={onSearchKeydown}
  />
</div>

<style>
  .large-wrap {
    position: relative;
    height: 100%;
  }
  .large {
    height: 100%;
    overflow: auto;
    background: var(--bg);
    color: var(--fg);
    font-size: var(--doc-font-size);
    font-family: var(--doc-font-family);
    line-height: var(--line-height);
  }
  .spacer {
    position: relative;
    width: 100%;
  }
  .content {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    will-change: transform;
  }
  .row {
    display: flex;
    height: var(--line-height);
    white-space: pre;
  }
  .row.hl {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    transition: background 0.4s ease;
  }
  /* Selected range rows: a lighter tint than the jump highlight, following the
     same accent color-mix convention. */
  .row.sel {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .gutter {
    flex: 0 0 auto;
    box-sizing: border-box;
    min-width: 3.5rem;
    height: var(--line-height);
    padding: 0 0.6rem;
    text-align: right;
    opacity: 0.5;
    user-select: none;
    border: none;
    border-right: 1px solid var(--topbar-border);
    background: none;
    color: inherit;
    font: inherit;
    line-height: var(--line-height);
    cursor: default;
  }
  .gutter:hover {
    opacity: 0.85;
    background: rgba(127, 127, 127, 0.15);
  }
  .text {
    flex: 1 1 auto;
    padding: 0 0.6rem;
  }
  /* Floating range toolbar, top-left (mirroring the top-right goto box), shown
     while a line range is selected. */
  .range-bar {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    max-width: calc(100% - 16px);
    padding: 6px 8px;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--topbar-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }
  .range-info {
    font-size: 0.8rem;
    opacity: 0.8;
  }
  .range-error {
    flex-basis: 100%;
    font-size: 0.78rem;
    color: var(--danger);
  }
</style>
