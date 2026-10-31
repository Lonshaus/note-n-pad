// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Clips: a copy too big to hold in memory is written to a file in the temp
//! folder and handed to the system clipboard from there, so the app's memory does
//! not grow with the text.
//!
//! macOS declares the text on the pasteboard and maps the file when another app
//! asks for it; at exit the text is written for real. Windows starts the helper
//! program next to the app, which opens the file, owns the clipboard and renders
//! the text on demand (`cliphelper/`). Linux has no clips.
//!
//! One lock, `CLIP_LOCK`, orders the copies and guards what the clipboard holds
//! now. Nothing waits for the main thread while holding it, except the helper's
//! arm handshake on Windows.
//!
//! A paste asks here first. A queued copy reserves a number beforehand and a paste
//! waits only for the reservations older than itself. Text from another app is
//! read behind a gate, and no clip is handed to the clipboard while one is open;
//! the gate and the reservations are short locks of their own, never `CLIP_LOCK`.
use crate::line_rule::BreakCounter;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
/// File-name prefix and suffix of a clip; the startup cleanup removes them.
const FILE_PREFIX: &str = "clip-";
const FILE_SUFFIX: &str = ".txt";
/// How long a command waits for the main thread (and, on Windows, for each
/// answer of the helper).
pub const MAIN_WAIT: Duration = Duration::from_secs(5);
/// Clips made by this run.
static NEXT_CLIP: AtomicU64 = AtomicU64::new(0);
/// What the clipboard holds of ours.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ClipInfo {
  pub id: String,
  pub bytes: u64,
  pub lines: u64,
  pub utf16_len: u64,
  /// How many line breaks are `\r\n`, one pair counting once.
  pub crlf: u64,
  /// The text is whole lines (a copy with no selection), to paste as lines.
  pub linewise: bool,
}
/// How a clip copy ended. The last two show no message.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClipOutcome {
  Offered(ClipInfo),
  /// A later copy came first, or the clipboard changed meanwhile.
  Superseded,
  OfferFailed,
}
/// A finished clip file.
#[derive(Clone, Debug)]
pub struct Written {
  pub path: PathBuf,
  pub info: ClipInfo,
}
/// `clip-<pid>-<seq>-<nanos>.txt` for a run's pid, its clip number and the time.
pub fn clip_file_name(pid: u32, seq: u64, nanos: u128) -> String {
  format!("{FILE_PREFIX}{}{FILE_SUFFIX}", clip_id(pid, seq, nanos))
}

fn clip_id(pid: u32, seq: u64, nanos: u128) -> String {
  format!("{pid}-{seq}-{nanos}")
}
/// Turns arbitrarily split UTF-8 into valid UTF-8, one U+FFFD for each maximal
/// invalid sequence, as `String::from_utf8_lossy` does for the whole text. A
/// character cut by the end of a chunk waits for the next.
#[derive(Default)]
pub struct Lossy {
  carry: [u8; 4],
  len: usize,
}

const REPLACEMENT: &str = "\u{FFFD}";

impl Lossy {
  /// Appends the converted `chunk` to `out`.
  pub fn push(&mut self, chunk: &[u8], out: &mut Vec<u8>) {
    let mut pos = 0;
    while self.len > 0 && pos < chunk.len() {
      self.carry[self.len] = chunk[pos];
      self.len += 1;
      pos += 1;
      match std::str::from_utf8(&self.carry[..self.len]) {
        Ok(text) => {
          out.extend_from_slice(text.as_bytes());
          self.len = 0;
        }
        Err(e) if e.error_len().is_none() => {}
        Err(_) => {
          // The byte just added broke the sequence: the carried bytes are one
          // invalid sequence, and that byte starts the next.
          out.extend_from_slice(REPLACEMENT.as_bytes());
          self.len = 0;
          pos -= 1;
        }
      }
    }
    let mut rest = &chunk[pos..];
    while !rest.is_empty() {
      match std::str::from_utf8(rest) {
        Ok(text) => {
          out.extend_from_slice(text.as_bytes());
          return;
        }
        Err(e) => {
          let valid = e.valid_up_to();
          out.extend_from_slice(&rest[..valid]);
          match e.error_len() {
            None => {
              let tail = &rest[valid..];
              self.carry[..tail.len()].copy_from_slice(tail);
              self.len = tail.len();
              return;
            }
            Some(n) => {
              out.extend_from_slice(REPLACEMENT.as_bytes());
              rest = &rest[valid + n..];
            }
          }
        }
      }
    }
  }
  /// Appends what a truncated last character leaves.
  pub fn finish(&mut self, out: &mut Vec<u8>) {
    if self.len > 0 {
      out.extend_from_slice(REPLACEMENT.as_bytes());
      self.len = 0;
    }
  }
}
/// UTF-16 units of valid UTF-8.
fn utf16_units(bytes: &[u8]) -> u64 {
  bytes
    .iter()
    .map(|&b| u64::from(b & 0xC0 != 0x80) + u64::from(b >= 0xF0))
    .sum()
}
/// The `\r\n` pairs in `bytes`; `after_cr` says whether the byte before them was a
/// `\r`, and is left for the next piece.
fn count_crlf(after_cr: &mut bool, bytes: &[u8]) -> u64 {
  let mut pairs = 0;
  for &b in bytes {
    if b == b'\n' && *after_cr {
      pairs += 1;
    }
    *after_cr = b == b'\r';
  }
  pairs
}
/// A clip file being written: the text goes in as it is read, converted to valid
/// UTF-8, and its size is counted on the way. A writer dropped before `finish`
/// removes the file.
pub struct ClipWriter {
  file: File,
  path: PathBuf,
  id: String,
  linewise: bool,
  lossy: Lossy,
  breaks: BreakCounter,
  bytes: u64,
  utf16_len: u64,
  crlf: u64,
  after_cr: bool,
  out: Vec<u8>,
  finished: bool,
}

impl ClipWriter {
  /// Starts a clip in `dir`.
  pub fn create(dir: &Path, linewise: bool) -> Result<Self, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0);
    let seq = NEXT_CLIP.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let path = dir.join(clip_file_name(pid, seq, nanos));
    let file = OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&path)
      .map_err(|e| e.to_string())?;
    Ok(ClipWriter {
      file,
      path,
      id: clip_id(pid, seq, nanos),
      linewise,
      lossy: Lossy::default(),
      breaks: BreakCounter::new(),
      bytes: 0,
      utf16_len: 0,
      crlf: 0,
      after_cr: false,
      out: Vec::new(),
      finished: false,
    })
  }
  /// Adds the next piece of the text.
  pub fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
    self.out.clear();
    self.lossy.push(bytes, &mut self.out);
    self.write_out()
  }
  /// Closes the file and says what it holds.
  pub fn finish(mut self) -> Result<Written, String> {
    self.out.clear();
    self.lossy.finish(&mut self.out);
    self.write_out()?;
    self.finished = true;
    let lines = match self.bytes {
      0 => 0,
      _ => self.breaks.finish() + 1,
    };
    Ok(Written {
      path: std::mem::take(&mut self.path),
      info: ClipInfo {
        id: std::mem::take(&mut self.id),
        bytes: self.bytes,
        lines,
        utf16_len: self.utf16_len,
        crlf: self.crlf,
        linewise: self.linewise,
      },
    })
  }
  fn write_out(&mut self) -> Result<(), String> {
    self.breaks.feed(&self.out);
    self.bytes += self.out.len() as u64;
    self.utf16_len += utf16_units(&self.out);
    self.crlf += count_crlf(&mut self.after_cr, &self.out);
    self.file.write_all(&self.out).map_err(|e| e.to_string())
  }
}

impl Drop for ClipWriter {
  fn drop(&mut self) {
    if !self.finished {
      let _ = fs::remove_file(&self.path);
    }
  }
}
/// The clip the clipboard holds now.
pub struct Active {
  info: ClipInfo,
  path: PathBuf,
  /// What shows the clipboard is still ours: the pasteboard's change count on
  /// macOS, the helper's pid on Windows.
  owner: u64,
}
/// Where a hand-off to the main thread stands, kept under the lock so a late
/// main thread and a waiter that gave up cannot both act. A waiter that gives up
/// removes the entry, which cancels the job: it only acts on a `Pending` one.
enum Handoff {
  Pending,
  Done(ClipOutcome),
}
/// What `CLIP_LOCK` guards.
pub struct Inner {
  /// The number of the latest clip copy.
  copy_seq: u64,
  clip_state: Option<Active>,
  handoffs: BTreeMap<u64, Handoff>,
}

impl Inner {
  const fn new() -> Self {
    Inner {
      copy_seq: 0,
      clip_state: None,
      handoffs: BTreeMap::new(),
    }
  }
}

pub static CLIP_LOCK: Mutex<Inner> = Mutex::new(Inner::new());
/// Whether the clipboard still shows `active` as its owner, `now` being what the
/// board reports now.
pub fn clip_status_valid(active: &Active, now: u64) -> bool {
  active.owner == now
}
// --- reservations and gates ---------------------------------------------------
/// How long a reservation or a gate lasts without being renewed. Its window renews
/// it every few seconds while the thing it stands for is alive, so only a leak
/// runs out.
pub const LEASE: Duration = Duration::from_secs(15);
/// The last number handed out. Reservations, gates and marks share it, so a number
/// names one thing and a mark orders against every reservation.
static NUMBERS: AtomicU64 = AtomicU64::new(0);

fn next_number() -> u64 {
  NUMBERS.fetch_add(1, Ordering::SeqCst) + 1
}

struct Lease {
  window: String,
  deadline: Instant,
}
/// Something that lives on a lease.
trait Leased {
  fn lease(&self) -> &Lease;
  fn lease_mut(&mut self) -> &mut Lease;
}

impl Leased for Lease {
  fn lease(&self) -> &Lease {
    self
  }
  fn lease_mut(&mut self) -> &mut Lease {
    self
  }
}
/// Removes the leases nobody renewed; whether any went.
fn expire_leases<T: Leased>(leases: &mut BTreeMap<u64, T>, now: Instant, what: &str) -> bool {
  let before = leases.len();
  leases.retain(|number, item| {
    let lease = item.lease();
    let alive = lease.deadline > now;
    if !alive {
      log::error!(
        "clip: {what} {number} of window {} ran out without being released",
        lease.window
      );
    }
    alive
  });
  leases.len() != before
}
/// Pushes the deadline of each of `numbers` that is a lease here; whether any is.
fn renew_leases<T: Leased>(
  leases: &mut BTreeMap<u64, T>,
  numbers: &[u64],
  deadline: Instant,
) -> bool {
  let mut any = false;
  for number in numbers {
    if let Some(item) = leases.get_mut(number) {
      item.lease_mut().deadline = deadline;
      any = true;
    }
  }
  any
}
/// Removes the leases of `window`; whether any went.
fn drop_window_leases<T: Leased>(leases: &mut BTreeMap<u64, T>, window: &str) -> bool {
  let before = leases.len();
  leases.retain(|_, item| item.lease().window != window);
  leases.len() != before
}
/// What `clip_copy_reserve` answers: `token` names the reservation, `seq` orders it
/// against the marks. They are one number.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reservation {
  pub token: u64,
  pub seq: u64,
}
/// The clip copies that are queued or under way, each reserved by its window
/// before it was queued.
pub struct Reservations {
  live: Mutex<BTreeMap<u64, Lease>>,
  /// The lowest live number, `u64::MAX` when none is.
  low: watch::Sender<u64>,
  ttl: Duration,
}

impl Reservations {
  fn new(ttl: Duration) -> Self {
    Reservations {
      live: Mutex::new(BTreeMap::new()),
      low: watch::channel(u64::MAX).0,
      ttl,
    }
  }
  /// Tells the waiters where the lowest live number is now.
  fn publish(&self, live: &BTreeMap<u64, Lease>) {
    let low = live.keys().next().copied().unwrap_or(u64::MAX);
    self.low.send_if_modified(|seen| {
      let moved = *seen != low;
      *seen = low;
      moved
    });
  }
  /// The number a paste pressed now is ordered by.
  pub fn mark(&self) -> u64 {
    NUMBERS.load(Ordering::SeqCst)
  }
  pub fn reserve(&self, window: &str, now: Instant) -> Reservation {
    let number = next_number();
    let mut live = self.live.lock().unwrap();
    live.insert(
      number,
      Lease {
        window: window.to_string(),
        deadline: now + self.ttl,
      },
    );
    self.publish(&live);
    Reservation {
      token: number,
      seq: number,
    }
  }
  pub fn release(&self, token: u64) {
    let mut live = self.live.lock().unwrap();
    if live.remove(&token).is_some() {
      self.publish(&live);
    }
  }
  pub fn renew(&self, tokens: &[u64], now: Instant) {
    let mut live = self.live.lock().unwrap();
    renew_leases(&mut live, tokens, now + self.ttl);
  }
  pub fn release_window(&self, window: &str) {
    let mut live = self.live.lock().unwrap();
    if drop_window_leases(&mut live, window) {
      self.publish(&live);
    }
  }
  /// Lets go of the reservations nobody renewed.
  #[cfg(test)]
  fn expire(&self, now: Instant) {
    let mut live = self.live.lock().unwrap();
    if expire_leases(&mut live, now, "reservation") {
      self.publish(&live);
    }
  }
  /// Resolves once no live reservation is numbered `mark` or lower. It holds no
  /// thread meanwhile, and a reservation nobody renews runs out and stops
  /// holding it up.
  pub async fn released_through(&self, mark: u64) {
    let mut changes = self.low.subscribe();
    loop {
      changes.borrow_and_update();
      let due = {
        let mut live = self.live.lock().unwrap();
        if expire_leases(&mut live, Instant::now(), "reservation") {
          self.publish(&live);
        }
        match live.range(..=mark).map(|(_, lease)| lease.deadline).min() {
          None => return,
          Some(due) => due,
        }
      };
      let _ = tokio::time::timeout_at(due.into(), changes.changed()).await;
    }
  }
}

static RESERVATIONS: OnceLock<Reservations> = OnceLock::new();

fn reservations() -> &'static Reservations {
  RESERVATIONS.get_or_init(|| Reservations::new(LEASE))
}
/// The error of a pin for a clip the clipboard does not hold.
pub const NOT_OURS: &str = "not-ours";
/// The error of a pin that was released or never was.
pub const PIN_GONE: &str = "pin-gone";

struct Pinned {
  window: String,
  file: Arc<File>,
}
/// Clips held open for a paste: the file as it was when the paste found the clip
/// ours, so the paste gets that clip however the clipboard changes after. A pin
/// holds a file, not memory, so it never runs out: `clip_unpin`, its window going
/// and its page reloading let go of it.
pub struct Pins {
  live: Mutex<BTreeMap<u64, Pinned>>,
}

impl Pins {
  fn new() -> Self {
    Pins {
      live: Mutex::new(BTreeMap::new()),
    }
  }
  fn pin(&self, window: &str, file: File) -> u64 {
    let number = next_number();
    self.live.lock().unwrap().insert(
      number,
      Pinned {
        window: window.to_string(),
        file: Arc::new(file),
      },
    );
    number
  }
  fn unpin(&self, pin: u64) {
    self.live.lock().unwrap().remove(&pin);
  }
  fn release_window(&self, window: &str) {
    self
      .live
      .lock()
      .unwrap()
      .retain(|_, pinned| pinned.window != window);
  }
  /// The file of a pin that is still held.
  fn file(&self, pin: u64) -> Result<Arc<File>, String> {
    self
      .live
      .lock()
      .unwrap()
      .get(&pin)
      .map(|pinned| Arc::clone(&pinned.file))
      .ok_or_else(|| PIN_GONE.to_string())
  }
}

static PINS: OnceLock<Pins> = OnceLock::new();

fn pins() -> &'static Pins {
  PINS.get_or_init(Pins::new)
}
/// The file of the clip `pin` holds, for positional reads (`PinReader`, `read_at`).
pub fn pinned(pin: u64) -> Result<Arc<File>, String> {
  pins().file(pin)
}
/// Reads from `file` at `offset` without moving a position of its own, so reads of
/// one pin may overlap.
pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
  #[cfg(unix)]
  {
    std::os::unix::fs::FileExt::read_at(file, buf, offset)
  }
  #[cfg(windows)]
  {
    std::os::windows::fs::FileExt::seek_read(file, buf, offset)
  }
}
/// A clip read from the start with `read_at`.
pub struct PinReader {
  file: Arc<File>,
  at: u64,
}

