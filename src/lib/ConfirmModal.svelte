<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';

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

  let cancelButton: HTMLButtonElement;

  // Single choke point every onprimary/onsecondary/ontertiary click runs
  // through: awaits whatever the handler returns and catches a rejection that
  // would otherwise be unhandled. The handler itself remains responsible for
  // reporting the failure somewhere the user can see (e.g. a `*Failed` state
  // field) — this only guarantees the rejection is never silently lost.
  function fire(handler: (() => void | Promise<void>) | undefined): void {
    if (handler === undefined) {
      return;
    }
    void (async (): Promise<void> => {
      try {
        await handler();
      } catch (e) {
        console.error(e);
      }
    })();
  }

  // A blocking dialog must own the keyboard: grab focus on mount (which blurs the
  // editor behind it, so keystrokes can't leak into the document) and restore it
  // to whatever held focus before when the dialog closes. Focusing the cancel
  // button — the non-destructive default — also makes the dialog keyboard-operable.
  onMount(() => {
    const previous = document.activeElement;
    cancelButton.focus();
    return () => {
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    };
  });
</script>

<div class="modal-backdrop">
  <div class="modal">
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
      <button class="btn" bind:this={cancelButton} onclick={oncancel}
        >{cancelLabel}</button
      >
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
