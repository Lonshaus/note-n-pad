// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Replace all as a layer over a windowed session's content.
//!
//! A replace-all never copies the file and never makes one piece per hit. One
//! streaming pass writes a change list to a compact file in the app's
//! `windowed-tmp/`: per hit its pre-replace byte offset, the CRLF bytes inserted
//! before it, whether its own output starts with an inserted `\n` and its
//! original text (every hit has the needle's length, so a record has a fixed size
//! and is found by index), and the replacement text once. Beside it the pass
//! keeps checkpoints, one per interval in either coordinate frame, each
//! recording both frames (offset and newlines before it) and the hits before it.
//!
//! A replace-all never joins a lone `\r` it keeps to a `\n` that the pass puts
//! next to it: that `\r` is rewritten to the insert separator. For `\r\n` one
//! `\n` byte is inserted right after it (recorded on a hit, `sep_before`); for
//! `\n` it and the run of `\r` bytes before it become `\n`, one record
//! `post_start | len` per run in a second file beside the change list.
//!
//! A `Layer` is an `OriginalSource` that reads the content below it (the current
//! piece table) and produces the replaced bytes for any range on the fly. The
//! forward layer turns the pre-replace frame into the post-replace frame; the
//! inverse layer is the same engine with the frames' roles swapped and the
//! original text put back. The session's piece table is rebuilt as one piece
//! over a layer, so layers stack.
//!
//! Position of hit `i` in the post-replace frame is its pre-replace offset plus
//! `i * (replacement_len - needle_len)` plus the `\n` bytes inserted before it.

use crate::line_rule::BreakCounter;
use crate::piece_table::{OriginalIndex, OriginalSource, PieceTable};
use std::cell::RefCell;
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
const MAGIC: &[u8; 8] = b"NPCL0002";
/// Magic plus the needle length and the replacement length.
const HEADER_FIXED: u64 = 24;
/// A hit record before the original text: offset, inserted bytes before it, and
/// whether its output starts with an inserted `\n`.
const RECORD_FIXED: u64 = 17;
/// A run record: where a run of `\r` rewritten to `\n` starts, and its length.
const RUN_RECORD: u64 = 16;
/// Hit records fetched per read while a layer walks hits in order.
const BATCH: u64 = 512;