impl PinReader {
  pub fn new(file: Arc<File>) -> Self {
    PinReader { file, at: 0 }
  }
}

impl std::io::Read for PinReader {
  fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
    let n = read_at(&self.file, buf, self.at)?;
    self.at += n as u64;
    Ok(n)
  }
}
/// Lets go of a reservation when dropped, however the copy it was for ended.
pub struct ReleaseOnDrop(pub Option<u64>);

impl Drop for ReleaseOnDrop {
  fn drop(&mut self) {
    if let Some(token) = self.0 {
      reservations().release(token);
    }
  }
}
/// How long a gate of a page may hold up a clip hand-over before the page is told to
/// give it up: the same 2 seconds after which the page stops treating the read as
/// quick (`PASTE_SLOW_MS`).
const REVOKE_AFTER: Duration = Duration::from_secs(2);
/// An open gate: its lease, when it opened and whether its window was told to give
/// it up.
struct GateEntry {
  lease: Lease,
  opened: Instant,
  revoking: bool,
}

impl Leased for GateEntry {
  fn lease(&self) -> &Lease {
    &self.lease
  }
  fn lease_mut(&mut self) -> &mut Lease {
    &mut self.lease
  }
}
/// Tells a window, by label, that the gate with this token is revoked.
type Notifier = Box<dyn Fn(&str, u64) + Send + Sync>;

struct GateState {
  gates: BTreeMap<u64, GateEntry>,
  /// Clip hand-overs under way.
  publishing: usize,
}
/// The read gate. Text from another app is read only while a gate is open, and no
/// clip is handed to the clipboard while one is, so what is read is never ours.
/// Its locks are short: nothing waits, reads a file or takes `CLIP_LOCK` while
/// holding one.
pub struct Gate {
  state: Mutex<GateState>,
  changed: Condvar,
  /// The owner and the info of the clip `CLIP_LOCK` guards, copied there so a
  /// gate can tell without it.
  ours: Mutex<Option<(u64, ClipInfo)>>,
  now: fn() -> Instant,
  ttl: Duration,
  revoke_after: Duration,
  notify: OnceLock<Notifier>,
}

impl Gate {
  pub const fn new() -> Self {
    Gate::with(Instant::now, LEASE)
  }

  const fn with(now: fn() -> Instant, ttl: Duration) -> Self {
    Gate::revoking_after(now, ttl, REVOKE_AFTER)
  }

  const fn revoking_after(now: fn() -> Instant, ttl: Duration, revoke_after: Duration) -> Self {
    Gate {
      state: Mutex::new(GateState {
        gates: BTreeMap::new(),
        publishing: 0,
      }),
      changed: Condvar::new(),
      ours: Mutex::new(None),
      now,
      ttl,
      revoke_after,
      notify: OnceLock::new(),
    }
  }
  /// Sets how a window is told its gate is revoked; once.
  pub fn set_notify(&self, notify: Notifier) {
    let _ = self.notify.set(notify);
  }

  fn set_ours(&self, ours: Option<(u64, ClipInfo)>) {
    *self.ours.lock().unwrap() = ours;
  }
  /// The clip, if `owner` is who the clipboard shows now.
  fn ours_if(&self, owner: u64) -> Option<ClipInfo> {
    match &*self.ours.lock().unwrap() {
      Some((held, info)) if *held == owner => Some(info.clone()),
      _ => None,
    }
  }

  fn insert(&self, state: &mut GateState, window: &str, now: Instant) -> u64 {
    let token = next_number();
    state.gates.insert(
      token,
      GateEntry {
        lease: Lease {
          window: window.to_string(),
          deadline: now + self.ttl,
        },
        opened: now,
        revoking: false,
      },
    );
    token
  }
  /// Opens a gate; `None` while a clip is being handed over.
  fn open(&self, window: &str) -> Option<u64> {
    let now = (self.now)();
    let mut state = self.state.lock().unwrap();
    if expire_leases(&mut state.gates, now, "gate") {
      self.changed.notify_all();
    }
    if state.publishing > 0 {
      return None;
    }
    Some(self.insert(&mut state, window, now))
  }
  /// `open`, holding on until a hand-over under way is done.
  fn open_when_idle(&self, window: &str) -> u64 {
    if let Some(token) = self.open(window) {
      return token;
    }
    tokio::task::block_in_place(|| {
      let mut state = self.state.lock().unwrap();
      while state.publishing > 0 {
        state = self.changed.wait(state).unwrap();
      }
      self.insert(&mut state, window, (self.now)())
    })
  }

  pub fn close(&self, token: u64) {
    self.end(token);
  }
  /// Closes a gate; whether it was still held when this came: not run out, not let
  /// go with its window. A gate being revoked is still held.
  pub fn end(&self, token: u64) -> bool {
    let now = (self.now)();
    let mut state = self.state.lock().unwrap();
    match state.gates.remove(&token) {
      Some(gate) => {
        self.changed.notify_all();
        gate.lease.deadline > now
      }
      None => false,
    }
  }

  pub fn renew(&self, tokens: &[u64]) {
    let deadline = (self.now)() + self.ttl;
    let mut state = self.state.lock().unwrap();
    renew_leases(&mut state.gates, tokens, deadline);
  }

  pub fn close_window(&self, window: &str) {
    let mut state = self.state.lock().unwrap();
    if drop_window_leases(&mut state.gates, window) {
      self.changed.notify_all();
    }
  }
  /// Closes the gates nobody renewed.
  #[cfg(test)]
  fn expire(&self, now: Instant) {
    let mut state = self.state.lock().unwrap();
    if expire_leases(&mut state.gates, now, "gate") {
      self.changed.notify_all();
    }
  }
  /// When the hand-over waiting for `gate` next has to look at it: when its lease
  /// runs out, or, for a page's gate not yet revoked, when it has been open long
  /// enough to be.
  fn look_at(&self, gate: &GateEntry) -> Instant {
    if gate.lease.window.is_empty() || gate.revoking {
      gate.lease.deadline
    } else {
      gate.lease.deadline.min(gate.opened + self.revoke_after)
    }
  }
  /// Marks the page gates open long enough as revoked; their windows and tokens.
  /// The gates of the backend (window `""`) are never revoked.
  fn revoke_due(&self, state: &mut GateState, now: Instant) -> Vec<(String, u64)> {
    let mut due = Vec::new();
    for (token, gate) in state.gates.iter_mut() {
      if !gate.lease.window.is_empty() && !gate.revoking && now >= gate.opened + self.revoke_after {
        gate.revoking = true;
        due.push((gate.lease.window.clone(), *token));
      }
    }
    due
  }
  /// Marks a hand-over as under way, once no gate is open. It holds on meanwhile,
  /// on a thread the runtime knows to replace, and with no lock held: a gate that
  /// is not renewed closes by itself. A page's gate open for `revoke_after` is
  /// revoked on the way: its window is told to close it, and the hand-over waits
  /// for that close like for any other.
  fn begin_publish(&self) -> Publishing<'_> {
    let ready = |state: &mut GateState| {
      if expire_leases(&mut state.gates, (self.now)(), "gate") {
        self.changed.notify_all();
      }
      state.gates.is_empty()
    };
    let mut state = self.state.lock().unwrap();
    if ready(&mut state) {
      state.publishing += 1;
      return Publishing(self);
    }
    drop(state);
    tokio::task::block_in_place(|| {
      let mut state = self.state.lock().unwrap();
      while !ready(&mut state) {
        let now = (self.now)();
        let revoked = self.revoke_due(&mut state, now);
        if !revoked.is_empty() {
          drop(state);
          if let Some(notify) = self.notify.get() {
            for (window, token) in &revoked {
              notify(window, *token);
            }
          }
          state = self.state.lock().unwrap();
          continue;
        }
        let due = state.gates.values().map(|gate| self.look_at(gate)).min();
        let pause = due.map_or(self.ttl, |due| due.saturating_duration_since(now));
        state = self.changed.wait_timeout(state, pause).unwrap().0;
      }
      state.publishing += 1;
    });
    Publishing(self)
  }
}
/// A clip hand-over under way; the gates stay shut while it lives.
struct Publishing<'a>(&'a Gate);

impl Drop for Publishing<'_> {
  fn drop(&mut self) {
    let mut state = self.0.state.lock().unwrap();
    state.publishing -= 1;
    self.0.changed.notify_all();
  }
}
/// Closes a gate when dropped.
struct Closing<'a>(&'a Gate, u64);

impl Drop for Closing<'_> {
  fn drop(&mut self) {
    self.0.close(self.1);
  }
}

pub static GATE: Gate = Gate::new();
/// What `clip_text_begin` answers.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TextBegin {
  /// The clipboard holds our clip: no gate was left open.
  Ours { info: ClipInfo },
  /// The text of the clipboard is somebody else's: read it, then close `token`.
  Gate { token: u64 },
  /// A clip is being handed over right now: ask again shortly.
  Busy,
}
/// Opens a gate for `window` and says whether the clipboard holds our clip.
fn text_begin_with<B: Board>(env: &Env<B>, window: &str) -> TextBegin {
  let Some(token) = env.gate.open(window) else {
    return TextBegin::Busy;
  };
  match env.gate.ours_if(env.board.identity()) {
    Some(info) => {
      env.gate.close(token);
      TextBegin::Ours { info }
    }
    None => TextBegin::Gate { token },
  }
}
/// Renews the reservations and gates the windows list.
fn renew_all(tokens: &[u64]) {
  reservations().renew(tokens, Instant::now());
  GATE.renew(tokens);
}
/// Lets go of everything `window` holds, and wakes the hand-overs waiting for its
/// gates.
fn reset_window(window: &str, reservations: &Reservations, pins: &Pins, gate: &Gate) {
  reservations.release_window(window);
  pins.release_window(window);
  gate.close_window(window);
}
/// The page of the window starts loading: what the old page held goes, before the
/// new page can hold anything.
pub fn window_reset(label: &str) {
  reset_window(label, reservations(), pins(), &GATE);
}
/// The window is gone: its reservations, pins and gates go with it.
pub fn window_destroyed(label: &str) {
  window_reset(label);
}
/// Tells the windows by event that a gate of theirs is revoked: `clip-gate-revoked`
/// with the token.
pub fn announce_revocations(app: tauri::AppHandle) {
  use tauri::Emitter;
  GATE.set_notify(Box::new(move |label, token| {
    let _ = app.emit_to(label, "clip-gate-revoked", token);
  }));
}
#[tauri::command]
pub fn clip_paste_mark() -> u64 {
  reservations().mark()
}
#[tauri::command]
pub fn clip_copy_reserve(window: tauri::Window) -> Reservation {
  reservations().reserve(window.label(), Instant::now())
}
#[tauri::command]
pub fn clip_copy_release(token: u64) {
  reservations().release(token);
}
#[tauri::command]
pub fn clip_copy_keepalive(tokens: Vec<u64>) {
  renew_all(&tokens);
}
#[tauri::command]
pub fn clip_text_begin(window: tauri::Window) -> TextBegin {
  text_begin_with(&platform_env(None), window.label())
}
#[tauri::command]
pub fn clip_text_end(token: u64) -> bool {
  GATE.end(token)
}
/// Runs a job on the main thread.
pub trait MainThread: Sync {
  /// Queues `job`; false when it cannot be queued.
  fn run(&self, job: Box<dyn FnOnce() + Send>) -> bool;
}

impl MainThread for tauri::AppHandle {
  fn run(&self, job: Box<dyn FnOnce() + Send>) -> bool {
    self.run_on_main_thread(job).is_ok()
  }
}
/// The system clipboard, as far as clips need it.
pub trait Board: Send + Sync + 'static {
  /// What is prepared before the lock is taken (the Windows helper).
  type Staged: Send + 'static;
  /// Prepares to offer `clip`, a finished file.
  fn stage(&self, clip: &Path) -> Result<Self::Staged, String>;
  /// Drops what `stage` prepared.
  fn discard(&self, staged: Self::Staged);
  /// The clipboard's change counter.
  fn count(&self) -> u64;
  /// What `Active::owner` is compared with.
  fn identity(&self) -> u64;
  /// Takes the clipboard for `clip`; the owner to remember.
  fn publish(&self, staged: &mut Self::Staged, clip: &Path) -> Result<u64, String>;
  /// At exit: puts the text on the clipboard for real.
  fn flush(&self, clip: &Path);
}
/// What a clip copy noted when it began.
#[derive(Clone, Copy)]
struct Ticket {
  seq: u64,
  count: u64,
}
/// Where and how long a hand-off waits.
struct Env<'a, B: Board> {
  lock: &'static Mutex<Inner>,
  gate: &'static Gate,
  board: &'a Arc<B>,
  main: Option<&'a dyn MainThread>,
  wait: Duration,
  /// Runs after a wait timed out, before the waiter looks at the hand-off.
  after_timeout: &'a dyn Fn(),
}
/// Runs `f` on the main thread and waits for its answer; `None` when it could
/// not be queued or did not answer in time. `f` may still run later.
fn ask_main<R: Send + 'static>(
  main: &dyn MainThread,
  wait: Duration,
  f: impl FnOnce() -> R + Send + 'static,
) -> Option<R> {
  let (tx, rx) = mpsc::channel();
  let job = move || {
    let _ = tx.send(f());
  };
  if !main.run(Box::new(job)) {
    return None;
  }
  rx.recv_timeout(wait).ok()
}
/// Replaces the clip the clipboard holds, and the copy of it the gate reads.
fn set_state(inner: &mut Inner, gate: &Gate, now: Option<Active>) -> Option<Active> {
  gate.set_ours(now.as_ref().map(|a| (a.owner, a.info.clone())));
  std::mem::replace(&mut inner.clip_state, now)
}
/// Takes the clipboard if this copy is still the latest and nothing else wrote
/// to it since it began. The caller removes the file on anything but `Offered`.
fn offer_locked<B: Board>(
  inner: &mut Inner,
  gate: &Gate,
  board: &B,
  ticket: &Ticket,
  written: &Written,
  staged: &mut B::Staged,
) -> ClipOutcome {
  if inner.copy_seq != ticket.seq || board.count() != ticket.count {
    return ClipOutcome::Superseded;
  }
  match board.publish(staged, &written.path) {
    Ok(owner) => {
      let now = Active {
        info: written.info.clone(),
        path: written.path.clone(),
        owner,
      };
      if let Some(old) = set_state(inner, gate, Some(now)) {
        let _ = fs::remove_file(&old.path);
      }
      ClipOutcome::Offered(written.info.clone())
    }
    Err(e) => {
      log::warn!("clip: the clipboard refused the clip: {e}");
      ClipOutcome::OfferFailed
    }
  }
}
/// The offer on this thread, the lock held throughout (Windows).
fn offer_inline<B: Board>(
  env: &Env<B>,
  ticket: Ticket,
  written: &Written,
  mut staged: B::Staged,
) -> ClipOutcome {
  let outcome = {
    let mut inner = env.lock.lock().unwrap();
    offer_locked(
      &mut inner,
      env.gate,
      &**env.board,
      &ticket,
      written,
      &mut staged,
    )
  };
  if !matches!(outcome, ClipOutcome::Offered(_)) {
    env.board.discard(staged);
    let _ = fs::remove_file(&written.path);
  }
  outcome
}
/// The offer on the main thread (macOS): queued without the lock, taken there by
/// the job itself. A wait that times out cancels the job, so a main thread that
/// wakes later does not touch the clipboard.
fn offer_on_main<B: Board>(
  env: &Env<B>,
  main: &dyn MainThread,
  ticket: Ticket,
  written: &Written,
  staged: B::Staged,
) -> ClipOutcome {
  let (lock, gate) = (env.lock, env.gate);
  let seq = ticket.seq;
  lock.lock().unwrap().handoffs.insert(seq, Handoff::Pending);
  let (tx, rx) = mpsc::channel::<()>();
  let job = {
    let board = Arc::clone(env.board);
    let written = written.clone();
    move || {
      let mut inner = lock.lock().unwrap();
      let mut staged = staged;
      if !matches!(inner.handoffs.get(&seq), Some(Handoff::Pending)) {
        board.discard(staged);
        return;
      }
      let outcome = offer_locked(&mut inner, gate, &*board, &ticket, &written, &mut staged);
      if !matches!(outcome, ClipOutcome::Offered(_)) {
        board.discard(staged);
        let _ = fs::remove_file(&written.path);
      }
      inner.handoffs.insert(seq, Handoff::Done(outcome));
      drop(inner);
      let _ = tx.send(());
    }
  };
  if !main.run(Box::new(job)) {
    lock.lock().unwrap().handoffs.remove(&seq);
    let _ = fs::remove_file(&written.path);
    return ClipOutcome::OfferFailed;
  }
  if rx.recv_timeout(env.wait).is_err() {
    (env.after_timeout)();
  }
  let mut inner = lock.lock().unwrap();
  match inner.handoffs.remove(&seq) {
    Some(Handoff::Done(outcome)) => outcome,
    _ => {
      drop(inner);
      let _ = fs::remove_file(&written.path);
      ClipOutcome::OfferFailed
    }
  }
}
/// A clip copy: notes that it began, runs `write` to make the clip and offers it.
fn copy_with<B: Board>(
  env: &Env<B>,
  write: impl FnOnce() -> Result<Written, String>,
) -> ClipOutcome {
  let seq = {
    let mut inner = env.lock.lock().unwrap();
    inner.copy_seq += 1;
    inner.copy_seq
  };
  let count = match env.main {
    Some(main) => {
      let board = Arc::clone(env.board);
      ask_main(main, env.wait, move || board.count())
    }
    None => Some(env.board.count()),
  };
  let Some(count) = count else {
    return ClipOutcome::OfferFailed;
  };
  let ticket = Ticket { seq, count };
  let written = match write() {
    Ok(written) => written,
    Err(e) => {
      log::warn!("clip: writing the clip failed: {e}");
      return ClipOutcome::OfferFailed;
    }
  };
  let staged = match env.board.stage(&written.path) {
    Ok(staged) => staged,
    Err(e) => {
      log::warn!("clip: preparing the offer failed: {e}");
      let _ = fs::remove_file(&written.path);
      return ClipOutcome::OfferFailed;
    }
  };
  // Before the hand-over, not inside it: the main thread never holds on for a gate.
  let _publishing = env.gate.begin_publish();
  match env.main {
    Some(main) => offer_on_main(env, main, ticket, &written, staged),
    None => offer_inline(env, ticket, &written, staged),
  }
}
/// The clip the clipboard holds, once checked that it still does; if not, the
/// clip is let go.
fn validate_locked<B: Board>(inner: &mut Inner, gate: &Gate, board: &B) -> Option<ClipInfo> {
  let active = inner.clip_state.as_ref()?;
  if clip_status_valid(active, board.identity()) {
    return Some(active.info.clone());
  }
  if let Some(old) = set_state(inner, gate, None) {
    let _ = fs::remove_file(&old.path);
  }
  None
}

