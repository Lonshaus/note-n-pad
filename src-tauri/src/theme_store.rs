// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::fs_ops::{is_ignored_file, write_text_atomic, Loaded, SkipReason, SkippedFile};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxColors {
  pub keyword: String,
  pub string: String,
  pub number: String,
  pub comment: String,
  pub function: String,
  #[serde(rename = "type")]
  pub r#type: String,
  pub variable: String,
  pub operator: String,
  #[serde(rename = "const")]
  pub r#const: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
  pub id: String,
  pub name: String,
  pub variant: String,
  #[serde(default)]
  pub order: i64,
  pub editor_bg: String,
  pub editor_fg: String,
  pub ui_bg: String,
  pub ui_fg: String,
  pub ui_accent: String,
  pub ui_border: String,
  pub danger: String,
  pub syntax: SyntaxColors,
}

/// `list_themes`'s per-item shape: every `CustomTheme` field, flattened, plus
/// whether a bundled default seed exists for this id (frontend uses it to
/// show a "restore" action and to label the theme as customized).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeListItem {
  #[serde(flatten)]
  pub theme: CustomTheme,
  pub is_default: bool,
}

/// A theme id may only contain ASCII alphanumerics, hyphens, and underscores
/// (so it can never traverse outside the themes directory when used as a
/// file name), and must be non-empty and no longer than 64 bytes.
fn valid_id(id: &str) -> bool {
  !id.is_empty()
    && id.len() <= 64
    && id
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A hex color literal: `#` followed by exactly 3 or 6 hex digits.
fn valid_hex_color(value: &str) -> bool {
  let Some(digits) = value.strip_prefix('#') else {
    return false;
  };
  (digits.len() == 3 || digits.len() == 6) && digits.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Validate a theme's shape: variant, every color's hex format, id charset,
/// and a non-empty trimmed name. Returns the first failure found.
pub fn validate(theme: &CustomTheme) -> Result<(), String> {
  if !valid_id(&theme.id) {
    return Err(format!("invalid theme id: {}", theme.id));
  }
  if theme.name.trim().is_empty() {
    return Err("theme name must not be empty".to_string());
  }
  match theme.variant.as_str() {
    "light" | "dark" => {}
    other => return Err(format!("unknown theme variant: {other}")),
  }
  let colors: [(&str, &str); 16] = [
    ("editorBg", &theme.editor_bg),
    ("editorFg", &theme.editor_fg),
    ("uiBg", &theme.ui_bg),
    ("uiFg", &theme.ui_fg),
    ("uiAccent", &theme.ui_accent),
    ("uiBorder", &theme.ui_border),
    ("danger", &theme.danger),
    ("keyword", &theme.syntax.keyword),
    ("string", &theme.syntax.string),
    ("number", &theme.syntax.number),
    ("comment", &theme.syntax.comment),
    ("function", &theme.syntax.function),
    ("type", &theme.syntax.r#type),
    ("variable", &theme.syntax.variable),
    ("operator", &theme.syntax.operator),
    ("const", &theme.syntax.r#const),
  ];
  for (field, value) in colors {
    if !valid_hex_color(value) {
      return Err(format!("invalid hex color for {field}: {value}"));
    }
  }
  Ok(())
}

/// Absolute path of the per-theme file for `id` inside `dir`.
fn theme_file(dir: &Path, id: &str) -> PathBuf {
  dir.join(format!("{id}.json"))
}

/// Parse one theme file's text as a `CustomTheme`.
fn parse_theme(text: &str) -> Result<CustomTheme, String> {
  serde_json::from_str(text).map_err(|e| e.to_string())
}

/// Load every `*.json` theme file in `dir`. A missing dir yields an empty Vec,
/// and an individual file that will not parse or does not validate is skipped
/// with a warning rather than failing the whole load. Validating here and not
/// only on write matters because a file can arrive without going through this
/// app: copied into the folder by hand, or synced in. Its colors reach
/// `setProperty` untouched, so the check belongs on the way in.
pub fn load_dir(dir: &Path) -> Result<Loaded<CustomTheme>, String> {
  let (named, skipped) = load_named(dir)?;
  Ok(Loaded {
    items: named.into_iter().map(|(_, theme)| theme).collect(),
    skipped,
  })
}
/// Themes paired with the file name each came from, plus the skipped files.
type NamedThemes = (Vec<(String, CustomTheme)>, Vec<SkippedFile>);
/// `load_dir` with the file name each theme came from. One theme per id: the
/// file whose stem equals the id wins, otherwise the first by file name; the
/// other files declaring that id are reported as `DuplicateId`.
fn load_named(dir: &Path) -> Result<NamedThemes, String> {
  let entries = match std::fs::read_dir(dir) {
    Ok(entries) => entries,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), Vec::new())),
    Err(e) => return Err(e.to_string()),
  };
  // read_dir order is unspecified; byte order keeps the winner stable.
  let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
  paths.sort();
  let mut themes: Vec<(String, CustomTheme)> = Vec::new();
  let mut skipped = Vec::new();
  for path in paths {
    // A subdirectory is not a theme that failed to load, so it is passed over
    // rather than reported.
    if path.is_dir() {
      continue;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
      continue;
    };
    if is_ignored_file(&name) {
      continue;
    }
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
      skipped.push(SkippedFile {
        name,
        reason: SkipReason::NotJson,
      });
      continue;
    }
    // Read, parse and validate are kept apart so the reason reported is the
    // one that actually applies: a folder this app cannot read is a different
    // problem from a file whose colors are not hex.
    let text = match std::fs::read_to_string(&path) {
      Ok(text) => text,
      Err(e) => {
        log::warn!("skipping unreadable theme {}: {e}", path.display());
        skipped.push(SkippedFile {
          name,
          reason: SkipReason::Unreadable,
        });
        continue;
      }
    };
    let theme = match parse_theme(&text) {
      Ok(theme) => theme,
      Err(e) => {
        log::warn!("skipping unparsable theme {}: {e}", path.display());
        skipped.push(SkippedFile {
          name,
          reason: SkipReason::Unparsable,
        });
        continue;
      }
    };
    if let Err(e) = validate(&theme) {
      log::warn!("skipping invalid theme {}: {e}", path.display());
      skipped.push(SkippedFile {
        name,
        reason: SkipReason::Invalid,
      });
      continue;
    }
    let Some(held) = themes.iter().position(|(_, t)| t.id == theme.id) else {
      themes.push((name, theme));
      continue;
    };
    let stem_is_id = |file: &str| file.strip_suffix(".json") == Some(theme.id.as_str());
    let challenger_wins = stem_is_id(&name) && !stem_is_id(&themes[held].0);
    let displaced = if challenger_wins {
      std::mem::replace(&mut themes[held], (name, theme)).0
    } else {
      name
    };
    log::warn!("skipping duplicate theme id in {displaced}");
    skipped.push(SkippedFile {
      name: displaced,
      reason: SkipReason::DuplicateId,
    });
  }
  Ok((themes, skipped))
}
/// The file `load_dir` keeps for theme `id`, or `None` when no file declares it.
fn file_for_id(dir: &Path, id: &str) -> Option<PathBuf> {
  // A valid `{id}.json` declaring `id` always wins, so the common case skips the scan.
  let own = theme_file(dir, id);
  let own_declares_id = std::fs::read_to_string(&own)
    .ok()
    .and_then(|text| parse_theme(&text).ok())
    .is_some_and(|t| t.id == id && validate(&t).is_ok());
  if own_declares_id {
    return Some(own);
  }
  let (named, _) = load_named(dir).ok()?;
  named
    .into_iter()
    .find(|(_, t)| t.id == id)
    .map(|(name, _)| dir.join(name))
}
/// `{id}.json` when that name is free, else the first free `{id}-N.json`
/// (N = 2, 3, ...). Never names an existing file.
fn free_theme_file(dir: &Path, id: &str) -> PathBuf {
  let own = theme_file(dir, id);
  if !own.exists() {
    return own;
  }
  (2..)
    .map(|n| dir.join(format!("{id}-{n}.json")))
    .find(|path| !path.exists())
    .expect("an unbounded range always yields a free name")
}
/// Validate then atomically write one theme into the file that declares its
/// id, or into a new free file when none does.
fn save_theme_to(dir: &Path, theme: &CustomTheme) -> Result<(), String> {
  validate(theme)?;
  let json = serde_json::to_string_pretty(theme).map_err(|e| e.to_string())?;
  let path = file_for_id(dir, &theme.id).unwrap_or_else(|| free_theme_file(dir, &theme.id));
  write_text_atomic(&path, &json)
}
/// Remove the file that declares `id`. A missing file is not an error.
fn delete_theme_file(dir: &Path, id: &str) -> Result<(), String> {
  if !valid_id(id) {
    return Err(format!("invalid theme id: {id}"));
  }
  let Some(path) = file_for_id(dir, id) else {
    return Ok(());
  };
  match std::fs::remove_file(path) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

/// The `themes` directory under the app data dir (no side effects; may not exist).
pub fn app_data_themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(
    app
      .path()
      .app_data_dir()
      .map_err(|e| e.to_string())?
      .join("themes"),
  )
}