#[cfg(test)]
thread_local! {
  static LIST_READS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
  static LAYER_READS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
fn count_list_read() {
  LIST_READS.with(|c| c.set(c.get() + 1));
}
#[cfg(test)]
fn count_layer_read() {
  LAYER_READS.with(|c| c.set(c.get() + 1));
}
/// Reads of hit or run records from the change-list files, and `Layer::read_into`
/// calls, on this thread since the last `reset_read_counts`. For tests.
#[cfg(test)]
pub fn read_counts() -> (u64, u64) {
  (LIST_READS.with(|c| c.get()), LAYER_READS.with(|c| c.get()))
}
/// Zero the counts of `read_counts`. For tests.
#[cfg(test)]
pub fn reset_read_counts() {
  LIST_READS.with(|c| c.set(0));
  LAYER_READS.with(|c| c.set(0));
}
/// Change-list reads a walk of every layer under `table` needs at least: two
/// passes over the hit records and two over the run records of each. For tests.
#[cfg(test)]
pub fn sequential_read_bound(table: &Table) -> u64 {
  match table.source() {
    Src::Layer(layer) => {
      2 * layer.list.hits.div_ceil(BATCH)
        + 2 * layer.list.runs.div_ceil(BATCH)
        + sequential_read_bound(&layer.under)
    }
    _ => 0,
  }
}

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
/// One checkpoint of a pass: both frames' offset and newlines before it, the
/// hits before it and the run records written before it. Never inside a hit.
#[derive(Clone, Copy, Debug)]
struct Ck {
  pre: u64,
  pre_nl: u64,
  post: u64,
  post_nl: u64,
  hits: u64,
  runs: u64,
}
/// One hit record.
#[derive(Clone, Copy, Debug)]
struct HitRec {
  /// Pre-replace offset.
  offset: u64,
  /// `\n` bytes inserted before this hit's output.
  extra: u64,
  /// 1 when the hit's output starts with an inserted `\n`.
  sep: u64,
}
/// The run record at byte `at` of `raw`.
fn parse_run(raw: &[u8], at: usize) -> Result<(u64, u64), String> {
  let short = || "short record".to_string();
  let word = |from: usize| -> Result<u64, String> {
    let bytes = raw.get(from..from + 8).ok_or_else(short)?;
    Ok(u64::from_le_bytes(bytes.try_into().map_err(|_| short())?))
  };
  Ok((word(at)?, word(at + 8)?))
}

impl HitRec {
  fn parse(raw: &[u8]) -> Result<HitRec, String> {
    let short = || "short record".to_string();
    Ok(HitRec {
      offset: u64::from_le_bytes(
        raw
          .get(..8)
          .ok_or_else(short)?
          .try_into()
          .map_err(|_| short())?,
      ),
      extra: u64::from_le_bytes(
        raw
          .get(8..16)
          .ok_or_else(short)?
          .try_into()
          .map_err(|_| short())?,
      ),
      sep: u64::from(*raw.get(16).ok_or_else(short)? != 0),
    })
  }
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
  /// `\n` bytes inserted over the whole pass (CRLF junctions).
  extras: u64,
  cks: Vec<Ck>,
  pre_len: u64,
  post_len: u64,
  pre_newlines: u64,
  post_newlines: u64,
  /// The run records (`\r` runs rewritten to `\n`), in a file that exists only
  /// when the pass wrote one.
  runs: u64,
  runs_path: PathBuf,
  runs_file: Option<File>,
}

impl Drop for ChangeList {
  fn drop(&mut self) {
    // Close the handles first: Windows will not remove an open file.
    self.file.take();
    self.runs_file.take();
    let _ = fs::remove_file(&self.path);
    let _ = fs::remove_file(&self.runs_path);
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
  /// Run records written (`\r` runs rewritten to `\n`), for tests.
  #[cfg(test)]
  pub fn run_count(&self) -> u64 {
    self.runs
  }
  /// Where the run records live (the file exists only when there are some), for
  /// tests.
  #[cfg(test)]
  pub fn runs_path(&self) -> &Path {
    &self.runs_path
  }
  /// `(offset, bytes inserted before it, inserted byte on it)` of hit `i`, for
  /// tests.
  #[cfg(test)]
  pub fn hit_record(&self, i: u64) -> (u64, u64, bool) {
    let rec = self.hit_at(i).unwrap();
    (rec.offset, rec.extra, rec.sep == 1)
  }

  fn record_size(&self) -> u64 {
    RECORD_FIXED + self.needle_len
  }
  /// `n` consecutive hit records starting at hit `from`, raw.
  fn records(&self, from: u64, n: u64) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    self.records_into(from, n, &mut buf)?;
    Ok(buf)
  }
  /// `records` into `buf`, replacing its contents.
  fn records_into(&self, from: u64, n: u64, buf: &mut Vec<u8>) -> Result<(), String> {
    #[cfg(test)]
    count_list_read();
    let file = self
      .file
      .as_ref()
      .ok_or_else(|| "change list is closed".to_string())?;
    buf.clear();
    file.read_into(
      self.data_start + from * self.record_size(),
      (n * self.record_size()) as usize,
      buf,
    )
  }
  /// Hit `i`.
  fn hit_at(&self, i: u64) -> Result<HitRec, String> {
    HitRec::parse(&self.records(i, 1)?)
  }
  /// `\n` bytes inserted before hit `j`'s output (all of them for `j == hits`).
  fn extras_before(&self, j: u64) -> Result<u64, String> {
    if j < self.hits {
      Ok(self.hit_at(j)?.extra)
    } else {
      Ok(self.extras)
    }
  }
  /// Pre-replace byte offset of the first hit (the same in both frames).
  pub fn first_hit_offset(&self) -> Result<u64, String> {
    Ok(self.hit_at(0)?.offset)
  }
  /// `n` consecutive run records starting at run `from`, into `buf`, replacing
  /// its contents.
  fn run_records_into(&self, from: u64, n: u64, buf: &mut Vec<u8>) -> Result<(), String> {
    #[cfg(test)]
    count_list_read();
    let file = self
      .runs_file
      .as_ref()
      .ok_or_else(|| "run list is closed".to_string())?;
    buf.clear();
    file.read_into(from * RUN_RECORD, (n * RUN_RECORD) as usize, buf)
  }
  /// Index of the first run that ends after `pos` (post-replace frame), or
  /// `runs` when none does, probing through `buf`. Runs are disjoint and
  /// ordered, so the checkpoints bound the search: runs written before the
  /// checkpoint at or before `pos` end before it, and only one run can span the
  /// next checkpoint.
  fn first_run_ending_after(&self, pos: u64, buf: &mut Vec<u8>) -> Result<u64, String> {
    let k = self
      .cks
      .partition_point(|c| c.post <= pos)
      .saturating_sub(1);
    let mut lo = self.cks.get(k).map_or(0, |c| c.runs);
    let mut hi = self
      .cks
      .get(k + 1)
      .map_or(self.runs, |c| (c.runs + 1).min(self.runs));
    while lo < hi {
      let mid = lo + (hi - lo) / 2;
      self.run_records_into(mid, 1, buf)?;
      let (start, len) = parse_run(buf, 0)?;
      if start + len > pos {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    Ok(lo)
  }
  /// An offset of the input frame of `dir` in the output frame. An offset at or
  /// before a hit's start moves by the hits before it; one inside a hit goes to
  /// the end of that hit's output; one at or past its end moves with the hit
  /// counted. A `\n` inserted on a hit belongs to that hit's output: forward, an
  /// offset at or before the hit's start does not count it; backward, an offset
  /// on the inserted byte maps to the hit's start. The hits before the offset
  /// come from the checkpoints and a binary search over the hit records, so the
  /// cost does not depend on line length.
  pub fn map_offset(&self, dir: Dir, offset: u64) -> Result<u64, String> {
    let growth = self.repl.len() as i128 - self.needle_len as i128;
    let out_len = match dir {
      Dir::Forward => self.post_len,
      Dir::Inverse => self.pre_len,
    };
    // Input-frame start and length of hit `i`, and its output-frame start and
    // length.
    let spans = |i: u64, rec: &HitRec| -> (i128, i128, i128, i128) {
      let moved = rec.offset as i128 + i as i128 * growth + rec.extra as i128;
      let grown = self.repl.len() as i128 + rec.sep as i128;
      match dir {
        Dir::Forward => (rec.offset as i128, self.needle_len as i128, moved, grown),
        Dir::Inverse => (moved, grown, rec.offset as i128, self.needle_len as i128),
      }
    };
    let ck_in = |c: &Ck| match dir {
      Dir::Forward => c.pre,
      Dir::Inverse => c.post,
    };
    let at = offset as i128;
    let k = self
      .cks
      .partition_point(|c| ck_in(c) <= offset)
      .saturating_sub(1);
    let hits0 = self.cks.get(k).map_or(0, |c| c.hits);
    let hits1 = self.cks.get(k + 1).map_or(self.hits, |c| c.hits);
    // First hit of the segment whose input ends after the offset.
    let (mut lo, mut hi) = (hits0, hits1);
    while lo < hi {
      let mid = lo + (hi - lo) / 2;
      let (in_start, in_len, _, _) = spans(mid, &self.hit_at(mid)?);
      if in_start + in_len > at {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    let passed = lo as i128 * growth + self.extras_before(lo)? as i128;
    let mut mapped = match dir {
      Dir::Forward => at + passed,
      Dir::Inverse => at - passed,
    };
    if lo < self.hits {
      let (in_start, _, out_start, out_hit) = spans(lo, &self.hit_at(lo)?);
      if at > in_start {
        mapped = out_start + out_hit;
      }
    }
    Ok(mapped.clamp(0, out_len as i128) as u64)
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
  scratch: RefCell<Scratch>,
}
/// Buffers a layer read reuses instead of allocating per read.
#[derive(Default)]
struct Scratch {
  /// The one-read block (see `SPAN_SLACK`).
  block: Vec<u8>,
  /// Hit records of the batch being walked.
  recs: Vec<u8>,
  /// One hit record, for the search of the first hit.
  probe: Vec<u8>,
  /// Run records of the chunk being walked.
  runs: Vec<u8>,
}
/// Build a table over a layer that maps `under` through `list`.
pub fn stack(id: u64, dir: Dir, under: Table, list: Arc<ChangeList>) -> Table {
  let (len, newlines, cks) = list.out_index(dir);
  let layer = Layer {
    id,
    dir,
    under,
    list,
    scratch: RefCell::new(Scratch::default()),
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
/// Which way the layer `table` is exactly over maps, if it is over one. For
/// tests.
#[cfg(test)]
pub fn top_layer_dir(table: &Table) -> Option<Dir> {
  match table.source() {
    Src::Layer(layer) => Some(layer.dir),
    _ => None,
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
  /// An empty batch that fills `data`.
  fn over(data: Vec<u8>) -> Self {
    Batch {
      from: 0,
      count: 0,
      data,
    }
  }
  /// Hit `j` and where its original text starts in `self.data`.
  fn record(&mut self, list: &ChangeList, j: u64) -> Result<(HitRec, usize), String> {
    if j < self.from || j >= self.from + self.count {
      self.from = j;
      self.count = BATCH.min(list.hits - j);
      list.records_into(j, self.count, &mut self.data)?;
    }
    let at = ((j - self.from) * list.record_size()) as usize;
    let rec = HitRec::parse(&self.data[at..])?;
    Ok((rec, at + RECORD_FIXED as usize))
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
  /// Length of hit `rec`'s output.
  fn hit_out_len(&self, rec: &HitRec) -> i128 {
    match self.dir {
      Dir::Forward => self.list.repl.len() as i128 + rec.sep as i128,
      Dir::Inverse => self.list.needle_len as i128,
    }
  }
  /// Position of hit `i` in the output frame.
  fn out_pos(&self, i: u64, rec: &HitRec) -> i128 {
    match self.dir {
      Dir::Forward => {
        rec.offset as i128
          + i as i128 * (self.list.repl.len() as i128 - self.list.needle_len as i128)
          + rec.extra as i128
      }
      Dir::Inverse => rec.offset as i128,
    }
  }
}
/// One step of a layer read, in output order.
enum Step<'a> {
  /// Text between hits, from the table below at `[from, to)`.
  Gap { from: u64, to: u64 },
  /// Output bytes of a hit: an inserted `\n` first when `nl`, then `text`.
  Hit { nl: bool, text: &'a [u8] },
}
/// A read whose input span is no wider than twice the text it takes from the
/// table below (plus this slack) is served by one read of that table; a wider
/// one (long runs of hits dropped from the output) reads gap by gap.
const SPAN_SLACK: u64 = 64 * 1024;
/// The largest one-read block a layer keeps between reads: two scan buffers of
/// 1 MiB, the widest span a save or a scan asks for, plus the slack.
const BLOCK_CAP: usize = 2 * (1 << 20) + SPAN_SLACK as usize;
/// Walks the runs once across the ascending gaps of one read.
struct RunCursor {
  /// The run the walk is at.
  i: u64,
  /// First run in the chunk held in the caller's buffer, and how many it holds.
  from: u64,
  n: u64,
  started: bool,
}

impl RunCursor {
  fn new() -> Self {
    RunCursor {
      i: 0,
      from: 0,
      n: 0,
      started: false,
    }
  }
  /// Set every byte of `buf`, which holds the post-replace frame from `pos`,
  /// that lies in a run to `byte`. `raw` holds the run chunk. Calls ascend in
  /// `pos` and do not overlap.
  fn paint(
    &mut self,
    list: &ChangeList,
    raw: &mut Vec<u8>,
    pos: u64,
    buf: &mut [u8],
    byte: u8,
  ) -> Result<(), String> {
    if list.runs == 0 || buf.is_empty() {
      return Ok(());
    }
    if !self.started {
      self.i = list.first_run_ending_after(pos, raw)?;
      self.from = self.i;
      self.n = 0;
      self.started = true;
    }
    let to = pos + buf.len() as u64;
    while self.i < list.runs {
      if self.i >= self.from + self.n {
        self.from = self.i;
        self.n = BATCH.min(list.runs - self.i);
        list.run_records_into(self.i, self.n, raw)?;
      }
      let (start, len) = parse_run(raw, ((self.i - self.from) * RUN_RECORD) as usize)?;
      if start + len <= pos {
        self.i += 1;
        continue;
      }
      if start >= to {
        break;
      }
      let a = start.max(pos);
      let b = (start + len).min(to);
      buf[(a - pos) as usize..(b - pos) as usize].fill(byte);
      if start + len <= to {
        self.i += 1;
      } else {
        // The run goes on into the next gap.
        break;
      }
    }
    Ok(())
  }
}

impl Layer {
  /// Walk the output `[a, end)` in order, starting at hit `first`, handing each
  /// gap and each hit's output bytes to `f`.
  fn walk(
    &self,
    batch: &mut Batch,
    first: u64,
    a: i128,
    end: i128,
    mut f: impl FnMut(Step) -> Result<(), String>,
  ) -> Result<(), String> {
    let list = &*self.list;
    let growth = list.repl.len() as i128 - list.needle_len as i128;
    let mut j = first;
    let mut cur = a;
    while cur < end {
      let (next_start, rec, text_at) = if j < list.hits {
        let (rec, at) = batch.record(list, j)?;
        (self.out_pos(j, &rec), rec, at)
      } else {
        // Past the last hit the shift counts every inserted byte.
        (
          self.out_len() as i128,
          HitRec {
            offset: 0,
            extra: list.extras,
            sep: 0,
          },
          0,
        )
      };
      if cur < next_start {
        // Text between hits comes from the table below, shifted by the hits
        // already passed and the bytes inserted before them.
        let stop = next_start.min(end);
        let shift = j as i128 * growth + rec.extra as i128;
        let (from, to) = match self.dir {
          Dir::Forward => (cur - shift, stop - shift),
          Dir::Inverse => (cur + shift, stop + shift),
        };
        f(Step::Gap {
          from: from as u64,
          to: to as u64,
        })?;
        cur = stop;
        continue;
      }
      let hit_end = next_start + self.hit_out_len(&rec);
      let to = hit_end.min(end);
      let from_in_hit = (cur - next_start) as usize;
      let to_in_hit = (to - next_start) as usize;
      match self.dir {
        Dir::Forward => {
          // The output is the inserted `\n`, if any, then the replacement.
          let sep = rec.sep as usize;
          f(Step::Hit {
            nl: sep == 1 && from_in_hit == 0 && to_in_hit >= 1,
            text: &list.repl[from_in_hit.saturating_sub(sep)..to_in_hit.saturating_sub(sep)],
          })?;
        }
        Dir::Inverse => f(Step::Hit {
          nl: false,
          text: &batch.data[text_at + from_in_hit..text_at + to_in_hit],
        })?,
      }
      cur = to;
      if cur == hit_end {
        j += 1;
      }
    }
    Ok(())
  }
  /// The body of `read_into`, working in the layer's `scratch`.
  fn read_with(
    &self,
    scratch: &mut Scratch,
    offset: u64,
    len: usize,
    out: &mut Vec<u8>,
  ) -> Result<(), String> {
    let list = &*self.list;
    let a = offset as i128;
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
      list.records_into(mid, 1, &mut scratch.probe)?;
      let rec = HitRec::parse(&scratch.probe)?;
      if self.out_pos(mid, &rec) + self.hit_out_len(&rec) > a {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    let mut batch = Batch::over(std::mem::take(&mut scratch.recs));
    let read = self.assemble(
      &mut batch,
      &mut scratch.block,
      &mut scratch.runs,
      lo,
      offset,
      a + len as i128,
      out,
    );
    // A needle above a few KiB makes a batch larger than the cap: drop it.
    if batch.data.capacity() <= BLOCK_CAP {
      scratch.recs = batch.data;
    }
    read
  }
  /// Append the output `[offset, end)` to `out`, starting at hit `first`: pass
  /// one finds how much of the table below the gaps take, pass two appends.
  #[allow(clippy::too_many_arguments)]
  fn assemble(
    &self,
    batch: &mut Batch,
    block: &mut Vec<u8>,
    runs: &mut Vec<u8>,
    first: u64,
    offset: u64,
    end: i128,
    out: &mut Vec<u8>,
  ) -> Result<(), String> {
    let list = &*self.list;
    let a = offset as i128;
    // One read of the table below covers every gap when the hits between them
    // do not widen the span much.
    let mut lowest = u64::MAX;
    let mut highest = 0u64;
    let mut wanted = 0u64;
    self.walk(batch, first, a, end, |step| {
      if let Step::Gap { from, to } = step {
        lowest = lowest.min(from);
        highest = highest.max(to);
        wanted += to - from;
      }
      Ok(())
    })?;
    let span = highest.saturating_sub(lowest);
    let one_read = wanted > 0 && span <= wanted * 2 + SPAN_SLACK;
    // A wider block is a temporary, freed after the read.
    let mut temp: Vec<u8> = Vec::new();
    let block: &mut Vec<u8> = if span as usize <= BLOCK_CAP {
      block
    } else {
      &mut temp
    };
    block.clear();
    if one_read {
      self.under.read_into(lowest, span as usize, block)?;
    }
    let block: &[u8] = block;
    out.reserve((end - a) as usize);
    let base = out.len();
    let inverse = self.dir == Dir::Inverse;
    let mut cursor = RunCursor::new();
    self.walk(batch, first, a, end, |step| {
      match step {
        Step::Gap { from, to } => {
          let at = out.len();
          if one_read {
            out.extend_from_slice(&block[(from - lowest) as usize..(to - lowest) as usize]);
          } else {
            self.under.read_into(from, (to - from) as usize, out)?;
          }
          // The bytes below that a run rewrote are `\r` in the original text.
          if inverse {
            cursor.paint(list, runs, from, &mut out[at..], b'\r')?;
          }
        }
        Step::Hit { nl, text } => {
          if nl {
            out.push(b'\n');
          }
          out.extend_from_slice(text);
        }
      }
      Ok(())
    })?;
    // Every output byte inside a run is `\n`, whatever its origin.
    if !inverse {
      RunCursor::new().paint(list, runs, offset, &mut out[base..], b'\n')?;
    }
    Ok(())
  }
}

impl OriginalSource for Layer {
  fn read_into(&self, offset: u64, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
    if len == 0 {
      return Ok(());
    }
    if offset as i128 + len as i128 > self.out_len() as i128 {
      return Err("read past layer end".to_string());
    }
    #[cfg(test)]
    count_layer_read();
    // The scratch is out of the cell while `under` is read, so a read through
    // another layer takes that layer's own.
    let mut scratch = std::mem::take(&mut *self.scratch.borrow_mut());
    let at = out.len();
    let read = self.read_with(&mut scratch, offset, len, out);
    if read.is_err() {
      out.truncate(at);
    }
    *self.scratch.borrow_mut() = scratch;
    read
  }
}
/// One coordinate frame of a pass: its break counter, and the checkpoints
/// placed while a final `\r` waited for the frame's next byte (they all wait on
/// that one byte, and each is short of that `\r` until it is known).
struct Frame {
  breaks: BreakCounter,
  waiting: Vec<usize>,
}

impl Frame {
  fn new() -> Self {
    Frame {
      breaks: BreakCounter::new(),
      waiting: Vec::new(),
    }
  }
}
/// What the last byte of the post-replace text is, as far as a junction goes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kept {
  /// Nothing a following `\n` could join.
  No,
  /// A `\r` of a gap; the next byte of the pre-replace text is not known yet.
  Maybe,
  /// A `\r` of a gap that is a lone break in the pre-replace text (a kept CR);
  /// the next post-replace byte is not known yet.
  Lone,
}
/// Writes a change list as a pass finds hits, and places the checkpoints.
///
/// A kept CR followed by a `\n` in the post-replace text is a junction: the
/// pass rewrites it (see the module doc). Only the state of the last post
/// byte, the trailing run of `\r` and one pending hit record are held; a hit
/// record is written one event late because the inserted byte of a CRLF
/// junction can fall on the last hit before the `\n`.
pub struct Builder {
  list: ChangeList,
  writer: BufWriter<File>,
  runs_writer: Option<BufWriter<File>>,
  crlf: bool,
  interval: u64,
  m: u64,
  r: u64,
  last_pre: u64,
  last_post: u64,
  cur_pre: u64,
  cur_post: u64,
  pre: Frame,
  post: Frame,
  hits: u64,
  cks: Vec<Ck>,
  pending: Option<(u64, u64, bool)>,
  pending_text: Vec<u8>,
  kept: Kept,
  /// The pending post `\r` is a break whatever follows it (an LF junction).
  lf_pending: bool,
  /// `\n` bytes inserted so far.
  extra: u64,
  /// LF junctions whose `\n` has been fed: each adds one break to the count.
  adj: u64,
  run_start: u64,
  run_len: u64,
  runs: u64,
  failure: Option<String>,
}

impl Builder {
  /// Start a change list in `dir` for a needle of `needle` bytes (only its
  /// length and newline count matter here) and the replacement `repl`.
  /// Checkpoints are placed so no segment exceeds `interval` bytes in either
  /// frame, except where a single hit is itself longer. `insert_sep` is `"\n"`
  /// or `"\r\n"`: what a kept CR is rewritten to when a `\n` would join it.
  pub fn create(
    dir: &Path,
    needle: &[u8],
    repl: &[u8],
    interval: u64,
    insert_sep: &str,
  ) -> Result<Builder, String> {
    let crlf = match insert_sep {
      "\n" => false,
      "\r\n" => true,
      _ => return Err("invalid insert separator".to_string()),
    };
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0);
    let stem = format!(
      "{FILE_PREFIX}{}-{}-{nanos}",
      std::process::id(),
      NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    );
    let path = dir.join(format!("{stem}{FILE_SUFFIX}"));
    let runs_path = dir.join(format!("{stem}-runs{FILE_SUFFIX}"));
    let file = OpenOptions::new()
      .read(true)
      .write(true)
      .create_new(true)
      .open(&path)
      .map_err(|e| e.to_string())?;
    // From here on the list owns the files: dropping it (a failed or abandoned
    // pass) removes them.
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
      extras: 0,
      cks: Vec::new(),
      pre_len: 0,
      post_len: 0,
      pre_newlines: 0,
      post_newlines: 0,
      runs: 0,
      runs_path,
      runs_file: None,
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
      runs_writer: None,
      crlf,
      interval: interval.max(1),
      m: needle.len() as u64,
      r: repl.len() as u64,
      last_pre: 0,
      last_post: 0,
      cur_pre: 0,
      cur_post: 0,
      pre: Frame::new(),
      post: Frame::new(),
      hits: 0,
      cks: vec![Ck {
        pre: 0,
        pre_nl: 0,
        post: 0,
        post_nl: 0,
        hits: 0,
        runs: 0,
      }],
      pending: None,
      pending_text: Vec::new(),
      kept: Kept::No,
      lf_pending: false,
      extra: 0,
      adj: 0,
      run_start: 0,
      run_len: 0,
      runs: 0,
      failure: None,
    })
  }
  /// What the pass holds in memory besides the checkpoints' count: pending
  /// record text and checkpoints waiting on a byte. For tests.
  #[cfg(test)]
  pub fn state_units(&self) -> usize {
    self.cks.len() + self.pending_text.len() + self.pre.waiting.len() + self.post.waiting.len()
  }
  /// Where the run records will be written, for tests.
  #[cfg(test)]
  pub fn runs_path(&self) -> &Path {
    &self.list.runs_path
  }
  /// Remember the first write error; the next `hit` or `finish` reports it.
  fn fail(&mut self, e: String) {
    self.failure.get_or_insert(e);
  }
  /// Place a checkpoint at the current offsets. A frame whose last byte is a
  /// `\r` cannot tell yet whether that `\r` is a break: the checkpoint waits
  /// for the frame's next byte (see `feed`), unless an LF junction already
  /// made the post frame's `\r` one.
  fn place(&mut self) {
    self.place_with(self.hits);
  }
  /// `place` with `hits` hits counted before the checkpoint: a hit whose
  /// output is still to start at the checkpoint is not one of them.
  fn place_with(&mut self, hits: u64) {
    let at = self.cks.len();
    self.cks.push(Ck {
      pre: self.cur_pre,
      pre_nl: self.pre.breaks.count(),
      post: self.cur_post,
      post_nl: self.post.breaks.count() + self.adj + u64::from(self.lf_pending),
      hits,
      runs: self.runs,
    });
    if self.pre.breaks.pending_cr() {
      self.pre.waiting.push(at);
    }
    if self.post.breaks.pending_cr() && !self.lf_pending {
      self.post.waiting.push(at);
    }
    self.last_pre = self.cur_pre;
    self.last_post = self.cur_post;
  }
  /// Append `bytes` to the pre-replace (`pre`) or post-replace frame. The first
  /// of them settles a `\r` that ended the frame before: it is a break unless
  /// that byte is `\n`, and the checkpoints waiting on it count it with it.
  fn feed(&mut self, pre: bool, bytes: &[u8]) {
    let Some(&first) = bytes.first() else {
      return;
    };
    let frame = if pre { &mut self.pre } else { &mut self.post };
    if frame.breaks.pending_cr() && first != b'\n' {
      for &at in &frame.waiting {
        if pre {
          self.cks[at].pre_nl += 1;
        } else {
          self.cks[at].post_nl += 1;
        }
      }
    }
    frame.waiting.clear();
    frame.breaks.feed(bytes);
    if !pre && self.lf_pending {
      // The `\r` and the `\n` that joined it are two breaks, and the counter
      // saw one pair.
      self.adj += 1;
      self.lf_pending = false;
    }
  }
  /// Follow the run of `\r` that ends the post-replace text (LF style only);
  /// `bytes` start at `cur_post`.
  fn track_run(&mut self, bytes: &[u8]) {
    if self.crlf || bytes.is_empty() {
      return;
    }
    match bytes.iter().rposition(|&b| b != b'\r') {
      Some(i) => {
        self.run_len = (bytes.len() - 1 - i) as u64;
        self.run_start = self.cur_post + i as u64 + 1;
      }
      None => {
        if self.run_len == 0 {
          self.run_start = self.cur_post;
        }
        self.run_len += bytes.len() as u64;
      }
    }
  }
  /// Write the pending hit record.
  fn flush_pending(&mut self) {
    let Some((offset, extra, sep)) = self.pending.take() else {
      return;
    };
    let w = &mut self.writer;
    let done = w
      .write_all(&offset.to_le_bytes())
      .and_then(|_| w.write_all(&extra.to_le_bytes()))
      .and_then(|_| w.write_all(&[u8::from(sep)]))
      .and_then(|_| w.write_all(&self.pending_text));
    if let Err(e) = done {
      self.fail(e.to_string());
    }
  }
  /// Append a run record for the run of `\r` ending at the kept CR, creating
  /// the run file on the first one.
  fn write_run(&mut self) -> Result<(), String> {
    if self.runs_writer.is_none() {
      let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&self.list.runs_path)
        .map_err(|e| e.to_string())?;
      let writer_file = file.try_clone().map_err(|e| e.to_string())?;
      self.list.runs_file = Some(file);
      self.runs_writer = Some(BufWriter::new(writer_file));
    }
    if let Some(w) = self.runs_writer.as_mut() {
      w.write_all(&self.run_start.to_le_bytes())
        .and_then(|_| w.write_all(&self.run_len.to_le_bytes()))
        .map_err(|e| e.to_string())?;
    }
    self.runs += 1;
    Ok(())
  }
  /// An LF junction: the run of `\r` ending at the kept CR becomes `\n`. The
  /// kept CR is a break from here on, for the checkpoints already waiting on
  /// it and for those placed before its `\n` is fed.
  fn lf_junction(&mut self) {
    if let Err(e) = self.write_run() {
      self.fail(e);
    }
    self.lf_pending = true;
    for &at in &self.post.waiting {
      self.cks[at].post_nl += 1;
    }
  }
  /// A gap starting with `first` follows. After a kept CR and hits with no
  /// output it makes a junction, decided here so that a checkpoint at the
  /// gap's start already sees it.
  fn settle_at_gap(&mut self, first: u8) {
    let junction = self.kept == Kept::Lone && first == b'\n';
    self.kept = Kept::No;
    if !junction {
      return;
    }
    if !self.crlf {
      self.lf_junction();
      return;
    }
    // The inserted `\n` belongs to the last hit, whose output starts here.
    let used = self.cur_post - self.last_post;
    if used > 0 && used + 1 > self.interval {
      self.place_with(self.hits - 1);
    }
    if let Some(p) = self.pending.as_mut() {
      p.2 = true;
    }
    self.extra += 1;
    self.feed(false, b"\n");
    self.cur_post += 1;
  }
  /// Text between hits, in order. Both frames advance by its length.
  pub fn gap(&mut self, mut bytes: &[u8]) {
    let (Some(&first), Some(&last)) = (bytes.first(), bytes.last()) else {
      return;
    };
    self.settle_at_gap(first);
    self.flush_pending();
    while !bytes.is_empty() {
      let used = (self.cur_pre - self.last_pre).max(self.cur_post - self.last_post);
      if used >= self.interval {
        self.place();
        continue;
      }
      let take = (self.interval - used).min(bytes.len() as u64) as usize;
      self.feed(true, &bytes[..take]);
      self.feed(false, &bytes[..take]);
      self.track_run(&bytes[..take]);
      self.cur_pre += take as u64;
      self.cur_post += take as u64;
      bytes = &bytes[take..];
    }
    self.kept = if last == b'\r' { Kept::Maybe } else { Kept::No };
  }
  /// The next hit, with the text it matched (the needle's length).
  pub fn hit(&mut self, original: &[u8]) -> Result<(), String> {
    if let Some(e) = self.failure.take() {
      return Err(e);
    }
    if original.len() as u64 != self.m {
      return Err("hit length differs from the needle".to_string());
    }
    // Is the replacement's `\n` about to join a kept CR?
    let lone = match self.kept {
      Kept::No => false,
      Kept::Maybe => original.first() != Some(&b'\n'),
      Kept::Lone => true,
    };
    let joins = lone && self.list.repl.first() == Some(&b'\n');
    let sep = joins && self.crlf;
    let used_pre = self.cur_pre - self.last_pre;
    let used_post = self.cur_post - self.last_post;
    if (used_pre > 0 || used_post > 0)
      && (used_pre + self.m > self.interval || used_post + self.r + u64::from(sep) > self.interval)
    {
      self.place();
    }
    self.flush_pending();
    self.pending = Some((self.cur_pre, self.extra, sep));
    self.pending_text.clear();
    self.pending_text.extend_from_slice(original);
    if sep {
      self.extra += 1;
    }
    self.feed(true, original);
    if joins && !self.crlf {
      self.lf_junction();
    }
    if sep {
      self.feed(false, b"\n");
      self.cur_post += 1;
    }
    let repl = std::mem::take(&mut self.list.repl);
    self.feed(false, &repl);
    self.track_run(&repl);
    self.list.repl = repl;
    self.cur_pre += self.m;
    self.cur_post += self.r;
    self.kept = if lone && self.r == 0 {
      Kept::Lone
    } else {
      Kept::No
    };
    self.hits += 1;
    Ok(())
  }
  /// Flush and seal the change list. `pre_len` is the length of the content
  /// the pass was given and must match what was fed in.
  pub fn finish(mut self, pre_len: u64) -> Result<ChangeList, String> {
    if let Some(e) = self.failure.take() {
      return Err(e);
    }
    if self.cur_pre != pre_len {
      return Err("pass did not cover the content".to_string());
    }
    self.flush_pending();
    if let Some(e) = self.failure.take() {
      return Err(e);
    }
    self.writer.flush().map_err(|e| e.to_string())?;
    if let Some(w) = self.runs_writer.as_mut() {
      w.flush().map_err(|e| e.to_string())?;
    }
    // A `\r` that ends a frame ends the text, so it is a break.
    for (pre, frame) in [(true, &self.pre), (false, &self.post)] {
      if frame.breaks.pending_cr() {
        for &at in &frame.waiting {
          if pre {
            self.cks[at].pre_nl += 1;
          } else {
            self.cks[at].post_nl += 1;
          }
        }
      }
    }
    self.list.hits = self.hits;
    self.list.extras = self.extra;
    self.list.runs = self.runs;
    self.list.cks = self.cks;
    self.list.pre_len = self.cur_pre;
    self.list.post_len = self.cur_post;
    self.list.pre_newlines = self.pre.breaks.finish();
    self.list.post_newlines = self.post.breaks.finish() + self.adj;
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
    let mut b = Builder::create(dir.path(), b"ab", b"xyz", 100, "\n").unwrap();
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
  fn the_run_list_lives_with_the_change_list_and_is_made_only_when_needed() {
    let dir = tempfile::tempdir().unwrap();
    // A pass without a junction has one file.
    let mut b = Builder::create(dir.path(), b"X", b"", 100, "\n").unwrap();
    b.gap(b"a");
    b.hit(b"X").unwrap();
    b.gap(b"b");
    let list = b.finish(3).unwrap();
    assert!(!list.runs_path().exists());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    drop(list);
    // A kept CR, a drop-out and an LF make a run.
    let mut b = Builder::create(dir.path(), b"X", b"", 100, "\n").unwrap();
    b.gap(b"\r");
    b.hit(b"X").unwrap();
    b.gap(b"\n");
    let list = b.finish(3).unwrap();
    let runs = list.runs_path().to_path_buf();
    assert!(runs.exists());
    assert_eq!(list.run_count(), 1);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    // cleanup_tmp takes the run list too.
    let other = dir.path().join("keep.bin");
    fs::write(&other, b"x").unwrap();
    drop(list);
    assert!(!runs.exists(), "the run list goes with the change list");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    fs::remove_file(&other).unwrap();
    // An abandoned pass removes both.
    let mut b = Builder::create(dir.path(), b"X", b"", 100, "\n").unwrap();
    b.gap(b"\r");
    b.hit(b"X").unwrap();
    b.gap(b"\n");
    let runs = b.runs_path().to_path_buf();
    assert!(runs.exists());
    drop(b);
    assert!(!runs.exists());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
  }

  #[test]
  fn cleanup_removes_a_run_list_left_behind() {
    let dir = tempfile::tempdir().unwrap();
    let runs = dir.path().join("cl-1-2-3-runs.bin");
    fs::write(&runs, b"x").unwrap();
    cleanup_tmp(dir.path());
    assert!(!runs.exists());
  }

  #[test]
  fn an_insert_separator_other_than_lf_or_crlf_is_refused_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    for sep in ["", "\r", "\n\n", "x"] {
      let err = Builder::create(dir.path(), b"x", b"y", 100, sep)
        .err()
        .unwrap();
      assert_eq!(err, "invalid insert separator");
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
  }

  #[test]
  fn an_abandoned_builder_leaves_no_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut b = Builder::create(dir.path(), b"ab", b"x", 100, "\n").unwrap();
    b.hit(b"ab").unwrap();
    drop(b);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
  }
}