fn status_with<B: Board>(env: &Env<B>) -> Option<ClipInfo> {
  match env.main {
    Some(main) => {
      let (lock, gate, board) = (env.lock, env.gate, Arc::clone(env.board));
      ask_main(main, env.wait, move || {
        validate_locked(&mut lock.lock().unwrap(), gate, &*board)
      })
      .flatten()
    }
    None => validate_locked(&mut env.lock.lock().unwrap(), env.gate, &**env.board),
  }
}
/// The clip file was not ours any more, or could not be opened.
#[derive(Debug, PartialEq, Eq)]
pub struct NotOurs;
/// Opens a clip file for reading.
type Opener = Arc<dyn Fn(&Path) -> std::io::Result<File> + Send + Sync>;
/// The clip `clip_id` names, opened in the same stretch of `CLIP_LOCK` that checks
/// the clipboard still holds it: a file already open reads to the end even if the
/// clip is replaced and deleted after. Nothing is opened for a clip that is not
/// ours.
fn open_with<B: Board>(
  env: &Env<B>,
  clip_id: &str,
  opener: Opener,
) -> Result<(File, ClipInfo), NotOurs> {
  let id = clip_id.to_string();
  let (lock, gate, board) = (env.lock, env.gate, Arc::clone(env.board));
  let job = move || {
    let mut inner = lock.lock().unwrap();
    let info = validate_locked(&mut inner, gate, &*board)?;
    if info.id != id {
      return None;
    }
    let path = &inner.clip_state.as_ref()?.path;
    match opener(path) {
      Ok(file) => Some((file, info)),
      Err(e) => {
        log::warn!("clip: opening the clip failed: {e}");
        None
      }
    }
  };
  let opened = match env.main {
    Some(main) => ask_main(main, env.wait, job).flatten(),
    None => job(),
  };
  opened.ok_or(NotOurs)
}
/// A clip file opened so a helper that holds it for deleting on close does not
/// stand in the way (Windows).
fn open_shared(path: &Path) -> std::io::Result<File> {
  #[cfg(windows)]
  {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_SHARE_READ | FILE_SHARE_DELETE
    OpenOptions::new().read(true).share_mode(1 | 4).open(path)
  }
  #[cfg(not(windows))]
  {
    File::open(path)
  }
}
/// What `system_text` found on the clipboard.
#[derive(Debug, PartialEq, Eq)]
pub enum SystemText {
  /// It holds our clip: paste that.
  Ours,
  /// The text of another app; `None` when there is none.
  Text(Option<String>),
}
/// Reads the clipboard's text for a paste of ours: behind a gate, after any
/// hand-over under way is done, and not at all when the clipboard holds our clip.
/// The read is on the main thread where the platform wants that.
fn system_text_with<B: Board>(
  env: &Env<B>,
  text: Arc<dyn Fn() -> Option<String> + Send + Sync>,
) -> Result<SystemText, String> {
  let token = env.gate.open_when_idle("");
  let _gate = Closing(env.gate, token);
  let (gate, board) = (env.gate, Arc::clone(env.board));
  let job = move || match gate.ours_if(board.identity()) {
    Some(_) => SystemText::Ours,
    None => SystemText::Text(text()),
  };
  match env.main {
    Some(main) => {
      ask_main(main, env.wait, job).ok_or_else(|| "the main thread did not answer".to_string())
    }
    None => Ok(job()),
  }
}
/// Checks the clip on the main thread. With `try_only` a lock somebody else holds
/// skips this check instead of waiting.
fn validate_here<B: Board>(lock: &Mutex<Inner>, gate: &Gate, board: &B, try_only: bool) {
  let mut inner = if try_only {
    match lock.try_lock() {
      Ok(inner) => inner,
      Err(_) => return,
    }
  } else {
    lock.lock().unwrap()
  };
  validate_locked(&mut inner, gate, board);
}
/// At exit, on the main thread: the text goes on the clipboard for real if the
/// clip is still ours, and the file is removed.
fn flush_with<B: Board>(lock: &Mutex<Inner>, gate: &Gate, board: &B) {
  let mut inner = lock.lock().unwrap();
  if let Some(active) = set_state(&mut inner, gate, None) {
    if clip_status_valid(&active, board.identity()) {
      board.flush(&active.path);
    }
    let _ = fs::remove_file(&active.path);
  }
}
/// Whether this platform has clips.
const HAS_CLIPS: bool = cfg!(any(target_os = "macos", target_os = "windows"));
/// Whether clips are handed to the clipboard on the main thread.
const ON_MAIN: bool = cfg!(target_os = "macos");

fn main_of(app: &tauri::AppHandle) -> Option<&dyn MainThread> {
  ON_MAIN.then_some(app as &dyn MainThread)
}
/// `copy_with`, unless the platform has no clips: then nothing is read or written.
fn copy_if<B: Board>(
  has_clips: bool,
  env: &Env<B>,
  write: impl FnOnce() -> Result<Written, String>,
) -> ClipOutcome {
  if !has_clips {
    return ClipOutcome::OfferFailed;
  }
  copy_with(env, write)
}
/// A clip copy, as a command makes it: `write` produces the clip file.
pub fn copy(
  app: &tauri::AppHandle,
  write: impl FnOnce() -> Result<Written, String>,
) -> ClipOutcome {
  copy_if(HAS_CLIPS, &platform_env(main_of(app)), write)
}
/// The environment of the commands: the real clipboard, lock and gate.
fn platform_env(main: Option<&dyn MainThread>) -> Env<'_, platform::PlatformBoard> {
  static BOARD: OnceLock<Arc<platform::PlatformBoard>> = OnceLock::new();
  Env {
    lock: &CLIP_LOCK,
    gate: &GATE,
    board: BOARD.get_or_init(|| Arc::new(platform::PlatformBoard)),
    main,
    wait: MAIN_WAIT,
    after_timeout: &|| {},
  }
}
/// What the clipboard holds of ours, if it still does. With a `mark` it first holds
/// on until every reservation numbered up to it is released: the copies pressed
/// before the paste.
#[tauri::command]
pub async fn clip_status(app: tauri::AppHandle, mark: Option<u64>) -> Option<ClipInfo> {
  if !HAS_CLIPS {
    return None;
  }
  if let Some(mark) = mark {
    reservations().released_through(mark).await;
  }
  tauri::async_runtime::spawn_blocking(move || status_with(&platform_env(main_of(&app))))
    .await
    .ok()
    .flatten()
}
/// Holds the clip `clip_id` open for `window`: the clipboard must hold it now.
fn pin_with<B: Board>(
  env: &Env<B>,
  pins: &Pins,
  window: &str,
  clip_id: &str,
  opener: Opener,
) -> Result<u64, String> {
  let (file, _) = open_with(env, clip_id, opener).map_err(|_| NOT_OURS.to_string())?;
  Ok(pins.pin(window, file))
}
/// Pins the clip `clip_id` for the calling window, which lets go with `clip_unpin`.
/// The clipboard may change after; the pin still reads the clip as it was.
/// `not-ours` when the clipboard does not hold the clip now.
#[tauri::command(async)]
pub fn clip_pin(
  app: tauri::AppHandle,
  window: tauri::Window,
  clip_id: String,
) -> Result<u64, String> {
  if !HAS_CLIPS {
    return Err(NOT_OURS.to_string());
  }
  let env = platform_env(main_of(&app));
  pin_with(
    &env,
    pins(),
    window.label(),
    &clip_id,
    Arc::new(open_shared),
  )
}
/// Lets go of a pin.
#[tauri::command(async)]
pub fn clip_unpin(pin: u64) {
  pins().unpin(pin);
}
/// What `clipboard_redispatch_paste` does with the window that asked.
#[cfg(any(target_os = "macos", test))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Redispatch {
  Send,
  NotKey,
  /// The action was sent and no responder took it.
  NotHandled,
}
/// Only the window Tauri reports focused gets the paste: it is the one whose first
/// responder the action reaches.
#[cfg(any(target_os = "macos", test))]
fn redispatch_decision(is_focused: bool) -> Redispatch {
  if is_focused {
    Redispatch::Send
  } else {
    Redispatch::NotKey
  }
}
/// `redispatch_decision`, then `send` for a window that gets the paste; `send`
/// says whether a responder handled it.
#[cfg(any(target_os = "macos", test))]
fn redispatch_with(is_focused: bool, send: impl FnOnce() -> bool) -> Redispatch {
  match redispatch_decision(is_focused) {
    Redispatch::Send if !send() => Redispatch::NotHandled,
    decision => decision,
  }
}
/// Sends `paste:` down the responder chain of the focused window, so the page gets
/// a real `paste` event it may read; `not-key` and nothing sent when the calling
/// window is not that window, `not-handled` when no responder took the action. The
/// check and the send are one job on the main thread, so no other window takes
/// the focus in between.
#[cfg(target_os = "macos")]
#[tauri::command(async)]
pub fn clipboard_redispatch_paste(window: tauri::Window) -> Result<Redispatch, String> {
  use tauri::Manager;
  let app = window.app_handle().clone();
  ask_main(&app, MAIN_WAIT, move || {
    redispatch_with(window.is_focused().unwrap_or(false), platform::send_paste)
  })
  .ok_or_else(|| "the main thread did not answer".to_string())
}
/// The text another app put on the clipboard, read behind a gate; see
/// `system_text_with`.
pub fn system_text(app: &tauri::AppHandle) -> Result<SystemText, String> {
  if !HAS_CLIPS {
    return Ok(SystemText::Text(None));
  }
  system_text_with(&platform_env(main_of(app)), Arc::new(platform::read_text))
}
/// The app came to the front (main thread): checks the clip. Windows skips the
/// check while the arm handshake holds the lock.
pub fn validate_on_focus() {
  if HAS_CLIPS {
    validate_here(&CLIP_LOCK, &GATE, &platform::PlatformBoard, !ON_MAIN);
  }
}
/// `RunEvent::Exit` (main thread): macOS writes the text for real, since a
/// declared text does not outlive the app. On Windows the helper sees the app go.
pub fn flush_for_exit() {
  if ON_MAIN {
    flush_with(&CLIP_LOCK, &GATE, &platform::PlatformBoard);
  }
}
/// How deleting a clip at startup went.
#[derive(Debug, PartialEq, Eq)]
pub enum Delete {
  Done,
  /// Another process holds it open (a helper of an earlier run on Windows).
  Busy,
  Failed,
}
/// What a startup cleanup did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Cleanup {
  pub removed: usize,
  pub kept: Vec<PathBuf>,
  pub failed: usize,
}
/// Removes `path`; on Windows a sharing violation is `Busy`.
pub fn delete_clip(path: &Path) -> Delete {
  match fs::remove_file(path) {
    Ok(()) => Delete::Done,
    Err(e) if cfg!(windows) && e.raw_os_error() == Some(32) => Delete::Busy,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Delete::Done,
    Err(_) => Delete::Failed,
  }
}
/// Deletes the clips an earlier run left in `dir`, with `try_delete`. One still
/// open elsewhere stays: its holder deletes it when it closes.
pub fn cleanup_clips(dir: &Path, try_delete: &dyn Fn(&Path) -> Delete) -> Cleanup {
  let mut report = Cleanup::default();
  let Ok(entries) = fs::read_dir(dir) else {
    return report;
  };
  for entry in entries.flatten() {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    if !(name.starts_with(FILE_PREFIX) && name.ends_with(FILE_SUFFIX)) {
      continue;
    }
    match try_delete(&entry.path()) {
      Delete::Done => report.removed += 1,
      Delete::Busy => report.kept.push(entry.path()),
      Delete::Failed => report.failed += 1,
    }
  }
  report
}
/// `cleanup_clips` at startup.
pub fn cleanup_startup(dir: &Path) {
  let report = cleanup_clips(dir, &delete_clip);
  if report.failed > 0 {
    log::warn!("clip: {} earlier clips could not be removed", report.failed);
  }
}

