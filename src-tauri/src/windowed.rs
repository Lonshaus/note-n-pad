// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Session-based windowed editing commands on top of the byte-coordinate piece
//! table. A `windowed_open` streams the file once to build a sparse line
//! checkpoint index and validate its UTF-8, then keeps a `PieceTable<File>` alive
//! in managed state under an incrementing session id. The frontend reads sliding
//! line windows
//! (`windowed_read`), applies batched global-coordinate edits (`windowed_apply`),
//! streams the result back to disk (`windowed_save`), and releases the session
//! (`windowed_close`). Byte coordinates and split-style line counting match the
//! piece table and `large_file`.

use crate::large_file::preview_at;
use crate::line_rule::BreakCounter;
use crate::note_store::{CheckpointIndex, LINE_RULE};
use crate::piece_table::{OriginalIndex, OriginalSource, PieceTable};
use crate::range_edit::{Fingerprint, FINGERPRINT_MISMATCH};
use crate::replace_layer::{self, Builder, ChangeList, Dir, Src, Table};
use crate::windowed_scan::{scan_backward, scan_forward, Event, Flow, ScanStop};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// One-pass scan / streaming-copy buffer (1 MiB): the same size the range-edit
/// path uses, keeping syscall overhead low without holding much of the file.
const SCAN_BUF: usize = 1024 * 1024;

/// Byte distance between sparse line-index checkpoints (1 MiB). Bounds the
/// forward scan any single original-buffer newline query costs, and sets the
/// checkpoint memory to `16 * ceil(file_len / CHECKPOINT_INTERVAL)` bytes — for a
/// 240 MB file, ~240 entries (< 4 KiB), versus ~40 MB for a dense per-line index.
/// 1 MiB matches `SCAN_BUF`, so a checkpoint segment is at most one scan buffer.
const CHECKPOINT_INTERVAL: u64 = 1024 * 1024;

/// Protocol error string returned when a file is not valid UTF-8. The frontend
/// keys its "can't open" message off this exact value, not off prose.
const NOT_UTF8: &str = "not-utf8";

/// Protocol error string returned by every command whose session id is not (or is
/// no longer) live. A single constant so the frontend can match one value.
const UNKNOWN_SESSION: &str = "unknown-session";
/// Bytes a search or replace-all pass reads per chunk (256 KiB), the same as the
/// viewer's search. The session lock is held for one chunk at a time.
const SCAN_CHUNK: usize = 256 * 1024;

/// Protocol error strings returned when there is nothing left to undo / redo. The
/// frontend keys silent no-ops off these exact values.
const NOTHING_TO_UNDO: &str = "nothing-to-undo";
const NOTHING_TO_REDO: &str = "nothing-to-redo";
/// A replace-all token the session does not hold.
const UNKNOWN_TOKEN: &str = "unknown-token";

/// Protocol error string returned by `windowed_open` / `windowed_reopen` for a
/// file at or above `LARGE_EDIT_MAX`. A single constant so the frontend can key
/// its "too large to edit" message off one exact value.
const TOO_LARGE: &str = "too-large";

/// Ceiling above which windowed editing is refused (512 MiB), enforced here as
/// an invariant rather than only as a disabled button. The frontend carries its
/// own copy of this same threshold as `LARGE_EDIT_MAX` in
/// `documentWindow.svelte.ts`; the two values must be kept in agreement. Do not
/// change this without updating that one.
const LARGE_EDIT_MAX: u64 = 512 * 1024 * 1024;

/// Per-region size (4 KiB) for the sampled digest `windowed_reopen`'s fast path
/// checks alongside the fingerprint (see `sample_digest`). At the 512 MiB
/// ceiling there are ~512 checkpoints, so ~512 regions of this size is ~2 MiB
/// total — well under a full-file hash, and the whole point of the fast path.
const SAMPLE_BLOCK: u64 = 4096;

/// FNV-1a 64-bit, implemented inline rather than reaching for
/// `std::collections::hash_map::DefaultHasher`: `DefaultHasher`'s docs
/// explicitly do not guarantee its output is stable across Rust versions or
/// even between runs of the same program. This digest is persisted to disk
/// across app runs (it rides along with a session's fingerprint), so a
/// `DefaultHasher`-based digest could silently stop matching after nothing
/// more than a toolchain upgrade — every restore would fall back to a full
/// rescan with no visible cause. FNV-1a is a fixed algorithm, not a language
/// feature, so its output is stable forever; the whole implementation is the
/// five lines below.
struct Fnv1a(u64);

impl Fnv1a {
  const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
  const PRIME: u64 = 0x100000001b3;

  fn new() -> Self {
    Fnv1a(Self::OFFSET_BASIS)
  }

  fn write(&mut self, bytes: &[u8]) {
    for &b in bytes {
      self.0 ^= b as u64;
      self.0 = self.0.wrapping_mul(Self::PRIME);
    }
  }

  fn write_u64(&mut self, n: u64) {
    self.write(&n.to_le_bytes());
  }
}

/// Compute the sampled digest `windowed_reopen`'s fast path requires to match
/// (alongside the fingerprint) before trusting a persisted `CheckpointIndex`
/// verbatim. Hashes a small fixed set of regions rather than the whole file:
/// the file's last `SAMPLE_BLOCK` bytes, plus one `SAMPLE_BLOCK` region at
/// each checkpoint offset (which already includes offset 0, so "the first
/// block" falls out of that for free). Sampling exactly the checkpoint
/// offsets is the point: those are the positions whose correctness the fast
/// path is trusting when it skips the scan. Each region's own `(offset, len)`
/// is hashed along with its bytes, so a change that shifts content between
/// regions cannot land on the same digest by coincidence. Region starts are
/// deduplicated before hashing so overlap (a small file, or a checkpoint that
/// lands inside the last block) never changes what gets hashed between calls.
///
/// This is deliberately not a full-file hash — reading a bounded few MB
/// instead of the whole file is the reason `windowed_reopen`'s fast path
/// exists. A same-size edit that avoids every sampled region entirely (and
/// also preserves mtime) is invisible to this digest; see
/// `reopen_cannot_detect_content_change_outside_every_sampled_region` for that
/// residual, deliberately narrow limit.
fn sample_digest(path: &Path, total_bytes: u64, checkpoints: &[(u64, u64)]) -> Result<u64, String> {
  let mut starts: Vec<u64> = checkpoints.iter().map(|&(o, _)| o).collect();
  if total_bytes > 0 {
    starts.push(total_bytes.saturating_sub(SAMPLE_BLOCK));
  }
  starts.sort_unstable();
  starts.dedup();

  let mut file = File::open(path).map_err(|e| e.to_string())?;
  let mut hasher = Fnv1a::new();
  let mut buf = vec![0u8; SAMPLE_BLOCK as usize];
  for start in starts {
    if start >= total_bytes {
      continue;
    }
    let len = SAMPLE_BLOCK.min(total_bytes - start) as usize;
    file
      .seek(SeekFrom::Start(start))
      .map_err(|e| e.to_string())?;
    file
      .read_exact(&mut buf[..len])
      .map_err(|e| e.to_string())?;
    hasher.write_u64(start);
    hasher.write_u64(len as u64);
    hasher.write(&buf[..len]);
  }
  Ok(hasher.0)
}

/// Maximum number of undo groups kept per session; the oldest is dropped once the
/// stack grows past it.
// ponytail: the journal is bounded by group count, not bytes — a single group can
// still hold arbitrarily large removed text (e.g. a huge delete). This caps the
// common "many small edits" growth; switch to a byte budget if pathological single
// edits ever dominate memory.
const UNDO_LIMIT: usize = 512;
/// Bytes read per step when a cascade looks backwards for the start of a run of
/// `\r`.
const CASCADE_READ: u64 = 64 * 1024;

/// One reversible replace in global byte coordinates: replace `[start, end)` with
/// `text`. Stored inverses undo a forward apply; applied in the frame current when
/// each is reached (see `Session::apply` / `apply_inverse_group`).
struct InverseEdit {
  start: u64,
  end: u64,
  text: String,
  /// Copied from the forward edit: an offset at `start` stays put when the
  /// frontend maps it through this edit.
  keep_start: bool,
  /// For a run of break bytes rewritten in place: the byte the range holds
  /// once this edit is applied, with `text` empty. The run itself is never
  /// copied into the journal.
  fill: Option<u8>,
}

/// The inverse edits of one coalesced undo step, in the order the forward edits
/// were applied. Undone by reverse-order sequential application, which walks the
/// document back through each intermediate state in its own coordinate frame.
type EditGroup = Vec<InverseEdit>;
/// A replace-all in the journal: only its change list, never a file handle or an
/// older piece table (a save can overwrite the file such a table reads).
/// `layer_id` names the forward layer this entry installed while that layer may
/// still be the table's top, unedited layer, so undoing it can simply take the
/// layer off.
struct ReplaceEntry {
  list: Arc<ChangeList>,
  layer_id: Option<u64>,
}
/// One undo step: a coalesced group of typing edits, or a replace-all. A typing
/// edit never coalesces into a replace-all.
enum JournalEntry {
  Edits(EditGroup),
  Replace(ReplaceEntry),
}
/// A journal entry with the content states around it: undoing it returns the
/// session to `before`, redoing it to `after`. Coalesced typing moves `after`.
struct Step {
  entry: JournalEntry,
  before: u64,
  after: u64,
}

/// A live editing session: the piece table over the file, the path it was opened
/// from (updated on save-as), the file's fingerprint at open / last save, the
/// checkpoint index that produced the table's `OriginalIndex` plus the sampled
/// digest computed against it (kept alongside so the frontend can read them
/// back out for persistence — see `windowed_index`), and the global-coordinate
/// undo/redo journal.
///
/// `index`, `digest` and `fingerprint` always describe the file at `path` (what
/// `windowed_index` returns and a snapshot persists), whatever layers the table
/// is stacked on.
struct Session {
  table: Table,
  path: PathBuf,
  fingerprint: Fingerprint,
  index: CheckpointIndex,
  digest: u64,
  /// Undo entries, oldest first; each undoes one coalesced edit step or one
  /// replace-all.
  undo_stack: Vec<Step>,
  /// Redo entries, populated by undo and cleared by any fresh apply.
  redo_stack: Vec<Step>,
  /// Bumped by every change of the content: apply, undo, redo, replace-all and
  /// the save that retargets the session. A scan records it when it starts and
  /// checks it at every chunk.
  generation: u64,
  /// Id of the content state the session is in. Every change that is not an
  /// undo or redo takes a fresh id, so an id names one content for good.
  state_id: u64,
  /// The `state_id` that was last written to disk (or opened).
  saved_state_id: u64,
  /// The next unused state id.
  next_state_id: u64,
  /// Set by a save: the next edit opens an undo step of its own, so undoing it
  /// can land exactly on the saved state.
  seal_group: bool,
  /// True while a replace-all pass runs. The commands that read or change the
  /// session wait for it to clear (see `WindowedState::lock_idle`).
  busy: bool,
  /// Change lists of replace-alls (done, undone or redone) whose offsets the
  /// frontend may still map, by token, with the direction of the change that
  /// produced the token. Holding the `Arc` keeps the list and its file alive
  /// after the journal and the layers have dropped theirs.
  replace_tokens: HashMap<u64, (Arc<ChangeList>, Dir)>,
  next_token: u64,
}

impl Session {
  fn new(
    table: Table,
    path: PathBuf,
    fingerprint: Fingerprint,
    index: CheckpointIndex,
    digest: u64,
  ) -> Self {
    Session {
      table,
      path,
      fingerprint,
      index,
      digest,
      undo_stack: Vec::new(),
      redo_stack: Vec::new(),
      generation: 0,
      state_id: 0,
      saved_state_id: 0,
      next_state_id: 1,
      seal_group: false,
      busy: false,
      replace_tokens: HashMap::new(),
      next_token: 1,
    }
  }
  /// Register a change list under a fresh token, mapping offsets in `dir`.
  fn register_token(&mut self, list: Arc<ChangeList>, dir: Dir) -> u64 {
    let token = self.next_token;
    self.next_token += 1;
    self.replace_tokens.insert(token, (list, dir));
    token
  }
  /// Map `offsets` through the replace-all behind `token`.
  fn map_replace(&self, token: u64, offsets: &[u64]) -> Result<Vec<u64>, String> {
    let (list, dir) = self
      .replace_tokens
      .get(&token)
      .ok_or_else(|| UNKNOWN_TOKEN.to_string())?;
    offsets.iter().map(|&o| list.map_offset(*dir, o)).collect()
  }
  /// Whether the content equals what was last saved.
  fn clean(&self) -> bool {
    self.state_id == self.saved_state_id
  }
}

/// A session's checkpoint index plus the fingerprint and sampled digest it was
/// built against, for the frontend to persist and later hand back to
/// `windowed_reopen`. `digest` crosses the IPC boundary as a decimal string,
/// not a raw JSON number: Tauri's frontend parses command responses with
/// `JSON.parse`, which decodes every number as an IEEE-754 `f64`. FNV-1a's
/// full 64-bit range exceeds `f64`'s 53-bit integer precision the large
/// majority of the time, so a `u64` digest silently rounds the instant JS
/// touches it — the rounded value is what would get persisted and handed back
/// to `windowed_reopen`, permanently defeating the fast path it was supposed
/// to enable. A decimal string round-trips exactly; `windowed_reopen` parses
/// it back into a `u64` (see `parse_digest`).
#[derive(Serialize)]
pub struct IndexSnapshot {
  pub index: CheckpointIndex,
  pub fingerprint: Fingerprint,
  pub digest: String,
}

/// Result of reopening a file for windowed editing from a previously persisted
/// checkpoint index (see `windowed_reopen`). `rescanned` is true when the
/// supplied fingerprint no longer matched the file on disk (or the supplied
/// index failed validation), so a full scan rebuilt the index instead of
/// trusting the caller's copy — the frontend uses this to distinguish an
/// instant reopen from one that just paid the scan cost the fingerprint match
/// was supposed to avoid.
#[derive(Serialize)]
pub struct ReopenResult {
  pub session_id: u64,
  pub total_bytes: u64,
  pub total_lines: u64,
  pub fingerprint: Fingerprint,
  pub rescanned: bool,
}

/// Managed state holding every open windowed-editing session, keyed by an
/// incrementing id.
// ponytail: one global lock guards all sessions, and save/rebase does file I/O
// while holding it. Sessions are per-document and edits are user-paced, so this
// never contends in practice; shard per session id if that ever changes.
#[derive(Default)]
pub struct WindowedState {
  sessions: Mutex<HashMap<u64, Session>>,
  /// Signalled when a replace-all pass ends and its session is idle again.
  idle: Condvar,
  next_id: AtomicU64,
  /// Cancel flags of the running result-list searches, by search id.
  searches: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl WindowedState {
  /// The sessions map locked, once session `id` is not running a replace-all.
  /// An unknown session is `UNKNOWN_SESSION`. Commands that touch a session wait
  /// here, so none can land between two chunks of a pass; they are all
  /// `#[tauri::command(async)]`, so the wait never blocks the main thread.
  fn lock_idle(&self, id: u64) -> Result<MutexGuard<'_, HashMap<u64, Session>>, String> {
    let mut map = self.sessions.lock().unwrap();
    loop {
      let busy = map
        .get(&id)
        .ok_or_else(|| UNKNOWN_SESSION.to_string())?
        .busy;
      if !busy {
        return Ok(map);
      }
      map = self.idle.wait(map).unwrap();
    }
  }
}
/// Clears a session's busy flag and wakes the commands waiting on it, however
/// the pass ends.
struct BusyGuard<'a> {
  state: &'a WindowedState,
  id: u64,
}

impl Drop for BusyGuard<'_> {
  fn drop(&mut self) {
    let mut map = self
      .state
      .sessions
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(session) = map.get_mut(&self.id) {
      session.busy = false;
    }
    self.state.idle.notify_all();
  }
}

/// Result of opening a file for windowed editing.
#[derive(Serialize)]
pub struct OpenResult {
  pub session_id: u64,
  pub total_bytes: u64,
  pub total_lines: u64,
  pub fingerprint: Fingerprint,
}

/// A read-back window: its text plus the byte range it covers and the current
/// global document statistics.
#[derive(Serialize)]
pub struct WindowResult {
  pub text: String,
  pub start_offset: u64,
  pub end_offset: u64,
  pub start_line: u64,
  pub total_lines: u64,
  pub total_bytes: u64,
  /// The window does not start the file and the byte before it is a `\r`
  /// (a window starts at a line start, so that `\r` is a break of its own).
  pub prev_lone_cr: bool,
  /// The window does not end the file and the byte at its end is a `\n`.
  pub next_is_lf: bool,
}

/// Current global document statistics after a mutating command.
#[derive(Serialize)]
pub struct DocStats {
  pub total_bytes: u64,
  pub total_lines: u64,
  /// True when the content equals what was last saved.
  pub clean: bool,
  /// The session's content generation after this result; a result with a lower
  /// one than another already seen is stale.
  pub generation: u64,
}

/// Result of a successful save: the rewritten file's fingerprint plus the current
/// document statistics (unchanged by the write, but returned for symmetry).
#[derive(Debug, Serialize)]
pub struct SaveResult {
  pub fingerprint: Fingerprint,
  pub total_bytes: u64,
  pub total_lines: u64,
  pub clean: bool,
  pub generation: u64,
}

/// A single replace expressed in global byte coordinates of the pre-apply
/// document: replace `[start, end)` with `text`.
///
/// `keep_start` marks the rewrite of a lone `\r` that an edit would otherwise
/// join to a `\n`: an offset at `start` is kept at `start`. `cascade` (always
/// with `keep_start`, over exactly one `\r`) also rewrites, for a `\n` text, the
/// run of `\r` bytes directly before it once the batch is applied.
#[derive(serde::Deserialize)]
pub struct Edit {
  pub start: u64,
  pub end: u64,
  pub text: String,
  #[serde(default)]
  pub keep_start: bool,
  #[serde(default)]
  pub cascade: bool,
}

/// One global-byte edit an undo/redo just applied: replace `[start, end)` with
/// `text`, in the document frame current when the frontend receives it. A
/// `fill` edit rewrites a run of break bytes to that byte (`"\r"` or `"\n"`)
/// in place, with `text` empty and the document text unchanged.
#[derive(Serialize, Debug)]
pub struct AppliedEdit {
  pub start: u64,
  pub end: u64,
  pub text: String,
  pub keep_start: bool,
  pub fill: Option<String>,
}

/// Result of a successful undo/redo: the edits just applied (in application order),
/// the 0-based line of the first edit's start (for a jump-to-change window reload),
/// and the current document statistics. For a replace-all there are no edits:
/// `reload_only` is set and `first_line` is the line of its first hit.
#[derive(Serialize, Debug)]
pub struct UndoResult {
  pub edits: Vec<AppliedEdit>,
  pub first_line: u64,
  pub total_bytes: u64,
  pub total_lines: u64,
  /// True for a replace-all undone or redone: `edits` is empty and the
  /// frontend reloads its window instead of mirroring edits.
  pub reload_only: bool,
  pub clean: bool,
  pub generation: u64,
  /// For a `reload_only` result: the token of the replace-all's change list, to
  /// map offsets with `windowed_map_replace` until `windowed_release_replace`.
  pub token: Option<u64>,
}

