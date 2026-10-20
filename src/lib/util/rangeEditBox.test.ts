// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import {
  isRangeBoxDirty,
  nextRangeBox,
  openRangeBox,
  rangeBoxWriteText,
  type RangeBox,
  type RangeBoxInit,
} from './rangeEditBox';

function init(over: Partial<RangeBoxInit> = {}): RangeBoxInit {
  return {
    tabId: 'viewer',
    sourcePath: '/tmp/big.log',
    startByte: 6,
    endByte: 24,
    startLine: 2,
    endLine: 4,
    fingerprint: { size: 30, mtime_ms: 1 },
    text: 'line2\nline3\nline4\n',
    ...over,
  };
}

const text = (s: string): Text => Text.of(s.split('\n'));

describe('openRangeBox', () => {
  it('opens clean on the slice as read, with the span, lines and baseline kept', () => {
    const box = openRangeBox(init());
    expect(box.content.toString()).toBe('line2\nline3\nline4\n');
    expect(box.saved).toBe(box.content);
    expect(isRangeBoxDirty(box)).toBe(false);
    expect(box).toMatchObject({
      tabId: 'viewer',
      sourcePath: '/tmp/big.log',
      startByte: 6,
      endByte: 24,
      startLine: 2,
      endLine: 4,
      fingerprint: { size: 30, mtime_ms: 1 },
      conflict: false,
    });
  });

  it('holds an LF buffer and remembers the CRLF the slice had', () => {
    const box = openRangeBox(init({ text: 'a\r\nb\r\n' }));
    expect(box.content.toString()).toBe('a\nb\n');
    expect(box.lineEnding).toBe('CRLF');
  });

  it('remembers whether the slice ended with a line break', () => {
    expect(openRangeBox(init({ text: 'a\nb\n' })).trailingBreak).toBe(true);
    expect(openRangeBox(init({ text: 'a\nb' })).trailingBreak).toBe(false);
    expect(openRangeBox(init({ text: '' })).trailingBreak).toBe(false);
  });

  it('opens an empty slice as an empty buffer', () => {
    const box = openRangeBox(init({ text: '' }));
    expect(box.content.length).toBe(0);
    expect(isRangeBoxDirty(box)).toBe(false);
  });
});

describe('editing', () => {
  const open = (): RangeBox => openRangeBox(init());

  it('turns the box dirty without touching the baseline', () => {
    const box = nextRangeBox(open(), {
      kind: 'edit',
      content: text('line2\nline3\nline4\nnew'),
    })!;
    expect(isRangeBoxDirty(box)).toBe(true);
    expect(box.saved.toString()).toBe('line2\nline3\nline4\n');
    expect(box.content.toString()).toBe('line2\nline3\nline4\nnew');
  });

  it('is clean again once the text is typed back', () => {
    const edited = nextRangeBox(open(), {
      kind: 'edit',
      content: text('x'),
    })!;
    const back = nextRangeBox(edited, {
      kind: 'edit',
      content: text('line2\nline3\nline4\n'),
    })!;
    expect(isRangeBoxDirty(back)).toBe(false);
  });

  it('leaves the box it was given as it was', () => {
    const before = open();
    nextRangeBox(before, { kind: 'edit', content: text('x') });
    expect(before.content.toString()).toBe('line2\nline3\nline4\n');
  });
});

describe('closing and conflicts', () => {
  const dirty = (): RangeBox =>
    nextRangeBox(openRangeBox(init()), {
      kind: 'edit',
      content: text('changed'),
    })!;

  it('a successful save closes the box', () => {
    expect(nextRangeBox(dirty(), { kind: 'saved' })).toBeNull();
  });

  it('cancel closes the box, changes and all', () => {
    expect(nextRangeBox(dirty(), { kind: 'cancel' })).toBeNull();
  });

  it('a changed source raises the conflict and keeps the text', () => {
    const box = nextRangeBox(dirty(), { kind: 'mismatch' })!;
    expect(box.conflict).toBe(true);
    expect(box.content.toString()).toBe('changed');
    expect(isRangeBoxDirty(box)).toBe(true);
  });

  it('dismissing the conflict goes back to the box with its text', () => {
    const conflicted = nextRangeBox(dirty(), { kind: 'mismatch' })!;
    const box = nextRangeBox(conflicted, { kind: 'conflict-dismissed' })!;
    expect(box.conflict).toBe(false);
    expect(box.content.toString()).toBe('changed');
  });

  it('a force-write after a conflict closes the box', () => {
    const conflicted = nextRangeBox(dirty(), { kind: 'mismatch' })!;
    expect(nextRangeBox(conflicted, { kind: 'saved' })).toBeNull();
  });

  it('a box that is not open stays closed', () => {
    for (const kind of ['saved', 'mismatch', 'conflict-dismissed', 'cancel']) {
      expect(
        nextRangeBox(null, { kind } as Parameters<typeof nextRangeBox>[1]),
      ).toBeNull();
    }
    expect(nextRangeBox(null, { kind: 'edit', content: text('x') })).toBeNull();
  });
});

describe('rangeBoxWriteText', () => {
  const edited = (source: string, buffer: string): RangeBox =>
    nextRangeBox(openRangeBox(init({ text: source })), {
      kind: 'edit',
      content: text(buffer),
    })!;

  it('writes the buffer back in the slice’s own line ending', () => {
    expect(rangeBoxWriteText(edited('a\r\nb\r\n', 'a\nb\nc\n'))).toBe(
      'a\r\nb\r\nc\r\n',
    );
  });

  it('puts the break back on text typed on the empty last line', () => {
    expect(rangeBoxWriteText(edited('a\nb\n', 'a\nb\nZZ'))).toBe('a\nb\nZZ\n');
  });

  it('adds no break when the slice had none', () => {
    expect(rangeBoxWriteText(edited('a\nb', 'a\nbZZ'))).toBe('a\nbZZ');
  });

  it('writes nothing for an emptied buffer, which removes the span', () => {
    expect(rangeBoxWriteText(edited('a\nb\n', ''))).toBe('');
  });
});
