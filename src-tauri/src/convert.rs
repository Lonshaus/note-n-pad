// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Conversion files: a document too big to stay a page-held document is poured
//! into a UTF-8 file of its own in the temp folder, a block at a time, and a
//! windowed session is opened over it. Also the streaming encoders a converted
//! session saves through, so the file keeps the encoding the document had.
//!
//! The store is the file's owner until a session takes it (`take`): a file nobody
//! took is deleted when it is aborted or the store goes. A conversion also has a
//! window that owns it; the file goes when that window is destroyed (`abort_window`).
//! A conversion in a handoff has no window: the handoff decides its fate.

use crate::clipboard_store::{read_at, PinReader};
use crate::range_edit::{Fingerprint, FINGERPRINT_MISMATCH};
use crate::windowed::{clip_read_error, fingerprint_of, no_folder, NOT_UTF8, SCAN_BUF, SCAN_CHUNK};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};
/// File-name prefix and suffix of a conversion file; the startup cleanup removes
/// them.
pub const FILE_PREFIX: &str = "cv-";
pub const FILE_SUFFIX: &str = ".txt";
/// A text that has a character the encoding cannot write.
pub const UNMAPPABLE: &str = "unmappable";
/// A conversion that is not finished (or no longer there) cannot be used.
const UNKNOWN_CONVERT: &str = "unknown-convert";
const UNFINISHED: &str = "unfinished-convert";
/// The window that was to own a conversion was destroyed meanwhile.
const WINDOW_GONE: &str = "window-gone";
/// The clip has no such line.
const LINE_OUT_OF_RANGE: &str = "line-out-of-range";

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);
/// `cv-<id>.txt` in `dir`, for a fresh id of this run's pid, number and time.
fn new_name(dir: &Path) -> (String, PathBuf) {
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  let seq = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
  let id = format!("{}-{seq}-{nanos}", std::process::id());
  let path = dir.join(format!("{FILE_PREFIX}{id}{FILE_SUFFIX}"));
  (id, path)
}
/// A conversion file that goes with its owner: deleted when dropped.
#[derive(Debug)]
pub struct TmpFile {
  path: PathBuf,
}

impl TmpFile {
  pub fn path(&self) -> &Path {
    &self.path
  }
  /// A new empty file in `dir`, open for writing.
  pub fn create(dir: &Path) -> io::Result<(File, TmpFile)> {
    fs::create_dir_all(dir)?;
    let (_, path) = new_name(dir);
    let file = OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&path)?;
    Ok((file, TmpFile { path }))
  }
}

impl Drop for TmpFile {
  fn drop(&mut self) {
    let _ = fs::remove_file(&self.path);
  }
}
// --- line breaks ---------------------------------------------------------------
/// Writes every line break of `bytes` (`\r\n`, a lone `\r`, `\n`) as `sep` into
/// `out`. `after_cr` carries a `\r` that ended the last piece, so the `\n` that
/// opens the next one does not make a second break.
fn normalize(bytes: &[u8], sep: &[u8], after_cr: &mut bool, out: &mut Vec<u8>) {
  let mut i = 0;
  while i < bytes.len() {
    if *after_cr {
      *after_cr = false;
      if bytes[i] == b'\n' {
        i += 1;
        continue;
      }
    }
    let n = bytes[i..]
      .iter()
      .position(|&b| b == b'\r' || b == b'\n')
      .unwrap_or(bytes.len() - i);
    out.extend_from_slice(&bytes[i..i + n]);
    i += n;
    if i < bytes.len() {
      out.extend_from_slice(sep);
      *after_cr = bytes[i] == b'\r';
      i += 1;
    }
  }
}
/// Line `line` (0-based) of a text read with `read_at`, without its break, handed to
/// `emit` `chunk` bytes at a time. Breaks are `\r\n`, a lone `\r` and `\n`, as
/// everywhere; a text of n breaks has n + 1 lines. Nothing is emitted for a line
/// the text does not have.
fn clip_line(
  read_at: &dyn Fn(&mut [u8], u64) -> io::Result<usize>,
  line: u64,
  chunk: usize,
  emit: &mut dyn FnMut(&[u8]) -> Result<(), String>,
) -> Result<(), String> {
  let mut block = vec![0u8; chunk.max(1)];
  let (mut at, mut current, mut after_cr) = (0u64, 0u64, false);
  loop {
    let n = match read_at(&mut block, at) {
      Ok(0) => break,
      Ok(n) => n,
      Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
      Err(e) => return Err(clip_read_error(&e)),
    };
    at += n as u64;
    let mut i = 0;
    while i < n {
      if after_cr {
        after_cr = false;
        if block[i] == b'\n' {
          i += 1;
          continue;
        }
      }
      let end = block[i..n]
        .iter()
        .position(|&b| b == b'\r' || b == b'\n')
        .map_or(n, |p| i + p);
      if current == line {
        if end > i {
          emit(&block[i..end])?;
        }
        if end < n {
          return Ok(());
        }
      }
      i = end;
      if i < n {
        current += 1;
        after_cr = block[i] == b'\r';
        i += 1;
      }
    }
  }
  if current == line {
    Ok(())
  } else {
    Err(LINE_OUT_OF_RANGE.to_string())
  }
}
// --- encoders ------------------------------------------------------------------
/// Whether the encoding writes the text as it is: UTF-8 without a byte order mark.
pub fn is_plain_utf8(label: &str, with_bom: bool) -> bool {
  !with_bom && label.eq_ignore_ascii_case("UTF-8")
}

enum Kind {
  Utf8,
  Utf16 { big: bool },
  Legacy(encoding_rs::Encoder),
}
/// Turns UTF-8 text, cut anywhere, into the bytes of an encoding. A character cut
/// by the end of a piece waits for the next. A character the encoding cannot
/// write is `UNMAPPABLE`; nothing is ever replaced.
pub struct Encoder {
  kind: Kind,
  /// The byte order mark still to be written in front of the first byte.
  head: Option<&'static [u8]>,
  carry: [u8; 4],
  carry_len: usize,
}