/// Modification time in milliseconds since the Unix epoch, degrading to 0 when the
/// filesystem does not expose one (mirrors the range-edit fingerprint semantics).
// ponytail: duplicated from range_edit rather than widening its private helpers to
// pub, keeping that module's surface untouched; fold together if a third caller
// appears.
fn mtime_ms(meta: &fs::Metadata) -> u64 {
  meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Read a file's fingerprint (size + mtime) from its metadata.
fn fingerprint_of(path: &Path) -> Result<Fingerprint, String> {
  let meta = fs::metadata(path).map_err(|e| e.to_string())?;
  Ok(Fingerprint {
    size: meta.len(),
    mtime_ms: mtime_ms(&meta),
  })
}
/// A scan pass's `(total_bytes, checkpoints, total_newlines)` result, counted
/// by the line rule (see `line_rule`).
type ScanResult = (u64, Vec<(u64, u64)>, u64);

/// Single streaming pass over `reader`: builds the sparse line-checkpoint index
/// and validates the whole stream as UTF-8, carrying an incomplete trailing
/// multi-byte sequence across buffer boundaries. Returns `(total_bytes,
/// checkpoints, total_newlines)`, where `checkpoints` is seeded with `(0, 0)` and
/// carries one `(offset, newlines_before_offset)` entry per `CHECKPOINT_INTERVAL`
/// bytes (see `OriginalIndex`). Any invalid byte, or a stream that ends
/// mid-character, returns the `NOT_UTF8` protocol error.
fn scan_reader<R: Read>(reader: R, buf_size: usize) -> Result<ScanResult, String> {
  scan_reader_at(reader, buf_size, CHECKPOINT_INTERVAL)
}
/// `scan_reader` with the checkpoint spacing given, so tests can use a small one.
fn scan_reader_at<R: Read>(
  mut reader: R,
  buf_size: usize,
  interval: u64,
) -> Result<ScanResult, String> {
  let mut checkpoints: Vec<(u64, u64)> = vec![(0, 0)];
  let mut last_checkpoint: u64 = 0;
  let mut breaks = BreakCounter::new();
  let mut buf = vec![0u8; buf_size.max(1)];
  let mut pos: u64 = 0;
  // Incomplete trailing UTF-8 sequence carried from the previous chunk (<= 3 B).
  let mut carry: Vec<u8> = Vec::new();
  loop {
    let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    let chunk = &buf[..n];
    // Break scan runs on the raw chunk: a carried byte is always a UTF-8
    // lead or continuation byte, never 0x0A or 0x0D, so it cannot hide a line
    // break.
    for (i, &b) in chunk.iter().enumerate() {
      let abs = pos + i as u64;
      // Record a checkpoint when this byte opens a new interval; the count is
      // the markers strictly before `abs`, which this byte settles for a `\r`
      // just before it.
      if abs - last_checkpoint >= interval {
        checkpoints.push((abs, breaks.count_before_next(b)));
        last_checkpoint = abs;
      }
      breaks.step(b);
    }
    // Validate carry + chunk together so a character split across the boundary
    // is judged whole. Only prepend the carry (an allocation) when there is one.
    let mut combined: Vec<u8>;
    let slice: &[u8] = if carry.is_empty() {
      chunk
    } else {
      combined = std::mem::take(&mut carry);
      combined.extend_from_slice(chunk);
      &combined
    };
    match std::str::from_utf8(slice) {
      Ok(_) => {}
      Err(e) => {
        if e.error_len().is_some() {
          // A genuinely invalid byte mid-slice: reject the file.
          return Err(NOT_UTF8.to_string());
        }
        // Unexpected end of input: the tail is a valid prefix of a
        // character; carry it forward to complete against the next chunk.
        carry = slice[e.valid_up_to()..].to_vec();
      }
    }
    pos += n as u64;
  }
  // A file ending mid-character is not valid UTF-8.
  if !carry.is_empty() {
    return Err(NOT_UTF8.to_string());
  }
  Ok((pos, checkpoints, breaks.finish()))
}

/// Scan a file on disk (see `scan_reader`) using the 1 MiB streaming buffer.
fn scan_file(path: &Path) -> Result<ScanResult, String> {
  let file = File::open(path).map_err(|e| e.to_string())?;
  scan_reader(file, SCAN_BUF)
}

/// Build a fresh piece table over `path` after (re)scanning it. Returns the
/// table, its total byte length, the file's fingerprint, the checkpoint index
/// the scan produced (see `CheckpointIndex`), and the sampled digest computed
/// against that index (see `sample_digest`).
fn build_table(path: &Path) -> Result<(Table, u64, Fingerprint, CheckpointIndex, u64), String> {
  let (total_bytes, checkpoints, total_newlines) = scan_file(path)?;
  let fingerprint = fingerprint_of(path)?;
  let digest = sample_digest(path, total_bytes, &checkpoints)?;
  let file = File::open(path).map_err(|e| e.to_string())?;
  let index = OriginalIndex::new(
    Src::File(file),
    total_bytes,
    total_newlines,
    checkpoints.clone(),
  );
  let table = PieceTable::new(index);
  let checkpoint_index = CheckpointIndex {
    checkpoints,
    total_newlines,
    line_rule: LINE_RULE,
  };
  Ok((table, total_bytes, fingerprint, checkpoint_index, digest))
}

/// Refuse a file at or above `LARGE_EDIT_MAX` before any scan or session is
/// built for it, turning the ceiling into an invariant rather than only a
/// disabled button. `windowed_save` deliberately does not call this: a session
/// already open past the ceiling may still be saved.
fn enforce_size_ceiling(len: u64) -> Result<(), String> {
  if len >= LARGE_EDIT_MAX {
    return Err(TOO_LARGE.to_string());
  }
  Ok(())
}

/// Validate a persisted `CheckpointIndex` against the file's actual current
/// size before `windowed_reopen` trusts it verbatim: a malformed index would
/// silently produce wrong line numbers, which is worse than a slow rescan.
/// Rejects an index counted under another line rule (`line_rule` differs from
/// `LINE_RULE`, as in a snapshot written before the field existed), an empty
/// index for a non-empty file, a first checkpoint other than the required
/// `(0, 0)` seed, non-ascending offsets, any offset at or past
/// the file's current length (the lone `(0, 0)` seed of an empty file is the
/// one exception, since offset 0 there does not reach past anything), a gap
/// between consecutive checkpoints other than exactly `CHECKPOINT_INTERVAL`
/// (the spacing every real scan produces — see `scan_reader`),
/// and a final gap to EOF wider than one interval. That spacing check is what
/// stops a single `(0, 0)` entry claimed for a huge file from validating: with
/// no bound on the gap, `OriginalIndex::load_segment` would read that whole
/// gap into memory in one go, which is exactly the unbounded-memory-use this
/// sparse index exists to avoid — see the project's decoupled-from-file-size
/// memory principle. It also rejects a `total_newlines` smaller than the last
/// checkpoint's own `newlines_before`: the count can only grow (or stay flat)
/// from one checkpoint to the next, so a smaller total is internally
/// inconsistent and cannot have come from a real scan. It also rejects a
/// `newlines_before` that decreases from one checkpoint to the next, for the
/// same reason — and doing so is free insurance against a real panic: with a
/// non-monotonic sequence trusted verbatim, `OriginalIndex::newline_pos`'s
/// `ordinal - checkpoints[seg].1 - 1` can underflow (a debug-build panic, a
/// wrapped-to-huge index in release) the moment a query lands in the segment
/// whose checkpoint claims more newlines than a later one. This is a free
/// check (no extra read), not a complete one — see below for what it does not
/// catch.
///
/// Two residual limitations, deliberately not closed here (closing either
/// means hashing the whole file, the cost the sampled digest exists to
/// avoid): the sampled digest only reads a bounded few MB near the start, the
/// end, and each checkpoint offset, so a same-size edit placed strictly
/// between those regions is invisible to it (see
/// `reopen_cannot_detect_content_change_outside_every_sampled_region`); and
/// the digest hashes each region's offset, length, and bytes, but never any
/// `newlines_before` value, so a tampered *interior* checkpoint's newline
/// count (or a `total_newlines` that is merely too large, not too small) is
/// trusted just as this check would pass it — verifying that fully needs a
/// scan, the cost this whole index exists to avoid. The consequence there is
/// not corruption and not merely wrong line numbering either: most reads land
/// on the underflow above, so `newline_pos` returns an "out of range" error,
/// `windowed_read` fails, and `WindowedEditor`'s `onMount` bails before
/// creating the view — the tab shows an error banner, repeating on every
/// restart until the file changes on disk or the snapshot is deleted. No
/// corruption, but a stuck tab rather than mislabeled text.
fn valid_checkpoint_index(index: &CheckpointIndex, total_bytes: u64) -> bool {
  // Counts made under another line rule are wrong for this one.
  if index.line_rule != LINE_RULE {
    return false;
  }
  if index.checkpoints.is_empty() {
    return total_bytes == 0;
  }
  if index.checkpoints[0] != (0, 0) {
    return false;
  }
  let mut prev_offset = 0u64;
  let mut prev_newlines_before = 0u64;
  let mut last_newlines_before = 0u64;
  for (i, &(offset, newlines_before)) in index.checkpoints.iter().enumerate() {
    if i > 0 {
      if offset <= prev_offset {
        return false;
      }
      if offset - prev_offset != CHECKPOINT_INTERVAL {
        return false;
      }
      if newlines_before < prev_newlines_before {
        return false;
      }
    }
    if offset >= total_bytes && !(offset == 0 && total_bytes == 0) {
      return false;
    }
    prev_offset = offset;
    prev_newlines_before = newlines_before;
    last_newlines_before = newlines_before;
  }
  if total_bytes - prev_offset > CHECKPOINT_INTERVAL {
    return false;
  }
  if index.total_newlines < last_newlines_before {
    return false;
  }
  true
}

/// Document byte offset at which `line` begins, extended over the piece table's
/// own `line_to_offset` so a line index equal to the line count maps to the end
/// of the document (the exclusive end of the last line's window).
fn line_offset<O: OriginalSource>(table: &PieceTable<O>, line: u64) -> Result<u64, String> {
  if line >= table.line_count() {
    Ok(table.len())
  } else {
    table.line_to_offset(line)
  }
}

impl Session {
  /// Apply a forward batch (see `windowed_apply` docs for the batch contract),
  /// recording its inverse into the journal. The inverse of the whole batch is
  /// built in post-apply coordinates *before* mutating: for edits sorted by
  /// ascending start, a running length delta places each replacement's inverse
  /// at the offset the text ends up at. `new_group` false (with a non-empty undo
  /// stack and an empty redo stack) coalesces the inverse into the last group;
  /// otherwise it opens a new group. Any apply clears the redo stack.
  fn apply(&mut self, edits: Vec<Edit>, new_group: bool) -> Result<DocStats, String> {
    let len = self.table.len();
    for edit in &edits {
      if edit.start > edit.end || edit.end > len {
        return Err("edit out of range".to_string());
      }
      if edit.cascade && !self.is_cr_rewrite(edit)? {
        return Err("cascade edit is not a rewrite of one CR".to_string());
      }
    }
    // Empty batches carry no reversible effect; skip journaling entirely.
    if edits.is_empty() {
      return Ok(self.stats());
    }
    // Build the inverse group in post-apply coordinates before any mutation.
    // `removed` is the text currently under each edit (valid UTF-8 by the
    // caller's boundary contract); `pstart` tracks where the replacement lands
    // once every lower-offset edit's length change has shifted it.
    // Edits are ordered by `(start, end)`, so an insertion and a rewrite that
    // begin at the same byte come out in exactly reverse orders in the two
    // passes below: the rewrite is applied first and the text lands before it.
    let mut ascending: Vec<&Edit> = edits.iter().collect();
    ascending.sort_by_key(|a| (a.start, a.end));
    let mut inverses: EditGroup = Vec::with_capacity(ascending.len());
    let mut cumshift: i64 = 0;
    for edit in &ascending {
      let removed = self.table.read(edit.start, edit.end)?;
      let removed = String::from_utf8(removed).map_err(|_| NOT_UTF8.to_string())?;
      let text_len = edit.text.len() as u64;
      let pstart = (edit.start as i64 + cumshift) as u64;
      inverses.push(InverseEdit {
        start: pstart,
        end: pstart + text_len,
        text: removed,
        keep_start: edit.keep_start,
        fill: None,
      });
      cumshift += text_len as i64 - (edit.end - edit.start) as i64;
    }
    // Apply back-to-front so a lower-offset edit's coordinates stay valid.
    let mut ordered: Vec<&Edit> = edits.iter().collect();
    ordered.sort_by_key(|b| std::cmp::Reverse((b.start, b.end)));
    for edit in ordered {
      self.table.delete(edit.start, edit.end)?;
      self.table.insert(edit.start, edit.text.as_bytes())?;
    }
    // Each LF rewrite also turns the `\r` run before it into `\n`, read from
    // the bytes the batch left, as a second step of the same undo group.
    for edit in &edits {
      if edit.cascade && edit.text == "\n" {
        if let Some(fill) = self.cascade_run(edit, &edits)? {
          inverses.push(fill);
        }
      }
    }
    self.generation += 1;
    let before = self.state_id;
    let after = self.take_state_id();
    // Only a group of typing edits can take more; a replace-all stays alone, and
    // so does a first edit after a save.
    let coalesce = !new_group
      && !self.seal_group
      && matches!(
        self.undo_stack.last(),
        Some(Step {
          entry: JournalEntry::Edits(_),
          ..
        })
      )
      && self.redo_stack.is_empty();
    self.redo_stack.clear();
    self.seal_group = false;
    match self.undo_stack.last_mut() {
      Some(Step {
        entry: JournalEntry::Edits(group),
        after: top_after,
        ..
      }) if coalesce => {
        group.extend(inverses);
        *top_after = after;
      }
      _ => self.push_undo(Step {
        entry: JournalEntry::Edits(inverses),
        before,
        after,
      }),
    }
    self.state_id = after;
    Ok(self.stats())
  }
  /// Whether `edit` rewrites exactly one `\r` to a line separator.
  fn is_cr_rewrite(&self, edit: &Edit) -> Result<bool, String> {
    if edit.end != edit.start + 1 || (edit.text != "\n" && edit.text != "\r\n") {
      return Ok(false);
    }
    Ok(self.table.read(edit.start, edit.end)? == b"\r")
  }
  /// After a batch with the LF rewrite `rewrite`: turn the maximal run of `\r`
  /// bytes directly before the rewritten byte into `\n` (each would otherwise
  /// be joined to the `\n` after it), and return the inverse of that step. The
  /// run is found by reading backwards from the byte's place after the batch.
  fn cascade_run(&mut self, rewrite: &Edit, batch: &[Edit]) -> Result<Option<InverseEdit>, String> {
    // Where the rewritten byte sits now: every other edit that ends at or
    // before it moved it, an insertion at its own start included.
    let mut at = rewrite.start as i64;
    for other in batch {
      if !std::ptr::eq(other, rewrite) && other.end <= rewrite.start {
        at += other.text.len() as i64 - (other.end - other.start) as i64;
      }
    }
    let end = at as u64;
    let mut start = end;
    while start > 0 {
      let from = start.saturating_sub(CASCADE_READ);
      let chunk = self.table.read(from, start)?;
      match chunk.iter().rposition(|&b| b != b'\r') {
        Some(i) => {
          start = from + i as u64 + 1;
          break;
        }
        None => start = from,
      }
    }
    if start == end {
      return Ok(None);
    }
    self.table.delete(start, end)?;
    self.table.insert_fill(start, b'\n', end - start)?;
    Ok(Some(InverseEdit {
      start,
      end,
      text: String::new(),
      keep_start: false,
      fill: Some(b'\r'),
    }))
  }
  /// Document statistics plus the clean flag and generation, for a result.
  fn stats(&self) -> DocStats {
    DocStats {
      total_bytes: self.table.len(),
      total_lines: self.table.line_count(),
      clean: self.clean(),
      generation: self.generation,
    }
  }
  /// A state id nothing has used yet.
  fn take_state_id(&mut self) -> u64 {
    let id = self.next_state_id;
    self.next_state_id += 1;
    id
  }

  /// Apply one group's inverse edits in reverse storage order, each in the
  /// coordinate frame current when it is reached, and return `(applied,
  /// opposite)`: the edits as applied (application order, for the frontend) and
  /// the opposite group that redoes them. The opposite is collected in
  /// application order, so reverse-applying it replays through the same frames.
  fn apply_inverse_group(
    &mut self,
    group: EditGroup,
  ) -> Result<(Vec<AppliedEdit>, EditGroup), String> {
    let mut applied: Vec<AppliedEdit> = Vec::with_capacity(group.len());
    let mut opposite: EditGroup = Vec::with_capacity(group.len());
    for inv in group.iter().rev() {
      if let Some(byte) = inv.fill {
        // A run of break bytes rewritten to the other break byte: the range
        // keeps its length and is never read or copied.
        let other = if byte == b'\r' { b'\n' } else { b'\r' };
        self.table.delete(inv.start, inv.end)?;
        self
          .table
          .insert_fill(inv.start, byte, inv.end - inv.start)?;
        opposite.push(InverseEdit {
          start: inv.start,
          end: inv.end,
          text: String::new(),
          keep_start: inv.keep_start,
          fill: Some(other),
        });
        applied.push(AppliedEdit {
          start: inv.start,
          end: inv.end,
          text: String::new(),
          keep_start: inv.keep_start,
          fill: Some((byte as char).to_string()),
        });
        continue;
      }
      let removed = self.table.read(inv.start, inv.end)?;
      let removed = String::from_utf8(removed).map_err(|_| NOT_UTF8.to_string())?;
      let text_len = inv.text.len() as u64;
      opposite.push(InverseEdit {
        start: inv.start,
        end: inv.start + text_len,
        text: removed,
        keep_start: inv.keep_start,
        fill: None,
      });
      self.table.delete(inv.start, inv.end)?;
      self.table.insert(inv.start, inv.text.as_bytes())?;
      applied.push(AppliedEdit {
        start: inv.start,
        end: inv.end,
        text: inv.text.clone(),
        keep_start: inv.keep_start,
        fill: None,
      });
    }
    Ok((applied, opposite))
  }
  /// Push an undo entry, dropping the oldest past `UNDO_LIMIT`. Dropping a
  /// replace-all entry does not delete its change list while a layer in the
  /// table still reads it: the list is shared and goes with its last holder.
  fn push_undo(&mut self, entry: Step) {
    self.undo_stack.push(entry);
    if self.undo_stack.len() > UNDO_LIMIT {
      self.undo_stack.remove(0);
    }
  }
  /// Pop and apply the newest undo entry, pushing its opposite onto the redo
  /// stack. Errors with `NOTHING_TO_UNDO` when the stack is empty.
  fn undo(&mut self) -> Result<UndoResult, String> {
    let step = self
      .undo_stack
      .pop()
      .ok_or_else(|| NOTHING_TO_UNDO.to_string())?;
    let (before, after) = (step.before, step.after);
    match step.entry {
      JournalEntry::Edits(group) => {
        let (applied, opposite) = self.apply_inverse_group(group)?;
        self.redo_stack.push(Step {
          entry: JournalEntry::Edits(opposite),
          before,
          after,
        });
        self.generation += 1;
        self.state_id = before;
        Ok(self.outcome(applied))
      }
      JournalEntry::Replace(entry) => {
        self.take_back_replace(&entry)?;
        self.state_id = before;
        let mut result = self.reload_outcome(&entry.list)?;
        result.token = Some(self.register_token(entry.list.clone(), Dir::Inverse));
        self.redo_stack.push(Step {
          entry: JournalEntry::Replace(ReplaceEntry {
            list: entry.list,
            layer_id: None,
          }),
          before,
          after,
        });
        Ok(result)
      }
    }
  }
  /// Pop and apply the newest redo entry, pushing its opposite back onto the undo
  /// stack. Errors with `NOTHING_TO_REDO` when the stack is empty.
  fn redo(&mut self) -> Result<UndoResult, String> {
    let step = self
      .redo_stack
      .pop()
      .ok_or_else(|| NOTHING_TO_REDO.to_string())?;
    let (before, after) = (step.before, step.after);
    match step.entry {
      JournalEntry::Edits(group) => {
        let (applied, opposite) = self.apply_inverse_group(group)?;
        self.undo_stack.push(Step {
          entry: JournalEntry::Edits(opposite),
          before,
          after,
        });
        self.generation += 1;
        self.state_id = after;
        Ok(self.outcome(applied))
      }
      JournalEntry::Replace(entry) => {
        let layer_id = self.stack_layer(Dir::Forward, entry.list.clone());
        self.state_id = after;
        let mut result = self.reload_outcome(&entry.list)?;
        result.token = Some(self.register_token(entry.list.clone(), Dir::Forward));
        self.undo_stack.push(Step {
          entry: JournalEntry::Replace(ReplaceEntry {
            list: entry.list,
            layer_id: Some(layer_id),
          }),
          before,
          after,
        });
        Ok(result)
      }
    }
  }
  /// Put a layer over the table, returning its id. Content changes, so the
  /// generation moves.
  fn stack_layer(&mut self, dir: Dir, list: Arc<ChangeList>) -> u64 {
    let id = replace_layer::next_layer_id();
    let under = std::mem::replace(&mut self.table, replace_layer::placeholder());
    self.table = replace_layer::stack(id, dir, under, list);
    self.generation += 1;
    id
  }
  /// Install a finished replace-all: a forward layer over the current content,
  /// one undo entry, redo cleared.
  fn install_replace(&mut self, list: Arc<ChangeList>) {
    let layer_id = self.stack_layer(Dir::Forward, list.clone());
    self.redo_stack.clear();
    let before = self.state_id;
    let after = self.take_state_id();
    self.push_undo(Step {
      entry: JournalEntry::Replace(ReplaceEntry {
        list,
        layer_id: Some(layer_id),
      }),
      before,
      after,
    });
    self.state_id = after;
    self.seal_group = false;
  }
  /// Revert the replace-all `entry` records. Undo is last-in-first-out: every
  /// later edit is already undone, so the content is exactly what the replace
  /// produced, and the change list's positions hold. When nothing at all changed
  /// since (no edit, no save) the layer it installed is still the unedited top
  /// of the table and is simply taken off; otherwise the inverse layer puts the
  /// original text back over whatever the table is now.
  fn take_back_replace(&mut self, entry: &ReplaceEntry) -> Result<(), String> {
    let removable = match entry.layer_id {
      Some(id) => replace_layer::top_forward_layer(&self.table) == Some(id),
      None => false,
    };
    if removable {
      let table = std::mem::replace(&mut self.table, replace_layer::placeholder());
      self.table = replace_layer::unstack(table)?;
      self.generation += 1;
    } else {
      self.stack_layer(Dir::Inverse, entry.list.clone());
    }
    Ok(())
  }
  /// The result of a replace-all undone or redone: nothing to mirror, the
  /// window is reloaded at the first hit.
  fn reload_outcome(&self, list: &ChangeList) -> Result<UndoResult, String> {
    let first = list.first_hit_offset()?;
    let first_line = self
      .table
      .offset_to_line(first.min(self.table.len()))
      .unwrap_or(0);
    Ok(UndoResult {
      edits: Vec::new(),
      first_line,
      total_bytes: self.table.len(),
      total_lines: self.table.line_count(),
      reload_only: true,
      clean: self.clean(),
      generation: self.generation,
      token: None,
    })
  }

  /// Package applied edits into an `UndoResult`, resolving the jump-to-change
  /// line from the first applied edit's start against the post-operation table.
  fn outcome(&self, applied: Vec<AppliedEdit>) -> UndoResult {
    let first_start = applied.first().map(|e| e.start).unwrap_or(0);
    let first_line = self
      .table
      .offset_to_line(first_start.min(self.table.len()))
      .unwrap_or(0);
    UndoResult {
      edits: applied,
      first_line,
      total_bytes: self.table.len(),
      total_lines: self.table.line_count(),
      reload_only: false,
      clean: self.clean(),
      generation: self.generation,
      token: None,
    }
  }
}

/// Core of `windowed_open`, kept free of the `tauri::State` type so it is
/// directly unit-testable: stat + ceiling check, scan, and package a fresh
/// session under a new id from `next_id`.
fn open_new_session(
  next_id: &AtomicU64,
  path: PathBuf,
) -> Result<(u64, Session, OpenResult), String> {
  let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
  enforce_size_ceiling(meta.len())?;
  let (table, total_bytes, fingerprint, index, digest) = build_table(&path)?;
  let total_lines = table.line_count();
  let session_id = next_id.fetch_add(1, Ordering::Relaxed);
  let session = Session::new(table, path, fingerprint.clone(), index, digest);
  let result = OpenResult {
    session_id,
    total_bytes,
    total_lines,
    fingerprint,
  };
  Ok((session_id, session, result))
}

/// Open `path` for windowed editing: scan once (line index + UTF-8 validation),
/// register a session, and report the initial statistics and fingerprint.
/// Refuses a file at or above `LARGE_EDIT_MAX` with the `TOO_LARGE` error.
#[tauri::command(async)]
pub fn windowed_open(state: State<WindowedState>, path: String) -> Result<OpenResult, String> {
  // Starting a new editing session is the removed feature; every other command
  // works on a session that already exists, which only a full session opened.
  crate::edition::require_full("large-file editing")?;
  let path = PathBuf::from(path);
  let (session_id, session, result) = open_new_session(&state.next_id, path)?;
  state.sessions.lock().unwrap().insert(session_id, session);
  Ok(result)
}

/// Core of `windowed_reopen`, kept free of the `tauri::State` type so it is
/// directly unit-testable. Stats the file and requires all
/// three of: the current fingerprint matching `fingerprint`, the supplied
/// `index` passing `valid_checkpoint_index`, and a freshly sampled digest over
/// the *supplied* checkpoints matching `digest` (see `sample_digest`) — the
/// fingerprint alone cannot rule out a same-size, same-mtime content change,
/// which is exactly what the digest is for. Only when all three hold does this
/// build the session directly from the supplied `index` with no scan and no
/// UTF-8 revalidation. Otherwise falls back to a full `build_table` rescan
/// (same `NOT_UTF8` failure mode as `windowed_open`); the frontend's own
/// `LargeFileView` index build already drives the visible status-bar
/// indicator during that slow path (see `windowed_reopen`'s doc), so this
/// rescan reports no progress of its own. `digest` is `None` when the caller
/// could not parse what it was handed back (see `parse_digest`); that never
/// matches, so it falls back to the rescan the same way a genuine mismatch
/// would, rather than panicking on malformed input.
fn reopen_session(
  next_id: &AtomicU64,
  path: PathBuf,
  index: CheckpointIndex,
  fingerprint: Fingerprint,
  digest: Option<u64>,
) -> Result<(u64, Session, ReopenResult), String> {
  let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
  enforce_size_ceiling(meta.len())?;
  let current = Fingerprint {
    size: meta.len(),
    mtime_ms: mtime_ms(&meta),
  };
  let trusted = current == fingerprint
    && valid_checkpoint_index(&index, meta.len())
    && digest
      .and_then(|d| {
        sample_digest(&path, meta.len(), &index.checkpoints)
          .ok()
          .map(|computed| computed == d)
      })
      .unwrap_or(false);
  let (table, total_bytes, out_fingerprint, out_index, out_digest, rescanned) = if trusted {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let original = OriginalIndex::new(
      Src::File(file),
      meta.len(),
      index.total_newlines,
      index.checkpoints.clone(),
    );
    let table = PieceTable::new(original);
    // `trusted` is only true when `digest` matched, which requires it to have
    // been `Some` in the first place.
    let digest = digest.expect("trusted requires a matching digest");
    (table, meta.len(), current, index, digest, false)
  } else {
    let (table, total_bytes, out_fingerprint, built_index, built_digest) = build_table(&path)?;
    (
      table,
      total_bytes,
      out_fingerprint,
      built_index,
      built_digest,
      true,
    )
  };
  let total_lines = table.line_count();
  let session_id = next_id.fetch_add(1, Ordering::Relaxed);
  let session = Session::new(table, path, out_fingerprint.clone(), out_index, out_digest);
  let result = ReopenResult {
    session_id,
    total_bytes,
    total_lines,
    fingerprint: out_fingerprint,
    rescanned,
  };
  Ok((session_id, session, result))
}

/// Parse a digest handed back across the IPC boundary as a decimal string
/// (see `IndexSnapshot`). `None` on anything malformed — the caller treats
/// that as "does not match", falling back to the rescan rather than trusting
/// a value that could not have come from `sample_digest` in the first place.
fn parse_digest(digest: &str) -> Option<u64> {
  digest.parse::<u64>().ok()
}

/// Reopen `path` for windowed editing from a previously persisted
/// `CheckpointIndex`, `Fingerprint`, and sampled `digest` (see
/// `windowed_index`). See `reopen_session` for the fast-path / fallback
/// contract. Refuses a file at or above `LARGE_EDIT_MAX` with the `TOO_LARGE`
/// error, same as `windowed_open`.
#[tauri::command(async)]
pub fn windowed_reopen(
  state: State<WindowedState>,
  path: String,
  index: CheckpointIndex,
  fingerprint: Fingerprint,
  digest: String,
) -> Result<ReopenResult, String> {
  let path = PathBuf::from(path);
  let digest = parse_digest(&digest);
  // The fallback rescan reports no progress of its own: `LargeFileView`'s own
  // index build (started independently in its `onMount`) already drives the
  // status-bar indexing indicator the user sees during a slow-path reopen —
  // see the class doc on `DocumentWindowState` and `beginWindowedRestore`.
  let (session_id, session, result) =
    reopen_session(&state.next_id, path, index, fingerprint, digest)?;
  state.sessions.lock().unwrap().insert(session_id, session);
  Ok(result)
}

/// Read a session's current checkpoint index, fingerprint, and sampled digest,
/// for the frontend to persist (see `windowed_reopen`).
#[tauri::command]
pub fn windowed_index(
  state: State<WindowedState>,
  session_id: u64,
) -> Result<IndexSnapshot, String> {
  let map = state.sessions.lock().unwrap();
  let session = map
    .get(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  Ok(IndexSnapshot {
    index: session.index.clone(),
    fingerprint: session.fingerprint.clone(),
    digest: session.digest.to_string(),
  })
}

/// Read the line window `[start_line, end_line)` (0-based, end exclusive) of a
/// session, clamping to the current line range. Returns the window text plus the
/// byte range it spans and the current global statistics. The content must be
/// valid UTF-8 (the file was validated at open and inserts come from JS strings);
/// a decode failure is a defensive error rather than a lossy substitution.
#[tauri::command(async)]
pub fn windowed_read(
  state: State<WindowedState>,
  session_id: u64,
  start_line: u64,
  end_line: u64,
) -> Result<WindowResult, String> {
  let map = state.lock_idle(session_id)?;
  let session = map
    .get(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  read_window_result(&session.table, start_line, end_line)
}
/// The window `[start_line, end_line)` of `table`, clamped to its line range.
fn read_window_result(
  table: &Table,
  start_line: u64,
  end_line: u64,
) -> Result<WindowResult, String> {
  let total_lines = table.line_count();
  let total_bytes = table.len();
  let start_line = start_line.min(total_lines);
  let end_line = end_line.clamp(start_line, total_lines);
  let start_offset = line_offset(table, start_line)?;
  let end_offset = line_offset(table, end_line)?;
  let bytes = table.read(start_offset, end_offset)?;
  let text = String::from_utf8(bytes).map_err(|_| NOT_UTF8.to_string())?;
  let prev_lone_cr = start_offset > 0 && table.read(start_offset - 1, start_offset)? == b"\r";
  let next_is_lf = end_offset < total_bytes && table.read(end_offset, end_offset + 1)? == b"\n";
  Ok(WindowResult {
    text,
    start_offset,
    end_offset,
    start_line,
    total_lines,
    total_bytes,
    prev_lone_cr,
    next_is_lf,
  })
}

/// Apply a batch of global-coordinate replaces to a session. The caller guarantees
/// the edits are mutually non-overlapping and all expressed in the same pre-apply
/// coordinate space; applying them by descending `start` keeps every earlier
/// edit's coordinates valid. All bounds are validated before any mutation, so an
/// out-of-range edit rejects the whole batch and leaves the session untouched.
/// `new_group` controls undo coalescing (see `Session::apply`).
#[tauri::command(async)]
pub fn windowed_apply(
  state: State<WindowedState>,
  session_id: u64,
  edits: Vec<Edit>,
  new_group: bool,
) -> Result<DocStats, String> {
  let mut map = state.lock_idle(session_id)?;
  let session = map
    .get_mut(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  session.apply(edits, new_group)
}

/// Undo the newest edit group: apply its inverse into the piece table and move it
/// to the redo stack. Returns the applied global-byte edits (for the frontend to
/// mirror into its window) plus the jump-to-change line and fresh statistics. An
/// empty undo stack returns the `NOTHING_TO_UNDO` protocol error for a silent skip.
#[tauri::command(async)]
pub fn windowed_undo(state: State<WindowedState>, session_id: u64) -> Result<UndoResult, String> {
  let mut map = state.lock_idle(session_id)?;
  let session = map
    .get_mut(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  session.undo()
}

/// Redo the newest undone group (inverse of `windowed_undo`). An empty redo stack
/// returns the `NOTHING_TO_REDO` protocol error for a silent skip.
#[tauri::command(async)]
pub fn windowed_redo(state: State<WindowedState>, session_id: u64) -> Result<UndoResult, String> {
  let mut map = state.lock_idle(session_id)?;
  let session = map
    .get_mut(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  session.redo()
}

/// Stream a session's document into a staged file (exclusive, so a colliding
/// staged name fails loudly), fsync it, then put it in `target`'s place.
/// Discards the staged file on any failure before the swap, so a failed save
/// never leaves a partial file behind.
///
/// Staging goes through `fs_ops` rather than straight to a sibling temp so this
/// writer answers a sandboxed destination folder the same way an ordinary save
/// does — a large file the user opened by hand is otherwise unsavable.
fn write_document(session: &Session, label: &str, target: &Path) -> Result<(), String> {
  crate::fs_ops::replace_with(target, label, true, None, |out| {
    session.table.write_all(out, SCAN_BUF)?;
    // fsync the data before the swap so a crash cannot leave a truncated file.
    // ponytail: file-level fsync only, no parent-dir fsync, unlike the
    // atomic-write path in fs_ops.
    out.sync_all().map_err(|e| e.to_string())
  })
}

/// Save a session to disk, then rebase it onto the written file. When `expected`
/// is supplied it is compared against the session file's current on-disk
/// fingerprint (out-of-band edit detection, same semantics as range-edit); a
/// mismatch returns the `FINGERPRINT_MISMATCH` protocol error and writes nothing.
/// `path_override` writes to a different path (save-as); the session then tracks
/// that path. After a successful write the session is rebased by rescanning the
/// output (new file handle, line index, fingerprint; pieces reset to a single
/// original run).
fn save_session(
  session: &mut Session,
  expected: Option<Fingerprint>,
  path_override: Option<PathBuf>,
) -> Result<SaveResult, String> {
  let target = path_override.unwrap_or_else(|| session.path.clone());
  if let Some(exp) = expected {
    // `expected` means "the file I'm about to overwrite should still look
    // like this", so the fingerprint check must run against `target`, the
    // file this call is about to overwrite — not `session.path`, which with
    // `path_override` set is a different file entirely. A target that does
    // not exist (or cannot be stat'd) counts as a mismatch rather than
    // surfacing a raw I/O error: it no longer looks like what was expected.
    let matches = fingerprint_of(&target)
      .map(|current| current == exp)
      .unwrap_or(false);
    if !matches {
      return Err(FINGERPRINT_MISMATCH.to_string());
    }
  }
  // The staged file lives in the destination directory so the final rename
  // stays on one filesystem (and is therefore atomic). The nanosecond label
  // keeps staged names distinct across runs; staging exclusively turns any
  // residual collision into an error.
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  write_document(session, &format!(".windowed-{nanos}"), &target)?;
  // Rebase onto the freshly written file: rescan for line index + fingerprint and
  // reset the piece table to a single original run over the new bytes.
  // ponytail: full O(size) rescan on every save. Fine at these file sizes; if it
  // ever dominates, carry the new line index forward from the in-memory pieces
  // instead of rereading the whole file.
  let (table, total_bytes, fingerprint, index, digest) = build_table(&target)?;
  let total_lines = table.line_count();
  // The old table, layers included, is dropped here: the saved file now holds
  // the flattened content, and a change list goes once no journal entry refers
  // to it either.
  session.table = table;
  session.path = target;
  session.fingerprint = fingerprint.clone();
  session.index = index;
  session.digest = digest;
  session.generation += 1;
  session.saved_state_id = session.state_id;
  session.seal_group = true;
  Ok(SaveResult {
    fingerprint,
    total_bytes,
    total_lines,
    clean: true,
    generation: session.generation,
  })
}
/// Core of `windowed_save`: waits for a running replace-all, then saves.
fn save_core(
  state: &WindowedState,
  session_id: u64,
  expected: Option<Fingerprint>,
  path_override: Option<PathBuf>,
) -> Result<SaveResult, String> {
  let mut map = state.lock_idle(session_id)?;
  let session = map
    .get_mut(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  save_session(session, expected, path_override)
}

#[tauri::command(async)]
pub fn windowed_save(
  state: State<WindowedState>,
  session_id: u64,
  expected: Option<Fingerprint>,
  path_override: Option<String>,
) -> Result<SaveResult, String> {
  save_core(
    &state,
    session_id,
    expected,
    path_override.map(PathBuf::from),
  )
}
/// Core of `windowed_set_path`: waits for a running replace-all, then points the
/// session at `path`. The file's bytes are the same, so its index, digest and
/// fingerprint stay valid.
fn set_path_core(state: &WindowedState, session_id: u64, path: PathBuf) -> Result<(), String> {
  let mut map = state.lock_idle(session_id)?;
  let session = map
    .get_mut(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  session.path = path;
  Ok(())
}
/// The file a session edits was renamed or moved: later saves and conflict
/// checks go to `path`. Nothing is read or written.
#[tauri::command(async)]
pub fn windowed_set_path(
  state: State<WindowedState>,
  session_id: u64,
  path: String,
) -> Result<(), String> {
  set_path_core(&state, session_id, PathBuf::from(path))
}
/// Core of `windowed_close`: waits for a running replace-all, then drops the
/// session. Its layers and journal go with it, and with them every change-list
/// file nothing else reads; the user's file is never touched.
fn close_core(state: &WindowedState, session_id: u64) {
  if let Ok(mut map) = state.lock_idle(session_id) {
    map.remove(&session_id);
  }
}

/// Release a session and its resources. No-op if the id is unknown or already
/// closed. Remaining sessions are dropped when the app exits; no explicit cleanup
/// is needed there.
#[tauri::command(async)]
pub fn windowed_close(state: State<WindowedState>, session_id: u64) {
  close_core(&state, session_id);
}

/// Core of `windowed_map_replace`.
fn map_replace_core(
  state: &WindowedState,
  session_id: u64,
  token: u64,
  offsets: &[u64],
) -> Result<Vec<u64>, String> {
  let map = state.lock_idle(session_id)?;
  let session = map
    .get(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  session.map_replace(token, offsets)
}

/// Map global byte `offsets` through the replace-all behind `token` (from an
/// undo, redo or replace-all result): the offsets of the content before the
/// change become offsets of the content after it.
#[tauri::command(async)]
pub fn windowed_map_replace(
  state: State<WindowedState>,
  session_id: u64,
  token: u64,
  offsets: Vec<u64>,
) -> Result<Vec<u64>, String> {
  map_replace_core(&state, session_id, token, &offsets)
}

/// Core of `windowed_release_replace`. A token or session already gone is not
/// an error.
fn release_replace_core(state: &WindowedState, session_id: u64, token: u64) {
  if let Ok(mut map) = state.lock_idle(session_id) {
    if let Some(session) = map.get_mut(&session_id) {
      session.replace_tokens.remove(&token);
    }
  }
}

/// Drop a replace-all token.
#[tauri::command(async)]
pub fn windowed_release_replace(state: State<WindowedState>, session_id: u64, token: u64) {
  release_replace_core(&state, session_id, token);
}

/// Core of `windowed_offset_line`.
fn offset_line_core(state: &WindowedState, session_id: u64, offset: u64) -> Result<u64, String> {
  let map = state.lock_idle(session_id)?;
  let session = map
    .get(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  session.table.offset_to_line(offset)
}

/// The 0-based line holding global byte `offset`, by the line rule (`line_rule`).
#[tauri::command(async)]
pub fn windowed_offset_line(
  state: State<WindowedState>,
  session_id: u64,
  offset: u64,
) -> Result<u64, String> {
  offset_line_core(&state, session_id, offset)
}
/// Reads session content one chunk at a time. Each read takes the sessions lock
/// for that chunk only and refuses once the content has changed since the scan
/// began, so a hit with an older generation's offsets is never reported.
struct SessionReader<'a> {
  state: &'a WindowedState,
  id: u64,
  generation: u64,
}

impl SessionReader<'_> {
  fn read(&self, offset: u64, len: usize) -> Result<Vec<u8>, ScanStop> {
    let map = self.state.sessions.lock().unwrap();
    let session = map
      .get(&self.id)
      .ok_or_else(|| ScanStop::Failed(UNKNOWN_SESSION.to_string()))?;
    if session.generation != self.generation {
      return Err(ScanStop::Stale);
    }
    session
      .table
      .read(offset, offset + len as u64)
      .map_err(ScanStop::Failed)
  }
}
/// A position as a 0-based line and a column counted in UTF-16 code units, the
/// unit CodeMirror uses.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Pos {
  pub line: u64,
  pub col: u64,
}
/// A match found by Find Next / Previous.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct FindHit {
  pub start: Pos,
  pub end: Pos,
  pub start_offset: u64,
  pub end_offset: u64,
}
/// Byte offset of `line` / `col` (UTF-16 units, line break excluded). A column
/// past the end of the line lands at its end.
fn pos_to_offset<O: OriginalSource>(
  table: &PieceTable<O>,
  line: u64,
  col: u64,
) -> Result<u64, String> {
  if table.line_count() == 0 {
    return Ok(0);
  }
  let line = line.min(table.line_count() - 1);
  let start = table.line_to_offset(line)?;
  let end = line_offset(table, line + 1)?;
  let bytes = table.read(start, end)?;
  let text = std::str::from_utf8(&bytes).map_err(|_| NOT_UTF8.to_string())?;
  let text = text.strip_suffix('\n').unwrap_or(text);
  let text = text.strip_suffix('\r').unwrap_or(text);
  let mut units = 0u64;
  for (i, ch) in text.char_indices() {
    if units >= col {
      return Ok(start + i as u64);
    }
    units += ch.len_utf16() as u64;
  }
  Ok(start + text.len() as u64)
}
/// Line and UTF-16 column of byte `offset`.
fn offset_to_pos<O: OriginalSource>(table: &PieceTable<O>, offset: u64) -> Result<Pos, String> {
  if table.len() == 0 {
    return Ok(Pos { line: 0, col: 0 });
  }
  let line = table.offset_to_line(offset)?;
  let start = table.line_to_offset(line)?;
  let bytes = table.read(start, offset)?;
  let col = String::from_utf8_lossy(&bytes).encode_utf16().count() as u64;
  Ok(Pos { line, col })
}
/// Why one attempt at a find did not produce an answer.
enum FindFailure {
  /// The content changed under the scan: try again.
  Stale,
  Failed(String),
}

impl From<ScanStop> for FindFailure {
  fn from(stop: ScanStop) -> Self {
    match stop {
      ScanStop::Stale => FindFailure::Stale,
      ScanStop::Cancelled => FindFailure::Failed("cancelled".to_string()),
      ScanStop::Failed(e) => FindFailure::Failed(e),
    }
  }
}
/// One scan for the next (or previous) hit from `line` / `col`, wrapping.
/// `between` runs before every chunk read; tests use it to land an edit mid-scan.
#[allow(clippy::too_many_arguments)]
fn find_once(
  state: &WindowedState,
  session_id: u64,
  needle: &[u8],
  case_sensitive: bool,
  line: u64,
  col: u64,
  backward: bool,
  chunk: usize,
  between: &mut dyn FnMut(usize),
) -> Result<Option<FindHit>, FindFailure> {
  let (generation, len, from) = {
    let map = state.lock_idle(session_id).map_err(FindFailure::Failed)?;
    let session = map
      .get(&session_id)
      .ok_or_else(|| FindFailure::Failed(UNKNOWN_SESSION.to_string()))?;
    (
      session.generation,
      session.table.len(),
      pos_to_offset(&session.table, line, col).map_err(FindFailure::Failed)?,
    )
  };
  let m = needle.len() as u64;
  let reader = SessionReader {
    state,
    id: session_id,
    generation,
  };
  let mut chunks = 0usize;
  let mut read = |offset: u64, n: usize| {
    between(chunks);
    chunks += 1;
    reader.read(offset, n)
  };
  let found = if backward {
    match scan_backward(0, from, needle, case_sensitive, chunk, &mut read)? {
      Some(off) => Some(off),
      None => scan_backward(
        from.saturating_sub(m - 1),
        len,
        needle,
        case_sensitive,
        chunk,
        &mut read,
      )?,
    }
  } else {
    let mut first: Option<u64> = None;
    for (start, limit) in [(from, len), (0, len.min(from + m - 1))] {
      scan_forward(
        start,
        limit,
        needle,
        case_sensitive,
        chunk,
        &mut read,
        &mut |event| {
          if let Event::Hit { off, .. } = event {
            first = Some(off);
            return Ok(Flow::Stop);
          }
          Ok(Flow::Continue)
        },
      )?;
      if first.is_some() {
        break;
      }
    }
    first
  };
  let Some(offset) = found else {
    return Ok(None);
  };
  let map = state.sessions.lock().unwrap();
  let session = map
    .get(&session_id)
    .ok_or_else(|| FindFailure::Failed(UNKNOWN_SESSION.to_string()))?;
  if session.generation != generation {
    return Err(FindFailure::Stale);
  }
  Ok(Some(FindHit {
    start: offset_to_pos(&session.table, offset).map_err(FindFailure::Failed)?,
    end: offset_to_pos(&session.table, offset + m).map_err(FindFailure::Failed)?,
    start_offset: offset,
    end_offset: offset + m,
  }))
}
/// Core of `windowed_find`: restarted once when an edit lands mid-scan.
#[allow(clippy::too_many_arguments)]
fn find_core(
  state: &WindowedState,
  session_id: u64,
  query: &str,
  case_sensitive: bool,
  line: u64,
  col: u64,
  backward: bool,
  chunk: usize,
  between: &mut dyn FnMut(usize),
) -> Result<Option<FindHit>, String> {
  if query.is_empty() {
    return Err("empty-query".to_string());
  }
  for _ in 0..2 {
    match find_once(
      state,
      session_id,
      query.as_bytes(),
      case_sensitive,
      line,
      col,
      backward,
      chunk,
      between,
    ) {
      Ok(hit) => return Ok(hit),
      Err(FindFailure::Stale) => continue,
      Err(FindFailure::Failed(e)) => return Err(e),
    }
  }
  Err("stale".to_string())
}
/// Find the next hit of `query` after the line / column given (or the previous
/// one before it, `backward`), over the session's current content, edits
/// included. Wraps around the end. `None` when the query does not occur.
#[tauri::command(async)]
pub fn windowed_find(
  state: State<WindowedState>,
  session_id: u64,
  query: String,
  case_sensitive: bool,
  line: u64,
  col: u64,
  backward: bool,
) -> Result<Option<FindHit>, String> {
  find_core(
    &state,
    session_id,
    &query,
    case_sensitive,
    line,
    col,
    backward,
    SCAN_CHUNK,
    &mut |_| {},
  )
}
/// One result row of the whole-file search. `col` counts UTF-16 units from the
/// start of the line, CodeMirror's unit.
#[derive(Debug, PartialEq, Eq)]
struct ResultHit {
  offset: u64,
  line: u64,
  col: u64,
  preview: String,
}
/// UTF-16 code units in `bytes` of UTF-8 text, counted without decoding so a
/// slice may start or end inside a character: every lead byte is one unit, or
/// two for a four-byte character, and continuation bytes add nothing.
fn utf16_units(bytes: &[u8]) -> u64 {
  bytes
    .iter()
    .map(|&b| match b {
      0x80..=0xBF => 0,
      0xF0..=0xFF => 2,
      _ => 1,
    })
    .sum()
}
/// The column after `bytes`, given the column before them: counting restarts
/// after the last break. A final `\r` is one unit until the next byte shows it
/// is a break (see `resolve_col`).
fn advance_col(col: u64, bytes: &[u8]) -> u64 {
  let last_break = (0..bytes.len()).rposition(|i| {
    bytes[i] == b'\n' || (bytes[i] == b'\r' && bytes.get(i + 1).is_some_and(|&n| n != b'\n'))
  });
  match last_break {
    Some(at) => utf16_units(&bytes[at + 1..]),
    None => col + utf16_units(bytes),
  }
}
/// The column before a byte `next`, given the column after the bytes before it
/// and whether they end in a `\r` still counted as a unit: that `\r` was a
/// break unless `next` is `\n`.
fn resolve_col(col: u64, pending_cr: bool, next: u8) -> u64 {
  if pending_cr && next != b'\n' {
    0
  } else {
    col
  }
}
/// How a whole-file search ended.
#[derive(Debug, PartialEq, Eq)]
enum SearchEnd {
  Done {
    hits: u64,
    truncated: bool,
  },
  /// An edit landed: the hits reported so far are out of date.
  Stale,
  Cancelled,
  Failed,
}
/// Whole-file search for the results list. Streams every hit through `emit`
/// with its 0-based line and a preview, stopping at `max_results`.
#[allow(clippy::too_many_arguments)]
fn search_core(
  state: &WindowedState,
  session_id: u64,
  query: &str,
  case_sensitive: bool,
  max_results: u32,
  cancel: &AtomicBool,
  chunk: usize,
  emit: &mut dyn FnMut(ResultHit),
  between: &mut dyn FnMut(usize),
) -> SearchEnd {
  if query.is_empty() {
    return SearchEnd::Failed;
  }
  let (generation, len) = match state.lock_idle(session_id) {
    Ok(map) => match map.get(&session_id) {
      Some(session) => (session.generation, session.table.len()),
      None => return SearchEnd::Failed,
    },
    Err(_) => return SearchEnd::Failed,
  };
  let needle = query.as_bytes();
  let reader = SessionReader {
    state,
    id: session_id,
    generation,
  };
  let mut chunks = 0usize;
  let mut read = |offset: u64, n: usize| {
    if cancel.load(Ordering::Relaxed) {
      return Err(ScanStop::Cancelled);
    }
    between(chunks);
    chunks += 1;
    reader.read(offset, n)
  };
  let mut hits = 0u64;
  let mut truncated = false;
  let mut breaks = BreakCounter::new();
  let mut col = 0u64;
  let result = scan_forward(
    0,
    len,
    needle,
    case_sensitive,
    chunk,
    &mut read,
    &mut |event| {
      match event {
        Event::Gap { bytes } => {
          if let Some(&first) = bytes.first() {
            col = resolve_col(col, breaks.pending_cr(), first);
          }
          col = advance_col(col, bytes);
          breaks.feed(bytes);
        }
        Event::Hit { off, buf, idx } => {
          let first = buf[idx];
          col = resolve_col(col, breaks.pending_cr(), first);
          emit(ResultHit {
            offset: off,
            line: breaks.count_before_next(first),
            col,
            preview: preview_at(buf, idx),
          });
          hits += 1;
          col = advance_col(col, needle);
          breaks.feed(needle);
          if hits >= max_results as u64 {
            truncated = true;
            return Ok(Flow::Stop);
          }
        }
      }
      if cancel.load(Ordering::Relaxed) {
        return Err(ScanStop::Cancelled);
      }
      Ok(Flow::Continue)
    },
  );
  match result {
    Ok(()) => SearchEnd::Done { hits, truncated },
    Err(ScanStop::Stale) => SearchEnd::Stale,
    Err(ScanStop::Cancelled) => SearchEnd::Cancelled,
    Err(ScanStop::Failed(e)) => {
      log::warn!("windowed search failed: {e}");
      SearchEnd::Failed
    }
  }
}

#[derive(Clone, Serialize)]
struct SearchHitPayload {
  search_id: String,
  offset: u64,
  line: u64,
  col: u64,
  preview: String,
}

#[derive(Clone, Serialize)]
struct SearchDonePayload {
  search_id: String,
  hits: u64,
  truncated: bool,
  /// An edit landed during the scan; the hits sent are out of date.
  stale: bool,
  /// The scan failed instead of finishing; `hits` is then meaningless.
  error: bool,
}
/// Start a whole-file search of the session's current content for the results
/// list, emitting `windowed-search-hit` per match and a final
/// `windowed-search-done`. A change to the content ends it as stale; the
/// frontend starts a fresh one once the edits settle.
#[tauri::command(async)]
pub fn windowed_search(
  app: AppHandle,
  state: State<WindowedState>,
  session_id: u64,
  query: String,
  case_sensitive: bool,
  max_results: u32,
  search_id: String,
) -> Result<(), String> {
  if query.is_empty() {
    return Err("query must not be empty".to_string());
  }
  let cancel = Arc::new(AtomicBool::new(false));
  state
    .searches
    .lock()
    .unwrap()
    .insert(search_id.clone(), cancel.clone());
  std::thread::spawn(move || {
    let state = app.state::<WindowedState>();
    let emit_id = search_id.clone();
    let end = search_core(
      &state,
      session_id,
      &query,
      case_sensitive,
      max_results,
      &cancel,
      SCAN_CHUNK,
      &mut |hit| {
        let _ = app.emit(
          "windowed-search-hit",
          SearchHitPayload {
            search_id: emit_id.clone(),
            offset: hit.offset,
            line: hit.line,
            col: hit.col,
            preview: hit.preview,
          },
        );
      },
      &mut |_| {},
    );
    let (hits, truncated, stale, error) = match end {
      SearchEnd::Done { hits, truncated } => (hits, truncated, false, false),
      SearchEnd::Stale => (0, false, true, false),
      SearchEnd::Cancelled => (0, false, false, false),
      SearchEnd::Failed => (0, false, false, true),
    };
    let _ = app.emit(
      "windowed-search-done",
      SearchDonePayload {
        search_id: search_id.clone(),
        hits,
        truncated,
        stale,
        error,
      },
    );
    state.searches.lock().unwrap().remove(&search_id);
  });
  Ok(())
}
/// Signal a running search to stop. No-op if the id is unknown or already done.
#[tauri::command]
pub fn windowed_search_cancel(state: State<WindowedState>, search_id: String) {
  if let Some(flag) = state.searches.lock().unwrap().get(&search_id) {
    flag.store(true, Ordering::Relaxed);
  }
}
/// What a finished replace-all reports.
#[derive(Serialize, Debug)]
pub struct ReplaceAllOutcome {
  pub count: u64,
  pub total_bytes: u64,
  pub total_lines: u64,
  pub clean: bool,
  pub generation: u64,
  /// The token of the change list when at least one hit was replaced (see
  /// `UndoResult::token`).
  pub token: Option<u64>,
}
/// Core of `windowed_replace_all`. One streaming pass over the current content
/// finds every leftmost non-overlapping hit and writes the change list to
/// `tmp_dir`; the session's table then becomes a forward layer over the table it
/// had, with one undo entry. The session is busy for the whole pass, so no
/// other command lands between two chunks. `between` runs before every chunk.
#[allow(clippy::too_many_arguments)]
fn replace_all_core(
  state: &WindowedState,
  tmp_dir: &Path,
  session_id: u64,
  query: &str,
  case_sensitive: bool,
  replacement: &str,
  insert_sep: &str,
  chunk: usize,
  interval: u64,
  between: &mut dyn FnMut(usize),
) -> Result<ReplaceAllOutcome, String> {
  if query.is_empty() {
    return Err("empty-query".to_string());
  }
  let (generation, len) = {
    let mut map = state.lock_idle(session_id)?;
    let session = map
      .get_mut(&session_id)
      .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
    session.busy = true;
    (session.generation, session.table.len())
  };
  let _busy = BusyGuard {
    state,
    id: session_id,
  };
  let needle = query.as_bytes();
  let mut builder = Builder::create(
    tmp_dir,
    needle,
    replacement.as_bytes(),
    interval,
    insert_sep,
  )?;
  let reader = SessionReader {
    state,
    id: session_id,
    generation,
  };
  let mut chunks = 0usize;
  let mut read = |offset: u64, n: usize| {
    between(chunks);
    chunks += 1;
    reader.read(offset, n)
  };
  scan_forward(
    0,
    len,
    needle,
    case_sensitive,
    chunk,
    &mut read,
    &mut |event| {
      match event {
        Event::Gap { bytes } => builder.gap(bytes),
        Event::Hit { buf, idx, .. } => builder
          .hit(&buf[idx..idx + needle.len()])
          .map_err(ScanStop::Failed)?,
      }
      Ok(Flow::Continue)
    },
  )
  .map_err(|stop| match stop {
    // Nothing else can change a busy session, so a changed generation is a bug.
    ScanStop::Stale => "replace-all aborted: the content changed during the pass".to_string(),
    ScanStop::Cancelled => "cancelled".to_string(),
    ScanStop::Failed(e) => e,
  })?;
  let list = builder.finish(len)?;
  let count = list.hits();
  let mut token = None;
  let mut map = state.sessions.lock().unwrap();
  let session = map
    .get_mut(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  if count > 0 {
    if session.generation != generation {
      return Err("replace-all aborted: the content changed during the pass".to_string());
    }
    let list = Arc::new(list);
    session.install_replace(list.clone());
    token = Some(session.register_token(list, Dir::Forward));
  }
  Ok(ReplaceAllOutcome {
    count,
    total_bytes: session.table.len(),
    total_lines: session.table.line_count(),
    clean: session.clean(),
    generation: session.generation,
    token,
  })
}
/// Replace every occurrence of `query` in the session's current content with
/// `replacement`, as one undoable step. A lone `\r` the pass leaves directly
/// before a `\n` is rewritten to `insert_sep` (`"\n"` or `"\r\n"`) in the same
/// step. Memory stays independent of the file size and the hit count: see
/// `replace_layer`.
#[tauri::command(async)]
pub fn windowed_replace_all(
  app: AppHandle,
  state: State<WindowedState>,
  session_id: u64,
  query: String,
  case_sensitive: bool,
  replacement: String,
  insert_sep: String,
) -> Result<ReplaceAllOutcome, String> {
  let tmp_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| e.to_string())?
    .join(replace_layer::TMP_DIR);
  replace_all_core(
    &state,
    &tmp_dir,
    session_id,
    &query,
    case_sensitive,
    &replacement,
    &insert_sep,
    SCAN_CHUNK,
    CHECKPOINT_INTERVAL,
    &mut |_| {},
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{Cursor, Write};
  use tempfile::tempdir;

  /// Force `path`'s mtime back to `fingerprint`'s, so a rewritten file keeps a
  /// colliding size+mtime fingerprint and a test can isolate what the sampled
  /// digest adds on top of it.
  ///
  /// The handle must be opened for writing. Unix `futimens` accepts a read-only
  /// descriptor, but Windows `SetFileTime` needs `FILE_WRITE_ATTRIBUTES`, so
  /// `File::open` there fails with `PermissionDenied` — which only a real
  /// Windows test run shows, since Windows-target checks on the dev host stop
  /// at `cargo check`.
  fn pin_mtime(path: &Path, fingerprint: &Fingerprint) {
    let secs = fingerprint.mtime_ms / 1000;
    let nanos = ((fingerprint.mtime_ms % 1000) * 1_000_000) as u32;
    let pinned = std::time::UNIX_EPOCH + std::time::Duration::new(secs, nanos);
    fs::OpenOptions::new()
      .write(true)
      .open(path)
      .unwrap()
      .set_modified(pinned)
      .unwrap();
    assert_eq!(
      &fingerprint_of(path).unwrap(),
      fingerprint,
      "size and mtime must collide for this test to isolate the digest's effect"
    );
  }

  /// Naive reference: replace the byte ranges of `edits` (each in pre-apply
  /// coordinates, non-overlapping) against a plain buffer, back to front.
  fn ref_apply(content: &[u8], edits: &[(u64, u64, &str)]) -> Vec<u8> {
    let mut v = content.to_vec();
    let mut ordered: Vec<&(u64, u64, &str)> = edits.iter().collect();
    ordered.sort_by_key(|b| std::cmp::Reverse(b.0));
    for &(start, end, text) in ordered {
      v.splice(start as usize..end as usize, text.bytes());
    }
    v
  }

  /// A `Session` built directly over a file path, bypassing managed state, for
  /// exercising the table + save helpers without a Tauri runtime.
  fn open_session(path: &Path) -> Session {
    let (table, _, fingerprint, index, digest) = build_table(path).unwrap();
    Session::new(table, path.to_path_buf(), fingerprint, index, digest)
  }

  /// Build a global-byte `Edit` from a triple, for the journal tests.
  fn edit(start: u64, end: u64, text: &str) -> Edit {
    Edit {
      start,
      end,
      text: text.to_string(),
      keep_start: false,
      cascade: false,
    }
  }

  /// Full document bytes of a session (for comparing against a reference model).
  fn whole(session: &Session) -> Vec<u8> {
    session.table.read(0, session.table.len()).unwrap()
  }

  /// Read a session window and return its text as bytes.
  fn read_window(session: &Session, start_line: u64, end_line: u64) -> Vec<u8> {
    let table = &session.table;
    let total_lines = table.line_count();
    let start_line = start_line.min(total_lines);
    let end_line = end_line.clamp(start_line, total_lines);
    let a = line_offset(table, start_line).unwrap();
    let b = line_offset(table, end_line).unwrap();
    table.read(a, b).unwrap()
  }

  /// Apply a batch to a session table the same way `windowed_apply` does.
  fn apply(session: &mut Session, edits: &[(u64, u64, &str)]) -> Result<(), String> {
    let len = session.table.len();
    for &(start, end, _) in edits {
      if start > end || end > len {
        return Err("edit out of range".to_string());
      }
    }
    let mut ordered: Vec<&(u64, u64, &str)> = edits.iter().collect();
    ordered.sort_by_key(|b| std::cmp::Reverse(b.0));
    for &(start, end, text) in ordered {
      session.table.delete(start, end)?;
      session.table.insert(start, text.as_bytes())?;
    }
    Ok(())
  }

  /// Save a session to its own path via the production `save_session`, and
  /// unwrap the result. For tests that only care about the write, not the
  /// guard or save-as behaviour.
  fn save(session: &mut Session) {
    save_session(session, None, None).unwrap();
  }

  #[test]
  fn scan_builds_line_starts_and_validates() {
    // Small buffer forces multi-chunk scanning. Interval is 1 MiB, so this
    // tiny input yields only the seed checkpoint; the two newlines are the
    // essential assertion.
    let (bytes, checkpoints, newlines) = scan_reader(Cursor::new("a\nbb\nccc"), 3).unwrap();
    assert_eq!(bytes, 8);
    assert_eq!(newlines, 2);
    assert_eq!(checkpoints, vec![(0, 0)]);
  }

  #[test]
  fn scan_empty_file_has_empty_index() {
    let (bytes, checkpoints, newlines) = scan_reader(Cursor::new(""), 4).unwrap();
    assert_eq!(bytes, 0);
    assert_eq!(newlines, 0);
    assert_eq!(checkpoints, vec![(0, 0)]);
  }

  #[test]
  fn scan_records_checkpoints_at_interval() {
    // Drives `scan_reader` itself over a buffer spanning three
    // `CHECKPOINT_INTERVAL` boundaries (I, 2I, 3I). Newlines are placed on
    // both sides of each boundary so an off-by-one in the "strictly before"
    // rule (counting a newline at the boundary offset itself into that same
    // checkpoint) is caught.
    let interval = CHECKPOINT_INTERVAL;
    let total_len = 3 * interval + 2000;
    let mut content = vec![b'a'; total_len as usize];
    // Newline offsets, chosen relative to each boundary:
    let nl_offsets: [u64; 8] = [
      10,                 // well before I
      interval - 1,       // last byte before I
      interval,           // exactly at I: belongs to the *next* interval
      interval + 1000,    // just after I
      2 * interval - 2,   // just before 2I
      2 * interval + 50,  // just after 2I
      3 * interval - 100, // just before 3I
      3 * interval + 3,   // just after 3I
    ];
    for &off in &nl_offsets {
      content[off as usize] = b'\n';
    }
    let (bytes, checkpoints, newlines) = scan_reader(Cursor::new(content), SCAN_BUF).unwrap();
    assert_eq!(bytes, total_len);
    assert_eq!(newlines, 8);
    // Each checkpoint's count is the newlines strictly before its offset:
    // I sees only the two newlines before it (10, I-1); the newline at I
    // itself lands in the 2I bucket, and the newline at 2I lands in 3I's.
    assert_eq!(
      checkpoints,
      vec![(0, 0), (interval, 2), (2 * interval, 5), (3 * interval, 7)]
    );
  }

  #[test]
  fn scan_accepts_multibyte_char_split_across_buffer() {
    // "aa中bb": with buf_size 4 the 3-byte '中' (E4 B8 AD) straddles the first
    // buffer boundary, exercising the carry path.
    let (bytes, checkpoints, newlines) = scan_reader(Cursor::new("aa中bb"), 4).unwrap();
    assert_eq!(bytes, 7);
    assert_eq!(newlines, 0);
    assert_eq!(checkpoints, vec![(0, 0)]);
  }

  #[test]
  fn scan_rejects_invalid_byte() {
    let err = scan_reader(Cursor::new([0x61u8, 0xFF, 0x62]), 8).unwrap_err();
    assert_eq!(err, NOT_UTF8);
  }

  #[test]
  fn scan_rejects_truncated_char_at_eof() {
    // A lead byte with no continuation before EOF is not valid UTF-8.
    let err = scan_reader(Cursor::new([0x61u8, 0xE4]), 8).unwrap_err();
    assert_eq!(err, NOT_UTF8);
  }

  #[test]
  fn open_read_apply_save_roundtrip() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("doc.txt");
    let content = "line0\nline1\nline2\nline3\n";
    fs::write(&path, content).unwrap();
    let mut session = open_session(&path);

    // Read a middle window: lines [1, 3) -> "line1\nline2\n".
    assert_eq!(read_window(&session, 1, 3), b"line1\nline2\n");

    // Batch of two non-overlapping edits in pre-apply coordinates:
    // replace "line0" (0..5) with "HEAD" and "line2" (12..17) with "MIDDLE".
    let edits = [(0u64, 5u64, "HEAD"), (12u64, 17u64, "MIDDLE")];
    apply(&mut session, &edits).unwrap();
    let expected = ref_apply(content.as_bytes(), &edits);
    assert_eq!(
      read_window(&session, 0, session.table.line_count()),
      expected
    );

    save(&mut session);
    // On-disk bytes match the naive splice result exactly.
    assert_eq!(fs::read(&path).unwrap(), expected);
  }

  #[test]
  fn crlf_bytes_are_preserved() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("crlf.txt");
    let content = b"alpha\r\nbeta\r\ngamma\r\n";
    fs::write(&path, content).unwrap();
    let mut session = open_session(&path);

    // Reading a window returns the CRLF bytes verbatim.
    let win = read_window(&session, 0, 1);
    assert_eq!(win, b"alpha\r\n");

    // Replace "beta" (bytes 7..11) with "BB"; untouched CRLFs stay byte-exact.
    let edits = [(7u64, 11u64, "BB")];
    apply(&mut session, &edits).unwrap();
    save(&mut session);
    assert_eq!(fs::read(&path).unwrap(), b"alpha\r\nBB\r\ngamma\r\n");
  }

  #[test]
  fn save_rejects_mismatched_fingerprint() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("guard.txt");
    fs::write(&path, b"original").unwrap();
    let mut session = open_session(&path);
    let stale = session.fingerprint.clone();

    // An external write changes size and mtime after the session was opened.
    fs::write(&path, b"changed on disk!!").unwrap();
    assert_ne!(fingerprint_of(&path).unwrap(), stale);

    // Replace the whole (8-byte) session document with "EDIT".
    apply(&mut session, &[(0, 8, "EDIT")]).unwrap();

    // A stale expected fingerprint rejects the save and writes nothing: the
    // external content is still on disk.
    let err = save_session(&mut session, Some(stale), None).unwrap_err();
    assert_eq!(err, FINGERPRINT_MISMATCH);
    assert_eq!(fs::read(&path).unwrap(), b"changed on disk!!");

    // With expected = None the save writes through.
    save_session(&mut session, None, None).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"EDIT");
  }

  #[test]
  fn save_as_checks_destination_not_source() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.txt");
    let dest = dir.path().join("dest.txt");
    fs::write(&source, b"source content").unwrap();
    fs::write(&dest, b"dest content").unwrap();
    let mut session = open_session(&source);
    let dest_fingerprint = fingerprint_of(&dest).unwrap();

    // `expected` matches the destination (not the source): the save-as succeeds.
    save_session(&mut session, Some(dest_fingerprint), Some(dest.clone())).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"source content");
  }

  #[test]
  fn save_as_rejects_source_fingerprint_for_stale_destination() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.txt");
    let dest = dir.path().join("dest.txt");
    fs::write(&source, b"source content").unwrap();
    let mut session = open_session(&source);
    let source_fingerprint = session.fingerprint.clone();
    fs::write(&dest, b"an unrelated, differently-sized destination").unwrap();
    assert_ne!(fingerprint_of(&dest).unwrap(), source_fingerprint);

    // The source's own fingerprint still matches the source, but the check
    // must run against `dest` (the file about to be overwritten), so this is
    // rejected even though `expected` is perfectly valid for `session.path`.
    let err = save_session(&mut session, Some(source_fingerprint), Some(dest.clone())).unwrap_err();
    assert_eq!(err, FINGERPRINT_MISMATCH);
    assert_eq!(
      fs::read(&dest).unwrap(),
      b"an unrelated, differently-sized destination"
    );
  }

  #[test]
  fn save_as_with_expected_rejects_missing_destination() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.txt");
    let dest = dir.path().join("brand-new.txt");
    fs::write(&source, b"source content").unwrap();
    let mut session = open_session(&source);
    let some_fingerprint = session.fingerprint.clone();
    assert!(!dest.exists());

    // A destination that does not exist yet cannot match any `expected`
    // fingerprint: this is a mismatch, not a raw I/O error.
    let err = save_session(&mut session, Some(some_fingerprint), Some(dest.clone())).unwrap_err();
    assert_eq!(err, FINGERPRINT_MISMATCH);
    assert!(!dest.exists());

    // With expected = None (today's only save-as path) a brand-new destination
    // still saves through untouched.
    save_session(&mut session, None, Some(dest.clone())).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"source content");
  }

  #[test]
  fn out_of_range_batch_is_rejected_atomically() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bounds.txt");
    fs::write(&path, b"abcdef").unwrap();
    let mut session = open_session(&path);
    let before = read_window(&session, 0, session.table.line_count());

    // Second edit reaches past EOF: the whole batch must be refused and the
    // table left untouched.
    let edits = [(0u64, 2u64, "XY"), (4u64, 99u64, "ZZ")];
    assert!(apply(&mut session, &edits).is_err());
    assert_eq!(read_window(&session, 0, session.table.line_count()), before);
    assert_eq!(before, b"abcdef");
  }

  #[test]
  fn save_then_apply_and_save_again() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rebase.txt");
    let content = "one\ntwo\nthree\n";
    fs::write(&path, content).unwrap();
    let mut session = open_session(&path);

    // First round: insert a line, save (rebasing the session onto the output).
    let e1 = [(4u64, 4u64, "TWO-AND-A-HALF\n")];
    apply(&mut session, &e1).unwrap();
    let after1 = ref_apply(content.as_bytes(), &e1);
    save(&mut session);
    assert_eq!(fs::read(&path).unwrap(), after1);

    // Second round runs on the rebased session: coordinates are against the
    // freshly written file. Replace "three" in the new content.
    let idx = after1.windows(5).position(|w| w == b"three").unwrap() as u64;
    let e2 = [(idx, idx + 5, "3")];
    apply(&mut session, &e2).unwrap();
    let after2 = ref_apply(&after1, &e2);
    save(&mut session);
    assert_eq!(fs::read(&path).unwrap(), after2);
  }

  #[test]
  fn failed_save_leaves_no_temp_behind() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("f.txt");
    fs::write(&path, b"content").unwrap();
    let session = open_session(&path);
    // A destination whose parent does not exist forces staging to fail before
    // any swap, exercising the cleanup path.
    let unreachable = dir.path().join("missing-subdir").join("x.txt");
    assert!(write_document(&session, ".windowed-test", &unreachable).is_err());
    // Nothing was written over the original, and no temp leaked into the dir.
    assert_eq!(fs::read(&path).unwrap(), b"content");
    let leftovers: Vec<_> = fs::read_dir(dir.path())
      .unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
      .collect();
    assert!(leftovers.is_empty());
  }

  #[test]
  fn large_multibyte_document_roundtrips_byte_for_byte() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("big.txt");
    // A few MiB of multi-byte content so the streaming save crosses several
    // 1 MiB copy buffers and the scan crosses several boundaries.
    let mut content = String::new();
    for i in 0..80_000 {
      content.push_str(&format!("行{i} café 日本語\n"));
    }
    fs::write(&path, &content).unwrap();
    let mut session = open_session(&path);

    // Insert at the very start and near the end (non-overlapping, pre-apply).
    let len = content.len() as u64;
    let edits = [(0u64, 0u64, "HEAD\n"), (len, len, "TAIL\n")];
    apply(&mut session, &edits).unwrap();
    let expected = ref_apply(content.as_bytes(), &edits);
    save(&mut session);
    assert_eq!(fs::read(&path).unwrap(), expected);
  }

  /// The third writer used to finish with a plain rename, which detaches every
  /// link the user had on the file it replaced. These three hold it to the same
  /// rule as the other two.
  #[test]
  fn saving_keeps_a_symlink_pointing_at_its_target() {
    let dir = tempdir().unwrap();
    let real = dir.path().join("real.log");
    fs::write(&real, "one\ntwo\n").unwrap();
    let link = dir.path().join("link.log");
    if !crate::fs_ops::linktest::symlink(&real, &link) {
      return; // this platform will not make one for us
    }
    let mut session = open_session(&link);

    apply(&mut session, &[(0u64, 3u64, "ONE")]).unwrap();
    save_session(&mut session, None, None).unwrap();

    assert!(
      fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink(),
      "the save must not put a plain file where the link was"
    );
    assert_eq!(fs::read(&real).unwrap(), b"ONE\ntwo\n");
    assert!(
      !fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e.file_name().to_string_lossy().ends_with(".tmp")),
      "no staged file may be left behind"
    );
  }

  #[test]
  fn saving_keeps_a_hard_link_shared() {
    let dir = tempdir().unwrap();
    let a = dir.path().join("a.log");
    fs::write(&a, "one\ntwo\n").unwrap();
    let b = dir.path().join("b.log");
    fs::hard_link(&a, &b).unwrap();
    let mut session = open_session(&a);

    apply(&mut session, &[(0u64, 3u64, "ONE")]).unwrap();
    save_session(&mut session, None, None).unwrap();

    assert_eq!(
      crate::fs_ops::linktest::links(&a),
      2,
      "the two names must still share one file"
    );
    assert_eq!(
      fs::read(&b).unwrap(),
      b"ONE\ntwo\n",
      "the other name sees it"
    );
    assert!(
      !fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e.file_name().to_string_lossy().ends_with(".tmp")),
      "no staged file may be left behind"
    );
  }

  #[test]
  fn saving_through_a_symlink_onto_a_shared_file_keeps_both() {
    // The link resolves to a file another name holds too. Replacing that file
    // would drop the other name, so the shared answer has to win.
    let dir = tempdir().unwrap();
    let real = dir.path().join("real.log");
    fs::write(&real, "one\ntwo\n").unwrap();
    let other = dir.path().join("other.log");
    fs::hard_link(&real, &other).unwrap();
    let link = dir.path().join("link.log");
    if !crate::fs_ops::linktest::symlink(&real, &link) {
      return;
    }
    let mut session = open_session(&link);

    apply(&mut session, &[(0u64, 3u64, "ONE")]).unwrap();
    save_session(&mut session, None, None).unwrap();

    assert_eq!(
      crate::fs_ops::linktest::links(&real),
      2,
      "the other name must survive"
    );
    assert_eq!(fs::read(&other).unwrap(), b"ONE\ntwo\n");
    assert!(fs::symlink_metadata(&link)
      .unwrap()
      .file_type()
      .is_symlink());
    assert!(
      !fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e.file_name().to_string_lossy().ends_with(".tmp")),
      "no staged file may be left behind"
    );
  }

  #[test]
  fn save_as_writes_new_path_and_retargets_session() {
    let dir = tempdir().unwrap();
    let orig_path = dir.path().join("orig.txt");
    let orig_content = "one\ntwo\nthree\n";
    fs::write(&orig_path, orig_content).unwrap();
    let mut session = open_session(&orig_path);

    apply(&mut session, &[(4u64, 7u64, "TWO")]).unwrap();
    let expected1 = ref_apply(orig_content.as_bytes(), &[(4u64, 7u64, "TWO")]);

    let new_path = dir.path().join("saved-as.txt");
    save_session(&mut session, None, Some(new_path.clone())).unwrap();

    // New path holds the edited bytes; the original file is untouched.
    assert_eq!(fs::read(&new_path).unwrap(), expected1);
    assert_eq!(fs::read(&orig_path).unwrap(), orig_content.as_bytes());

    // The session now tracks the new path: a further edit + plain save
    // (no override, no expected) writes to the new path, not the original.
    apply(&mut session, &[(0u64, 0u64, "HEAD\n")]).unwrap();
    let expected2 = ref_apply(&expected1, &[(0u64, 0u64, "HEAD\n")]);
    save_session(&mut session, None, None).unwrap();

    assert_eq!(fs::read(&new_path).unwrap(), expected2);
    assert_eq!(fs::read(&orig_path).unwrap(), orig_content.as_bytes());
  }

  #[test]
  fn save_as_respects_fingerprint_guard_on_original_path() {
    let dir = tempdir().unwrap();
    let orig_path = dir.path().join("orig.txt");
    fs::write(&orig_path, b"original").unwrap();
    let mut session = open_session(&orig_path);
    let stale = session.fingerprint.clone();

    // External edit to the *original* path after the session was opened.
    fs::write(&orig_path, b"changed on disk!!").unwrap();
    assert_ne!(fingerprint_of(&orig_path).unwrap(), stale);

    apply(&mut session, &[(0, 8, "EDIT")]).unwrap();
    let new_path = dir.path().join("saved-as.txt");

    let err = save_session(&mut session, Some(stale), Some(new_path.clone())).unwrap_err();
    assert_eq!(err, FINGERPRINT_MISMATCH);

    // Nothing landed at the new path, and the original keeps the external edit.
    assert!(!new_path.exists());
    assert_eq!(fs::read(&orig_path).unwrap(), b"changed on disk!!");
  }

  #[test]
  fn failed_rename_after_temp_created_leaves_no_temp_behind() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("f.txt");
    fs::write(&path, b"content").unwrap();
    let mut session = open_session(&path);

    // Target is an existing *non-empty* directory: create_new on the temp
    // (a sibling file inside `dir`) succeeds, but the final rename over a
    // non-empty directory fails, exercising the "temp created, then
    // cleaned up on failure" branch rather than the create_new failure one.
    let target_dir = dir.path().join("target-is-a-dir");
    fs::create_dir(&target_dir).unwrap();
    fs::write(target_dir.join("occupant.txt"), b"keep").unwrap();

    assert!(write_document(&session, ".windowed-test", &target_dir).is_err());

    // No temp leaked in the parent dir, and the occupied directory is intact.
    assert!(!dir
      .path()
      .join(".target-is-a-dir.windowed-test.tmp")
      .exists());
    let leftovers: Vec<_> = fs::read_dir(dir.path())
      .unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
      .collect();
    assert!(leftovers.is_empty());
    assert!(target_dir.join("occupant.txt").exists());

    // The session can still save normally to a writable path.
    save(&mut session);
    assert_eq!(fs::read(&path).unwrap(), b"content");
  }

  /// Build a session over freshly-written `content` in a fresh temp dir.
  fn session_with(dir: &tempfile::TempDir, content: &[u8]) -> Session {
    let path = dir.path().join("journal.txt");
    fs::write(&path, content).unwrap();
    open_session(&path)
  }

  #[test]
  fn undo_reverts_insert_delete_replace_and_multibyte() {
    let dir = tempdir().unwrap();
    // Insert.
    let mut s = session_with(&dir, b"abc");
    s.apply(vec![edit(1, 1, "XY")], true).unwrap();
    assert_eq!(whole(&s), b"aXYbc");
    s.undo().unwrap();
    assert_eq!(whole(&s), b"abc");
    // Delete.
    s.apply(vec![edit(0, 2, "")], true).unwrap();
    assert_eq!(whole(&s), b"c");
    s.undo().unwrap();
    assert_eq!(whole(&s), b"abc");
    // Replace, multi-byte on both sides.
    let mut m = session_with(&dir, "café中".as_bytes());
    let before = whole(&m);
    // Replace "fé中" (bytes 2..8, "f"=1 "é"=2 "中"=3) with "日本" (6 bytes).
    m.apply(vec![edit(2, 8, "日本")], true).unwrap();
    assert_eq!(whole(&m), "ca日本".as_bytes());
    m.undo().unwrap();
    assert_eq!(whole(&m), before);
  }

  #[test]
  fn undo_redo_roundtrip_matches_reference() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"one\ntwo\nthree\n");
    let mut reference = b"one\ntwo\nthree\n".to_vec();
    let mut states = vec![reference.clone()];
    // Three separate groups (new_group = true each), recording every state.
    for e in [edit(0, 3, "ONE"), edit(4, 7, "TWO"), edit(0, 0, "H\n")] {
      let removed = &reference[e.start as usize..e.end as usize];
      let mut next = reference.clone();
      next.splice(
        e.start as usize..e.end as usize,
        e.text.bytes().collect::<Vec<_>>(),
      );
      let _ = removed;
      s.apply(vec![e], true).unwrap();
      reference = next;
      states.push(reference.clone());
      assert_eq!(whole(&s), reference);
    }
    // Undo back to the start, matching each recorded prior state.
    for expected in states.iter().rev().skip(1) {
      s.undo().unwrap();
      assert_eq!(whole(&s), *expected);
    }
    // Redo forward again, matching each recorded later state.
    for expected in states.iter().skip(1) {
      s.redo().unwrap();
      assert_eq!(whole(&s), *expected);
    }
  }

  #[test]
  fn undo_redo_handles_multi_edit_batch() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"0123456789");
    // Two non-overlapping edits in one batch (one shared pre-apply frame).
    s.apply(vec![edit(1, 3, "AB"), edit(6, 8, "CDE")], true)
      .unwrap();
    assert_eq!(whole(&s), b"0AB345CDE89");
    s.undo().unwrap();
    assert_eq!(whole(&s), b"0123456789");
    s.redo().unwrap();
    assert_eq!(whole(&s), b"0AB345CDE89");
  }

  #[test]
  fn coalesce_groups_by_new_group_flag() {
    let dir = tempdir().unwrap();
    // Coalesced: two applies join one group, so a single undo reverts both.
    let mut s = session_with(&dir, b"");
    s.apply(vec![edit(0, 0, "a")], true).unwrap();
    s.apply(vec![edit(1, 1, "b")], false).unwrap();
    assert_eq!(whole(&s), b"ab");
    assert_eq!(s.undo_stack.len(), 1);
    s.undo().unwrap();
    assert_eq!(whole(&s), b"");
    // A single redo restores the whole coalesced step.
    s.redo().unwrap();
    assert_eq!(whole(&s), b"ab");
    // Separate groups: two applies with new_group = true need two undos.
    let mut t = session_with(&dir, b"");
    t.apply(vec![edit(0, 0, "a")], true).unwrap();
    t.apply(vec![edit(1, 1, "b")], true).unwrap();
    assert_eq!(t.undo_stack.len(), 2);
    t.undo().unwrap();
    assert_eq!(whole(&t), b"a");
    t.undo().unwrap();
    assert_eq!(whole(&t), b"");
  }

  #[test]
  fn coalesce_overlapping_multibyte_edits_roundtrip() {
    let dir = tempdir().unwrap();
    // Original text contains multi-byte characters (Chinese).
    let original = "你好世界".as_bytes().to_vec();
    let mut s = session_with(&dir, &original);
    // Insert "哈" right after "你好" (byte offset 6, start of a new group).
    s.apply(vec![edit(6, 6, "哈")], true).unwrap();
    let after_insert1 = whole(&s);
    assert_eq!(after_insert1, "你好哈世界".as_bytes());
    // Insert "囉" right after "哈" (coalesced into the same group).
    s.apply(vec![edit(9, 9, "囉")], false).unwrap();
    let after_insert2 = whole(&s);
    assert_eq!(after_insert2, "你好哈囉世界".as_bytes());
    // Backspace: delete "囉" again, same position, overlapping the prior
    // insert's range (still coalesced into the same group).
    s.apply(vec![edit(9, 12, "")], false).unwrap();
    let after_backspace = whole(&s);
    assert_eq!(after_backspace, "你好哈世界".as_bytes());
    // Whole coalesced group: only one undo step recorded.
    assert_eq!(s.undo_stack.len(), 1);
    // One undo restores the original document, whole-file byte compare.
    s.undo().unwrap();
    assert_eq!(whole(&s), original);
    // One redo restores the post-backspace state, whole-file byte compare.
    s.redo().unwrap();
    assert_eq!(whole(&s), after_backspace);
    // Undo again returns to the original.
    s.undo().unwrap();
    assert_eq!(whole(&s), original);
  }

  #[test]
  fn apply_clears_redo_stack() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"abc");
    s.apply(vec![edit(0, 0, "X")], true).unwrap();
    s.undo().unwrap();
    assert_eq!(s.redo_stack.len(), 1);
    // A fresh edit invalidates the redo history.
    s.apply(vec![edit(0, 0, "Y")], true).unwrap();
    assert!(s.redo_stack.is_empty());
    assert_eq!(s.redo().unwrap_err(), NOTHING_TO_REDO);
  }

  #[test]
  fn undo_correct_after_save_and_rebase() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("saved.txt");
    fs::write(&path, b"hello world\n").unwrap();
    let mut s = open_session(&path);
    // Edit, then save (rebases the piece table onto the written file).
    s.apply(vec![edit(0, 5, "GOODBYE")], true).unwrap();
    save(&mut s);
    assert_eq!(fs::read(&path).unwrap(), b"GOODBYE world\n");
    // The journal survives the rebase: undo still restores the original, and a
    // second save writes it back to disk byte-for-byte.
    s.undo().unwrap();
    assert_eq!(whole(&s), b"hello world\n");
    save(&mut s);
    assert_eq!(fs::read(&path).unwrap(), b"hello world\n");
  }

  #[test]
  fn journal_evicts_oldest_past_limit() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"");
    // One more group than the cap; the oldest must be dropped.
    for i in 0..(UNDO_LIMIT + 1) {
      let at = s.table.len();
      s.apply(vec![edit(at, at, "x")], true).unwrap();
      let _ = i;
    }
    assert_eq!(s.undo_stack.len(), UNDO_LIMIT);
    // Exactly UNDO_LIMIT undos succeed; the evicted group is gone.
    for _ in 0..UNDO_LIMIT {
      s.undo().unwrap();
    }
    assert_eq!(s.undo().unwrap_err(), NOTHING_TO_UNDO);
    // The first inserted 'x' was evicted, so one char remains.
    assert_eq!(whole(&s), b"x");
  }

  #[test]
  fn empty_stacks_return_protocol_errors() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"abc");
    assert_eq!(s.undo().unwrap_err(), NOTHING_TO_UNDO);
    assert_eq!(s.redo().unwrap_err(), NOTHING_TO_REDO);
  }
  // --- the clean flag ----------------------------------------------------------

  #[test]
  fn a_freshly_opened_session_is_clean() {
    let dir = tempdir().unwrap();
    let s = session_with(&dir, b"abc");
    assert!(s.clean());
  }

  #[test]
  fn an_empty_batch_keeps_the_session_clean() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"abc");
    let stats = s.apply(Vec::new(), true).unwrap();
    assert!(stats.clean);
    assert_eq!(stats.generation, 0);
    s.apply(vec![edit(0, 0, "X")], true).unwrap();
    save(&mut s);
    assert!(s.apply(Vec::new(), true).unwrap().clean);
  }

  #[test]
  fn an_edit_is_dirty_and_undoing_every_edit_is_clean_again() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"abc");
    assert!(!s.apply(vec![edit(0, 0, "X")], true).unwrap().clean);
    assert!(!s.apply(vec![edit(1, 1, "Y")], true).unwrap().clean);
    assert!(!s.undo().unwrap().clean);
    assert!(s.undo().unwrap().clean);
    assert!(!s.redo().unwrap().clean);
    assert!(!s.redo().unwrap().clean);
    assert!(!s.undo().unwrap().clean);
    assert!(s.undo().unwrap().clean);
  }

  #[test]
  fn undoing_past_a_save_is_dirty_and_redoing_back_to_it_is_clean() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"abc");
    s.apply(vec![edit(0, 0, "X")], true).unwrap();
    save(&mut s);
    assert!(s.clean());
    assert!(!s.undo().unwrap().clean);
    assert!(s.redo().unwrap().clean);
  }

  #[test]
  fn typing_that_would_coalesce_after_a_save_still_undoes_to_the_saved_state() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"");
    s.apply(vec![edit(0, 0, "a")], true).unwrap();
    save(&mut s);
    // Not a new group by the caller's rule, yet it must not join the saved one.
    assert!(!s.apply(vec![edit(1, 1, "b")], false).unwrap().clean);
    assert_eq!(s.undo_stack.len(), 2);
    assert!(s.undo().unwrap().clean);
    assert_eq!(whole(&s), b"a");
    // The next typing after that coalesces again.
    s.apply(vec![edit(1, 1, "c")], false).unwrap();
    s.apply(vec![edit(2, 2, "d")], false).unwrap();
    assert_eq!(s.undo_stack.len(), 2);
    assert!(s.undo().unwrap().clean);
    assert_eq!(whole(&s), b"a");
  }

  #[test]
  fn typing_after_undoing_past_a_save_is_never_clean_before_the_next_save() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"");
    s.apply(vec![edit(0, 0, "a")], true).unwrap();
    save(&mut s);
    assert!(!s.undo().unwrap().clean);
    assert!(!s.apply(vec![edit(0, 0, "z")], false).unwrap().clean);
    assert!(!s.undo().unwrap().clean);
    assert!(!s.redo().unwrap().clean);
    // The saved content ("a") is no state this session can reach again.
    assert_eq!(whole(&s), b"z");
    save(&mut s);
    assert!(s.clean());
  }

  #[test]
  fn undoing_all_of_more_than_the_journal_keeps_is_still_dirty() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"");
    for _ in 0..(UNDO_LIMIT + 1) {
      let at = s.table.len();
      s.apply(vec![edit(at, at, "x")], true).unwrap();
    }
    let mut last = true;
    for _ in 0..UNDO_LIMIT {
      last = s.undo().unwrap().clean;
    }
    assert!(!last, "the evicted step's edit is still in the document");
    assert_eq!(whole(&s), b"x");
    assert!(!s.clean());
  }

  #[test]
  fn save_as_makes_the_session_clean() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"abc");
    s.apply(vec![edit(0, 0, "X")], true).unwrap();
    assert!(!s.clean());
    let saved = save_session(&mut s, None, Some(dir.path().join("other.txt"))).unwrap();
    assert!(saved.clean);
    assert!(s.clean());
    assert!(!s.undo().unwrap().clean);
    assert!(s.redo().unwrap().clean);
  }

  #[test]
  fn results_carry_a_generation_that_only_grows() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"abc");
    let a = s.apply(vec![edit(0, 0, "X")], true).unwrap().generation;
    let b = s.apply(vec![edit(1, 1, "Y")], false).unwrap().generation;
    let c = s.undo().unwrap().generation;
    let d = s.redo().unwrap().generation;
    let e = save_session(&mut s, None, None).unwrap().generation;
    assert!(a < b && b < c && c < d && d < e, "{a} {b} {c} {d} {e}");
  }

  #[test]
  fn undo_result_reports_edits_and_first_line() {
    let dir = tempdir().unwrap();
    let mut s = session_with(&dir, b"L0\nL1\nL2\n");
    // Insert on line 1 (byte 3).
    s.apply(vec![edit(3, 3, "X")], true).unwrap();
    let r = s.undo().unwrap();
    // The undo removes the inserted "X": one edit deleting [3,4).
    assert_eq!(r.edits.len(), 1);
    assert_eq!(r.edits[0].start, 3);
    assert_eq!(r.edits[0].end, 4);
    assert_eq!(r.edits[0].text, "");
    assert_eq!(r.first_line, 1);
    assert_eq!(r.total_bytes, 9);
  }

  #[test]
  fn reopen_trusts_supplied_index_without_rescanning() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("trust.txt");
    fs::write(&path, "one\ntwo\nthree\n").unwrap();
    let fingerprint = fingerprint_of(&path).unwrap();
    let (_, _, _, real_index, digest) = build_table(&path).unwrap();
    // Deliberately wrong-but-well-formed index: the real file has 3 newlines
    // (4 lines); this claims 40. The checkpoint *offsets* (what the digest is
    // sampled against) are left correct, so only trusting the index verbatim
    // (no rescan) could let the wrong `total_newlines` survive into the
    // rebuilt session.
    let bogus = CheckpointIndex {
      checkpoints: real_index.checkpoints,
      total_newlines: 40,
      line_rule: LINE_RULE,
    };
    let next_id = AtomicU64::new(0);
    let (_, session, result) =
      reopen_session(&next_id, path, bogus, fingerprint, Some(digest)).unwrap();
    assert!(
      !result.rescanned,
      "a matching fingerprint and digest must skip the scan entirely"
    );
    assert_eq!(session.table.line_count(), 41);
  }

  #[test]
  fn reopen_rescans_an_index_counted_under_another_line_rule() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rule.txt");
    // Breaks at bytes 1, 4 and 6: four lines, where `\n` alone gives two.
    let content = b"a\rb\r\nc\r";
    fs::write(&path, content).unwrap();
    let fingerprint = fingerprint_of(&path).unwrap();
    let (_, _, _, real_index, digest) = build_table(&path).unwrap();
    assert_eq!(real_index.line_rule, LINE_RULE);
    assert_eq!(real_index.total_newlines, 3);
    // Only the rule differs from the real index: the checkpoints, fingerprint
    // and digest all match, yet the index is not trusted.
    let counted_before = CheckpointIndex {
      line_rule: 0,
      ..real_index.clone()
    };
    assert!(!valid_checkpoint_index(
      &counted_before,
      content.len() as u64
    ));
    // An index saved before the field existed reads back with rule 0.
    let json = r#"{"checkpoints":[[0,0]],"total_newlines":1}"#;
    let saved: CheckpointIndex = serde_json::from_str(json).unwrap();
    assert_eq!(saved.line_rule, 0);
    assert!(!valid_checkpoint_index(&saved, content.len() as u64));
    let next_id = AtomicU64::new(0);
    let (_, session, result) = reopen_session(
      &next_id,
      path.clone(),
      counted_before,
      fingerprint.clone(),
      Some(digest),
    )
    .unwrap();
    assert!(result.rescanned);
    assert_eq!(session.table.line_count(), 4);
    // A fresh index goes through JSON the way the frontend hands it back, and
    // is trusted.
    let json = serde_json::to_string(&real_index).unwrap();
    assert!(json.contains(r#""line_rule":1"#), "{json}");
    let handed_back: CheckpointIndex = serde_json::from_str(&json).unwrap();
    assert!(valid_checkpoint_index(&handed_back, content.len() as u64));
    let (_, session, result) =
      reopen_session(&next_id, path, handed_back, fingerprint, Some(digest)).unwrap();
    assert!(!result.rescanned);
    assert_eq!(session.table.line_count(), 4);
  }

  #[test]
  fn reopen_with_stale_fingerprint_rescans_and_rebuilds_correct_index() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("stale.txt");
    fs::write(&path, "a\nb\n").unwrap();
    let stale = fingerprint_of(&path).unwrap();
    // The file changes size after the fingerprint was captured (and before
    // reopen), so the supplied fingerprint no longer matches.
    fs::write(&path, "one\ntwo\nthree\nfour\n").unwrap();
    assert_ne!(fingerprint_of(&path).unwrap(), stale);
    let bogus = CheckpointIndex {
      checkpoints: vec![(0, 0)],
      total_newlines: 999,
      line_rule: LINE_RULE,
    };
    let next_id = AtomicU64::new(0);
    // The fingerprint mismatch alone forces the fallback, so the digest value
    // supplied here is irrelevant; `None` stands in for "whatever was
    // persisted" (or failed to parse).
    let (_, session, result) = reopen_session(&next_id, path, bogus, stale, None).unwrap();
    assert!(result.rescanned);
    // The rescan produces the correct index for the *new* content, not the
    // bogus supplied one.
    assert_eq!(session.table.line_count(), 5);
    assert_eq!(whole(&session), b"one\ntwo\nthree\nfour\n");
  }

  #[test]
  fn reopen_detects_same_size_content_change_inside_sampled_region() {
    // A same-size, same-mtime content change is exactly what the sampled
    // digest exists to catch when it lands where the digest actually reads:
    // this whole tiny file lives inside checkpoint 0's sampled block, so the
    // change is visible even though the fingerprint alone would miss it (see
    // `reopen_cannot_detect_content_change_outside_every_sampled_region` for
    // the region this guard does *not* cover). The mtime collision is forced
    // deterministically via `set_modified` rather than relying on racing the
    // clock.
    let dir = tempdir().unwrap();
    let path = dir.path().join("collide.txt");
    fs::write(&path, "aaa\nbbbb").unwrap(); // 1 newline, 8 bytes.
    let fingerprint = fingerprint_of(&path).unwrap();
    let (_, _, _, real_index, real_digest) = build_table(&path).unwrap();
    assert_eq!(real_index.total_newlines, 1);

    // Same byte length, but the newline is gone: 0 newlines, still 8 bytes.
    fs::write(&path, "aaabbbbb").unwrap();
    pin_mtime(&path, &fingerprint);

    let next_id = AtomicU64::new(0);
    let (_, session, result) = reopen_session(
      &next_id,
      path.clone(),
      real_index,
      fingerprint,
      Some(real_digest),
    )
    .unwrap();

    // The digest mismatch (computed over the same checkpoint offsets, which
    // cover this whole small file) forces a rescan despite the matching
    // fingerprint, and the rescan finds the real, correct content.
    assert!(result.rescanned);
    assert_eq!(session.table.line_count(), 1);
    assert_eq!(whole(&session), b"aaabbbbb");
  }

  #[test]
  fn reopen_cannot_detect_content_change_outside_every_sampled_region() {
    // Residual, deliberately narrow limitation: the sampled digest only reads
    // near the start, near the end, and near each checkpoint offset. An
    // adversarial same-size edit placed strictly between those regions, with
    // the mtime also restored, is invisible to both the fingerprint and the
    // digest. Closing this fully would mean hashing the whole file, which is
    // the cost this feature exists to avoid — this test pins the boundary
    // rather than pretending it does not exist.
    let dir = tempdir().unwrap();
    let path = dir.path().join("blindspot.txt");
    // Two checkpoint intervals (checkpoints at 0 and at 1 MiB); all-ASCII, no
    // newlines, so the newline-count math stays easy to reason about.
    let size = 2 * CHECKPOINT_INTERVAL as usize;
    fs::write(&path, vec![b'a'; size]).unwrap();
    let fingerprint = fingerprint_of(&path).unwrap();
    let (_, _, _, real_index, real_digest) = build_table(&path).unwrap();
    assert_eq!(
      real_index.checkpoints,
      vec![(0, 0), (CHECKPOINT_INTERVAL, 0)]
    );
    assert_eq!(real_index.total_newlines, 0);

    // A byte roughly in the middle of the second interval: past the first
    // checkpoint's sampled block, past the second checkpoint's sampled block,
    // and well before the last-block sample near EOF.
    let target = CHECKPOINT_INTERVAL + CHECKPOINT_INTERVAL / 2;
    {
      let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
      file.seek(SeekFrom::Start(target)).unwrap();
      file.write_all(b"\n").unwrap(); // Same size; adds a newline outside every sample.
    }
    pin_mtime(&path, &fingerprint);

    let next_id = AtomicU64::new(0);
    let (_, session, result) = reopen_session(
      &next_id,
      path.clone(),
      real_index,
      fingerprint,
      Some(real_digest),
    )
    .unwrap();

    // Trusted despite the real content now containing a newline the stale
    // index does not know about: the pinned residual blind spot.
    assert!(!result.rescanned);
    assert_eq!(session.table.line_count(), 1); // Stale: still thinks 0 newlines.
    let (_, _, _, fresh_index, _) = build_table(&path).unwrap();
    assert_eq!(fresh_index.total_newlines, 1); // A real scan would find it.
  }

  #[test]
  fn sample_digest_is_deterministic() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("det.txt");
    fs::write(&path, "hello\nworld\n").unwrap();
    let checkpoints = vec![(0, 0)];
    let d1 = sample_digest(&path, 12, &checkpoints).unwrap();
    let d2 = sample_digest(&path, 12, &checkpoints).unwrap();
    assert_eq!(d1, d2);
  }

  #[test]
  fn sample_digest_handles_file_smaller_than_one_block() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("small.txt");
    fs::write(&path, "tiny").unwrap(); // 4 bytes, well under SAMPLE_BLOCK.
    let checkpoints = vec![(0, 0)];
    let d1 = sample_digest(&path, 4, &checkpoints).unwrap();
    let d2 = sample_digest(&path, 4, &checkpoints).unwrap();
    assert_eq!(d1, d2);
  }

  #[test]
  fn sample_digest_mixes_in_start_and_len_not_just_bytes() {
    // Whole file is one repeated byte, so any region sampled reads identical
    // content regardless of where it starts. Two single-checkpoint calls that
    // land on different offsets therefore read the exact same raw bytes at
    // both their checkpoint region and the (always-included) last-block
    // region; only hashing each region's own `(start, len)` alongside its
    // bytes (see `sample_digest`) can tell these two checkpoint choices apart.
    // Without that mixing, content shifted between regions could collide.
    let dir = tempdir().unwrap();
    let path = dir.path().join("repeat.txt");
    let total_bytes = 2 * SAMPLE_BLOCK;
    fs::write(&path, vec![b'a'; total_bytes as usize]).unwrap();
    let d_a = sample_digest(&path, total_bytes, &[(0, 0)]).unwrap();
    let d_b = sample_digest(&path, total_bytes, &[(1000, 0)]).unwrap();
    assert_ne!(d_a, d_b);
  }

  #[test]
  fn sample_digest_dedups_overlapping_start_offsets() {
    // Two checkpoints that land on the same offset (0) as each other and as
    // the last-block region (the file is smaller than `SAMPLE_BLOCK`, so the
    // last-block start is also 0): without `starts.dedup()` this one region
    // would be hashed three times instead of once, producing a different
    // digest than the single-checkpoint equivalent below.
    let dir = tempdir().unwrap();
    let path = dir.path().join("overlap.txt");
    fs::write(&path, b"hello world").unwrap();
    let total_bytes = 11;
    let with_dup = sample_digest(&path, total_bytes, &[(0, 0), (0, 5)]).unwrap();
    let without_dup = sample_digest(&path, total_bytes, &[(0, 0)]).unwrap();
    assert_eq!(with_dup, without_dup);
  }

  #[test]
  fn sample_digest_handles_empty_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("empty.txt");
    fs::write(&path, b"").unwrap();
    let checkpoints = vec![(0, 0)];
    let d1 = sample_digest(&path, 0, &checkpoints).unwrap();
    let d2 = sample_digest(&path, 0, &checkpoints).unwrap();
    assert_eq!(d1, d2);
  }

  #[test]
  fn index_snapshot_serializes_digest_as_a_json_string_not_a_number() {
    // This is the exact wire shape `windowed_index` hands the frontend. A
    // JSON *number* here would decode in JS as an `f64`, silently rounding a
    // digest this large; a JSON *string* round-trips it exactly.
    let snapshot = IndexSnapshot {
      index: CheckpointIndex {
        checkpoints: vec![(0, 0)],
        total_newlines: 0,
        line_rule: LINE_RULE,
      },
      fingerprint: Fingerprint {
        size: 0,
        mtime_ms: 0,
      },
      digest: 8_614_438_812_897_467_614u64.to_string(),
    };
    let json = serde_json::to_value(&snapshot).unwrap();
    assert!(
      json["digest"].is_string(),
      "digest must serialize as a JSON string, not a number"
    );
  }

  #[test]
  fn digest_does_not_survive_an_f64_ipc_round_trip_but_a_decimal_string_does() {
    // A real, previously observed FNV-1a output: 64 significant bits, well
    // past `f64`'s 53-bit integer precision. This is the exact regression F1
    // fixes — a raw `u64` handed to JS as a JSON number gets silently rounded
    // the instant JS parses it, and the rounded value is what would get
    // persisted and handed back to `windowed_reopen`, permanently defeating
    // the fast path.
    let digest: u64 = 8_614_438_812_897_467_614;

    // What `response.json()` on the JS side does to a raw `u64` embedded as a
    // JSON number: decode as `f64`, the only numeric type JSON has.
    let via_f64 = digest as f64 as u64;
    assert_ne!(
      via_f64, digest,
      "this digest must not survive an f64 round-trip, or the regression this \
       test exists to catch is not actually being exercised"
    );

    // What actually crosses the boundary now (see `IndexSnapshot::digest` and
    // `parse_digest`): a decimal string, parsed back into a `u64` with no
    // intermediate float at all.
    let via_string = digest.to_string().parse::<u64>().unwrap();
    assert_eq!(
      via_string, digest,
      "the string wire format must round-trip the digest exactly"
    );
  }

  #[test]
  fn parse_digest_rejects_malformed_input_instead_of_panicking() {
    assert_eq!(parse_digest("12345"), Some(12345));
    assert_eq!(parse_digest("not-a-number"), None);
    assert_eq!(parse_digest(""), None);
    // A raw f64-rounded value (as would arrive from a pre-fix frontend, or a
    // corrupted snapshot) is still a well-formed decimal string, so it parses
    // — it just won't match the real digest, which `reopen_session` already
    // handles as an ordinary mismatch (see `reopen_with_stale_fingerprint_*`).
    assert_eq!(
      parse_digest("8614438812897467000"),
      Some(8_614_438_812_897_467_000)
    );
  }

  #[test]
  fn reopen_rejects_empty_index_for_nonempty_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("nonempty.txt");
    fs::write(&path, "a\nb\nc\n").unwrap();
    let fingerprint = fingerprint_of(&path).unwrap();
    let empty = CheckpointIndex {
      checkpoints: Vec::new(),
      total_newlines: 0,
      line_rule: LINE_RULE,
    };
    // The digest matching what `sample_digest` actually computes over the
    // supplied (empty) checkpoint list, so a digest mismatch cannot be what
    // forces the rescan below — only `valid_checkpoint_index` rejecting the
    // empty index for a non-empty file can be.
    let digest = sample_digest(&path, 6, &empty.checkpoints).unwrap();
    let next_id = AtomicU64::new(0);
    let (_, session, result) =
      reopen_session(&next_id, path, empty, fingerprint, Some(digest)).unwrap();
    // Rejected despite the matching fingerprint and digest: falls back to a
    // full, correct scan rather than producing a corrupt (line-count-0)
    // session.
    assert!(result.rescanned);
    assert_eq!(session.table.line_count(), 4);
  }

  #[test]
  fn reopen_rejects_non_monotonic_offsets() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("nonmono.txt");
    fs::write(&path, "a\nb\nc\n").unwrap();
    let fingerprint = fingerprint_of(&path).unwrap();
    let bad = CheckpointIndex {
      checkpoints: vec![(0, 0), (3, 1), (2, 2)],
      total_newlines: 3,
      line_rule: LINE_RULE,
    };
    // Matches what `sample_digest` computes over these exact (bad) offsets, so
    // a digest mismatch cannot be what forces the rescan below. These offsets
    // (3, 2) are not 1-MiB-interval multiples, so the interval-spacing check
    // rejects the very first pair (0, 3) before the loop ever reaches the
    // non-ascending pair (3, 2) — it is that spacing check, not the ascending-
    // offset guard, that forces the rescan here. The ascending guard has its
    // own dedicated coverage using 1-MiB-multiple offsets (see
    // `valid_checkpoint_index_rejects_non_ascending_offsets_at_interval_spacing`),
    // where spacing cannot absorb the rejection.
    let digest = sample_digest(&path, 6, &bad.checkpoints).unwrap();
    let next_id = AtomicU64::new(0);
    let (_, session, result) =
      reopen_session(&next_id, path, bad, fingerprint, Some(digest)).unwrap();
    assert!(result.rescanned);
    assert_eq!(session.table.line_count(), 4);
  }

  #[test]
  fn reopen_rejects_offset_past_eof() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("pasteof.txt");
    fs::write(&path, "a\nb\nc\n").unwrap(); // 6 bytes.
    let fingerprint = fingerprint_of(&path).unwrap();
    let bad = CheckpointIndex {
      checkpoints: vec![(0, 0), (100, 3)],
      total_newlines: 3,
      line_rule: LINE_RULE,
    };
    // Matches what `sample_digest` computes over these exact (bad) offsets
    // (the offset past EOF is simply skipped, same as `sample_digest` does),
    // so a digest mismatch cannot be what forces the rescan below. This offset
    // (100) is not a 1-MiB-interval multiple either, so the interval-spacing
    // check rejects it before the loop ever reaches the past-EOF check — it
    // is that spacing check, not the past-EOF guard, that forces the rescan
    // here. The past-EOF guard has its own dedicated coverage using a 1-MiB-
    // multiple offset (see `valid_checkpoint_index_rejects_checkpoint_at_eof`),
    // where spacing cannot absorb the rejection.
    let digest = sample_digest(&path, 6, &bad.checkpoints).unwrap();
    let next_id = AtomicU64::new(0);
    let (_, session, result) =
      reopen_session(&next_id, path, bad, fingerprint, Some(digest)).unwrap();
    assert!(result.rescanned);
    assert_eq!(session.table.line_count(), 4);
  }

  #[test]
  fn valid_checkpoint_index_rejects_non_ascending_offsets_at_interval_spacing() {
    // Every offset here is an exact multiple of `CHECKPOINT_INTERVAL`, so the
    // interval-spacing check cannot short-circuit this the way it does in
    // `reopen_rejects_non_monotonic_offsets` above — only the ascending-offset
    // guard rejects it. Without that guard, `offset - prev_offset` (5 -
    // CHECKPOINT_INTERVAL) underflows and panics — see
    // `valid_checkpoint_index`'s doc comment and its "attempt to subtract with
    // overflow" note.
    let index = CheckpointIndex {
      checkpoints: vec![(0, 0), (CHECKPOINT_INTERVAL, 0), (5, 0)],
      total_newlines: 0,
      line_rule: LINE_RULE,
    };
    assert!(!valid_checkpoint_index(&index, 3 * CHECKPOINT_INTERVAL));
  }

  #[test]
  fn valid_checkpoint_index_rejects_non_zero_first_checkpoint() {
    // Both offsets are exact multiples of `CHECKPOINT_INTERVAL` apart, so the
    // interval-spacing check cannot short-circuit this — only the seed guard
    // (`checkpoints[0] == (0, 0)`) rejects it. Without that guard this index
    // validates (ascending, correctly spaced, in range), and a query for an
    // offset before the first checkpoint's offset then panics inside
    // `PieceTable::seg_of_offset`'s `partition_point(...) - 1`.
    let index = CheckpointIndex {
      checkpoints: vec![(5, 0), (CHECKPOINT_INTERVAL + 5, 1)],
      total_newlines: 1,
      line_rule: LINE_RULE,
    };
    assert!(!valid_checkpoint_index(&index, 2 * CHECKPOINT_INTERVAL));
  }

  #[test]
  fn valid_checkpoint_index_rejects_checkpoint_at_eof() {
    // The offset is an exact multiple of `CHECKPOINT_INTERVAL`, so the
    // interval-spacing check cannot short-circuit this — only the past-EOF
    // guard rejects it. Without that guard this index validates into a
    // degenerate zero-length final segment: the last checkpoint sits exactly
    // at EOF, with nothing left after it.
    let index = CheckpointIndex {
      checkpoints: vec![(0, 0), (CHECKPOINT_INTERVAL, 0)],
      total_newlines: 0,
      line_rule: LINE_RULE,
    };
    assert!(!valid_checkpoint_index(&index, CHECKPOINT_INTERVAL));
  }

  #[test]
  fn reopen_rejects_undersized_checkpoint_spacing() {
    // A single `(0, 0)` checkpoint claimed for a file several intervals large:
    // every existing check (ascending offsets, in-range, matching fingerprint
    // and digest) would pass this. Only the spacing check added for F3 rejects
    // it — without it, `OriginalIndex::load_segment` would read the entire gap
    // between the checkpoint and EOF into memory in one go.
    let dir = tempdir().unwrap();
    let path = dir.path().join("undersized.txt");
    let size = 5 * CHECKPOINT_INTERVAL as usize;
    fs::write(&path, vec![b'a'; size]).unwrap();
    let fingerprint = fingerprint_of(&path).unwrap();
    let bad = CheckpointIndex {
      checkpoints: vec![(0, 0)],
      total_newlines: 0,
      line_rule: LINE_RULE,
    };
    let digest = sample_digest(&path, size as u64, &bad.checkpoints).unwrap();
    let next_id = AtomicU64::new(0);
    let (_, session, result) =
      reopen_session(&next_id, path, bad, fingerprint, Some(digest)).unwrap();
    assert!(result.rescanned);
    assert_eq!(session.table.line_count(), 1);
  }

  #[test]
  fn reopen_rejects_undersized_interior_checkpoint_spacing() {
    // Unlike `reopen_rejects_undersized_checkpoint_spacing` (a lone `(0, 0)`
    // for a file several intervals large, which the *final*-gap check alone
    // already rejects), this pins the *interior* spacing check specifically:
    // a second checkpoint placed 3 intervals past the first, for a file whose
    // *final* gap (past that second checkpoint) is legitimately small. If the
    // interior spacing check were ever deleted, this index would validate —
    // and `OriginalIndex::load_segment` would then read the entire 3 MiB
    // interior gap into memory in one go, the unbounded-memory-use this
    // sparse index exists to avoid.
    let dir = tempdir().unwrap();
    let path = dir.path().join("interior_gap.txt");
    let size = 3 * CHECKPOINT_INTERVAL + 10;
    fs::write(&path, vec![b'a'; size as usize]).unwrap();
    let fingerprint = fingerprint_of(&path).unwrap();
    let bad = CheckpointIndex {
      checkpoints: vec![(0, 0), (3 * CHECKPOINT_INTERVAL, 0)],
      total_newlines: 0,
      line_rule: LINE_RULE,
    };
    let digest = sample_digest(&path, size, &bad.checkpoints).unwrap();
    let next_id = AtomicU64::new(0);
    let (_, session, result) =
      reopen_session(&next_id, path, bad, fingerprint, Some(digest)).unwrap();
    assert!(result.rescanned);
    assert_eq!(session.table.line_count(), 1);
  }

  #[test]
  fn reopen_rejects_non_monotonic_newline_counts() {
    // A second checkpoint claiming fewer newlines-before than the first: the
    // count can only grow (or stay flat) between checkpoints, so this is
    // internally inconsistent and cannot have come from a real scan. Without
    // this check, `OriginalIndex::newline_pos`'s
    // `ordinal - checkpoints[seg].1 - 1` would underflow the moment a query
    // for an ordinal below the first checkpoint's claimed count landed in the
    // second checkpoint's segment.
    let dir = tempdir().unwrap();
    let path = dir.path().join("nonmono_newlines.txt");
    let size = 3 * CHECKPOINT_INTERVAL;
    fs::write(&path, vec![b'a'; size as usize]).unwrap();
    let fingerprint = fingerprint_of(&path).unwrap();
    let bad = CheckpointIndex {
      checkpoints: vec![
        (0, 0),
        (CHECKPOINT_INTERVAL, 5),
        (2 * CHECKPOINT_INTERVAL, 2),
      ],
      total_newlines: 5,
      line_rule: LINE_RULE,
    };
    let digest = sample_digest(&path, size, &bad.checkpoints).unwrap();
    let next_id = AtomicU64::new(0);
    let (_, session, result) =
      reopen_session(&next_id, path, bad, fingerprint, Some(digest)).unwrap();
    assert!(result.rescanned);
    assert_eq!(session.table.line_count(), 1);
  }

  #[test]
  fn reopen_rejects_total_newlines_below_last_checkpoint() {
    // A real index whose last checkpoint carries `newlines_before: 1`, but the
    // supplied `total_newlines` claims 0 — internally inconsistent, since the
    // count can only grow (or stay flat) after a checkpoint, never shrink.
    // Every other check (offsets, spacing, fingerprint, digest — the digest
    // never covers `newlines_before`/`total_newlines`) would pass this, so
    // only the F3(b) consistency check added to `valid_checkpoint_index`
    // rejects it.
    let dir = tempdir().unwrap();
    let path = dir.path().join("badtotal.txt");
    let size = 2 * CHECKPOINT_INTERVAL as usize;
    let mut content = vec![b'a'; size];
    content[100] = b'\n'; // One newline, before the single non-seed checkpoint.
    fs::write(&path, &content).unwrap();
    let fingerprint = fingerprint_of(&path).unwrap();
    let (_, _, _, real_index, _) = build_table(&path).unwrap();
    assert_eq!(
      real_index.checkpoints,
      vec![(0, 0), (CHECKPOINT_INTERVAL, 1)]
    );
    assert_eq!(real_index.total_newlines, 1);
    let bad = CheckpointIndex {
      checkpoints: real_index.checkpoints.clone(),
      total_newlines: 0,
      line_rule: LINE_RULE,
    };
    // Same checkpoint offsets/bytes as the real index, so the digest still
    // matches: only the tampered `total_newlines` differs.
    let digest = sample_digest(&path, size as u64, &bad.checkpoints).unwrap();
    let next_id = AtomicU64::new(0);
    let (_, session, result) =
      reopen_session(&next_id, path, bad, fingerprint, Some(digest)).unwrap();
    assert!(result.rescanned);
    assert_eq!(session.table.line_count(), 2);
  }

  #[test]
  fn reopen_rescan_rejects_non_utf8() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("invalid.bin");
    fs::write(&path, [0x61u8, 0xFF, 0x62]).unwrap();
    // A fingerprint that never matches forces the fallback rescan path.
    let mismatched = Fingerprint {
      size: 999,
      mtime_ms: 0,
    };
    let placeholder = CheckpointIndex {
      checkpoints: vec![(0, 0)],
      total_newlines: 0,
      line_rule: LINE_RULE,
    };
    let next_id = AtomicU64::new(0);
    let err = match reopen_session(&next_id, path, placeholder, mismatched, None) {
      Err(e) => e,
      Ok(_) => panic!("expected NOT_UTF8"),
    };
    assert_eq!(err, NOT_UTF8);
  }

  #[test]
  fn reopen_and_open_both_refuse_file_at_ceiling() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("huge.txt");
    // A sparse file (no real bytes written) is enough to exercise the
    // metadata-length ceiling check, which runs before any scan.
    File::create(&path)
      .unwrap()
      .set_len(LARGE_EDIT_MAX)
      .unwrap();
    let next_id = AtomicU64::new(0);

    let open_err = match open_new_session(&next_id, path.clone()) {
      Err(e) => e,
      Ok(_) => panic!("expected TOO_LARGE"),
    };
    assert_eq!(open_err, TOO_LARGE);

    let index = CheckpointIndex {
      checkpoints: vec![(0, 0)],
      total_newlines: 0,
      line_rule: LINE_RULE,
    };
    let fingerprint = Fingerprint {
      size: LARGE_EDIT_MAX,
      mtime_ms: 0,
    };
    let reopen_err = match reopen_session(&next_id, path, index, fingerprint, None) {
      Err(e) => e,
      Ok(_) => panic!("expected TOO_LARGE"),
    };
    assert_eq!(reopen_err, TOO_LARGE);
  }

  #[test]
  fn open_edit_save_index_reopen_roundtrip_reads_same_lines() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("roundtrip.txt");
    fs::write(&path, "line0\nline1\nline2\nline3\n").unwrap();

    let next_id = AtomicU64::new(0);
    let (session_id, mut session, _) = open_new_session(&next_id, path.clone()).unwrap();
    apply(&mut session, &[(0u64, 5u64, "HEAD")]).unwrap();
    save(&mut session);
    let _ = session_id;

    // Persist exactly what `windowed_index` would hand the frontend.
    let index = session.index.clone();
    let fingerprint = session.fingerprint.clone();
    let digest = session.digest;
    assert_eq!(fingerprint_of(&path).unwrap(), fingerprint);

    let (_, reopened, result) =
      reopen_session(&next_id, path, index, fingerprint, Some(digest)).unwrap();
    assert!(!result.rescanned);
    assert_eq!(
      read_window(&reopened, 0, reopened.table.line_count()),
      b"HEAD\nline1\nline2\nline3\n"
    );
  }
}
/// Search, find and replace-all over a session's edited content.
#[cfg(test)]
mod replace_tests {
  use super::*;
  use crate::large_file::find_sub;
  use crate::replace_layer::{layer_depth, list_paths, resident_units};
  use std::io::Cursor;
  use std::sync::mpsc;
  use std::time::{Duration, Instant};
  use tempfile::{tempdir, TempDir};

