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

use crate::piece_table::{OriginalIndex, PieceTable};
use crate::range_edit::{Fingerprint, FINGERPRINT_MISMATCH};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

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

/// Protocol error strings returned when there is nothing left to undo / redo. The
/// frontend keys silent no-ops off these exact values.
const NOTHING_TO_UNDO: &str = "nothing-to-undo";
const NOTHING_TO_REDO: &str = "nothing-to-redo";

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

/// One reversible replace in global byte coordinates: replace `[start, end)` with
/// `text`. Stored inverses undo a forward apply; applied in the frame current when
/// each is reached (see `Session::apply` / `apply_inverse_group`).
struct InverseEdit {
  start: u64,
  end: u64,
  text: String,
}

/// The inverse edits of one coalesced undo step, in the order the forward edits
/// were applied. Undone by reverse-order sequential application, which walks the
/// document back through each intermediate state in its own coordinate frame.
type EditGroup = Vec<InverseEdit>;

/// A live editing session: the piece table over the file, the path it was opened
/// from (updated on save-as), the file's fingerprint at open / last save, the
/// checkpoint index that produced the table's `OriginalIndex` plus the sampled
/// digest computed against it (kept alongside so the frontend can read them
/// back out for persistence — see `windowed_index`), and the global-coordinate
/// undo/redo journal.
struct Session {
  table: PieceTable<File>,
  path: PathBuf,
  fingerprint: Fingerprint,
  index: CheckpointIndex,
  digest: u64,
  /// Undo groups, oldest first; each entry undoes one coalesced edit step.
  undo_stack: Vec<EditGroup>,
  /// Redo groups, populated by undo and cleared by any fresh apply.
  redo_stack: Vec<EditGroup>,
}

/// Serializable form of the sparse line-checkpoint index `OriginalIndex` holds:
/// the `(offset, newlines_before_offset)` checkpoint pairs plus the original's
/// total newline count. Compact by construction — a 512-entry array of two
/// `u64`s each is the whole cost, no per-entry object wrapper — since this
/// crosses the IPC boundary and gets written into a JSON snapshot. See
/// `OriginalIndex` for the checkpoint contract this must satisfy: ascending
/// offsets seeded with `(0, 0)`, each carrying the newline count strictly
/// before it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CheckpointIndex {
  pub checkpoints: Vec<(u64, u64)>,
  pub total_newlines: u64,
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
  next_id: AtomicU64,
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
}

/// Current global document statistics after a mutating command.
#[derive(Serialize)]
pub struct DocStats {
  pub total_bytes: u64,
  pub total_lines: u64,
}

/// Result of a successful save: the rewritten file's fingerprint plus the current
/// document statistics (unchanged by the write, but returned for symmetry).
#[derive(Debug, Serialize)]
pub struct SaveResult {
  pub fingerprint: Fingerprint,
  pub total_bytes: u64,
  pub total_lines: u64,
}

/// A single replace expressed in global byte coordinates of the pre-apply
/// document: replace `[start, end)` with `text`.
#[derive(serde::Deserialize)]
pub struct Edit {
  pub start: u64,
  pub end: u64,
  pub text: String,
}

/// One global-byte edit an undo/redo just applied: replace `[start, end)` with
/// `text`, in the document frame current when the frontend receives it.
#[derive(Serialize, Debug)]
pub struct AppliedEdit {
  pub start: u64,
  pub end: u64,
  pub text: String,
}

