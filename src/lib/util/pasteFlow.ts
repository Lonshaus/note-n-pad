// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A paste into a document or a sticky note. Where there are clips the page
// never reads the clipboard by itself: the paste is stopped, the tab locked, the
// core asked what the clipboard holds, and the paste made from the answer, in
// one transaction. Free of the DOM and Tauri, so it unit-tests in isolation.

import {
  EditorSelection,
  Text,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state';
import type { ClipInfo } from './clipRouting';
import { pasteLockOwner, type PasteLock, type PasteLocks } from './pasteLock';
import {
  hasClips,
  pastedSize,
  pastedText,
  pasteDecision,
  pasteErrorText,
  resolveClip,
  type FieldDeps,
  type MarkInput,
  type PasteDest,
  type PasteEventLike,
  type PasteRange,
  type PasteSource,
  type Resolved,
} from './pasteRouting';
import { pasteIsLinewise, pasteSpec } from './replayKeys';
/** The key a sticky note's lock goes by: it has one editor and no tabs. */
export const STICKY_KEY = 'sticky';
/** A paste that makes the tab a large file: the content around `ranges` and the
 *  pasted `source` are written to a file in the core. */
export interface ConversionRequest {
  dest: PasteDest;
  /** The tab, or `STICKY_KEY` for a sticky note. */
  tabId: string;
  /** The document as it was at the paste; the tab is locked, so it still is. */
  doc: Text;
  /** Where the paste goes, one place for every selection, in order, recorded at
   *  the event: CodeMirror's `doPaste` puts the text in each. */
  ranges: PasteRange[];
  /** The pasted text is whole lines: a line break follows each piece. */
  linewise: boolean;
  source: PasteSource;
  /** For a clip source: the pin the conversion reads the clip through, and the
   *  call that lets go of it. The conversion calls it when it is done with the
   *  clip, however it ends. Null for text. */
  clip: { pin: number; release: () => void } | null;
  /** The lock the tab is under (a full one). */
  lockId: number;
  /** Takes the lock off the tab; call it when the conversion is over, installed,
   *  failed or cancelled. */
  unlock: () => void;
}
/** What a paste needs of the editor that holds the tab. */
export interface PasteHost {
  dest: PasteDest;
  /** The tab's state: the live one when it is shown. Null once it is gone. */
  stateOf: (tabId: string) => EditorState | null;
  /** Applies a transaction to the tab, shown or not. */
  apply: (tabId: string, spec: TransactionSpec) => void;
  /** Shows a lock on the tab, or none. */
  showLock: (tabId: string, lock: PasteLock | undefined) => void;
  /** The line ending the tab is written with. */
  eolOf: (tabId: string) => '\n' | '\r\n';
}
export interface PasteFlowDeps {
  env: FieldDeps;
  /** `clip_read_chunk`, through a pin. */
  readChunk: (
    pin: number,
    offset: number,
  ) => Promise<{ text: string; next: number }>;
  /** The free edition pastes any size as it is. */
  isLite: () => boolean;
  startConversion: (request: ConversionRequest) => void;
  locks: PasteLocks;
  /** The text the last copy left for a line-wise paste. */
  lastLinewise: () => string | null;
  /** Tells the user the clip could not be read; `error` is `pasteErrorText`. */
  reportFailure: (error: string) => void;
}
/** The view as a paste sees it. */
export interface PasteView {
  state: EditorState;
  contentDOM: unknown;
}
export type PasteEvent = Pick<PasteEventLike, 'clipboardData'> & {
  preventDefault: () => void;
};
/** The whole clip, read a block at a time through its pin. */
async function readClip(
  deps: PasteFlowDeps,
  pin: number,
  info: ClipInfo,
): Promise<string> {
  let text = Text.empty;
  let offset = 0;
  while (offset < info.bytes) {
    const chunk = await deps.readChunk(pin, offset);
    if (chunk.next <= offset) {
      throw new Error('clip-stalled');
    }
    text = text.append(Text.of(chunk.text.split('\n')));
    offset = chunk.next;
  }
  return text.toString();
}
/** Where a paste of `source` goes, as CodeMirror's `doPaste` (view
 *  `index.js:4930-4961`) puts it: a line-wise paste above each caret line once
 *  per line, text with as many lines as there are selections one line to each
 *  selection, anything else the whole text in each selection. A clip has the
 *  same rules, its lines counted by the core. */
export function pasteRanges(
  state: EditorState,
  source: PasteSource,
  remembered: string | null,
): { ranges: PasteRange[]; linewise: boolean } {
  const selection = state.selection.ranges;
  const allEmpty = selection.every((r) => r.empty);
  let linewise: boolean;
  let byLine = false;
  if (source.kind === 'text') {
    linewise = pasteIsLinewise(state, source.text, remembered);
    byLine = state.toText(source.text).lines === selection.length;
  } else {
    linewise = source.info.linewise && allEmpty;
    // One selection and one line is the whole clip either way.
    byLine =
      selection.length > 1 &&
      Math.max(source.info.lines, 1) === selection.length;
  }
  const ranges: PasteRange[] = [];
  let next = 1;
  if (linewise) {
    let lastLine = -1;
    for (const r of selection) {
      const line = state.doc.lineAt(r.from);
      if (line.from === lastLine) {
        continue;
      }
      lastLine = line.from;
      ranges.push({
        from: line.from,
        to: line.from,
        line: byLine ? next++ : null,
      });
    }
  } else {
    for (const r of selection) {
      ranges.push({ from: r.from, to: r.to, line: byLine ? next++ : null });
    }
  }
  return { ranges, linewise };
}

export class PasteFlow {
  constructor(
    private host: PasteHost,
    private deps: PasteFlowDeps,
  ) {}
  /** The editor's `paste` handler; true when the event is dealt with. */
  onPaste(tabId: string, view: PasteView, e: PasteEvent): boolean {
    const { env, locks } = this.deps;
    if (locks.has(tabId) || view.state.readOnly) {
      e.preventDefault();
      return true;
    }
    if (!hasClips(env.platform)) {
      // The text comes with the event, and is read once.
      const text = pastedText(e.clipboardData);
      if (text === '') {
        return false;
      }
      e.preventDefault();
      this.pasteText(tabId, view.state, text);
      return true;
    }
    e.preventDefault();
    void this.pasteViaCore(tabId, view, env.clipPasteMark());
    return true;
  }
  /** Pastes the text of the clipboard that is already read (Edit > Paste on
   *  Linux, the event's text). */
  pasteText(tabId: string, state: EditorState, text: string): void {
    this.afterText(tabId, state, text, undefined, null);
  }

  private async pasteViaCore(
    tabId: string,
    view: PasteView,
    mark: MarkInput,
  ): Promise<void> {
    const { env, locks } = this.deps;
    const lock = locks.begin(tabId, 'wait');
    this.host.showLock(tabId, lock);
    const recorded = view.state.selection;
    const held = (): boolean => locks.get(tabId)?.id === lock.id;
    const release = (): void => {
      if (locks.end(tabId, lock.id)) {
        this.host.showLock(tabId, undefined);
      }
    };
    let result: Resolved;
    try {
      result = await resolveClip(
        {
          ...env,
          focusStill: () =>
            env.hasFocus() && env.activeElement() === view.contentDOM,
        },
        mark,
        'web',
        { onSlow: release },
      );
    } catch {
      release();
      return;
    }
    const state = this.host.stateOf(tabId);
    if (state === null) {
      if (result.kind === 'clip') {
        result.release();
      }
      release();
      return;
    }
    // Held, the tab is as it was at the event: the paste goes where it was
    // pressed. Released after two seconds, it goes where the selection is now.
    const base = held() ? state.update({ selection: recorded }).state : state;
    try {
      if (result.kind === 'text') {
        this.afterText(
          tabId,
          base,
          result.text,
          held() ? lock : undefined,
          release,
        );
      } else if (result.kind === 'clip') {
        await this.afterClip(tabId, base, result, held() ? lock : undefined);
      } else {
        release();
      }
    } catch {
      if (result.kind === 'clip') {
        result.release();
      }
      release();
    }
  }

  private lockFor(tabId: string, held: PasteLock | undefined): PasteLock {
    const { locks } = this.deps;
    const lock = held ?? locks.begin(tabId, 'wait');
    const full = locks.upgrade(tabId, lock.id) ?? lock;
    this.host.showLock(tabId, full);
    return full;
  }
  private convert(
    tabId: string,
    base: EditorState,
    held: PasteLock | undefined,
    ranges: PasteRange[],
    linewise: boolean,
    source: PasteSource,
    clip: { pin: number; release: () => void } | null,
  ): void {
    const { locks } = this.deps;
    const lock = this.lockFor(tabId, held);
    this.deps.startConversion({
      dest: this.host.dest,
      tabId,
      doc: base.doc,
      ranges: ranges.map((r) => ({ ...r })),
      linewise,
      source,
      clip,
      lockId: lock.id,
      unlock: () => {
        if (locks.end(tabId, lock.id)) {
          this.host.showLock(tabId, undefined);
        }
      },
    });
  }
  // Text the page holds: pasted as CodeMirror pastes it, in one transaction,
  // unless it makes the tab too big, which asks the conversion.
  private afterText(
    tabId: string,
    base: EditorState,
    text: string,
    held: PasteLock | undefined,
    release: (() => void) | null,
  ): void {
    const remembered = this.deps.lastLinewise();
    const source: PasteSource = { kind: 'text', text };
    const where = pasteRanges(base, source, remembered);
    const size = pastedSize({
      dest: this.host.dest,
      doc: base.doc,
      ranges: where.ranges,
      eol: this.host.eolOf(tabId),
      source,
      linewise: where.linewise,
    });
    const verdict = pasteDecision({
      dest: this.host.dest,
      full: !this.deps.isLite(),
      size: size.size,
    });
    if (verdict === 'convert') {
      this.convert(
        tabId,
        base,
        held,
        where.ranges,
        where.linewise,
        source,
        null,
      );
      return;
    }
    this.host.apply(tabId, {
      ...pasteSpec(base, text, remembered),
      userEvent: 'input.paste',
      scrollIntoView: true,
      annotations: held === undefined ? [] : pasteLockOwner.of(held.id),
    });
    release?.();
  }
  // A clip: too big for the tab, it asks the conversion, which takes the pin;
  // else its text is read back a block at a time through the pin, under the
  // lock, and pasted in one transaction as CodeMirror pastes text.
  private async afterClip(
    tabId: string,
    base: EditorState,
    clip: Extract<Resolved, { kind: 'clip' }>,
    held: PasteLock | undefined,
  ): Promise<void> {
    const { locks } = this.deps;
    const info = clip.info;
    const source: PasteSource = { kind: 'clip', info };
    const where = pasteRanges(base, source, null);
    const size = pastedSize({
      dest: this.host.dest,
      doc: base.doc,
      ranges: where.ranges,
      eol: this.host.eolOf(tabId),
      source,
      linewise: where.linewise,
    });
    const verdict = pasteDecision({
      dest: this.host.dest,
      full: !this.deps.isLite(),
      size: size.size,
    });
    if (verdict === 'convert') {
      this.convert(tabId, base, held, where.ranges, where.linewise, source, {
        pin: clip.pin,
        release: clip.release,
      });
      return;
    }
    const lock = held ?? locks.begin(tabId, 'wait');
    this.host.showLock(tabId, lock);
    try {
      let text: string;
      try {
        text = await readClip(this.deps, clip.pin, info);
      } catch (e) {
        this.deps.reportFailure(pasteErrorText(e));
        return;
      }
      if (locks.get(tabId)?.id === lock.id) {
        this.host.apply(tabId, {
          ...pasteSpec(base, text, info.linewise ? text : null),
          userEvent: 'input.paste',
          scrollIntoView: true,
          annotations: pasteLockOwner.of(lock.id),
        });
      }
    } finally {
      clip.release();
      if (locks.end(tabId, lock.id)) {
        this.host.showLock(tabId, undefined);
      }
    }
  }
}
/** Applies a transaction to the saved state of a tab that is not shown, and tells
 *  the window its document changed. Nothing when the tab has no saved state. */
export function applyToSavedState(
  states: Map<string, EditorState>,
  id: string,
  spec: TransactionSpec,
  oncontentof: (id: string, doc: Text) => void,
): void {
  const saved = states.get(id);
  if (saved !== undefined) {
    const next = saved.update(spec).state;
    states.set(id, next);
    oncontentof(id, next.doc);
  }
}

const targets = new WeakMap<object, (text: string) => void>();
/** Lets the editor `view` take pasted text from outside its own events. */
export function registerPasteTarget(
  view: object,
  paste: (text: string) => void,
): () => void {
  targets.set(view, paste);
  return () => {
    targets.delete(view);
  };
}
/** Pastes text that was read apart from a paste event (Edit > Paste where the
 *  menu is ours) the way the editor pastes its own events' text. False when
 *  the editor is not one of ours. */
export function routePastedText(view: object, text: string): boolean {
  const paste = targets.get(view);
  if (paste === undefined) {
    return false;
  }
  paste(text);
  return true;
}
