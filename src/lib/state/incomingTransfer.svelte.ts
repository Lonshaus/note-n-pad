// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A tab arriving from another window, from the receiver's side: claim it,
// answer whether this window can take it, wait for what the window is doing,
// keep a copy outside the tabs, tell the core where it will sit, and only when
// the core accepts, make it a tab. Until then nothing of the window changes.

import { invoke } from '@tauri-apps/api/core';
import type { PathRules } from '../util/filePath';
import { retargetPath } from '../util/filePath';
import { toClientPoint } from '../util/tabDrag';
import type { TabPayload } from '../util/tabPayload';
import type {
  Answer,
  Claimed,
  CommitResult,
  Point,
  TransferStatus,
  WindowedStats,
} from '../util/tabTransferWire';
import {
  pathRules,
  type DocTab,
  type DocumentWindowState,
  type IncomingCopy,
} from './documentWindow.svelte';
import { platform } from './platform.svelte';
/** What decides whether this window takes a tab. */
export interface AnswerFacts {
  /** The window has loaded its tabs. */
  ready: boolean;
  /** It knows the tab indices its group already holds. */
  indexSettled: boolean;
  /** A drag-start lock: a dialog, a gate, a close or quit, another transfer. */
  locked: boolean;
  /** It already holds a tab of that id, in its tabs or among its copies. */
  holdsId: boolean;
}
/** Whether the window can take the tab: only when nothing could be lost or
 *  doubled by it. */
export function receiverAnswer(facts: AnswerFacts): boolean {
  return facts.ready && facts.indexSettled && !facts.locked && !facts.holdsId;
}

type IncomingWindow = Pick<
  DocumentWindowState,
  | 'acceptIncoming'
  | 'committedMetaOf'
  | 'committing'
  | 'dragLocked'
  | 'dropIncoming'
  | 'holdIncoming'
  | 'incoming'
  | 'indexKnown'
  | 'isEmpty'
  | 'ready'
  | 'restoreIncoming'
  | 'settleForInsert'
  | 'tabs'
  | 'wasDropped'
>;
/** What the receiver needs of the window around it. */
export interface IncomingHost {
  /** The window was made for this tab: it shows itself only once it has it,
   *  and closes when it does not get it. */
  receive: boolean;
  /** Whether a dialog is up: a tab that arrives then is not switched to. */
  modalOpen(): boolean;
  /** A tab arrived: the window checks its file, and keeps its bounds. */
  arrived(tab: DocTab): void;
  /** Bring the window forward (a window made for the tab is revealed). */
  reveal(): Promise<void>;
  /** Close the window: it has nothing. */
  closeWindow(): Promise<void>;
}
/** The tabs arriving at one window. */
export class IncomingTransfers {
  /** The claimed payloads that have not become a copy yet, by transfer id. */
  private claimed = new Map<number, TabPayload>();
  private readonly win: IncomingWindow;
  private readonly host: IncomingHost;

