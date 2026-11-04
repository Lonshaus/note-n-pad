// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import type { CloseGate } from './closeGate.svelte';
import type { DocumentWindowState } from './documentWindow.svelte';
/** What this module needs from the window state. */
type MissingWindow = Pick<
  DocumentWindowState,
  | 'activeTab'
  | 'endComposition'
  | 'isDirty'
  | 'onConflictClosed'
  | 'onRestored'
  | 'openTab'
  | 'rangeBox'
  | 'rangeBoxCancel'
  | 'rangeBoxDirty'
  | 'rangeConflictSaveAs'
  | 'saveActive'
  | 'saveAs'
  | 'switchTo'
  | 'tabs'
  | 'windowedConflict'
  | 'windowedPending'
>;
/** What it needs from the close gate. */
type MissingGate = Pick<
  CloseGate,
  | 'held'
  | 'onDismissed'
  | 'onVetoed'
  | 'promptTabClose'
  | 'resumeDeferred'
  | 'visible'
>;
/** What it needs from the window around it. */
export interface MissingHost {
  /** Close the active tab and drop its record. With `keepWindow` the window
   *  stays when it was the last tab. */
  finishTabClose(keepWindow?: boolean): Promise<void>;
  /** Destroy the window, which a held-back quit or close kept open and which
   *  has no tab left. */
  closeEmptyWindow(): Promise<void>;
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
  private queue = $state<Entry[]>([]);
  /** The last tab was discarded and the window kept open for a quit or close
   *  that was held back; it must not outlive that quit or close. */
  private keptEmpty = false;
  /** A tab close is waiting for typed input to reach the core. */
  private closing = false;
  private readonly win: MissingWindow;
  private readonly gate: MissingGate;
  private readonly host: MissingHost;

  constructor(win: MissingWindow, gate: MissingGate, host: MissingHost) {
    this.win = win;
    this.gate = gate;
    this.host = host;
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
      if (item !== null) {
        return item;
      }
    }
    return null;
  }
  /** Every tab still waiting, shown or not, in the order they are asked about. */
  pending(): MissingItem[] {
    return this.queue.flatMap((entry) => this.resolve(entry) ?? []);
  }
  /** While the dialog is up the window stays on its tab: nothing switches,
   *  opens or closes a tab. */
  navigationLocked(): boolean {
    return this.current() !== null;
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
      this.settle();
      await this.revealCurrent();
      return false;
    }
    const saved = item.box
      ? await this.win.rangeConflictSaveAs(pathOverride)
      : await this.win.saveAs(pathOverride);
    if (saved) {
      this.drop(item);
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
    await this.host.finishTabClose(held);
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
  /** Close the active tab (⌘W, the close button). A tab whose file is gone
   *  shows its own dialog instead; one with changes asks first. */
  requestClose(): void {
    if (this.navigationLocked()) {
      return;
    }
    const tab = this.win.activeTab;
    if (tab === null) {
      return;
    }
    // Input of a windowed editor that is not in the core yet would be lost:
    // the close waits for it, then goes on with what the tab is by then.
    if (tab.windowed !== undefined && this.win.windowedPending?.() === true) {
      if (!this.closing) {
        this.closing = true;
        void this.closeWhenSettled(tab);
      }
      return;
    }
    this.closeNow(tab);
  }
  private async closeWhenSettled(
    tab: NonNullable<MissingWindow['activeTab']>,
  ): Promise<void> {
    try {
      await this.win.endComposition?.();
    } finally {
      this.closing = false;
    }
    if (this.win.activeTab !== tab) {
      return;
    }
    this.closeNow(tab);
  }
  private closeNow(tab: NonNullable<MissingWindow['activeTab']>): void {
    const box = this.boxOf(tab.id);
    if (tab.missing === true || box?.missing === true) {
      this.promote({ tabId: tab.id, box: tab.missing !== true });
    } else if (box !== null && this.win.rangeBoxDirty()) {
      void this.gate.promptTabClose();
    } else if (this.win.isDirty(tab)) {
      this.confirmClose = true;
    } else {
      void this.host.finishTabClose();
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
   *  dialog. */
  async confirmSave(): Promise<void> {
    if (!(await this.win.saveActive())) {
      return;
    }
    this.confirmClose = false;
    await this.host.finishTabClose();
    await this.revealCurrent();
  }
  /** "不儲存" in the close confirmation. */
  async confirmDiscard(): Promise<void> {
    this.confirmClose = false;
    await this.host.finishTabClose();
    await this.revealCurrent();
  }
  cancelClose(): void {
    this.confirmClose = false;
    void this.revealCurrent();
  }
  /** Open `path` as a tab (the workspace tree, the shell) while the dialog may
   *  be up: the window returns to the dialog's tab once it is open. */
  async openFile(path: string): Promise<void> {
    await this.win.openTab(path);
    await this.revealCurrent();
  }
}