/// Result of a successful undo/redo: the edits just applied (in application order),
/// the 0-based line of the first edit's start (for a jump-to-change window reload),
/// and the current document statistics.
#[derive(Serialize, Debug)]
pub struct UndoResult {
  pub edits: Vec<AppliedEdit>,
  pub first_line: u64,
  pub total_bytes: u64,
  pub total_lines: u64,
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

/// A scan pass's `(total_bytes, checkpoints, total_newlines)` result.
type ScanResult = (u64, Vec<(u64, u64)>, u64);

/// Single streaming pass over `reader`: builds the sparse line-checkpoint index
/// and validates the whole stream as UTF-8, carrying an incomplete trailing
/// multi-byte sequence across buffer boundaries. Returns `(total_bytes,
/// checkpoints, total_newlines)`, where `checkpoints` is seeded with `(0, 0)` and
/// carries one `(offset, newlines_before_offset)` entry per `CHECKPOINT_INTERVAL`
/// bytes (see `OriginalIndex`). Any invalid byte, or a stream that ends
/// mid-character, returns the `NOT_UTF8` protocol error.
fn scan_reader<R: Read>(mut reader: R, buf_size: usize) -> Result<ScanResult, String> {
  let mut checkpoints: Vec<(u64, u64)> = vec![(0, 0)];
  let mut last_checkpoint: u64 = 0;
  let mut newlines: u64 = 0;
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
    // Newline scan runs on the raw chunk: a carried byte is always a UTF-8
    // lead or continuation byte, never 0x0A, so it cannot hide a line break.
    for (i, &b) in chunk.iter().enumerate() {
      let abs = pos + i as u64;
      // Record a checkpoint when this byte opens a new interval; `newlines`
      // is the count strictly before `abs`, matching the checkpoint contract.
      if abs - last_checkpoint >= CHECKPOINT_INTERVAL {
        checkpoints.push((abs, newlines));
        last_checkpoint = abs;
      }
      if b == b'\n' {
        newlines += 1;
      }
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
  Ok((pos, checkpoints, newlines))
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
fn build_table(
  path: &Path,
) -> Result<(PieceTable<File>, u64, Fingerprint, CheckpointIndex, u64), String> {
  let (total_bytes, checkpoints, total_newlines) = scan_file(path)?;
  let fingerprint = fingerprint_of(path)?;
  let digest = sample_digest(path, total_bytes, &checkpoints)?;
  let file = File::open(path).map_err(|e| e.to_string())?;
  let index = OriginalIndex::new(file, total_bytes, total_newlines, checkpoints.clone());
  let table = PieceTable::new(index);
  let checkpoint_index = CheckpointIndex {
    checkpoints,
    total_newlines,
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
/// Rejects an empty index for a non-empty file, a first checkpoint other than
/// the required `(0, 0)` seed, non-ascending offsets, any offset at or past
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
fn line_offset(table: &PieceTable<File>, line: u64) -> Result<u64, String> {
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
    }
    // Empty batches carry no reversible effect; skip journaling entirely.
    if edits.is_empty() {
      return Ok(DocStats {
        total_bytes: self.table.len(),
        total_lines: self.table.line_count(),
      });
    }
    // Build the inverse group in post-apply coordinates before any mutation.
    // `removed` is the text currently under each edit (valid UTF-8 by the
    // caller's boundary contract); `pstart` tracks where the replacement lands
    // once every lower-offset edit's length change has shifted it.
    let mut ascending: Vec<&Edit> = edits.iter().collect();
    ascending.sort_by_key(|a| a.start);
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
      });
      cumshift += text_len as i64 - (edit.end - edit.start) as i64;
    }
    // Apply back-to-front so a lower-offset edit's coordinates stay valid.
    let mut ordered: Vec<&Edit> = edits.iter().collect();
    ordered.sort_by_key(|b| std::cmp::Reverse(b.start));
    for edit in ordered {
      self.table.delete(edit.start, edit.end)?;
      self.table.insert(edit.start, edit.text.as_bytes())?;
    }
    let coalesce = !new_group && !self.undo_stack.is_empty() && self.redo_stack.is_empty();
    self.redo_stack.clear();
    if coalesce {
      self.undo_stack.last_mut().unwrap().extend(inverses);
    } else {
      self.undo_stack.push(inverses);
      if self.undo_stack.len() > UNDO_LIMIT {
        self.undo_stack.remove(0);
      }
    }
    Ok(DocStats {
      total_bytes: self.table.len(),
      total_lines: self.table.line_count(),
    })
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
      let removed = self.table.read(inv.start, inv.end)?;
      let removed = String::from_utf8(removed).map_err(|_| NOT_UTF8.to_string())?;
      let text_len = inv.text.len() as u64;
      opposite.push(InverseEdit {
        start: inv.start,
        end: inv.start + text_len,
        text: removed,
      });
      self.table.delete(inv.start, inv.end)?;
      self.table.insert(inv.start, inv.text.as_bytes())?;
      applied.push(AppliedEdit {
        start: inv.start,
        end: inv.end,
        text: inv.text.clone(),
      });
    }
    Ok((applied, opposite))
  }

  /// Pop and apply the newest undo group, pushing its opposite onto the redo
  /// stack. Errors with `NOTHING_TO_UNDO` when the stack is empty.
  fn undo(&mut self) -> Result<UndoResult, String> {
    let group = self
      .undo_stack
      .pop()
      .ok_or_else(|| NOTHING_TO_UNDO.to_string())?;
    let (applied, opposite) = self.apply_inverse_group(group)?;
    self.redo_stack.push(opposite);
    Ok(self.outcome(applied))
  }

  /// Pop and apply the newest redo group, pushing its opposite back onto the undo
  /// stack. Errors with `NOTHING_TO_REDO` when the stack is empty.
  fn redo(&mut self) -> Result<UndoResult, String> {
    let group = self
      .redo_stack
      .pop()
      .ok_or_else(|| NOTHING_TO_REDO.to_string())?;
    let (applied, opposite) = self.apply_inverse_group(group)?;
    self.undo_stack.push(opposite);
    Ok(self.outcome(applied))
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
  let session = Session {
    table,
    path,
    fingerprint: fingerprint.clone(),
    index,
    digest,
    undo_stack: Vec::new(),
    redo_stack: Vec::new(),
  };
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
      file,
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
  let session = Session {
    table,
    path,
    fingerprint: out_fingerprint.clone(),
    index: out_index,
    digest: out_digest,
    undo_stack: Vec::new(),
    redo_stack: Vec::new(),
  };
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
#[tauri::command]
pub fn windowed_read(
  state: State<WindowedState>,
  session_id: u64,
  start_line: u64,
  end_line: u64,
) -> Result<WindowResult, String> {
  let map = state.sessions.lock().unwrap();
  let session = map
    .get(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  let table = &session.table;
  let total_lines = table.line_count();
  let total_bytes = table.len();
  let start_line = start_line.min(total_lines);
  let end_line = end_line.clamp(start_line, total_lines);
  let start_offset = line_offset(table, start_line)?;
  let end_offset = line_offset(table, end_line)?;
  let bytes = table.read(start_offset, end_offset)?;
  let text = String::from_utf8(bytes).map_err(|_| NOT_UTF8.to_string())?;
  Ok(WindowResult {
    text,
    start_offset,
    end_offset,
    start_line,
    total_lines,
    total_bytes,
  })
}

/// Apply a batch of global-coordinate replaces to a session. The caller guarantees
/// the edits are mutually non-overlapping and all expressed in the same pre-apply
/// coordinate space; applying them by descending `start` keeps every earlier
/// edit's coordinates valid. All bounds are validated before any mutation, so an
/// out-of-range edit rejects the whole batch and leaves the session untouched.
/// `new_group` controls undo coalescing (see `Session::apply`).
#[tauri::command]
pub fn windowed_apply(
  state: State<WindowedState>,
  session_id: u64,
  edits: Vec<Edit>,
  new_group: bool,
) -> Result<DocStats, String> {
  let mut map = state.sessions.lock().unwrap();
  let session = map
    .get_mut(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  session.apply(edits, new_group)
}

/// Undo the newest edit group: apply its inverse into the piece table and move it
/// to the redo stack. Returns the applied global-byte edits (for the frontend to
/// mirror into its window) plus the jump-to-change line and fresh statistics. An
/// empty undo stack returns the `NOTHING_TO_UNDO` protocol error for a silent skip.
#[tauri::command]
pub fn windowed_undo(state: State<WindowedState>, session_id: u64) -> Result<UndoResult, String> {
  let mut map = state.sessions.lock().unwrap();
  let session = map
    .get_mut(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  session.undo()
}

/// Redo the newest undone group (inverse of `windowed_undo`). An empty redo stack
/// returns the `NOTHING_TO_REDO` protocol error for a silent skip.
#[tauri::command]
pub fn windowed_redo(state: State<WindowedState>, session_id: u64) -> Result<UndoResult, String> {
  let mut map = state.sessions.lock().unwrap();
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
  session.table = table;
  session.path = target;
  session.fingerprint = fingerprint.clone();
  session.index = index;
  session.digest = digest;
  Ok(SaveResult {
    fingerprint,
    total_bytes,
    total_lines,
  })
}

#[tauri::command(async)]
pub fn windowed_save(
  state: State<WindowedState>,
  session_id: u64,
  expected: Option<Fingerprint>,
  path_override: Option<String>,
) -> Result<SaveResult, String> {
  let mut map = state.sessions.lock().unwrap();
  let session = map
    .get_mut(&session_id)
    .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
  save_session(session, expected, path_override.map(PathBuf::from))
}

/// Release a session and its resources. No-op if the id is unknown or already
/// closed. Remaining sessions are dropped when the app exits; no explicit cleanup
/// is needed there.
#[tauri::command]
pub fn windowed_close(state: State<WindowedState>, session_id: u64) {
  state.sessions.lock().unwrap().remove(&session_id);
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
    Session {
      table,
      path: path.to_path_buf(),
      fingerprint,
      index,
      digest,
      undo_stack: Vec::new(),
      redo_stack: Vec::new(),
    }
  }

  /// Build a global-byte `Edit` from a triple, for the journal tests.
  fn edit(start: u64, end: u64, text: &str) -> Edit {
    Edit {
      start,
      end,
      text: text.to_string(),
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

/// Guards the broader "heavy file I/O must not run on the UI thread" rule (see
/// the doc comment on `windows.rs`'s window-builder rule, which this extends).
/// Same technique as `window_command_threading_tests` in `windows.rs`: reads its
/// own source text and asserts each listed command is `#[tauri::command(async)]`,
/// since a blocking one would run scan/save I/O proportional to file size on the
/// main thread and freeze every window's repaint until it finishes.
#[cfg(test)]
mod heavy_io_command_threading_tests {
  const SOURCE: &str = include_str!("windowed.rs");
  const MUST_RUN_OFF_THE_MAIN_THREAD: &[&str] =
    &["windowed_open", "windowed_reopen", "windowed_save"];

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
  fn the_guard_would_notice_a_dropped_async() {
    // Proves the assertion above can fail, against a command not in the list.
    let at = SOURCE
      .find("pub fn windowed_close")
      .expect("windowed_close");
    let attribute = SOURCE[..at].trim_end();
    assert!(attribute.ends_with("#[tauri::command]"));
    assert!(!attribute.ends_with("#[tauri::command(async)]"));
  }
}
