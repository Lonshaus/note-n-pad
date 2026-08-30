// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::fs_ops::{is_ignored_file, write_text_atomic, Loaded, SkipReason, SkippedFile};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// One UI language as pure data: an id, its native display label, a menu-order
/// hint, and the flat key→string map the frontend `t()` looks up.
///
/// Any id may have a data file, including the three locales compiled into the
/// binary (`en`/`ja`/`zh-TW`): a file simply *shadows* the compiled dictionary,
/// which is how the built-in languages are editable. The compiled dictionaries
/// remain the floor — lookup falls through data file → compiled locale →
/// compiled English — so deleting an override reverts to the shipped strings
/// and no edit can leave the UI unreadable.
///
/// Rust never validates the *key set* (that is the frontend's authority,
/// derived from the master dictionary) — a locale missing keys falls back
/// per-key at lookup time, so partial locales are allowed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LocaleData {
  pub id: String,
  pub label: String,
  #[serde(default)]
  pub order: i64,
  pub strings: BTreeMap<String, String>,
}

/// `list_locales`'s per-item shape: every `LocaleData` field, flattened, plus
/// whether a bundled seed exists for this id. The frontend uses it to enable
/// "restore" and to know the locale can be reverted to its shipped strings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleListItem {
  #[serde(flatten)]
  pub locale: LocaleData,
  pub is_default: bool,
}

/// A locale id may only contain ASCII alphanumerics, hyphens, and underscores
/// (so it can never traverse outside the locales directory when used as a file
/// name), and must be non-empty and no longer than 64 bytes. Matches the theme
/// store's rule; `zh-TW`-style tags pass because hyphens are allowed.
fn valid_id(id: &str) -> bool {
  !id.is_empty()
    && id.len() <= 64
    && id
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Validate a locale's shape: id charset, a non-empty trimmed label, and at
/// least one string. Returns the first failure found.
pub fn validate(locale: &LocaleData) -> Result<(), String> {
  if !valid_id(&locale.id) {
    return Err(format!("invalid locale id: {}", locale.id));
  }
  if locale.label.trim().is_empty() {
    return Err("locale label must not be empty".to_string());
  }
  if locale.strings.is_empty() {
    return Err("locale has no strings".to_string());
  }
  Ok(())
}

/// Absolute path of the per-locale file for `id` inside `dir`.
fn locale_file(dir: &Path, id: &str) -> PathBuf {
  dir.join(format!("{id}.json"))
}

/// Parse one locale file's text as a `LocaleData`.
fn parse_locale(text: &str) -> Result<LocaleData, String> {
  serde_json::from_str(text).map_err(|e| e.to_string())
}

/// Load every `*.json` locale file in `dir`. A missing dir yields an empty Vec,
/// and an unparsable individual file is skipped with a warning rather than
/// failing the whole load.
pub fn load_dir(dir: &Path) -> Result<Loaded<LocaleData>, String> {
  let entries = match std::fs::read_dir(dir) {
    Ok(entries) => entries,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
      return Ok(Loaded {
        items: Vec::new(),
        skipped: Vec::new(),
      })
    }
    Err(e) => return Err(e.to_string()),
  };
  let mut locales = Vec::new();
  let mut skipped = Vec::new();
  for entry in entries {
    let Ok(entry) = entry else {
      continue;
    };
    let path = entry.path();
    // A subdirectory is not a locale that failed to load, so it is passed over
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
    // Read and parse are kept apart so a folder this app cannot read is not
    // reported as a file with broken contents.
    let text = match std::fs::read_to_string(&path) {
      Ok(text) => text,
      Err(e) => {
        log::warn!("skipping unreadable locale {}: {e}", path.display());
        skipped.push(SkippedFile {
          name,
          reason: SkipReason::Unreadable,
        });
        continue;
      }
    };
    match parse_locale(&text) {
      Ok(locale) => locales.push(locale),
      Err(e) => {
        log::warn!("skipping unparsable locale {}: {e}", path.display());
        skipped.push(SkippedFile {
          name,
          reason: SkipReason::Unparsable,
        });
      }
    }
  }
  Ok(Loaded {
    items: locales,
    skipped,
  })
}

