// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! A sticky whose text outgrew a sticky becomes a tab of a document window. The
//! sticky builds a conversion file, then asks for a handoff; the window that is to
//! show the tab claims it, opens the tab over the file and reports it done. Which
//! of those happen, and in which order, is decided here and nowhere else.
//!
//! A handoff is `Pending` until a window claims it, `Claimed` until that window
//! says it is done, then `Done`; or it is `Reclaimed`, and goes back to the sticky.
//! The states exclude each other and a call that no longer fits is ignored. A
//! handoff nobody claims in `CLAIM_TIMEOUT` is reclaimed, and so is one whose
//! window is destroyed before it is done. Reclaimed: the conversion file is
//! deleted and the sticky, which was locked, is told (`convert-reclaimed`).
//!
//! A `Done` sticky keeps its record but not its window or its place in the lists
//! (`NoteStore::hand_off`) until its tab is saved for the first time (the record
//! goes), the changes are discarded (the sticky comes back), or the window of the
//! tab goes away (the record stays for the next start).

use crate::convert::ConvertStore;
use crate::note_store::{self, HandedLoc, NoteSnapshot, NoteStore};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
/// How long a handoff waits to be claimed.
pub const CLAIM_TIMEOUT: Duration = Duration::from_secs(30);
/// The call does not fit the state the handoff is in.
const REFUSED: &str = "refused";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
  Pending,
  Claimed,
  Done,
  Reclaimed,
}
/// What the tab over the conversion looks like, as the sticky's window converted
/// it: the document window opens it the same way.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabFormat {
  pub language: Option<String>,
  pub encoding: String,
  /// `LF` or `CRLF`.
  pub line_ending: String,
}

impl TabFormat {
  /// Refuses a line ending that is neither `LF` nor `CRLF`.
  fn checked(self) -> Result<Self, String> {
    match self.line_ending.as_str() {
      "LF" | "CRLF" => Ok(self),
      other => Err(format!("unknown line ending: {other}")),
    }
  }
}

struct Handoff {
  note_id: String,
  convert_id: String,
  format: TabFormat,
  phase: Phase,
  /// The window the handoff was sent to while `Pending`; the one that claimed it
  /// from then on.
  window: Option<String>,
  started: Instant,
}
/// What a window gets for claiming a handoff.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Claimed {
  pub convert_id: String,
  pub note_id: String,
  pub language: Option<String>,
  pub encoding: String,
  pub line_ending: String,
}
/// A handoff that goes back to its sticky.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reclaimed {
  pub handoff_id: u64,
  pub note_id: String,
  pub convert_id: String,
}

#[derive(Default)]
struct Inner {
  next: u64,
  items: HashMap<u64, Handoff>,
}
/// The state machine of all handoffs. It only decides; `Shell` does the rest.
#[derive(Default)]
pub struct Handoffs {
  inner: Mutex<Inner>,
}

