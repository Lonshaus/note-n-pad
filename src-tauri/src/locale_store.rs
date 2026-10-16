// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::fs_ops::{is_ignored_file, write_text_atomic, Loaded, SkipReason, SkippedFile};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
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
/// Manifest of the seed keys already offered to each data locale, so a key the
/// user later emptied is never added back. Dot-prefixed: `load_dir` skips it.
const SEEDED_KEYS_FILE: &str = ".seeded-keys.json";

type SeededKeys = BTreeMap<String, BTreeSet<String>>;
/// Add seed keys that an existing data file lacks and that no earlier merge
/// offered. Existing values, label, order, extra keys, missing and unparsable
/// files are never touched. A manifest entry only grows for a file that parsed
/// and was either complete or written, so a failed file is retried next run.
pub fn merge_new_seed_keys(resource_dir: &Path, data_dir: &Path) {
  let Ok(entries) = std::fs::read_dir(resource_dir) else {
    return;
  };
  let manifest_path = data_dir.join(SEEDED_KEYS_FILE);
  let stored: SeededKeys = std::fs::read_to_string(&manifest_path)
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default();
  let mut manifest = stored.clone();
  for entry in entries.flatten() {
    let path = entry.path();
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
      continue;
    }
    let Some(id) = path.file_stem().and_then(|n| n.to_str()) else {
      continue;
    };
    if !valid_id(id) {
      continue;
    }
    let Some(seed) = std::fs::read_to_string(&path)
      .ok()
      .and_then(|text| parse_locale(&text).ok())
    else {
      continue;
    };
    let Some(mut data) = std::fs::read_to_string(locale_file(data_dir, id))
      .ok()
      .and_then(|text| parse_locale(&text).ok())
    else {
      continue;
    };
    let offered = stored.get(id);
    let mut added = false;
    for (key, value) in &seed.strings {
      if !data.strings.contains_key(key) && !offered.is_some_and(|set| set.contains(key)) {
        data.strings.insert(key.clone(), value.clone());
        added = true;
      }
    }
    if added {
      if data.id != id {
        continue;
      }
      if let Err(e) = save_locale_to(data_dir, &data) {
        log::warn!("failed to merge new keys into locale {id}: {e}");
        continue;
      }
    }
    manifest
      .entry(id.to_string())
      .or_default()
      .extend(seed.strings.keys().cloned());
  }
  if manifest != stored {
    let result = serde_json::to_string_pretty(&manifest)
      .map_err(|e| e.to_string())
      .and_then(|json| write_text_atomic(&manifest_path, &json));
    if let Err(e) = result {
      log::warn!("failed to write {SEEDED_KEYS_FILE}: {e}");
    }
  }
}
/// (locale id, key, old shipped value) for every string reworded to read
/// correctly for any count. A data-folder value that still equals the old
/// shipped value is replaced; anything the user edited is never touched.
const REWORDED: &[(&str, &str, &str)] = &[
  ("en", "skipped.heading", "{count} files could not be loaded"),
  ("en", "skipped.snapshotHeading", "{count} sticky or document snapshots could not be loaded"),
  ("en", "settings.general.snapshotMoveBody", "The current folder has {count} sticky notes and unsaved document content. If you don't move them, they won't show up in Note&Pad anymore — they'll stay in the original folder."),
  ("en", "settings.general.snapshotCollisionTitle", "The chosen folder already has {count} matching snapshots"),
  ("en", "large.range.info", "Lines {start}–{end} ({count} lines, ~{size})"),
  ("en", "large.search.results", "{count} results"),
  ("en", "status.indexing", "Indexing… {count} lines"),
  ("en", "status.lines", "{count} lines"),
  ("en", "doc.restoreUnreadable", "Couldn’t read {names}. Open them again to continue."),
  ("de", "skipped.heading", "{count} Dateien konnten nicht geladen werden"),
  ("de", "skipped.snapshotHeading", "{count} Notiz- oder Dokument-Sicherungen konnten nicht geladen werden"),
  ("de", "settings.general.snapshotCollisionTitle", "Der ausgewählte Ordner enthält bereits {count} gleiche Schnappschüsse"),
  ("de", "large.range.info", "Zeilen {start}–{end} ({count} Zeilen, ca. {size})"),
  ("de", "large.search.results", "{count} Ergebnisse"),
  ("de", "status.indexing", "Indizierung… {count} Zeilen"),
  ("de", "status.lines", "{count} Zeilen"),
  ("de", "doc.restoreUnreadable", "{names} konnte nicht gelesen werden. Öffne die Dateien erneut, um fortzufahren."),
  ("fr", "skipped.heading", "{count} fichiers n’ont pas pu être chargés"),
  ("fr", "skipped.snapshotHeading", "{count} instantanés de notes ou de documents n’ont pas pu être chargés"),
  ("fr", "settings.general.snapshotMoveBody", "Le dossier actuel contient {count} pense-bêtes et du contenu de document non enregistré. Si vous ne les déplacez pas, ils n'apparaîtront plus dans Note&Pad et resteront uniquement dans le dossier d'origine."),
  ("fr", "settings.general.snapshotCollisionTitle", "Le dossier choisi contient déjà {count} instantanés identiques"),
  ("fr", "large.range.info", "Lignes {start}–{end} ({count} lignes, ~{size})"),
  ("fr", "large.search.results", "{count} résultats"),
  ("fr", "status.indexing", "Indexation… {count} lignes"),
  ("fr", "status.lines", "{count} lignes"),
  ("fr", "doc.restoreUnreadable", "Impossible de lire {names}. Rouvrez les fichiers pour continuer."),
  ("es", "skipped.heading", "No se pudieron cargar {count} archivos"),
  ("es", "skipped.snapshotHeading", "No se pudieron cargar {count} instantáneas de notas o documentos"),
  ("es", "settings.general.snapshotMoveBody", "La carpeta actual tiene {count} notas adhesivas y contenido de documentos sin guardar. Si no las mueve, dejarán de aparecer en Note&Pad y solo permanecerán en la carpeta original."),
  ("es", "settings.general.snapshotCollisionTitle", "La carpeta seleccionada ya tiene {count} instantáneas iguales"),
  ("es", "large.range.info", "Líneas {start}–{end} ({count} líneas, ~{size})"),
  ("es", "large.search.searching", "Buscando… {count} encontrados"),
  ("es", "large.search.results", "{count} resultados"),
  ("es", "status.indexing", "Indexando… {count} líneas"),
  ("es", "status.lines", "{count} líneas"),
  ("es", "doc.restoreUnreadable", "No se pudo leer {names}. Ábrelos de nuevo para continuar."),
  ("it", "skipped.snapshotHeading", "Non è stato possibile caricare {count} istantanee di note o documenti"),
  ("it", "settings.general.snapshotCollisionTitle", "La cartella scelta contiene già {count} snapshot identici"),
  ("it", "large.range.info", "Righe {start}–{end} ({count} righe, ~{size})"),
  ("it", "large.search.searching", "Ricerca in corso… {count} trovati"),
  ("it", "large.search.results", "{count} risultati"),
  ("it", "status.indexing", "Indicizzazione… {count} righe"),
  ("it", "status.lines", "{count} righe"),
  ("it", "doc.restoreUnreadable", "Impossibile leggere {names}. Riaprili per continuare."),
  ("pt-BR", "skipped.heading", "Não foi possível carregar {count} arquivos"),
  ("pt-BR", "skipped.snapshotHeading", "Não foi possível carregar {count} instantâneos de notas ou documentos"),
  ("pt-BR", "settings.general.snapshotMoveBody", "A pasta atual tem {count} notas adesivas e conteúdo de documentos não salvo. Se você não movê-las, elas deixarão de aparecer no Note&Pad e permanecerão apenas na pasta original."),
  ("pt-BR", "settings.general.snapshotCollisionTitle", "A pasta escolhida já tem {count} instantâneos iguais"),
  ("pt-BR", "large.range.info", "Linhas {start}–{end} ({count} linhas, ~{size})"),
  ("pt-BR", "large.search.searching", "Pesquisando… {count} encontrados"),
  ("pt-BR", "large.search.results", "{count} resultados"),
  ("pt-BR", "status.indexing", "Indexando… {count} linhas"),
  ("pt-BR", "status.lines", "{count} linhas"),
  ("pt-BR", "doc.restoreUnreadable", "Não foi possível ler {names}. Abra os arquivos novamente para continuar."),
  ("ru", "settings.general.snapshotMoveBody", "В текущей папке находится {count} стикеров и несохранённое содержимое документов. Если их не переместить, они больше не будут отображаться в Note&Pad и останутся только в исходной папке."),
  ("ru", "settings.general.snapshotCollisionTitle", "В выбранной папке уже есть {count} таких же снимков"),
  ("ru", "large.range.info", "Строки {start}–{end} ({count} строк, ~{size})"),
  ("ru", "status.indexing", "Индексирование… {count} строк"),
  ("ru", "doc.restoreUnreadable", "Не удалось прочитать: {names}. Откройте файлы снова, чтобы продолжить."),
  ("pl", "settings.general.snapshotMoveBody", "Bieżący folder zawiera {count} karteczek i niezapisaną zawartość dokumentów. Jeśli ich nie przeniesiesz, nie będą już widoczne w Note&Pad i pozostaną tylko w pierwotnym folderze."),
  ("pl", "settings.general.snapshotCollisionTitle", "Wybrany folder zawiera już {count} takich samych migawek"),
  ("pl", "large.range.info", "Wiersze {start}–{end} ({count} wierszy, ~{size})"),
  ("pl", "status.indexing", "Indeksowanie… {count} wierszy"),
  ("pl", "status.lines", "{count} wierszy"),
  ("pl", "doc.restoreUnreadable", "Nie można odczytać: {names}. Otwórz pliki ponownie, aby kontynuować."),
  ("tr", "doc.restoreUnreadable", "{names} okunamadı. Devam etmek için dosyaları yeniden açın."),
  ("vi", "doc.restoreUnreadable", "Không đọc được {names}. Hãy mở lại các tệp để tiếp tục."),
];
/// Replace unedited old shipped values with the new ones. A locale with a
/// bundled seed gets the seed value. A compiled locale (no seed) has the key
/// removed from its data file so lookup falls through to the compiled string.
pub fn update_reworded_values(resource_dir: &Path, data_dir: &Path) {
  update_reworded_with(REWORDED, resource_dir, data_dir);
}

