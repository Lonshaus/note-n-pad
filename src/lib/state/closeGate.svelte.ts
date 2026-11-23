// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import type { DocTab, DocumentWindowState } from './documentWindow.svelte';
/** What raises the gate: a dirty tab too large to snapshot ('oversized'), a
 *  snapshot write that was attempted and failed ('unwritable'), or an open
 *  range edit box with changes ('rangeBox'). */
export type GateReason = 'oversized' | 'unwritable' | 'rangeBox';
/** What the gate resumes once nothing blocks any more: a quit (`request_exit`),
 *  closing this window (`finishWindowClose`) or closing the active tab. */
export type GateContinuation = 'quit' | 'close' | 'tab';
/** What the gate needs from the window around it. */
export interface GateHost {
  /** The window's label, which the quit handshake acks by. */
  label: string;
  /** Drop the clean tabs' records and destroy the window. */
  finishWindowClose(): Promise<void>;
  /** Close `tab` and drop its record. With `keepWindow`, the window stays when
   *  it was the last tab: a quit or close that was held back is about to take it
   *  over. */
  finishTabClose(tab: DocTab, keepWindow?: boolean): Promise<void>;
  /** Bring this window forward: the gate may belong to a background window
   *  (a quit asks every window at once), and without it the user sees no
   *  reaction to the quit at all. */
  focusWindow(): Promise<void>;
  /** Whether another dialog of this window must be answered first. While it is,
   *  the prompt waits and is raised again by `resumeDeferred`. */
  promptBlocked?(): boolean;
  /** Whether another dialog of this window, one that cannot wait behind the
   *  prompt, is up. The prompt is then called off: the quit or close it guards
   *  does not go through, and the window stays on its tab. */
  promptRefused?(): boolean;
}

type GateWindow = Pick<
  DocumentWindowState,
  | 'activeTab'
  | 'discardChanges'
  | 'discardWindowed'
  | 'endComposition'
  | 'firstBlockingDirty'
  | 'firstOversizedDirtyIndex'
  | 'firstUnwritableDirtyIndex'
  | 'flushAll'
  | 'rangeBox'
  | 'rangeBoxBlocking'
  | 'rangeBoxCancel'
  | 'rangeBoxDirty'
  | 'rangeBoxSave'
  | 'rangeConflictSaveAs'
  | 'saveAsTab'
  | 'saveTab'
  | 'settleTransfers'
  | 'switchTo'
  | 'tabs'
  | 'windowedPending'
>;
/** The gate before a quit, a window close or a tab close that would lose
 *  something no snapshot can carry: the quit and window-close handshakes and
 *  the tab close raise it instead of silently dropping the edits. Save and
 *  discard walk the offending items one at a time; once none remain the
 *  pending action resumes. Cancel leaves everything as it is (a quit is
 *  already vetoed; a close was prevented). */
export class CloseGate {
  /** The gate dialog is up. */
  visible = $state(false);
  /** Which condition the dialog is about; it picks the message and the save. */
  reason = $state<GateReason>('oversized');
  /** What resumes after the last item is resolved. Non-reactive: it is only
   *  read inside the async handlers right after being set. */
  private continuation: GateContinuation = 'quit';
  /** Set once the app-level quit handshake starts (`flush-request`), cleared
   *  again if this or another window vetoes the quit (`flush-cancelled`). Not
   *  a one-way latch: `flush-request` only means the handshake *started*.
   *  While true, `close-flush-request` (a same-window OS close caught up in
   *  the same batch close) is ignored so the quit handshake — not this
   *  window's own self-destroy via `confirm_close` — owns the shutdown; a
   *  window racing both would never send `flush_ack`, stalling the quit. */
  private quittingNow = false;
  /** Whether the quit handshake owns this window's shutdown. */
  get quitting(): boolean {
    return this.quittingNow;
  }
  /** The window's own close is under way: set when it starts and kept until it
   *  is called off, taken over by a quit, fails or ends with the window gone.
   *  While it is, no tab is dragged out and none is taken in. */
  private closingNow = false;
  get closing(): boolean {
    return this.closingNow;
  }
  /** The close failed to finish (`closeDocumentWindow`): it is not under way. */
  abandonClose(): void {
    this.closingNow = false;
  }
  /** The tab the dialog is about: the one the scan that raised it found. Save,
   *  Discard and a tab close act on it, whichever tab is active by then. */
  private target: DocTab | null = null;
  /** A prompt was asked for while another dialog held the window. */
  private deferred = false;
  /** A prompt is switching to the tab it asks about. */
  private asking = false;
  /** The tab of a tab close that has not ended: set by `promptTabClose`, kept
   *  apart from `continuation`, which a quit or a window close may replace. */
  private tabClosePending: DocTab | null = null;
  /** Callers waiting for the next `flush-cancelled`. */
  private cancelWaiters: (() => void)[] = [];
  /** Called when the gate has no more say: the dialog was cancelled or left
   *  after a declined save, or the quit, close or tab close it guarded went
   *  through. */
  onDismissed: (() => void) | null = null;
  /** Called when the quit this gate guards was vetoed (by any window), or the
   *  gate dialog was cancelled: the quit or close will not go through. */
  onVetoed: (() => void) | null = null;
  /** Called with the tab of a pending tab close when that close has ended: the
   *  tab was closed, the dialog was left or the close was taken over. */
  onTabCloseEnded: ((tab: DocTab) => void) | null = null;
  /** Report the end of the pending tab close, once. */
  private tabCloseEnded(): void {
    const tab = this.tabClosePending;
    if (tab !== null) {
      this.tabClosePending = null;
      this.onTabCloseEnded?.(tab);
    }
  }
  /** A quit or a window close takes over from a pending tab close. */
  private takeOver(continuation: 'quit' | 'close'): void {
    this.continuation = continuation;
    this.tabCloseEnded();
  }
  private hide(): void {
    this.visible = false;
    this.closingNow = false;
    this.tabCloseEnded();
    this.onDismissed?.();
  }
  /** Whether the gate holds the window on its tab: its dialog is up or coming. */
  get busy(): boolean {
    return this.visible || this.asking;
  }

