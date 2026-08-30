// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::fs_ops::{is_ignored_file, write_text_atomic_private, Loaded, SkipReason, SkippedFile};
use crate::mac_bookmark;
use crate::settings;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteSnapshot {
  pub id: String,
  pub content: String,
  pub file_path: Option<String>,
  #[serde(default)]
  pub language: Option<String>,
  /// Whether `language` was chosen by hand. False (the default for legacy
  /// files) lets restore re-detect from the filename; true keeps the stored
  /// language verbatim, including None which means a manual plain-text choice.
  #[serde(default)]
  pub explicit: bool,
  #[serde(default)]
  pub x: Option<f64>,
  #[serde(default)]
  pub y: Option<f64>,
  #[serde(default)]
  pub width: Option<f64>,
  #[serde(default)]
  pub height: Option<f64>,
  #[serde(default = "default_pin_mode")]
  pub pin_mode: String,
  #[serde(default)]
  pub pin_app: Option<String>,
  #[serde(default = "default_opacity")]
  pub opacity: f64,
  #[serde(default = "default_paper")]
  pub paper: String,
  #[serde(default = "default_kind")]
  pub kind: String,
  #[serde(default)]
  pub dirty: bool,
  /// Id shared by all tabs living in the same document window. None on legacy
  /// files and stickies; the restore path migrates a None document to a solo group.
  #[serde(default)]
  pub window_group: Option<String>,
  /// Position of this tab within its window, ordering tabs on restore.
  #[serde(default)]
  pub tab_index: i64,
  /// Line ending the file is written with ("LF" or "CRLF"). The buffer is LF.
  #[serde(default = "default_line_ending")]
  pub line_ending: String,
  /// Whether the file carried a UTF-8 BOM, preserved across save/restore.
  #[serde(default)]
  pub had_bom: bool,
  /// Text encoding the file is read/written with (e.g. "UTF-8", "Big5").
  #[serde(default = "default_encoding")]
  pub encoding: String,
  /// Project root this document tab was opened from, isolating tree-opens to
  /// one document window per project. None for stickies and projectless docs.
  #[serde(default)]
  pub project: Option<String>,
  /// File size of a read-only large-file tab, persisted so restore reopens it
  /// straight in the large-file view without re-stat. None for ordinary tabs.
  #[serde(default)]
  pub large: Option<u64>,
  /// Source file a range-edit tab was sliced from. Its presence marks the tab
  /// as a range tab on restore; the byte span and fingerprint below rebuild the
  /// splice write-back baseline. None for every non-range tab.
  #[serde(default)]
  pub range_source: Option<String>,
  /// Byte span `[range_start, range_end)` of the slice within `range_source`.
  #[serde(default)]
  pub range_start: Option<u64>,
  #[serde(default)]
  pub range_end: Option<u64>,
  /// Source fingerprint captured at slice/last-splice time, restored as the
  /// conflict baseline so an out-of-band edit still triggers the mismatch flow.
  #[serde(default)]
  pub range_fp_size: Option<u64>,
  #[serde(default)]
  pub range_fp_mtime: Option<u64>,
  /// 1-based line number of the range's first line, fixed at extraction time
  /// (nothing before this tab's content can shift while it stays open). The
  /// frontend derives the displayed end line from the tab's own content line
  /// count instead of persisting it, so the label follows an edit that
  /// changes the line count and a language change instead of freezing a
  /// formatted string. None for a non-range tab, and for a range tab
  /// restored from an older snapshot, which persisted a formatted label
  /// (`range_label`, removed) instead of a line number; the frontend falls
  /// back to the bare file name for such a tab rather than reconstructing a
  /// line span from the old string.
  #[serde(default)]
  pub range_start_line: Option<i64>,
  /// Sparse line-checkpoint index of a windowed-editing tab (see
  /// `windowed::CheckpointIndex`), captured via `windowed_index` at snapshot
  /// time. Its presence is what marks the tab as "was unlocked" on restore —
  /// there is deliberately no separate boolean for that fact. None for every
  /// tab that was never unlocked into windowed editing.
  #[serde(default)]
  pub windowed_index: Option<crate::windowed::CheckpointIndex>,
  /// Fingerprint (size + mtime) `windowed_index` above was built against, so
  /// restore's `windowed_reopen` call can validate it before trusting it.
  #[serde(default)]
  pub windowed_fp_size: Option<u64>,
  #[serde(default)]
  pub windowed_fp_mtime: Option<u64>,
  /// Sampled digest `windowed_reopen` checks alongside the fingerprint before
  /// trusting the persisted index verbatim (see `windowed::sample_digest`).
  /// Stored as a decimal string, not a number: this struct is exchanged with
  /// the frontend over the same IPC boundary the digest itself must survive
  /// (see `windowed::IndexSnapshot`), so a `u64` here would round-trip
  /// through JS's `f64` and lose precision just the same.
  #[serde(default)]
  pub windowed_digest: Option<String>,
  /// 0-based top-of-viewport line at snapshot time, fed back through
  /// `initialTopLine` on restore so editing continues from where it left off.
  #[serde(default)]
  pub windowed_top_line: Option<u64>,
}

fn default_encoding() -> String {
  "UTF-8".to_string()
}

fn default_opacity() -> f64 {
  1.0
}

fn default_line_ending() -> String {
  "LF".to_string()
}

fn default_paper() -> String {
  "classic".to_string()
}

fn default_pin_mode() -> String {
  "none".to_string()
}

fn default_kind() -> String {
  "sticky".to_string()
}

/// Upgrade a legacy note object in place: a pre-pin_mode note with `pinned: true`
/// becomes `pin_mode: "top"`. Notes that already carry a pin_mode are untouched.
fn migrate_legacy_pin(value: &mut serde_json::Value) {
  let Some(obj) = value.as_object_mut() else {
    return;
  };
  if obj.contains_key("pin_mode") {
    return;
  }
  let was_pinned = obj.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
  if was_pinned {
    obj.insert("pin_mode".into(), serde_json::Value::String("top".into()));
  }
}

/// A note id may only contain ASCII alphanumerics and hyphens (UUID shape), so it
/// can never traverse outside the snapshots directory when used as a file name.
fn valid_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Absolute path of the per-note file for `id` inside `dir`.
fn note_file(dir: &Path, id: &str) -> PathBuf {
  dir.join(format!("{id}.json"))
}

/// Serialize one note and atomically write it to `<dir>/{id}.json`.
fn save_note(dir: &Path, note: &NoteSnapshot) -> Result<(), String> {
  if !valid_id(&note.id) {
    return Err(format!("invalid note id: {}", note.id));
  }
  let json = serde_json::to_string_pretty(note).map_err(|e| e.to_string())?;
  write_text_atomic_private(&note_file(dir, &note.id), &json)
}

