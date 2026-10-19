// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { withAddedFont } from '../util/font';
import type { LineEnding } from '../util/text';
import type { I18nKey } from '../i18n';
import { resolveLocale, type Language, type Locale } from '../i18n/locale';
import { localeRegistry } from '../i18n/localeRegistry.svelte';
import { pickDefaultTheme, resolveEditorTheme } from '../theme/themes';
import { isLite } from './edition.svelte';
import { themeRegistry } from '../theme/themeRegistry.svelte';
import {
  interfaceIsDark,
  isInterfaceMode,
  type InterfaceMode,
} from '../theme/chrome';

/** How an over-threshold file opens: ask (confirm offering view/edit), or open
 *  straight into the read-only view or in-place edit. */
export type LargeOpenMode = 'ask' | 'view' | 'edit';

/** Where a non-project file opens from the Open dialog / menu. */
export type OpenTarget = 'tab' | 'window';

/** How to resolve a snapshot-file name collision when moving into an
 *  already-populated destination. Mirrors Rust's `CollisionPolicy`. */
export type CollisionPolicy = 'source' | 'dest' | 'both';

/** Note counts for the snapshot-dir switch-confirmation dialogs. */
export interface SnapshotMovePreview {
  sourceCount: number;
  collisionCount: number;
}

/** Full settings payload from the Rust core (load_settings / settings-changed). */
interface AppSettings {
  // Not typed as ThemeId: Rust stores this verbatim and never validates it (see
  // AppSettings::theme's doc comment on the Rust side), so a legacy/unknown
  // value can arrive here — `apply()` below is what actually enforces the type.
  theme: string;
  interface_mode: string;
  editor_font_size: number;
  editor_word_wrap: boolean;
  editor_line_numbers: boolean;
  worker_highlight: boolean;
  large_open_mode: LargeOpenMode;
  ask_long_line_open: boolean;
  preview_local_resources: boolean;
  open_target: OpenTarget;
  editor_font_family: string;
  editor_extra_fonts: string[];
  default_line_ending: LineEnding;
  default_encoding: string;
  new_note_shortcut: string;
  snapshot_dir: string | null;
  default_sticky_width: number;
  default_sticky_height: number;
  language: Language;
  show_tray_icon: boolean;
  open_workspace_on_startup: boolean;
}

/** Payload of the `load_settings` command: the settings themselves, plus the
 *  name of every field that was silently repaired while loading (wrong JSON
 *  type or an out-of-range value, reset to its default) — empty when none
 *  were. See `AppSettings::repair`/`tolerant_settings` on the Rust side. */
interface LoadedSettings {
  settings: AppSettings;
  repaired_fields: string[];
  unset_defaults_to_notify?: string[];
  snapshot_dir_unavailable: boolean;
  snapshot_dir_in_use: boolean;
  snapshot_dir_unlockable: boolean;
}
/** What `set_snapshot_dir` returns: the snapshot-folder notices to show from
 *  now on. Mirrors Rust's `SnapshotDirState`. */
interface SnapshotDirState {
  unavailable: boolean;
  in_use: boolean;
  unlockable: boolean;
}
/** The text for a failed `set_snapshot_dir`. Rust's `SetDirError` arrives as
 *  `{ kind: 'in_use' }` or `{ kind: 'other', message }`; "in use" gets its own
 *  wording, anything else shows what the core reported. */
export function snapshotDirErrorText(
  err: unknown,
  translate: (key: I18nKey) => string,
): string {
  if (typeof err === 'object' && err !== null && 'kind' in err) {
    if (err.kind === 'in_use') {
      return translate('settings.snapshotDirInUseSwitch');
    }
    if ('message' in err) {
      return String(err.message);
    }
  }
  return String(err);
}