/// Remove `<dir>/{id}.json`. A missing file is not an error.
fn delete_locale_file(dir: &Path, id: &str) -> Result<(), String> {
  if !valid_id(id) {
    return Err(format!("invalid locale id: {id}"));
  }
  match std::fs::remove_file(locale_file(dir, id)) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

/// The `locales` directory under the app data dir (no side effects; may not exist).
pub fn app_data_locales_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(
    app
      .path()
      .app_data_dir()
      .map_err(|e| e.to_string())?
      .join("locales"),
  )
}

/// The `locales` directory under the app data dir, created if absent.
pub fn locales_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app_data_locales_dir(app)?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

/// The bundled default-locale seed directory (`resources/locales/` in the
/// packaged app, see `tauri.conf.json`'s `bundle.resources` mapping).
pub fn resource_locales_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(
    app
      .path()
      .resource_dir()
      .map_err(|e| e.to_string())?
      .join("locales"),
  )
}

/// Copy every `*.json` seed from `resource_dir` into `data_dir`, but only when
/// `data_dir` does not yet exist. A fresh install gets the bundled data locales;
/// once the locales dir exists (even emptied by the user deleting every data
/// locale), seeding never runs again, so deleted locales stay deleted. The
/// three compiled locales are unaffected either way — they are never files.
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

/// Load `data_dir` and sort by `order` then `id` for a stable menu order.
pub fn list_sorted(data_dir: &Path) -> Result<Loaded<LocaleData>, String> {
  let mut loaded = load_dir(data_dir)?;
  loaded
    .items
    .sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
  Ok(loaded)
}

/// Whether a bundled seed json exists for `id` in `resource_dir` — the
/// `isDefault` flag `list_locales` reports and the source `restore_default`
/// reads from.
fn has_default_seed(resource_dir: &Path, id: &str) -> bool {
  resource_dir.join(format!("{id}.json")).is_file()
}

/// Load `data_dir` in menu order and annotate each locale with whether a
/// bundled seed exists for its id (i.e. whether it can be restored).
pub fn list_with_defaults(
  data_dir: &Path,
  resource_dir: &Path,
) -> Result<Loaded<LocaleListItem>, String> {
  let loaded = list_sorted(data_dir)?;
  Ok(Loaded {
    items: loaded
      .items
      .into_iter()
      .map(|locale| {
        let is_default = has_default_seed(resource_dir, &locale.id);
        LocaleListItem { locale, is_default }
      })
      .collect(),
    skipped: loaded.skipped,
  })
}

/// Validate then atomically write one locale to `<dir>/{id}.json`. Every id is
/// writable, including a compiled locale's — that file shadows the compiled
/// dictionary rather than replacing it, and deleting it restores the shipped
/// strings.
fn save_locale_to(dir: &Path, locale: &LocaleData) -> Result<(), String> {
  validate(locale)?;
  let json = serde_json::to_string_pretty(locale).map_err(|e| e.to_string())?;
  write_text_atomic(&locale_file(dir, &locale.id), &json)
}

/// Overwrite `<data_dir>/{id}.json` with the bundled seed for `id`, undoing any
/// edits (including the customized label) or the deletion of that one locale.
fn restore_default_from(
  resource_dir: &Path,
  data_dir: &Path,
  id: &str,
) -> Result<LocaleData, String> {
  if !valid_id(id) {
    return Err(format!("invalid locale id: {id}"));
  }
  let text = std::fs::read_to_string(resource_dir.join(format!("{id}.json")))
    .map_err(|e| format!("no default locale for id {id}: {e}"))?;
  let locale = parse_locale(&text)?;
  save_locale_to(data_dir, &locale)?;
  Ok(locale)
}

