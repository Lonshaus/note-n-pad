// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Replace all as a layer over a windowed session's content.
//!
//! A replace-all never copies the file and never makes one piece per hit. One
//! streaming pass writes a change list to a compact file in the app's
//! `windowed-tmp/`: per hit its pre-replace byte offset and original text (every
//! hit has the needle's length, so a record has a fixed size and is found by
//! index), and the replacement text once. Beside it the pass keeps checkpoints,
//! one per interval in either coordinate frame, each recording both frames
//! (offset and newlines before it) and the hits before it.
//!
//! A `Layer` is an `OriginalSource` that reads the content below it (the current
//! piece table) and produces the replaced bytes for any range on the fly. The
//! forward layer turns the pre-replace frame into the post-replace frame; the
//! inverse layer is the same engine with the frames' roles swapped and the
//! original text put back. The session's piece table is rebuilt as one piece
//! over a layer, so layers stack.
//!
//! Position of hit `i` in the post-replace frame is its pre-replace offset plus
//! `i * (replacement_len - needle_len)`.

use crate::large_file::count_newlines;
use crate::piece_table::{OriginalIndex, OriginalSource, PieceTable};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
/// Name of the folder, inside the app data dir, that holds change lists.
pub const TMP_DIR: &str = "windowed-tmp";
const FILE_PREFIX: &str = "cl-";
const FILE_SUFFIX: &str = ".bin";
const MAGIC: &[u8; 8] = b"NPCL0001";
/// Magic plus the needle length and the replacement length.
const HEADER_FIXED: u64 = 24;
/// Hit records fetched per read while a layer walks hits in order.
const BATCH: u64 = 512;

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);
static NEXT_LAYER: AtomicU64 = AtomicU64::new(1);
/// A fresh id for a layer, so a journal entry can tell whether the layer it
/// created is still the session's top layer.
pub fn next_layer_id() -> u64 {
  NEXT_LAYER.fetch_add(1, Ordering::Relaxed)
}
/// A session's piece table: over the file on disk, or over a replace layer.
pub type Table = PieceTable<Src>;
/// What a session's piece table reads its original bytes from.
pub enum Src {
  /// Placeholder while a table is being swapped; reading it is an error.
  Empty,
  /// The file on disk (pread).
  File(File),
  /// A replace layer, which owns the table underneath it.
  Layer(Box<Layer>),
}

impl OriginalSource for Src {
  fn read_into(&self, offset: u64, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
    match self {
      Src::Empty => Err("table is being replaced".to_string()),
      Src::File(file) => file.read_into(offset, len, out),
      Src::Layer(layer) => layer.read_into(offset, len, out),
    }
  }
}
/// A table with nothing in it, to swap in while the real one is moved.
pub fn placeholder() -> Table {
  PieceTable::new(OriginalIndex::new(Src::Empty, 0, 0, vec![(0, 0)]))
}
/// Which way a layer maps.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dir {
  /// Pre-replace content in, post-replace content out.
  Forward,
  /// Post-replace content in, pre-replace content out.
  Inverse,
}
/// One checkpoint of a pass: both frames' offset and newlines before it, and
/// the hits before it. Never inside a hit.
#[derive(Clone, Copy, Debug)]
struct Ck {
  pre: u64,
  pre_nl: u64,
  post: u64,
  post_nl: u64,
  hits: u64,
}
/// The change list of one replace-all. The file is deleted when the last
/// reference is dropped: journal entries and layers share it through an `Arc`,
/// so it lives exactly as long as something can still read it.
pub struct ChangeList {
  path: PathBuf,
  file: Option<File>,
  needle_len: u64,
  repl: Vec<u8>,
  data_start: u64,
  hits: u64,
  cks: Vec<Ck>,
  pre_len: u64,
  post_len: u64,
  pre_newlines: u64,
  post_newlines: u64,
}

impl Drop for ChangeList {
  fn drop(&mut self) {
    // Close the handle first: Windows will not remove an open file.
    self.file.take();
    let _ = fs::remove_file(&self.path);
  }
}

impl ChangeList {
  /// Number of hits the pass replaced.
  pub fn hits(&self) -> u64 {
    self.hits
  }
  /// Where the change list lives.
  #[cfg(test)]
  pub fn path(&self) -> &Path {
    &self.path
  }
  /// Checkpoints held in memory (one per interval), for tests.
  #[cfg(test)]
  pub fn checkpoint_count(&self) -> usize {
    self.cks.len()
  }