// Exported (alongside the `settingsState` singleton below) so tests can
// construct isolated instances — see settingsReady.test.ts.
export class SettingsState {
  // Empty until the first settings load resolves a real theme id (or the
  // registry seeds one). applyTheme falls back to the first available theme, so
  // an unresolved id never leaves a window unthemed.
  themeId = $state<string>('');
  /** App interface (chrome) appearance, independent of the editor theme. */
  interfaceMode = $state<InterfaceMode>('system');
  editorFontSize = $state(13);
  editorWordWrap = $state(true);
  editorLineNumbers = $state(true);
  workerHighlight = $state(false);
  largeOpenMode = $state<LargeOpenMode>('ask');
  askLongLineOpen = $state(true);
  previewLocalResources = $state(false);
  openTarget = $state<OpenTarget>('tab');
  editorFontFamily = $state('');
  /** Families the user added through the picker's "choose another font" list. */
  editorExtraFonts = $state<string[]>([]);
  defaultLineEnding = $state<LineEnding>('LF');
  defaultEncoding = $state('UTF-8');
  newNoteShortcut = $state('CmdOrCtrl+Shift+N');
  /** Folder the user picked to hold snapshots, or null for the default (the
   *  app data dir). Absolute path, verbatim from the Rust core. */
  snapshotDir = $state<string | null>(null);
  /** The actually-resolved snapshots directory (picked folder's own "Note&Pad"
   *  subfolder, or the app data default), fetched separately since it is
   *  derived server-side rather than stored directly. Empty until the first
   *  fetch resolves. */
  resolvedSnapshotDir = $state('');
  defaultStickyWidth = $state(280);
  defaultStickyHeight = $state(230);
  language = $state<Language>('system');
  showTrayIcon = $state(true);
  openWorkspaceOnStartup = $state(false);
  /** Active UI locale id, resolved against the OS language and the set of loaded
   *  locales. Depends on `localeRegistry`, so it re-resolves when a locale is
   *  imported or deleted — a deleted active locale falls back automatically. */
  resolvedLocale: Locale = $derived(
    resolveLocale(
      this.language,
      navigator.language,
      localeRegistry.availableIds(),
    ),
  );
  /** OS light/dark preference, kept live by `listen()`. Drives the interface
   *  chrome when `interfaceMode` follows the system, and picks the first-run
   *  default theme when the stored theme id is unresolvable. Public so each
   *  window's chrome `$effect` re-runs when the OS preference changes. */
  prefersDark = $state(false);

  /** Fold a full settings payload into the reactive fields. `theme` is
   *  validated here (Rust stores it verbatim, see the payload's doc comment
   *  above): an unrecognized value — a fresh install's placeholder, or a
   *  legacy mode string — is replaced by an OS-preference-based
   *  default and persisted immediately, so it only ever happens once. */
  /** `validate` is set only for the first load (`init`), where the registry is
   *  reliably loaded (reveal.ts loads it first): an unresolvable stored id — a
   *  fresh install's placeholder or a legacy mode string — is replaced by
   *  an OS-preference default and persisted once. Live `settings-changed`
   *  broadcasts pass `validate=false` and are trusted verbatim: another window
   *  may broadcast a just-created theme id before this window's registry has
   *  reloaded it, so re-validating here would wrongly "correct" it back to a
   *  default and clobber the selection everywhere. applyTheme falls back
   *  visually until the registry catches up, then resolves the real theme. */
  private apply(s: AppSettings, validate = false): void {
    // Lite has no theme choice and must not correct the stored one: that would
    // overwrite a choice made in the full edition.
    if (!validate || themeRegistry.has(s.theme) || isLite()) {
      this.themeId = s.theme;
    } else {
      const picked = pickDefaultTheme(this.prefersDark, themeRegistry.themes);
      if (picked !== undefined) {
        this.themeId = picked;
        void this.setThemeId(picked);
      }
    }
    this.interfaceMode = isInterfaceMode(s.interface_mode)
      ? s.interface_mode
      : 'system';
    this.editorFontSize = s.editor_font_size;
    this.editorWordWrap = s.editor_word_wrap;
    this.editorLineNumbers = s.editor_line_numbers;
    this.workerHighlight = s.worker_highlight;
    this.largeOpenMode = s.large_open_mode;
    this.askLongLineOpen = s.ask_long_line_open;
    this.previewLocalResources = s.preview_local_resources;
    this.openTarget = s.open_target;
    this.editorFontFamily = s.editor_font_family;
    this.editorExtraFonts = s.editor_extra_fonts;
    this.defaultLineEnding = s.default_line_ending;
    this.defaultEncoding = s.default_encoding;
    this.newNoteShortcut = s.new_note_shortcut;
    this.snapshotDir = s.snapshot_dir;
    this.defaultStickyWidth = s.default_sticky_width;
    this.defaultStickyHeight = s.default_sticky_height;
    this.language = s.language;
    this.showTrayIcon = s.show_tray_icon;
    this.openWorkspaceOnStartup = s.open_workspace_on_startup;
  }

  /** Resolves once `init()` has folded the stored settings in — or has failed
   *  trying, so a caller can never hang on it.
   *
   *  A document window's `onMount` starts two independent chains: one loads the
   *  settings (through `revealWhenThemed`), the other opens the file it was
   *  created for. Nothing ordered them, so a decision that reads a setting could
   *  run against the constructor defaults instead of the stored value — on a
   *  slow machine, opening a large file with `large_open_mode` set to
   *  'view'/'edit' still raised the 'ask' confirm, because the open won the race
   *  Anything whose behaviour a setting decides awaits this first. */
  readonly ready: Promise<void>;
  #markReady!: () => void;

  constructor() {
    this.ready = new Promise((resolve) => {
      this.#markReady = resolve;
    });
  }

