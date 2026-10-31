// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A paste that makes a document or a sticky note too big for its editor turns
// it into a large file: the user is asked, the content around the paste and the
// pasted content are written to a conversion file in the core, and the tab is
// installed over that file, or the note is handed to a document window. A
// result too big to edit is saved and shown in the view instead.

import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { t } from '../i18n';
import { convertOps } from '../util/convertStream';
import type { ConversionRequest } from '../util/pasteFlow';
import { pasteErrorText } from '../util/pasteRouting';
import { READ_ONLY_DESTINATION } from '../util/protocol';
import { saveDialogOptions, suggestedName } from '../util/saveDialog';
import type { LineEnding } from '../util/text';
import { settingsState } from './settings.svelte';
/** Which button of a dialog was pressed ('cancel' is also Esc). */
export type ConvertButton = 'primary' | 'secondary' | 'tertiary' | 'cancel';
/** A dialog the conversion asks, texts already in the UI language. */
export interface ConvertDialog {
  id: number;
  kind: 'confirm' | 'tooBig' | 'conflict' | 'unmappable' | 'error';
  message: string;
  primary?: string;
  secondary?: string;
  cancel: string;
}
type DialogSpec = Omit<ConvertDialog, 'id'>;
/** What the conversion needs of a tab it is to replace. */
export interface ConvertTabInfo {
  path: string;
  encoding: string;
  hadBom: boolean;
  lineEnding: LineEnding;
  language: string | null;
}
/** The document window as a conversion sees it. */
export interface DocConvertHost {
  /** The tab, or null once it is gone. */
  tab: (tabId: string) => ConvertTabInfo | null;
  /** Makes the tab a large file over the finished conversion `convertId`, in
   *  place. Rejects with the reason, and the tab is then as it was. */
  install: (tabId: string, convertId: string) => Promise<void>;
  /** Shows the tab as the read-only view of the saved file `path`. */
  showViewer: (tabId: string, path: string, size: number) => Promise<void>;
}
/** The sticky window as a conversion sees it. */
export interface StickyConvertHost {
  noteId: () => string | null;
  language: () => string | null;
  /** Has the note's record up to date: it is what the note comes back as. */
  flush: () => Promise<void>;
  /** Opens the saved file as a document the way a file is opened, and takes the
   *  note away. */
  openSaved: (path: string) => Promise<void>;
}
interface Fingerprint {
  size: number;
  mtime_ms: number;
}
/** The run is given up; `where` is the check that found it so. */
class Cancelled extends Error {
  readonly where: string;
  constructor(where: string) {
    super(where);
    this.where = where;
  }
}
/** The save of a result too big to edit failed: where to, and the core's error. */
class ConvertSaveFailed extends Error {
  readonly path: string;
  readonly why: string;
  constructor(path: string, why: string) {
    super(why);
    this.path = path;
    this.why = why;
  }
}
/** The fingerprint of the file at `path`, asked for at the paste; null when it
 *  could not be had. */
interface Baseline {
  path: string;
  fingerprint: Promise<Fingerprint | null>;
}
/** One conversion under way. */
export interface Job {
  request: ConversionRequest;
  cancelled: boolean;
  /** The conversion file, until the core takes it over or it is deleted. */
  convertId: string | null;
  /** The fingerprint the document's file had when the paste was made, asked for
   *  before the user is. Null for a tab with no file. */
  baseline: Baseline | null;
  /** The fingerprint the save back is checked against. */
  expected: Fingerprint | null;
  pinReleased: boolean;
}

const baselineOf = (path: string): Baseline => ({
  path,
  fingerprint: invoke<Fingerprint>('file_fingerprint', { path }).catch(
    () => null,
  ),
});