  fn record_size(&self) -> u64 {
    8 + self.needle_len
  }
  /// `n` consecutive hit records starting at hit `from`, raw.
  fn records(&self, from: u64, n: u64) -> Result<Vec<u8>, String> {
    let file = self
      .file
      .as_ref()
      .ok_or_else(|| "change list is closed".to_string())?;
    let mut buf = Vec::new();
    file.read_into(
      self.data_start + from * self.record_size(),
      (n * self.record_size()) as usize,
      &mut buf,
    )?;
    Ok(buf)
  }
  /// Pre-replace byte offset of hit `i`.
  fn offset_at(&self, i: u64) -> Result<u64, String> {
    let raw = self.records(i, 1)?;
    Ok(u64::from_le_bytes(
      raw[..8]
        .try_into()
        .map_err(|_| "short record".to_string())?,
    ))
  }
  /// Pre-replace byte offset of the first hit (the same in both frames).
  pub fn first_hit_offset(&self) -> Result<u64, String> {
    self.offset_at(0)
  }
  /// `(len, newlines, checkpoints)` of the output frame of `dir`, in the shape
  /// `OriginalIndex` takes. Checkpoints at or past the end, or repeating an
  /// offset (a replacement shorter than the needle can leave the output frame
  /// standing still), are left out.
  fn out_index(&self, dir: Dir) -> (u64, u64, Vec<(u64, u64)>) {
    let (len, newlines) = match dir {
      Dir::Forward => (self.post_len, self.post_newlines),
      Dir::Inverse => (self.pre_len, self.pre_newlines),
    };
    let mut cks: Vec<(u64, u64)> = Vec::with_capacity(self.cks.len());
    for ck in &self.cks {
      let (off, nl) = match dir {
        Dir::Forward => (ck.post, ck.post_nl),
        Dir::Inverse => (ck.pre, ck.pre_nl),
      };
      let fresh = cks.last().map_or(true, |&(prev, _)| off > prev);
      if fresh && (off < len || cks.is_empty()) {
        cks.push((off, nl));
      }
    }
    (len, newlines, cks)
  }
}
/// A replace layer: reads the table below (`under`, in the input frame) and the
/// change list, and yields the output frame.
pub struct Layer {
  id: u64,
  dir: Dir,
  under: Table,
  list: Arc<ChangeList>,
}
/// Build a table over a layer that maps `under` through `list`.
pub fn stack(id: u64, dir: Dir, under: Table, list: Arc<ChangeList>) -> Table {
  let (len, newlines, cks) = list.out_index(dir);
  let layer = Layer {
    id,
    dir,
    under,
    list,
  };
  PieceTable::new(OriginalIndex::new(
    Src::Layer(Box::new(layer)),
    len,
    newlines,
    cks,
  ))
}
/// The layer id of `table`'s source when that is a forward layer and the table
/// is exactly that layer, unedited (so removing the layer is lossless).
pub fn top_forward_layer(table: &Table) -> Option<u64> {
  match table.source() {
    Src::Layer(layer) if layer.dir == Dir::Forward && table.is_pristine() => Some(layer.id),
    _ => None,
  }
}
/// Take the layer off `table`, returning the table that was under it. `table`
/// must be a pristine layer (see `top_forward_layer`).
pub fn unstack(table: Table) -> Result<Table, String> {
  match table.into_source() {
    Src::Layer(layer) => Ok(layer.under),
    _ => Err("table is not a layer".to_string()),
  }
}
/// Number of layers a table is stacked on, counting through the tables under
/// them. For tests.
#[cfg(test)]
pub fn layer_depth(table: &Table) -> usize {
  match table.source() {
    Src::Layer(layer) => 1 + layer_depth(&layer.under),
    _ => 0,
  }
}
/// Paths of the change lists of every layer a table is stacked on. For tests.
#[cfg(test)]
pub fn list_paths(table: &Table) -> Vec<PathBuf> {
  match table.source() {
    Src::Layer(layer) => {
      let mut paths = vec![layer.list.path().to_path_buf()];
      paths.extend(list_paths(&layer.under));
      paths
    }
    _ => Vec::new(),
  }
}
/// Bytes the table's own structures hold in memory, counting every layer
/// beneath it: pieces, add buffer, index checkpoints and change-list
/// checkpoints. For tests asserting memory does not follow the hit count.
#[cfg(test)]
pub fn resident_units(table: &Table) -> usize {
  let own = table.piece_count() + table.add_len() + table.checkpoint_count();
  match table.source() {
    Src::Layer(layer) => own + layer.list.checkpoint_count() + resident_units(&layer.under),
    _ => own,
  }
}
/// Reads hit records in batches while a layer walks hits in order.
struct Batch {
  from: u64,
  count: u64,
  data: Vec<u8>,
}