  const ID: u64 = 1;

  struct Fixture {
    dir: TempDir,
    path: PathBuf,
    tmp: PathBuf,
    state: WindowedState,
  }

  fn fixture(content: &[u8]) -> Fixture {
    let dir = tempdir().unwrap();
    let path = dir.path().join("doc.txt");
    fs::write(&path, content).unwrap();
    let (table, _, fingerprint, index, digest) = build_table(&path).unwrap();
    let state = WindowedState::default();
    state.sessions.lock().unwrap().insert(
      ID,
      Session::new(table, path.clone(), fingerprint, index, digest),
    );
    let tmp = dir.path().join(replace_layer::TMP_DIR);
    Fixture {
      dir,
      path,
      tmp,
      state,
    }
  }

  fn ed(start: u64, end: u64, text: &str) -> Edit {
    Edit {
      start,
      end,
      text: text.to_string(),
      keep_start: false,
      cascade: false,
    }
  }

  impl Fixture {
    fn with<R>(&self, f: impl FnOnce(&mut Session) -> R) -> R {
      let mut map = self.state.sessions.lock().unwrap();
      f(map.get_mut(&ID).unwrap())
    }

    fn whole(&self) -> Vec<u8> {
      self.with(|s| s.table.read(0, s.table.len()).unwrap())
    }