/// Remove `<dir>/{id}.json`. A missing file is not an error.
fn delete_note_file(dir: &Path, id: &str) -> Result<(), String> {
  if !valid_id(id) {
    return Err(format!("invalid note id: {id}"));
  }
  match std::fs::remove_file(note_file(dir, id)) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

/// Parse one per-note file, applying the legacy pin migration first. The error
/// carries the reason as well as the message, so `load_dir` can tell a person
/// which of three different problems the file has.
fn load_note_file(path: &Path) -> Result<NoteSnapshot, (SkipReason, String)> {
  let text = std::fs::read_to_string(path).map_err(|e| (SkipReason::Unreadable, e.to_string()))?;
  let mut value: serde_json::Value =
    serde_json::from_str(&text).map_err(|e| (SkipReason::Unparsable, e.to_string()))?;
  migrate_legacy_pin(&mut value);
  let note: NoteSnapshot =
    serde_json::from_value(value).map_err(|e| (SkipReason::Unparsable, e.to_string()))?;
  if !valid_id(&note.id) {
    return Err((SkipReason::Invalid, format!("invalid note id: {}", note.id)));
  }
  Ok(note)
}

/// Load every `*.json` note file in `dir`. A missing dir yields an empty Vec, and
/// an unparsable individual file is skipped with a warning rather than crashing.
/// A file whose name does not match the id inside it is skipped the same way:
/// `save_note` only ever writes `{id}.json`, so a mismatch means the file came
/// from outside the store (a cloud conflict copy, a hand-made duplicate), and
/// admitting it would let two notes share one id. Restore builds one window per
/// id, so that becomes two windows asking for the same label, and the second
/// `WebviewLabelAlreadyExists` fails `setup` — a panic with no window at all.
pub fn load_dir(dir: &Path) -> Result<Loaded<NoteSnapshot>, String> {
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
  let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
  // read_dir order is unspecified; sort by file name so the lexicographic
  // tie-break below (used only when no candidate is an exact `{id}.json`
  // match) is stable across launches instead of random.
  paths.sort();
  // Ids are supposed to be unique because file names are unique, but a
  // case-insensitive extension match (see below) means two distinct file
  // names (e.g. `a.json` and `a.JSON`, or a cloud conflict copy like
  // `a (conflicted copy).json`) can both parse to the same id. Downstream
  // (window restore) assumes unique ids, so load_dir enforces that itself
  // instead of trusting the indirect "file names are unique" property.
  //
  // Among colliding candidates, the file whose name is exactly `{id}.json`
  // is preferred: that's the note's real file, everything else is some kind
  // of copy or case variant. Sorting file paths lexicographically to break
  // ties is NOT a safe substitute for this, because it compares raw bytes:
  // a conflict copy's space (0x20) or a differently-cased extension's `-`
  // (0x2D) both sort before the real file's `.` (0x2E), so a naive
  // path-sort tie-break would deterministically prefer the copy and lose
  // the real note on the next save.
  // id -> (index in `notes`, the file name it was loaded from). The name is
  // kept so a candidate displaced by a later exact match can still be named.
  let mut winners: std::collections::HashMap<String, (usize, String)> =
    std::collections::HashMap::new();
  let mut notes: Vec<NoteSnapshot> = Vec::new();
  let mut skipped: Vec<SkippedFile> = Vec::new();
  for path in paths {
    // A subdirectory is not a snapshot that failed to load, so it is passed
    // over rather than reported.
    if path.is_dir() {
      continue;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
      continue;
    };
    if is_ignored_file(&name) {
      continue;
    }
    // Some sync clients and FAT/exFAT round-trips change extension case
    // (e.g. `.JSON`); comparing case-insensitively keeps those snapshots visible.
    if !path
      .extension()
      .and_then(|e| e.to_str())
      .is_some_and(|e| e.eq_ignore_ascii_case("json"))
    {
      skipped.push(SkippedFile {
        name,
        reason: SkipReason::NotJson,
      });
      continue;
    }
    match load_note_file(&path) {
      Ok(note) if path.file_stem().and_then(|s| s.to_str()) != Some(note.id.as_str()) => {
        log::warn!(
          "skipping foreign snapshot {}: it carries id {}",
          path.display(),
          note.id
        );
        skipped.push(SkippedFile {
          name,
          reason: SkipReason::ForeignId,
        });
      }
      Ok(note) => {
        let is_exact = name == format!("{}.json", note.id);
        match winners.get(&note.id).cloned() {
          None => {
            winners.insert(note.id.clone(), (notes.len(), name));
            notes.push(note);
          }
          Some((idx, previous)) => {
            // Paths are visited in sorted order, so a non-exact existing
            // winner already satisfies the lexicographic tie-break against
            // any later non-exact candidate. An exact match always wins
            // (and at most one candidate per id can be exact, since dir
            // entries have distinct names), so replacing only on `is_exact`
            // covers every case without tracking the existing candidate's
            // exactness separately.
            if is_exact {
              log::warn!(
                "preferring exact match {}: id {:?} previously loaded from a non-exact match",
                path.display(),
                note.id
              );
              winners.insert(note.id.clone(), (idx, name));
              notes[idx] = note;
              skipped.push(SkippedFile {
                name: previous,
                reason: SkipReason::DuplicateId,
              });
            } else {
              log::warn!(
                "skipping {}: id {:?} already loaded from an earlier file",
                path.display(),
                note.id
              );
              skipped.push(SkippedFile {
                name,
                reason: SkipReason::DuplicateId,
              });
            }
          }
        }
      }
      Err((reason, e)) => {
        log::warn!("skipping unusable snapshot {}: {e}", path.display());
        skipped.push(SkippedFile { name, reason });
      }
    }
  }
  Ok(Loaded {
    items: notes,
    skipped,
  })
}

/// Replace the note with a matching id, or append it when new.
pub fn upsert(notes: &mut Vec<NoteSnapshot>, note: NoteSnapshot) {
  match notes.iter_mut().find(|n| n.id == note.id) {
    Some(existing) => *existing = note,
    None => notes.push(note),
  }
}

/// Remove the note with `id`. Returns true when something was removed.
pub fn delete(notes: &mut Vec<NoteSnapshot>, id: &str) -> bool {
  let before = notes.len();
  notes.retain(|n| n.id != id);
  notes.len() != before
}

/// One document window to open on restore: its group id plus the bounds of the
/// group's lowest-tab_index tab (all tabs share the one window).
#[derive(Debug, Clone, PartialEq)]
pub struct DocWindowPlan {
  pub group: String,
  pub x: Option<f64>,
  pub y: Option<f64>,
  pub width: Option<f64>,
  pub height: Option<f64>,
}

/// A document note's effective group id: its window_group, or its own id when
/// None (a legacy/solo document becomes its own single-tab window).
fn resolved_group(note: &NoteSnapshot) -> &str {
  note.window_group.as_deref().unwrap_or(&note.id)
}

/// Plan one document window per group from stored notes. Stickies are ignored.
/// Groups keep first-appearance order; each window inherits the bounds of its
/// lowest-tab_index tab.
pub fn plan_document_windows(notes: &[NoteSnapshot]) -> Vec<DocWindowPlan> {
  let mut order: Vec<String> = Vec::new();
  let mut plans: std::collections::HashMap<String, (i64, DocWindowPlan)> =
    std::collections::HashMap::new();
  for note in notes {
    if note.kind != "document" {
      continue;
    }
    let group = resolved_group(note).to_string();
    let candidate = DocWindowPlan {
      group: group.clone(),
      x: note.x,
      y: note.y,
      width: note.width,
      height: note.height,
    };
    match plans.get_mut(&group) {
      Some((best_index, plan)) => {
        if note.tab_index < *best_index {
          *best_index = note.tab_index;
          *plan = candidate;
        }
      }
      None => {
        order.push(group.clone());
        plans.insert(group, (note.tab_index, candidate));
      }
    }
  }
  order
    .into_iter()
    .map(|g| plans.remove(&g).unwrap().1)
    .collect()
}

/// The snapshot files that could not be loaded at startup, held until a window
/// takes focus and claims them. `NoteStore::load` runs inside `setup`, before a
/// single window exists, so there is nowhere to report them at the moment they
/// are found. Taken once: the report belongs to one window, not to every window
/// that happens to gain focus later.
#[derive(Default)]
pub struct StartupSkips(Mutex<Option<Vec<SkippedFile>>>);

impl StartupSkips {
  /// Hold `skipped` for the first window to ask. An empty list is held as
  /// nothing, so the frontend never has to distinguish "none" from "empty".
  pub fn holding(skipped: Vec<SkippedFile>) -> Self {
    StartupSkips(Mutex::new(if skipped.is_empty() {
      None
    } else {
      Some(skipped)
    }))
  }
}

#[tauri::command]
pub fn take_startup_skips(state: State<StartupSkips>) -> Option<Vec<SkippedFile>> {
  state.0.lock().unwrap().take()
}

/// The in-memory notes plus the directory their per-note files live in. Both are
/// guarded together so a location switch stays consistent with the file layout.
///
/// `seqs` is the last-applied sequence number per note id, used only by
/// `upsert_ordered` (see its doc comment): `upsert_note` runs `(async)` off the
/// UI thread, so two overlapping calls for the same id are no longer guaranteed
/// to complete in call order, and the Mutex alone only prevents a torn write,
/// not an older payload landing after a newer one. A missing entry means no
/// ordered write has applied yet for that id.
struct Inner {
  notes: Vec<NoteSnapshot>,
  dir: PathBuf,
  seqs: std::collections::HashMap<String, u64>,
}

/// The single owner of note snapshots: an in-memory Vec guarded by a Mutex,
/// loaded once at startup and persisted as one atomic file per note.
pub struct NoteStore {
  inner: Mutex<Inner>,
}

impl NoteStore {
  /// Build a store by loading every per-note file in `dir` (missing = empty),
  /// discarding what could not be loaded. Only tests want that: startup is the
  /// one caller with somewhere to report a skipped file, and it uses
  /// `load_reporting` instead.
  #[cfg(test)]
  pub fn load(dir: PathBuf) -> Result<Self, String> {
    Ok(Self::load_reporting(dir)?.0)
  }

  /// `load`, plus the files in `dir` that could not be loaded. Startup uses
  /// this one: it is the only caller with somewhere to report them.
  pub fn load_reporting(dir: PathBuf) -> Result<(Self, Vec<SkippedFile>), String> {
    let loaded = load_dir(&dir)?;
    Ok((
      NoteStore {
        inner: Mutex::new(Inner {
          notes: loaded.items,
          dir,
          seqs: std::collections::HashMap::new(),
        }),
      },
      loaded.skipped,
    ))
  }

  /// Build a store with no notes, still bound to `dir`. Used when `dir`
  /// exists but cannot be listed (e.g. permissions): starting empty touches
  /// nothing on disk, and every write into `dir` would fail the same way, so
  /// no data is destroyed by starting empty.
  pub fn empty(dir: PathBuf) -> Self {
    NoteStore {
      inner: Mutex::new(Inner {
        notes: Vec::new(),
        dir,
        seqs: std::collections::HashMap::new(),
      }),
    }
  }

  pub fn list(&self) -> Vec<NoteSnapshot> {
    self.inner.lock().unwrap().notes.clone()
  }

  pub fn get(&self, id: &str) -> Option<NoteSnapshot> {
    self
      .inner
      .lock()
      .unwrap()
      .notes
      .iter()
      .find(|n| n.id == id)
      .cloned()
  }

  pub fn upsert(&self, note: NoteSnapshot) -> Result<(), String> {
    let mut inner = self.inner.lock().unwrap();
    save_note(&inner.dir, &note)?;
    upsert(&mut inner.notes, note);
    Ok(())
  }

  /// Like `upsert`, but drops the write instead of applying it when `seq` is
  /// older than the last `seq` this id was successfully written with. `seq` is
  /// assigned by the frontend at the moment the write is issued (a single
  /// incrementing counter, JS being single-threaded), not by whenever this
  /// call happens to reach the lock, so it reflects true call order even
  /// though `upsert_note` runs `(async)` and worker-pool scheduling gives no
  /// such guarantee on its own. Returns whether the write was applied, so the
  /// caller can skip broadcasting `store-changed` for a dropped write.
  pub fn upsert_ordered(&self, note: NoteSnapshot, seq: u64) -> Result<bool, String> {
    let mut inner = self.inner.lock().unwrap();
    if let Some(&last) = inner.seqs.get(&note.id) {
      if seq < last {
        return Ok(false);
      }
    }
    let id = note.id.clone();
    save_note(&inner.dir, &note)?;
    inner.seqs.insert(id, seq);
    upsert(&mut inner.notes, note);
    Ok(true)
  }

  pub fn delete(&self, id: &str) -> Result<(), String> {
    let mut inner = self.inner.lock().unwrap();
    delete_note_file(&inner.dir, id)?;
    delete(&mut inner.notes, id);
    Ok(())
  }

  /// The directory currently active for per-note files.
  pub fn current_dir(&self) -> PathBuf {
    self.inner.lock().unwrap().dir.clone()
  }

  /// Snapshot-file counts for the switch-confirmation dialogs, computed from
  /// what is actually on disk (not the in-memory list): how many notes would
  /// be stranded by a "don't move" choice, and how many of the active
  /// directory's filenames already exist in `new_dir`.
  pub fn preview_move(&self, new_dir: &Path) -> SnapshotMovePreview {
    let inner = self.inner.lock().unwrap();
    let source_names = json_file_names(&inner.dir);
    let dest_names: std::collections::HashSet<String> =
      json_file_names(new_dir).into_iter().collect();
    let collision_count = source_names
      .iter()
      .filter(|n| dest_names.contains(*n))
      .count();
    SnapshotMovePreview {
      source_count: source_names.len(),
      collision_count,
    }
  }

  /// Repoint the active directory at `new_dir`, optionally moving every
  /// `*.json` file physically present in the old one first (moving what is
  /// really on disk, not the in-memory list, so unparsable files, mismatched-
  /// stem files, and every note when the store started empty are carried
  /// along rather than stranded). Collisions at the destination are resolved
  /// per `policy`. The in-memory notes are then reloaded from `new_dir`'s
  /// actual contents, so the list always agrees with disk.
  pub fn set_dir(
    &self,
    new_dir: PathBuf,
    move_files: bool,
    policy: CollisionPolicy,
  ) -> Result<(), String> {
    let mut inner = self.inner.lock().unwrap();
    if inner.dir == new_dir {
      return Ok(());
    }
    std::fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
    if move_files {
      move_snapshot_files(&inner.dir, &new_dir, policy)?;
    }
    inner.notes = load_dir(&new_dir)?.items;
    inner.dir = new_dir;
    Ok(())
  }
}

/// How to resolve a filename collision when moving snapshot files into an
/// already-populated destination. Filenames are note ids (UUIDs), so a
/// per-file prompt is meaningless — the whole batch is resolved one way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollisionPolicy {
  /// The directory being moved from wins: its copy overwrites the destination's.
  Source,
  /// The destination's existing copy wins: the source copy is left where it is.
  Dest,
  /// Both are kept: the incoming copy gets a new id, becoming an independent note.
  Both,
}