/// The `themes` directory under the app data dir, created if absent.
pub fn themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app_data_themes_dir(app)?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

/// The bundled default-theme seed directory (`resources/themes/` in the
/// packaged app, see `tauri.conf.json`'s `bundle.resources` mapping).
pub fn resource_themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(
    app
      .path()
      .resource_dir()
      .map_err(|e| e.to_string())?
      .join("themes"),
  )
}

/// Copy every `*.json` seed from `resource_dir` into `data_dir`, but only
/// when `data_dir` does not yet exist. A fresh install gets the 10 bundled
/// defaults; once the themes dir exists (even emptied by the user deleting
/// every theme), seeding never runs again, so deleted defaults stay deleted.
pub fn seed_defaults_if_missing(resource_dir: &Path, data_dir: &Path) -> Result<(), String> {
  if data_dir.exists() {
    return Ok(());
  }
  std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
  let entries = match std::fs::read_dir(resource_dir) {
    Ok(entries) => entries,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(e) => return Err(e.to_string()),
  };
  for entry in entries {
    let Ok(entry) = entry else {
      continue;
    };
    let path = entry.path();
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
      continue;
    }
    if let Some(name) = path.file_name() {
      std::fs::copy(&path, data_dir.join(name)).map_err(|e| e.to_string())?;
    }
  }
  Ok(())
}

