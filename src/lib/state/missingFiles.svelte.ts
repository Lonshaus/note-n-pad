// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import type { CloseGate } from './closeGate.svelte';
import type { DocumentWindowState } from './documentWindow.svelte';
/** What this module needs from the window state. */
type MissingWindow = Pick<
  DocumentWindowState,
  | 'activeTab'
  | 'clickSeq'
  | 'clicksInWait'
  | 'endComposition'
  | 'holdActive'
  | 'isDirty'
  | 'onConflictClosed'
  | 'onRestored'
  | 'openTab'
  | 'pendingClicks'
  | 'preparingTab'
  | 'rangeBox'
  | 'rangeBoxCancel'
  | 'rangeBoxDirty'
  | 'rangeConflictSaveAs'
  | 'saveAs'
  | 'saveTab'
  | 'settleTab'
  | 'settled'
  | 'switchTo'
  | 'tabs'
  | 'windowedConflict'
  | 'windowedPending'
>;
/** What it needs from the close gate. */
type MissingGate = Pick<
  CloseGate,
  | 'busy'
  | 'held'
  | 'onDismissed'
  | 'onTabCloseEnded'
  | 'onVetoed'
  | 'promptTabClose'
  | 'resumeDeferred'
  | 'visible'
>;
/** What it needs from the window around it. */
export interface MissingHost {
  /** Close `tab` and drop its record. With `keepWindow` the window stays when
   *  it was the last tab. */
  finishTabClose(
    tab: NonNullable<MissingWindow['activeTab']>,
    keepWindow?: boolean,
  ): Promise<void>;
  /** Destroy the window, which a held-back quit or close kept open and which
   *  has no tab left. */
  closeEmptyWindow(): Promise<void>;
  /** Whether a dialog of the window other than the ones this module owns is up
   *  (a message, a question about a large file, a conversion, a conflict of the
   *  edit box). */
  dialogOpen(): boolean;
}
/** Whether `active` is the tab `target` was asked about. */
export function sameTabStillActive(
  target: object | null | undefined,
  active: object | null,
): boolean {
  return target !== null && target !== undefined && target === active;
}
/** A tab, or the range edit box over a tab, whose file is gone. */
interface Entry {
  tabId: string;
  box: boolean;
}
/** Something to check: an entry and the path it was sent with. */
interface Target extends Entry {
  path: string;
}
/** How a tab close ended: the tab is gone, it stays, or another tab was the
 *  active one when it was asked for, which the close is asked for again. */
type CloseEnd = 'closed' | 'kept' | 'retry';
type DocTab = NonNullable<MissingWindow['activeTab']>;
/** A close button's click, waiting for its turn. */
interface QueuedClose {
  tab: DocTab;
  /** The window's click count when the button was clicked. */
  seq: number;
  /** A tab was clicked in the same wait before it, or the tab clicked is the
   *  one the window ends on. */
  clicked: boolean;
  resolve: () => void;
}
/** The tab close `closeTab` is waiting for, and the token of the deferred
 *  close it started. */
interface PendingClose {
  tab: DocTab;
  owner: object;
  resolve: (end: CloseEnd) => void;
}
/** The entry the dialog is about, with the file name to show. */
export interface MissingItem extends Entry {
  path: string;
}
/** Finds the tabs whose file was deleted or moved away while they held changes
 *  that are not saved anywhere else, and walks the user through each: save it
 *  somewhere new, or let it go. One per document window.
 *
 *  A found tab is marked `missing` (in memory only) and queued. The queue is
 *  shown one at a time, and a tab or edit box is never written back to the path
 *  that is gone. It also owns the "save changes before closing?" dialog, since
 *  the two must never be up together and share the rule for closing a tab. */