impl Handoffs {
  /// A new handoff of the sticky `note_id`, whose text is in the conversion file
  /// `convert_id`, to open as a tab of `format`.
  pub fn start(&self, note_id: &str, convert_id: &str, format: TabFormat, now: Instant) -> u64 {
    let mut inner = self.inner.lock().unwrap();
    inner.next += 1;
    let id = inner.next;
    inner.items.insert(
      id,
      Handoff {
        note_id: note_id.to_string(),
        convert_id: convert_id.to_string(),
        format,
        phase: Phase::Pending,
        window: None,
        started: now,
      },
    );
    id
  }
  /// The handoff is sent to window `label`.
  pub fn send_to(&self, id: u64, label: &str) {
    if let Some(item) = self.inner.lock().unwrap().items.get_mut(&id) {
      if item.phase == Phase::Pending {
        item.window = Some(label.to_string());
      }
    }
  }
  /// Window `window` takes the handoff and gets the conversion file's id, the
  /// sticky's and the format of the tab. Refused once the handoff is taken, done,
  /// reclaimed, past its time, or sent to another window.
  pub fn claim(&self, id: u64, window: &str, now: Instant) -> Result<Claimed, String> {
    let mut inner = self.inner.lock().unwrap();
    let item = inner
      .items
      .get_mut(&id)
      .ok_or_else(|| REFUSED.to_string())?;
    let fits = item.phase == Phase::Pending
      && now.saturating_duration_since(item.started) < CLAIM_TIMEOUT
      && item.window.as_deref().map_or(true, |sent| sent == window);
    if !fits {
      return Err(REFUSED.to_string());
    }
    item.phase = Phase::Claimed;
    item.window = Some(window.to_string());
    Ok(Claimed {
      convert_id: item.convert_id.clone(),
      note_id: item.note_id.clone(),
      language: item.format.language.clone(),
      encoding: item.format.encoding.clone(),
      line_ending: item.format.line_ending.clone(),
    })
  }
  /// The window that claimed the handoff has its tab. The sticky's id when that is
  /// news; a handoff that is not claimed by `window` any more is ignored.
  pub fn done(&self, id: u64, window: &str) -> Option<String> {
    let mut inner = self.inner.lock().unwrap();
    let item = inner.items.get_mut(&id)?;
    if item.phase != Phase::Claimed || item.window.as_deref() != Some(window) {
      return None;
    }
    item.phase = Phase::Done;
    Some(item.note_id.clone())
  }
  /// The handoff cannot be completed, whoever says so.
  pub fn failed(&self, id: u64) -> Option<Reclaimed> {
    let mut inner = self.inner.lock().unwrap();
    reclaim(&mut inner, id)
  }
  /// The handoffs nobody claimed in time.
  pub fn expire(&self, now: Instant) -> Vec<Reclaimed> {
    let mut inner = self.inner.lock().unwrap();
    let late: Vec<u64> = inner
      .items
      .iter()
      .filter(|(_, item)| {
        item.phase == Phase::Pending && now.saturating_duration_since(item.started) >= CLAIM_TIMEOUT
      })
      .map(|(id, _)| *id)
      .collect();
    late
      .into_iter()
      .filter_map(|id| reclaim(&mut inner, id))
      .collect()
  }
  /// Window `label` is gone: what was sent to it, or claimed by it, and is not
  /// done goes back.
  pub fn window_gone(&self, label: &str) -> Vec<Reclaimed> {
    let mut inner = self.inner.lock().unwrap();
    let mine: Vec<u64> = inner
      .items
      .iter()
      .filter(|(_, item)| item.window.as_deref() == Some(label))
      .map(|(id, _)| *id)
      .collect();
    mine
      .into_iter()
      .filter_map(|id| reclaim(&mut inner, id))
      .collect()
  }
  /// These handoffs were never delivered; they go back.
  pub fn give_back(&self, ids: &[u64]) -> Vec<Reclaimed> {
    let mut inner = self.inner.lock().unwrap();
    ids
      .iter()
      .filter_map(|id| reclaim(&mut inner, *id))
      .collect()
  }
}
/// `Pending` or `Claimed` to `Reclaimed`; nothing else changes state.
fn reclaim(inner: &mut Inner, id: u64) -> Option<Reclaimed> {
  let item = inner.items.get_mut(&id)?;
  if !matches!(item.phase, Phase::Pending | Phase::Claimed) {
    return None;
  }
  item.phase = Phase::Reclaimed;
  Some(Reclaimed {
    handoff_id: id,
    note_id: item.note_id.clone(),
    convert_id: item.convert_id.clone(),
  })
}
/// Why a handoff went back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
  /// Nobody claimed it in time.
  Timeout,
  /// The window said it could not open the tab, or none could be opened.
  Failed,
  /// The window it was sent to, or the one that claimed it, went away.
  WindowClosed,
}

impl Why {
  fn as_str(self) -> &'static str {
    match self {
      Why::Timeout => "timeout",
      Why::Failed => "failed",
      Why::WindowClosed => "window-closed",
    }
  }
}
/// What the state machine's decisions do to the app.
pub trait Shell {
  /// Tells the sticky its text is not leaving: it unlocks and shows an error.
  fn sticky_reclaimed(&self, reclaimed: &Reclaimed, why: Why);
  /// Closes the window of the sticky `note_id`.
  fn close_sticky(&self, note_id: &str);
  /// Opens the window of a sticky again.
  fn show_sticky(&self, note: &NoteSnapshot) -> Result<(), String>;
  /// The lists of stickies changed.
  fn changed(&self, note_id: &str);
}
/// Deletes the conversion files of `reclaimed` and tells their stickies.
fn give_back(shell: &dyn Shell, converts: &ConvertStore, reclaimed: Vec<Reclaimed>, why: Why) {
  for item in reclaimed {
    converts.abort(&item.convert_id);
    shell.sticky_reclaimed(&item, why);
  }
}

fn expire_core(shell: &dyn Shell, handoffs: &Handoffs, converts: &ConvertStore, now: Instant) {
  give_back(shell, converts, handoffs.expire(now), Why::Timeout);
}

