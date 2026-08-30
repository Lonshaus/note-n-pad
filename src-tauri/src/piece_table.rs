// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Piece-table core for windowed editing of very large files.
//!
//! The single source of truth for a document's full content lives here in the
//! Rust core; the frontend editor (CodeMirror) only ever loads a sliding
//! window. This module models the document as an original (immutable) buffer
//! plus an append-only add buffer, stitched together by an ordered list of
//! pieces.
//!
//! Coordinates are byte offsets (`u64`) throughout. This module treats content
//! as opaque bytes: it never inspects UTF-8 structure except to count `\n`
//! bytes for line indexing. Keeping edit boundaries on valid UTF-8 character
//! boundaries is entirely the caller's responsibility — the piece table will
//! happily split a multi-byte sequence if asked to, and callers above this
//! layer must not ask.
//!
//! The original buffer is never fully loaded into memory: reads against it go
//! through the `OriginalSource` trait (pread-style random access), implemented
//! for `std::fs::File` (production) and `&[u8]` (tests). Its newline structure
//! is likewise never held densely — see `OriginalIndex` for the sparse
//! checkpoint index and its single-segment decode cache.

use std::cell::RefCell;
use std::fs::File;
use std::io::Write;

/// Random access to the immutable original buffer without loading it whole.
///
/// Implementations must append exactly `len` bytes starting at `offset` to
/// `out`, or return `Err` if the range is out of bounds / the read fails. The
/// piece table only ever requests ranges it knows are in bounds, so an error
/// here signals I/O failure or a caller contract violation, never normal flow.
pub trait OriginalSource {
  fn read_into(&self, offset: u64, len: usize, out: &mut Vec<u8>) -> Result<(), String>;
}

impl OriginalSource for &[u8] {
  fn read_into(&self, offset: u64, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
    let start = usize::try_from(offset).map_err(|_| "offset overflows usize".to_string())?;
    let end = start
      .checked_add(len)
      .ok_or_else(|| "read range overflows usize".to_string())?;
    let slice = self
      .get(start..end)
      .ok_or_else(|| "read past original end".to_string())?;
    out.extend_from_slice(slice);
    Ok(())
  }
}

impl OriginalSource for File {
  fn read_into(&self, offset: u64, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
    let mut buf = vec![0u8; len];
    // pread-style access: does not disturb the file cursor and needs only
    // `&self`, so several reads can interleave without external locking.
    #[cfg(unix)]
    {
      use std::os::unix::fs::FileExt;
      self
        .read_exact_at(&mut buf, offset)
        .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
      use std::os::windows::fs::FileExt;
      let mut done = 0usize;
      while done < len {
        let n = self
          .seek_read(&mut buf[done..], offset + done as u64)
          .map_err(|e| e.to_string())?;
        if n == 0 {
          return Err("read past original end".to_string());
        }
        done += n;
      }
    }
    out.extend_from_slice(&buf);
    Ok(())
  }
}

/// Sparse newline index over the immutable original buffer, plus the read
/// channel to that buffer.
///
/// Instead of one `u64` per line (dense, ~8 bytes/line — 40 MB for a
/// five-million-line file), the original's newline structure is captured as
/// sparse checkpoints taken at a fixed byte interval `I` (chosen by the caller;
/// `windowed` uses 1 MiB). Each checkpoint is `(offset, newlines_before)`:
/// `newlines_before` is the exact count of `\n` bytes in original `[0, offset)`.
/// Checkpoints are ascending in offset, seeded with `(0, 0)`, and never more
/// than `I` bytes apart, so any newline query resolves by binary-searching the
/// checkpoints and scanning at most one `I`-byte segment.
///
/// Checkpoint memory: `16 * ceil(original_len / I)` bytes (one `(u64, u64)` per
/// interval) — for a 240 MB file at `I` = 1 MiB, ~240 entries ≈ 3.75 KiB.
///
/// A single-segment cache holds the decoded newline byte offsets of the most
/// recently queried checkpoint segment (`Vec<u64>`, valid only within that
/// segment). Edits query per keystroke, so decoding an `I`-byte segment on
/// every query would be far too costly; the cache makes repeated queries in the
/// same segment (the common editing pattern) a plain binary search.
///
/// Cache-validity basis: the original buffer is immutable between open and the
/// next save/rebase, so its bytes — and therefore any decoded segment — never
/// change while this index is alive. No invalidation is needed. On save/rebase
/// the whole index (checkpoints and cache) is rebuilt over the new file by
/// `windowed`, discarding stale state wholesale.
///
/// Segment-cache memory: at most one segment's newline offsets — worst case a
/// segment that is entirely `\n` bytes, `8 * I` bytes (one `u64` per newline,
/// at most `I` newlines in an `I`-byte segment); for `I` = 1 MiB that ceiling
/// is 8 MiB, but real text (tens of bytes per line) stays in the low hundreds
/// of KiB.
pub struct OriginalIndex<O: OriginalSource> {
  source: O,
  len: u64,
  total_newlines: u64,
  /// `(offset, newlines_before_offset)`, ascending, seeded with `(0, 0)`,
  /// consecutive entries at most one interval apart. See struct docs.
  checkpoints: Vec<(u64, u64)>,
  /// Decoded newline offsets of the currently cached segment. See struct docs.
  cache: RefCell<SegmentCache>,
  /// Diagnostic: number of segment decodes performed. Read only by tests to
  /// assert cache hits vs cross-segment loads.
  #[cfg(test)]
  loads: std::cell::Cell<u64>,
}