impl Batch {
  fn new() -> Self {
    Batch {
      from: 0,
      count: 0,
      data: Vec::new(),
    }
  }
  /// Offset of hit `j` and where its original text starts in `self.data`.
  fn record(&mut self, list: &ChangeList, j: u64) -> Result<(u64, usize), String> {
    if j < self.from || j >= self.from + self.count {
      self.from = j;
      self.count = BATCH.min(list.hits - j);
      self.data = list.records(j, self.count)?;
    }
    let at = ((j - self.from) * list.record_size()) as usize;
    let off = u64::from_le_bytes(
      self.data[at..at + 8]
        .try_into()
        .map_err(|_| "short record".to_string())?,
    );
    Ok((off, at + 8))
  }
}

impl Layer {
  fn out_len(&self) -> u64 {
    match self.dir {
      Dir::Forward => self.list.post_len,
      Dir::Inverse => self.list.pre_len,
    }
  }

  fn ck_out(&self, ck: &Ck) -> u64 {
    match self.dir {
      Dir::Forward => ck.post,
      Dir::Inverse => ck.pre,
    }
  }

  fn hit_in_len(&self) -> i128 {
    match self.dir {
      Dir::Forward => self.list.needle_len as i128,
      Dir::Inverse => self.list.repl.len() as i128,
    }
  }

  fn hit_out_len(&self) -> i128 {
    match self.dir {
      Dir::Forward => self.list.repl.len() as i128,
      Dir::Inverse => self.list.needle_len as i128,
    }
  }
  /// Position of hit `i` in the output frame, given its pre-replace offset.
  fn out_pos(&self, i: u64, pre_offset: u64) -> i128 {
    match self.dir {
      Dir::Forward => {
        pre_offset as i128
          + i as i128 * (self.list.repl.len() as i128 - self.list.needle_len as i128)
      }
      Dir::Inverse => pre_offset as i128,
    }
  }
}
/// One step of assembling a layer read, in output order.
enum Op {
  /// Text between hits, taken from the table below at `[from, to)`.
  Under { from: u64, to: u64 },
  /// Text of a hit, at `[from, to)` of the literals collected for this read.
  Literal { from: usize, to: usize },
}
/// A read whose input span is no wider than twice the text it takes from the
/// table below (plus this slack) is served by one read of that table; a wider
/// one (long runs of hits dropped from the output) reads gap by gap.
const SPAN_SLACK: u64 = 64 * 1024;