/// Snapshot-file counts used to word the switch-confirmation dialogs before a
/// move is attempted.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct SnapshotMovePreview {
  pub source_count: usize,
  pub collision_count: usize,
}

/// The id (file stem) of every `*.json` file directly inside `dir`. A missing
/// dir yields an empty Vec.
fn json_file_names(dir: &Path) -> Vec<String> {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return Vec::new();
  };
  entries
    .filter_map(|e| e.ok())
    .map(|e| e.path())
    .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
    .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_string))
    .collect()
}

/// Copy `path` into `dst` under a freshly generated id, so a "keep both"
/// collision produces a note `load_dir` will actually admit (its filename
/// must equal the id stored inside it, so a same-name copy cannot just be
/// renamed). Content that fails to parse as JSON is copied verbatim under the
/// new filename: it was already unloadable, so this cannot make it worse.
fn write_with_new_id(path: &Path, dst: &Path) -> Result<PathBuf, String> {
  let new_id = uuid::Uuid::new_v4().to_string();
  let dest_path = dst.join(format!("{new_id}.json"));
  let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
  let rewritten = match serde_json::from_str::<serde_json::Value>(&text) {
    Ok(mut value) => {
      if let Some(obj) = value.as_object_mut() {
        obj.insert("id".to_string(), serde_json::Value::String(new_id));
      }
      serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
    }
    Err(_) => text,
  };
  std::fs::write(&dest_path, rewritten).map_err(|e| e.to_string())?;
  Ok(dest_path)
}

/// Physically move every `*.json` file directly inside `src` into `dst`,
/// resolving name collisions per `policy`. On any I/O failure, every file
/// already copied into `dst` during this call is removed before returning,
/// so a partial failure leaves no residue at the destination and `src` is
/// left exactly as it was.
fn move_snapshot_files(src: &Path, dst: &Path, policy: CollisionPolicy) -> Result<(), String> {
  let entries = match std::fs::read_dir(src) {
    Ok(entries) => entries,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(e) => return Err(e.to_string()),
  };
  let mut copied: Vec<PathBuf> = Vec::new();
  let mut moved_sources: Vec<PathBuf> = Vec::new();
  let result = (|| -> Result<(), String> {
    for entry in entries {
      let path = entry.map_err(|e| e.to_string())?.path();
      if path.extension().and_then(|e| e.to_str()) != Some("json") {
        continue;
      }
      let file_name = path
        .file_name()
        .ok_or_else(|| "snapshot file has no name".to_string())?;
      let dest_path = dst.join(file_name);
      if dest_path.exists() && policy == CollisionPolicy::Dest {
        // The destination's copy wins; leave this one where it is.
        continue;
      }
      let landed = if dest_path.exists() && policy == CollisionPolicy::Both {
        write_with_new_id(&path, dst)?
      } else {
        std::fs::copy(&path, &dest_path).map_err(|e| e.to_string())?;
        dest_path
      };
      copied.push(landed);
      moved_sources.push(path);
    }
    Ok(())
  })();
  if let Err(e) = result {
    for path in &copied {
      let _ = std::fs::remove_file(path);
    }
    return Err(e);
  }
  for path in &moved_sources {
    let _ = std::fs::remove_file(path);
  }
  Ok(())
}

/// Resolve the effective snapshots directory: `None` (the default) resolves to
/// the app data dir's `snapshots` folder, exactly as before this setting
/// existed; `Some(picked)` resolves to `picked/Note&Pad/snapshots` — the user
/// picks the parent, the app owns the `Note&Pad` folder inside it. That layout
/// deliberately matches the old hard-coded iCloud path, so an existing iCloud
/// user's files stay in place across the migration (see
/// `migrate_legacy_snapshot_location`).
fn snapshot_dir_for(app_data: &Path, picked: Option<&Path>) -> PathBuf {
  match picked {
    Some(dir) => dir.join("Note&Pad").join("snapshots"),
    None => app_data.join("snapshots"),
  }
}

pub fn resolve_snapshot_dir(app: &AppHandle, picked: Option<&Path>) -> Result<PathBuf, String> {
  let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(snapshot_dir_for(&app_data, picked))
}

/// Whether snapshots can actually be written into `dir`: the directory can be
/// created and a file inside it opened for writing. Nothing else in the startup
/// path finds this out — `resolve_snapshot_dir` is pure path arithmetic and
/// `NoteStore::load` only reads — so a folder the app cannot write to used to
/// surface as every later write failing one at a time.
#[cfg(unix)]
mod access_check {
  use std::ffi::c_int;

  // access(2) is a plain existence/permission check with no side effects,
  // unlike creating and deleting a probe file — the latter fires a sync
  // event on every launch for iCloud Drive / Dropbox snapshot folders.
  extern "C" {
    fn access(path: *const std::ffi::c_char, mode: c_int) -> c_int;
  }

  pub const W_OK: c_int = 2;

  pub fn writable(dir: &std::path::Path) -> bool {
    let Ok(c_path) = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()) else {
      return false;
    };
    // Safety: `c_path` is a valid NUL-terminated buffer kept alive for the call.
    unsafe { access(c_path.as_ptr(), W_OK) == 0 }
  }
}

fn is_writable(dir: &Path) -> bool {
  if std::fs::create_dir_all(dir).is_err() {
    return false;
  }
  // Migration nicety: clean up a leftover probe file from older builds.
  let _ = std::fs::remove_file(dir.join(".write-probe"));
  #[cfg(unix)]
  {
    access_check::writable(dir)
  }
  // Windows still writes a probe: `_waccess` there sees only the read-only
  // attribute and answers "writable" for a folder an ACL denies (measured), so
  // swapping it in would call a folder usable that no snapshot can be written
  // to -- the very failure this check exists to catch. The cost is two events
  // per launch in a synced folder, which is what the Unix side avoids.
  #[cfg(not(unix))]
  {
    let probe = dir.join(".write-probe");
    match std::fs::File::create(&probe) {
      Ok(_) => {
        let _ = std::fs::remove_file(&probe);
        true
      }
      Err(_) => false,
    }
  }
}

/// Whether this launch fell back to the default snapshots folder. Set once at
/// startup and read by `settings::load_settings`, so the settings window can
/// say so instead of the user finding out by noticing their notes are missing.
#[derive(Default)]
pub struct SnapshotFallback(std::sync::atomic::AtomicBool);

impl SnapshotFallback {
  pub fn in_use(&self) -> bool {
    self.0.load(std::sync::atomic::Ordering::Relaxed)
  }

  fn mark(&self) {
    self.0.store(true, std::sync::atomic::Ordering::Relaxed);
  }
}