/// The decoded newline positions of one checkpoint segment. `seg == usize::MAX`
/// marks "no segment decoded yet". `newlines` holds the absolute original byte
/// offsets of every `\n` in `[checkpoints[seg].0, segment_end)`, ascending.
struct SegmentCache {
  seg: usize,
  newlines: Vec<u64>,
}

impl<O: OriginalSource> OriginalIndex<O> {
  /// Build an index over `source` (whose total byte length is `len`) from the
  /// sparse `checkpoints` and the original's `total_newlines`. `checkpoints`
  /// must be seeded with `(0, 0)`, ascending in offset, at most one interval
  /// apart, each carrying the newline count strictly before its offset. This
  /// matches the sparse index `windowed`'s single scan collects.
  pub fn new(source: O, len: u64, total_newlines: u64, checkpoints: Vec<(u64, u64)>) -> Self {
    OriginalIndex {
      source,
      len,
      total_newlines,
      checkpoints,
      cache: RefCell::new(SegmentCache {
        seg: usize::MAX,
        newlines: Vec::new(),
      }),
      #[cfg(test)]
      loads: std::cell::Cell::new(0),
    }
  }

  /// Read original bytes `[offset, offset + len)` into `out` (delegates to the
  /// source). Used by the piece table's content reads and streaming save.
  fn read_into(&self, offset: u64, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
    self.source.read_into(offset, len, out)
  }

  /// Index of the checkpoint segment containing `offset`: the last checkpoint
  /// whose offset does not exceed `offset`. `offset == len` lands on the final
  /// segment.
  fn seg_of_offset(&self, offset: u64) -> usize {
    self.checkpoints.partition_point(|&(o, _)| o <= offset) - 1
  }

  /// Ensure segment `seg` is decoded into the cache, pread-ing and scanning it
  /// only on a miss. Correctness relies on the original being immutable for the
  /// index's lifetime (see struct docs), so a cached segment never goes stale.
  fn load_segment(&self, seg: usize) -> Result<(), String> {
    let mut cache = self.cache.borrow_mut();
    if cache.seg == seg {
      return Ok(());
    }
    let start = self.checkpoints[seg].0;
    let end = self
      .checkpoints
      .get(seg + 1)
      .map(|&(o, _)| o)
      .unwrap_or(self.len);
    let mut buf = Vec::with_capacity((end - start) as usize);
    self
      .source
      .read_into(start, (end - start) as usize, &mut buf)?;
    cache.newlines.clear();
    for (i, &b) in buf.iter().enumerate() {
      if b == b'\n' {
        cache.newlines.push(start + i as u64);
      }
    }
    cache.seg = seg;
    #[cfg(test)]
    self.loads.set(self.loads.get() + 1);
    Ok(())
  }

  /// Count of `\n` bytes in original `[0, offset)`.
  fn newlines_before(&self, offset: u64) -> Result<u64, String> {
    let seg = self.seg_of_offset(offset);
    // Checkpoint-aligned offsets (notably 0, the start of every unsplit
    // original piece) carry the exact count already — no decode needed.
    if self.checkpoints[seg].0 == offset {
      return Ok(self.checkpoints[seg].1);
    }
    self.load_segment(seg)?;
    let cache = self.cache.borrow();
    let within = cache.newlines.partition_point(|&p| p < offset) as u64;
    Ok(self.checkpoints[seg].1 + within)
  }

  /// Byte offset of the `ordinal`-th newline (1-based, `1..=total_newlines`)
  /// in the original.
  fn newline_pos(&self, ordinal: u64) -> Result<u64, String> {
    // The ordinal-th newline lives in the last segment whose newline-before
    // count is still below `ordinal`.
    let seg = self.checkpoints.partition_point(|&(_, n)| n < ordinal) - 1;
    self.load_segment(seg)?;
    let cache = self.cache.borrow();
    let idx = (ordinal - self.checkpoints[seg].1 - 1) as usize;
    cache
      .newlines
      .get(idx)
      .copied()
      .ok_or_else(|| "newline ordinal out of range".to_string())
  }

  #[cfg(test)]
  fn segment_loads(&self) -> u64 {
    self.loads.get()
  }
}

/// Which buffer a piece draws its bytes from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Source {
  Original,
  Add,
}

/// A contiguous run of bytes drawn from one source buffer.
///
/// `start`/`len` are offsets within that source buffer (for `Original` these
/// are absolute original-file offsets, so they stay valid across splits).
/// `newlines` caches the number of `\n` bytes inside the run; it must be split
/// exactly when a piece is split so prefix sums stay correct.
#[derive(Clone, Copy, Debug)]
struct Piece {
  source: Source,
  start: u64,
  len: u64,
  newlines: u64,
}

