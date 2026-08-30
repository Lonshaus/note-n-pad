// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::fs_ops::write_text_atomic;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppSettings {
  /// The active built-in theme id (e.g. "ink", "paper"). No mode/slot layer —
  /// whichever theme the user last picked is stored verbatim. Not validated
  /// against the known theme id set here: a legacy value from before this
  /// field held an id (the old "system"/"light"/"dark" mode strings) or an
  /// unrecognized id is the frontend's job to detect and replace on load
  /// (`settingsState` picks a system-preference-based default in that case),
  /// so Rust never rejects or silently rewrites it.
  #[serde(default = "default_theme")]
  pub theme: String,
  /// App interface (chrome) appearance, independent of the editor `theme`:
  /// "system" (follow the OS), "light", or "dark". The frontend validates it
  /// (an unknown value falls back to "system"), so it is stored verbatim here.
  #[serde(default = "default_interface_mode")]
  pub interface_mode: String,
  /// UI language: "system" follows the OS/browser UI language, otherwise a
  /// locale id. Not validated against a fixed set here (like `theme`): the three
  /// compiled locales ("zh-TW"/"ja"/"en") plus any pure-data locale — including
  /// a third-party import with an arbitrary id — are all valid selections, and
  /// the frontend resolves an unavailable or deleted id to a fallback on load,
  /// so Rust stores whichever id was chosen verbatim.
  #[serde(default = "default_language")]
  pub language: String,
  #[serde(default = "default_new_note_shortcut")]
  pub new_note_shortcut: String,
  /// Absolute path to the folder the user picked to hold the app's `Note&Pad`
  /// snapshots folder, or `None` for the default (the app data dir). See
  /// `note_store::resolve_snapshot_dir` for how this resolves to the actual
  /// snapshots directory, and `note_store::migrate_legacy_snapshot_location`
  /// for the retired `"local"`/`"icloud"` string this field replaced.
  #[serde(default = "default_snapshot_dir")]
  pub snapshot_dir: Option<String>,
  /// The same folder as `snapshot_dir`, written down in the one form a
  /// sandboxed build can reopen it with. macOS only, and never the only record
  /// of the choice: `snapshot_dir` beside it always holds the readable path, so
  /// a settings file stays diagnosable by hand, means the same thing on every
  /// platform, and still points somewhere if this ever stops resolving. See
  /// `mac_bookmark`.
  #[serde(default)]
  pub snapshot_dir_bookmark: Option<String>,
  #[serde(default = "default_sticky_width")]
  pub default_sticky_width: f64,
  #[serde(default = "default_sticky_height")]
  pub default_sticky_height: f64,
  #[serde(default = "default_editor_font_size")]
  pub editor_font_size: f64,
  #[serde(default = "default_editor_word_wrap")]
  pub editor_word_wrap: bool,
  #[serde(default = "default_editor_line_numbers")]
  pub editor_line_numbers: bool,
  /// Whether to run worker-based syntax highlighting on over-threshold files.
  /// Off by default so large files stay uncolored unless the user opts in.
  #[serde(default = "default_worker_highlight")]
  pub worker_highlight: bool,
  /// How an over-threshold file opens: "ask" (default) raises a confirm offering
  /// view or edit, "view" drops straight into the read-only large-file view, and
  /// "edit" unlocks straight into in-place editing (both "ask"'s edit choice and
  /// "edit" fall back to view for a non-UTF-8 or oversized file).
  #[serde(default = "default_large_open_mode")]
  pub large_open_mode: String,
  /// Whether to ask how to open a file whose longest line is over the frontend
  /// long-line threshold (offering open-as-is / format / soft-wrap). On by
  /// default; when off such files always open as-is. serde default keeps old
  /// settings files loading.
  #[serde(default = "default_ask_long_line_open")]
  pub ask_long_line_open: bool,
  /// Whether the preview renders local images and clickable links. Off by
  /// default.
  #[serde(default = "default_preview_local_resources")]
  pub preview_local_resources: bool,
  /// How a non-project file opens from the Open dialog / menu: "tab" opens a
  /// new tab in the focused document window (default, the historical
  /// behavior), "window" opens each picked file in its own document window.
  #[serde(default = "default_open_target")]
  pub open_target: String,
  /// Document editor font family. Empty means the built-in monospace stack.
  #[serde(default)]
  pub editor_font_family: String,
  #[serde(default = "default_line_ending")]
  pub default_line_ending: String,
  #[serde(default = "default_encoding")]
  pub default_encoding: String,
  /// Remembered workspace-window bounds. x/y are None until the window has moved.
  #[serde(default)]
  pub workspace_x: Option<f64>,
  #[serde(default)]
  pub workspace_y: Option<f64>,
  #[serde(default = "default_workspace_width")]
  pub workspace_width: f64,
  #[serde(default = "default_workspace_height")]
  pub workspace_height: f64,
  /// Root folders of the project trees shown in the workspace sidebar. Empty
  /// until the user adds one; each entry is a sibling top-level node.
  #[serde(default)]
  pub project_roots: Vec<String>,
  /// Whether the system tray / status-bar icon is shown. When off the icon is
  /// hidden (the app keeps running); its actions stay reachable from the menu
  /// bar, global shortcut, and Dock menu. Cross-platform.
  #[serde(default = "default_show_tray_icon")]
  pub show_tray_icon: bool,
  /// Whether to open the workspace window automatically at startup, after the
  /// restored sticky/document windows. Off by default (unchanged behavior).
  #[serde(default = "default_open_workspace_on_startup")]
  pub open_workspace_on_startup: bool,
  /// Recently opened file paths for the File > Open Recent menu, newest first,
  /// de-duplicated and capped at `RECENT_FILES_MAX`. Empty until the first open.
  #[serde(default)]
  pub recent_files: Vec<String>,
}

/// Hard cap on how many recently opened files `recent_files` keeps. Newest
/// first; older paths past this fall off.
pub const RECENT_FILES_MAX: usize = 10;

fn default_theme() -> String {
  "ink".to_string()
}

fn default_interface_mode() -> String {
  "system".to_string()
}

fn default_language() -> String {
  "system".to_string()
}

fn default_new_note_shortcut() -> String {
  "CmdOrCtrl+Shift+N".to_string()
}

fn default_snapshot_dir() -> Option<String> {
  None
}

fn default_sticky_width() -> f64 {
  280.0
}

fn default_sticky_height() -> f64 {
  230.0
}

fn default_editor_font_size() -> f64 {
  13.0
}

fn default_editor_word_wrap() -> bool {
  true
}

fn default_editor_line_numbers() -> bool {
  true
}

fn default_worker_highlight() -> bool {
  false
}

fn default_large_open_mode() -> String {
  "ask".to_string()
}

fn default_ask_long_line_open() -> bool {
  true
}

fn default_preview_local_resources() -> bool {
  false
}

fn default_open_target() -> String {
  "tab".to_string()
}