/// The snapshots directory to actually use at startup: the folder the settings
/// point at when it works, the default inside the app's own data directory when
/// it does not.
///
/// The picked folder can be unusable for reasons the user cannot be expected to
/// have anticipated — an external disk that is not mounted, a synced folder
/// that went read-only, or, in a sandboxed build, a grant that did not survive
/// the last launch. None of those is a reason to have no snapshots at all:
/// before this fallback, a sticky could not be created, so the startup window
/// never opened and the app sat there with a menu bar and nothing else. The
/// default folder is inside the app's own data directory, which is the one
/// place it is always allowed to write.
///
/// The setting is deliberately left as the user wrote it, so the folder is used
/// again the moment it works. `fallback` records that this happened for the
/// settings window to report.
pub fn startup_snapshot_dir(
  app: &AppHandle,
  settings: &settings::AppSettings,
  fallback: &SnapshotFallback,
) -> Result<PathBuf, String> {
  let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let default_dir = snapshot_dir_for(&app_data, None);
  let Some(picked) = picked_snapshot_dir(settings) else {
    return Ok(default_dir);
  };
  let dir = snapshot_dir_for(&app_data, Some(picked.as_path()));
  if is_writable(&dir) {
    return Ok(dir);
  }
  log::warn!(
    "snapshot folder {} cannot be written to; using the default folder",
    dir.display()
  );
  fallback.mark();
  Ok(default_dir)
}

/// The folder the settings choose, or `None` for the default. Prefers the
/// bookmark, which is the only form that still opens under the sandbox, and
/// falls back to the plain path when there is no bookmark or it no longer
/// resolves — a folder that was deleted and recreated at the same place is
/// reachable by path even though its bookmark is gone.
fn picked_snapshot_dir(settings: &settings::AppSettings) -> Option<PathBuf> {
  let path = settings.snapshot_dir.as_ref().map(PathBuf::from);
  let Some(bookmark) = settings.snapshot_dir_bookmark.as_deref() else {
    return path;
  };
  mac_bookmark::to_path(bookmark).or(path)
}

/// The iCloud Drive base for our snapshots, or None when the platform has no
/// iCloud Drive concept. Existence of iCloud Drive itself is checked separately.
#[cfg(target_os = "macos")]
fn icloud_base(app: &AppHandle) -> Option<PathBuf> {
  app
    .path()
    .home_dir()
    .ok()
    .map(|h| h.join("Library/Mobile Documents/com~apple~CloudDocs/Note&Pad"))
}

#[cfg(not(target_os = "macos"))]
fn icloud_base(_app: &AppHandle) -> Option<PathBuf> {
  None
}

/// Map the retired `"local"`/`"icloud"` `snapshot_location` string to the new
/// `snapshot_dir` path setting. `"icloud"` resolves to `icloud_parent` — the
/// parent of the old hard-coded iCloud `Note&Pad` folder — so
/// `snapshot_dir_for` reconstructs the exact same directory the user already
/// had. Anything else (`"local"`, unknown, or `"icloud"` with no iCloud parent,
/// i.e. a non-macOS machine) maps to `None`, the new default. Pure so every
/// branch is unit-tested without touching the filesystem.
pub fn migrate_legacy_snapshot_location(
  legacy: &str,
  icloud_parent: Option<PathBuf>,
) -> Option<PathBuf> {
  match legacy {
    "icloud" => icloud_parent,
    _ => None,
  }
}

/// One-time startup migration: read the legacy `snapshot_location` string
/// straight from the settings JSON (the field has no home on `AppSettings`
/// anymore) and, when `snapshot_dir` is still unset, fold it into
/// `snapshot_dir` and persist. A missing settings file, or one that already
/// has `snapshot_dir`, is a no-op.
///
/// Every failure is logged and swallowed rather than returned. This runs inside
/// `setup()`, and everywhere else a broken settings file quietly falls back to
/// defaults (`app_settings`); letting a migration failure propagate would turn
/// an unreadable — or merely read-only — settings file into the app refusing to
/// launch at all. Skipping just leaves the old value in place for the next run.
pub fn migrate_legacy_snapshot_location_setting(app: &AppHandle) {
  let Ok(path) = settings::settings_path(app) else {
    return;
  };
  let Ok(text) = std::fs::read_to_string(&path) else {
    return;
  };
  let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
    log::warn!("settings file is not valid JSON; skipping snapshot-location migration");
    return;
  };
  if value.get("snapshot_dir").is_some() {
    return;
  }
  let Some(legacy) = value.get("snapshot_location").and_then(|v| v.as_str()) else {
    return;
  };
  let icloud_parent = icloud_base(app).and_then(|p| p.parent().map(Path::to_path_buf));
  let Some(migrated) = migrate_legacy_snapshot_location(legacy, icloud_parent) else {
    return;
  };
  let updated = settings::load_from(&path).map(|mut settings| {
    settings.snapshot_dir = Some(migrated.to_string_lossy().into_owned());
    settings
  });
  match updated.and_then(|settings| settings::save_to(&path, &settings)) {
    Ok(()) => {}
    Err(e) => log::warn!("failed to migrate snapshot_location into snapshot_dir: {e}"),
  }
}

/// Switch `store`'s active directory to `new_dir` (optionally moving the old
/// directory's files into it first, resolving collisions per `policy`), then
/// call `write_setting` to persist the choice. The setting is written only
/// after a successful switch; if `write_setting` fails, the switch is rolled
/// back (files moved back, active dir reverted) so files and setting never
/// disagree. Split out of `apply_snapshot_dir` so this ordering guarantee is
/// unit-testable against a real `NoteStore` without a running Tauri app.
fn switch_and_persist(
  store: &NoteStore,
  new_dir: PathBuf,
  move_files: bool,
  policy: CollisionPolicy,
  write_setting: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
  let old_dir = store.current_dir();
  store.set_dir(new_dir, move_files, policy)?;
  if let Err(e) = write_setting() {
    // The switch already happened but the setting didn't take; move back so
    // the two never disagree about where the files live. Best-effort: the
    // files just moved from old_dir win any collision moving back into it.
    let _ = store.set_dir(old_dir, move_files, CollisionPolicy::Source);
    return Err(e);
  }
  Ok(())
}

/// Validate the picked folder, then switch and persist via `switch_and_persist`.
pub fn apply_snapshot_dir(
  app: &AppHandle,
  store: &NoteStore,
  dir: Option<PathBuf>,
  move_files: bool,
  policy: CollisionPolicy,
) -> Result<(), String> {
  if let Some(picked) = &dir {
    if !picked.is_dir() {
      return Err("the chosen folder does not exist".to_string());
    }
  }
  let new_dir = resolve_snapshot_dir(app, dir.as_deref())?;
  switch_and_persist(store, new_dir, move_files, policy, || {
    let path = settings::settings_path(app)?;
    // Never `app_settings` here: this reads settings only to mutate one field
    // and write the whole struct back, so a read failure must abort instead of
    // being laundered into defaults that then overwrite the user's real file.
    let mut settings = settings::load_or_default_for_write(&path)?;
    settings.snapshot_dir = dir.as_deref().map(|p| p.to_string_lossy().into_owned());
    // A sandboxed build cannot reopen a folder from its path alone, so the
    // grant is written down beside the path as a security-scoped bookmark.
    settings.snapshot_dir_bookmark = dir.as_deref().and_then(mac_bookmark::encode);
    settings::save_to(&path, &settings)
  })
}

/// Broadcast that the store changed so live views (e.g. the workspace window)
/// can re-read. Payload is the affected note id, or None for a bulk change. The
/// store itself stays emit-free; every command/helper mutating it emits here.
pub fn emit_store_changed(app: &AppHandle, note_id: Option<&str>) {
  let _ = app.emit("store-changed", note_id);
  // The Windows Jump List lists stickies straight from the store, same as the
  // Dock menu; keep it in sync with every mutation that reaches this choke
  // point.
  #[cfg(target_os = "windows")]
  crate::jumplist::rebuild(app);
}

#[tauri::command]
pub fn list_notes(store: State<NoteStore>) -> Vec<NoteSnapshot> {
  store.list()
}

#[tauri::command]
pub fn get_note(store: State<NoteStore>, id: String) -> Option<NoteSnapshot> {
  store.get(&id)
}

/// Off the UI thread: this runs on every debounced snapshot, so the full
/// serialize + write + fsync + rename must not block the UI thread. `seq`
/// guards against the reordering that moving this off the main thread makes
/// possible — see `NoteStore::upsert_ordered`.
#[tauri::command(async)]
pub fn upsert_note(
  app: AppHandle,
  store: State<NoteStore>,
  note: NoteSnapshot,
  seq: u64,
) -> Result<(), String> {
  let id = note.id.clone();
  if store.upsert_ordered(note, seq)? {
    emit_store_changed(&app, Some(&id));
  }
  Ok(())
}

#[tauri::command]
pub fn delete_note(app: AppHandle, store: State<NoteStore>, id: String) -> Result<(), String> {
  store.delete(&id)?;
  emit_store_changed(&app, Some(&id));
  Ok(())
}

/// Delete every note in `ids` from `store`, tolerating ids that don't exist
/// (an unknown id is not an error — see `delete_note_file`) and logging any
/// individual failure without aborting the rest of the batch.
fn delete_notes(store: &NoteStore, ids: &[String]) {
  for id in ids {
    if let Err(e) = store.delete(id) {
      log::warn!("failed to drop closed tab {id}: {e}");
    }
  }
}

