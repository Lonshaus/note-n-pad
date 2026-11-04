// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Where a paste comes from and where it goes. The clipboard may hold a clip of
// ours (a file the core wrote for text too big for the web clipboard) or text
// from another app; only the core knows which, so a paste never reads the web
// clipboard before it has asked. Free of the DOM and Tauri, so it unit-tests
// in isolation.

import type { Text } from '@codemirror/state';
import { SNAPSHOT_CONTENT_MAX } from './snapshotPolicy';
import type { ClipFocus, ClipInfo } from './clipRouting';
import type { LiveTokens } from './liveTokens';
import { t } from '../i18n';
/** Mirrors `LARGE_FILE_THRESHOLD` of the document window: above it an open
 *  goes to the large-file mode, and so does a paste that would grow past it. */
export const PASTE_DOC_LIMIT = 100 * 1024 * 1024;
/** How long a read of external text may run before the editor is released. */
export const PASTE_SLOW_MS = 2000;
/** The wait before asking again while a clip is being handed over. */
export const BUSY_RETRY_MS = 20;
/** What `clip_text_begin` answers. */
export type TextBegin =
  | { kind: 'ours'; info: ClipInfo }
  | { kind: 'gate'; token: number }
  | { kind: 'busy' };
/** What a paste turns out to hold. 'system' is the text of the system
 *  clipboard, which only the core reads. */
export type Resolved =
  | {
      kind: 'clip';
      info: ClipInfo;
      /** The pin that keeps the clip readable, whatever the clipboard holds
       *  later. The paste reads the clip through it. */
      pin: number;
      /** Lets go of the pin; the paste calls it when it is over, once. */
      release: () => void;
    }
  | { kind: 'text'; text: string }
  | { kind: 'system' }
  | { kind: 'none' };
/** The mark the core numbered a paste with at the event, or null when the
 *  core could not (nothing to wait for then). */
export type MarkInput = Promise<number | null> | number | null;
/** The part of a paste event the window listener reads. */
export interface PasteEventLike {
  clipboardData: { getData: (type: string) => string } | null;
  preventDefault: () => void;
  stopImmediatePropagation: () => void;
}
/** Whether a read of external text may still be taken: its gate is open. */
export interface GateState {
  open: boolean;
}
/** The pastes that wait for the system to hand the web page the clipboard's
 *  text (macOS: the core sends a paste to the focused element). Its listener
 *  is the first on the window, and takes an event only for a wait whose gate
 *  is open: a gate that is closed says the clipboard may hold a clip of ours,
 *  which the page must never read. */
export class RedispatchWaiter {
  private waiting: { gate: GateState; resolve: (text: string) => void }[] = [];
  /** Waits for the next paste event that comes while `gate` is open. */
  expect(gate: GateState): { text: Promise<string>; cancel: () => void } {
    let entry: { gate: GateState; resolve: (text: string) => void } | undefined;
    const text = new Promise<string>((resolve) => {
      entry = { gate, resolve };
      this.waiting.push(entry);
    });
    return {
      text,
      cancel: () => {
        this.waiting = this.waiting.filter((w) => w !== entry);
      },
    };
  }
  /** The window's capture listener for `paste`. */
  handle = (e: PasteEventLike): void => {
    this.waiting = this.waiting.filter((w) => w.gate.open);
    const first = this.waiting.shift();
    if (first === undefined) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    first.resolve(pastedText(e.clipboardData));
  };
}
/** The text of a paste event as CodeMirror reads it: text, else a URI list. */
export function pastedText(
  data: { getData: (type: string) => string } | null,
): string {
  if (data === null) {
    return '';
  }
  const text = data.getData('text/plain');
  return text !== '' ? text : data.getData('text/uri-list');
}
/** What `resolveClip` needs from the host. */
export interface ResolveDeps {
  /** `std::env::consts::OS` of the host. */
  platform: string;
  /** `clip_status`: waits for the clip copies reserved before `mark`. */
  clipStatus: (mark: number | null) => Promise<ClipInfo | null>;
  textBegin: () => Promise<TextBegin>;
  /** `clip_text_end`: closes the gate. Resolves with whether the core still
   *  held it, false when it ran out or was let go meanwhile. */
  textEnd: (token: number) => Promise<boolean>;
  /** Calls back with the token of each gate of this window the core revokes
   *  (`clip-gate-revoked`); returns the removal. */
  onGateRevoked: (cb: (token: number) => void) => () => void;
  /** `clip_pin`: rejects with 'not-ours' when the clipboard does not hold the
   *  clip. */
  pin: (clipId: string) => Promise<number>;
  /** `clip_unpin`. */
  unpin: (pin: number) => void;
  /** macOS: asks the core to send a paste to the focused element. */
  redispatchPaste: () => Promise<'send' | 'not-key' | 'not-handled'>;
  /** Windows: the web page's own clipboard read. */
  readText: () => Promise<string>;
  /** Focus is still where the paste happened. */
  focusStill: () => boolean;
  waiter: RedispatchWaiter;
  /** Calls back on each keydown, pointerdown or input of the window. */
  userInput: (cb: () => void) => () => void;
  tokens: LiveTokens;
  sleep: (ms: number) => Promise<void>;
}
export interface ResolveOptions {
  /** The read of external text has run for `PASTE_SLOW_MS`. */
  onSlow?: () => void;
}
/** What the clipboard holds for a paste made at `mark`. 'web' may read the
 *  text of another app in the page, 'core' leaves that to the core. */