  /** True when the last settings write did not reach disk. Every write goes
   *  through `save`, so this is the single place any window can read to tell the
   *  user their change was not kept. Cleared by the next write that succeeds.
   *
   *  This exists because a rejected write used to be swallowed whole: the
   *  setters below assign the new value before persisting it, so the UI went on
   *  showing a change that was never stored, and the app silently stopped
   *  keeping settings at all until it was restarted. */
  saveFailed = $state(false);

  /** True when the settings file on disk had a field that was unreadable
   *  (wrong type or out of range) and got silently reset to its default while
   *  loading. Kept separate from `saveFailed`: that flag means a write did not
   *  reach disk, this one means a *read* repaired the file — conflating them
   *  would show a save-failure message for a problem that happened on load.
   *  The repaired value is what the next save would otherwise permanently
   *  write back over what the user actually had, so this is the one place
   *  that ever gets told. */
  settingsRepaired = $state(false);

  /** True when the folder named by the `snapshot_dir` setting could not be
   *  used at startup and the default folder is in use instead. Set from
   *  `LoadedSettings.snapshot_dir_unavailable`, alongside `settingsRepaired`. */
  snapshotDirUnavailable = $state(false);
  /** True when the chosen snapshot folder is in use by another app at startup
   *  and the default folder is in use instead. From
   *  `LoadedSettings.snapshot_dir_in_use`. */
  snapshotDirInUse = $state(false);
  /** True when the snapshot folder in use has no lock support, so another app
   *  using it at the same time cannot be detected. From
   *  `LoadedSettings.snapshot_dir_unlockable`, kept current by
   *  `setSnapshotDir`. */
  snapshotDirUnlockable = $state(false);
  /** Rows whose default key is taken and not yet acknowledged, from the last
   *  load. The Settings window acknowledges them once it has shown the notice. */
  unsetDefaultsToNotify: string[] = [];
  /** Tell the Rust core the unset-default notice was shown, so it is not
   *  repeated on the next launch. A failure only means it is shown again. */
  async ackUnsetDefaults(): Promise<void> {
    try {
      await invoke<void>('ack_unset_defaults', {
        ids: this.unsetDefaultsToNotify,
      });
    } catch {
      // Reported again on the next load.
    }
  }

  /** Persist a partial settings patch. On failure the optimistic in-memory
   *  value is re-read from disk, so the control snaps back to what is actually
   *  stored rather than advertising an edit that did not happen. */
  async save(patch: Record<string, unknown>): Promise<void> {
    try {
      await invoke<void>('save_settings', { settings: patch });
      this.saveFailed = false;
    } catch {
      this.saveFailed = true;
      try {
        const loaded = await invoke<LoadedSettings>('load_settings');
        this.apply(loaded.settings);
        this.settingsRepaired = loaded.repaired_fields.length > 0;
        this.#applySnapshotDirState(loaded);
        this.unsetDefaultsToNotify = loaded.unset_defaults_to_notify ?? [];
      } catch {
        // The stored settings cannot be read back either; the flag is all the
        // signal there is.
      }
    }
  }