/// Forget a closed document window's clean tabs, but only after a short
/// deferral and only if `should_forget_tabs` says it's safe. A window that is
/// the FIRST of a desktop-shell batch close cannot be recognized as part of
/// the batch (see `is_batch_close` in `lib.rs`), so it runs its normal
/// single-close flow, which calls this instead of deleting immediately.
///
/// `close_at` is this window's own `CloseRequested` time (recorded by
/// `handle_window_event`, looked up and removed here by `label`; a close
/// that reached here without going through the `FlushDoc` path falls back to
/// "now"). Deferral runs until `close_at + BATCH_CLOSE_WINDOW`, not a fresh
/// `BATCH_CLOSE_WINDOW` from whenever this command happened to be called —
/// the flush handshake in between can itself take a while, so waiting a full
/// window from *now* would just add unrelated latency.
///
/// `QUIT_IN_FLIGHT` alone is not enough to decide: it resets to `false`
/// within milliseconds of a vetoed quit, while the batch that triggered it
/// stays real for as long as the user sits in the oversized-tab dialog. See
/// `should_forget_tabs` for the actual (monotonic, veto-proof) decision.
///
/// Trade-off, deliberately on the safe side: if the process dies inside that
/// window (killed, crashed) the notes are never forgotten and those tabs
/// reappear on the next launch. A stale tab beats a lost tab.
#[tauri::command]
pub fn drop_closed_tabs(app: AppHandle, label: String, ids: Vec<String>) {
  // Always consume the CLOSE_REQUESTED_AT entry for this label, even when there is
  // nothing to delete, otherwise it leaks for the lifetime of the session.
  let close_at = crate::CLOSE_REQUESTED_AT
    .lock()
    .unwrap()
    .as_mut()
    .and_then(|map| map.remove(&label))
    .unwrap_or_else(std::time::Instant::now);
  if ids.is_empty() {
    return;
  }
  let deadline = close_at + crate::BATCH_CLOSE_WINDOW;
  std::thread::spawn(move || {
    let now = std::time::Instant::now();
    if deadline > now {
      std::thread::sleep(deadline - now);
    }
    let last_batch = *crate::LAST_BATCH_CLOSE.lock().unwrap();
    let quit_in_flight = crate::QUIT_IN_FLIGHT.load(std::sync::atomic::Ordering::SeqCst);
    if !crate::should_forget_tabs(close_at, last_batch, quit_in_flight) {
      return;
    }
    let store = app.state::<NoteStore>();
    delete_notes(&store, &ids);
    emit_store_changed(&app, None);
  });
}

/// Note counts the settings UI uses to word its switch-confirmation dialogs
/// before committing to a move: how many notes are in the currently active
/// directory, and how many of them would collide with `dir`'s contents.
#[tauri::command]
pub fn preview_snapshot_dir_move(
  app: AppHandle,
  store: State<NoteStore>,
  dir: Option<String>,
) -> Result<SnapshotMovePreview, String> {
  let new_dir = resolve_snapshot_dir(&app, dir.map(PathBuf::from).as_deref())?;
  Ok(store.preview_move(&new_dir))
}

#[tauri::command]
pub fn set_snapshot_dir(
  app: AppHandle,
  store: State<NoteStore>,
  dir: Option<String>,
  move_files: bool,
  policy: CollisionPolicy,
) -> Result<(), String> {
  apply_snapshot_dir(&app, &store, dir.map(PathBuf::from), move_files, policy)?;
  emit_store_changed(&app, None);
  Ok(())
}

