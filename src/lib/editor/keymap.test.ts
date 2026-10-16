// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  EditorSelection,
  EditorState,
  type Transaction,
} from '@codemirror/state';
import { keymap, type EditorView, type KeyBinding } from '@codemirror/view';
import { indentLess, indentMore } from '@codemirror/commands';
import {
  cursorLineStart,
  defaultKeymap,
  historyKeymap,
  selectLine,
  selectParentSyntax,
  undoSelection,
} from '@codemirror/commands';
import { foldCode, foldKeymap } from '@codemirror/language';
import {
  gotoLine,
  searchKeymap,
  selectNextOccurrence,
} from '@codemirror/search';
import {
  closeBracketsKeymap,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete';
import type { KeyLike } from '../util/accelerator';
import { offscreenArrowKeys } from './offscreenArrow';
import {
  REBINDABLE,
  buildKeymap,
  keymapExtension,
  resolveCodeNamedKey,
  shiftTabKey,
  tabKey,
  toCodeMirrorKeys,
  type KeymapProfile,
} from './keymap';

describe('toCodeMirrorKeys', () => {
  it('spells modifiers out and lowercases letters', () => {
    expect(toCodeMirrorKeys('Ctrl+Shift+K', 'windows')).toEqual([
      'Ctrl-Shift-k',
    ]);
    expect(toCodeMirrorKeys('Alt+Cmd+G', 'macos')).toEqual(['Alt-Meta-g']);
    expect(toCodeMirrorKeys('Shift+Cmd+K', 'macos')).toEqual(['Shift-Meta-k']);
    expect(toCodeMirrorKeys('Win+K', 'windows')).toEqual(['Meta-k']);
  });

  it('keeps named keys, digits, function keys and punctuation as they are', () => {
    expect(toCodeMirrorKeys('Alt+Cmd+ArrowUp', 'macos')).toEqual([
      'Alt-Meta-ArrowUp',
    ]);
    expect(toCodeMirrorKeys('Ctrl+Space', 'windows')).toEqual(['Ctrl-Space']);
    expect(toCodeMirrorKeys('Alt+Escape', 'macos')).toEqual(['Alt-Escape']);
    expect(toCodeMirrorKeys('Ctrl+Shift+1', 'windows')).toEqual([
      'Ctrl-Shift-1',
    ]);
    expect(toCodeMirrorKeys('Alt+F5', 'windows')).toEqual(['Alt-F5']);
    expect(toCodeMirrorKeys('Cmd+/', 'macos')).toEqual(['Meta-/']);
    expect(toCodeMirrorKeys('Alt+Cmd+\\', 'macos')).toEqual(['Alt-Meta-\\']);
    expect(toCodeMirrorKeys('Ctrl+Shift+[', 'windows')).toEqual([
      'Ctrl-Shift-[',
    ]);
    expect(toCodeMirrorKeys('Cmd+Enter', 'macos')).toEqual(['Meta-Enter']);
  });

  it('adds the capital-letter spelling for Ctrl+Alt+Shift+letter on Windows', () => {
    // Ctrl+Alt is AltGr there, so CodeMirror sees the shifted capital letter.
    expect(toCodeMirrorKeys('Ctrl+Alt+Shift+G', 'windows')).toEqual([
      'Ctrl-Alt-Shift-g',
      'Ctrl-Alt-G',
    ]);
    expect(toCodeMirrorKeys('Ctrl+Alt+Shift+Cmd+G', 'macos')).toEqual([
      'Ctrl-Alt-Shift-Meta-g',
    ]);
    expect(toCodeMirrorKeys('Ctrl+Alt+G', 'windows')).toEqual(['Ctrl-Alt-g']);
  });
});
/** The CodeMirror key name reduced to a comparable form: sorted modifiers and
 *  the key, where a capital letter means Shift plus the lowercase letter. */
function norm(spec: string, os: 'macos' | 'windows'): string {
  const parts = spec.split(/-(?!$)/);
  let key = parts.pop() ?? '';
  const mods = new Set<string>();
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod') {
      mods.add(os === 'macos' ? 'Meta' : 'Ctrl');
    } else if (lower === 'cmd' || lower === 'meta' || lower === 'm') {
      mods.add('Meta');
    } else {
      mods.add(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  if (/^[A-Z]$/.test(key)) {
    mods.add('Shift');
    key = key.toLowerCase();
  }
  return `${[...mods].sort().join('+')}+${key}`;
}
/** The names the stock bindings in `sources` give `run` on `os`. */
function stockKeys(
  sources: readonly (readonly KeyBinding[])[],
  run: unknown,
  os: 'macos' | 'windows',
): string[] {
  const out: string[] = [];
  for (const source of sources) {
    for (const b of source) {
      if (b.run !== run) {
        continue;
      }
      const name = (os === 'macos' ? b.mac : b.win) ?? b.key;
      if (name !== undefined) {
        out.push(norm(name, os));
      }
    }
  }
  return out;
}
// The editor-scope defaults of the shortcut registry: id, macOS, Windows.
const DEFAULTS: [string, string, string][] = [
  ['goto-line', 'Alt+Cmd+G', 'Ctrl+Alt+G'],
  ['editor.move-line-up', 'Alt+ArrowUp', 'Alt+ArrowUp'],
  ['editor.move-line-down', 'Alt+ArrowDown', 'Alt+ArrowDown'],
  ['editor.copy-line-up', 'Alt+Shift+ArrowUp', 'Alt+Shift+ArrowUp'],
  ['editor.copy-line-down', 'Alt+Shift+ArrowDown', 'Alt+Shift+ArrowDown'],
  ['editor.add-cursor-above', 'Alt+Cmd+ArrowUp', 'Ctrl+Alt+ArrowUp'],
  ['editor.add-cursor-below', 'Alt+Cmd+ArrowDown', 'Ctrl+Alt+ArrowDown'],
  ['editor.insert-line-below', 'Cmd+Enter', 'Ctrl+Enter'],
  ['editor.select-line', 'Ctrl+L', 'Alt+L'],
  ['editor.expand-selection', 'Cmd+I', 'Ctrl+I'],
  ['editor.outdent', 'Cmd+[', 'Ctrl+['],
  ['editor.indent', 'Cmd+]', 'Ctrl+]'],
  ['editor.reindent', 'Alt+Cmd+\\', 'Ctrl+Alt+\\'],
  ['editor.delete-line', 'Shift+Cmd+K', 'Ctrl+Shift+K'],
  ['editor.go-to-bracket', 'Shift+Cmd+\\', 'Ctrl+Shift+\\'],
  ['editor.toggle-line-comment', 'Cmd+/', 'Ctrl+/'],
  ['editor.toggle-block-comment', 'Ctrl+Shift+A', 'Alt+Shift+A'],
  ['editor.toggle-tab-focus', 'Ctrl+Shift+M', 'Ctrl+M'],
  ['editor.cursor-undo', 'Cmd+U', 'Ctrl+U'],
  ['editor.cursor-redo', 'Shift+Cmd+U', 'Alt+U'],
  ['editor.add-next-occurrence', 'Cmd+D', 'Ctrl+D'],
  ['editor.select-all-occurrences', 'Shift+Cmd+L', 'Ctrl+Shift+L'],
  ['editor.fold', 'Alt+Cmd+[', 'Ctrl+Shift+['],
  ['editor.unfold', 'Alt+Cmd+]', 'Ctrl+Shift+]'],
  ['editor.fold-all', 'Ctrl+Alt+[', 'Ctrl+Alt+['],
  ['editor.unfold-all', 'Ctrl+Alt+]', 'Ctrl+Alt+]'],
  ['editor.trigger-suggest', 'Alt+Escape', 'Ctrl+Space'],
];

function accelFor(
  os: 'macos' | 'windows',
  overrides: Record<string, string | null> = {},
): (id: string) => string | null {
  return (id) => {
    if (id in overrides) {
      return overrides[id] ?? null;
    }
    const row = DEFAULTS.find(([rowId]) => rowId === id);
    return row === undefined ? null : os === 'macos' ? row[1] : row[2];
  };
}

function everyBinding(
  profile: KeymapProfile,
  os: 'macos' | 'windows',
  accel = accelFor(os),
): KeyBinding[] {
  const { normal, completion } = buildKeymap(profile, os, accel);
  return [...completion, ...normal];
}

const PROFILES: KeymapProfile[] = ['document', 'sticky', 'windowed'];
const STOCK = [
  closeBracketsKeymap,
  defaultKeymap,
  searchKeymap,
  historyKeymap,
  foldKeymap,
  completionKeymap,
];

describe('buildKeymap', () => {
  it('leaves no stock binding for a command the user can rebind', () => {
    for (const profile of PROFILES) {
      const bindings = everyBinding(profile, 'macos', () => null);
      for (const command of REBINDABLE) {
        expect(
          bindings.some((b) => b.run === command.run),
          `${profile} ${command.id}`,
        ).toBe(false);
      }
    }
  });

  it('binds a command only at the key in effect', () => {
    const accel = accelFor('windows', {
      'editor.fold': 'Ctrl+Alt+K',
      'editor.indent': null,
    });
    const bindings = everyBinding('document', 'windows', accel);
    const fold = bindings.filter((b) => b.run === foldCode);
    expect(fold.map((b) => b.key)).toEqual(['Ctrl-Alt-k']);
    expect(
      bindings.some(
        (b) =>
          b.key === 'Ctrl-Shift-[' || b.key === 'Ctrl-]' || b.key === 'Mod-]',
      ),
    ).toBe(false);
  });

  it('binds a command that has no default once the user gives it a key', () => {
    const none = everyBinding('document', 'macos');
    expect(
      none.filter(
        (b) =>
          b.run ===
          REBINDABLE.find((c) => c.id === 'editor.add-line-comment')!.run,
      ),
    ).toEqual([]);
    const some = everyBinding(
      'document',
      'macos',
      accelFor('macos', { 'editor.add-line-comment': 'Ctrl+Alt+C' }),
    );
    expect(
      some
        .filter(
          (b) =>
            b.run ===
            REBINDABLE.find((c) => c.id === 'editor.add-line-comment')!.run,
        )
        .map((b) => b.key),
    ).toEqual(['Ctrl-Alt-c']);
  });

  it('gives every rebindable command its stock key when nothing was changed', () => {
    for (const os of ['macos', 'windows'] as const) {
      for (const [id, ,] of DEFAULTS) {
        const command = REBINDABLE.find((c) => c.id === id)!;
        for (const profile of command.profiles) {
          const sources =
            profile === 'document'
              ? STOCK
              : profile === 'sticky'
                ? [defaultKeymap, historyKeymap, searchKeymap]
                : [defaultKeymap];
          const stock = stockKeys(sources, command.run, os).sort();
          const built = everyBinding(profile, os)
            .filter((b) => b.run === command.run)
            .map((b) => norm(b.key!, os))
            .sort();
          if (id === 'editor.toggle-tab-focus' && os === 'macos') {
            // Shift-Alt-m could never fire on macOS, so the default moved.
            expect(built, `${profile} ${id} ${os}`).toEqual(['Ctrl+Shift+m']);
            continue;
          }
          if (id === 'editor.trigger-suggest' && os === 'macos') {
            // Ctrl+Space is taken by the input source switch on macOS.
            expect(built, `${profile} ${id} ${os}`).toEqual(['Alt+Escape']);
            continue;
          }
          // A sticky takes only three search commands, not the whole search
          // keymap, so compare against the commands it really had.
          const expected =
            profile === 'sticky' && sources.includes(searchKeymap)
              ? [...new Set(stock)]
              : stock;
          expect(built, `${profile} ${id} ${os}`).toEqual(expected);
        }
      }
    }
  });

  it('keeps the flags of the stock binding on the rebound key', () => {
    const find = (run: unknown): KeyBinding =>
      everyBinding('document', 'macos').find((b) => b.run === run)!;
    expect(find(selectParentSyntax).preventDefault).toBe(true);
    expect(find(undoSelection).preventDefault).toBe(true);
    expect(find(selectNextOccurrence).preventDefault).toBe(true);
    expect(find(selectLine).preventDefault).toBeUndefined();
    expect(find(gotoLine).preventDefault).toBeUndefined();
  });

  it('leaves every other stock binding exactly as it was', () => {
    const rebindable = new Set(REBINDABLE.map((c) => c.run));
    for (const profile of PROFILES) {
      const built = everyBinding(profile, 'windows');
      const sources =
        profile === 'document'
          ? STOCK
          : profile === 'sticky'
            ? [defaultKeymap, historyKeymap]
            : [defaultKeymap];
      for (const source of sources) {
        for (const stock of source) {
          if (stock.run !== undefined && rebindable.has(stock.run)) {
            continue;
          }
          // The one deliberate change: see the Emacs test below.
          const dropsShift =
            stock.run === cursorLineStart && stock.mac === 'Ctrl-a';
          expect(
            built.some(
              (b) =>
                b.run === stock.run &&
                b.key === stock.key &&
                b.mac === stock.mac &&
                (dropsShift ? b.shift === undefined : b.shift === stock.shift),
            ),
            `${profile} ${stock.key ?? stock.mac}`,
          ).toBe(true);
        }
      }
    }
  });

  it('keeps the Emacs select-to-line-start key out of the fixed keys', () => {
    const bindings = everyBinding('document', 'macos');
    const emacsA = bindings.find(
      (b) => b.run === cursorLineStart && b.mac === 'Ctrl-a',
    )!;
    expect(emacsA.shift).toBeUndefined();
    // The other Emacs bindings keep their Shift variant.
    expect(
      bindings.find((b) => b.mac === 'Ctrl-b' && b.shift !== undefined),
    ).toBeDefined();
  });

  it('drops the lint keys and the macOS Option completion keys', () => {
    const bindings = everyBinding('document', 'macos');
    expect(bindings.some((b) => b.key === 'F8')).toBe(false);
    expect(bindings.some((b) => b.key === 'Mod-Shift-m')).toBe(false);
    expect(bindings.some((b) => b.mac === 'Alt-`' || b.mac === 'Alt-i')).toBe(
      false,
    );
  });

  it('binds Trigger Suggest at Alt-Escape on macOS and Ctrl-Space on Windows', () => {
    const mac = everyBinding('document', 'macos');
    expect(
      mac.filter((b) => b.run === startCompletion).map((b) => b.key),
    ).toEqual(['Alt-Escape']);
    expect(mac.some((b) => b.key === 'Ctrl-Space')).toBe(false);
    const windows = everyBinding('document', 'windows');
    expect(
      windows.filter((b) => b.run === startCompletion).map((b) => b.key),
    ).toEqual(['Ctrl-Space']);
  });

  it('keeps the completion list keys at the highest precedence', () => {
    const { normal, completion } = buildKeymap(
      'document',
      'windows',
      accelFor('windows'),
    );
    for (const key of ['Escape', 'ArrowDown', 'ArrowUp', 'Enter']) {
      expect(
        completion.some((b) => b.key === key),
        key,
      ).toBe(true);
    }
    expect(completion.some((b) => b.run === startCompletion)).toBe(true);
    expect(normal.some((b) => b.run === startCompletion)).toBe(false);
    expect(
      buildKeymap('sticky', 'windows', accelFor('windows')).completion,
    ).toEqual([]);
  });

  it('gives each editor only the commands it has', () => {
    const has = (profile: KeymapProfile, id: string): boolean => {
      const run = REBINDABLE.find((c) => c.id === id)!.run;
      return everyBinding(profile, 'windows').some((b) => b.run === run);
    };
    expect(has('document', 'editor.fold')).toBe(true);
    expect(has('sticky', 'editor.fold')).toBe(false);
    expect(has('windowed', 'editor.fold')).toBe(false);
    expect(has('sticky', 'goto-line')).toBe(true);
    expect(has('windowed', 'goto-line')).toBe(false);
    expect(has('windowed', 'editor.move-line-up')).toBe(true);
    expect(has('sticky', 'editor.cursor-undo')).toBe(true);
    expect(has('windowed', 'editor.cursor-undo')).toBe(false);
    expect(has('windowed', 'editor.select-line')).toBe(true);
  });

  it('puts two spellings on one command only for the Windows AltGr case', () => {
    const accel = accelFor('windows', { 'editor.fold': 'Ctrl+Alt+Shift+K' });
    const keys = everyBinding('document', 'windows', accel)
      .filter((b) => b.run === foldCode)
      .map((b) => b.key);
    expect(keys).toEqual(['Ctrl-Alt-Shift-k', 'Ctrl-Alt-K']);
  });
});

describe('Up and Down for a caret outside the rendered lines', () => {
  it('binds both keys with their Shift variants in every editor', () => {
    for (const profile of PROFILES) {
      for (const os of ['macos', 'windows'] as const) {
        const { offscreen } = buildKeymap(profile, os, accelFor(os));
        const arrows = offscreen.filter((b) => b.key !== undefined);
        expect(arrows.map((b) => b.key)).toEqual(['ArrowUp', 'ArrowDown']);
        for (const b of offscreen) {
          expect(b.run, `${profile} ${os}`).toBeTypeOf('function');
          expect(b.shift, `${profile} ${os}`).toBeTypeOf('function');
          expect(b.run).not.toBe(b.shift);
        }
        expect(arrows).toEqual([...offscreenArrowKeys]);
      }
    }
  });

  it('binds macOS Ctrl-p and Ctrl-n to the same commands, on macOS only', () => {
    for (const profile of PROFILES) {
      const mac = buildKeymap(profile, 'macos', accelFor('macos')).offscreen;
      expect(
        mac.filter((b) => b.key === undefined).map((b) => b.mac),
        profile,
      ).toEqual(['Ctrl-p', 'Ctrl-n']);
      const [up, down] = offscreenArrowKeys;
      expect(mac[2]?.run, profile).toBe(up?.run);
      expect(mac[2]?.shift, profile).toBe(up?.shift);
      expect(mac[3]?.run, profile).toBe(down?.run);
      expect(mac[3]?.shift, profile).toBe(down?.shift);
      const win = buildKeymap(
        profile,
        'windows',
        accelFor('windows'),
      ).offscreen;
      expect(
        win.some((b) => b.mac !== undefined),
        profile,
      ).toBe(false);
    }
  });

  it('keeps them out of the rebindable and the stock bindings', () => {
    for (const profile of PROFILES) {
      const { normal, completion, offscreen } = buildKeymap(
        profile,
        'macos',
        accelFor('macos'),
      );
      for (const b of offscreen) {
        expect(normal.includes(b), profile).toBe(false);
        expect(completion.includes(b), profile).toBe(false);
      }
      // The stock Up and Down stay, for a caret inside the rendered lines.
      for (const key of ['ArrowUp', 'ArrowDown']) {
        expect(
          normal.some((b) => b.key === key),
          `${profile} ${key}`,
        ).toBe(true);
      }
    }
  });

  it('ranks them above the other bindings and below the completion list', () => {
    for (const profile of PROFILES) {
      const extension = keymapExtension(
        profile,
        'windows',
        accelFor('windows'),
      );
      // A keymap of ordinary precedence listed before the editor's own.
      const other: KeyBinding[] = [{ key: 'ArrowDown', run: () => false }];
      const maps = EditorState.create({
        extensions: [keymap.of(other), extension],
      }).facet(keymap);
      const mine = maps.findIndex((map) =>
        map.some((b) => b.run === offscreenArrowKeys[1]?.run),
      );
      const withDown = maps.flatMap((map, i) =>
        map.some((b) => b.key === 'ArrowDown') ? [i] : [],
      );
      // Only the completion list's keymap, the document editor's, comes first.
      expect(withDown.indexOf(mine), profile).toBe(
        profile === 'document' ? 1 : 0,
      );
      expect(maps.indexOf(other), profile).toBeGreaterThan(mine);
    }
  });
});

describe('Tab key', () => {
  const tabOf = (bindings: KeyBinding[]): KeyBinding[] =>
    bindings.filter((b) => b.key === 'Tab');

  it('is bound in every editor with its own commands', () => {
    for (const profile of PROFILES) {
      const tabs = tabOf(everyBinding(profile, 'macos'));
      expect(tabs, profile).toHaveLength(1);
      expect(tabs[0]?.run, profile).toBe(tabKey);
      expect(tabs[0]?.shift, profile).toBe(shiftTabKey);
      expect(tabKey).not.toBe(indentMore);
      expect(shiftTabKey).not.toBe(indentLess);
    }
  });

  it('stays bound when the indent rows are unset, which then bind nothing', () => {
    for (const profile of PROFILES) {
      const bindings = everyBinding(
        profile,
        'windows',
        accelFor('windows', { 'editor.indent': null, 'editor.outdent': null }),
      );
      expect(tabOf(bindings), profile).toHaveLength(1);
      expect(
        bindings.some((b) => b.run === indentMore || b.run === indentLess),
        profile,
      ).toBe(false);
    }
  });

  it('leaves the indent rows at their new keys only', () => {
    for (const profile of PROFILES) {
      const bindings = everyBinding(
        profile,
        'windows',
        accelFor('windows', {
          'editor.indent': 'Ctrl+Alt+I',
          'editor.outdent': 'Ctrl+Alt+O',
        }),
      );
      expect(
        bindings.filter((b) => b.run === indentMore).map((b) => b.key),
        profile,
      ).toEqual(['Ctrl-Alt-i']);
      expect(
        bindings.filter((b) => b.run === indentLess).map((b) => b.key),
        profile,
      ).toEqual(['Ctrl-Alt-o']);
      expect(tabOf(bindings), profile).toHaveLength(1);
    }
  });

  function run(
    command: (view: EditorView) => boolean,
    doc: string,
    selection: EditorSelection,
  ): string {
    let state = EditorState.create({ doc, selection });
    const view = {
      get state() {
        return state;
      },
      dispatch: (tr: Transaction) => {
        state = tr.state;
      },
    } as unknown as EditorView;
    expect(command(view)).toBe(true);
    return state.doc.toString();
  }

  it('inserts exactly one tab character at an empty caret', () => {
    expect(run(tabKey, 'abcd', EditorSelection.single(2))).toBe('ab\tcd');
  });

  it('indents every selected line by the indent unit', () => {
    expect(run(tabKey, 'a\nb\nc', EditorSelection.single(0, 3))).toBe(
      '  a\n  b\nc',
    );
  });

  it('outdents by one indent unit with Shift-Tab', () => {
    expect(run(shiftTabKey, '    a\n  b', EditorSelection.single(0, 9))).toBe(
      '  a\nb',
    );
  });
});

describe('resolveCodeNamedKey', () => {
  const key = (
    k: string,
    code: string,
    mods: Partial<
      Pick<KeyLike, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>
    > = {},
  ): KeyLike => ({
    key: k,
    code,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    metaKey: mods.metaKey ?? false,
  });
  const bindings = everyBinding('document', 'macos');
  const resolve = (
    list: readonly KeyBinding[],
    event: KeyLike,
    os = 'macos',
  ): ReturnType<typeof resolveCodeNamedKey> =>
    resolveCodeNamedKey(list, event, os);

  it('finds the binding of a named key the layout turned into a character', () => {
    // Zhuyin: Option+Esc arrives as U+200D with code Escape.
    expect(resolve(bindings, key('\u200D', 'Escape', { altKey: true }))).toBe(
      startCompletion,
    );
  });

  it('leaves ordinary events to CodeMirror', () => {
    expect(
      resolve(bindings, key('Escape', 'Escape', { altKey: true })),
    ).toBeNull();
    expect(resolve(bindings, key('a', 'KeyA', { altKey: true }))).toBeNull();
    expect(
      resolve(bindings, key('\u200D', 'KeyA', { altKey: true })),
    ).toBeNull();
  });

  it('ignores a key typed during an IME composition', () => {
    expect(
      resolve(bindings, key('Process', 'Escape', { altKey: true })),
    ).toBeNull();
    expect(
      resolve(bindings, {
        ...key('\u200D', 'Escape', { altKey: true }),
        isComposing: true,
      }),
    ).toBeNull();
  });

  it('returns nothing when no binding holds that key', () => {
    expect(
      resolve(bindings, key('\u200D', 'Escape', { ctrlKey: true })),
    ).toBeNull();
  });

  it('reads Mod as Meta on macOS and Ctrl elsewhere', () => {
    const run = (): boolean => true;
    const list: KeyBinding[] = [{ key: 'Mod-Escape', run }];
    const meta = key('\u200D', 'Escape', { metaKey: true });
    const ctrl = key('\u200D', 'Escape', { ctrlKey: true });
    expect(resolve(list, meta, 'macos')).toBe(run);
    expect(resolve(list, ctrl, 'macos')).toBeNull();
    expect(resolve(list, ctrl, 'windows')).toBe(run);
    expect(resolve(list, meta, 'windows')).toBeNull();
  });

  it('prefers the field of the platform over key', () => {
    const run = (): boolean => true;
    const list: KeyBinding[] = [{ key: 'Ctrl-Escape', mac: 'Alt-Escape', run }];
    const alt = key('\u200D', 'Escape', { altKey: true });
    const ctrl = key('\u200D', 'Escape', { ctrlKey: true });
    expect(resolve(list, alt, 'macos')).toBe(run);
    expect(resolve(list, ctrl, 'macos')).toBeNull();
    expect(resolve(list, ctrl, 'windows')).toBe(run);
    expect(resolve(list, alt, 'windows')).toBeNull();
    const win: KeyBinding[] = [{ win: 'Alt-Escape', run }];
    expect(resolve(win, alt, 'windows')).toBe(run);
    expect(resolve(win, alt, 'macos')).toBeNull();
  });

  it('runs the shift variant when only the unshifted name matches', () => {
    const run = (): boolean => true;
    const shift = (): boolean => true;
    const list: KeyBinding[] = [{ key: 'Alt-Escape', run, shift }];
    expect(
      resolve(list, key('\u200D', 'Escape', { altKey: true, shiftKey: true })),
    ).toBe(shift);
    expect(resolve(list, key('\u200D', 'Escape', { altKey: true }))).toBe(run);
    const explicit: KeyBinding[] = [{ key: 'Shift-Alt-Escape', run }];
    expect(
      resolve(
        explicit,
        key('\u200D', 'Escape', { altKey: true, shiftKey: true }),
      ),
    ).toBe(run);
    expect(
      resolve(explicit, key('\u200D', 'Escape', { altKey: true })),
    ).toBeNull();
  });
});