/// Windows text tooling still expects CRLF by default; every other platform
/// treats LF as native. Split out from `default_line_ending` so the mapping is
/// testable off Windows: a `cfg!` inside the assertion would compile to the same
/// branch as the code it checks, and pass whatever the code said.
fn line_ending_for(os: &str) -> &'static str {
  if os == "windows" {
    "CRLF"
  } else {
    "LF"
  }
}

fn default_line_ending() -> String {
  line_ending_for(std::env::consts::OS).to_string()
}

fn default_encoding() -> String {
  "UTF-8".to_string()
}

fn default_show_tray_icon() -> bool {
  true
}

fn default_open_workspace_on_startup() -> bool {
  false
}

pub(crate) fn default_workspace_width() -> f64 {
  300.0
}

fn default_workspace_height() -> f64 {
  560.0
}

impl Default for AppSettings {
  fn default() -> Self {
    AppSettings {
      theme: default_theme(),
      interface_mode: default_interface_mode(),
      language: default_language(),
      new_note_shortcut: default_new_note_shortcut(),
      snapshot_dir: default_snapshot_dir(),
      snapshot_dir_bookmark: None,
      default_sticky_width: default_sticky_width(),
      default_sticky_height: default_sticky_height(),
      editor_font_size: default_editor_font_size(),
      editor_word_wrap: default_editor_word_wrap(),
      editor_line_numbers: default_editor_line_numbers(),
      worker_highlight: default_worker_highlight(),
      large_open_mode: default_large_open_mode(),
      ask_long_line_open: default_ask_long_line_open(),
      preview_local_resources: default_preview_local_resources(),
      open_target: default_open_target(),
      editor_font_family: String::new(),
      default_line_ending: default_line_ending(),
      default_encoding: default_encoding(),
      workspace_x: None,
      workspace_y: None,
      workspace_width: default_workspace_width(),
      workspace_height: default_workspace_height(),
      project_roots: Vec::new(),
      show_tray_icon: default_show_tray_icon(),
      open_workspace_on_startup: default_open_workspace_on_startup(),
      recent_files: Vec::new(),
    }
  }
}

/// Insert `path` at the front of a recent-files list: de-duplicate (an existing
/// occurrence is removed so a re-open moves it to the front), then cap the list
/// at `RECENT_FILES_MAX`. Pure so the ordering/dedupe/cap rules are unit-tested.
pub fn push_recent(current: &[String], path: &str) -> Vec<String> {
  let mut out: Vec<String> = current
    .iter()
    .filter(|p| p.as_str() != path)
    .cloned()
    .collect();
  out.insert(0, path.to_string());
  out.truncate(RECENT_FILES_MAX);
  out
}

/// Record `path` in the on-disk recent list and return the updated list. Reads,
/// updates, and writes settings; the caller repopulates the menu from the result.
/// A missing file falls back to defaults (first run); a genuine read failure on
/// an existing file aborts instead of writing defaults back over it.
pub fn push_recent_file(app: &AppHandle, path: &str) -> Result<Vec<String>, String> {
  let file = settings_path(app)?;
  let mut settings = load_or_default_for_write(&file)?;
  settings.recent_files = push_recent(&settings.recent_files, path);
  save_to(&file, &settings)?;
  Ok(settings.recent_files)
}

/// Clear the on-disk recent list. See `push_recent_file` for the read-failure
/// handling.
pub fn clear_recent_files(app: &AppHandle) -> Result<(), String> {
  let file = settings_path(app)?;
  let mut settings = load_or_default_for_write(&file)?;
  settings.recent_files.clear();
  save_to(&file, &settings)
}

/// Load settings ahead of a read-merge-write, without ever turning a genuine
/// read failure into defaults that then get written back. A missing file is
/// first run and correctly becomes defaults; any other error (I/O failure, or
/// a root that is not valid JSON / not even a JSON object, so nothing could be
/// salvaged) means the file exists but could not be read, and must abort the
/// write rather than clobber it. Kept separate from `app_settings`, whose
/// `unwrap_or_default()` is a read-only path where falling back is safe. Every
/// caller anywhere in the app that reads settings in order to mutate one field
/// and write the whole struct back — not just the callers local to this file —
/// must go through this, never `app_settings`, or a transient read failure
/// gets laundered into "defaults" and permanently overwrites the user's file.
pub fn load_or_default_for_write(path: &Path) -> Result<AppSettings, String> {
  match load_from(path) {
    Ok(settings) => Ok(settings),
    Err(e) => {
      if path.exists() {
        log::warn!(
          "settings: refusing to overwrite {} after a failed read: {e}",
          path.display()
        );
        Err(format!(
          "failed to read existing settings, not overwriting: {e}"
        ))
      } else {
        Ok(AppSettings::default())
      }
    }
  }
}

/// Reject an empty shortcut. `theme`, `language`, and `snapshot_dir` are not
/// validated here — `snapshot_dir` is an arbitrary path (or None for the
/// default) whose existence is checked separately, at the point it is applied
/// (see `note_store::apply_snapshot_dir`), not on every generic settings save.
/// Reset every stored field that would fail `validate` back to its default.
/// Applied on load, never on save: `save_settings` merges a patch over what is
/// on disk and validates the whole result, so one out-of-range stored value
/// rejects *every* later save — including saves that never touch that field —
/// and the app silently stops persisting settings altogether. A file written by
/// an older build (a real one held `large_open_mode: "null"`) or hand-edited
/// must degrade to the default, not brick the whole pane. Returns the name of
/// every field it reset, so the caller can tell the user (never on its own —
/// see `tolerant_settings`, which logs the type-mismatch case; this is the
/// out-of-range counterpart of the same silent-reset family).
fn repair(settings: &mut AppSettings) -> Vec<String> {
  let mut repaired = Vec::new();
  if settings.new_note_shortcut.trim().is_empty() {
    settings.new_note_shortcut = default_new_note_shortcut();
    repaired.push("new_note_shortcut".to_string());
  }
  if !(180.0..=4000.0).contains(&settings.default_sticky_width) {
    settings.default_sticky_width = default_sticky_width();
    repaired.push("default_sticky_width".to_string());
  }
  if !(140.0..=4000.0).contains(&settings.default_sticky_height) {
    settings.default_sticky_height = default_sticky_height();
    repaired.push("default_sticky_height".to_string());
  }
  if !(260.0..=4000.0).contains(&settings.workspace_width) {
    settings.workspace_width = default_workspace_width();
    repaired.push("workspace_width".to_string());
  }
  if !(320.0..=4000.0).contains(&settings.workspace_height) {
    settings.workspace_height = default_workspace_height();
    repaired.push("workspace_height".to_string());
  }
  if !(9.0..=32.0).contains(&settings.editor_font_size) {
    settings.editor_font_size = default_editor_font_size();
    repaired.push("editor_font_size".to_string());
  }
  if !matches!(settings.default_line_ending.as_str(), "LF" | "CRLF") {
    settings.default_line_ending = default_line_ending();
    repaired.push("default_line_ending".to_string());
  }
  if !matches!(settings.large_open_mode.as_str(), "ask" | "view" | "edit") {
    settings.large_open_mode = default_large_open_mode();
    repaired.push("large_open_mode".to_string());
  }
  if !matches!(settings.open_target.as_str(), "tab" | "window") {
    settings.open_target = default_open_target();
    repaired.push("open_target".to_string());
  }
  if !crate::encoding::is_supported_label(&settings.default_encoding) {
    settings.default_encoding = default_encoding();
    repaired.push("default_encoding".to_string());
  }
  repaired
}