  private readonly win: GateWindow;
  private readonly host: GateHost;

  constructor(win: GateWindow, host: GateHost) {
    this.win = win;
    this.host = host;
  }
  /** The next thing to ask about: the edit box and the tab holding it alone
   *  for a tab close, everything for a quit or a window close. */
  private blocking(): ReturnType<GateWindow['firstBlockingDirty']> {
    return this.continuation === 'tab'
      ? this.win.rangeBoxBlocking()
      : this.win.firstBlockingDirty();
  }
  /** Whether something already known blocks, before any write is attempted. */
  private knownBlocking(): boolean {
    return (
      this.win.firstOversizedDirtyIndex() !== -1 || this.win.rangeBoxDirty()
    );
  }
  /** The first thing that blocks, with its tab made the active one. The dialog
   *  stays on that tab even when another switch got in the way meanwhile, and it
   *  looks again when the tab is gone. Null when nothing blocks. */
  private async bringBlockingForward(): Promise<ReturnType<
    GateWindow['firstBlockingDirty']
  > | null> {
    for (;;) {
      const blocking = this.blocking();
      if (blocking === null) {
        return null;
      }
      const target = this.win.tabs[blocking.index] ?? null;
      this.target = target;
      await this.win.switchTo(blocking.index);
      if (target === null || this.win.activeTab === target) {
        return blocking;
      }
      const at = this.win.tabs.indexOf(target);
      if (at !== -1) {
        await this.win.switchTo(at);
        if (this.win.activeTab === target) {
          return blocking;
        }
      }
    }
  }
  /** Show the dialog for the first thing that blocks, or resume the pending
   *  action when nothing does. */
  async prompt(): Promise<void> {
    if (this.host.promptRefused?.() === true) {
      this.cancel();
      return;
    }
    if (this.host.promptBlocked?.() === true) {
      this.deferred = true;
      return;
    }
    // Held until the dialog is up, so the window stays put meanwhile.
    this.asking = true;
    let blocking: ReturnType<GateWindow['firstBlockingDirty']> | null;
    try {
      blocking = await this.bringBlockingForward();
      if (blocking !== null) {
        this.reason =
          blocking.rangeBox === true
            ? 'rangeBox'
            : blocking.oversized
              ? 'oversized'
              : 'unwritable';
        this.visible = true;
      }
    } finally {
      this.asking = false;
    }
    if (blocking === null) {
      this.visible = false;
      if (this.continuation === 'close') {
        await this.host.finishWindowClose();
      } else if (this.continuation === 'tab') {
        try {
          if (this.target !== null) {
            await this.host.finishTabClose(this.target);
          }
        } finally {
          this.tabCloseEnded();
        }
      } else {
        await invoke('request_exit');
      }
      this.onDismissed?.();
      return;
    }
    await this.host.focusWindow();
  }
  /** Whether a prompt is being held back behind another dialog. */
  get held(): boolean {
    return this.deferred;
  }
  /** The dialog that held a prompt back is gone: raise it again, which asks
   *  about whatever still blocks or carries on with the quit or close. */
  async resumeDeferred(): Promise<void> {
    if (!this.deferred) {
      return;
    }
    this.deferred = false;
    await this.prompt();
  }
  /** Closing `tab`, which holds an edit box with changes. */
  async promptTabClose(tab: DocTab): Promise<void> {
    this.continuation = 'tab';
    this.tabClosePending = tab;
    this.target = tab;
    await this.prompt();
  }
  async save(): Promise<void> {
    // The oversized gate resaves in place (a dialog only for an untitled tab).
    // A write-failure gate always prompts Save As: the failure is in the
    // snapshot folder, a different location from the tab's own file, but
    // forcing an explicit new target is the safer default when a location was
    // just proven unwritable. The box writes back into its source; a conflict
    // or a failure leaves it open.
    const target = this.target;
    let saved: boolean;
    if (this.reason === 'rangeBox') {
      // A source that is gone cannot be written back into: the box's text goes
      // to a new file instead.
      if (this.win.rangeBox?.missing === true) {
        saved = await this.win.rangeConflictSaveAs();
        // The new file opened as the active tab, which a tab close would now
        // take for the tab it was asked about.
        if (saved && this.continuation === 'tab') {
          this.hide();
          return;
        }
      } else {
        saved = (await this.win.rangeBoxSave()) === 'ok';
      }
    } else if (this.reason === 'unwritable') {
      saved = target !== null && (await this.win.saveAsTab(target));
    } else {
      saved = target !== null && (await this.win.saveTab(target));
    }
    // A cancelled or failed save leaves the item unsaved; dismiss the gate (the
    // quit is already vetoed, so the app simply stays open).
    if (!saved) {
      this.hide();
      return;
    }
    await this.prompt();
  }