  constructor(win: IncomingWindow, host: IncomingHost) {
    this.win = win;
    this.host = host;
  }
  /** The core has a tab for this window (`tab-transfer-in`, or a queued
   *  transfer handed over with the window's ready call). */
  async take(t: number): Promise<void> {
    let claimed: Claimed<TabPayload> | null;
    try {
      claimed = await invoke<Claimed<TabPayload> | null>('tab_transfer_claim', {
        t,
      });
    } catch (error) {
      console.error('tab_transfer_claim failed', error);
      claimed = null;
    }
    if (claimed === null) {
      this.ended();
      return;
    }
    this.claimed.set(t, claimed.payload);
    try {
      await this.receive(t, claimed.offset ?? null);
    } finally {
      this.claimed.delete(t);
    }
  }
  /** `tab-transfer-abort`: the core called the transfer off. */
  onAbort(t: number): void {
    // A copy that was dropped has closed a window left with nothing already.
    const held = this.win.incoming.has(t);
    this.win.dropIncoming(t);
    if (!held) {
      this.ended();
    }
  }
  /** The file `from` was renamed to `to`: a tab claimed and not yet a copy
   *  follows it. (The copies of the window state follow it themselves.) */
  retargetPaths(
    from: string,
    to: string,
    rules: PathRules = pathRules(),
  ): void {
    for (const payload of this.claimed.values()) {
      payload.tab.path = retargetPath(payload.tab.path, from, to, rules);
    }
  }
  /** A transfer ended without a tab: a window made for it has nothing to show,
   *  and closes (once). */
  private ended(): void {
    if (this.host.receive && this.win.isEmpty && !this.closeAsked) {
      this.closeAsked = true;
      void this.host.closeWindow();
    }
  }
  private closeAsked = false;
  private holds(id: string): boolean {
    return (
      this.win.tabs.some((tab) => tab.id === id) ||
      [...this.win.incoming.values()].some((copy) => copy.tab.id === id)
    );
  }
  /** The windowed session of the tab as it is now: edits that were still on
   *  their way when the sender froze the tab have landed by now. False when the
   *  core no longer has the session. */
  private async refreshSession(payload: TabPayload): Promise<boolean> {
    const windowed = payload.tab.windowed;
    if (windowed === undefined) {
      return true;
    }
    try {
      const stats = await invoke<WindowedStats>('windowed_stats', {
        sessionId: windowed.sessionId,
      });
      windowed.dirty = stats.dirty;
      windowed.totalBytes = stats.totalBytes;
      windowed.totalLines = stats.totalLines;
      return true;
    } catch (error) {
      console.error('windowed_stats failed', error);
      return false;
    }
  }
  private async receive(t: number, offset: Point | null): Promise<void> {
    const first = this.claimed.get(t);
    if (first === undefined) {
      return;
    }
    const known = await this.refreshSession(first);
    const ok =
      known &&
      receiverAnswer({
        ready: this.win.ready,
        indexSettled: this.win.indexKnown,
        locked: this.win.dragLocked(),
        holdsId: this.holds(first.tab.id),
      });
    let answer: Answer;
    try {
      answer = await invoke<Answer>('tab_transfer_answer', { t, ok });
    } catch (error) {
      console.error('tab_transfer_answer failed', error);
      answer = 'expired';
    }
    if (answer !== 'commit') {
      this.ended();
      return;
    }
    // What the window is doing with its current tab goes first, as for a switch.
    await this.win.settleForInsert();
    const payload = this.claimed.get(t);
    if (payload === undefined || this.win.wasDropped(t)) {
      this.ended();
      return;
    }
    const client =
      offset === null
        ? null
        : toClientPoint(offset, platform.os, window.devicePixelRatio);
    const copy = this.win.holdIncoming(t, payload, client);
    // A dropped copy makes no call: there is nothing to report.
    if (this.win.wasDropped(t)) {
      this.ended();
      return;
    }
    // Pending from before the call goes out, so nothing can look in between.
    let settled: (result: CommitResult) => void = () => {};
    const committing = new Promise<CommitResult>((resolve) => {
      settled = resolve;
    });
    this.win.committing = committing;
    void this.commit(t, copy).then(settled);
    let result: CommitResult;
    try {
      result = await committing;
    } finally {
      if (this.win.committing === committing) {
        this.win.committing = null;
      }
    }
    if (result !== 'accepted') {
      // Closes a window left with nothing.
      this.win.dropIncoming(t);
      return;
    }
    // The core has the tab here now: it is this window's, whatever came meanwhile.
    if (!this.win.incoming.has(t)) {
      this.win.restoreIncoming(copy);
    }
    const tab = this.win.acceptIncoming(t, !this.host.modalOpen());
    if (tab !== null) {
      this.host.arrived(tab);
      await this.host.reveal();
    }
  }
  /** Tell the core where the copy sits. When the call itself fails the core is
   *  asked what became of the transfer. */
  private async commit(t: number, copy: IncomingCopy): Promise<CommitResult> {
    try {
      return await invoke<CommitResult>('tab_transfer_committed', {
        t,
        meta: this.win.committedMetaOf(copy),
      });
    } catch (error) {
      console.error('tab_transfer_committed failed', error);
    }
    try {
      const status = await invoke<TransferStatus>('tab_transfer_status', { t });
      return status === 'accepted' ? 'accepted' : 'rejected';
    } catch {
      return 'rejected';
    }
  }
}
