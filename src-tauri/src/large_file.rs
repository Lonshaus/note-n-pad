// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::clipboard_store::{self, ClipOutcome, ClipWriter, Written};
use crate::line_rule::{breaks_before, BreakCounter};
use crate::windowed::{WindowedState, SCAN_CHUNK};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
/// Upper bound on a single `read_chunk` request (4 MiB) so a bad `len` can't ask
/// the backend to allocate an unbounded buffer.
const MAX_CHUNK_LEN: u32 = 4 * 1024 * 1024;
/// Byte window the search thread reads per iteration. Large relative to any sane
/// query so a match can straddle at most one chunk boundary.
const SEARCH_CHUNK: usize = 256 * 1024;
/// Emit an index-progress event at most once per this many bytes scanned.
const INDEX_PROGRESS_BYTES: u64 = 4 * 1024 * 1024;
/// Preview length (in characters) for a search hit's line.
const PREVIEW_CHARS: usize = 200;
/// Managed state holding in-flight line indexes and cancellable searches.
#[derive(Default)]
pub struct LargeFileState {
  indexes: Mutex<HashMap<String, LineIndex>>,
  searches: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl LargeFileState {
  /// The checkpoints of the fullest index of `path`, or just the file's start
  /// when it has none.
  fn checkpoints_of(&self, path: &Path) -> Vec<(u64, u64)> {
    let map = self.indexes.lock().unwrap();
    map
      .values()
      .filter(|index| index.path == path)
      .max_by_key(|index| index.checkpoints.len())
      .map_or_else(|| vec![(0, 0)], |index| index.checkpoints.clone())
  }
}
/// A byte-offset index over a file's lines. Checkpoints are `(line, byte offset
/// of that line's start)` recorded every `interval` lines, always seeded with
/// `(0, 0)`. `total_lines` is `None` until the background scan completes, and
/// stays `None` with `failed` set when the scan died.
struct LineIndex {
  path: PathBuf,
  checkpoints: Vec<(u64, u64)>,
  total_lines: Option<u64>,
  failed: bool,
}
/// Where an index's background scan stands, as `index_line_count` reports it.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "state", content = "lines", rename_all = "lowercase")]
pub enum IndexStatus {
  Running,
  Done(u64),
  Failed,
}

fn index_status(index: &LineIndex) -> IndexStatus {
  if index.failed {
    IndexStatus::Failed
  } else {
    match index.total_lines {
      Some(total) => IndexStatus::Done(total),
      None => IndexStatus::Running,
    }
  }
}
/// Look an index up by id and report its scan status.
fn status_of(indexes: &Mutex<HashMap<String, LineIndex>>, id: &str) -> Result<IndexStatus, String> {
  let map = indexes.lock().unwrap();
  let index = map.get(id).ok_or_else(|| "unknown index id".to_string())?;
  Ok(index_status(index))
}
/// Record that an index's scan failed, unless the index was already dropped.
fn mark_failed(indexes: &Mutex<HashMap<String, LineIndex>>, id: &str) {
  if let Some(entry) = indexes.lock().unwrap().get_mut(id) {
    entry.failed = true;
  }
}

#[derive(Serialize)]
pub struct FileStat {
  pub size: u64,
}

#[derive(Serialize)]
pub struct Chunk {
  pub text: String,
  pub start: u64,
  pub end: u64,
}

#[derive(Clone, Serialize)]
struct IndexProgress {
  id: String,
  lines: u64,
  bytes: u64,
  done: bool,
  /// `true` only on the terminal event of a scan that failed (open error or a
  /// mid-scan I/O error). `false` on every progress event and on a successful
  /// terminal event.
  error: bool,
}

#[derive(Clone, Serialize)]
struct SearchHit {
  search_id: String,
  offset: u64,
  line: u64,
  preview: String,
}

#[derive(Clone, Serialize)]
struct SearchDone {
  search_id: String,
  hits: u64,
  truncated: bool,
  /// `true` when the scan failed (open error or a mid-scan I/O error) instead
  /// of finishing normally; `hits` is then meaningless and must not be read as
  /// "0 matches found".
  error: bool,
}
/// A single search match: absolute byte offset, line number, and a preview of the
/// matched line.
struct Hit {
  offset: u64,
  line: u64,
  preview: String,
}
/// Return whether a byte is a UTF-8 continuation byte (`10xxxxxx`).
fn is_continuation(b: u8) -> bool {
  (b & 0xC0) == 0x80
}
/// Align a raw byte slice read at `offset` to UTF-8 character boundaries. Leading
/// continuation bytes (a character that began before `offset`) are dropped so
/// `start` moves forward; a trailing incomplete-but-valid sequence (a character
/// cut by the read window) is dropped so `end` moves back. Genuinely invalid
/// bytes in between are replaced lossily rather than trimmed.
fn align_chunk(bytes: &[u8], offset: u64) -> Chunk {
  // A UTF-8 character is at most 4 bytes, so at most 3 leading continuations.
  let lead = bytes
    .iter()
    .take(3)
    .take_while(|&&b| is_continuation(b))
    .count();
  let body = &bytes[lead..];
  let start = offset + lead as u64;
  let trailing = incomplete_trailing_len(body);
  let usable = &body[..body.len() - trailing];
  let end = start + usable.len() as u64;
  Chunk {
    text: String::from_utf8_lossy(usable).into_owned(),
    start,
    end,
  }
}
/// Number of trailing bytes that form an incomplete-but-otherwise-valid UTF-8
/// sequence (a multi-byte character cut off at the end of the buffer). Returns 0
/// when the slice ends on a boundary or ends with genuinely invalid bytes (those
/// are left for lossy replacement instead of being trimmed).
fn incomplete_trailing_len(b: &[u8]) -> usize {
  match std::str::from_utf8(b) {
    Ok(_) => 0,
    Err(e) => match e.error_len() {
      // `None` means "unexpected end of input": the tail is a valid prefix
      // of a character, so trim it back to the last full boundary.
      None => b.len() - e.valid_up_to(),
      // `Some` means an invalid byte mid-buffer; leave it for lossy decode.
      Some(_) => 0,
    },
  }
}
/// Read the file's size.
fn stat(path: &Path) -> Result<FileStat, String> {
  let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
  Ok(FileStat { size: meta.len() })
}
/// Read up to `len` bytes from `offset` and return them as boundary-aligned text.
fn read_chunk_at(path: &Path, offset: u64, len: u32) -> Result<Chunk, String> {
  let len = len.min(MAX_CHUNK_LEN) as u64;
  let mut file = File::open(path).map_err(|e| e.to_string())?;
  file
    .seek(SeekFrom::Start(offset))
    .map_err(|e| e.to_string())?;
  let mut buf = Vec::new();
  file
    .take(len)
    .read_to_end(&mut buf)
    .map_err(|e| e.to_string())?;
  Ok(align_chunk(&buf, offset))
}
/// Scan a reader into a line index, invoking `progress(lines, bytes)` after each
/// buffer so the caller can throttle progress reporting. Returns the checkpoints
/// (seeded with `(0, 0)`) and the total line count. Line count follows split
/// semantics: break count (see `line_rule`) plus one for a non-empty file, zero
/// for an empty one.
fn build_index<R: Read>(
  mut reader: R,
  interval: u32,
  mut progress: impl FnMut(u64, u64),
) -> Result<(Vec<(u64, u64)>, u64), String> {
  let mut checkpoints = vec![(0u64, 0u64)];
  let mut breaks = BreakCounter::new();
  let mut pos = 0u64;
  let mut any = false;
  let mut buf = [0u8; 256 * 1024];
  loop {
    let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    any = true;
    for &b in &buf[..n] {
      let before = breaks.count();
      breaks.step(b);
      if breaks.count() != before {
        // A `\n` ends its line, so the next line starts one past it; a `\r`
        // is only settled by the byte after it, which starts the next line.
        let start = if b == b'\n' { pos + 1 } else { pos };
        if interval != 0 && breaks.count() % interval as u64 == 0 {
          checkpoints.push((breaks.count(), start));
        }
      }
      pos += 1;
    }
    progress(breaks.count(), pos);
  }
  // A `\r` that ends the file settles here and starts an empty last line.
  let line = breaks.finish();
  if breaks.pending_cr() && interval != 0 && line % interval as u64 == 0 {
    checkpoints.push((line, pos));
  }
  let total = if any { line + 1 } else { 0 };
  Ok((checkpoints, total))
}
/// Nearest checkpoint at or before `line`: the last one whose line index does not
/// exceed the target. Checkpoints are ascending, so binary-search the boundary.
fn nearest_checkpoint(checkpoints: &[(u64, u64)], line: u64) -> (u64, u64) {
  let idx = checkpoints.partition_point(|&(l, _)| l <= line);
  checkpoints[idx - 1]
}
/// Error text of `offset_of_line` for a line past the file's last line.
const LINE_OUT_OF_RANGE: &str = "line out of range";
/// Byte offset of `target` line's start, scanning forward from a checkpoint that
/// begins at `start_line` / `start_offset`. Errors with `LINE_OUT_OF_RANGE` when
/// `target` lies past the file's last line.
fn offset_of_line<R: Read>(
  mut reader: R,
  start_offset: u64,
  start_line: u64,
  target: u64,
) -> Result<u64, String> {
  if target < start_line {
    return Err("line before checkpoint".to_string());
  }
  let mut need = target - start_line;
  if need == 0 {
    return Ok(start_offset);
  }
  let mut pos = start_offset;
  let mut breaks = BreakCounter::new();
  let mut buf = [0u8; 64 * 1024];
  loop {
    let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      // A `\r` that ends the file starts an empty last line.
      if breaks.pending_cr() && need == 1 {
        return Ok(pos);
      }
      return Err(LINE_OUT_OF_RANGE.to_string());
    }
    for &b in &buf[..n] {
      let before = breaks.count();
      breaks.step(b);
      if breaks.count() != before {
        need -= 1;
        if need == 0 {
          // One past a `\n`, or at the byte after a `\r`: the start of
          // `target`.
          return Ok(if b == b'\n' { pos + 1 } else { pos });
        }
      }
      pos += 1;
    }
  }
}
/// Open `path` and scan forward from `checkpoint` (line index, byte offset) to
/// the start of `line`. `Ok(None)` when `line` is past the last line.
fn line_offset_in_file(
  path: &Path,
  checkpoint: (u64, u64),
  line: u64,
) -> Result<Option<u64>, String> {
  let mut file = File::open(path).map_err(|e| e.to_string())?;
  file
    .seek(SeekFrom::Start(checkpoint.1))
    .map_err(|e| e.to_string())?;
  match offset_of_line(BufReader::new(file), checkpoint.1, checkpoint.0, line) {
    Ok(offset) => Ok(Some(offset)),
    Err(e) if e == LINE_OUT_OF_RANGE => Ok(None),
    Err(e) => Err(e),
  }
}
/// Case-aware substring search over bytes. Case-insensitive matching folds ASCII
/// letters only; non-ASCII bytes compare verbatim.
pub(crate) fn find_sub(hay: &[u8], needle: &[u8], case_sensitive: bool) -> Option<usize> {
  if needle.is_empty() || needle.len() > hay.len() {
    return None;
  }
  // ponytail: O(n*m) windowed scan, fine for interactive search; swap in memmem
  // if large-file search latency ever matters.
  if case_sensitive {
    hay.windows(needle.len()).position(|w| w == needle)
  } else {
    hay
      .windows(needle.len())
      .position(|w| w.eq_ignore_ascii_case(needle))
  }
}
/// Truncate a string to at most `max` characters (not bytes).
fn truncate_chars(s: &str, max: usize) -> String {
  match s.char_indices().nth(max) {
    Some((idx, _)) => s[..idx].to_string(),
    None => s.to_string(),
  }
}
/// Preview of the line containing the match at `idx` within `buf`, from after the
/// last `\r` or `\n` before `idx` to the first one at or after it, truncated to
/// `PREVIEW_CHARS`. A match starting at the `\n` of a `\r\n` is on the line that
/// `\r\n` ends, so that line is shown. The line may be clipped when it crosses a
/// read boundary, which is acceptable for a preview.
pub(crate) fn preview_at(buf: &[u8], idx: usize) -> String {
  let idx = if idx > 0 && buf[idx] == b'\n' && buf[idx - 1] == b'\r' {
    idx - 1
  } else {
    idx
  };
  let start = buf[..idx]
    .iter()
    .rposition(|&b| b == b'\n' || b == b'\r')
    .map(|p| p + 1)
    .unwrap_or(0);
  let end = buf[idx..]
    .iter()
    .position(|&b| b == b'\n' || b == b'\r')
    .map(|p| idx + p)
    .unwrap_or(buf.len());
  let line = String::from_utf8_lossy(&buf[start..end]);
  truncate_chars(&line, PREVIEW_CHARS)
}
/// Stream-search a reader chunk by chunk, carrying a `query.len() - 1` byte tail
/// across boundaries so a match straddling two chunks is still found. Reports each
/// hit through `on_hit` and returns `(hit count, truncated)` where `truncated` is
/// true only when `max_results` capped the results. Cancellation via `cancel`
/// stops early and reports `truncated = false`.
fn search_stream<R: Read>(
  mut reader: R,
  query: &[u8],
  case_sensitive: bool,
  max_results: u32,
  chunk_size: usize,
  cancel: &AtomicBool,
  mut on_hit: impl FnMut(Hit),
) -> Result<(u64, bool), String> {
  let m = query.len();
  let overlap = m - 1;
  let mut carry: Vec<u8> = Vec::new();
  // Absolute offset of the first byte of `combined`, and the breaks in all the
  // text before it (a final `\r` there waits for the first byte of `combined`).
  let mut base_offset: u64 = 0;
  let mut before_base = BreakCounter::new();
  let mut hits = 0u64;
  let mut buf = vec![0u8; chunk_size];
  loop {
    if cancel.load(Ordering::Relaxed) {
      return Ok((hits, false));
    }
    let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      return Ok((hits, false));
    }
    let mut combined = std::mem::take(&mut carry);
    combined.extend_from_slice(&buf[..n]);
    // Every match found here uses at least one byte from the new read (the
    // carry alone is shorter than the query), so none was reportable before.
    let mut from = 0;
    while let Some(rel) = find_sub(&combined[from..], query, case_sensitive) {
      let idx = from + rel;
      on_hit(Hit {
        offset: base_offset + idx as u64,
        line: before_base.count_before_next(combined[0]) + breaks_before(&combined, idx),
        preview: preview_at(&combined, idx),
      });
      hits += 1;
      if hits >= max_results as u64 {
        return Ok((hits, true));
      }
      if cancel.load(Ordering::Relaxed) {
        return Ok((hits, false));
      }
      from = idx + m;
      if from > combined.len() {
        break;
      }
    }
    // Keep the last `overlap` bytes as carry; advance base/line past the rest.
    let keep = overlap.min(combined.len());
    let consumed = combined.len() - keep;
    before_base.feed(&combined[..consumed]);
    base_offset += consumed as u64;
    carry = combined[consumed..].to_vec();
  }
}

