// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { READ_ONLY_DESTINATION, FILE_NOT_FOUND } from './protocol';
import {
  FILE_CHANGED,
  IO_CHUNK_BYTES,
  IO_OFFSET_HEADER,
  IO_SESSION_LIMIT,
  IO_TOKEN_HEADER,
} from './documentIoProtocol';
import {
  readDocument,
  writeBlocks,
  writeDocument,
  type Decoded,
} from './documentIo';
import { Text } from '@codemirror/state';
import { documentWindow, type DocTab } from '../state/documentWindow.svelte';
import { settingsState } from '../state/settings.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.stubGlobal('window', globalThis);

const mockInvoke = vi.mocked(invoke);
const JSON_RESULT: Decoded = {
  content: 'from json',
  encoding: 'Shift_JIS',
  had_bom: false,
  lossy: false,
};
type Answer = unknown | ((args: Record<string, unknown>) => unknown);
function respond(answer: Answer, args: Record<string, unknown>): unknown {
  return typeof answer === 'function'
    ? (answer as (a: Record<string, unknown>) => unknown)(args)
    : answer;
}
/** A fake core where every command answers from `answers` (a rejection when
 *  the answer is an `Error`-less string thrown from a function). */
function installCore(answers: Record<string, Answer>): void {
  mockInvoke.mockImplementation((async (
    cmd: string,
    args?: Record<string, unknown>,
  ) => {
    if (!(cmd in answers)) {
      throw new Error(`unexpected command ${cmd}`);
    }
    return respond(answers[cmd], args ?? {});
  }) as typeof invoke);
}
const bytes = (text: string): ArrayBuffer =>
  new TextEncoder().encode(text).buffer as ArrayBuffer;