export class MissingFiles {
  /** The "save changes before closing?" dialog is up. */
  confirmClose = $state(false);
  /** The tab that dialog is about: Save and Don't Save act on it, whichever tab
   *  is active by the time it is answered. */
  private closeTarget: NonNullable<MissingWindow['activeTab']> | null = null;
  private queue = $state<Entry[]>([]);
  /** The last tab was discarded and the window kept open for a quit or close
   *  that was held back; it must not outlive that quit or close. */
  private keptEmpty = false;
  /** A tab close is waiting for typed input to reach the core. */
  private closing = false;
  /** A windowed close is waiting for input: resolved when it has ended. */
  private closingEnd: Promise<void> | null = null;
  private endClosing: (() => void) | null = null;
  /** The close buttons clicked, in click order, each waiting for the one before
   *  to end. */
  private closeQueue: QueuedClose[] = [];
  private running = false;
  private pendingClose: PendingClose | null = null;
  private readonly win: MissingWindow;
  private readonly gate: MissingGate;
  private readonly host: MissingHost;

  constructor(win: MissingWindow, gate: MissingGate, host: MissingHost) {
    this.win = win;
    this.gate = gate;
    this.host = host;
    win.holdActive = () => this.tabsLocked();
    win.onRestored = () => {
      void this.check();
    };
    // Every dialog that held the dialog back can leave on its own; when one
    // does, the window goes to the tab the dialog is about.
    win.onConflictClosed = () => {
      void this.revealCurrent();
    };
    gate.onDismissed = () => {
      void this.revealCurrent();
    };
    gate.onVetoed = () => {
      void this.closeIfKeptEmpty();
    };
    gate.onTabCloseEnded = (tab) => {
      this.closeEnded(tab.id);
    };
  }
  private tabOf(id: string): MissingWindow['tabs'][number] | undefined {
    return this.win.tabs.find((tab) => tab.id === id);
  }
  /** The edit box, when it belongs to the tab `id`. */
  private boxOf(id: string): NonNullable<MissingWindow['rangeBox']> | null {
    const box = this.win.rangeBox;
    return box !== null && box.tabId === id ? box : null;
  }
  /** Whether the entry is marked, or waiting in the queue. */
  private handled(entry: Entry): boolean {
    const marked = entry.box
      ? this.boxOf(entry.tabId)?.missing === true
      : this.tabOf(entry.tabId)?.missing === true;
    return (
      marked ||
      this.queue.some((e) => e.tabId === entry.tabId && e.box === entry.box)
    );
  }
  /** The entry as the dialog shows it, or null once it no longer applies: the
   *  tab is gone, or it is no longer marked missing. */
  private resolve(entry: Entry): MissingItem | null {
    const tab = this.tabOf(entry.tabId);
    if (tab === undefined) {
      return null;
    }
    if (entry.box) {
      const box = this.boxOf(entry.tabId);
      return box?.missing === true ? { ...entry, path: box.sourcePath } : null;
    }
    return tab.missing === true ? { ...entry, path: tab.path } : null;
  }
  /** Whether the tab of `entry` is on its way to another window: it shows no
   *  dialog until it is back or gone. */
  private onItsWay(entry: Entry): boolean {
    return this.tabOf(entry.tabId)?.transferring === true;
  }
  private prune(): void {
    this.queue = this.queue.filter((entry) => this.resolve(entry) !== null);
  }
  /** Another dialog of the window holds it: the user answers that one first. */
  private blocked(): boolean {
    return (
      this.confirmClose ||
      this.gate.visible ||
      this.win.rangeBox?.conflict === true ||
      this.win.windowedConflict !== null
    );
  }
  /** What has unsaved changes and a path to lose, and is not known to be gone. */
  private targets(): Target[] {
    const targets: Target[] = [];
    for (const tab of this.win.tabs) {
      const entry = { tabId: tab.id, box: false };
      if (tab.path !== '' && this.win.isDirty(tab) && !this.handled(entry)) {
        targets.push({ ...entry, path: tab.path });
      }
    }
    const box = this.win.rangeBox;
    if (box !== null && this.win.rangeBoxDirty()) {
      const entry = { tabId: box.tabId, box: true };
      if (!this.handled(entry)) {
        targets.push({ ...entry, path: box.sourcePath });
      }
    }
    return targets;
  }
  /** Whether `target` still describes what it was sent as: its tab (or box) is
   *  still there, still holds the changes, still names the same path, and is not
   *  handled by a check that finished first. */
  private stillApplies(target: Target): boolean {
    const tab = this.tabOf(target.tabId);
    if (tab === undefined || this.handled(target)) {
      return false;
    }
    if (target.box) {
      const box = this.boxOf(target.tabId);
      return (
        box !== null &&
        box.sourcePath === target.path &&
        this.win.rangeBoxDirty()
      );
    }
    return tab.path === target.path && this.win.isDirty(tab);
  }
  private mark(target: Target): void {
    if (target.box) {
      const box = this.boxOf(target.tabId);
      if (box === null) {
        return;
      }
      this.win.rangeBox = { ...box, missing: true };
    } else {
      const tab = this.tabOf(target.tabId);
      if (tab === undefined) {
        return;
      }
      tab.missing = true;
    }
    this.queue.push({ tabId: target.tabId, box: target.box });
  }
  /** Look for tabs whose file is gone: every one with unsaved changes and a
   *  path, and the edit box. Called when the app comes to the front and once the
   *  window has restored its tabs. */
  async check(): Promise<void> {
    // Another dialog is up: the next time the app comes to the front looks again.
    if (this.host.dialogOpen()) {
      return;
    }
    this.prune();
    const targets = this.targets();
    if (targets.length === 0) {
      return;
    }
    let gone: string[];
    try {
      gone = await invoke<string[]>('missing_paths', {
        paths: [...new Set(targets.map((target) => target.path))],
      });
    } catch (error) {
      console.error('missing_paths failed', error);
      return;
    }
    if (this.host.dialogOpen()) {
      return;
    }
    const missing = new Set(gone);
    for (const target of targets) {
      if (missing.has(target.path) && this.stillApplies(target)) {
        this.mark(target);
      }
    }
    await this.revealCurrent();
  }
  /** The dialog to show now, or null: nothing is queued, or another dialog of
   *  the window has to be answered first. */
  current(): MissingItem | null {
    if (this.blocked()) {
      return null;
    }
    for (const entry of this.queue) {
      const item = this.resolve(entry);
      if (item !== null && !this.onItsWay(entry)) {
        return item;
      }
    }
    return null;
  }
  /** Every tab still waiting, shown or not, in the order they are asked about.
   *  A tab on its way to another window is not waiting for this window. */
  pending(): MissingItem[] {
    return this.queue.flatMap((entry) =>
      this.onItsWay(entry) ? [] : (this.resolve(entry) ?? []),
    );
  }
  /** A tab that arrived from another window already marked as missing: it waits
   *  in this window's queue as well. */
  enqueue(tab: NonNullable<MissingWindow['activeTab']>): void {
    const entry = { tabId: tab.id, box: false };
    const queued = this.queue.some(
      (e) => e.tabId === entry.tabId && e.box === entry.box,
    );
    if (tab.missing === true && !queued) {
      this.queue.push(entry);
    }
  }
  /** While a dialog is up the window stays on its tab: nothing switches,
   *  opens or closes a tab. */
  navigationLocked(): boolean {
    return (
      this.current() !== null ||
      this.confirmClose ||
      this.gate.busy ||
      this.host.dialogOpen()
    );
  }
  /** The same, and the edit box covers the tabs too. Closing the active tab
   *  stays possible with the box open: it leads to the box's own question. */
  tabsLocked(): boolean {
    return this.navigationLocked() || this.win.rangeBox !== null;
  }
  /** Whether a dialog is up that a quit or close must not be raised over. The
   *  dialog for a missing file is not one: it waits for the answer. */
  otherDialogUp(): boolean {
    return this.confirmClose || this.host.dialogOpen();
  }
  /** Make the tab of `item` the active one. False when it is gone, or another
   *  switch got in the way. */
  async reveal(item: Entry): Promise<boolean> {
    const index = this.win.tabs.findIndex((tab) => tab.id === item.tabId);
    if (index === -1) {
      return false;
    }
    await this.win.switchTo(index);
    return this.win.activeTab?.id === item.tabId;
  }
  /** Bring the window to the tab the dialog is about. */
  async revealCurrent(): Promise<void> {
    const item = this.current();
    if (item !== null && this.win.activeTab?.id !== item.tabId) {
      await this.reveal(item);
    }
  }
  private drop(item: Entry): void {
    this.queue = this.queue.filter(
      (entry) => entry.tabId !== item.tabId || entry.box !== item.box,
    );
  }
  /** The dialog is answered: when nothing else waits, a quit or close it held
   *  back goes on. */
  private settle(): void {
    if (this.pending().length === 0) {
      void this.gate.resumeDeferred();
    }
  }
  /** "另存新檔": save what the dialog is about to a new path. False when the save
   *  dialog was cancelled or the write failed, which leaves the dialog up. */
  async saveAs(pathOverride?: string): Promise<boolean> {
    const item = this.current();
    if (item === null) {
      return false;
    }
    if (!(await this.reveal(item))) {
      this.drop(item);
      this.closeEnded(item.tabId);
      this.settle();
      await this.revealCurrent();
      return false;
    }
    const saved = item.box
      ? await this.win.rangeConflictSaveAs(pathOverride)
      : await this.win.saveAs(pathOverride);
    if (saved) {
      this.drop(item);
      this.closeEnded(item.tabId);
      this.settle();
      await this.revealCurrent();
    }
    return saved;
  }
  /** "放棄變更": close the tab the dialog is about without asking again. An edit
   *  box is closed and so is the tab it sits on. */
  async discard(): Promise<void> {
    const item = this.current();
    if (item === null) {
      return;
    }
    if (!(await this.reveal(item))) {
      this.drop(item);
      this.closeEnded(item.tabId);
      this.settle();
      await this.revealCurrent();
      return;
    }
    if (item.box) {
      this.win.rangeBoxCancel();
    }
    this.drop(item);
    // A quit or close held back behind the dialog ends the window itself; the
    // last tab closing must not destroy the window before it gets there.
    const held = this.gate.held;
    const tab = this.tabOf(item.tabId);
    if (tab !== undefined) {
      try {
        await this.host.finishTabClose(tab, held);
      } finally {
        this.closeEnded(tab.id);
      }
    }
    this.keptEmpty = held && this.win.tabs.length === 0;
    this.settle();
    await this.revealCurrent();
  }
  /** The quit or close the window was kept for did not go through: close the
   *  window as closing its last tab would have, unless it got a tab since. */
  private async closeIfKeptEmpty(): Promise<void> {
    if (!this.keptEmpty) {
      return;
    }
    this.keptEmpty = false;
    if (this.win.tabs.length === 0) {
      await this.host.closeEmptyWindow();
    }
  }
  /** Close `tab`, the active tab (⌘W). A tab whose file is gone shows its own
   *  dialog instead; one with changes asks first. Nothing happens when `tab` is
   *  no longer the active one. False when no close was started. `owner` is the
   *  token of the close button's close that asked, which a deferred close
   *  reports to. */
  requestClose(tab: DocTab, owner?: object): boolean {
    if (this.navigationLocked() || this.win.activeTab !== tab) {
      return false;
    }
    // A tab on its way: the move is called off first (or the tab, already in
    // the other window, is not this window's to close).
    if (tab.transferring === true || this.win.preparingTab === tab) {
      void this.closeAfterSettle(tab, owner);
      return true;
    }
    // Input of a windowed editor that is not in the core yet would be lost:
    // the close waits for it, then goes on with what the tab is by then.
    if (tab.windowed !== undefined && this.win.windowedPending?.() === true) {
      if (this.closing) {
        return false;
      }
      this.closing = true;
      this.closingEnd = new Promise<void>((resolve) => {
        this.endClosing = resolve;
      });
      void this.closeWhenSettled(tab, owner);
      return true;
    }
    this.closeNow(tab);
    return true;
  }
  /** Close the tab at `index` (its close button). The close waits for the ones
   *  clicked before it, and resolves once it has ended. */
  requestCloseAt(index: number): Promise<void> {
    const tab = this.win.tabs[index];
    if (this.tabsLocked() || tab === undefined) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.closeQueue.push({
        tab,
        seq: this.win.clickSeq,
        clicked: this.win.pendingClicks > 0 || this.win.clicksInWait > 0,
        resolve,
      });
      if (!this.running) {
        this.running = true;
        void this.runCloseQueue();
      }
    });
  }
  /** Whether no close button's close is waiting or under way. */
  get closeQueueIdle(): boolean {
    return this.closeQueue.length === 0 && !this.running;
  }
  private async runCloseQueue(): Promise<void> {
    try {
      for (;;) {
        const entry = this.closeQueue.shift();
        if (entry === undefined) {
          return;
        }
        try {
          await this.closeOne(entry);
        } catch (error) {
          console.error('closing a tab failed', error);
        }
        this.pendingClose = null;
        entry.resolve();
      }
    } finally {
      this.running = false;
    }
  }
  /** Close the tab of one close button, whichever tabs were clicked meanwhile:
   *  a tab that is closed without a question does not take the screen, and a
   *  question is asked on the tab it is about, after which the window goes to
   *  the tab clicked last. */
  private async closeOne(entry: QueuedClose): Promise<void> {
    const tab = entry.tab;
    for (;;) {
      await this.win.settled();
      if (!this.win.tabs.includes(tab)) {
        return;
      }
      const clicked = entry.clicked || this.win.clickSeq !== entry.seq;
      const back = this.win.activeTab;
      let to: DocTab | null = null;
      if (!clicked || (back !== tab && !this.asksNothing(tab))) {
        if (this.navigationLocked()) {
          return;
        }
        await this.win.switchTo(this.win.tabs.indexOf(tab));
        await this.win.settled();
        if (this.win.activeTab !== tab) {
          continue;
        }
        to = clicked ? back : null;
      } else if (back !== tab) {
        if (this.navigationLocked()) {
          return;
        }
        await this.host.finishTabClose(tab);
        return;
      }
      const end = await this.closeTab(tab);
      if (end === 'retry') {
        continue;
      }
      if (
        end === 'closed' &&
        to !== null &&
        this.win.tabs.includes(to) &&
        !this.navigationLocked()
      ) {
        await this.win.switchTo(this.win.tabs.indexOf(to));
      }
      return;
    }
  }
  /** Whether closing `tab` goes ahead without a question or a dialog. */
  private asksNothing(tab: DocTab): boolean {
    const box = this.boxOf(tab.id);
    return (
      tab.missing !== true &&
      box?.missing !== true &&
      !(box !== null && this.win.rangeBoxDirty()) &&
      !this.win.isDirty(tab) &&
      tab.transferring !== true &&
      this.win.preparingTab !== tab &&
      !(tab.windowed !== undefined && this.win.windowedPending?.() === true)
    );
  }
  /** Close the active `tab` and resolve once that has ended. */
  private async closeTab(tab: DocTab): Promise<CloseEnd> {
    // A windowed close that waits for input ends first.
    while (this.closingEnd !== null) {
      await this.closingEnd;
    }
    return new Promise<CloseEnd>((resolve) => {
      const owner = {};
      this.pendingClose = { tab, owner, resolve };
      if (!this.requestClose(tab, owner)) {
        this.closeEnded(
          tab.id,
          this.win.activeTab !== tab ? 'other-active' : undefined,
        );
      }
    });
  }
  /** The close of the tab `id` has ended. A report that carries the `owner` of
   *  a deferred close counts only for the close that started it. */
  private closeEnded(
    id: string,
    reason?: 'other-active',
    owner?: object,
  ): void {
    const pending = this.pendingClose;
    if (pending === null || pending.tab.id !== id) {
      return;
    }
    if (owner !== undefined && owner !== pending.owner) {
      return;
    }
    this.pendingClose = null;
    if (!this.win.tabs.includes(pending.tab)) {
      pending.resolve('closed');
    } else {
      pending.resolve(reason === 'other-active' ? 'retry' : 'kept');
    }
  }
  private async closeAfterSettle(tab: DocTab, owner?: object): Promise<void> {
    let started = false;
    try {
      await this.win.settleTab(tab);
      if (this.win.activeTab !== tab || tab.transferring === true) {
        return;
      }
      started = this.requestClose(tab, owner);
    } finally {
      if (!started) {
        this.deferredEnded(tab, owner);
      }
    }
  }
  private async closeWhenSettled(tab: DocTab, owner?: object): Promise<void> {
    let reached = false;
    try {
      try {
        await this.win.endComposition?.();
      } finally {
        this.closing = false;
        this.closingEnd = null;
        this.endClosing?.();
        this.endClosing = null;
      }
      if (this.win.activeTab !== tab || this.navigationLocked()) {
        return;
      }
      reached = true;
      this.closeNow(tab);
    } finally {
      if (!reached) {
        this.deferredEnded(tab, owner);
      }
    }
  }
  /** A deferred close ended without reaching a close of its own. */
  private deferredEnded(tab: DocTab, owner?: object): void {
    if (owner === undefined) {
      return;
    }
    this.closeEnded(
      tab.id,
      this.win.tabs.includes(tab) && this.win.activeTab !== tab
        ? 'other-active'
        : undefined,
      owner,
    );
  }
  private closeNow(tab: DocTab): void {
    const box = this.boxOf(tab.id);
    if (tab.missing === true || box?.missing === true) {
      this.promote({ tabId: tab.id, box: tab.missing !== true });
    } else if (box !== null && this.win.rangeBoxDirty()) {
      void this.gate.promptTabClose(tab);
    } else if (this.win.isDirty(tab)) {
      this.closeTarget = tab;
      this.confirmClose = true;
    } else {
      void this.finishClean(tab);
    }
  }
  /** Close a tab that asks nothing; a failure is logged and ends the close. */
  private async finishClean(tab: DocTab): Promise<void> {
    try {
      await this.host.finishTabClose(tab);
    } catch (error) {
      console.error('closing a tab failed', error);
    } finally {
      this.closeEnded(tab.id);
    }
  }
  /** Put `entry` first in the queue, adding it when it is not there. */
  private promote(entry: Entry): void {
    this.queue = [
      entry,
      ...this.queue.filter(
        (e) => e.tabId !== entry.tabId || e.box !== entry.box,
      ),
    ];
  }
  /** "儲存" in the close confirmation. A cancelled save keeps the tab and the
   *  dialog. Text typed while the write was out is saved again before the tab
   *  closes; a save that fails then keeps the tab too. */
  async confirmSave(): Promise<void> {
    const tab = this.closeTarget;
    if (tab === null) {
      return;
    }
    do {
      if (!(await this.win.saveTab(tab))) {
        return;
      }
    } while (this.win.tabs.includes(tab) && this.win.isDirty(tab));
    this.confirmClose = false;
    this.closeTarget = null;
    try {
      await this.host.finishTabClose(tab);
    } finally {
      this.closeEnded(tab.id);
    }
    await this.revealCurrent();
  }
  /** "不儲存" in the close confirmation. */
  async confirmDiscard(): Promise<void> {
    const tab = this.closeTarget;
    this.confirmClose = false;
    this.closeTarget = null;
    if (tab !== null) {
      try {
        await this.host.finishTabClose(tab);
      } finally {
        this.closeEnded(tab.id);
      }
    }
    await this.revealCurrent();
  }
  cancelClose(): void {
    const tab = this.closeTarget;
    this.confirmClose = false;
    this.closeTarget = null;
    if (tab !== null) {
      this.closeEnded(tab.id);
    }
    void this.revealCurrent();
  }
  /** Open `path` as a tab (the workspace tree, the shell) while the dialog may
   *  be up: the window returns to the dialog's tab once it is open. */
  async openFile(path: string): Promise<void> {
    await this.win.openTab(path);
    await this.revealCurrent();
  }
}