impl Encoder {
  /// UTF-8 has a BOM when `with_bom`; the UTF-16s always do (as `encode_text`);
  /// `with_bom` means nothing to the rest.
  pub fn new(label: &str, with_bom: bool) -> Result<Self, String> {
    let enc = crate::encoding::label_to_encoding(label)
      .ok_or_else(|| format!("unsupported encoding: {label}"))?;
    let (kind, head): (Kind, Option<&'static [u8]>) = if std::ptr::eq(enc, encoding_rs::UTF_8) {
      (Kind::Utf8, with_bom.then_some(&[0xEF, 0xBB, 0xBF][..]))
    } else if std::ptr::eq(enc, encoding_rs::UTF_16LE) {
      (Kind::Utf16 { big: false }, Some(&[0xFF, 0xFE][..]))
    } else if std::ptr::eq(enc, encoding_rs::UTF_16BE) {
      (Kind::Utf16 { big: true }, Some(&[0xFE, 0xFF][..]))
    } else {
      (Kind::Legacy(enc.new_encoder()), None)
    };
    Ok(Encoder {
      kind,
      head,
      carry: [0; 4],
      carry_len: 0,
    })
  }
  /// Whether some text cannot be written (only the legacy encodings), so a save
  /// is worth a pass of its own to find out before it writes.
  pub fn can_fail(&self) -> bool {
    matches!(self.kind, Kind::Legacy(_))
  }
  /// Appends the encoding of the next piece of UTF-8 to `out`.
  pub fn push(&mut self, bytes: &[u8], out: &mut Vec<u8>) -> Result<(), String> {
    if let Some(head) = self.head.take() {
      out.extend_from_slice(head);
    }
    let mut rest = bytes;
    while self.carry_len > 0 && !rest.is_empty() {
      self.carry[self.carry_len] = rest[0];
      self.carry_len += 1;
      rest = &rest[1..];
      let (carried, len) = (self.carry, self.carry_len);
      match std::str::from_utf8(&carried[..len]) {
        Ok(text) => {
          self.carry_len = 0;
          self.encode(text, out, false)?;
        }
        Err(e) if e.error_len().is_none() => {}
        Err(_) => return Err(NOT_UTF8.to_string()),
      }
    }
    if rest.is_empty() {
      return Ok(());
    }
    match std::str::from_utf8(rest) {
      Ok(text) => self.encode(text, out, false),
      Err(e) if e.error_len().is_none() => {
        let whole = e.valid_up_to();
        let text = std::str::from_utf8(&rest[..whole]).map_err(|_| NOT_UTF8.to_string())?;
        self.encode(text, out, false)?;
        let tail = &rest[whole..];
        self.carry[..tail.len()].copy_from_slice(tail);
        self.carry_len = tail.len();
        Ok(())
      }
      Err(_) => Err(NOT_UTF8.to_string()),
    }
  }
  /// The text is over.
  pub fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), String> {
    if self.carry_len > 0 {
      return Err(NOT_UTF8.to_string());
    }
    if let Some(head) = self.head.take() {
      out.extend_from_slice(head);
    }
    self.encode("", out, true)
  }
  fn encode(&mut self, text: &str, out: &mut Vec<u8>, last: bool) -> Result<(), String> {
    match &mut self.kind {
      Kind::Utf8 => out.extend_from_slice(text.as_bytes()),
      Kind::Utf16 { big } => {
        for unit in text.encode_utf16() {
          let bytes = if *big {
            unit.to_be_bytes()
          } else {
            unit.to_le_bytes()
          };
          out.extend_from_slice(&bytes);
        }
      }
      Kind::Legacy(encoder) => {
        let mut buf = [0u8; 4096];
        let mut src = text;
        loop {
          let (result, read, written) =
            encoder.encode_from_utf8_without_replacement(src, &mut buf, last);
          out.extend_from_slice(&buf[..written]);
          src = &src[read..];
          match result {
            encoding_rs::EncoderResult::InputEmpty => break,
            encoding_rs::EncoderResult::OutputFull => {}
            encoding_rs::EncoderResult::Unmappable(_) => return Err(UNMAPPABLE.to_string()),
          }
        }
      }
    }
    Ok(())
  }
}
/// A writer that takes UTF-8 and writes an encoding of it to `inner`, a piece at
/// a time. An error is the text of the failure, `UNMAPPABLE` included.
pub struct EncodeWriter<W: Write> {
  inner: W,
  encoder: Encoder,
  out: Vec<u8>,
}

impl<W: Write> EncodeWriter<W> {
  pub fn new(inner: W, encoder: Encoder) -> Self {
    EncodeWriter {
      inner,
      encoder,
      out: Vec::new(),
    }
  }
  /// Ends the text and hands the writer back.
  pub fn finish(mut self) -> Result<W, String> {
    self.out.clear();
    self.encoder.finish(&mut self.out)?;
    self.inner.write_all(&self.out).map_err(|e| e.to_string())?;
    Ok(self.inner)
  }
}

impl<W: Write> Write for EncodeWriter<W> {
  fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
    self.out.clear();
    self
      .encoder
      .push(buf, &mut self.out)
      .map_err(io::Error::other)?;
    self.inner.write_all(&self.out)?;
    Ok(buf.len())
  }
  fn flush(&mut self) -> io::Result<()> {
    self.inner.flush()
  }
}
/// Reads `src` to its end in `buf` sized pieces into `dst`.
fn pump(src: &mut dyn Read, dst: &mut dyn Write, buf: usize) -> Result<(), String> {
  let mut block = vec![0u8; buf.max(1)];
  loop {
    match src.read(&mut block) {
      Ok(0) => return Ok(()),
      Ok(n) => dst.write_all(&block[..n]).map_err(|e| e.to_string())?,
      Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
      Err(e) => return Err(e.to_string()),
    }
  }
}
/// Checks that all of `source` can be written in the encoding, writing nothing.
/// `source` pours the document into the writer it is given.
pub fn precheck(
  label: &str,
  with_bom: bool,
  source: impl FnOnce(&mut dyn Write) -> Result<(), String>,
) -> Result<(), String> {
  let encoder = Encoder::new(label, with_bom)?;
  if !encoder.can_fail() {
    return Ok(());
  }
  let mut writer = EncodeWriter::new(io::sink(), encoder);
  source(&mut writer)?;
  writer.finish().map(|_| ())
}
/// Reads the UTF-8 file `src` through the encoding into the open file `out`.
fn encode_file(
  src: &Path,
  label: &str,
  with_bom: bool,
  out: &mut File,
  buf: usize,
) -> Result<(), String> {
  let mut file = File::open(src).map_err(|e| e.to_string())?;
  let mut writer = EncodeWriter::new(&mut *out, Encoder::new(label, with_bom)?);
  pump(&mut file, &mut writer, buf)?;
  writer.finish()?;
  out.sync_all().map_err(|e| e.to_string())
}
/// Decodes `src` in `label` to UTF-8 into `dst`, a block at a time. A byte order
/// mark that belongs to the encoding is dropped when `with_bom` (the UTF-16s
/// always have one).
fn decode_stream(
  src: &mut dyn Read,
  dst: &mut dyn Write,
  label: &str,
  with_bom: bool,
  buf: usize,
) -> Result<(), String> {
  let enc = crate::encoding::label_to_encoding(label)
    .ok_or_else(|| format!("unsupported encoding: {label}"))?;
  let bom: &[u8] = if std::ptr::eq(enc, encoding_rs::UTF_8) && with_bom {
    &[0xEF, 0xBB, 0xBF]
  } else if std::ptr::eq(enc, encoding_rs::UTF_16LE) {
    &[0xFF, 0xFE]
  } else if std::ptr::eq(enc, encoding_rs::UTF_16BE) {
    &[0xFE, 0xFF]
  } else {
    &[]
  };
  let mut decoder = enc.new_decoder_without_bom_handling();
  let mut input = vec![0u8; buf.max(4)];
  let mut output = vec![0u8; 64 * 1024];
  let mut first = true;
  loop {
    // The first piece is read whole so a mark cannot be cut by it.
    let mut len = 0;
    while len < input.len() {
      match src.read(&mut input[len..]) {
        Ok(0) => break,
        Ok(n) => len += n,
        Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
        Err(e) => return Err(e.to_string()),
      }
      if !first {
        break;
      }
    }
    let mut piece = &input[..len];
    if first {
      first = false;
      piece = piece.strip_prefix(bom).unwrap_or(piece);
    }
    let last = len == 0;
    loop {
      let (result, read, written, _) = decoder.decode_to_utf8(piece, &mut output, last);
      dst
        .write_all(&output[..written])
        .map_err(|e| e.to_string())?;
      piece = &piece[read..];
      if result == encoding_rs::CoderResult::InputEmpty {
        break;
      }
    }
    if last {
      return Ok(());
    }
  }
}
// --- the store -----------------------------------------------------------------
/// A conversion file being written, or finished and waiting for a session.
struct Entry {
  path: PathBuf,
  file: Option<File>,
  /// The line break the text is written with; none for a file written as it is.
  sep: Option<&'static str>,
  after_cr: bool,
  /// Set when the file is finished.
  bytes: Option<u64>,
  /// A session took the file: it is no longer ours to delete.
  taken: bool,
}

