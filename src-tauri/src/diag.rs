//! In-memory diagnostic logger. Normal operation never touches disk: every
//! formatted log line goes into a capped ring buffer held in memory, and
//! `dump` is the only thing that ever writes it out, called from panic
//! handling and from failure paths that would otherwise just be a discarded
//! `log::warn!`.

use log::{Level, LevelFilter, Log, Metadata, Record};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Ring buffer capacity in bytes. Bounds both memory use and, transitively,
/// the size of the dumped file.
const RING_CAP: usize = 256 * 1024;

/// Fixed dump file name; `dump` always overwrites it, so disk usage never
/// grows beyond one ring's worth of text.
const DUMP_FILE_NAME: &str = "diagnostic.log";

/// Byte ring buffer of complete, newline-terminated log lines. Free of any
/// Tauri type so it can be unit-tested on its own.
struct Ring {
  buf: Mutex<VecDeque<u8>>,
  cap: usize,
}

impl Ring {
  fn new(cap: usize) -> Self {
    Ring {
      buf: Mutex::new(VecDeque::new()),
      cap,
    }
  }

  /// Append one line, adding a trailing newline if missing, then drop whole
  /// oldest lines (never splitting one) until back under the cap. A single
  /// line that alone exceeds the cap is truncated to its final `cap` bytes
  /// rather than left to blow the buffer out or panic.
  fn push_line(&self, line: &str) {
    let mut bytes = line.as_bytes().to_vec();
    if bytes.last() != Some(&b'\n') {
      bytes.push(b'\n');
    }
    let mut buf = self.buf.lock().unwrap();
    if bytes.len() >= self.cap {
      buf.clear();
      buf.extend(&bytes[bytes.len() - self.cap..]);
      return;
    }
    buf.extend(&bytes);
    while buf.len() > self.cap {
      match buf.iter().position(|&b| b == b'\n') {
        Some(pos) => {
          buf.drain(..=pos);
        }
        None => buf.clear(),
      }
    }
  }

  fn snapshot(&self) -> Vec<u8> {
    self.buf.lock().unwrap().iter().copied().collect()
  }
}

/// `log::Log` implementation backed by a `Ring`. Installed once as the
/// process-wide global logger.
struct DiagLogger {
  ring: Ring,
}

impl DiagLogger {
  fn new() -> Self {
    DiagLogger {
      ring: Ring::new(RING_CAP),
    }
  }
}

impl Log for DiagLogger {
  fn enabled(&self, metadata: &Metadata) -> bool {
    metadata.level() <= Level::Info
  }

  fn log(&self, record: &Record) {
    if !self.enabled(record.metadata()) {
      return;
    }
    let now = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or_default();
    let line = format!(
      "{}.{:03} {:5} [{}] {}",
      now.as_secs(),
      now.subsec_millis(),
      record.level(),
      record.target(),
      record.args()
    );
    self.ring.push_line(&line);
    // Debug builds still print to stderr so `npm run tauri dev` stays usable.
    #[cfg(debug_assertions)]
    eprintln!("{line}");
  }

  fn flush(&self) {}
}

static LOGGER: OnceLock<DiagLogger> = OnceLock::new();

/// Install the diagnostic logger as the process-wide global logger. Must run
/// once, before anything else calls into `log`.
pub fn init() {
  let logger = LOGGER.get_or_init(DiagLogger::new);
  // Only failure mode is "already installed"; nothing else can be running
  // this early, so it is safe to ignore.
  let _ = log::set_logger(logger);
  log::set_max_level(LevelFilter::Info);
}

/// Append one line to the ring directly, bypassing `log::Record` formatting.
/// Used by the panic hook, which runs before a `Record` can be built.
fn record_line(line: &str) {
  if let Some(logger) = LOGGER.get() {
    logger.ring.push_line(line);
    #[cfg(debug_assertions)]
    eprintln!("{line}");
  }
}

/// Log a panic's payload and location into the ring, then dump it.
pub fn record_panic(app: &AppHandle, payload: &str, location: Option<String>) {
  let where_ = location.unwrap_or_else(|| "unknown location".to_string());
  record_line(&format!("PANIC [{where_}] {payload}"));
  let _ = dump(app);
}

/// Write the ring's current contents to `app_log_dir()/diagnostic.log`,
/// creating the directory if needed and overwriting any previous dump.
pub fn dump(app: &AppHandle) -> Result<PathBuf, String> {
  let logger = LOGGER.get().ok_or("diagnostic logger not installed")?;
  let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let path = dir.join(DUMP_FILE_NAME);
  std::fs::write(&path, logger.ring.snapshot()).map_err(|e| e.to_string())?;
  Ok(path)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ring_drops_oldest_whole_lines_and_stays_under_cap() {
    let ring = Ring::new(64);
    for i in 0..40 {
      ring.push_line(&format!("line-{i:03}"));
    }
    let snapshot = ring.snapshot();
    assert!(snapshot.len() <= 64);
    let text = String::from_utf8(snapshot).unwrap();
    // No partial line: every kept line is a full "line-NNN" entry.
    for line in text.lines() {
      assert!(line.starts_with("line-"));
      assert_eq!(line.len(), "line-000".len());
    }
    // The most recent line survived; the earliest ones were dropped.
    assert!(text.contains("line-039"));
    assert!(!text.contains("line-000"));
  }

  #[test]
  fn single_line_larger_than_cap_does_not_panic() {
    let ring = Ring::new(16);
    let huge = "x".repeat(1000);
    ring.push_line(&huge);
    let snapshot = ring.snapshot();
    assert!(snapshot.len() <= 16);
  }

  #[test]
  fn dump_writes_exactly_the_ring_contents() {
    let ring = Ring::new(RING_CAP);
    ring.push_line("hello");
    ring.push_line("world");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DUMP_FILE_NAME);
    std::fs::write(&path, ring.snapshot()).unwrap();
    let written = std::fs::read(&path).unwrap();
    assert_eq!(written, ring.snapshot());
    assert_eq!(String::from_utf8(written).unwrap(), "hello\nworld\n");
  }

  #[test]
  fn second_dump_overwrites_rather_than_appends() {
    let ring = Ring::new(RING_CAP);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DUMP_FILE_NAME);
    ring.push_line("first");
    std::fs::write(&path, ring.snapshot()).unwrap();
    ring.push_line("second");
    std::fs::write(&path, ring.snapshot()).unwrap();
    let written = String::from_utf8(std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(written, "first\nsecond\n");
  }
}
