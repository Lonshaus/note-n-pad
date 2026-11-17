// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::fs_ops::{
  copy_into_place, destination_lock, ensure_parent_dir, folder_vanished, land, prepare, read_error,
  remove_created_dirs, stage_unique, writable, write_bytes_atomic, Landing, Prepared, Staged,
  FOLDER_VANISHED_RETRIES, READ_ONLY_DESTINATION,
};
use encoding_rs::{CoderResult, Decoder, Encoder, EncoderResult, Encoding};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, Webview};
/// Result of decoding a byte buffer into text. `content` is BOM-free; line
/// endings are preserved (the frontend normalizes to LF).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Decoded {
  pub content: String,
  pub encoding: String,
  pub had_bom: bool,
  /// True when decoding produced U+FFFD replacement characters, i.e. the bytes
  /// did not fully fit the chosen encoding.
  pub lossy: bool,
}
/// The fixed set of encodings exposed to the frontend, paired with their
/// encoding_rs backing. The label (not encoding_rs's `.name()`) is what we
/// persist and show, so casing stays stable ("GB18030", "Windows-1252").
fn supported() -> [(&'static str, &'static Encoding); 22] {
  [
    ("UTF-8", encoding_rs::UTF_8),
    ("UTF-16LE", encoding_rs::UTF_16LE),
    ("UTF-16BE", encoding_rs::UTF_16BE),
    ("Big5", encoding_rs::BIG5),
    ("GB18030", encoding_rs::GB18030),
    ("GBK", encoding_rs::GBK),
    ("Shift_JIS", encoding_rs::SHIFT_JIS),
    ("EUC-JP", encoding_rs::EUC_JP),
    ("ISO-2022-JP", encoding_rs::ISO_2022_JP),
    ("EUC-KR", encoding_rs::EUC_KR),
    ("Windows-1252", encoding_rs::WINDOWS_1252),
    ("ISO-8859-15", encoding_rs::ISO_8859_15),
    ("Windows-1250", encoding_rs::WINDOWS_1250),
    ("Windows-1251", encoding_rs::WINDOWS_1251),
    ("KOI8-R", encoding_rs::KOI8_R),
    ("Windows-1253", encoding_rs::WINDOWS_1253),
    ("Windows-1254", encoding_rs::WINDOWS_1254),
    ("Windows-1255", encoding_rs::WINDOWS_1255),
    ("Windows-1256", encoding_rs::WINDOWS_1256),
    ("Windows-874", encoding_rs::WINDOWS_874),
    ("Windows-1258", encoding_rs::WINDOWS_1258),
    ("MacRoman", encoding_rs::MACINTOSH),
  ]
}
/// Whether `label` is one of the supported encoding labels (case-insensitive).
/// Exposed so settings validation reuses this single source of truth instead of
/// duplicating the encoding list.
pub fn is_supported_label(label: &str) -> bool {
  label_to_encoding(label).is_some()
}
/// Resolve a label (case-insensitive) to its encoding_rs encoding.
pub(crate) fn label_to_encoding(label: &str) -> Option<&'static Encoding> {
  supported()
    .into_iter()
    .find(|(name, _)| name.eq_ignore_ascii_case(label))
    .map(|(_, enc)| enc)
}
/// Map an encoding_rs encoding back to our fixed label.
fn label_for(enc: &'static Encoding) -> String {
  supported()
    .into_iter()
    .find(|(_, e)| std::ptr::eq(*e, enc))
    .map(|(name, _)| name.to_string())
    // Unreachable in practice: every path passes a supported encoding.
    .unwrap_or_else(|| "Windows-1252".to_string())
}
/// Constrain a detector guess to the supported list; unknown guesses fall back
/// to Windows-1252 (a superset-ish single-byte reading that never fails).
fn constrain(enc: &'static Encoding) -> &'static Encoding {
  if supported().into_iter().any(|(_, e)| std::ptr::eq(e, enc)) {
    enc
  } else {
    encoding_rs::WINDOWS_1252
  }
}
/// Decode `bytes` with `enc`, without any BOM handling (callers strip BOMs
/// explicitly). Returns the text and whether replacement characters appeared.
fn decode_bytes(enc: &'static Encoding, bytes: &[u8]) -> (String, bool) {
  let (cow, lossy) = enc.decode_without_bom_handling(bytes);
  (cow.into_owned(), lossy)
}
/// Whether `window` is one of the JIS escape sequences that mark ISO-2022-JP.
fn is_iso2022_escape(window: &[u8]) -> bool {
  window == b"\x1B$B" || window == b"\x1B$@" || window == b"\x1B(J"
}
/// Auto-detect the encoding of `bytes` and decode it.
pub fn decode_auto(bytes: &[u8]) -> Decoded {
  // 1. BOM sniff wins outright.
  if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
    let (content, lossy) = decode_bytes(encoding_rs::UTF_8, rest);
    return Decoded {
      content,
      encoding: "UTF-8".into(),
      had_bom: true,
      lossy,
    };
  }
  if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
    let (content, lossy) = decode_bytes(encoding_rs::UTF_16LE, rest);
    return Decoded {
      content,
      encoding: "UTF-16LE".into(),
      had_bom: true,
      lossy,
    };
  }
  if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
    let (content, lossy) = decode_bytes(encoding_rs::UTF_16BE, rest);
    return Decoded {
      content,
      encoding: "UTF-16BE".into(),
      had_bom: true,
      lossy,
    };
  }
  // 2. ISO-2022-JP is pure ASCII plus escape sequences, so it would pass the
  // strict UTF-8 check below; sniff its JIS escape sequences first.
  if bytes.windows(3).any(is_iso2022_escape) {
    let (content, lossy) = decode_bytes(encoding_rs::ISO_2022_JP, bytes);
    return Decoded {
      content,
      encoding: "ISO-2022-JP".into(),
      had_bom: false,
      lossy,
    };
  }
  // 3. Strict UTF-8: valid UTF-8 is always read as UTF-8.
  if let Ok(s) = std::str::from_utf8(bytes) {
    return Decoded {
      content: s.to_string(),
      encoding: "UTF-8".into(),
      had_bom: false,
      lossy: false,
    };
  }
  // 4. Statistical detection, constrained to the supported list.
  let mut detector = chardetng::EncodingDetector::new();
  detector.feed(bytes, true);
  let enc = constrain(detector.guess(None, true));
  let (content, lossy) = decode_bytes(enc, bytes);
  Decoded {
    content,
    encoding: label_for(enc),
    had_bom: false,
    lossy,
  }
}
/// Strip a BOM only when it matches `enc`, reporting whether one was removed.
fn strip_matching_bom<'a>(enc: &'static Encoding, bytes: &'a [u8]) -> (&'a [u8], bool) {
  let bom: &[u8] = if std::ptr::eq(enc, encoding_rs::UTF_8) {
    &[0xEF, 0xBB, 0xBF]
  } else if std::ptr::eq(enc, encoding_rs::UTF_16LE) {
    &[0xFF, 0xFE]
  } else if std::ptr::eq(enc, encoding_rs::UTF_16BE) {
    &[0xFE, 0xFF]
  } else {
    return (bytes, false);
  };
  match bytes.strip_prefix(bom) {
    Some(rest) => (rest, true),
    None => (bytes, false),
  }
}
/// Forced decode with a specific label.
pub fn decode_as(bytes: &[u8], label: &str) -> Result<Decoded, String> {
  let enc = label_to_encoding(label).ok_or_else(|| format!("unsupported encoding: {label}"))?;
  let (rest, had_bom) = strip_matching_bom(enc, bytes);
  let (content, lossy) = decode_bytes(enc, rest);
  Ok(Decoded {
    content,
    encoding: label_for(enc),
    had_bom,
    lossy,
  })
}
/// Encode text to `label`. UTF-8 optionally prepends a BOM; UTF-16 variants
/// always write their BOM; `with_bom` is ignored for non-Unicode encodings.
/// Characters that cannot be represented are a hard error (never silently dropped).
pub fn encode_text(content: &str, label: &str, with_bom: bool) -> Result<Vec<u8>, String> {
  let enc = label_to_encoding(label).ok_or_else(|| format!("unsupported encoding: {label}"))?;
  if std::ptr::eq(enc, encoding_rs::UTF_8) {
    let mut out = Vec::with_capacity(content.len() + 3);
    if with_bom {
      out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(content.as_bytes());
    return Ok(out);
  }
  // encoding_rs has no UTF-16 encoder (its output encoding is UTF-8), so build
  // the code units by hand. Every Unicode scalar maps, so this never fails.
  if std::ptr::eq(enc, encoding_rs::UTF_16LE) {
    let mut out = vec![0xFF, 0xFE];
    for unit in content.encode_utf16() {
      out.extend_from_slice(&unit.to_le_bytes());
    }
    return Ok(out);
  }
  if std::ptr::eq(enc, encoding_rs::UTF_16BE) {
    let mut out = vec![0xFE, 0xFF];
    for unit in content.encode_utf16() {
      out.extend_from_slice(&unit.to_be_bytes());
    }
    return Ok(out);
  }
  // Legacy single/double-byte encodings: encode and reject unmappable input.
  let (bytes, _, had_unmappable) = enc.encode(content);
  if had_unmappable {
    return Err(format!(
      "content contains characters that cannot be represented in {label}"
    ));
  }
  Ok(bytes.into_owned())
}

#[tauri::command]
pub fn read_file_auto(path: String) -> Result<Decoded, String> {
  let bytes = std::fs::read(&path).map_err(|e| read_error(&e))?;
  Ok(decode_auto(&bytes))
}

#[tauri::command]
pub fn read_file_as(path: String, encoding: String) -> Result<Decoded, String> {
  let bytes = std::fs::read(&path).map_err(|e| read_error(&e))?;
  decode_as(&bytes, &encoding)
}
/// Off the UI thread: the encode + atomic write can run long on a large file.
/// Every call site awaits this one call before its next action, so there is no
/// overlapping write to reorder.
#[tauri::command(async)]
pub fn write_file_encoded(
  path: String,
  content: String,
  encoding: String,
  with_bom: bool,
) -> Result<(), String> {
  let bytes = encode_text(&content, &encoding, with_bom)?;
  write_bytes_atomic(Path::new(&path), &bytes)
}
/// The most UTF-8 bytes one chunk of a document read or write carries over IPC
/// (`src/lib/util/documentIoProtocol.ts`, which a test ties to this value).
const IO_CHUNK_BYTES: usize = 1048576;
/// Header carrying the write session's token.
const IO_TOKEN_HEADER: &str = "x-note-n-pad-io-token";
/// Header carrying the UTF-8 offset where a written chunk starts.
const IO_OFFSET_HEADER: &str = "x-note-n-pad-io-offset";
/// `read_begin` and `write_begin` answer with exactly this at the per-window
/// limit; the frontend finishes that one read or write over JSON instead.
const IO_SESSION_LIMIT: &str = "io-session-limit";
/// `read_begin` and `write_begin` answer with exactly this for a window that no
/// longer exists.
const WINDOW_CLOSED: &str = "window-closed";
/// The file being read changed since `read_begin` looked at it.
const FILE_CHANGED: &str = "file-changed";
/// Read sessions, and write sessions, one window may hold at once.
const MAX_IO_SESSIONS_PER_WINDOW: usize = 16;
const UNKNOWN_SESSION: &str = "unknown io session";

type Slot<S> = Arc<Mutex<Option<S>>>;

struct Entry<S> {
  label: String,
  slot: Slot<S>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
/// One kind of session, keyed by token. The map lock is never held across I/O.
struct SessionTable<S> {
  next: AtomicU64,
  entries: Mutex<HashMap<u64, Entry<S>>>,
}

impl<S> SessionTable<S> {
  fn new() -> Self {
    Self {
      next: AtomicU64::new(1),
      entries: Mutex::new(HashMap::new()),
    }
  }
  /// Reserve the next token for `label`, whose slot is filled once the session
  /// is open, or refuse at the per-window limit.
  fn admit(&self, label: &str) -> Result<(u64, Slot<S>), String> {
    let mut entries = locked(&self.entries);
    let held = entries.values().filter(|e| e.label == label).count();
    if held >= MAX_IO_SESSIONS_PER_WINDOW {
      return Err(IO_SESSION_LIMIT.to_string());
    }
    let token = self.next.fetch_add(1, Ordering::Relaxed);
    let slot: Slot<S> = Arc::new(Mutex::new(None));
    entries.insert(
      token,
      Entry {
        label: label.to_string(),
        slot: Arc::clone(&slot),
      },
    );
    Ok((token, slot))
  }

  fn slot(&self, label: &str, token: u64) -> Result<Slot<S>, String> {
    let entries = locked(&self.entries);
    match entries.get(&token) {
      Some(entry) if entry.label == label => Ok(Arc::clone(&entry.slot)),
      _ => Err(UNKNOWN_SESSION.to_string()),
    }
  }
  /// Take the entry out of the table. A wrong `label` leaves it in place.
  fn remove(&self, label: &str, token: u64) -> Result<Slot<S>, String> {
    let mut entries = locked(&self.entries);
    match entries.get(&token) {
      Some(entry) if entry.label == label => {}
      _ => return Err(UNKNOWN_SESSION.to_string()),
    }
    let entry = entries.remove(&token);
    entry
      .map(|e| e.slot)
      .ok_or_else(|| UNKNOWN_SESSION.to_string())
  }

  fn holds(&self, token: u64) -> bool {
    locked(&self.entries).contains_key(&token)
  }

  fn drain_window(&self, label: &str) -> Vec<Slot<S>> {
    let mut entries = locked(&self.entries);
    let tokens: Vec<u64> = entries
      .iter()
      .filter(|(_, e)| e.label == label)
      .map(|(t, _)| *t)
      .collect();
    tokens
      .into_iter()
      .filter_map(|t| entries.remove(&t).map(|e| e.slot))
      .collect()
  }
}
/// Non-empty ASCII digits that fit a `u64`; nothing else is a number here.
fn parse_number(text: &str) -> Option<u64> {
  if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  text.parse().ok()
}

fn parse_token(token: &str) -> Result<u64, String> {
  parse_number(token).ok_or_else(|| UNKNOWN_SESSION.to_string())
}

fn header_number(headers: &HeaderMap, name: &str) -> Result<u64, String> {
  let value = headers
    .get(name)
    .ok_or_else(|| format!("missing {name}"))?
    .to_str()
    .map_err(|_| format!("invalid {name}"))?;
  parse_number(value).ok_or_else(|| format!("invalid {name}"))
}
/// Fill `buf` unless the stream ends first.
fn read_full(reader: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
  let mut filled = 0;
  while filled < buf.len() {
    let n = read_once(reader, &mut buf[filled..])?;
    if n == 0 {
      break;
    }
    filled += n;
  }
  Ok(filled)
}

fn read_once(reader: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
  loop {
    match reader.read(buf) {
      Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
      other => return other,
    }
  }
}
/// A BOM at the start of `bytes`, as `decode_auto` recognises them.
fn sniff_bom(bytes: &[u8]) -> Option<(&'static Encoding, usize)> {
  if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
    Some((encoding_rs::UTF_8, 3))
  } else if bytes.starts_with(&[0xFF, 0xFE]) {
    Some((encoding_rs::UTF_16LE, 2))
  } else if bytes.starts_with(&[0xFE, 0xFF]) {
    Some((encoding_rs::UTF_16BE, 2))
  } else {
    None
  }
}
/// Whether the last bytes before a block and its first two form a JIS escape.
fn seam_has_iso2022_escape(tail: &[u8], fresh: &[u8]) -> bool {
  let head = &fresh[..fresh.len().min(2)];
  let mut seam = [0u8; 4];
  seam[..tail.len()].copy_from_slice(tail);
  seam[tail.len()..tail.len() + head.len()].copy_from_slice(head);
  seam[..tail.len() + head.len()]
    .windows(3)
    .any(is_iso2022_escape)
}
/// What one pass over a stream decided, the same way `decode_auto` and
/// `decode_as` decide over a whole buffer.
struct Scan {
  encoding: &'static Encoding,
  bom_len: u64,
  /// Whether the content after any BOM is valid UTF-8.
  utf8_valid: bool,
}

fn scan_stream(reader: &mut impl Read, forced: Option<&'static Encoding>) -> std::io::Result<Scan> {
  // Room for the incomplete UTF-8 sequence carried in front of the next block.
  let mut buf = vec![0u8; IO_CHUNK_BYTES + 3];
  let mut carry = 0;
  let mut first = true;
  let mut bom: Option<&'static Encoding> = None;
  let mut bom_len = 0;
  let mut utf8_valid = true;
  let mut escape_seen = false;
  let mut tail = [0u8; 2];
  let mut tail_len = 0;
  let mut detector = chardetng::EncodingDetector::new();
  loop {
    let got = read_full(reader, &mut buf[carry..carry + IO_CHUNK_BYTES])?;
    let last = got < IO_CHUNK_BYTES;
    let mut fresh_start = carry;
    if first {
      first = false;
      let head = &buf[..got];
      match forced {
        Some(enc) => bom_len = head.len() - strip_matching_bom(enc, head).0.len(),
        None => {
          if let Some((enc, len)) = sniff_bom(head) {
            bom = Some(enc);
            bom_len = len;
          }
        }
      }
      fresh_start += bom_len;
    }
    let fresh = &buf[fresh_start..carry + got];
    if forced.is_none() && bom.is_none() {
      escape_seen = escape_seen
        || seam_has_iso2022_escape(&tail[..tail_len], fresh)
        || fresh.windows(3).any(is_iso2022_escape);
      if fresh.len() >= 2 {
        tail.copy_from_slice(&fresh[fresh.len() - 2..]);
        tail_len = 2;
      }
      detector.feed(fresh, last);
    }
    let mut next_carry = 0;
    if utf8_valid {
      let span = &buf[fresh_start - carry..carry + got];
      match std::str::from_utf8(span) {
        Ok(_) => {}
        Err(e) if e.error_len().is_none() && !last => {
          next_carry = span.len() - e.valid_up_to();
        }
        Err(_) => utf8_valid = false,
      }
    }
    if last {
      break;
    }
    let end = carry + got;
    buf.copy_within(end - next_carry..end, 0);
    carry = next_carry;
  }
  let encoding = forced.or(bom).unwrap_or_else(|| {
    if escape_seen {
      encoding_rs::ISO_2022_JP
    } else if utf8_valid {
      encoding_rs::UTF_8
    } else {
      constrain(detector.guess(None, true))
    }
  });
  Ok(Scan {
    encoding,
    bom_len: bom_len as u64,
    utf8_valid,
  })
}
/// How the content of one read session reaches the frontend.
enum Transfer {
  /// Valid UTF-8: the bytes of the file, unchanged.
  Direct,
  Decode(Box<DecodeState>),
}

struct DecodeState {
  decoder: Decoder,
  input: Vec<u8>,
  consumed: usize,
  input_total: u64,
  input_ended: bool,
}
/// Holds stream state only, so its size does not depend on the file.
struct ReadStream {
  /// Bytes after any BOM, as seen by `read_begin`.
  source_len: u64,
  sent: u64,
  lossy: bool,
  finished: bool,
  transfer: Transfer,
}

impl ReadStream {
  fn new(scan: &Scan, len: u64) -> Self {
    let direct = std::ptr::eq(scan.encoding, encoding_rs::UTF_8) && scan.utf8_valid;
    let transfer = if direct {
      Transfer::Direct
    } else {
      Transfer::Decode(Box::new(DecodeState {
        decoder: scan.encoding.new_decoder_without_bom_handling(),
        input: Vec::new(),
        consumed: 0,
        input_total: 0,
        input_ended: false,
      }))
    };
    Self {
      source_len: len.saturating_sub(scan.bom_len),
      sent: 0,
      lossy: false,
      finished: false,
      transfer,
    }
  }
}
/// Produce the next chunk, empty only when the content has ended.
fn read_next(stream: &mut ReadStream, reader: &mut impl Read) -> Result<Vec<u8>, String> {
  if stream.finished {
    return Ok(Vec::new());
  }
  let mut out = vec![0u8; IO_CHUNK_BYTES];
  let produced = match &mut stream.transfer {
    Transfer::Direct => {
      let n = read_full(reader, &mut out).map_err(|e| read_error(&e))?;
      if n == 0 && stream.sent != stream.source_len {
        return Err(FILE_CHANGED.to_string());
      }
      n
    }
    Transfer::Decode(state) => {
      let mut produced = 0;
      loop {
        if state.consumed == state.input.len() && !state.input_ended {
          state.input.resize(IO_CHUNK_BYTES, 0);
          let n = read_once(reader, &mut state.input).map_err(|e| read_error(&e))?;
          state.input.truncate(n);
          state.consumed = 0;
          state.input_total += n as u64;
          if n == 0 {
            if state.input_total != stream.source_len {
              return Err(FILE_CHANGED.to_string());
            }
            state.input_ended = true;
          }
        }
        let last = state.input_ended;
        let (result, read, written, replaced) =
          state
            .decoder
            .decode_to_utf8(&state.input[state.consumed..], &mut out[produced..], last);
        state.consumed += read;
        produced += written;
        stream.lossy |= replaced;
        match result {
          CoderResult::InputEmpty if last => {
            // The decoder must not be called again now.
            stream.finished = true;
            break;
          }
          CoderResult::InputEmpty if produced > 0 => break,
          CoderResult::InputEmpty => {}
          CoderResult::OutputFull => {
            debug_assert!(produced > 0);
            break;
          }
        }
      }
      produced
    }
  };
  out.truncate(produced);
  stream.sent += produced as u64;
  Ok(out)
}

struct ReadSession {
  file: File,
  len: u64,
  modified: Option<SystemTime>,
  stream: ReadStream,
}
/// Length and modification time, as compared before every chunk.
fn stat_of(file: &File) -> Result<(u64, Option<SystemTime>), String> {
  let meta = file.metadata().map_err(|e| read_error(&e))?;
  Ok((meta.len(), meta.modified().ok()))
}
/// The one scan pass of a read, leaving `reader` at the first byte to send.
fn begin_stream<R: Read + Seek>(
  reader: &mut R,
  forced: Option<&'static Encoding>,
) -> std::io::Result<Scan> {
  let scan = scan_stream(reader, forced)?;
  reader.seek(SeekFrom::Start(scan.bom_len))?;
  Ok(scan)
}
/// Writes one session's text in its encoding; `encode_text` over the whole
/// string gives the same bytes.
enum StreamEncoder {
  Utf8 { with_bom: bool },
  Utf16 { big_endian: bool },
  Legacy(Box<Encoder>, String),
}

impl StreamEncoder {
  fn new(enc: &'static Encoding, label: &str, with_bom: bool) -> Self {
    if std::ptr::eq(enc, encoding_rs::UTF_8) {
      Self::Utf8 { with_bom }
    } else if std::ptr::eq(enc, encoding_rs::UTF_16LE) {
      Self::Utf16 { big_endian: false }
    } else if std::ptr::eq(enc, encoding_rs::UTF_16BE) {
      Self::Utf16 { big_endian: true }
    } else {
      Self::Legacy(Box::new(enc.new_encoder()), label.to_string())
    }
  }
  /// Write the BOM this encoding leads with, if any.
  fn begin(&self, out: &mut File) -> Result<(), String> {
    let bom: &[u8] = match self {
      Self::Utf8 { with_bom: true } => &[0xEF, 0xBB, 0xBF],
      Self::Utf16 { big_endian: false } => &[0xFF, 0xFE],
      Self::Utf16 { big_endian: true } => &[0xFE, 0xFF],
      _ => &[],
    };
    out.write_all(bom).map_err(|e| e.to_string())
  }

  fn write(&mut self, text: &str, out: &mut File) -> Result<(), String> {
    match self {
      Self::Utf8 { .. } => out.write_all(text.as_bytes()).map_err(|e| e.to_string()),
      Self::Utf16 { big_endian } => {
        let mut bytes = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
          let pair = if *big_endian {
            unit.to_be_bytes()
          } else {
            unit.to_le_bytes()
          };
          bytes.extend_from_slice(&pair);
        }
        out.write_all(&bytes).map_err(|e| e.to_string())
      }
      Self::Legacy(encoder, label) => pump_legacy(encoder, label, text, false, out),
    }
  }
  /// Flush any state the encoder holds at the end of the text.
  fn finish(&mut self, out: &mut File) -> Result<(), String> {
    if let Self::Legacy(encoder, label) = self {
      pump_legacy(encoder, label, "", true, out)?;
    }
    Ok(())
  }
}