impl Drop for Entry {
  fn drop(&mut self) {
    self.file = None;
    if !self.taken {
      let _ = fs::remove_file(&self.path);
    }
  }
}
/// What a finished conversion holds.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Finished {
  pub bytes: u64,
  /// Small enough for a windowed session to edit.
  pub editable: bool,
}
/// A conversion and the window label that owns it, if any.
struct Slot {
  owner: Option<String>,
  entry: Arc<Mutex<Entry>>,
}
/// The conversion files of the app, by id.
pub struct ConvertStore {
  dir: Option<PathBuf>,
  /// The size from which a file is not editable.
  max: u64,
  entries: Mutex<HashMap<String, Slot>>,
}
/// The value of `NOTENPAD_LARGE_EDIT_MAX`: a whole number of bytes.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn parse_max(value: Option<&str>) -> Option<u64> {
  value.and_then(|v| v.trim().parse().ok())
}
/// Debug builds: the size `NOTENPAD_LARGE_EDIT_MAX` sets, so a test can reach the
/// limit with a small file. Release builds never read it.
fn max_from_env() -> Option<u64> {
  #[cfg(debug_assertions)]
  {
    parse_max(std::env::var("NOTENPAD_LARGE_EDIT_MAX").ok().as_deref())
  }
  #[cfg(not(debug_assertions))]
  {
    None
  }
}

