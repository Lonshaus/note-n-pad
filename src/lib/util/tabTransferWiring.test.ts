// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Source checks for the wiring of a tab transfer. Components are not mounted in
// these tests, so what the document window, the editors and the dialogs have to
// do for a tab on its way is read from their files.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
function read(...parts: string[]): string {
  return readFileSync(join(here, '..', ...parts), 'utf8');
}
const app = read('..', 'DocumentApp.svelte');
const editor = read('editor', 'DocumentEditor.svelte');
const windowed = read('windowed', 'WindowedEditor.svelte');
const large = read('large', 'LargeFileView.svelte');
const gate = read('state', 'closeGate.svelte.ts');
const missing = read('state', 'missingFiles.svelte.ts');
const state = read('state', 'documentWindow.svelte.ts');
/** The text of the function whose declaration starts with `head`, up to the
 *  closing brace at the same indent. */
function body(source: string, head: string): string {
  const at = source.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  const indent = /^ */.exec(source.slice(source.lastIndexOf('\n', at) + 1))![0];
  const end = source.indexOf(`\n${indent}}`, at);
  expect(end, head).toBeGreaterThan(-1);
  return source.slice(at, end);
}

describe('the editor', () => {
  it('exports the lock of a tab, which reconfigures the editable compartment as a paste does', () => {
    expect(editor).toContain('export function showLock(');
    expect(body(editor, 'export function showLock(')).toContain(
      'showTabLock(id, lock)',
    );
    expect(body(editor, 'function showTabLock(')).toContain(
      'editableCompartment.reconfigure(',
    );
    // The paste host's own lock is the same function.
    expect(editor).toContain(
      'showLock: (id: string, lock: PasteLock | undefined) =>',
    );
    expect(editor).toContain('showTabLock(id, lock)');
  });

  it('exports its state and its scroll for a tab', () => {
    expect(editor).toContain(
      'export function editorStateOf(id: string): EditorState | null',
    );
    expect(editor).toContain(
      'export function scrollOf(id: string): ScrollRecord | null',
    );
  });

  it('reads the scroll of a tab that is not shown from the plain record, not the snapshot effect', () => {
    const scrollOf = body(
      editor,
      'export function scrollOf(id: string): ScrollRecord | null {',
    );
    expect(scrollOf).toContain('scrollRecords.get(id)');
    expect(scrollOf).not.toContain('scrolls.');
  });

  it('stores the plain scroll record where it sets the snapshot effect', () => {
    const at = editor.indexOf('scrolls.set(mountedId, captureScroll(view));');
    expect(at).toBeGreaterThan(-1);
    const next = editor.slice(at, at + 200);
    expect(next).toContain(
      'scrollRecords.set(mountedId, scrollRecordOf(view))',
    );
    expect(editor).toContain('scrollRecords.delete(key);');
  });

  it('starts from the seed of a moved tab, on its first mount and on a switch', () => {
    const mount = body(editor, '  onMount(() => {');
    expect(mount.indexOf('seeded(activeId, content)')).toBeGreaterThan(-1);
    expect(mount.indexOf('seeded(activeId, content)')).toBeLessThan(
      mount.indexOf('buildState(content, activeId)'),
    );
    const swap = editor.slice(
      editor.indexOf('const saved = states.get(id);'),
      editor.indexOf('view.setState(incoming);'),
    );
    expect(swap).toContain('seeded(id, content)');
    expect(swap).toContain('buildState(content, id)');
    // The seed is read only for a tab that has no saved state.
    expect(swap).toContain('saved === undefined');
  });

  it('reacts only to reloads after it mounted, so a seeded document keeps its history', () => {
    expect(editor).toContain('let reloadsSeen = untrack(() => reloadSeq);');
    const reload = editor.slice(
      editor.indexOf('let reloadsSeen'),
      editor.indexOf('// Live language change on the active tab'),
    );
    expect(reload).toContain('seq === reloadsSeen');
    expect(reload).not.toContain('seq === 0');
  });

  it('builds every state from one list of extensions', () => {
    expect(editor).toContain('function extensionsFor(id: string): Extension');
    expect(editor).toContain('extensions: extensionsFor(id)');
    expect(editor).toContain(
      'seededState(seed.editor, doc, extensionsFor(id))',
    );
  });

  it('applies a seeded scroll in the measure pass instead of dispatching a snapshot', () => {
    expect(editor).toContain('applyScrollRecord(view, seed.scroll)');
  });
});