fn update_reworded_with(table: &[(&str, &str, &str)], resource_dir: &Path, data_dir: &Path) {
  let ids: BTreeSet<&str> = table.iter().map(|(id, _, _)| *id).collect();
  for id in ids {
    if !valid_id(id) {
      continue;
    }
    let Some(mut data) = std::fs::read_to_string(locale_file(data_dir, id))
      .ok()
      .and_then(|text| parse_locale(&text).ok())
    else {
      continue;
    };
    if data.id != id {
      continue;
    }
    let seed = std::fs::read_to_string(locale_file(resource_dir, id))
      .ok()
      .and_then(|text| parse_locale(&text).ok());
    let mut changed = false;
    for (_, key, old) in table.iter().filter(|(i, _, _)| *i == id) {
      if data.strings.get(*key).map(String::as_str) != Some(*old) {
        continue;
      }
      match &seed {
        Some(seed) => match seed.strings.get(*key) {
          Some(new) if new != old => {
            data.strings.insert((*key).to_string(), new.clone());
            changed = true;
          }
          _ => {}
        },
        None => {
          data.strings.remove(*key);
          changed = true;
        }
      }
    }
    if changed {
      if let Err(e) = save_locale_to(data_dir, &data) {
        log::warn!("failed to update reworded strings in locale {id}: {e}");
      }
    }
  }
}
/// Seed the app-data `locales` dir from the bundled resources on first run,
/// then fold in seed keys added by later releases.
/// Called once from setup, before any locale command touches the dir.
pub fn seed_on_startup(app: &AppHandle) -> Result<(), String> {
  let resource_dir = resource_locales_dir(app)?;
  let data_dir = app_data_locales_dir(app)?;
  seed_defaults_if_missing(&resource_dir, &data_dir)?;
  merge_new_seed_keys(&resource_dir, &data_dir);
  update_reworded_values(&resource_dir, &data_dir);
  Ok(())
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

/// The locales compiled into the app. Deleting the data file of one of them only
/// drops its override, which is how "restore" works for it, so lite allows
/// that and nothing else.
const COMPILED_LOCALES: [&str; 3] = ["zh-TW", "ja", "en"];

/// What lite leaves of `delete_locale`: dropping a compiled locale's override.
/// Deleting any other locale is a removed feature.
fn delete_allowed(lite: bool, id: &str) -> Result<(), String> {
  if COMPILED_LOCALES.contains(&id) {
    return Ok(());
  }
  crate::edition::refuse_if(lite, "deleting a language")
}

#[tauri::command]
pub fn delete_locale(app: AppHandle, id: String) -> Result<(), String> {
  delete_allowed(crate::edition::is_lite(), &id)?;
  delete_locale_file(&locales_dir(&app)?, &id)?;
  let _ = app.emit("locales-changed", ());
  Ok(())
}

#[cfg(not(feature = "lite"))]
#[tauri::command]
pub fn import_locale(app: AppHandle, path: String) -> Result<LocaleData, String> {
  crate::edition::require_full("importing a language")?;
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
#[cfg(not(feature = "lite"))]
#[tauri::command]
pub fn read_locale_file(path: String) -> Result<LocaleData, String> {
  crate::edition::require_full("importing a language")?;
  let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
  let locale = parse_locale(&text)?;
  validate(&locale)?;
  Ok(locale)
}

#[cfg(not(feature = "lite"))]
#[tauri::command]
pub fn export_locale(locale: LocaleData, path: String) -> Result<(), String> {
  crate::edition::require_full("exporting a language")?;
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
  fn lite_deletes_a_compiled_locales_override_and_nothing_else() {
    for id in ["en", "ja", "zh-TW"] {
      assert!(delete_allowed(true, id).is_ok(), "{id}");
    }
    for id in ["de", "zh-CN", "mine"] {
      assert!(delete_allowed(true, id).is_err(), "{id}");
      assert!(delete_allowed(false, id).is_ok(), "{id}");
    }
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

  fn locale_with(id: &str, pairs: &[(&str, &str)]) -> LocaleData {
    LocaleData {
      id: id.into(),
      label: format!("{id} label"),
      order: 3,
      strings: pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect(),
    }
  }

  fn read_locale(dir: &Path, id: &str) -> LocaleData {
    parse_locale(&std::fs::read_to_string(locale_file(dir, id)).unwrap()).unwrap()
  }

  fn manifest_of(dir: &Path) -> SeededKeys {
    serde_json::from_str(&std::fs::read_to_string(dir.join(SEEDED_KEYS_FILE)).unwrap()).unwrap()
  }

  fn keys(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|k| k.to_string()).collect()
  }

  #[test]
  fn merge_adds_missing_keys_and_keeps_edits() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    std::fs::create_dir_all(&res).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    write_locale(
      &res,
      &locale_with("de", &[("a", "A seed"), ("b", "B seed"), ("c", "C seed")]),
    );
    let mut old = locale_with("de", &[("a", "A edited"), ("extra", "mine")]);
    old.label = "Deutsch (custom)".into();
    old.order = 9;
    write_locale(&data, &old);
    merge_new_seed_keys(&res, &data);
    let merged = read_locale(&data, "de");
    assert_eq!(merged.strings["a"], "A edited");
    assert_eq!(merged.strings["b"], "B seed");
    assert_eq!(merged.strings["c"], "C seed");
    assert_eq!(merged.strings["extra"], "mine");
    assert_eq!(merged.label, "Deutsch (custom)");
    assert_eq!(merged.order, 9);
    assert_eq!(manifest_of(&data)["de"], keys(&["a", "b", "c"]));
  }

  #[test]
  fn merge_does_not_rewrite_when_nothing_is_new() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    std::fs::create_dir_all(&res).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    write_locale(&res, &locale_with("de", &[("a", "A"), ("b", "B")]));
    // Hand-formatted, not what save_locale_to would produce.
    let hand = "{\"id\":\"de\",\"label\":\"D\",\"strings\":{\"a\":\"x\",\"b\":\"y\"}}";
    std::fs::write(locale_file(&data, "de"), hand).unwrap();
    merge_new_seed_keys(&res, &data);
    assert_eq!(
      std::fs::read_to_string(locale_file(&data, "de")).unwrap(),
      hand
    );
    let manifest_before = std::fs::read(data.join(SEEDED_KEYS_FILE)).unwrap();
    merge_new_seed_keys(&res, &data);
    assert_eq!(
      std::fs::read_to_string(locale_file(&data, "de")).unwrap(),
      hand
    );
    assert_eq!(
      std::fs::read(data.join(SEEDED_KEYS_FILE)).unwrap(),
      manifest_before
    );
  }

  #[test]
  fn merge_does_not_readd_a_key_the_user_emptied() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    std::fs::create_dir_all(&res).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    write_locale(&res, &locale_with("de", &[("a", "A"), ("b", "B")]));
    write_locale(&data, &locale_with("de", &[("a", "A")]));
    merge_new_seed_keys(&res, &data);
    assert!(read_locale(&data, "de").strings.contains_key("b"));
    let mut emptied = read_locale(&data, "de");
    emptied.strings.remove("b");
    save_locale_to(&data, &emptied).unwrap();
    merge_new_seed_keys(&res, &data);
    assert!(!read_locale(&data, "de").strings.contains_key("b"));
  }

  #[test]
  fn merge_leaves_missing_unparsable_and_unseeded_files_alone() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    std::fs::create_dir_all(&res).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    write_locale(&res, &locale_with("de", &[("a", "A")]));
    write_locale(&res, &locale_with("fr", &[("a", "A")]));
    // de: deleted. fr: unparsable. pirate: user-made, no seed.
    std::fs::write(locale_file(&data, "fr"), "{ not json").unwrap();
    let pirate = locale_with("pirate", &[("z", "Z")]);
    write_locale(&data, &pirate);
    let pirate_bytes = std::fs::read(locale_file(&data, "pirate")).unwrap();
    merge_new_seed_keys(&res, &data);
    assert!(!locale_file(&data, "de").exists());
    assert_eq!(
      std::fs::read_to_string(locale_file(&data, "fr")).unwrap(),
      "{ not json"
    );
    assert_eq!(
      std::fs::read(locale_file(&data, "pirate")).unwrap(),
      pirate_bytes
    );
    assert!(!data.join(SEEDED_KEYS_FILE).exists());
  }

  #[test]
  fn merge_treats_an_unparsable_manifest_as_absent() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    std::fs::create_dir_all(&res).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    write_locale(&res, &locale_with("de", &[("a", "A"), ("b", "B")]));
    write_locale(&data, &locale_with("de", &[("a", "A")]));
    std::fs::write(data.join(SEEDED_KEYS_FILE), "garbage").unwrap();
    merge_new_seed_keys(&res, &data);
    assert!(read_locale(&data, "de").strings.contains_key("b"));
    assert_eq!(manifest_of(&data)["de"], keys(&["a", "b"]));
  }

  #[cfg(unix)]
  #[test]
  fn merge_failure_does_not_extend_the_manifest_and_is_retried() {
    use std::os::unix::fs::PermissionsExt;
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    std::fs::create_dir_all(&res).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    write_locale(&res, &locale_with("de", &[("a", "A"), ("b", "B")]));
    write_locale(&res, &locale_with("fr", &[("a", "A"), ("b", "B")]));
    write_locale(&data, &locale_with("de", &[("a", "A")]));
    write_locale(&data, &locale_with("fr", &[("a", "A")]));
    let de_file = locale_file(&data, "de");
    std::fs::set_permissions(&de_file, std::fs::Permissions::from_mode(0o444)).unwrap();
    if std::fs::OpenOptions::new()
      .write(true)
      .open(&de_file)
      .is_ok()
    {
      // Permission bits are not enforced (running as root): nothing to exercise.
      return;
    }
    // fr: unparsable on the first run.
    let fr_good = std::fs::read_to_string(locale_file(&data, "fr")).unwrap();
    std::fs::write(locale_file(&data, "fr"), "{ not json").unwrap();
    merge_new_seed_keys(&res, &data);
    let manifest = std::fs::read_to_string(data.join(SEEDED_KEYS_FILE));
    assert!(manifest.is_err() || !manifest.unwrap().contains("\"de\""));
    std::fs::set_permissions(&de_file, std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::write(locale_file(&data, "fr"), fr_good).unwrap();
    merge_new_seed_keys(&res, &data);
    assert!(read_locale(&data, "de").strings.contains_key("b"));
    assert!(read_locale(&data, "fr").strings.contains_key("b"));
    assert_eq!(manifest_of(&data)["de"], keys(&["a", "b"]));
    assert_eq!(manifest_of(&data)["fr"], keys(&["a", "b"]));
  }

  #[test]
  fn merge_after_fresh_seed_records_keys_so_later_removal_sticks() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    std::fs::create_dir_all(&res).unwrap();
    write_locale(&res, &locale_with("de", &[("a", "A"), ("b", "B")]));
    seed_defaults_if_missing(&res, &data).unwrap();
    merge_new_seed_keys(&res, &data);
    assert_eq!(manifest_of(&data)["de"], keys(&["a", "b"]));
    let mut cut = read_locale(&data, "de");
    cut.strings.remove("b");
    save_locale_to(&data, &cut).unwrap();
    write_locale(
      &res,
      &locale_with("de", &[("a", "A"), ("b", "B"), ("c", "C")]),
    );
    merge_new_seed_keys(&res, &data);
    let merged = read_locale(&data, "de");
    assert!(!merged.strings.contains_key("b"));
    assert_eq!(merged.strings["c"], "C");
  }

  #[test]
  fn merge_overwrites_nothing_when_edited_value_differs_from_seed() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    std::fs::create_dir_all(&res).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    write_locale(&res, &locale_with("de", &[("a", "seed"), ("b", "B")]));
    write_locale(&data, &locale_with("de", &[("a", "edited")]));
    merge_new_seed_keys(&res, &data);
    assert_eq!(read_locale(&data, "de").strings["a"], "edited");
  }

  #[test]
  fn reworded_replaces_old_shipped_values_and_keeps_edits() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    std::fs::create_dir_all(&res).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let table = [
      ("de", "a", "old a"),
      ("de", "b", "old b"),
      ("de", "c", "old c"),
    ];
    write_locale(
      &res,
      &locale_with("de", &[("a", "new a"), ("b", "new b"), ("c", "new c")]),
    );
    write_locale(
      &data,
      &locale_with(
        "de",
        &[("a", "old a"), ("b", "my b"), ("c", "old c"), ("x", "mine")],
      ),
    );
    update_reworded_with(&table, &res, &data);
    let got = read_locale(&data, "de");
    assert_eq!(got.strings["a"], "new a");
    assert_eq!(got.strings["b"], "my b");
    assert_eq!(got.strings["c"], "new c");
    assert_eq!(got.strings["x"], "mine");
    let before = std::fs::read_to_string(locale_file(&data, "de")).unwrap();
    update_reworded_with(&table, &res, &data);
    assert_eq!(
      std::fs::read_to_string(locale_file(&data, "de")).unwrap(),
      before
    );
  }

  #[test]
  fn reworded_removes_old_values_from_a_compiled_locale_file() {
    let base = tempdir().unwrap();
    let (res, data) = (base.path().join("res"), base.path().join("data"));
    std::fs::create_dir_all(&res).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let table = [("en", "a", "old a"), ("en", "b", "old b")];
    write_locale(
      &data,
      &locale_with("en", &[("a", "old a"), ("b", "my b"), ("c", "mine")]),
    );
    update_reworded_with(&table, &res, &data);
    let got = read_locale(&data, "en");
    assert!(!got.strings.contains_key("a"));
    assert_eq!(got.strings["b"], "my b");
    assert_eq!(got.strings["c"], "mine");
  }

  #[test]
  fn reworded_table_matches_the_bundled_seeds() {
    let res = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/locales");
    for (id, key, old) in REWORDED {
      if let Ok(text) = std::fs::read_to_string(locale_file(&res, id)) {
        let seed = parse_locale(&text).unwrap();
        let new = &seed.strings[*key];
        assert_ne!(new, old, "{id} {key} still holds the old value");
      }
    }
  }
}
