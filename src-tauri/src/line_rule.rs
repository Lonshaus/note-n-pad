// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! The line rule: where lines of a very large file begin.
//!
//! A break is marked by one byte: every `\n`, and every `\r` whose next byte in
//! the same text is not `\n` (or that is the text's last byte). Line `L` starts
//! one byte after the `L`-th marker, so a `\r\n` pair is one break (marked by
//! its `\n`) and a lone `\r` is a break of its own. An offset strictly inside a
//! `\r\n` belongs to the line of its `\r`.
//!
//! A checkpoint at offset `o` carries the markers strictly before `o`. A `\r`
//! at `o - 1` is one of them unless the byte at `o` is `\n`, so its status is
//! only known once the byte at `o` is seen (or the text ends).
/// Whether the byte at `i` of `bytes` is a break marker. A missing next byte
/// ends the text.
#[cfg(test)]
pub fn is_break(bytes: &[u8], i: usize) -> bool {
  match bytes[i] {
    b'\n' => true,
    b'\r' => bytes.get(i + 1) != Some(&b'\n'),
    _ => false,
  }
}
/// Number of markers at positions below `limit` in `bytes`, where `bytes`
/// beyond `limit` is lookahead for a `\r` at `limit - 1` (none ends the text).
pub fn breaks_before(bytes: &[u8], limit: usize) -> u64 {
  let mut count = 0u64;
  for i in 0..limit {
    match bytes[i] {
      b'\n' => count += 1,
      b'\r' if bytes.get(i + 1) != Some(&b'\n') => count += 1,
      _ => {}
    }
  }
  count
}
/// Append `base + i` to `out` for every marker position `i < limit` in `bytes`;
/// `bytes` beyond `limit` is lookahead as in `breaks_before`.
pub fn push_break_positions(bytes: &[u8], limit: usize, base: u64, out: &mut Vec<u64>) {
  for i in 0..limit {
    match bytes[i] {
      b'\n' => out.push(base + i as u64),
      b'\r' if bytes.get(i + 1) != Some(&b'\n') => out.push(base + i as u64),
      _ => {}
    }
  }
}
/// Position of the `k`-th marker (1-based) in `bytes`, a text of its own.
pub fn nth_break(bytes: &[u8], k: u64) -> Option<usize> {
  let mut seen = 0u64;
  for i in 0..bytes.len() {
    let marker = match bytes[i] {
      b'\n' => true,
      b'\r' => bytes.get(i + 1) != Some(&b'\n'),
      _ => false,
    };
    if marker {
      seen += 1;
      if seen == k {
        return Some(i);
      }
    }
  }
  None
}
/// Number of markers in `bytes`, a text of its own: a final `\r` counts.
pub fn count_breaks(bytes: &[u8]) -> u64 {
  breaks_before(bytes, bytes.len())
}
/// Counts markers over text fed in pieces. A `\r` at the end of what has been
/// fed is held back until the next byte shows whether it is a marker.
#[derive(Clone, Copy, Debug, Default)]
pub struct BreakCounter {
  pending_cr: bool,
  count: u64,
}

impl BreakCounter {
  pub fn new() -> Self {
    BreakCounter::default()
  }
  /// Take the next byte of the text.
  pub fn step(&mut self, b: u8) {
    if self.pending_cr {
      if b != b'\n' {
        self.count += 1;
      }
      self.pending_cr = false;
    }
    match b {
      b'\n' => self.count += 1,
      b'\r' => self.pending_cr = true,
      _ => {}
    }
  }
  /// Take the next bytes of the text.
  pub fn feed(&mut self, bytes: &[u8]) {
    for &b in bytes {
      self.step(b);
    }
  }
  /// Markers settled so far, not counting a held-back final `\r`.
  pub fn count(&self) -> u64 {
    self.count
  }
  /// Whether the last byte fed is a `\r` whose status waits for the next byte.
  pub fn pending_cr(&self) -> bool {
    self.pending_cr
  }
  /// Markers strictly before the next byte, which is `next`.
  pub fn count_before_next(&self, next: u8) -> u64 {
    if self.pending_cr && next != b'\n' {
      self.count + 1
    } else {
      self.count
    }
  }
  /// Markers in the whole text: a held-back final `\r` ends the text.
  pub fn finish(self) -> u64 {
    self.count + self.pending_cr as u64
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_break_is_a_lf_or_a_cr_not_followed_by_lf() {
    let text = b"a\nb\r\nc\rd\ne";
    let marks: Vec<usize> = (0..text.len()).filter(|&i| is_break(text, i)).collect();
    assert_eq!(marks, vec![1, 4, 6, 8]);
    assert_eq!(count_breaks(text), 4);
    assert_eq!(count_breaks(b"a\r"), 1);
    assert_eq!(count_breaks(b"\r\r\n\r"), 3);
    assert_eq!(count_breaks(b""), 0);
  }

  #[test]
  fn breaks_before_looks_one_byte_past_the_limit() {
    let text = b"a\r\nb";
    assert_eq!(breaks_before(text, 2), 0);
    assert_eq!(breaks_before(text, 3), 1);
    assert_eq!(breaks_before(&text[..2], 2), 1);
    let mut at = Vec::new();
    push_break_positions(text, 4, 10, &mut at);
    assert_eq!(at, vec![12]);
    assert_eq!(nth_break(b"a\rb\r\nc", 2), Some(4));
    assert_eq!(nth_break(b"a\rb\r\nc", 3), None);
  }

  #[test]
  fn a_counter_agrees_with_a_flat_count_for_every_split() {
    let text = b"\r\n\r\r\n\n\rx\ry\r";
    for cut in 0..=text.len() {
      let mut counter = BreakCounter::new();
      counter.feed(&text[..cut]);
      counter.feed(&text[cut..]);
      assert_eq!(counter.finish(), count_breaks(text), "cut {cut}");
    }
    for o in 1..text.len() {
      let mut counter = BreakCounter::new();
      counter.feed(&text[..o]);
      assert_eq!(
        counter.count_before_next(text[o]),
        breaks_before(text, o),
        "offset {o}"
      );
    }
  }
}