describe('the windowed editor', () => {
  it('drops input and does nothing for undo, redo and replace while frozen', () => {
    expect(windowed).toContain('frozen?: boolean;');
    expect(body(windowed, 'function isReadOnly()')).toContain('frozen ||');
    expect(body(windowed, "function runUndo(dir: 'undo' | 'redo')")).toContain(
      'frozen',
    );
    for (const head of [
      'async function replaceOne(fromList = false)',
      'async function replaceAll()',
    ]) {
      expect(body(windowed, head)).toMatch(/\{\s+if \(frozen\) \{\s+return;/);
    }
    // A swap does not make it editable again.
    expect(windowed).toContain(
      'readOnlyExtension(frozen || !swapKeepsInput())',
    );
  });

  it('takes the input again when it is unfrozen', () => {
    expect(windowed).toContain('void frozen;');
    expect(windowed).toContain('untrack(syncReadOnly)');
  });

  it('and the views cancel their searches when they go', () => {
    // The cleanup of its mount, which ends in destroying the view.
    const last = windowed.lastIndexOf('view.destroy();');
    const cleanup = windowed.slice(
      windowed.lastIndexOf('return () => {', last),
      last,
    );
    expect(cleanup).toContain('cancelSearch();');
    expect(large).toContain(
      "invoke('cancel_search', { searchId: currentSearchId })",
    );
  });
});

describe('the document window', () => {
  it('gives the editor the seed and the hooks the window state needs of it', () => {
    expect(app).toContain('bind:this={editorRef}');
    const host = body(app, 'documentWindow.transferHost = {');
    expect(host).toContain('editorRef?.showLock(id, lock)');
    expect(host).toContain('editorRef?.editorStateOf(id)');
    expect(host).toContain('editorRef?.scrollOf(id)');
    expect(host).toContain('viewModes.get(id)');
    expect(host).toContain('viewModes.set(id, mode)');
    expect(host).toContain('dropGeometry: () => currentGeometry()');
    expect(app).toContain('takeSeed={(id) => documentWindow.takeSeed(id)}');
    expect(app).toContain(
      'onseeded={(id, doc) => documentWindow.seededDoc(id, doc)}',
    );
    expect(app).toContain('frozen={active.transferring === true}');
  });

  it('tells the state what keeps a tab from being dragged, a close and a quit included', () => {
    const host = body(app, 'documentWindow.dragHost = {');
    expect(host).toContain('closing: () => gate.closing');
    expect(host).toContain('quitting: () => gate.quitting');
  });

  it('asks the menu gate before anything else runs', () => {
    const run = body(app, 'function runMenuAction(action: string): void {');
    expect(run).toMatch(
      /^function runMenuAction\(action: string\): void \{\s+\/\/ [^\n]*\n\s+if \(!menuActionAllowed\(action, active\?\.transferring === true\)\) \{\s+return;/,
    );
  });

  it('does not change the view mode of a tab on its way', () => {
    expect(body(app, 'function setViewMode(mode: ViewMode): void {')).toContain(
      'active.transferring === true',
    );
  });

  it('dims a tab on its way', () => {
    expect(app).toContain('class:dim={tab.transferring === true');
  });

  it('sends every release to the window state, which asks the core', () => {
    const up = body(app, 'function onTabPointerUp(e: PointerEvent): void {');
    expect(up).toContain('documentWindow.releaseTab(tab, {');
    expect(up).not.toContain('documentWindow.moveTab(');
  });

  it('registers the transfer listeners before it announces itself', () => {
    const listeners = app.indexOf('const transferListeners = Promise.all([');
    expect(listeners).toBeGreaterThan(-1);
    for (const event of ['in', 'release', 'cancel', 'abort']) {
      expect(app).toContain(`TRANSFER_EVENT.${event}`);
    }
    expect(app).toContain('documentWindow.transferListening = true;');
    const announce = app.indexOf('await announceReady();');
    expect(announce).toBeGreaterThan(app.indexOf('await transferListeners;'));
    expect(app.indexOf('await transferListeners;')).toBeGreaterThan(-1);
  });

  it('hands a queued transfer to the receiver', () => {
    const ready = body(
      app,
      'const announceReady = async (): Promise<void> => {',
    );
    expect(ready).toContain('item.kind === QUEUED_TRANSFER');
    expect(ready).toContain('incomingTransfers.take(item.value)');
  });

  it('reveals a window made for a tab only once the tab is in it', () => {
    expect(app).toContain("params.get('receive') === '1'");
    expect(app).toMatch(/if \(!receive\) \{\s+void revealWhenThemed\(\);/);
    expect(app).toContain('receive ? revealWhenThemed()');
    expect(app).toContain("invoke('reveal_self')");
  });

  it('checks the missing files, and keeps its bounds, when a tab arrives', () => {
    const arrived = body(app, 'arrived: (tab) => {');
    expect(arrived).toContain('missing.enqueue(tab)');
    expect(arrived).toContain('void missing.check()');
    expect(arrived).toContain('captureBounds()');
  });

  it('lets a rename reach the tabs claimed and not yet copies', () => {
    expect(app).toContain(
      'incomingTransfers.retargetPaths(event.payload.from, event.payload.to)',
    );
  });

  it('ends the handoff of a tab however the handoff ended', () => {
    const handoff = body(app, 'async function openHandoff(handoffId: number)');
    expect(handoff).toMatch(
      /finally \{\s+documentWindow\.endHandingOver\(tabId\)/,
    );
  });

  it('closes only through the helper that settles the transfers', () => {
    // Every `destroy()` of the window sits in the finish of `closeDocumentWindow`.
    const found = [...app.matchAll(/destroy\(\)/g)];
    expect(found.length).toBeGreaterThan(0);
    for (const match of found) {
      const before = app.slice(Math.max(0, match.index! - 90), match.index);
      expect(before).toContain('closeDocumentWindow(documentWindow, () =>');
    }
    for (const source of [gate, missing, state]) {
      expect(source).not.toMatch(/destroy\(\)/);
    }
    // The window close of the gate lets go of what it held when it fails.
    const close = body(
      app,
      'async function finishWindowClose(): Promise<void> {',
    );
    expect(close).toContain('closeDocumentWindow(');
    expect(close).toContain('gate.abandonClose()');
    expect(close).toContain("invoke('confirm_close'");
  });

  it('reads every "window is empty" check from `isEmpty`', () => {
    const legacy = [...app.matchAll(/documentWindow\.tabs\.length === 0/g)];
    // Only the blank tab a new window starts with, before anything can arrive.
    expect(legacy).toHaveLength(1);
    expect(app.slice(legacy[0]!.index! - 30, legacy[0]!.index!)).toContain(
      'startBlank &&',
    );
    expect(
      [...app.matchAll(/documentWindow\.isEmpty/g)].length,
    ).toBeGreaterThanOrEqual(6);
    expect(body(app, 'async function finishTabClose(')).toContain(
      'documentWindow.isEmpty && !keepWindow',
    );
  });

  it('closes a tab by the tab it was asked for', () => {
    const close = body(app, 'async function finishTabClose(');
    expect(close).toContain('documentWindow.tabs.indexOf(tab)');
    expect(close).not.toContain('documentWindow.activeIndex');
  });
});

describe('the dialogs', () => {
  it('act on the tab they were raised for', () => {
    expect(gate).toContain('private target: DocTab | null = null;');
    expect(gate).toContain('this.win.saveTab(target)');
    expect(gate).toContain('this.win.saveAsTab(target)');
    expect(gate).toContain('this.win.discardWindowed(target)');
    expect(gate).toContain(
      'this.win.discardChanges(this.win.tabs.indexOf(target))',
    );
    expect(gate).toContain('this.host.finishTabClose(this.target)');
    expect(gate).not.toContain('saveActive');
    expect(gate).not.toContain('activeIndex');
    expect(missing).toContain('private closeTarget');
    expect(missing).toContain('this.win.saveTab(tab)');
    expect(missing).not.toContain('this.win.saveActive()');
  });

  it('settle the transfers before they scan', () => {
    const quit = body(gate, '  async onFlushRequest(): Promise<void> {');
    expect(quit.indexOf('settleTransfers()')).toBeGreaterThan(-1);
    expect(quit.indexOf('settleTransfers()')).toBeLessThan(
      quit.indexOf('knownBlocking()'),
    );
    const close = body(gate, '  async onCloseFlushRequest(): Promise<void> {');
    expect(close.indexOf('settleTransfers()')).toBeGreaterThan(-1);
    expect(close.indexOf('settleTransfers()')).toBeLessThan(
      close.indexOf('knownBlocking()'),
    );
  });

  it('clear `closing` in exactly the places the plan names', () => {
    const clears = [...gate.matchAll(/this\.closingNow = false/g)];
    // `hide()`, the three veto branches of a quit, and `abandonClose()`.
    expect(clears).toHaveLength(5);
    expect(body(gate, '  onFlushCancelled(): void {')).not.toContain(
      'closingNow',
    );
    expect(body(gate, '  private hide(): void {')).toContain(
      'this.closingNow = false',
    );
    expect(
      body(gate, '  async onCloseFlushRequest(): Promise<void> {'),
    ).toContain('this.closingNow = true');
  });
});

const main = read('..', 'main.ts');
const reveal = read('util', 'reveal.ts');

describe('a tab torn off its bar', () => {
  it('never selects text: the press is prevented before the lock guard', () => {
    const down = body(
      app,
      'function onTabPointerDown(e: PointerEvent, index: number): void {',
    );
    const prevented = down.indexOf(
      'if (e.button === 0) {\n      e.preventDefault();',
    );
    expect(prevented).toBeGreaterThan(-1);
    expect(prevented).toBeLessThan(down.indexOf('documentWindow.dragLocked()'));
    // The range box keeps its own branch.
    expect(down).toContain('if (keepsBoxFocus(rangeBoxOpen)) {');
  });

  it('leaves the pointer to the core once the tab is out: no move, no hover command', () => {
    const move = body(
      app,
      'function onTabPointerMove(e: PointerEvent): void {',
    );
    expect(move.indexOf('if (isFollowing(dragState)) {')).toBeLessThan(
      move.indexOf('feedDrag({'),
    );
    expect(move).not.toContain('tab_drag_hover');
    const start = body(app, '  async function startTearOff(');
    expect(start).not.toContain('tab_drag_hover');
    // The hover command is sent from the frame handler only, which sends
    // nothing for a drag that is not `dragging`.
    expect([...app.matchAll(/invoke\('tab_drag_hover'/g)]).toHaveLength(1);
    expect(body(app, 'function onHoverFrame(): void {')).toContain(
      "dragging: dragState.phase === 'dragging',",
    );
  });

  it('ends the page hover before the core is asked, and asks the one that fits', () => {
    const start = body(app, '  async function startTearOff(');
    const ended = start.indexOf('await endHover();');
    expect(ended).toBeGreaterThan(-1);
    expect(ended).toBeLessThan(start.indexOf('documentWindow.detachTab('));
    expect(ended).toBeLessThan(start.indexOf('await followWindow('));
    expect(start).toContain("kind === 'detach'");
    expect(body(app, '  async function followWindow(')).toContain(
      "'tab_window_follow_start'",
    );
    // A refusal puts the drag back, so the release behaves as it always did.
    expect(start).toContain("feedDrag({ kind: 'notStarted' })");
  });

  it('holds Esc until the start has answered, then tells the core', () => {
    const start = body(app, '  async function startTearOff(');
    expect(start).toContain('() => pendingTearOffCancel');
    expect(start.indexOf('tearOffStarted = true;')).toBeLessThan(
      start.indexOf('sendTearOffCancel(id);'),
    );
    const dispatch = body(
      app,
      'function dispatchTearOffCancel(id: string): void {',
    );
    expect(dispatch).toContain('if (tearOffStarted) {');
    expect(dispatch).toContain('pendingTearOffCancel = true;');
    expect(
      body(app, 'function sendTearOffCancel(id: string): void {'),
    ).toContain("'tab_tearoff_cancel'");
  });

  it('tells the core the button went up and gives the range box its focus on every exit', () => {
    const up = body(app, 'function onTabPointerUp(e: PointerEvent): void {');
    expect(up).toContain("outcome?.kind === 'releaseSeen'");
    expect(up).toContain("'tab_tearoff_release_seen'");
    expect(up).toContain('(outcome !== null || following) && rangeBoxOpen');
    const cancel = body(
      app,
      'function cancelDrag(reason: CancelReason): void {',
    );
    expect(cancel).toContain('(outcome !== null || following) && rangeBoxOpen');
    expect(cancel).toContain('dispatchTearOffCancel(outcome.id)');
    expect(body(app, 'function afterDragExit(): void {')).toContain(
      'focusActiveEditor();',
    );
  });

  it('takes its events with the other transfer listeners, before it announces itself', () => {
    const batch = app.slice(
      app.indexOf('const transferListeners = Promise.all(['),
      app.indexOf(']).then((unlisten) => {'),
    );
    expect(batch).toContain('win.listen<SendPayload>(TEAROFF_EVENT.send');
    expect(batch).toContain('documentWindow.onTransferSend(event.payload)');
    expect(batch).toContain('win.listen<TearOffEndPayload>(TEAROFF_EVENT.end');
    // The end of a tear-off's own role carries no id.
    expect(batch).toContain('event.payload.id === null');
    expect(batch).toContain('documentWindow.endTearOffRole()');
    expect(batch).toContain('onTearOffEnd(event.payload.id)');
    expect(app.indexOf('await announceReady();')).toBeGreaterThan(
      app.indexOf('await transferListeners;'),
    );
  });

  it('drains the queue of the new ready answer and applies a role that ended already', () => {
    const ready = body(
      app,
      'const announceReady = async (): Promise<void> => {',
    );
    expect(ready).toContain("invoke<WindowReady>('doc_window_ready'");
    expect(ready).toContain('for (const item of ready.queued) {');
    expect(ready).toContain('item.kind === QUEUED_TRANSFER');
    expect(ready).toContain('incomingTransfers.take(item.value)');
    // The first transfer is the one the role lets through.
    expect(
      ready.indexOf('documentWindow.tearOffFirst = item.value;'),
    ).toBeLessThan(ready.indexOf('incomingTransfers.take(item.value)'));
    // A role the core ended before the page listened ends after the tab is in.
    const late = ready.slice(
      ready.indexOf('if (tearOff && ready.tearOffRoleEnded)'),
    );
    expect(late).toContain('documentWindow.endTearOffRole();');
    expect(late).toContain('if (ready.revealed) {');
    expect(late).toContain("invoke('reveal_self')");
  });

  it('stamps the theme before it mounts, loads its chrome and never shows itself while it waits', () => {
    expect(
      main.indexOf('stampTearOff(document.documentElement'),
    ).toBeGreaterThan(-1);
    expect(main.indexOf('stampTearOff(document.documentElement')).toBeLessThan(
      main.indexOf('mount(Component'),
    );
    expect(app).toMatch(
      /if \(!receive\) \{\s+void revealWhenThemed\(\);\s+\} else if \(tearOff\) \{\s+void loadChrome\(\);/,
    );
    expect(reveal).toContain('export async function loadChrome()');
    // `reveal_self` is not in `loadChrome`, and the page asks for it in three
    // places: the reveal host (which the role keeps from running), the window
    // state's own reveal, and the late end of a role.
    expect(body(reveal, 'export async function loadChrome()')).not.toContain(
      'reveal_self',
    );
    expect([...app.matchAll(/invoke\('reveal_self'\)/g)]).toHaveLength(3);
    expect(app).toContain('documentWindow.tearOffRole = tearOff;');
  });

  it('tells the core where its tab bar is: on mount, with its height, its size and its pixel ratio', () => {
    expect(body(app, '  function reportTabBar(): void {')).toContain(
      "invoke('report_tab_bar'",
    );
    const effect = app.slice(
      app.indexOf('// On mount, and whenever the bar'),
      app.indexOf('let dragState'),
    );
    expect(effect).toContain('void tabbarEl;');
    expect(effect).toContain('void tabbarHeight;');
    expect(effect).toContain('reportTabBar();');
    expect(app).toContain("window.addEventListener('resize', onWindowResize);");
    expect(app).toContain(
      "window.removeEventListener('resize', onWindowResize);",
    );
    const resized = app.slice(
      app.indexOf('const onWindowResize = (): void => {'),
      app.indexOf('let ratioQuery'),
    );
    expect(resized).toContain('refreshFullscreen();');
    expect(resized).toContain('reportTabBar();');
    expect(app).toContain('`(resolution: ${window.devicePixelRatio}dppx)`');
    expect(body(app, '    const onRatioChange = (): void => {')).toContain(
      'reportTabBar();',
    );
  });

  it('knows whether it is full screen and asks no tear-off of a touch or a pen', () => {
    expect(app).toContain(
      'canTearOff: canTearOff(dragPointerType, platform.os, fullscreen)',
    );
    expect(app).toContain('dragPointerType = e.pointerType;');
  });
});

describe('a tab of another window that follows the pointer over this one', () => {
  it('answers every hover of a follow with what the window takes now, accepted or not', () => {
    const hover = body(app, 'function onHover(payload: HoverPayload): void {');
    expect(hover).toContain('hoverAck(payload, ready, locked)');
    const asked = hover.indexOf("invoke('tab_hover_ack', { ...ack })");
    expect(asked).toBeGreaterThan(-1);
    // The answer goes out before the window decides whether it draws anything.
    expect(asked).toBeLessThan(
      hover.indexOf('hoverAccepted({ ready, locked })'),
    );
    expect(hover.slice(0, asked)).not.toContain('return;');
    expect(hover.slice(0, asked)).toContain('if (ack !== null) {');
  });

  it('draws the tab only for a hover that carries a follow, and removes it with the gap', () => {
    const hover = body(app, 'function onHover(payload: HoverPayload): void {');
    expect(hover).toContain('const follow = payload.follow;');
    expect(hover).toMatch(/ghost:\s+follow === undefined\s+\? null/);
    expect(hover).toContain(
      'ghostLeft(gap.point, follow.grabX, gap.width, geometry.bar)',
    );
    // It is shown while the gap is, and ends with it.
    expect(app).toContain(
      '{#if hover !== null && hover.ghost !== null && hoverShown}',
    );
    expect(app).toContain('class="tab-ghost"');
  });

  it('keeps the tab drawn under the pointer out of the bar and out of its geometry', () => {
    const rects = body(app, 'function tabRects(bar: HTMLElement)');
    expect(rects).toContain('querySelectorAll<HTMLElement>(TAB_SELECTOR)');
    const bar = app.indexOf('class="tabbar"');
    const ghost = app.indexOf('class="tab-ghost"');
    const tabs = app.indexOf('{#each documentWindow.tabs as tab, i (tab.id)}');
    const newTab = app.indexOf('class="tab-new"');
    expect(bar).toBeLessThan(tabs);
    expect(newTab).toBeLessThan(ghost);
    // The look is shared with the tab through one rule.
    expect(app).toMatch(/\.tab,\n\s+\.tab-ghost \{/);
  });

  it('names the tab and where the pointer holds it when it leaves, for both ways of leaving', () => {
    expect(body(app, '  async function startTearOff(')).toContain(
      'title: tabName(tab.path),',
    );
    const follow = body(app, '  async function followWindow(');
    expect(follow).toContain('title: start.title,');
    expect(follow).toContain('tabGrabX: start.grab.x,');
  });
});

describe('a window a tab that follows the pointer made invisible', () => {
  it('is shown before the close gate asks for its focus, whatever its role', () => {
    const focus = body(app, 'focusWindow: async () => {');
    expect(focus).toContain("invoke('tab_window_restore')");
    expect(focus.indexOf("invoke('tab_window_restore')")).toBeLessThan(
      focus.indexOf('win.setFocus()'),
    );
    expect(focus).not.toContain('tearOffRole');
  });

  it('is shown when a close or a quit is called off, whatever its role', () => {
    const handler = body(app, 'gate.onCallOff = () => {');
    const restore = handler.indexOf("invoke('tab_window_restore')");
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(handler.indexOf('tearOffCloseCalledOff('));
    expect(
      handler.slice(0, handler.indexOf('tearOffCloseCalledOff(')),
    ).not.toContain('tearOffRole');
    // The role-bound call stays as it was.
    expect(handler).toContain("invoke('tab_tearoff_close_vetoed')");
  });

  it('is shown when the send of its only tab failed or was refused', () => {
    const reveal = body(state, '  private async revealWith(tab: DocTab)');
    expect(reveal).toContain("invoke('tab_window_restore')");
    expect(reveal.indexOf('this.goingAway()')).toBeLessThan(
      reveal.indexOf("invoke('tab_window_restore')"),
    );
    expect(reveal.indexOf("invoke('tab_window_restore')")).toBeLessThan(
      reveal.indexOf('this.revealSelf?.()'),
    );
    const send = body(state, '  async onTransferSend(payload: SendPayload)');
    // Every way the send does not start is shown through it.
    expect(send.match(/await this\.revealWith\(tab\);/g)).toHaveLength(2);
  });
});
