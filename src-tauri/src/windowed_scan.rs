// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Chunked substring scans over a windowed session's content. The scans know
//! nothing about sessions: they pull bytes through a `read` closure, which is
//! where the caller takes its lock (one chunk at a time) and checks that the
//! content has not changed since the scan began.
//!
//! The matching rule is the viewer's (`large_file::find_sub`: ASCII-only case
//! folding) with one tightening: hits are leftmost and non-overlapping across
//! chunk boundaries too, so the result never depends on the chunk size.

use crate::large_file::find_sub;
/// Why a scan ended without finishing.
#[derive(Debug, PartialEq, Eq)]
pub enum ScanStop {
  /// The session's content changed after the scan began: nothing found so far
  /// may be trusted.
  Stale,
  /// The caller asked the scan to stop.
  Cancelled,
  /// The session is gone or a read failed.
  Failed(String),
}
/// What the scan reports, in file order.
pub enum Event<'a> {
  /// Bytes outside any hit. Gaps and hits tile the scanned range exactly.
  Gap { bytes: &'a [u8] },
  /// A hit at absolute byte `off`: `buf[idx..]` starts with its text and `buf`
  /// holds the text around it (for a preview).
  Hit { off: u64, buf: &'a [u8], idx: usize },
}
/// Whether the scan goes on after an event.
pub enum Flow {
  Continue,
  Stop,
}

pub type Reader<'r> = dyn FnMut(u64, usize) -> Result<Vec<u8>, ScanStop> + 'r;
/// Scan `[start, limit)` forward in `chunk`-byte reads, reporting gaps and
/// leftmost non-overlapping hits of `needle` in order. A hit lies wholly inside
/// the range. The unconsumed tail of a chunk (the last `needle.len() - 1`
/// bytes) is carried into the next, so a hit straddling a boundary is found;
/// a hit starting inside the previous one is skipped.
pub fn scan_forward(
  start: u64,
  limit: u64,
  needle: &[u8],
  case_sensitive: bool,
  chunk: usize,
  read: &mut Reader<'_>,
  visit: &mut dyn FnMut(Event<'_>) -> Result<Flow, ScanStop>,
) -> Result<(), ScanStop> {
  let m = needle.len();
  if m == 0 {
    return Err(ScanStop::Failed("empty query".to_string()));
  }
  let chunk = chunk.max(1);
  // Next absolute byte to read, the absolute offset of `combined[0]`, and the
  // offset before which everything has been reported.
  let mut pos = start;
  let mut base = start;
  let mut emitted = start;
  let mut combined: Vec<u8> = Vec::new();
  loop {
    let want = (limit - pos).min(chunk as u64) as usize;
    let last = pos + want as u64 >= limit;
    if want > 0 {
      let data = read(pos, want)?;
      if data.len() != want {
        return Err(ScanStop::Failed("short read".to_string()));
      }
      combined.extend_from_slice(&data);
      pos += want as u64;
    }
    loop {
      let from = (emitted - base) as usize;
      let Some(rel) = find_sub(&combined[from..], needle, case_sensitive) else {
        break;
      };
      let idx = from + rel;
      let off = base + idx as u64;
      if idx > from {
        if let Flow::Stop = visit(Event::Gap {
          bytes: &combined[from..idx],
        })? {
          return Ok(());
        }
      }
      if let Flow::Stop = visit(Event::Hit {
        off,
        buf: &combined,
        idx,
      })? {
        return Ok(());
      }
      emitted = off + m as u64;
    }
    let from = (emitted - base) as usize;
    if last {
      if from < combined.len() {
        visit(Event::Gap {
          bytes: &combined[from..],
        })?;
      }
      return Ok(());
    }
    // No hit can start before the last `m - 1` bytes without being seen, so
    // everything before them is settled.
    let safe = base + combined.len().saturating_sub(m - 1) as u64;
    if safe > emitted {
      if let Flow::Stop = visit(Event::Gap {
        bytes: &combined[from..(safe - base) as usize],
      })? {
        return Ok(());
      }
      emitted = safe;
    }
    combined.drain(..(safe - base) as usize);
    base = safe;
  }
}
/// The rightmost occurrence of `needle` in `hay`.
fn rfind_sub(hay: &[u8], needle: &[u8], case_sensitive: bool) -> Option<usize> {
  if needle.is_empty() || needle.len() > hay.len() {
    return None;
  }
  if case_sensitive {
    hay.windows(needle.len()).rposition(|w| w == needle)
  } else {
    hay
      .windows(needle.len())
      .rposition(|w| w.eq_ignore_ascii_case(needle))
  }
}
/// The start of the rightmost hit lying wholly inside `[lo, hi)`, scanning
/// backward in `chunk`-byte reads that overlap by `needle.len() - 1` bytes.
pub fn scan_backward(
  lo: u64,
  hi: u64,
  needle: &[u8],
  case_sensitive: bool,
  chunk: usize,
  read: &mut Reader<'_>,
) -> Result<Option<u64>, ScanStop> {
  let m = needle.len() as u64;
  if m == 0 {
    return Err(ScanStop::Failed("empty query".to_string()));
  }
  // A window must be wider than the overlap, or the scan would not advance.
  let chunk = (chunk as u64).max(2 * m);
  let mut window_hi = hi;
  while window_hi > lo {
    let window_lo = window_hi.saturating_sub(chunk).max(lo);
    let len = (window_hi - window_lo) as usize;
    let data = read(window_lo, len)?;
    if data.len() != len {
      return Err(ScanStop::Failed("short read".to_string()));
    }
    if let Some(idx) = rfind_sub(&data, needle, case_sensitive) {
      return Ok(Some(window_lo + idx as u64));
    }
    if window_lo == lo {
      break;
    }
    window_hi = window_lo + (m - 1);
  }
  Ok(None)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::line_rule::count_breaks;

  fn slice_reader(content: &[u8]) -> impl FnMut(u64, usize) -> Result<Vec<u8>, ScanStop> + '_ {
    move |off, len| Ok(content[off as usize..off as usize + len].to_vec())
  }
  /// Leftmost non-overlapping hit offsets of a flat in-memory scan.
  fn flat_hits(hay: &[u8], needle: &[u8], case: bool) -> Vec<u64> {
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = find_sub(&hay[from..], needle, case) {
      out.push((from + rel) as u64);
      from += rel + needle.len();
    }
    out
  }
  /// Every hit and gap a scan reports, checked to tile the range exactly.
  fn scan_all(
    content: &[u8],
    start: u64,
    limit: u64,
    needle: &[u8],
    case: bool,
    chunk: usize,
  ) -> Vec<u64> {
    let mut hits = Vec::new();
    let mut cursor = start;
    scan_forward(
      start,
      limit,
      needle,
      case,
      chunk,
      &mut slice_reader(content),
      &mut |ev| {
        match ev {
          Event::Gap { bytes } => {
            assert_eq!(
              bytes,
              &content[cursor as usize..cursor as usize + bytes.len()]
            );
            cursor += bytes.len() as u64;
          }
          Event::Hit { off, buf, idx } => {
            assert_eq!(off, cursor, "a hit must start where the last event ended");
            assert!(buf[idx..idx + needle.len()].eq_ignore_ascii_case(needle));
            hits.push(off);
            cursor += needle.len() as u64;
          }
        }
        Ok(Flow::Continue)
      },
    )
    .unwrap();
    assert_eq!(cursor, limit, "gaps and hits must tile the range");
    hits
  }

  #[test]
  fn hits_do_not_depend_on_the_chunk_size() {
    let hay = b"aaaaaaaaaa abab ababab aaa\naab aab xabababx aaaa";
    for needle in [&b"aa"[..], b"abab", b"a", b"aab", b"ab"] {
      let want = flat_hits(hay, needle, true);
      for chunk in 1..=hay.len() + 3 {
        assert_eq!(
          scan_all(hay, 0, hay.len() as u64, needle, true, chunk),
          want,
          "needle {:?} chunk {chunk}",
          String::from_utf8_lossy(needle)
        );
      }
    }
  }

  #[test]
  fn the_viewer_carry_would_report_an_overlapping_hit() {
    // "aa" in "aaa" with a boundary after two bytes: the carry holds the tail
    // of the first hit, and a naive scan reports a second hit inside it.
    let hay = b"aaa";
    assert_eq!(scan_all(hay, 0, 3, b"aa", true, 2), vec![0]);
  }

  #[test]
  fn case_insensitive_folds_ascii_only() {
    let hay = "Foo foo FOO é É".as_bytes();
    assert_eq!(
      scan_all(hay, 0, hay.len() as u64, b"foo", false, 4),
      vec![0, 4, 8]
    );
    assert_eq!(scan_all(hay, 0, hay.len() as u64, b"foo", true, 4), vec![4]);
    let e = "é".as_bytes();
    assert_eq!(scan_all(hay, 0, hay.len() as u64, e, false, 3).len(), 1);
  }

  #[test]
  fn scan_starts_and_ends_where_asked() {
    let hay = b"xx abc abc abc xx";
    assert_eq!(scan_all(hay, 4, 14, b"abc", true, 3), vec![7, 11]);
    // A hit cut by the limit is not reported.
    assert_eq!(scan_all(hay, 4, 13, b"abc", true, 3), vec![7]);
  }

  #[test]
  fn hit_count_by_newlines_matches_a_flat_count() {
    let hay = b"a\nb\nab\nb\na b\n";
    let mut lines_before = Vec::new();
    let mut seen = 0u64;
    scan_forward(
      0,
      hay.len() as u64,
      b"b",
      true,
      2,
      &mut slice_reader(hay),
      &mut |ev| {
        match ev {
          Event::Gap { bytes } => seen += count_breaks(bytes),
          Event::Hit { .. } => lines_before.push(seen),
        }
        Ok(Flow::Continue)
      },
    )
    .unwrap();
    assert_eq!(lines_before, vec![1, 2, 3, 4]);
  }

  #[test]
  fn visitor_can_stop_the_scan() {
    let hay = b"ab ab ab ab";
    let mut got = 0;
    scan_forward(
      0,
      hay.len() as u64,
      b"ab",
      true,
      3,
      &mut slice_reader(hay),
      &mut |ev| {
        if let Event::Hit { .. } = ev {
          got += 1;
          if got == 2 {
            return Ok(Flow::Stop);
          }
        }
        Ok(Flow::Continue)
      },
    )
    .unwrap();
    assert_eq!(got, 2);
  }

  #[test]
  fn a_failing_read_stops_the_scan() {
    let mut read = |_: u64, _: usize| Err(ScanStop::Stale);
    let r = scan_forward(0, 10, b"a", true, 4, &mut read, &mut |_| Ok(Flow::Continue));
    assert_eq!(r, Err(ScanStop::Stale));
  }

  #[test]
  fn backward_finds_the_rightmost_hit_before_a_position() {
    let hay = b"ab ab xab ab";
    for chunk in 1..=hay.len() + 2 {
      let mut read = slice_reader(hay);
      let found = scan_backward(0, hay.len() as u64, b"ab", true, chunk, &mut read).unwrap();
      assert_eq!(found, Some(10), "chunk {chunk}");
      let mut read = slice_reader(hay);
      let found = scan_backward(0, 10, b"ab", true, chunk, &mut read).unwrap();
      assert_eq!(found, Some(7), "chunk {chunk}");
      let mut read = slice_reader(hay);
      let found = scan_backward(0, 4, b"ab", true, chunk, &mut read).unwrap();
      assert_eq!(found, Some(0), "chunk {chunk}");
      let mut read = slice_reader(hay);
      let found = scan_backward(0, 1, b"ab", true, chunk, &mut read).unwrap();
      assert_eq!(found, None, "chunk {chunk}");
    }
  }

  #[test]
  fn backward_finds_a_hit_straddling_a_window_boundary() {
    let hay = b"xxxxabcdxxxx";
    for chunk in 1..=12 {
      let mut read = slice_reader(hay);
      let found = scan_backward(0, 12, b"abcd", true, chunk, &mut read).unwrap();
      assert_eq!(found, Some(4), "chunk {chunk}");
    }
  }

  #[test]
  fn backward_is_case_insensitive_when_asked() {
    let hay = b"one ONE two";
    let mut read = slice_reader(hay);
    assert_eq!(
      scan_backward(0, 11, b"one", false, 4, &mut read).unwrap(),
      Some(4)
    );
    let mut read = slice_reader(hay);
    assert_eq!(
      scan_backward(0, 11, b"one", true, 4, &mut read).unwrap(),
      Some(0)
    );
  }
}