const binary = (): ArrayBuffer => new ArrayBuffer(1);
const reject = (error: string) => () => {
  throw error;
};
function calledWith(cmd: string): number {
  return mockInvoke.mock.calls.filter((c) => c[0] === cmd).length;
}
/** A core that answers a chunked read with `chunks`, then empty. */
function readingCore(
  chunks: ArrayBuffer[],
  end: Answer = { contentBytes: 0, lossy: false },
): Record<string, Answer> {
  let index = 0;
  return {
    ipc_probe: binary(),
    read_begin: { token: '7', encoding: 'UTF-8', hadBom: false },
    doc_read_chunk: (args: Record<string, unknown>) => {
      expect(args['token']).toBe('7');
      return index < chunks.length ? chunks[index++] : new ArrayBuffer(0);
    },
    read_end: end,
    read_file_auto: JSON_RESULT,
    read_file_as: JSON_RESULT,
  };
}
function chunkedRead(chunks: ArrayBuffer[], contentBytes: number): void {
  installCore(readingCore(chunks, { contentBytes, lossy: false }));
}
beforeEach(() => {
  mockInvoke.mockReset();
});
describe('choosing the transport', () => {
  it('reads and writes over JSON when the probe does not answer with bytes', async () => {
    for (const probe of [undefined, [1, 2, 3], null]) {
      mockInvoke.mockReset();
      installCore({
        ipc_probe: probe,
        read_file_auto: JSON_RESULT,
        write_file_encoded: undefined,
      });
      await expect(readDocument('/a.txt')).resolves.toEqual(JSON_RESULT);
      await writeDocument({
        path: '/a.txt',
        content: 'x',
        encoding: 'UTF-8',
        withBom: false,
      });
      expect(calledWith('read_begin')).toBe(0);
      expect(calledWith('write_begin')).toBe(0);
      expect(calledWith('read_file_auto')).toBe(1);
      expect(calledWith('write_file_encoded')).toBe(1);
    }
  });
  it('falls back to JSON when the probe itself rejects', async () => {
    installCore({ read_file_auto: JSON_RESULT });
    await expect(readDocument('/a.txt')).resolves.toEqual(JSON_RESULT);
    expect(calledWith('ipc_probe')).toBe(1);
  });
  it('uses the chunked commands when the probe answers with bytes', async () => {
    chunkedRead([bytes('hi')], 2);
    const result = await readDocument('/a.txt');
    expect(result.content).toBe('hi');
    expect(calledWith('read_begin')).toBe(1);
    expect(calledWith('read_file_auto')).toBe(0);
  });
});
describe('chunked read', () => {
  it('passes the encoding through and the token as a string', async () => {
    const core = readingCore([bytes('ok')], { contentBytes: 2, lossy: true });
    installCore({
      ...core,
      read_begin: (args: Record<string, unknown>) => {
        expect(args).toEqual({ path: '/a.txt', encoding: 'Big5' });
        return { token: '18014398509481985', encoding: 'Big5', hadBom: false };
      },
      doc_read_chunk: (args: Record<string, unknown>) => {
        expect(args['token']).toBe('18014398509481985');
        return args['offset'] === 0 ? bytes('ok') : new ArrayBuffer(0);
      },
      read_end: (args: Record<string, unknown>) => {
        expect(args['token']).toBe('18014398509481985');
        return { contentBytes: 2, lossy: true };
      },
    });
    const result = await readDocument('/a.txt', 'Big5');
    expect(result).toEqual({
      content: 'ok',
      encoding: 'Big5',
      had_bom: false,
      lossy: true,
    });
  });
  it('joins characters split across chunks and keeps a BOM in the content', async () => {
    const text = '﻿日本語';
    const whole = new TextEncoder().encode(text);
    const a = whole.slice(0, 4).buffer as ArrayBuffer;
    const b = whole.slice(4).buffer as ArrayBuffer;
    chunkedRead([a, b], whole.byteLength);
    const result = await readDocument('/a.txt');
    expect(result.content).toBe(text);
  });
  it('fails when the total is one short or one over, and still ends the session', async () => {
    for (const wrong of [4, 6]) {
      mockInvoke.mockReset();
      chunkedRead([bytes('hello')], wrong);
      await expect(readDocument('/a.txt')).rejects.toThrow();
      expect(calledWith('read_end')).toBe(1);
      expect(calledWith('read_file_auto')).toBe(0);
    }
  });
  it('fails on a chunk that is not an ArrayBuffer and still ends the session', async () => {
    installCore(
      readingCore([[1, 2, 3] as unknown as ArrayBuffer], {
        contentBytes: 0,
        lossy: false,
      }),
    );
    await expect(readDocument('/a.txt')).rejects.toThrow();
    expect(calledWith('read_end')).toBe(1);
  });
  it('rereads over JSON on file-changed even when read_end rejects', async () => {
    installCore({
      ...readingCore([]),
      doc_read_chunk: reject(FILE_CHANGED),
      read_end: reject('unknown io session'),
    });
    await expect(readDocument('/a.txt')).resolves.toEqual(JSON_RESULT);
    expect(calledWith('read_file_auto')).toBe(1);
    expect(calledWith('read_end')).toBe(1);
  });
  it('rereads over JSON once at the session limit, without counting as a failure', async () => {
    installCore({ ...readingCore([]), read_begin: reject(IO_SESSION_LIMIT) });
    await expect(readDocument('/a.txt')).resolves.toEqual(JSON_RESULT);
    expect(calledWith('read_file_auto')).toBe(1);
    expect(calledWith('ipc_probe')).toBe(1);
  });
});
describe('a chunked read that fails', () => {
  it('redoes over JSON once when the probe has fallen back', async () => {
    let probes = 0;
    installCore({
      ...readingCore([bytes('x')]),
      ipc_probe: () => (probes++ === 0 ? binary() : [1]),
      doc_read_chunk: reject('transport gone'),
    });
    await expect(readDocument('/a.txt')).resolves.toEqual(JSON_RESULT);
    expect(calledWith('read_file_auto')).toBe(1);
  });
  it('reports the error as it arrived when the probe still answers with bytes', async () => {
    installCore({
      ...readingCore([]),
      read_begin: reject(FILE_NOT_FOUND),
    });
    let caught: unknown = null;
    try {
      await readDocument('/a.txt');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(FILE_NOT_FOUND);
    expect(calledWith('read_file_auto')).toBe(0);
  });
});
describe('writeBlocks', () => {
  const join = (blocks: Uint8Array[]): string => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return (
      blocks.map((b) => decoder.decode(b, { stream: true })).join('') +
      decoder.decode()
    );
  };
  it('stays under the limit and joins back to the text', () => {
    const text = 'a測\u{1F600}b'.repeat(4000);
    const blocks = [...writeBlocks(text, 64)];
    for (const block of blocks) {
      expect(block.byteLength).toBeLessThanOrEqual(64);
      expect(block.byteLength).toBeGreaterThan(0);
    }
    expect(join(blocks)).toBe(text);
  });
  it('keeps a surrogate pair whole at the boundary', () => {
    // Each block starts with ASCII so the first cut lands on the pair.
    const emoji = '\u{1F600}';
    const text = `abc${emoji}${emoji}xyz`;
    const limit = 4;
    const blocks = [...writeBlocks(text, limit)];
    // Lone halves would decode as U+FFFD or be refused by the fatal decoder.
    expect(join(blocks)).toBe(text);
    for (const block of blocks) {
      expect(block.byteLength).toBeLessThanOrEqual(limit);
    }
  });
  it('yields nothing for empty text', () => {
    expect([...writeBlocks('')]).toEqual([]);
  });
  it('honours the real limit with multi-byte text', () => {
    const text = '測'.repeat(2 * IO_CHUNK_BYTES);
    let total = 0;
    for (const block of writeBlocks(text)) {
      expect(block.byteLength).toBeLessThanOrEqual(IO_CHUNK_BYTES);
      total += block.byteLength;
    }
    expect(total).toBe(3 * text.length);
  });
});
/** A fake core recording what `writeDocument` sends. */
function writingCore(): {
  answers: Record<string, Answer>;
  chunks: { offset: string; token: string; bytes: Uint8Array }[];
} {
  const chunks: { offset: string; token: string; bytes: Uint8Array }[] = [];
  mockInvoke.mockImplementation((async (
    cmd: string,
    args?: unknown,
    options?: { headers: Record<string, string> },
  ) => {
    if (cmd === 'ipc_probe') {
      return binary();
    }
    if (cmd === 'write_begin') {
      return '42';
    }
    if (cmd === 'write_chunk') {
      const headers = options?.headers ?? {};
      chunks.push({
        offset: headers[IO_OFFSET_HEADER] ?? '',
        token: headers[IO_TOKEN_HEADER] ?? '',
        bytes: args as Uint8Array,
      });
      return undefined;
    }
    if (cmd === 'write_commit') {
      return undefined;
    }
    throw new Error(`unexpected command ${cmd}`);
  }) as typeof invoke);
  return { answers: {}, chunks };
}
const request = (content: string) => ({
  path: '/a.txt',
  content,
  encoding: 'UTF-8',
  withBom: false,
});
describe('chunked write', () => {
  it('sends blocks with their offsets and commits the total', async () => {
    const { chunks } = writingCore();
    const text = '測'.repeat(IO_CHUNK_BYTES);
    await writeDocument(request(text));
    expect(chunks.length).toBeGreaterThan(1);
    let expected = 0;
    for (const chunk of chunks) {
      expect(chunk.token).toBe('42');
      expect(chunk.offset).toBe(String(expected));
      expect(chunk.bytes.byteLength).toBeLessThanOrEqual(IO_CHUNK_BYTES);
      expected += chunk.bytes.byteLength;
    }
    expect(expected).toBe(3 * IO_CHUNK_BYTES);
    expect(mockInvoke).toHaveBeenLastCalledWith('write_commit', {
      token: '42',
      contentBytes: expected,
    });
    expect(calledWith('write_abort')).toBe(0);
  });
  it('commits empty content with no chunk at all', async () => {
    const { chunks } = writingCore();
    await writeDocument(request(''));
    expect(chunks).toHaveLength(0);
    expect(mockInvoke).toHaveBeenLastCalledWith('write_commit', {
      token: '42',
      contentBytes: 0,
    });
  });
  it('fails a lone surrogate instead of replacing it', async () => {
    const { chunks } = writingCore();
    await expect(writeDocument(request('bad \uD800 text'))).rejects.toThrow();
    expect(chunks).toHaveLength(0);
    expect(calledWith('write_begin')).toBe(0);
  });
  it('writes over JSON at the session limit without counting as a failure', async () => {
    installCore({
      ipc_probe: binary(),
      write_begin: reject(IO_SESSION_LIMIT),
      write_file_encoded: undefined,
    });
    await writeDocument(request('hi'));
    expect(calledWith('write_file_encoded')).toBe(1);
    expect(calledWith('ipc_probe')).toBe(1);
    expect(calledWith('write_chunk')).toBe(0);
  });
  it('after a refused chunk leaves the session alone and redoes over JSON once on fallback', async () => {
    let probes = 0;
    installCore({
      ipc_probe: () => (probes++ === 0 ? binary() : [1]),
      write_begin: '9',
      write_chunk: reject('expected a raw body'),
      write_file_encoded: undefined,
    });
    await writeDocument(request('hi'));
    expect(calledWith('write_file_encoded')).toBe(1);
    expect(calledWith('write_commit')).toBe(0);
    expect(calledWith('write_abort')).toBe(0);
  });
  it('redoes over JSON after a commit fails on fallback', async () => {
    let probes = 0;
    installCore({
      ipc_probe: () => (probes++ === 0 ? binary() : [1]),
      write_begin: '9',
      write_chunk: undefined,
      write_commit: reject('gone'),
      write_file_encoded: undefined,
    });
    await writeDocument(request('hi'));
    expect(calledWith('write_file_encoded')).toBe(1);
  });
  it('reports the refusal as it arrived when binary IPC still works', async () => {
    installCore({
      ipc_probe: binary(),
      write_begin: reject(READ_ONLY_DESTINATION),
    });
    let caught: unknown = null;
    try {
      await writeDocument(request('hi'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(READ_ONLY_DESTINATION);
    expect(calledWith('write_file_encoded')).toBe(0);
  });
  it('aborts when it gives up before commit without a refused chunk', async () => {
    const encode = vi
      .spyOn(TextEncoder.prototype, 'encode')
      .mockImplementationOnce(() => {
        throw new RangeError('out of memory');
      });
    installCore({
      ipc_probe: binary(),
      write_begin: '9',
      write_abort: undefined,
    });
    await expect(writeDocument(request('hi'))).rejects.toThrow('out of memory');
    expect(calledWith('write_abort')).toBe(1);
    encode.mockRestore();
  });
});
// The serializer Tauri uses when it falls back to postMessage
// (`scripts/process-ipc-message-fn.js`, tauri 2.12.5).
function processIpcMessage(message: unknown): {
  contentType: string;
  data: string;
} {
  const data = JSON.stringify(message, (_k, val: unknown) => {
    if (val instanceof Map) {
      return Object.fromEntries(val.entries());
    }
    if (val instanceof Uint8Array) {
      return Array.from(val);
    }
    if (val instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(val));
    }
    return val;
  });
  return { contentType: 'application/json', data };
}
describe('a write chunk on the postMessage route', () => {
  it('keeps the headers and turns the body into numbers', async () => {
    let chunkArgs: unknown;
    let chunkOptions: unknown;
    installCore({
      ipc_probe: binary(),
      write_begin: '42',
      write_commit: undefined,
    });
    const answered = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation(((
      cmd: string,
      args?: unknown,
      options?: unknown,
    ) => {
      if (cmd === 'write_chunk') {
        chunkArgs = args;
        chunkOptions = options;
        return Promise.resolve(undefined);
      }
      return answered(cmd, args as Record<string, unknown>);
    }) as typeof invoke);
    await writeDocument(request('hi'));
    const { data } = processIpcMessage({
      cmd: 'write_chunk',
      options: chunkOptions,
      payload: chunkArgs,
    });
    const parsed = JSON.parse(data) as {
      options: { headers: Record<string, string> };
      payload: number[];
    };
    expect(parsed.options.headers[IO_TOKEN_HEADER]).toBe('42');
    expect(parsed.options.headers[IO_OFFSET_HEADER]).toBe('0');
    expect(parsed.payload).toEqual([104, 105]);
  });
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** A core with `limit` chunked sessions; opens beyond that are refused. */
function sessionLimitedCore(limit: number): {
  answers: Record<string, Answer>;
  refused: { read: number; write: number };
} {
  const refused = { read: 0, write: 0 };
  let openReads = 0;
  let openWrites = 0;
  const answers: Record<string, Answer> = {
    ipc_probe: () => binary(),
    read_begin: () => {
      if (openReads >= limit) {
        refused.read += 1;
        throw IO_SESSION_LIMIT;
      }
      openReads += 1;
      return { token: `r${openReads}`, encoding: 'UTF-8', hadBom: false };
    },
    doc_read_chunk: (args: Record<string, unknown>) =>
      args['offset'] === 0 ? bytes('text') : new ArrayBuffer(0),
    read_end: async () => {
      await settle();
      openReads -= 1;
      return { contentBytes: 4, lossy: false };
    },
    write_begin: () => {
      if (openWrites >= limit) {
        refused.write += 1;
        throw IO_SESSION_LIMIT;
      }
      openWrites += 1;
      return `w${openWrites}`;
    },
    write_chunk: undefined,
    write_commit: async () => {
      await settle();
      openWrites -= 1;
    },
    read_file_auto: {
      content: 'text',
      encoding: 'UTF-8',
      had_bom: false,
      lossy: false,
    },
    write_file_encoded: undefined,
  };
  return { answers, refused };
}
function tabFor(path: string): DocTab {
  const content = Text.of(['changed']);
  return {
    id: path,
    path,
    readOnlyFile: false,
    content,
    savedContent: Text.of(['old']),
    language: null,
    explicit: false,
    lineEnding: 'LF',
    savedLineEnding: 'LF',
    hadBom: false,
    encoding: 'UTF-8',
    lossy: false,
    tabIndex: 0,
  } as unknown as DocTab;
}
describe('documents go through the helper', () => {
  beforeEach(async () => {
    installCore({ ipc_probe: undefined });
    mockInvoke.mockImplementation((async () => null) as typeof invoke);
    await settingsState.init().catch(() => {});
  });
  it('more saves and reads at once than sessions all finish, the extra over JSON', async () => {
    const limit = 16;
    const { answers, refused } = sessionLimitedCore(limit);
    const defaults = (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd in answers) {
        return respond(answers[cmd], args ?? {});
      }
      return null;
    }) as typeof invoke;
    mockInvoke.mockImplementation(defaults);
    documentWindow.tabs.length = 0;
    documentWindow.saveFailed = null;
    documentWindow.tabs.push(tabFor('/tmp/limit.txt'));
    documentWindow.activeIndex = 0;
    const saves = Array.from({ length: limit + 1 }, () =>
      documentWindow.saveActive(),
    );
    const reads = Array.from({ length: limit + 1 }, () =>
      readDocument('/tmp/limit.txt'),
    );
    const saved = await Promise.all(saves);
    const read = await Promise.all(reads);
    expect(saved.every((r) => r === true)).toBe(true);
    expect(read.map((d) => d.content)).toEqual(
      Array.from({ length: limit + 1 }, () => 'text'),
    );
    expect(documentWindow.saveFailed).toBeNull();
    expect(refused.write).toBe(1);
    expect(refused.read).toBe(1);
    expect(calledWith('write_file_encoded')).toBe(1);
    expect(calledWith('read_file_auto')).toBe(1);
  });
  it('a lossy chunked read shows as lossy on the tab', async () => {
    const answers: Record<string, Answer> = {
      ...sessionLimitedCore(4).answers,
      read_end: { contentBytes: 4, lossy: true },
      read_begin: { token: '1', encoding: 'UTF-8', hadBom: false },
      stat_file: { size: 10 },
      path_writable: true,
      list_notes: [],
      live_doc_groups: [],
    };
    const defaults = (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd in answers) {
        return respond(answers[cmd], args ?? {});
      }
      return null;
    }) as typeof invoke;
    mockInvoke.mockImplementation(defaults);
    documentWindow.tabs.length = 0;
    documentWindow.openFailed = null;
    await documentWindow.init('g', null, null);
    await documentWindow.openTab('/tmp/lossy.txt');
    const tab = documentWindow.tabs.find((t) => t.path === '/tmp/lossy.txt');
    expect(tab?.lossy).toBe(true);
    expect(tab?.content.toString()).toBe('text');
  });
});