/// Whether a bundled default seed json exists for `id` in `resource_dir` —
/// the `isDefault` flag `list_themes` reports and the check `restore_default`
/// relies on to find its source file.
fn has_default_seed(resource_dir: &Path, id: &str) -> bool {
  resource_dir.join(format!("{id}.json")).is_file()
}

/// Load `data_dir`, sort by `order` then `name`, and annotate each theme with
/// whether a bundled default seed exists for its id.
pub fn list_with_defaults(
  data_dir: &Path,
  resource_dir: &Path,
) -> Result<Loaded<ThemeListItem>, String> {
  let mut loaded = load_dir(data_dir)?;
  loaded
    .items
    .sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.name.cmp(&b.name)));
  Ok(Loaded {
    items: loaded
      .items
      .into_iter()
      .map(|theme| {
        let is_default = has_default_seed(resource_dir, &theme.id);
        ThemeListItem { theme, is_default }
      })
      .collect(),
    skipped: loaded.skipped,
  })
}
/// Overwrite the file declaring `id` (or write a new one) with the bundled
/// default seed for `id`, undoing any edits or the deletion of that one default theme.
fn restore_default_from(
  resource_dir: &Path,
  data_dir: &Path,
  id: &str,
) -> Result<CustomTheme, String> {
  if !valid_id(id) {
    return Err(format!("invalid theme id: {id}"));
  }
  let text = std::fs::read_to_string(resource_themes_file(resource_dir, id))
    .map_err(|e| format!("no default theme for id {id}: {e}"))?;
  let theme = parse_theme(&text)?;
  save_theme_to(data_dir, &theme)?;
  Ok(theme)
}

/// Absolute path of the bundled default seed file for `id` inside `resource_dir`.
fn resource_themes_file(resource_dir: &Path, id: &str) -> PathBuf {
  resource_dir.join(format!("{id}.json"))
}
/// Manifest of the bundled theme ids already offered to this install.
/// Dot-prefixed: `load_dir` skips it.
const SEEDED_THEMES_FILE: &str = ".seeded-themes.json";
/// The themes shipped since 1.0.0. Without a manifest they count as offered
/// (a missing one was deleted by the user), so only later additions are copied.
const BASELINE_THEME_IDS: [&str; 10] = [
  "bamboo", "dawn", "dusk", "ember", "forest", "ink", "paper", "plain", "sky", "voyage",
];
/// Copy bundled themes that were never offered to this install. A theme the
/// user deleted is not recreated and an existing file is never modified. An id
/// some file already declares is not copied; a taken `{id}.json` name moves
/// the copy to the first free `{id}-N.json`.
pub fn seed_new_defaults(resource_dir: &Path, data_dir: &Path) {
  let Ok(entries) = std::fs::read_dir(resource_dir) else {
    return;
  };
  let manifest_path = data_dir.join(SEEDED_THEMES_FILE);
  let stored: Option<BTreeSet<String>> = std::fs::read_to_string(&manifest_path)
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok());
  let mut offered = stored
    .clone()
    .unwrap_or_else(|| BASELINE_THEME_IDS.iter().map(|id| id.to_string()).collect());
  for entry in entries.flatten() {
    let path = entry.path();
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
      continue;
    }
    let Some(id) = path.file_stem().and_then(|n| n.to_str()) else {
      continue;
    };
    if !valid_id(id) || offered.contains(id) {
      continue;
    }
    if file_for_id(data_dir, id).is_none() {
      if let Err(e) = std::fs::copy(&path, free_theme_file(data_dir, id)) {
        log::warn!("failed to seed theme {id}: {e}");
        continue;
      }
    }
    offered.insert(id.to_string());
  }
  if stored.as_ref() != Some(&offered) {
    let result = serde_json::to_string_pretty(&offered)
      .map_err(|e| e.to_string())
      .and_then(|json| write_text_atomic(&manifest_path, &json));
    if let Err(e) = result {
      log::warn!("failed to write {SEEDED_THEMES_FILE}: {e}");
    }
  }
}
/// Seed the app-data `themes` dir from the bundled resources on first run,
/// then copy themes that later releases added to the bundle.
/// Called once from setup, before any theme command touches the dir.
pub fn seed_on_startup(app: &AppHandle) -> Result<(), String> {
  let resource_dir = resource_themes_dir(app)?;
  let data_dir = app_data_themes_dir(app)?;
  seed_defaults_if_missing(&resource_dir, &data_dir)?;
  seed_new_defaults(&resource_dir, &data_dir);
  Ok(())
}

/// What the Lite edition shows of the theme list: only the bundled defaults.
/// The editor needs one of them to be colored; themes the user made or imported
/// stay on disk, untouched, for when the edition is full again.
fn for_edition(mut loaded: Loaded<ThemeListItem>, lite: bool) -> Loaded<ThemeListItem> {
  if lite {
    loaded.items.retain(|item| item.is_default);
  }
  loaded
}

#[tauri::command]
pub fn list_themes(app: AppHandle) -> Result<Loaded<ThemeListItem>, String> {
  let loaded = list_with_defaults(&themes_dir(&app)?, &resource_themes_dir(&app)?)?;
  Ok(for_edition(loaded, crate::edition::is_lite()))
}

