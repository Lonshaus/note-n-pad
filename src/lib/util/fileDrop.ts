// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Windows only: Tauri's drop handler is off there, so the page receives the
// drop and hands the files to the native side, which reads their paths. On
// macOS an outside file drag never reaches the page and nothing here acts.

interface NativeWebview {
  postMessageWithAdditionalObjects(
    message: string,
    objects: ArrayLike<unknown>,
  ): void;
}
/** The message `file_drop.rs` listens for. */
const FILE_DROP_MESSAGE = 'note-n-pad:file-drop';
/** Whether a drag carries files from outside the page. */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes('Files');
}
/** WebView2's `window.chrome.webview`; undefined in every other webview. */
function nativeWebview(): NativeWebview | undefined {
  const webview = (
    globalThis as { chrome?: { webview?: Partial<NativeWebview> } }
  ).chrome?.webview;
  return typeof webview?.postMessageWithAdditionalObjects === 'function'
    ? (webview as NativeWebview)
    : undefined;
}

function fileTransfer(e: DragEvent): DataTransfer | null {
  const transfer = e.dataTransfer;
  return transfer !== null && isFileDrag(transfer.types) ? transfer : null;
}
/** Capture-phase `dragover`: accept a file drag so the drop fires. */
export function onFileDragOver(e: DragEvent): void {
  const transfer = fileTransfer(e);
  if (transfer === null || nativeWebview() === undefined) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  transfer.dropEffect = 'copy';
}
/**
 * Capture-phase `drop`: forward the files natively. Stopping the event keeps
 * the editor from inserting the file's text into the document.
 */
export function onFileDrop(e: DragEvent): void {
  const transfer = fileTransfer(e);
  const webview = nativeWebview();
  if (transfer === null || webview === undefined) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  webview.postMessageWithAdditionalObjects(FILE_DROP_MESSAGE, transfer.files);
}
