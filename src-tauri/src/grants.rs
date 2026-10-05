// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Keeps the sandboxed build's file and folder grants across relaunch.
//!
//! A grant from Finder or an open panel lasts only for the process that got it.
//! Every path the app persists (open tabs, recent files, project roots) gets a
//! security-scoped bookmark in `grants.json`, resolved once at the next launch.
//! Unsandboxed builds read paths directly, so there everything here is a no-op.

use crate::note_store::NoteSnapshot;
use crate::settings::AppSettings;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};

const FILE_NAME: &str = "grants.json";
/// Upper bound on stored grants; the least recently used go first.
const MAX_ENTRIES: usize = 200;
/// A `last_used` bump is written out only when it moves at least this far, so
/// a tab's debounced snapshots do not rewrite the whole file each time.
const BUMP_PERSIST_SECS: u64 = 3600;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Entry {
  bookmark: String,
  last_used: u64,
}

type GrantMap = BTreeMap<String, Entry>;

struct State {
  /// `None` until `restore_all` loaded the file, and for the whole run when
  /// that failed, so nothing is ever written over a file that was not read.
  file: Option<PathBuf>,
  map: GrantMap,
  /// Entries whose bookmark did not resolve this launch.
  failed: BTreeSet<String>,
  /// Paths whose encode failure was already logged this launch.
  warned: BTreeSet<String>,
}

struct Grants {
  state: Mutex<State>,
  restored: Once,
}

static GRANTS: Grants = Grants::new();

/// Whether this process runs in the App Sandbox.
fn sandboxed() -> bool {
  cfg!(target_os = "macos") && std::env::var_os("APP_SANDBOX_CONTAINER_ID").is_some()
}

fn now() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

/// Record `path` (a file or folder the process can reach right now) so the next
/// launch can reach it too. Call it outside any store or settings lock.
pub fn remember(path: &str) {
  remember_in(&GRANTS, sandboxed(), path, now(), mac_bookmark_encode);
}

/// Resolve the stored grants once per process, dropping entries outside `prune`
/// when it is given. Must run before any window can read a restored path.
pub fn restore_all(app_data_dir: &Path, prune: Option<&HashSet<String>>) {
  if !sandboxed() {
    return;
  }
  GRANTS.restore_with(
    app_data_dir.join(FILE_NAME),
    prune,
    crate::mac_bookmark::to_path,
  );
}

fn mac_bookmark_encode(path: &Path) -> Result<String, String> {
  crate::mac_bookmark::try_encode(path)
}

fn remember_in(
  grants: &Grants,
  sandboxed: bool,
  path: &str,
  now: u64,
  encode: impl Fn(&Path) -> Result<String, String>,
) {
  if !sandboxed {
    return;
  }
  grants.remember_with(path, now, encode);
}

/// The paths still referenced after a clean startup load, or `None` when any
/// input may be incomplete, in which case nothing is pruned. Matching is by
/// exact string on both sides.
pub fn prune_set(
  store_load_ok: bool,
  fallback_active: bool,
  skipped_any: bool,
  settings_report: &Result<(AppSettings, Vec<String>), String>,
  notes: &[NoteSnapshot],
) -> Option<HashSet<String>> {
  if !store_load_ok || fallback_active || skipped_any {
    return None;
  }
  let (settings, repaired) = settings_report.as_ref().ok()?;
  if repaired
    .iter()
    .any(|f| f == "recent_files" || f == "project_roots")
  {
    return None;
  }
  let mut set = HashSet::new();
  for note in notes {
    for path in [&note.file_path, &note.project, &note.range_source]
      .into_iter()
      .flatten()
    {
      if !path.is_empty() {
        set.insert(path.clone());
      }
    }
  }
  set.extend(settings.recent_files.iter().cloned());
  set.extend(settings.project_roots.iter().cloned());
  Some(set)
}