impl ConvertStore {
  /// A store whose files go in `dir`.
  pub fn new(dir: Option<PathBuf>) -> Self {
    Self::with_max(
      dir,
      max_from_env().unwrap_or(crate::windowed::LARGE_EDIT_MAX),
    )
  }
  fn with_max(dir: Option<PathBuf>, max: u64) -> Self {
    ConvertStore {
      dir,
      max,
      entries: Mutex::new(HashMap::new()),
    }
  }
  fn entry(&self, id: &str) -> Result<Arc<Mutex<Entry>>, String> {
    self
      .entries
      .lock()
      .unwrap()
      .get(id)
      .map(|slot| slot.entry.clone())
      .ok_or_else(|| UNKNOWN_CONVERT.to_string())
  }
  /// Starts a file whose line breaks are all `sep`, owned by the window `owner`.
  pub fn begin(&self, owner: Option<&str>, sep: &str) -> Result<String, String> {
    let sep = match sep {
      "\n" => "\n",
      "\r\n" => "\r\n",
      _ => return Err("invalid line break".to_string()),
    };
    self.begin_as(owner, Some(sep))
  }
  fn begin_as(&self, owner: Option<&str>, sep: Option<&'static str>) -> Result<String, String> {
    let dir = self.dir.as_ref().ok_or_else(no_folder)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (id, path) = new_name(dir);
    let file = OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&path)
      .map_err(|e| e.to_string())?;
    let entry = Entry {
      path,
      file: Some(file),
      sep,
      after_cr: false,
      bytes: None,
      taken: false,
    };
    self.entries.lock().unwrap().insert(
      id.clone(),
      Slot {
        owner: owner.map(str::to_string),
        entry: Arc::new(Mutex::new(entry)),
      },
    );
    Ok(id)
  }
  /// Adds `text`, `block` bytes at a time.
  fn append_with(&self, id: &str, text: &str, block: usize) -> Result<(), String> {
    let entry = self.entry(id)?;
    let mut guard = entry.lock().unwrap();
    let entry = &mut *guard;
    let (Some(file), Some(sep)) = (entry.file.as_mut(), entry.sep) else {
      return Err(UNFINISHED.to_string());
    };
    let mut out = Vec::new();
    for piece in text.as_bytes().chunks(block.max(1)) {
      out.clear();
      normalize(piece, sep.as_bytes(), &mut entry.after_cr, &mut out);
      file.write_all(&out).map_err(|e| e.to_string())?;
    }
    Ok(())
  }
  /// Adds the next piece of text of the frontend.
  pub fn append(&self, id: &str, text: &str) -> Result<(), String> {
    self.append_with(id, text, SCAN_CHUNK)
  }
  /// Adds all of `source`, `chunk` bytes at a time.
  fn append_from(&self, id: &str, source: &mut dyn Read, chunk: usize) -> Result<(), String> {
    let entry = self.entry(id)?;
    let mut guard = entry.lock().unwrap();
    let entry = &mut *guard;
    let (Some(file), Some(sep)) = (entry.file.as_mut(), entry.sep) else {
      return Err(UNFINISHED.to_string());
    };
    let mut block = vec![0u8; chunk.max(1)];
    let mut out = Vec::new();
    loop {
      match source.read(&mut block) {
        Ok(0) => return Ok(()),
        Ok(n) => {
          out.clear();
          normalize(&block[..n], sep.as_bytes(), &mut entry.after_cr, &mut out);
          file.write_all(&out).map_err(|e| e.to_string())?;
        }
        Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
        Err(e) => return Err(clip_read_error(&e)),
      }
    }
  }
  /// Adds the clip `open` finds; nothing is written when there is none.
  fn append_clip_with(
    &self,
    id: &str,
    open: &dyn Fn() -> Result<Arc<File>, String>,
    chunk: usize,
  ) -> Result<(), String> {
    self.entry(id)?;
    let mut clip = PinReader::new(open()?);
    self.append_from(id, &mut clip, chunk)
  }
  /// Adds line `line` of the text `read_at` reads, no break, `chunk` bytes at a time.
  fn append_line_from(
    &self,
    id: &str,
    read_at: &dyn Fn(&mut [u8], u64) -> io::Result<usize>,
    line: u64,
    chunk: usize,
  ) -> Result<(), String> {
    let entry = self.entry(id)?;
    let mut guard = entry.lock().unwrap();
    let entry = &mut *guard;
    let (Some(file), Some(sep)) = (entry.file.as_mut(), entry.sep) else {
      return Err(UNFINISHED.to_string());
    };
    let mut out = Vec::new();
    clip_line(read_at, line, chunk, &mut |piece| {
      out.clear();
      normalize(piece, sep.as_bytes(), &mut entry.after_cr, &mut out);
      file.write_all(&out).map_err(|e| e.to_string())
    })
  }
  /// Adds line `line` of the clip `open` finds.
  fn append_clip_line_with(
    &self,
    id: &str,
    open: &dyn Fn() -> Result<Arc<File>, String>,
    line: u64,
    chunk: usize,
  ) -> Result<(), String> {
    self.entry(id)?;
    let clip = open()?;
    self.append_line_from(id, &|buf, at| read_at(&clip, buf, at), line, chunk)
  }
  /// Closes the file, safely on disk.
  pub fn finish(&self, id: &str) -> Result<Finished, String> {
    let entry = self.entry(id)?;
    let mut guard = entry.lock().unwrap();
    if let Some(file) = guard.file.take() {
      file.sync_all().map_err(|e| e.to_string())?;
    }
    let bytes = fs::metadata(&guard.path).map_err(|e| e.to_string())?.len();
    guard.bytes = Some(bytes);
    Ok(Finished {
      bytes,
      editable: bytes < self.max,
    })
  }
  /// Gives the conversion up: its file goes.
  pub fn abort(&self, id: &str) {
    self.entries.lock().unwrap().remove(id);
  }
  /// The window `label` is gone: every conversion it owns is given up. Calls on
  /// them fail from here on.
  pub fn abort_window(&self, label: &str) {
    let gone: Vec<Slot> = {
      let mut entries = self.entries.lock().unwrap();
      let ids: Vec<String> = entries
        .iter()
        .filter(|(_, slot)| slot.owner.as_deref() == Some(label))
        .map(|(id, _)| id.clone())
        .collect();
      ids.iter().filter_map(|id| entries.remove(id)).collect()
    };
    drop(gone);
  }
  /// Sets the window that owns the conversion `id`; none leaves it to whoever else
  /// has it (a handoff).
  pub fn set_owner(&self, id: &str, owner: Option<&str>) -> Result<(), String> {
    self
      .entries
      .lock()
      .unwrap()
      .get_mut(id)
      .map(|slot| slot.owner = owner.map(str::to_string))
      .ok_or_else(|| UNKNOWN_CONVERT.to_string())
  }
  /// Hands the finished file to a session. It is deleted with the guard.
  pub fn take(&self, id: &str) -> Result<TmpFile, String> {
    let entry = self.entry(id)?;
    let mut guard = entry.lock().unwrap();
    if guard.bytes.is_none() {
      return Err(UNFINISHED.to_string());
    }
    guard.taken = true;
    let path = guard.path.clone();
    drop(guard);
    self.entries.lock().unwrap().remove(id);
    Ok(TmpFile { path })
  }
  /// `f` on the path of a finished file, which stays where it is.
  fn with_finished<R>(
    &self,
    id: &str,
    f: impl FnOnce(&Path) -> Result<R, String>,
  ) -> Result<R, String> {
    let entry = self.entry(id)?;
    let guard = entry.lock().unwrap();
    if guard.bytes.is_none() {
      return Err(UNFINISHED.to_string());
    }
    f(&guard.path)
  }
  /// Writes the finished file to `target` in an encoding, replacing it. With
  /// `expected` the target must still look as it did. Nothing is written when some
  /// text cannot be. The file is deleted once it is saved.
  fn save_with(
    &self,
    id: &str,
    target: &Path,
    label: &str,
    with_bom: bool,
    expected: Option<Fingerprint>,
    buf: usize,
  ) -> Result<Fingerprint, String> {
    let saved = self.with_finished(id, |src| {
      if let Some(expected) = expected {
        let same = fingerprint_of(target)
          .map(|now| now == expected)
          .unwrap_or(false);
        if !same {
          return Err(FINGERPRINT_MISMATCH.to_string());
        }
      }
      precheck(label, with_bom, |out| {
        let mut file = File::open(src).map_err(|e| e.to_string())?;
        pump(&mut file, out, buf)
      })?;
      let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
      crate::fs_ops::replace_with(target, &format!(".convert-{nanos}"), true, None, |out| {
        encode_file(src, label, with_bom, out, buf)
      })?;
      fingerprint_of(target)
    })?;
    self.abort(id);
    Ok(saved)
  }
  /// `decode_file_with` in blocks of the standard size.
  pub fn decode_file(
    &self,
    owner: Option<&str>,
    src: &Path,
    label: &str,
    with_bom: bool,
  ) -> Result<String, String> {
    self.decode_file_with(owner, src, label, with_bom, SCAN_BUF)
  }
  /// A finished file holding `src` decoded from an encoding.
  fn decode_file_with(
    &self,
    owner: Option<&str>,
    src: &Path,
    label: &str,
    with_bom: bool,
    buf: usize,
  ) -> Result<String, String> {
    let mut file = File::open(src).map_err(|e| e.to_string())?;
    let id = self.begin_as(owner, None)?;
    let made = (|| {
      {
        let entry = self.entry(&id)?;
        let mut guard = entry.lock().unwrap();
        let out = guard.file.as_mut().ok_or_else(|| UNFINISHED.to_string())?;
        decode_stream(&mut file, out, label, with_bom, buf)?;
      }
      self.finish(&id)
    })();
    match made {
      Ok(_) => Ok(id),
      Err(e) => {
        self.abort(&id);
        Err(e)
      }
    }
  }
}
// --- commands ------------------------------------------------------------------
/// The conversion `made` for a window that is `alive` or not. A window destroyed
/// while the conversion was made has run its cleanup already, so the conversion is
/// given up here.
fn settle(
  converts: &ConvertStore,
  made: Result<String, String>,
  alive: bool,
) -> Result<String, String> {
  let id = made?;
  if !alive {
    converts.abort(&id);
    return Err(WINDOW_GONE.to_string());
  }
  Ok(id)
}
/// The window is still there; a destroyed window is out of the manager before its
/// cleanup runs.
fn is_alive(window: &tauri::Window) -> bool {
  window
    .app_handle()
    .get_webview_window(window.label())
    .is_some()
}
/// Starts a conversion file whose line breaks are all `eol` (`"\n"` or `"\r\n"`);
/// the id names it in the other commands. The calling window owns it: the file
/// goes when the window does.
#[tauri::command(async)]
pub fn convert_begin(
  window: tauri::Window,
  converts: State<ConvertStore>,
  eol: String,
) -> Result<String, String> {
  let made = converts.begin(Some(window.label()), &eol);
  settle(&converts, made, is_alive(&window))
}
/// Adds a piece of text (at most 1 MiB of UTF-16 units, no surrogate pair cut) to
/// the file, its line breaks written as the file's.
#[tauri::command(async)]
pub fn convert_append(
  converts: State<ConvertStore>,
  id: String,
  text: String,
) -> Result<(), String> {
  converts.append(&id, &text)
}
/// Adds the pinned clip (`clip_pin`) to the file, streamed from the clip file and
/// never held in memory. `pin-gone` when the pin was released: nothing is written
/// then.
#[tauri::command(async)]
pub fn convert_append_clip(
  converts: State<ConvertStore>,
  id: String,
  pin: u64,
) -> Result<(), String> {
  converts.append_clip_with(&id, &|| crate::clipboard_store::pinned(pin), SCAN_CHUNK)
}
/// Adds line `line` (0-based) of the pinned clip to the file, without its break,
/// streamed like the whole clip. `line-out-of-range` when the clip has fewer
/// lines: nothing is written then. `pin-gone` as for `convert_append_clip`.
#[tauri::command(async)]
pub fn convert_append_clip_line(
  converts: State<ConvertStore>,
  id: String,
  pin: u64,
  line: u64,
) -> Result<(), String> {
  converts.append_clip_line_with(
    &id,
    &|| crate::clipboard_store::pinned(pin),
    line,
    SCAN_CHUNK,
  )
}
/// Ends the file: how big it is and whether a windowed session can edit it.
#[tauri::command(async)]
pub fn convert_finish(converts: State<ConvertStore>, id: String) -> Result<Finished, String> {
  converts.finish(&id)
}
/// Gives the conversion up and deletes its file.
#[tauri::command(async)]
pub fn convert_abort(converts: State<ConvertStore>, id: String) {
  converts.abort(&id);
}
/// Writes the finished conversion to `target` in an encoding, for a result too big
/// to edit. `expected` is the fingerprint `target` must still have (none: write
/// whatever is there); a different one is the `fingerprint-mismatch` error and the
/// file is kept for another try. `unmappable` when some text has no form in the
/// encoding: nothing is written then, and the file is kept. A saved file is
/// deleted. Returns the fingerprint of the file written.
#[tauri::command(async)]
pub fn convert_save(
  converts: State<ConvertStore>,
  convert_id: String,
  target: String,
  encoding: String,
  with_bom: bool,
  expected: Option<Fingerprint>,
) -> Result<Fingerprint, String> {
  converts.save_with(
    &convert_id,
    Path::new(&target),
    &encoding,
    with_bom,
    expected,
    SCAN_BUF,
  )
}
/// Decodes the file at `path` (written in `encoding`, with a byte order mark when
/// `with_bom`) into a finished UTF-8 conversion file; the id names it. Line breaks
/// are left as they are.
#[tauri::command(async)]
pub fn convert_from_file(
  window: tauri::Window,
  converts: State<ConvertStore>,
  path: String,
  encoding: String,
  with_bom: bool,
) -> Result<String, String> {
  let made = converts.decode_file(Some(window.label()), Path::new(&path), &encoding, with_bom);
  settle(&converts, made, is_alive(&window))
}
/// Window `label` was destroyed: the conversions it owns are deleted.
pub fn window_destroyed(app: &tauri::AppHandle, label: &str) {
  if let Some(converts) = app.try_state::<ConvertStore>() {
    converts.abort_window(label);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;
  /// Encodings of the kinds there are: UTF-8, both UTF-16s, single and multi-byte
  /// legacy ones and a stateful one.
  const LABELS: [&str; 7] = [
    "UTF-8",
    "UTF-16LE",
    "UTF-16BE",
    "Shift_JIS",
    "Big5",
    "Windows-1252",
    "ISO-2022-JP",
  ];
  const TEXT: &str = "日本語のテキスト\r\n二行目 café\rthird\nÀ lone\r\n";

  fn store(dir: &Path) -> ConvertStore {
    ConvertStore::new(Some(dir.to_path_buf()))
  }
  fn cv_files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
      .map(|entries| {
        entries
          .flatten()
          .map(|e| e.file_name().to_string_lossy().into_owned())
          .filter(|n| n.starts_with(FILE_PREFIX))
          .collect()
      })
      .unwrap_or_default();
    names.sort();
    names
  }
  fn path_of(converts: &ConvertStore, id: &str) -> PathBuf {
    converts.entry(id).unwrap().lock().unwrap().path.clone()
  }
  fn made(converts: &ConvertStore, sep: &str, pieces: &[&str]) -> String {
    let id = converts.begin(None, sep).unwrap();
    for piece in pieces {
      converts.append(&id, piece).unwrap();
    }
    converts.finish(&id).unwrap();
    id
  }
  fn content_of(converts: &ConvertStore, id: &str) -> Vec<u8> {
    fs::read(path_of(converts, id)).unwrap()
  }
  /// `text` with every break written `sep`.
  fn breaks_as(text: &str, sep: &str) -> String {
    let mut out = Vec::new();
    normalize(text.as_bytes(), sep.as_bytes(), &mut false, &mut out);
    String::from_utf8(out).unwrap()
  }
  fn encoded_by(label: &str, with_bom: bool, pieces: &[&[u8]]) -> Result<Vec<u8>, String> {
    let mut writer = EncodeWriter::new(Vec::new(), Encoder::new(label, with_bom)?);
    for piece in pieces {
      writer.write_all(piece).map_err(|e| e.to_string())?;
    }
    writer.finish()
  }
  // --- the data flow -----------------------------------------------------------

  #[test]
  fn breaks_are_written_as_the_files_whatever_the_pieces() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    for sep in ["\n", "\r\n"] {
      let want = breaks_as(TEXT, sep);
      for size in [1, 2, 3, 5, 7, 1000] {
        let pieces: Vec<&str> = {
          let mut out = Vec::new();
          let mut at = 0;
          while at < TEXT.len() {
            let mut to = (at + size).min(TEXT.len());
            while !TEXT.is_char_boundary(to) {
              to += 1;
            }
            out.push(&TEXT[at..to]);
            at = to;
          }
          out
        };
        let id = made(&converts, sep, &pieces);
        assert_eq!(
          String::from_utf8(content_of(&converts, &id)).unwrap(),
          want,
          "{sep:?} in pieces of {size}"
        );
      }
    }
  }

  #[test]
  fn a_cr_ending_one_piece_and_a_lf_opening_the_next_are_one_break() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let id = made(&converts, "\r\n", &["a\r", "\nb\r", "\r", "c\n"]);
    assert_eq!(content_of(&converts, &id), b"a\r\nb\r\n\r\nc\r\n");
  }

  #[test]
  fn a_prefix_text_and_suffix_make_the_reference() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    for sep in ["\n", "\r\n"] {
      let (before, pasted, after) = ("top\nmid", "x\r\ny\rz", "tail\r\nend");
      let id = made(&converts, sep, &[before, pasted, after]);
      let want = breaks_as(&format!("{before}{pasted}{after}"), sep);
      assert_eq!(content_of(&converts, &id), want.as_bytes());
    }
  }

  #[test]
  fn a_clip_between_two_texts_is_streamed_with_the_same_result() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let clip = dir.path().join("clip.txt");
    let text = "日本語\r\nsecond\rthird\n".repeat(50);
    fs::write(&clip, &text).unwrap();
    for sep in ["\n", "\r\n"] {
      for chunk in [1, 3, 16, SCAN_CHUNK] {
        let id = converts.begin(None, sep).unwrap();
        converts.append(&id, "before\r").unwrap();
        converts
          .append_clip_with(&id, &|| Ok(Arc::new(File::open(&clip).unwrap())), chunk)
          .unwrap();
        converts.append(&id, "\nafter").unwrap();
        converts.finish(&id).unwrap();
        let want = breaks_as(&format!("before\r{text}\nafter"), sep);
        assert_eq!(
          content_of(&converts, &id),
          want.as_bytes(),
          "{sep:?} {chunk}"
        );
      }
    }
  }

  #[test]
  fn a_pin_that_is_gone_writes_nothing() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let id = converts.begin(None, "\n").unwrap();
    converts.append(&id, "kept").unwrap();
    let err = converts
      .append_clip_with(&id, &|| Err("pin-gone".to_string()), SCAN_CHUNK)
      .unwrap_err();
    assert_eq!(err, "pin-gone");
    let err = converts
      .append_clip_line_with(&id, &|| Err("pin-gone".to_string()), 0, SCAN_CHUNK)
      .unwrap_err();
    assert_eq!(err, "pin-gone");
    converts.finish(&id).unwrap();
    assert_eq!(content_of(&converts, &id), b"kept");
  }

  #[test]
  fn a_clip_that_cannot_be_read_fails_with_the_read_prefix_and_writes_nothing() {
    struct Unreadable;
    impl Read for Unreadable {
      fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("no access"))
      }
    }
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let id = converts.begin(None, "\n").unwrap();
    converts.append(&id, "kept").unwrap();
    let err = converts
      .append_from(&id, &mut Unreadable, SCAN_CHUNK)
      .unwrap_err();
    assert_eq!(err, "clip-read: no access");
    let err = converts
      .append_line_from(
        &id,
        &|_, _| Err(io::Error::other("no access")),
        0,
        SCAN_CHUNK,
      )
      .unwrap_err();
    assert_eq!(err, "clip-read: no access");
    converts.finish(&id).unwrap();
    assert_eq!(content_of(&converts, &id), b"kept");
  }
  /// The lines of `text` by the line rule: `\r\n`, a lone `\r` and `\n` end one.
  fn lines_of(text: &str) -> Vec<String> {
    breaks_as(text, "\n")
      .split('\n')
      .map(str::to_string)
      .collect()
  }

  #[test]
  fn one_line_of_a_clip_is_added_without_its_break() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let clip = dir.path().join("clip.txt");
    for text in [
      "first\r\nsecond\rthird\n\nlast",
      "one",
      "a\n",
      "\r\n\r",
      "日本語\r\n😀 x\r\r\ny",
      "",
    ] {
      fs::write(&clip, text).unwrap();
      let lines = lines_of(text);
      for chunk in [1, 2, 3, 5, SCAN_CHUNK] {
        for (n, want) in lines.iter().enumerate() {
          let id = converts.begin(None, "\r\n").unwrap();
          converts.append(&id, "<").unwrap();
          converts
            .append_clip_line_with(
              &id,
              &|| Ok(Arc::new(File::open(&clip).unwrap())),
              n as u64,
              chunk,
            )
            .unwrap();
          converts.append(&id, ">").unwrap();
          converts.finish(&id).unwrap();
          assert_eq!(
            content_of(&converts, &id),
            format!("<{want}>").as_bytes(),
            "{text:?} line {n} in blocks of {chunk}"
          );
        }
      }
    }
  }

  #[test]
  fn a_line_a_clip_does_not_have_is_an_error_and_writes_nothing() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let clip = dir.path().join("clip.txt");
    fs::write(&clip, "a\r\nb\nc").unwrap();
    for line in [3, 4, u64::MAX] {
      let id = converts.begin(None, "\n").unwrap();
      converts.append(&id, "kept").unwrap();
      let err = converts
        .append_clip_line_with(&id, &|| Ok(Arc::new(File::open(&clip).unwrap())), line, 2)
        .unwrap_err();
      assert_eq!(err, "line-out-of-range");
      converts.finish(&id).unwrap();
      assert_eq!(content_of(&converts, &id), b"kept");
    }
  }

  #[test]
  fn a_line_of_many_blocks_is_read_a_block_at_a_time() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let clip = dir.path().join("clip.txt");
    let long = "x".repeat(200_000);
    fs::write(&clip, format!("first\r\n{long}\rlast")).unwrap();
    let file = File::open(&clip).unwrap();
    let asked = std::cell::Cell::new(0usize);
    let id = converts.begin(None, "\n").unwrap();
    crate::test_alloc::reset_largest();
    converts
      .append_line_from(
        &id,
        &|buf, at| {
          asked.set(asked.get().max(buf.len()));
          read_at(&file, buf, at)
        },
        1,
        64,
      )
      .unwrap();
    let largest = crate::test_alloc::largest();
    assert!(asked.get() <= 64, "asked for {} at once", asked.get());
    assert!(largest <= 4 * 64, "one allocation of {largest} bytes");
    converts.finish(&id).unwrap();
    assert_eq!(content_of(&converts, &id), long.as_bytes());
  }

  #[test]
  fn the_clip_commands_read_the_pin_and_never_check_the_clipboard_again() {
    for name in [
      "pub fn convert_append_clip(",
      "pub fn convert_append_clip_line(",
    ] {
      let at = SOURCE.find(name).unwrap();
      let body = &SOURCE[at..];
      let body = &body[..body.find("\n}\n").unwrap()];
      assert!(body.contains("clipboard_store::pinned(pin)"), "{name}");
      assert!(!body.contains("open_clip"), "{name} must not check again");
    }
  }

  #[test]
  fn appending_holds_a_block_at_a_time() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let id = converts.begin(None, "\r\n").unwrap();
    let text = "a line of text\n".repeat(20_000);
    crate::test_alloc::reset_largest();
    converts.append_with(&id, &text, 64).unwrap();
    let largest = crate::test_alloc::largest();
    assert!(largest <= 4 * 64, "one allocation of {largest} bytes");
    converts.finish(&id).unwrap();
    assert_eq!(
      fs::metadata(path_of(&converts, &id)).unwrap().len(),
      20_000 * 16
    );
  }

  #[test]
  fn a_piece_from_the_page_is_written_in_blocks_of_the_standard_size() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let id = converts.begin(None, "\r\n").unwrap();
    let text = "ab\n".repeat(1 << 20);
    crate::test_alloc::reset_largest();
    converts.append(&id, &text).unwrap();
    let largest = crate::test_alloc::largest();
    assert!(
      largest <= 4 * SCAN_CHUNK,
      "one allocation of {largest} bytes for {} bytes",
      text.len()
    );
    converts.finish(&id).unwrap();
    assert_eq!(
      fs::metadata(path_of(&converts, &id)).unwrap().len(),
      (1 << 20) * 4
    );
  }

  #[test]
  fn a_clip_is_read_a_chunk_at_a_time() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let clip = dir.path().join("clip.txt");
    fs::write(&clip, "a line of text\n".repeat(20_000)).unwrap();
    let id = converts.begin(None, "\r\n").unwrap();
    crate::test_alloc::reset_largest();
    converts
      .append_clip_with(&id, &|| Ok(Arc::new(File::open(&clip).unwrap())), 64)
      .unwrap();
    let largest = crate::test_alloc::largest();
    assert!(largest <= 4 * 64, "one allocation of {largest} bytes");
  }

  #[test]
  fn editable_ends_one_byte_below_the_limit() {
    let dir = tempdir().unwrap();
    let converts = ConvertStore::with_max(Some(dir.path().to_path_buf()), 10);
    for (bytes, editable) in [(9usize, true), (10, false), (11, false)] {
      let id = converts.begin(None, "\n").unwrap();
      converts.append(&id, &"x".repeat(bytes)).unwrap();
      assert_eq!(
        converts.finish(&id).unwrap(),
        Finished {
          bytes: bytes as u64,
          editable
        },
        "{bytes} bytes"
      );
    }
  }

  #[test]
  fn the_limit_variable_is_a_number_of_bytes() {
    assert_eq!(parse_max(Some(" 4096 ")), Some(4096));
    assert_eq!(parse_max(Some("big")), None);
    assert_eq!(parse_max(None), None);
  }

  #[test]
  fn the_limit_of_a_release_build_is_the_one_of_the_editor() {
    assert_eq!(
      ConvertStore::with_max(None, crate::windowed::LARGE_EDIT_MAX).max,
      512 * 1024 * 1024
    );
  }

  #[test]
  fn an_aborted_file_and_a_file_of_a_dropped_store_are_deleted() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let a = converts.begin(None, "\n").unwrap();
    let b = made(&converts, "\n", &["done"]);
    let c = converts.begin(None, "\n").unwrap();
    assert_eq!(cv_files(dir.path()).len(), 3);
    converts.abort(&a);
    assert_eq!(cv_files(dir.path()).len(), 2);
    assert_eq!(converts.append(&a, "x").unwrap_err(), UNKNOWN_CONVERT);
    drop(converts);
    assert!(cv_files(dir.path()).is_empty(), "{b} {c}");
  }

  #[test]
  fn a_taken_file_is_the_sessions_and_goes_with_its_guard() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let unfinished = converts.begin(None, "\n").unwrap();
    assert_eq!(converts.take(&unfinished).unwrap_err(), UNFINISHED);
    let id = made(&converts, "\n", &["kept"]);
    let tmp = converts.take(&id).unwrap();
    assert_eq!(converts.take(&id).unwrap_err(), UNKNOWN_CONVERT);
    converts.abort(&unfinished);
    drop(converts);
    assert_eq!(fs::read(tmp.path()).unwrap(), b"kept");
    let path = tmp.path().to_path_buf();
    drop(tmp);
    assert!(!path.exists());
  }

  #[test]
  fn without_a_folder_nothing_begins() {
    let converts = ConvertStore::new(None);
    assert_eq!(converts.begin(None, "\n").unwrap_err(), no_folder());
    assert!(ConvertStore::new(Some(tempdir().unwrap().path().join("x")))
      .begin(None, "\r")
      .is_err());
  }
  // --- the encoders ------------------------------------------------------------

  #[test]
  fn every_encoding_writes_what_encode_text_writes_whatever_the_pieces() {
    let text = "日本語のテキスト\r\n二行目 café\n";
    for label in LABELS {
      // The legacy ones that cannot write every character get their own text.
      let text = match label {
        "Windows-1252" => "café\r\nà la mode\n",
        "ISO-2022-JP" | "Shift_JIS" | "Big5" => "日本語\r\n二行目\n",
        _ => text,
      };
      for with_bom in [false, true] {
        let want = crate::encoding::encode_text(text, label, with_bom).unwrap();
        for size in [1, 2, 3, 4, 5, 1000] {
          let pieces: Vec<&[u8]> = text.as_bytes().chunks(size).collect();
          assert_eq!(
            encoded_by(label, with_bom, &pieces).unwrap(),
            want,
            "{label} bom {with_bom} pieces of {size}"
          );
        }
      }
    }
  }

  #[test]
  fn an_empty_text_still_has_its_mark() {
    for (label, bom, want) in [
      ("UTF-8", false, &[][..]),
      ("UTF-8", true, &[0xEF, 0xBB, 0xBF][..]),
      ("UTF-16LE", false, &[0xFF, 0xFE][..]),
      ("UTF-16BE", false, &[0xFE, 0xFF][..]),
      ("Shift_JIS", true, &[][..]),
    ] {
      assert_eq!(encoded_by(label, bom, &[]).unwrap(), want, "{label}");
    }
  }

  #[test]
  fn a_character_the_encoding_lacks_is_unmappable_not_replaced() {
    for label in ["Shift_JIS", "Windows-1252", "Big5"] {
      let err = encoded_by(label, false, &["ok 😀".as_bytes()]).unwrap_err();
      assert_eq!(err, UNMAPPABLE, "{label}");
    }
    assert!(encoded_by("UTF-16LE", false, &["😀".as_bytes()]).is_ok());
  }

  #[test]
  fn a_text_that_is_not_utf8_is_refused() {
    assert_eq!(
      encoded_by("UTF-8", false, &[b"ab\xFFcd"]).unwrap_err(),
      NOT_UTF8
    );
    // A character cut for good.
    assert_eq!(
      encoded_by("Shift_JIS", false, &[&"日".as_bytes()[..2]]).unwrap_err(),
      NOT_UTF8
    );
  }

  #[test]
  fn a_precheck_finds_what_a_write_would_stumble_on_and_writes_nothing() {
    let mut seen = 0;
    let err = precheck("Shift_JIS", false, |out| {
      seen += 1;
      out.write_all("ok 😀".as_bytes()).map_err(|e| e.to_string())
    })
    .unwrap_err();
    assert_eq!(err, UNMAPPABLE);
    // The Unicode encodings cannot fail: the document is not even read.
    precheck("UTF-16LE", false, |_| panic!("read for nothing")).unwrap();
    assert_eq!(seen, 1);
  }
  // --- saving and decoding -------------------------------------------------------

  #[test]
  fn convert_save_writes_the_encoding_and_deletes_the_file() {
    let dir = tempdir().unwrap();
    let work = dir.path().join("work");
    let converts = store(&work);
    let target = dir.path().join("out.txt");
    let text = "日本語\r\n二行目\n";
    for (label, bom) in [("Shift_JIS", false), ("UTF-16BE", true), ("UTF-8", true)] {
      let id = made(&converts, "\n", &[text]);
      converts
        .save_with(&id, &target, label, bom, None, 16)
        .unwrap();
      assert_eq!(
        fs::read(&target).unwrap(),
        crate::encoding::encode_text(&breaks_as(text, "\n"), label, bom).unwrap(),
        "{label}"
      );
      assert!(cv_files(&work).is_empty(), "{label}: the file is deleted");
    }
  }

  #[test]
  fn convert_save_with_another_fingerprint_writes_nothing_until_told_to() {
    let dir = tempdir().unwrap();
    let work = dir.path().join("work");
    let converts = store(&work);
    let target = dir.path().join("out.txt");
    fs::write(&target, "outside").unwrap();
    let stale = Fingerprint {
      size: 1,
      mtime_ms: 1,
    };
    let id = made(&converts, "\n", &["new"]);
    let err = converts
      .save_with(&id, &target, "UTF-8", false, Some(stale), 16)
      .unwrap_err();
    assert_eq!(err, FINGERPRINT_MISMATCH);
    assert_eq!(fs::read(&target).unwrap(), b"outside");
    assert_eq!(cv_files(&work).len(), 1, "kept for another try");
    // The fingerprint it has is accepted.
    let fresh = fingerprint_of(&target).unwrap();
    let id2 = made(&converts, "\n", &["newer"]);
    converts
      .save_with(&id2, &target, "UTF-8", false, Some(fresh.clone()), 16)
      .unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"newer");
    // None writes anyway.
    converts
      .save_with(&id, &target, "UTF-8", false, None, 16)
      .unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new");
    // A target that is not there is not what was expected either.
    let id3 = made(&converts, "\n", &["x"]);
    let gone = dir.path().join("gone.txt");
    assert_eq!(
      converts
        .save_with(&id3, &gone, "UTF-8", false, Some(fresh), 16)
        .unwrap_err(),
      FINGERPRINT_MISMATCH
    );
  }

  #[test]
  fn convert_save_with_an_unmappable_character_changes_nothing_and_keeps_the_file() {
    let dir = tempdir().unwrap();
    let work = dir.path().join("work");
    let converts = store(&work);
    let target = dir.path().join("out.txt");
    fs::write(&target, "outside").unwrap();
    let id = made(&converts, "\n", &["日本語 ", "😀 tail"]);
    let err = converts
      .save_with(&id, &target, "Shift_JIS", false, None, 8)
      .unwrap_err();
    assert_eq!(err, UNMAPPABLE);
    assert_eq!(fs::read(&target).unwrap(), b"outside");
    assert_eq!(cv_files(&work).len(), 1);
    // Found before anything is staged: a target that cannot be staged to is not
    // what the error is about.
    let nowhere = dir.path().join("no").join("such").join("out.txt");
    assert_eq!(
      converts
        .save_with(&id, &nowhere, "Shift_JIS", false, None, 8)
        .unwrap_err(),
      UNMAPPABLE
    );
    // Again, in UTF-8.
    converts
      .save_with(&id, &target, "UTF-8", false, None, 8)
      .unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "日本語 😀 tail");
  }

  #[test]
  fn a_file_is_decoded_to_utf8_in_pieces_whatever_their_size() {
    let dir = tempdir().unwrap();
    let work = dir.path().join("work");
    let converts = store(&work);
    let text = "日本語のテキスト\r\n二行目\rthird\n".repeat(30);
    for (label, bom) in [
      ("Shift_JIS", false),
      ("EUC-JP", false),
      ("UTF-16LE", true),
      ("UTF-16BE", true),
      ("UTF-8", true),
      ("UTF-8", false),
    ] {
      let src = dir.path().join("src.txt");
      fs::write(
        &src,
        crate::encoding::encode_text(&text, label, bom).unwrap(),
      )
      .unwrap();
      for size in [4, 5, 7, 4096] {
        let id = converts
          .decode_file_with(None, &src, label, bom, size)
          .unwrap();
        assert_eq!(
          String::from_utf8(content_of(&converts, &id)).unwrap(),
          text,
          "{label} bom {bom} pieces of {size}"
        );
      }
    }
  }

  #[test]
  fn a_file_that_cannot_be_read_leaves_no_conversion_behind() {
    let dir = tempdir().unwrap();
    let work = dir.path().join("work");
    let converts = store(&work);
    assert!(converts
      .decode_file_with(None, &dir.path().join("missing"), "UTF-8", false, 16)
      .is_err());
    let src = dir.path().join("src.txt");
    fs::write(&src, "x").unwrap();
    assert!(converts
      .decode_file_with(None, &src, "Nope", false, 16)
      .is_err());
    assert!(cv_files(&work).is_empty());
  }
  // --- the commands --------------------------------------------------------------

  #[test]
  fn tmp_files_are_created_once_and_deleted_with_their_guard() {
    let dir = tempdir().unwrap();
    let (_file, tmp) = TmpFile::create(dir.path()).unwrap();
    let path = tmp.path().to_path_buf();
    assert!(path.exists());
    assert!(path
      .file_name()
      .unwrap()
      .to_string_lossy()
      .starts_with(FILE_PREFIX));
    drop(tmp);
    assert!(!path.exists());
  }

  #[test]
  fn a_destroyed_window_takes_its_conversions_and_no_other() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let mine = converts.begin(Some("doc-1"), "\n").unwrap();
    converts.append(&mine, "text").unwrap();
    let finished = converts.begin(Some("doc-1"), "\n").unwrap();
    converts.finish(&finished).unwrap();
    let decoded = dir.path().join("src.txt");
    fs::write(&decoded, "abc").unwrap();
    let from_file = converts
      .decode_file(Some("doc-1"), &decoded, "UTF-8", false)
      .unwrap();
    let other = converts.begin(Some("doc-2"), "\n").unwrap();
    let handed = converts.begin(None, "\n").unwrap();
    assert_eq!(cv_files(dir.path()).len(), 5);
    converts.abort_window("doc-1");
    assert_eq!(cv_files(dir.path()).len(), 2);
    for id in [&mine, &finished, &from_file] {
      assert_eq!(converts.entry(id).err().as_deref(), Some(UNKNOWN_CONVERT));
    }
    for id in [&other, &handed] {
      assert!(converts.append(id, "still there").is_ok());
    }
    converts.abort_window("doc-2");
    assert_eq!(cv_files(dir.path()).len(), 1);
    assert!(converts.entry(&handed).is_ok());
  }

  #[test]
  fn a_call_on_a_conversion_a_destroyed_window_owned_fails_and_writes_nothing() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let id = converts.begin(Some("doc-1"), "\n").unwrap();
    converts.append(&id, "text").unwrap();
    converts.abort_window("doc-1");
    assert_eq!(converts.append(&id, "more").unwrap_err(), UNKNOWN_CONVERT);
    assert_eq!(
      converts
        .append_clip_with(&id, &|| Err("not opened".to_string()), 8)
        .unwrap_err(),
      UNKNOWN_CONVERT
    );
    let clip = dir.path().join("clip.txt");
    fs::write(&clip, "a").unwrap();
    assert_eq!(
      converts
        .append_clip_line_with(&id, &|| Ok(Arc::new(File::open(&clip).unwrap())), 0, 8)
        .unwrap_err(),
      UNKNOWN_CONVERT
    );
    assert_eq!(converts.finish(&id).unwrap_err(), UNKNOWN_CONVERT);
    assert_eq!(converts.take(&id).unwrap_err(), UNKNOWN_CONVERT);
    let target = dir.path().join("target.txt");
    assert_eq!(
      converts
        .save_with(&id, &target, "UTF-8", false, None, 8)
        .unwrap_err(),
      UNKNOWN_CONVERT
    );
    assert!(!target.exists());
    assert_eq!(cv_files(dir.path()), Vec::<String>::new());
  }

  #[test]
  fn a_conversion_in_use_when_its_window_goes_ends_without_a_file() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let id = converts.begin(Some("doc-1"), "\n").unwrap();
    let entry = converts.entry(&id).unwrap();
    let busy = entry.lock().unwrap();
    converts.abort_window("doc-1");
    drop(busy);
    drop(entry);
    assert_eq!(cv_files(dir.path()), Vec::<String>::new());
  }

  #[test]
  fn a_session_that_took_the_file_keeps_it_when_the_window_goes() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let id = made(&converts, "\n", &["text"]);
    converts.set_owner(&id, Some("doc-1")).unwrap();
    let tmp = converts.take(&id).unwrap();
    converts.abort_window("doc-1");
    assert!(tmp.path().exists());
    drop(tmp);
    assert_eq!(cv_files(dir.path()), Vec::<String>::new());
  }

  #[test]
  fn the_owner_can_be_set_and_cleared_and_an_unknown_conversion_is_refused() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let id = converts.begin(Some("note-a"), "\n").unwrap();
    converts.set_owner(&id, None).unwrap();
    converts.abort_window("note-a");
    assert!(converts.entry(&id).is_ok());
    converts.set_owner(&id, Some("doc-1")).unwrap();
    converts.abort_window("note-a");
    assert!(converts.entry(&id).is_ok());
    converts.abort_window("doc-1");
    assert!(converts.entry(&id).is_err());
    assert_eq!(
      converts.set_owner(&id, Some("doc-1")).unwrap_err(),
      UNKNOWN_CONVERT
    );
  }

  #[test]
  fn a_conversion_made_for_a_window_that_went_meanwhile_is_given_up() {
    let dir = tempdir().unwrap();
    let converts = store(dir.path());
    let made_for = converts.begin(Some("doc-1"), "\n");
    assert_eq!(settle(&converts, made_for, false).unwrap_err(), WINDOW_GONE);
    assert_eq!(cv_files(dir.path()), Vec::<String>::new());
    let made_for = converts.begin(Some("doc-1"), "\n");
    let id = settle(&converts, made_for, true).unwrap();
    assert!(converts.entry(&id).is_ok());
    assert_eq!(
      settle(&converts, Err("no folder".to_string()), false).unwrap_err(),
      "no folder"
    );
  }

  #[test]
  fn the_commands_that_make_a_conversion_name_their_window() {
    for name in ["pub fn convert_begin(", "pub fn convert_from_file("] {
      let at = SOURCE.find(name).unwrap();
      let body = &SOURCE[at..];
      let body = &body[..body.find("\n}\n").unwrap()];
      assert!(body.contains("window: tauri::Window"), "{name}");
      assert!(body.contains("Some(window.label())"), "{name}");
      assert!(body.contains("settle("), "{name}");
    }
  }

  #[test]
  fn a_destroyed_window_is_cleaned_up_in_the_window_event() {
    let lib = include_str!("lib.rs");
    assert!(lib.contains("convert::window_destroyed(window.app_handle(), window.label())"));
  }

  const SOURCE: &str = include_str!("convert.rs");
  const NEW_COMMANDS: &[&str] = &[
    "convert_begin",
    "convert_append",
    "convert_append_clip",
    "convert_append_clip_line",
    "convert_finish",
    "convert_abort",
    "convert_save",
    "convert_from_file",
  ];

  #[test]
  fn every_new_command_is_async() {
    for name in NEW_COMMANDS {
      let at = SOURCE
        .find(&format!("pub fn {name}("))
        .unwrap_or_else(|| panic!("{name} is gone"));
      assert!(
        SOURCE[..at]
          .trim_end()
          .ends_with("#[tauri::command(async)]"),
        "{name} must be #[tauri::command(async)]: it writes or reads a file"
      );
    }
  }
}
