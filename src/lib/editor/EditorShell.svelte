<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import type { Extension } from '@codemirror/state';
  import type { EditorView } from '@codemirror/view';
  import Editor from './Editor.svelte';
  import { loadLanguage, MAX_HIGHLIGHT_CHARS } from './language';

  interface Props {
    value: string;
    language: string | null;
    dark: boolean;
    minimal?: boolean;
    onchange: (v: string) => void;
    onview?: (view: EditorView | null) => void;
  }

  let {
    value,
    language,
    dark,
    minimal = false,
    onchange,
    onview,
  }: Props = $props();

  // Highlighting is forced off for oversized content regardless of stored language.
  const gateActive = $derived(value.length > MAX_HIGHLIGHT_CHARS);
  const effectiveLang = $derived(gateActive ? null : language);

  let loadedExt = $state<Extension | null>(null);
  let langSeq = 0;

  // Load the language extension off the reactive graph. The $state write happens
  // after an await, i.e. outside the effect's synchronous frame, so it does not
  // violate the no-mutation-inside-$effect rule. A sequence number drops stale
  // loads so a slow earlier selection can't clobber a newer one.
  async function applyLanguage(name: string | null): Promise<void> {
    const seq = ++langSeq;
    const ext = name === null ? null : await loadLanguage(name);
    await Promise.resolve();
    if (seq === langSeq) {
      loadedExt = ext;
    }
  }

  $effect(() => {
    const name = effectiveLang;
    void applyLanguage(name);
  });
</script>

<Editor {value} lang={loadedExt} {dark} {minimal} {onchange} {onview} />