/// Drop the least recently used entries beyond `MAX_ENTRIES`; ties go by key.
fn cap(map: &mut GrantMap) {
  if map.len() <= MAX_ENTRIES {
    return;
  }
  let mut order: Vec<(u64, String)> = map.iter().map(|(k, e)| (e.last_used, k.clone())).collect();
  order.sort();
  let excess = map.len() - MAX_ENTRIES;
  for (_, key) in order.into_iter().take(excess) {
    map.remove(&key);
  }
}

fn load(file: &Path) -> Result<GrantMap, String> {
  match std::fs::read_to_string(file) {
    Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_else(|e| {
      log::warn!(
        "grants: {} is not valid, starting empty: {e}",
        file.display()
      );
      GrantMap::new()
    })),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(GrantMap::new()),
    Err(e) => Err(e.to_string()),
  }
}

fn persist(state: &State) {
  let Some(file) = state.file.as_deref() else {
    return;
  };
  let result = serde_json::to_string(&state.map)
    .map_err(|e| e.to_string())
    .and_then(|json| crate::fs_ops::write_text_atomic_private(file, &json));
  if let Err(e) = result {
    log::warn!("grants: could not write {}: {e}", file.display());
  }
}

impl Grants {
  const fn new() -> Self {
    Grants {
      state: Mutex::new(State {
        file: None,
        map: BTreeMap::new(),
        failed: BTreeSet::new(),
        warned: BTreeSet::new(),
      }),
      restored: Once::new(),
    }
  }

  fn lock(&self) -> std::sync::MutexGuard<'_, State> {
    self.state.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn remember_with(&self, path: &str, now: u64, encode: impl Fn(&Path) -> Result<String, String>) {
    if path.is_empty() {
      return;
    }
    let mut state = self.lock();
    if state.file.is_none() {
      return;
    }
    if !state.failed.contains(path) {
      if let Some(entry) = state.map.get_mut(path) {
        let stale = now.saturating_sub(entry.last_used) >= BUMP_PERSIST_SECS;
        entry.last_used = entry.last_used.max(now);
        if stale {
          persist(&state);
        }
        return;
      }
    }
    match encode(Path::new(path)) {
      Ok(bookmark) => {
        state.map.insert(
          path.to_string(),
          Entry {
            bookmark,
            last_used: now,
          },
        );
        state.failed.remove(path);
        state.warned.remove(path);
        cap(&mut state.map);
        persist(&state);
      }
      Err(e) => {
        if state.warned.insert(path.to_string()) {
          log::warn!("grants: no bookmark for {path}: {e}");
        }
      }
    }
  }

  fn restore_with(
    &self,
    file: PathBuf,
    prune: Option<&HashSet<String>>,
    resolve: impl Fn(&str) -> Option<PathBuf>,
  ) {
    self.restored.call_once(|| {
      let mut state = self.lock();
      let map = match load(&file) {
        Ok(map) => map,
        Err(e) => {
          log::warn!("grants: could not read {}: {e}", file.display());
          return;
        }
      };
      state.map = map;
      state.file = Some(file);
      let before = state.map.len();
      if let Some(keep) = prune {
        state.map.retain(|path, _| keep.contains(path));
      }
      cap(&mut state.map);
      let failed: BTreeSet<String> = state
        .map
        .iter()
        .filter(|(_, entry)| resolve(&entry.bookmark).is_none())
        .map(|(path, _)| path.clone())
        .collect();
      state.failed = failed;
      if state.map.len() != before {
        persist(&state);
      }
      log::info!(
        "grants: {} entries restored, {} did not resolve, {} dropped",
        state.map.len() - state.failed.len(),
        state.failed.len(),
        before - state.map.len()
      );
    });
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::Cell;
  use tempfile::tempdir;

  fn ok_encode(path: &Path) -> Result<String, String> {
    Ok(format!("bm:{}", path.display()))
  }

  fn resolve_all(_: &str) -> Option<PathBuf> {
    Some(PathBuf::from("/resolved"))
  }

  fn entry(bookmark: &str, last_used: u64) -> Entry {
    Entry {
      bookmark: bookmark.to_string(),
      last_used,
    }
  }

  fn write_map(file: &Path, map: &GrantMap) {
    std::fs::write(file, serde_json::to_string(map).unwrap()).unwrap();
  }

  fn read_map(file: &Path) -> GrantMap {
    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
  }

  /// A `Grants` restored from `file` with every bookmark resolving.
  fn restored(file: &Path) -> Grants {
    let grants = Grants::new();
    grants.restore_with(file.to_path_buf(), None, resolve_all);
    grants
  }

  fn note(value: serde_json::Value) -> NoteSnapshot {
    serde_json::from_value(value).unwrap()
  }

  fn clean_settings() -> Result<(AppSettings, Vec<String>), String> {
    Ok((AppSettings::default(), Vec::new()))
  }

  #[test]
  fn the_map_round_trips_through_the_file() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    let grants = restored(&file);
    grants.remember_with("/a.txt", 10, ok_encode);
    grants.remember_with("/b", 20, ok_encode);
    let reloaded = load(&file).unwrap();
    assert_eq!(reloaded.get("/a.txt"), Some(&entry("bm:/a.txt", 10)));
    assert_eq!(reloaded.get("/b"), Some(&entry("bm:/b", 20)));
    assert_eq!(reloaded.len(), 2);
  }