export async function resolveClip(
  deps: ResolveDeps,
  mark: MarkInput,
  textVia: 'web' | 'core',
  options: ResolveOptions = {},
): Promise<Resolved> {
  const at = await Promise.resolve(mark).catch(() => null);
  let lost = 0;
  for (;;) {
    const info = await deps.clipStatus(at).catch(() => null);
    if (info !== null) {
      // A clip that is gone by the time it is pinned is no clip: the clipboard
      // holds something else.
      const pinned = await pinClip(deps, info);
      if (pinned !== null) {
        return pinned;
      }
    }
    if (textVia === 'core') {
      return { kind: 'system' };
    }
    let begin: TextBegin;
    try {
      begin = await deps.textBegin();
    } catch {
      return { kind: 'none' };
    }
    if (begin.kind === 'ours') {
      const pinned = await pinClip(deps, begin.info);
      if (pinned !== null) {
        return pinned;
      }
      lost += 1;
      if (lost >= 4) {
        return { kind: 'none' };
      }
      continue;
    }
    if (begin.kind === 'busy') {
      await deps.sleep(BUSY_RETRY_MS);
      continue;
    }
    return readExternal(deps, begin.token, options);
  }
}
// Pins the clip at once; null when the clipboard no longer holds it. The pin has
// no deadline: `release` or the window going lets go of it.
async function pinClip(
  deps: ResolveDeps,
  info: ClipInfo,
): Promise<Resolved | null> {
  let pin: number;
  try {
    pin = await deps.pin(info.id);
  } catch {
    return null;
  }
  let released = false;
  return {
    kind: 'clip',
    info,
    pin,
    release: () => {
      if (!released) {
        released = true;
        deps.unpin(pin);
      }
    },
  };
}
// The gate is open from here to the end: a clip of ours is never handed to the
// system clipboard meanwhile, so what the page reads is somebody else's text.
// It stays open, renewed, for as long as the read takes; the user's own input
// after the editor was released revokes the wait, and so does the core when
// another window's clip has waited for the gate that long.
async function readExternal(
  deps: ResolveDeps,
  token: number,
  options: ResolveOptions,
): Promise<Resolved> {
  const gate: GateState = { open: true };
  const forget = deps.tokens.hold('gate', token);
  let ended: Promise<boolean> | null = null;
  const end = (): Promise<boolean> => {
    if (ended === null) {
      gate.open = false;
      forget();
      ended = deps.textEnd(token);
    }
    return ended;
  };
  let slow: ReturnType<typeof setTimeout> | undefined;
  let stopInput: (() => void) | undefined;
  let stopRevoke: (() => void) | undefined;
  let cancelWait: (() => void) | undefined;
  try {
    if (!deps.focusStill()) {
      return { kind: 'none' };
    }
    const revoked = new Promise<null>((resolve) => {
      stopRevoke = deps.onGateRevoked((revokedToken) => {
        if (revokedToken === token) {
          void end();
          resolve(null);
        }
      });
      slow = setTimeout(() => {
        options.onSlow?.();
        stopInput = deps.userInput(() => {
          void end();
          resolve(null);
        });
      }, PASTE_SLOW_MS);
    });
    const read =
      deps.platform === 'macos'
        ? redispatched(deps, gate, (cancel) => {
            cancelWait = cancel;
          })
        : deps.readText().then(
            (text) => text,
            () => null,
          );
    const text = await Promise.race([read, revoked]);
    if (text === null || text === '' || !gate.open) {
      return { kind: 'none' };
    }
    // The core takes the gate away only now: text read after it ran out or was
    // let go may be our own clip's, and is dropped.
    return (await end()) ? { kind: 'text', text } : { kind: 'none' };
  } finally {
    clearTimeout(slow);
    stopInput?.();
    stopRevoke?.();
    cancelWait?.();
    void end();
  }
}

