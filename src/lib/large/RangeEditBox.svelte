<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import type { Text } from '@codemirror/state';
  import type { EditorView } from '@codemirror/view';
  import DocumentEditor from '../editor/DocumentEditor.svelte';
  import { t } from '../i18n';
  import { rangeLabel } from '../util/rangeLabel';
  import type { RangeBox } from '../util/rangeEditBox';

  interface Props {
    box: RangeBox;
    dark: boolean;
    fontSize: number;
    fontFamily: string;
    wordWrap: boolean;
    lineNumbers: boolean;
    onchange: (content: Text) => void;
    onsave: () => void | Promise<void>;
    oncancel: () => void;
    onview: (view: EditorView | null) => void;
  }

  let {
    box,
    dark,
    fontSize,
    fontFamily,
    wordWrap,
    lineNumbers,
    onchange,
    onsave,
    oncancel,
    onview,
  }: Props = $props();
  // The editor reads its starting text once, at mount; later edits flow out
  // through `onchange`. The box holds one document, so one id and no reloads.
  const ID = 'range-box';
  const OPEN_IDS = [ID];
</script>

<div class="backdrop" role="presentation">
  <div class="panel" role="dialog" aria-modal="true">
    <div class="title">
      {rangeLabel(box.sourcePath, box.startLine, box.endLine)}
    </div>
    <div class="editor">
      <DocumentEditor
        activeId={ID}
        content={box.saved}
        language={null}
        {dark}
        {fontSize}
        {fontFamily}
        {wordWrap}
        {lineNumbers}
        openIds={OPEN_IDS}
        reloadSeq={0}
        reloadTarget=""
        convertible={false}
        {onchange}
        onselection={() => {}}
        {onview}
      />
    </div>
    <div class="actions">
      <button class="btn primary" onclick={() => void onsave()}
        >{t('common.save')}</button
      >
      <button class="btn" onclick={oncancel}>{t('common.cancel')}</button>
    </div>
  </div>
</div>

<style>
  /* Below ConfirmModal (z-index 3), so a dialog raised from the box covers it. */
  .backdrop {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.35);
  }
  .panel {
    display: flex;
    flex-direction: column;
    width: min(1000px, 92%);
    height: 82%;
    background: var(--modal-surface);
    color: var(--modal-fg);
    border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
    overflow: hidden;
  }
  .title {
    flex: 0 0 auto;
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--modal-border);
    font-size: 13px;
  }
  .editor {
    flex: 1 1 auto;
    min-height: 0;
  }
  .actions {
    display: flex;
    flex: 0 0 auto;
    gap: 0.4rem;
    justify-content: flex-end;
    padding: 0.55rem 0.9rem;
    border-top: 1px solid var(--modal-border);
  }
  .btn {
    appearance: none;
    -webkit-appearance: none;
    padding: 0.3rem 0.7rem;
    font-size: 13px;
    white-space: nowrap;
    border-radius: 5px;
    border: 1px solid var(--modal-border);
    background: transparent;
    color: inherit;
    cursor: default;
  }
  .btn:hover {
    background: var(--modal-hover);
  }
  .btn.primary {
    border-color: transparent;
    background: var(--modal-accent);
    color: #ffffff;
  }
  .btn.primary:hover {
    filter: brightness(1.05);
  }
</style>