    fn edit(&self, edits: Vec<Edit>, new_group: bool) {
      self.with(|s| s.apply(edits, new_group).unwrap());
    }

    fn replace_with(
      &self,
      q: &str,
      case: bool,
      r: &str,
      chunk: usize,
      interval: u64,
    ) -> ReplaceAllOutcome {
      self.replace_with_sep(q, case, r, "\n", chunk, interval)
    }

    fn replace_with_sep(
      &self,
      q: &str,
      case: bool,
      r: &str,
      insert_sep: &str,
      chunk: usize,
      interval: u64,
    ) -> ReplaceAllOutcome {
      replace_all_core(
        &self.state,
        &self.tmp,
        ID,
        q,
        case,
        r,
        insert_sep,
        chunk,
        interval,
        &mut |_| {},
      )
      .unwrap()
    }

    fn replace(&self, q: &str, r: &str) -> ReplaceAllOutcome {
      self.replace_with(q, true, r, SCAN_CHUNK, CHECKPOINT_INTERVAL)
    }

    fn undo(&self) -> UndoResult {
      self.with(|s| s.undo().unwrap())
    }

    fn redo(&self) -> UndoResult {
      self.with(|s| s.redo().unwrap())
    }

    fn save(&self) {
      save_core(&self.state, ID, None, None).unwrap();
    }

