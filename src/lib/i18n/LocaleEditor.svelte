<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { open, save as saveDialog, ask } from '@tauri-apps/plugin-dialog';
  import { t, englishText, builtinStrings, I18N_KEYS } from '.';
  import { BUILTIN_LABELS, type LocaleData } from './locale';
  import { localeRegistry } from './localeRegistry.svelte';
  import {
    customizedLabel,
    groupKeys,
    placeholdersOf,
    setString,
  } from './localeEdit';

  interface Props {
    /** The locale being edited. The parent wraps this component in `{#key id}`,
     *  so switching languages remounts it with a fresh draft. */
    id: string;
    /** A compiled locale (en/ja/zh-TW). Its data file only *shadows* the
     *  compiled dictionary, so "restore" means dropping that file. */
    isBuiltin: boolean;
    /** A bundled seed exists, so "restore" returns to the shipped strings. */
    hasSeed: boolean;
    /** Reports unsaved state so the parent can warn before switching away. */
    ondirty: (dirty: boolean) => void;
  }
  let { id, isBuiltin, hasSeed, ondirty }: Props = $props();

  // Editor rows, grouped by the key's namespace. The key set is fixed at build
  // time (it comes from the master dictionary), so this is computed once.
  const KEY_GROUPS = groupKeys(I18N_KEYS);

  // The draft. Edits stay here until the user saves, so typing never
  // retranslates the running UI mid-keystroke.
  let label = $state('');
  let strings = $state<Record<string, string>>({});
  let dirty = $state(false);
  let error = $state('');

  /** (Re)load the draft from what is currently stored. A built-in with no
   *  override starts from its compiled dictionary, so editing e.g. English
   *  begins with the shipped English rather than a blank form. */
  function loadDraft(): void {
    const entry = localeRegistry.get(id);
    label = entry?.label ?? BUILTIN_LABELS[id] ?? id;
    strings = { ...(entry?.strings ?? builtinStrings(id) ?? {}) };
    dirty = false;
    error = '';
    ondirty(false);
  }
  loadDraft();

  function markDirty(): void {
    error = '';
    if (!dirty) {
      dirty = true;
      ondirty(true);
    }
  }

  /** The draft as a storable locale. A built-in override has no menu order of
   *  its own — the list renders the compiled three from a fixed order. */
  function draftLocale(labelOverride?: string): LocaleData {
    return {
      id,
      label: labelOverride ?? label,
      order: localeRegistry.get(id)?.order ?? 0,
      strings: $state.snapshot(strings),
    };
  }

  function edit(key: string, value: string): void {
    setString({ id, label, order: 0, strings }, key, value);
    markDirty();
  }

  async function save(): Promise<void> {
    const marked = customizedLabel(label, t('settings.language.customSuffix'));
    await localeRegistry.save(draftLocale(marked));
    label = marked;
    dirty = false;
    error = '';
    ondirty(false);
  }

  /** Merge someone else's corrected translations into the draft. Only the keys
   *  present in the file are replaced, so a partial correction file is enough;
   *  the result still needs an explicit save.
   *
   *  The file must be for *this* language: merging a German file into Japanese
   *  would silently overwrite the strings with the wrong language, and the only
   *  way back would be a full restore. Use "import language" to add a different
   *  language instead. */
  async function updateFromJson(): Promise<void> {
    error = '';
    const path = await open({
      multiple: false,
      filters: [{ name: 'Locale', extensions: ['json'] }],
    });
    if (typeof path !== 'string') {
      return;
    }
    try {
      const source = await localeRegistry.readFile(path);
      if (source.id !== id) {
        error = t('settings.language.idMismatch', { id: source.id });
        return;
      }
      for (const [key, value] of Object.entries(source.strings)) {
        strings[key] = value;
      }
      markDirty();
    } catch {
      error = t('settings.language.importError');
    }
  }

  /** Export what is on screen (draft included), so a translation can be shared
   *  without saving it into the running app first. */
  async function exportDraft(): Promise<void> {
    error = '';
    const path = await saveDialog({
      defaultPath: `${id}.json`,
      filters: [{ name: 'Locale', extensions: ['json'] }],
    });
    if (typeof path !== 'string') {
      return;
    }
    await localeRegistry.exportFile(draftLocale(), path);
  }

  /** Discard customizations: a bundled locale returns to its seed, a built-in
   *  drops its override file and falls back to the compiled dictionary. */
  async function reset(): Promise<void> {
    error = '';
    const ok = await ask(t('settings.language.resetConfirm', { name: label }), {
      title: t('settings.language.reset'),
      kind: 'warning',
      okLabel: t('settings.language.reset'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) {
      return;
    }
    if (hasSeed) {
      await localeRegistry.restoreDefault(id);
    } else {
      await localeRegistry.remove(id);
    }
    loadDraft();
  }

  // Restorable once something is stored to undo: a bundled seed to return to,
  // or (for a built-in) an override file currently shadowing the compiled one.
  const canReset = $derived(
    hasSeed || (isBuiltin && localeRegistry.get(id) !== undefined),
  );
</script>

<div class="editor">
  <div class="toolbar">
    <button class="btn" disabled={!dirty} onclick={() => void save()}>
      {t('settings.language.save')}
    </button>
    <button class="btn" onclick={() => void updateFromJson()}>
      {t('settings.language.updateFromJson')}
    </button>
    <button class="btn" onclick={() => void exportDraft()}>
      {t('settings.language.export')}
    </button>
    <button class="btn" disabled={!canReset} onclick={() => void reset()}>
      {t('settings.language.reset')}
    </button>
    {#if dirty}
      <span class="unsaved">{t('settings.language.unsaved')}</span>
    {/if}
  </div>
  {#if error !== ''}
    <span class="error">{error}</span>
  {/if}
  <div class="rows">
    {#each KEY_GROUPS as group (group.name)}
      <div class="group">
        <div class="group-label">{group.name}</div>
        {#each group.keys as key (key)}
          {@const reference = englishText(key)}
          {@const marks = placeholdersOf(reference)}
          <div class="row">
            <div class="meta">
              <span class="key">{key}</span>
              {#if marks.length > 0}
                <span class="marks">{marks.join(' ')}</span>
              {/if}
              <span class="ref">{reference}</span>
            </div>
            <input
              class="input"
              type="text"
              value={strings[key] ?? ''}
              placeholder={reference}
              oninput={(e) => edit(key, e.currentTarget.value)}
            />
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
  }
  /* Save / update / export / restore sit above the rows and stay put while the
     ~170 string rows scroll underneath. */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    flex: 0 0 auto;
  }
  .btn {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--topbar-border);
    border-radius: 6px;
    background: var(--bg);
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    cursor: default;
  }
  .btn:hover:not(:disabled) {
    background: var(--topbar-border);
  }
  .btn:disabled {
    opacity: 0.4;
  }
  /* Unsaved marker: edits are buffered, so this is the only cue that the running
     UI does not yet reflect what is on screen. */
  .unsaved {
    color: var(--accent);
    font-size: 0.78rem;
  }
  .error {
    color: var(--danger);
    font-size: 0.78rem;
  }
  .rows {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding-right: 0.25rem;
  }
  .group {
    display: flex;
    flex-direction: column;
  }
  .group-label {
    padding: 0.35rem 0.5rem 0.2rem;
    font-size: 0.72rem;
    font-weight: 600;
    opacity: 0.5;
  }
  .group-label:not(:first-child) {
    margin-top: 0.35rem;
    border-top: 1px solid var(--topbar-border);
    padding-top: 0.5rem;
  }
  /* Each row pairs the key's identity (name, placeholders, English reference)
     with its input, so a translator sees what they are translating. */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.5rem;
    align-items: start;
    padding: 0.3rem 0.5rem;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .key {
    font-family: ui-monospace, monospace;
    font-size: 0.68rem;
    opacity: 0.55;
    overflow-wrap: anywhere;
  }
  /* Placeholders the translation must keep — dropping one loses the value. */
  .marks {
    font-family: ui-monospace, monospace;
    font-size: 0.68rem;
    color: var(--accent);
  }
  .ref {
    font-size: 0.78rem;
    opacity: 0.75;
    overflow-wrap: anywhere;
  }
  .input {
    width: 100%;
    /* There is no global border-box rule, so width:100% plus padding and border
       would otherwise overflow the grid cell and force a horizontal scrollbar. */
    box-sizing: border-box;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--topbar-border);
    border-radius: 6px;
    background: var(--bg);
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
  }
</style>
