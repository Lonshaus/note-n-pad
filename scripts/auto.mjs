#!/usr/bin/env node
// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Driver for the Note&Pad debug automation socket. Zero deps.
//   node scripts/auto.mjs '{"id":1,"cmd":"list_windows"}'   send one request
//   node scripts/auto.mjs --repl                            one JSON per stdin line
// Port comes from NOTE_N_PAD_AUTOMATION_PORT (default 21456). Per-connection
// timeout comes from NOTE_N_PAD_AUTO_TIMEOUT_MS (default 60000).
import net from 'node:net';
import readline from 'node:readline';

const PORT = Number(process.env.NOTE_N_PAD_AUTOMATION_PORT) || 21456;
const TIMEOUT_MS = Number(process.env.NOTE_N_PAD_AUTO_TIMEOUT_MS) || 60000;

/** The id of a request line, or null when it has none to match against. */
function requestId(line) {
  try {
    const id = JSON.parse(line).id;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

/** Whether <raw> is a response to the request with <id>. Every response carries
 *  a boolean `ok` and no request does, which is what makes this reject the
 *  request line read back verbatim: a port inside the ephemeral range can
 *  self-connect on loopback, and accepting the echo would report a live app
 *  when nothing is listening at all. */
function isResponse(raw, id) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return false;
  }
  if (msg === null || typeof msg !== 'object' || typeof msg.ok !== 'boolean') {
    return false;
  }
  return id === null || msg.id === id;
}

/** Open a connection, send one request line, resolve with the response line. */
function send(line) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PORT, '127.0.0.1');
    const id = requestId(line);
    let buf = '';
    socket.setTimeout(TIMEOUT_MS);
    socket.on('connect', () => socket.write(line.trim() + '\n'));
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        socket.end();
        const raw = buf.slice(0, nl);
        if (isResponse(raw, id)) {
          resolve(raw);
        } else {
          reject(
            new Error(
              `automation socket answered with a non-response: ${raw.slice(0, 120)}`,
            ),
          );
        }
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`automation socket timed out after ${TIMEOUT_MS}ms`));
    });
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = buf.trim();
      if (!raw) {
        reject(new Error('automation socket closed with no response'));
      } else if (isResponse(raw, id)) {
        resolve(raw);
      } else {
        reject(
          new Error(
            `automation socket answered with a non-response: ${raw.slice(0, 120)}`,
          ),
        );
      }
    });
  });
}

const arg = process.argv[2];
// A failed request is routine — the app is down, or shutting down mid-call —
// and every caller's stderr lands in a suite log, so report one line rather
// than an unhandled-rejection stack. The non-zero exit is what callers read.
try {
  if (arg === '--repl') {
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (line.trim()) {
        console.log(await send(line));
      }
    }
  } else if (arg) {
    console.log(await send(arg));
  } else {
    console.error("usage: node scripts/auto.mjs '<json>' | --repl");
    process.exit(1);
  }
} catch (err) {
  console.error(`auto: ${err.message}`);
  process.exit(1);
}