/// The currently resolved snapshots directory, for the settings UI to display.
#[tauri::command]
pub fn get_snapshot_dir(store: State<NoteStore>) -> Result<String, String> {
  // The store's own directory, not a fresh resolve of the setting: this is what
  // the app is actually writing to, so a launch that fell back to the default
  // shows the default here rather than the folder that failed. Re-resolving
  // would also mean re-acquiring a sandbox grant on every settings screen.
  Ok(store.current_dir().to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  fn settings_with(dir: Option<&str>, bookmark: Option<&str>) -> settings::AppSettings {
    settings::AppSettings {
      snapshot_dir: dir.map(str::to_string),
      snapshot_dir_bookmark: bookmark.map(str::to_string),
      ..Default::default()
    }
  }

  #[test]
  fn no_choice_means_the_default_folder() {
    assert_eq!(picked_snapshot_dir(&settings_with(None, None)), None);
  }

  #[test]
  fn the_plain_path_is_used_when_there_is_no_bookmark() {
    // Every build before bookmarks existed, and every build on Windows and
    // Linux: the path is the whole record of the choice.
    assert_eq!(
      picked_snapshot_dir(&settings_with(Some("/Volumes/Disk/Snaps"), None)),
      Some(PathBuf::from("/Volumes/Disk/Snaps"))
    );
  }

  #[test]
  fn a_bookmark_that_no_longer_resolves_falls_back_to_the_path() {
    // The folder deleted and recreated at the same place: unreachable by
    // bookmark, still perfectly reachable by path. Losing the folder here is
    // what storing only the bookmark would have cost.
    assert_eq!(
      picked_snapshot_dir(&settings_with(Some("/Volumes/Disk/Snaps"), Some("AAAA"))),
      Some(PathBuf::from("/Volumes/Disk/Snaps"))
    );
  }

  #[test]
  fn a_fallback_starts_unmarked_and_stays_marked() {
    let fallback = SnapshotFallback::default();
    assert!(!fallback.in_use());
    fallback.mark();
    assert!(fallback.in_use());
  }

  #[test]
  fn a_folder_that_can_be_created_and_written_is_usable() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("snapshots");
    assert!(is_writable(&target));
    assert!(target.is_dir(), "the probe creates the folder it checks");
    assert!(
      std::fs::read_dir(&target).unwrap().next().is_none(),
      "the probe leaves nothing behind"
    );
  }

  #[cfg(unix)]
  #[test]
  fn a_read_only_folder_is_not_usable() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let target = dir.path().join("locked");
    std::fs::create_dir(&target).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o500)).unwrap();
    let usable = is_writable(&target);
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!usable, "a folder that refuses a new file is not usable");
  }

  #[test]
  fn is_writable_leaves_no_files_behind() {
    // access(2) never creates anything, unlike the old probe-file approach —
    // which fired a sync event per launch on iCloud Drive / Dropbox folders.
    let dir = tempdir().unwrap();
    assert!(is_writable(dir.path()));
    let entries: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
    assert!(
      entries.is_empty(),
      "is_writable must not leave files behind"
    );
  }

  fn note(id: &str) -> NoteSnapshot {
    NoteSnapshot {
      id: id.into(),
      content: "hi".into(),
      file_path: None,
      language: None,
      explicit: false,
      x: Some(10.0),
      y: Some(20.0),
      width: Some(320.0),
      height: Some(260.0),
      pin_mode: "top".into(),
      pin_app: None,
      opacity: 0.5,
      paper: "pink".into(),
      kind: "sticky".into(),
      dirty: false,
      window_group: None,
      tab_index: 0,
      line_ending: "LF".into(),
      had_bom: false,
      encoding: "UTF-8".into(),
      project: None,
      large: None,
      range_source: None,
      range_start: None,
      range_end: None,
      range_fp_size: None,
      range_fp_mtime: None,
      range_start_line: None,
      windowed_index: None,
      windowed_fp_size: None,
      windowed_fp_mtime: None,
      windowed_digest: None,
      windowed_top_line: None,
    }
  }

  fn doc(id: &str, group: Option<&str>, tab_index: i64) -> NoteSnapshot {
    NoteSnapshot {
      kind: "document".into(),
      file_path: Some(format!("/tmp/{id}.txt")),
      window_group: group.map(|g| g.to_string()),
      tab_index,
      ..note(id)
    }
  }

  #[test]
  fn traversal_id_is_rejected_on_upsert() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    let err = store.upsert(note("../evil")).unwrap_err();
    assert!(err.contains("invalid note id"));
    // Nothing escapes the snapshots dir and nothing is stored in memory.
    assert!(!dir.path().parent().unwrap().join("evil.json").exists());
    assert!(store.list().is_empty());
  }

  #[test]
  fn traversal_id_is_skipped_on_load() {
    let dir = tempdir().unwrap();
    let planted = serde_json::to_string(&note("../evil")).unwrap();
    std::fs::write(dir.path().join("planted.json"), planted).unwrap();
    std::fs::write(
      dir.path().join("ok.json"),
      serde_json::to_string(&note("ok")).unwrap(),
    )
    .unwrap();
    let loaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(loaded, vec![note("ok")]);
  }

  #[test]
  fn upsert_then_load_roundtrips_per_file() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(note("a")).unwrap();
    // The note lives in its own file.
    assert!(dir.path().join("a.json").exists());
    // Reload from disk to prove persistence, not just in-memory state.
    let reloaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(reloaded, vec![note("a")]);
  }

  #[cfg(unix)]
  #[test]
  fn a_snapshot_and_its_directory_are_created_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    // A sticky note has no file of its own, so this snapshot is the only copy
    // of text the user has not saved anywhere. The snapshot directory can be
    // pointed at a shared path in settings, which is the case this covers.
    let root = tempdir().unwrap();
    let dir = root.path().join("snapshots");
    let store = NoteStore::load(dir.clone()).unwrap();
    store.upsert(note("a")).unwrap();

    let file_mode = std::fs::metadata(dir.join("a.json"))
      .unwrap()
      .permissions()
      .mode()
      & 0o777;
    assert_eq!(file_mode, 0o600);
    let dir_mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
    assert_eq!(dir_mode, 0o700);
  }

  #[test]
  fn upsert_replaces_existing_by_id() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(note("a")).unwrap();
    let mut updated = note("a");
    updated.content = "changed".into();
    store.upsert(updated.clone()).unwrap();
    assert_eq!(store.list(), vec![updated]);
  }

  #[test]
  fn upsert_ordered_in_order_sequence_persists_latest() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    let mut first = note("a");
    first.content = "one".into();
    let mut second = note("a");
    second.content = "two".into();
    let mut third = note("a");
    third.content = "three".into();
    assert!(store.upsert_ordered(first, 1).unwrap());
    assert!(store.upsert_ordered(second, 2).unwrap());
    assert!(store.upsert_ordered(third, 3).unwrap());
    assert_eq!(store.get("a").unwrap().content, "three");
    let reloaded = NoteStore::load(dir.path().to_path_buf()).unwrap();
    assert_eq!(reloaded.get("a").unwrap().content, "three");
  }

  #[test]
  fn upsert_ordered_drops_stale_write_for_same_id() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    let mut newer = note("a");
    newer.content = "newer".into();
    let mut older = note("a");
    older.content = "older".into();
    // seq 5 (the newer payload) lands first, as if its write finished before
    // seq 2's write, which was issued earlier but took longer.
    assert!(store.upsert_ordered(newer, 5).unwrap());
    assert!(!store.upsert_ordered(older, 2).unwrap());
    // The stale write must not have overwritten the newer one, in memory or
    // on disk.
    assert_eq!(store.get("a").unwrap().content, "newer");
    let reloaded = NoteStore::load(dir.path().to_path_buf()).unwrap();
    assert_eq!(reloaded.get("a").unwrap().content, "newer");
  }

  #[test]
  fn upsert_ordered_tracks_sequence_independently_per_id() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    let mut a = note("a");
    a.content = "a-content".into();
    let mut b = note("b");
    b.content = "b-content".into();
    // "a" has already reached a high sequence; "b" starting fresh at a low
    // sequence must not be treated as stale just because "a" is ahead.
    assert!(store.upsert_ordered(a, 100).unwrap());
    assert!(store.upsert_ordered(b, 1).unwrap());
    assert_eq!(store.get("a").unwrap().content, "a-content");
    assert_eq!(store.get("b").unwrap().content, "b-content");
  }

  #[test]
  fn delete_removes_file_and_persists() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(note("a")).unwrap();
    store.upsert(note("b")).unwrap();
    store.delete("a").unwrap();
    assert!(!dir.path().join("a.json").exists());
    let reloaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(reloaded, vec![note("b")]);
  }

  #[test]
  fn delete_unknown_id_is_noop() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(note("a")).unwrap();
    store.delete("does-not-exist").unwrap();
    assert_eq!(store.list(), vec![note("a")]);
  }

  #[test]
  fn delete_notes_removes_exactly_the_given_ids_and_tolerates_unknown_ones() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(note("a")).unwrap();
    store.upsert(note("b")).unwrap();
    store.upsert(note("c")).unwrap();
    delete_notes(
      &store,
      &["a".to_string(), "b".to_string(), "unknown".to_string()],
    );
    assert_eq!(store.list(), vec![note("c")]);
  }

  /// The reasons reported for `dir`, as (file name, reason) pairs sorted by
  /// name so an assertion does not depend on directory order.
  fn skips(dir: &Path) -> Vec<(String, SkipReason)> {
    let mut skipped: Vec<(String, SkipReason)> = load_dir(dir)
      .unwrap()
      .skipped
      .into_iter()
      .map(|s| (s.name, s.reason))
      .collect();
    skipped.sort();
    skipped
  }

  #[test]
  fn load_dir_does_not_report_hidden_or_system_files() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(note("a")).unwrap();
    // Recreated by a file browser, left by an interrupted write, and the two
    // Windows equivalents. None of them is a snapshot that failed to load.
    for name in [".DS_Store", ".a.json.tmp", "Thumbs.db", "desktop.ini"] {
      std::fs::write(dir.path().join(name), "x").unwrap();
    }
    std::fs::create_dir(dir.path().join("a-folder")).unwrap();
    let loaded = load_dir(dir.path()).unwrap();
    assert_eq!(loaded.items, vec![note("a")]);
    assert_eq!(loaded.skipped, Vec::new());
  }

  #[test]
  fn load_dir_reports_a_file_that_is_not_json() {
    let dir = tempdir().unwrap();
    // The shape a rename or a backup tool leaves behind: the snapshot is gone
    // from the list, and only the extension says why.
    std::fs::write(dir.path().join("a.json.txt"), "{}").unwrap();
    assert_eq!(
      skips(dir.path()),
      vec![("a.json.txt".to_string(), SkipReason::NotJson)]
    );
  }

  #[test]
  fn load_dir_reports_the_reason_each_file_was_skipped() {
    let dir = tempdir().unwrap();
    std::fs::write(
      dir.path().join("a.json"),
      r#"{"id":"a","content":"one","file_path":null}"#,
    )
    .unwrap();
    // Carries an id that is not its file name.
    std::fs::write(
      dir.path().join("renamed.json"),
      r#"{"id":"a","content":"two","file_path":null}"#,
    )
    .unwrap();
    // Parses, but not into a note.
    std::fs::write(dir.path().join("b.json"), "{ not json").unwrap();
    assert_eq!(
      skips(dir.path()),
      vec![
        ("b.json".to_string(), SkipReason::Unparsable),
        ("renamed.json".to_string(), SkipReason::ForeignId),
      ]
    );
  }

  #[test]
  fn load_dir_names_the_cloud_conflict_copy_it_passed_over() {
    let dir = tempdir().unwrap();
    // The case this whole report exists for: a sync client wrote a second file
    // holding the same note, and the list silently came back one note short of
    // what is on disk. The copy is reported as foreign rather than duplicate
    // because its name is what disqualifies it — the id inside it is `a`, but
    // `save_note` only ever writes `{id}.json`. DuplicateId is reached only by
    // two files whose stems both equal the id, i.e. a case-differing extension,
    // which a case-insensitive filesystem cannot even hold.
    std::fs::write(
      dir.path().join("a (conflicted copy).json"),
      r#"{"id":"a","content":"copy","file_path":null}"#,
    )
    .unwrap();
    std::fs::write(
      dir.path().join("a.json"),
      r#"{"id":"a","content":"real","file_path":null}"#,
    )
    .unwrap();
    let loaded = load_dir(dir.path()).unwrap();
    assert_eq!(loaded.items.len(), 1);
    assert_eq!(loaded.items[0].content, "real");
    assert_eq!(
      loaded.skipped,
      vec![SkippedFile {
        name: "a (conflicted copy).json".to_string(),
        reason: SkipReason::ForeignId,
      }]
    );
  }

  #[test]
  fn startup_skips_are_handed_out_once() {
    let held = StartupSkips::holding(vec![SkippedFile {
      name: "a.json".to_string(),
      reason: SkipReason::ForeignId,
    }]);
    assert_eq!(held.0.lock().unwrap().as_ref().map(Vec::len), Some(1));
    // The report belongs to the first window that asks, not to every window
    // that gains focus afterwards.
    assert!(held.0.lock().unwrap().take().is_some());
    assert!(held.0.lock().unwrap().take().is_none());
  }

  #[test]
  fn startup_skips_hold_nothing_when_nothing_was_skipped() {
    assert!(StartupSkips::holding(Vec::new())
      .0
      .lock()
      .unwrap()
      .is_none());
  }

  #[test]
  fn load_dir_loads_a_file_with_an_uppercase_json_extension() {
    let dir = tempdir().unwrap();
    // Simulate a sync client/FAT round-trip that changed only the case of the
    // extension, leaving the stem (and so the filename/id match) untouched.
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(note("a")).unwrap();
    std::fs::rename(dir.path().join("a.json"), dir.path().join("a.JSON")).unwrap();
    let loaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(loaded, vec![note("a")]);
  }

  #[test]
  fn load_dir_dedupes_two_files_carrying_the_same_id() {
    let dir = tempdir().unwrap();
    // Two distinct file names (not just a case-differing extension, which
    // may not collide on a case-insensitive host filesystem) that both pass
    // the extension filter and both parse to id "a".
    std::fs::write(
      dir.path().join("a.json"),
      r#"{"id":"a","content":"one","file_path":null}"#,
    )
    .unwrap();
    std::fs::write(
      dir.path().join("a-copy.JSON"),
      r#"{"id":"a","content":"two","file_path":null}"#,
    )
    .unwrap();
    let loaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].id, "a");
  }

  #[test]
  fn load_dir_prefers_exact_filename_match_over_a_conflict_copy_that_sorts_first() {
    let dir = tempdir().unwrap();
    // A sync client's conflict copy: its space (0x20) sorts before the real
    // file's dot (0x2E), so a naive lexicographic tie-break would wrongly
    // pick this file over `a.json`.
    std::fs::write(
      dir.path().join("a (conflicted copy).json"),
      r#"{"id":"a","content":"copy","file_path":null}"#,
    )
    .unwrap();
    std::fs::write(
      dir.path().join("a.json"),
      r#"{"id":"a","content":"real","file_path":null}"#,
    )
    .unwrap();
    let loaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].content, "real");
  }

  #[test]
  fn load_dir_prefers_exact_filename_match_over_a_copy_that_sorts_after() {
    let dir = tempdir().unwrap();
    // `a-copy.JSON` sorts after `a.json` (`-` is 0x2D, `.` is 0x2E), so this
    // case cannot pass by accident of a fixed sort direction either.
    std::fs::write(
      dir.path().join("a.json"),
      r#"{"id":"a","content":"real","file_path":null}"#,
    )
    .unwrap();
    std::fs::write(
      dir.path().join("a-copy.JSON"),
      r#"{"id":"a","content":"copy","file_path":null}"#,
    )
    .unwrap();
    let loaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].content, "real");
  }

  #[test]
  fn load_dir_skips_unparsable_file() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(note("good")).unwrap();
    // A corrupt sibling must be skipped, never crash the load.
    std::fs::write(dir.path().join("bad.json"), "{ not json").unwrap();
    // A non-json file is ignored entirely.
    std::fs::write(dir.path().join("notes.txt"), "ignore me").unwrap();
    let loaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(loaded, vec![note("good")]);
  }

  #[test]
  fn load_dir_skips_a_copy_carrying_an_id_that_is_already_taken() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(note("a")).unwrap();
    store.upsert(note("b")).unwrap();
    // What a cloud sync leaves behind on a conflict: a byte-identical copy under
    // a new name, still carrying id "a". Two notes sharing one id would restore
    // into two windows with the same label and kill the launch.
    let original = std::fs::read(dir.path().join("a.json")).unwrap();
    std::fs::write(dir.path().join("a (conflicted copy).json"), &original).unwrap();
    let mut ids: Vec<String> = NoteStore::load(dir.path().to_path_buf())
      .unwrap()
      .list()
      .into_iter()
      .map(|n| n.id)
      .collect();
    ids.sort();
    assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
  }

  #[test]
  fn load_dir_skips_a_renamed_file_even_when_nothing_else_claims_its_id() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(note("a")).unwrap();
    std::fs::rename(dir.path().join("a.json"), dir.path().join("a-backup.json")).unwrap();
    assert!(NoteStore::load(dir.path().to_path_buf())
      .unwrap()
      .list()
      .is_empty());
  }

  #[test]
  fn a_note_file_from_an_older_build_gets_new_field_defaults() {
    // A snapshot file written before `pin_mode`, `kind`, `dirty` and `opacity`
    // existed: the pin flag is upgraded and every absent field takes its serde
    // default, so an older file still restores instead of failing to parse.
    let dir = tempdir().unwrap();
    std::fs::write(
      dir.path().join("a.json"),
      r#"{"id":"a","content":"hi","file_path":null,"language":"Rust","pinned":true}"#,
    )
    .unwrap();
    let notes = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].pin_mode, "top");
    assert_eq!(notes[0].kind, "sticky");
    assert!(!notes[0].dirty);
    assert_eq!(notes[0].opacity, 1.0);
    assert_eq!(notes[0].language, Some("Rust".into()));
  }

  #[test]
  fn set_dir_moves_files_to_new_location() {
    let root = tempdir().unwrap();
    let dir1 = root.path().join("local/snapshots");
    let dir2 = root.path().join("icloud/snapshots");
    let store = NoteStore::load(dir1.clone()).unwrap();
    store.upsert(note("a")).unwrap();
    store.upsert(note("b")).unwrap();
    store
      .set_dir(dir2.clone(), true, CollisionPolicy::Source)
      .unwrap();
    assert!(dir2.join("a.json").exists());
    assert!(dir2.join("b.json").exists());
    assert!(!dir1.join("a.json").exists());
    assert!(!dir1.join("b.json").exists());
    assert_eq!(store.list().len(), 2);
    assert_eq!(NoteStore::load(dir2).unwrap().list().len(), 2);
  }

  #[test]
  fn set_dir_moves_a_file_present_on_disk_but_absent_from_memory() {
    let root = tempdir().unwrap();
    let dir1 = root.path().join("local/snapshots");
    let dir2 = root.path().join("icloud/snapshots");
    let store = NoteStore::load(dir1.clone()).unwrap();
    store.upsert(note("a")).unwrap();
    // Present on disk (e.g. a sticky, or a note left behind by a store that
    // started empty) but never went through `upsert`, so it is not in memory.
    let stray = note("stray");
    std::fs::create_dir_all(&dir1).unwrap();
    std::fs::write(
      dir1.join("stray.json"),
      serde_json::to_string_pretty(&stray).unwrap(),
    )
    .unwrap();
    store
      .set_dir(dir2.clone(), true, CollisionPolicy::Source)
      .unwrap();
    assert!(dir2.join("stray.json").exists());
    assert!(!dir1.join("stray.json").exists());
    let mut ids: Vec<String> = store.list().into_iter().map(|n| n.id).collect();
    ids.sort();
    assert_eq!(ids, vec!["a".to_string(), "stray".to_string()]);
  }

  #[test]
  fn collision_source_policy_overwrites_destination() {
    let root = tempdir().unwrap();
    let dir1 = root.path().join("local");
    let dir2 = root.path().join("cloud");
    let store = NoteStore::load(dir1.clone()).unwrap();
    let mut a = note("a");
    a.content = "from source".into();
    store.upsert(a).unwrap();
    std::fs::create_dir_all(&dir2).unwrap();
    let mut dest_a = note("a");
    dest_a.content = "from destination".into();
    std::fs::write(
      dir2.join("a.json"),
      serde_json::to_string_pretty(&dest_a).unwrap(),
    )
    .unwrap();
    store
      .set_dir(dir2.clone(), true, CollisionPolicy::Source)
      .unwrap();
    let loaded = NoteStore::load(dir2).unwrap().get("a").unwrap();
    assert_eq!(loaded.content, "from source");
    assert!(!dir1.join("a.json").exists());
  }

  #[test]
  fn collision_dest_policy_keeps_destination_and_leaves_source_in_place() {
    let root = tempdir().unwrap();
    let dir1 = root.path().join("local");
    let dir2 = root.path().join("cloud");
    let store = NoteStore::load(dir1.clone()).unwrap();
    let mut a = note("a");
    a.content = "from source".into();
    store.upsert(a).unwrap();
    std::fs::create_dir_all(&dir2).unwrap();
    let mut dest_a = note("a");
    dest_a.content = "from destination".into();
    std::fs::write(
      dir2.join("a.json"),
      serde_json::to_string_pretty(&dest_a).unwrap(),
    )
    .unwrap();
    store
      .set_dir(dir2.clone(), true, CollisionPolicy::Dest)
      .unwrap();
    let loaded = NoteStore::load(dir2).unwrap().get("a").unwrap();
    assert_eq!(loaded.content, "from destination");
    // The source copy was never deleted: it stays behind in the old folder.
    assert!(dir1.join("a.json").exists());
  }

  #[test]
  fn collision_both_policy_gives_the_incoming_copy_a_new_loadable_id() {
    let root = tempdir().unwrap();
    let dir1 = root.path().join("local");
    let dir2 = root.path().join("cloud");
    let store = NoteStore::load(dir1.clone()).unwrap();
    let mut a = note("a");
    a.content = "from source".into();
    store.upsert(a).unwrap();
    std::fs::create_dir_all(&dir2).unwrap();
    let mut dest_a = note("a");
    dest_a.content = "from destination".into();
    std::fs::write(
      dir2.join("a.json"),
      serde_json::to_string_pretty(&dest_a).unwrap(),
    )
    .unwrap();
    store
      .set_dir(dir2.clone(), true, CollisionPolicy::Both)
      .unwrap();
    assert!(!dir1.join("a.json").exists());
    let notes = NoteStore::load(dir2).unwrap().list();
    assert_eq!(notes.len(), 2);
    let contents: std::collections::HashSet<&str> =
      notes.iter().map(|n| n.content.as_str()).collect();
    assert_eq!(
      contents,
      std::collections::HashSet::from(["from source", "from destination"])
    );
    // The incoming copy is a genuinely new, loadable note: a different id
    // than "a", and it is not itself named "a" (which is what makes it
    // survive `load_dir`'s stem-must-match-id check rather than a rename).
    let new_note = notes.iter().find(|n| n.content == "from source").unwrap();
    assert_ne!(new_note.id, "a");
  }

  #[test]
  fn a_failure_partway_through_leaves_no_residue_at_the_destination() {
    let root = tempdir().unwrap();
    let dir1 = root.path().join("local");
    let dir2 = root.path().join("dst");
    let store = NoteStore::load(dir1.clone()).unwrap();
    // "a" sorts (and so copies) before "b" on every platform's read_dir walk
    // in practice, but the important thing is only one of the two can land.
    store.upsert(note("a")).unwrap();
    store.upsert(note("b")).unwrap();
    // "b.json" already exists at the destination as a *directory*: copying
    // "b"'s file onto it fails partway through the batch, after "a" landed.
    std::fs::create_dir_all(dir2.join("b.json")).unwrap();
    let result = store.set_dir(dir2.clone(), true, CollisionPolicy::Source);
    assert!(result.is_err());
    // The one file that did land was cleaned up: no residue at the destination.
    assert!(!dir2.join("a.json").exists());
    // Nothing was removed from the source, and the store never switched.
    assert!(dir1.join("a.json").exists());
    assert!(dir1.join("b.json").exists());
    assert_eq!(store.current_dir(), dir1);
    assert_eq!(store.list().len(), 2);
  }

  #[test]
  fn failed_setting_write_rolls_the_move_back() {
    let root = tempdir().unwrap();
    let dir1 = root.path().join("local");
    let dir2 = root.path().join("cloud");
    let store = NoteStore::load(dir1.clone()).unwrap();
    store.upsert(note("a")).unwrap();
    let result = switch_and_persist(&store, dir2.clone(), true, CollisionPolicy::Source, || {
      Err("disk full".to_string())
    });
    assert!(result.is_err());
    // Files are back at the old location, and the store still points at it.
    assert!(dir1.join("a.json").exists());
    assert!(!dir2.join("a.json").exists());
    assert_eq!(store.current_dir(), dir1);
    assert_eq!(store.list(), vec![note("a")]);
  }

  #[test]
  fn the_setting_is_only_written_after_a_successful_move() {
    // This ordering was documented but never tested.
    let root = tempdir().unwrap();
    let dir1 = root.path().join("local");
    let dir2 = root.path().join("cloud");
    let store = NoteStore::load(dir1.clone()).unwrap();
    store.upsert(note("a")).unwrap();
    // Observed from *inside* the setting-write closure: proves the move (and
    // the dir switch it implies) already happened before this callback ran,
    // not just that it happened by the time the outer call returns.
    let seen_before_write = std::sync::Mutex::new((false, PathBuf::new()));
    let result = switch_and_persist(&store, dir2.clone(), true, CollisionPolicy::Source, || {
      *seen_before_write.lock().unwrap() = (dir2.join("a.json").exists(), store.current_dir());
      Ok(())
    });
    assert!(result.is_ok());
    let (moved_before_write, dir_before_write) = seen_before_write.into_inner().unwrap();
    assert!(moved_before_write);
    assert_eq!(dir_before_write, dir2);
  }

  #[test]
  fn document_kind_roundtrips() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    let mut doc = note("d");
    doc.kind = "document".into();
    doc.file_path = Some("/tmp/x.txt".into());
    doc.dirty = true;
    store.upsert(doc.clone()).unwrap();
    let reloaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(reloaded, vec![doc]);
  }

  #[test]
  fn tab_fields_roundtrip_through_disk() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    let mut d = doc("d", Some("grp-1"), 3);
    d.line_ending = "CRLF".into();
    d.had_bom = true;
    d.encoding = "Big5".into();
    // A manual plain-text choice: explicit true with no language must survive.
    d.explicit = true;
    d.language = None;
    store.upsert(d.clone()).unwrap();
    let reloaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(reloaded, vec![d]);
  }

  #[test]
  fn legacy_document_defaults_tab_fields() {
    // An older document file has none of the newer fields.
    let dir = tempdir().unwrap();
    std::fs::write(
      dir.path().join("a.json"),
      r#"{"id":"a","content":"hi","file_path":"/tmp/a.txt","kind":"document"}"#,
    )
    .unwrap();
    let notes = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].window_group, None);
    assert_eq!(notes[0].tab_index, 0);
    assert_eq!(notes[0].line_ending, "LF");
    assert!(!notes[0].had_bom);
    assert_eq!(notes[0].encoding, "UTF-8");
    // A pre-revision document has no project tag.
    assert_eq!(notes[0].project, None);
    // Legacy files predate the explicit flag: they default to auto-detect.
    assert!(!notes[0].explicit);
    // A document written before the large-file viewer existed is an ordinary
    // tab, not a large-file view.
    assert_eq!(notes[0].large, None);
    // A pre-range document carries no range markers.
    assert_eq!(notes[0].range_source, None);
    assert_eq!(notes[0].range_start, None);
    assert_eq!(notes[0].range_end, None);
    assert_eq!(notes[0].range_fp_size, None);
    assert_eq!(notes[0].range_fp_mtime, None);
    assert_eq!(notes[0].range_start_line, None);
    // An older document predates the windowed-restore fields entirely; a user
    // upgrading must not lose the tab (it deserializes, just as an ordinary tab).
    assert_eq!(notes[0].windowed_index, None);
    assert_eq!(notes[0].windowed_fp_size, None);
    assert_eq!(notes[0].windowed_fp_mtime, None);
    assert_eq!(notes[0].windowed_digest, None);
    assert_eq!(notes[0].windowed_top_line, None);
  }

  #[test]
  fn windowed_tab_roundtrips_through_disk() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    let mut d = doc("d", Some("grp-1"), 0);
    d.large = Some(200 * 1024 * 1024);
    d.windowed_index = Some(crate::windowed::CheckpointIndex {
      checkpoints: vec![(0, 0), (1_048_576, 12)],
      total_newlines: 5000,
    });
    d.windowed_fp_size = Some(200 * 1024 * 1024);
    d.windowed_fp_mtime = Some(1_700_000_000_000);
    // A real FNV-1a digest exceeds `f64`'s 53-bit integer precision
    // comfortably, but the point of storing it as a string is that it
    // survives untouched even at that magnitude — see `windowed::IndexSnapshot`.
    d.windowed_digest = Some(0xdead_beef_cafe_babeu64.to_string());
    d.windowed_top_line = Some(42);
    store.upsert(d.clone()).unwrap();
    let reloaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(reloaded, vec![d]);
  }

  #[test]
  fn range_tab_roundtrips_through_disk() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    let mut d = doc("d", Some("grp-1"), 0);
    d.file_path = Some(String::new());
    d.range_source = Some("/tmp/big.log".into());
    d.range_start = Some(1024);
    d.range_end = Some(2048);
    d.range_fp_size = Some(9_000_000);
    d.range_fp_mtime = Some(1_700_000_000_000);
    d.range_start_line = Some(3);
    store.upsert(d.clone()).unwrap();
    let reloaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(reloaded, vec![d]);
  }

  #[test]
  fn legacy_range_label_note_loads_with_no_start_line() {
    // An older range tab persisted a formatted `range_label` instead of a
    // start line. The field no longer exists on `NoteSnapshot`; serde ignores
    // the unknown key by default, so the note must still load intact (the
    // frontend falls back to the bare file name for it, not a nonsensical
    // line span reconstructed from the old string).
    let dir = tempdir().unwrap();
    std::fs::write(
      dir.path().join("d.json"),
      r#"{"id":"d","content":"","file_path":"","kind":"document",
          "range_source":"/tmp/big.log","range_start":1024,"range_end":2048,
          "range_label":"big.log（第 3–9 行）"}"#,
    )
    .unwrap();
    let notes = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].range_source.as_deref(), Some("/tmp/big.log"));
    assert_eq!(notes[0].range_start_line, None);
  }

  #[test]
  fn large_tab_roundtrips_through_disk() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    let mut d = doc("d", Some("grp-1"), 0);
    d.large = Some(200 * 1024 * 1024);
    store.upsert(d.clone()).unwrap();
    let reloaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(reloaded, vec![d]);
  }

  #[test]
  fn project_tag_roundtrips_through_disk() {
    let dir = tempdir().unwrap();
    let store = NoteStore::load(dir.path().to_path_buf()).unwrap();
    let mut d = doc("d", Some("grp-1"), 0);
    d.project = Some("/tmp/project".into());
    store.upsert(d.clone()).unwrap();
    let reloaded = NoteStore::load(dir.path().to_path_buf()).unwrap().list();
    assert_eq!(reloaded, vec![d]);
  }

  #[test]
  fn plan_groups_tabs_and_ignores_stickies() {
    let notes = vec![
      note("sticky"),
      doc("a", Some("g1"), 1),
      doc("b", Some("g1"), 0),
      doc("c", Some("g2"), 0),
    ];
    let plans = plan_document_windows(&notes);
    assert_eq!(plans.len(), 2);
    // g1 keeps first-appearance order; its bounds come from the lowest tab_index (b).
    assert_eq!(plans[0].group, "g1");
    assert_eq!(plans[0].x, doc("b", Some("g1"), 0).x);
    assert_eq!(plans[1].group, "g2");
  }

  #[test]
  fn plan_treats_group_none_as_solo_group_by_id() {
    let notes = vec![doc("solo1", None, 0), doc("solo2", None, 0)];
    let plans = plan_document_windows(&notes);
    assert_eq!(plans.len(), 2);
    assert_eq!(plans[0].group, "solo1");
    assert_eq!(plans[1].group, "solo2");
  }

  #[test]
  fn snapshot_dir_for_default_and_picked() {
    let app_data = Path::new("/app-data");
    // None (the default) resolves to the app data dir, exactly as before this
    // setting existed.
    assert_eq!(snapshot_dir_for(app_data, None), app_data.join("snapshots"));
    // A picked parent gets our own "Note&Pad" folder nested inside it.
    let picked = Path::new("/Volumes/Cloud");
    assert_eq!(
      snapshot_dir_for(app_data, Some(picked)),
      picked.join("Note&Pad").join("snapshots")
    );
  }

  #[test]
  fn migrate_legacy_snapshot_location_maps_every_branch() {
    let cloud_parent = PathBuf::from("/Users/x/Library/Mobile Documents/com~apple~CloudDocs");
    // "local" always migrates to None (the new default), regardless of
    // whether an iCloud parent happens to be available.
    assert_eq!(
      migrate_legacy_snapshot_location("local", Some(cloud_parent.clone())),
      None
    );
    assert_eq!(migrate_legacy_snapshot_location("local", None), None);
    // An unknown/garbage legacy value also falls back to None.
    assert_eq!(
      migrate_legacy_snapshot_location("dropbox", Some(cloud_parent.clone())),
      None
    );
    // "icloud" with an available parent migrates to that parent, so
    // `snapshot_dir_for` reconstructs the exact same directory as before.
    assert_eq!(
      migrate_legacy_snapshot_location("icloud", Some(cloud_parent.clone())),
      Some(cloud_parent)
    );
    // "icloud" with no iCloud parent (a non-macOS machine) migrates to None:
    // there was never an iCloud dir there.
    assert_eq!(migrate_legacy_snapshot_location("icloud", None), None);
  }
}
