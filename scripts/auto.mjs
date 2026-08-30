#!/usr/bin/env node
// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Driver for the Note&Pad debug automation socket. Zero deps.
//   node scripts/auto.mjs '{"id":1,"cmd":"list_windows"}'   send one request
//   node scripts/auto.mjs --repl                            one JSON per stdin line
// Port comes from NOTE_N_PAD_AUTOMATION_PORT (default 45678).
import net from 'node:net';
import readline from 'node:readline';

const PORT = Number(process.env.NOTE_N_PAD_AUTOMATION_PORT) || 45678;

/** Open a connection, send one request line, resolve with the response line. */
function send(line) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PORT, '127.0.0.1');
    let buf = '';
    socket.on('connect', () => socket.write(line.trim() + '\n'));
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        socket.end();
        resolve(buf.slice(0, nl));
      }
    });
    socket.on('error', reject);
    socket.on('end', () => resolve(buf.trim()));
  });
}

const arg = process.argv[2];
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
