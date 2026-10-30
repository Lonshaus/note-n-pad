// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Spill files: document content too large to keep in memory, held in a file of
//! its own in the temp folder and read back in fixed-size blocks.
//!
//! A `SpillFile` records only its path, length and a sparse newline index (the
//! same `(offset, newlines_before)` checkpoints as `OriginalIndex`, taken while
//! the file is written). It keeps no file handle: every read opens the file and
//! closes it again, so the number of open handles does not grow with the number
//! of spills, and the file can be removed on Windows whenever its last owner
//! goes. The last `Arc<SpillFile>` to drop deletes the file.

use crate::line_rule::BreakCounter;
use crate::piece_table::{copy_range_to, fill_at, OriginalSource, PieceTable};
use crate::windowed::{CHECKPOINT_INTERVAL, SCAN_CHUNK};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Removed content longer than this many bytes (1 MiB) goes to a spill file.
pub const SPILL_MIN: u64 = 1024 * 1024;
/// File-name prefix and suffix of a spill file; `cleanup_tmp` removes them.
pub const FILE_PREFIX: &str = "sp-";
pub const FILE_SUFFIX: &str = ".bin";

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

/// The value of `NOTENPAD_SPILL_MIN`: a whole number of bytes.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn parse_spill_min(value: Option<&str>) -> Option<u64> {
  value.and_then(|v| v.trim().parse().ok())
}

/// Debug builds: the threshold `NOTENPAD_SPILL_MIN` sets, so a test can make a
/// small deletion spill. Release builds never read it.
pub fn min_from_env() -> Option<u64> {
  #[cfg(debug_assertions)]
  {
    parse_spill_min(std::env::var("NOTENPAD_SPILL_MIN").ok().as_deref())
  }
  #[cfg(not(debug_assertions))]
  {
    None
  }
}

/// Where and how a session spills: the folder, the size past which removed
/// content spills, and the checkpoint interval and block size of the files.
#[derive(Clone, Debug)]
pub struct SpillCtx {
  pub dir: PathBuf,
  pub min: u64,
  pub interval: u64,
  pub chunk: usize,
}

impl SpillCtx {
  /// A context for `dir` with the standard sizes; `min` overrides the threshold.
  pub fn new(dir: PathBuf, min: Option<u64>) -> Self {
    SpillCtx {
      dir,
      min: min.unwrap_or(SPILL_MIN),
      interval: CHECKPOINT_INTERVAL,
      chunk: SCAN_CHUNK,
    }
  }
  /// A builder for a new spill file with this context's block size.
  pub fn builder(&self) -> Result<SpillBuilder, String> {
    SpillBuilder::create_with(&self.dir, self.interval, self.chunk)
  }
}

/// A spill file: path, length and sparse newline checkpoints.
pub struct SpillFile {
  path: PathBuf,
  len: u64,
  /// Markers in the whole file, a final `\r` included.
  newlines: u64,
  /// `(offset, markers strictly before offset)`, ascending, seeded with `(0, 0)`.
  checkpoints: Vec<(u64, u64)>,
  /// Largest read a scan of this file makes.
  chunk: usize,
}

impl Drop for SpillFile {
  fn drop(&mut self) {
    let _ = fs::remove_file(&self.path);
  }
}

/// What a range of a spill file looks like to the piece table.
pub struct RangeInfo {
  pub newlines: u64,
  pub first: u8,
  pub last: u8,
}

/// One open read handle; closed when it drops.
struct Reader {
  file: File,
}

impl Reader {
  fn open(path: &Path) -> Result<Self, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    #[cfg(test)]
    stats::opened();
    Ok(Reader { file })
  }
  /// Append `[offset, offset + len)` to `out`.
  fn read(&self, offset: u64, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
    let at = out.len();
    out.resize(at + len, 0);
    let read = fill_at(&self.file, offset, &mut out[at..]);
    if read.is_err() {
      out.truncate(at);
    }
    #[cfg(test)]
    stats::read(len, out.capacity());
    read
  }
}

#[cfg(test)]
impl Drop for Reader {
  fn drop(&mut self) {
    stats::closed();
  }
}

impl SpillFile {
  /// Length in bytes.
  #[cfg(test)]
  pub fn len(&self) -> u64 {
    self.len
  }
  /// Where the file lives.
  #[cfg(test)]
  pub fn path(&self) -> &Path {
    &self.path
  }