#[cfg(target_os = "macos")]
// The provider methods carry the protocol's names.
#[allow(non_snake_case)]
mod platform {
  use super::*;
  use objc2::rc::Retained;
  use objc2::runtime::ProtocolObject;
  use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker};
  use objc2_app_kit::{
    NSPasteboard, NSPasteboardItem, NSPasteboardItemDataProvider, NSPasteboardType,
    NSPasteboardTypeString, NSPasteboardWriting,
  };
  use objc2_foundation::{
    NSArray, NSData, NSDataReadingOptions, NSObject, NSObjectProtocol, NSString,
  };
  use std::cell::RefCell;

  struct ProviderIvars {
    path: String,
  }

  define_class!(
    /// Supplies the clip's text when another app pastes: the file mapped, not read.
    /// The pasteboard calls it on whatever thread it likes, and `clearContents`
    /// calls the second method before it returns while the lock is held, so
    /// neither touches the clip lock or its state.
    #[unsafe(super(NSObject))]
    #[name = "NoteNPadClipProvider"]
    #[ivars = ProviderIvars]
    struct ClipProvider;

    unsafe impl NSObjectProtocol for ClipProvider {}

    unsafe impl NSPasteboardItemDataProvider for ClipProvider {
      #[unsafe(method(pasteboard:item:provideDataForType:))]
      fn pasteboard_item_provideDataForType(
        &self,
        _pasteboard: Option<&NSPasteboard>,
        item: &NSPasteboardItem,
        r#type: &NSPasteboardType,
      ) {
        let path = NSString::from_str(&self.ivars().path);
        let mapped =
          NSData::dataWithContentsOfFile_options_error(&path, NSDataReadingOptions::MappedIfSafe);
        if let Ok(data) = mapped {
          item.setData_forType(&data, r#type);
        }
      }

      #[unsafe(method(pasteboardFinishedWithDataProvider:))]
      fn pasteboardFinishedWithDataProvider(&self, _pasteboard: &NSPasteboard) {}
    }
  );

  impl ClipProvider {
    fn new(path: &Path) -> Retained<Self> {
      let this = Self::alloc().set_ivars(ProviderIvars {
        path: path.to_string_lossy().into_owned(),
      });
      unsafe { msg_send![super(this), init] }
    }
  }

  thread_local! {
    /// The declared item and its provider, which the pasteboard does not retain.
    /// Only the main thread touches them.
    static HELD: RefCell<Option<(Retained<NSPasteboardItem>, Retained<ClipProvider>)>> =
      const { RefCell::new(None) };
  }

  fn map(clip: &Path) -> Option<Retained<NSData>> {
    let path = NSString::from_str(&clip.to_string_lossy());
    NSData::dataWithContentsOfFile_options_error(&path, NSDataReadingOptions::MappedIfSafe).ok()
  }
  /// `paste:` to the first responder of the window in focus (main thread); whether
  /// a responder handled it.
  pub fn send_paste() -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
      return false;
    };
    let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
    let none: *const objc2::runtime::AnyObject = std::ptr::null();
    // Safety: `sendAction:to:from:` takes a selector and two nullable objects; a
    // nil target means the first responder that handles it.
    unsafe { msg_send![&*app, sendAction: sel!(paste:), to: none, from: none] }
  }
  /// The text on the pasteboard, if there is any (main thread).
  pub fn read_text() -> Option<String> {
    NSPasteboard::generalPasteboard()
      .stringForType(unsafe { NSPasteboardTypeString })
      .map(|text| text.to_string())
  }
  /// The pasteboard; every method here runs on the main thread.
  pub struct PlatformBoard;

  impl Board for PlatformBoard {
    type Staged = ();
    fn stage(&self, _clip: &Path) -> Result<(), String> {
      Ok(())
    }
    fn discard(&self, _staged: ()) {}
    fn count(&self) -> u64 {
      NSPasteboard::generalPasteboard().changeCount() as u64
    }
    fn identity(&self) -> u64 {
      self.count()
    }
    fn publish(&self, _staged: &mut (), clip: &Path) -> Result<u64, String> {
      let pasteboard = NSPasteboard::generalPasteboard();
      pasteboard.clearContents();
      // The old provider is done once the contents are cleared.
      HELD.with(|held| held.borrow_mut().take());
      let provider = ClipProvider::new(clip);
      let item = NSPasteboardItem::new();
      let types = NSArray::from_slice(&[unsafe { NSPasteboardTypeString }]);
      if !item.setDataProvider_forTypes(ProtocolObject::from_ref(&*provider), &types) {
        return Err("setDataProvider failed".to_string());
      }
      let objects =
        NSArray::from_retained_slice(&[ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
          item.clone(),
        )]);
      if !pasteboard.writeObjects(&objects) {
        return Err("writeObjects failed".to_string());
      }
      HELD.with(|held| *held.borrow_mut() = Some((item, provider)));
      Ok(pasteboard.changeCount() as u64)
    }
    fn flush(&self, clip: &Path) {
      let Some(data) = map(clip) else {
        return;
      };
      let pasteboard = NSPasteboard::generalPasteboard();
      pasteboard.clearContents();
      HELD.with(|held| held.borrow_mut().take());
      pasteboard.setData_forType(Some(&data), unsafe { NSPasteboardTypeString });
    }
  }

  #[cfg(test)]
  mod tests {
    use super::*;
    /// The provider answers a paste from the mapped file, on a pasteboard of its
    /// own so the user's clipboard stays alone.
    #[test]
    fn the_provider_supplies_the_clip_file_to_a_paste() {
      let dir = tempfile::tempdir().unwrap();
      let path = dir.path().join("clip-1-0-1.txt");
      let text = "line one\r\nline \u{1F600} two\n";
      std::fs::write(&path, text).unwrap();
      /// Releases the unique pasteboard however the test ends.
      struct Release(Retained<NSPasteboard>);
      impl Drop for Release {
        fn drop(&mut self) {
          let _: () = unsafe { msg_send![&*self.0, releaseGlobally] };
        }
      }
      let guard = Release(NSPasteboard::pasteboardWithUniqueName());
      let pasteboard = &*guard.0;
      pasteboard.clearContents();
      let provider = ClipProvider::new(&path);
      let item = NSPasteboardItem::new();
      let types = NSArray::from_slice(&[unsafe { NSPasteboardTypeString }]);
      assert!(item.setDataProvider_forTypes(ProtocolObject::from_ref(&*provider), &types));
      let objects =
        NSArray::from_retained_slice(&[ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
          item.clone(),
        )]);
      assert!(pasteboard.writeObjects(&objects));
      let read = pasteboard.stringForType(unsafe { NSPasteboardTypeString });
      assert_eq!(read.map(|s| s.to_string()), Some(text.to_string()));
      // Clearing runs the finished callback before it returns; it must not hang.
      pasteboard.clearContents();
    }
  }
}

#[cfg(target_os = "windows")]
mod platform {
  use super::*;
  use std::io::{BufRead, BufReader};
  use std::os::windows::process::CommandExt;
  use std::process::{Child, ChildStdin, Command, Stdio};
  use windows_sys::Win32::System::DataExchange::{GetClipboardOwner, GetClipboardSequenceNumber};
  use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

  const DETACHED_PROCESS: u32 = 0x0000_0008;
  const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
  const HELPER_EXE: &str = "cliphelper.exe";
  const PARENT_PID_VAR: &str = "NOTENPAD_CLIP_PARENT_PID";
  /// A started helper that holds the clip open and waits to be armed.
  pub struct Staged {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
  }