  #[cfg(unix)]
  #[test]
  fn the_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let file = dir.path().join("data").join(FILE_NAME);
    let grants = restored(&file);
    grants.remember_with("/a.txt", 10, ok_encode);
    let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
  }

  #[test]
  fn an_empty_path_is_ignored() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    let grants = restored(&file);
    grants.remember_with("", 10, |_| panic!("an empty path must not be encoded"));
    assert!(!file.exists());
  }

  #[test]
  fn an_unsandboxed_remember_writes_nothing() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    let grants = restored(&file);
    remember_in(&grants, false, "/a.txt", 10, ok_encode);
    assert!(!file.exists());
    assert!(grants.lock().map.is_empty());
  }

  #[test]
  fn remember_before_restore_writes_nothing() {
    let dir = tempdir().unwrap();
    let grants = Grants::new();
    remember_in(&grants, true, "/a.txt", 10, ok_encode);
    assert!(grants.lock().map.is_empty());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
  }

  #[test]
  fn a_failed_encode_is_retried_on_the_next_remember() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    let grants = restored(&file);
    grants.remember_with("/a.txt", 10, |_| Err("no access".to_string()));
    assert!(!file.exists());
    let calls = Cell::new(0);
    grants.remember_with("/a.txt", 20, |p| {
      calls.set(calls.get() + 1);
      ok_encode(p)
    });
    assert_eq!(calls.get(), 1);
    assert_eq!(read_map(&file).get("/a.txt"), Some(&entry("bm:/a.txt", 20)));
  }

  #[test]
  fn a_live_entry_is_bumped_not_re_encoded() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    let grants = restored(&file);
    grants.remember_with("/a.txt", 10, ok_encode);
    grants.remember_with("/a.txt", 10 + BUMP_PERSIST_SECS, |_| {
      panic!("a resolved entry must not be re-encoded")
    });
    assert_eq!(
      read_map(&file).get("/a.txt"),
      Some(&entry("bm:/a.txt", 10 + BUMP_PERSIST_SECS))
    );
  }

  #[test]
  fn remember_replaces_an_entry_that_failed_this_launch() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    write_map(
      &file,
      &GrantMap::from([("/a.txt".into(), entry("dead", 5))]),
    );
    let grants = Grants::new();
    grants.restore_with(file.clone(), None, |_| None);
    grants.remember_with("/a.txt", 10, ok_encode);
    assert_eq!(read_map(&file).get("/a.txt"), Some(&entry("bm:/a.txt", 10)));
    // Fresh again, so a later call only bumps.
    grants.remember_with("/a.txt", 11, |_| panic!("must not re-encode"));
  }

  #[test]
  fn a_failed_entry_survives_a_failed_re_encode() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    write_map(
      &file,
      &GrantMap::from([("/a.txt".into(), entry("dead", 5))]),
    );
    let grants = Grants::new();
    grants.restore_with(file.clone(), None, |_| None);
    grants.remember_with("/a.txt", 10, |_| Err("no access".to_string()));
    assert_eq!(read_map(&file).get("/a.txt"), Some(&entry("dead", 5)));
  }

  #[test]
  fn two_threads_remembering_both_persist() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    let grants = restored(&file);
    std::thread::scope(|s| {
      s.spawn(|| grants.remember_with("/a.txt", 10, ok_encode));
      s.spawn(|| grants.remember_with("/b.txt", 10, ok_encode));
    });
    let map = read_map(&file);
    assert!(map.contains_key("/a.txt"));
    assert!(map.contains_key("/b.txt"));
  }

  #[test]
  fn restore_without_prune_keeps_every_entry() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    let stored = GrantMap::from([
      ("/a".into(), entry("ok", 1)),
      ("/b".into(), entry("dead", 2)),
    ]);
    write_map(&file, &stored);
    let grants = Grants::new();
    grants.restore_with(file.clone(), None, |b| {
      (b == "ok").then(|| PathBuf::from("/a"))
    });
    assert_eq!(grants.lock().map, stored);
    assert_eq!(read_map(&file), stored);
    assert!(grants.lock().failed.contains("/b"));
  }

  #[test]
  fn restore_with_prune_drops_unreferenced_entries() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    write_map(
      &file,
      &GrantMap::from([("/a".into(), entry("x", 1)), ("/b".into(), entry("y", 2))]),
    );
    let keep = HashSet::from(["/a".to_string()]);
    let grants = Grants::new();
    grants.restore_with(file.clone(), Some(&keep), resolve_all);
    assert_eq!(
      read_map(&file),
      GrantMap::from([("/a".into(), entry("x", 1))])
    );
  }

  #[test]
  fn restore_runs_once_per_process() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    write_map(&file, &GrantMap::from([("/a".into(), entry("x", 1))]));
    let grants = Grants::new();
    let calls = Cell::new(0);
    let resolve = |_: &str| {
      calls.set(calls.get() + 1);
      None
    };
    grants.restore_with(file.clone(), None, resolve);
    grants.restore_with(file.clone(), Some(&HashSet::new()), resolve);
    assert_eq!(calls.get(), 1);
    assert!(read_map(&file).contains_key("/a"));
  }

  #[test]
  fn an_unreadable_file_disables_writes_for_the_run() {
    let dir = tempdir().unwrap();
    // A directory where the file should be: exists, cannot be read as text.
    let file = dir.path().join(FILE_NAME);
    std::fs::create_dir(&file).unwrap();
    let grants = restored(&file);
    grants.remember_with("/a.txt", 10, ok_encode);
    assert!(file.is_dir());
    assert!(grants.lock().map.is_empty());
  }

  #[test]
  fn restore_caps_at_the_least_recently_used() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    let stored: GrantMap = (0..MAX_ENTRIES as u64 + 5)
      .map(|i| (format!("/f{i}"), entry("x", 1000 + i)))
      .collect();
    write_map(&file, &stored);
    let grants = Grants::new();
    grants.restore_with(file.clone(), None, resolve_all);
    let map = read_map(&file);
    assert_eq!(map.len(), MAX_ENTRIES);
    for i in 0..5 {
      assert!(!map.contains_key(&format!("/f{i}")));
    }
    assert!(map.contains_key("/f5"));
  }

  #[test]
  fn remember_past_the_cap_drops_the_least_recently_used() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    let stored: GrantMap = (0..MAX_ENTRIES as u64)
      .map(|i| (format!("/f{i}"), entry("x", 1000 + i)))
      .collect();
    write_map(&file, &stored);
    let grants = restored(&file);
    grants.remember_with("/new", 5000, ok_encode);
    let map = read_map(&file);
    assert_eq!(map.len(), MAX_ENTRIES);
    assert!(!map.contains_key("/f0"));
    assert!(map.contains_key("/new"));
  }

  #[test]
  fn prune_set_is_none_when_the_store_failed_to_load() {
    assert_eq!(prune_set(false, false, false, &clean_settings(), &[]), None);
  }

  #[test]
  fn prune_set_is_none_when_the_fallback_folder_is_active() {
    assert_eq!(prune_set(true, true, false, &clean_settings(), &[]), None);
  }

  #[test]
  fn prune_set_is_none_when_a_snapshot_was_skipped() {
    assert_eq!(prune_set(true, false, true, &clean_settings(), &[]), None);
  }

  #[test]
  fn prune_set_is_none_when_settings_could_not_be_read() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "not json").unwrap();
    let report = crate::settings::load_from_with_report(&path);
    assert!(report.is_err());
    assert_eq!(prune_set(true, false, false, &report, &[]), None);
  }

  #[test]
  fn prune_set_is_none_when_recent_files_was_repaired() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(
      &path,
      r#"{"recent_files": "oops", "project_roots": ["/p"]}"#,
    )
    .unwrap();
    let report = crate::settings::load_from_with_report(&path);
    assert_eq!(prune_set(true, false, false, &report, &[]), None);
  }

  #[test]
  fn prune_set_is_none_when_project_roots_was_repaired() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, r#"{"recent_files": ["/r"], "project_roots": 7}"#).unwrap();
    let report = crate::settings::load_from_with_report(&path);
    assert_eq!(prune_set(true, false, false, &report, &[]), None);
  }

  #[test]
  fn prune_set_ignores_repairs_to_unrelated_fields() {
    let report = Ok((AppSettings::default(), vec!["editor_font_size".to_string()]));
    assert_eq!(
      prune_set(true, false, false, &report, &[]),
      Some(HashSet::new())
    );
  }

  #[test]
  fn prune_set_collects_every_referenced_path_on_a_clean_load() {
    let dir = tempdir().unwrap();
    // Missing settings.json is a first run, not a failed read.
    let missing = crate::settings::load_from_with_report(&dir.path().join("settings.json"));
    let mut report = missing.unwrap();
    report.0.recent_files = vec!["/recent.txt".into()];
    report.0.project_roots = vec!["/root".into()];
    let notes = [
      note(serde_json::json!({"id": "d", "content": "", "file_path": "/doc.md"})),
      note(serde_json::json!({"id": "p", "content": "", "file_path": null, "project": "/proj"})),
      note(
        serde_json::json!({"id": "r", "content": "", "file_path": "", "range_source": "/big.log"}),
      ),
      note(serde_json::json!({"id": "s", "content": "sticky", "file_path": null})),
    ];
    let set = prune_set(true, false, false, &Ok(report), &notes).unwrap();
    let expected: HashSet<String> = ["/doc.md", "/proj", "/big.log", "/recent.txt", "/root"]
      .into_iter()
      .map(String::from)
      .collect();
    assert_eq!(set, expected);
  }

  #[test]
  fn pruning_matches_paths_as_exact_strings() {
    let dir = tempdir().unwrap();
    let file = dir.path().join(FILE_NAME);
    write_map(
      &file,
      &GrantMap::from([
        ("/root".into(), entry("x", 1)),
        ("/Doc.md".into(), entry("x", 1)),
        ("/a/./b.txt".into(), entry("x", 1)),
      ]),
    );
    let settings = AppSettings {
      project_roots: vec!["/root/".into()],
      ..AppSettings::default()
    };
    let notes = [
      note(serde_json::json!({"id": "d", "content": "", "file_path": "/doc.md"})),
      note(serde_json::json!({"id": "e", "content": "", "file_path": "/a/b.txt"})),
    ];
    let keep = prune_set(true, false, false, &Ok((settings, Vec::new())), &notes).unwrap();
    let grants = Grants::new();
    grants.restore_with(file.clone(), Some(&keep), resolve_all);
    assert!(read_map(&file).is_empty());
  }
}
