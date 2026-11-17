// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import type { DocumentWindowState } from './documentWindow.svelte';
import { sameTabStillActive } from './missingFiles.svelte';
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
  /** Close the active tab. With `keepWindow`, the window stays when it was the
   *  last tab: a quit or close that was held back is about to take it over. */
  finishTabClose(keepWindow?: boolean): Promise<void>;
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
  | 'activeIndex'
  | 'discardChanges'
  | 'discardWindowedActive'
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
  | 'saveActive'
  | 'saveAs'
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
  private quitting = false;
  /** A prompt was asked for while another dialog held the window. */
  private deferred = false;
  /** A prompt is switching to the tab it asks about. */
  private asking = false;
  /** The tab a tab close was asked for. */
  private tabCloseTarget: GateWindow['activeTab'] = null;
  /** The tab the dialog on screen asks about. */
  private askedTab: GateWindow['activeTab'] = null;
  /** Callers waiting for the next `flush-cancelled`. */
  private cancelWaiters: (() => void)[] = [];
  /** Called when the gate has no more say: the dialog was cancelled or left
   *  after a declined save, or the quit, close or tab close it guarded went
   *  through. */
  onDismissed: (() => void) | null = null;
  /** Called when the quit this gate guards was vetoed (by any window), or the
   *  gate dialog was cancelled: the quit or close will not go through. */
  onVetoed: (() => void) | null = null;
  private hide(): void {
    this.visible = false;
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
    const blocking = this.blocking();
    if (blocking === null) {
      this.visible = false;
      if (this.continuation === 'close') {
        await this.host.finishWindowClose();
      } else if (this.continuation === 'tab') {
        // The active tab is no longer the one the close was asked for.
        if (!sameTabStillActive(this.tabCloseTarget, this.win.activeTab)) {
          this.hide();
          return;
        }
        await this.host.finishTabClose();
      } else {
        await invoke('request_exit');
      }
      this.onDismissed?.();
      return;
    }
    // Taken before the wait: the tabs may shift meanwhile, an index would then
    // name another one.
    const asked = this.win.tabs[blocking.index] ?? null;
    this.asking = true;
    try {
      await this.win.switchTo(blocking.index);
      this.reason =
        blocking.rangeBox === true
          ? 'rangeBox'
          : blocking.oversized
            ? 'oversized'
            : 'unwritable';
      this.askedTab = asked;
      this.visible = true;
    } finally {
      this.asking = false;
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
  /** Closing the active tab, which holds an edit box with changes. */
  async promptTabClose(): Promise<void> {
    this.continuation = 'tab';
    this.tabCloseTarget = this.win.activeTab;
    await this.prompt();
  }
  /** Whether the tab the dialog asks about is still the active one. When not
   *  (a switch that was under way when the dialog came up), the dialog only
   *  closes: nothing is written, discarded or closed. */
  private askedTabActive(): boolean {
    return sameTabStillActive(this.askedTab, this.win.activeTab);
  }

  async save(): Promise<void> {
    if (!this.askedTabActive()) {
      this.hide();
      return;
    }
    // The oversized gate resaves in place (a dialog only for an untitled tab).
    // A write-failure gate always prompts Save As: the failure is in the
    // snapshot folder, a different location from the tab's own file, but
    // forcing an explicit new target is the safer default when a location was
    // just proven unwritable. The box writes back into its source; a conflict
    // or a failure leaves it open.
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
      saved = await this.win.saveAs();
    } else {
      saved = await this.win.saveActive();
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
    if (!this.askedTabActive()) {
      this.hide();
      return;
    }
    if (this.reason === 'rangeBox') {
      this.win.rangeBoxCancel();
    } else if (this.win.activeTab?.windowed !== undefined) {
      // A windowed tab's dirtiness lives in its Rust session, so a plain buffer
      // reset would not clear it (leaving the quit gate stuck); reopen the
      // session at the on-disk baseline instead. A discard that failed leaves
      // the tab unsaved: asking about it again would only repeat the question the
      // failure message sits on top of, so the quit or close is called off.
      if (!(await this.win.discardWindowedActive())) {
        this.cancel();
        return;
      }
    } else {
      this.win.discardChanges(this.win.activeIndex);
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
    this.quitting = true;
    // Input still on its way into the core (a composition, queued input, an
    // apply in flight) would be lost: veto this quit at once, let the input
    // land, and carry on once the veto has gone round. What it leaves behind is
    // asked about as usual, and a clean result quits on this one request.
    if (this.win.windowedPending?.() === true) {
      const cancelled = this.nextCancelled();
      await invoke('flush_cancel');
      await this.win.endComposition?.();
      await cancelled;
      this.continuation = 'quit';
      await this.prompt();
      return;
    }
    // A dirty tab too large to snapshot, or an edit box with changes, cannot be
    // silently restored after quit; veto this quit right away (before the
    // handshake times out and exits anyway) and make the user deal with it.
    if (this.knownBlocking()) {
      this.continuation = 'quit';
      await invoke('flush_cancel');
      await this.prompt();
      return;
    }
    await this.win.flushAll();
    // A snapshot write failure is only discovered by attempting it, so this
    // check can only happen after the flush above — a dirty tab whose write
    // just failed cannot be silently restored after quit either.
    if (this.win.firstUnwritableDirtyIndex() !== -1) {
      this.continuation = 'quit';
      await invoke('flush_cancel');
      await this.prompt();
      return;
    }
    await invoke('flush_ack', { label: this.host.label });
  }
  /** `flush-cancelled`: any window vetoed the quit, so the handshake never
   *  completes. */
  onFlushCancelled(): void {
    this.quitting = false;
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
    if (this.quitting) {
      // A quit handshake already owns this window's shutdown; let it finish
      // instead of racing it through `confirm_close`.
      return;
    }
    if (this.win.windowedPending?.() === true) {
      await this.win.endComposition?.();
    }
    if (this.knownBlocking()) {
      this.continuation = 'close';
      await this.prompt();
      return;
    }
    await this.win.flushAll();
    // A snapshot write failure is only discovered by attempting it; check
    // right after the attempt, same gate as the oversized case above.
    if (this.win.firstUnwritableDirtyIndex() !== -1) {
      this.continuation = 'close';
      await this.prompt();
      return;
    }
    await this.host.finishWindowClose();
  }
}