fn pump_legacy(
  encoder: &mut Encoder,
  label: &str,
  text: &str,
  last: bool,
  out: &mut File,
) -> Result<(), String> {
  let mut buf = vec![0u8; IO_CHUNK_BYTES];
  let mut consumed = 0;
  loop {
    let (result, read, written) =
      encoder.encode_from_utf8_without_replacement(&text[consumed..], &mut buf, last);
    consumed += read;
    out.write_all(&buf[..written]).map_err(|e| e.to_string())?;
    match result {
      EncoderResult::InputEmpty => return Ok(()),
      EncoderResult::OutputFull => {}
      EncoderResult::Unmappable(_) => {
        return Err(format!(
          "content contains characters that cannot be represented in {label}"
        ));
      }
    }
  }
}

struct WriteSession {
  dest: PathBuf,
  file: File,
  staged: Staged,
  landing: Landing,
  encoder: StreamEncoder,
  received: u64,
  /// The folders this session relies on, deepest first.
  created_dirs: Vec<PathBuf>,
  created: Arc<CreatedDirs>,
}

impl WriteSession {
  fn discard(self) {
    drop(self.file);
    self.staged.discard();
    self.created.abandon(&self.created_dirs);
  }
}
/// Folders made for saves still in progress, each with how many sessions rely
/// on it. A count is never zero while its entry exists.
#[derive(Default)]
struct CreatedDirs {
  counts: Mutex<HashMap<PathBuf, usize>>,
}

impl CreatedDirs {
  /// Count a session on the levels of `dir` in `made`, and on any other level
  /// of `dir` already recorded. Answers with what it now holds, deepest first.
  fn acquire(&self, made: &[PathBuf], dir: &Path) -> Vec<PathBuf> {
    let mut counts = locked(&self.counts);
    let mut held = Vec::new();
    for level in dir.ancestors() {
      let count = if made.iter().any(|m| m == level) {
        Some(counts.entry(level.to_path_buf()).or_insert(0))
      } else {
        counts.get_mut(level)
      };
      if let Some(count) = count {
        *count += 1;
        held.push(level.to_path_buf());
      }
    }
    held
  }
  /// A save landed: these folders are no longer a failed save's to remove.
  fn finish_ok(&self, held: &[PathBuf]) {
    let mut counts = locked(&self.counts);
    for dir in held {
      counts.remove(dir);
    }
  }
  /// Drop one session's hold, answering with the folders nobody relies on now.
  /// A folder a save has landed in is no longer recorded, so it is skipped.
  fn finish_failed(&self, held: &[PathBuf]) -> Vec<PathBuf> {
    let mut counts = locked(&self.counts);
    let mut emptied = Vec::new();
    for dir in held {
      if let Some(count) = counts.get_mut(dir) {
        *count -= 1;
        if *count == 0 {
          counts.remove(dir);
          emptied.push(dir.clone());
        }
      }
    }
    emptied
  }