/// Last-applied sequence per theme id. Guards `save_theme` (now `(async)`,
/// see its doc comment) against the live color editor's 300ms-debounced
/// `persist()`, whose two overlapping calls for the same theme are no longer
/// guaranteed to land in call order — mirrors `NoteStore::upsert_ordered`.
fn theme_seqs() -> &'static Mutex<HashMap<String, u64>> {
  static SEQS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
  SEQS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Off the UI thread: called on every live color-drag debounce tick, so the
/// serialize + atomic write must not block the UI thread. `seq` (assigned by
/// the frontend at the moment the write is issued, so it reflects true call
/// order) guards against a stale drag tick landing after a newer one.
#[tauri::command(async)]
pub fn save_theme(app: AppHandle, theme: CustomTheme, seq: u64) -> Result<(), String> {
  crate::edition::require_full("themes")?;
  let mut seqs = theme_seqs().lock().unwrap();
  if let Some(&last) = seqs.get(&theme.id) {
    if seq < last {
      return Ok(());
    }
  }
  save_theme_to(&themes_dir(&app)?, &theme)?;
  seqs.insert(theme.id.clone(), seq);
  drop(seqs);
  let _ = app.emit("themes-changed", ());
  Ok(())
}

#[tauri::command]
pub fn delete_theme(app: AppHandle, id: String) -> Result<(), String> {
  crate::edition::require_full("themes")?;
  delete_theme_file(&themes_dir(&app)?, &id)?;
  let _ = app.emit("themes-changed", ());
  Ok(())
}

#[tauri::command]
pub fn import_theme(path: String) -> Result<CustomTheme, String> {
  crate::edition::require_full("themes")?;
  let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
  let theme = parse_theme(&text)?;
  validate(&theme)?;
  Ok(theme)
}