  /// Append `[offset, offset + len)` to `out`.
  pub fn read_into(&self, offset: u64, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
    let end = offset
      .checked_add(len as u64)
      .ok_or_else(|| "read range overflows u64".to_string())?;
    if end > self.len {
      return Err("read past spill end".to_string());
    }
    Reader::open(&self.path)?.read(offset, len, out)
  }

  /// Feed `[from, to)` to `f` in blocks of at most `chunk` bytes, until `f`
  /// returns false.
  fn scan(
    &self,
    reader: &Reader,
    from: u64,
    to: u64,
    mut f: impl FnMut(u64, &[u8]) -> bool,
  ) -> Result<(), String> {
    let mut buf: Vec<u8> = Vec::with_capacity(self.chunk.min((to - from) as usize));
    let mut at = from;
    while at < to {
      let take = (to - at).min(self.chunk as u64) as usize;
      buf.clear();
      reader.read(at, take, &mut buf)?;
      if !f(at, &buf) {
        break;
      }
      at += take as u64;
    }
    Ok(())
  }
  // ponytail: every line query rescans up to one interval from its checkpoint;
  // add a one-segment cache like `OriginalIndex` if spill pieces are queried
  // per keystroke.
  /// Markers strictly before `offset` (`0..=len`), a `\r` at `offset - 1`
  /// counting unless the byte at `offset` is `\n`.
  fn markers_to(&self, reader: &Reader, offset: u64) -> Result<u64, String> {
    let seg = self.checkpoints.partition_point(|&(o, _)| o <= offset) - 1;
    let (from, before) = self.checkpoints[seg];
    if from == offset {
      return Ok(before);
    }
    let mut counter = BreakCounter::new();
    self.scan(reader, from, offset, |_, bytes| {
      counter.feed(bytes);
      true
    })?;
    if offset == self.len {
      return Ok(before + counter.finish());
    }
    let mut next = Vec::with_capacity(1);
    reader.read(offset, 1, &mut next)?;
    Ok(before + counter.count_before_next(next[0]))
  }

  /// Markers in `[a, b)` under the rule of the whole file, for `a <= b <= len`.
  pub fn markers_between(&self, a: u64, b: u64) -> Result<u64, String> {
    let reader = Reader::open(&self.path)?;
    Ok(self.markers_to(&reader, b)? - self.markers_to(&reader, a)?)
  }

  /// Byte offset of the `ordinal`-th marker (1-based) of the whole file.
  pub fn newline_pos(&self, ordinal: u64) -> Result<u64, String> {
    if ordinal == 0 || ordinal > self.newlines {
      return Err("newline ordinal out of range".to_string());
    }
    let seg = self.checkpoints.partition_point(|&(_, n)| n < ordinal) - 1;
    let (from, before) = self.checkpoints[seg];
    let target = ordinal - before;
    let reader = Reader::open(&self.path)?;
    let mut counter = BreakCounter::new();
    let mut found = None;
    self.scan(&reader, from, self.len, |at, bytes| {
      for (i, &b) in bytes.iter().enumerate() {
        counter.step(b);
        if counter.count() == target {
          // A `\r` is only counted once the byte after it is seen.
          found = Some(at + i as u64 - u64::from(b != b'\n'));
          return false;
        }
      }
      true
    })?;
    // A final `\r` ends the text.
    found
      .or_else(|| (counter.finish() == target).then_some(self.len - 1))
      .ok_or_else(|| "newline ordinal out of range".to_string())
  }

  /// The markers of `[start, start + len)` as a text of its own (a final `\r`
  /// counts), and its first and last byte.
  pub fn range_info(&self, start: u64, len: u64) -> Result<RangeInfo, String> {
    let end = start + len;
    if len == 0 || end > self.len {
      return Err("spill range out of bounds".to_string());
    }
    let reader = Reader::open(&self.path)?;
    let mut one = Vec::with_capacity(1);
    reader.read(start, 1, &mut one)?;
    reader.read(end - 1, 1, &mut one)?;
    let (first, last) = (one[0], one[1]);
    let newlines = if start == 0 && end == self.len {
      self.newlines
    } else {
      let inside = self.markers_to(&reader, end)? - self.markers_to(&reader, start)?;
      // A `\r\n` cut after its `\r`: the `\r` is a marker of the range's own.
      let mut after = Vec::with_capacity(1);
      let cut = end < self.len && last == b'\r' && {
        reader.read(end, 1, &mut after)?;
        after[0] == b'\n'
      };
      inside + u64::from(cut)
    };
    Ok(RangeInfo {
      newlines,
      first,
      last,
    })
  }