async function redispatched(
  deps: ResolveDeps,
  gate: GateState,
  setCancel: (cancel: () => void) => void,
): Promise<string | null> {
  const wait = deps.waiter.expect(gate);
  setCancel(wait.cancel);
  let sent: 'send' | 'not-key' | 'not-handled';
  try {
    sent = await deps.redispatchPaste();
  } catch {
    return null;
  }
  return sent === 'send' ? wait.text : null;
}
/** The size a paste leaves a document or a sticky note at, in what the limit
 *  of its kind counts: UTF-8 bytes of the file for a document, UTF-16 units
 *  for a note. */
export type PasteDest = 'document' | 'sticky';
export type PasteSource =
  { kind: 'clip'; info: ClipInfo } | { kind: 'text'; text: string };

export function sizeLimit(dest: PasteDest): number {
  return dest === 'document' ? PASTE_DOC_LIMIT : SNAPSHOT_CONTENT_MAX;
}
/** UTF-8 length of a string, a lone surrogate counted as the replacement
 *  character an encoder writes. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        n += 4;
        i += 1;
      } else {
        n += 3;
      }
    } else {
      n += 3;
    }
  }
  return n;
}
function utf8Range(doc: Text, from: number, to: number): number {
  let n = 0;
  if (to <= from) {
    return 0;
  }
  const it = doc.iterRange(from, to);
  while (!it.next().done) {
    n += utf8Length(it.value);
  }
  return n;
}
/** One place a paste goes: `from`-`to` is replaced. `line` is the 1-based line
 *  of the pasted text that goes here when CodeMirror gives each selection one
 *  line of it, null when the whole text goes here. */
export interface PasteRange {
  from: number;
  to: number;
  line: number | null;
}
/** What the pasted text amounts to once its line breaks are `\n`. */
function pastedShape(
  source: PasteSource,
  linewise: boolean,
): { bytes: number; units: number; breaks: number } {
  let bytes: number;
  let units: number;
  let breaks: number;
  if (source.kind === 'clip') {
    const info = source.info;
    bytes = info.bytes - info.crlf;
    units = info.utf16_len - info.crlf;
    breaks = Math.max(info.lines - 1, 0);
  } else {
    const flat = source.text.replace(/\r\n?/g, '\n');
    bytes = utf8Length(flat);
    units = flat.length;
    breaks = 0;
    for (let i = flat.indexOf('\n'); i !== -1; i = flat.indexOf('\n', i + 1)) {
      breaks += 1;
    }
  }
  if (linewise) {
    bytes += 1;
    units += 1;
    breaks += 1;
  }
  return { bytes, units, breaks };
}
/** The size of the document or note once `source` replaces `ranges` (or
 *  `from`-`to`), and whether it is exact: when the worst case the lengths allow
 *  (three bytes a unit, a break written as two) is under `limit` it is returned
 *  as it is and the document is not read. The ranges are the selection's, in
 *  order and apart. */