#[tauri::command]
pub fn stat_file(path: String) -> Result<FileStat, String> {
  stat(Path::new(&path))
}

#[tauri::command]
pub fn read_chunk(path: String, offset: u64, len: u32) -> Result<Chunk, String> {
  read_chunk_at(Path::new(&path), offset, len)
}
/// Start building a line index in the background. Returns an id immediately; the
/// index is seeded and filled in when the scan finishes, emitting throttled
/// `large-index-progress` events along the way.
#[tauri::command]
pub fn start_line_index(
  app: AppHandle,
  state: State<LargeFileState>,
  path: String,
  interval_lines: u32,
) -> Result<String, String> {
  if interval_lines == 0 {
    return Err("interval_lines must be greater than zero".to_string());
  }
  let id = uuid::Uuid::new_v4().to_string();
  let path_buf = PathBuf::from(&path);
  state.indexes.lock().unwrap().insert(
    id.clone(),
    LineIndex {
      path: path_buf.clone(),
      checkpoints: vec![(0, 0)],
      total_lines: None,
      failed: false,
    },
  );
  let thread_id = id.clone();
  std::thread::spawn(move || {
    let file = match File::open(&path_buf) {
      Ok(f) => f,
      Err(e) => {
        log::warn!("line index open failed: {e}");
        mark_failed(&app.state::<LargeFileState>().indexes, &thread_id);
        let _ = app.emit(
          "large-index-progress",
          IndexProgress {
            id: thread_id,
            lines: 0,
            bytes: 0,
            done: true,
            error: true,
          },
        );
        return;
      }
    };
    let mut last_emit = 0u64;
    let result = build_index(BufReader::new(file), interval_lines, |lines, bytes| {
      if bytes - last_emit >= INDEX_PROGRESS_BYTES {
        last_emit = bytes;
        let _ = app.emit(
          "large-index-progress",
          IndexProgress {
            id: thread_id.clone(),
            lines,
            bytes,
            done: false,
            error: false,
          },
        );
      }
    });
    let (checkpoints, total, bytes) = match result {
      Ok((cp, total)) => {
        let bytes = cp.last().map(|&(_, o)| o).unwrap_or(0);
        (cp, total, bytes)
      }
      Err(e) => {
        log::warn!("line index scan failed: {e}");
        mark_failed(&app.state::<LargeFileState>().indexes, &thread_id);
        let _ = app.emit(
          "large-index-progress",
          IndexProgress {
            id: thread_id,
            lines: 0,
            bytes: 0,
            done: true,
            error: true,
          },
        );
        return;
      }
    };
    // Only publish if the index wasn't dropped mid-scan.
    if let Some(entry) = app
      .state::<LargeFileState>()
      .indexes
      .lock()
      .unwrap()
      .get_mut(&thread_id)
    {
      entry.checkpoints = checkpoints;
      entry.total_lines = Some(total);
    }
    let _ = app.emit(
      "large-index-progress",
      IndexProgress {
        id: thread_id,
        lines: total,
        bytes,
        done: true,
        error: false,
      },
    );
  });
  Ok(id)
}
/// Byte offset where `line` begins, using the index's nearest checkpoint and
/// scanning forward from there. `None` when `line` is past the last line.
#[tauri::command]
pub fn line_to_offset(
  state: State<LargeFileState>,
  id: String,
  line: u64,
) -> Result<Option<u64>, String> {
  let (path, checkpoint) = {
    let map = state.indexes.lock().unwrap();
    let index = map.get(&id).ok_or_else(|| "unknown index id".to_string())?;
    (
      index.path.clone(),
      nearest_checkpoint(&index.checkpoints, line),
    )
  };
  line_offset_in_file(&path, checkpoint, line)
}
/// Where the index's scan stands: still running, done with the total line count,
/// or failed. Errors with "unknown index id" once the index has been dropped.
#[tauri::command]
pub fn index_line_count(state: State<LargeFileState>, id: String) -> Result<IndexStatus, String> {
  status_of(&state.indexes, &id)
}
/// Release a line index and its memory.
#[tauri::command]
pub fn drop_line_index(state: State<LargeFileState>, id: String) {
  state.indexes.lock().unwrap().remove(&id);
}
/// What `clip_copy_file` copies: the whole file, or lines `start` to `end` (0
/// based, both included, each with its line break if it has one).
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClipRange {
  Whole,
  Lines { start: u64, end: u64 },
}
/// Core of `clip_copy_file`: the bytes of `range` of the file at `path` are
/// written to a clip file in `dir`, `chunk` bytes at a time, and invalid UTF-8
/// becomes U+FFFD as the viewer shows it. `line_offset` is the start of a line, or
/// `None` past the last. Without a folder nothing is read.
fn clip_copy_file_core(
  dir: Option<&Path>,
  path: &Path,
  range: ClipRange,
  line_offset: &dyn Fn(u64) -> Result<Option<u64>, String>,
  chunk: usize,
) -> Result<Written, String> {
  let dir = dir.ok_or_else(|| "no temp folder".to_string())?;
  let len = stat(path)?.size;
  let (start, end) = match range {
    ClipRange::Whole => (0, len),
    ClipRange::Lines { start, end } => {
      let (first, last) = (start.min(end), start.max(end));
      let from = line_offset(first)?.ok_or_else(|| LINE_OUT_OF_RANGE.to_string())?;
      let to = match last.checked_add(1) {
        Some(next) => line_offset(next)?.unwrap_or(len),
        None => len,
      };
      (from, to)
    }
  };
  let mut file = File::open(path).map_err(|e| e.to_string())?;
  file
    .seek(SeekFrom::Start(start))
    .map_err(|e| e.to_string())?;
  let mut writer = ClipWriter::create(dir, false)?;
  let mut buf = vec![0u8; chunk.max(1)];
  let mut left = end.saturating_sub(start);
  while left > 0 {
    let take = (buf.len() as u64).min(left) as usize;
    let n = file.read(&mut buf[..take]).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    writer.push(&buf[..n])?;
    left -= n as u64;
  }
  writer.finish()
}
/// Copy the whole file, or a range of its lines, to the system clipboard through
/// a clip file, so the text is never held in memory. The lines are found with the
/// file's line index when it has one. `OfferFailed` also covers every error.
/// `reservation` is the one the window made for this copy; it is released when the
/// copy ends, however it ends.
#[tauri::command(async)]
pub fn clip_copy_file(
  app: AppHandle,
  large: State<LargeFileState>,
  windowed: State<WindowedState>,
  path: String,
  range: ClipRange,
  reservation: Option<u64>,
) -> ClipOutcome {
  let _release = clipboard_store::ReleaseOnDrop(reservation);
  clipboard_store::copy(&app, || {
    let path = PathBuf::from(path);
    let checkpoints = large.checkpoints_of(&path);
    clip_copy_file_core(
      windowed.clip_dir().as_deref(),
      &path,
      range,
      &|line| line_offset_in_file(&path, nearest_checkpoint(&checkpoints, line), line),
      SCAN_CHUNK,
    )
  })
}
/// Start a background plain-text search, emitting `large-search-hit` per match and
/// a final `large-search-done`. Registers a cancellation flag under `search_id`.
#[tauri::command]
pub fn stream_search(
  app: AppHandle,
  state: State<LargeFileState>,
  path: String,
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
  let path_buf = PathBuf::from(&path);
  std::thread::spawn(move || {
    let done = |hits: u64, truncated: bool, error: bool| {
      let _ = app.emit(
        "large-search-done",
        SearchDone {
          search_id: search_id.clone(),
          hits,
          truncated,
          error,
        },
      );
      app
        .state::<LargeFileState>()
        .searches
        .lock()
        .unwrap()
        .remove(&search_id);
    };
    let file = match File::open(&path_buf) {
      Ok(f) => f,
      Err(e) => {
        log::warn!("search open failed: {e}");
        done(0, false, true);
        return;
      }
    };
    let emit_id = search_id.clone();
    let result = search_stream(
      BufReader::new(file),
      query.as_bytes(),
      case_sensitive,
      max_results,
      SEARCH_CHUNK,
      &cancel,
      |hit| {
        let _ = app.emit(
          "large-search-hit",
          SearchHit {
            search_id: emit_id.clone(),
            offset: hit.offset,
            line: hit.line,
            preview: hit.preview,
          },
        );
      },
    );
    match result {
      Ok((hits, truncated)) => done(hits, truncated, false),
      Err(e) => {
        log::warn!("search scan failed: {e}");
        done(0, false, true);
      }
    }
  });
  Ok(())
}
/// Signal a running search to stop. No-op if the id is unknown or already done.
#[tauri::command]
pub fn cancel_search(state: State<LargeFileState>, search_id: String) {
  if let Some(flag) = state.searches.lock().unwrap().get(&search_id) {
    flag.store(true, Ordering::Relaxed);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Cursor;
  use tempfile::tempdir;

  #[test]
  fn align_drops_leading_partial_char() {
    // "a中b" = 61 E4 B8 AD 62; reading from byte 2 lands mid-"中".
    let chunk = align_chunk(&[0xB8, 0xAD, 0x62], 2);
    assert_eq!(chunk.text, "b");
    assert_eq!(chunk.start, 4);
    assert_eq!(chunk.end, 5);
  }

  #[test]
  fn align_drops_trailing_partial_char() {
    // "a" + first two bytes of "中": the cut character is trimmed off the end.
    let chunk = align_chunk(&[0x61, 0xE4, 0xB8], 0);
    assert_eq!(chunk.text, "a");
    assert_eq!(chunk.start, 0);
    assert_eq!(chunk.end, 1);
  }

  #[test]
  fn align_keeps_whole_emoji() {
    // "😀" = F0 9F 98 80, a full 4-byte character read whole.
    let chunk = align_chunk(&[0xF0, 0x9F, 0x98, 0x80], 10);
    assert_eq!(chunk.text, "😀");
    assert_eq!(chunk.start, 10);
    assert_eq!(chunk.end, 14);
  }

  #[test]
  fn align_replaces_invalid_bytes_lossily() {
    // A stray invalid byte in the middle is replaced, not trimmed or panicked.
    let chunk = align_chunk(&[0x61, 0xFF, 0x62], 0);
    assert!(chunk.text.starts_with('a') && chunk.text.ends_with('b'));
    assert_eq!(chunk.end - chunk.start, 3);
  }

  #[test]
  fn read_chunk_aligns_across_multibyte_boundary() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("multi.txt");
    // "a中b😀c" — offsets: a=0, 中=1..4, b=4, 😀=5..9, c=9.
    std::fs::write(&path, "a中b😀c").unwrap();
    // Start mid-"中" (offset 2) with a length that cuts mid-"😀".
    let chunk = read_chunk_at(&path, 2, 5).unwrap();
    // No half characters: valid round-trip, boundaries advanced past "中".
    assert!(chunk.text.chars().all(|c| c != char::REPLACEMENT_CHARACTER));
    assert_eq!(chunk.start, 4);
    assert!(chunk.text.starts_with('b'));
  }

  #[test]
  fn read_chunk_past_eof_is_empty() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("small.txt");
    std::fs::write(&path, "abc").unwrap();
    let chunk = read_chunk_at(&path, 100, 10).unwrap();
    assert_eq!(chunk.text, "");
    assert_eq!(chunk.start, 100);
    assert_eq!(chunk.end, 100);
  }

  #[test]
  fn index_counts_lines_without_trailing_newline() {
    let (_, total) = build_index(Cursor::new("line0\nline1\nline2"), 1, |_, _| {}).unwrap();
    assert_eq!(total, 3);
  }

  #[test]
  fn index_counts_lines_with_trailing_newline() {
    let (_, total) = build_index(Cursor::new("a\nb\n"), 1, |_, _| {}).unwrap();
    assert_eq!(total, 3);
  }

  #[test]
  fn index_empty_file_has_zero_lines() {
    let (cp, total) = build_index(Cursor::new(""), 1, |_, _| {}).unwrap();
    assert_eq!(total, 0);
    assert_eq!(cp, vec![(0, 0)]);
  }

  #[test]
  fn offset_of_line_within_and_across_interval() {
    // "line0\nline1\nline2": line starts at bytes 0, 6, 12.
    let content = "line0\nline1\nline2";
    // Interval 2 records checkpoints for lines 0 and 2 only, so line 1 must be
    // reached by scanning forward from the line-0 checkpoint.
    let (cp, _) = build_index(Cursor::new(content), 2, |_, _| {}).unwrap();
    assert_eq!(cp, vec![(0, 0), (2, 12)]);
    // Line 1 is inside the interval (scanned from checkpoint 0).
    let c0 = nearest_checkpoint(&cp, 1);
    let mut r = Cursor::new(content);
    r.seek(SeekFrom::Start(c0.1)).unwrap();
    assert_eq!(offset_of_line(r, c0.1, c0.0, 1).unwrap(), 6);
    // Line 2 lands exactly on a checkpoint.
    let c2 = nearest_checkpoint(&cp, 2);
    let mut r = Cursor::new(content);
    r.seek(SeekFrom::Start(c2.1)).unwrap();
    assert_eq!(offset_of_line(r, c2.1, c2.0, 2).unwrap(), 12);
  }

  #[test]
  fn offset_of_line_out_of_range_errors() {
    let content = "a\nb";
    let (cp, _) = build_index(Cursor::new(content), 1, |_, _| {}).unwrap();
    let c = nearest_checkpoint(&cp, 5);
    let mut r = Cursor::new(content);
    r.seek(SeekFrom::Start(c.1)).unwrap();
    assert!(offset_of_line(r, c.1, c.0, 5).is_err());
  }

  #[test]
  fn line_offset_in_file_maps_past_end_to_none() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("short.txt");
    for content in ["a\nb\nc", "a\nb\nc\n"] {
      std::fs::write(&path, content).unwrap();
      let (cp, _) = build_index(Cursor::new(content), 100, |_, _| {}).unwrap();
      for target in [400u64, 800] {
        let c = nearest_checkpoint(&cp, target);
        assert_eq!(line_offset_in_file(&path, c, target), Ok(None));
      }
      let c = nearest_checkpoint(&cp, 2);
      assert_eq!(line_offset_in_file(&path, c, 2), Ok(Some(4)));
    }
  }

  #[test]
  fn line_offset_in_file_maps_a_single_long_line_past_end_to_none() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("one-line.txt");
    let content = "x".repeat(1000);
    std::fs::write(&path, &content).unwrap();
    let (cp, _) = build_index(Cursor::new(content), 100, |_, _| {}).unwrap();
    let c = nearest_checkpoint(&cp, 400);
    assert_eq!(line_offset_in_file(&path, c, 400), Ok(None));
  }

  #[test]
  fn line_offset_in_file_keeps_real_failures_as_errors() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("gone.txt");
    assert!(line_offset_in_file(&missing, (0, 0), 3).is_err());
    let path = dir.path().join("f.txt");
    std::fs::write(&path, "a\nb\n").unwrap();
    // A target before the checkpoint is a caller bug, not a past-end answer.
    assert!(line_offset_in_file(&path, (5, 0), 3).is_err());
  }

  #[test]
  fn search_finds_match_across_chunk_boundary() {
    // Chunk size 2 forces "ABC" to straddle a boundary.
    let cancel = AtomicBool::new(false);
    let mut hits = Vec::new();
    let (count, truncated) =
      search_stream(Cursor::new("xxABCxx"), b"ABC", true, 100, 2, &cancel, |h| {
        hits.push(h.offset)
      })
      .unwrap();
    assert_eq!(count, 1);
    assert!(!truncated);
    assert_eq!(hits, vec![2]);
  }

  #[test]
  fn search_is_case_insensitive_when_requested() {
    let cancel = AtomicBool::new(false);
    let mut hits = Vec::new();
    let (count, _) = search_stream(
      Cursor::new("hello ABC world"),
      b"abc",
      false,
      100,
      4,
      &cancel,
      |h| hits.push(h.offset),
    )
    .unwrap();
    assert_eq!(count, 1);
    assert_eq!(hits, vec![6]);
  }

  #[test]
  fn search_reports_line_numbers() {
    let cancel = AtomicBool::new(false);
    let mut hits = Vec::new();
    let (count, _) = search_stream(
      Cursor::new("a\nb\nfind me\nd"),
      b"find",
      true,
      100,
      3,
      &cancel,
      |h| hits.push((h.line, h.preview.clone())),
    )
    .unwrap();
    assert_eq!(count, 1);
    // Line number is correct even though the match straddles read boundaries.
    assert_eq!(hits[0].0, 2);
    // Preview is best-effort within the buffer, so it starts on the hit line.
    assert!(hits[0].1.starts_with("find"));
  }

  #[test]
  fn search_preview_is_whole_line_within_one_buffer() {
    // A chunk large enough to hold the line yields the full preview.
    let cancel = AtomicBool::new(false);
    let mut previews = Vec::new();
    search_stream(
      Cursor::new("a\nb\nfind me\nd"),
      b"find",
      true,
      100,
      64,
      &cancel,
      |h| previews.push(h.preview),
    )
    .unwrap();
    assert_eq!(previews, vec!["find me".to_string()]);
  }

  #[test]
  fn search_truncates_at_max_results() {
    let cancel = AtomicBool::new(false);
    let mut count_seen = 0;
    let (count, truncated) =
      search_stream(Cursor::new("a a a a a"), b"a", true, 2, 2, &cancel, |_| {
        count_seen += 1
      })
      .unwrap();
    assert_eq!(count, 2);
    assert!(truncated);
    assert_eq!(count_seen, 2);
  }

  #[test]
  fn search_stops_when_cancelled() {
    // Cancelling inside the hit callback stops the scan after the first match.
    let cancel = AtomicBool::new(false);
    let mut hits = 0;
    let (count, truncated) = search_stream(
      Cursor::new("a a a a a"),
      b"a",
      true,
      100,
      2,
      &cancel,
      |_| {
        hits += 1;
        cancel.store(true, Ordering::Relaxed);
      },
    )
    .unwrap();
    assert_eq!(count, 1);
    assert_eq!(hits, 1);
    assert!(!truncated);
  }

  #[test]
  fn search_pre_cancelled_finds_nothing() {
    let cancel = AtomicBool::new(true);
    let (count, truncated) =
      search_stream(Cursor::new("aaaa"), b"a", true, 100, 2, &cancel, |_| {}).unwrap();
    assert_eq!(count, 0);
    assert!(!truncated);
  }
  /// A reader that always fails, standing in for a mid-scan I/O error (e.g. the
  /// file disappearing or a disk read failure).
  struct FailingReader;

  impl Read for FailingReader {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
      Err(std::io::Error::other("simulated read failure"))
    }
  }

  #[test]
  fn index_mid_scan_failure_errors() {
    // This is the condition `start_line_index`'s worker thread matches on to emit
    // the terminal `large-index-progress` event with `error: true` instead of
    // returning silently.
    assert!(build_index(FailingReader, 1, |_, _| {}).is_err());
  }

  fn index_entry() -> LineIndex {
    LineIndex {
      path: PathBuf::from("x"),
      checkpoints: vec![(0, 0)],
      total_lines: None,
      failed: false,
    }
  }

  #[test]
  fn index_status_running_while_scan_unfinished() {
    let indexes = Mutex::new(HashMap::new());
    indexes.lock().unwrap().insert("a".into(), index_entry());
    assert_eq!(status_of(&indexes, "a").unwrap(), IndexStatus::Running);
  }

  #[test]
  fn index_status_done_reports_total() {
    let indexes = Mutex::new(HashMap::new());
    let mut entry = index_entry();
    entry.total_lines = Some(42);
    indexes.lock().unwrap().insert("a".into(), entry);
    assert_eq!(status_of(&indexes, "a").unwrap(), IndexStatus::Done(42));
  }

  #[test]
  fn index_status_failed_after_mark_failed() {
    let indexes = Mutex::new(HashMap::new());
    indexes.lock().unwrap().insert("a".into(), index_entry());
    mark_failed(&indexes, "a");
    assert_eq!(status_of(&indexes, "a").unwrap(), IndexStatus::Failed);
  }

  #[test]
  fn index_status_unknown_id_errors_and_mark_failed_ignores_it() {
    let indexes = Mutex::new(HashMap::new());
    mark_failed(&indexes, "gone");
    assert_eq!(status_of(&indexes, "gone").unwrap_err(), "unknown index id");
  }

  #[test]
  fn index_status_serializes_with_a_state_tag() {
    assert_eq!(
      serde_json::to_string(&IndexStatus::Running).unwrap(),
      r#"{"state":"running"}"#
    );
    assert_eq!(
      serde_json::to_string(&IndexStatus::Done(7)).unwrap(),
      r#"{"state":"done","lines":7}"#
    );
    assert_eq!(
      serde_json::to_string(&IndexStatus::Failed).unwrap(),
      r#"{"state":"failed"}"#
    );
  }

  #[test]
  fn search_mid_scan_failure_errors() {
    // This is the condition `stream_search`'s worker thread matches on to call
    // `done(0, false, true)` instead of the success terminal call
    // `done(hits, truncated, false)` — the two are no longer the same signal.
    let cancel = AtomicBool::new(false);
    assert!(search_stream(FailingReader, b"x", true, 100, 64, &cancel, |_| {}).is_err());
  }
  // --- The line rule: `\n`, and `\r` not followed by `\n` ---------------------
  /// Line starts of `c` by the line rule, written out directly.
  fn rule_starts(c: &[u8]) -> Vec<u64> {
    let mut starts = vec![0u64];
    for i in 0..c.len() {
      if c[i] == b'\n' || (c[i] == b'\r' && c.get(i + 1) != Some(&b'\n')) {
        starts.push(i as u64 + 1);
      }
    }
    starts
  }
  /// A reader that hands out one byte per read.
  struct OneByte<'a>(&'a [u8]);
  impl Read for OneByte<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
      match self.0.split_first() {
        Some((&b, rest)) if !buf.is_empty() => {
          buf[0] = b;
          self.0 = rest;
          Ok(1)
        }
        _ => Ok(0),
      }
    }
  }

  const CR_CONTENTS: [&str; 7] = [
    "a\rb\r\nc\r\r\n\rd\r",
    "\r",
    "\r\r\r",
    "\r\n\r\n",
    "x\ny\rz\r\n",
    "line\r",
    "é\rè\r\n",
  ];

  #[test]
  fn index_follows_the_line_rule_for_any_read_size() {
    for text in CR_CONTENTS {
      let bytes = text.as_bytes();
      let starts = rule_starts(bytes);
      for interval in [1u32, 2, 3] {
        let want: Vec<(u64, u64)> = std::iter::once((0, 0))
          .chain(
            (1..starts.len() as u64)
              .filter(|line| line % interval as u64 == 0)
              .map(|line| (line, starts[line as usize])),
          )
          .collect();
        let whole = build_index(Cursor::new(bytes), interval, |_, _| {}).unwrap();
        let single = build_index(OneByte(bytes), interval, |_, _| {}).unwrap();
        assert_eq!(whole, (want.clone(), starts.len() as u64), "{text:?}");
        assert_eq!(single, whole, "{text:?}");
      }
    }
    assert_eq!(
      build_index(Cursor::new(""), 1, |_, _| {}).unwrap(),
      (vec![(0, 0)], 0)
    );
  }

  #[test]
  fn index_keeps_a_crlf_whole_across_the_read_buffer() {
    // The CR is the last byte of the first 256 KiB read, the LF the first of the
    // next: one break, not two.
    let mut bytes = vec![b'a'; 256 * 1024 - 1];
    bytes.extend_from_slice(b"\r\nb\rc");
    let (cp, total) = build_index(Cursor::new(&bytes), 1, |_, _| {}).unwrap();
    assert_eq!(total, 3);
    assert_eq!(cp, vec![(0, 0), (1, 256 * 1024 + 1), (2, 256 * 1024 + 3)]);
  }

  #[test]
  fn offset_of_line_follows_the_line_rule() {
    for text in CR_CONTENTS {
      let bytes = text.as_bytes();
      let starts = rule_starts(bytes);
      let (cp, total) = build_index(Cursor::new(bytes), 2, |_, _| {}).unwrap();
      assert_eq!(total, starts.len() as u64);
      for line in 0..total {
        let c = nearest_checkpoint(&cp, line);
        for reader in [
          Box::new(Cursor::new(&bytes[c.1 as usize..])) as Box<dyn Read>,
          Box::new(OneByte(&bytes[c.1 as usize..])),
        ] {
          assert_eq!(
            offset_of_line(reader, c.1, c.0, line).unwrap(),
            starts[line as usize],
            "line {line} of {text:?}"
          );
        }
      }
      let c = nearest_checkpoint(&cp, total);
      let err = offset_of_line(Cursor::new(&bytes[c.1 as usize..]), c.1, c.0, total).unwrap_err();
      assert_eq!(err, LINE_OUT_OF_RANGE, "past the end of {text:?}");
    }
  }

  #[test]
  fn offset_of_line_keeps_a_crlf_whole_across_the_read_buffer() {
    let mut bytes = vec![b'a'; 64 * 1024 - 1];
    bytes.extend_from_slice(b"\r\nb\rc");
    let at = |line: u64| offset_of_line(Cursor::new(&bytes), 0, 0, line).unwrap();
    assert_eq!(at(1), 64 * 1024 + 1);
    assert_eq!(at(2), 64 * 1024 + 3);
    assert!(offset_of_line(Cursor::new(&bytes), 0, 0, 3).is_err());
  }

  #[test]
  fn search_lines_follow_the_line_rule_for_any_read_size() {
    let cancel = AtomicBool::new(false);
    for text in CR_CONTENTS {
      let bytes = text.as_bytes();
      let starts = rule_starts(bytes);
      for needle in ["b", "\n", "\r", "\r\n", "\nb", "c\r", "\rd", "é", "z"] {
        let mut want = Vec::new();
        let mut from = 0usize;
        while let Some(rel) = find_sub(&bytes[from..], needle.as_bytes(), true) {
          let at = (from + rel) as u64;
          want.push((at, starts.partition_point(|&s| s <= at) as u64 - 1));
          from += rel + needle.len();
        }
        for chunk in [1usize, 2, 3, 5, 64] {
          let mut got = Vec::new();
          search_stream(
            Cursor::new(bytes),
            needle.as_bytes(),
            true,
            u32::MAX,
            chunk,
            &cancel,
            |h| got.push((h.offset, h.line)),
          )
          .unwrap();
          assert_eq!(got, want, "{needle:?} in {text:?} / chunk {chunk}");
        }
      }
    }
  }

  #[test]
  fn a_preview_runs_between_the_nearest_breaks() {
    assert_eq!(preview_at(b"ab\rcd\nef", 3), "cd");
    assert_eq!(preview_at(b"ab\rcd\nef", 0), "ab");
    assert_eq!(preview_at(b"x\r\ny", 3), "y");
    assert_eq!(preview_at(b"x\r\ny\r", 0), "x");
    // A match starting at the LF of a CRLF shows the line that CRLF ends.
    assert_eq!(preview_at(b"x\r\nb", 2), "x");
    assert_eq!(preview_at(b"a\rx\r\nb", 4), "x");
    assert_eq!(preview_at(b"\r\nb", 1), "");
  }

  #[test]
  fn a_hit_at_the_lf_of_a_crlf_previews_its_own_line() {
    let cancel = AtomicBool::new(false);
    let mut hits = Vec::new();
    search_stream(Cursor::new("x\r\nb"), b"\nb", true, 100, 64, &cancel, |h| {
      hits.push((h.line, h.preview))
    })
    .unwrap();
    assert_eq!(hits, vec![(0, "x".to_string())]);
  }
  // --- clip_copy_file ----------------------------------------------------------
  fn clip_of(
    content: &[u8],
    range: ClipRange,
    chunk: usize,
  ) -> (Result<Written, String>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source.txt");
    std::fs::write(&path, content).unwrap();
    let starts = rule_starts(content);
    let made = clip_copy_file_core(
      Some(&dir.path().join("clips")),
      &path,
      range,
      &|line| Ok(starts.get(line as usize).copied()),
      chunk,
    );
    (made, dir)
  }
  fn lossy_len(bytes: &[u8]) -> (usize, usize) {
    let text = String::from_utf8_lossy(bytes);
    (text.len(), text.encode_utf16().count())
  }
  #[test]
  fn a_whole_file_clip_holds_the_file() {
    let content = "行0 café\r\nline 1\nlone\rCR \u{1F600}\nlast".repeat(500);
    for chunk in [1, 7, 64, 4096, 1 << 20] {
      let (made, dir) = clip_of(content.as_bytes(), ClipRange::Whole, chunk);
      let made = made.unwrap();
      assert_eq!(std::fs::read(&made.path).unwrap(), content.as_bytes());
      let (bytes, utf16) = lossy_len(content.as_bytes());
      assert_eq!(made.info.bytes, bytes as u64);
      assert_eq!(made.info.utf16_len, utf16 as u64);
      assert_eq!(
        made.info.lines,
        crate::line_rule::count_breaks(content.as_bytes()) + 1
      );
      assert!(!made.info.linewise);
      drop(dir);
    }
  }
  #[test]
  fn a_line_range_clip_holds_those_lines_with_their_breaks() {
    let content: Vec<u8> = (0..40)
      .map(|i| match i % 3 {
        0 => format!("line {i} \u{e9}\r\n"),
        1 => format!("line {i}\n"),
        _ => format!("line {i}\r"),
      })
      .collect::<String>()
      .into_bytes();
    let starts = rule_starts(&content);
    let len = content.len() as u64;
    let cases = [
      (0, 0),
      (0, 39),
      (3, 7),
      (7, 3),
      (38, 39),
      (39, 39),
      (10, 500),
    ];
    for (start, end) in cases {
      for chunk in [3, 64] {
        let (made, _dir) = clip_of(&content, ClipRange::Lines { start, end }, chunk);
        let made = made.unwrap();
        let (first, last) = (start.min(end), start.max(end));
        let from = starts[first as usize];
        let to = starts.get(last as usize + 1).copied().unwrap_or(len);
        assert_eq!(
          std::fs::read(&made.path).unwrap(),
          &content[from as usize..to as usize],
          "lines {start} to {end}, chunk {chunk}"
        );
      }
    }
    // A first line past the last is an error and leaves nothing behind.
    let (made, dir) = clip_of(
      &content,
      ClipRange::Lines {
        start: 500,
        end: 600,
      },
      64,
    );
    assert!(made.is_err());
    assert!(
      !dir.path().join("clips").exists()
        || std::fs::read_dir(dir.path().join("clips")).unwrap().count() == 0
    );
  }
  #[test]
  fn invalid_utf8_in_a_clip_is_replaced_as_the_viewer_does_even_across_blocks() {
    let mut content = Vec::new();
    for i in 0..300u32 {
      content.extend_from_slice(format!("ok {i} \u{20ac} \u{1F600} ").as_bytes());
      content.extend_from_slice(match i % 4 {
        0 => b"\xFF",
        1 => b"\xE4\xB8",
        2 => b"\xF0\x9F\x98",
        _ => b"\x80\xC3",
      });
      content.push(b'\n');
    }
    content.extend_from_slice(b"end \xE2\x82");
    let want = String::from_utf8_lossy(&content).into_owned();
    for chunk in [1, 2, 3, 5, 7, 64, 1000] {
      let (made, _dir) = clip_of(&content, ClipRange::Whole, chunk);
      let made = made.unwrap();
      assert_eq!(
        std::fs::read(&made.path).unwrap(),
        want.as_bytes(),
        "chunk {chunk}"
      );
      assert_eq!(made.info.bytes, want.len() as u64);
      assert_eq!(made.info.utf16_len, want.encode_utf16().count() as u64);
    }
  }
  #[test]
  fn a_file_clip_without_a_folder_touches_nothing() {
    let err = clip_copy_file_core(
      None,
      Path::new("/nowhere/at/all.txt"),
      ClipRange::Whole,
      &|_| Ok(None),
      64,
    )
    .unwrap_err();
    assert_eq!(
      err, "no temp folder",
      "refused before the file is looked at"
    );
  }
  #[test]
  fn a_file_clip_is_read_in_blocks() {
    let content = "0123456789abcdef\n".repeat(1 << 19);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.txt");
    std::fs::write(&path, &content).unwrap();
    let chunk = 64 * 1024;
    crate::test_alloc::reset_largest();
    let made = clip_copy_file_core(
      Some(&dir.path().join("clips")),
      &path,
      ClipRange::Whole,
      &|_| Ok(None),
      chunk,
    )
    .unwrap();
    let biggest = crate::test_alloc::largest();
    assert!(biggest <= 8 * chunk, "one allocation of {biggest} bytes");
    assert_eq!(made.info.bytes, content.len() as u64);
    assert_eq!(
      std::fs::metadata(&made.path).unwrap().len(),
      content.len() as u64
    );
  }
  #[test]
  fn a_clip_range_comes_from_the_frontend_as_a_tagged_object() {
    let whole: ClipRange = serde_json::from_str(r#"{ "kind": "whole" }"#).unwrap();
    assert!(matches!(whole, ClipRange::Whole));
    let lines: ClipRange =
      serde_json::from_str(r#"{ "kind": "lines", "start": 9, "end": 2000000 }"#).unwrap();
    assert!(matches!(
      lines,
      ClipRange::Lines {
        start: 9,
        end: 2000000
      }
    ));
  }
  #[test]
  fn the_file_clip_command_runs_off_the_main_thread() {
    let source = include_str!("large_file.rs");
    let at = source.find("pub fn clip_copy_file(").unwrap();
    assert!(source[..at]
      .trim_end()
      .ends_with("#[tauri::command(async)]"));
  }
  #[test]
  fn the_nearest_index_of_a_path_is_the_one_with_the_most_checkpoints() {
    let state = LargeFileState::default();
    let entry = |path: &str, checkpoints: Vec<(u64, u64)>| LineIndex {
      path: PathBuf::from(path),
      checkpoints,
      total_lines: None,
      failed: false,
    };
    state
      .indexes
      .lock()
      .unwrap()
      .insert("a".into(), entry("/f.txt", vec![(0, 0)]));
    state.indexes.lock().unwrap().insert(
      "b".into(),
      entry("/f.txt", vec![(0, 0), (10, 100), (20, 200)]),
    );
    state
      .indexes
      .lock()
      .unwrap()
      .insert("c".into(), entry("/g.txt", vec![(0, 0), (5, 50)]));
    assert_eq!(state.checkpoints_of(Path::new("/f.txt")).len(), 3);
    assert_eq!(state.checkpoints_of(Path::new("/none.txt")), vec![(0, 0)]);
  }
}