pub struct PieceTable<O: OriginalSource> {
  /// Sparse newline index over the immutable original, plus the read channel
  /// to it. Original-piece newline lookups go through this; add-piece lookups
  /// scan the in-memory add buffer directly.
  index: OriginalIndex<O>,
  /// Append-only edit buffer. Grows on every `insert`, never shrinks; deleted
  /// text simply stops being referenced by any piece.
  add: Vec<u8>,
  pieces: Vec<Piece>,
  /// Prefix sum of piece byte lengths, `len() + 1` entries; `offset_prefix[i]`
  /// is the document byte offset at which `pieces[i]` begins, and the last
  /// entry is the total document length.
  offset_prefix: Vec<u64>,
  /// Prefix sum of piece newline counts, same shape as `offset_prefix`.
  newline_prefix: Vec<u64>,
}

impl<O: OriginalSource> PieceTable<O> {
  /// Build a piece table over the original described by `index`. The document
  /// starts as a single original run when the original is non-empty, else no
  /// pieces at all.
  pub fn new(index: OriginalIndex<O>) -> Self {
    let pieces = if index.len == 0 {
      Vec::new()
    } else {
      vec![Piece {
        source: Source::Original,
        start: 0,
        len: index.len,
        newlines: index.total_newlines,
      }]
    };
    let mut table = PieceTable {
      index,
      add: Vec::new(),
      pieces,
      offset_prefix: Vec::new(),
      newline_prefix: Vec::new(),
    };
    table.rebuild();
    table
  }

  /// Recompute both prefix-sum arrays from `pieces`.
  // ponytail: O(pieces) rebuild after every edit. Fine up to ~10^5 pieces;
  // past that, switch the `Vec<Piece>` for a balanced tree (e.g. rope/order-
  // statistics tree) carrying subtree byte and newline sums, and update
  // prefixes incrementally instead of rebuilding.
  fn rebuild(&mut self) {
    self.offset_prefix.clear();
    self.newline_prefix.clear();
    self.offset_prefix.push(0);
    self.newline_prefix.push(0);
    let mut off = 0u64;
    let mut nl = 0u64;
    for piece in &self.pieces {
      off += piece.len;
      nl += piece.newlines;
      self.offset_prefix.push(off);
      self.newline_prefix.push(nl);
    }
  }

  /// Total document length in bytes.
  pub fn len(&self) -> u64 {
    *self.offset_prefix.last().expect("prefix seeded with 0")
  }

  /// Total line count using split semantics (newline count plus one for a
  /// non-empty document, zero for an empty one) to match `large_file`.
  pub fn line_count(&self) -> u64 {
    let newlines = *self.newline_prefix.last().expect("prefix seeded with 0");
    if self.len() == 0 {
      0
    } else {
      newlines + 1
    }
  }

  /// Number of `\n` bytes in a source-buffer sub-range of `piece`, covering
  /// local offsets `[from, to)` measured from the piece's own start.
  fn source_newlines(&self, piece: &Piece, from: u64, to: u64) -> Result<u64, String> {
    match piece.source {
      Source::Original => {
        let a = piece.start + from;
        let b = piece.start + to;
        // ponytail: when `[a, b)` straddles a checkpoint boundary the two
        // `newlines_before` calls decode two different segments, evicting
        // each other; local edits keep both ends in one segment so this
        // stays a cache hit. Add a two-slot cache only if wide original
        // splits ever dominate.
        Ok(self.index.newlines_before(b)? - self.index.newlines_before(a)?)
      }
      Source::Add => {
        let s = (piece.start + from) as usize;
        let e = (piece.start + to) as usize;
        Ok(self.add[s..e].iter().filter(|&&c| c == b'\n').count() as u64)
      }
    }
  }

  /// Split `piece` at local offset `loc`, returning the left and right halves
  /// with `newlines` correctly partitioned. `loc` must satisfy `0 < loc <
  /// piece.len`.
  fn split_piece(&self, piece: &Piece, loc: u64) -> Result<(Piece, Piece), String> {
    let left_nl = self.source_newlines(piece, 0, loc)?;
    let left = Piece {
      source: piece.source,
      start: piece.start,
      len: loc,
      newlines: left_nl,
    };
    let right = Piece {
      source: piece.source,
      start: piece.start + loc,
      len: piece.len - loc,
      newlines: piece.newlines - left_nl,
    };
    Ok((left, right))
  }

  /// Ensure a piece boundary exists exactly at document offset `offset`,
  /// splitting a straddling piece if needed. Returns the index of the first
  /// piece that starts at `offset` (or `pieces.len()` when `offset == len`).
  fn split_at(&mut self, offset: u64) -> Result<usize, String> {
    if offset > self.len() {
      return Err("offset out of range".to_string());
    }
    let mut acc = 0u64;
    let mut i = 0;
    while i < self.pieces.len() {
      if offset == acc {
        return Ok(i);
      }
      let plen = self.pieces[i].len;
      if offset < acc + plen {
        let loc = offset - acc;
        let (left, right) = self.split_piece(&self.pieces[i], loc)?;
        self.pieces[i] = left;
        self.pieces.insert(i + 1, right);
        return Ok(i + 1);
      }
      acc += plen;
      i += 1;
    }
    // offset == len falls through to here.
    Ok(self.pieces.len())
  }