  #applySnapshotDirState(loaded: LoadedSettings): void {
    this.snapshotDirUnavailable = loaded.snapshot_dir_unavailable ?? false;
    this.snapshotDirInUse = loaded.snapshot_dir_in_use ?? false;
    this.snapshotDirUnlockable = loaded.snapshot_dir_unlockable ?? false;
  }

  async init(): Promise<void> {
    try {
      const loaded = await invoke<LoadedSettings>('load_settings');
      this.apply(loaded.settings, true);
      this.settingsRepaired = loaded.repaired_fields.length > 0;
      this.#applySnapshotDirState(loaded);
      this.unsetDefaultsToNotify = loaded.unset_defaults_to_notify ?? [];
    } finally {
      this.#markReady();
    }
  }

  /** Fetch the actually-resolved snapshots directory from the Rust core (it is
   *  derived from `snapshotDir`, not stored directly). Only the settings
   *  window needs this, so it is fetched on demand rather than in `init()`. */
  async refreshResolvedSnapshotDir(): Promise<void> {
    this.resolvedSnapshotDir = await invoke<string>('get_snapshot_dir');
  }

  /** Register the OS color-scheme listener; returns a cleanup function. */
  listen(): () => void {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    this.prefersDark = mq.matches;
    const onChange = (e: MediaQueryListEvent): void => {
      this.prefersDark = e.matches;
    };
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }

  /** Subscribe to the app-wide `settings-changed` broadcast so every window
   *  applies live edits made in the settings window. */
  listenChanges(): Promise<UnlistenFn> {
    return listen<AppSettings>('settings-changed', (e) =>
      this.apply(e.payload),
    );
  }

  get isDark(): boolean {
    return (
      resolveEditorTheme(
        themeRegistry.themes,
        this.themeId,
        isLite(),
        interfaceIsDark(this.interfaceMode, this.prefersDark),
      )?.variant === 'dark'
    );
  }

  async setLanguage(language: Language): Promise<void> {
    this.language = language;
    await this.save({ language });
  }

  async setThemeId(id: string): Promise<void> {
    this.themeId = id;
    // save_settings merges partial patches server-side, so unrelated fields
    // (shortcut, snapshot location, ...) are never clobbered.
    await this.save({ theme: id });
  }

  async setInterfaceMode(mode: InterfaceMode): Promise<void> {
    this.interfaceMode = mode;
    await this.save({ interface_mode: mode });
  }

  async setFontSize(size: number): Promise<void> {
    this.editorFontSize = size;
    await this.save({ editor_font_size: size });
  }

  async setWordWrap(on: boolean): Promise<void> {
    this.editorWordWrap = on;
    await this.save({ editor_word_wrap: on });
  }

  async setLineNumbers(on: boolean): Promise<void> {
    this.editorLineNumbers = on;
    await this.save({ editor_line_numbers: on });
  }

  async setWorkerHighlight(on: boolean): Promise<void> {
    this.workerHighlight = on;
    await this.save({ worker_highlight: on });
  }

  async setLargeOpenMode(mode: LargeOpenMode): Promise<void> {
    this.largeOpenMode = mode;
    await this.save({ large_open_mode: mode });
  }

  async setAskLongLineOpen(on: boolean): Promise<void> {
    this.askLongLineOpen = on;
    await this.save({ ask_long_line_open: on });
  }

  async setPreviewLocalResources(on: boolean): Promise<void> {
    this.previewLocalResources = on;
    await this.save({ preview_local_resources: on });
  }

  async setOpenTarget(target: OpenTarget): Promise<void> {
    this.openTarget = target;
    await this.save({ open_target: target });
  }

  async setShowTrayIcon(on: boolean): Promise<void> {
    this.showTrayIcon = on;
    await this.save({ show_tray_icon: on });
  }

  async setOpenWorkspaceOnStartup(on: boolean): Promise<void> {
    this.openWorkspaceOnStartup = on;
    await this.save({ open_workspace_on_startup: on });
  }

  async setFontFamily(family: string): Promise<void> {
    const trimmed = family.trim();
    this.editorFontFamily = trimmed;
    await this.save({ editor_font_family: trimmed });
  }
  /** Remember `family` in the added-fonts list and select it, in one save. */
  async addFontFamily(family: string): Promise<void> {
    const trimmed = family.trim();
    this.editorFontFamily = trimmed;
    this.editorExtraFonts = withAddedFont(this.editorExtraFonts, trimmed);
    await this.save({
      editor_font_family: trimmed,
      editor_extra_fonts: this.editorExtraFonts,
    });
  }

  async setDefaultLineEnding(ending: LineEnding): Promise<void> {
    this.defaultLineEnding = ending;
    await this.save({ default_line_ending: ending });
  }

  async setDefaultEncoding(label: string): Promise<void> {
    this.defaultEncoding = label;
    await this.save({ default_encoding: label });
  }

  /** Note counts for the switch-confirmation dialogs, computed from what is
   *  actually on disk in the currently active directory and in `dir`
   *  (null resolves to the default location), not the in-memory note list. */
  async previewSnapshotDirMove(
    dir: string | null,
  ): Promise<SnapshotMovePreview> {
    const preview = await invoke<{
      source_count: number;
      collision_count: number;
    }>('preview_snapshot_dir_move', { dir });
    return {
      sourceCount: preview.source_count,
      collisionCount: preview.collision_count,
    };
  }

  /** Snapshot dir moves files server-side (its own command), so this never
   *  goes through save_settings. Update the local fields only after it
   *  succeeds. `dir` is null to reset to the default. `moveFiles` false
   *  switches the active directory without touching any files (the "don't
   *  move" choice); `policy` resolves a name collision at the destination
   *  and is ignored when there is nothing to move. The returned notice state
   *  replaces the startup one: the folder is now the one the user picked. */
  async setSnapshotDir(
    dir: string | null,
    moveFiles: boolean,
    policy: CollisionPolicy,
  ): Promise<void> {
    const state = await invoke<SnapshotDirState>('set_snapshot_dir', {
      dir,
      moveFiles,
      policy,
    });
    this.snapshotDirUnavailable = state.unavailable;
    this.snapshotDirInUse = state.in_use;
    this.snapshotDirUnlockable = state.unlockable;
    this.snapshotDir = dir;
    await this.refreshResolvedSnapshotDir();
  }
  /** Reset the default sticky size to the built-in 280×230. */
  async resetStickySize(): Promise<void> {
    this.defaultStickyWidth = 280;
    this.defaultStickyHeight = 230;
    await this.save({ default_sticky_width: 280, default_sticky_height: 230 });
  }
}

export const settingsState = new SettingsState();