  /// Markers in the whole file.
  #[cfg(test)]
  pub fn total_newlines(&self) -> u64 {
    self.newlines
  }
  /// The checkpoints taken while the file was written.
  #[cfg(test)]
  pub fn checkpoints(&self) -> &[(u64, u64)] {
    &self.checkpoints
  }
}

/// A run of a spill file: the removed content an undo step keeps on disk.
#[derive(Clone)]
pub struct SpillRef {
  pub file: Arc<SpillFile>,
  pub start: u64,
  pub len: u64,
}

/// Writes a new spill file. Dropped before `finish`, it removes the file.
pub struct SpillBuilder {
  file: File,
  path: PathBuf,
  written: u64,
  counter: BreakCounter,
  checkpoints: Vec<(u64, u64)>,
  interval: u64,
  chunk: usize,
  finished: bool,
}

impl SpillBuilder {
  /// Start a spill file in `dir` with the standard checkpoint interval.
  #[cfg(test)]
  pub fn create(dir: &Path) -> Result<Self, String> {
    Self::create_with(dir, CHECKPOINT_INTERVAL, SCAN_CHUNK)
  }
  /// Start a spill file in `dir`; checkpoints are at most `interval` bytes apart
  /// and a scan of the finished file reads at most `chunk` bytes at a time.
  pub fn create_with(dir: &Path, interval: u64, chunk: usize) -> Result<Self, String> {
    #[cfg(test)]
    stats::maybe_fail_create()?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0);
    let name = format!(
      "{FILE_PREFIX}{}-{}-{nanos}{FILE_SUFFIX}",
      std::process::id(),
      NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    );
    let path = dir.join(name);
    let file = OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&path)
      .map_err(|e| e.to_string())?;
    Ok(SpillBuilder {
      file,
      path,
      written: 0,
      counter: BreakCounter::new(),
      checkpoints: vec![(0, 0)],
      interval: interval.max(1),
      chunk: chunk.max(1),
      finished: false,
    })
  }

  /// Copy document bytes `[start, end)` of `table` into the file, in blocks of
  /// at most the builder's block size.
  pub fn copy_range<O: OriginalSource>(
    &mut self,
    table: &PieceTable<O>,
    start: u64,
    end: u64,
  ) -> Result<(), String> {
    let chunk = self.chunk;
    copy_range_to(table, start, end, self, chunk)
  }

  /// Close the file and return it. The last holder of the `Arc` removes it.
  pub fn finish(mut self) -> Result<Arc<SpillFile>, String> {
    self.finished = true;
    Ok(Arc::new(SpillFile {
      path: std::mem::take(&mut self.path),
      len: self.written,
      newlines: self.counter.finish(),
      checkpoints: std::mem::take(&mut self.checkpoints),
      chunk: self.chunk,
    }))
  }

  fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
    #[cfg(test)]
    stats::wrote(bytes.len());
    let mut rest = bytes;
    while !rest.is_empty() {
      let next = self.checkpoints.last().map_or(0, |&(o, _)| o) + self.interval;
      if self.written == next {
        self
          .checkpoints
          .push((next, self.counter.count_before_next(rest[0])));
        continue;
      }
      let take = (next - self.written).min(rest.len() as u64) as usize;
      self.counter.feed(&rest[..take]);
      self.written += take as u64;
      rest = &rest[take..];
    }
    self.file.write_all(bytes).map_err(|e| e.to_string())
  }
}

impl Write for SpillBuilder {
  fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
    self.append(buf).map_err(std::io::Error::other)?;
    Ok(buf.len())
  }
  fn flush(&mut self) -> std::io::Result<()> {
    Ok(())
  }
}

impl Drop for SpillBuilder {
  fn drop(&mut self) {
    if !self.finished {
      let _ = fs::remove_file(&self.path);
    }
  }
}

