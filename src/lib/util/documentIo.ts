// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Reads and writes an ordinary document over IPC in chunks of raw bytes,
// using the JSON commands whenever raw bytes cannot cross.
import { invoke } from '@tauri-apps/api/core';
import {
  FILE_CHANGED,
  IO_CHUNK_BYTES,
  IO_OFFSET_HEADER,
  IO_SESSION_LIMIT,
  IO_TOKEN_HEADER,
} from './documentIoProtocol';
/** What `read_file_auto` and `read_file_as` answer with. */
export interface Decoded {
  content: string;
  encoding: string;
  had_bom: boolean;
  lossy: boolean;
}
export interface WriteRequest {
  path: string;
  content: string;
  encoding: string;
  withBom: boolean;
}
interface ReadBegun {
  token: string;
  encoding: string;
  hadBom: boolean;
}
interface ReadEnded {
  contentBytes: number;
  lossy: boolean;
}
/** Whether raw byte responses currently reach this page. */
async function binaryIpc(): Promise<boolean> {
  try {
    return (await invoke('ipc_probe')) instanceof ArrayBuffer;
  } catch {
    return false;
  }
}
function readJson(path: string, encoding?: string): Promise<Decoded> {
  return encoding === undefined
    ? invoke<Decoded>('read_file_auto', { path })
    : invoke<Decoded>('read_file_as', { path, encoding });
}
function writeJson(request: WriteRequest): Promise<void> {
  return invoke('write_file_encoded', { ...request });
}
/** After a chunk failed: redo the whole thing over JSON when binary IPC is no
 *  longer available, otherwise fail with the error as it arrived. */
async function redoIfFallback<T>(
  error: unknown,
  overJson: () => Promise<T>,
): Promise<T> {
  if (await binaryIpc()) {
    throw error;
  }
  return overJson();
}
async function endRead(token: string): Promise<void> {
  try {
    await invoke('read_end', { token });
  } catch {
    // The core may already have removed the session.
  }
}
/** Read `path` (auto-detecting, or as `encoding`). The result is the same as
 *  the JSON commands' whichever transport carried it. */
export async function readDocument(
  path: string,
  encoding?: string,
): Promise<Decoded> {
  const overJson = (): Promise<Decoded> => readJson(path, encoding);
  // One await here: `binaryIpc` would add ticks before the JSON call.
  let probe: unknown;
  try {
    probe = await invoke('ipc_probe');
  } catch {
    probe = null;
  }
  if (!(probe instanceof ArrayBuffer)) {
    return overJson();
  }
  let begun: ReadBegun;
  try {
    begun = await invoke<ReadBegun>(
      'read_begin',
      encoding === undefined ? { path } : { path, encoding },
    );
  } catch (e) {
    if (String(e) === IO_SESSION_LIMIT) {
      return overJson();
    }
    return redoIfFallback(e, overJson);
  }
  const { token } = begun;
  // `ignoreBOM` keeps a U+FEFF that belongs to the content.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let content = '';
  let received = 0;
  try {
    for (;;) {
      const chunk = await invoke<unknown>('doc_read_chunk', {
        token,
        offset: received,
      });
      if (!(chunk instanceof ArrayBuffer)) {
        throw new Error('doc_read_chunk did not answer with bytes');
      }
      if (chunk.byteLength === 0) {
        break;
      }
      content += decoder.decode(chunk, { stream: true });
      received += chunk.byteLength;
    }
    content += decoder.decode();
  } catch (e) {
    await endRead(token);
    if (String(e) === FILE_CHANGED) {
      return overJson();
    }
    return redoIfFallback(e, overJson);
  }
  try {
    const ended = await invoke<ReadEnded>('read_end', { token });
    if (ended.contentBytes !== received) {
      throw new Error('chunked read lost bytes');
    }
    return {
      content,
      encoding: begun.encoding,
      had_bom: begun.hadBom,
      lossy: ended.lossy,
    };
  } catch (e) {
    return redoIfFallback(e, overJson);
  }
}
const SURROGATE_HIGH_START = 0xd800;
const SURROGATE_LOW_START = 0xdc00;
const SURROGATE_LOW_END = 0xe000;
/** Whether the unit before `at` and the one at it are one surrogate pair. */
function splitsPair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) {
    return false;
  }
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return (
    before >= SURROGATE_HIGH_START &&
    before < SURROGATE_LOW_START &&
    after >= SURROGATE_LOW_START &&
    after < SURROGATE_LOW_END
  );
}
/** Successive UTF-8 blocks of `text`, each at most `limit` bytes, never cutting
 *  a surrogate pair in two. */
export function* writeBlocks(
  text: string,
  limit: number = IO_CHUNK_BYTES,
): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + limit, text.length);
    let block: Uint8Array;
    for (;;) {
      if (splitsPair(text, end)) {
        end = end - 1 > at ? end - 1 : end + 1;
      }
      block = encoder.encode(text.slice(at, end));
      if (block.byteLength <= limit) {
        break;
      }
      end =
        at + Math.max(1, Math.floor(((end - at) * limit) / block.byteLength));
    }
    yield block;
    at = end;
  }
}
async function abortWrite(token: string): Promise<void> {
  try {
    await invoke('write_abort', { token });
  } catch {
    // Nothing left to abort.
  }
}
/** Write a document (the same bytes and refusals as `write_file_encoded`). */
export async function writeDocument(request: WriteRequest): Promise<void> {
  const { path, content, encoding, withBom } = request;
  const overJson = (): Promise<void> => writeJson(request);
  // See `readDocument` for why this is awaited here.
  let probe: unknown;
  try {
    probe = await invoke('ipc_probe');
  } catch {
    probe = null;
  }
  if (!(probe instanceof ArrayBuffer)) {
    return overJson();
  }
  // `TextEncoder` would silently turn a lone surrogate into U+FFFD.
  if (!content.isWellFormed()) {
    throw new Error('content has a lone surrogate');
  }
  let token: string;
  try {
    token = await invoke<string>('write_begin', { path, encoding, withBom });
  } catch (e) {
    if (String(e) === IO_SESSION_LIMIT) {
      return overJson();
    }
    return redoIfFallback(e, overJson);
  }
  let offset = 0;
  let chunkRefused = false;
  try {
    for (const block of writeBlocks(content)) {
      try {
        await invoke('write_chunk', block, {
          headers: {
            [IO_TOKEN_HEADER]: token,
            [IO_OFFSET_HEADER]: String(offset),
          },
        });
      } catch (e) {
        // A refused chunk has already ended the session in the core.
        chunkRefused = true;
        throw e;
      }
      offset += block.byteLength;
    }
  } catch (e) {
    if (!chunkRefused) {
      await abortWrite(token);
    }
    return redoIfFallback(e, overJson);
  }
  try {
    await invoke('write_commit', { token, contentBytes: offset });
  } catch (e) {
    return redoIfFallback(e, overJson);
  }
}