/// Seed the app-data `locales` dir from the bundled resources on first run.
/// Called once from setup, before any locale command touches the dir.
pub fn seed_on_startup(app: &AppHandle) -> Result<(), String> {
  seed_defaults_if_missing(&resource_locales_dir(app)?, &app_data_locales_dir(app)?)
}

#[tauri::command]
pub fn list_locales(app: AppHandle) -> Result<Loaded<LocaleListItem>, String> {
  list_with_defaults(&locales_dir(&app)?, &resource_locales_dir(&app)?)
}

/// Persist an edited locale (the locale editor's per-keystroke save, debounced
/// on the frontend). The whole `strings` map is replaced, so a key the frontend
/// dropped (an emptied field) disappears and falls back to English again.
/// Off the UI thread: called only on an explicit editor save (never debounced,
/// see the doc comment above), so there is at most one in-flight call and
/// nothing to reorder.
#[tauri::command(async)]
pub fn save_locale(app: AppHandle, locale: LocaleData) -> Result<(), String> {
  save_locale_to(&locales_dir(&app)?, &locale)?;
  let _ = app.emit("locales-changed", ());
  Ok(())
}

/// Restore a bundled locale to its shipped strings and label. Only valid for
/// locales whose id has a seed (`isDefault`).
#[tauri::command]
pub fn restore_default_locale(app: AppHandle, id: String) -> Result<LocaleData, String> {
  let locale = restore_default_from(&resource_locales_dir(&app)?, &locales_dir(&app)?, &id)?;
  let _ = app.emit("locales-changed", ());
  Ok(locale)
}

#[tauri::command]
pub fn delete_locale(app: AppHandle, id: String) -> Result<(), String> {
  delete_locale_file(&locales_dir(&app)?, &id)?;
  let _ = app.emit("locales-changed", ());
  Ok(())
}

#[tauri::command]
pub fn import_locale(app: AppHandle, path: String) -> Result<LocaleData, String> {
  let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
  let locale = parse_locale(&text)?;
  validate(&locale)?;
  // Write the imported file's own text (not a re-serialization) so the author's
  // formatting and key order survive the round-trip into the data dir.
  write_text_atomic(&locale_file(&locales_dir(&app)?, &locale.id), &text)?;
  let _ = app.emit("locales-changed", ());
  Ok(locale)
}

/// Read and validate a locale file *without* installing it — the source for
/// "update from JSON", where the caller merges the file's strings into the
/// locale currently open in the editor instead of adding a new language.
#[tauri::command]
pub fn read_locale_file(path: String) -> Result<LocaleData, String> {
  let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
  let locale = parse_locale(&text)?;
  validate(&locale)?;
  Ok(locale)
}