  fn abandon(&self, held: &[PathBuf]) {
    remove_created_dirs(&self.finish_failed(held));
  }
}
/// The name a write session stages under, unique to the session and attempt.
fn io_temp_name(token: u64, salt: &str, attempt: u32) -> String {
  format!(".io-{token}-{salt}-{attempt}")
}
/// Chunked read and write sessions. Nothing here holds a file's content.
pub struct DocIoState {
  reads: SessionTable<ReadSession>,
  writes: SessionTable<WriteSession>,
  created: Arc<CreatedDirs>,
  /// Random at startup, mixed into staged file names.
  process_salt: u32,
}

impl Default for DocIoState {
  fn default() -> Self {
    Self::new()
  }
}

impl DocIoState {
  pub fn new() -> Self {
    let id = uuid::Uuid::new_v4().as_u128();
    Self {
      reads: SessionTable::new(),
      writes: SessionTable::new(),
      created: Arc::default(),
      process_salt: (id >> 96) as u32,
    }
  }

  fn salt(&self) -> String {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0) as u32;
    format!("{:08x}{nanos:08x}", self.process_salt)
  }

  #[cfg(test)]
  fn begin_read(
    &self,
    label: &str,
    path: &str,
    encoding: Option<&str>,
  ) -> Result<ReadBegun, String> {
    self.begin_read_with(label, path, encoding, &|_| true)
  }

  fn begin_read_with(
    &self,
    label: &str,
    path: &str,
    encoding: Option<&str>,
    window_alive: &dyn Fn(&str) -> bool,
  ) -> Result<ReadBegun, String> {
    let forced = match encoding {
      Some(name) => {
        Some(label_to_encoding(name).ok_or_else(|| format!("unsupported encoding: {name}"))?)
      }
      None => None,
    };
    let (token, slot) = self.reads.admit(label)?;
    let opened = (|| {
      let mut file = File::open(path).map_err(|e| read_error(&e))?;
      let (len, modified) = stat_of(&file)?;
      let scan = begin_stream(&mut file, forced).map_err(|e| read_error(&e))?;
      let stream = ReadStream::new(&scan, len);
      let session = ReadSession {
        file,
        len,
        modified,
        stream,
      };
      Ok::<_, String>((session, scan))
    })();
    let (session, scan) = match opened {
      Ok(opened) => opened,
      Err(e) => {
        let _ = self.reads.remove(label, token);
        return Err(e);
      }
    };
    *locked(&slot) = Some(session);
    if !window_alive(label) {
      let _ = self.reads.remove(label, token);
      locked(&slot).take();
      return Err(WINDOW_CLOSED.to_string());
    }
    // The window may have gone while the file was open.
    if !self.reads.holds(token) {
      locked(&slot).take();
    }
    Ok(ReadBegun {
      token: token.to_string(),
      encoding: label_for(scan.encoding),
      had_bom: scan.bom_len > 0,
    })
  }

  fn read_chunk(&self, label: &str, token: &str, offset: u64) -> Result<Vec<u8>, String> {
    let token = parse_token(token)?;
    let slot = self.reads.slot(label, token)?;
    let mut guard = locked(&slot);
    let Some(session) = guard.as_mut() else {
      return Err(UNKNOWN_SESSION.to_string());
    };
    if offset != session.stream.sent {
      return Err(format!(
        "read offset {offset} is not {}",
        session.stream.sent
      ));
    }
    let result = match stat_of(&session.file) {
      Ok(stat) if stat == (session.len, session.modified) => {
        read_next(&mut session.stream, &mut session.file)
      }
      Ok(_) => Err(FILE_CHANGED.to_string()),
      Err(e) => Err(e),
    };
    if matches!(&result, Err(e) if e == FILE_CHANGED) {
      guard.take();
      drop(guard);
      let _ = self.reads.remove(label, token);
    }
    result
  }

  fn end_read(&self, label: &str, token: &str) -> Result<ReadEnded, String> {
    let token = parse_token(token)?;
    let slot = self.reads.remove(label, token)?;
    let session = locked(&slot)
      .take()
      .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
    Ok(ReadEnded {
      content_bytes: session.stream.sent,
      lossy: session.stream.lossy,
    })
  }

  #[cfg(test)]
  fn begin_write(
    &self,
    label: &str,
    path: &str,
    encoding: &str,
    with_bom: bool,
    salt: &str,
  ) -> Result<String, String> {
    self.begin_write_with(
      label,
      path,
      encoding,
      with_bom,
      salt,
      &|_| true,
      &|| {},
      &|| {},
    )
  }
  /// `on_attempt` starts each try; `before_stage` runs between checking the
  /// folder and creating the staged file.
  #[allow(clippy::too_many_arguments)]
  fn begin_write_with(
    &self,
    label: &str,
    path: &str,
    encoding: &str,
    with_bom: bool,
    salt: &str,
    window_alive: &dyn Fn(&str) -> bool,
    on_attempt: &dyn Fn(),
    before_stage: &dyn Fn(),
  ) -> Result<String, String> {
    let enc =
      label_to_encoding(encoding).ok_or_else(|| format!("unsupported encoding: {encoding}"))?;
    let (token, slot) = self.writes.admit(label)?;
    let dest = PathBuf::from(path);
    let dir = dest.parent().unwrap_or(Path::new(""));
    let opened = (|| {
      let name_at = |attempt| io_temp_name(token, salt, attempt);
      let mut retries = FOLDER_VANISHED_RETRIES;
      let (prepared, held) = loop {
        on_attempt();
        let (made, ensured) = ensure_parent_dir(&dest);
        let held = self.created.acquire(&made, dir);
        if let Err(e) = ensured {
          self.created.abandon(&held);
          return Err(e);
        }
        before_stage();
        match prepare(&dest, |at| stage_unique(at, name_at, None)) {
          Ok(prepared) => break (prepared, held),
          Err(e) => {
            // Asked first: this attempt's own cleanup does not count as vanishing.
            let vanished = folder_vanished(dir);
            self.created.abandon(&held);
            if !vanished || retries == 0 {
              return Err(e);
            }
            retries -= 1;
          }
        }
      };
      let Prepared {
        mut file,
        staged,
        landing,
      } = prepared;
      let encoder = StreamEncoder::new(enc, encoding, with_bom);
      if let Err(e) = encoder.begin(&mut file) {
        drop(file);
        staged.discard();
        self.created.abandon(&held);
        return Err(e);
      }
      Ok(WriteSession {
        dest: dest.clone(),
        file,
        staged,
        landing,
        encoder,
        received: 0,
        created_dirs: held,
        created: Arc::clone(&self.created),
      })
    })();
    let session = match opened {
      Ok(session) => session,
      Err(e) => {
        let _ = self.writes.remove(label, token);
        return Err(e);
      }
    };
    *locked(&slot) = Some(session);
    if !window_alive(label) {
      let _ = self.writes.remove(label, token);
      if let Some(session) = locked(&slot).take() {
        session.discard();
      }
      return Err(WINDOW_CLOSED.to_string());
    }
    // The window may have gone while the staged file was being created.
    if !self.writes.holds(token) {
      if let Some(session) = locked(&slot).take() {
        session.discard();
      }
    }
    Ok(token.to_string())
  }

  fn accept_chunk(
    &self,
    label: &str,
    headers: &HeaderMap,
    body: &InvokeBody,
  ) -> Result<(), String> {
    let token = header_number(headers, IO_TOKEN_HEADER)?;
    let slot = self.writes.slot(label, token)?;
    let mut guard = locked(&slot);
    let result = match guard.as_mut() {
      Some(session) => write_chunk_to(session, headers, body),
      None => Err(UNKNOWN_SESSION.to_string()),
    };
    if result.is_err() {
      if let Some(session) = guard.take() {
        session.discard();
      }
      drop(guard);
      let _ = self.writes.remove(label, token);
    }
    result
  }

  fn commit_write(
    &self,
    label: &str,
    token: &str,
    content_bytes: u64,
    pour: impl FnOnce(&Path, &Path) -> Result<(), String>,
  ) -> Result<(), String> {
    let token = parse_token(token)?;
    let slot = self.writes.remove(label, token)?;
    let mut session = locked(&slot)
      .take()
      .ok_or_else(|| UNKNOWN_SESSION.to_string())?;
    if session.received != content_bytes {
      let expected = session.received;
      session.discard();
      return Err(format!(
        "write of {content_bytes} bytes received {expected}"
      ));
    }
    let flushed = session
      .encoder
      .finish(&mut session.file)
      .and_then(|()| session.file.sync_all().map_err(|e| e.to_string()));
    if let Err(e) = flushed {
      session.discard();
      return Err(e);
    }
    let WriteSession {
      dest,
      file,
      staged,
      landing,
      created_dirs,
      created,
      ..
    } = session;
    drop(file);
    let lock = destination_lock(&dest);
    let _guard = locked(&lock);
    if !writable(&dest) {
      staged.discard();
      created.abandon(&created_dirs);
      return Err(READ_ONLY_DESTINATION.to_string());
    }
    let landed = land(staged, landing, &dest, pour);
    match &landed {
      Ok(()) => created.finish_ok(&created_dirs),
      Err(_) => created.abandon(&created_dirs),
    }
    landed
  }

  fn abort_write(&self, label: &str, token: &str) -> Result<(), String> {
    let token = parse_token(token)?;
    let slot = self.writes.remove(label, token)?;
    if let Some(session) = locked(&slot).take() {
      session.discard();
    }
    Ok(())
  }
  /// Move a window's sessions out of the tables, without closing anything yet.
  fn take_window(&self, label: &str) -> WindowSessions {
    WindowSessions {
      reads: self.reads.drain_window(label),
      writes: self.writes.drain_window(label),
    }
  }
}

fn write_chunk_to(
  session: &mut WriteSession,
  headers: &HeaderMap,
  body: &InvokeBody,
) -> Result<(), String> {
  let start = header_number(headers, IO_OFFSET_HEADER)?;
  let InvokeBody::Raw(bytes) = body else {
    return Err("expected a raw body".to_string());
  };
  if bytes.len() > IO_CHUNK_BYTES {
    return Err("chunk larger than the limit".to_string());
  }
  if start != session.received {
    return Err(format!("chunk at {start} is not at {}", session.received));
  }
  let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
  session.encoder.write(text, &mut session.file)?;
  session.received += bytes.len() as u64;
  Ok(())
}
/// What a closed window held, to be released off the calling thread.
struct WindowSessions {
  reads: Vec<Slot<ReadSession>>,
  writes: Vec<Slot<WriteSession>>,
}

impl WindowSessions {
  fn is_empty(&self) -> bool {
    self.reads.is_empty() && self.writes.is_empty()
  }

