// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Background syntax-highlight worker.
 *
 *  Runs Lezer incremental parsing off the main thread and streams highlight
 *  spans back through the protocol in `./protocol`. It never imports any
 *  CodeMirror runtime — only `@lezer/*` — so the same worker can back a future
 *  non-CodeMirror editor. This file is intentionally thin: all testable logic
 *  lives in `./core`, and this shell only wires messages to that logic. */
import type { Parser, Tree } from '@lezer/common';
import { TreeFragment } from '@lezer/common';
import {
  HighlightSession,
  applyEditsToText,
  extractSpans,
  reusableFragments,
} from './core';
import { loadParser, resolveLanguageId } from './languages';
import { isCurrent } from './protocol';
import type { InboundMessage, OutboundMessage } from './protocol';

/** Narrow view of the dedicated-worker global, typed without pulling in the
 *  conflicting `webworker` lib. Everything used here exists at runtime. */
const worker = globalThis as unknown as {
  postMessage(message: OutboundMessage): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: InboundMessage }) => void,
  ): void;
  close?: () => void;
};

/** Wall-clock time budget per parse slice before yielding to the event loop. */
const SLICE_MS = 15;

let parser: Parser | null = null;
let doc = '';
let version = 0;
let viewport = { from: 0, to: 0 };
/** Fragments seeding the next parse (reuse from the previous tree). */
let pendingFragments: readonly TreeFragment[] = [];
/** The most recent fully parsed tree, kept for incremental reuse. */
let lastTree: Tree | null = null;
let currentSession: HighlightSession | null = null;
/** Bumped whenever a new run supersedes the one in flight. */
let runToken = 0;

function post(message: OutboundMessage): void {
  worker.postMessage(message);
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function emitSpans(
  tree: Tree,
  from: number,
  to: number,
  parseVersion: number,
): void {
  if (from >= to || !isCurrent(parseVersion, version)) {
    return;
  }
  post({
    type: 'spans',
    version: parseVersion,
    from,
    to,
    ranges: extractSpans(tree, from, to),
  });
}

/** Drive one session to `stopPos`, yielding between slices and reporting
 *  progress. Returns the finished tree, or null if superseded or cancelled. */
async function parseTo(
  fragments: readonly TreeFragment[],
  stopPos: number,
  token: number,
  parseVersion: number,
): Promise<Tree | null> {
  if (!parser) {
    return null;
  }
  const session = new HighlightSession(parser, doc, fragments, stopPos);
  currentSession = session;
  for (;;) {
    if (token !== runToken) {
      return null;
    }
    const tree = session.advance(SLICE_MS, () => performance.now());
    if (isCurrent(parseVersion, version)) {
      post({
        type: 'progress',
        version: parseVersion,
        parsedBytes: session.parsedPos,
        total: doc.length,
      });
    }
    if (session.isCancelled) {
      return null;
    }
    if (tree) {
      return tree;
    }
    await yieldToLoop();
  }
}

/** Highlight the current document: viewport region first, then the whole
 *  document in the background. */
async function run(parseVersion: number): Promise<void> {
  const token = ++runToken;
  if (!parser) {
    return;
  }
  const total = doc.length;
  const viewportEnd = Math.min(Math.max(viewport.to, 0), total);
  const viewportStart = Math.min(Math.max(viewport.from, 0), viewportEnd);
  const treeA = await parseTo(
    pendingFragments,
    viewportEnd,
    token,
    parseVersion,
  );
  if (!treeA) {
    return;
  }
  emitSpans(treeA, viewportStart, viewportEnd, parseVersion);
  let finalTree = treeA;
  if (viewportEnd < total) {
    const treeB = await parseTo(
      TreeFragment.addTree(treeA),
      total,
      token,
      parseVersion,
    );
    if (!treeB) {
      return;
    }
    finalTree = treeB;
  }
  emitSpans(finalTree, 0, total, parseVersion);
  lastTree = finalTree;
  if (isCurrent(parseVersion, version)) {
    post({ type: 'done', version: parseVersion });
  }
}

async function handleInit(
  language: string,
  docText: string,
  msgVersion: number,
): Promise<void> {
  const id = resolveLanguageId(language);
  if (!id) {
    post({ type: 'error', message: `Unsupported language: ${language}` });
    return;
  }
  doc = docText;
  version = msgVersion;
  pendingFragments = [];
  lastTree = null;
  try {
    parser = await loadParser(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', message: `Failed to load parser: ${message}` });
    return;
  }
  if (!isCurrent(msgVersion, version)) {
    return;
  }
  void run(version);
}

worker.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      void handleInit(message.language, message.docText, message.version);
      break;
    }
    case 'edits': {
      doc = applyEditsToText(doc, message.changes);
      version = message.version;
      pendingFragments = lastTree
        ? reusableFragments(lastTree, message.changes)
        : [];
      lastTree = null;
      void run(version);
      break;
    }
    case 'viewport': {
      viewport = { from: message.from, to: message.to };
      pendingFragments = lastTree ? TreeFragment.addTree(lastTree) : [];
      void run(version);
      break;
    }
    case 'cancel': {
      runToken++;
      currentSession?.cancel();
      break;
    }
    case 'dispose': {
      runToken++;
      currentSession?.cancel();
      parser = null;
      lastTree = null;
      pendingFragments = [];
      worker.close?.();
      break;
    }
  }
});