export function pastedSize(s: {
  dest: PasteDest;
  doc: Text;
  from?: number;
  to?: number;
  ranges?: PasteRange[];
  /** The line ending the document is written with; a note is always `\n`. */
  eol: '\n' | '\r\n';
  source: PasteSource;
  /** The paste inserts a line break after the text, above the caret line. */
  linewise?: boolean;
  limit?: number;
}): { size: number; exact: boolean } {
  const limit = s.limit ?? sizeLimit(s.dest);
  const linewise = s.linewise === true;
  const ranges: PasteRange[] = s.ranges ?? [
    { from: s.from ?? 0, to: s.to ?? s.from ?? 0, line: null },
  ];
  const whole = pastedShape(s.source, linewise);
  let lines: string[] | null = null;
  let pastedUnits = 0;
  let pastedBytes = 0;
  let pastedBreaks = 0;
  let removed = 0;
  let removedBreaks = 0;
  let clipPieces = 0;
  for (const r of ranges) {
    removed += r.to - r.from;
    removedBreaks += s.doc.lineAt(r.to).number - s.doc.lineAt(r.from).number;
    if (r.line !== null && s.source.kind === 'clip') {
      // A line of a clip: the lines together are the clip without its breaks,
      // counted once below; only the break a line-wise paste adds is here.
      clipPieces += 1;
      if (linewise) {
        pastedUnits += 1;
        pastedBytes += 1;
        pastedBreaks += 1;
      }
      continue;
    }
    let shape = whole;
    if (r.line !== null && s.source.kind === 'text') {
      lines ??= s.source.text.replace(/\r\n?/g, '\n').split('\n');
      shape = pastedShape(
        { kind: 'text', text: lines[r.line - 1] ?? '' },
        linewise,
      );
    }
    pastedUnits += shape.units;
    pastedBytes += shape.bytes;
    pastedBreaks += shape.breaks;
  }
  if (clipPieces > 0 && s.source.kind === 'clip') {
    // Every line of the clip goes to one range; with a caret line met twice, a
    // line is not used and this is a little more than the paste adds.
    const info = s.source.info;
    const breaks = Math.max(info.lines, 1) - 1;
    pastedBytes += info.bytes - info.crlf - breaks;
    pastedUnits += info.utf16_len - info.crlf - breaks;
  }
  const keptUnits = s.doc.length - removed;
  if (s.dest === 'sticky') {
    return { size: keptUnits + pastedUnits, exact: true };
  }
  const crlf = s.eol === '\r\n';
  const breaks = s.doc.lines - 1 - removedBreaks + pastedBreaks;
  const worst = (keptUnits + pastedUnits) * 3 + (crlf ? breaks : 0);
  if (worst <= limit) {
    return { size: worst, exact: false };
  }
  let kept = 0;
  let at = 0;
  for (const r of ranges) {
    kept += utf8Range(s.doc, at, r.from);
    at = r.to;
  }
  kept += utf8Range(s.doc, at, s.doc.length);
  return {
    size: kept + pastedBytes + (crlf ? breaks : 0),
    exact: true,
  };
}
/** D8: whether a paste converts the tab to the large-file mode or is pasted as
 *  it is. The free edition never converts. */
export function pasteDecision(s: {
  dest: PasteDest;
  full: boolean;
  size: number;
}): 'convert' | 'paste' {
  return s.full && s.size > sizeLimit(s.dest) ? 'convert' : 'paste';
}
/** Where a paste goes in a document: a line-wise paste of a clip inserts above
 *  the caret line, with a line break after the text; anything else replaces the
 *  selection. */
export function pasteRange(
  doc: Text,
  main: { from: number; to: number; head: number; empty: boolean },
  linewise: boolean,
): { from: number; to: number; appendBreak: boolean } {
  if (linewise && main.empty) {
    const line = doc.lineAt(main.head);
    return { from: line.from, to: line.from, appendBreak: true };
  }
  return { from: main.from, to: main.to, appendBreak: false };
}
/** What a paste in the large-file editor does with the event. */
export type WindowedPasteAction =
  | { kind: 'field' }
  | { kind: 'queue'; item: { kind: 'clipPaste'; mark: MarkInput } }
  | { kind: 'native' };
/** 'field': a find or goto field has focus and handles its own paste. 'queue':
 *  the paste waits in the replay queue, behind the input typed before it, with
 *  the mark taken at the event. 'native': no clips on this platform. */
export function windowedPasteAction(s: {
  focus: ClipFocus;
  hasClips: boolean;
  mark: MarkInput;
}): WindowedPasteAction {
  if (s.focus === 'other') {
    return { kind: 'field' };
  }
  if (s.hasClips) {
    return { kind: 'queue', item: { kind: 'clipPaste', mark: s.mark } };
  }
  return { kind: 'native' };
}
/** Whether the page may read external text for a queued paste: the selection
 *  fits the window, the editor takes input and has the focus. */
export function windowedTextVia(s: {
  fits: boolean;
  editable: boolean;
  focused: boolean;
}): 'web' | 'core' {
  return s.fits && s.editable && s.focused ? 'web' : 'core';
}
/** Prefix of the core's error for a read of a clip the system failed. */
const CLIP_READ = 'clip-read: ';
/** The ending Rust gives an `io::Error` the operating system raised. */
const OS_ERROR = / \(os error -?\d+\)$/;
/** What a failed paste or conversion says to the user, never an internal code:
 *  the clip is unreadable for the codes that say so, a read the system failed
 *  gives its detail, an operating system error is shown as it came, and anything
 *  else is an interrupted conversion, the error going to the console. */