#[tauri::command]
pub fn export_locale(locale: LocaleData, path: String) -> Result<(), String> {
  validate(&locale)?;
  let json = serde_json::to_string_pretty(&locale).map_err(|e| e.to_string())?;
  std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  fn locale(id: &str) -> LocaleData {
    let mut strings = BTreeMap::new();
    strings.insert(
      "settings.section.general".to_string(),
      "General".to_string(),
    );
    strings.insert("app.name".to_string(), "Note&Pad".to_string());
    LocaleData {
      id: id.into(),
      label: "Test Locale".into(),
      order: 0,
      strings,
    }
  }

  fn write_locale(dir: &Path, l: &LocaleData) {
    let json = serde_json::to_string_pretty(l).unwrap();
    std::fs::write(locale_file(dir, &l.id), json).unwrap();
  }

  #[test]
  fn load_dir_does_not_report_hidden_or_system_files() {
    let dir = tempdir().unwrap();
    write_locale(dir.path(), &locale("de"));
    for name in [".DS_Store", ".de.json.tmp", "Thumbs.db", "desktop.ini"] {
      std::fs::write(dir.path().join(name), "x").unwrap();
    }
    std::fs::create_dir(dir.path().join("a-folder")).unwrap();
    let loaded = load_dir(dir.path()).unwrap();
    assert_eq!(loaded.items, vec![locale("de")]);
    assert_eq!(loaded.skipped, Vec::new());
  }

  #[test]
  fn load_dir_reports_why_each_locale_was_skipped() {
    let dir = tempdir().unwrap();
    write_locale(dir.path(), &locale("de"));
    std::fs::write(dir.path().join("readme.txt"), "x").unwrap();
    // What a sync client leaves behind when it truncates a file mid-write: the
    // interface falls back to another language and nothing says a file is why.
    std::fs::write(dir.path().join("pirate.json"), "{\"id\":\"pir").unwrap();
    let loaded = load_dir(dir.path()).unwrap();
    assert_eq!(loaded.items, vec![locale("de")]);
    let mut reported: Vec<(String, SkipReason)> = loaded
      .skipped
      .into_iter()
      .map(|s| (s.name, s.reason))
      .collect();
    reported.sort();
    assert_eq!(
      reported,
      vec![
        ("pirate.json".to_string(), SkipReason::Unparsable),
        ("readme.txt".to_string(), SkipReason::NotJson),
      ]
    );
  }

  #[test]
  fn save_then_list_roundtrips() {
    let dir = tempdir().unwrap();
    write_locale(dir.path(), &locale("de"));
    assert_eq!(load_dir(dir.path()).unwrap().items, vec![locale("de")]);
  }

  #[test]
  fn validate_rejects_empty_label() {
    let mut l = locale("de");
    l.label = "  ".into();
    assert!(validate(&l).is_err());
  }

  #[test]
  fn validate_rejects_no_strings() {
    let mut l = locale("de");
    l.strings.clear();
    assert!(validate(&l).is_err());
  }

  #[test]
  fn validate_rejects_traversal_id() {
    let mut l = locale("de");
    l.id = "../evil".into();
    assert!(validate(&l).unwrap_err().contains("invalid locale id"));
  }

  #[test]
  fn delete_rejects_invalid_id() {
    let dir = tempdir().unwrap();
    assert!(delete_locale_file(dir.path(), "../evil")
      .unwrap_err()
      .contains("invalid locale id"));
  }

  #[test]
  fn delete_missing_file_is_noop() {
    let dir = tempdir().unwrap();
    delete_locale_file(dir.path(), "does-not-exist").unwrap();
  }

  #[test]
  fn list_sorts_by_order_then_id() {
    let dir = tempdir().unwrap();
    let mut a = locale("a");
    a.order = 1;
    let mut b = locale("b");
    b.order = 1;
    let mut z = locale("z");
    z.order = 0;
    write_locale(dir.path(), &a);
    write_locale(dir.path(), &b);
    write_locale(dir.path(), &z);
    let ids: Vec<String> = list_sorted(dir.path())
      .unwrap()
      .items
      .into_iter()
      .map(|l| l.id)
      .collect();
    assert_eq!(ids, vec!["z", "a", "b"]);
  }

  #[test]
  fn list_skips_one_bad_file_but_keeps_the_rest() {
    let dir = tempdir().unwrap();
    write_locale(dir.path(), &locale("good"));
    std::fs::write(dir.path().join("bad.json"), "{ not json").unwrap();
    std::fs::write(dir.path().join("notes.txt"), "ignored").unwrap();
    assert_eq!(load_dir(dir.path()).unwrap().items, vec![locale("good")]);
  }

  #[test]
  fn missing_dir_lists_empty() {
    let dir = tempdir().unwrap();
    assert!(load_dir(&dir.path().join("nope")).unwrap().items.is_empty());
  }

  #[test]
  fn save_locale_roundtrips_edited_strings() {
    let dir = tempdir().unwrap();
    let mut edited = locale("de");
    edited.label = "Deutsch (German)（自訂）".into();
    edited
      .strings
      .insert("settings.section.general".into(), "Allgemein".into());
    save_locale_to(dir.path(), &edited).unwrap();
    assert_eq!(load_dir(dir.path()).unwrap().items, vec![edited]);
  }

  #[test]
  fn save_locale_accepts_a_compiled_locale_id_as_an_override() {
    // Editing a built-in language writes a data file that shadows the compiled
    // dictionary; deleting that file restores the shipped strings.
    let dir = tempdir().unwrap();
    for id in ["en", "ja", "zh-TW"] {
      save_locale_to(dir.path(), &locale(id)).unwrap();
      assert!(dir.path().join(format!("{id}.json")).exists());
    }
    assert_eq!(load_dir(dir.path()).unwrap().items.len(), 3);
  }

  #[test]
  fn save_locale_drops_keys_the_editor_removed() {
    // Emptying a field removes the key entirely, so lookups fall back to English.
    let dir = tempdir().unwrap();
    let mut l = locale("de");
    l.strings.insert("extra.key".into(), "value".into());
    save_locale_to(dir.path(), &l).unwrap();
    l.strings.remove("extra.key");
    save_locale_to(dir.path(), &l).unwrap();
    let loaded = load_dir(dir.path()).unwrap().items;
    assert!(!loaded[0].strings.contains_key("extra.key"));
  }

  #[test]
  fn list_with_defaults_marks_seeded_locales() {
    let data = tempdir().unwrap();
    let resources = tempdir().unwrap();
    write_locale(data.path(), &locale("de"));
    write_locale(data.path(), &locale("pirate"));
    write_locale(resources.path(), &locale("de"));
    let listed = list_with_defaults(data.path(), resources.path())
      .unwrap()
      .items;
    let de = listed.iter().find(|i| i.locale.id == "de").unwrap();
    let pirate = listed.iter().find(|i| i.locale.id == "pirate").unwrap();
    assert!(de.is_default);
    assert!(!pirate.is_default);
  }

  #[test]
  fn restore_default_overwrites_edits_from_resource_dir() {
    let data = tempdir().unwrap();
    let resources = tempdir().unwrap();
    let original = locale("de");
    write_locale(resources.path(), &original);
    let mut edited = original.clone();
    edited.label = "Deutsch（自訂）".into();
    edited
      .strings
      .insert("settings.section.general".into(), "hand edited".into());
    save_locale_to(data.path(), &edited).unwrap();
    let restored = restore_default_from(resources.path(), data.path(), "de").unwrap();
    assert_eq!(restored, original);
    assert_eq!(load_dir(data.path()).unwrap().items, vec![original]);
  }

  #[test]
  fn restore_default_errs_when_no_seed_for_id() {
    let data = tempdir().unwrap();
    let resources = tempdir().unwrap();
    assert!(restore_default_from(resources.path(), data.path(), "pirate").is_err());
  }

  #[test]
  fn seed_copies_resources_only_when_data_dir_missing() {
    let base = tempdir().unwrap();
    let resources = base.path().join("resources");
    let data = base.path().join("data");
    std::fs::create_dir_all(&resources).unwrap();
    write_locale(&resources, &locale("de"));
    seed_defaults_if_missing(&resources, &data).unwrap();
    assert_eq!(load_dir(&data).unwrap().items, vec![locale("de")]);
    // Delete the seeded locale, then confirm seeding never runs again.
    delete_locale_file(&data, "de").unwrap();
    seed_defaults_if_missing(&resources, &data).unwrap();
    assert!(load_dir(&data).unwrap().items.is_empty());
  }

  #[test]
  fn seed_does_not_overwrite_existing_data() {
    let base = tempdir().unwrap();
    let resources = base.path().join("resources");
    let data = base.path().join("data");
    std::fs::create_dir_all(&resources).unwrap();
    write_locale(&resources, &locale("de"));
    let mut edited = locale("de");
    edited.label = "Edited".into();
    std::fs::create_dir_all(&data).unwrap();
    write_locale(&data, &edited);
    seed_defaults_if_missing(&resources, &data).unwrap();
    assert_eq!(load_dir(&data).unwrap().items, vec![edited]);
  }
}