  fn release(self) {
    for slot in self.reads {
      locked(&slot).take();
    }
    for slot in self.writes {
      if let Some(session) = locked(&slot).take() {
        session.discard();
      }
    }
  }
}
/// A window closed or its page reloaded: take its sessions out on the calling
/// thread and close them on another.
pub fn window_gone(app: &AppHandle, label: &str) {
  let Some(state) = app.try_state::<DocIoState>() else {
    return;
  };
  let sessions = state.take_window(label);
  if !sessions.is_empty() {
    std::thread::spawn(move || sessions.release());
  }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadBegun {
  token: String,
  encoding: String,
  had_bom: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadEnded {
  content_bytes: u64,
  lossy: bool,
}
/// Answered with bytes, so the page can see whether binary responses still
/// reach it.
#[tauri::command]
pub fn ipc_probe() -> Response {
  Response::new(vec![0u8])
}

#[tauri::command(async)]
pub fn read_begin(
  webview: Webview,
  state: State<'_, DocIoState>,
  path: String,
  encoding: Option<String>,
) -> Result<ReadBegun, String> {
  state.begin_read_with(webview.label(), &path, encoding.as_deref(), &|label| {
    webview.get_webview_window(label).is_some()
  })
}
/// `read_chunk` is the large-file viewer's command, so this is not named that.
#[tauri::command(async)]
pub fn doc_read_chunk(
  webview: Webview,
  state: State<'_, DocIoState>,
  token: String,
  offset: u64,
) -> Result<Response, String> {
  state
    .read_chunk(webview.label(), &token, offset)
    .map(Response::new)
}

#[tauri::command(async)]
pub fn read_end(
  webview: Webview,
  state: State<'_, DocIoState>,
  token: String,
) -> Result<ReadEnded, String> {
  state.end_read(webview.label(), &token)
}

#[tauri::command(async)]
pub fn write_begin(
  webview: Webview,
  state: State<'_, DocIoState>,
  path: String,
  encoding: String,
  with_bom: bool,
) -> Result<String, String> {
  let salt = state.salt();
  state.begin_write_with(
    webview.label(),
    &path,
    &encoding,
    with_bom,
    &salt,
    &|label| webview.get_webview_window(label).is_some(),
    &|| {},
    &|| {},
  )
}

#[tauri::command(async)]
pub async fn write_chunk(
  webview: Webview,
  state: State<'_, DocIoState>,
  request: Request<'_>,
) -> Result<(), String> {
  state.accept_chunk(webview.label(), request.headers(), request.body())
}

#[tauri::command(async)]
pub fn write_commit(
  webview: Webview,
  state: State<'_, DocIoState>,
  token: String,
  content_bytes: u64,
) -> Result<(), String> {
  state.commit_write(webview.label(), &token, content_bytes, copy_into_place)
}

#[tauri::command(async)]
pub fn write_abort(
  webview: Webview,
  state: State<'_, DocIoState>,
  token: String,
) -> Result<(), String> {
  state.abort_write(webview.label(), &token)
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  #[test]
  fn supported_list_matches_the_frontend_list() {
    let ts = include_str!("../../src/lib/util/text.ts");
    let start = ts.find("export const ENCODINGS = [").unwrap();
    let list = &ts[start..];
    let list = &list[..list.find("] as const;").unwrap()];
    let frontend: Vec<&str> = list
      .lines()
      .skip(1)
      .map(|line| line.trim().trim_end_matches(',').trim_matches('\''))
      .collect();
    let backend: Vec<&str> = supported().iter().map(|(label, _)| *label).collect();
    assert_eq!(frontend, backend);
  }

  #[test]
  fn read_commands_report_missing_file_as_protocol_value() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("gone.txt").to_string_lossy().into_owned();
    assert_eq!(read_file_auto(p.clone()).unwrap_err(), "file-not-found");
    assert_eq!(
      read_file_as(p, "UTF-8".to_string()).unwrap_err(),
      "file-not-found"
    );
  }

  #[cfg(unix)]
  #[test]
  fn read_commands_report_unreadable_file_with_other_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("locked.txt");
    std::fs::write(&path, b"x").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read(&path).is_ok() {
      // Running as root: permissions are not enforced.
      return;
    }
    let p = path.to_string_lossy().into_owned();
    let a = read_file_auto(p.clone()).unwrap_err();
    let b = read_file_as(p, "UTF-8".to_string()).unwrap_err();
    assert_ne!(a, "file-not-found");
    assert_ne!(b, "file-not-found");
  }

  #[test]
  fn bom_sniff_utf8() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("héllo".as_bytes());
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "UTF-8");
    assert!(d.had_bom);
    assert!(!d.lossy);
    assert_eq!(d.content, "héllo");
  }

  #[test]
  fn bom_sniff_utf16le() {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "héllo".encode_utf16() {
      bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "UTF-16LE");
    assert!(d.had_bom);
    assert_eq!(d.content, "héllo");
  }

  #[test]
  fn bom_sniff_utf16be() {
    let mut bytes = vec![0xFE, 0xFF];
    for unit in "héllo".encode_utf16() {
      bytes.extend_from_slice(&unit.to_be_bytes());
    }
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "UTF-16BE");
    assert!(d.had_bom);
    assert_eq!(d.content, "héllo");
  }

  #[test]
  fn strict_utf8_no_bom() {
    let d = decode_auto("plain ascii and üñïçödé".as_bytes());
    assert_eq!(d.encoding, "UTF-8");
    assert!(!d.had_bom);
    assert!(!d.lossy);
  }

  #[test]
  fn big5_detection_roundtrip() {
    // Traditional-Chinese sample, long enough for statistical detection.
    let original = "這是一段用來測試繁體中文編碼偵測的範例文字，包含許多常見的字元。";
    let bytes = encode_text(original, "Big5", false).unwrap();
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "Big5");
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn shift_jis_detection_roundtrip() {
    // Japanese sample with kana, which chardetng reads as Shift_JIS.
    let original = "これはシフトジスの文字コードを判定するためのテスト用の文章です。";
    let bytes = encode_text(original, "Shift_JIS", false).unwrap();
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "Shift_JIS");
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn decode_as_forces_encoding() {
    // Bytes 0xB4 0xE1 are valid Big5 but arbitrary Windows-1252.
    let original = "測試";
    let bytes = encode_text(original, "Big5", false).unwrap();
    let forced = decode_as(&bytes, "Big5").unwrap();
    assert_eq!(forced.encoding, "Big5");
    assert_eq!(forced.content, original);
    // Forcing Windows-1252 over the same bytes yields different, non-empty text.
    let mis = decode_as(&bytes, "windows-1252").unwrap();
    assert_ne!(mis.content, original);
  }

  #[test]
  fn decode_as_strips_matching_bom() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("hi".as_bytes());
    let d = decode_as(&bytes, "UTF-8").unwrap();
    assert!(d.had_bom);
    assert_eq!(d.content, "hi");
  }

  #[test]
  fn lossy_flag_set_on_bad_bytes() {
    // 0xFF is not valid Shift_JIS and decodes to a replacement character.
    let d = decode_as(&[0x41, 0xFF, 0x42], "Shift_JIS").unwrap();
    assert!(d.lossy);
    assert!(d.content.contains('\u{FFFD}'));
  }

  #[test]
  fn encode_utf8_with_and_without_bom() {
    let without = encode_text("hi", "UTF-8", false).unwrap();
    assert_eq!(without, b"hi");
    let with = encode_text("hi", "UTF-8", true).unwrap();
    assert_eq!(with, vec![0xEF, 0xBB, 0xBF, b'h', b'i']);
  }

  #[test]
  fn encode_utf16_always_carries_bom() {
    let le = encode_text("A", "UTF-16LE", false).unwrap();
    assert_eq!(le, vec![0xFF, 0xFE, 0x41, 0x00]);
    let be = encode_text("A", "UTF-16BE", false).unwrap();
    assert_eq!(be, vec![0xFE, 0xFF, 0x00, 0x41]);
  }

  #[test]
  fn encode_ignores_bom_for_legacy_encoding() {
    // with_bom must not prepend anything for a non-Unicode encoding.
    let a = encode_text("abc", "Windows-1252", true).unwrap();
    let b = encode_text("abc", "Windows-1252", false).unwrap();
    assert_eq!(a, b);
    assert_eq!(a, b"abc");
  }

  #[test]
  fn encode_unmappable_char_errors() {
    // A traditional-Chinese character has no Windows-1252 representation.
    let err = encode_text("héllo 測", "Windows-1252", false).unwrap_err();
    assert!(err.contains("cannot be represented"));
  }

  #[test]
  fn every_label_resolves_and_maps_back() {
    for (label, enc) in supported() {
      assert!(std::ptr::eq(label_to_encoding(label).unwrap(), enc));
      assert_eq!(label_for(enc), label);
    }
  }

  #[test]
  fn gb18030_roundtrip() {
    let original = "这是一段用于测试GB18030编码的示例文字。";
    let bytes = encode_text(original, "GB18030", false).unwrap();
    // The known GB18030 encoding of "这" ("this"), so a mutated codec mapping
    // (not only wrong output text) gets caught.
    assert!(bytes.starts_with(&[0xD5, 0xE2]));
    let d = decode_as(&bytes, "GB18030").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn gb18030_supports_supplementary_plane_that_gbk_rejects() {
    // U+20000, a supplementary-plane CJK character. GB18030 encodes it as a
    // 4-byte sequence; GBK (2-byte only) has no representation for it, which
    // documents the exact difference between the two encoders.
    let original = "\u{20000}";
    let bytes = encode_text(original, "GB18030", false).unwrap();
    let d = decode_as(&bytes, "GB18030").unwrap();
    assert_eq!(d.content, original);
    let err = encode_text(original, "GBK", false).unwrap_err();
    assert!(err.contains("cannot be represented"));
  }

  #[test]
  fn gbk_roundtrip() {
    // Common simplified-Chinese characters, all within GBK's 2-byte repertoire.
    let original = "这是一段用于测试GBK编码的示例文字。";
    let bytes = encode_text(original, "GBK", false).unwrap();
    assert!(bytes.starts_with(&[0xD5, 0xE2]));
    let d = decode_as(&bytes, "GBK").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn euc_kr_roundtrip() {
    let original = "이것은 EUC-KR 인코딩을 테스트하기 위한 한국어 문장입니다.";
    let bytes = encode_text(original, "EUC-KR", false).unwrap();
    // The known EUC-KR encoding of "이" ("this"/subject marker).
    assert!(bytes.starts_with(&[0xC0, 0xCC]));
    let d = decode_as(&bytes, "EUC-KR").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn iso_8859_15_roundtrip() {
    // Includes the Euro sign, the character that distinguishes -15 from -1.
    let original = "Le prix est de 20 € pour ce produit très cher.";
    let bytes = encode_text(original, "ISO-8859-15", false).unwrap();
    // 0xA4 is the Euro sign under -15; under plain ISO-8859-1 it's the
    // generic currency sign, so this byte pins us to the right variant.
    assert!(bytes.contains(&0xA4));
    let d = decode_as(&bytes, "ISO-8859-15").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1250_roundtrip() {
    // Czech pangram, exercising Central European diacritics.
    let original = "Příliš žluťoučký kůň úpěl ďábelské ódy.";
    let bytes = encode_text(original, "Windows-1250", false).unwrap();
    // 0xF8 is "ř" under Windows-1250, a byte most other single-byte code
    // pages either leave unassigned or map to something else entirely.
    assert!(bytes.contains(&0xF8));
    let d = decode_as(&bytes, "Windows-1250").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn koi8_r_roundtrip() {
    let original = "Привет, это тест кодировки КОИ8-Р.";
    let bytes = encode_text(original, "KOI8-R", false).unwrap();
    // The known KOI8-R encoding of "П", the first Cyrillic letter here.
    // KOI8-R's Cyrillic layout doesn't follow ISO/Windows Cyrillic ordering,
    // so this byte pins us to KOI8-R specifically and not Windows-1251.
    assert!(bytes.starts_with(&[0xF0]));
    let d = decode_as(&bytes, "KOI8-R").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1253_roundtrip() {
    let original = "Αυτό είναι ένα δοκιμαστικό κείμενο στα ελληνικά.";
    let bytes = encode_text(original, "Windows-1253", false).unwrap();
    // The known Windows-1253 encoding of "Α" (Greek capital alpha).
    assert!(bytes.starts_with(&[0xC1]));
    let d = decode_as(&bytes, "Windows-1253").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1254_roundtrip() {
    // Turkish characters not present in Windows-1252 (ğ, ş, ı).
    let original = "Bu, Türkçe karakterler içeren bir test metnidir: ğüşıöç.";
    let bytes = encode_text(original, "Windows-1254", false).unwrap();
    // 0xF0 is "ğ" (g-breve) under Windows-1254, the letter that most clearly
    // distinguishes Turkish's code page from the rest of the Windows-125x family.
    assert!(bytes.contains(&0xF0));
    let d = decode_as(&bytes, "Windows-1254").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1255_roundtrip() {
    let original = "זהו טקסט בדיקה בעברית.";
    let bytes = encode_text(original, "Windows-1255", false).unwrap();
    // The known Windows-1255 encoding of "ז" (Hebrew letter zayin).
    assert!(bytes.starts_with(&[0xE6]));
    let d = decode_as(&bytes, "Windows-1255").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1256_roundtrip() {
    let original = "هذا نص تجريبي باللغة العربية.";
    let bytes = encode_text(original, "Windows-1256", false).unwrap();
    // The known Windows-1256 encoding of "ه" (Arabic letter heh).
    assert!(bytes.starts_with(&[0xE5]));
    let d = decode_as(&bytes, "Windows-1256").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_874_roundtrip() {
    let original = "นี่คือข้อความทดสอบภาษาไทย";
    let bytes = encode_text(original, "Windows-874", false).unwrap();
    // The known Windows-874 (TIS-620-based) encoding of "น" (Thai letter no nu).
    assert!(bytes.starts_with(&[0xB9]));
    let d = decode_as(&bytes, "Windows-874").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1258_roundtrip() {
    // Windows-1258 has no precomposed slot for every Vietnamese vowel/tone
    // combination (e.g. U+1ED9 "ộ" is unmappable), so genuine Windows-1258
    // text stores such letters decomposed: a precomposed base letter (ô, ê,
    // â, …) followed by a combining tone mark. This sample uses that form,
    // which is exactly what real Windows-1258 documents contain.
    let original = "Đây là mô\u{323}t câu tiê\u{301}ng Viê\u{323}t có dâ\u{301}u.";
    let bytes = encode_text(original, "Windows-1258", false).unwrap();
    // The known Windows-1258 encoding of "Đ" (D with stroke), a letter absent
    // from every other Windows-125x/ISO code page in this list.
    assert!(bytes.starts_with(&[0xD0]));
    let d = decode_as(&bytes, "Windows-1258").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn macroman_roundtrip() {
    let original = "Café à la crème, très élégant.";
    let bytes = encode_text(original, "MacRoman", false).unwrap();
    // "é" is 0x8E under MacRoman, unlike 0xE9 under every Windows/ISO Latin
    // code page, so this pins us to the classic Mac OS Roman table.
    assert!(bytes.contains(&0x8E));
    let d = decode_as(&bytes, "MacRoman").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn euc_jp_detection_roundtrip() {
    let original = "これは日本語の文章で、文字コードの自動判定を確認するためのものです。";
    let bytes = encode_text(original, "EUC-JP", false).unwrap();
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "EUC-JP");
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn iso_2022_jp_roundtrip() {
    // ISO-2022-JP uses escape sequences; detection keys off them directly.
    let original = "日本語のメールでよく使われる文字コードです。";
    let bytes = encode_text(original, "ISO-2022-JP", false).unwrap();
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "ISO-2022-JP");
    assert_eq!(d.content, original);
    let forced = decode_as(&bytes, "ISO-2022-JP").unwrap();
    assert_eq!(forced.content, original);
  }

  #[test]
  fn windows_1251_roundtrip() {
    let original = "Это тестовый текст на русском языке для проверки кодировки.";
    let bytes = encode_text(original, "Windows-1251", false).unwrap();
    let d = decode_as(&bytes, "Windows-1251").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn write_file_encoded_writes_expected_bytes() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("doc.txt");
    write_file_encoded(
      path.to_string_lossy().into_owned(),
      "hi".into(),
      "UTF-16LE".into(),
      false,
    )
    .unwrap();
    let read = std::fs::read(&path).unwrap();
    assert_eq!(read, vec![0xFF, 0xFE, b'h', 0x00, b'i', 0x00]);
    // Round-trips back through auto detection.
    assert_eq!(decode_auto(&read).content, "hi");
  }
}

#[cfg(test)]
mod doc_io_tests {
  use super::*;
  use crate::fs_ops::STAGE_NAME_STEM_BYTES;
  use std::cell::Cell;
  use std::io::Cursor;
  use std::sync::mpsc;
  use std::time::Duration;
  use tauri::http::HeaderValue;
  use tempfile::{tempdir, TempDir};

  const WIN: &str = "main";
  const OTHER: &str = "other";
  const SALT: &str = "testsalt";

  fn write_file(dir: &TempDir, name: &str, bytes: &[u8]) -> String {
    let path = dir.path().join(name);
    std::fs::write(&path, bytes).unwrap();
    path.to_string_lossy().into_owned()
  }
  /// Read through a session to its empty chunk, checking every chunk's bound.
  fn read_all(
    state: &DocIoState,
    path: &str,
    forced: Option<&str>,
  ) -> (String, ReadBegun, ReadEnded) {
    let begun = state.begin_read(WIN, path, forced).unwrap();
    let mut content = Vec::new();
    loop {
      let chunk = state
        .read_chunk(WIN, &begun.token, content.len() as u64)
        .unwrap();
      assert!(chunk.len() <= IO_CHUNK_BYTES);
      if chunk.is_empty() {
        break;
      }
      content.extend_from_slice(&chunk);
    }
    let ended = state.end_read(WIN, &begun.token).unwrap();
    assert_eq!(ended.content_bytes, content.len() as u64);
    (String::from_utf8(content).unwrap(), begun, ended)
  }

  fn assert_same_as_auto(bytes: &[u8]) {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "doc.txt", bytes);
    let (content, begun, ended) = read_all(&DocIoState::new(), &path, None);
    let expected = decode_auto(bytes);
    assert_eq!(content, expected.content);
    assert_eq!(begun.encoding, expected.encoding);
    assert_eq!(begun.had_bom, expected.had_bom);
    assert_eq!(ended.lossy, expected.lossy);
  }

  fn assert_same_as_forced(bytes: &[u8], label: &str) {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "doc.txt", bytes);
    let (content, begun, ended) = read_all(&DocIoState::new(), &path, Some(label));
    let expected = decode_as(bytes, label).unwrap();
    assert_eq!(content, expected.content);
    assert_eq!(begun.encoding, expected.encoding);
    assert_eq!(begun.had_bom, expected.had_bom);
    assert_eq!(ended.lossy, expected.lossy);
  }

  #[test]
  fn read_begin_reports_a_missing_file_as_the_protocol_value() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("gone.txt").to_string_lossy().into_owned();
    let err = DocIoState::new().begin_read(WIN, &path, None).unwrap_err();
    assert_eq!(err, "file-not-found");
  }

  #[test]
  fn shared_values_match_the_frontend_file() {
    let ts = include_str!("../../src/lib/util/documentIoProtocol.ts");
    let value = |name: &str| {
      ts.split(&format!("export const {name} = "))
        .nth(1)
        .and_then(|rest| rest.split(';').next())
        .unwrap_or_else(|| panic!("{name} in documentIoProtocol.ts"))
        .trim()
        .to_string()
    };
    assert_eq!(value("IO_CHUNK_BYTES"), IO_CHUNK_BYTES.to_string());
    assert_eq!(value("IO_TOKEN_HEADER"), format!("'{IO_TOKEN_HEADER}'"));
    assert_eq!(value("IO_OFFSET_HEADER"), format!("'{IO_OFFSET_HEADER}'"));
    assert_eq!(value("IO_SESSION_LIMIT"), format!("'{IO_SESSION_LIMIT}'"));
    assert_eq!(value("FILE_CHANGED"), format!("'{FILE_CHANGED}'"));
  }

  #[test]
  fn empty_file_matches_and_answers_empty_at_once() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "empty.txt", b"");
    let state = DocIoState::new();
    let begun = state.begin_read(WIN, &path, None).unwrap();
    assert!(state.read_chunk(WIN, &begun.token, 0).unwrap().is_empty());
    let ended = state.end_read(WIN, &begun.token).unwrap();
    assert_eq!(ended.content_bytes, 0);
    assert_same_as_auto(b"");
    assert_same_as_forced(b"", "Shift_JIS");
  }

  #[test]
  fn boms_lossy_and_forced_utf8_read_as_the_whole_file_decoders_do() {
    // UTF-8 BOM and UTF-16 BOMs.
    let mut utf8_bom = vec![0xEF, 0xBB, 0xBF];
    utf8_bom.extend_from_slice("héllo".as_bytes());
    assert_same_as_auto(&utf8_bom);
    assert_same_as_forced(&utf8_bom, "UTF-8");
    let mut le = vec![0xFF, 0xFE];
    for unit in "héllo測試".encode_utf16() {
      le.extend_from_slice(&unit.to_le_bytes());
    }
    assert_same_as_auto(&le);
    let mut be = vec![0xFE, 0xFF];
    for unit in "héllo測試".encode_utf16() {
      be.extend_from_slice(&unit.to_be_bytes());
    }
    assert_same_as_auto(&be);
    // Lossy: BOM then invalid, forced UTF-8 over Shift_JIS and Latin-1 bytes.
    assert_same_as_auto(&[0xEF, 0xBB, 0xBF, 0x41, 0xFF, 0x42]);
    assert_same_as_forced(&[0xEF, 0xBB, 0xBF, 0x41, 0xFF, 0x42], "UTF-8");
    let sjis = encode_text("シフトジスの文章です", "Shift_JIS", false).unwrap();
    assert_same_as_forced(&sjis, "UTF-8");
    assert_same_as_forced(&[0x63, 0x61, 0x66, 0xE9, 0x20, 0xFC], "UTF-8");
    assert_same_as_forced(&[0x41, 0xFF, 0x42], "Shift_JIS");
  }

  #[test]
  fn invalid_utf8_across_the_chunk_boundary_reads_as_decode_as() {
    // A Shift_JIS pair and a Latin-1 byte straddling 1 MiB.
    let sjis_pair = encode_text("日", "Shift_JIS", false).unwrap();
    assert_eq!(sjis_pair.len(), 2);
    let mut across = vec![b'a'; IO_CHUNK_BYTES - 1];
    across.extend_from_slice(&sjis_pair);
    across.extend_from_slice(b"tail");
    assert_same_as_forced(&across, "UTF-8");
    let mut latin = vec![b'a'; IO_CHUNK_BYTES - 1];
    latin.push(0xE9);
    latin.extend_from_slice(b"tail");
    assert_same_as_forced(&latin, "UTF-8");
    // A truncated sequence at the end of the content, past the boundary.
    let mut truncated = vec![b'a'; IO_CHUNK_BYTES];
    truncated.extend_from_slice(&[0xE3, 0x81]);
    assert_same_as_forced(&truncated, "UTF-8");
    assert_same_as_auto(&truncated);
  }

  #[test]
  fn iso_2022_jp_escape_is_seen_across_the_chunk_boundary() {
    let body = encode_text("日本語のテキスト", "ISO-2022-JP", false).unwrap();
    assert!(body.starts_with(b"\x1B$B"));
    for split in 1..3 {
      let mut bytes = vec![b'a'; IO_CHUNK_BYTES - split];
      bytes.extend_from_slice(&body);
      assert_same_as_auto(&bytes);
      assert_same_as_forced(&bytes, "ISO-2022-JP");
    }
  }

  #[test]
  fn detector_files_read_as_decode_auto() {
    let big5 = encode_text(
      "這是一段用來測試繁體中文編碼偵測的範例文字，包含許多常見的字元。",
      "Big5",
      false,
    )
    .unwrap();
    assert_same_as_auto(&big5);
    let mut large = Vec::new();
    while large.len() < 3 * IO_CHUNK_BYTES {
      large.extend_from_slice(&big5);
    }
    assert_same_as_auto(&large);
    let euc = encode_text(
      "これは日本語の文章で、文字コードの自動判定を確認するためのものです。",
      "EUC-JP",
      false,
    )
    .unwrap();
    assert_same_as_auto(&euc);
  }

  #[test]
  fn non_ascii_path_reads() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "日本語の名前.txt", "內容 héllo".as_bytes());
    let (content, begun, _) = read_all(&DocIoState::new(), &path, None);
    assert_eq!(content, "內容 héllo");
    assert_eq!(begun.encoding, "UTF-8");
  }

  #[test]
  fn sizes_at_the_chunk_boundary_read_whole() {
    assert_same_as_auto(&vec![b'x'; IO_CHUNK_BYTES]);
    assert_same_as_auto(&vec![b'x'; IO_CHUNK_BYTES + 1]);
    assert_same_as_auto(&vec![b'x'; 2 * IO_CHUNK_BYTES]);
    let mut across = vec![b'a'; IO_CHUNK_BYTES - 1];
    across.extend_from_slice("測".as_bytes());
    across.extend_from_slice("後".as_bytes());
    assert_same_as_auto(&across);
  }

  #[test]
  fn a_wrong_offset_is_refused() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "doc.txt", b"hello");
    let state = DocIoState::new();
    let begun = state.begin_read(WIN, &path, None).unwrap();
    assert!(state.read_chunk(WIN, &begun.token, 1).is_err());
    assert_eq!(
      state.read_chunk(WIN, &begun.token, 0).unwrap(),
      b"hello".to_vec()
    );
    assert!(state.read_chunk(WIN, &begun.token, 0).is_err());
    assert!(state.read_chunk(WIN, &begun.token, 5).unwrap().is_empty());
  }

  #[test]
  fn a_file_changed_during_a_read_is_reported_and_the_session_is_gone() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "doc.txt", b"hello world");
    let state = DocIoState::new();
    let begun = state.begin_read(WIN, &path, None).unwrap();
    std::fs::write(&path, b"changed").unwrap();
    assert_eq!(
      state.read_chunk(WIN, &begun.token, 0).unwrap_err(),
      FILE_CHANGED
    );
    assert!(state.end_read(WIN, &begun.token).is_err());
  }

  #[test]
  fn another_window_cannot_touch_a_read_session() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "doc.txt", b"hello");
    let state = DocIoState::new();
    let begun = state.begin_read(WIN, &path, None).unwrap();
    assert!(state.read_chunk(OTHER, &begun.token, 0).is_err());
    assert!(state.end_read(OTHER, &begun.token).is_err());
    assert_eq!(
      state.read_chunk(WIN, &begun.token, 0).unwrap(),
      b"hello".to_vec()
    );
  }
  /// Counts the bytes handed out.
  struct CountingReader {
    inner: Cursor<Vec<u8>>,
    read: u64,
  }

  impl Read for CountingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
      let n = self.inner.read(buf)?;
      self.read += n as u64;
      Ok(n)
    }
  }

  impl Seek for CountingReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
      self.inner.seek(pos)
    }
  }

  #[test]
  fn a_decoded_read_reads_the_file_at_most_twice() {
    let bytes = encode_text(&"テキスト".repeat(600_000), "Shift_JIS", false).unwrap();
    let len = bytes.len() as u64;
    assert!(len > 3 * IO_CHUNK_BYTES as u64);
    let mut reader = CountingReader {
      inner: Cursor::new(bytes),
      read: 0,
    };
    let scan = begin_stream(&mut reader, Some(encoding_rs::SHIFT_JIS)).unwrap();
    let mut stream = ReadStream::new(&scan, len);
    while !read_next(&mut stream, &mut reader).unwrap().is_empty() {}
    assert!(reader.read <= 2 * len);
  }
  /// Hands out one byte per call, so a decoder sees input a byte at a time.
  struct Drip(Vec<u8>);

  impl Read for Drip {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
      if self.0.is_empty() {
        return Ok(0);
      }
      buf[0] = self.0.remove(0);
      Ok(1)
    }
  }

  #[test]
  fn input_too_short_for_output_keeps_reading_and_empty_only_ends() {
    // Lead byte first: alone it yields nothing, and must not read as the end.
    let bytes = encode_text("日", "Shift_JIS", false).unwrap();
    let scan = Scan {
      encoding: encoding_rs::SHIFT_JIS,
      bom_len: 0,
      utf8_valid: false,
    };
    let mut stream = ReadStream::new(&scan, bytes.len() as u64);
    let mut reader = Drip(bytes);
    let first = read_next(&mut stream, &mut reader).unwrap();
    assert_eq!(first, "日".as_bytes());
    assert!(read_next(&mut stream, &mut reader).unwrap().is_empty());
  }

  struct EndsEarly(Cursor<Vec<u8>>);

  impl Read for EndsEarly {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
      self.0.read(buf)
    }
  }

  #[test]
  fn a_reader_ending_early_is_a_change_not_the_end_direct() {
    let scan = Scan {
      encoding: encoding_rs::UTF_8,
      bom_len: 0,
      utf8_valid: true,
    };
    let mut stream = ReadStream::new(&scan, 100);
    let mut reader = EndsEarly(Cursor::new(b"0123456789".to_vec()));
    assert_eq!(read_next(&mut stream, &mut reader).unwrap().len(), 10);
    assert_eq!(
      read_next(&mut stream, &mut reader).unwrap_err(),
      FILE_CHANGED
    );
  }

  #[test]
  fn a_reader_ending_early_is_a_change_not_the_end_decoded() {
    let scan = Scan {
      encoding: encoding_rs::SHIFT_JIS,
      bom_len: 0,
      utf8_valid: false,
    };
    let mut stream = ReadStream::new(&scan, 100);
    let mut reader = EndsEarly(Cursor::new(b"0123456789".to_vec()));
    assert_eq!(read_next(&mut stream, &mut reader).unwrap().len(), 10);
    assert_eq!(
      read_next(&mut stream, &mut reader).unwrap_err(),
      FILE_CHANGED
    );
  }

  #[test]
  fn a_truncated_sequence_at_the_end_flushes_and_never_panics() {
    // Shift_JIS 1 MiB then a lone lead byte.
    let mut sjis = vec![b'a'; IO_CHUNK_BYTES];
    sjis.push(0x83);
    assert_same_as_forced(&sjis, "Shift_JIS");
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "sjis.txt", &sjis);
    let state = DocIoState::new();
    let begun = state.begin_read(WIN, &path, Some("Shift_JIS")).unwrap();
    let mut sent = 0u64;
    let mut sizes = Vec::new();
    loop {
      let chunk = state.read_chunk(WIN, &begun.token, sent).unwrap();
      assert!(chunk.len() <= IO_CHUNK_BYTES);
      if chunk.is_empty() {
        break;
      }
      sent += chunk.len() as u64;
      sizes.push(chunk.len());
    }
    assert!(sizes.len() >= 2);
    // Once finished, the same offset answers empty and does not touch the decoder.
    assert!(state
      .read_chunk(WIN, &begun.token, sent)
      .unwrap()
      .is_empty());
    assert!(state
      .read_chunk(WIN, &begun.token, sent)
      .unwrap()
      .is_empty());
    // Odd-length UTF-16: the half code unit at the end.
    let mut odd = vec![0xFF, 0xFE, 0x41, 0x00];
    odd.push(0x42);
    assert_same_as_auto(&odd);
    assert_same_as_forced(&[0x41, 0x00, 0x42], "UTF-16LE");
  }

  #[test]
  fn read_end_reports_the_decoders_length_and_lossiness() {
    let bytes = [0x41, 0xFF, 0x42];
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "doc.txt", &bytes);
    let (content, _, ended) = read_all(&DocIoState::new(), &path, Some("Shift_JIS"));
    let expected = decode_as(&bytes, "Shift_JIS").unwrap();
    assert_eq!(content, expected.content);
    assert_eq!(ended.content_bytes, expected.content.len() as u64);
    assert!(ended.lossy);
  }

  #[test]
  fn buffers_do_not_grow_with_the_file() {
    let bytes = encode_text(&"テキスト".repeat(1_500_000), "Shift_JIS", false).unwrap();
    let len = bytes.len() as u64;
    let dir = tempdir().unwrap();
    assert!(len > 8 * IO_CHUNK_BYTES as u64);
    let path = write_file(&dir, "big.txt", &bytes);
    drop(bytes);
    let state = DocIoState::new();
    crate::test_alloc::reset_peak();
    let before = crate::test_alloc::live();
    crate::test_alloc::reset_largest();
    let begun = state.begin_read(WIN, &path, Some("Shift_JIS")).unwrap();
    let mut sent = 0u64;
    loop {
      let chunk = state.read_chunk(WIN, &begun.token, sent).unwrap();
      if chunk.is_empty() {
        break;
      }
      sent += chunk.len() as u64;
    }
    state.end_read(WIN, &begun.token).unwrap();
    assert!(crate::test_alloc::largest() <= 2 * IO_CHUNK_BYTES);
    assert!(crate::test_alloc::peak() - before <= 6 * IO_CHUNK_BYTES as i64);
  }

  fn headers_of(token: &str, offset: &str) -> HeaderMap {
    let mut map = HeaderMap::new();
    map.insert(IO_TOKEN_HEADER, HeaderValue::from_str(token).unwrap());
    map.insert(IO_OFFSET_HEADER, HeaderValue::from_str(offset).unwrap());
    map
  }

  fn send(state: &DocIoState, token: &str, offset: u64, bytes: &[u8]) -> Result<(), String> {
    state.accept_chunk(
      WIN,
      &headers_of(token, &offset.to_string()),
      &InvokeBody::Raw(bytes.to_vec()),
    )
  }
  /// Run a whole write of `pieces`, returning the staged-free result bytes.
  fn write_pieces(label: &str, with_bom: bool, pieces: &[&str]) -> Result<Vec<u8>, String> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("out.txt");
    let p = path.to_string_lossy().into_owned();
    let state = DocIoState::new();
    let token = state.begin_write(WIN, &p, label, with_bom, SALT)?;
    let mut offset = 0u64;
    for piece in pieces {
      send(&state, &token, offset, piece.as_bytes())?;
      offset += piece.len() as u64;
    }
    state.commit_write(WIN, &token, offset, copy_into_place)?;
    let out = std::fs::read(&path).unwrap();
    assert_no_temp(&dir);
    Ok(out)
  }

  fn assert_no_temp(dir: &TempDir) {
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
      .unwrap()
      .filter_map(Result::ok)
      .map(|e| e.file_name().to_string_lossy().into_owned())
      .filter(|n| n.ends_with(".tmp"))
      .collect();
    assert!(leftovers.is_empty(), "leftovers: {leftovers:?}");
  }

  #[test]
  fn each_encoding_writes_what_encode_text_writes() {
    let cases: &[(&str, &str, bool)] = &[
      ("UTF-8", "héllo 世界 \u{1F600}", false),
      ("UTF-8", "héllo 世界", true),
      ("UTF-16LE", "héllo 世界 \u{1F600}", false),
      ("UTF-16LE", "x", true),
      ("UTF-16BE", "héllo 世界 \u{1F600}", false),
      ("Big5", "繁體中文的句子", false),
      ("GB18030", "这是一段中文 \u{20000}", false),
      ("GBK", "这是一段中文", false),
      ("Shift_JIS", "シフトジスの文章", true),
      ("EUC-JP", "日本語の文章", false),
      ("ISO-2022-JP", "abc日本語def語", false),
      ("EUC-KR", "한국어 문장", false),
      ("Windows-1252", "héllo", true),
      ("Windows-1251", "Привет", false),
      ("KOI8-R", "Привет", false),
      ("MacRoman", "Café crème", false),
      ("ISO-8859-15", "prix 20 €", false),
    ];
    for &(label, text, with_bom) in cases {
      let expected = encode_text(text, label, with_bom).unwrap();
      assert_eq!(
        write_pieces(label, with_bom, &[text]).unwrap(),
        expected,
        "{label}"
      );
      // The same text in two chunks, cut between characters.
      let cut = text
        .char_indices()
        .nth(text.chars().count() / 2)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
      let (a, b) = text.split_at(cut);
      assert_eq!(
        write_pieces(label, with_bom, &[a, b]).unwrap(),
        expected,
        "{label} split"
      );
    }
  }

  #[test]
  fn iso_2022_jp_state_survives_a_chunk_boundary() {
    // Split between two Japanese characters: the escape must not repeat.
    let text = "日本語";
    let expected = encode_text(text, "ISO-2022-JP", false).unwrap();
    assert_eq!(
      write_pieces("ISO-2022-JP", false, &["日", "本語"]).unwrap(),
      expected
    );
  }

  #[test]
  fn unmappable_character_errors_as_encode_text_does() {
    let expected = encode_text("héllo 測", "Windows-1252", false).unwrap_err();
    let got = write_pieces("Windows-1252", false, &["héllo 測"]).unwrap_err();
    assert_eq!(got, expected);
  }

  #[test]
  fn empty_content_writes_only_what_encode_text_writes() {
    assert_eq!(
      write_pieces("UTF-16LE", false, &[]).unwrap(),
      vec![0xFF, 0xFE]
    );
    assert_eq!(
      write_pieces("UTF-16BE", false, &[]).unwrap(),
      vec![0xFE, 0xFF]
    );
    assert_eq!(
      write_pieces("UTF-8", true, &[]).unwrap(),
      vec![0xEF, 0xBB, 0xBF]
    );
    assert_eq!(write_pieces("UTF-8", false, &[]).unwrap(), Vec::<u8>::new());
    assert_eq!(
      write_pieces("Shift_JIS", true, &[]).unwrap(),
      Vec::<u8>::new()
    );
  }

  #[test]
  fn two_sessions_to_one_target_interleave_and_land_whole() {
    let dir = tempdir().unwrap();
    let dest = dir.path().join("out.txt");
    let p = dest.to_string_lossy().into_owned();
    let state = DocIoState::new();
    let first = state.begin_write(WIN, &p, "UTF-8", false, SALT).unwrap();
    let second = state.begin_write(WIN, &p, "UTF-8", false, SALT).unwrap();
    send(&state, &first, 0, b"first-a").unwrap();
    send(&state, &second, 0, b"second-a").unwrap();
    send(&state, &first, 7, b"first-b").unwrap();
    send(&state, &second, 8, b"second-b").unwrap();
    state
      .commit_write(WIN, &first, 14, copy_into_place)
      .unwrap();
    state
      .commit_write(WIN, &second, 16, copy_into_place)
      .unwrap();
    let out = std::fs::read_to_string(&dest).unwrap();
    assert!(out == "first-afirst-b" || out == "second-asecond-b");
    assert_no_temp(&dir);
  }

  #[test]
  fn a_wrong_total_leaves_the_target_and_drops_the_staged_file() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "out.txt", b"old");
    let state = DocIoState::new();
    let token = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
    send(&state, &token, 0, b"new content").unwrap();
    assert!(state
      .commit_write(WIN, &token, 10, copy_into_place)
      .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"old");
    assert_no_temp(&dir);
  }

  #[test]
  fn a_second_commit_finds_nothing_and_touches_nothing() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "out.txt", b"old");
    let state = DocIoState::new();
    let token = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
    send(&state, &token, 0, b"new").unwrap();
    state.commit_write(WIN, &token, 3, copy_into_place).unwrap();
    assert!(state.commit_write(WIN, &token, 3, copy_into_place).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"new");
  }

  #[test]
  fn a_failed_chunk_ends_the_session_for_good() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "out.txt", b"old");
    let state = DocIoState::new();
    let token = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
    send(&state, &token, 0, b"good").unwrap();
    assert!(send(&state, &token, 99, b"bad offset").is_err());
    assert_no_temp(&dir);
    assert!(state.commit_write(WIN, &token, 4, copy_into_place).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"old");
  }

  #[test]
  fn malformed_chunks_are_refused_and_end_the_session() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "out.txt", b"old");
    let cases: &[(&str, InvokeBody)] = &[
      ("x", InvokeBody::Raw(b"data".to_vec())),
      ("+5", InvokeBody::Raw(b"data".to_vec())),
      ("", InvokeBody::Raw(b"data".to_vec())),
      ("99999999999999999999", InvokeBody::Raw(b"data".to_vec())),
      ("1, 2", InvokeBody::Raw(b"data".to_vec())),
      ("9", InvokeBody::Raw(b"data".to_vec())),
      ("0", InvokeBody::Raw(vec![b'a'; IO_CHUNK_BYTES + 1])),
      ("0", InvokeBody::Raw(vec![0xFF, 0xFE])),
      ("0", InvokeBody::Json(serde_json::json!({ "not": "raw" }))),
    ];
    for (offset, body) in cases {
      let state = DocIoState::new();
      let token = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
      let headers = headers_of(&token, offset);
      assert!(state.accept_chunk(WIN, &headers, body).is_err(), "{offset}");
      assert_no_temp(&dir);
      assert!(
        state.commit_write(WIN, &token, 0, copy_into_place).is_err(),
        "{offset}"
      );
      assert_eq!(std::fs::read(&path).unwrap(), b"old");
    }
  }

  #[test]
  fn a_missing_or_malformed_header_is_refused() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "out.txt", b"old");
    let state = DocIoState::new();
    let token = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
    let body = InvokeBody::Raw(b"data".to_vec());
    let mut no_offset = HeaderMap::new();
    no_offset.insert(IO_TOKEN_HEADER, HeaderValue::from_str(&token).unwrap());
    let mut no_token = HeaderMap::new();
    no_token.insert(IO_OFFSET_HEADER, HeaderValue::from_static("0"));
    let mut bad_bytes = HeaderMap::new();
    bad_bytes.insert(IO_TOKEN_HEADER, HeaderValue::from_str(&token).unwrap());
    bad_bytes.insert(
      IO_OFFSET_HEADER,
      HeaderValue::from_bytes(&[0x31, 0xFF]).unwrap(),
    );
    assert!(state.accept_chunk(WIN, &no_token, &body).is_err());
    assert!(state
      .accept_chunk(WIN, &headers_of("nope", "0"), &body)
      .is_err());
    assert!(state.accept_chunk(WIN, &no_offset, &body).is_err());
    let again = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
    let mut bad = bad_bytes.clone();
    bad.insert(IO_TOKEN_HEADER, HeaderValue::from_str(&again).unwrap());
    assert!(state.accept_chunk(WIN, &bad, &body).is_err());
  }

  #[test]
  fn hitting_the_per_window_limit_refuses_with_the_protocol_value() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "doc.txt", b"text");
    let state = DocIoState::new();
    for _ in 0..MAX_IO_SESSIONS_PER_WINDOW {
      state.begin_read(WIN, &path, None).unwrap();
    }
    assert_eq!(
      state.begin_read(WIN, &path, None).unwrap_err(),
      IO_SESSION_LIMIT
    );
    let mut tokens = Vec::new();
    for _ in 0..MAX_IO_SESSIONS_PER_WINDOW {
      tokens.push(state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap());
    }
    assert_eq!(
      state
        .begin_write(WIN, &path, "UTF-8", false, SALT)
        .unwrap_err(),
      IO_SESSION_LIMIT
    );
    // The limit is per window, and a finished session frees its place.
    assert!(state
      .begin_write(OTHER, &path, "UTF-8", false, SALT)
      .is_ok());
    state.abort_write(WIN, &tokens[0]).unwrap();
    assert!(state.begin_write(WIN, &path, "UTF-8", false, SALT).is_ok());
  }

  #[test]
  fn a_preexisting_candidate_name_is_never_overwritten_and_the_write_succeeds() {
    let dir = tempdir().unwrap();
    let dest = dir.path().join("out.txt");
    let p = dest.to_string_lossy().into_owned();
    let state = DocIoState::new();
    // The first token this table issues is 1.
    let taken = dir
      .path()
      .join(format!(".out.txt{}.tmp", io_temp_name(1, SALT, 0)));
    std::fs::write(&taken, b"kept copy").unwrap();
    let token = state.begin_write(WIN, &p, "UTF-8", false, SALT).unwrap();
    assert_eq!(token, "1");
    send(&state, &token, 0, b"new").unwrap();
    state.commit_write(WIN, &token, 3, copy_into_place).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    assert_eq!(std::fs::read(&taken).unwrap(), b"kept copy");
  }

  #[test]
  fn salt_changes_the_staged_name() {
    assert_ne!(io_temp_name(7, "aa", 0), io_temp_name(7, "bb", 0));
    assert_ne!(io_temp_name(7, "aa", 0), io_temp_name(7, "aa", 1));
    assert_ne!(io_temp_name(7, "aa", 0), io_temp_name(8, "aa", 0));
  }
  /// `begin_write` through `commit_write` for one chunk, with a production salt.
  fn chunked_save(path: &Path, text: &str) -> Result<(), String> {
    let state = DocIoState::new();
    let p = path.to_string_lossy().into_owned();
    let token = state.begin_write(WIN, &p, "UTF-16LE", true, &state.salt())?;
    send(&state, &token, 0, text.as_bytes())?;
    state.commit_write(WIN, &token, text.len() as u64, copy_into_place)
  }

  #[test]
  fn every_name_the_json_path_saves_also_saves_chunked() {
    let text = "long name 世界";
    for len in [227usize, 240, 250] {
      let name = format!("{}.txt", "a".repeat(len - 4));
      for old in [None, Some(b"old".as_slice())] {
        let (json_dir, chunked_dir) = (tempdir().unwrap(), tempdir().unwrap());
        let (json, chunked) = (json_dir.path().join(&name), chunked_dir.path().join(&name));
        if let Some(old) = old {
          std::fs::write(&json, old).unwrap();
          std::fs::write(&chunked, old).unwrap();
        }
        let by_json = write_file_encoded(
          json.to_string_lossy().into_owned(),
          text.to_string(),
          "UTF-16LE".to_string(),
          true,
        );
        assert_eq!(chunked_save(&chunked, text), by_json, "{len}");
        assert_eq!(
          std::fs::read(&chunked).unwrap(),
          std::fs::read(&json).unwrap(),
          "{len}"
        );
        assert_no_temp(&chunked_dir);
      }
    }
  }

  #[test]
  fn a_multibyte_name_is_cut_between_characters() {
    assert_ne!(STAGE_NAME_STEM_BYTES % 3, 0, "the cap must split a kanji");
    let dir = tempdir().unwrap();
    // 244 UTF-8 bytes.
    let name = format!("{}.txt", "漢".repeat(80));
    let path = dir.path().join(&name);
    let p = path.to_string_lossy().into_owned();
    let state = DocIoState::new();
    let salt = state.salt();
    let token = state.begin_write(WIN, &p, "UTF-8", false, &salt).unwrap();
    let stem = "漢".repeat(STAGE_NAME_STEM_BYTES / 3);
    let staged = format!(".{stem}{}.tmp", io_temp_name(1, &salt, 0));
    assert!(dir.path().join(&staged).exists(), "{staged}");
    send(&state, &token, 0, b"new").unwrap();
    state.commit_write(WIN, &token, 3, copy_into_place).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"new");
    assert_no_temp(&dir);
  }

  #[test]
  fn a_taken_candidate_for_a_capped_name_is_kept_and_the_write_succeeds() {
    let dir = tempdir().unwrap();
    let dest = dir.path().join("a".repeat(250));
    let p = dest.to_string_lossy().into_owned();
    let state = DocIoState::new();
    let stem = "a".repeat(STAGE_NAME_STEM_BYTES);
    let taken = dir
      .path()
      .join(format!(".{stem}{}.tmp", io_temp_name(1, SALT, 0)));
    std::fs::write(&taken, b"kept copy").unwrap();
    let token = state.begin_write(WIN, &p, "UTF-8", false, SALT).unwrap();
    send(&state, &token, 0, b"new").unwrap();
    state.commit_write(WIN, &token, 3, copy_into_place).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    assert_eq!(std::fs::read(&taken).unwrap(), b"kept copy");
  }

  #[test]
  fn the_longest_staged_name_fits_the_name_limit() {
    let suffix = io_temp_name(u64::MAX, &"f".repeat(16), u32::MAX);
    let longest = ".".len() + STAGE_NAME_STEM_BYTES + suffix.len() + ".tmp".len();
    assert!(longest < 255, "{longest}");
  }

  #[test]
  fn commit_waits_for_the_destination_lock() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "out.txt", b"old");
    let state = Arc::new(DocIoState::new());
    let token = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
    send(&state, &token, 0, b"new").unwrap();
    let lock = destination_lock(Path::new(&path));
    let held = lock.lock().unwrap();
    let (done, finished) = mpsc::channel();
    let worker = {
      let state = Arc::clone(&state);
      let token = token.clone();
      std::thread::spawn(move || {
        let result = state.commit_write(WIN, &token, 3, copy_into_place);
        done.send(result).unwrap();
      })
    };
    assert!(finished.recv_timeout(Duration::from_millis(300)).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"old");
    drop(held);
    finished
      .recv_timeout(Duration::from_secs(10))
      .unwrap()
      .unwrap();
    worker.join().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"new");
  }

  #[test]
  fn a_failed_pour_keeps_the_staged_file_against_abort_and_cleanup() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "out.txt", b"old");
    std::fs::hard_link(&path, dir.path().join("link.txt")).unwrap();
    let state = DocIoState::new();
    let token = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
    send(&state, &token, 0, b"new").unwrap();
    let staged = dir
      .path()
      .join(format!(".out.txt{}.tmp", io_temp_name(1, SALT, 0)));
    assert!(staged.exists());
    let failed = state.commit_write(WIN, &token, 3, |_, _| Err("disk full".to_string()));
    assert_eq!(failed.unwrap_err(), "disk full");
    assert!(staged.exists());
    assert!(state.abort_write(WIN, &token).is_err());
    state.take_window(WIN).release();
    assert!(staged.exists());
    assert_eq!(std::fs::read(&staged).unwrap(), b"new");
  }

  #[test]
  fn abort_and_window_release_drop_only_their_own_staged_files() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "out.txt", b"old");
    let state = DocIoState::new();
    let aborted = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
    send(&state, &aborted, 0, b"abc").unwrap();
    state.abort_write(WIN, &aborted).unwrap();
    assert_no_temp(&dir);
    let read = state.begin_read(WIN, &path, None).unwrap();
    let write = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
    send(&state, &write, 0, b"abc").unwrap();
    let held = state.take_window(WIN);
    assert!(!held.is_empty());
    held.release();
    assert_no_temp(&dir);
    assert!(state.read_chunk(WIN, &read.token, 0).is_err());
    assert!(state.commit_write(WIN, &write, 3, copy_into_place).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"old");
  }

  #[test]
  fn another_window_cannot_end_or_abort_a_session() {
    let dir = tempdir().unwrap();
    let path = write_file(&dir, "out.txt", b"old");
    let state = DocIoState::new();
    let begun = state.begin_read(WIN, &path, None).unwrap();
    assert!(state.end_read(OTHER, &begun.token).is_err());
    assert!(state.read_chunk(WIN, &begun.token, 0).is_ok());
    let token = state.begin_write(WIN, &path, "UTF-8", false, SALT).unwrap();
    assert!(state.abort_write(OTHER, &token).is_err());
    assert!(state
      .accept_chunk(
        OTHER,
        &headers_of(&token, "0"),
        &InvokeBody::Raw(b"x".to_vec())
      )
      .is_err());
    send(&state, &token, 0, b"x").unwrap();
    assert!(state
      .commit_write(OTHER, &token, 1, copy_into_place)
      .is_err());
    state.commit_write(WIN, &token, 1, copy_into_place).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"x");
  }

  #[test]
  fn replies_use_the_field_names_the_frontend_reads() {
    let begun = serde_json::to_value(ReadBegun {
      token: "1".into(),
      encoding: "UTF-8".into(),
      had_bom: true,
    })
    .unwrap();
    assert_eq!(begun["token"], "1");
    assert_eq!(begun["hadBom"], true);
    let ended = serde_json::to_value(ReadEnded {
      content_bytes: 2,
      lossy: false,
    })
    .unwrap();
    assert_eq!(ended["contentBytes"], 2);
    assert_eq!(ended["lossy"], false);
  }

  fn text_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
  }

  fn begin_at(state: &DocIoState, dest: &Path, encoding: &str) -> String {
    state
      .begin_write(WIN, &text_of(dest), encoding, false, SALT)
      .unwrap()
  }

  fn record_of(state: &DocIoState) -> HashMap<PathBuf, usize> {
    locked(&state.created.counts).clone()
  }

  fn assert_nothing_left(state: &DocIoState) {
    assert!(record_of(state).is_empty(), "{:?}", record_of(state));
    assert!(locked(&state.writes.entries).is_empty());
    assert!(locked(&state.reads.entries).is_empty());
  }
  /// A character Shift_JIS cannot represent, sent to a session to make it fail.
  fn fail_chunk(state: &DocIoState, token: &str, offset: u64) -> String {
    send(state, token, offset, "\u{1F600}".as_bytes()).unwrap_err()
  }
  /// `begin_write` with a hook that removes `folder` before the first staging.
  fn begin_losing_folder_once(state: &DocIoState, dest: &Path, folder: &Path) -> String {
    let calls = Cell::new(0);
    let before_stage = || {
      calls.set(calls.get() + 1);
      if calls.get() == 1 {
        std::fs::remove_dir(folder).unwrap();
      }
    };
    let token = state
      .begin_write_with(
        WIN,
        &text_of(dest),
        "Shift_JIS",
        false,
        SALT,
        &|_| true,
        &|| {},
        &before_stage,
      )
      .unwrap();
    assert_eq!(calls.get(), 2);
    token
  }

  #[test]
  fn a_chunk_that_cannot_be_encoded_removes_the_folders_it_made() {
    for second_chunk in [false, true] {
      let dir = tempdir().unwrap();
      let (outer, inner) = (dir.path().join("outer"), dir.path().join("outer/inner"));
      let dest = inner.join("out.txt");
      let state = DocIoState::new();
      let token = begin_at(&state, &dest, "Shift_JIS");
      let mut offset = 0;
      if second_chunk {
        send(&state, &token, 0, b"fine").unwrap();
        offset = 4;
      }
      fail_chunk(&state, &token, offset);
      assert!(!inner.exists(), "{second_chunk}");
      assert!(!outer.exists(), "{second_chunk}");
      assert_nothing_left(&state);
      assert_no_temp(&dir);
    }
  }

  #[test]
  fn abort_a_wrong_total_and_window_release_remove_the_folder_they_made() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let dest = folder.join("out.txt");
    let state = DocIoState::new();
    let token = begin_at(&state, &dest, "UTF-8");
    state.abort_write(WIN, &token).unwrap();
    assert!(!folder.exists());
    assert_nothing_left(&state);
    let token = begin_at(&state, &dest, "UTF-8");
    assert!(state.commit_write(WIN, &token, 9, copy_into_place).is_err());
    assert!(!folder.exists());
    assert_nothing_left(&state);
    begin_at(&state, &dest, "UTF-8");
    state.take_window(WIN).release();
    assert!(!folder.exists());
    assert_nothing_left(&state);
  }

  #[test]
  fn a_refused_staging_removes_the_folder_it_made() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let state = DocIoState::new();
    let attempts = Cell::new(0);
    let stages = Cell::new(0);
    let err = state
      .begin_write_with(
        WIN,
        &text_of(&folder.join("..")),
        "UTF-8",
        false,
        SALT,
        &|_| true,
        &|| attempts.set(attempts.get() + 1),
        &|| stages.set(stages.get() + 1),
      )
      .unwrap_err();
    assert_eq!(err, "path has no file name");
    assert!(!folder.exists());
    assert_nothing_left(&state);
    assert_eq!(attempts.get(), 1);
    assert_eq!(stages.get(), 1);
  }

  #[test]
  fn a_failed_replace_removes_the_folder_it_made() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let dest = folder.join("a".repeat(256));
    let state = DocIoState::new();
    let token = begin_at(&state, &dest, "UTF-8");
    send(&state, &token, 0, b"new").unwrap();
    assert!(state.commit_write(WIN, &token, 3, copy_into_place).is_err());
    assert!(!folder.exists());
    assert_nothing_left(&state);
  }
  // Which error a too-long name draws before its parent exists differs on Windows.
  #[cfg(unix)]
  #[test]
  fn a_failure_part_way_through_creating_removes_what_was_made() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let long = folder.join("a".repeat(256));
    let state = DocIoState::new();
    let attempts = Cell::new(0);
    let err = state
      .begin_write_with(
        WIN,
        &text_of(&long.join("out.txt")),
        "UTF-8",
        false,
        SALT,
        &|_| true,
        &|| attempts.set(attempts.get() + 1),
        &|| {},
      )
      .unwrap_err();
    assert!(!folder.exists());
    assert_nothing_left(&state);
    assert_eq!(attempts.get(), 1);
    let other = tempdir().unwrap();
    let expected = std::fs::create_dir_all(other.path().join("new").join("a".repeat(256)))
      .map_err(|e| read_error(&e))
      .unwrap_err();
    assert_eq!(err, expected);
  }

  #[test]
  fn folders_already_there_are_left_alone() {
    let dir = tempdir().unwrap();
    let existing = dir.path().join("existing");
    std::fs::create_dir(&existing).unwrap();
    std::fs::write(existing.join("mine.txt"), b"mine").unwrap();
    let state = DocIoState::new();
    let token = begin_at(&state, &existing.join("out.txt"), "Shift_JIS");
    fail_chunk(&state, &token, 0);
    assert_eq!(std::fs::read(existing.join("mine.txt")).unwrap(), b"mine");
    // Only the deepest level is new here.
    let deepest = existing.join("deepest");
    let token = begin_at(&state, &deepest.join("out.txt"), "Shift_JIS");
    fail_chunk(&state, &token, 0);
    assert!(!deepest.exists());
    assert!(existing.is_dir());
    assert_nothing_left(&state);
  }

  #[test]
  fn a_folder_holding_something_else_stays_with_its_contents() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let state = DocIoState::new();
    let token = begin_at(&state, &folder.join("out.txt"), "Shift_JIS");
    std::fs::write(folder.join("mine.txt"), b"mine").unwrap();
    let err = fail_chunk(&state, &token, 0);
    assert_eq!(
      err,
      encode_text("\u{1F600}", "Shift_JIS", false).unwrap_err()
    );
    assert_eq!(std::fs::read(folder.join("mine.txt")).unwrap(), b"mine");
    assert_nothing_left(&state);
  }

  #[test]
  fn a_landed_save_keeps_its_folder() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let dest = folder.join("out.txt");
    let state = DocIoState::new();
    let token = begin_at(&state, &dest, "UTF-8");
    send(&state, &token, 0, b"text").unwrap();
    state.commit_write(WIN, &token, 4, copy_into_place).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"text");
    assert_nothing_left(&state);
  }

  #[test]
  fn a_read_only_refusal_at_commit_settles_the_folder() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let dest = folder.join("out.txt");
    let state = DocIoState::new();
    let token = begin_at(&state, &dest, "UTF-8");
    std::fs::write(&dest, b"old").unwrap();
    let mut permissions = std::fs::metadata(&dest).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&dest, permissions).unwrap();
    assert_eq!(
      state
        .commit_write(WIN, &token, 0, copy_into_place)
        .unwrap_err(),
      READ_ONLY_DESTINATION
    );
    assert_eq!(std::fs::read(&dest).unwrap(), b"old");
    assert_nothing_left(&state);
  }

  #[cfg(unix)]
  #[test]
  fn a_level_named_through_dotdot_that_exists_is_not_removed() {
    let dir = tempdir().unwrap();
    let a = dir.path().join("a");
    let b = a.join("b");
    std::fs::create_dir_all(&b).unwrap();
    let dest = a.join("missing/../b/f.txt");
    let state = DocIoState::new();
    let token = begin_at(&state, &dest, "Shift_JIS");
    fail_chunk(&state, &token, 0);
    assert!(b.is_dir());
    assert!(!a.join("missing").exists());
    assert_nothing_left(&state);
  }

  #[test]
  fn sessions_sharing_a_new_folder_remove_it_only_when_the_last_fails() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let state = DocIoState::new();
    let first = begin_at(&state, &folder.join("a.txt"), "Shift_JIS");
    let second = begin_at(&state, &folder.join("b.txt"), "Shift_JIS");
    fail_chunk(&state, &first, 0);
    assert!(folder.is_dir());
    assert_eq!(record_of(&state).get(&folder), Some(&1));
    let staged = folder.join(format!(".b.txt{}.tmp", io_temp_name(2, SALT, 0)));
    assert!(staged.exists());
    send(&state, &second, 0, b"ok").unwrap();
    fail_chunk(&state, &second, 2);
    assert!(!folder.exists());
    assert_nothing_left(&state);
  }

  #[test]
  fn a_later_save_that_lands_keeps_the_folder_whichever_ends_first() {
    for creator_fails_first in [true, false] {
      let dir = tempdir().unwrap();
      let folder = dir.path().join("new");
      let state = DocIoState::new();
      let creator = begin_at(&state, &folder.join("a.txt"), "Shift_JIS");
      let later = begin_at(&state, &folder.join("b.txt"), "UTF-8");
      send(&state, &later, 0, b"text").unwrap();
      if creator_fails_first {
        fail_chunk(&state, &creator, 0);
      }
      state.commit_write(WIN, &later, 4, copy_into_place).unwrap();
      if !creator_fails_first {
        fail_chunk(&state, &creator, 0);
      }
      assert_eq!(std::fs::read(folder.join("b.txt")).unwrap(), b"text");
      assert_nothing_left(&state);
    }
  }
  // Depends on a too-long name failing after its parent was made; see above.
  #[cfg(unix)]
  #[test]
  fn a_failed_creation_does_not_spend_another_sessions_count() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let state = DocIoState::new();
    let holder = begin_at(&state, &folder.join("a.txt"), "Shift_JIS");
    let dest = folder.join("sub").join("a".repeat(256)).join("out.txt");
    assert!(state
      .begin_write(WIN, &text_of(&dest), "UTF-8", false, SALT)
      .is_err());
    assert!(!folder.join("sub").exists());
    assert_eq!(record_of(&state).get(&folder), Some(&1));
    fail_chunk(&state, &holder, 0);
    assert!(!folder.exists());
    assert_nothing_left(&state);
  }

  #[test]
  fn the_record_is_empty_once_every_session_has_ended() {
    let dir = tempdir().unwrap();
    let state = DocIoState::new();
    let landed_in = dir.path().join("landed");
    let failed_in = dir.path().join("failed");
    let landed = begin_at(&state, &landed_in.join("out.txt"), "UTF-8");
    let failed = begin_at(&state, &failed_in.join("out.txt"), "Shift_JIS");
    assert_eq!(record_of(&state).len(), 2);
    send(&state, &landed, 0, b"text").unwrap();
    state
      .commit_write(WIN, &landed, 4, copy_into_place)
      .unwrap();
    fail_chunk(&state, &failed, 0);
    assert!(landed_in.is_dir());
    assert!(!failed_in.exists());
    assert_nothing_left(&state);
  }

  #[test]
  fn acquiring_an_entry_again_adds_to_it() {
    let created = CreatedDirs::default();
    let dir = PathBuf::from("outer/inner");
    let made = vec![dir.clone()];
    assert_eq!(created.acquire(&made, &dir), made);
    assert_eq!(created.acquire(&made, &dir), made);
    assert_eq!(locked(&created.counts).get(&dir), Some(&2));
    assert!(created.finish_failed(&made).is_empty());
    assert_eq!(created.finish_failed(&made), made);
    assert!(locked(&created.counts).is_empty());
  }

  #[test]
  fn acquire_also_holds_recorded_ancestors_deepest_first() {
    let created = CreatedDirs::default();
    let outer = PathBuf::from("outer");
    let inner = outer.join("inner");
    created.acquire(std::slice::from_ref(&outer), &outer);
    assert_eq!(
      created.acquire(std::slice::from_ref(&inner), &inner),
      vec![inner.clone(), outer.clone()]
    );
    assert_eq!(locked(&created.counts).get(&outer), Some(&2));
  }

  #[test]
  fn begin_write_recreates_a_folder_that_vanishes_before_staging() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let dest = folder.join("out.txt");
    let state = DocIoState::new();
    let token = begin_losing_folder_once(&state, &dest, &folder);
    assert!(folder.is_dir());
    send(&state, &token, 0, b"text").unwrap();
    state.commit_write(WIN, &token, 4, copy_into_place).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"text");
    assert_nothing_left(&state);
  }

  #[test]
  fn a_session_begun_after_losing_its_folder_still_removes_it_on_failure() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let state = DocIoState::new();
    let token = begin_losing_folder_once(&state, &folder.join("out.txt"), &folder);
    fail_chunk(&state, &token, 0);
    assert!(!folder.exists());
    assert_nothing_left(&state);
  }

  #[test]
  fn begin_write_gives_up_after_the_retries_with_the_last_error() {
    assert_eq!(FOLDER_VANISHED_RETRIES, 3);
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let dest = folder.join("out.txt");
    let state = DocIoState::new();
    let attempts = Cell::new(0);
    let stages = Cell::new(0);
    let before_stage = || {
      stages.set(stages.get() + 1);
      std::fs::remove_dir(&folder).unwrap();
    };
    let err = state
      .begin_write_with(
        WIN,
        &text_of(&dest),
        "UTF-8",
        false,
        SALT,
        &|_| true,
        &|| attempts.set(attempts.get() + 1),
        &before_stage,
      )
      .unwrap_err();
    assert_eq!(attempts.get(), FOLDER_VANISHED_RETRIES + 1);
    assert_eq!(stages.get(), FOLDER_VANISHED_RETRIES + 1);
    let expected = File::create(&dest).unwrap_err().to_string();
    assert_eq!(err, expected);
    assert!(!folder.exists());
    assert_nothing_left(&state);
  }

  #[test]
  fn begin_write_does_not_retry_while_the_folder_is_there() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("existing");
    std::fs::create_dir(&folder).unwrap();
    let state = DocIoState::new();
    let stages = Cell::new(0);
    let err = state
      .begin_write_with(
        WIN,
        &text_of(&folder.join("..")),
        "UTF-8",
        false,
        SALT,
        &|_| true,
        &|| {},
        &|| stages.set(stages.get() + 1),
      )
      .unwrap_err();
    assert_eq!(err, "path has no file name");
    assert_eq!(stages.get(), 1);
    assert!(folder.is_dir());
    assert_nothing_left(&state);
  }

  #[test]
  fn begin_write_does_not_retry_when_its_folder_is_the_empty_path() {
    let state = DocIoState::new();
    let attempts = Cell::new(0);
    let stages = Cell::new(0);
    let err = state
      .begin_write_with(
        WIN,
        "..",
        "UTF-8",
        false,
        SALT,
        &|_| true,
        &|| attempts.set(attempts.get() + 1),
        &|| stages.set(stages.get() + 1),
      )
      .unwrap_err();
    assert_eq!(err, "path has no file name");
    assert_eq!(attempts.get(), 1);
    assert_eq!(stages.get(), 1);
    assert_nothing_left(&state);
  }

  fn closed(_: &str) -> bool {
    false
  }

  fn begin_write_in(
    state: &DocIoState,
    label: &str,
    dest: &Path,
    window_alive: &dyn Fn(&str) -> bool,
  ) -> Result<String, String> {
    state.begin_write_with(
      label,
      &text_of(dest),
      "UTF-8",
      false,
      SALT,
      window_alive,
      &|| {},
      &|| {},
    )
  }

  #[test]
  fn a_destroyed_window_starts_no_sessions() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let source = write_file(&dir, "in.txt", b"text");
    let state = DocIoState::new();
    let err = begin_write_in(&state, WIN, &folder.join("out.txt"), &closed).unwrap_err();
    assert_eq!(err, WINDOW_CLOSED);
    assert!(!folder.exists());
    let err = state
      .begin_read_with(WIN, &source, None, &closed)
      .unwrap_err();
    assert_eq!(err, WINDOW_CLOSED);
    assert_nothing_left(&state);
    assert_no_temp(&dir);
  }

  #[test]
  fn a_living_window_starts_sessions_as_usual() {
    let dir = tempdir().unwrap();
    let dest = dir.path().join("out.txt");
    let source = write_file(&dir, "in.txt", b"text");
    let state = DocIoState::new();
    let token = begin_write_in(&state, WIN, &dest, &|_| true).unwrap();
    send(&state, &token, 0, b"text").unwrap();
    state.commit_write(WIN, &token, 4, copy_into_place).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"text");
    let begun = state
      .begin_read_with(WIN, &source, None, &|_| true)
      .unwrap();
    assert_eq!(state.read_chunk(WIN, &begun.token, 0).unwrap(), b"text");
  }

  #[test]
  fn cleanup_arriving_during_the_window_check_leaves_nothing() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("new");
    let source = write_file(&dir, "in.txt", b"text");
    let state = DocIoState::new();
    let window_alive = |label: &str| {
      state.take_window(label).release();
      false
    };
    let err = begin_write_in(&state, WIN, &folder.join("out.txt"), &window_alive).unwrap_err();
    assert_eq!(err, WINDOW_CLOSED);
    assert!(!folder.exists());
    let err = state
      .begin_read_with(WIN, &source, None, &window_alive)
      .unwrap_err();
    assert_eq!(err, WINDOW_CLOSED);
    assert_nothing_left(&state);
    assert_no_temp(&dir);
  }

  #[test]
  fn a_reopened_window_of_the_same_label_works() {
    let dir = tempdir().unwrap();
    let dest = dir.path().join("out.txt");
    let source = write_file(&dir, "in.txt", b"text");
    let state = DocIoState::new();
    state.take_window(WIN).release();
    assert!(begin_write_in(&state, WIN, &dest, &|_| true).is_ok());
    assert!(state.begin_read_with(WIN, &source, None, &|_| true).is_ok());
  }

  #[test]
  fn only_the_destroyed_window_is_refused() {
    let dir = tempdir().unwrap();
    let dest = dir.path().join("out.txt");
    let source = write_file(&dir, "in.txt", b"text");
    let state = DocIoState::new();
    let window_alive = |label: &str| label != WIN;
    assert!(begin_write_in(&state, WIN, &dest, &window_alive).is_err());
    assert!(state
      .begin_read_with(WIN, &source, None, &window_alive)
      .is_err());
    assert!(begin_write_in(&state, OTHER, &dest, &window_alive).is_ok());
    assert!(state
      .begin_read_with(OTHER, &source, None, &window_alive)
      .is_ok());
  }

  #[test]
  fn the_begin_commands_ask_the_window_manager() {
    let source = include_str!("encoding.rs");
    for command in ["pub fn write_begin(", "pub fn read_begin("] {
      let body = source
        .split(command)
        .nth(1)
        .and_then(|rest| rest.split("#[tauri::command").next())
        .unwrap();
      assert!(
        body.contains("webview.get_webview_window(label).is_some()"),
        "{command}"
      );
    }
  }
}
