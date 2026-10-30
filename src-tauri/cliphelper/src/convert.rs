// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! UTF-8 to UTF-16 conversion in fixed-size chunks, with no line-ending changes.
use std::io::Read;

pub const CHUNK_SIZE: usize = 1024 * 1024;
const REPLACEMENT: u16 = 0xFFFD;
/// Incremental decoder. UTF-8 sequences split across chunk boundaries are carried over.
/// Invalid bytes become U+FFFD (one per maximal invalid subpart, like `String::from_utf8_lossy`).
#[derive(Default)]
pub struct Utf8ToUtf16 {
  carry: [u8; 4],
  carry_len: usize,
}

impl Utf8ToUtf16 {
  pub fn new() -> Self {
    Self::default()
  }
  /// Decodes one chunk and appends the UTF-16 units to `out`.
  pub fn push(&mut self, chunk: &[u8], out: &mut Vec<u16>) {
    let mut pos = 0;
    // Complete a sequence left over from the previous chunk first.
    while self.carry_len > 0 && pos < chunk.len() {
      self.carry[self.carry_len] = chunk[pos];
      self.carry_len += 1;
      pos += 1;
      match std::str::from_utf8(&self.carry[..self.carry_len]) {
        Ok(s) => {
          out.extend(s.encode_utf16());
          self.carry_len = 0;
        }
        Err(e) if e.error_len().is_none() => {}
        Err(_) => {
          // The byte just added broke the sequence: emit U+FFFD for the carried
          // prefix and reprocess that byte as the start of the next sequence.
          out.push(REPLACEMENT);
          self.carry_len = 0;
          pos -= 1;
        }
      }
    }
    let mut rest = &chunk[pos..];
    while !rest.is_empty() {
      match std::str::from_utf8(rest) {
        Ok(s) => {
          out.extend(s.encode_utf16());
          return;
        }
        Err(e) => {
          let valid = e.valid_up_to();
          // The prefix was just validated, so this always succeeds.
          if let Ok(s) = std::str::from_utf8(&rest[..valid]) {
            out.extend(s.encode_utf16());
          }
          match e.error_len() {
            None => {
              // Incomplete sequence at the end of the chunk (1 to 3 bytes).
              let tail = &rest[valid..];
              self.carry[..tail.len()].copy_from_slice(tail);
              self.carry_len = tail.len();
              return;
            }
            Some(n) => {
              out.push(REPLACEMENT);
              rest = &rest[valid + n..];
            }
          }
        }
      }
    }
  }
  /// Flushes a truncated trailing sequence as U+FFFD.
  pub fn finish(&mut self, out: &mut Vec<u16>) {
    if self.carry_len > 0 {
      out.push(REPLACEMENT);
      self.carry_len = 0;
    }
  }
}
/// Converts a sequence of arbitrarily split UTF-8 chunks to UTF-16.
#[cfg(test)]
pub fn utf8_chunks_to_utf16(chunks: &[&[u8]]) -> Vec<u16> {
  let mut dec = Utf8ToUtf16::new();
  let mut out = Vec::new();
  for c in chunks {
    dec.push(c, &mut out);
  }
  dec.finish(&mut out);
  out
}
/// Streams a UTF-8 reader in 1 MiB chunks and hands each converted piece to `sink`.
/// Returns (bytes read, UTF-16 units produced). Memory use: one input chunk plus one
/// output piece, independent of the input size.
pub fn stream_reader_utf16<R: Read, F: FnMut(&[u16])>(
  file: &mut R,
  mut sink: F,
) -> std::io::Result<(u64, u64)> {
  let mut buf = vec![0u8; CHUNK_SIZE];
  let mut out: Vec<u16> = Vec::with_capacity(CHUNK_SIZE + 4);
  let mut dec = Utf8ToUtf16::new();
  let mut bytes = 0u64;
  let mut units = 0u64;
  loop {
    let n = file.read(&mut buf)?;
    if n == 0 {
      break;
    }
    bytes += n as u64;
    out.clear();
    dec.push(&buf[..n], &mut out);
    units += out.len() as u64;
    sink(&out);
  }
  out.clear();
  dec.finish(&mut out);
  if !out.is_empty() {
    units += out.len() as u64;
    sink(&out);
  }
  Ok((bytes, units))
}

#[cfg(test)]
mod tests {
  use super::*;
  // 1-byte, 2-byte (e acute), 3-byte (CJK), 4-byte (emoji, surrogate pair), CRLF.
  const SAMPLE: &str =
    "a\u{e9}\u{4e2d}\u{1F600}\r\nb\u{20AC}\u{10FFFF}\r\n\u{1F9D1}\u{200D}\u{1F4BB}z";

