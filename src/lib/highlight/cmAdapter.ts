// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** CodeMirror binding for the editor-agnostic highlight worker.
 *
 *  This is the ONLY file in `src/lib/highlight/` allowed to import
 *  `@codemirror/*`. Everything else in the module (protocol, core, worker,
 *  languages, client) stays free of any editor engine so the same worker can
 *  back a future non-CodeMirror surface. This adapter translates between CM's
 *  transactions/viewport and the worker's `protocol` messages, and turns the
 *  spans it streams back into CM decorations. */
import type { ChangeSet, Extension, Range } from '@codemirror/state';
import { StateEffect, StateField } from '@codemirror/state';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { HighlightClient } from './client';
import { isCurrent, nextVersion } from './protocol';
import type { Edit, OutboundMessage, SpanRange } from './protocol';
import { markWorkerActive, markWorkerInactive } from './workerHighlight.svelte';

/** Turn worker spans into CM decoration ranges (a `tok-*` mark per span). The
 *  input is in document order (as `extractSpans` produces it), which is exactly
 *  the sort order `RangeSet` requires for `add`. Pure. */
export function spansToDecorations(
  ranges: readonly SpanRange[],
): Range<Decoration>[] {
  return ranges.map((r) =>
    Decoration.mark({ class: r.cls }).range(r.from, r.to),
  );
}

/** Translate a CM `ChangeSet` into the worker's edit batch. `iterChanges`
 *  reports each change in coordinates of the document *before* the batch — the
 *  exact convention `protocol.Edit` and `core.applyEditsToText` expect. Pure. */
export function changesToEdits(changes: ChangeSet): Edit[] {
  const edits: Edit[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    edits.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return edits;
}

/** Replace the highlight decorations covering `[from, to)` with a fresh set. */
const setSpansEffect = StateEffect.define<{
  from: number;
  to: number;
  ranges: readonly SpanRange[];
}>();

/** Holds the current highlight decorations. It maps through every change so
 *  existing spans keep valid positions until the worker returns fresh spans for
 *  the new document version. */
const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setSpansEffect)) {
        const { from, to, ranges } = effect.value;
        deco = deco.update({
          filterFrom: from,
          filterTo: to,
          filter: () => false,
          add: spansToDecorations(ranges),
        });
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Owns one worker session for the live view: sends the document, edits and
 *  viewport, and dispatches the spans it gets back into `highlightField`. The
 *  main thread owns the version counter and bumps it per edit batch; spans
 *  tagged with a superseded version are dropped (a fresh parse is already on the
 *  way, since every edit re-triggers the worker). */
class WorkerHighlightPlugin {
  private readonly client: HighlightClient;
  private version = 0;

  constructor(
    private readonly view: EditorView,
    language: string,
    createClient: () => HighlightClient,
  ) {
    this.client = createClient();
    this.client.onMessage((message) => {
      this.onMessage(message);
    });
    this.client.post({
      type: 'init',
      docText: view.state.doc.toString(),
      language,
      version: this.version,
    });
    this.postViewport();
    markWorkerActive();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.version = nextVersion(this.version);
      this.client.post({
        type: 'edits',
        changes: changesToEdits(update.changes),
        version: this.version,
      });
    }
    if (update.viewportChanged) {
      this.postViewport();
    }
  }

  destroy(): void {
    this.client.post({ type: 'dispose' });
    this.client.terminate();
    markWorkerInactive();
  }

  private onMessage(message: OutboundMessage): void {
    if (message.type !== 'spans' || !isCurrent(message.version, this.version)) {
      return;
    }
    this.view.dispatch({
      effects: setSpansEffect.of({
        from: message.from,
        to: message.to,
        ranges: message.ranges,
      }),
    });
  }

  private postViewport(): void {
    const { from, to } = this.view.viewport;
    this.client.post({ type: 'viewport', from, to });
  }
}

/** Extension that highlights the document off the main thread. Add it (in its
 *  own compartment) only for oversized documents where the synchronous CM
 *  language path is disabled; `language` must be a canonical worker id. */
export function workerHighlight(config: {
  language: string;
  createClient: () => HighlightClient;
}): Extension {
  return [
    highlightField,
    ViewPlugin.define(
      (view) =>
        new WorkerHighlightPlugin(view, config.language, config.createClient),
    ),
  ];
}
