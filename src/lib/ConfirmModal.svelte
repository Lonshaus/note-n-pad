<script module lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only
  // Every mounted modal of this window. They share one z-index, so the last in
  // DOM order is the one drawn on top and the only one that may take the keys.
  const mounted = new Set<HTMLElement>();
  // What held focus before the first modal opened.
  let restoreTo: Element | null = null;

  function topmost(): HTMLElement | undefined {
    let top: HTMLElement | undefined;
    for (const el of mounted) {
      if (
        top === undefined ||
        (top.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !==
          0
      ) {
        top = el;
      }
    }
    return top;
  }
  // The primary button when there is one, otherwise the Cancel/Close button.
  function defaultButton(modal: HTMLElement): HTMLElement | null {
    return (
      modal.querySelector<HTMLElement>('.btn.primary') ??
      modal.querySelector<HTMLElement>('[data-cancel]')
    );
  }
  /** True while any dialog is mounted; outer Esc handlers yield to it. */
  export function isModalOpen(): boolean {
    return mounted.size > 0;
  }
  /** Put keyboard focus inside the topmost dialog. Returns false when no dialog
   *  is mounted. Focus already inside it stays put (a button reached with Tab
   *  keeps it); from anywhere else (BODY, the editor, a lower dialog) it goes
   *  to the default button. */
  export function focusTopmostModal(): boolean {
    const top = topmost();
    if (top === undefined) {
      return false;
    }
    if (!top.contains(document.activeElement)) {
      defaultButton(top)?.focus();
    }
    return true;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { modalActsOnEscape } from './util/popupEscape';

  interface Props {
    message: string;
    // Optional, so a dialog that only reports something renders one button
    // rather than offering an action it does not have.
    primaryLabel?: string | undefined;
    // A secondary button is optional; omit both (or pass undefined) to render
    // only primary/cancel.
    secondaryLabel?: string | undefined;
    // A tertiary button is optional too, rendered between secondary and cancel
    // (a third choice, e.g. the open dialog's "soft-wrap and open").
    tertiaryLabel?: string | undefined;
    cancelLabel: string;
    // Widened so an async handler's returned promise is visible here rather
    // than discarded: a bare `() => void` parameter also accepts an
    // `async () => Promise<void>` argument (TypeScript never checks return-type
    // width against a `void`-returning parameter type), so a plain
    // `onclick={onprimary}` throws the promise away and a rejection inside
    // becomes an unhandled rejection nobody observes. `fire` below awaits and
    // catches it instead, once, for every caller.
    onprimary?: (() => void | Promise<void>) | undefined;
    onsecondary?: (() => void | Promise<void>) | undefined;
    ontertiary?: (() => void | Promise<void>) | undefined;
    oncancel: () => void;
  }

  let {
    message,
    primaryLabel,
    secondaryLabel,
    tertiaryLabel,
    cancelLabel,
    onprimary,
    onsecondary,
    ontertiary,
    oncancel,
  }: Props = $props();

  let root: HTMLElement;
  let busy = false;

  // Single choke point every onprimary/onsecondary/ontertiary click runs
  // through: awaits whatever the handler returns and catches a rejection that
  // would otherwise be unhandled. The handler itself remains responsible for
  // reporting the failure somewhere the user can see (e.g. a `*Failed` state
  // field) — this only guarantees the rejection is never silently lost.
  // A second activation while the handler is still running is ignored.
  function fire(handler: (() => void | Promise<void>) | undefined): void {
    if (handler === undefined || busy) {
      return;
    }
    busy = true;
    void (async (): Promise<void> => {
      try {
        await handler();
      } catch (e) {
        console.error(e);
      } finally {
        busy = false;
      }
    })();
  }
  // A blocking dialog must own the keyboard: the topmost one grabs focus on
  // mount (which blurs the editor behind it, so keystrokes can't leak into the
  // document) and focus returns to whatever held it before once the last one
  // closes. Focus starts on the default button so Enter activates it.
  onMount(() => {
    if (mounted.size === 0) {
      restoreTo = document.activeElement;
    }
    mounted.add(root);
    if (topmost() === root) {
      defaultButton(root)?.focus();
    }
    return () => {
      mounted.delete(root);
      const next = topmost();
      if (next === undefined) {
        if (restoreTo instanceof HTMLElement) {
          restoreTo.focus();
        }
        restoreTo = null;
      } else if (!next.contains(document.activeElement)) {
        defaultButton(next)?.focus();
      }
    };
  });
  // Esc cancels the topmost dialog, Enter and Space activate the focused
  // button natively. A dialog underneath ignores all three, so a button
  // reached there with Tab cannot be pressed from the keyboard.
  function onkeydown(e: KeyboardEvent): void {
    const isTop = topmost() === root;
    if (e.key === 'Escape') {
      if (!modalActsOnEscape(e)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (isTop) {
        oncancel();
      }
    } else if (e.key === 'Tab') {
      // Focus never leaves the dialog: Tab cycles through its own buttons.
      e.preventDefault();
      if (!isTop || e.isComposing) {
        return;
      }
      const buttons = [...root.querySelectorAll<HTMLElement>('button')];
      const at = buttons.findIndex((b) => b === document.activeElement);
      const last = buttons.length - 1;
      const next = e.shiftKey
        ? at <= 0
          ? last
          : at - 1
        : (at + 1) % (last + 1);
      buttons[next]?.focus();
    } else if (!isTop && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
    }
  }
  // A press on the dim area must not pull focus off the dialog's button, or
  // Esc and Enter would stop reaching the dialog.
  function onbackdropmousedown(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      e.preventDefault();
    }
  }
</script>

<div
  class="modal-backdrop"
  role="presentation"
  bind:this={root}
  onmousedown={onbackdropmousedown}
>
  <div class="modal" role="dialog" aria-modal="true" tabindex="-1" {onkeydown}>
    <p>{message}</p>
    <div class="modal-actions">
      {#if primaryLabel !== undefined && onprimary !== undefined}
        <button class="btn primary" onclick={() => fire(onprimary)}
          >{primaryLabel}</button
        >
      {/if}
      {#if secondaryLabel !== undefined && onsecondary !== undefined}
        <button class="btn" onclick={() => fire(onsecondary)}
          >{secondaryLabel}</button
        >
      {/if}
      {#if tertiaryLabel !== undefined && ontertiary !== undefined}
        <button class="btn" onclick={() => fire(ontertiary)}
          >{tertiaryLabel}</button
        >
      {/if}
      <button class="btn" data-cancel onclick={oncancel}>{cancelLabel}</button>
    </div>
  </div>
</div>

<style>
  /* Look is driven by --modal-* custom properties the host defines, so a sticky
     keeps its paper palette while a document window uses the app theme. */
  .modal-backdrop {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.35);
  }
  .modal {
    background: var(--modal-surface);
    color: var(--modal-fg);
    border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
    padding: 0.85rem 1rem;
    max-width: 85%;
    text-align: center;
  }
  .modal p {
    margin: 0 0 0.8rem;
    font-size: 13px;
  }
  .modal-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    justify-content: center;
  }
  .btn {
    appearance: none;
    -webkit-appearance: none;
    padding: 0.3rem 0.7rem;
    font-size: 13px;
    /* A label never breaks mid-word: languages with longer words than English
       (ja "保存しない", de "Nicht sichern") otherwise wrap inside the button and
       turn it into a two-line block. The row wraps instead when they don't fit. */
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