  fn expected(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
  }

  #[test]
  fn whole_input_single_chunk() {
    assert_eq!(utf8_chunks_to_utf16(&[SAMPLE.as_bytes()]), expected(SAMPLE));
  }

  #[test]
  fn two_byte_split() {
    let b = "x\u{e9}y".as_bytes();
    // Bytes: x, C3, A9, y. Split between C3 and A9.
    assert_eq!(
      utf8_chunks_to_utf16(&[&b[..2], &b[2..]]),
      expected("x\u{e9}y")
    );
  }

  #[test]
  fn three_byte_split_every_position() {
    let s = "x\u{4e2d}y";
    let b = s.as_bytes();
    for cut in 1..b.len() {
      assert_eq!(
        utf8_chunks_to_utf16(&[&b[..cut], &b[cut..]]),
        expected(s),
        "cut {cut}"
      );
    }
    // Three separate chunks, splitting after each byte of the CJK char.
    assert_eq!(
      utf8_chunks_to_utf16(&[&b[..2], &b[2..3], &b[3..]]),
      expected(s)
    );
  }

  #[test]
  fn four_byte_split_every_position_yields_surrogate_pair() {
    let s = "x\u{1F600}y";
    let b = s.as_bytes();
    for cut in 1..b.len() {
      let out = utf8_chunks_to_utf16(&[&b[..cut], &b[cut..]]);
      assert_eq!(out, expected(s), "cut {cut}");
      assert_eq!(out.len(), 4);
      assert_eq!((out[1], out[2]), (0xD83D, 0xDE00));
    }
    // 1-byte, 2-byte and 3-byte pieces of the emoji.
    assert_eq!(
      utf8_chunks_to_utf16(&[&b[..2], &b[2..3], &b[3..4], &b[4..]]),
      expected(s)
    );
  }

  #[test]
  fn one_byte_chunks_and_every_two_way_split() {
    let b = SAMPLE.as_bytes();
    let ones: Vec<&[u8]> = b.chunks(1).collect();
    assert_eq!(utf8_chunks_to_utf16(&ones), expected(SAMPLE));
    for cut in 0..=b.len() {
      assert_eq!(
        utf8_chunks_to_utf16(&[&b[..cut], &b[cut..]]),
        expected(SAMPLE),
        "cut {cut}"
      );
    }
  }

  #[test]
  fn line_endings_are_kept() {
    let s = "a\r\nb\nc\rd";
    assert_eq!(utf8_chunks_to_utf16(&[s.as_bytes()]), expected(s));
  }

  #[test]
  fn empty_chunks_are_harmless() {
    let b = "\u{1F600}".as_bytes();
    assert_eq!(
      utf8_chunks_to_utf16(&[b"", &b[..1], b"", &b[1..], b""]),
      expected("\u{1F600}")
    );
  }

  #[test]
  fn invalid_bytes_match_lossy() {
    let cases: [&[u8]; 4] = [b"a\xFFb", b"a\xE4\xB8", b"\xE4\xB8x", b"\xF0\x9F\x98"];
    for bytes in cases {
      let want: Vec<u16> = String::from_utf8_lossy(bytes).encode_utf16().collect();
      assert_eq!(utf8_chunks_to_utf16(&[bytes]), want);
      for cut in 0..=bytes.len() {
        assert_eq!(
          utf8_chunks_to_utf16(&[&bytes[..cut], &bytes[cut..]]),
          want,
          "{bytes:?} cut {cut}"
        );
      }
    }
  }

  #[test]
  fn stream_across_chunk_boundary() {
    // Place a 4-byte char exactly across the 1 MiB boundary.
    let mut data = vec![b'a'; CHUNK_SIZE - 2];
    data.extend_from_slice("\u{1F600}".as_bytes());
    data.extend_from_slice("tail\r\n".as_bytes());
    let mut got: Vec<u16> = Vec::new();
    let (bytes, units) =
      stream_reader_utf16(&mut data.as_slice(), |p| got.extend_from_slice(p)).unwrap();
    let want: Vec<u16> = String::from_utf8(data.clone())
      .unwrap()
      .encode_utf16()
      .collect();
    assert_eq!(bytes, data.len() as u64);
    assert_eq!(units, want.len() as u64);
    assert_eq!(got, want);
  }
}