    fn change_lists_on_disk(&self) -> usize {
      match fs::read_dir(&self.tmp) {
        Ok(entries) => entries.flatten().count(),
        Err(_) => 0,
      }
    }

    fn live_lists(&self) -> Vec<PathBuf> {
      self.with(|s| list_paths(&s.table))
    }
  }
  /// One hit of the model: its pre-replace offset, and whether the `\n` of a
  /// CRLF junction is part of its output.
  struct ModelHit {
    pre: usize,
    sep: bool,
  }
  /// The replace-all rule written out over whole buffers: the post bytes and the
  /// hits with the inserted-byte attribution.
  struct ReplaceModel {
    post: Vec<u8>,
    hits: Vec<ModelHit>,
    junctions: usize,
  }
  /// Where a post-replace byte before the rewrite came from.
  #[derive(Clone, Copy)]
  enum Origin {
    Gap(usize),
    Hit(usize),
  }
  /// Replace `needle` by `repl` (leftmost, non-overlapping), then rewrite every
  /// kept CR (a `\r` of the text between hits whose next byte is not `\n`) that
  /// the replacement leaves directly before a `\n`: for `\r\n` an `\n` goes
  /// right after it, for `\n` it and the run of `\r` before it become `\n`.
  fn replace_model(
    hay: &[u8],
    needle: &[u8],
    repl: &[u8],
    case: bool,
    insert_sep: &str,
  ) -> ReplaceModel {
    let mut hits = Vec::new();
    let mut q0: Vec<(u8, Origin)> = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = find_sub(&hay[from..], needle, case) {
      for (i, &b) in hay[from..from + rel].iter().enumerate() {
        q0.push((b, Origin::Gap(from + i)));
      }
      let at = from + rel;
      q0.extend(repl.iter().map(|&b| (b, Origin::Hit(hits.len()))));
      hits.push(ModelHit {
        pre: at,
        sep: false,
      });
      from = at + needle.len();
    }
    for (i, &b) in hay[from..].iter().enumerate() {
      q0.push((b, Origin::Gap(from + i)));
    }
    let n = q0.len();
    let mut to_lf = vec![false; n];
    let mut insert_after = vec![false; n];
    let mut junctions = 0;
    for i in 0..n {
      let (b, origin) = q0[i];
      let Origin::Gap(at) = origin else {
        continue;
      };
      let kept = b == b'\r' && hay.get(at + 1) != Some(&b'\n');
      if !(kept && i + 1 < n && q0[i + 1].0 == b'\n') {
        continue;
      }
      junctions += 1;
      if insert_sep == "\n" {
        let mut j = i;
        loop {
          to_lf[j] = true;
          if j == 0 || q0[j - 1].0 != b'\r' {
            break;
          }
          j -= 1;
        }
      } else {
        insert_after[i] = true;
        // The byte belongs to the hit that makes the `\n` follow the CR: the
        // one whose replacement starts with it, else the last hit before the
        // `\n` of the text between hits.
        let owner = match q0[i + 1].1 {
          Origin::Hit(h) => h,
          Origin::Gap(next) => hits.partition_point(|h| h.pre < next) - 1,
        };
        hits[owner].sep = true;
      }
    }
    let mut post = Vec::with_capacity(n);
    for i in 0..n {
      post.push(if to_lf[i] { b'\n' } else { q0[i].0 });
      if insert_after[i] {
        post.push(b'\n');
      }
    }
    ReplaceModel {
      post,
      hits,
      junctions,
    }
  }

  impl ReplaceModel {
    /// Where every pre offset `0..=pre_len` goes, and where every post offset
    /// goes back to. An offset at or before a hit's start does not count the
    /// hit; one inside it goes to the end of its output; one at its end counts
    /// it. The inserted `\n` is the first byte of its hit's output.
    fn maps(&self, pre_len: usize, m: usize, r: usize) -> (Vec<u64>, Vec<u64>) {
      let mut forward = vec![0u64; pre_len + 1];
      // (post start, output length) of every hit.
      let mut spans: Vec<(usize, usize)> = Vec::new();
      let (mut post, mut x, mut h) = (0usize, 0usize, 0usize);
      while x <= pre_len {
        if h < self.hits.len() && self.hits[h].pre == x {
          let out_len = r + usize::from(self.hits[h].sep);
          forward[x] = post as u64;
          for k in 1..m {
            forward[x + k] = (post + out_len) as u64;
          }
          spans.push((post, out_len));
          post += out_len;
          x += m;
          h += 1;
        } else {
          forward[x] = post as u64;
          post += 1;
          x += 1;
        }
      }
      let post_len = self.post.len();
      let mut inverse = vec![0u64; post_len + 1];
      let (mut y, mut p, mut h) = (0usize, 0usize, 0usize);
      while y <= post_len {
        // A hit with no output at this offset has been passed.
        while h < spans.len() && spans[h].0 == y && spans[h].1 == 0 {
          p += m;
          h += 1;
        }
        if h < spans.len() && spans[h].0 == y {
          inverse[y] = p as u64;
          for k in 1..spans[h].1 {
            inverse[y + k] = (p + m) as u64;
          }
          p += m;
          y += spans[h].1;
          h += 1;
        } else {
          inverse[y] = p as u64;
          p += 1;
          y += 1;
        }
      }
      (forward, inverse)
    }
  }
  /// A flat in-memory leftmost non-overlapping replace, with the junction
  /// rewrite of `insert_sep`.
  fn flat_replace(
    hay: &[u8],
    needle: &[u8],
    repl: &[u8],
    case: bool,
    insert_sep: &str,
  ) -> (Vec<u8>, u64) {
    let model = replace_model(hay, needle, repl, case, insert_sep);
    let count = model.hits.len() as u64;
    (model.post, count)
  }

  fn line_starts(flat: &[u8]) -> Vec<u64> {
    let mut starts = vec![0u64];
    for (i, &b) in flat.iter().enumerate() {
      if b == b'\n' {
        starts.push(i as u64 + 1);
      }
    }
    starts
  }
  /// The table equals `flat` in length, bytes, line count, every line start,
  /// the line of every (sampled) offset and a spread of line windows.
  fn assert_table_is(table: &Table, flat: &[u8]) {
    assert_table_matches(table, flat, &line_starts(flat));
  }
  /// `assert_table_is` for line starts `starts` given.
  fn assert_table_matches(table: &Table, flat: &[u8], starts: &[u64]) {
    assert_eq!(table.len(), flat.len() as u64, "len");
    let lines = if flat.is_empty() {
      0
    } else {
      starts.len() as u64
    };
    assert_eq!(table.line_count(), lines, "line_count");
    assert_eq!(table.read(0, table.len()).unwrap(), flat, "bytes");
    for line in 0..lines {
      assert_eq!(
        table.line_to_offset(line).unwrap(),
        starts[line as usize],
        "line_to_offset({line})"
      );
    }
    let step = (flat.len() / 3000).max(1);
    let mut off = 0usize;
    while off <= flat.len() {
      let want = starts.partition_point(|&s| s <= off as u64) as u64 - 1;
      assert_eq!(
        table.offset_to_line(off as u64).unwrap(),
        want,
        "offset_to_line({off})"
      );
      off += step;
    }
    let end = flat.len() as u64;
    assert_eq!(
      table.offset_to_line(end).unwrap(),
      starts.partition_point(|&s| s <= end) as u64 - 1
    );
    // Line windows, as `windowed_read` reads them.
    for (a, b) in [
      (0u64, 3u64),
      (1, 2),
      (2, 9),
      (lines.saturating_sub(4), lines),
      (0, lines),
    ] {
      let a = a.min(lines);
      let b = b.clamp(a, lines);
      let from = line_offset(table, a).unwrap();
      let to = line_offset(table, b).unwrap();
      assert_eq!(
        table.read(from, to).unwrap(),
        flat[from as usize..to as usize],
        "window {a}..{b}"
      );
    }
  }
  /// Every checkpoint of the table's index is at most `interval` bytes after the
  /// previous one, and so is the end.
  fn assert_segments_within(table: &Table, interval: u64) {
    let cks = table.index_checkpoints();
    for pair in cks.windows(2) {
      assert!(pair[1].0 - pair[0].0 <= interval, "segment {pair:?}");
    }
    assert!(
      table.len() - cks.last().unwrap().0 <= interval,
      "last segment"
    );
  }

  fn lcg_content(seed: u64, len: usize) -> Vec<u8> {
    let vocab: [&str; 9] = ["tok", "x", "a\nb", " ", "\n", "foo", "bar", "é", "tokx"];
    let mut state = seed;
    let mut out = String::new();
    while out.len() < len {
      state = state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
      out.push_str(vocab[((state >> 33) % vocab.len() as u64) as usize]);
    }
    out.into_bytes()
  }
  // --- search over the edited session ----------------------------------------

  fn all_hits(fx: &Fixture, q: &str, case: bool, chunk: usize) -> Vec<(u64, u64, String)> {
    all_hits_with_cols(fx, q, case, chunk)
      .into_iter()
      .map(|(offset, line, _, preview)| (offset, line, preview))
      .collect()
  }

  fn all_hits_with_cols(
    fx: &Fixture,
    q: &str,
    case: bool,
    chunk: usize,
  ) -> Vec<(u64, u64, u64, String)> {
    let mut hits = Vec::new();
    let cancel = AtomicBool::new(false);
    let end = search_core(
      &fx.state,
      ID,
      q,
      case,
      u32::MAX,
      &cancel,
      chunk,
      &mut |h| hits.push((h.offset, h.line, h.col, h.preview)),
      &mut |_| {},
    );
    assert!(
      matches!(
        end,
        SearchEnd::Done {
          truncated: false,
          ..
        }
      ),
      "{end:?}"
    );
    hits
  }

  fn flat_hits(hay: &[u8], q: &str, case: bool) -> Vec<(u64, u64)> {
    let starts = line_starts(hay);
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = find_sub(&hay[from..], q.as_bytes(), case) {
      let off = (from + rel) as u64;
      out.push((off, starts.partition_point(|&s| s <= off) as u64 - 1));
      from += rel + q.len();
    }
    out
  }

  fn offsets_and_lines(hits: &[(u64, u64, String)]) -> Vec<(u64, u64)> {
    hits.iter().map(|h| (h.0, h.1)).collect()
  }

  #[test]
  fn search_finds_hits_across_chunk_boundaries() {
    let content =
      b"needle at the start, a needle\nin the middle, and needle needleneedle\nend needle";
    let fx = fixture(content);
    let want = flat_hits(content, "needle", true);
    assert!(want.len() >= 6);
    for chunk in 1..=content.len() + 2 {
      assert_eq!(
        offsets_and_lines(&all_hits(&fx, "needle", true, chunk)),
        want,
        "chunk {chunk}"
      );
    }
  }

  #[test]
  fn search_finds_hits_across_a_piece_boundary() {
    let fx = fixture(b"hello wor");
    // The added text continues the original, so "world" spans two pieces.
    fx.edit(vec![ed(9, 9, "ld there")], true);
    assert_eq!(fx.whole(), b"hello world there");
    for chunk in 1..=20 {
      assert_eq!(
        offsets_and_lines(&all_hits(&fx, "world", true, chunk)),
        vec![(6, 0)],
        "chunk {chunk}"
      );
    }
    // And one spanning an added piece, an original piece and another added one.
    fx.edit(vec![ed(0, 0, "AB")], true);
    fx.edit(vec![ed(11, 11, "CD")], true);
    let whole = fx.whole();
    let want = flat_hits(&whole, "ABhello", true);
    assert_eq!(want.len(), 1);
    assert_eq!(offsets_and_lines(&all_hits(&fx, "ABhello", true, 3)), want);
  }

  #[test]
  fn search_finds_hits_inside_inserted_text_and_not_inside_deleted_text() {
    let fx = fixture(b"xx needle yy needle zz\nsecond line\n");
    // Inserted text is searched; the file on disk has none of it.
    fx.edit(vec![ed(12, 12, "[NEEDLE inserted]")], true);
    let whole = fx.whole();
    let want = flat_hits(&whole, "needle", false);
    assert_eq!(want.len(), 3);
    assert_eq!(offsets_and_lines(&all_hits(&fx, "needle", false, 5)), want);
    // Deleted text is not.
    fx.edit(vec![ed(3, 9, "")], true);
    let whole = fx.whole();
    assert!(!String::from_utf8_lossy(&whole).contains("xx needle"));
    let want = flat_hits(&whole, "needle", false);
    assert_eq!(offsets_and_lines(&all_hits(&fx, "needle", false, 4)), want);
    // A hit that would only exist across the deleted gap is not invented.
    let fx = fixture(b"nee--dle and needle");
    fx.edit(vec![ed(3, 5, "")], true);
    assert_eq!(fx.whole(), b"needle and needle");
    assert_eq!(all_hits(&fx, "needle", true, 3).len(), 2);
    let fx = fixture(b"nee--XXdle");
    fx.edit(vec![ed(3, 5, "")], true);
    assert!(all_hits(&fx, "needle", true, 3).is_empty());
  }

  #[test]
  fn search_is_case_insensitive_when_asked() {
    let content = b"Foo foo FOO\nfOo";
    let fx = fixture(content);
    assert_eq!(all_hits(&fx, "foo", true, 4).len(), 1);
    let hits = all_hits(&fx, "foo", false, 4);
    assert_eq!(
      offsets_and_lines(&hits),
      vec![(0, 0), (4, 0), (8, 0), (12, 1)]
    );
    assert_eq!(hits[3].2, "fOo");
  }

  #[test]
  fn search_reports_lines_for_needles_with_newlines_and_caps_results() {
    let content = b"a\nb a\nb\nxa\nb";
    let fx = fixture(content);
    assert_eq!(
      offsets_and_lines(&all_hits(&fx, "a\nb", true, 2)),
      flat_hits(content, "a\nb", true)
    );
    let cancel = AtomicBool::new(false);
    let mut got = 0;
    let end = search_core(
      &fx.state,
      ID,
      "a",
      true,
      2,
      &cancel,
      3,
      &mut |_| got += 1,
      &mut |_| {},
    );
    assert_eq!(
      end,
      SearchEnd::Done {
        hits: 2,
        truncated: true
      }
    );
    assert_eq!(got, 2);
  }

  #[test]
  fn search_reports_utf16_columns_across_chunk_boundaries() {
    // The emoji is four bytes and two UTF-16 units; "é" two bytes and one.
    let content = "😀é needle\nab 😀😀 needle é\r\nneedle\nx".as_bytes();
    let fx = fixture(content);
    let want = vec![(0u64, 4u64), (1, 8), (2, 0)];
    for chunk in 1..=content.len() + 2 {
      let got: Vec<(u64, u64)> = all_hits_with_cols(&fx, "needle", true, chunk)
        .iter()
        .map(|h| (h.1, h.2))
        .collect();
      assert_eq!(got, want, "chunk {chunk}");
    }
    // A needle with a newline restarts the column after it.
    let fx = fixture(b"ab\ncd ab\ncd ab\ncd");
    let cols: Vec<u64> = all_hits_with_cols(&fx, "ab\ncd", true, 3)
      .iter()
      .map(|h| h.2)
      .collect();
    assert_eq!(cols, vec![0, 3, 3]);
  }

  #[test]
  fn search_can_be_cancelled_and_reports_unknown_sessions() {
    let fx = fixture(b"aaaa aaaa aaaa");
    let cancel = AtomicBool::new(true);
    let end = search_core(
      &fx.state,
      ID,
      "a",
      true,
      10,
      &cancel,
      3,
      &mut |_| {},
      &mut |_| {},
    );
    assert_eq!(end, SearchEnd::Cancelled);
    let cancel = AtomicBool::new(false);
    let end = search_core(
      &fx.state,
      99,
      "a",
      true,
      10,
      &cancel,
      3,
      &mut |_| {},
      &mut |_| {},
    );
    assert_eq!(end, SearchEnd::Failed);
  }

  fn find(
    fx: &Fixture,
    q: &str,
    case: bool,
    line: u64,
    col: u64,
    backward: bool,
  ) -> Option<FindHit> {
    find_core(&fx.state, ID, q, case, line, col, backward, 4, &mut |_| {}).unwrap()
  }

  #[test]
  fn find_next_and_previous_wrap_and_report_positions() {
    // "one" at bytes 0, 8, 16 on line 0 and 27 on line 1.
    let content = b"one two one two one\nsecond one line\n";
    let fx = fixture(content);
    let hit = find(&fx, "one", true, 0, 0, false).unwrap();
    assert_eq!((hit.start_offset, hit.end_offset), (0, 3));
    assert_eq!(hit.start, Pos { line: 0, col: 0 });
    assert_eq!(hit.end, Pos { line: 0, col: 3 });
    // From the end of that hit: the next one.
    let hit = find(&fx, "one", true, 0, 3, false).unwrap();
    assert_eq!(hit.start_offset, 8);
    // From the last hit's end: wraps to the first.
    let hit = find(&fx, "one", true, 1, 10, false).unwrap();
    assert_eq!(hit.start_offset, 0);
    let hit = find(&fx, "one", true, 1, 7, false).unwrap();
    assert_eq!((hit.start.line, hit.start.col), (1, 7));
    // Backward: the nearest hit that ends before the position.
    let hit = find(&fx, "one", true, 1, 0, true).unwrap();
    assert_eq!(hit.start_offset, 16);
    let hit = find(&fx, "one", true, 0, 8, true).unwrap();
    assert_eq!(hit.start_offset, 0);
    // Backward from before the first one wraps to the last.
    let hit = find(&fx, "one", true, 0, 0, true).unwrap();
    assert_eq!((hit.start.line, hit.start.col), (1, 7));
    assert!(find(&fx, "absent", true, 0, 0, false).is_none());
    assert!(find(&fx, "absent", true, 0, 0, true).is_none());
    assert!(find(&fx, "ONE", true, 0, 0, false).is_none());
    assert!(find(&fx, "ONE", false, 0, 0, false).is_some());
  }

  #[test]
  fn a_lone_hit_is_found_again_from_itself() {
    let fx = fixture(b"abc needle def");
    let hit = find(&fx, "needle", true, 0, 10, false).unwrap();
    assert_eq!(hit.start_offset, 4);
    let hit = find(&fx, "needle", true, 0, 4, true).unwrap();
    assert_eq!(hit.start_offset, 4);
  }

  #[test]
  fn find_columns_count_utf16_units_and_skip_the_line_break() {
    // The emoji is 4 bytes and 2 UTF-16 units.
    let fx = fixture("😀a needle\r\nzz needle\r\n".as_bytes());
    let hit = find(&fx, "needle", true, 0, 0, false).unwrap();
    assert_eq!(hit.start, Pos { line: 0, col: 4 });
    assert_eq!(hit.end, Pos { line: 0, col: 10 });
    assert_eq!(hit.start_offset, 6);
    // A column past the end of the line (CodeMirror's line has no \r\n) lands
    // at the end of the line, not inside the break.
    let hit = find(&fx, "needle", true, 0, 999, false).unwrap();
    assert_eq!(hit.start, Pos { line: 1, col: 3 });
    let hit = find(&fx, "needle", true, 1, 3, false).unwrap();
    assert_eq!(hit.start, Pos { line: 1, col: 3 });
    let hit = find(&fx, "needle", true, 1, 4, false).unwrap();
    assert_eq!(hit.start, Pos { line: 0, col: 4 });
  }

  #[test]
  fn find_sees_edits_and_pieces() {
    let fx = fixture(b"line one\nline two\n");
    fx.edit(vec![ed(5, 8, "needle")], true);
    let hit = find(&fx, "needle", true, 0, 0, false).unwrap();
    assert_eq!((hit.start.line, hit.start.col), (0, 5));
  }

  #[test]
  fn an_edit_mid_scan_makes_a_results_search_stale() {
    let mut content = vec![b'.'; 40];
    content.extend_from_slice(b"needle");
    content.extend(vec![b'.'; 40]);
    let fx = fixture(&content);
    let cancel = AtomicBool::new(false);
    let mut hits = Vec::new();
    let mut edited = false;
    let end = search_core(
      &fx.state,
      ID,
      "needle",
      true,
      100,
      &cancel,
      8,
      &mut |h| hits.push(h.offset),
      &mut |chunk| {
        if chunk == 2 && !edited {
          edited = true;
          fx.edit(vec![ed(0, 0, "ZZZZ")], true);
        }
      },
    );
    assert_eq!(end, SearchEnd::Stale);
    assert!(hits.is_empty(), "no hit from the old generation: {hits:?}");
  }