fn validate(settings: &AppSettings) -> Result<(), String> {
  if settings.new_note_shortcut.trim().is_empty() {
    return Err("new_note_shortcut must not be empty".to_string());
  }
  // Matches the sticky window's min size and a sane upper bound.
  if !(180.0..=4000.0).contains(&settings.default_sticky_width)
    || !(140.0..=4000.0).contains(&settings.default_sticky_height)
  {
    return Err("default sticky size out of range".to_string());
  }
  // Matches the workspace window's min size and a sane upper bound.
  if !(260.0..=4000.0).contains(&settings.workspace_width)
    || !(320.0..=4000.0).contains(&settings.workspace_height)
  {
    return Err("workspace size out of range".to_string());
  }
  if !(9.0..=32.0).contains(&settings.editor_font_size) {
    return Err("editor font size out of range".to_string());
  }
  match settings.default_line_ending.as_str() {
    "LF" | "CRLF" => {}
    other => return Err(format!("unknown line ending: {other}")),
  }
  match settings.large_open_mode.as_str() {
    "ask" | "view" | "edit" => {}
    other => return Err(format!("unknown large open mode: {other}")),
  }
  match settings.open_target.as_str() {
    "tab" | "window" => {}
    other => return Err(format!("unknown open target: {other}")),
  }
  if !crate::encoding::is_supported_label(&settings.default_encoding) {
    return Err(format!(
      "unknown default encoding: {}",
      settings.default_encoding
    ));
  }
  Ok(())
}

/// Merge a partial JSON patch over current settings, so callers can update one
/// field without clobbering the others (validated as a whole after merging).
pub fn merge_settings(
  current: &AppSettings,
  patch: &serde_json::Value,
) -> Result<AppSettings, String> {
  let mut merged = serde_json::to_value(current).map_err(|e| e.to_string())?;
  let (Some(obj), Some(patch_obj)) = (merged.as_object_mut(), patch.as_object()) else {
    return Err("settings patch must be a JSON object".to_string());
  };
  // A null patch value means "leave this field untouched"; every other value
  // replaces the field (patching `project_roots` replaces the whole array).
  for (key, value) in patch_obj {
    if value.is_null() {
      continue;
    }
    obj.insert(key.clone(), value.clone());
  }
  serde_json::from_value(merged).map_err(|e| e.to_string())
}

/// Seed `project_roots` from the legacy single `project_root` string when the
/// newer array field is absent. A non-empty legacy root becomes the sole entry;
/// an empty/missing legacy root leaves `project_roots` to its default (empty).
fn migrate_legacy_project_root(value: &mut serde_json::Value) {
  let Some(obj) = value.as_object_mut() else {
    return;
  };
  if obj.contains_key("project_roots") {
    return;
  }
  let legacy = obj
    .get("project_root")
    .and_then(|v| v.as_str())
    .unwrap_or("");
  if !legacy.trim().is_empty() {
    obj.insert(
      "project_roots".into(),
      serde_json::Value::Array(vec![serde_json::Value::String(legacy.to_string())]),
    );
  }
}

/// Fold the retired `ask_before_large_open` bool into the unified `large_open_mode`.
/// The two settings used to overlap; now a single mode carries the choice:
/// ask=true means "ask" regardless of the stored mode, ask=false keeps the stored
/// view/edit mode (defaulting to the old "view" when none was stored). The legacy
/// key is dropped so it never lingers in the on-disk file.
fn migrate_legacy_ask_before_large_open(value: &mut serde_json::Value) {
  let Some(obj) = value.as_object_mut() else {
    return;
  };
  let Some(ask) = obj.get("ask_before_large_open").and_then(|v| v.as_bool()) else {
    return;
  };
  if ask {
    obj.insert(
      "large_open_mode".into(),
      serde_json::Value::String("ask".into()),
    );
  } else if !obj.contains_key("large_open_mode") {
    obj.insert(
      "large_open_mode".into(),
      serde_json::Value::String("view".into()),
    );
  }
  obj.remove("ask_before_large_open");
}

/// Read one field out of a settings JSON object: missing is the normal
/// "older file predates this field" case and gets the default silently, but a
/// *present* value that fails to deserialize into its field type (wrong JSON
/// type, not merely an out-of-range value — `repair` handles those) is
/// recorded in `dropped` by field name and replaced with the default, instead
/// of failing the whole file.
fn field_or_default<T: serde::de::DeserializeOwned>(
  obj: &serde_json::Map<String, serde_json::Value>,
  key: &str,
  default: impl FnOnce() -> T,
  dropped: &mut Vec<String>,
) -> T {
  match obj.get(key) {
    None => default(),
    Some(value) => match serde_json::from_value(value.clone()) {
      Ok(parsed) => parsed,
      Err(_) => {
        dropped.push(key.to_string());
        default()
      }
    },
  }
}

/// Rebuild `AppSettings` field by field from a settings JSON object, so one
/// field with the wrong JSON *type* costs only that field instead of the
/// whole file (the fast strict-parse path in `load_from` already covers the
/// common case where every field is well-typed). Every dropped field name is
/// logged and returned, since a silent reset is what made this bug invisible.
fn tolerant_settings(
  obj: &serde_json::Map<String, serde_json::Value>,
) -> (AppSettings, Vec<String>) {
  let mut dropped = Vec::new();
  let settings = AppSettings {
    theme: field_or_default(obj, "theme", default_theme, &mut dropped),
    interface_mode: field_or_default(obj, "interface_mode", default_interface_mode, &mut dropped),
    language: field_or_default(obj, "language", default_language, &mut dropped),
    new_note_shortcut: field_or_default(
      obj,
      "new_note_shortcut",
      default_new_note_shortcut,
      &mut dropped,
    ),
    snapshot_dir: field_or_default(obj, "snapshot_dir", default_snapshot_dir, &mut dropped),
    snapshot_dir_bookmark: field_or_default(obj, "snapshot_dir_bookmark", || None, &mut dropped),
    default_sticky_width: field_or_default(
      obj,
      "default_sticky_width",
      default_sticky_width,
      &mut dropped,
    ),
    default_sticky_height: field_or_default(
      obj,
      "default_sticky_height",
      default_sticky_height,
      &mut dropped,
    ),
    editor_font_size: field_or_default(
      obj,
      "editor_font_size",
      default_editor_font_size,
      &mut dropped,
    ),
    editor_word_wrap: field_or_default(
      obj,
      "editor_word_wrap",
      default_editor_word_wrap,
      &mut dropped,
    ),
    editor_line_numbers: field_or_default(
      obj,
      "editor_line_numbers",
      default_editor_line_numbers,
      &mut dropped,
    ),
    worker_highlight: field_or_default(
      obj,
      "worker_highlight",
      default_worker_highlight,
      &mut dropped,
    ),
    large_open_mode: field_or_default(
      obj,
      "large_open_mode",
      default_large_open_mode,
      &mut dropped,
    ),
    ask_long_line_open: field_or_default(
      obj,
      "ask_long_line_open",
      default_ask_long_line_open,
      &mut dropped,
    ),
    preview_local_resources: field_or_default(
      obj,
      "preview_local_resources",
      default_preview_local_resources,
      &mut dropped,
    ),
    open_target: field_or_default(obj, "open_target", default_open_target, &mut dropped),
    editor_font_family: field_or_default(obj, "editor_font_family", String::new, &mut dropped),
    default_line_ending: field_or_default(
      obj,
      "default_line_ending",
      default_line_ending,
      &mut dropped,
    ),
    default_encoding: field_or_default(obj, "default_encoding", default_encoding, &mut dropped),
    workspace_x: field_or_default(obj, "workspace_x", || None, &mut dropped),
    workspace_y: field_or_default(obj, "workspace_y", || None, &mut dropped),
    workspace_width: field_or_default(
      obj,
      "workspace_width",
      default_workspace_width,
      &mut dropped,
    ),
    workspace_height: field_or_default(
      obj,
      "workspace_height",
      default_workspace_height,
      &mut dropped,
    ),
    project_roots: field_or_default(obj, "project_roots", Vec::new, &mut dropped),
    show_tray_icon: field_or_default(obj, "show_tray_icon", default_show_tray_icon, &mut dropped),
    open_workspace_on_startup: field_or_default(
      obj,
      "open_workspace_on_startup",
      default_open_workspace_on_startup,
      &mut dropped,
    ),
    recent_files: field_or_default(obj, "recent_files", Vec::new, &mut dropped),
  };
  if !dropped.is_empty() {
    log::warn!(
      "settings: field(s) had the wrong type and were reset to their default: {}",
      dropped.join(", ")
    );
  }
  (settings, dropped)
}