const confirmSpec = (): DialogSpec => ({
  kind: 'confirm',
  message: t('convert.confirm'),
  primary: t('convert.continue'),
  cancel: t('common.cancel'),
});
const tooBigSpec = (): DialogSpec => ({
  kind: 'tooBig',
  message: t('convert.tooBig'),
  primary: t('convert.tooBig.save'),
  cancel: t('convert.tooBig.discard'),
});
const conflictSpec = (): DialogSpec => ({
  kind: 'conflict',
  message: t('doc.windowedConflict.message'),
  primary: t('doc.conflict.writeAnyway'),
  secondary: t('doc.conflict.saveAsNew'),
  cancel: t('common.cancel'),
});
const unmappableSpec = (name: string, encoding: string): DialogSpec => ({
  kind: 'unmappable',
  message: t('convert.unmappable', { name, encoding }),
  primary: t('convert.unmappable.utf8'),
  secondary: t('convert.unmappable.saveAs'),
  cancel: t('common.cancel'),
});
const errorSpec = (message: string): DialogSpec => ({
  kind: 'error',
  message,
  cancel: t('common.close'),
});
/** The name of the file a message speaks of. */
function nameOf(path: string): string {
  return path === '' ? t('doc.untitled') : (path.split(/[/\\]/).pop() ?? path);
}

export class ConvertController {
  /** The dialog on screen: the first of those waiting. */
  dialog = $state<ConvertDialog | null>(null);
  private waiting: {
    dialog: ConvertDialog;
    job: Job | null;
    resolve: (b: ConvertButton) => void;
  }[] = [];
  private nextDialog = 0;
  private jobs = new Map<string, Job>();
  /** How the last run ended, for the automation hooks. */
  lastExit: string | null = null;
  /** The notes handed to a document window and not yet taken over, by note id. */
  private handoffs = new Map<string, Job>();
  private docHost: DocConvertHost | null = null;
  private stickyHost: StickyConvertHost | null = null;

  attachDoc(host: DocConvertHost | null): void {
    this.docHost = host;
  }
  attachSticky(host: StickyConvertHost | null): void {
    this.stickyHost = host;
  }
  /** The tabs that have a conversion under way. */
  jobTabIds(): string[] {
    return [...this.jobs.keys()];
  }
  /** Whether a conversion holds the tab. */
  busy(tabId: string): boolean {
    return this.jobs.has(tabId);
  }
  // ---- dialogs ----
  /** Asks the user; resolves with the button. A cancelled job's dialogs answer
   *  'cancel' by themselves. */
  ask(job: Job | null, spec: DialogSpec): Promise<ConvertButton> {
    if (job?.cancelled === true) {
      return Promise.resolve('cancel');
    }
    return new Promise((resolve) => {
      this.waiting.push({
        dialog: { ...spec, id: (this.nextDialog += 1) },
        job,
        resolve,
      });
      this.show();
    });
  }
  /** The D13 question, for a save of a tab that cannot be written in its
   *  encoding. */
  async askUnmappable(
    name: string,
    encoding: string,
  ): Promise<'utf8' | 'saveAs' | 'cancel'> {
    const button = await this.ask(null, unmappableSpec(name, encoding));
    return button === 'primary'
      ? 'utf8'
      : button === 'secondary'
        ? 'saveAs'
        : 'cancel';
  }
  /** A report of a failure. */
  report(message: string): void {
    void this.ask(null, errorSpec(message));
  }
  /** The user pressed `button` of the dialog on screen. */
  answer(button: ConvertButton): void {
    const first = this.waiting.shift();
    if (first === undefined) {
      return;
    }
    this.show();
    first.resolve(button);
  }
  private show(): void {
    this.dialog = this.waiting[0]?.dialog ?? null;
  }
  // ---- the conversion ----
  /** A paste that makes the tab a large file. The tab is locked until this
   *  calls `request.unlock()`. */
  start(request: ConversionRequest): void {
    const path =
      request.dest === 'document'
        ? (this.docHost?.tab(request.tabId)?.path ?? '')
        : '';
    const job: Job = {
      request,
      cancelled: false,
      convertId: null,
      baseline: path === '' ? null : baselineOf(path),
      expected: null,
      pinReleased: false,
    };
    this.jobs.set(request.tabId, job);
    void this.run(job);
  }
  /** The tab was closed: its conversion is given up. */
  cancelTab(tabId: string): void {
    const job = this.jobs.get(tabId);
    if (job !== undefined) {
      this.cancel(job);
    }
  }
  /** The window closes: every conversion is given up. */
  cancelAll(): void {
    for (const job of this.jobs.values()) {
      this.cancel(job);
    }
  }
  private cancel(job: Job): void {
    job.cancelled = true;
    for (const w of this.waiting.filter((x) => x.job === job)) {
      this.waiting = this.waiting.filter((x) => x !== w);
      w.resolve('cancel');
    }
    this.show();
    // A job that waits for a handoff has nothing running to notice.
    for (const [noteId, held] of this.handoffs) {
      if (held === job) {
        this.handoffs.delete(noteId);
        this.finish(job);
      }
    }
  }
  /** The core took the sticky note's handoff back (`convert-reclaimed`): the
   *  note unlocks and the user is told. */
  reclaimed(noteId: string): void {
    const job = this.handoffs.get(noteId);
    if (job === undefined) {
      return;
    }
    this.handoffs.delete(noteId);
    this.finish(job);
    this.report(t('convert.reclaimed'));
  }
  /** Gives the pin of the clip back, once. */
  private releasePin(job: Job): void {
    if (!job.pinReleased) {
      job.pinReleased = true;
      job.request.clip?.release();
    }
  }
  private check(job: Job): void {
    if (job.cancelled) {
      throw new Cancelled('check: job cancelled');
    }
    if (
      job.request.dest === 'document' &&
      this.docHost?.tab(job.request.tabId) == null
    ) {
      throw new Cancelled('check: tab gone');
    }
  }
  private finish(job: Job): void {
    if (this.jobs.get(job.request.tabId) === job) {
      this.jobs.delete(job.request.tabId);
    }
    job.request.unlock();
  }
  private info(job: Job): ConvertTabInfo {
    if (job.request.dest === 'sticky') {
      return {
        path: '',
        encoding: settingsState.defaultEncoding,
        hadBom: false,
        lineEnding: settingsState.defaultLineEnding,
        language: this.stickyHost?.language() ?? null,
      };
    }
    const tab = this.docHost?.tab(job.request.tabId);
    if (tab === undefined || tab === null) {
      throw new Cancelled('info: tab gone');
    }
    return tab;
  }