fn failed_core(shell: &dyn Shell, handoffs: &Handoffs, converts: &ConvertStore, id: u64) {
  give_back(
    shell,
    converts,
    handoffs.failed(id).into_iter().collect(),
    Why::Failed,
  );
}
/// A new handoff of the sticky `note_id` over the conversion `convert_id`. From
/// here the handoff decides the file's fate, not the sticky's window.
fn start_core(
  handoffs: &Handoffs,
  converts: &ConvertStore,
  note_id: &str,
  convert_id: &str,
  format: TabFormat,
  now: Instant,
) -> Result<u64, String> {
  let format = format.checked()?;
  converts.set_owner(convert_id, None)?;
  Ok(handoffs.start(note_id, convert_id, format, now))
}
/// Window `window` takes the handoff and with it the conversion file, which goes
/// when the window does.
fn claim_core(
  handoffs: &Handoffs,
  converts: &ConvertStore,
  id: u64,
  window: &str,
  now: Instant,
) -> Result<Claimed, String> {
  let claimed = handoffs.claim(id, window, now)?;
  // A file that is gone already is found out when the window opens it.
  let _ = converts.set_owner(&claimed.convert_id, Some(window));
  Ok(claimed)
}
/// The tab is open in `window`: the sticky closes, its record stays and it leaves
/// the lists.
fn done_core(
  shell: &dyn Shell,
  handoffs: &Handoffs,
  store: &NoteStore,
  id: u64,
  window: &str,
  tab_id: &str,
) {
  let Some(note_id) = handoffs.done(id, window) else {
    return;
  };
  store.hand_off(
    &note_id,
    HandedLoc {
      window: window.to_string(),
      tab_id: tab_id.to_string(),
    },
  );
  shell.close_sticky(&note_id);
  shell.changed(&note_id);
}
/// The tab was saved for the first time: the sticky's record goes.
fn sticky_saved_core(shell: &dyn Shell, store: &NoteStore, note_id: &str) -> Result<(), String> {
  store.delete(note_id)?;
  store.take_back(note_id);
  shell.changed(note_id);
  Ok(())
}
/// The changes of the tab were discarded: the sticky comes back as its record has
/// it. Nothing happens for a sticky that is not handed off.
fn release_core(shell: &dyn Shell, store: &NoteStore, note_id: &str) -> Result<(), String> {
  if !store.take_back(note_id) {
    return Ok(());
  }
  let note = store
    .get(note_id)
    .ok_or_else(|| format!("no such note: {note_id}"))?;
  shell.changed(note_id);
  shell.show_sticky(&note)
}
/// Window `label` was destroyed.
fn window_destroyed_core(
  shell: &dyn Shell,
  handoffs: &Handoffs,
  converts: &ConvertStore,
  store: &NoteStore,
  label: &str,
) {
  give_back(
    shell,
    converts,
    handoffs.window_gone(label),
    Why::WindowClosed,
  );
  for note_id in store.take_back_in(label) {
    shell.changed(&note_id);
  }
}

struct AppShell<'a>(&'a AppHandle);