/// Read settings from a JSON file. Missing file returns defaults. A legacy
/// single `project_root` is migrated into `project_roots`, and a legacy
/// `ask_before_large_open` bool is folded into `large_open_mode`, before
/// deserialization. One field with the wrong JSON type costs only that field:
/// the strict parse below is tried first (the common, fully-valid case), and
/// only on failure does `tolerant_settings` rebuild the struct field by field
/// so every other field survives. A file that is not valid JSON at all (or
/// whose root is not even a JSON object) has no fields to salvage and still
/// errors.
pub fn load_from(path: &Path) -> Result<AppSettings, String> {
  load_from_with_report(path).map(|(settings, _)| settings)
}

/// Same as `load_from`, but also returns the name of every field that was
/// silently repaired (wrong JSON type, dropped by `tolerant_settings`; or an
/// out-of-range value, reset by `repair`) so a caller that can reach the user
/// — the `load_settings` command — can tell them, instead of the repair
/// happening invisibly and the repaired value getting written back over
/// their file as if it were what they had.
pub fn load_from_with_report(path: &Path) -> Result<(AppSettings, Vec<String>), String> {
  match std::fs::read_to_string(path) {
    Ok(text) => {
      let mut value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
      migrate_legacy_project_root(&mut value);
      migrate_legacy_ask_before_large_open(&mut value);
      let (mut settings, mut repaired) = match serde_json::from_value(value.clone()) {
        Ok(settings) => (settings, Vec::new()),
        Err(_) => {
          let obj = value
            .as_object()
            .ok_or_else(|| "settings file root is not a JSON object".to_string())?;
          tolerant_settings(obj)
        }
      };
      repaired.extend(repair(&mut settings));
      Ok((settings, repaired))
    }
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((AppSettings::default(), Vec::new())),
    Err(e) => Err(e.to_string()),
  }
}

/// Validate then serialize settings to JSON and atomically write them to `path`.
pub fn save_to(path: &Path, settings: &AppSettings) -> Result<(), String> {
  validate(settings)?;
  let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
  write_text_atomic(path, &json)
}

pub fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(dir.join("settings.json"))
}

/// Load settings for backend use, falling back to defaults on any error. Pure
/// read path with nothing written back, so a failed read degrading to
/// defaults here is survivable (unlike `load_or_default_for_write`, used
/// ahead of a save, where the same fallback would get defaults written back
/// over the user's file) — and after the tolerant per-field load in
/// `load_from`, this fallback is rarely reached at all.
pub fn app_settings(app: &AppHandle) -> AppSettings {
  settings_path(app)
    .and_then(|p| load_from(&p))
    .unwrap_or_default()
}