  async discard(): Promise<void> {
    const target = this.target;
    if (this.reason === 'rangeBox') {
      this.win.rangeBoxCancel();
    } else if (target === null) {
      // Nothing it was about is left.
    } else if (target.windowed !== undefined) {
      // A windowed tab's dirtiness lives in its Rust session, so a plain buffer
      // reset would not clear it (leaving the quit gate stuck); reopen the
      // session at the on-disk baseline instead. A discard that failed leaves
      // the tab unsaved: asking about it again would only repeat the question the
      // failure message sits on top of, so the quit or close is called off.
      if (!(await this.win.discardWindowed(target))) {
        this.cancel();
        return;
      }
    } else {
      this.win.discardChanges(this.win.tabs.indexOf(target));
    }
    await this.prompt();
  }

  cancel(): void {
    this.hide();
    this.onVetoed?.();
  }
  /** `flush-request`: the quit handshake starts. Quit stays silent otherwise;
   *  restore reopens unsaved tabs afterward. */
  async onFlushRequest(): Promise<void> {
    this.quittingNow = true;
    // A tab on its way is settled before anything is scanned or asked.
    await this.win.settleTransfers();
    // Input still on its way into the core (a composition, queued input, an
    // apply in flight) would be lost: veto this quit at once, let the input
    // land, and carry on once the veto has gone round. What it leaves behind is
    // asked about as usual, and a clean result quits on this one request.
    if (this.win.windowedPending?.() === true) {
      const cancelled = this.nextCancelled();
      await invoke('flush_cancel');
      await this.win.endComposition?.();
      await cancelled;
      this.takeOver('quit');
      this.closingNow = false;
      await this.prompt();
      return;
    }
    // A dirty tab too large to snapshot, or an edit box with changes, cannot be
    // silently restored after quit; veto this quit right away (before the
    // handshake times out and exits anyway) and make the user deal with it.
    if (this.knownBlocking()) {
      this.takeOver('quit');
      this.closingNow = false;
      await invoke('flush_cancel');
      await this.prompt();
      return;
    }
    await this.win.flushAll();
    // A snapshot write failure is only discovered by attempting it, so this
    // check can only happen after the flush above — a dirty tab whose write
    // just failed cannot be silently restored after quit either.
    if (this.win.firstUnwritableDirtyIndex() !== -1) {
      this.takeOver('quit');
      this.closingNow = false;
      await invoke('flush_cancel');
      await this.prompt();
      return;
    }
    await invoke('flush_ack', { label: this.host.label });
  }
  /** `flush-cancelled`: any window vetoed the quit, so the handshake never
   *  completes. */
  onFlushCancelled(): void {
    this.quittingNow = false;
    const waiting = this.cancelWaiters;
    this.cancelWaiters = [];
    for (const wake of waiting) {
      wake();
    }
    this.onVetoed?.();
  }
  /** Resolves at the next `flush-cancelled`. */
  private nextCancelled(): Promise<void> {
    return new Promise((resolve) => {
      this.cancelWaiters.push(resolve);
    });
  }
  /** `close-flush-request`: the OS close of this window. Dirty tabs are
   *  snapshotted (a restart restores them), then the backend destroys the
   *  window; whatever cannot ride along raises the gate, which resumes by
   *  closing the window instead of quitting. */
  async onCloseFlushRequest(): Promise<void> {
    if (this.quittingNow) {
      // A quit handshake already owns this window's shutdown; let it finish
      // instead of racing it through `confirm_close`.
      return;
    }
    this.closingNow = true;
    // A tab on its way is settled before anything is scanned or asked.
    await this.win.settleTransfers();
    if (this.win.windowedPending?.() === true) {
      await this.win.endComposition?.();
    }
    if (this.knownBlocking()) {
      this.takeOver('close');
      await this.prompt();
      return;
    }
    await this.win.flushAll();
    // A snapshot write failure is only discovered by attempting it; check
    // right after the attempt, same gate as the oversized case above.
    if (this.win.firstUnwritableDirtyIndex() !== -1) {
      this.takeOver('close');
      await this.prompt();
      return;
    }
    await this.host.finishWindowClose();
  }
}