  #[test]
  fn an_edit_mid_scan_restarts_a_find_on_the_new_content() {
    let mut content = vec![b'.'; 40];
    content.extend_from_slice(b"needle");
    content.extend(vec![b'.'; 40]);
    let fx = fixture(&content);
    let mut edited = false;
    let hit = find_core(
      &fx.state,
      ID,
      "needle",
      true,
      0,
      0,
      false,
      8,
      &mut |chunk| {
        if chunk == 2 && !edited {
          edited = true;
          fx.edit(vec![ed(0, 0, "ZZZZ")], true);
        }
      },
    )
    .unwrap()
    .unwrap();
    assert_eq!(
      hit.start_offset, 44,
      "offsets of the new content, not the old"
    );
    assert_eq!(&fx.whole()[44..50], b"needle");
  }

  #[test]
  fn a_find_that_keeps_going_stale_gives_up() {
    let fx = fixture(&[b'.'; 64]);
    let r = find_core(&fx.state, ID, "x", true, 0, 0, false, 8, &mut |chunk| {
      if chunk == 1 {
        fx.edit(vec![ed(0, 0, "y")], true);
      }
    });
    assert_eq!(r.unwrap_err(), "stale");
  }
  // --- replace all -----------------------------------------------------------

  fn big_doc(rows: usize, hit_every: usize) -> Vec<u8> {
    let mut s = String::with_capacity(rows * 24);
    for i in 0..rows {
      if i % hit_every == 0 {
        s.push_str(&format!("row {i:06} tok payload\n"));
      } else {
        s.push_str(&format!("row {i:06} xxx payload\n"));
      }
    }
    s.into_bytes()
  }

  fn within(limit: Duration, what: &str, f: impl FnOnce()) {
    let t = Instant::now();
    f();
    assert!(t.elapsed() < limit, "{what} took {:?}", t.elapsed());
  }

  #[test]
  fn replace_all_of_100k_hits_then_undo_and_redo_are_exact_and_fast() {
    let original = big_doc(100_000, 1);
    let fx = fixture(&original);
    let (replaced, count) = flat_replace(&original, b"tok", b"TOKEN_LONGER", true, "\n");
    assert_eq!(count, 100_000);
    within(Duration::from_secs(10), "replace all", || {
      let out = fx.replace("tok", "TOKEN_LONGER");
      assert_eq!(out.count, 100_000);
      assert_eq!(out.total_bytes, replaced.len() as u64);
      assert_eq!(fx.whole(), replaced);
    });
    fx.with(|s| assert_eq!(s.table.line_count(), 100_001));
    within(Duration::from_secs(10), "undo", || {
      let r = fx.undo();
      assert!(r.reload_only && r.edits.is_empty());
      assert_eq!(r.first_line, 0);
      assert_eq!(fx.whole(), original);
    });
    within(Duration::from_secs(10), "redo", || {
      let r = fx.redo();
      assert!(r.reload_only && r.edits.is_empty());
      assert_eq!(fx.whole(), replaced);
    });
    // Windows read through the layer.
    fx.with(|s| {
      let a = line_offset(&s.table, 77_000).unwrap();
      let b = line_offset(&s.table, 77_010).unwrap();
      assert_eq!(
        s.table.read(a, b).unwrap(),
        replaced[a as usize..b as usize]
      );
    });
  }

  #[test]
  fn memory_after_replace_all_does_not_follow_the_hit_count() {
    let units = |fx: &Fixture| {
      fx.with(|s| {
        assert_eq!(
          s.table.piece_count(),
          1,
          "one piece over the layer, not one per hit"
        );
        assert_eq!(layer_depth(&s.table), 1);
        assert_eq!(s.table.add_len(), 0);
        resident_units(&s.table)
      })
    };
    let few = fixture(&big_doc(100_000, 100));
    let many = fixture(&big_doc(100_000, 1));
    assert_eq!(few.whole().len(), many.whole().len());
    let a = few.replace("tok", "TOK");
    assert_eq!(a.count, 1_000);
    let few_units = units(&few);
    let b = many.replace("tok", "TOK");
    assert_eq!(b.count, 100_000);
    let many_units = units(&many);
    assert!(
      few_units.abs_diff(many_units) <= 2,
      "{few_units} units for 10^3 hits, {many_units} for 10^5"
    );
    // Checkpoints are one per MiB, not one per hit.
    assert!(many_units < 40, "{many_units}");
    // The change list is the part that grows with the hits.
    let size = |fx: &Fixture| fs::metadata(&fx.live_lists()[0]).unwrap().len();
    assert!(size(&many) > 50 * size(&few));
  }

  #[test]
  fn replace_all_is_one_step_and_a_typing_edit_after_it_opens_a_new_group() {
    let fx = fixture(b"a tok b tok\nc\n");
    assert_eq!(fx.replace("tok", "X").count, 2);
    fx.edit(vec![ed(0, 0, "Q")], false);
    fx.with(|s| {
      assert_eq!(
        s.undo_stack.len(),
        2,
        "the edit did not coalesce into the replace-all"
      );
      assert!(matches!(s.undo_stack[0].entry, JournalEntry::Replace(_)));
      assert!(matches!(s.undo_stack[1].entry, JournalEntry::Edits(_)));
    });
    let r = fx.undo();
    assert!(!r.reload_only);
    assert_eq!(fx.whole(), b"a X b X\nc\n");
    let r = fx.undo();
    assert!(r.reload_only);
    assert_eq!(fx.whole(), b"a tok b tok\nc\n");
    assert_eq!(fx.redo().edits.len(), 0);
    assert_eq!(fx.whole(), b"a X b X\nc\n");
    assert_eq!(fx.redo().edits.len(), 1);
    assert_eq!(fx.whole(), b"Qa X b X\nc\n");
  }

  #[test]
  fn replace_all_is_dirty_and_its_undo_and_redo_follow_the_clean_flag() {
    let fx = fixture(b"a tok b tok\nc\n");
    let out = fx.replace("tok", "X");
    assert!(!out.clean);
    assert!(out.generation > 0);
    assert!(fx.undo().clean);
    assert!(!fx.redo().clean);
    fx.save();
    assert!(fx.with(|s| s.clean()));
    assert!(!fx.undo().clean);
    assert!(fx.redo().clean);
    // A replace with no hit leaves the flag and the generation where they were.
    let generation = fx.with(|s| s.generation);
    let none = fx.replace("nothing", "X");
    assert!(none.clean);
    assert_eq!(none.generation, generation);
  }

  #[test]
  fn replace_all_with_no_hits_changes_nothing() {
    let fx = fixture(b"nothing here\n");
    let out = fx.replace("tok", "X");
    assert_eq!((out.count, out.total_bytes), (0, 13));
    fx.with(|s| {
      assert!(s.undo_stack.is_empty());
      assert_eq!(s.generation, 0);
    });
    assert_eq!(fx.change_lists_on_disk(), 0);
    let err = replace_all_core(
      &fx.state,
      &fx.tmp,
      ID,
      "",
      true,
      "x",
      "\n",
      8,
      100,
      &mut |_| {},
    );
    assert_eq!(err.unwrap_err(), "empty-query");
  }

  #[test]
  fn replace_all_then_typing_edits_then_undo_all_restores_the_original() {
    let original = big_doc(2_000, 3);
    let fx = fixture(&original);
    fx.replace("tok", "TOKEN");
    fx.edit(vec![ed(5, 5, "first")], true);
    fx.edit(vec![ed(50, 60, "")], true);
    fx.edit(vec![ed(100, 100, "tok\n")], true);
    for _ in 0..3 {
      assert!(!fx.undo().reload_only);
    }
    let (replaced, _) = flat_replace(&original, b"tok", b"TOKEN", true, "\n");
    assert_eq!(fx.whole(), replaced);
    assert!(fx.undo().reload_only);
    assert_eq!(fx.whole(), original);
  }

  fn assert_save_roundtrip(fx: &Fixture, original: &[u8]) {
    let (replaced, _) = flat_replace(original, b"tok", b"TOKEN-LONG", true, "\n");
    fx.replace("tok", "TOKEN-LONG");
    assert_eq!(fx.whole(), replaced);
    fx.save();
    assert_eq!(
      fs::read(&fx.path).unwrap(),
      replaced,
      "the saved file is the replaced content"
    );
    assert_eq!(fx.whole(), replaced);
    assert!(fx.live_lists().is_empty(), "a save flattens the layers");
    fx.undo();
    assert_eq!(fx.whole(), original, "undo after a save");
    fx.with(|s| assert_table_is(&s.table, original));
    fx.save();
    assert_eq!(fs::read(&fx.path).unwrap(), original);
    fx.redo();
    assert_eq!(fx.whole(), replaced, "redo after a save");
    fx.with(|s| assert_table_is(&s.table, &replaced));
    fx.save();
    assert_eq!(fs::read(&fx.path).unwrap(), replaced);
    fx.undo();
    assert_eq!(fx.whole(), original);
  }

  #[test]
  fn replace_all_save_undo_redo_by_rename() {
    let original = big_doc(3_000, 2);
    let fx = fixture(&original);
    assert_save_roundtrip(&fx, &original);
  }

  #[test]
  fn replace_all_save_undo_redo_by_pouring_in_place() {
    let original = big_doc(3_000, 2);
    let fx = fixture(&original);
    let other = fx.dir.path().join("other-name.txt");
    fs::hard_link(&fx.path, &other).unwrap();
    assert_eq!(crate::fs_ops::linktest::links(&fx.path), 2);
    assert_save_roundtrip(&fx, &original);
    // The write went into the shared file: both names saw every step.
    assert_eq!(crate::fs_ops::linktest::links(&fx.path), 2);
    assert_eq!(
      fs::read(&other).unwrap(),
      flat_replace(&original, b"tok", b"TOKEN-LONG", true, "\n").0
    );
  }

  #[test]
  fn stacked_replace_alls_undo_to_the_original_and_read_exactly() {
    let original = lcg_content(7, 6_000);
    let fx = fixture(&original);
    let steps: [(&str, &str); 3] = [("tok", "tokentoken"), ("entok", "E\nE"), ("E", "")];
    let mut flats = vec![original.clone()];
    for (q, r) in steps {
      let (next, _) = flat_replace(
        flats.last().unwrap(),
        q.as_bytes(),
        r.as_bytes(),
        true,
        "\n",
      );
      assert_ne!(&next, flats.last().unwrap());
      flats.push(next);
      fx.replace_with(q, true, r, 13, 200);
      fx.with(|s| assert_table_is(&s.table, flats.last().unwrap()));
    }
    fx.with(|s| assert_eq!(layer_depth(&s.table), 3));
    // Window reads through three layers, as the editor makes them.
    fx.with(|s| {
      let lines = s.table.line_count();
      let flat = flats.last().unwrap();
      let starts = line_starts(flat);
      for (a, b) in [(0, 20), (lines / 2, lines / 2 + 30), (lines - 7, lines)] {
        let from = line_offset(&s.table, a).unwrap();
        let to = line_offset(&s.table, b).unwrap();
        assert_eq!(from, starts[a as usize]);
        assert_eq!(
          s.table.read(from, to).unwrap(),
          flat[from as usize..to as usize]
        );
      }
    });
    for want in flats.iter().rev().skip(1) {
      assert!(fx.undo().reload_only);
      fx.with(|s| assert_table_is(&s.table, want));
    }
    for want in flats.iter().skip(1) {
      assert!(fx.redo().reload_only);
      fx.with(|s| assert_table_is(&s.table, want));
    }
    // Undo again after a save puts inverse layers over the saved file.
    fx.save();
    for want in flats.iter().rev().skip(1) {
      fx.undo();
      fx.with(|s| assert_table_is(&s.table, want));
    }
  }

  #[test]
  fn self_overlapping_needles_replace_like_a_flat_replace_at_every_alignment() {
    let docs: [&[u8]; 3] = [
      b"aaaaaaaaaaaaaaaaaaaaaaa bab aaa\naaaa a aa",
      b"abababababab xabababx ababab\nabab abab ab",
      b"aabaabaab aaa aaaa aaaaa b\naa",
    ];
    for content in docs {
      for needle in ["aa", "abab", "aab", "a"] {
        let (want, count) = flat_replace(content, needle.as_bytes(), b"Z", true, "\n");
        for chunk in 1..=content.len() + 2 {
          let fx = fixture(content);
          let out = fx.replace_with(needle, true, "Z", chunk, 1 << 20);
          assert_eq!(out.count, count, "needle {needle} chunk {chunk}");
          assert_eq!(fx.whole(), want, "needle {needle} chunk {chunk}");
          // The results list reports the same hits.
          assert_eq!(
            all_hits(&fixture(content), needle, true, chunk).len() as u64,
            count,
            "needle {needle} chunk {chunk}"
          );
        }
      }
    }
  }

  #[test]
  fn growing_shrinking_and_multiline_replacements_match_a_flat_replace() {
    let long = "0123456789".repeat(7);
    let needles = ["tok", "x", "a\nb", "é"];
    let repls = ["", "T", "tok", long.as_str(), "p\nq\nr", "é\n"];
    for (n, needle) in needles.iter().enumerate() {
      for (r, repl) in repls.iter().enumerate() {
        let original = lcg_content((n * 10 + r) as u64 + 1, 2_500);
        let (replaced, count) =
          flat_replace(&original, needle.as_bytes(), repl.as_bytes(), true, "\n");
        assert!(count > 3, "{needle:?} has few hits");
        let fx = fixture(&original);
        let interval = 100;
        let out = fx.replace_with(needle, true, repl, 7, interval);
        assert_eq!(out.count, count);
        fx.with(|s| {
          assert_table_is(&s.table, &replaced);
          assert_segments_within(&s.table, interval);
        });
        // The inverse layer after a save, over the saved file.
        fx.save();
        fx.undo();
        fx.with(|s| {
          assert_table_is(&s.table, &original);
          assert_eq!(layer_depth(&s.table), 1);
          assert_segments_within(&s.table, interval);
        });
        fx.redo();
        fx.with(|s| {
          assert_table_is(&s.table, &replaced);
          assert_segments_within(&s.table, interval);
        });
        // Three stacked layers on top of that.
        let mut flat = replaced.clone();
        for (q, rr) in [("tok", "TT"), ("o", "oo\n"), ("é", "")] {
          let (next, _) = flat_replace(&flat, q.as_bytes(), rr.as_bytes(), true, "\n");
          fx.replace_with(q, true, rr, 11, interval);
          flat = next;
          fx.with(|s| {
            assert_table_is(&s.table, &flat);
            assert_segments_within(&s.table, interval);
          });
        }
      }
    }
  }

  #[test]
  fn replace_all_is_case_insensitive_when_asked() {
    let fx = fixture(b"Tok tok TOK tOk\n");
    assert_eq!(fx.replace_with("tok", false, "x", 5, 100).count, 4);
    assert_eq!(fx.whole(), b"x x x x\n");
    let fx = fixture(b"Tok tok TOK tOk\n");
    assert_eq!(fx.replace_with("tok", true, "x", 5, 100).count, 1);
    assert_eq!(fx.whole(), b"Tok x TOK tOk\n");
  }
  // --- the change list's life ------------------------------------------------

  #[test]
  fn the_session_index_stays_the_on_disk_files_through_replace_undo_and_redo() {
    let original = big_doc(100_000, 1);
    let fx = fixture(&original);
    let (index, fingerprint, digest) =
      fx.with(|s| (s.index.clone(), s.fingerprint.clone(), s.digest));
    assert!(index.checkpoints.len() >= 3);
    let check = |fx: &Fixture| {
      let (idx, fp, dg) = fx.with(|s| (s.index.clone(), s.fingerprint.clone(), s.digest));
      assert_eq!(idx, index);
      assert_eq!(fp, fingerprint);
      assert_eq!(dg, digest);
      assert_eq!(fingerprint_of(&fx.path).unwrap(), fp);
      // What a restore does with it rebuilds the on-disk content exactly.
      let next_id = AtomicU64::new(50);
      let (_, reopened, result) =
        reopen_session(&next_id, fx.path.clone(), idx, fp, Some(dg)).unwrap();
      assert!(!result.rescanned);
      assert_eq!(
        reopened.table.read(0, reopened.table.len()).unwrap(),
        original
      );
    };
    check(&fx);
    fx.replace("tok", "TOKEN");
    check(&fx);
    fx.undo();
    check(&fx);
    fx.redo();
    check(&fx);
  }

  #[test]
  fn a_change_list_outlives_its_journal_entry_while_a_layer_reads_it() {
    let original = lcg_content(3, 4_000);
    let fx = fixture(&original);
    let (replaced, _) = flat_replace(&original, b"tok", b"TT", true, "\n");
    let token = fx.replace("tok", "TT").token.unwrap();
    let lists = fx.live_lists();
    assert_eq!(lists.len(), 1);
    // More edit groups than the journal keeps push the replace-all out of it.
    for i in 0..=UNDO_LIMIT {
      fx.edit(vec![ed(0, 0, "e")], true);
      assert!(i < 10_000);
    }
    fx.with(|s| {
      assert_eq!(s.undo_stack.len(), UNDO_LIMIT);
      assert!(s
        .undo_stack
        .iter()
        .all(|e| matches!(e.entry, JournalEntry::Edits(_))));
    });
    release_replace_core(&fx.state, ID, token);
    assert!(lists[0].exists(), "the layer still reads it");
    let mut want = vec![b'e'; UNDO_LIMIT + 1];
    want.extend_from_slice(&replaced);
    assert_eq!(fx.whole(), want);
    fx.with(|s| assert_table_is(&s.table, &want));
    fx.save();
    assert!(!lists[0].exists(), "a save flattens it away");
    assert_eq!(fs::read(&fx.path).unwrap(), want);
  }

  #[test]
  fn replace_save_undo_then_a_fresh_edit_keeps_the_file_until_the_next_save_or_close() {
    let original = lcg_content(5, 4_000);
    let fx = fixture(&original);
    let (replaced, _) = flat_replace(&original, b"tok", b"TT", true, "\n");
    let forward = fx.replace("tok", "TT").token.unwrap();
    let first = fx.live_lists()[0].clone();
    fx.save();
    assert!(first.exists(), "the journal entry still refers to it");
    assert!(fx.live_lists().is_empty(), "but no layer reads it any more");
    let back = fx.undo().token.unwrap();
    let lists = fx.live_lists();
    assert_eq!(
      lists.len(),
      1,
      "the inverse layer reads the same change list"
    );
    assert_eq!(lists[0], first.clone());
    assert!(first.exists());
    fx.edit(vec![ed(0, 0, "fresh")], true);
    fx.with(|s| assert!(s.redo_stack.is_empty()));
    let mut want = original.clone();
    want.splice(0..0, b"fresh".iter().copied());
    assert_eq!(fx.whole(), want);
    fx.with(|s| assert_table_is(&s.table, &want));
    assert!(
      first.exists(),
      "the live layer holds it after the redo entry is gone"
    );
    release_replace_core(&fx.state, ID, forward);
    release_replace_core(&fx.state, ID, back);
    fx.save();
    assert!(!first.exists());
    assert_eq!(fs::read(&fx.path).unwrap(), want);
    let _ = replaced;
    // Closing deletes every change list and never the user's file.
    let fx = fixture(&original);
    fx.replace("tok", "TT");
    fx.replace("foo", "FOOO");
    assert_eq!(fx.change_lists_on_disk(), 2);
    close_core(&fx.state, ID);
    assert_eq!(fx.change_lists_on_disk(), 0);
    assert_eq!(fs::read(&fx.path).unwrap(), original);
    assert!(fx.state.sessions.lock().unwrap().is_empty());
  }

  #[test]
  fn a_failed_pass_leaves_the_content_and_no_file_behind() {
    let fx = fixture(&lcg_content(9, 3_000));
    let before = fx.whole();
    let r = replace_all_core(
      &fx.state,
      &fx.tmp,
      ID,
      "tok",
      true,
      "T",
      "\n",
      8,
      100,
      &mut |chunk| {
        if chunk == 3 {
          fx.edit(vec![ed(0, 0, "sneaked in")], true);
        }
      },
    );
    assert!(r.unwrap_err().contains("changed during the pass"));
    assert_eq!(fx.change_lists_on_disk(), 0);
    fx.with(|s| {
      assert!(!s.busy, "the session is released");
      assert!(s.undo_stack.len() == 1);
    });
    let mut want = b"sneaked in".to_vec();
    want.extend_from_slice(&before);
    assert_eq!(fx.whole(), want);
  }
  // --- save and close wait for a running pass ---------------------------------
  /// Run a replace-all of "tok" with the pass paused after its first chunk, run
  /// `other` meanwhile, and say whether `other` had already finished by the time
  /// the pass resumed.
  fn while_a_pass_is_paused<R: Send>(
    fx: &Fixture,
    other: impl FnOnce(&Fixture) -> R + Send,
  ) -> (R, bool) {
    let (paused_tx, paused_rx) = mpsc::channel::<()>();
    let (resume_tx, resume_rx) = mpsc::channel::<()>();
    let finished = AtomicBool::new(false);
    std::thread::scope(|scope| {
      let pass = scope.spawn(move || {
        let mut hook = |chunk: usize| {
          if chunk == 1 {
            paused_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
          }
        };
        replace_all_core(
          &fx.state, &fx.tmp, ID, "tok", true, "TOKEN", "\n", 16, 100, &mut hook,
        )
      });
      paused_rx.recv().unwrap();
      let finished = &finished;
      let waiter = scope.spawn(move || {
        let r = other(fx);
        finished.store(true, Ordering::SeqCst);
        r
      });
      std::thread::sleep(Duration::from_millis(300));
      let early = finished.load(Ordering::SeqCst);
      resume_tx.send(()).unwrap();
      pass.join().unwrap().unwrap();
      (waiter.join().unwrap(), early)
    })
  }

  fn fingerprint_of_session(fx: &Fixture) -> Fingerprint {
    fx.with(|s| s.fingerprint.clone())
  }

  #[test]
  fn a_save_after_set_path_writes_the_new_path_and_leaves_no_file_at_the_old_one() {
    let fx = fixture(b"one\ntwo\n");
    let moved = fx.dir.path().join("renamed.txt");
    fs::rename(&fx.path, &moved).unwrap();
    set_path_core(&fx.state, ID, moved.clone()).unwrap();
    fx.edit(vec![ed(0, 3, "ONE")], true);
    save_core(&fx.state, ID, None, None).unwrap();
    assert_eq!(fs::read(&moved).unwrap(), b"ONE\ntwo\n");
    assert!(!fx.path.exists(), "the old path must not come back");
    assert_eq!(fx.with(|s| s.path.clone()), moved);
  }

  #[test]
  fn the_conflict_check_after_set_path_reads_the_fingerprint_of_the_new_path() {
    let fx = fixture(b"one\ntwo\n");
    let before = fingerprint_of_session(&fx);
    let moved = fx.dir.path().join("renamed.txt");
    fs::rename(&fx.path, &moved).unwrap();
    // Still aimed at the old path, the file looks gone and the save is refused.
    let refused = save_core(&fx.state, ID, Some(before.clone()), None).unwrap_err();
    assert_eq!(refused, FINGERPRINT_MISMATCH);
    set_path_core(&fx.state, ID, moved.clone()).unwrap();
    fx.edit(vec![ed(0, 3, "ONE")], true);
    save_core(&fx.state, ID, Some(before), None).unwrap();
    assert_eq!(fs::read(&moved).unwrap(), b"ONE\ntwo\n");
    assert!(!fx.path.exists());
  }

  #[test]
  fn set_path_on_an_unknown_session_is_refused() {
    let fx = fixture(b"x");
    assert_eq!(
      set_path_core(&fx.state, ID + 1, fx.path.clone()).unwrap_err(),
      UNKNOWN_SESSION
    );
  }

  fn tok_doc() -> Vec<u8> {
    "tok one\ntwo tok\nthree\nfour tok tok\nfive\n"
      .repeat(8)
      .into_bytes()
  }

  #[test]
  fn a_save_waits_for_a_running_pass_by_rename() {
    let original = tok_doc();
    let fx = fixture(&original);
    let (saved, early) = while_a_pass_is_paused(&fx, |fx| save_core(&fx.state, ID, None, None));
    assert!(!early, "the save must wait for the pass");
    saved.unwrap();
    let (replaced, _) = flat_replace(&original, b"tok", b"TOKEN", true, "\n");
    assert_eq!(fs::read(&fx.path).unwrap(), replaced);
    assert_eq!(fx.whole(), replaced);
  }

  #[test]
  fn a_save_waits_for_a_running_pass_by_pouring_in_place() {
    let original = tok_doc();
    let fx = fixture(&original);
    fs::hard_link(&fx.path, fx.dir.path().join("link.txt")).unwrap();
    let (saved, early) = while_a_pass_is_paused(&fx, |fx| save_core(&fx.state, ID, None, None));
    assert!(!early, "the save must wait for the pass");
    saved.unwrap();
    let (replaced, _) = flat_replace(&original, b"tok", b"TOKEN", true, "\n");
    assert_eq!(fs::read(&fx.path).unwrap(), replaced);
    assert_eq!(crate::fs_ops::linktest::links(&fx.path), 2);
    assert_eq!(fx.whole(), replaced);
  }

  #[test]
  fn a_close_waits_for_a_running_pass_and_leaves_no_change_list() {
    let original = tok_doc();
    let fx = fixture(&original);
    let ((), early) = while_a_pass_is_paused(&fx, |fx| close_core(&fx.state, ID));
    assert!(!early, "the close must wait for the pass");
    assert!(fx.state.sessions.lock().unwrap().is_empty());
    assert_eq!(fx.change_lists_on_disk(), 0);
    assert_eq!(
      fs::read(&fx.path).unwrap(),
      original,
      "the user's file is untouched"
    );
  }

  #[test]
  fn read_apply_undo_and_redo_wait_for_a_running_pass() {
    let original = tok_doc();
    let fx = fixture(&original);
    let (_, early) = while_a_pass_is_paused(&fx, |fx| {
      let map = fx.state.lock_idle(ID).unwrap();
      let s = map.get(&ID).unwrap();
      // By the time the session is handed out the replace has been installed.
      assert_eq!(s.undo_stack.len(), 1);
    });
    assert!(!early, "a read must wait for the pass");
  }

  #[test]
  fn the_busy_guard_clears_the_flag_even_when_the_pass_fails() {
    let fx = fixture(&tok_doc());
    let r = replace_all_core(
      &fx.state,
      Path::new("/nonexistent-root-for-test/\0/windowed-tmp"),
      ID,
      "tok",
      true,
      "x",
      "\n",
      8,
      100,
      &mut |_| {},
    );
    assert!(r.is_err());
    fx.with(|s| assert!(!s.busy));
    // A command that waits on idle returns at once.
    assert!(fx.state.lock_idle(ID).is_ok());
    assert_eq!(fx.state.lock_idle(404).err().unwrap(), UNKNOWN_SESSION);
  }
  // --- offsets through a replace-all -------------------------------------------

  /// Reference for `map_offset`: the hits of a leftmost non-overlapping scan,
  /// each as its pre-replace start.
  fn ref_hits(hay: &[u8], needle: &[u8]) -> Vec<u64> {
    let mut hits = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = find_sub(&hay[from..], needle, true) {
      hits.push((from + rel) as u64);
      from += rel + needle.len();
    }
    hits
  }

  /// Where the reference puts `offset` of the pre frame (`forward`) or of the
  /// post frame (not forward).
  fn ref_map(hits: &[u64], n: i64, r: i64, forward: bool, offset: u64) -> u64 {
    let (hit_in, hit_out) = if forward { (n, r) } else { (r, n) };
    let mut moved = 0i64;
    for (i, &p) in hits.iter().enumerate() {
      let start = if forward {
        p as i64
      } else {
        p as i64 + i as i64 * (r - n)
      };
      let o = offset as i64;
      // A hit with no input text (an empty replacement, undone) is a point
      // that an offset on it has passed.
      if o < start || (o == start && hit_in > 0) {
        break;
      }
      if o < start + hit_in {
        return (start + moved + hit_out) as u64;
      }
      moved += hit_out - hit_in;
    }
    (offset as i64 + moved) as u64
  }

  #[test]
  fn map_offset_matches_the_reference_for_every_offset_in_both_directions() {
    let original = lcg_content(11, 3_000);
    for repl in ["T", "TOKEN-LONGER", "", "a\nb", "tok"] {
      let fx = fixture(&original);
      let out = fx.replace_with("tok", true, repl, 13, 70);
      let fwd = out.token.expect("a replace with hits has a token");
      let hits = ref_hits(&original, b"tok");
      assert!(hits.len() > 20);
      let (n, r) = (3i64, repl.len() as i64);
      let pre: Vec<u64> = (0..=original.len() as u64).collect();
      let want: Vec<u64> = pre.iter().map(|&o| ref_map(&hits, n, r, true, o)).collect();
      assert_eq!(
        map_replace_core(&fx.state, ID, fwd, &pre).unwrap(),
        want,
        "forward, replacement {repl:?}"
      );
      let post_len = fx.with(|s| s.table.len());
      let back = fx.undo().token.expect("an undone replace has a token");
      let post: Vec<u64> = (0..=post_len).collect();
      let want: Vec<u64> = post
        .iter()
        .map(|&o| ref_map(&hits, n, r, false, o))
        .collect();
      assert_eq!(
        map_replace_core(&fx.state, ID, back, &post).unwrap(),
        want,
        "inverse, replacement {repl:?}"
      );
      // The redo maps pre to post again with its own token.
      let again = fx.redo().token.unwrap();
      assert_ne!(again, fwd);
      let want: Vec<u64> = pre.iter().map(|&o| ref_map(&hits, n, r, true, o)).collect();
      assert_eq!(map_replace_core(&fx.state, ID, again, &pre).unwrap(), want);
    }
  }

  #[test]
  fn map_offset_places_offsets_before_between_inside_and_after_hits() {
    // "ab tok cd tok ef": hits at 3 and 10, three bytes each.
    let fx = fixture(b"ab tok cd tok ef");
    let token = fx.replace("tok", "LONGER").token.unwrap();
    // Before the first hit, at its start, inside it, at its end, between the
    // hits, inside the second, and after the last one.
    let got = map_replace_core(&fx.state, ID, token, &[0, 3, 4, 5, 6, 8, 13, 14, 16]).unwrap();
    assert_eq!(got, vec![0, 3, 9, 9, 9, 11, 19, 20, 22]);
    assert_eq!(fx.whole(), b"ab LONGER cd LONGER ef");
    // A shorter replacement moves the offsets the other way.
    let fx = fixture(b"ab tok cd tok ef");
    let token = fx.replace("tok", "X").token.unwrap();
    let got = map_replace_core(&fx.state, ID, token, &[3, 4, 6, 10, 12, 16]).unwrap();
    assert_eq!(got, vec![3, 4, 4, 8, 9, 12]);
  }

  #[test]
  fn a_replace_all_without_hits_has_no_token() {
    let fx = fixture(b"nothing here\n");
    assert!(fx.replace("tok", "X").token.is_none());
    fx.with(|s| assert!(s.replace_tokens.is_empty()));
  }

  #[test]
  fn a_token_outlives_the_journal_and_the_layer_until_it_is_released() {
    let fx = fixture(b"a tok b tok\nc\n");
    let forward = fx.replace("tok", "TOKEN").token.unwrap();
    let back = fx.undo().token.unwrap();
    assert_ne!(forward, back);
    // The layer is off the table; the typing edit empties the redo stack.
    fx.edit(vec![ed(0, 0, "ZZ")], true);
    assert!(fx.live_lists().is_empty());
    assert_eq!(
      fx.change_lists_on_disk(),
      1,
      "the tokens still hold the list"
    );
    // The undo's token maps the post frame onto the pre frame, whatever has
    // been typed since: post "a TOKEN b TOKEN" -> pre "a tok b tok".
    let got = map_replace_core(&fx.state, ID, back, &[0, 2, 4, 8, 9, 15]).unwrap();
    assert_eq!(got, vec![0, 2, 5, 6, 7, 11]);
    release_replace_core(&fx.state, ID, forward);
    assert_eq!(
      fx.change_lists_on_disk(),
      1,
      "the other token still holds it"
    );
    release_replace_core(&fx.state, ID, back);
    assert_eq!(fx.change_lists_on_disk(), 0);
    assert_eq!(
      map_replace_core(&fx.state, ID, back, &[0]).unwrap_err(),
      UNKNOWN_TOKEN
    );
    // Releasing a token that is gone, or in a session that is gone, is quiet.
    release_replace_core(&fx.state, ID, back);
    release_replace_core(&fx.state, 404, back);
  }

  #[test]
  fn closing_the_session_drops_its_tokens_and_their_files() {
    let fx = fixture(b"a tok b tok\nc\n");
    fx.replace("tok", "TOKEN");
    fx.undo();
    fx.edit(vec![ed(0, 0, "ZZ")], true);
    assert_eq!(fx.change_lists_on_disk(), 1);
    close_core(&fx.state, ID);
    assert_eq!(fx.change_lists_on_disk(), 0);
    assert_eq!(
      map_replace_core(&fx.state, ID, 1, &[0]).unwrap_err(),
      UNKNOWN_SESSION
    );
  }