/// Settings payload returned to the frontend by `load_settings`, alongside the
/// name of every field that was silently repaired on this load (empty when
/// none were) — see `load_from_with_report`.
#[derive(Debug, Clone, Serialize)]
pub struct LoadedSettings {
  pub settings: AppSettings,
  pub repaired_fields: Vec<String>,
  /// The chosen snapshot folder could not be used on this launch and the
  /// default one is in use instead. The setting itself is left alone, so the
  /// chosen folder is used again as soon as it works.
  pub snapshot_dir_unavailable: bool,
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<LoadedSettings, String> {
  let (settings, repaired_fields) = load_from_with_report(&settings_path(&app)?)?;
  Ok(LoadedSettings {
    settings,
    repaired_fields,
    snapshot_dir_unavailable: app
      .try_state::<crate::note_store::SnapshotFallback>()
      .is_some_and(|state| state.in_use()),
  })
}

/// Whether a settings save changed the UI language preference, so the native
/// menus (which the WebView never re-renders) must be rebuilt in the new locale.
/// Compares the stored preference verbatim: switching between two values that
/// resolve to the same locale still triggers a harmless rebuild.
pub fn language_changed(old: &str, new: &str) -> bool {
  old != new
}

/// Serializes the read-merge-write section of `save_settings` below. Plain
/// commands used to get this for free (Tauri runs them one at a time on the
/// main thread), but `save_settings` is now `(async)` (see its doc comment),
/// so two overlapping calls — e.g. two rapid stepper clicks, neither awaited
/// by its caller — would otherwise both read the same `current`, merge their
/// own patch on top of it, and write back independently: whichever finishes
/// last wins outright, silently discarding the other call's fields instead of
/// merging both. The lock turns that back into the one-at-a-time sequence the
/// merge logic already assumes.
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Off the UI thread: `settings_path` reads the app-data dir and the
/// load/merge/write below round-trips the whole settings file. The write
/// itself only ever touches `crate::fs_ops` and this module's own file I/O, so
/// it is safe to run off-main — but the side effects that follow it are not:
/// `rebuild_menus` builds and installs a native `Menu`/tray menu,
/// `retitle_fixed_windows`/`retitle_sticky_windows` set native window titles,
/// `set_tray_visible` toggles the tray icon, and `reapply_focus_menu` mutates
/// menu-item state — all of these are AppKit/GTK/Win32 UI object calls that
/// must run on the platform main thread, so they are queued there with
/// `run_on_main_thread` instead of running on this command's worker thread.
#[tauri::command(async)]
pub fn save_settings(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
  let path = settings_path(&app)?;
  let (current, merged) = {
    let _guard = SETTINGS_WRITE_LOCK.lock().unwrap();
    // Never `unwrap_or_default` here: this reads settings only to merge a patch
    // and write the whole struct back, so a read failure must abort instead of
    // being laundered into defaults that then overwrite the user's real file.
    let current = load_or_default_for_write(&path)?;
    let mut merged = merge_settings(&current, &settings)?;
    // Normalize the free-form font family (empty allowed, no allow-list).
    merged.editor_font_family = merged.editor_font_family.trim().to_string();
    save_to(&path, &merged)?;
    (current, merged)
  };
  let app_for_main = app.clone();
  if let Err(e) = app.run_on_main_thread(move || {
    // Rebuild the native menus when the UI language changed; the WebView
    // reacts to `settings-changed` on its own, but the app/tray/context menus
    // are Rust.
    if language_changed(&current.language, &merged.language) {
      let locale = crate::i18n::current_locale(&merged.language);
      crate::rebuild_menus(&app_for_main, locale);
      // The fixed-title singleton windows (workspace/settings/about) are
      // titled by the Rust side, so they must be retitled here too.
      crate::windows::retitle_fixed_windows(&app_for_main, locale);
      // Same freeze for an already-open sticky: its title bar was set once at
      // creation (`create_sticky_window`) and otherwise never touched again.
      // Document windows are not swept here — their title follows the active
      // tab's file name and is owned by the frontend.
      crate::windows::retitle_sticky_windows(&app_for_main, locale);
    }
    // Show or hide the tray/status-bar icon when the preference changed.
    if current.show_tray_icon != merged.show_tray_icon {
      crate::set_tray_visible(&app_for_main, merged.show_tray_icon);
    }
    // Broadcast the merged settings so every open window applies changes live.
    let _ = app_for_main.emit("settings-changed", &merged);
    // The Format/View menu checks (word wrap, line numbers) mirror these
    // settings, so re-apply the focused window's menu state after any save.
    crate::reapply_focus_menu(&app_for_main);
  }) {
    log::warn!("save_settings: could not reach the main thread: {e}");
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  /// Deserialize a settings JSON string through the same legacy migration path
  /// that `load_from` applies to on-disk files.
  fn load_json(text: &str) -> AppSettings {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, text).unwrap();
    load_from(&path).unwrap()
  }

  /// A value outside its allowed set must not survive the load. Left alone it
  /// poisons every future save, because `save_settings` validates the whole
  /// merged object and a patch that never mentions the field still fails.
  #[test]
  fn an_out_of_range_stored_value_is_repaired_on_load() {
    let settings = load_json(
      r#"{"large_open_mode": "null", "default_line_ending": "CR", "open_target": "pane", "editor_font_size": 900.0, "default_encoding": "NOPE"}"#,
    );
    assert_eq!(settings.large_open_mode, "ask");
    assert_eq!(settings.default_line_ending, default_line_ending());
    assert_eq!(settings.open_target, "tab");
    assert_eq!(settings.editor_font_size, default_editor_font_size());
    assert_eq!(settings.default_encoding, "UTF-8");
  }

  /// The report is what lets the frontend tell the user a repair happened —
  /// without it the reset is exactly as invisible as before this fix.
  #[test]
  fn a_repaired_field_is_reported_not_just_defaulted() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(
      &path,
      r#"{"large_open_mode": "null", "editor_font_size": "not a number"}"#,
    )
    .unwrap();
    let (settings, repaired) = load_from_with_report(&path).unwrap();
    assert_eq!(settings.large_open_mode, "ask");
    assert_eq!(settings.editor_font_size, default_editor_font_size());
    // One field failed type deserialization (tolerant_settings), the other
    // was well-typed but out of the allowed set (repair) — both must show up.
    assert!(repaired.contains(&"large_open_mode".to_string()));
    assert!(repaired.contains(&"editor_font_size".to_string()));
  }