export function pasteErrorText(error: unknown): string {
  const why = error instanceof Error ? error.message : String(error);
  if (
    why === 'pin-gone' ||
    why === 'not-utf8' ||
    why === 'clip-stalled' ||
    why === 'line-out-of-range'
  ) {
    return t('paste.clipUnreadable');
  }
  if (why.startsWith(CLIP_READ)) {
    return t('paste.clipReadFailed', { detail: why.slice(CLIP_READ.length) });
  }
  if (OS_ERROR.test(why)) {
    return why;
  }
  console.error(why);
  return t('convert.interrupted');
}
/** The calls a queued paste makes in the core. */
export interface WindowedPasteIo<R> {
  /** Pastes the clip read through `pin`. */
  pasteClip: (pin: number, info: ClipInfo) => Promise<R>;
  pasteSystem: () => Promise<R>;
  /** `clip_status` with no mark. */
  clipStatus: () => Promise<ClipInfo | null>;
  pin: (clipId: string) => Promise<number>;
  unpin: (pin: number) => void;
  /** Tells the user the clip could not be read, with `pasteErrorText`. */
  report: (error: string) => void;
}
/** Runs a paste the clipboard decided in the core and lets go of the pin it
 *  holds. The system's text may turn out to be a clip of ours ('ours'): it is
 *  pinned then and pasted as a clip. 'gone' when the pin was let go (the page
 *  reloaded, say): the user is told through `io.report`, and nothing was
 *  changed. */
export async function runWindowedPaste<R>(
  io: WindowedPasteIo<R>,
  first:
    | { kind: 'clip'; info: ClipInfo; pin: number; release: () => void }
    | { kind: 'system' },
): Promise<{ kind: 'done'; value: R } | { kind: 'gone' }> {
  let step = first;
  const extra: number[] = [];
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const value =
          step.kind === 'clip'
            ? await io.pasteClip(step.pin, step.info)
            : await io.pasteSystem();
        return { kind: 'done', value };
      } catch (e) {
        const why = String(e);
        if (why === 'pin-gone' || why.startsWith(CLIP_READ)) {
          io.report(pasteErrorText(why));
          return { kind: 'gone' };
        }
        if (step.kind === 'system' && why === 'ours') {
          const info = await io.clipStatus();
          let pin: number | null = null;
          if (info !== null) {
            pin = await io.pin(info.id).catch(() => null);
          }
          if (info === null || pin === null) {
            step = { kind: 'system' };
          } else {
            extra.push(pin);
            step = { kind: 'clip', info, pin, release: () => {} };
          }
        } else {
          throw e;
        }
      }
    }
    throw new Error('the clipboard kept changing');
  } finally {
    if (first.kind === 'clip') {
      first.release();
    }
    for (const pin of extra) {
      io.unpin(pin);
    }
  }
}
/** The part of a text field a paste touches. */
export interface PasteField {
  selectionStart: number | null;
  selectionEnd: number | null;
  setRangeText: (text: string, start: number, end: number, mode: 'end') => void;
  dispatchEvent: (e: Event) => boolean;
}
export interface FieldDeps extends Omit<ResolveDeps, 'focusStill'> {
  /** `clip_paste_mark`, called at the event. */
  clipPasteMark: () => Promise<number | null>;
  hasFocus: () => boolean;
  activeElement: () => unknown;
  /** Types `text` into the focused field, replacing its selection. */
  insertText: (text: string) => void;
}
/** Whether the host has clips at all: a paste there is routed through the core. */
export function hasClips(platform: string): boolean {
  return platform === 'macos' || platform === 'windows';
}
/** A paste into a text field. A clip is refused (it is too big for a field);
 *  text from another app goes in at the selection the field had at the event.
 *  A field with no selection API (`type="number"`) takes it at its caret, as
 *  typed. Where there are no clips the field pastes as it does. */
export async function fieldPaste(
  e: { preventDefault: () => void },
  field: PasteField,
  deps: FieldDeps,
): Promise<void> {
  if (!hasClips(deps.platform)) {
    return;
  }
  e.preventDefault();
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? start;
  const mark = deps.clipPasteMark();
  const result = await resolveClip(
    {
      ...deps,
      focusStill: () => deps.hasFocus() && deps.activeElement() === field,
    },
    mark,
    'web',
  );
  if (result.kind === 'clip') {
    result.release();
  }
  if (
    result.kind === 'text' &&
    deps.hasFocus() &&
    deps.activeElement() === field
  ) {
    if (field.selectionStart === null) {
      deps.insertText(result.text);
    } else {
      field.setRangeText(result.text, start, end, 'end');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}
