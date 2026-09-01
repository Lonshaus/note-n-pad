<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import {
    settingsState,
    type LargeOpenMode,
    type OpenTarget,
  } from './lib/state/settings.svelte';
  import { platform } from './lib/state/platform.svelte';
  import { revealWhenThemed } from './lib/util/reveal';
  import LoadProblems from './lib/LoadProblems.svelte';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import ThemePreview from './lib/theme/ThemePreview.svelte';
  import { THEME_COLOR_FIELDS, type Theme } from './lib/theme/themes';
  import type { InterfaceMode } from './lib/theme/chrome';
  import { getColor, setColor } from './lib/theme/themeColor';
  import { open, save, ask } from '@tauri-apps/plugin-dialog';
  import { debounce } from './lib/util/debounce';
  import {
    keyEventToAccelerator,
    formatAccelerator,
  } from './lib/util/accelerator';
  import {
    FONT_CANDIDATES,
    availableFonts,
    filterInstalledFonts,
    makeCanvasMeasurer,
  } from './lib/util/font';
  import { invoke } from '@tauri-apps/api/core';
  import { ENCODINGS, type LineEnding } from './lib/util/text';
  import { t, type I18nKey } from './lib/i18n';
  import { BUILTIN_IDS, BUILTIN_LABELS } from './lib/i18n/locale';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import LocaleEditor from './lib/i18n/LocaleEditor.svelte';

  type Section = 'sticky' | 'editor' | 'general' | 'language';
  // The editor section has two sub-tabs: its own settings, and the theme editor
  // (a theme only colors the editor, so it belongs here, not a top-level tab).
  type EditorTab = 'general' | 'theme';

  // Theme colors only the editor surface, so the color editor drops the
  // interface chrome group (that is the interface mode's job now).
  const COLOR_GROUPS = ['editor', 'syntax'] as const;

  // Labels resolve through `t()` in the template, so section/theme/language
  // rows carry a stable id plus their dictionary key (never a captured string),
  // keeping every label reactive to a live language change.
  const SECTIONS: { id: Section; key: I18nKey }[] = [
    { id: 'general', key: 'settings.section.general' },
    { id: 'sticky', key: 'settings.section.sticky' },
    { id: 'editor', key: 'settings.section.editor' },
    { id: 'language', key: 'settings.section.language' },
  ];

  // Sub-tabs of the editor section (reusing the General label for the first).
  const EDITOR_TABS: { id: EditorTab; key: I18nKey }[] = [
    { id: 'general', key: 'settings.section.general' },
    { id: 'theme', key: 'settings.editor.tabTheme' },
  ];

  // Interface (chrome) appearance options, shown in the General section.
  const INTERFACE_MODES: { id: InterfaceMode; key: I18nKey }[] = [
    { id: 'system', key: 'settings.interface.system' },
    { id: 'light', key: 'settings.theme.light' },
    { id: 'dark', key: 'settings.theme.dark' },
  ];

  let section = $state<Section>('general');
  let editorTab = $state<EditorTab>('general');

  // Shortcut recorder state.
  let recording = $state(false);
  let shortcutError = $state('');
  let recorderEl = $state<HTMLButtonElement | undefined>(undefined);

  let snapshotDirError = $state('');

  // Windows-only row, and only on builds where the Default apps deep link
  // understands its app parameter. The Rust check answers false everywhere
  // else, so this stays false and the row never renders.
  let defaultAppsSupported = $state(false);

  // A small in-app choice dialog (message + arbitrary buttons), used for the
  // two snapshot-folder-switch prompts below: `ask()`'s system dialog only
  // ever offers OK/Cancel, and these need three and four labeled choices.
  // Mirrors the modal-overlay/modal-card mechanism already used for "save as
  // new theme" above.
  let choiceModal = $state<{
    titleKey: I18nKey;
    titleParams: Record<string, string | number> | undefined;
    bodyKey: I18nKey | undefined;
    bodyParams: Record<string, string | number> | undefined;
    buttons: { id: string; labelKey: I18nKey }[];
    resolve: (id: string) => void;
  } | null>(null);

  function askChoice(
    titleKey: I18nKey,
    buttons: { id: string; labelKey: I18nKey }[],
    options?: {
      titleParams?: Record<string, string | number>;
      bodyKey?: I18nKey;
      bodyParams?: Record<string, string | number>;
    },
  ): Promise<string> {
    return new Promise((resolve) => {
      choiceModal = {
        titleKey,
        titleParams: options?.titleParams,
        bodyKey: options?.bodyKey,
        bodyParams: options?.bodyParams,
        buttons,
        resolve,
      };
    });
  }

  function answerChoice(id: string): void {
    choiceModal?.resolve(id);
    choiceModal = null;
  }

  /** Switch the active snapshot folder to `dir` (null = default location),
   *  asking first when the current folder actually has something to lose. */
  async function switchSnapshotDir(dir: string | null): Promise<void> {
    try {
      snapshotDirError = '';
      const preview = await settingsState.previewSnapshotDirMove(dir);
      if (preview.sourceCount === 0) {
        // Nothing to strand: switch straight away, no prompt.
        await settingsState.setSnapshotDir(dir, true, 'source');
        return;
      }
      const first = await askChoice(
        'settings.general.snapshotMoveTitle',
        [
          { id: 'move', labelKey: 'settings.general.snapshotMoveConfirm' },
          { id: 'skip', labelKey: 'settings.general.snapshotMoveSkip' },
          { id: 'cancel', labelKey: 'common.cancel' },
        ],
        {
          bodyKey: 'settings.general.snapshotMoveBody',
          bodyParams: { count: preview.sourceCount },
        },
      );
      if (first === 'cancel') {
        return;
      }
      if (first === 'skip') {
        await settingsState.setSnapshotDir(dir, false, 'source');
        return;
      }
      let policy: 'source' | 'dest' | 'both' = 'source';
      if (preview.collisionCount > 0) {
        const resolved = await askChoice(
          'settings.general.snapshotCollisionTitle',
          [
            {
              id: 'source',
              labelKey: 'settings.general.snapshotCollisionSource',
            },
            { id: 'dest', labelKey: 'settings.general.snapshotCollisionDest' },
            { id: 'both', labelKey: 'settings.general.snapshotCollisionBoth' },
            { id: 'cancel', labelKey: 'common.cancel' },
          ],
          { titleParams: { count: preview.collisionCount } },
        );
        if (resolved === 'cancel') {
          return;
        }
        policy = resolved as 'source' | 'dest' | 'both';
      }
      await settingsState.setSnapshotDir(dir, true, policy);
    } catch (err) {
      snapshotDirError = String(err);
    }
  }

  async function chooseSnapshotDir(): Promise<void> {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== 'string') {
      return;
    }
    await switchSnapshotDir(picked);
  }

  async function resetSnapshotDir(): Promise<void> {
    await switchSnapshotDir(null);
  }

  function onRecorderKeydown(e: KeyboardEvent): void {
    e.preventDefault();
    // Esc (with no modifiers) cancels recording and restores the display.
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      recorderEl?.blur();
      return;
    }
    const accel = keyEventToAccelerator(e);
    // A bare modifier press is ignored; keep waiting for a full combo.
    if (accel === null) {
      return;
    }
    void applyShortcut(accel);
  }

  async function applyShortcut(accel: string): Promise<void> {
    try {
      await settingsState.setNewNoteShortcut(accel);
      shortcutError = '';
    } catch (err) {
      // Registration failed (invalid/conflicting): show it and keep the old one.
      shortcutError = String(err);
    }
    recording = false;
    recorderEl?.blur();
  }

  function commitFontSize(raw: string): void {
    const n = Number(raw);
    if (Number.isNaN(n)) {
      return;
    }
    const clamped = Math.min(32, Math.max(9, Math.round(n)));
    void settingsState.setFontSize(clamped);
  }

  function stepFontSize(delta: number): void {
    commitFontSize(String(settingsState.editorFontSize + delta));
  }

  // Font picker rows. '' is the built-in stack whose label is translated
  // (labelKey); the concrete faces are detected per host in onMount (only the
  // ones actually installed are listed), so brand face names stay verbatim.
  let fontFamilies = $state<{ value: string; labelKey?: I18nKey }[]>([
    { value: '', labelKey: 'settings.editor.fontDefault' },
  ]);
  const CUSTOM_FONT = '__custom__';

  // Sticky flag set once the user picks the custom option, so the text input stays visible
  // even while its value is empty or matches a listed face.
  let fontCustom = $state(false);
  // A stored value not in the list is inherently custom (e.g. loaded from disk).
  const fontValueIsCustom = $derived(
    settingsState.editorFontFamily !== '' &&
      !fontFamilies.some((f) => f.value === settingsState.editorFontFamily),
  );
  const showFontInput = $derived(fontCustom || fontValueIsCustom);
  const fontSelectValue = $derived(
    showFontInput ? CUSTOM_FONT : settingsState.editorFontFamily,
  );

  function onFontSelect(value: string): void {
    if (value === CUSTOM_FONT) {
      fontCustom = true;
    } else {
      fontCustom = false;
      void settingsState.setFontFamily(value);
    }
  }

  function commitFontFamily(raw: string): void {
    const value = raw.trim();
    // A typed value matching a listed face collapses back to the dropdown.
    if (fontFamilies.some((f) => f.value === value)) {
      fontCustom = false;
    }
    void settingsState.setFontFamily(value);
  }

  // Reflect the resolved theme onto the document root.
  $effect(() => {
    applyTheme(settingsState.themeId);
    applyChrome(settingsState.interfaceMode, settingsState.prefersDark);
  });

  onMount(() => {
    const unlistenTheme = settingsState.listen();
    const unlistenChanges = settingsState.listenChanges();
    const unlistenThemes = themeRegistry.listen();
    const unlistenLocales = localeRegistry.listen();
    void platform.init();
    void invoke<boolean>('default_apps_page_supported')
      .catch(() => false)
      .then((supported) => {
        defaultAppsSupported = supported;
      });
    void settingsState.refreshResolvedSnapshotDir();
    // On Linux, fontconfig substitutes missing families with a metric-compatible
    // one, so the rendered-width heuristic below can't tell "installed" from
    // "substituted". Where `fc-list` is available it is authoritative; other
    // platforms fall back to the width heuristic.
    // A rejected call has to land on the heuristic too: without the catch the
    // rejection is silent and the picker keeps only its default entry forever.
    void invoke<string[] | null>('installed_font_families')
      .catch(() => null)
      .then((installed) => {
        const filtered =
          installed === null
            ? availableFonts(FONT_CANDIDATES, makeCanvasMeasurer())
            : filterInstalledFonts(FONT_CANDIDATES, installed);
        fontFamilies.push(...filtered.map((value) => ({ value })));
      });
    // Reveal the window only after the theme is loaded and applied, so a
    // dark-theme window never flashes its default white background.
    void revealWhenThemed();
    // DEV-only automation hook; dynamic import keeps it out of production.
    if (import.meta.env.DEV) {
      void import('./lib/dev/auto').then((m) =>
        m.installSettingsAuto({
          switchSnapshotDir,
          exportTheme: (path: string) => exportTheme(path),
          setThemeColor: (path, value) =>
            setSelectedColor(
              path as (typeof THEME_COLOR_FIELDS)[number]['path'],
              value,
            ),
          themeColor: (path) =>
            selectedTheme === undefined
              ? ''
              : getColor(
                  selectedTheme,
                  path as (typeof THEME_COLOR_FIELDS)[number]['path'],
                ),
        }),
      );
    }
    return () => {
      unlistenTheme();
      void unlistenChanges.then((u) => u());
      void unlistenThemes.then((u) => u());
      void unlistenLocales.then((u) => u());
    };
  });

  // The currently selected theme object, resolved through the registry so its
  // live edits (below) are visible immediately.
  const selectedTheme = $derived(themeRegistry.get(settingsState.themeId));
  // A default theme (has a bundled seed) can be restored (復原); the others can't.
  const selectedIsDefault = $derived(selectedTheme?.isDefault === true);
  // A default that has been edited carries the "（自訂）" marker in its name, so
  // there is something to restore; a pristine default has nothing to 復原.
  const selectedModified = $derived(
    selectedIsDefault &&
      selectedTheme !== undefined &&
      selectedTheme.name.endsWith(t('settings.theme.customSuffix')),
  );

  let importError = $state('');
  // Name typed for "save as new theme" (a named copy of the current colors),
  // entered in a small modal opened by the button.
  let newThemeName = $state('');
  let saveAsOpen = $state(false);

  // Any theme action dismisses a lingering import error.
  function selectTheme(id: string): void {
    importError = '';
    void settingsState.setThemeId(id);
  }

  function openSaveAs(): void {
    importError = '';
    newThemeName = '';
    saveAsOpen = true;
  }

  function cancelSaveAs(): void {
    saveAsOpen = false;
  }

  async function confirmSaveAs(): Promise<void> {
    if (newThemeName.trim() === '') {
      return;
    }
    await saveAsNewTheme();
    saveAsOpen = false;
  }

  function onSaveAsKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      void confirmSaveAs();
    } else if (e.key === 'Escape') {
      cancelSaveAs();
    }
  }

  // Focus the modal's input as soon as it mounts.
  function autofocus(node: HTMLInputElement): void {
    node.focus();
  }

  function newThemeId(): string {
    return `custom-${crypto.randomUUID()}`;
  }

  async function importTheme(): Promise<void> {
    importError = '';
    const path = await open({
      multiple: false,
      filters: [{ name: 'Theme', extensions: ['json'] }],
    });
    if (typeof path !== 'string') {
      return;
    }
    try {
      const imported = await themeRegistry.importFile(path);
      imported.id = newThemeId();
      await themeRegistry.save(imported);
      await settingsState.setThemeId(imported.id);
    } catch {
      importError = t('settings.theme.importError');
    }
  }

  // Any theme exports (defaults included) — a theme is just data.
  // `pathOverride` skips the dialog (automation/E2E), like the document saves.
  async function exportTheme(pathOverride?: string): Promise<void> {
    importError = '';
    const theme = selectedTheme;
    if (theme === undefined) {
      return;
    }
    const path =
      pathOverride ??
      (await save({
        defaultPath: `${theme.name}.json`,
        filters: [{ name: 'Theme', extensions: ['json'] }],
      }));
    if (typeof path !== 'string') {
      return;
    }
    try {
      await themeRegistry.exportFile(theme, path);
    } catch {
      importError = t('settings.theme.exportError');
    }
  }

  // Save the current colors as a new, user-named theme (a separate entry; the
  // theme it was copied from is untouched).
  async function saveAsNewTheme(): Promise<void> {
    const theme = selectedTheme;
    const name = newThemeName.trim();
    if (theme === undefined || name === '') {
      return;
    }
    const copy: Theme = structuredClone($state.snapshot(theme));
    copy.id = newThemeId();
    copy.name = name;
    delete copy.isDefault;
    newThemeName = '';
    await themeRegistry.save(copy);
    await settingsState.setThemeId(copy.id);
  }

  // 復原: restore a default theme to its seeded colors and name (dropping the
  // "（自訂）" marker). Only meaningful for defaults; the id is unchanged so the
  // selection stays put.
  async function resetSelected(): Promise<void> {
    importError = '';
    const theme = selectedTheme;
    if (theme === undefined || !selectedModified) {
      return;
    }
    // Restoring discards the current edits, so confirm first.
    const ok = await ask(
      t('settings.theme.resetConfirm', { name: theme.name }),
      {
        title: t('settings.theme.reset'),
        kind: 'warning',
        okLabel: t('settings.theme.reset'),
        cancelLabel: t('common.cancel'),
      },
    );
    if (!ok) {
      return;
    }
    await themeRegistry.restoreDefault(theme.id);
  }

  // 刪除: permanently remove the selected theme's file, freeing the space it
  // used. Any theme is deletable (defaults are seeded data files too), but the
  // picker always keeps at least one — the button is disabled at the last theme.
  async function deleteSelected(): Promise<void> {
    importError = '';
    const theme = selectedTheme;
    if (theme === undefined || themeRegistry.themes.length <= 1) {
      return;
    }
    // Deleting removes the file for good, so confirm first.
    const ok = await ask(
      t('settings.theme.deleteConfirm', { name: theme.name }),
      {
        title: t('settings.theme.delete'),
        kind: 'warning',
        okLabel: t('settings.theme.delete'),
        cancelLabel: t('common.cancel'),
      },
    );
    if (!ok) {
      return;
    }
    const wasSelected = settingsState.themeId === theme.id;
    const next = themeRegistry.themes.find((t) => t.id !== theme.id);
    await themeRegistry.remove(theme.id);
    if (wasSelected && next !== undefined) {
      await settingsState.setThemeId(next.id);
    }
  }

  // Live-editing mutates the registry's reactive entry in place (so applyTheme's
  // $effect recolors instantly), then debounces persistence so rapid drags don't
  // spam the core.
  const persistSelected = debounce((theme: Theme) => {
    void themeRegistry.persist(theme);
  }, 300);

  // Every theme edits in place. Editing a default the first time appends the
  // "（自訂）" marker to its name so the list shows it has diverged from the
  // seed; 復原 restores the seeded name and colors.
  function setSelectedColor(
    path: (typeof THEME_COLOR_FIELDS)[number]['path'],
    value: string,
  ): void {
    importError = '';
    const theme = selectedTheme;
    if (theme === undefined) {
      return;
    }
    setColor(theme, path, value);
    const suffix = t('settings.theme.customSuffix');
    if (theme.isDefault && !theme.name.endsWith(suffix)) {
      theme.name = theme.name + suffix;
    }
    persistSelected(theme);
  }

  // Language: the list mirrors the theme list. The three compiled locales sit
  // above the divider — always present and never deletable, they are the floor
  // the UI falls back to — and the pure-data locales below it can be imported
  // and deleted to free space. Every language is editable, including the
  // compiled three: editing one writes a data file that shadows its compiled
  // dictionary, and restoring drops that file again.
  //
  // Selecting a row applies that language and opens it in the editor; per-locale
  // actions (save / update / export / restore) live in the editor's own toolbar.

  /** The language open in the editor: any concrete id, or '' while following
   *  the system (nothing concrete to edit). */
  const editingId = $derived(
    settingsState.language === 'system' ? '' : settingsState.language,
  );
  /** Data locales excluding the compiled three, whose rows are rendered above
   *  the divider — an override file must not list its language twice. */
  const dataLocales = $derived(
    localeRegistry.locales.filter(
      (l) => !(BUILTIN_IDS as readonly string[]).includes(l.id),
    ),
  );
  /** Only a pure-data locale is deletable; the compiled three are the floor. */
  const canDeleteSelected = $derived(
    editingId !== '' &&
      !(BUILTIN_IDS as readonly string[]).includes(editingId) &&
      localeRegistry.get(editingId) !== undefined,
  );
  /** Row label: an override's own label (which may carry "（自訂）") wins over
   *  the constant native name. */
  function localeLabel(id: string): string {
    return localeRegistry.get(id)?.label ?? BUILTIN_LABELS[id] ?? id;
  }

  // Unsaved-edit state, reported up by the editor so switching away can warn.
  let langDirty = $state(false);

  /** Switch language. Edits are buffered in the editor, so leaving with unsaved
   *  changes would silently discard them — confirm first. */
  async function selectLanguage(lang: string): Promise<void> {
    importError = '';
    if (lang === settingsState.language) {
      return;
    }
    if (langDirty) {
      const ok = await ask(t('settings.language.discardConfirm'), {
        title: t('settings.language.unsaved'),
        kind: 'warning',
        // The question is whether to lose the edits, so the confirming button
        // says exactly that rather than "yes".
        okLabel: t('dialog.dontSave'),
        cancelLabel: t('common.cancel'),
      });
      if (!ok) {
        return;
      }
      langDirty = false;
    }
    await settingsState.setLanguage(lang);
  }

  async function importLocale(): Promise<void> {
    importError = '';
    const path = await open({
      multiple: false,
      filters: [{ name: 'Locale', extensions: ['json'] }],
    });
    if (typeof path !== 'string') {
      return;
    }
    try {
      const imported = await localeRegistry.importFile(path);
      await settingsState.setLanguage(imported.id);
    } catch {
      importError = t('settings.language.importError');
    }
  }

  async function deleteLocale(): Promise<void> {
    importError = '';
    const locale = localeRegistry.get(editingId);
    if (locale === undefined || !canDeleteSelected) {
      return;
    }
    // Deleting removes the file for good (freeing its space), so confirm first.
    const ok = await ask(
      t('settings.language.deleteConfirm', { name: locale.label }),
      {
        title: t('settings.language.delete'),
        kind: 'warning',
        okLabel: t('settings.language.delete'),
        cancelLabel: t('common.cancel'),
      },
    );
    if (!ok) {
      return;
    }
    const wasActive = settingsState.language === locale.id;
    await localeRegistry.remove(locale.id);
    langDirty = false;
    if (wasActive) {
      // The compiled floor guarantees a readable language remains; follow system.
      await settingsState.setLanguage('system');
    }
  }