impl OriginalSource for Layer {
  fn read_into(&self, offset: u64, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
    if len == 0 {
      return Ok(());
    }
    let list = &*self.list;
    let end = offset as i128 + len as i128;
    if end > self.out_len() as i128 {
      return Err("read past layer end".to_string());
    }
    let a = offset as i128;
    let hit_out = self.hit_out_len();
    let growth = hit_out - self.hit_in_len();
    // The segment holding `offset` bounds which hits can matter.
    let k = list
      .cks
      .partition_point(|c| self.ck_out(c) <= offset)
      .saturating_sub(1);
    let hits0 = list.cks[k].hits;
    let hits1 = list.cks.get(k + 1).map_or(list.hits, |c| c.hits);
    // First hit whose output ends after `offset`.
    let (mut lo, mut hi) = (hits0, hits1);
    while lo < hi {
      let mid = lo + (hi - lo) / 2;
      let o = list.offset_at(mid)?;
      if self.out_pos(mid, o) + hit_out > a {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    let mut j = lo;
    let mut cur = a;
    let mut batch = Batch::new();
    let mut ops: Vec<Op> = Vec::new();
    let mut literals: Vec<u8> = Vec::new();
    while cur < end {
      let (next_start, text_at) = if j < list.hits {
        let (o, at) = batch.record(list, j)?;
        (self.out_pos(j, o), at)
      } else {
        (self.out_len() as i128, 0)
      };
      if cur < next_start {
        // Text between hits comes from the table below, shifted by the hits
        // already passed.
        let stop = next_start.min(end);
        let shift = j as i128 * growth;
        ops.push(Op::Under {
          from: (cur - shift) as u64,
          to: (stop - shift) as u64,
        });
        cur = stop;
        continue;
      }
      let hit_end = next_start + hit_out;
      let to = hit_end.min(end);
      let from_in_hit = (cur - next_start) as usize;
      let to_in_hit = (to - next_start) as usize;
      let from = literals.len();
      match self.dir {
        Dir::Forward => literals.extend_from_slice(&list.repl[from_in_hit..to_in_hit]),
        Dir::Inverse => {
          literals.extend_from_slice(&batch.data[text_at + from_in_hit..text_at + to_in_hit])
        }
      }
      ops.push(Op::Literal {
        from,
        to: literals.len(),
      });
      cur = to;
      if cur == hit_end {
        j += 1;
      }
    }
    // One read of the table below covers every gap when the hits between them
    // do not widen the span much.
    let mut lowest = u64::MAX;
    let mut highest = 0u64;
    let mut wanted = 0u64;
    for op in &ops {
      if let Op::Under { from, to } = op {
        lowest = lowest.min(*from);
        highest = highest.max(*to);
        wanted += to - from;
      }
    }
    let span = highest.saturating_sub(lowest);
    let mut block: Vec<u8> = Vec::new();
    let one_read = wanted > 0 && span <= wanted * 2 + SPAN_SLACK;
    if one_read {
      block.reserve(span as usize);
      self.under.read_into(lowest, span as usize, &mut block)?;
    }
    out.reserve(len);
    for op in &ops {
      match op {
        Op::Under { from, to } => {
          if one_read {
            out.extend_from_slice(&block[(from - lowest) as usize..(to - lowest) as usize]);
          } else {
            self.under.read_into(*from, (to - from) as usize, out)?;
          }
        }
        Op::Literal { from, to } => out.extend_from_slice(&literals[*from..*to]),
      }
    }
    Ok(())
  }
}
/// Writes a change list as a pass finds hits, and places the checkpoints.
pub struct Builder {
  list: ChangeList,
  writer: BufWriter<File>,
  interval: u64,
  m: u64,
  r: u64,
  nl_m: u64,
  nl_r: u64,
  last_pre: u64,
  last_post: u64,
  cur_pre: u64,
  cur_post: u64,
  pre_nl: u64,
  post_nl: u64,
  hits: u64,
  cks: Vec<Ck>,
}

impl Builder {
  /// Start a change list in `dir` for a needle of `needle` bytes (only its
  /// length and newline count matter here) and the replacement `repl`.
  /// Checkpoints are placed so no segment exceeds `interval` bytes in either
  /// frame, except where a single hit is itself longer.
  pub fn create(dir: &Path, needle: &[u8], repl: &[u8], interval: u64) -> Result<Builder, String> {
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
      .read(true)
      .write(true)
      .create_new(true)
      .open(&path)
      .map_err(|e| e.to_string())?;
    // From here on the list owns the file: dropping it (a failed or abandoned
    // pass) removes it.
    let writer_file = match file.try_clone() {
      Ok(clone) => clone,
      Err(e) => {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(e.to_string());
      }
    };
    let list = ChangeList {
      path,
      file: Some(file),
      needle_len: needle.len() as u64,
      repl: repl.to_vec(),
      data_start: HEADER_FIXED + repl.len() as u64,
      hits: 0,
      cks: Vec::new(),
      pre_len: 0,
      post_len: 0,
      pre_newlines: 0,
      post_newlines: 0,
    };
    let mut writer = BufWriter::new(writer_file);
    writer.write_all(MAGIC).map_err(|e| e.to_string())?;
    writer
      .write_all(&(needle.len() as u64).to_le_bytes())
      .map_err(|e| e.to_string())?;
    writer
      .write_all(&(repl.len() as u64).to_le_bytes())
      .map_err(|e| e.to_string())?;
    writer.write_all(repl).map_err(|e| e.to_string())?;
    Ok(Builder {
      list,
      writer,
      interval: interval.max(1),
      m: needle.len() as u64,
      r: repl.len() as u64,
      nl_m: count_newlines(needle),
      nl_r: count_newlines(repl),
      last_pre: 0,
      last_post: 0,
      cur_pre: 0,
      cur_post: 0,
      pre_nl: 0,
      post_nl: 0,
      hits: 0,
      cks: vec![Ck {
        pre: 0,
        pre_nl: 0,
        post: 0,
        post_nl: 0,
        hits: 0,
      }],
    })
  }

  fn place(&mut self) {
    self.cks.push(Ck {
      pre: self.cur_pre,
      pre_nl: self.pre_nl,
      post: self.cur_post,
      post_nl: self.post_nl,
      hits: self.hits,
    });
    self.last_pre = self.cur_pre;
    self.last_post = self.cur_post;
  }
  /// Text between hits, in order. Both frames advance by its length.
  pub fn gap(&mut self, mut bytes: &[u8]) {
    while !bytes.is_empty() {
      let used = (self.cur_pre - self.last_pre).max(self.cur_post - self.last_post);
      if used >= self.interval {
        self.place();
        continue;
      }
      let take = (self.interval - used).min(bytes.len() as u64) as usize;
      let nl = count_newlines(&bytes[..take]);
      self.cur_pre += take as u64;
      self.cur_post += take as u64;
      self.pre_nl += nl;
      self.post_nl += nl;
      bytes = &bytes[take..];
    }
  }
  /// The next hit, with the text it matched (the needle's length).
  pub fn hit(&mut self, original: &[u8]) -> Result<(), String> {
    if original.len() as u64 != self.m {
      return Err("hit length differs from the needle".to_string());
    }
    let used_pre = self.cur_pre - self.last_pre;
    let used_post = self.cur_post - self.last_post;
    if (used_pre > 0 || used_post > 0)
      && (used_pre + self.m > self.interval || used_post + self.r > self.interval)
    {
      self.place();
    }
    self
      .writer
      .write_all(&self.cur_pre.to_le_bytes())
      .map_err(|e| e.to_string())?;
    self.writer.write_all(original).map_err(|e| e.to_string())?;
    self.cur_pre += self.m;
    self.cur_post += self.r;
    self.pre_nl += self.nl_m;
    self.post_nl += self.nl_r;
    self.hits += 1;
    Ok(())
  }
  /// Flush and seal the change list. `pre_len` is the length of the content
  /// the pass was given and must match what was fed in.
  pub fn finish(mut self, pre_len: u64) -> Result<ChangeList, String> {
    if self.cur_pre != pre_len {
      return Err("pass did not cover the content".to_string());
    }
    self.writer.flush().map_err(|e| e.to_string())?;
    self.list.hits = self.hits;
    self.list.cks = self.cks;
    self.list.pre_len = self.cur_pre;
    self.list.post_len = self.cur_post;
    self.list.pre_newlines = self.pre_nl;
    self.list.post_newlines = self.post_nl;
    Ok(self.list)
  }
}
/// Delete the change-list files a previous run left in `dir`. Only files this
/// module names are touched.
pub fn cleanup_tmp(dir: &Path) {
  let Ok(entries) = fs::read_dir(dir) else {
    return;
  };
  for entry in entries.flatten() {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    if name.starts_with(FILE_PREFIX) && name.ends_with(FILE_SUFFIX) {
      let _ = fs::remove_file(entry.path());
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cleanup_removes_only_change_lists() {
    let dir = tempfile::tempdir().unwrap();
    let ours = dir.path().join("cl-1-2-3.bin");
    let theirs = dir.path().join("notes.bin");
    let other = dir.path().join("cl-1-2-3.txt");
    for p in [&ours, &theirs, &other] {
      fs::write(p, b"x").unwrap();
    }
    cleanup_tmp(dir.path());
    assert!(!ours.exists());
    assert!(theirs.exists());
    assert!(other.exists());
    // A folder that does not exist is not an error.
    cleanup_tmp(&dir.path().join("missing"));
  }

  #[test]
  fn dropping_the_last_holder_deletes_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut b = Builder::create(dir.path(), b"ab", b"xyz", 100).unwrap();
    b.gap(b"hello ");
    b.hit(b"ab").unwrap();
    let list = Arc::new(b.finish(8).unwrap());
    let path = list.path().to_path_buf();
    assert!(path.exists());
    let second = list.clone();
    drop(list);
    assert!(path.exists(), "a second holder keeps it alive");
    drop(second);
    assert!(!path.exists());
  }

  #[test]
  fn an_abandoned_builder_leaves_no_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut b = Builder::create(dir.path(), b"ab", b"x", 100).unwrap();
    b.hit(b"ab").unwrap();
    drop(b);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
  }
}