  private async run(job: Job): Promise<void> {
    let failure: { error: unknown } | null = null;
    let keepLock = false;
    let exit = 'completed';
    try {
      const answer = await this.ask(job, confirmSpec());
      if (answer !== 'primary') {
        exit = `answer: ${answer}`;
        return;
      }
      this.check(job);
      const info = this.info(job);
      if (job.request.dest === 'document' && info.path !== '') {
        // The tab may have been saved elsewhere meanwhile: the file it has now
        // is asked about anew.
        const base =
          job.baseline?.path === info.path
            ? job.baseline
            : baselineOf(info.path);
        job.expected = await base.fingerprint;
      }
      const id = await invoke<string>('convert_begin', {
        eol: info.lineEnding === 'CRLF' ? '\r\n' : '\n',
      });
      job.convertId = id;
      await this.stream(job, id);
      // The clip is in the file; the pin is not needed any more.
      this.releasePin(job);
      const done = await invoke<{ bytes: number; editable: boolean }>(
        'convert_finish',
        { id },
      );
      this.check(job);
      if (!done.editable) {
        exit = await this.tooBig(job, id, info);
      } else if (job.request.dest === 'document') {
        // The core owns the file from here on, whatever comes of it.
        job.convertId = null;
        await this.docHost?.install(job.request.tabId, id);
      } else {
        const noteId = this.stickyHost?.noteId() ?? null;
        if (noteId === null) {
          throw new Error('no note');
        }
        await this.stickyHost?.flush();
        this.check(job);
        // The core owns the file from here on, whatever comes of it.
        job.convertId = null;
        await invoke<number>('convert_handoff_start', {
          noteId,
          convertId: id,
          language: info.language,
          encoding: info.encoding,
          lineEnding: info.lineEnding,
        });
        // The note stays locked until its window is closed by the core or the
        // handoff comes back.
        this.handoffs.set(noteId, job);
        keepLock = true;
      }
    } catch (e) {
      if (e instanceof Cancelled) {
        exit = e.where;
      } else {
        exit = 'error';
        failure = { error: e };
      }
    } finally {
      this.lastExit = `${job.request.tabId}: ${exit}, cancelled=${job.cancelled}`;
      this.releasePin(job);
      if (job.convertId !== null) {
        const id = job.convertId;
        job.convertId = null;
        void invoke('convert_abort', { id }).catch(() => {});
      }
      if (!keepLock) {
        this.finish(job);
      }
    }
    if (failure !== null) {
      const error = failure.error;
      this.report(
        error instanceof ConvertSaveFailed
          ? error.why === READ_ONLY_DESTINATION
            ? t('doc.saveReadOnly', { name: nameOf(error.path) })
            : t('doc.saveFailed', {
                name: nameOf(error.path),
                error: error.why,
              })
          : t('convert.failed', { error: pasteErrorText(error) }),
      );
    }
  }
  /** Writes the document around the places, and what is pasted at them. */
  private async stream(job: Job, id: string): Promise<void> {
    const r = job.request;
    for (const op of convertOps(r)) {
      this.check(job);
      if (op.kind === 'text') {
        await invoke('convert_append', { id, text: op.text });
        continue;
      }
      // A pin that was let go ('pin-gone') fails the conversion as any other
      // failure does.
      const pin = r.clip?.pin;
      if (pin === undefined) {
        throw new Error('no clip');
      }
      if (op.kind === 'clip') {
        await invoke('convert_append_clip', { id, pin });
      } else {
        await invoke('convert_append_clip_line', { id, pin, line: op.line });
      }
    }
  }
  private async pickPath(
    info: ConvertTabInfo,
    suggested: string,
  ): Promise<string | null> {
    return save(saveDialogOptions(info.language, suggested));
  }
  /** D16: the result is too big to edit. The user may have it saved and shown in
   *  the view, or have nothing pasted. Returns how it ended, for `lastExit`. */
  private async tooBig(
    job: Job,
    id: string,
    info: ConvertTabInfo,
  ): Promise<string> {
    const answer = await this.ask(job, tooBigSpec());
    if (answer !== 'primary') {
      return `tooBig answer: ${answer}`;
    }
    let target: string | null = info.path === '' ? null : info.path;
    let expected = job.expected;
    let encoding = info.encoding;
    let bom = info.hadBom;
    if (target === null) {
      target = await this.pickPath(info, 'Untitled');
      if (target === null) {
        return 'tooBig: no path';
      }
    }
    let saved: Fingerprint;
    for (;;) {
      this.check(job);
      try {
        saved = await invoke<Fingerprint>('convert_save', {
          convertId: id,
          target,
          encoding,
          withBom: bom,
          expected,
        });
        // The file is deleted by the save.
        job.convertId = null;
        break;
      } catch (e) {
        const why = String(e);
        if (why === 'fingerprint-mismatch') {
          const choice = await this.ask(job, conflictSpec());
          if (choice === 'primary') {
            expected = null;
            continue;
          }
          if (choice === 'secondary') {
            const other = await this.pickPath(info, suggestedName(target));
            if (other === null) {
              return 'tooBig conflict: no path';
            }
            target = other;
            expected = null;
            continue;
          }
          return `tooBig conflict: ${choice}`;
        }
        if (why === 'unmappable') {
          const choice = await this.ask(
            job,
            unmappableSpec(nameOf(target), encoding),
          );
          if (choice === 'primary') {
            encoding = 'UTF-8';
            bom = false;
            continue;
          }
          if (choice === 'secondary') {
            const other = await this.pickPath(info, suggestedName(target));
            if (other === null) {
              return 'tooBig unmappable: no path';
            }
            target = other;
            encoding = 'UTF-8';
            bom = false;
            continue;
          }
          return `tooBig unmappable: ${choice}`;
        }
        throw new ConvertSaveFailed(target, why);
      }
    }
    if (job.cancelled) {
      return 'tooBig: cancelled after save';
    }
    if (job.request.dest === 'document') {
      await this.docHost?.showViewer(job.request.tabId, target, saved.size);
    } else {
      await this.stickyHost?.openSaved(target);
    }
    return 'completed';
  }
}

export const convertController = new ConvertController();