</script>

<div class="settings">
  <div class="rail" role="tablist">
    {#each SECTIONS as s (s.id)}
      <button
        class="rail-item"
        class:active={section === s.id}
        role="tab"
        aria-selected={section === s.id}
        onclick={() => (section = s.id)}
      >
        {t(s.key)}
      </button>
    {/each}
  </div>

  <div class="pane">
    <!-- Every settings write funnels through `settingsState.save`, so one banner
         covers the whole window: a change that did not reach disk is reported
         here instead of leaving the control showing an edit that was lost. -->
    {#if settingsState.saveFailed}
      <p class="error save-failed" role="alert">{t('settings.saveFailed')}</p>
    {/if}
    {#if settingsState.settingsRepaired}
      <p class="error save-failed" role="alert">{t('settings.loadRepaired')}</p>
    {/if}
    {#if settingsState.snapshotDirUnavailable}
      <p class="error save-failed" role="alert">
        {t('settings.snapshotDirUnavailable')}
      </p>
    {/if}
    {#if choiceModal !== null}
      {@const modal = choiceModal}
      <div class="modal-overlay" role="presentation">
        <div class="modal-card" role="presentation">
          <span class="modal-title">{t(modal.titleKey, modal.titleParams)}</span
          >
          {#if modal.bodyKey !== undefined}
            <span class="modal-body">{t(modal.bodyKey, modal.bodyParams)}</span>
          {/if}
          <div class="modal-actions">
            {#each modal.buttons as button (button.id)}
              <button class="btn" onclick={() => answerChoice(button.id)}>
                {t(button.labelKey)}
              </button>
            {/each}
          </div>
        </div>
      </div>
    {/if}
    {#if section === 'editor'}
      <div class="subtabs" role="tablist">
        {#each EDITOR_TABS as tab (tab.id)}
          <button
            class="subtab"
            class:active={editorTab === tab.id}
            role="tab"
            aria-selected={editorTab === tab.id}
            onclick={() => (editorTab = tab.id)}
          >
            {t(tab.key)}
          </button>
        {/each}
      </div>
    {/if}
    {#if section === 'editor' && editorTab === 'theme'}
      <div class="theme-layout">
        <div class="theme-side">
          <!-- An open listbox: optgroup headers + tight option rows, like an
               expanded <select>. Only this box scrolls (import can add many
               themes later), never the whole pane. -->
          <div
            class="theme-listbox"
            role="listbox"
            aria-label={t('settings.editor.tabTheme')}
          >
            {#if themeRegistry.dark().length > 0}
              <div class="theme-optgroup-label">{t('settings.theme.dark')}</div>
              {#each themeRegistry.dark() as th (th.id)}
                <button
                  class="theme-option"
                  class:selected={settingsState.themeId === th.id}
                  role="option"
                  aria-selected={settingsState.themeId === th.id}
                  onclick={() => selectTheme(th.id)}
                >
                  {th.name}
                </button>
              {/each}
            {/if}
            {#if themeRegistry.light().length > 0}
              <div class="theme-optgroup-label">
                {t('settings.theme.light')}
              </div>
              {#each themeRegistry.light() as th (th.id)}
                <button
                  class="theme-option"
                  class:selected={settingsState.themeId === th.id}
                  role="option"
                  aria-selected={settingsState.themeId === th.id}
                  onclick={() => selectTheme(th.id)}
                >
                  {th.name}
                </button>
              {/each}
            {/if}
          </div>
          <div class="theme-actions">
            <button class="btn" onclick={() => void importTheme()}>
              {t('settings.theme.import')}
            </button>
          </div>
          {#if importError !== ''}
            <span class="error">{importError}</span>
          {/if}
          <!-- A theme that fails to load never reaches the list above, so this
               is the only place its file is named. No actions: a theme file
               that fails is one just placed in the folder by hand. -->
          <LoadProblems
            items={themeRegistry.skipped}
            kind="themes"
            actions={false}
          />
        </div>
        <!-- Preview + color editor. The color grid is always editable: every
             theme is data, edited in place; editing a default marks its name
             "（自訂）" and 復原 restores its seed. Changes recolor the window live. -->
        <div class="theme-detail">
          <ThemePreview
            isDark={settingsState.isDark}
            fontSize={settingsState.editorFontSize}
            fontFamily={settingsState.editorFontFamily}
          />
          {#if selectedTheme !== undefined}
            {@const theme = selectedTheme}
            <div class="theme-editor">
              <div class="theme-editor-actions">
                <button class="btn" onclick={() => void exportTheme()}>
                  {t('settings.theme.export')}
                </button>
                {#if selectedIsDefault}
                  <button
                    class="btn"
                    disabled={!selectedModified}
                    onclick={() => void resetSelected()}
                  >
                    {t('settings.theme.reset')}
                  </button>
                {/if}
                <button
                  class="btn"
                  disabled={themeRegistry.themes.length <= 1}
                  onclick={() => void deleteSelected()}
                >
                  {t('settings.theme.delete')}
                </button>
                <button class="btn" onclick={openSaveAs}>
                  {t('settings.theme.saveAsNew')}
                </button>
              </div>
              {#if importError !== ''}
                <span class="error">{importError}</span>
              {/if}
              {#each COLOR_GROUPS as group (group)}
                <div class="color-group">
                  <div class="theme-optgroup-label">
                    {t(`settings.theme.group.${group}`)}
                  </div>
                  {#each THEME_COLOR_FIELDS.filter((f) => f.group === group) as field (field.path)}
                    {@const value = getColor(theme, field.path)}
                    <div class="color-row">
                      <span class="color-label">
                        {field.group === 'syntax'
                          ? field.key
                          : t(`settings.theme.color.${field.key}` as I18nKey)}
                      </span>
                      <input
                        class="color-swatch"
                        type="color"
                        {value}
                        oninput={(e) =>
                          setSelectedColor(field.path, e.currentTarget.value)}
                      />
                      <span class="color-hex">{value}</span>
                    </div>
                  {/each}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      {#if saveAsOpen}
        <div class="modal-overlay" role="presentation" onclick={cancelSaveAs}>
          <div
            class="modal-card"
            role="presentation"
            onclick={(e) => e.stopPropagation()}
          >
            <span class="modal-title">{t('settings.theme.saveAsNew')}</span>
            <input
              class="text-input"
              type="text"
              placeholder={t('settings.theme.nameLabel')}
              bind:value={newThemeName}
              onkeydown={onSaveAsKeydown}
              use:autofocus
            />
            <div class="modal-actions">
              <button class="btn" onclick={cancelSaveAs}>
                {t('common.cancel')}
              </button>
              <button
                class="btn"
                disabled={newThemeName.trim() === ''}
                onclick={() => void confirmSaveAs()}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      {/if}
    {:else if section === 'sticky'}
      <div class="field">
        <span class="field-label">{t('settings.sticky.newNoteShortcut')}</span>
        <button
          class="recorder"
          class:recording
          bind:this={recorderEl}
          onfocus={() => {
            recording = true;
            shortcutError = '';
          }}
          onblur={() => (recording = false)}
          onkeydown={onRecorderKeydown}
        >
          {recording
            ? t('settings.sticky.recording')
            : formatAccelerator(
                settingsState.newNoteShortcut,
                platform.isMacOS,
              )}
        </button>
        {#if recording}
          <span class="hint">{t('settings.sticky.recordCancelHint')}</span>
        {:else}
          <span class="hint">{t('settings.sticky.recordHint')}</span>
        {/if}
        {#if shortcutError !== ''}
          <span class="error">{t('settings.sticky.shortcutError')}</span>
        {/if}
      </div>

      <div class="field">
        <span class="field-label">{t('settings.sticky.defaultSize')}</span>
        <div class="size-row">
          <span class="size-value"
            >{Math.round(settingsState.defaultStickyWidth)} ×
            {Math.round(settingsState.defaultStickyHeight)}</span
          >
          <button class="btn" onclick={() => settingsState.resetStickySize()}>
            {t('settings.sticky.resetSize')}
          </button>
        </div>
      </div>
    {:else if section === 'editor' && editorTab === 'general'}
      <label class="toggle">
        <input
          type="checkbox"
          checked={settingsState.editorWordWrap}
          onchange={(e) => settingsState.setWordWrap(e.currentTarget.checked)}
        />
        <span>{t('settings.editor.wordWrap')}</span>
      </label>

      <label class="toggle">
        <input
          type="checkbox"
          checked={settingsState.editorLineNumbers}
          onchange={(e) =>
            settingsState.setLineNumbers(e.currentTarget.checked)}
        />
        <span>{t('settings.editor.lineNumbers')}</span>
      </label>

      <div class="field">
        <label class="toggle">
          <input
            type="checkbox"
            checked={settingsState.workerHighlight}
            onchange={(e) =>
              settingsState.setWorkerHighlight(e.currentTarget.checked)}
          />
          <span>{t('settings.editor.workerHighlight')}</span>
        </label>
        <span class="hint">{t('settings.editor.workerHighlightHint')}</span>
      </div>

      <div class="field">
        <span class="field-label">{t('settings.editor.font')}</span>
        <select
          class="select"
          value={fontSelectValue}
          onchange={(e) => onFontSelect(e.currentTarget.value)}
        >
          {#each fontFamilies as f (f.value)}
            <option value={f.value}
              >{f.labelKey ? t(f.labelKey) : f.value}</option
            >
          {/each}
          <option value={CUSTOM_FONT}>{t('settings.editor.fontCustom')}</option>
        </select>
        {#if showFontInput}
          <input
            class="text-input"
            type="text"
            placeholder={t('settings.editor.fontNamePlaceholder')}
            value={settingsState.editorFontFamily}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
            onblur={(e) => commitFontFamily(e.currentTarget.value)}
          />
        {/if}
      </div>

      <div class="field">
        <span class="field-label">{t('settings.editor.fontSize')}</span>
        <div class="stepper">
          <button
            class="step"
            title={t('settings.editor.fontSizeDecrease')}
            aria-label={t('settings.editor.fontSizeDecrease')}
            onclick={() => stepFontSize(-1)}
          >
            −
          </button>
          <input
            class="num"
            type="number"
            min="9"
            max="32"
            value={settingsState.editorFontSize}
            onchange={(e) => commitFontSize(e.currentTarget.value)}
          />
          <button
            class="step"
            title={t('settings.editor.fontSizeIncrease')}
            aria-label={t('settings.editor.fontSizeIncrease')}
            onclick={() => stepFontSize(1)}
          >
            +
          </button>
        </div>
      </div>
      <div class="field">
        <span class="field-label">{t('settings.editor.defaultLineEnding')}</span
        >
        <select
          class="select"
          value={settingsState.defaultLineEnding}
          onchange={(e) =>
            settingsState.setDefaultLineEnding(
              e.currentTarget.value as LineEnding,
            )}
        >
          <option value="LF">LF</option>
          <option value="CRLF">CRLF</option>
        </select>
      </div>

      <div class="field">
        <span class="field-label">{t('settings.editor.defaultEncoding')}</span>
        <select
          class="select"
          value={settingsState.defaultEncoding}
          onchange={(e) =>
            settingsState.setDefaultEncoding(e.currentTarget.value)}
        >
          {#each ENCODINGS as enc (enc)}
            <option value={enc}>{enc}</option>
          {/each}
        </select>
      </div>
    {:else if section === 'general'}
      <!-- Interface (chrome) appearance — independent of the editor theme. -->
      <div class="field">
        <span class="field-label">{t('settings.interface.label')}</span>
        <div class="segmented">
          {#each INTERFACE_MODES as mode (mode.id)}
            <button
              class="segment"
              class:active={settingsState.interfaceMode === mode.id}
              onclick={() => void settingsState.setInterfaceMode(mode.id)}
            >
              {t(mode.key)}
            </button>
          {/each}
        </div>
      </div>
      <div class="field">
        <span class="field-label">{t('settings.general.snapshotLocation')}</span
        >
        <span class="hint">{settingsState.resolvedSnapshotDir}</span>
        <div class="snapshot-actions">
          <button class="btn" onclick={() => void chooseSnapshotDir()}>
            {t('settings.general.snapshotChoose')}
          </button>
          <button
            class="btn"
            disabled={settingsState.snapshotDir === null}
            onclick={() => void resetSnapshotDir()}
          >
            {t('settings.general.snapshotReset')}
          </button>
        </div>
        {#if snapshotDirError !== ''}
          <span class="error">{snapshotDirError}</span>
        {/if}
        <span class="hint">{t('settings.general.snapshotCloudHint')}</span>
      </div>

      <div class="field">
        <span class="field-label">{t('settings.general.largeOpenMode')}</span>
        <select
          class="select"
          value={settingsState.largeOpenMode}
          onchange={(e) =>
            settingsState.setLargeOpenMode(
              e.currentTarget.value as LargeOpenMode,
            )}
        >
          <option value="ask">{t('settings.general.largeOpenModeAsk')}</option>
          <option value="view">{t('settings.general.largeOpenModeView')}</option
          >
          <option value="edit">{t('settings.general.largeOpenModeEdit')}</option
          >
        </select>
      </div>

      <label class="toggle">
        <input
          type="checkbox"
          checked={settingsState.askLongLineOpen}
          onchange={(e) =>
            settingsState.setAskLongLineOpen(e.currentTarget.checked)}
        />
        <span>{t('settings.general.askLongLineOpen')}</span>
      </label>

      <label class="toggle">
        <input
          type="checkbox"
          checked={settingsState.previewLocalResources}
          onchange={(e) =>
            settingsState.setPreviewLocalResources(e.currentTarget.checked)}
        />
        <span>{t('settings.general.previewLocalResources')}</span>
      </label>

      <div class="field">
        <span class="field-label">{t('settings.general.openTarget')}</span>
        <select
          class="select"
          value={settingsState.openTarget}
          onchange={(e) =>
            settingsState.setOpenTarget(e.currentTarget.value as OpenTarget)}
        >
          <option value="tab">{t('settings.general.openTargetTab')}</option>
          <option value="window"
            >{t('settings.general.openTargetWindow')}</option
          >
        </select>
      </div>

      {#if defaultAppsSupported}
        <div class="field">
          <span class="field-label">{t('settings.general.defaultApps')}</span>
          <button
            class="btn default-apps-action"
            onclick={() => void invoke('open_default_apps_page')}
          >
            {t('settings.general.defaultAppsOpen')}
          </button>
        </div>
      {/if}

      <label class="toggle">
        <input
          type="checkbox"
          checked={settingsState.showTrayIcon}
          onchange={(e) =>
            settingsState.setShowTrayIcon(e.currentTarget.checked)}
        />
        <span>{t('settings.general.showTrayIcon')}</span>
      </label>

      <label class="toggle">
        <input
          type="checkbox"
          checked={settingsState.openWorkspaceOnStartup}
          onchange={(e) =>
            settingsState.setOpenWorkspaceOnStartup(e.currentTarget.checked)}
        />
        <span>{t('settings.general.openWorkspaceOnStartup')}</span>
      </label>
    {:else if section === 'language'}
      <div class="lang-layout">
        <div class="lang-side">
          <!-- Open listbox, like the theme list: the three compiled locales
             (always available, never deletable) at the top, a divider, then the
             pure-data locales the user can import/export/delete. -->
          <div
            class="theme-listbox"
            role="listbox"
            aria-label={t('settings.section.language')}
          >
            <button
              class="theme-option"
              class:selected={settingsState.language === 'system'}
              role="option"
              aria-selected={settingsState.language === 'system'}
              onclick={() => void selectLanguage('system')}
            >
              {t('settings.language.system')}
            </button>
            {#each BUILTIN_IDS as id (id)}
              <button
                class="theme-option"
                class:selected={settingsState.language === id}
                role="option"
                aria-selected={settingsState.language === id}
                onclick={() => void selectLanguage(id)}
              >
                {localeLabel(id)}{#if langDirty && editingId === id}<span
                    class="dirty-dot">•</span
                  >{/if}
              </button>
            {/each}
            {#if dataLocales.length > 0}
              <div class="list-divider"></div>
              {#each dataLocales as loc (loc.id)}
                <button
                  class="theme-option"
                  class:selected={settingsState.language === loc.id}
                  role="option"
                  aria-selected={settingsState.language === loc.id}
                  onclick={() => void selectLanguage(loc.id)}
                >
                  {loc.label}{#if langDirty && editingId === loc.id}<span
                      class="dirty-dot">•</span
                    >{/if}
                </button>
              {/each}
            {/if}
          </div>
          <div class="theme-actions">
            <button class="btn" onclick={() => void importLocale()}>
              {t('settings.language.import')}
            </button>
            <button
              class="btn"
              disabled={!canDeleteSelected}
              onclick={() => void deleteLocale()}
            >
              {t('settings.language.delete')}
            </button>
          </div>
          {#if importError !== ''}
            <span class="error">{importError}</span>
          {/if}
          <!-- The delete button above only reaches locales that loaded, so a
               file that fails to parse cannot be removed from here without
               this. Its folder is one the user has never had to visit. -->
          <LoadProblems
            items={localeRegistry.skipped}
            kind="locales"
            actions={true}
            onchanged={() => void localeRegistry.load()}
          />
        </div>
        <!-- String editor. Every language is editable, the compiled three
             included: their edits are stored as a data file shadowing the
             compiled dictionary. Edits are buffered until saved, so typing never
             retranslates the running UI mid-keystroke. Keyed on the id so
             switching languages remounts with a fresh draft. -->
        <div class="lang-detail">
          {#if editingId === ''}
            <p class="lang-hint">{t('settings.language.followSystemHint')}</p>
          {:else}
            {#key editingId}
              <LocaleEditor
                id={editingId}
                isBuiltin={(BUILTIN_IDS as readonly string[]).includes(
                  editingId,
                )}
                hasSeed={localeRegistry.get(editingId)?.isDefault === true}
                ondirty={(d) => (langDirty = d)}
              />
            {/key}
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .settings {
    display: flex;
    height: 100vh;
    overflow: hidden;
    background: var(--bg);
    color: var(--fg);
    font-family: system-ui, sans-serif;
    font-size: 0.85rem;
  }
  .rail {
    display: flex;
    flex-direction: column;
    flex: 0 0 120px;
    gap: 0.15rem;
    padding: 0.6rem 0.4rem;
    border-right: 1px solid var(--topbar-border);
    overflow-y: auto;
  }
  .rail-item {
    padding: 0.45rem 0.6rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: default;
    opacity: 0.7;
  }
  .rail-item:hover {
    background: var(--topbar-border);
    opacity: 1;
  }
  .rail-item.active {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    opacity: 1;
    font-weight: 600;
  }
  .pane {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    flex: 1 1 auto;
    padding: 1rem 1.1rem;
    overflow-y: auto;
  }
  .subtabs {
    display: flex;
    flex: 0 0 auto;
    gap: 0.3rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--topbar-border);
  }
  .subtab {
    padding: 0.3rem 0.7rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: default;
    opacity: 0.6;
  }
  .subtab:hover {
    opacity: 1;
  }
  .subtab.active {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    opacity: 1;
    font-weight: 600;
  }
  .segmented {
    display: inline-flex;
    align-self: flex-start;
    border: 1px solid var(--topbar-border);
    border-radius: 7px;
    overflow: hidden;
  }
  .segment {
    padding: 0.35rem 0.8rem;
    border: none;
    border-right: 1px solid var(--topbar-border);
    background: none;
    color: inherit;
    font: inherit;
    cursor: default;
  }
  .segment:last-child {
    border-right: none;
  }
  .segment:hover {
    background: var(--topbar-border);
  }
  .segment.active {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    font-weight: 600;
  }
  /* Breathing room below the last control. A real flex item rather than bottom
     padding: scroll containers drop trailing padding in some engines, so the
     padding-only version still let the last control hug the window edge. */
  .pane::after {
    content: '';
    flex: 0 0 1.2rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .field-label {
    font-size: 0.78rem;
    opacity: 0.6;
  }
  .stepper {
    display: inline-flex;
    align-self: flex-start;
    align-items: center;
    gap: 0.3rem;
  }
  .step {
    width: 26px;
    height: 26px;
    border: 1px solid var(--topbar-border);
    border-radius: 6px;
    background: none;
    color: inherit;
    font-size: 1rem;
    line-height: 1;
    cursor: default;
  }
  .step:hover {
    background: var(--topbar-border);
  }
  .num {
    width: 3.2rem;
    padding: 0.3rem;
    border: 1px solid var(--topbar-border);
    border-radius: 6px;
    background: var(--bg);
    color: inherit;
    font: inherit;
    text-align: center;
  }
  .recorder {
    align-self: flex-start;
    min-width: 12rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--topbar-border);
    border-radius: 7px;
    background: var(--bg);
    color: inherit;
    font: inherit;
    text-align: center;
    cursor: default;
  }
  .recorder.recording {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent);
    opacity: 0.85;
  }
  .hint {
    font-size: 0.75rem;
    opacity: 0.5;
  }
  .error {
    color: var(--danger);
    font-size: 0.78rem;
  }
  .save-failed {
    margin: 0 0 0.75rem;
  }
  .text-input {
    align-self: flex-start;
    min-width: 12rem;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--topbar-border);
    border-radius: 6px;
    background: var(--bg);
    color: inherit;
    font: inherit;
  }
  .size-row {
    display: flex;
    align-items: center;
    gap: 0.7rem;
  }
  .size-value {
    font-variant-numeric: tabular-nums;
  }
  .btn {
    padding: 0.35rem 0.8rem;
    border: 1px solid var(--topbar-border);
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: default;
  }
  .btn:hover:not(:disabled) {
    background: var(--topbar-border);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .snapshot-actions {
    display: flex;
    gap: 0.5rem;
  }
  /* A lone button in a column field would otherwise stretch the full width. */
  .default-apps-action {
    align-self: flex-start;
  }
  .select {
    align-self: flex-start;
    min-width: 8rem;
    padding: 0.35rem;
    border: 1px solid var(--topbar-border);
    border-radius: 6px;
    background: var(--bg);
    color: inherit;
    font: inherit;
  }
  /* The appearance pane fills the window height so the preview can stretch and
     the listbox gets a real scroll region instead of growing the pane. The
     language list wants the same self-scrolling listbox. */
  .pane:has(.theme-layout),
  .pane:has(.lang-layout) {
    overflow: hidden;
  }
  /* Language pane: the locale list on the left, the string editor on the right,
     mirroring the theme pane's split. */
  .lang-layout {
    display: flex;
    gap: 1rem;
    align-items: stretch;
    flex: 1 1 auto;
    min-height: 0;
  }
  /* Left column: the listbox plus the import/export/reset/delete actions.
     `min-width: 0` is required, not cosmetic: a flex item's automatic minimum
     size would otherwise let the longest non-wrapping label (e.g. "Português
     (Brasil) (Brazilian Portuguese)") stretch this column past its basis and
     push the editor out of the window. Pinned here, long labels ellipsize
     inside the listbox instead. */
  .lang-side {
    display: flex;
    flex-direction: column;
    flex: 0 0 250px;
    min-width: 0;
    gap: 0.5rem;
    min-height: 0;
  }
  /* Plain divider between the compiled locales and the deletable data locales. */
  .list-divider {
    margin: 0.35rem 0.5rem;
    border-top: 1px solid var(--topbar-border);
  }
  /* Right column: hosts the editor, which keeps its toolbar pinned and scrolls
     its own ~170 string rows. */
  .lang-detail {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }
  .lang-hint {
    margin: 0;
    opacity: 0.6;
  }
  /* Marks the row whose editor has unsaved edits, so the state is visible even
     while scrolled away from the toolbar. */
  .dirty-dot {
    margin-left: 0.3rem;
    color: var(--accent);
  }
  .theme-layout {
    display: flex;
    gap: 1rem;
    align-items: stretch;
    flex: 1 1 auto;
    min-height: 0;
  }
  /* Left column: the listbox plus the duplicate/import actions below it. */
  .theme-side {
    display: flex;
    flex-direction: column;
    flex: 0 0 190px;
    gap: 0.5rem;
    min-height: 0;
  }
  /* Open listbox styled like an expanded <select>: fixed width, own scroll. */
  .theme-listbox {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    padding: 0.25rem;
    border: 1px solid var(--topbar-border);
    border-radius: 8px;
    background: var(--bg);
    overflow-y: auto;
    min-height: 0;
  }
  .theme-actions {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .theme-actions .btn {
    width: 100%;
  }
  /* Right column: the read-only preview on top, the editor/actions below,
     scrolling on its own so the 16 color rows never widen or scroll the pane. */
  .theme-detail {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }
  .theme-editor {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    overflow-y: auto;
    min-height: 0;
  }
  .theme-editor-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .modal-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, #000 45%, transparent);
    z-index: 10;
  }
  .modal-card {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    min-width: 16rem;
    padding: 1rem;
    border: 1px solid var(--topbar-border);
    border-radius: 10px;
    background: var(--bg);
    box-shadow: 0 8px 30px color-mix(in srgb, #000 35%, transparent);
  }
  .modal-title {
    font-size: 0.82rem;
    font-weight: 600;
  }
  .modal-body {
    font-size: 0.8rem;
    opacity: 0.8;
  }
  .modal-card .text-input {
    align-self: stretch;
    min-width: 0;
  }
  .modal-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .color-group {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .color-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.15rem 0.5rem;
  }
  .color-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
  }
  .color-swatch {
    flex: 0 0 auto;
    width: 1.8rem;
    height: 1.5rem;
    padding: 0;
    border: 1px solid var(--topbar-border);
    border-radius: 4px;
    background: none;
    cursor: default;
  }
  .color-hex {
    flex: 0 0 4.6rem;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    opacity: 0.6;
  }
  .theme-optgroup-label {
    padding: 0.35rem 0.5rem 0.2rem;
    font-size: 0.72rem;
    font-weight: 600;
    opacity: 0.5;
  }
  .theme-optgroup-label:not(:first-child) {
    margin-top: 0.35rem;
    border-top: 1px solid var(--topbar-border);
    padding-top: 0.5rem;
  }
  .theme-option {
    padding: 0.32rem 0.6rem;
    border: none;
    border-radius: 5px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: default;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .theme-option:hover {
    background: var(--topbar-border);
  }
  .theme-option.selected {
    background: var(--accent);
    color: #fff;
  }
</style>