  fn answer(lines: &mpsc::Receiver<String>) -> Option<String> {
    lines.recv_timeout(MAIN_WAIT).ok()
  }
  /// The Unicode text on the clipboard, if there is any.
  pub fn read_text() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{
      CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    const CF_UNICODETEXT: u32 = 13;
    // Safety: the clipboard is open while its handle is used, and the locked
    // block is a NUL-terminated UTF-16 string, copied before it is unlocked.
    unsafe {
      if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
        return None;
      }
      // Another program may have it open for a moment.
      let opened = (0..20).any(|_| {
        let ok = OpenClipboard(std::ptr::null_mut()) != 0;
        if !ok {
          std::thread::sleep(Duration::from_millis(10));
        }
        ok
      });
      if !opened {
        return None;
      }
      let handle = GetClipboardData(CF_UNICODETEXT);
      let mut text = None;
      if !handle.is_null() {
        let units = GlobalLock(handle) as *const u16;
        if !units.is_null() {
          let mut len = 0;
          while *units.add(len) != 0 {
            len += 1;
          }
          text = Some(String::from_utf16_lossy(std::slice::from_raw_parts(
            units, len,
          )));
          GlobalUnlock(handle);
        }
      }
      CloseClipboard();
      text
    }
  }
  /// The clipboard through the helper program and the Win32 counters.
  pub struct PlatformBoard;

  impl Board for PlatformBoard {
    type Staged = Staged;
    fn stage(&self, clip: &Path) -> Result<Staged, String> {
      let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name(HELPER_EXE);
      if !exe.is_file() {
        return Err(format!("{} is missing", exe.display()));
      }
      let mut child = Command::new(exe)
        .arg(clip)
        .env(PARENT_PID_VAR, std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map_err(|e| e.to_string())?;
      let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return Err("the helper has no pipes".to_string());
      };
      let (tx, lines) = mpsc::channel();
      std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
          if tx.send(line).is_err() {
            break;
          }
        }
      });
      let mut staged = Staged {
        child,
        stdin,
        lines,
      };
      if answer(&staged.lines).as_deref() == Some("ready") {
        Ok(staged)
      } else {
        self.discard_in_place(&mut staged);
        Err("the helper did not open the clip".to_string())
      }
    }
    fn discard(&self, mut staged: Staged) {
      self.discard_in_place(&mut staged);
    }
    fn count(&self) -> u64 {
      u64::from(unsafe { GetClipboardSequenceNumber() })
    }
    fn identity(&self) -> u64 {
      let mut pid = 0u32;
      let owner = unsafe { GetClipboardOwner() };
      if !owner.is_null() {
        unsafe { GetWindowThreadProcessId(owner, &mut pid) };
      }
      u64::from(pid)
    }
    fn publish(&self, staged: &mut Staged, _clip: &Path) -> Result<u64, String> {
      writeln!(staged.stdin, "arm")
        .and_then(|()| staged.stdin.flush())
        .map_err(|e| e.to_string())?;
      match answer(&staged.lines).as_deref() {
        Some("armed") => Ok(u64::from(staged.child.id())),
        other => Err(format!("the helper answered {other:?}")),
      }
    }
    fn flush(&self, _clip: &Path) {}
  }

  impl PlatformBoard {
    /// Ends the helper; the clip goes with it, as it holds the file open.
    fn discard_in_place(&self, staged: &mut Staged) {
      let _ = staged.child.kill();
      let _ = staged.child.wait();
    }
  }

  #[cfg(test)]
  mod tests {
    use super::*;
    use windows_sys::Win32::System::DataExchange::{
      CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
      GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    /// Puts `text` on the clipboard as Unicode text, the way any program does.
    fn put_text(text: &str) {
      let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
      // Safety: the block is sized for the units, filled while locked, and handed
      // to the clipboard, which owns it from then on.
      unsafe {
        let opened = (0..50).any(|_| {
          let ok = OpenClipboard(std::ptr::null_mut()) != 0;
          if !ok {
            std::thread::sleep(Duration::from_millis(20));
          }
          ok
        });
        assert!(opened, "the clipboard could not be opened");
        EmptyClipboard();
        let block = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2);
        assert!(!block.is_null());
        let at = GlobalLock(block) as *mut u16;
        std::ptr::copy_nonoverlapping(units.as_ptr(), at, units.len());
        GlobalUnlock(block);
        assert!(!SetClipboardData(13, block).is_null());
        CloseClipboard();
      }
    }

    #[test]
    fn unicode_text_on_the_clipboard_is_read_whole() {
      let text = "line one\r\nsecond \u{1F600} \u{65E5}\u{672C}\r\n";
      put_text(text);
      assert_eq!(read_text().as_deref(), Some(text));
    }
  }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
  use super::*;
  /// No clips here, so no text is read for them either.
  pub fn read_text() -> Option<String> {
    None
  }
  /// No clips here: every offer fails before anything is read.
  pub struct PlatformBoard;

  impl Board for PlatformBoard {
    type Staged = ();
    fn stage(&self, _clip: &Path) -> Result<(), String> {
      Err("no clipboard clips on this platform".to_string())
    }
    fn discard(&self, _staged: ()) {}
    fn count(&self) -> u64 {
      0
    }
    fn identity(&self) -> u64 {
      0
    }
    fn publish(&self, _staged: &mut (), _clip: &Path) -> Result<u64, String> {
      Err("no clipboard clips on this platform".to_string())
    }
    fn flush(&self, _clip: &Path) {}
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicBool, AtomicUsize};
  use tempfile::{tempdir, TempDir};

  const SOURCE: &str = include_str!("clipboard_store.rs");
  /// A lock of its own, as the offers need a `'static` one.
  fn own_lock() -> &'static Mutex<Inner> {
    Box::leak(Box::new(Mutex::new(Inner::new())))
  }
  /// A clipboard that counts what is done to it. A publish bumps the change
  /// counter and takes the clipboard, as a pasteboard declaration does.
  #[derive(Default)]
  struct Fake {
    count: AtomicU64,
    owner: AtomicU64,
    publishes: AtomicUsize,
    discards: AtomicUsize,
    refuse: AtomicBool,
    /// A publish holds on while this is set, as a stuck handshake does.
    stall: AtomicBool,
    flushed: Mutex<Vec<PathBuf>>,
  }

  impl Board for Fake {
    type Staged = ();
    fn stage(&self, _clip: &Path) -> Result<(), String> {
      Ok(())
    }
    fn discard(&self, _staged: ()) {
      self.discards.fetch_add(1, Ordering::SeqCst);
    }
    fn count(&self) -> u64 {
      self.count.load(Ordering::SeqCst)
    }
    fn identity(&self) -> u64 {
      self.owner.load(Ordering::SeqCst)
    }
    fn publish(&self, _staged: &mut (), _clip: &Path) -> Result<u64, String> {
      self.publishes.fetch_add(1, Ordering::SeqCst);
      while self.stall.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(1));
      }
      if self.refuse.load(Ordering::SeqCst) {
        return Err("refused".to_string());
      }
      let now = self.count.fetch_add(1, Ordering::SeqCst) + 1;
      self.owner.store(now, Ordering::SeqCst);
      Ok(now)
    }
    fn flush(&self, clip: &Path) {
      self.flushed.lock().unwrap().push(clip.to_path_buf());
    }
  }
  /// A main thread that answers the first `answers` jobs on the spot and keeps
  /// the rest until `run_all`.
  struct Queue {
    answers: AtomicUsize,
    jobs: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
    refuse: bool,
  }

  impl Queue {
    fn new(answers: usize) -> Self {
      Queue {
        answers: AtomicUsize::new(answers),
        jobs: Mutex::new(Vec::new()),
        refuse: false,
      }
    }
    fn run_all(&self) {
      loop {
        let job = {
          let mut jobs = self.jobs.lock().unwrap();
          if jobs.is_empty() {
            return;
          }
          jobs.remove(0)
        };
        job();
      }
    }
  }

  impl MainThread for Queue {
    fn run(&self, job: Box<dyn FnOnce() + Send>) -> bool {
      if self.refuse {
        return false;
      }
      let left = self.answers.load(Ordering::SeqCst);
      if left > 0 {
        self.answers.store(left - 1, Ordering::SeqCst);
        job();
      } else {
        self.jobs.lock().unwrap().push(job);
      }
      true
    }
  }
  /// A main thread that runs every job on a thread of its own, at once.
  struct Prompt;

  impl MainThread for Prompt {
    fn run(&self, job: Box<dyn FnOnce() + Send>) -> bool {
      std::thread::spawn(job);
      true
    }
  }

  fn env<'a>(
    lock: &'static Mutex<Inner>,
    board: &'a Arc<Fake>,
    main: Option<&'a dyn MainThread>,
    wait: Duration,
    after_timeout: &'a dyn Fn(),
  ) -> Env<'a, Fake> {
    Env {
      lock,
      gate: own_gate(),
      board,
      main,
      wait,
      after_timeout,
    }
  }
  /// A gate of its own, for the same reason.
  fn own_gate() -> &'static Gate {
    Box::leak(Box::new(Gate::new()))
  }
  /// A finished clip holding `text`.
  fn clip(dir: &TempDir, text: &str) -> Result<Written, String> {
    let mut writer = ClipWriter::create(dir.path(), false)?;
    writer.push(text.as_bytes())?;
    writer.finish()
  }

  fn state_info(lock: &Mutex<Inner>) -> Option<ClipInfo> {
    lock
      .lock()
      .unwrap()
      .clip_state
      .as_ref()
      .map(|a| a.info.clone())
  }

  fn clip_files(dir: &TempDir) -> usize {
    fs::read_dir(dir.path())
      .unwrap()
      .flatten()
      .filter(|e| e.file_name().to_string_lossy().starts_with(FILE_PREFIX))
      .count()
  }
  /// Runs `f` on a thread and says whether it finished within `limit`.
  fn finishes_within(limit: Duration, f: impl FnOnce() + Send + 'static) -> bool {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
      f();
      let _ = tx.send(());
    });
    rx.recv_timeout(limit).is_ok()
  }
  // --- names and text ---------------------------------------------------------

  #[test]
  fn two_runs_never_name_a_clip_alike() {
    // Two runs both start counting at 0, and may start in the same instant.
    assert_ne!(clip_file_name(100, 0, 5), clip_file_name(200, 0, 5));
    assert_ne!(clip_file_name(100, 0, 5), clip_file_name(100, 1, 5));
    assert_ne!(clip_file_name(100, 0, 5), clip_file_name(100, 0, 6));
    assert_eq!(clip_file_name(7, 3, 9), "clip-7-3-9.txt");
    let dir = tempdir().unwrap();
    let made = clip(&dir, "x").unwrap();
    let name = made
      .path
      .file_name()
      .unwrap()
      .to_string_lossy()
      .into_owned();
    assert!(name.starts_with(&format!("clip-{}-", std::process::id())));
    assert!(name.ends_with(".txt"));
    assert_eq!(name, format!("clip-{}.txt", made.info.id));
  }
  /// Splits `bytes` in `n` pieces at every choice of cut points.
  fn splits(bytes: &[u8], n: usize) -> Vec<Vec<&[u8]>> {
    fn go<'a>(rest: &'a [u8], n: usize, out: &mut Vec<Vec<&'a [u8]>>, now: &mut Vec<&'a [u8]>) {
      if n == 1 {
        now.push(rest);
        out.push(now.clone());
        now.pop();
        return;
      }
      for cut in 0..=rest.len() {
        now.push(&rest[..cut]);
        go(&rest[cut..], n - 1, out, now);
        now.pop();
      }
    }
    let mut out = Vec::new();
    go(bytes, n, &mut out, &mut Vec::new());
    out
  }

  fn lossy_of(pieces: &[&[u8]]) -> Vec<u8> {
    let mut lossy = Lossy::default();
    let mut out = Vec::new();
    for piece in pieces {
      lossy.push(piece, &mut out);
    }
    lossy.finish(&mut out);
    out
  }

  #[test]
  fn invalid_utf8_becomes_what_from_utf8_lossy_makes_however_it_is_cut() {
    let cases: [&[u8]; 9] = [
      b"a\xFFb",
      b"a\xE4\xB8",
      b"\xE4\xB8x",
      b"\xF0\x9F\x98",
      b"\xF0\x9F\x98x\xC3",
      b"\xC0\x80\xED\xA0\x80z",
      b"ok \xE2\x82\xAC \xF0\x9F\x98\x80 \xFF\xFE end",
      b"\xE4\xB8\xE4\xB8\xAD",
      b"\x80\x80\xF4\x90\x80\x80",
    ];
    for bytes in cases {
      let want = String::from_utf8_lossy(bytes).into_owned().into_bytes();
      for n in 1..=3 {
        for pieces in splits(bytes, n) {
          assert_eq!(
            lossy_of(&pieces),
            want,
            "{bytes:?} in {} pieces",
            pieces.len()
          );
        }
      }
    }
  }

  #[test]
  fn a_clip_counts_what_it_holds() {
    let dir = tempdir().unwrap();
    let text = "a\r\nb\n\u{1F600}é\r";
    let made = clip(&dir, text).unwrap();
    assert_eq!(fs::read(&made.path).unwrap(), text.as_bytes());
    assert_eq!(made.info.bytes, text.len() as u64);
    assert_eq!(made.info.utf16_len, text.encode_utf16().count() as u64);
    // \r\n, \n and the final \r are three breaks.
    assert_eq!(made.info.lines, 4);
    assert!(!made.info.linewise);
    let empty = clip(&dir, "").unwrap();
    assert_eq!(
      (empty.info.bytes, empty.info.lines, empty.info.utf16_len),
      (0, 0, 0)
    );
    let mut writer = ClipWriter::create(dir.path(), true).unwrap();
    writer.push(b"one").unwrap();
    let one = writer.finish().unwrap();
    assert_eq!((one.info.lines, one.info.linewise), (1, true));
  }

  #[test]
  fn a_clip_of_invalid_utf8_is_valid_utf8_and_counted_as_written() {
    let dir = tempdir().unwrap();
    let bytes = b"x\xE4\xB8 \xFF y\xF0\x9F";
    let mut writer = ClipWriter::create(dir.path(), false).unwrap();
    for piece in bytes.chunks(3) {
      writer.push(piece).unwrap();
    }
    let made = writer.finish().unwrap();
    let want = String::from_utf8_lossy(bytes).into_owned();
    assert_eq!(fs::read(&made.path).unwrap(), want.as_bytes());
    assert_eq!(made.info.bytes, want.len() as u64);
    assert_eq!(made.info.utf16_len, want.encode_utf16().count() as u64);
  }

  #[test]
  fn a_clip_given_up_leaves_no_file() {
    let dir = tempdir().unwrap();
    let mut writer = ClipWriter::create(dir.path(), false).unwrap();
    writer.push(b"half").unwrap();
    assert_eq!(clip_files(&dir), 1);
    drop(writer);
    assert_eq!(clip_files(&dir), 0);
  }
  // --- order and state --------------------------------------------------------

  #[test]
  fn a_copy_that_ends_inside_another_supersedes_it_by_the_counter() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let env = env(lock, &board, None, MAIN_WAIT, &hook);
    let mut later = None;
    let mut later_path = None;
    let first = copy_with(&env, || {
      // The second copy begins and ends while the first is still being written.
      later = Some(copy_with(&env, || {
        let made = clip(&dir, "second")?;
        later_path = Some(made.path.clone());
        Ok(made)
      }));
      clip(&dir, "first")
    });
    assert_eq!(first, ClipOutcome::Superseded);
    let ClipOutcome::Offered(info) = later.unwrap() else {
      panic!("the later copy must be offered");
    };
    assert_eq!(info.bytes, 6);
    assert_eq!(state_info(lock), Some(info));
    assert_eq!(board.publishes.load(Ordering::SeqCst), 1);
    assert_eq!(clip_files(&dir), 1, "only the later clip is left");
    assert!(later_path.unwrap().exists());
  }

  #[test]
  fn of_two_overlapping_copies_only_the_later_is_offered() {
    // The first copy is ready to offer while the second, which began after it, is
    // still being written: the first must not take the clipboard.
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let (began_tx, began_rx) = mpsc::channel();
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let (first, second) = std::thread::scope(|scope| {
      let (board, dir) = (&board, &dir);
      let second = scope.spawn(move || {
        let hook = || {};
        let env = env(lock, board, None, MAIN_WAIT, &hook);
        copy_with(&env, || {
          began_tx.send(()).unwrap();
          go_rx.recv().unwrap();
          clip(dir, "second")
        })
      });
      let hook = || {};
      let env = env(lock, board, None, MAIN_WAIT, &hook);
      let first = copy_with(&env, || {
        began_rx.recv().unwrap();
        clip(dir, "first")
      });
      go_tx.send(()).unwrap();
      (first, second.join().unwrap())
    });
    assert_eq!(first, ClipOutcome::Superseded);
    let ClipOutcome::Offered(info) = second else {
      panic!("the later copy must be offered: {second:?}");
    };
    assert_eq!(info.bytes, 6);
    assert_eq!(state_info(lock), Some(info));
    assert_eq!(board.publishes.load(Ordering::SeqCst), 1);
    assert_eq!(clip_files(&dir), 1, "only the later clip is left");
  }

  #[test]
  fn a_clipboard_write_during_the_copy_supersedes_it() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let env = env(lock, &board, None, MAIN_WAIT, &hook);
    let out = copy_with(&env, || {
      // Another app, or a text copy of ours, writes to the clipboard.
      board.count.fetch_add(1, Ordering::SeqCst);
      clip(&dir, "text")
    });
    assert_eq!(out, ClipOutcome::Superseded);
    assert_eq!(board.publishes.load(Ordering::SeqCst), 0);
    assert_eq!(state_info(lock), None);
    assert_eq!(clip_files(&dir), 0);
  }

  #[test]
  fn a_refused_offer_fails_keeps_the_old_clip_and_removes_its_own_file() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let env = env(lock, &board, None, MAIN_WAIT, &hook);
    let ClipOutcome::Offered(old) = copy_with(&env, || clip(&dir, "old")) else {
      panic!("the first copy must be offered");
    };
    board.refuse.store(true, Ordering::SeqCst);
    let out = copy_with(&env, || clip(&dir, "new"));
    assert_eq!(out, ClipOutcome::OfferFailed);
    assert_eq!(state_info(lock), Some(old));
    assert_eq!(
      clip_files(&dir),
      1,
      "the old clip stays, the new one is gone"
    );
    assert_eq!(board.discards.load(Ordering::SeqCst), 1);
  }

  #[test]
  fn a_failure_to_write_the_clip_fails_the_offer() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let env = env(lock, &board, None, MAIN_WAIT, &hook);
    let out = copy_with(&env, || {
      let _ = &dir;
      Err("disk full".to_string())
    });
    assert_eq!(out, ClipOutcome::OfferFailed);
    assert_eq!(board.publishes.load(Ordering::SeqCst), 0);
  }

  #[test]
  fn a_platform_without_clips_reads_and_writes_nothing() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let env = env(lock, &board, None, MAIN_WAIT, &hook);
    let out = copy_if(false, &env, || -> Result<Written, String> {
      panic!("nothing may be read or written")
    });
    assert_eq!(out, ClipOutcome::OfferFailed);
    assert_eq!(clip_files(&dir), 0);
    assert_eq!(lock.lock().unwrap().copy_seq, 0);
  }

  #[test]
  fn a_new_clip_takes_the_place_of_the_old_one_and_its_file() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let env = env(lock, &board, None, MAIN_WAIT, &hook);
    let mut first_path = None;
    let first = copy_with(&env, || {
      let made = clip(&dir, "first")?;
      first_path = Some(made.path.clone());
      Ok(made)
    });
    assert!(matches!(first, ClipOutcome::Offered(_)));
    let second = copy_with(&env, || clip(&dir, "second one"));
    let ClipOutcome::Offered(info) = second else {
      panic!("the second copy must be offered");
    };
    assert_eq!(state_info(lock), Some(info));
    assert!(!first_path.unwrap().exists());
    assert_eq!(clip_files(&dir), 1);
  }

  #[test]
  fn a_status_is_only_given_while_the_clipboard_is_still_ours() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let env = env(lock, &board, None, MAIN_WAIT, &hook);
    let ClipOutcome::Offered(info) = copy_with(&env, || clip(&dir, "text")) else {
      panic!("the copy must be offered");
    };
    assert_eq!(status_with(&env), Some(info));
    // Somebody else takes the clipboard.
    board.owner.store(999, Ordering::SeqCst);
    assert_eq!(status_with(&env), None);
    assert_eq!(
      state_info(lock),
      None,
      "the state is none after a failed check"
    );
    assert_eq!(clip_files(&dir), 0, "and the file is gone");
    assert_eq!(status_with(&env), None);
  }

  #[test]
  fn the_outcome_reaches_the_frontend_as_a_tagged_object() {
    let info = ClipInfo {
      id: "1-2-3".to_string(),
      bytes: 10,
      lines: 2,
      utf16_len: 9,
      crlf: 1,
      linewise: true,
    };
    assert_eq!(
      serde_json::to_value(ClipOutcome::Offered(info)).unwrap(),
      serde_json::json!({
        "kind": "offered",
        "id": "1-2-3",
        "bytes": 10,
        "lines": 2,
        "utf16_len": 9,
        "crlf": 1,
        "linewise": true
      })
    );
    assert_eq!(
      serde_json::to_value(ClipOutcome::Superseded).unwrap(),
      serde_json::json!({ "kind": "superseded" })
    );
    assert_eq!(
      serde_json::to_value(ClipOutcome::OfferFailed).unwrap(),
      serde_json::json!({ "kind": "offer_failed" })
    );
  }

  #[test]
  fn the_owner_is_valid_only_when_it_is_what_the_board_reports() {
    let active = Active {
      info: ClipInfo {
        id: "1".to_string(),
        bytes: 0,
        lines: 0,
        utf16_len: 0,
        crlf: 0,
        linewise: false,
      },
      path: PathBuf::new(),
      owner: 42,
    };
    assert!(clip_status_valid(&active, 42));
    assert!(!clip_status_valid(&active, 43));
    assert!(!clip_status_valid(&active, 0));
  }
  // --- the main thread and the lock -------------------------------------------

  #[test]
  fn an_offer_on_the_main_thread_publishes_there() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let env = env(lock, &board, Some(&Prompt), MAIN_WAIT, &hook);
    let out = copy_with(&env, || clip(&dir, "text"));
    assert!(matches!(out, ClipOutcome::Offered(_)));
    assert_eq!(board.publishes.load(Ordering::SeqCst), 1);
    assert!(lock.lock().unwrap().handoffs.is_empty());
  }

  #[test]
  fn a_main_thread_that_does_not_answer_fails_the_offer_in_time_and_stays_out_of_it() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    // It answers the change counter at the start, then stops.
    let queue = Queue::new(1);
    let wait = Duration::from_millis(200);
    let env = env(lock, &board, Some(&queue), wait, &hook);
    let began = std::time::Instant::now();
    let out = copy_with(&env, || clip(&dir, "text"));
    assert_eq!(out, ClipOutcome::OfferFailed);
    assert!(
      began.elapsed() < Duration::from_secs(3),
      "took {:?}",
      began.elapsed()
    );
    assert_eq!(clip_files(&dir), 0, "the clip is deleted");
    assert_eq!(state_info(lock), None);
    assert!(
      lock.lock().unwrap().handoffs.is_empty(),
      "a waiter that gave up leaves nothing behind, if the job never runs"
    );
    // The main thread comes back: it must leave the clipboard alone.
    queue.run_all();
    assert_eq!(
      board.publishes.load(Ordering::SeqCst),
      0,
      "no clearContents"
    );
    assert_eq!(state_info(lock), None);
    assert!(lock.lock().unwrap().handoffs.is_empty());
  }

  #[test]
  fn a_wait_that_times_out_as_the_job_finishes_leaves_one_consistent_result() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let queue = Arc::new(Queue::new(1));
    let stuck = Arc::new(AtomicBool::new(false));
    // The main thread runs the job after the wait timed out, before the waiter
    // looks at it. It is a thread of its own, as the real one is, and a job that
    // cannot finish while the waiter is here fails the test instead of hanging it.
    let hook = {
      let (queue, stuck) = (Arc::clone(&queue), Arc::clone(&stuck));
      move || {
        let (tx, rx) = mpsc::channel();
        let queue = Arc::clone(&queue);
        std::thread::spawn(move || {
          queue.run_all();
          let _ = tx.send(());
        });
        if rx.recv_timeout(Duration::from_secs(2)).is_err() {
          stuck.store(true, Ordering::SeqCst);
        }
      }
    };
    let env = env(
      lock,
      &board,
      Some(&*queue),
      Duration::from_millis(100),
      &hook,
    );
    let out = copy_with(&env, || clip(&dir, "text"));
    assert!(
      !stuck.load(Ordering::SeqCst),
      "the job could not run while the waiter was waiting"
    );
    let ClipOutcome::Offered(info) = out else {
      panic!("the offer was made, so it is reported as made: {out:?}");
    };
    assert_eq!(state_info(lock), Some(info));
    assert_eq!(clip_files(&dir), 1, "the offered clip is not deleted");
    assert_eq!(board.publishes.load(Ordering::SeqCst), 1);
  }

  #[test]
  fn a_main_thread_that_cannot_be_reached_reads_nothing() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let queue = Queue::new(0);
    let env = env(
      lock,
      &board,
      Some(&queue),
      Duration::from_millis(100),
      &hook,
    );
    let out = copy_if(true, &env, || -> Result<Written, String> {
      panic!("the clip is not written when the start fails")
    });
    assert_eq!(out, ClipOutcome::OfferFailed);
    assert_eq!(clip_files(&dir), 0);
    let mut queue = Queue::new(1);
    queue.refuse = true;
    let env = Env {
      main: Some(&queue),
      ..env
    };
    assert_eq!(
      copy_with(&env, || clip(&dir, "x")),
      ClipOutcome::OfferFailed
    );
    assert_eq!(clip_files(&dir), 0);
  }

  #[test]
  fn an_offer_waiting_for_the_main_thread_holds_up_no_status_check_or_exit() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let queue = Arc::new(Queue::new(1));
    let offering = {
      let (board, queue) = (Arc::clone(&board), Arc::clone(&queue));
      let path = dir.path().to_path_buf();
      std::thread::spawn(move || {
        let hook = || {};
        let env = Env {
          lock,
          gate: own_gate(),
          board: &board,
          main: Some(&*queue),
          wait: Duration::from_secs(4),
          after_timeout: &hook,
        };
        copy_with(&env, || {
          let mut writer = ClipWriter::create(&path, false)?;
          writer.push(b"text")?;
          writer.finish()
        })
      })
    };
    // Wait until the job is queued: the offer is now waiting for the main thread.
    let queued = std::time::Instant::now();
    while queue.jobs.lock().unwrap().is_empty() {
      assert!(
        queued.elapsed() < Duration::from_secs(5),
        "the job never came"
      );
      std::thread::sleep(Duration::from_millis(5));
    }
    let limit = Duration::from_secs(1);
    let fake = Arc::clone(&board);
    assert!(
      finishes_within(limit, move || {
        let hook = || {};
        let env = Env {
          lock,
          gate: own_gate(),
          board: &fake,
          main: Some(&Prompt),
          wait: Duration::from_secs(4),
          after_timeout: &hook,
        };
        assert_eq!(status_with(&env), None);
      }),
      "a status check waited for the offer"
    );
    let fake = Arc::clone(&board);
    assert!(
      finishes_within(limit, move || validate_here(
        lock,
        &Gate::new(),
        &*fake,
        false
      )),
      "the focus check waited for the offer"
    );
    let fake = Arc::clone(&board);
    assert!(
      finishes_within(limit, move || flush_with(lock, &Gate::new(), &*fake)),
      "the exit flush waited for the offer"
    );
    queue.run_all();
    assert!(matches!(offering.join().unwrap(), ClipOutcome::Offered(_)));
  }

  #[test]
  fn a_check_on_a_main_thread_that_cannot_wait_skips_a_held_lock() {
    // Windows: the arm handshake holds the lock for up to five seconds.
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let env = env(lock, &board, None, MAIN_WAIT, &hook);
    assert!(matches!(
      copy_with(&env, || clip(&dir, "text")),
      ClipOutcome::Offered(_)
    ));
    board.owner.store(999, Ordering::SeqCst);
    let held = lock.lock().unwrap();
    let fake = Arc::clone(&board);
    assert!(
      finishes_within(Duration::from_secs(1), move || validate_here(
        lock,
        &Gate::new(),
        &*fake,
        true
      )),
      "the check must not wait"
    );
    drop(held);
    assert!(
      state_info(lock).is_some(),
      "a skipped check changes nothing"
    );
    validate_here(lock, &Gate::new(), &*board, true);
    assert!(state_info(lock).is_none(), "the next check goes through");
  }

  #[test]
  fn at_exit_a_clip_that_is_still_ours_is_written_out_and_its_file_removed() {
    let (dir, lock) = (tempdir().unwrap(), own_lock());
    let board = Arc::new(Fake::default());
    let hook = || {};
    let env = env(lock, &board, None, MAIN_WAIT, &hook);
    let mut path = None;
    let out = copy_with(&env, || {
      let made = clip(&dir, "text")?;
      path = Some(made.path.clone());
      Ok(made)
    });
    assert!(matches!(out, ClipOutcome::Offered(_)));
    flush_with(lock, &Gate::new(), &*board);
    assert_eq!(*board.flushed.lock().unwrap(), vec![path.clone().unwrap()]);
    assert!(!path.unwrap().exists());
    assert_eq!(state_info(lock), None);
    // One that is no longer ours is only removed.
    let again = copy_with(&env, || clip(&dir, "more"));
    assert!(matches!(again, ClipOutcome::Offered(_)));
    board.owner.store(999, Ordering::SeqCst);
    flush_with(lock, &Gate::new(), &*board);
    assert_eq!(board.flushed.lock().unwrap().len(), 1);
    assert_eq!(clip_files(&dir), 0);
  }

  #[test]
  fn the_main_thread_wait_is_at_most_five_seconds() {
    assert!(MAIN_WAIT <= Duration::from_secs(5));
  }
  // --- source rules -----------------------------------------------------------
  /// The text of function `name`, from its signature to its closing brace.
  fn body_of(name: &str) -> &'static str {
    let at = SOURCE
      .find(&format!("fn {name}("))
      .unwrap_or_else(|| panic!("{name} is gone"));
    let open = at + SOURCE[at..].find(") {").unwrap() + 2;
    let mut depth = 0;
    for (i, c) in SOURCE[open..].char_indices() {
      match c {
        '{' => depth += 1,
        '}' => {
          depth -= 1;
          if depth == 0 {
            return &SOURCE[at..open + i + 1];
          }
        }
        _ => {}
      }
    }
    panic!("{name} never ends");
  }

  #[test]
  fn the_provider_callbacks_touch_neither_the_lock_nor_the_state() {
    // `clearContents` calls the finished callback before it returns, with the
    // lock held, and the lock cannot be taken twice.
    for name in [
      "pasteboard_item_provideDataForType",
      "pasteboardFinishedWithDataProvider",
    ] {
      let body = body_of(name);
      for word in ["CLIP_LOCK", "clip_state", ".lock("] {
        assert!(!body.contains(word), "{name} mentions {word}");
      }
    }
    assert!(body_of("pasteboard_item_provideDataForType").contains("MappedIfSafe"));
  }
  /// Whether function `name` is an `async fn`.
  fn is_async(name: &str) -> bool {
    let at = SOURCE.find(&format!("fn {name}(")).unwrap();
    SOURCE[..at].ends_with("async ")
  }
  /// The attribute line before function `name` and its text up to the closing
  /// brace, signature included.
  fn command_of(name: &str) -> (&'static str, &'static str) {
    let needle = format!("fn {name}(");
    let at = SOURCE
      .find(&needle)
      .unwrap_or_else(|| panic!("{name} is gone"));
    let start = SOURCE[..at].rfind("\n#[").map_or(0, |i| i + 1);
    let attribute = SOURCE[start..at].lines().next().unwrap_or("");
    let open = at + SOURCE[at..].find('{').unwrap();
    let mut depth = 0;
    for (i, c) in SOURCE[open..].char_indices() {
      match c {
        '{' => depth += 1,
        '}' => {
          depth -= 1;
          if depth == 0 {
            return (attribute, &SOURCE[at..open + i + 1]);
          }
        }
        _ => {}
      }
    }
    panic!("{name} never ends");
  }

  #[test]
  fn the_commands_that_wait_or_read_files_run_off_the_main_thread() {
    // `clip_status` is an `async fn` and holds on without a thread; the other
    // one hops to the main thread and waits for it. Add a command here when it
    // joins them: a synchronous command runs on the main thread itself.
    assert_eq!(command_of("clip_status").0, "#[tauri::command]");
    assert!(is_async("clip_status"));
    for name in ["clipboard_redispatch_paste", "clip_pin", "clip_unpin"] {
      assert_eq!(command_of(name).0, "#[tauri::command(async)]", "{name}");
      assert!(!is_async(name), "{name}");
    }
  }

  #[test]
  fn the_commands_of_the_main_thread_neither_wait_nor_read_nor_take_the_lock() {
    // They run in the order they arrive, on the main thread, which also serves
    // every window: a wait or a file read there stops them all.
    for name in [
      "clip_paste_mark",
      "clip_copy_reserve",
      "clip_copy_release",
      "clip_copy_keepalive",
      "clip_text_begin",
      "clip_text_end",
    ] {
      let (attribute, text) = command_of(name);
      assert_eq!(attribute, "#[tauri::command]", "{name} must not be async");
      assert!(!is_async(name), "{name} must not be async");
      for word in ["async", "wait", "recv", "File::open", "read", "CLIP_LOCK"] {
        assert!(!text.contains(word), "{name} mentions {word}");
      }
    }
  }
  // --- line breaks ------------------------------------------------------------

  #[test]
  fn a_clip_counts_its_crlf_pairs_however_it_is_cut() {
    let dir = tempdir().unwrap();
    let crlf_of = |pieces: &[&[u8]]| {
      let mut writer = ClipWriter::create(dir.path(), false).unwrap();
      for piece in pieces {
        writer.push(piece).unwrap();
      }
      writer.finish().unwrap().info.crlf
    };
    assert_eq!(crlf_of(&[b"a\r\nb\r\nc\n"]), 2);
    assert_eq!(crlf_of(&[b"a\rb\rc\n\n\r"]), 0, "lone breaks are not pairs");
    assert_eq!(crlf_of(&[b"a\r", b"\nb"]), 1, "the pair is cut in two");
    assert_eq!(crlf_of(&[b"a\r", b"\r", b"\n"]), 1);
    assert_eq!(crlf_of(&[b"\r", b"", b"\n\r\n"]), 2);
    assert_eq!(crlf_of(&[b"\n", b"\r"]), 0);
    assert_eq!(crlf_of(&[b""]), 0);
    assert_eq!(crlf_of(&[]), 0);
    // A character cut by the end of a piece waits for the next, with a pair
    // right behind it.
    assert_eq!(crlf_of(&["é\r".as_bytes(), b"\n"]), 1);
    assert_eq!(crlf_of(&[b"\xC3", b"\xA9\r\n\xC3", b"\xA9\r", b"\n"]), 2);
    let made = clip(&dir, "x\r\ny\r\n").unwrap();
    assert_eq!((made.info.crlf, made.info.lines), (2, 3));
  }
  // --- reservations and marks -------------------------------------------------
  /// A runtime of `workers` threads that does not wait for a task stuck on one of
  /// them when the test ends, so a failure shows instead of hanging.
  struct Runtime(Option<tokio::runtime::Runtime>);

  impl std::ops::Deref for Runtime {
    type Target = tokio::runtime::Runtime;
    fn deref(&self) -> &Self::Target {
      self.0.as_ref().unwrap()
    }
  }

  impl Drop for Runtime {
    fn drop(&mut self) {
      if let Some(rt) = self.0.take() {
        rt.shutdown_background();
      }
    }
  }

  fn runtime(workers: usize) -> Runtime {
    Runtime(Some(
      tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .enable_time()
        .build()
        .unwrap(),
    ))
  }
  /// Spawns a wait for the reservations numbered up to `mark`; the receiver says
  /// when it ended.
  fn waiter(rt: &Runtime, reg: &Arc<Reservations>, mark: u64) -> mpsc::Receiver<()> {
    let (tx, rx) = mpsc::channel();
    let reg = Arc::clone(reg);
    rt.spawn(async move {
      reg.released_through(mark).await;
      let _ = tx.send(());
    });
    rx
  }
  const SOON: Duration = Duration::from_secs(5);
  const LATER: Duration = Duration::from_millis(150);

  #[test]
  fn a_paste_waits_for_the_copies_pressed_before_it_and_for_no_other() {
    let rt = runtime(2);
    let reg = Arc::new(Reservations::new(LEASE));
    let now = Instant::now();
    let first = reg.reserve("a", now);
    let second = reg.reserve("a", now);
    let mark = reg.mark();
    let after = reg.reserve("b", now);
    assert!(first.seq < second.seq && second.seq <= mark && mark < after.seq);
    let waiting = waiter(&rt, &reg, mark);
    assert!(
      waiting.recv_timeout(LATER).is_err(),
      "two copies are queued"
    );
    reg.release(second.token);
    assert!(waiting.recv_timeout(LATER).is_err(), "one is left");
    reg.release(first.token);
    assert!(
      waiting.recv_timeout(SOON).is_ok(),
      "the copy made after the mark is not waited for"
    );
    assert!(waiter(&rt, &reg, mark).recv_timeout(SOON).is_ok());
    // A mark taken when nothing is reserved needs no wait at all.
    reg.release(after.token);
    assert!(waiter(&rt, &reg, reg.mark()).recv_timeout(SOON).is_ok());
  }

  #[test]
  fn two_windows_with_a_paste_and_a_copy_each_all_finish() {
    // Each window runs its queue in order: its paste, then its copy. The calls
    // reach Rust in the order the keys were pressed, interleaved. A paste that
    // waited for every copy would wait for its own window's copy behind it.
    let rt = runtime(2);
    let reg = Arc::new(Reservations::new(LEASE));
    let now = Instant::now();
    let paste_a = reg.mark();
    let copy_a = reg.reserve("a", now);
    let paste_b = reg.mark();
    let copy_b = reg.reserve("b", now);
    let (tx, rx) = mpsc::channel();
    for (name, mark, copy) in [("a", paste_a, copy_a), ("b", paste_b, copy_b)] {
      let (reg, tx) = (Arc::clone(&reg), tx.clone());
      rt.spawn(async move {
        reg.released_through(mark).await;
        tx.send(format!("paste {name}")).unwrap();
        reg.release(copy.token);
        tx.send(format!("copy {name}")).unwrap();
      });
    }
    let mut done: Vec<String> = (0..4).map(|_| rx.recv_timeout(SOON).unwrap()).collect();
    done.sort();
    assert_eq!(done, ["copy a", "copy b", "paste a", "paste b"]);
  }

  #[test]
  fn waits_for_marks_hold_no_thread() {
    // Three waits on two workers: if a wait kept its worker, the third and the
    // release queued after them would never run.
    let rt = runtime(2);
    let reg = Arc::new(Reservations::new(LEASE));
    let held = reg.reserve("a", Instant::now());
    let mark = reg.mark();
    let waits: Vec<_> = (0..3).map(|_| waiter(&rt, &reg, mark)).collect();
    std::thread::sleep(LATER);
    let (tx, rx) = mpsc::channel();
    let release = Arc::clone(&reg);
    rt.spawn(async move {
      release.release(held.token);
      let _ = tx.send(());
    });
    assert!(rx.recv_timeout(SOON).is_ok(), "the release never ran");
    for wait in waits {
      assert!(wait.recv_timeout(SOON).is_ok());
    }
  }

  #[test]
  fn a_reservation_nobody_renews_runs_out_and_a_renewed_one_does_not() {
    let reg = Reservations::new(LEASE);
    let t0 = Instant::now();
    let kept = reg.reserve("a", t0);
    let lost = reg.reserve("a", t0);
    let live = |reg: &Reservations| reg.live.lock().unwrap().len();
    reg.expire(t0 + Duration::from_secs(14));
    assert_eq!(live(&reg), 2);
    reg.renew(&[kept.token], t0 + Duration::from_secs(14));
    reg.expire(t0 + Duration::from_secs(20));
    assert_eq!(live(&reg), 1, "only the one nobody renewed went");
    assert!(reg.live.lock().unwrap().contains_key(&kept.token));
    assert!(!reg.live.lock().unwrap().contains_key(&lost.token));
    reg.expire(t0 + Duration::from_secs(29));
    assert_eq!(live(&reg), 0, "fifteen seconds after the last renewal");
  }

  #[test]
  fn a_wait_ends_when_the_reservation_it_waits_for_runs_out() {
    let rt = runtime(2);
    let reg = Arc::new(Reservations::new(Duration::from_millis(200)));
    let lost = reg.reserve("a", Instant::now());
    let began = Instant::now();
    let waiting = waiter(&rt, &reg, reg.mark());
    assert!(waiting.recv_timeout(SOON).is_ok());
    assert!(began.elapsed() >= Duration::from_millis(150));
    assert!(reg.live.lock().unwrap().get(&lost.token).is_none());
    // One that is renewed keeps its wait, however long that is.
    let kept = reg.reserve("a", Instant::now());
    let waiting = waiter(&rt, &reg, reg.mark());
    for _ in 0..12 {
      std::thread::sleep(Duration::from_millis(50));
      reg.renew(&[kept.token], Instant::now());
    }
    assert!(waiting.try_recv().is_err(), "waited out 600 ms of 200 ms");
    assert!(waiting.recv_timeout(SOON).is_ok(), "then it ran out");
  }

  #[test]
  fn letting_go_of_a_reservation_twice_or_by_drop_is_harmless() {
    let reg = Reservations::new(LEASE);
    let held = reg.reserve("a", Instant::now());
    reg.release(held.token);
    reg.release(held.token);
    reg.release(u64::MAX);
    assert!(reg.live.lock().unwrap().is_empty());
    let token = reservations().reserve("drop-test", Instant::now()).token;
    let guard = ReleaseOnDrop(Some(token));
    assert!(reservations().live.lock().unwrap().contains_key(&token));
    drop(guard);
    assert!(!reservations().live.lock().unwrap().contains_key(&token));
    drop(ReleaseOnDrop(None));
  }

  #[test]
  fn a_window_that_goes_takes_its_reservations_and_gates_with_it() {
    let label = "window-destroyed-test";
    let reserved = reservations().reserve(label, Instant::now()).token;
    let other = reservations().reserve("someone-else", Instant::now()).token;
    let gate = GATE.open(label).unwrap();
    let live = |token: u64| reservations().live.lock().unwrap().contains_key(&token);
    let open = |token: u64| GATE.state.lock().unwrap().gates.contains_key(&token);
    assert!(live(reserved) && open(gate));
    window_destroyed(label);
    assert!(!live(reserved) && !open(gate));
    assert!(live(other), "another window's reservation stays");
    reservations().release(other);
  }

  #[test]
  fn the_keepalive_renews_reservations_and_gates_alike() {
    let label = "keepalive-test";
    let reserved = reservations().reserve(label, Instant::now()).token;
    let gate = GATE.open(label).unwrap();
    let deadlines = || {
      (
        reservations().live.lock().unwrap()[&reserved].deadline,
        GATE.state.lock().unwrap().gates[&gate].lease.deadline,
      )
    };
    let before = deadlines();
    std::thread::sleep(Duration::from_millis(5));
    renew_all(&[reserved, gate, u64::MAX]);
    let after = deadlines();
    assert!(after.0 > before.0, "the reservation");
    assert!(after.1 > before.1, "the gate");
    window_destroyed(label);
  }
  // --- the read gate ----------------------------------------------------------
  /// A clock the test moves.
  macro_rules! fake_clock {
    ($name:ident) => {
      mod $name {
        use super::*;
        static BASE: OnceLock<Instant> = OnceLock::new();
        static MOVED: AtomicU64 = AtomicU64::new(0);
        pub fn now() -> Instant {
          *BASE.get_or_init(Instant::now) + Duration::from_millis(MOVED.load(Ordering::SeqCst))
        }
        pub fn advance(by: Duration) {
          MOVED.fetch_add(by.as_millis() as u64, Ordering::SeqCst);
        }
      }
    };
  }
  fake_clock!(lease_clock);
  fake_clock!(waiting_clock);
  /// Closes every gate when dropped, so a test that fails with a copy waiting
  /// for one ends instead of hanging.
  struct CloseAll(&'static Gate);

  impl Drop for CloseAll {
    fn drop(&mut self) {
      self.0.state.lock().unwrap().gates.clear();
      self.0.changed.notify_all();
    }
  }

  fn gate_count(gate: &Gate) -> usize {
    gate.state.lock().unwrap().gates.len()
  }
  /// A clipboard the test has offered a clip to, on the gate and lock it returns.
  fn offered(dir: &TempDir, board: &Arc<Fake>) -> (&'static Mutex<Inner>, &'static Gate, ClipInfo) {
    let (lock, gate) = (own_lock(), own_gate());
    let hook = || {};
    let env = Env {
      gate,
      ..env(lock, board, None, MAIN_WAIT, &hook)
    };
    let ClipOutcome::Offered(info) = copy_with(&env, || clip(dir, "ours")) else {
      panic!("the copy must be offered");
    };
    (lock, gate, info)
  }

  #[test]
  fn text_begin_says_ours_for_our_clip_and_opens_a_gate_for_anything_else() {
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate, info) = offered(&dir, &board);
    let env = Env {
      gate,
      ..env(lock, &board, None, MAIN_WAIT, &|| {})
    };
    assert_eq!(
      text_begin_with(&env, "w"),
      TextBegin::Ours { info: info.clone() }
    );
    assert_eq!(gate_count(gate), 0, "no gate is left open for our own clip");
    // Another app takes the clipboard.
    board.owner.store(999, Ordering::SeqCst);
    let TextBegin::Gate { token } = text_begin_with(&env, "w") else {
      panic!("the clipboard is not ours any more");
    };
    assert_eq!(gate_count(gate), 1);
    gate.close(token);
    assert_eq!(gate_count(gate), 0);
    // The state still names our clip, and the owner says it is not the clipboard's.
    assert_eq!(state_info(lock), Some(info));
  }

  #[test]
  fn a_copy_waits_for_the_gate_to_close_before_it_hands_over_the_clip() {
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate) = (own_lock(), own_gate());
    let env = Env {
      gate,
      ..env(lock, &board, None, MAIN_WAIT, &|| {})
    };
    let TextBegin::Gate { token } = text_begin_with(&env, "w") else {
      panic!("a gate opens");
    };
    let _close = CloseAll(gate);
    let publishes = || board.publishes.load(Ordering::SeqCst);
    std::thread::scope(|scope| {
      let copying = scope.spawn(|| {
        let hook = || {};
        let env = Env {
          gate,
          ..self::env(lock, &board, None, MAIN_WAIT, &hook)
        };
        copy_with(&env, || clip(&dir, "text"))
      });
      std::thread::sleep(LATER);
      assert_eq!(publishes(), 0, "the clip waits while the page reads");
      assert!(!copying.is_finished());
      gate.close(token);
      assert!(matches!(copying.join().unwrap(), ClipOutcome::Offered(_)));
    });
    assert_eq!(publishes(), 1);
  }

  #[test]
  fn a_copy_waiting_for_a_gate_holds_no_lock() {
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate) = (own_lock(), own_gate());
    let token = gate.open("w").unwrap();
    let _close = CloseAll(gate);
    std::thread::scope(|scope| {
      let copying = scope.spawn(|| {
        let hook = || {};
        let env = Env {
          gate,
          ..env(lock, &board, None, MAIN_WAIT, &hook)
        };
        copy_with(&env, || clip(&dir, "text"))
      });
      std::thread::sleep(LATER);
      assert!(!copying.is_finished(), "it is waiting");
      assert!(lock.try_lock().is_ok(), "the clip lock is free");
      assert!(gate.state.try_lock().is_ok(), "the gate's lock is free");
      assert!(gate.ours.try_lock().is_ok(), "so is the clip's note");
      assert!(CLIP_LOCK.try_lock().is_ok());
      gate.close(token);
      copying.join().unwrap();
    });
  }

  #[test]
  fn a_gate_that_stays_open_longer_than_the_main_thread_wait_does_not_fail_the_copy() {
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate) = (own_lock(), own_gate());
    let token = gate.open("w").unwrap();
    let _close = CloseAll(gate);
    let outcome = std::thread::scope(|scope| {
      let copying = scope.spawn(|| {
        let hook = || {};
        let env = Env {
          gate,
          ..env(
            lock,
            &board,
            Some(&Prompt),
            Duration::from_millis(100),
            &hook,
          )
        };
        copy_with(&env, || clip(&dir, "text"))
      });
      std::thread::sleep(Duration::from_millis(450));
      assert!(!copying.is_finished());
      gate.close(token);
      copying.join().unwrap()
    });
    assert!(matches!(outcome, ClipOutcome::Offered(_)), "{outcome:?}");
  }

  #[test]
  fn a_gate_opened_during_a_hand_over_says_busy_and_stays_shut() {
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate) = (own_lock(), own_gate());
    // The main thread answers the change counter, then keeps the hand-over.
    let queue = Queue::new(1);
    std::thread::scope(|scope| {
      let copying = scope.spawn(|| {
        let hook = || {};
        let env = Env {
          gate,
          ..env(lock, &board, Some(&queue), MAIN_WAIT, &hook)
        };
        copy_with(&env, || clip(&dir, "text"))
      });
      let began = Instant::now();
      while queue.jobs.lock().unwrap().is_empty() {
        assert!(began.elapsed() < SOON, "the hand-over never began");
        std::thread::sleep(Duration::from_millis(2));
      }
      let env = Env {
        gate,
        ..env(lock, &board, None, MAIN_WAIT, &|| {})
      };
      assert_eq!(text_begin_with(&env, "w"), TextBegin::Busy);
      assert_eq!(gate_count(gate), 0, "a busy answer opens no gate");
      queue.run_all();
      assert!(matches!(copying.join().unwrap(), ClipOutcome::Offered(_)));
      assert!(
        matches!(text_begin_with(&env, "w"), TextBegin::Ours { .. }),
        "and when it is over the gate works again"
      );
    });
  }

  #[test]
  fn a_stuck_hand_over_does_not_hold_up_text_begin() {
    // Windows: the arm handshake holds the clip lock while the helper answers.
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate) = (own_lock(), own_gate());
    board.stall.store(true, Ordering::SeqCst);
    std::thread::scope(|scope| {
      let copying = scope.spawn(|| {
        let hook = || {};
        let env = Env {
          gate,
          ..env(lock, &board, None, MAIN_WAIT, &hook)
        };
        copy_with(&env, || clip(&dir, "text"))
      });
      let began = Instant::now();
      while board.publishes.load(Ordering::SeqCst) == 0 {
        assert!(began.elapsed() < SOON, "the hand-over never began");
        std::thread::sleep(Duration::from_millis(2));
      }
      assert!(lock.try_lock().is_err(), "the hand-over holds the lock");
      let (tx, rx) = mpsc::channel();
      let other = Arc::clone(&board);
      scope.spawn(move || {
        let env = Env {
          gate,
          ..env(lock, &other, None, MAIN_WAIT, &|| {})
        };
        let _ = tx.send(text_begin_with(&env, "w"));
      });
      let answer = rx.recv_timeout(Duration::from_millis(50));
      board.stall.store(false, Ordering::SeqCst);
      assert_eq!(answer, Ok(TextBegin::Busy));
      copying.join().unwrap();
    });
  }

  #[test]
  fn a_gate_nobody_renews_closes_and_a_renewed_one_stays() {
    let gate = Gate::with(lease_clock::now, LEASE);
    let kept = gate.open("a").unwrap();
    let lost = gate.open("a").unwrap();
    let held = |token: u64| gate.state.lock().unwrap().gates.contains_key(&token);
    lease_clock::advance(Duration::from_secs(10));
    gate.renew(&[kept]);
    lease_clock::advance(Duration::from_secs(10));
    gate.expire(lease_clock::now());
    assert!(held(kept), "twenty seconds in, ten since its renewal");
    assert!(!held(lost), "fifteen seconds without one");
    lease_clock::advance(Duration::from_secs(6));
    gate.expire(lease_clock::now());
    assert!(!held(kept));
  }

  #[test]
  fn a_copy_goes_ahead_once_the_gate_it_waits_for_has_run_out() {
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let lock = own_lock();
    let gate: &'static Gate = Box::leak(Box::new(Gate::with(waiting_clock::now, LEASE)));
    gate.open("a").unwrap();
    let _close = CloseAll(gate);
    std::thread::scope(|scope| {
      let copying = scope.spawn(|| {
        let hook = || {};
        let env = Env {
          gate,
          ..env(lock, &board, None, MAIN_WAIT, &hook)
        };
        copy_with(&env, || clip(&dir, "text"))
      });
      std::thread::sleep(LATER);
      assert!(!copying.is_finished());
      waiting_clock::advance(Duration::from_secs(16));
      gate.changed.notify_all();
      std::thread::sleep(LATER);
      let went_ahead = copying.is_finished();
      gate.state.lock().unwrap().gates.clear();
      gate.changed.notify_all();
      assert!(went_ahead, "the gate ran out and the copy still waits");
      assert!(matches!(copying.join().unwrap(), ClipOutcome::Offered(_)));
    });
  }
  fake_clock!(revoke_clock);
  fake_clock!(revoke_expiry_clock);
  fake_clock!(end_clock);
  type Told = Arc<Mutex<Vec<(String, u64)>>>;
  /// A gate that records the revocations it announces.
  fn noting_gate(gate: Gate) -> (&'static Gate, Told) {
    let gate: &'static Gate = Box::leak(Box::new(gate));
    let told: Told = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&told);
    gate.set_notify(Box::new(move |window, token| {
      log.lock().unwrap().push((window.to_string(), token));
    }));
    (gate, told)
  }
  /// A hand-over waiting on `gate` from a thread of its own; whether it went ahead.
  fn handing_over(gate: &'static Gate) -> Arc<AtomicBool> {
    let went = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&went);
    std::thread::spawn(move || {
      let _publishing = gate.begin_publish();
      flag.store(true, Ordering::SeqCst);
    });
    went
  }

  #[test]
  fn a_page_gate_open_two_seconds_is_revoked_and_the_hand_over_waits_for_its_close() {
    let (gate, told) = noting_gate(Gate::with(revoke_clock::now, LEASE));
    let _close = CloseAll(gate);
    let token = gate.open("w").unwrap();
    let went = handing_over(gate);
    std::thread::sleep(LATER);
    revoke_clock::advance(Duration::from_millis(1900));
    gate.changed.notify_all();
    std::thread::sleep(LATER);
    assert!(told.lock().unwrap().is_empty(), "not yet two seconds");
    revoke_clock::advance(Duration::from_millis(100));
    gate.changed.notify_all();
    std::thread::sleep(LATER);
    assert_eq!(*told.lock().unwrap(), vec![("w".to_string(), token)]);
    assert!(
      !went.load(Ordering::SeqCst),
      "the hand-over waits for the close, not for the event"
    );
    assert!(gate.state.lock().unwrap().gates.contains_key(&token));
    // More wakes tell nobody twice.
    gate.changed.notify_all();
    std::thread::sleep(LATER);
    assert_eq!(told.lock().unwrap().len(), 1);
    assert!(gate.end(token));
    let began = Instant::now();
    while !went.load(Ordering::SeqCst) {
      assert!(began.elapsed() < SOON, "the close never let it go ahead");
      std::thread::sleep(Duration::from_millis(2));
    }
  }

  #[test]
  fn a_hand_over_under_way_revokes_a_gate_that_keeps_being_renewed_when_it_is_two_seconds_old() {
    // The waiter must wake for the revocation by itself, long before the lease
    // runs out.
    let (gate, told) = noting_gate(Gate::revoking_after(
      Instant::now,
      LEASE,
      Duration::from_millis(200),
    ));
    let _close = CloseAll(gate);
    let token = gate.open("w").unwrap();
    let went = handing_over(gate);
    let began = Instant::now();
    while told.lock().unwrap().is_empty() {
      assert!(
        began.elapsed() < Duration::from_millis(1500),
        "never revoked"
      );
      gate.renew(&[token]);
      std::thread::sleep(Duration::from_millis(20));
    }
    assert!(began.elapsed() >= Duration::from_millis(200));
    assert_eq!(*told.lock().unwrap(), vec![("w".to_string(), token)]);
    assert!(!went.load(Ordering::SeqCst));
  }

  #[test]
  fn a_gate_of_the_backend_is_never_revoked() {
    let (gate, told) = noting_gate(Gate::revoking_after(
      Instant::now,
      LEASE,
      Duration::from_millis(100),
    ));
    let _close = CloseAll(gate);
    let token = gate.open("").unwrap();
    let went = handing_over(gate);
    std::thread::sleep(Duration::from_millis(500));
    // Any wake of the waiting hand-over looks at the gates again.
    gate.changed.notify_all();
    std::thread::sleep(LATER);
    assert!(told.lock().unwrap().is_empty());
    assert!(
      !went.load(Ordering::SeqCst),
      "it waits until the read is done"
    );
    gate.close(token);
    let began = Instant::now();
    while !went.load(Ordering::SeqCst) {
      assert!(began.elapsed() < SOON, "the close never let it go ahead");
      std::thread::sleep(Duration::from_millis(2));
    }
  }

  #[test]
  fn a_gate_being_revoked_runs_out_fifteen_seconds_after_its_last_renewal() {
    let (gate, told) = noting_gate(Gate::with(revoke_expiry_clock::now, LEASE));
    let _close = CloseAll(gate);
    let token = gate.open("w").unwrap();
    let went = handing_over(gate);
    std::thread::sleep(LATER);
    revoke_expiry_clock::advance(Duration::from_secs(2));
    gate.changed.notify_all();
    std::thread::sleep(LATER);
    assert_eq!(told.lock().unwrap().len(), 1);
    gate.renew(&[token]);
    revoke_expiry_clock::advance(Duration::from_secs(14));
    gate.changed.notify_all();
    std::thread::sleep(LATER);
    assert!(
      !went.load(Ordering::SeqCst),
      "fourteen seconds after the renewal"
    );
    revoke_expiry_clock::advance(Duration::from_secs(2));
    gate.changed.notify_all();
    std::thread::sleep(LATER);
    assert!(went.load(Ordering::SeqCst), "sixteen seconds after it");
  }

  #[test]
  fn ending_a_gate_says_whether_it_was_still_held() {
    let gate = Gate::with(end_clock::now, LEASE);
    let (revoking, run_out) = (gate.open("w").unwrap(), gate.open("w").unwrap());
    end_clock::advance(Duration::from_secs(2));
    let due = gate.revoke_due(&mut gate.state.lock().unwrap(), end_clock::now());
    assert_eq!(due.len(), 2);
    let (held, reset) = (gate.open("w").unwrap(), gate.open("gone").unwrap());
    gate.renew(&[revoking]);
    end_clock::advance(Duration::from_secs(14));
    assert!(gate.end(held), "a gate in the table");
    assert!(gate.end(revoking), "one being revoked is in the table too");
    assert!(!gate.end(run_out), "run out, though nobody swept it yet");
    gate.close_window("gone");
    assert!(!gate.end(reset), "let go with its window");
    assert!(!gate.end(u64::MAX), "never was");
  }

  #[test]
  fn what_sendaction_answers_decides_between_send_and_not_handled() {
    assert_eq!(redispatch_with(true, || true), Redispatch::Send);
    assert_eq!(redispatch_with(true, || false), Redispatch::NotHandled);
    let sent = AtomicBool::new(false);
    let decision = redispatch_with(false, || {
      sent.store(true, Ordering::SeqCst);
      true
    });
    assert_eq!(decision, Redispatch::NotKey);
    assert!(
      !sent.load(Ordering::SeqCst),
      "nothing is sent to another window"
    );
    assert_eq!(
      serde_json::to_value(Redispatch::NotHandled).unwrap(),
      serde_json::json!("not-handled")
    );
  }
  /// What a text read finds, and how often it was asked.
  fn reader(
    text: Option<&str>,
  ) -> (
    Arc<AtomicUsize>,
    Arc<dyn Fn() -> Option<String> + Send + Sync>,
  ) {
    let asked = Arc::new(AtomicUsize::new(0));
    let text = text.map(str::to_string);
    let count = Arc::clone(&asked);
    let read = move || {
      count.fetch_add(1, Ordering::SeqCst);
      text.clone()
    };
    (asked, Arc::new(read))
  }

  #[test]
  fn text_of_another_app_is_read_behind_a_gate_that_is_gone_after() {
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate, _) = offered(&dir, &board);
    board.owner.store(999, Ordering::SeqCst);
    for main in [None, Some(&Prompt as &dyn MainThread)] {
      let env = Env {
        gate,
        ..env(lock, &board, main, MAIN_WAIT, &|| {})
      };
      let (asked, read) = reader(Some("from elsewhere"));
      let during = Arc::new(AtomicUsize::new(0));
      let read: Arc<dyn Fn() -> Option<String> + Send + Sync> = {
        let (inner, count) = (read, Arc::clone(&during));
        Arc::new(move || {
          count.store(gate_count(gate), Ordering::SeqCst);
          inner()
        })
      };
      let seen = (system_text_with(&env, read), during.load(Ordering::SeqCst));
      assert_eq!(
        seen.0,
        Ok(SystemText::Text(Some("from elsewhere".to_string())))
      );
      assert_eq!(seen.1, 1, "the gate was open while the text was read");
      assert_eq!(asked.load(Ordering::SeqCst), 1);
      assert_eq!(gate_count(gate), 0, "and closed after");
    }
  }

  #[test]
  fn our_clip_on_the_clipboard_is_not_read_as_text() {
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate, _) = offered(&dir, &board);
    let env = Env {
      gate,
      ..env(lock, &board, None, MAIN_WAIT, &|| {})
    };
    let (asked, read) = reader(Some("never"));
    assert_eq!(system_text_with(&env, read), Ok(SystemText::Ours));
    assert_eq!(asked.load(Ordering::SeqCst), 0);
    assert_eq!(gate_count(gate), 0);
  }

  #[test]
  fn text_is_not_read_while_a_clip_is_handed_over_and_then_the_answer_follows_the_clipboard() {
    for refused in [false, true] {
      let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
      board.refuse.store(refused, Ordering::SeqCst);
      let (lock, gate) = (own_lock(), own_gate());
      let queue = Queue::new(1);
      let (asked, read) = reader(Some("the old text"));
      std::thread::scope(|scope| {
        let copying = scope.spawn(|| {
          let hook = || {};
          let env = Env {
            gate,
            ..env(lock, &board, Some(&queue), MAIN_WAIT, &hook)
          };
          copy_with(&env, || clip(&dir, "text"))
        });
        let began = Instant::now();
        while queue.jobs.lock().unwrap().is_empty() {
          assert!(began.elapsed() < SOON, "the hand-over never began");
          std::thread::sleep(Duration::from_millis(2));
        }
        let reading = scope.spawn(|| {
          let env = Env {
            gate,
            ..env(lock, &board, None, MAIN_WAIT, &|| {})
          };
          system_text_with(&env, read)
        });
        std::thread::sleep(LATER);
        assert!(!reading.is_finished(), "it holds on");
        assert_eq!(asked.load(Ordering::SeqCst), 0, "nothing is read");
        assert_eq!(gate_count(gate), 0);
        queue.run_all();
        copying.join().unwrap();
        let found = reading.join().unwrap();
        if refused {
          assert_eq!(
            found,
            Ok(SystemText::Text(Some("the old text".to_string())))
          );
          assert_eq!(asked.load(Ordering::SeqCst), 1);
        } else {
          assert_eq!(found, Ok(SystemText::Ours), "the new clip is ours");
          assert_eq!(asked.load(Ordering::SeqCst), 0);
        }
      });
    }
  }
  // --- opening a clip ---------------------------------------------------------
  /// An opener that counts what it opens.
  fn counting_opener() -> (Arc<AtomicUsize>, Opener) {
    let opened = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&opened);
    let opener: Opener = Arc::new(move |path| {
      count.fetch_add(1, Ordering::SeqCst);
      File::open(path)
    });
    (opened, opener)
  }

  #[test]
  fn a_clip_that_is_not_ours_is_not_opened() {
    use std::io::Read;
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate, info) = offered(&dir, &board);
    for main in [None, Some(&Prompt as &dyn MainThread)] {
      let env = Env {
        gate,
        ..env(lock, &board, main, MAIN_WAIT, &|| {})
      };
      let (opened, opener) = counting_opener();
      assert_eq!(
        open_with(&env, "some-other-clip", opener.clone()).err(),
        Some(NotOurs)
      );
      assert_eq!(opened.load(Ordering::SeqCst), 0, "another clip's id");
      let (mut file, held) = open_with(&env, &info.id, opener.clone()).unwrap();
      assert_eq!(opened.load(Ordering::SeqCst), 1);
      assert_eq!(held, info);
      // Replaced and deleted after, the open file still reads to its end.
      let path = dir.path().join(format!("clip-{}.txt", info.id));
      assert!(path.exists());
      fs::remove_file(&path).unwrap();
      let mut text = String::new();
      file.read_to_string(&mut text).unwrap();
      assert_eq!(text, "ours");
      fs::write(&path, "ours").unwrap();
    }
    board.owner.store(999, Ordering::SeqCst);
    let env = Env {
      gate,
      ..env(lock, &board, None, MAIN_WAIT, &|| {})
    };
    let (opened, opener) = counting_opener();
    assert_eq!(open_with(&env, &info.id, opener).err(), Some(NotOurs));
    assert_eq!(
      opened.load(Ordering::SeqCst),
      0,
      "the clipboard moved on, nothing is opened"
    );
    assert_eq!(state_info(lock), None);
    assert_eq!(gate.ours_if(999), None, "and the gate forgot it");
  }

  #[test]
  fn a_clip_that_cannot_be_opened_is_not_ours_either() {
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate, info) = offered(&dir, &board);
    let env = Env {
      gate,
      ..env(lock, &board, None, MAIN_WAIT, &|| {})
    };
    let opener: Opener = Arc::new(|_| Err(std::io::Error::other("gone")));
    assert_eq!(open_with(&env, &info.id, opener).err(), Some(NotOurs));
  }
  // --- pins -------------------------------------------------------------------

  fn read_all(file: Arc<File>) -> String {
    use std::io::Read;
    let mut text = String::new();
    PinReader::new(file).read_to_string(&mut text).unwrap();
    text
  }

  #[test]
  fn a_pinned_clip_is_read_whole_after_the_clipboard_moves_and_its_file_goes() {
    let (dir, board) = (tempdir().unwrap(), Arc::new(Fake::default()));
    let (lock, gate, info) = offered(&dir, &board);
    let env = Env {
      gate,
      ..env(lock, &board, None, MAIN_WAIT, &|| {})
    };
    let (pins, opener): (Pins, Opener) = (Pins::new(), Arc::new(|path| File::open(path)));
    let wrong = pin_with(&env, &pins, "w", "some-other-clip", opener.clone());
    assert_eq!(wrong, Err(NOT_OURS.to_string()));
    let pin = pin_with(&env, &pins, "w", &info.id, opener.clone()).unwrap();
    // Another app takes the clipboard; the clip is deleted with its state.
    board.owner.store(999, Ordering::SeqCst);
    assert_eq!(status_with(&env), None);
    assert_eq!(clip_files(&dir), 0);
    assert_eq!(read_all(pins.file(pin).unwrap()), "ours");
    // A pin asked for now is refused: the clipboard is not ours.
    let late = pin_with(&env, &pins, "w", &info.id, opener);
    assert_eq!(late, Err(NOT_OURS.to_string()));
  }

  #[test]
  fn a_pin_has_no_deadline_and_nothing_renews_it() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("clip.txt");
    fs::write(&path, "text").unwrap();
    let pins = Pins::new();
    let pin = pins.pin("w", File::open(&path).unwrap());
    assert_eq!(read_all(pins.file(pin).unwrap()), "text");
    // The keepalive of a window lists its pins; none of its work touches them.
    renew_all(&[pin]);
    assert!(pins.file(pin).is_ok());
    let at = SOURCE.find("struct Pinned {").unwrap();
    let rest = &SOURCE[at..];
    let pins_code = &rest[..rest.find("static PINS:").unwrap()];
    for word in ["Instant", "Duration", "deadline", "ttl", "Lease", "expire"] {
      assert!(!pins_code.contains(word), "a pin must not know {word}");
    }
  }

  #[test]
  fn a_pin_is_gone_after_unpin_window_destroyed_and_window_reset() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("clip.txt");
    fs::write(&path, "text").unwrap();
    let pin_for = |label: &str| pins().pin(label, File::open(&path).unwrap());
    let (unpinned, destroyed, reset, kept) = (
      pin_for("pin-gone-test-a"),
      pin_for("pin-gone-test-b"),
      pin_for("pin-gone-test-c"),
      pin_for("pin-gone-test-d"),
    );
    assert!(pinned(unpinned).is_ok() && pinned(destroyed).is_ok() && pinned(reset).is_ok());
    clip_unpin(unpinned);
    assert_eq!(pinned(unpinned).err().as_deref(), Some(PIN_GONE));
    window_destroyed("pin-gone-test-b");
    assert_eq!(pinned(destroyed).err().as_deref(), Some(PIN_GONE));
    window_reset("pin-gone-test-c");
    assert_eq!(pinned(reset).err().as_deref(), Some(PIN_GONE));
    assert!(pinned(kept).is_ok(), "another window's pin stays");
    pins().unpin(kept);
  }

  #[test]
  fn a_window_reset_lets_go_of_that_window_only() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("clip.txt");
    fs::write(&path, "text").unwrap();
    let (reservations, pins) = (Reservations::new(LEASE), Pins::new());
    let gate: &'static Gate = Box::leak(Box::new(Gate::new()));
    let _close = CloseAll(gate);
    let reserved = reservations.reserve("reset-me", Instant::now());
    let other_reserved = reservations.reserve("someone-else", Instant::now());
    let pin = pins.pin("reset-me", File::open(&path).unwrap());
    let other_pin = pins.pin("someone-else", File::open(&path).unwrap());
    let opened = gate.open("reset-me").unwrap();
    let other_opened = gate.open("someone-else").unwrap();
    reset_window("reset-me", &reservations, &pins, gate);
    let held = |token: u64| gate.state.lock().unwrap().gates.contains_key(&token);
    let live = |token: u64| reservations.live.lock().unwrap().contains_key(&token);
    assert!(!live(reserved.token) && pins.file(pin).is_err() && !held(opened));
    assert!(
      live(other_reserved.token),
      "another window's reservation stays"
    );
    assert!(pins.file(other_pin).is_ok(), "another window's pin stays");
    assert!(held(other_opened), "another window's gate stays");
  }

  #[test]
  fn a_window_reset_wakes_the_hand_over_waiting_for_its_gate() {
    let gate: &'static Gate = Box::leak(Box::new(Gate::new()));
    let _close = CloseAll(gate);
    gate.open("reset-me").unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::scope(|scope| {
      scope.spawn(|| {
        let _publishing = gate.begin_publish();
        let _ = tx.send(());
      });
      std::thread::sleep(LATER);
      assert!(rx.try_recv().is_err(), "it waits for the gate");
      reset_window("reset-me", &Reservations::new(LEASE), &Pins::new(), gate);
      // Well before the hand-over would look at the gate by itself.
      assert!(rx.recv_timeout(Duration::from_millis(1000)).is_ok());
    });
  }

  #[test]
  fn a_pin_that_is_let_go_or_never_was_is_gone() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("clip.txt");
    fs::write(&path, "text").unwrap();
    let pins = Pins::new();
    let pin = pins.pin("w", File::open(&path).unwrap());
    pins.unpin(pin);
    pins.unpin(pin);
    assert_eq!(pins.file(pin).err().as_deref(), Some("pin-gone"));
    assert_eq!(pins.file(u64::MAX).err().as_deref(), Some("pin-gone"));
    assert_eq!(pinned(u64::MAX).err().as_deref(), Some("pin-gone"));
  }

  #[test]
  fn a_window_that_goes_takes_its_pins() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("clip.txt");
    fs::write(&path, "text").unwrap();
    let (label, kept) = ("pin-window-test", "pin-other-window");
    let first = pins().pin(label, File::open(&path).unwrap());
    let other = pins().pin(kept, File::open(&path).unwrap());
    assert!(pinned(first).is_ok());
    window_destroyed(label);
    assert_eq!(pinned(first).err().as_deref(), Some(PIN_GONE));
    assert!(pinned(other).is_ok(), "another window's pin stays");
    pins().unpin(other);
  }
  // --- the page asks the system to paste (macOS) -----------------------------

  #[test]
  fn only_the_key_window_gets_the_paste() {
    assert_eq!(redispatch_decision(true), Redispatch::Send);
    assert_eq!(redispatch_decision(false), Redispatch::NotKey);
    assert_eq!(
      serde_json::to_value(Redispatch::NotKey).unwrap(),
      serde_json::json!("not-key")
    );
  }
  // --- startup cleanup --------------------------------------------------------

  fn folder_with_clips() -> TempDir {
    let dir = tempdir().unwrap();
    for name in [
      "clip-1-0-1.txt",
      "clip-2-0-2.txt",
      "notes.txt",
      "sp-1.bin",
      "clip-3.bin",
    ] {
      fs::write(dir.path().join(name), b"x").unwrap();
    }
    dir
  }

  #[test]
  fn startup_removes_every_clip_and_nothing_else() {
    let dir = folder_with_clips();
    let report = cleanup_clips(dir.path(), &delete_clip);
    assert_eq!(
      report,
      Cleanup {
        removed: 2,
        kept: Vec::new(),
        failed: 0
      }
    );
    let mut left: Vec<String> = fs::read_dir(dir.path())
      .unwrap()
      .flatten()
      .map(|e| e.file_name().to_string_lossy().into_owned())
      .collect();
    left.sort();
    assert_eq!(left, ["clip-3.bin", "notes.txt", "sp-1.bin"]);
    assert_eq!(
      cleanup_clips(&dir.path().join("none"), &delete_clip),
      Cleanup::default()
    );
  }

  #[test]
  fn startup_keeps_a_clip_another_process_still_holds_open() {
    // The Windows rule, with the sharing violation injected.
    let dir = folder_with_clips();
    let held = dir.path().join("clip-1-0-1.txt");
    let report = cleanup_clips(dir.path(), &|path| {
      if path == held {
        return Delete::Busy;
      }
      delete_clip(path)
    });
    assert_eq!(report.kept, vec![held.clone()]);
    assert_eq!((report.removed, report.failed), (1, 0));
    assert!(held.exists());
    assert!(!dir.path().join("clip-2-0-2.txt").exists());
  }

  #[cfg(windows)]
  #[test]
  fn a_clip_a_helper_holds_for_deleting_on_close_can_still_be_opened_and_read() {
    use std::io::Read;
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("clip-1-0-1.txt");
    fs::write(&path, "held by the helper").unwrap();
    // Open as the helper does: delete on close, shared for reading only.
    let held = OpenOptions::new()
      .read(true)
      .access_mode(0x8000_0000 | 0x0001_0000)
      .share_mode(1)
      .custom_flags(0x0400_0000)
      .open(&path)
      .unwrap();
    let mut text = String::new();
    open_shared(&path)
      .unwrap()
      .read_to_string(&mut text)
      .unwrap();
    assert_eq!(text, "held by the helper");
    drop(held);
  }

  #[cfg(windows)]
  #[test]
  fn startup_leaves_a_clip_a_helper_holds_until_it_lets_go() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempdir().unwrap();
    let path = dir.path().join("clip-1-0-1.txt");
    fs::write(&path, b"x").unwrap();
    // Open as the helper does: delete on close, shared for reading only.
    let held = OpenOptions::new()
      .read(true)
      .access_mode(0x8000_0000 | 0x0001_0000)
      .share_mode(1)
      .custom_flags(0x0400_0000)
      .open(&path)
      .unwrap();
    let report = cleanup_clips(dir.path(), &delete_clip);
    assert_eq!(report.kept, vec![path.clone()]);
    assert!(path.exists());
    drop(held);
    assert!(!path.exists());
  }
}