  /// Insert `bytes` at document offset `offset`. `offset` may equal `len()`
  /// (append). An empty `bytes` is a no-op. Out-of-range offset returns `Err`.
  pub fn insert(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
    if offset > self.len() {
      return Err("insert offset out of range".to_string());
    }
    if bytes.is_empty() {
      return Ok(());
    }
    let start = self.add.len() as u64;
    let newlines = bytes.iter().filter(|&&c| c == b'\n').count() as u64;
    self.add.extend_from_slice(bytes);
    let idx = self.split_at(offset)?;
    // ponytail: adjacent pieces from the same source that happen to be
    // byte-contiguous are never merged. Correctness first; merging is a
    // fragmentation optimization to add only if piece counts blow up.
    self.pieces.insert(
      idx,
      Piece {
        source: Source::Add,
        start,
        len: bytes.len() as u64,
        newlines,
      },
    );
    self.rebuild();
    Ok(())
  }

  /// Delete document bytes `[start, end)`. `start == end` is a no-op. Any of
  /// `start > end`, `end > len()` returns `Err`.
  pub fn delete(&mut self, start: u64, end: u64) -> Result<(), String> {
    if start > end {
      return Err("delete start after end".to_string());
    }
    if end > self.len() {
      return Err("delete end out of range".to_string());
    }
    if start == end {
      return Ok(());
    }
    // Split at `start` first; the split at `end` (>= start) only inserts at
    // an index >= `s`, so `s` stays valid.
    let s = self.split_at(start)?;
    let e = match self.split_at(end) {
      Ok(e) => e,
      Err(err) => {
        // The first split already mutated `pieces`. A split is
        // content-preserving, so rebuilding the prefix sums fully
        // restores consistency; without this, a later read would index
        // the stale prefixes out of bounds and panic.
        self.rebuild();
        return Err(err);
      }
    };
    self.pieces.drain(s..e);
    self.rebuild();
    Ok(())
  }

  /// Read document bytes `[start, end)`. Out-of-range or inverted range
  /// returns `Err`.
  pub fn read(&self, start: u64, end: u64) -> Result<Vec<u8>, String> {
    if start > end {
      return Err("read start after end".to_string());
    }
    if end > self.len() {
      return Err("read end out of range".to_string());
    }
    let mut out = Vec::with_capacity((end - start) as usize);
    if start == end {
      return Ok(out);
    }
    for (i, piece) in self.pieces.iter().enumerate() {
      let p_start = self.offset_prefix[i];
      let p_end = self.offset_prefix[i + 1];
      if p_end <= start {
        continue;
      }
      if p_start >= end {
        break;
      }
      // Intersect the request with this piece, in local piece coordinates.
      let from = start.max(p_start) - p_start;
      let to = end.min(p_end) - p_start;
      match piece.source {
        Source::Original => {
          self
            .index
            .read_into(piece.start + from, (to - from) as usize, &mut out)?;
        }
        Source::Add => {
          let a = (piece.start + from) as usize;
          let b = (piece.start + to) as usize;
          out.extend_from_slice(&self.add[a..b]);
        }
      }
    }
    Ok(out)
  }

  /// Document byte offset at which `line` begins (0-based line index). Valid
  /// lines are `0..line_count()`; anything else returns `Err`.
  pub fn line_to_offset(&self, line: u64) -> Result<u64, String> {
    if line >= self.line_count() {
      return Err("line out of range".to_string());
    }
    if line == 0 {
      return Ok(0);
    }
    // Line `line` starts one byte past the `line`-th newline (1-based).
    // Find the piece whose newline prefix range contains that newline.
    let piece_idx = self.newline_prefix.partition_point(|&n| n < line) - 1;
    let k = line - self.newline_prefix[piece_idx]; // 1-based within the piece
    let nl_offset = self.newline_doc_offset(piece_idx, k)?;
    Ok(nl_offset + 1)
  }

  /// Document byte offset of the `k`-th newline (1-based) inside `pieces[idx]`.
  fn newline_doc_offset(&self, idx: usize, k: u64) -> Result<u64, String> {
    let piece = &self.pieces[idx];
    let doc_start = self.offset_prefix[idx];
    match piece.source {
      Source::Original => {
        let ps = piece.start;
        // The k-th newline at or after `ps` is the `(n + k)`-th newline of
        // the whole original, where `n` newlines precede `ps`.
        let n = self.index.newlines_before(ps)?;
        let newline_pos = self.index.newline_pos(n + k)?;
        Ok(doc_start + (newline_pos - ps))
      }
      Source::Add => {
        let base = piece.start as usize;
        let end = base + piece.len as usize;
        let mut count = 0u64;
        for (i, &b) in self.add[base..end].iter().enumerate() {
          if b == b'\n' {
            count += 1;
            if count == k {
              return Ok(doc_start + i as u64);
            }
          }
        }
        Err("newline index out of range".to_string())
      }
    }
  }