impl Shell for AppShell<'_> {
  fn sticky_reclaimed(&self, reclaimed: &Reclaimed, why: Why) {
    let _ = self.0.emit_to(
      format!("note-{}", reclaimed.note_id),
      "convert-reclaimed",
      serde_json::json!({
        "note_id": reclaimed.note_id,
        "handoff_id": reclaimed.handoff_id,
        "reason": why.as_str(),
      }),
    );
  }
  fn close_sticky(&self, note_id: &str) {
    if let Some(window) = self.0.get_webview_window(&format!("note-{note_id}")) {
      let _ = window.destroy();
    }
  }
  fn show_sticky(&self, note: &NoteSnapshot) -> Result<(), String> {
    crate::windows::create_sticky_window(self.0, note)
  }
  fn changed(&self, note_id: &str) {
    note_store::emit_store_changed(self.0, Some(note_id));
  }
}
/// A document window was destroyed (`WindowEvent::Destroyed`): what was sent to it
/// or claimed by it and is not done goes back to its sticky, and the stickies whose
/// tab was in it are no longer handed off.
pub fn window_destroyed(app: &AppHandle, label: &str) {
  let (Some(handoffs), Some(converts), Some(store)) = (
    app.try_state::<Handoffs>(),
    app.try_state::<ConvertStore>(),
    app.try_state::<NoteStore>(),
  ) else {
    return;
  };
  window_destroyed_core(&AppShell(app), &handoffs, &converts, &store, label);
}
/// Handoffs that were queued for a window that went away unready.
pub fn give_back_unclaimed(app: &AppHandle, ids: &[u64]) {
  let (Some(handoffs), Some(converts)) =
    (app.try_state::<Handoffs>(), app.try_state::<ConvertStore>())
  else {
    return;
  };
  give_back(
    &AppShell(app),
    &converts,
    handoffs.give_back(ids),
    Why::WindowClosed,
  );
}
/// The document window a handoff goes to: the last one when documents open as
/// tabs, else (or with none open) a new, empty one.
fn target_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
  if crate::settings::app_settings(app).open_target == "tab" {
    if let Some(window) = crate::last_doc_window(app) {
      return Ok(window);
    }
  }
  let label = crate::windows::open_empty_document(app)?;
  app
    .get_webview_window(&label)
    .ok_or_else(|| "the document window is gone".to_string())
}
/// Starts handing the sticky `note_id` over to a document window as a tab over the
/// finished conversion `convert_id`. The target is chosen by the open-target
/// setting, and the window gets it as `open-converted { handoff_id }` or, while it
/// is loading, from `doc_window_ready`. The tab gets the sticky's `language`, and the
/// `encoding` and `line_ending` (`LF` or `CRLF`) the conversion used. An error means
/// nothing was handed over: the conversion file is deleted and the sticky stays as
/// it is. Returns the handoff id.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn convert_handoff_start(
  app: AppHandle,
  handoffs: State<Handoffs>,
  converts: State<ConvertStore>,
  note_id: String,
  convert_id: String,
  language: Option<String>,
  encoding: String,
  line_ending: String,
) -> Result<u64, String> {
  let format = TabFormat {
    language,
    encoding,
    line_ending,
  };
  let id = start_core(
    &handoffs,
    &converts,
    &note_id,
    &convert_id,
    format,
    Instant::now(),
  )?;
  let timer = app.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(CLAIM_TIMEOUT).await;
    if let (Some(handoffs), Some(converts)) = (
      timer.try_state::<Handoffs>(),
      timer.try_state::<ConvertStore>(),
    ) {
      expire_core(&AppShell(&timer), &handoffs, &converts, Instant::now());
    }
  });
  let sent = target_window(&app).and_then(|window| {
    handoffs.send_to(id, window.label());
    if crate::pending_opens::open_converted_in_window(&window, id) {
      Ok(())
    } else {
      Err("the document window did not take the document".to_string())
    }
  });
  if let Err(e) = sent {
    // The sticky is told by the error, not by an event.
    if let Some(item) = handoffs.failed(id) {
      converts.abort(&item.convert_id);
    }
    return Err(e);
  }
  Ok(id)
}
/// The window takes the handoff `handoff_id`; the conversion file's id, to open the
/// tab over it with `windowed_open_converted`, the sticky's, and the language,
/// encoding and line ending the tab gets. Refused (the error `refused`) when the
/// handoff was reclaimed, is taken, or was sent to another window.
#[tauri::command(async)]
pub fn convert_claim(
  window: tauri::Window,
  handoffs: State<Handoffs>,
  converts: State<ConvertStore>,
  handoff_id: u64,
) -> Result<Claimed, String> {
  claim_core(
    &handoffs,
    &converts,
    handoff_id,
    window.label(),
    Instant::now(),
  )
}
/// The window has the tab `tab_id` open over the handoff's file. The sticky's
/// window closes and the sticky is out of the lists until its tab is saved or its
/// changes are discarded. Ignored when the handoff is no longer the window's.
#[tauri::command(async)]
pub fn convert_done(
  app: AppHandle,
  window: tauri::Window,
  handoffs: State<Handoffs>,
  store: State<NoteStore>,
  handoff_id: u64,
  tab_id: String,
) {
  done_core(
    &AppShell(&app),
    &handoffs,
    &store,
    handoff_id,
    window.label(),
    &tab_id,
  );
}
/// The window could not open the tab. The conversion file is deleted and the
/// sticky is told to unlock (`convert-reclaimed`). Ignored when the handoff is
/// over.
#[tauri::command(async)]
pub fn convert_failed(
  app: AppHandle,
  handoffs: State<Handoffs>,
  converts: State<ConvertStore>,
  handoff_id: u64,
) {
  failed_core(&AppShell(&app), &handoffs, &converts, handoff_id);
}
/// The changes of the tab a sticky became were discarded: the sticky is back, in a
/// window of its own, as its record has it.
#[tauri::command(async)]
pub fn convert_release(
  app: AppHandle,
  store: State<NoteStore>,
  note_id: String,
) -> Result<(), String> {
  release_core(&AppShell(&app), &store, &note_id)
}
/// The tab a sticky became was saved for the first time: the sticky's record is
/// deleted and it is no longer handed off.
#[tauri::command(async)]
pub fn convert_sticky_saved(
  app: AppHandle,
  store: State<NoteStore>,
  note_id: String,
) -> Result<(), String> {
  sticky_saved_core(&AppShell(&app), &store, &note_id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::RefCell;
  use std::fs;
  use std::path::Path;
  use tempfile::{tempdir, TempDir};
  /// What the handoffs did to the app.
  #[derive(Default)]
  struct Spy {
    log: RefCell<Vec<String>>,
  }

  impl Shell for Spy {
    fn sticky_reclaimed(&self, r: &Reclaimed, why: Why) {
      self
        .log
        .borrow_mut()
        .push(format!("reclaimed {} {}", r.note_id, why.as_str()));
    }
    fn close_sticky(&self, note_id: &str) {
      self.log.borrow_mut().push(format!("close {note_id}"));
    }
    fn show_sticky(&self, note: &NoteSnapshot) -> Result<(), String> {
      self.log.borrow_mut().push(format!("show {}", note.id));
      Ok(())
    }
    fn changed(&self, note_id: &str) {
      self.log.borrow_mut().push(format!("changed {note_id}"));
    }
  }

  impl Spy {
    fn seen(&self) -> Vec<String> {
      std::mem::take(&mut *self.log.borrow_mut())
    }
  }

  struct Rig {
    dir: TempDir,
    spy: Spy,
    handoffs: Handoffs,
    converts: ConvertStore,
    store: NoteStore,
    t0: Instant,
  }

  fn format() -> TabFormat {
    TabFormat {
      language: Some("rust".to_string()),
      encoding: "Shift_JIS".to_string(),
      line_ending: "CRLF".to_string(),
    }
  }

  fn sticky(id: &str) -> NoteSnapshot {
    serde_json::from_value(serde_json::json!({
      "id": id,
      "content": "text",
      "file_path": null,
    }))
    .unwrap()
  }

  impl Rig {
    fn new() -> Rig {
      let dir = tempdir().unwrap();
      let store = NoteStore::load(dir.path().join("notes")).unwrap();
      store.upsert(sticky("a")).unwrap();
      store.upsert(sticky("b")).unwrap();
      Rig {
        converts: ConvertStore::new(Some(dir.path().join("tmp"))),
        spy: Spy::default(),
        handoffs: Handoffs::default(),
        store,
        t0: Instant::now(),
        dir,
      }
    }
    /// A finished conversion file and a handoff of sticky `note` over it.
    fn start(&self, note: &str) -> (u64, String) {
      let convert = self.converts.begin(None, "\n").unwrap();
      self.converts.append(&convert, "text").unwrap();
      self.converts.finish(&convert).unwrap();
      (
        self.handoffs.start(note, &convert, format(), self.t0),
        convert,
      )
    }
    fn files(&self) -> usize {
      fs::read_dir(self.dir.path().join("tmp")).map_or(0, |d| d.flatten().count())
    }
    fn listed(&self) -> Vec<String> {
      self.store.list().into_iter().map(|n| n.id).collect()
    }
    fn done(&self, id: u64, window: &str, tab: &str) {
      done_core(&self.spy, &self.handoffs, &self.store, id, window, tab);
    }
    fn later(&self, secs: u64) -> Instant {
      self.t0 + Duration::from_secs(secs)
    }
  }

  #[test]
  fn a_claimed_handoff_gives_its_file_and_is_then_done_by_the_claimer_only() {
    let rig = Rig::new();
    let (id, convert) = rig.start("a");
    assert_eq!(
      rig.handoffs.claim(id, "doc-1", rig.later(1)),
      Ok(Claimed {
        convert_id: convert,
        note_id: "a".to_string(),
        language: Some("rust".to_string()),
        encoding: "Shift_JIS".to_string(),
        line_ending: "CRLF".to_string(),
      })
    );
    // Only one window gets it.
    assert!(rig.handoffs.claim(id, "doc-2", rig.later(2)).is_err());
    // Another window cannot finish it.
    rig.done(id, "doc-2", "t");
    assert_eq!(rig.store.handed_off("a"), None);
    assert!(rig.spy.seen().is_empty());
    rig.done(id, "doc-1", "tab-9");
    assert_eq!(
      rig.spy.seen(),
      vec!["close a".to_string(), "changed a".to_string()]
    );
    assert_eq!(
      rig.store.handed_off("a"),
      Some(HandedLoc {
        window: "doc-1".to_string(),
        tab_id: "tab-9".to_string()
      })
    );
  }

  #[test]
  fn a_claim_reaches_the_frontend_as_both_ids() {
    let rig = Rig::new();
    let (id, convert) = rig.start("a");
    let claimed = rig.handoffs.claim(id, "doc-1", rig.later(1)).unwrap();
    assert_eq!(
      serde_json::to_value(claimed).unwrap(),
      serde_json::json!({
        "convert_id": convert,
        "note_id": "a",
        "language": "rust",
        "encoding": "Shift_JIS",
        "line_ending": "CRLF",
      })
    );
    assert_eq!(
      rig.handoffs.claim(id, "doc-1", rig.later(2)),
      Err("refused".to_string())
    );
  }

  #[test]
  fn a_claim_gives_back_what_the_start_stored() {
    let rig = Rig::new();
    let convert = rig.converts.begin(None, "\n").unwrap();
    rig.converts.finish(&convert).unwrap();
    for (language, encoding, line_ending) in [
      (None, "UTF-8", "LF"),
      (Some("markdown"), "Windows-1252", "CRLF"),
    ] {
      let format = TabFormat {
        language: language.map(str::to_string),
        encoding: encoding.to_string(),
        line_ending: line_ending.to_string(),
      };
      let id = start_core(&rig.handoffs, &rig.converts, "a", &convert, format, rig.t0).unwrap();
      let claimed = claim_core(&rig.handoffs, &rig.converts, id, "doc-1", rig.later(1)).unwrap();
      assert_eq!(claimed.language.as_deref(), language);
      assert_eq!(claimed.encoding, encoding);
      assert_eq!(claimed.line_ending, line_ending);
    }
  }

  #[test]
  fn a_line_ending_that_is_neither_lf_nor_crlf_starts_nothing() {
    let rig = Rig::new();
    let convert = rig.converts.begin(None, "\n").unwrap();
    rig.converts.finish(&convert).unwrap();
    for bad in ["CR", "lf", "", "\r\n"] {
      let format = TabFormat {
        line_ending: bad.to_string(),
        ..format()
      };
      let started = start_core(&rig.handoffs, &rig.converts, "a", &convert, format, rig.t0);
      assert!(started.is_err(), "{bad:?}");
    }
    assert!(rig.handoffs.claim(1, "doc-1", rig.later(1)).is_err());
  }

  #[test]
  fn a_claim_after_the_timeout_is_refused_and_the_sticky_keeps_its_record() {
    let rig = Rig::new();
    let (id, _) = rig.start("a");
    assert!(rig.handoffs.claim(id, "doc-1", rig.later(30)).is_err());
    expire_core(&rig.spy, &rig.handoffs, &rig.converts, rig.later(30));
    assert_eq!(rig.spy.seen(), vec!["reclaimed a timeout".to_string()]);
    assert!(rig.handoffs.claim(id, "doc-1", rig.later(31)).is_err());
    assert!(rig.store.get("a").is_some());
    assert_eq!(rig.listed(), vec!["a", "b"]);
    assert_eq!(rig.files(), 0, "the file is deleted");
    // Just in time is fine.
    let (id, _) = rig.start("b");
    assert!(rig.handoffs.claim(id, "doc-1", rig.later(29)).is_ok());
  }

  #[test]
  fn nothing_expires_that_was_claimed_or_is_early() {
    let rig = Rig::new();
    let (early, _) = rig.start("a");
    let (claimed, _) = rig.start("b");
    rig.handoffs.claim(claimed, "doc-1", rig.later(1)).unwrap();
    expire_core(&rig.spy, &rig.handoffs, &rig.converts, rig.later(29));
    assert!(rig.spy.seen().is_empty());
    expire_core(&rig.spy, &rig.handoffs, &rig.converts, rig.later(300));
    assert_eq!(rig.spy.seen(), vec!["reclaimed a timeout".to_string()]);
    assert!(rig.handoffs.claim(early, "doc-1", rig.later(1)).is_err());
    rig.done(claimed, "doc-1", "t");
    assert_eq!(
      rig.store.handed_off("b").map(|l| l.tab_id),
      Some("t".into())
    );
  }

  #[test]
  fn done_after_the_timeout_is_ignored() {
    let rig = Rig::new();
    let (id, _) = rig.start("a");
    expire_core(&rig.spy, &rig.handoffs, &rig.converts, rig.later(31));
    rig.spy.seen();
    rig.done(id, "doc-1", "t");
    assert!(rig.spy.seen().is_empty());
    assert_eq!(rig.store.handed_off("a"), None);
    assert_eq!(rig.listed(), vec!["a", "b"]);
  }

  #[test]
  fn done_keeps_the_record_and_hides_the_sticky_from_every_list() {
    let rig = Rig::new();
    let (id, _) = rig.start("a");
    rig.handoffs.claim(id, "doc-1", rig.later(1)).unwrap();
    rig.done(id, "doc-1", "t");
    assert!(rig.store.get("a").is_some(), "the record stays");
    assert_eq!(rig.listed(), vec!["b"]);
    // A second done changes nothing.
    rig.spy.seen();
    rig.done(id, "doc-1", "other");
    assert!(rig.spy.seen().is_empty());
    assert_eq!(
      rig.store.handed_off("a").map(|l| l.tab_id),
      Some("t".into())
    );
  }

  #[test]
  fn a_window_destroyed_after_the_claim_gives_the_handoff_back_and_deletes_the_file() {
    let rig = Rig::new();
    let (id, _) = rig.start("a");
    rig.handoffs.claim(id, "doc-1", rig.later(1)).unwrap();
    window_destroyed_core(&rig.spy, &rig.handoffs, &rig.converts, &rig.store, "doc-1");
    assert_eq!(
      rig.spy.seen(),
      vec!["reclaimed a window-closed".to_string()]
    );
    assert_eq!(rig.files(), 0);
    // What comes after is ignored.
    rig.done(id, "doc-1", "t");
    assert!(rig.spy.seen().is_empty());
    assert_eq!(rig.listed(), vec!["a", "b"]);
    // Another window's destruction does not touch a handoff.
    let (id, _) = rig.start("b");
    rig.handoffs.claim(id, "doc-2", rig.later(1)).unwrap();
    window_destroyed_core(&rig.spy, &rig.handoffs, &rig.converts, &rig.store, "doc-1");
    assert!(rig.spy.seen().is_empty());
    assert_eq!(rig.files(), 1);
  }
  /// A finished file the sticky's window `owner` made, handed off.
  fn handed(rig: &Rig, owner: &str) -> (u64, String) {
    let convert = rig.converts.begin(Some(owner), "\n").unwrap();
    rig.converts.append(&convert, "text").unwrap();
    rig.converts.finish(&convert).unwrap();
    let id = start_core(
      &rig.handoffs,
      &rig.converts,
      "a",
      &convert,
      format(),
      rig.t0,
    )
    .unwrap();
    (id, convert)
  }

  #[test]
  fn a_handoff_of_a_conversion_that_is_gone_does_not_start() {
    let rig = Rig::new();
    let convert = rig.converts.begin(Some("note-a"), "\n").unwrap();
    rig.converts.abort_window("note-a");
    assert!(start_core(
      &rig.handoffs,
      &rig.converts,
      "a",
      &convert,
      format(),
      rig.t0
    )
    .is_err());
  }

  #[test]
  fn a_pending_handoff_survives_the_sticky_window_and_keeps_its_timeout() {
    let rig = Rig::new();
    let (id, _) = handed(&rig, "note-a");
    rig.handoffs.send_to(id, "doc-1");
    rig.converts.abort_window("note-a");
    assert_eq!(rig.files(), 1);
    expire_core(&rig.spy, &rig.handoffs, &rig.converts, rig.later(1));
    assert_eq!(rig.files(), 1);
    expire_core(&rig.spy, &rig.handoffs, &rig.converts, rig.later(30));
    assert_eq!(rig.spy.seen(), vec!["reclaimed a timeout".to_string()]);
    assert_eq!(rig.files(), 0);
    assert_eq!(rig.files(), 0);
  }

  #[test]
  fn a_pending_handoff_the_sticky_window_outlives_can_still_be_claimed() {
    let rig = Rig::new();
    let (id, convert) = handed(&rig, "note-a");
    rig.converts.abort_window("note-a");
    let claimed = claim_core(&rig.handoffs, &rig.converts, id, "doc-1", rig.later(1)).unwrap();
    assert_eq!(claimed.convert_id, convert);
    assert_eq!(rig.files(), 1);
  }

  #[test]
  fn a_claimed_conversion_belongs_to_the_claiming_window() {
    let rig = Rig::new();
    let (id, _) = handed(&rig, "note-a");
    claim_core(&rig.handoffs, &rig.converts, id, "doc-1", rig.later(1)).unwrap();
    // Another window's cleanup leaves it; the claiming window's takes it.
    rig.converts.abort_window("note-a");
    rig.converts.abort_window("doc-2");
    assert_eq!(rig.files(), 1);
    rig.converts.abort_window("doc-1");
    assert_eq!(rig.files(), 0);
    assert_eq!(rig.files(), 0);
  }

  #[test]
  fn a_refused_claim_does_not_change_the_owner() {
    let rig = Rig::new();
    let (id, _) = handed(&rig, "note-a");
    rig.handoffs.send_to(id, "doc-1");
    assert!(claim_core(&rig.handoffs, &rig.converts, id, "doc-2", rig.later(1)).is_err());
    rig.converts.abort_window("doc-2");
    assert_eq!(rig.files(), 1);
  }

  #[test]
  fn the_commands_hand_the_owner_over() {
    let source = include_str!("convert_handoff.rs");
    let at = source.find("pub fn convert_handoff_start(").unwrap();
    let body = &source[at..];
    let body = &body[..body.find("\n}\n").unwrap()];
    assert!(body.contains("start_core("));
    assert!(body.contains("line_ending"));
    let at = source.find("pub fn convert_claim(").unwrap();
    let body = &source[at..];
    let body = &body[..body.find("\n}\n").unwrap()];
    assert!(body.contains("claim_core("));
    assert!(body.contains("window.label()"));
  }

  #[test]
  fn a_handoff_sent_to_a_window_that_goes_unready_is_reclaimed_and_cannot_be_claimed() {
    let rig = Rig::new();
    let (id, _) = rig.start("a");
    rig.handoffs.send_to(id, "doc-1");
    // Sent to doc-1: another window may not take it.
    assert!(rig.handoffs.claim(id, "doc-2", rig.later(1)).is_err());
    give_back(
      &rig.spy,
      &rig.converts,
      rig.handoffs.give_back(&[id]),
      Why::WindowClosed,
    );
    assert_eq!(
      rig.spy.seen(),
      vec!["reclaimed a window-closed".to_string()]
    );
    assert!(rig.handoffs.claim(id, "doc-1", rig.later(1)).is_err());
    assert_eq!(rig.files(), 0);
    // Giving it back twice tells the sticky once.
    give_back(
      &rig.spy,
      &rig.converts,
      rig.handoffs.give_back(&[id]),
      Why::WindowClosed,
    );
    assert!(rig.spy.seen().is_empty());
  }

  #[test]
  fn a_window_destroyed_while_the_handoff_was_pending_for_it_reclaims_it() {
    let rig = Rig::new();
    let (id, _) = rig.start("a");
    rig.handoffs.send_to(id, "doc-1");
    window_destroyed_core(&rig.spy, &rig.handoffs, &rig.converts, &rig.store, "doc-1");
    assert_eq!(
      rig.spy.seen(),
      vec!["reclaimed a window-closed".to_string()]
    );
    assert!(rig.handoffs.claim(id, "doc-1", rig.later(1)).is_err());
  }

  #[test]
  fn failed_goes_back_once_whatever_the_state_and_never_after_done() {
    let rig = Rig::new();
    let (pending, _) = rig.start("a");
    failed_core(&rig.spy, &rig.handoffs, &rig.converts, pending);
    assert_eq!(rig.spy.seen(), vec!["reclaimed a failed".to_string()]);
    failed_core(&rig.spy, &rig.handoffs, &rig.converts, pending);
    assert!(rig.spy.seen().is_empty());
    let (claimed, _) = rig.start("b");
    rig.handoffs.claim(claimed, "doc-1", rig.later(1)).unwrap();
    rig.done(claimed, "doc-1", "t");
    rig.spy.seen();
    failed_core(&rig.spy, &rig.handoffs, &rig.converts, claimed);
    assert!(rig.spy.seen().is_empty());
    assert!(rig.store.handed_off("b").is_some());
    failed_core(&rig.spy, &rig.handoffs, &rig.converts, 999);
    assert!(rig.spy.seen().is_empty());
  }

  #[test]
  fn a_file_a_session_took_is_not_deleted_by_a_reclaim() {
    let rig = Rig::new();
    let (id, convert) = rig.start("a");
    rig.handoffs.claim(id, "doc-1", rig.later(1)).unwrap();
    let tmp = rig.converts.take(&convert).unwrap();
    window_destroyed_core(&rig.spy, &rig.handoffs, &rig.converts, &rig.store, "doc-1");
    assert!(Path::new(tmp.path()).exists());
  }

  #[test]
  fn the_first_save_deletes_the_record_and_empties_the_set() {
    let rig = Rig::new();
    let (id, _) = rig.start("a");
    rig.handoffs.claim(id, "doc-1", rig.later(1)).unwrap();
    rig.done(id, "doc-1", "t");
    rig.spy.seen();
    sticky_saved_core(&rig.spy, &rig.store, "a").unwrap();
    assert_eq!(rig.spy.seen(), vec!["changed a".to_string()]);
    assert!(rig.store.get("a").is_none());
    assert_eq!(rig.store.handed_off("a"), None);
    assert_eq!(rig.listed(), vec!["b"]);
    // It stays deleted after a restart.
    let reloaded = NoteStore::load(rig.store.current_dir()).unwrap();
    assert!(reloaded.get("a").is_none());
  }

  #[test]
  fn releasing_brings_the_sticky_back_from_its_record() {
    let rig = Rig::new();
    let (id, _) = rig.start("a");
    rig.handoffs.claim(id, "doc-1", rig.later(1)).unwrap();
    rig.done(id, "doc-1", "t");
    assert_eq!(rig.listed(), vec!["b"]);
    rig.spy.seen();
    release_core(&rig.spy, &rig.store, "a").unwrap();
    assert_eq!(
      rig.spy.seen(),
      vec!["changed a".to_string(), "show a".to_string()]
    );
    assert_eq!(rig.listed(), vec!["a", "b"]);
    assert_eq!(rig.store.handed_off("a"), None);
    // A sticky that is not handed off has nothing to show.
    release_core(&rig.spy, &rig.store, "a").unwrap();
    assert!(rig.spy.seen().is_empty());
  }

  #[test]
  fn a_window_with_a_handed_off_tab_destroyed_frees_the_sticky_without_a_window() {
    let rig = Rig::new();
    let (id, _) = rig.start("a");
    rig.handoffs.claim(id, "doc-1", rig.later(1)).unwrap();
    rig.done(id, "doc-1", "t");
    rig.spy.seen();
    window_destroyed_core(&rig.spy, &rig.handoffs, &rig.converts, &rig.store, "doc-2");
    assert!(rig.spy.seen().is_empty());
    assert_eq!(rig.listed(), vec!["b"]);
    window_destroyed_core(&rig.spy, &rig.handoffs, &rig.converts, &rig.store, "doc-1");
    assert_eq!(rig.spy.seen(), vec!["changed a".to_string()]);
    assert_eq!(rig.listed(), vec!["a", "b"]);
    assert!(
      rig.store.get("a").is_some(),
      "the record is for the next start"
    );
  }

  const SOURCE: &str = include_str!("convert_handoff.rs");
  const NEW_COMMANDS: &[&str] = &[
    "convert_handoff_start",
    "convert_claim",
    "convert_done",
    "convert_failed",
    "convert_release",
    "convert_sticky_saved",
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
        "{name} must be #[tauri::command(async)]: it deletes files and opens windows"
      );
    }
  }
}