  #[test]
  fn offset_line_counts_cr_and_lf_breaks() {
    // Lines by the core's count: "a\n" | "b\r\n" | "c\r" | "d\n" | "e".
    let fx = fixture(b"a\nb\r\nc\rd\ne");
    let at = |o: u64| offset_line_core(&fx.state, ID, o).unwrap();
    assert_eq!(at(0), 0);
    assert_eq!(at(1), 0, "before the first LF");
    assert_eq!(at(2), 1);
    // Inside a CRLF: before the LF, so still on the line of the CR.
    assert_eq!(at(4), 1);
    assert_eq!(at(5), 2);
    assert_eq!(at(6), 2, "before the lone CR");
    // A lone CR is a break: the next byte opens a line.
    assert_eq!(at(7), 3);
    assert_eq!(at(8), 3);
    assert_eq!(at(10), 4);
    // The file end is on the last line; past it is an error.
    let end = fx.whole().len() as u64;
    assert_eq!(at(end), 4);
    assert!(offset_line_core(&fx.state, ID, end + 1).is_err());
    assert_eq!(
      offset_line_core(&fx.state, 404, 0).unwrap_err(),
      UNKNOWN_SESSION
    );
  }
  #[test]
  fn pos_to_offset_stops_before_a_lone_cr() {
    // Lines: "ab\r" | "cd\r\n" | "ef\r" | "".
    let fx = fixture(b"ab\rcd\r\nef\r");
    fx.with(|s| {
      let at = |line: u64, col: u64| pos_to_offset(&s.table, line, col).unwrap();
      assert_eq!(at(0, 0), 0);
      assert_eq!(at(0, 2), 2);
      assert_eq!(at(0, 99), 2, "a column past the end stops before the CR");
      assert_eq!(at(1, 99), 5);
      assert_eq!(at(2, 1), 8);
      assert_eq!(at(2, 99), 9);
      assert_eq!(at(3, 0), 10, "the empty line after a final CR");
      assert_eq!(at(9, 0), 10, "a line past the end is the last line");
      let pos = offset_to_pos(&s.table, 3).unwrap();
      assert_eq!((pos.line, pos.col), (1, 0));
    });
  }
  // --- The line rule: `\n`, and `\r` not followed by `\n` ----------------------
  /// Line starts of `flat` by the line rule, written out directly.
  fn rule_line_starts(flat: &[u8]) -> Vec<u64> {
    let mut starts = vec![0u64];
    for i in 0..flat.len() {
      if flat[i] == b'\n' || (flat[i] == b'\r' && flat.get(i + 1) != Some(&b'\n')) {
        starts.push(i as u64 + 1);
      }
    }
    starts
  }

  fn assert_table_by_rule(table: &Table, flat: &[u8]) {
    assert_table_matches(table, flat, &rule_line_starts(flat));
  }
  /// Every line start and the line of every offset, exhaustively.
  fn assert_every_line_and_offset(table: &Table, flat: &[u8], what: &str) {
    let starts = rule_line_starts(flat);
    let lines = if flat.is_empty() {
      0
    } else {
      starts.len() as u64
    };
    assert_eq!(table.line_count(), lines, "{what}: line_count of {flat:?}");
    for line in 0..lines {
      let got = table
        .line_to_offset(line)
        .unwrap_or_else(|e| panic!("{what}: line_to_offset({line}) of {flat:?}: {e}"));
      assert_eq!(
        got, starts[line as usize],
        "{what}: line_to_offset({line}) of {flat:?}"
      );
    }
    for off in 0..=flat.len() as u64 {
      let got = table
        .offset_to_line(off)
        .unwrap_or_else(|e| panic!("{what}: offset_to_line({off}) of {flat:?}: {e}"));
      assert_eq!(
        got,
        starts.partition_point(|&s| s <= off) as u64 - 1,
        "{what}: offset_to_line({off}) of {flat:?}"
      );
    }
    assert_table_by_rule(table, flat);
  }
  /// Line and UTF-16 column of `off` in `flat`.
  fn rule_pos(flat: &[u8], off: u64) -> Pos {
    let starts = rule_line_starts(flat);
    let line = starts.partition_point(|&s| s <= off) as u64 - 1;
    let text = String::from_utf8_lossy(&flat[starts[line as usize] as usize..off as usize]);
    Pos {
      line,
      col: text.encode_utf16().count() as u64,
    }
  }
  /// Offset of `line` / `col` in `flat`; a column past the text lands at its
  /// end, before the line's break.
  fn rule_offset(flat: &[u8], line: u64, col: u64) -> u64 {
    let starts = rule_line_starts(flat);
    let line = (line as usize).min(starts.len() - 1);
    let start = starts[line] as usize;
    let end = starts.get(line + 1).map_or(flat.len(), |&e| e as usize);
    let mut text = &flat[start..end];
    if text.ends_with(b"\n") {
      text = &text[..text.len() - 1];
    }
    if text.ends_with(b"\r") {
      text = &text[..text.len() - 1];
    }
    let text = std::str::from_utf8(text).unwrap();
    let mut units = 0u64;
    for (i, ch) in text.char_indices() {
      if units >= col {
        return (start + i) as u64;
      }
      units += ch.len_utf16() as u64;
    }
    (start + text.len()) as u64
  }

