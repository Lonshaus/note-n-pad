// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Values shared with the Rust core (`encoding.rs`, whose tests read this file).
/** The most bytes of UTF-8 one chunk carries over IPC. */
export const IO_CHUNK_BYTES = 1048576;
/** Header naming a write session. */
export const IO_TOKEN_HEADER = 'x-note-n-pad-io-token';
/** Header giving the UTF-8 offset where a chunk starts. */
export const IO_OFFSET_HEADER = 'x-note-n-pad-io-offset';
/** A window's sessions are all in use; that one read or write goes over JSON. */
export const IO_SESSION_LIMIT = 'io-session-limit';
/** The file changed during a chunked read. */
export const FILE_CHANGED = 'file-changed';