  /// A fully valid file reports nothing repaired.
  #[test]
  fn a_valid_file_reports_no_repairs() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "{}").unwrap();
    let (_, repaired) = load_from_with_report(&path).unwrap();
    assert!(repaired.is_empty());
  }

  /// `app_settings` may fall back to defaults on a read failure (it never
  /// writes), but `load_or_default_for_write` — the path every mutate-one-field
  /// caller must use — must refuse instead, or the caller would write those
  /// defaults back over the user's real file.
  #[test]
  fn load_or_default_for_write_refuses_to_launder_a_read_failure_into_defaults() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    // Not valid JSON: an existing, unreadable-as-settings file.
    std::fs::write(&path, "{ this is not json").unwrap();
    let result = load_or_default_for_write(&path);
    assert!(result.is_err());
    // The file on disk must be untouched — no defaults written back.
    let on_disk = std::fs::read_to_string(&path).unwrap();
    assert_eq!(on_disk, "{ this is not json");
  }

  #[test]
  fn a_repaired_file_can_be_saved_again() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, r#"{"large_open_mode": "null"}"#).unwrap();
    let loaded = load_from(&path).unwrap();
    // Before the repair this failed with "unknown large open mode: null",
    // which is what silently froze the whole settings pane.
    save_to(&path, &loaded).unwrap();
  }

  #[test]
  fn repair_leaves_a_valid_file_alone() {
    let settings = load_json(
      r#"{"large_open_mode": "view", "default_line_ending": "CRLF", "open_target": "window", "default_encoding": "Big5"}"#,
    );
    assert_eq!(settings.large_open_mode, "view");
    assert_eq!(settings.default_line_ending, "CRLF");
    assert_eq!(settings.open_target, "window");
    assert_eq!(settings.default_encoding, "Big5");
  }

  #[test]
  fn save_load_roundtrip() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = AppSettings {
      theme: "voyage".into(),
      interface_mode: "dark".into(),
      language: "ja".into(),
      new_note_shortcut: "CmdOrCtrl+Alt+M".into(),
      snapshot_dir: Some("/Volumes/Cloud/Note&Pad".into()),
      snapshot_dir_bookmark: Some("Ym9va21hcms=".into()),
      default_sticky_width: 491.0,
      default_sticky_height: 353.0,
      editor_font_size: 16.0,
      editor_word_wrap: false,
      editor_line_numbers: false,
      worker_highlight: true,
      large_open_mode: "edit".into(),
      ask_long_line_open: false,
      preview_local_resources: true,
      open_target: "window".into(),
      editor_font_family: "Menlo".into(),
      default_line_ending: "CRLF".into(),
      default_encoding: "Big5".into(),
      workspace_x: Some(40.0),
      workspace_y: Some(60.0),
      workspace_width: 320.0,
      workspace_height: 600.0,
      project_roots: vec!["/tmp/project".into(), "/tmp/other".into()],
      show_tray_icon: false,
      open_workspace_on_startup: true,
      recent_files: vec!["/tmp/a.txt".into(), "/tmp/b.txt".into()],
    };
    save_to(&path, &settings).unwrap();
    assert_eq!(load_from(&path).unwrap(), settings);
  }

  #[test]
  fn legacy_json_defaults_workspace_bounds() {
    let legacy = r#"{"theme":"dark"}"#;
    let settings: AppSettings = serde_json::from_str(legacy).unwrap();
    assert_eq!(settings.workspace_x, None);
    assert_eq!(settings.workspace_y, None);
    assert_eq!(settings.workspace_width, 300.0);
    assert_eq!(settings.workspace_height, 560.0);
  }

  #[test]
  fn save_rejects_out_of_range_workspace_size() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let too_narrow = AppSettings {
      workspace_width: 100.0,
      ..AppSettings::default()
    };
    assert!(save_to(&path, &too_narrow).is_err());
    let too_short = AppSettings {
      workspace_height: 100.0,
      ..AppSettings::default()
    };
    assert!(save_to(&path, &too_short).is_err());
  }

  #[test]
  fn merge_patches_workspace_bounds_only() {
    let current = AppSettings::default();
    let patch = serde_json::json!({
        "workspace_x": 12.0,
        "workspace_y": 34.0,
        "workspace_width": 400.0,
        "workspace_height": 700.0,
    });
    let merged = merge_settings(&current, &patch).unwrap();
    assert_eq!(merged.workspace_x, Some(12.0));
    assert_eq!(merged.workspace_y, Some(34.0));
    assert_eq!(merged.workspace_width, 400.0);
    assert_eq!(merged.workspace_height, 700.0);
    // Unpatched fields survive.
    assert_eq!(merged.theme, "ink");
  }

  #[test]
  fn merge_replaces_and_clears_project_roots() {
    let current = AppSettings::default();
    assert!(current.project_roots.is_empty());
    let set = merge_settings(
      &current,
      &serde_json::json!({ "project_roots": ["/tmp/a", "/tmp/b"] }),
    )
    .unwrap();
    assert_eq!(set.project_roots, vec!["/tmp/a", "/tmp/b"]);
    // Patching replaces the whole array, not a merge/append.
    let replaced =
      merge_settings(&set, &serde_json::json!({ "project_roots": ["/tmp/c"] })).unwrap();
    assert_eq!(replaced.project_roots, vec!["/tmp/c"]);
    // An empty array clears every project.
    let cleared = merge_settings(&set, &serde_json::json!({ "project_roots": [] })).unwrap();
    assert!(cleared.project_roots.is_empty());
    // A null patch leaves the field untouched.
    let untouched = merge_settings(&set, &serde_json::json!({ "project_roots": null })).unwrap();
    assert_eq!(untouched.project_roots, vec!["/tmp/a", "/tmp/b"]);
  }

  #[test]
  fn legacy_json_defaults_project_roots_to_empty() {
    let legacy = r#"{"theme":"dark"}"#;
    let settings = load_json(legacy);
    assert!(settings.project_roots.is_empty());
  }

  #[test]
  fn interface_mode_defaults_to_system_and_round_trips() {
    // Default and any settings file predating the field follow the system.
    assert_eq!(AppSettings::default().interface_mode, "system");
    assert_eq!(load_json(r#"{"theme":"ink"}"#).interface_mode, "system");
    // A patch replaces it verbatim (validation is the frontend's job).
    let set = merge_settings(
      &AppSettings::default(),
      &serde_json::json!({ "interface_mode": "dark" }),
    )
    .unwrap();
    assert_eq!(set.interface_mode, "dark");
  }

  #[test]
  fn legacy_project_root_string_seeds_project_roots() {
    // An older settings file carries a single `project_root` string.
    let legacy = r#"{"theme":"dark","project_root":"/tmp/legacy"}"#;
    let settings = load_json(legacy);
    assert_eq!(settings.project_roots, vec!["/tmp/legacy"]);
  }

  #[test]
  fn legacy_empty_project_root_seeds_nothing() {
    let legacy = r#"{"theme":"dark","project_root":""}"#;
    let settings = load_json(legacy);
    assert!(settings.project_roots.is_empty());
  }

  #[test]
  fn explicit_project_roots_wins_over_legacy_field() {
    // When both fields are present, the array is authoritative; the legacy
    // scalar is ignored rather than overwriting it.
    let json = r#"{"project_root":"/tmp/old","project_roots":["/tmp/new"]}"#;
    let settings = load_json(json);
    assert_eq!(settings.project_roots, vec!["/tmp/new"]);
  }

  #[test]
  fn legacy_json_defaults_sticky_size() {
    let legacy = r#"{"theme":"dark"}"#;
    let settings: AppSettings = serde_json::from_str(legacy).unwrap();
    assert_eq!(settings.default_sticky_width, 280.0);
    assert_eq!(settings.default_sticky_height, 230.0);
  }

  #[test]
  fn save_rejects_out_of_range_sticky_size() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = AppSettings {
      default_sticky_width: 10.0,
      ..AppSettings::default()
    };
    assert!(save_to(&path, &settings).is_err());
  }

  #[test]
  fn merge_patch_keeps_unpatched_fields() {
    let current = AppSettings {
      theme: "dark".into(),
      snapshot_dir: Some("/Volumes/Cloud/Note&Pad".into()),
      ..AppSettings::default()
    };
    let patch = serde_json::json!({ "theme": "light" });
    let merged = merge_settings(&current, &patch).unwrap();
    assert_eq!(merged.theme, "light");
    assert_eq!(
      merged.snapshot_dir,
      Some("/Volumes/Cloud/Note&Pad".to_string())
    );
  }

  #[test]
  fn merge_rejects_non_object_patch() {
    assert!(merge_settings(&AppSettings::default(), &serde_json::json!("dark")).is_err());
  }

  #[test]
  fn load_missing_returns_default_theme() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("does-not-exist.json");
    let loaded = load_from(&path).unwrap();
    assert_eq!(loaded.theme, "ink");
    assert_eq!(loaded.new_note_shortcut, "CmdOrCtrl+Shift+N");
  }

  #[test]
  fn legacy_json_without_shortcut_defaults() {
    let legacy = r#"{"theme":"dark"}"#;
    let settings: AppSettings = serde_json::from_str(legacy).unwrap();
    assert_eq!(settings.new_note_shortcut, "CmdOrCtrl+Shift+N");
    assert_eq!(settings.snapshot_dir, None);
  }

  #[test]
  fn legacy_json_defaults_language_to_system() {
    let legacy = r#"{"theme":"dark"}"#;
    let settings: AppSettings = serde_json::from_str(legacy).unwrap();
    assert_eq!(settings.language, "system");
  }

  #[test]
  fn language_change_detected() {
    // A different stored preference triggers a native-menu rebuild.
    assert!(language_changed("system", "ja"));
    assert!(language_changed("en", "zh-TW"));
    // An identical preference does not.
    assert!(!language_changed("system", "system"));
    assert!(!language_changed("ja", "ja"));
  }

  #[test]
  fn merge_patches_language() {
    let current = AppSettings::default();
    assert_eq!(current.language, "system");
    let merged = merge_settings(&current, &serde_json::json!({ "language": "zh-TW" })).unwrap();
    assert_eq!(merged.language, "zh-TW");
    // Unpatched fields survive.
    assert_eq!(merged.theme, "ink");
  }

  #[test]
  fn save_accepts_supported_languages() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    for language in [
      "system", "zh-TW", "zh-CN", "ja", "en", "ru", "es", "pt-BR", "de", "fr", "ko", "pl", "tr",
      "it", "th", "vi",
    ] {
      let settings = AppSettings {
        language: language.into(),
        ..AppSettings::default()
      };
      assert!(save_to(&path, &settings).is_ok());
    }
  }

  #[test]
  fn save_accepts_any_language() {
    // Pure-data locales make the language id open-ended (a third-party import
    // has an arbitrary id); like `theme`, an unrecognized value must not fail
    // the save — the frontend resolves an unavailable id to a fallback on load.
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = AppSettings {
      language: "pirate".into(),
      ..AppSettings::default()
    };
    save_to(&path, &settings).unwrap();
    assert_eq!(load_from(&path).unwrap().language, "pirate");
  }

  #[test]
  fn save_accepts_any_theme_value() {
    // Not validated (see the field doc comment): an id the frontend doesn't
    // recognize yet, or a legacy mode string, must not fail the save —
    // the frontend detects and replaces it on load, Rust just stores it.
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = AppSettings {
      theme: "not-a-real-theme-yet".into(),
      ..AppSettings::default()
    };
    save_to(&path, &settings).unwrap();
    assert_eq!(load_from(&path).unwrap().theme, "not-a-real-theme-yet");
  }

  #[test]
  fn legacy_json_defaults_workspace_entry_fields() {
    // A settings file predating these entry-point fields loads with the tray
    // icon shown and the workspace not auto-opened (unchanged behavior).
    let legacy = r#"{"theme":"dark"}"#;
    let settings = load_json(legacy);
    assert!(settings.show_tray_icon);
    assert!(!settings.open_workspace_on_startup);
  }

  #[test]
  fn merge_patches_workspace_entry_fields() {
    let current = AppSettings::default();
    assert!(current.show_tray_icon);
    assert!(!current.open_workspace_on_startup);
    let merged = merge_settings(
      &current,
      &serde_json::json!({ "show_tray_icon": false, "open_workspace_on_startup": true }),
    )
    .unwrap();
    assert!(!merged.show_tray_icon);
    assert!(merged.open_workspace_on_startup);
    // Unpatched fields survive.
    assert_eq!(merged.theme, "ink");
  }

  #[test]
  fn legacy_json_defaults_editor_fields() {
    let legacy = r#"{"theme":"dark"}"#;
    let settings: AppSettings = serde_json::from_str(legacy).unwrap();
    assert_eq!(settings.editor_font_size, 13.0);
    assert!(settings.editor_word_wrap);
    assert!(settings.editor_line_numbers);
    assert_eq!(settings.editor_font_family, "");
    assert_eq!(settings.default_line_ending, default_line_ending());
    assert_eq!(settings.default_encoding, "UTF-8");
    // A settings file predating worker highlighting defaults to off.
    assert!(!settings.worker_highlight);
    // A settings file predating the large-open-mode setting defaults to ask.
    assert_eq!(settings.large_open_mode, "ask");
    // A settings file predating the long-line ask setting defaults to on.
    assert!(settings.ask_long_line_open);
    // A settings file predating the open-target setting defaults to tab.
    assert_eq!(settings.open_target, "tab");
  }

  #[test]
  fn merge_patches_ask_long_line_open() {
    let current = AppSettings::default();
    assert!(current.ask_long_line_open);
    let merged = merge_settings(
      &current,
      &serde_json::json!({ "ask_long_line_open": false }),
    )
    .unwrap();
    assert!(!merged.ask_long_line_open);
    // Unpatched fields survive.
    assert_eq!(merged.theme, "ink");
  }

  #[test]
  fn merge_patches_preview_local_resources() {
    let current = AppSettings::default();
    assert!(!current.preview_local_resources);
    let merged = merge_settings(
      &current,
      &serde_json::json!({ "preview_local_resources": true }),
    )
    .unwrap();
    assert!(merged.preview_local_resources);
    // Unpatched fields survive.
    assert_eq!(merged.theme, "ink");
  }

  #[test]
  fn merge_patches_open_target() {
    let current = AppSettings::default();
    assert_eq!(current.open_target, "tab");
    let merged = merge_settings(&current, &serde_json::json!({ "open_target": "window" })).unwrap();
    assert_eq!(merged.open_target, "window");
    // Unpatched fields survive.
    assert_eq!(merged.theme, "ink");
  }

  #[test]
  fn save_rejects_unknown_open_target() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = AppSettings {
      open_target: "split".into(),
      ..AppSettings::default()
    };
    assert!(save_to(&path, &settings).is_err());
  }

  #[test]
  fn merge_patches_large_open_mode() {
    let current = AppSettings::default();
    assert_eq!(current.large_open_mode, "ask");
    let merged =
      merge_settings(&current, &serde_json::json!({ "large_open_mode": "edit" })).unwrap();
    assert_eq!(merged.large_open_mode, "edit");
    // Unpatched fields survive.
    assert_eq!(merged.theme, "ink");
  }

  #[test]
  fn legacy_ask_before_large_open_folds_into_mode() {
    // The four (ask_before_large_open, large_open_mode) combinations a
    // pre-merge settings file could hold, plus the ask-only file that never
    // stored a mode. `load_from` applies the migration; the retired key is dropped.
    // ask=true wins over any stored mode -> "ask".
    assert_eq!(
      load_json(r#"{"ask_before_large_open":true,"large_open_mode":"view"}"#).large_open_mode,
      "ask"
    );
    assert_eq!(
      load_json(r#"{"ask_before_large_open":true,"large_open_mode":"edit"}"#).large_open_mode,
      "ask"
    );
    // ask=false keeps the stored view/edit mode.
    assert_eq!(
      load_json(r#"{"ask_before_large_open":false,"large_open_mode":"view"}"#).large_open_mode,
      "view"
    );
    assert_eq!(
      load_json(r#"{"ask_before_large_open":false,"large_open_mode":"edit"}"#).large_open_mode,
      "edit"
    );
    // ask=false with no stored mode falls back to the old "view" default.
    assert_eq!(
      load_json(r#"{"ask_before_large_open":false}"#).large_open_mode,
      "view"
    );
    // ask=true with no stored mode -> "ask".
    assert_eq!(
      load_json(r#"{"ask_before_large_open":true}"#).large_open_mode,
      "ask"
    );
  }

  #[test]
  fn save_rejects_unknown_large_open_mode() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = AppSettings {
      large_open_mode: "hybrid".into(),
      ..AppSettings::default()
    };
    assert!(save_to(&path, &settings).is_err());
  }

  #[test]
  fn merge_patches_worker_highlight() {
    let current = AppSettings::default();
    assert!(!current.worker_highlight);
    let merged =
      merge_settings(&current, &serde_json::json!({ "worker_highlight": true })).unwrap();
    assert!(merged.worker_highlight);
    // Unpatched fields survive.
    assert_eq!(merged.theme, "ink");
  }

  #[test]
  fn save_rejects_out_of_range_font_size() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let too_small = AppSettings {
      editor_font_size: 8.0,
      ..AppSettings::default()
    };
    assert!(save_to(&path, &too_small).is_err());
    let too_big = AppSettings {
      editor_font_size: 33.0,
      ..AppSettings::default()
    };
    assert!(save_to(&path, &too_big).is_err());
  }

  #[test]
  fn save_accepts_font_size_bounds() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    for size in [9.0, 32.0] {
      let s = AppSettings {
        editor_font_size: size,
        ..AppSettings::default()
      };
      assert!(save_to(&path, &s).is_ok());
    }
  }

  #[test]
  fn merge_patches_editor_font_family() {
    let current = AppSettings::default();
    assert_eq!(current.editor_font_family, "");
    let merged = merge_settings(
      &current,
      &serde_json::json!({ "editor_font_family": "JetBrains Mono" }),
    )
    .unwrap();
    assert_eq!(merged.editor_font_family, "JetBrains Mono");
    // Unpatched fields survive.
    assert_eq!(merged.theme, "ink");
  }

  #[test]
  fn save_accepts_any_font_family() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = AppSettings {
      editor_font_family: "Some Arbitrary Face".into(),
      ..AppSettings::default()
    };
    assert!(save_to(&path, &settings).is_ok());
    assert_eq!(
      load_from(&path).unwrap().editor_font_family,
      "Some Arbitrary Face"
    );
  }

  #[test]
  fn only_windows_defaults_to_crlf() {
    assert_eq!(line_ending_for("windows"), "CRLF");
    for os in ["macos", "linux", "freebsd", ""] {
      assert_eq!(line_ending_for(os), "LF", "{os} should default to LF");
    }
  }

  #[test]
  fn the_default_is_whatever_this_platform_maps_to() {
    assert_eq!(default_line_ending(), line_ending_for(std::env::consts::OS));
  }

  #[test]
  fn save_rejects_unknown_line_ending() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = AppSettings {
      default_line_ending: "CR".into(),
      ..AppSettings::default()
    };
    assert!(save_to(&path, &settings).is_err());
  }

  #[test]
  fn save_rejects_unknown_default_encoding() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = AppSettings {
      default_encoding: "EBCDIC".into(),
      ..AppSettings::default()
    };
    assert!(save_to(&path, &settings).is_err());
  }

  #[test]
  fn recent_files_default_empty_and_roundtrip() {
    let legacy = r#"{"theme":"dark"}"#;
    assert!(load_json(legacy).recent_files.is_empty());
  }

  #[test]
  fn push_recent_prepends_newest_first() {
    let list = push_recent(&[], "/a");
    assert_eq!(list, vec!["/a"]);
    let list = push_recent(&list, "/b");
    assert_eq!(list, vec!["/b", "/a"]);
  }

  #[test]
  fn push_recent_dedupes_moving_to_front() {
    let list = vec!["/a".to_string(), "/b".to_string(), "/c".to_string()];
    // Re-opening /c moves it to the front without duplicating it.
    assert_eq!(push_recent(&list, "/c"), vec!["/c", "/a", "/b"]);
    // Re-opening the current front is a no-op ordering-wise.
    assert_eq!(push_recent(&list, "/a"), vec!["/a", "/b", "/c"]);
  }

  #[test]
  fn push_recent_caps_at_max() {
    let mut list: Vec<String> = Vec::new();
    for i in 0..(RECENT_FILES_MAX + 5) {
      list = push_recent(&list, &format!("/f{i}"));
    }
    assert_eq!(list.len(), RECENT_FILES_MAX);
    // Newest is at the front, and the oldest entries fell off.
    assert_eq!(list[0], format!("/f{}", RECENT_FILES_MAX + 4));
    assert!(!list.contains(&"/f0".to_string()));
  }

  #[test]
  fn merge_patches_recent_files() {
    let current = AppSettings::default();
    let merged = merge_settings(
      &current,
      &serde_json::json!({ "recent_files": ["/x", "/y"] }),
    )
    .unwrap();
    assert_eq!(merged.recent_files, vec!["/x", "/y"]);
  }

  #[test]
  fn a_wrong_typed_field_costs_only_that_field() {
    // `theme` is a String in the schema; storing a number for it used to fail
    // the whole file. Every other field must survive, at whatever value was
    // stored, and only `theme` falls back to its default.
    let settings = load_json(
      r#"{"theme": 42, "interface_mode": "dark", "editor_font_size": 18.0, "project_roots": ["/tmp/a"]}"#,
    );
    assert_eq!(settings.theme, default_theme());
    assert_eq!(settings.interface_mode, "dark");
    assert_eq!(settings.editor_font_size, 18.0);
    assert_eq!(settings.project_roots, vec!["/tmp/a"]);
  }

  #[test]
  fn a_wrong_typed_field_survives_a_read_merge_write_cycle() {
    // The regression that matters: `save_settings` reads, merges a patch, and
    // writes back. Before the fix, a wrong-typed field turned the read into
    // defaults, and every other setting the user had was overwritten.
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(
      &path,
      r#"{"theme": 42, "interface_mode": "dark", "project_roots": ["/tmp/a"], "show_tray_icon": false}"#,
    )
    .unwrap();
    let current = load_from(&path).unwrap();
    let patch = serde_json::json!({ "editor_font_size": 20.0 });
    let merged = merge_settings(&current, &patch).unwrap();
    save_to(&path, &merged).unwrap();
    let reloaded = load_from(&path).unwrap();
    assert_eq!(reloaded.editor_font_size, 20.0);
    // Settings never touched by the patch, and unrelated to the bad field,
    // must have survived the whole round trip.
    assert_eq!(reloaded.interface_mode, "dark");
    assert_eq!(reloaded.project_roots, vec!["/tmp/a"]);
    assert!(!reloaded.show_tray_icon);
  }

  #[test]
  fn invalid_json_still_errors() {
    // Not valid JSON at all has no fields to salvage; this must keep failing.
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "{ not json").unwrap();
    assert!(load_from(&path).is_err());
  }

  #[test]
  fn missing_file_still_yields_defaults() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("does-not-exist.json");
    assert_eq!(load_from(&path).unwrap(), AppSettings::default());
  }

  #[cfg(unix)]
  #[test]
  fn an_unreadable_existing_file_is_not_overwritten_with_defaults() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, r#"{"theme": "dark"}"#).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    let result = load_or_default_for_write(&path);
    // Restore permissions before any assertion/cleanup can fail and leak a
    // file tempdir can't remove.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(result.is_err());
    // The file on disk must be untouched, not silently reset to defaults.
    let contents = std::fs::read_to_string(&path).unwrap();
    assert!(contents.contains("\"theme\""));
  }

  #[test]
  fn save_rejects_empty_shortcut() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let settings = AppSettings {
      new_note_shortcut: "   ".into(),
      ..AppSettings::default()
    };
    assert!(save_to(&path, &settings).is_err());
  }
}