  fn rule_scan_inputs() -> Vec<Vec<u8>> {
    let mut inputs: Vec<Vec<u8>> = [
      &b"abcd\rxyzabc"[..],
      b"abcd\r\nyzabc",
      b"abcdefghi\rxy",
      b"abcdefghi\r\ny",
      b"abcde\rfg",
      b"abcd\r",
      b"abcde\r",
      b"\r",
      b"\r\r\r\r\r\r\r\r\r\r\r\r",
      b"\r\n\r\n\r\n\r\n\r\n\r\n",
      b"\n",
      b"",
    ]
    .iter()
    .map(|input| input.to_vec())
    .collect();
    let tokens: [&[u8]; 4] = [b"a", "é".as_bytes(), b"\r", b"\n"];
    for seed in 1..=80u64 {
      let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15);
      let mut input = Vec::new();
      for _ in 0..(seed % 25) {
        state = state
          .wrapping_mul(6364136223846793005)
          .wrapping_add(1442695040888963407);
        input.extend_from_slice(tokens[((state >> 33) % 4) as usize]);
      }
      inputs.push(input);
    }
    inputs
  }

  #[test]
  fn the_scan_follows_the_line_rule_for_any_read_size() {
    for input in rule_scan_inputs() {
      let starts = rule_line_starts(&input);
      let mut want = vec![(0u64, 0u64)];
      let mut at = 5u64;
      while at < input.len() as u64 {
        want.push((at, starts.partition_point(|&s| s <= at) as u64 - 1));
        at += 5;
      }
      for buf in [1usize, 2, 3, 4096] {
        let (bytes, checkpoints, total) =
          scan_reader_at(Cursor::new(input.as_slice()), buf, 5).unwrap();
        assert_eq!(bytes, input.len() as u64, "{input:?} / {buf}");
        assert_eq!(total, starts.len() as u64 - 1, "total of {input:?} / {buf}");
        assert_eq!(checkpoints, want, "checkpoints of {input:?} / {buf}");
        let table = PieceTable::new(OriginalIndex::new(
          input.as_slice(),
          bytes,
          total,
          checkpoints,
        ));
        let lines = if input.is_empty() {
          0
        } else {
          starts.len() as u64
        };
        assert_eq!(table.line_count(), lines, "{input:?} / {buf}");
        for line in 0..lines {
          assert_eq!(
            table.line_to_offset(line).unwrap(),
            starts[line as usize],
            "line {line} of {input:?} / {buf}"
          );
        }
      }
    }
  }

  const CR_TEXTS: [&str; 5] = [
    "a\r\nb",
    "a\r\nb\rc\nd\r\n\re\r",
    "\r\r\n\n\r",
    "é\rè\r\n\r\néa\r",
    "xa\rb\r\nxa\r\nx\r",
  ];
  const CR_NEEDLES: [&str; 11] = [
    "\nb", "a\r", "\r", "\r\n", "b\r", "\n", "c\n", "\rc", "\r\r", "x", "a\r\nb",
  ];
  /// Non-overlapping hits from `find_sub`, as offsets.
  fn flat_hit_offsets(flat: &[u8], needle: &[u8]) -> Vec<u64> {
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = find_sub(&flat[from..], needle, true) {
      out.push((from + rel) as u64);
      from += rel + needle.len();
    }
    out
  }

  #[test]
  fn search_lines_and_columns_follow_the_line_rule() {
    for text in CR_TEXTS {
      let flat = text.as_bytes();
      let fx = fixture(flat);
      for needle in CR_NEEDLES {
        let want: Vec<(u64, u64, u64)> = flat_hit_offsets(flat, needle.as_bytes())
          .into_iter()
          .map(|off| {
            let pos = rule_pos(flat, off);
            (off, pos.line, pos.col)
          })
          .collect();
        for chunk in [1usize, 2, 3, 7, SCAN_CHUNK] {
          let got: Vec<(u64, u64, u64)> = all_hits_with_cols(&fx, needle, true, chunk)
            .into_iter()
            .map(|(off, line, col, _)| (off, line, col))
            .collect();
          assert_eq!(got, want, "{text:?} / {needle:?} / chunk {chunk}");
        }
      }
    }
  }

  #[test]
  fn a_hit_inside_a_crlf_sits_on_the_line_of_its_cr() {
    let fx = fixture(b"a\r\nb");
    // "\nb" starts between the CR and the LF: line 0, one past the line's text.
    assert_eq!(
      all_hits_with_cols(&fx, "\nb", true, SCAN_CHUNK)
        .into_iter()
        .map(|(off, line, col, _)| (off, line, col))
        .collect::<Vec<_>>(),
      vec![(2, 0, 2)]
    );
    let find = |q: &str, line: u64, col: u64, backward: bool| {
      find_core(
        &fx.state,
        ID,
        q,
        true,
        line,
        col,
        backward,
        SCAN_CHUNK,
        &mut |_| {},
      )
      .unwrap()
      .unwrap()
    };
    let forward = find("\nb", 0, 0, false);
    assert_eq!(forward.start, Pos { line: 0, col: 2 });
    assert_eq!(forward.end, Pos { line: 1, col: 1 });
    let backward = find("\nb", 1, 1, true);
    assert_eq!(backward.start, Pos { line: 0, col: 2 });
    assert_eq!(backward.end, Pos { line: 1, col: 1 });
    // "a\r" ends between the CR and the LF.
    let forward = find("a\r", 0, 0, false);
    assert_eq!(forward.start, Pos { line: 0, col: 0 });
    assert_eq!(forward.end, Pos { line: 0, col: 2 });
    let backward = find("a\r", 1, 1, true);
    assert_eq!(backward.start, Pos { line: 0, col: 0 });
    assert_eq!(backward.end, Pos { line: 0, col: 2 });
    let listed = all_hits_with_cols(&fx, "a\r", true, SCAN_CHUNK);
    assert_eq!(
      listed.iter().map(|h| (h.1, h.2)).collect::<Vec<_>>(),
      vec![(0, 0)]
    );
  }

  #[test]
  fn find_positions_follow_the_line_rule_in_both_directions() {
    for text in CR_TEXTS {
      let flat = text.as_bytes();
      let fx = fixture(flat);
      for needle in CR_NEEDLES {
        let m = needle.len() as u64;
        let all: Vec<u64> = (0..flat.len().saturating_sub(needle.len() - 1))
          .filter(|&s| &flat[s..s + needle.len()] == needle.as_bytes())
          .map(|s| s as u64)
          .collect();
        let listed = all_hits_with_cols(&fx, needle, true, SCAN_CHUNK);
        for chunk in [2usize, SCAN_CHUNK] {
          for from in 0..=flat.len() {
            if std::str::from_utf8(&flat[..from]).is_err() {
              continue;
            }
            let pos = rule_pos(flat, from as u64);
            let from_off = rule_offset(flat, pos.line, pos.col);
            for backward in [false, true] {
              let want = if backward {
                all
                  .iter()
                  .rev()
                  .find(|&&s| s + m <= from_off)
                  .or_else(|| all.last())
              } else {
                all.iter().find(|&&s| s >= from_off).or_else(|| all.first())
              };
              let got = find_core(
                &fx.state,
                ID,
                needle,
                true,
                pos.line,
                pos.col,
                backward,
                chunk,
                &mut |_| {},
              )
              .unwrap();
              let label = format!("{text:?} / {needle:?} / from {from} / back {backward}");
              assert_eq!(
                got.as_ref().map(|h| h.start_offset),
                want.copied(),
                "{label}"
              );
              if let Some(hit) = got {
                assert_eq!(hit.start, rule_pos(flat, hit.start_offset), "{label}");
                assert_eq!(hit.end, rule_pos(flat, hit.end_offset), "{label}");
              }
            }
          }
        }
        // The first find and the first listed hit are one place.
        if let Some(first) = listed.first() {
          let hit = find_core(
            &fx.state,
            ID,
            needle,
            true,
            0,
            0,
            false,
            SCAN_CHUNK,
            &mut |_| {},
          )
          .unwrap()
          .unwrap();
          assert_eq!(hit.start_offset, first.0);
          assert_eq!(
            hit.start,
            Pos {
              line: first.1,
              col: first.2
            }
          );
        }
      }
    }
  }
  /// Replace `q` by `r` over `content` and walk a path that builds an inverse
  /// layer, comparing the table with a flat recomputation after every step:
  /// replace-all, save, undo, redo; or replace-all, typing, undo of the typing,
  /// undo, redo. The offsets the replace-all and its undo map equal the model's.
  fn check_replace_path(
    content: &[u8],
    q: &str,
    r: &str,
    insert_sep: &str,
    interval: u64,
    chunk: usize,
    typing: bool,
  ) {
    check_replace_path_with(content, q, r, insert_sep, interval, chunk, typing, &|_| {});
  }
  /// `check_replace_path`, with `more` run on the table after every step that
  /// leaves a replace layer on top.
  #[allow(clippy::too_many_arguments)]
  fn check_replace_path_with(
    content: &[u8],
    q: &str,
    r: &str,
    insert_sep: &str,
    interval: u64,
    chunk: usize,
    typing: bool,
    more: &dyn Fn(&Table),
  ) {
    use crate::replace_layer::top_layer_dir;
    let model = replace_model(content, q.as_bytes(), r.as_bytes(), true, insert_sep);
    let post = model.post.clone();
    let hits = model.hits.len() as u64;
    let label = format!("{content:?} / {q:?} -> {r:?} / {insert_sep:?} / interval {interval}");
    let check = |fx: &Fixture, what: &str, flat: &[u8], dir: Option<Dir>| {
      fx.with(|s| {
        if dir.is_some() {
          assert_eq!(top_layer_dir(&s.table), dir, "{what}: {label}");
          more(&s.table);
        }
        assert_every_line_and_offset(&s.table, flat, &format!("{what}: {label}"));
      });
    };
    let fx = fixture(content);
    let out = fx.replace_with_sep(q, true, r, insert_sep, chunk, interval);
    assert_eq!(out.count, hits, "{label}");
    if hits == 0 {
      return;
    }
    let lines = if post.is_empty() {
      0
    } else {
      rule_line_starts(&post).len() as u64
    };
    assert_eq!(out.total_lines, lines, "total_lines: {label}");
    check(&fx, "forward", &post, Some(Dir::Forward));
    let (forward, inverse) = model.maps(content.len(), q.len(), r.len());
    let pre: Vec<u64> = (0..=content.len() as u64).collect();
    let token = out.token.expect("a replace with hits has a token");
    assert_eq!(
      map_replace_core(&fx.state, ID, token, &pre).unwrap(),
      forward,
      "offsets forward: {label}"
    );
    let check_back = |back: UndoResult| {
      let token = back.token.expect("an undone replace has a token");
      let post_offsets: Vec<u64> = (0..=post.len() as u64).collect();
      assert_eq!(
        map_replace_core(&fx.state, ID, token, &post_offsets).unwrap(),
        inverse,
        "offsets back: {label}"
      );
    };
    if !typing {
      fx.save();
      check(&fx, "saved", &post, None);
      check_back(fx.undo());
      check(&fx, "inverse after save", content, Some(Dir::Inverse));
      fx.redo();
      check(&fx, "forward again", &post, Some(Dir::Forward));
      return;
    }
    // Typing inside the content splits its piece, so the undo that follows
    // cannot just take the layer off.
    let text = std::str::from_utf8(&post).unwrap();
    let mut at = post.len() / 2;
    while !text.is_char_boundary(at) {
      at += 1;
    }
    if at == 0 || at >= post.len() {
      return;
    }
    fx.edit(vec![ed(at as u64, at as u64, "Z")], true);
    let mut typed = post.clone();
    typed.insert(at, b'Z');
    check(&fx, "typed", &typed, None);
    fx.undo();
    check(&fx, "typing undone", &post, None);
    check_back(fx.undo());
    check(&fx, "inverse after typing", content, Some(Dir::Inverse));
    fx.redo();
    check(&fx, "forward after redo", &post, Some(Dir::Forward));
  }

  const BOUNDARY_CASES: [(&[u8], &str, &str, u64); 11] = [
    // Pre frame: a lone CR, then a CRLF cut, just before a checkpoint.
    (b"abc\rdefghij", "hi", "Z", 4),
    (b"abc\r\ndefghij", "hi", "Z", 4),
    (b"abcdefg\rhijk", "jk", "Z", 4),
    (b"abcdefg\r\nhijk", "jk", "Z", 4),
    // Post frame: a replacement ending in CR, then a gap that starts without
    // and with an LF, the checkpoint between them.
    (b"xx ABy.........", "AB", "q\r", 5),
    (b"xx AB\nzzzzzzzz", "AB", "q\r", 5),
    (b"xx ABy.........", "AB", "q\r\n", 5),
    // Empty replacements after a gap that ends in a lone CR: checkpoints
    // pile up at one post offset; then a byte that is no LF, an LF, the end.
    (b"a\rXYXYXYXYXYbcd", "XY", "", 3),
    (b"a\rXYXYXYXYXY\nbcd", "XY", "", 3),
    (b"a\rXYXYXYXYXY", "XY", "", 3),
    (b"a\rXYXYXYXYXY\rbcd", "XY", "", 3),
  ];

  fn check_boundary_cases(typing: bool) {
    for insert_sep in ["\n", "\r\n"] {
      for (content, q, r, interval) in BOUNDARY_CASES {
        for chunk in [2usize, SCAN_CHUNK] {
          check_replace_path(content, q, r, insert_sep, interval, chunk, typing);
        }
      }
    }
  }

  fn check_random_replaces(typing: bool) {
    let tokens = ["a", "b", "x", "\r", "\n", "é", "ab", "\r\n", "xa\r"];
    let needles = ["x", "\r", "\n", "\r\n", "a\r", "\nb", "b", "xa\r"];
    let repls = ["", "\r", "\n", "\r\n", "q\r", "\rq", "zz", "\r\r"];
    for seed in 1..=8u64 {
      let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15);
      let mut next = || {
        state = state
          .wrapping_mul(6364136223846793005)
          .wrapping_add(1442695040888963407);
        state >> 33
      };
      let mut content = String::new();
      while content.len() < 60 {
        content.push_str(tokens[(next() % tokens.len() as u64) as usize]);
      }
      for _ in 0..20 {
        let q = needles[(next() % needles.len() as u64) as usize];
        let r = repls[(next() % repls.len() as u64) as usize];
        let interval = [3u64, 5, 8][(next() % 3) as usize];
        for insert_sep in ["\n", "\r\n"] {
          check_replace_path(content.as_bytes(), q, r, insert_sep, interval, 7, typing);
        }
      }
    }
  }

  #[test]
  fn replace_all_checkpoints_follow_the_line_rule_at_chosen_boundaries_after_a_save() {
    check_boundary_cases(false);
  }

  #[test]
  fn replace_all_checkpoints_follow_the_line_rule_at_chosen_boundaries_after_typing() {
    check_boundary_cases(true);
  }

  #[test]
  fn replace_all_follows_the_line_rule_over_random_texts_after_a_save() {
    check_random_replaces(false);
  }

  #[test]
  fn replace_all_follows_the_line_rule_over_random_texts_after_typing() {
    check_random_replaces(true);
  }
  /// Every content over {a, x, CR, LF} of length 0 to 5.
  fn short_contents() -> Vec<Vec<u8>> {
    let alphabet = *b"ax\r\n";
    let mut all: Vec<Vec<u8>> = vec![Vec::new()];
    let mut from = 0;
    for _ in 0..5 {
      let to = all.len();
      for i in from..to {
        for &b in &alphabet {
          let mut next = all[i].clone();
          next.push(b);
          all.push(next);
        }
      }
      from = to;
    }
    all
  }

  #[test]
  fn replace_all_rewrites_every_junction_over_every_short_content() {
    let started = Instant::now();
    let needles = ["x", "xx", "\r", "\n", "\r\n", "x\r", "\nx"];
    let repls = ["", "y", "\n", "\r", "\r\n", "\rq", "q\r"];
    let contents = short_contents();
    assert_eq!(contents.len(), 1365);
    let mut junctions = 0;
    for (c, content) in contents.iter().enumerate() {
      for insert_sep in ["\n", "\r\n"] {
        for k in 0..3 {
          let pair = (3 * c + k) % 49;
          let (q, r) = (needles[pair / 7], repls[pair % 7]);
          let interval = [1u64, 2, 3][(c + k) % 3];
          let chunk = [1usize, 2, 3, 7][(c + k) % 4];
          let typing = (c + k) % 2 == 1;
          check_replace_path(content, q, r, insert_sep, interval, chunk, typing);
          junctions +=
            replace_model(content, q.as_bytes(), r.as_bytes(), true, insert_sep).junctions;
        }
      }
    }
    assert!(junctions > 20, "{junctions} junctions");
    let took = started.elapsed();
    eprintln!("enumeration took {took:?}");
    assert!(took < Duration::from_secs(60), "{took:?}");
  }
  /// Named shapes: content, needle, replacement.
  const JUNCTION_SHAPES: [(&[u8], &str, &str); 15] = [
    // A run of kept CRs that hits split: the inverse read meets it in more than
    // one gap.
    (b"a\rx\rx\nb", "x", ""),
    (b"\r\rxx\r\rx\n", "x", ""),
    (b"q\rx\rx\rx\r\n", "x", ""),
    (b"\rx\n", "x", ""),
    (b"\rxx\n", "x", ""),
    (b"\r\rx\n", "x", ""),
    (b"a\r\r\rxx\n", "x", ""),
    (b"\rx", "x", ""),
    (b"\rxa", "x", ""),
    (b"x\rx\n", "x", ""),
    (b"\rx\nx\n", "x", ""),
    // A CR that is half of a CRLF is not a kept CR.
    (b"a\r\nx", "x", "y"),
    (b"\r\nb", "\n", "\n"),
    // The replacement starts with the LF.
    (b"\rxq\n", "x", "\nq"),
    // A CR of the replacement before an LF of the text is not rewritten.
    (b"x\n", "x", "q\r"),
  ];

  #[test]
  fn replace_all_rewrites_the_named_junction_shapes_at_every_interval_and_chunk() {
    for (content, q, r) in JUNCTION_SHAPES {
      for interval in 1..=3u64 {
        for chunk in [1usize, 2, 3, 7] {
          for insert_sep in ["\n", "\r\n"] {
            for typing in [false, true] {
              check_replace_path(content, q, r, insert_sep, interval, chunk, typing);
            }
          }
        }
      }
    }
  }

  #[test]
  fn the_named_shapes_rewrite_what_the_rule_says() {
    let rewritten = |content: &[u8], q: &str, r: &str, sep: &str| {
      replace_model(content, q.as_bytes(), r.as_bytes(), true, sep).post
    };
    assert_eq!(rewritten(b"\rx\n", "x", "", "\n"), b"\n\n");
    assert_eq!(rewritten(b"\rx\n", "x", "", "\r\n"), b"\r\n\n");
    assert_eq!(rewritten(b"a\r\r\rxx\n", "x", "", "\n"), b"a\n\n\n\n");
    assert_eq!(rewritten(b"a\r\r\rxx\n", "x", "", "\r\n"), b"a\r\r\r\n\n");
    assert_eq!(rewritten(b"\rx", "x", "", "\n"), b"\r");
    assert_eq!(rewritten(b"\rxq\n", "x", "\nq", "\r\n"), b"\r\n\nqq\n");
    assert_eq!(rewritten(b"a\r\nx", "x", "y", "\n"), b"a\r\ny");
    assert_eq!(rewritten(b"x\n", "x", "q\r", "\n"), b"q\r\n");
    // The LF of a CRLF replaced by an LF leaves the pair as it was.
    assert_eq!(rewritten(b"\r\nb", "\n", "\n", "\n"), b"\r\nb");
  }
  /// The checkpoints of the table's index count the breaks of `flat` before
  /// their offset, by the line rule.
  fn assert_checkpoint_counts(table: &Table, flat: &[u8]) {
    use crate::line_rule::BreakCounter;
    let mut counter = BreakCounter::new();
    let mut fed = 0usize;
    for &(off, nl) in table.index_checkpoints() {
      let off = off as usize;
      counter.feed(&flat[fed..off]);
      fed = off;
      let want = if off == flat.len() {
        counter.finish()
      } else {
        counter.count_before_next(flat[off])
      };
      assert_eq!(nl, want, "checkpoint at {off}");
    }
  }
  /// The change list behind `token`.
  fn list_of(fx: &Fixture, token: u64) -> Arc<ChangeList> {
    fx.with(|s| s.replace_tokens.get(&token).unwrap().0.clone())
  }
  /// Samples of the table against `flat`: length, line count, bytes, a spread
  /// of line starts, reads that start inside a run and every checkpoint.
  fn assert_big_table_is(table: &Table, flat: &[u8]) {
    assert_eq!(table.len(), flat.len() as u64);
    assert_eq!(table.read(0, table.len()).unwrap(), flat, "bytes");
    let starts = rule_line_starts(flat);
    assert_eq!(table.line_count(), starts.len() as u64, "line_count");
    for line in [
      0,
      1,
      2,
      starts.len() / 2,
      starts.len() - 2,
      starts.len() - 1,
    ] {
      assert_eq!(
        table.line_to_offset(line as u64).unwrap(),
        starts[line],
        "line {line}"
      );
    }
    for off in [1usize, flat.len() / 3, flat.len() / 2 + 1, flat.len() - 5] {
      assert_eq!(
        table.read(off as u64, off as u64 + 4).unwrap(),
        flat[off..off + 4]
      );
    }
    assert_checkpoint_counts(table, flat);
  }
  /// A run of `run` CRs, then 3 * 512 + 1 drop-outs (more than three batches of
  /// hit records), then an LF.
  fn long_run_content(run: usize) -> Vec<u8> {
    let mut content = vec![b'\r'; run];
    content.extend(std::iter::repeat_n(b'X', 3 * 512 + 1));
    content.push(b'\n');
    content
  }

  #[test]
  fn a_run_of_a_million_cr_is_rewritten_by_one_record_for_lf() {
    let content = long_run_content(1_000_000);
    let model = replace_model(&content, b"X", b"", true, "\n");
    assert_eq!(model.junctions, 1);
    assert!(model.post.iter().all(|&b| b == b'\n'));
    let fx = fixture(&content);
    let out = fx.replace_with_sep("X", true, "", "\n", SCAN_CHUNK, 700);
    let token = out.token.unwrap();
    let list = list_of(&fx, token);
    assert_eq!(list.run_count(), 1, "one record for the whole run");
    assert_eq!(out.total_lines, 1_000_002);
    fx.with(|s| assert_big_table_is(&s.table, &model.post));
    fx.save();
    fx.undo();
    fx.with(|s| assert_big_table_is(&s.table, &content));
    fx.redo();
    fx.with(|s| assert_big_table_is(&s.table, &model.post));
  }

  #[test]
  fn a_run_of_a_million_cr_gets_one_inserted_byte_on_the_last_hit_for_crlf() {
    let content = long_run_content(1_000_000);
    let model = replace_model(&content, b"X", b"", true, "\r\n");
    assert_eq!(model.junctions, 1);
    let fx = fixture(&content);
    let out = fx.replace_with_sep("X", true, "", "\r\n", SCAN_CHUNK, 700);
    let list = list_of(&fx, out.token.unwrap());
    assert_eq!(list.run_count(), 0);
    assert!(!list.runs_path().exists(), "no run list without a run");
    assert_eq!(list.hit_record(0), (1_000_000, 0, false));
    let last = list.hits() - 1;
    assert_eq!(last, 3 * 512);
    assert_eq!(list.hit_record(last), (1_000_000 + last, 0, true));
    fx.with(|s| assert_big_table_is(&s.table, &model.post));
    fx.save();
    fx.undo();
    fx.with(|s| assert_big_table_is(&s.table, &content));
    fx.redo();
    fx.with(|s| assert_big_table_is(&s.table, &model.post));
  }

  #[test]
  fn a_hundred_thousand_junctions_write_a_hundred_thousand_records_or_inserted_bytes() {
    let content = b"\rX\n".repeat(100_000);
    for insert_sep in ["\n", "\r\n"] {
      let model = replace_model(&content, b"X", b"", true, insert_sep);
      assert_eq!(model.junctions, 100_000);
      let fx = fixture(&content);
      let out = fx.replace_with_sep("X", true, "", insert_sep, SCAN_CHUNK, 1000);
      let list = list_of(&fx, out.token.unwrap());
      if insert_sep == "\n" {
        assert_eq!(list.run_count(), 100_000);
        assert_eq!(list.hit_record(99_999).1, 0);
      } else {
        assert_eq!(list.run_count(), 0);
        assert_eq!(list.hit_record(99_999), (299_998, 99_999, true));
        assert_eq!(list.hit_record(7), (3 * 7 + 1, 7, true));
      }
      fx.with(|s| assert_big_table_is(&s.table, &model.post));
      fx.save();
      fx.undo();
      fx.with(|s| assert_big_table_is(&s.table, &content));
      fx.redo();
      fx.with(|s| assert_big_table_is(&s.table, &model.post));
    }
  }

  #[test]
  fn what_a_pass_holds_does_not_follow_the_run_or_the_junction_count() {
    // Resident units of the stacked table (no checkpoint but the first, so the
    // checkpoint count is the same) and the pass's own state before it ends.
    let units = |content: &[u8], insert_sep: &str| -> (usize, usize) {
      let fx = fixture(content);
      fx.replace_with_sep("X", true, "", insert_sep, SCAN_CHUNK, 100_000_000);
      let table = fx.with(|s| resident_units(&s.table));
      let dir = tempdir().unwrap();
      let mut b = Builder::create(dir.path(), b"X", b"", 100_000_000, insert_sep).unwrap();
      for piece in content.split_inclusive(|&c| c == b'X') {
        match piece.split_last() {
          Some((b'X', gap)) => {
            b.gap(gap);
            b.hit(b"X").unwrap();
          }
          _ => b.gap(piece),
        }
      }
      (table, b.state_units())
    };
    for insert_sep in ["\n", "\r\n"] {
      assert_eq!(
        units(&long_run_content(10), insert_sep),
        units(&long_run_content(1_000_000), insert_sep),
        "a run of 10 and of a million, {insert_sep:?}"
      );
      assert_eq!(
        units(&b"\rX\n".repeat(10), insert_sep),
        units(&b"\rX\n".repeat(100_000), insert_sep),
        "10 and 100000 junctions, {insert_sep:?}"
      );
    }
  }

  #[test]
  fn checkpoints_keep_their_spacing_while_a_kept_cr_waits_through_many_hits() {
    // A kept CR, 16 drop-outs (many intervals of pre bytes with no post byte),
    // then an LF, another byte or the end.
    for tail in [&b"\n"[..], b"b", b""] {
      let mut content = b"a\r".to_vec();
      content.extend(b"XY".repeat(16));
      content.extend(tail);
      for insert_sep in ["\n", "\r\n"] {
        for typing in [false, true] {
          check_replace_path_with(&content, "XY", "", insert_sep, 3, 7, typing, &|table| {
            assert_segments_within(table, 3);
          });
        }
      }
    }
  }

  #[test]
  fn an_inserted_byte_belongs_to_one_hit_and_the_offsets_follow_it() {
    // "\rxx\n": both x are dropped, so the CR meets the LF; CRLF gives
    // "\r\n\n" with the inserted byte on the last x.
    let fx = fixture(b"\rxx\n");
    let token = fx
      .replace_with_sep("x", true, "", "\r\n", SCAN_CHUNK, CHECKPOINT_INTERVAL)
      .token
      .unwrap();
    assert_eq!(fx.whole(), b"\r\n\n");
    assert_eq!(
      map_replace_core(&fx.state, ID, token, &[0, 1, 2, 3, 4]).unwrap(),
      vec![0, 1, 1, 2, 3]
    );
    let back = fx.undo().token.unwrap();
    assert_eq!(fx.whole(), b"\rxx\n");
    assert_eq!(
      map_replace_core(&fx.state, ID, back, &[0, 1, 2, 3]).unwrap(),
      vec![0, 2, 3, 4]
    );
    // The same for LF: no byte is inserted, the offsets only follow the hits.
    let fx = fixture(b"\rxx\n");
    let token = fx.replace("x", "").token.unwrap();
    assert_eq!(fx.whole(), b"\n\n");
    assert_eq!(
      map_replace_core(&fx.state, ID, token, &[0, 1, 2, 3, 4]).unwrap(),
      vec![0, 1, 1, 1, 2]
    );
  }
  // --- Reads through replace layers --------------------------------------------
  /// Every `[a, b)` read of `table` equals `flat`; for a long `flat`, the ranges
  /// between a spread of offsets, among them the ends.
  fn assert_reads_match(table: &Table, flat: &[u8], what: &str) {
    assert_eq!(table.len(), flat.len() as u64, "{what}: length");
    let n = flat.len() as u64;
    let picks: Vec<u64> = if n <= 64 {
      (0..=n).collect()
    } else {
      let mut picks = vec![0, 1, 2, 3, n / 3, n / 2, n - 3, n - 2, n - 1, n];
      picks.sort_unstable();
      picks.dedup();
      picks
    };
    for &a in &picks {
      for &b in picks.iter().filter(|&&b| b >= a) {
        assert_eq!(
          table.read(a, b).unwrap(),
          &flat[a as usize..b as usize],
          "{what}: read [{a}, {b})"
        );
      }
    }
  }
  /// The table under a replace layer reads like the model's bytes: the post
  /// bytes under a forward layer, the original under an inverse one.
  fn assert_layer_reads_match(table: &Table, content: &[u8], q: &str, r: &str, insert_sep: &str) {
    let model = replace_model(content, q.as_bytes(), r.as_bytes(), true, insert_sep);
    let flat: &[u8] = match replace_layer::top_layer_dir(table) {
      Some(Dir::Forward) => &model.post,
      Some(Dir::Inverse) => content,
      None => panic!("no layer on top"),
    };
    assert_reads_match(
      table,
      flat,
      &format!("{content:?} / {q:?} -> {r:?} / {insert_sep:?}"),
    );
  }

  #[test]
  fn a_read_through_a_layer_equals_the_flat_model_for_the_named_shapes() {
    for (content, q, r) in JUNCTION_SHAPES {
      for interval in 1..=3u64 {
        for insert_sep in ["\n", "\r\n"] {
          check_replace_path_with(content, q, r, insert_sep, interval, 7, false, &|table| {
            assert_layer_reads_match(table, content, q, r, insert_sep);
          });
        }
      }
    }
  }

  #[test]
  fn a_read_through_a_layer_equals_the_flat_model_for_random_small_cases() {
    let tokens: [&str; 7] = ["a", "x", "\r", "\n", "xx", "\r\n", "\r\r"];
    let needles = ["x", "xx", "\r", "\n", "\r\n"];
    let repls = ["", "y", "\n", "\r", "\r\n", "\nq"];
    let mut state = 11u64;
    let mut next = || {
      state = state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
      state >> 33
    };
    for _ in 0..200 {
      let mut content = String::new();
      let target = 8 + (next() % 33) as usize;
      while content.len() < target {
        content.push_str(tokens[(next() % tokens.len() as u64) as usize]);
      }
      let q = needles[(next() % needles.len() as u64) as usize];
      let r = repls[(next() % repls.len() as u64) as usize];
      let interval = 1 + next() % 3;
      for insert_sep in ["\n", "\r\n"] {
        check_replace_path_with(
          content.as_bytes(),
          q,
          r,
          insert_sep,
          interval,
          7,
          false,
          &|table| assert_layer_reads_match(table, content.as_bytes(), q, r, insert_sep),
        );
      }
    }
  }

  #[test]
  fn a_read_through_a_layer_that_drops_a_wide_span_reads_gap_by_gap() {
    // 200,000 dropped hits between two gaps: far wider than twice the text the
    // read takes from the table below plus the slack.
    let mut content = b"a\r".to_vec();
    content.extend(std::iter::repeat_n(b'x', 200_000));
    content.extend_from_slice(b"\nb");
    for insert_sep in ["\n", "\r\n"] {
      for interval in [4096, CHECKPOINT_INTERVAL] {
        let fx = fixture(&content);
        fx.replace_with_sep("x", true, "", insert_sep, SCAN_CHUNK, interval);
        let check = || {
          fx.with(|s| assert_layer_reads_match(&s.table, &content, "x", "", insert_sep));
        };
        check();
        fx.save();
        fx.undo();
        check();
        fx.redo();
        check();
      }
    }
  }

  #[test]
  fn a_failed_read_leaves_the_caller_buffer_as_it_was() {
    let fx = fixture(b"head\nqq tail\n");
    fx.replace("qq", "");
    let layer_len = fx.with(|s| s.table.len());
    fx.with(|s| {
      let mut out = b"keep".to_vec();
      // Past the end of a layer.
      assert!(s
        .table
        .source()
        .read_into(0, layer_len as usize + 1, &mut out)
        .is_err());
      assert_eq!(out, b"keep");
      // Past the end of a piece table.
      assert!(s
        .table
        .read_into(0, layer_len as usize + 1, &mut out)
        .is_err());
      assert_eq!(out, b"keep");
    });
    // The file under the layer is cut short: the failure comes from the bottom
    // of the stack, after the layer began to fill the buffer.
    File::options()
      .write(true)
      .open(&fx.path)
      .unwrap()
      .set_len(3)
      .unwrap();
    fx.with(|s| {
      let mut out = b"keep".to_vec();
      assert!(s
        .table
        .source()
        .read_into(0, layer_len as usize, &mut out)
        .is_err());
      assert_eq!(out, b"keep");
      assert!(s.table.read_into(0, layer_len as usize, &mut out).is_err());
      assert_eq!(out, b"keep");
      assert!(s.table.read(0, layer_len).is_err());
    });
    // A file source: past the end, and a short file.
    let file = File::open(&fx.path).unwrap();
    let mut out = b"keep".to_vec();
    assert!(file.read_into(0, 4, &mut out).is_err());
    assert_eq!(out, b"keep");
    assert!(file.read_into(1, 2, &mut out).is_ok());
    assert_eq!(out, b"keepea");
  }
  // --- Memory of reads through replace layers ----------------------------------
  const MIB: i64 = 1 << 20;
  /// `size` bytes of `unit` repeated.
  fn repeated(unit: &[u8], size: usize) -> Vec<u8> {
    unit
      .iter()
      .cycle()
      .take(size / unit.len() * unit.len())
      .copied()
      .collect()
  }
  /// A table over the file `path`, with a checkpoint every `CHECKPOINT_INTERVAL`.
  fn file_table(path: &Path) -> Table {
    build_table(path).unwrap().0
  }
  /// The change list of replacing every `needle` in `content` by nothing.
  fn drop_all(dir: &Path, content: &[u8], needle: &[u8], insert_sep: &str) -> Arc<ChangeList> {
    let mut builder = Builder::create(dir, needle, b"", CHECKPOINT_INTERVAL, insert_sep).unwrap();
    let (mut at, mut start) = (0, 0);
    while at + needle.len() <= content.len() {
      if &content[at..at + needle.len()] == needle {
        builder.gap(&content[start..at]);
        builder.hit(&content[at..at + needle.len()]).unwrap();
        at += needle.len();
        start = at;
      } else {
        at += 1;
      }
    }
    builder.gap(&content[start..]);
    Arc::new(builder.finish(content.len() as u64).unwrap())
  }

  fn whole_bytes(table: &Table) -> Vec<u8> {
    let mut bytes = Vec::new();
    table.write_all(&mut bytes, SCAN_BUF).unwrap();
    bytes
  }
  /// What `write_all` of a table cost, run twice in a row.
  struct Cost {
    /// Peak live bytes above the level before the first run.
    run1: i64,
    /// The same for the second run.
    run2: i64,
    /// Allocations of 64 KiB or more in the second run.
    big2: usize,
    /// Change-list reads and `Layer::read_into` calls of the second run.
    list_reads: u64,
    layer_reads: u64,
  }

  fn write_all_twice(table: &Table) -> Cost {
    use crate::test_alloc as alloc;
    let mut sink = std::io::sink();
    let before = alloc::live();
    alloc::reset_peak();
    table.write_all(&mut sink, SCAN_BUF).unwrap();
    let run1 = alloc::peak() - before;
    let before = alloc::live();
    alloc::reset_peak();
    alloc::reset_big();
    replace_layer::reset_read_counts();
    table.write_all(&mut sink, SCAN_BUF).unwrap();
    let (list_reads, layer_reads) = replace_layer::read_counts();
    Cost {
      run1,
      run2: alloc::peak() - before,
      big2: alloc::big(),
      list_reads,
      layer_reads,
    }
  }
  /// The R1 bounds of one case.
  fn assert_cost(name: &str, table: &Table) -> Cost {
    let cost = write_all_twice(table);
    eprintln!(
      "{name}: run1 {:.3} MiB, run2 {:.3} MiB, run2 big allocs {}, change-list reads {} in {} layer reads",
      cost.run1 as f64 / MIB as f64,
      cost.run2 as f64 / MIB as f64,
      cost.big2,
      cost.list_reads,
      cost.layer_reads
    );
    assert!(
      cost.run2 <= SCAN_BUF as i64 + 64 * 1024,
      "{name}: run 2 peak {}",
      cost.run2
    );
    assert_eq!(
      cost.big2, 1,
      "{name}: allocations of 64 KiB or more in run 2"
    );
    assert!(cost.run1 <= 8 * MIB, "{name}: run 1 peak {}", cost.run1);
    let bound = replace_layer::sequential_read_bound(table) + 64 * cost.layer_reads;
    assert!(
      cost.list_reads <= bound,
      "{name}: {} change-list reads, bound {bound}",
      cost.list_reads
    );
    cost
  }
  /// A 4 MiB file of `unit` with every `qq` dropped: the cost of `write_all` of
  /// (a) the forward table, (b) an inverse layer over the saved bytes, (c) a
  /// forward layer over (b). Every layer is new, so its first read is cold.
  fn costs_of(name: &str, unit: &[u8], insert_sep: &str) -> [Cost; 3] {
    let dir = tempdir().unwrap();
    let path = dir.path().join("m.txt");
    let content = repeated(unit, 4 << 20);
    fs::write(&path, &content).unwrap();
    let list = drop_all(dir.path(), &content, b"qq", insert_sep);
    let forward = replace_layer::stack(1, Dir::Forward, file_table(&path), list.clone());
    let a = assert_cost(&format!("{name} (a) forward"), &forward);
    let saved = dir.path().join("s.txt");
    fs::write(&saved, whole_bytes(&forward)).unwrap();
    let inverse = replace_layer::stack(2, Dir::Inverse, file_table(&saved), list.clone());
    let b = assert_cost(&format!("{name} (b) inverse after save"), &inverse);
    let redo = replace_layer::stack(3, Dir::Forward, inverse, list);
    let c = assert_cost(&format!("{name} (c) redo over inverse"), &redo);
    [a, b, c]
  }

  #[test]
  fn writing_a_table_over_replace_layers_holds_a_few_buffers() {
    let sparse_unit = [vec![b'x'; 61], b"qq\n".to_vec()].concat();
    let sparse = costs_of("sparse", &sparse_unit, "\n");
    for (name, unit, insert_sep) in [
      ("dense", b"aqq\n".as_slice(), "\n"),
      ("junction LF", b"\rqq\n".as_slice(), "\n"),
      ("junction CRLF", b"\rqq\n".as_slice(), "\r\n"),
    ] {
      let costs = costs_of(name, unit, insert_sep);
      for step in 0..3 {
        assert!(
          costs[step].run1 <= sparse[step].run1 + MIB,
          "{name} step {step}: run 1 peak {} against sparse {}",
          costs[step].run1,
          sparse[step].run1
        );
      }
    }
  }

  #[test]
  fn writing_two_stacked_forward_layers_holds_a_few_buffers() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("m.txt");
    let content = repeated(b"aqq\n", 4 << 20);
    fs::write(&path, &content).unwrap();
    let first = replace_layer::stack(
      1,
      Dir::Forward,
      file_table(&path),
      drop_all(dir.path(), &content, b"qq", "\n"),
    );
    let once = whole_bytes(&first);
    let second = replace_layer::stack(
      2,
      Dir::Forward,
      first,
      drop_all(dir.path(), &once, b"a", "\n"),
    );
    let cost = write_all_twice(&second);
    eprintln!(
      "forward over forward: run2 {:.3} MiB",
      cost.run2 as f64 / MIB as f64
    );
    assert!(cost.run2 <= 6 * MIB, "run 2 peak {}", cost.run2);
  }

  #[test]
  fn one_read_of_a_whole_layer_keeps_nothing_afterwards() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("m.txt");
    let sparse_unit = [vec![b'x'; 61], b"qq\n".to_vec()].concat();
    let content = repeated(&sparse_unit, 4 << 20);
    fs::write(&path, &content).unwrap();
    let forward = replace_layer::stack(
      1,
      Dir::Forward,
      file_table(&path),
      drop_all(dir.path(), &content, b"qq", "\n"),
    );
    let before = crate::test_alloc::live();
    let whole = forward.read(0, forward.len()).unwrap();
    assert_eq!(whole.len() as u64, forward.len());
    drop(whole);
    let kept = crate::test_alloc::live() - before;
    eprintln!("retained after one whole read: {kept} bytes");
    assert!(kept <= 256 * 1024, "{kept} bytes kept");
  }
}
/// Junction rewrites: a lone `\r` that an edit would join to a `\n` is rewritten in
/// the same batch, and an LF rewrite also takes the run of `\r` before it.
#[cfg(test)]
mod junction_tests {
  use super::*;
  use tempfile::{tempdir, TempDir};
  /// A session over `content` whose index has a checkpoint every `interval`.
  fn open_at(dir: &TempDir, content: &[u8], interval: u64) -> Session {
    let path = dir.path().join("junction.txt");
    fs::write(&path, content).unwrap();
    let (total, checkpoints, newlines) =
      scan_reader_at(File::open(&path).unwrap(), 4096, interval).unwrap();
    let index = OriginalIndex::new(
      Src::File(File::open(&path).unwrap()),
      total,
      newlines,
      checkpoints.clone(),
    );
    let checkpoint_index = CheckpointIndex {
      checkpoints,
      total_newlines: newlines,
      line_rule: LINE_RULE,
    };
    Session::new(
      PieceTable::new(index),
      path.clone(),
      fingerprint_of(&path).unwrap(),
      checkpoint_index,
      0,
    )
  }
  /// One edit of a batch: `(start, end, text, rewrite)`; a rewrite carries
  /// `keep_start` and `cascade`.
  type Item<'a> = (u64, u64, &'a str, bool);
  fn batch(items: &[Item]) -> Vec<Edit> {
    items
      .iter()
      .map(|&(start, end, text, rewrite)| Edit {
        start,
        end,
        text: text.to_string(),
        keep_start: rewrite,
        cascade: rewrite,
      })
      .collect()
  }
  /// The document after `items`, written out directly: edits in descending
  /// `(start, end)` order, then every LF rewrite turns the `\r` bytes before it
  /// into `\n`. The rewrite bytes are tracked by tag, not by arithmetic.
  fn flat(content: &[u8], items: &[Item]) -> Vec<u8> {
    let mut bytes: Vec<(u8, bool)> = content.iter().map(|&b| (b, false)).collect();
    let mut ordered = items.to_vec();
    ordered.sort_by_key(|i| std::cmp::Reverse((i.0, i.1)));
    for (start, end, text, rewrite) in ordered {
      bytes.splice(
        start as usize..end as usize,
        text.bytes().map(|b| (b, rewrite)),
      );
    }
    for i in 0..bytes.len() {
      if bytes[i].1 && bytes[i].0 == b'\n' && !(i > 0 && bytes[i - 1] == (b'\r', true)) {
        let mut from = i;
        while from > 0 && bytes[from - 1].0 == b'\r' {
          from -= 1;
        }
        for byte in &mut bytes[from..i] {
          byte.0 = b'\n';
        }
      }
    }
    bytes.into_iter().map(|(b, _)| b).collect()
  }

  fn rule_starts(c: &[u8]) -> Vec<u64> {
    let mut starts = vec![0u64];
    for i in 0..c.len() {
      if c[i] == b'\n' || (c[i] == b'\r' && c.get(i + 1) != Some(&b'\n')) {
        starts.push(i as u64 + 1);
      }
    }
    starts
  }
  /// The session's bytes and line structure equal `flat`. `full` checks every
  /// line start, else the count and a few lines.
  fn assert_is(s: &Session, flat: &[u8], full: bool, what: &str) {
    assert_eq!(s.table.len(), flat.len() as u64, "{what}: length");
    if flat.len() <= 4096 {
      assert_eq!(
        s.table.read(0, s.table.len()).unwrap(),
        flat,
        "{what}: bytes"
      );
    }
    let starts = rule_starts(flat);
    let lines = if flat.is_empty() {
      0
    } else {
      starts.len() as u64
    };
    assert_eq!(s.table.line_count(), lines, "{what}: line count");
    let picks: Vec<u64> = if full {
      (0..lines).collect()
    } else {
      [0, lines / 3, lines / 2, lines.saturating_sub(1)]
        .into_iter()
        .filter(|&l| l < lines)
        .collect()
    };
    for line in picks {
      assert_eq!(
        s.table.line_to_offset(line).unwrap(),
        starts[line as usize],
        "{what}: start of line {line}"
      );
    }
  }
  /// Apply `items`, undo, redo: each state equals the flat model.
  fn round_trip(content: &[u8], items: &[Item], interval: u64, full: bool, what: &str) {
    let dir = tempdir().unwrap();
    let mut s = open_at(&dir, content, interval);
    let after = flat(content, items);
    s.apply(batch(items), true).unwrap();
    assert_is(&s, &after, full, &format!("{what}: apply"));
    s.undo().unwrap();
    assert_is(&s, content, full, &format!("{what}: undo"));
    s.redo().unwrap();
    assert_is(&s, &after, full, &format!("{what}: redo"));
    s.undo().unwrap();
    assert_is(&s, content, full, &format!("{what}: undo again"));
  }

  #[test]
  fn a_window_knows_its_neighbours() {
    let dir = tempdir().unwrap();
    // Lines: `a\r`, `b\r\n`, `\n`, `c\n`, and a last one holding `d`.
    let s = open_at(&dir, b"a\rb\r\n\nc\nd", 4);
    let read = |from: u64, to: u64| {
      let w = read_window_result(&s.table, from, to).unwrap();
      (w.start_offset, w.end_offset, w.prev_lone_cr, w.next_is_lf)
    };
    // The start of the file has nothing before it; the end has nothing after.
    assert_eq!(read(0, 1), (0, 2, false, false));
    assert_eq!(read(0, 5), (0, 9, false, false));
    // After the lone `\r`, and before the `\n` of the empty line that follows.
    assert_eq!(read(1, 2), (2, 5, true, true));
    // After a CRLF (the byte before is its `\n`), and before other bytes.
    assert_eq!(read(2, 3), (5, 6, false, false));
    assert_eq!(read(3, 5), (6, 9, false, false));
    let s = open_at(&dir, b"a\n\nb\r", 4);
    let w = read_window_result(&s.table, 0, 1).unwrap();
    assert!(w.next_is_lf && !w.prev_lone_cr);
    // A file ending in a lone `\r`: the last window has nothing after it.
    let w = read_window_result(&s.table, 2, 3).unwrap();
    assert_eq!((w.start_offset, w.end_offset), (3, 5));
    assert!(!w.next_is_lf && !w.prev_lone_cr);
  }

  #[test]
  fn an_enter_after_a_lone_cr_is_rewritten_and_undone() {
    // `x\ry`: Enter at the start of `y` inserts `\n`, which would join the `\r`.
    let items: &[Item] = &[(2, 2, "\n", false), (1, 2, "\n", true)];
    round_trip(b"x\ry", items, 3, true, "LF");
    // The same step in the journal: the undo edit puts the `\r` back and keeps
    // its start anchored.
    let dir = tempdir().unwrap();
    let mut s = open_at(&dir, b"x\ry", 3);
    s.apply(batch(items), true).unwrap();
    let undone = s.undo().unwrap();
    assert_eq!(
      serde_json::to_value(&undone.edits).unwrap(),
      serde_json::json!([
        { "start": 2, "end": 3, "text": "", "keep_start": false, "fill": null },
        { "start": 1, "end": 2, "text": "\r", "keep_start": true, "fill": null },
      ])
    );
    let redone = s.redo().unwrap();
    assert_eq!(
      serde_json::to_value(&redone.edits).unwrap(),
      serde_json::json!([
        { "start": 1, "end": 2, "text": "\n", "keep_start": true, "fill": null },
        { "start": 2, "end": 2, "text": "\n", "keep_start": false, "fill": null },
      ])
    );
  }

  #[test]
  fn deleting_between_a_lone_cr_and_an_lf_keeps_both_lines() {
    // `x\rmid\nt`: deleting `mid` would join the `\r` to the `\n`.
    for (sep, expected) in [("\n", &b"x\n\nt"[..]), ("\r\n", b"x\r\n\nt")] {
      let items: &[Item] = &[(2, 5, "", false), (1, 2, sep, true)];
      assert_eq!(flat(b"x\rmid\nt", items), expected);
      round_trip(b"x\rmid\nt", items, 3, true, sep);
    }
  }

  #[test]
  fn a_cascade_takes_the_whole_run_of_cr() {
    // Runs of 1, 2, 3, 1000, across checkpoints, at the start of the file.
    for run in [1usize, 2, 3, 1000] {
      for lead in [&b""[..], b"x", b"head\nxx"] {
        let mut content = lead.to_vec();
        content.extend(std::iter::repeat_n(b'\r', run));
        content.extend_from_slice(b"tail\nend");
        let last = (lead.len() + run - 1) as u64;
        let at = last + 1;
        // Enter at the start of `tail`: the run's last `\r` would join it.
        let enter: &[Item] = &[(at, at, "\n", false), (last, at, "\n", true)];
        let after = flat(&content, enter);
        let n = after.iter().filter(|&&b| b == b'\n').count();
        assert!(n > run, "the model turned the run into LF");
        round_trip(
          &content,
          enter,
          7,
          run <= 3,
          &format!("enter, run {run}, lead {lead:?}"),
        );
        // The same run, with the `tail` line deleted down to its LF.
        let del: &[Item] = &[(at, at + 4, "", false), (last, at, "\n", true)];
        round_trip(
          &content,
          del,
          7,
          run <= 3,
          &format!("delete, run {run}, lead {lead:?}"),
        );
      }
    }
    // A file of nothing but `\r`, and the CR-only example from the plan.
    round_trip(
      b"x\r\r",
      &[(3, 3, "\n", false), (2, 3, "\n", true)],
      4,
      true,
      "x CR CR",
    );
    assert_eq!(
      flat(b"x\r\r", &[(3, 3, "\n", false), (2, 3, "\n", true)]),
      b"x\n\n\n"
    );
    round_trip(
      b"\r\r\r\ra",
      &[(4, 4, "\n", false), (3, 4, "\n", true)],
      2,
      true,
      "CR only",
    );
  }

  #[test]
  fn a_crlf_rewrite_does_not_cascade() {
    // `x\r\r` then a deleted line: only the last `\r` becomes `\r\n`.
    let content = b"x\r\rmid\nt";
    let items: &[Item] = &[(3, 6, "", false), (2, 3, "\r\n", true)];
    assert_eq!(flat(content, items), b"x\r\r\n\nt");
    round_trip(content, items, 3, true, "CRLF run");
  }

  #[test]
  fn a_drag_move_deleting_inside_a_run_is_handled_like_any_other_edit() {
    // `a` + three `\r` + `b`: one `\r` of the run deleted, an LF inserted after
    // the run, all in one batch.
    let content = b"a\r\r\rb";
    let items: &[Item] = &[(4, 4, "\n", false), (2, 3, "", false), (3, 4, "\n", true)];
    assert_eq!(flat(content, items), b"a\n\n\nb");
    round_trip(content, items, 3, true, "drag move");
  }

  #[test]
  fn an_insertion_and_a_rewrite_at_one_start_land_in_the_right_order() {
    // The text goes before the rewritten byte; the deletion after it makes the
    // junction (the tie rule: batches order by start and end).
    for (sep, expected) in [("\n", &b"xb\n\nt"[..]), ("\r\n", b"xb\r\n\nt")] {
      let content = b"x\rk\nt";
      let items: &[Item] = &[(1, 1, "b", false), (2, 3, "", false), (1, 2, sep, true)];
      assert_eq!(flat(content, items), expected);
      round_trip(content, items, 3, true, sep);
    }
  }

  #[test]
  fn a_rewrite_over_something_else_rejects_the_batch() {
    let dir = tempdir().unwrap();
    let mut s = open_at(&dir, b"x\ny\r", 3);
    for bad in [
      vec![(1u64, 2u64, "\n", true)],
      vec![(0, 1, "\n", true)],
      vec![(2, 3, "\n", true), (0, 0, "q", false)],
      vec![(3, 4, "ab", true)],
      vec![(2, 4, "\n", true)],
    ] {
      let items: Vec<Item> = bad.iter().map(|&(a, b, t, r)| (a, b, t, r)).collect();
      let before = s.table.len();
      assert!(s.apply(batch(&items), true).is_err(), "{items:?}");
      assert_eq!(s.table.len(), before, "the document is untouched");
      assert!(s.undo_stack.is_empty());
    }
  }

  #[test]
  fn an_edit_comes_over_json_with_or_without_the_rewrite_flags() {
    let plain: Edit = serde_json::from_str(r#"{"start":1,"end":2,"text":"a"}"#).unwrap();
    assert!(!plain.keep_start && !plain.cascade);
    let rewrite: Edit =
      serde_json::from_str(r#"{"start":1,"end":2,"text":"\n","keep_start":true,"cascade":true}"#)
        .unwrap();
    assert!(rewrite.keep_start && rewrite.cascade);
    // The rewrite as the frontend sends it, applied over a run of three `\r`;
    // the undo and the redo come back as literal JSON, the run as a `fill`.
    let dir = tempdir().unwrap();
    let mut s = open_at(&dir, b"x\r\r\ry", 3);
    let edits: Vec<Edit> = serde_json::from_str(
      r#"[{"start":4,"end":4,"text":"\n"},
          {"start":3,"end":4,"text":"\n","keep_start":true,"cascade":true}]"#,
    )
    .unwrap();
    s.apply(edits, true).unwrap();
    assert_eq!(s.table.read(0, s.table.len()).unwrap(), b"x\n\n\n\ny");
    let undone = s.undo().unwrap();
    assert_eq!(
      serde_json::to_string(&undone.edits).unwrap(),
      concat!(
        r#"[{"start":1,"end":3,"text":"","keep_start":false,"fill":"\r"},"#,
        r#"{"start":4,"end":5,"text":"","keep_start":false,"fill":null},"#,
        r#"{"start":3,"end":4,"text":"\r","keep_start":true,"fill":null}]"#
      )
    );
    assert_eq!(s.table.read(0, s.table.len()).unwrap(), b"x\r\r\ry");
    let redone = s.redo().unwrap();
    assert_eq!(
      serde_json::to_string(&redone.edits).unwrap(),
      concat!(
        r#"[{"start":3,"end":4,"text":"\n","keep_start":true,"fill":null},"#,
        r#"{"start":4,"end":4,"text":"\n","keep_start":false,"fill":null},"#,
        r#"{"start":1,"end":3,"text":"","keep_start":false,"fill":"\n"}]"#
      )
    );
    assert_eq!(s.table.read(0, s.table.len()).unwrap(), b"x\n\n\n\ny");
  }

  #[test]
  fn the_journal_and_the_table_do_not_grow_with_the_run() {
    // The same step over a run of 10 and of a million `\r`: the typed bytes
    // are all the add buffer gains, and the journal holds no text of the run.
    let mut grown = Vec::new();
    for run in [10usize, 1_000_000] {
      let mut content = b"h\n".to_vec();
      content.extend(std::iter::repeat_n(b'\r', run));
      content.extend_from_slice(b"tail");
      let dir = tempdir().unwrap();
      let mut s = open_at(&dir, &content, 1024 * 1024);
      let (last, at) = ((run + 1) as u64, (run + 2) as u64);
      let before = s.table.add_len();
      s.apply(
        batch(&[(at, at, "\n", false), (last, at, "\n", true)]),
        true,
      )
      .unwrap();
      grown.push(s.table.add_len() - before);
      let Some(Step {
        entry: JournalEntry::Edits(group),
        ..
      }) = s.undo_stack.last()
      else {
        panic!("one edit group");
      };
      let held: usize = group.iter().map(|e| e.text.len()).sum();
      assert!(held <= 2, "the group holds {held} bytes of text");
      assert_eq!(group.iter().filter(|e| e.fill.is_some()).count(), 1);
      let undone = s.undo().unwrap();
      assert_eq!(undone.edits.iter().map(|e| e.text.len()).sum::<usize>(), 1);
      assert_is(&s, &content, false, "undo");
      s.redo().unwrap();
      assert_eq!(s.table.len(), content.len() as u64 + 1);
      assert_eq!(s.table.line_count(), run as u64 + 3);
    }
    assert_eq!(grown[0], grown[1], "typed bytes only");
    assert_eq!(grown[0], 2);
  }
}

/// Guards the broader "heavy file I/O must not run on the UI thread" rule (see
/// the doc comment on `windows.rs`'s window-builder rule, which this extends).
/// Same technique as `window_command_threading_tests` in `windows.rs`: reads its
/// own source text and asserts each listed command is `#[tauri::command(async)]`,
/// since a blocking one would run scan/save I/O proportional to file size on the
/// main thread and freeze every window's repaint until it finishes.
#[cfg(test)]
mod heavy_io_command_threading_tests {
  const SOURCE: &str = include_str!("windowed.rs");
  const MUST_RUN_OFF_THE_MAIN_THREAD: &[&str] = &[
    "windowed_open",
    "windowed_reopen",
    "windowed_save",
    "windowed_set_path",
    "windowed_read",
    "windowed_apply",
    "windowed_undo",
    "windowed_redo",
    "windowed_close",
    "windowed_find",
    "windowed_search",
    "windowed_replace_all",
    "windowed_map_replace",
    "windowed_release_replace",
    "windowed_offset_line",
  ];

  #[test]
  fn every_heavy_io_command_is_async() {
    for name in MUST_RUN_OFF_THE_MAIN_THREAD {
      let needle = format!("pub fn {name}");
      let at = SOURCE
        .find(&needle)
        .unwrap_or_else(|| panic!("{name} is listed here but no longer exists in windowed.rs"));
      let attribute = SOURCE[..at].trim_end();
      assert!(
        attribute.ends_with("#[tauri::command(async)]"),
        "{name} must be #[tauri::command(async)]: a blocking command doing \
         O(file size) work freezes repaint on every window while it runs"
      );
    }
  }

  #[test]
  fn every_command_that_touches_a_session_waits_for_a_running_pass() {
    // A replace-all marks its session busy; these take the session through
    // `lock_idle`, which waits, so none lands between two chunks of the pass.
    for name in [
      "windowed_read",
      "windowed_apply",
      "windowed_undo",
      "windowed_redo",
    ] {
      let at = SOURCE
        .find(&format!("pub fn {name}"))
        .unwrap_or_else(|| panic!("{name} is gone"));
      let body = &SOURCE[at..];
      let body = &body[..body.find("\n}\n").unwrap()];
      assert!(
        body.contains("lock_idle"),
        "{name} must wait for a running pass"
      );
    }
    for core in [
      "fn save_core",
      "fn set_path_core",
      "fn close_core",
      "fn map_replace_core",
      "fn release_replace_core",
      "fn offset_line_core",
      "fn find_once",
      "fn search_core",
    ] {
      let at = SOURCE
        .find(core)
        .unwrap_or_else(|| panic!("{core} is gone"));
      let body = &SOURCE[at..];
      let body = &body[..body.find("\n}\n").unwrap()];
      assert!(
        body.contains("lock_idle"),
        "{core} must wait for a running pass"
      );
    }
  }

  #[test]
  fn the_guard_would_notice_a_dropped_async() {
    // Proves the assertion above can fail, against a command not in the list.
    let at = SOURCE
      .find("pub fn windowed_index")
      .expect("windowed_index");
    let attribute = SOURCE[..at].trim_end();
    assert!(attribute.ends_with("#[tauri::command]"));
    assert!(!attribute.ends_with("#[tauri::command(async)]"));
  }
}