  /// 0-based line index containing document byte `offset`, i.e. the number of
  /// newlines strictly before `offset`. `offset` may equal `len()`; anything
  /// larger returns `Err`.
  // Public inverse of `line_to_offset`, exercised by this module's tests and by
  // the windowed undo/redo commands (jump-to-change line lookup).
  pub fn offset_to_line(&self, offset: u64) -> Result<u64, String> {
    if offset > self.len() {
      return Err("offset out of range".to_string());
    }
    let piece_idx = self.offset_prefix.partition_point(|&o| o <= offset) - 1;
    // For `offset == len` the search lands on the last piece boundary; treat
    // that as "all newlines counted".
    if piece_idx >= self.pieces.len() {
      return Ok(*self.newline_prefix.last().expect("prefix seeded with 0"));
    }
    let local = offset - self.offset_prefix[piece_idx];
    let within = self.source_newlines(&self.pieces[piece_idx], 0, local)?;
    Ok(self.newline_prefix[piece_idx] + within)
  }

  /// Stream the whole document to `out`, piece by piece. Original pieces are
  /// copied from the original source in `buf_size`-byte slices so no more than
  /// one buffer of any original piece is ever held in memory; add pieces are
  /// written straight from the in-memory add buffer. Used by the save path to
  /// write a very large document without materializing it whole.
  pub fn write_all<W: Write>(&self, out: &mut W, buf_size: usize) -> Result<(), String> {
    let cap = buf_size.max(1);
    let mut scratch: Vec<u8> = Vec::with_capacity(cap);
    for piece in &self.pieces {
      match piece.source {
        Source::Original => {
          let mut off = piece.start;
          let mut remaining = piece.len;
          while remaining > 0 {
            let take = remaining.min(cap as u64) as usize;
            scratch.clear();
            self.index.read_into(off, take, &mut scratch)?;
            out.write_all(&scratch).map_err(|e| e.to_string())?;
            off += take as u64;
            remaining -= take as u64;
          }
        }
        Source::Add => {
          let a = piece.start as usize;
          let b = (piece.start + piece.len) as usize;
          out.write_all(&self.add[a..b]).map_err(|e| e.to_string())?;
        }
      }
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  /// Sparse checkpoint interval used by most tests. Deliberately tiny so small
  /// fixtures still span several segments, exercising the cross-segment paths.
  const TEST_INTERVAL: u64 = 8;

  /// Build a sparse `OriginalIndex` over `source`, whose content is exactly
  /// `bytes`, using `interval`-byte checkpoints. Mirrors the single scan
  /// `windowed` performs (checkpoint at every interval boundary, carrying the
  /// newline count strictly before that offset).
  fn build_index<O: OriginalSource>(source: O, bytes: &[u8], interval: u64) -> OriginalIndex<O> {
    let mut checkpoints = vec![(0u64, 0u64)];
    let mut last = 0u64;
    let mut newlines = 0u64;
    for (i, &b) in bytes.iter().enumerate() {
      let abs = i as u64;
      if abs - last >= interval {
        checkpoints.push((abs, newlines));
        last = abs;
      }
      if b == b'\n' {
        newlines += 1;
      }
    }
    OriginalIndex::new(source, bytes.len() as u64, newlines, checkpoints)
  }

  /// Slice-backed index at the default test interval.
  fn slice_index(bytes: &[u8]) -> OriginalIndex<&[u8]> {
    build_index(bytes, bytes, TEST_INTERVAL)
  }

  // --- Naive reference model over a plain Vec<u8> ---------------------------

  fn ref_line_count(c: &[u8]) -> u64 {
    if c.is_empty() {
      0
    } else {
      c.iter().filter(|&&b| b == b'\n').count() as u64 + 1
    }
  }

  fn ref_line_to_offset(c: &[u8], line: u64) -> u64 {
    if line == 0 {
      return 0;
    }
    let mut seen = 0u64;
    for (i, &b) in c.iter().enumerate() {
      if b == b'\n' {
        seen += 1;
        if seen == line {
          return (i + 1) as u64;
        }
      }
    }
    panic!("reference line_to_offset out of range");
  }

  fn ref_offset_to_line(c: &[u8], offset: u64) -> u64 {
    c[..offset as usize].iter().filter(|&&b| b == b'\n').count() as u64
  }

  /// Slice-backed source that fails exactly the `fail_on`-th `read_into` call
  /// (1-based) and succeeds on every other. Models a transient pread fault,
  /// e.g. the original file truncated or removed externally mid-operation.
  struct FailingSource {
    bytes: Vec<u8>,
    calls: std::cell::Cell<usize>,
    fail_on: usize,
  }
  impl OriginalSource for FailingSource {
    fn read_into(&self, offset: u64, len: usize, out: &mut Vec<u8>) -> Result<(), String> {
      let n = self.calls.get() + 1;
      self.calls.set(n);
      if n == self.fail_on {
        return Err("injected read fault".to_string());
      }
      self.bytes.as_slice().read_into(offset, len, out)
    }
  }

  #[test]
  fn delete_stays_consistent_when_second_split_read_fails() {
    // 20 bytes at TEST_INTERVAL=8 → segments at offsets 0, 8, 16. Deleting
    // [2, 18) splits inside segment 0 (first segment load) and then inside
    // segment 2 (second load). Failing that second load used to leave
    // `pieces` split with stale prefix sums, so a later read panicked on an
    // out-of-bounds prefix index; the error path must rebuild instead.
    let content = b"aaaa\nbbbb\ncccc\ndddd\n".to_vec();
    let src = FailingSource {
      bytes: content.clone(),
      calls: std::cell::Cell::new(0),
      fail_on: 2,
    };
    let index = build_index(src, &content, TEST_INTERVAL);
    let mut t = PieceTable::new(index);
    let err = t.delete(2, 18).unwrap_err();
    assert!(
      err.contains("injected read fault"),
      "unexpected error: {err}"
    );
    // The failed delete must leave the table fully consistent: identical
    // content and geometry, and the same edit must succeed once the source
    // recovers (only the second read call ever fails).
    assert_eq!(t.len(), 20);
    assert_eq!(t.line_count(), 5);
    assert_eq!(t.read(0, 20).unwrap(), content);
    t.delete(2, 18).unwrap();
    assert_eq!(t.read(0, t.len()).unwrap(), b"aad\n".to_vec());
  }

  /// Minimal LCG (Numerical Recipes constants) for reproducible pseudo-random
  /// operation sequences without pulling in a dependency.
  struct Lcg(u64);
  impl Lcg {
    fn next_u64(&mut self) -> u64 {
      self.0 = self
        .0
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
      self.0
    }
    fn below(&mut self, n: u64) -> u64 {
      if n == 0 {
        return 0;
      }
      self.next_u64() % n
    }
  }

  /// Run a fixed-seed sequence of random inserts/deletes against both the
  /// piece table and a naive Vec<u8>, asserting agreement at every step.
  fn fuzz_against_reference<O: OriginalSource>(mut pt: PieceTable<O>, original: &[u8]) {
    let mut reference: Vec<u8> = original.to_vec();
    let mut rng = Lcg(0x1234_5678_9abc_def0);
    let alphabet = b"ab\nc\n\xe4\xbd\xa0"; // ASCII, newlines, a multi-byte UTF-8 char
    for _ in 0..400 {
      let len = reference.len() as u64;
      if rng.below(2) == 0 || len == 0 {
        // Insert.
        let offset = rng.below(len + 1);
        let n = rng.below(6) as usize;
        let mut bytes = Vec::with_capacity(n);
        for _ in 0..n {
          bytes.push(alphabet[rng.below(alphabet.len() as u64) as usize]);
        }
        pt.insert(offset, &bytes).unwrap();
        reference.splice(offset as usize..offset as usize, bytes.iter().copied());
      } else {
        // Delete a random sub-range.
        let start = rng.below(len);
        let end = start + rng.below(len - start + 1);
        pt.delete(start, end).unwrap();
        reference.drain(start as usize..end as usize);
      }

      assert_eq!(pt.len(), reference.len() as u64, "len mismatch");
      assert_eq!(
        pt.line_count(),
        ref_line_count(&reference),
        "line_count mismatch"
      );

      // Sampled reads.
      let dlen = reference.len() as u64;
      for _ in 0..4 {
        let a = rng.below(dlen + 1);
        let b = a + rng.below(dlen - a + 1);
        assert_eq!(
          pt.read(a, b).unwrap(),
          reference[a as usize..b as usize].to_vec(),
          "read mismatch"
        );
      }

      // Random line_to_offset / offset_to_line.
      let lc = ref_line_count(&reference);
      if lc > 0 {
        let line = rng.below(lc);
        assert_eq!(
          pt.line_to_offset(line).unwrap(),
          ref_line_to_offset(&reference, line),
          "line_to_offset mismatch"
        );
      }
      let off = rng.below(dlen + 1);
      assert_eq!(
        pt.offset_to_line(off).unwrap(),
        ref_offset_to_line(&reference, off),
        "offset_to_line mismatch"
      );
    }
  }

  #[test]
  fn fuzz_slice_source() {
    let original = b"hello\nworld\nthis is a document\nwith several lines\n";
    let pt = PieceTable::new(slice_index(original));
    fuzz_against_reference(pt, original);
  }

  #[test]
  fn fuzz_slice_source_empty_original() {
    let original: &[u8] = b"";
    let pt = PieceTable::new(slice_index(original));
    fuzz_against_reference(pt, original);
  }

  #[test]
  fn fuzz_file_source() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let original = b"hello\nworld\nthis is a document\nwith several lines\n";
    file.write_all(original).unwrap();
    file.flush().unwrap();
    let handle = File::open(file.path()).unwrap();
    let pt = PieceTable::new(build_index(handle, original, TEST_INTERVAL));
    fuzz_against_reference(pt, original);
  }

  #[test]
  fn empty_table_basics() {
    let mut pt = PieceTable::new(slice_index(b""));
    assert_eq!(pt.len(), 0);
    assert_eq!(pt.line_count(), 0);
    assert_eq!(pt.read(0, 0).unwrap(), Vec::<u8>::new());
    assert!(pt.line_to_offset(0).is_err());
    assert_eq!(pt.offset_to_line(0).unwrap(), 0);
    // Empty insert on empty table stays empty.
    pt.insert(0, b"").unwrap();
    assert_eq!(pt.len(), 0);
  }

  #[test]
  fn insert_boundaries() {
    let original = b"abc";
    let mut pt = PieceTable::new(slice_index(original));
    // At offset 0 (prepend).
    pt.insert(0, b"X").unwrap();
    assert_eq!(pt.read(0, pt.len()).unwrap(), b"Xabc");
    // At offset == len (append).
    let end = pt.len();
    pt.insert(end, b"Y").unwrap();
    assert_eq!(pt.read(0, pt.len()).unwrap(), b"XabcY");
    // In the middle (splits a piece).
    pt.insert(2, b"Z").unwrap();
    assert_eq!(pt.read(0, pt.len()).unwrap(), b"XaZbcY");
    // Out-of-range insert errors.
    assert!(pt.insert(pt.len() + 1, b"!").is_err());
  }

  #[test]
  fn delete_whole_and_across_pieces() {
    let original = b"one\ntwo\n";
    let mut pt = PieceTable::new(slice_index(original));
    // Build several pieces via inserts.
    pt.insert(4, b"INS\n").unwrap(); // "one\nINS\ntwo\n"
    pt.insert(0, b"HEAD ").unwrap(); // "HEAD one\nINS\ntwo\n"
    assert_eq!(pt.read(0, pt.len()).unwrap(), b"HEAD one\nINS\ntwo\n");
    // Delete a range spanning multiple pieces (original + add + original).
    pt.delete(3, 12).unwrap();
    let expected = {
      let mut v = b"HEAD one\nINS\ntwo\n".to_vec();
      v.drain(3..12);
      v
    };
    assert_eq!(pt.read(0, pt.len()).unwrap(), expected);
    // Delete the entire remaining document.
    pt.delete(0, pt.len()).unwrap();
    assert_eq!(pt.len(), 0);
    assert_eq!(pt.line_count(), 0);
  }

  #[test]
  fn delete_range_errors() {
    let original = b"abcdef";
    let mut pt = PieceTable::new(slice_index(original));
    assert!(pt.delete(4, 2).is_err()); // start after end
    assert!(pt.delete(0, 7).is_err()); // end past len
    assert!(pt.read(0, 7).is_err()); // read past len
    assert!(pt.read(5, 3).is_err()); // inverted read
    assert!(pt.offset_to_line(7).is_err()); // offset past len
    assert!(pt.line_to_offset(99).is_err()); // line out of range
                                             // No-op delete leaves content intact.
    pt.delete(2, 2).unwrap();
    assert_eq!(pt.read(0, pt.len()).unwrap(), b"abcdef");
  }

  #[test]
  fn multibyte_roundtrip() {
    // A string mixing ASCII and multi-byte UTF-8 characters.
    let original = "café — 日本語\nsecond line\n".as_bytes();
    let mut pt = PieceTable::new(slice_index(original));
    // Insert more multi-byte content in the middle of the document.
    let ins = "🍜🎌".as_bytes();
    pt.insert(5, ins).unwrap();
    let got = pt.read(0, pt.len()).unwrap();
    let mut expected = original.to_vec();
    expected.splice(5..5, ins.iter().copied());
    assert_eq!(
      got, expected,
      "multi-byte content must round-trip byte-for-byte"
    );
  }

  #[test]
  fn line_index_after_edits() {
    let original = b"L0\nL1\nL2\n"; // 4 lines (trailing newline)
    let mut pt = PieceTable::new(slice_index(original));
    assert_eq!(pt.line_count(), 4);
    assert_eq!(pt.line_to_offset(0).unwrap(), 0);
    assert_eq!(pt.line_to_offset(1).unwrap(), 3);
    assert_eq!(pt.line_to_offset(3).unwrap(), 9);
    assert_eq!(pt.offset_to_line(0).unwrap(), 0);
    assert_eq!(pt.offset_to_line(3).unwrap(), 1);
    assert_eq!(pt.offset_to_line(9).unwrap(), 3);
    // Insert a newline inside line 1, shifting later line offsets.
    pt.insert(4, b"X\nY").unwrap(); // "L0\nLX\nY1\nL2\n"
    assert_eq!(pt.read(0, pt.len()).unwrap(), b"L0\nLX\nY1\nL2\n");
    assert_eq!(pt.line_count(), 5);
    assert_eq!(pt.line_to_offset(2).unwrap(), 6);
    assert_eq!(pt.offset_to_line(6).unwrap(), 2);
  }

  /// Sparse vs dense: over an unedited original (pure `Original` pieces, so
  /// every query routes through the checkpoint index), the piece table must
  /// agree with a naive dense line-start table on `line_to_offset` /
  /// `offset_to_line` for random lines and offsets, including checkpoint
  /// boundaries, file head/tail, and offsets sitting exactly on newlines.
  #[test]
  fn sparse_matches_dense_over_original() {
    // Mixed line lengths (some far longer than the interval, some shorter)
    // so segment boundaries land mid-line, on line starts, and on newlines.
    let mut content: Vec<u8> = Vec::new();
    let mut rng = Lcg(0xdead_beef_0000_0001);
    for _ in 0..600 {
      let line_len = rng.below(40) as usize;
      for _ in 0..line_len {
        content.push(b'a' + (rng.below(26) as u8));
      }
      content.push(b'\n');
    }
    // A trailing line with no newline, to cover the "past last newline" tail.
    content.extend_from_slice(b"trailing-no-newline");

    // Use a modest interval so many checkpoints exist across the document.
    let index = build_index(&content[..], &content, 37);
    let pt = PieceTable::new(index);

    assert_eq!(pt.line_count(), ref_line_count(&content));

    let lc = pt.line_count();
    for _ in 0..500 {
      let line = rng.below(lc);
      assert_eq!(
        pt.line_to_offset(line).unwrap(),
        ref_line_to_offset(&content, line),
        "line_to_offset mismatch at line {line}"
      );
    }
    let dlen = content.len() as u64;
    for _ in 0..500 {
      let off = rng.below(dlen + 1);
      assert_eq!(
        pt.offset_to_line(off).unwrap(),
        ref_offset_to_line(&content, off),
        "offset_to_line mismatch at offset {off}"
      );
    }
    // Exhaustively check every checkpoint boundary and the byte on each side,
    // plus the exact newline offsets, plus head and tail.
    let mut probes: Vec<u64> = vec![0, dlen];
    for (o, _) in pt.index.checkpoints.iter() {
      for d in [-1i64, 0, 1] {
        let p = *o as i64 + d;
        if p >= 0 && p as u64 <= dlen {
          probes.push(p as u64);
        }
      }
    }
    for (i, &b) in content.iter().enumerate() {
      if b == b'\n' {
        probes.push(i as u64); // exactly on the newline byte
        probes.push(i as u64 + 1); // exactly on the following line start
      }
    }
    for off in probes {
      assert_eq!(
        pt.offset_to_line(off).unwrap(),
        ref_offset_to_line(&content, off),
        "offset_to_line mismatch at probe {off}"
      );
    }
  }

  /// Segment cache: repeated queries inside one checkpoint segment decode it
  /// once (hits thereafter); a query in a different segment forces a fresh
  /// decode. Verified via the diagnostic load counter.
  #[test]
  fn segment_cache_hits_and_cross_segment_loads() {
    // 400 single-char lines "x\n" => 800 bytes; interval 100 => 8 segments.
    let mut content: Vec<u8> = Vec::new();
    for _ in 0..400 {
      content.extend_from_slice(b"x\n");
    }
    let index = build_index(&content[..], &content, 100);
    let pt = PieceTable::new(index);

    // First query decodes the segment holding offset 10.
    let _ = pt.offset_to_line(10).unwrap();
    let after_first = pt.index.segment_loads();
    assert_eq!(
      after_first, 1,
      "first query must decode exactly one segment"
    );

    // Repeated queries within the same (first) segment: pure cache hits.
    for off in [0u64, 5, 20, 50, 99] {
      let _ = pt.offset_to_line(off).unwrap();
    }
    assert_eq!(
      pt.index.segment_loads(),
      after_first,
      "same-segment queries must not decode again"
    );

    // A query deep in a later segment forces one more decode.
    let _ = pt.offset_to_line(750).unwrap();
    assert_eq!(
      pt.index.segment_loads(),
      after_first + 1,
      "cross-segment query must decode exactly once more"
    );

    // Values stay correct regardless of cache state.
    for off in [0u64, 99, 100, 400, 750, 799, 800] {
      assert_eq!(
        pt.offset_to_line(off).unwrap(),
        ref_offset_to_line(&content, off),
        "cached query returned wrong line at {off}"
      );
    }
  }

  /// A single line far longer than the checkpoint interval: several
  /// consecutive checkpoints carry the same newline count, and a split inside
  /// that line counts zero newlines across the segments it spans.
  #[test]
  fn long_line_exceeding_interval() {
    let interval = 1024u64;
    let long_len = 5000usize; // > 4 intervals with no newline
    let mut content: Vec<u8> = vec![b'a'; long_len];
    content.push(b'\n'); // end of the long line 0
    content.extend_from_slice(b"tail\n"); // line 1
    let dlen = content.len() as u64;

    let index = build_index(&content[..], &content, interval);
    // Several checkpoints must fall inside the newline-free run.
    assert!(
      index.checkpoints.len() >= 4,
      "long line should span segments"
    );
    let mut pt = PieceTable::new(index);

    // "aaaa…\ntail\n" ends with a newline, so split semantics give 3 lines
    // (long line, "tail", trailing empty line).
    assert_eq!(pt.line_count(), 3);
    assert_eq!(pt.line_to_offset(0).unwrap(), 0);
    assert_eq!(pt.line_to_offset(1).unwrap(), long_len as u64 + 1);
    assert_eq!(pt.line_to_offset(2).unwrap(), dlen);
    // Offsets anywhere inside the long line are all line 0.
    for off in [0u64, 1, 1023, 1024, 2048, 4999, long_len as u64] {
      assert_eq!(
        pt.offset_to_line(off).unwrap(),
        0,
        "inside long line at {off}"
      );
    }
    assert_eq!(pt.offset_to_line(long_len as u64 + 1).unwrap(), 1);
    assert_eq!(pt.offset_to_line(dlen).unwrap(), 2);

    // Split the long line by inserting mid-way: the split's newline counting
    // spans multiple newline-free segments and must count zero there.
    pt.insert(2500, b"Z").unwrap();
    let mut expected = content.clone();
    expected.splice(2500..2500, std::iter::once(b'Z'));
    assert_eq!(pt.read(0, pt.len()).unwrap(), expected);
    assert_eq!(pt.line_count(), 3);
    // Line 1 now starts one byte later.
    assert_eq!(pt.line_to_offset(1).unwrap(), long_len as u64 + 2);
  }
}