#[tauri::command]
pub fn export_theme(theme: CustomTheme, path: String) -> Result<(), String> {
  crate::edition::require_full("themes")?;
  validate(&theme)?;
  let json = serde_json::to_string_pretty(&theme).map_err(|e| e.to_string())?;
  std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_default_theme(app: AppHandle, id: String) -> Result<CustomTheme, String> {
  crate::edition::require_full("themes")?;
  let theme = restore_default_from(&resource_themes_dir(&app)?, &themes_dir(&app)?, &id)?;
  let _ = app.emit("themes-changed", ());
  Ok(theme)
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  fn theme(id: &str) -> CustomTheme {
    CustomTheme {
      id: id.into(),
      name: "墨 Ink（自訂）".into(),
      variant: "dark".into(),
      order: 0,
      editor_bg: "#17181c".into(),
      editor_fg: "#d4d6dc".into(),
      ui_bg: "#1c1e24".into(),
      ui_fg: "#9aa0ac".into(),
      ui_accent: "#6f9bd8".into(),
      ui_border: "#2b2e36".into(),
      danger: "#e2635c".into(),
      syntax: SyntaxColors {
        keyword: "#b48ead".into(),
        string: "#9cc09a".into(),
        number: "#d3a15c".into(),
        comment: "#656b78".into(),
        function: "#6f9bd8".into(),
        r#type: "#6fb3ad".into(),
        variable: "#d4d6dc".into(),
        operator: "#b09aa8".into(),
        r#const: "#d3a15c".into(),
      },
    }
  }

  #[test]
  fn save_then_list_roundtrips() {
    let dir = tempdir().unwrap();
    save_theme_to(dir.path(), &theme("custom-a")).unwrap();
    let loaded = load_dir(dir.path()).unwrap().items;
    assert_eq!(loaded, vec![theme("custom-a")]);
  }

  #[test]
  fn save_rejects_invalid_variant() {
    let dir = tempdir().unwrap();
    let mut t = theme("custom-a");
    t.variant = "sepia".into();
    let err = save_theme_to(dir.path(), &t).unwrap_err();
    assert!(err.contains("variant"));
    assert!(!dir.path().join("custom-a.json").exists());
  }

  #[test]
  fn save_rejects_invalid_hex_color() {
    let dir = tempdir().unwrap();
    let mut t = theme("custom-a");
    t.editor_bg = "17181c".into();
    let err = save_theme_to(dir.path(), &t).unwrap_err();
    assert!(err.contains("editorBg"));
    assert!(!dir.path().join("custom-a.json").exists());
  }

  #[test]
  fn save_rejects_wrong_hex_length() {
    let dir = tempdir().unwrap();
    let mut t = theme("custom-a");
    t.danger = "#abcd".into();
    assert!(save_theme_to(dir.path(), &t).is_err());
  }

  #[test]
  fn parse_rejects_missing_field() {
    let json = r#"{"id":"custom-a","name":"x","variant":"dark"}"#;
    assert!(parse_theme(json).is_err());
  }

  #[test]
  fn save_rejects_traversal_id() {
    let dir = tempdir().unwrap();
    let t = theme("../evil");
    let err = save_theme_to(dir.path(), &t).unwrap_err();
    assert!(err.contains("invalid theme id"));
    assert!(!dir.path().parent().unwrap().join("evil.json").exists());
  }

  #[test]
  fn save_rejects_id_with_dotdot() {
    let dir = tempdir().unwrap();
    let t = theme("a..b");
    // ".." contains only dots, which are not in the allowed charset.
    assert!(save_theme_to(dir.path(), &t).is_err());
  }

  #[test]
  fn delete_rejects_invalid_id() {
    let dir = tempdir().unwrap();
    let err = delete_theme_file(dir.path(), "../evil").unwrap_err();
    assert!(err.contains("invalid theme id"));
  }

  #[test]
  fn delete_missing_file_is_noop() {
    let dir = tempdir().unwrap();
    delete_theme_file(dir.path(), "does-not-exist").unwrap();
  }

  #[test]
  fn export_then_import_roundtrips() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("exported.json");
    let t = theme("custom-a");
    let json = serde_json::to_string_pretty(&t).unwrap();
    std::fs::write(&path, &json).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    let imported = parse_theme(&text).unwrap();
    validate(&imported).unwrap();
    assert_eq!(imported, t);
  }

  #[test]
  fn list_skips_one_bad_file_but_keeps_the_rest() {
    let dir = tempdir().unwrap();
    save_theme_to(dir.path(), &theme("good")).unwrap();
    std::fs::write(dir.path().join("bad.json"), "{ not json").unwrap();
    std::fs::write(dir.path().join("ignore.txt"), "not json at all").unwrap();
    let loaded = load_dir(dir.path()).unwrap().items;
    assert_eq!(loaded, vec![theme("good")]);
  }

  #[test]
  fn missing_dir_lists_empty() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("nope");
    assert!(load_dir(&missing).unwrap().items.is_empty());
  }

  #[test]
  fn order_field_roundtrips_and_defaults_to_zero() {
    let dir = tempdir().unwrap();
    let mut t = theme("custom-a");
    t.order = 3;
    save_theme_to(dir.path(), &t).unwrap();
    let loaded = load_dir(dir.path()).unwrap().items;
    assert_eq!(loaded, vec![t]);
    // A file written before this field existed parses with order 0.
    let json = r##"{"id":"legacy","name":"x","variant":"dark","editorBg":"#111",
      "editorFg":"#111","uiBg":"#111","uiFg":"#111","uiAccent":"#111",
      "uiBorder":"#111","danger":"#111","syntax":{"keyword":"#111","string":"#111",
      "number":"#111","comment":"#111","function":"#111","type":"#111",
      "variable":"#111","operator":"#111","const":"#111"}}"##;
    assert_eq!(parse_theme(json).unwrap().order, 0);
  }

  #[test]
  fn load_dir_skips_a_theme_whose_colors_are_not_hex() {
    // A theme file can arrive without passing through save or import — copied
    // into the folder by hand, or synced in. Its colors are handed straight to
    // `setProperty`, so an unchecked value would reach the stylesheet.
    let dir = tempdir().unwrap();
    let good = theme("good");
    save_theme_to(dir.path(), &good).unwrap();
    let bad = r##"{"id":"bad","name":"x","variant":"dark","editorBg":"red; }",
      "editorFg":"#111","uiBg":"#111","uiFg":"#111","uiAccent":"#111",
      "uiBorder":"#111","danger":"#111","syntax":{"keyword":"#111","string":"#111",
      "number":"#111","comment":"#111","function":"#111","type":"#111",
      "variable":"#111","operator":"#111","const":"#111"}}"##;
    std::fs::write(dir.path().join("bad.json"), bad).unwrap();

    // The file parses as a CustomTheme, so only validation can reject it.
    assert!(parse_theme(bad).is_ok());
    assert_eq!(load_dir(dir.path()).unwrap().items, vec![good]);
  }

  #[test]
  fn load_dir_skips_a_theme_with_an_unknown_variant() {
    let dir = tempdir().unwrap();
    let good = theme("good");
    save_theme_to(dir.path(), &good).unwrap();
    let mut bad = theme("bad");
    bad.variant = "neon".into();
    let json = serde_json::to_string(&bad).unwrap();
    std::fs::write(dir.path().join("bad.json"), json).unwrap();

    assert_eq!(load_dir(dir.path()).unwrap().items, vec![good]);
  }

  #[test]
  fn load_dir_does_not_report_hidden_or_system_files() {
    let dir = tempdir().unwrap();
    save_theme_to(dir.path(), &theme("ink")).unwrap();
    for name in [".DS_Store", ".ink.json.tmp", "Thumbs.db", "desktop.ini"] {
      std::fs::write(dir.path().join(name), "x").unwrap();
    }
    std::fs::create_dir(dir.path().join("a-folder")).unwrap();
    let loaded = load_dir(dir.path()).unwrap();
    assert_eq!(loaded.items, vec![theme("ink")]);
    assert_eq!(loaded.skipped, Vec::new());
  }

  #[test]
  fn load_dir_reports_why_each_theme_was_skipped() {
    let dir = tempdir().unwrap();
    save_theme_to(dir.path(), &theme("ink")).unwrap();
    std::fs::write(dir.path().join("notes.txt"), "x").unwrap();
    std::fs::write(dir.path().join("broken.json"), "{ not json").unwrap();
    // Parses as a theme, but a color that is not hex would reach `setProperty`
    // untouched, which is why `validate` runs on load and not only on write.
    let mut bad = theme("bad");
    bad.editor_bg = "red; }".into();
    std::fs::write(
      dir.path().join("bad.json"),
      serde_json::to_string(&bad).unwrap(),
    )
    .unwrap();
    let loaded = load_dir(dir.path()).unwrap();
    assert_eq!(loaded.items, vec![theme("ink")]);
    let mut reported: Vec<(String, SkipReason)> = loaded
      .skipped
      .into_iter()
      .map(|s| (s.name, s.reason))
      .collect();
    reported.sort();
    assert_eq!(
      reported,
      vec![
        ("bad.json".to_string(), SkipReason::Invalid),
        ("broken.json".to_string(), SkipReason::Unparsable),
        ("notes.txt".to_string(), SkipReason::NotJson),
      ]
    );
  }

  #[test]
  fn list_with_defaults_sorts_by_order_then_name() {
    let data = tempdir().unwrap();
    let resources = tempdir().unwrap();
    let mut b = theme("b-theme");
    b.order = 1;
    b.name = "B".into();
    let mut a = theme("a-theme");
    a.order = 1;
    a.name = "A".into();
    let mut z = theme("z-theme");
    z.order = 0;
    z.name = "Z".into();
    save_theme_to(data.path(), &b).unwrap();
    save_theme_to(data.path(), &a).unwrap();
    save_theme_to(data.path(), &z).unwrap();
    std::fs::write(resources.path().join("a-theme.json"), "{}").unwrap();
    let listed = list_with_defaults(data.path(), resources.path())
      .unwrap()
      .items;
    let ids: Vec<&str> = listed.iter().map(|i| i.theme.id.as_str()).collect();
    assert_eq!(ids, vec!["z-theme", "a-theme", "b-theme"]);
    assert!(listed[1].is_default);
    assert!(!listed[0].is_default);
    assert!(!listed[2].is_default);
  }

  #[test]
  fn lite_lists_the_bundled_defaults_only_and_full_lists_everything() {
    let data = tempdir().unwrap();
    let resources = tempdir().unwrap();
    for id in ["default-a", "mine"] {
      save_theme_to(data.path(), &theme(id)).unwrap();
    }
    std::fs::write(resources.path().join("default-a.json"), "{}").unwrap();
    let ids = |lite| -> Vec<String> {
      for_edition(
        list_with_defaults(data.path(), resources.path()).unwrap(),
        lite,
      )
      .items
      .into_iter()
      .map(|i| i.theme.id)
      .collect()
    };
    assert_eq!(ids(true), vec!["default-a"]);
    assert_eq!(ids(false).len(), 2);
    // Nothing on disk changed.
    assert!(data.path().join("mine.json").exists());
  }

  #[test]
  fn restore_default_overwrites_from_resource_dir() {
    let data = tempdir().unwrap();
    let resources = tempdir().unwrap();
    let mut original = theme("ink");
    original.name = "factory default".into();
    let json = serde_json::to_string_pretty(&original).unwrap();
    std::fs::write(resources.path().join("ink.json"), json).unwrap();
    let mut edited = original.clone();
    edited.name = "user edited".into();
    save_theme_to(data.path(), &edited).unwrap();
    let restored = restore_default_from(resources.path(), data.path(), "ink").unwrap();
    assert_eq!(restored.name, "factory default");
    let loaded = load_dir(data.path()).unwrap().items;
    assert_eq!(loaded, vec![original]);
  }

  #[test]
  fn restore_default_errs_when_no_seed_for_id() {
    let data = tempdir().unwrap();
    let resources = tempdir().unwrap();
    let err = restore_default_from(resources.path(), data.path(), "no-such-id").unwrap_err();
    assert!(!err.is_empty());
  }

  #[test]
  fn seed_copies_resources_only_when_data_dir_missing() {
    let base = tempdir().unwrap();
    let resources = base.path().join("resources");
    let data = base.path().join("data");
    std::fs::create_dir_all(&resources).unwrap();
    let seed = theme("ink");
    std::fs::write(
      resources.join("ink.json"),
      serde_json::to_string_pretty(&seed).unwrap(),
    )
    .unwrap();
    seed_defaults_if_missing(&resources, &data).unwrap();
    assert_eq!(load_dir(&data).unwrap().items, vec![seed]);
    // Delete the seeded theme, then confirm seeding never runs again.
    delete_theme_file(&data, "ink").unwrap();
    seed_defaults_if_missing(&resources, &data).unwrap();
    assert!(load_dir(&data).unwrap().items.is_empty());
  }

  #[test]
  fn seed_does_not_overwrite_existing_edits() {
    let base = tempdir().unwrap();
    let resources = base.path().join("resources");
    let data = base.path().join("data");
    std::fs::create_dir_all(&resources).unwrap();
    std::fs::write(resources.join("ink.json"), "{}").unwrap();
    let mut edited = theme("ink");
    edited.name = "user edited".into();
    save_theme_to(&data, &edited).unwrap();
    seed_defaults_if_missing(&resources, &data).unwrap();
    assert_eq!(load_dir(&data).unwrap().items, vec![edited]);
  }

  fn ten_ids() -> [&'static str; 10] {
    [
      "bamboo", "dawn", "dusk", "ember", "forest", "ink", "paper", "plain", "sky", "voyage",
    ]
  }

  fn write_seeds(dir: &Path, ids: &[&str]) {
    std::fs::create_dir_all(dir).unwrap();
    for id in ids {
      std::fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_string_pretty(&theme(id)).unwrap(),
      )
      .unwrap();
    }
  }

  fn recorded(data: &Path) -> BTreeSet<String> {
    serde_json::from_str(&std::fs::read_to_string(data.join(SEEDED_THEMES_FILE)).unwrap()).unwrap()
  }

  fn file_ids(data: &Path) -> BTreeSet<String> {
    load_dir(data)
      .unwrap()
      .items
      .into_iter()
      .map(|t| t.id)
      .collect()
  }

  fn set(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|id| id.to_string()).collect()
  }

  #[test]
  fn new_defaults_fresh_install_records_all_and_copies_nothing_extra() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    write_seeds(&res, &ten_ids());
    seed_defaults_if_missing(&res, &data).unwrap();
    seed_new_defaults(&res, &data);
    assert_eq!(recorded(&data), set(&ten_ids()));
    assert_eq!(file_ids(&data), set(&ten_ids()));
  }

  #[test]
  fn new_defaults_upgrade_without_manifest_does_not_recreate_a_deleted_default() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    write_seeds(&res, &ten_ids());
    seed_defaults_if_missing(&res, &data).unwrap();
    delete_theme_file(&data, "dusk").unwrap();
    seed_new_defaults(&res, &data);
    assert!(!data.join("dusk.json").exists());
    assert_eq!(recorded(&data), set(&ten_ids()));
  }

  #[test]
  fn new_defaults_copies_a_new_seed_once() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    write_seeds(&res, &ten_ids());
    seed_defaults_if_missing(&res, &data).unwrap();
    seed_new_defaults(&res, &data);
    write_seeds(&res, &["fresh"]);
    seed_new_defaults(&res, &data);
    assert!(data.join("fresh.json").exists());
    assert!(recorded(&data).contains("fresh"));
    delete_theme_file(&data, "fresh").unwrap();
    seed_new_defaults(&res, &data);
    assert!(!data.join("fresh.json").exists());
  }

  #[test]
  fn new_defaults_never_overwrites_a_same_id_user_theme() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    write_seeds(&res, &ten_ids());
    seed_defaults_if_missing(&res, &data).unwrap();
    seed_new_defaults(&res, &data);
    write_seeds(&res, &["fresh"]);
    std::fs::write(data.join("fresh.json"), "user's own").unwrap();
    seed_new_defaults(&res, &data);
    assert_eq!(
      std::fs::read_to_string(data.join("fresh.json")).unwrap(),
      "user's own"
    );
    assert!(recorded(&data).contains("fresh"));
  }

  #[cfg(unix)]
  #[test]
  fn new_defaults_failed_copy_is_not_recorded_and_retried() {
    use std::os::unix::fs::PermissionsExt;
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    write_seeds(&res, &ten_ids());
    seed_defaults_if_missing(&res, &data).unwrap();
    seed_new_defaults(&res, &data);
    write_seeds(&res, &["fresh"]);
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o555)).unwrap();
    if std::fs::write(data.join("probe"), "x").is_ok() {
      // Permission bits are not enforced (running as root): nothing to exercise.
      std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o755)).unwrap();
      return;
    }
    seed_new_defaults(&res, &data);
    assert!(!recorded(&data).contains("fresh"));
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o755)).unwrap();
    seed_new_defaults(&res, &data);
    assert!(data.join("fresh.json").exists());
    assert!(recorded(&data).contains("fresh"));
  }

  #[test]
  fn new_defaults_unparsable_manifest_falls_back_to_the_baseline() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    write_seeds(&res, &ten_ids());
    seed_defaults_if_missing(&res, &data).unwrap();
    delete_theme_file(&data, "sky").unwrap();
    std::fs::write(data.join(SEEDED_THEMES_FILE), "garbage").unwrap();
    seed_new_defaults(&res, &data);
    assert!(!data.join("sky.json").exists());
    assert_eq!(recorded(&data), set(&ten_ids()));
  }

  #[test]
  fn new_defaults_skipped_versions_get_later_themes_but_not_deleted_defaults() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    let mut ids = ten_ids().to_vec();
    ids.push("fresh");
    write_seeds(&res, &ids);
    write_seeds(&data, &ten_ids());
    delete_theme_file(&data, "ember").unwrap();
    seed_new_defaults(&res, &data);
    assert!(data.join("fresh.json").exists());
    assert!(!data.join("ember.json").exists());
    assert_eq!(recorded(&data).len(), 11);
  }

  #[test]
  fn new_defaults_missing_resource_dir_writes_no_manifest() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    write_seeds(&data, &ten_ids());
    seed_new_defaults(&res, &data);
    assert!(!data.join(SEEDED_THEMES_FILE).exists());
    write_seeds(&res, &ten_ids());
    delete_theme_file(&data, "plain").unwrap();
    seed_new_defaults(&res, &data);
    assert!(!data.join("plain.json").exists());
  }

  fn write_theme_as(dir: &Path, file: &str, id: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
      dir.join(file),
      serde_json::to_string_pretty(&theme(id)).unwrap(),
    )
    .unwrap();
  }

  fn skipped_duplicates(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = load_dir(dir)
      .unwrap()
      .skipped
      .into_iter()
      .filter(|s| s.reason == SkipReason::DuplicateId)
      .map(|s| s.name)
      .collect();
    names.sort();
    names
  }

  #[test]
  fn new_defaults_skip_an_id_another_file_declares() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    write_seeds(&res, &ten_ids());
    seed_defaults_if_missing(&res, &data).unwrap();
    seed_new_defaults(&res, &data);
    write_theme_as(&data, "mine.json", "newtheme");
    write_seeds(&res, &["newtheme"]);
    seed_new_defaults(&res, &data);
    assert!(!data.join("newtheme.json").exists());
    assert!(!data.join("newtheme-2.json").exists());
    assert!(recorded(&data).contains("newtheme"));
    let ids: Vec<String> = load_dir(&data)
      .unwrap()
      .items
      .into_iter()
      .map(|t| t.id)
      .filter(|id| id == "newtheme")
      .collect();
    assert_eq!(ids, vec!["newtheme".to_string()]);
  }

  #[test]
  fn load_dir_keeps_one_theme_per_id() {
    let dir = tempdir().unwrap();
    write_theme_as(dir.path(), "b.json", "x");
    write_theme_as(dir.path(), "a.json", "x");
    let loaded = load_dir(dir.path()).unwrap();
    assert_eq!(loaded.items.len(), 1);
    assert_eq!(
      file_for_id(dir.path(), "x"),
      Some(dir.path().join("a.json"))
    );
    assert_eq!(skipped_duplicates(dir.path()), vec!["b.json".to_string()]);
    write_theme_as(dir.path(), "x.json", "x");
    let loaded = load_dir(dir.path()).unwrap();
    assert_eq!(loaded.items.len(), 1);
    assert_eq!(
      file_for_id(dir.path(), "x"),
      Some(dir.path().join("x.json"))
    );
    assert_eq!(
      skipped_duplicates(dir.path()),
      vec!["a.json".to_string(), "b.json".to_string()]
    );
  }

  #[test]
  fn file_for_id_ignores_an_invalid_file_named_after_the_id() {
    let dir = tempdir().unwrap();
    let mut bad = theme("x");
    bad.editor_bg = "red".into();
    std::fs::write(
      dir.path().join("x.json"),
      serde_json::to_string(&bad).unwrap(),
    )
    .unwrap();
    write_theme_as(dir.path(), "a.json", "x");
    assert_eq!(
      file_for_id(dir.path(), "x"),
      Some(dir.path().join("a.json"))
    );
    assert_eq!(file_for_id(dir.path(), "nope"), None);
  }

  #[test]
  fn new_defaults_use_an_alternate_name_when_the_file_name_holds_another_id() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    write_seeds(&res, &ten_ids());
    seed_defaults_if_missing(&res, &data).unwrap();
    seed_new_defaults(&res, &data);
    write_theme_as(&data, "newtheme.json", "other");
    write_seeds(&res, &["newtheme"]);
    seed_new_defaults(&res, &data);
    assert!(data.join("newtheme-2.json").exists());
    assert!(recorded(&data).contains("newtheme"));
    assert_eq!(
      file_for_id(&data, "other"),
      Some(data.join("newtheme.json"))
    );
    assert_eq!(
      file_for_id(&data, "newtheme"),
      Some(data.join("newtheme-2.json"))
    );
    let before = file_ids(&data);
    seed_new_defaults(&res, &data);
    assert!(!data.join("newtheme-3.json").exists());
    assert_eq!(file_ids(&data), before);
  }

  #[test]
  fn save_delete_and_restore_follow_the_file_that_declares_the_id() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    write_theme_as(&data, "newtheme.json", "other");
    write_theme_as(&data, "newtheme-2.json", "newtheme");
    write_seeds(&res, &["newtheme"]);
    let other_bytes = std::fs::read(data.join("newtheme.json")).unwrap();
    let mut edited = theme("newtheme");
    edited.name = "edited".into();
    save_theme_to(&data, &edited).unwrap();
    assert_eq!(
      std::fs::read(data.join("newtheme.json")).unwrap(),
      other_bytes
    );
    assert!(!data.join("newtheme-3.json").exists());
    assert_eq!(
      parse_theme(&std::fs::read_to_string(data.join("newtheme-2.json")).unwrap())
        .unwrap()
        .name,
      "edited"
    );
    let restored = restore_default_from(&res, &data, "newtheme").unwrap();
    assert_eq!(restored, theme("newtheme"));
    assert_eq!(
      parse_theme(&std::fs::read_to_string(data.join("newtheme-2.json")).unwrap())
        .unwrap()
        .name,
      theme("newtheme").name
    );
    assert_eq!(
      std::fs::read(data.join("newtheme.json")).unwrap(),
      other_bytes
    );
    delete_theme_file(&data, "newtheme").unwrap();
    assert!(!data.join("newtheme-2.json").exists());
    assert_eq!(
      std::fs::read(data.join("newtheme.json")).unwrap(),
      other_bytes
    );
  }

  #[test]
  fn save_and_delete_use_a_hand_placed_file_whose_name_differs_from_the_id() {
    let dir = tempdir().unwrap();
    write_theme_as(dir.path(), "mine.json", "newtheme");
    let mut edited = theme("newtheme");
    edited.name = "edited".into();
    save_theme_to(dir.path(), &edited).unwrap();
    assert!(!dir.path().join("newtheme.json").exists());
    assert_eq!(load_dir(dir.path()).unwrap().items, vec![edited]);
    delete_theme_file(dir.path(), "newtheme").unwrap();
    assert!(!dir.path().join("mine.json").exists());
  }

  #[test]
  fn save_of_a_new_id_creates_its_own_file() {
    let dir = tempdir().unwrap();
    save_theme_to(dir.path(), &theme("fresh")).unwrap();
    assert!(dir.path().join("fresh.json").exists());
  }
}