/// A spill of document bytes `[start, end)` of `table`: the run of a spill piece
/// that holds them, or a new file streamed from the table.
pub fn spill_range<O: OriginalSource>(
  table: &PieceTable<O>,
  start: u64,
  end: u64,
  ctx: &SpillCtx,
) -> Result<SpillRef, String> {
  if let Some(found) = table.spill_cover(start, end) {
    return Ok(found);
  }
  let mut builder = ctx.builder()?;
  builder.copy_range(table, start, end)?;
  Ok(SpillRef {
    file: builder.finish()?,
    start: 0,
    len: end - start,
  })
}

/// `spill_range` for a source that is read through `read(start, end)`, so the
/// caller can hold no lock between two blocks. Never reuses a spill piece.
pub fn spill_range_with(
  read: &mut dyn FnMut(u64, u64) -> Result<Vec<u8>, String>,
  start: u64,
  end: u64,
  ctx: &SpillCtx,
) -> Result<SpillRef, String> {
  let mut builder = ctx.builder()?;
  let mut at = start;
  while at < end {
    let to = (at + ctx.chunk.max(1) as u64).min(end);
    builder
      .write_all(&read(at, to)?)
      .map_err(|e| e.to_string())?;
    at = to;
  }
  Ok(SpillRef {
    file: builder.finish()?,
    start: 0,
    len: end - start,
  })
}

/// Counters of what the read and write paths ask of the disk, per thread, for
/// tests that bound memory.
#[cfg(test)]
pub mod stats {
  use std::cell::Cell;

  #[derive(Clone, Copy, Default, Debug)]
  pub struct Stats {
    /// Largest range one read asked for.
    pub max_read: usize,
    /// Bytes `PieceTable::read` was asked for, in all.
    pub total_read: u64,
    /// Largest buffer a read filled.
    pub max_buf: usize,
    /// Largest single write into a spill file.
    pub max_write: usize,
    /// Most spill read handles open at once.
    pub max_open: usize,
    open: usize,
    /// Spill files created.
    pub created: usize,
  }

  thread_local! {
    static STATS: Cell<Stats> = const { Cell::new(Stats { max_read: 0, total_read: 0, max_buf: 0, max_write: 0, max_open: 0, open: 0, created: 0 }) };
    static FAIL_CREATE: Cell<usize> = const { Cell::new(0) };
  }

  fn update(f: impl FnOnce(&mut Stats)) {
    STATS.with(|s| {
      let mut v = s.get();
      f(&mut v);
      s.set(v);
    });
  }
  /// Zero the counters.
  pub fn reset() {
    STATS.with(|s| s.set(Stats::default()));
  }
  /// The counters since the last `reset`.
  pub fn get() -> Stats {
    STATS.with(|s| s.get())
  }
  pub fn read(range: usize, buf: usize) {
    update(|s| {
      s.max_read = s.max_read.max(range);
      s.max_buf = s.max_buf.max(buf);
    });
  }
  /// A read of document content through `PieceTable::read`, counted once.
  pub fn content_read(range: usize) {
    update(|s| s.total_read += range as u64);
  }
  pub fn wrote(n: usize) {
    update(|s| s.max_write = s.max_write.max(n));
  }
  pub fn opened() {
    update(|s| {
      s.open += 1;
      s.max_open = s.max_open.max(s.open);
    });
  }
  pub fn closed() {
    update(|s| s.open = s.open.saturating_sub(1));
  }
  /// Make the `n`-th spill file started from now on fail (1-based; 0 clears).
  pub fn fail_create_at(n: usize) {
    FAIL_CREATE.with(|f| f.set(n));
  }
  pub fn maybe_fail_create() -> Result<(), String> {
    let hit = FAIL_CREATE.with(|f| {
      let left = f.get();
      if left > 0 {
        f.set(left - 1);
      }
      left == 1
    });
    if hit {
      return Err("injected spill failure".to_string());
    }
    update(|s| s.created += 1);
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_threshold_override_is_a_whole_number_of_bytes() {
    assert_eq!(parse_spill_min(Some("4096")), Some(4096));
    assert_eq!(parse_spill_min(Some(" 64 ")), Some(64));
    assert_eq!(parse_spill_min(Some("1MiB")), None);
    assert_eq!(parse_spill_min(Some("")), None);
    assert_eq!(parse_spill_min(None), None);
  }
}
