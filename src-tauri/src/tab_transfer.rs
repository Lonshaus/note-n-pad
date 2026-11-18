// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Moving a tab from one document window to another, or out into a window of its
// own. The tab is in two places only for the length of one handshake and its
// record always follows it: the sender freezes the tab and begins, the receiver
// claims the tab, answers, installs it and reports where it put it, and only
// then does the sender let it go. `TransferBook` holds the open transfers and is
// pure: every method returns the actions to perform, so the rules are tested
// without a window.
//
// Commands take the calling window and check it against the transfer, as
// `convert_claim` does. Results come back as return values; events only tell a
// window that something new happened.

use crate::note_store::{NoteStore, TabPlacement};
use crate::window_at::{self, Decision, Hit, Point};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
/// An existing receiving window has this long from `begin` to answer.
const EXISTING_WINDOW_TIMEOUT: Duration = Duration::from_secs(5);
/// A new window has this long from `begin` to load and claim.
const NEW_WINDOW_CLAIM_TIMEOUT: Duration = Duration::from_secs(30);
/// A new window has this long from its claim to answer and report.
const NEW_WINDOW_COMMIT_TIMEOUT: Duration = Duration::from_secs(5);
/// Where a released tab goes: what `tab_drop_target` answers and `begin` takes
/// back unchanged for the `doc` and `new_window` variants.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DropTarget {
  /// The own window: reorder, or return the tab to its slot.
  #[serde(rename = "self")]
  SelfWindow,
  /// Another document window; `offset` is the release point minus its inner
  /// origin, in native units.
  Doc {
    label: String,
    offset: Point,
  },
  /// A window of its own, with its top left at `point`.
  NewWindow {
    point: Point,
  },
  /// The window itself moves to `point` (the tab was its only one).
  MoveWindow {
    point: Point,
  },
  Cancel,
}
/// Why `begin` did not start a transfer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
  Busy,
  Quitting,
  NotReady,
}
/// What `tab_transfer_begin` answers.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BeginResult {
  Started { t: u64 },
  Refused { reason: Refusal },
}
/// What `tab_transfer_claim` answers: the tab as the sender packed it, and where
/// it was dropped when the receiver is an existing window.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Claimed {
  pub payload: Value,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub offset: Option<Point>,
}
/// What `tab_transfer_answer` answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Answer {
  Commit,
  Expired,
}
/// What `tab_transfer_committed` answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitResult {
  Accepted,
  Rejected,
}
/// What `tab_transfer_cancel` answers: called off, or too late.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelResult {
  Cancelled,
  Accepted,
}
/// What `tab_transfer_status` answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
  Pending,
  Accepted,
  Gone,
}
/// Window bounds as the receiver reports them; each field is a number or null.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
  pub x: Option<f64>,
  pub y: Option<f64>,
  pub width: Option<f64>,
  pub height: Option<f64>,
}
/// Where the receiver put the tab: what the stored record is rewritten to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedMeta {
  pub tab_index: i64,
  pub order: f64,
  pub group: String,
  pub project: Option<String>,
  pub bounds: Bounds,
}
impl CommittedMeta {
  fn placement(&self) -> TabPlacement {
    TabPlacement {
      group: self.group.clone(),
      tab_index: self.tab_index,
      order: self.order,
      project: self.project.clone(),
      x: self.bounds.x,
      y: self.bounds.y,
      width: self.bounds.width,
      height: self.bounds.height,
    }
  }
}
/// What a window does with one transfer of its own that was settled.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
  tag = "kind",
  rename_all = "snake_case",
  rename_all_fields = "camelCase"
)]
pub enum SettleAction {
  /// An outgoing transfer was called off: the tab is the window's again.
  Unfreeze { t: u64, note_id: String },
  /// An incoming transfer was called off: drop the copy.
  DropIncoming { t: u64 },
  /// An outgoing transfer was accepted elsewhere: let the tab go now.
  Release { t: u64, note_id: String },
}
/// The payload of the events: which transfer.
#[derive(Clone, Copy, Serialize)]
struct TransferEvent {
  t: u64,
}
/// Where the receiver is.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
  Existing { label: String, offset: Point },
  NewWindow { label: String },
}
impl Target {
  /// The target of a `begin` from a `DropTarget` it accepts; a new window gets
  /// the label `mint` makes.
  pub fn from_drop(drop: &DropTarget, mint: impl FnOnce() -> String) -> Result<Target, String> {
    match drop {
      DropTarget::Doc { label, offset } => Ok(Target::Existing {
        label: label.clone(),
        offset: *offset,
      }),
      DropTarget::NewWindow { .. } => Ok(Target::NewWindow { label: mint() }),
      other => Err(format!("a transfer cannot begin for {other:?}")),
    }
  }
  fn label(&self) -> &str {
    match self {
      Target::Existing { label, .. } | Target::NewWindow { label } => label,
    }
  }
}
/// Something the caller of a `TransferBook` method carries out.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
  EmitIn {
    label: String,
    t: u64,
  },
  EmitRelease {
    label: String,
    t: u64,
  },
  EmitCancel {
    label: String,
    t: u64,
  },
  EmitAbort {
    label: String,
    t: u64,
  },
  /// From now on only `label` writes `note` (while it exists).
  SetOwner {
    note: String,
    label: String,
  },
  /// A new window whose transfer did not end accepted.
  Destroy {
    label: String,
  },
  /// Look at transfer `t` again after `after`: it may have expired.
  Schedule {
    t: u64,
    after: Duration,
  },
}
/// What `begin` needs to know of the app.
pub struct BeginContext<'a> {
  pub quitting: bool,
  /// Whether a window has announced itself and so takes an event directly.
  pub ready: &'a dyn Fn(&str) -> bool,
}
/// What `TransferBook::begin` decided.
#[derive(Debug, PartialEq)]
pub enum Begin {
  Refused(Refusal),
  Started { t: u64, actions: Vec<Action> },
}
/// The store calls a `committed` makes, atomically with the book.
pub trait TransferStore {
  fn update_placement(&self, id: &str, placement: &TabPlacement) -> Result<bool, String>;
  fn set_owner(&self, id: &str, label: &str);
  fn retarget_handed_off(&self, sticky: &str, window: &str) -> bool;
}
impl TransferStore for NoteStore {
  fn update_placement(&self, id: &str, placement: &TabPlacement) -> Result<bool, String> {
    NoteStore::update_placement(self, id, placement)
  }
  fn set_owner(&self, id: &str, label: &str) {
    NoteStore::set_owner(self, id, label);
  }
  fn retarget_handed_off(&self, sticky: &str, window: &str) -> bool {
    NoteStore::retarget_handed_off(self, sticky, window)
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
  /// Begun, not claimed.
  Open,
  /// Claimed, not answered.
  Claimed,
  /// The receiver was told to commit.
  Answered,
  /// The receiver reported where it put the tab; the sender may let it go.
  Accepted,
}
struct Entry {
  note: String,
  /// The sticky the tab came from, when it is a handed-off one.
  sticky: Option<String>,
  sender: String,
  receiver: String,
  offset: Option<Point>,
  new_window: bool,
  payload: Value,
  phase: Phase,
  deadline: Instant,
  /// The sender went after the receiver was told to commit.
  sender_gone: bool,
}
/// The open transfers, by id and by the note they carry.
#[derive(Default)]
pub struct TransferBook {
  entries: HashMap<u64, Entry>,
  by_note: HashMap<String, u64>,
  last: u64,
}
/// The note id and the sticky id (when it has one) of a packed tab.
fn ids_of(payload: &Value) -> Option<(String, Option<String>)> {
  let tab = payload.get("tab")?;
  let id = tab.get("id")?.as_str()?.to_string();
  let sticky = tab
    .get("converted")
    .and_then(|converted| converted.get("noteId"))
    .and_then(Value::as_str)
    .map(str::to_string);
  Some((id, sticky))
}
impl TransferBook {
  /// Start a transfer of the tab in `payload` from `sender` to `target`.
  pub fn begin(
    &mut self,
    sender: &str,
    payload: Value,
    target: Target,
    now: Instant,
    ctx: &BeginContext,
  ) -> Result<Begin, String> {
    let (note, sticky) = ids_of(&payload).ok_or("the payload has no tab id")?;
    if target.label() == sender {
      return Err("a tab cannot be transferred to its own window".to_string());
    }
    if self.by_note.contains_key(&note) {
      return Ok(Begin::Refused(Refusal::Busy));
    }
    if ctx.quitting {
      return Ok(Begin::Refused(Refusal::Quitting));
    }
    if matches!(&target, Target::Existing { label, .. } if !(ctx.ready)(label)) {
      return Ok(Begin::Refused(Refusal::NotReady));
    }
    self.last += 1;
    let t = self.last;
    let receiver = target.label().to_string();
    let (offset, new_window, wait) = match target {
      Target::Existing { offset, .. } => (Some(offset), false, EXISTING_WINDOW_TIMEOUT),
      Target::NewWindow { .. } => (None, true, NEW_WINDOW_CLAIM_TIMEOUT),
    };
    let mut actions = vec![Action::SetOwner {
      note: note.clone(),
      label: sender.to_string(),
    }];
    if !new_window {
      actions.push(Action::EmitIn {
        label: receiver.clone(),
        t,
      });
    }
    actions.push(Action::Schedule { t, after: wait });
    self.by_note.insert(note.clone(), t);
    self.entries.insert(
      t,
      Entry {
        note,
        sticky,
        sender: sender.to_string(),
        receiver,
        offset,
        new_window,
        payload,
        phase: Phase::Open,
        deadline: now + wait,
        sender_gone: false,
      },
    );
    Ok(Begin::Started { t, actions })
  }
  /// Call transfer `t` off if it is not accepted: the note is the sender's
  /// again, the sender is told to unfreeze, the receiver to drop its copy, and a
  /// new window is destroyed. Nothing for an unknown or accepted transfer.
  fn call_off(&mut self, t: u64) -> Vec<Action> {
    match self.entries.get(&t) {
      Some(entry) if entry.phase != Phase::Accepted => {}
      _ => return Vec::new(),
    }
    let entry = self.entries.remove(&t).expect("checked above");
    self.by_note.remove(&entry.note);
    let mut actions = vec![
      Action::SetOwner {
        note: entry.note,
        label: entry.sender.clone(),
      },
      Action::EmitCancel {
        label: entry.sender,
        t,
      },
      Action::EmitAbort {
        label: entry.receiver.clone(),
        t,
      },
    ];
    if entry.new_window {
      actions.push(Action::Destroy {
        label: entry.receiver,
      });
    }
    actions
  }
  fn remove(&mut self, t: u64) {
    if let Some(entry) = self.entries.remove(&t) {
      self.by_note.remove(&entry.note);
    }
  }
  /// The ids of the open transfers, lowest first.
  fn ids(&self) -> Vec<u64> {
    let mut ids: Vec<u64> = self.entries.keys().copied().collect();
    ids.sort_unstable();
    ids
  }
  /// The receiver takes the tab. Its payload, and the offset it was dropped at
  /// for an existing window; none for an unknown transfer, another caller or an
  /// expired one.
  pub fn claim(&mut self, t: u64, caller: &str, now: Instant) -> (Option<Claimed>, Vec<Action>) {
    let Some(entry) = self.entries.get_mut(&t) else {
      return (None, Vec::new());
    };
    if entry.receiver != caller || entry.phase == Phase::Accepted {
      return (None, Vec::new());
    }
    if now >= entry.deadline {
      return (None, self.call_off(t));
    }
    let mut actions = Vec::new();
    if entry.phase == Phase::Open {
      entry.phase = Phase::Claimed;
      // A window that had to load is given time to answer from its claim.
      if entry.new_window {
        entry.deadline = now + NEW_WINDOW_COMMIT_TIMEOUT;
        actions.push(Action::Schedule {
          t,
          after: NEW_WINDOW_COMMIT_TIMEOUT,
        });
      }
    }
    let claimed = Claimed {
      payload: entry.payload.clone(),
      offset: entry.offset,
    };
    (Some(claimed), actions)
  }
  /// The receiver can take the tab (`ok`) or cannot. `commit` only before the
  /// transfer expires; anything else is `expired` and calls the transfer off.
  pub fn answer(&mut self, t: u64, ok: bool, caller: &str, now: Instant) -> (Answer, Vec<Action>) {
    let Some(entry) = self.entries.get_mut(&t) else {
      return (Answer::Expired, Vec::new());
    };
    if entry.receiver != caller || matches!(entry.phase, Phase::Open | Phase::Accepted) {
      return (Answer::Expired, Vec::new());
    }
    if !ok || now >= entry.deadline {
      return (Answer::Expired, self.call_off(t));
    }
    entry.phase = Phase::Answered;
    (Answer::Commit, Vec::new())
  }
  /// The receiver put the tab at `meta`. Rewrites the stored record (nothing to
  /// rewrite for a tab that has none), makes the receiver the note's owner,
  /// moves a handed-off sticky with it and tells the sender to let go. A
  /// transfer called off meanwhile is `rejected`; so is a failing store write,
  /// which calls it off.
  pub fn committed(
    &mut self,
    t: u64,
    caller: &str,
    meta: &CommittedMeta,
    store: &dyn TransferStore,
  ) -> (CommitResult, Vec<Action>) {
    let Some(entry) = self.entries.get(&t) else {
      return (CommitResult::Rejected, Vec::new());
    };
    if entry.receiver != caller {
      return (CommitResult::Rejected, Vec::new());
    }
    match entry.phase {
      Phase::Accepted => return (CommitResult::Accepted, Vec::new()),
      Phase::Open | Phase::Claimed => return (CommitResult::Rejected, Vec::new()),
      Phase::Answered => {}
    }
    if let Err(e) = store.update_placement(&entry.note, &meta.placement()) {
      log::warn!("could not rewrite the record of a moved tab: {e}");
      return (CommitResult::Rejected, self.call_off(t));
    }
    store.set_owner(&entry.note, &entry.receiver);
    if let Some(sticky) = &entry.sticky {
      store.retarget_handed_off(sticky, &entry.receiver);
    }
    let release = Action::EmitRelease {
      label: entry.sender.clone(),
      t,
    };
    let gone = entry.sender_gone;
    if let Some(entry) = self.entries.get_mut(&t) {
      entry.phase = Phase::Accepted;
    }
    // Nobody is left to say it let go.
    if gone {
      self.remove(t);
    }
    (CommitResult::Accepted, vec![release])
  }
  /// The sender calls the transfer off. Too late once the receiver put the tab.
  pub fn cancel(&mut self, t: u64, caller: &str) -> (CancelResult, Vec<Action>) {
    match self.entries.get(&t) {
      Some(entry) if entry.sender == caller => {
        if entry.phase == Phase::Accepted {
          (CancelResult::Accepted, Vec::new())
        } else {
          (CancelResult::Cancelled, self.call_off(t))
        }
      }
      _ => (CancelResult::Cancelled, Vec::new()),
    }
  }
  /// The sender let the tab go: the transfer is over.
  pub fn released(&mut self, t: u64, caller: &str) {
    let ours = self
      .entries
      .get(&t)
      .is_some_and(|e| e.sender == caller && e.phase == Phase::Accepted);
    if ours {
      self.remove(t);
    }
  }
  /// Where transfer `t` stands, for one of its two windows.
  pub fn status(&self, t: u64, caller: &str) -> Status {
    match self.entries.get(&t) {
      Some(entry) if entry.sender == caller || entry.receiver == caller => {
        if entry.phase == Phase::Accepted {
          Status::Accepted
        } else {
          Status::Pending
        }
      }
      _ => Status::Gone,
    }
  }
  /// A timer for transfer `t` went off.
  pub fn expire(&mut self, t: u64, now: Instant) -> Vec<Action> {
    match self.entries.get(&t) {
      Some(entry) if entry.phase != Phase::Accepted && now >= entry.deadline => self.call_off(t),
      _ => Vec::new(),
    }
  }
  /// Window `label` is closing or being quit: every transfer of it not yet
  /// accepted is called off, in both directions, and what the window itself does
  /// about each one comes back. A transfer accepted elsewhere is let go now.
  pub fn settle_window(&mut self, label: &str) -> (Vec<SettleAction>, Vec<Action>) {
    let (mut settled, mut actions) = (Vec::new(), Vec::new());
    for t in self.ids() {
      let Some(entry) = self.entries.get(&t) else {
        continue;
      };
      let accepted = entry.phase == Phase::Accepted;
      let note_id = entry.note.clone();
      if entry.sender == label {
        if accepted {
          settled.push(SettleAction::Release { t, note_id });
        } else {
          actions.extend(self.call_off(t));
          settled.push(SettleAction::Unfreeze { t, note_id });
        }
      } else if entry.receiver == label && !accepted {
        actions.extend(self.call_off(t));
        settled.push(SettleAction::DropIncoming { t });
      }
    }
    (settled, actions)
  }
  /// Window `label` is gone (destroyed, or its page loaded again). The sender
  /// going before the receiver was told to commit calls the transfer off; after
  /// that it does not, and once accepted the entry only waited for it. The
  /// receiver going before it reported calls the transfer off.
  pub fn window_gone(&mut self, label: &str) -> Vec<Action> {
    let mut actions = Vec::new();
    for t in self.ids() {
      let Some(entry) = self.entries.get_mut(&t) else {
        continue;
      };
      if entry.sender == label {
        match entry.phase {
          Phase::Accepted => self.remove(t),
          Phase::Answered => entry.sender_gone = true,
          Phase::Open | Phase::Claimed => actions.extend(self.call_off(t)),
        }
      } else if entry.receiver == label {
        actions.extend(self.call_off(t));
      }
    }
    actions
  }
  /// A quit starts: every transfer not yet accepted is called off.
  pub fn quit_call_off(&mut self) -> Vec<Action> {
    let mut actions = Vec::new();
    for t in self.ids() {
      actions.extend(self.call_off(t));
    }
    actions
  }
  /// The file `from` was renamed to `to`: the tabs in flight follow it.
  pub fn retarget_paths(&mut self, from: &str, to: &str) {
    for entry in self.entries.values_mut() {
      let Some(Value::String(path)) = entry.payload.pointer_mut("/tab/path") else {
        continue;
      };
      let moved = crate::file_ops::retarget_path(path, from, to);
      if moved != *path {
        *path = moved;
      }
    }
  }
  #[cfg(test)]
  fn len(&self) -> usize {
    self.entries.len()
  }
}
/// The labels a quit waits for acks from: those of `labels` that are not being
/// destroyed by the quit's call-off.
pub fn ack_set(labels: impl IntoIterator<Item = String>, destroyed: &[String]) -> HashSet<String> {
  labels
    .into_iter()
    .filter(|label| !destroyed.contains(label))
    .collect()
}
/// The labels of the windows a set of actions destroys.
fn destroyed_by(actions: &[Action]) -> Vec<String> {
  actions
    .iter()
    .filter_map(|action| match action {
      Action::Destroy { label } => Some(label.clone()),
      _ => None,
    })
    .collect()
}
/// The `DropTarget` of a release at `point`.
fn drop_target_for(
  hit: &Hit,
  fullscreen: bool,
  same_monitor: bool,
  only_tab: bool,
  point: Point,
) -> DropTarget {
  match window_at::drop_decision(hit, fullscreen, same_monitor, only_tab) {
    Decision::Doc { label, offset } => DropTarget::Doc { label, offset },
    Decision::SelfWindow => DropTarget::SelfWindow,
    Decision::NewWindow => DropTarget::NewWindow { point },
    Decision::MoveWindow => DropTarget::MoveWindow { point },
    Decision::Cancel => DropTarget::Cancel,
  }
}
/// The open transfers, and the windows whose first page has loaded (a later
/// load is a reload: the page's state is gone).
#[derive(Default)]
pub struct TransferState {
  book: Mutex<TransferBook>,
  loaded: Mutex<HashSet<String>>,
}
fn emit(app: &AppHandle, label: &str, event: &str, t: u64) {
  let _ = app.emit_to(label, event, TransferEvent { t });
}
/// Carry out what the book decided.
fn run(app: &AppHandle, actions: Vec<Action>) {
  for action in actions {
    match action {
      Action::EmitIn { label, t } => emit(app, &label, "tab-transfer-in", t),
      Action::EmitRelease { label, t } => emit(app, &label, "tab-transfer-release", t),
      Action::EmitCancel { label, t } => emit(app, &label, "tab-transfer-cancel", t),
      Action::EmitAbort { label, t } => emit(app, &label, "tab-transfer-abort", t),
      Action::SetOwner { note, label } => {
        if let Some(store) = app.try_state::<NoteStore>() {
          store.set_owner(&note, &label);
        }
      }
      Action::Destroy { label } => {
        if let Some(window) = app.get_webview_window(&label) {
          let _ = window.destroy();
        }
      }
      Action::Schedule { t, after } => {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
          tokio::time::sleep(after).await;
          expire(&app, t);
        });
      }
    }
  }
}
fn expire(app: &AppHandle, t: u64) {
  let Some(state) = app.try_state::<TransferState>() else {
    return;
  };
  let actions = state.book.lock().unwrap().expire(t, Instant::now());
  run(app, actions);
}
/// Window `label` was destroyed or loaded its page again: its transfers follow
/// `TransferBook::window_gone`. Off the event loop: the actions can destroy a
/// window.
pub fn window_gone(app: &AppHandle, label: &str) {
  let Some(state) = app.try_state::<TransferState>() else {
    return;
  };
  state.loaded.lock().unwrap().remove(label);
  let actions = state.book.lock().unwrap().window_gone(label);
  if actions.is_empty() {
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || run(&app, actions));
}
/// A page of window `label` started loading. The first load of a window is its
/// start; a later one is a reload, which takes the page's state with it.
pub fn page_started(app: &AppHandle, label: &str) {
  let Some(state) = app.try_state::<TransferState>() else {
    return;
  };
  let reloaded = note_page_load(&mut state.loaded.lock().unwrap(), label);
  if reloaded {
    window_gone(app, label);
  }
}
/// Record that a page of `label` started loading: whether it is a reload, which
/// is any load of a window after its first.
fn note_page_load(loaded: &mut HashSet<String>, label: &str) -> bool {
  !loaded.insert(label.to_string())
}
/// A quit starts: call off every transfer not yet accepted. The labels of the
/// windows this destroys, which will never ack.
pub fn quit_call_off(app: &AppHandle) -> Vec<String> {
  let Some(state) = app.try_state::<TransferState>() else {
    return Vec::new();
  };
  let actions = state.book.lock().unwrap().quit_call_off();
  let destroyed = destroyed_by(&actions);
  run(app, actions);
  destroyed
}
/// The file `from` was renamed to `to`: tabs in flight follow it.
pub fn follow_move(app: &AppHandle, from: &str, to: &str) {
  if let Some(state) = app.try_state::<TransferState>() {
    state.book.lock().unwrap().retarget_paths(from, to);
  }
}
/// Where the tab of a release at the client point goes. Called by the sender on
/// every release. Main thread: the hit test reads window-system state.
#[tauri::command]
pub fn tab_drop_target(
  app: AppHandle,
  window: tauri::WebviewWindow,
  client_x: f64,
  client_y: f64,
  dpr: f64,
  only_tab: bool,
) -> DropTarget {
  let point = window_at::release_point(
    &window,
    Point {
      x: client_x,
      y: client_y,
    },
    dpr,
  );
  let (hit, same_monitor) = window_at::locate(&app, &window, point);
  let fullscreen = window.is_fullscreen().unwrap_or(false);
  drop_target_for(&hit, fullscreen, same_monitor, only_tab, point)
}
/// Move the calling window so that its top left is at `point`, un-maximizing it
/// first. For the only tab of a window dropped outside it.
#[tauri::command]
pub fn tab_move_window(window: tauri::WebviewWindow, point: Point) -> Result<(), String> {
  #[cfg(any(target_os = "macos", windows))]
  {
    if window.is_maximized().unwrap_or(false) {
      window.unmaximize().map_err(|e| e.to_string())?;
    }
    let size = window_at::outer_size(&window);
    window_at::set_top_left(&window, window_at::place(&window, point, size))
  }
  #[cfg(not(any(target_os = "macos", windows)))]
  {
    let _ = (window, point);
    Ok(())
  }
}
/// The sender starts a transfer of the packed tab `payload` to `target`, which
/// is what `tab_drop_target` answered (`doc` or `new_window`). `project` is the
/// sender's, which a new window takes. Builds a window, so it runs off the main
/// thread.
#[tauri::command(async)]
pub fn tab_transfer_begin(
  app: AppHandle,
  window: tauri::WebviewWindow,
  state: State<TransferState>,
  pending: State<crate::pending_opens::PendingOpens>,
  payload: Value,
  target: DropTarget,
  project: Option<String>,
) -> Result<BeginResult, String> {
  let group = uuid::Uuid::new_v4().to_string();
  let target_kind = Target::from_drop(&target, || format!("doc-{group}"))?;
  let ready = |label: &str| pending.is_ready(label);
  let ctx = BeginContext {
    quitting: crate::QUIT_IN_FLIGHT.load(std::sync::atomic::Ordering::SeqCst),
    ready: &ready,
  };
  let begin =
    state
      .book
      .lock()
      .unwrap()
      .begin(window.label(), payload, target_kind, Instant::now(), &ctx)?;
  let (t, actions) = match begin {
    Begin::Refused(reason) => return Ok(BeginResult::Refused { reason }),
    Begin::Started { t, actions } => (t, actions),
  };
  // Queued before the window exists, so it cannot announce itself first.
  if let DropTarget::NewWindow { point } = target {
    let label = format!("doc-{group}");
    pending.route_transfer(&label, t);
    if let Err(e) = open_receiving_window(&app, &window, &group, project.as_deref(), point) {
      pending.forget(&label);
      let actions = state.book.lock().unwrap().cancel(t, window.label()).1;
      run(&app, actions);
      return Err(e);
    }
  }
  run(&app, actions);
  Ok(BeginResult::Started { t })
}
/// Build the window that receives a tab dropped outside every window, at the
/// sender's size and with its top left at `point`.
fn open_receiving_window(
  app: &AppHandle,
  sender: &tauri::WebviewWindow,
  group: &str,
  project: Option<&str>,
  point: Point,
) -> Result<(), String> {
  let scale = sender.scale_factor().map_err(|e| e.to_string())?;
  let size = sender
    .inner_size()
    .map_err(|e| e.to_string())?
    .to_logical::<f64>(scale);
  #[cfg(any(target_os = "macos", windows))]
  let placed = window_at::place(sender, point, window_at::native_size(sender));
  #[cfg(not(any(target_os = "macos", windows)))]
  let placed = point;
  // macOS places the window as it is built; Windows builds it hidden without a
  // position and moves it once it has a frame to measure.
  let at = cfg!(target_os = "macos").then_some((placed.x, placed.y));
  crate::windows::open_receiving_document(app, group, project, (size.width, size.height), at)?;
  #[cfg(windows)]
  if let Some(created) = app.get_webview_window(&format!("doc-{group}")) {
    window_at::set_top_left(&created, placed)?;
  }
  Ok(())
}
/// The receiver takes the tab of transfer `t`.
#[tauri::command(async)]
pub fn tab_transfer_claim(
  app: AppHandle,
  window: tauri::WebviewWindow,
  state: State<TransferState>,
  t: u64,
) -> Option<Claimed> {
  let (claimed, actions) = state
    .book
    .lock()
    .unwrap()
    .claim(t, window.label(), Instant::now());
  run(&app, actions);
  claimed
}
/// The receiver answers whether it can take the tab.
#[tauri::command(async)]
pub fn tab_transfer_answer(
  app: AppHandle,
  window: tauri::WebviewWindow,
  state: State<TransferState>,
  t: u64,
  ok: bool,
) -> Answer {
  let (answer, actions) = state
    .book
    .lock()
    .unwrap()
    .answer(t, ok, window.label(), Instant::now());
  run(&app, actions);
  answer
}
/// The receiver reports where it put the tab.
#[tauri::command(async)]
pub fn tab_transfer_committed(
  app: AppHandle,
  window: tauri::WebviewWindow,
  state: State<TransferState>,
  store: State<NoteStore>,
  t: u64,
  meta: CommittedMeta,
) -> CommitResult {
  let (result, actions) = state
    .book
    .lock()
    .unwrap()
    .committed(t, window.label(), &meta, &*store);
  run(&app, actions);
  if result == CommitResult::Accepted {
    crate::note_store::emit_store_changed(&app, None);
  }
  result
}
/// The sender calls transfer `t` off.
#[tauri::command(async)]
pub fn tab_transfer_cancel(
  app: AppHandle,
  window: tauri::WebviewWindow,
  state: State<TransferState>,
  t: u64,
) -> CancelResult {
  let (result, actions) = state.book.lock().unwrap().cancel(t, window.label());
  run(&app, actions);
  result
}
/// The sender removed the tab: the transfer is over.
#[tauri::command(async)]
pub fn tab_transfer_released(window: tauri::WebviewWindow, state: State<TransferState>, t: u64) {
  state.book.lock().unwrap().released(t, window.label());
}
/// Where transfer `t` stands.
#[tauri::command(async)]
pub fn tab_transfer_status(
  window: tauri::WebviewWindow,
  state: State<TransferState>,
  t: u64,
) -> Status {
  state.book.lock().unwrap().status(t, window.label())
}
/// The calling window is closing or quitting: its transfers not yet accepted
/// are called off, and what it does about each comes back.
#[tauri::command(async)]
pub fn tab_transfer_settle_window(
  app: AppHandle,
  window: tauri::WebviewWindow,
  state: State<TransferState>,
) -> Vec<SettleAction> {
  let (settled, actions) = state.book.lock().unwrap().settle_window(window.label());
  run(&app, actions);
  settled
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  use std::cell::RefCell;

  const T0: fn() -> Instant = Instant::now;

  fn tab(id: &str) -> Value {
    json!({ "tab": { "id": id, "path": "/p/a.txt" } })
  }
  fn sticky_tab(id: &str, sticky: &str) -> Value {
    json!({ "tab": { "id": id, "path": "", "converted": { "noteId": sticky } } })
  }
  fn existing(label: &str) -> Target {
    Target::Existing {
      label: label.to_string(),
      offset: Point { x: 12.5, y: 7.25 },
    }
  }
  fn fresh(label: &str) -> Target {
    Target::NewWindow {
      label: label.to_string(),
    }
  }
  fn ctx<'a>(quitting: bool, ready: &'a dyn Fn(&str) -> bool) -> BeginContext<'a> {
    BeginContext { quitting, ready }
  }
  fn begin_with(book: &mut TransferBook, note: &str, target: Target, now: Instant) -> u64 {
    let ready = |_: &str| true;
    match book
      .begin("doc-a", tab(note), target, now, &ctx(false, &ready))
      .unwrap()
    {
      Begin::Started { t, .. } => t,
      other => panic!("{other:?}"),
    }
  }
  fn meta() -> CommittedMeta {
    CommittedMeta {
      tab_index: 3,
      order: 1.5,
      group: "g-b".to_string(),
      project: Some("/proj".to_string()),
      bounds: Bounds {
        x: Some(1.0),
        y: None,
        width: Some(300.0),
        height: None,
      },
    }
  }
  /// A store that records what a commit does to it.
  #[derive(Default)]
  struct FakeStore {
    records: RefCell<Vec<String>>,
    placements: RefCell<Vec<(String, TabPlacement)>>,
    owners: RefCell<Vec<(String, String)>>,
    retargets: RefCell<Vec<(String, String)>>,
    fail: bool,
  }
  impl TransferStore for FakeStore {
    fn update_placement(&self, id: &str, placement: &TabPlacement) -> Result<bool, String> {
      if self.fail {
        return Err("disk full".to_string());
      }
      self
        .placements
        .borrow_mut()
        .push((id.to_string(), placement.clone()));
      Ok(self.records.borrow().iter().any(|r| r == id))
    }
    fn set_owner(&self, id: &str, label: &str) {
      self
        .owners
        .borrow_mut()
        .push((id.to_string(), label.to_string()));
    }
    fn retarget_handed_off(&self, sticky: &str, window: &str) -> bool {
      self
        .retargets
        .borrow_mut()
        .push((sticky.to_string(), window.to_string()));
      true
    }
  }
  /// Run a transfer to the answered phase and return its id.
  fn answered(book: &mut TransferBook, note: &str, receiver: &str, now: Instant) -> u64 {
    let t = begin_with(book, note, existing(receiver), now);
    assert!(book.claim(t, receiver, now).0.is_some());
    assert_eq!(book.answer(t, true, receiver, now).0, Answer::Commit);
    t
  }
  fn cancelled_for(t: u64, sender: &str, receiver: &str) -> Vec<Action> {
    vec![
      Action::EmitCancel {
        label: sender.to_string(),
        t,
      },
      Action::EmitAbort {
        label: receiver.to_string(),
        t,
      },
    ]
  }
  fn emits(actions: &[Action]) -> Vec<Action> {
    actions
      .iter()
      .filter(|a| !matches!(a, Action::SetOwner { .. } | Action::Schedule { .. }))
      .cloned()
      .collect()
  }

  #[test]
  fn begin_marks_the_sender_owner_tells_an_existing_window_and_arms_the_timer() {
    let mut book = TransferBook::default();
    let ready = |_: &str| true;
    let Begin::Started { t, actions } = book
      .begin(
        "doc-a",
        tab("n"),
        existing("doc-b"),
        T0(),
        &ctx(false, &ready),
      )
      .unwrap()
    else {
      panic!("refused");
    };
    assert_eq!(
      actions,
      vec![
        Action::SetOwner {
          note: "n".to_string(),
          label: "doc-a".to_string()
        },
        Action::EmitIn {
          label: "doc-b".to_string(),
          t
        },
        Action::Schedule {
          t,
          after: Duration::from_secs(5)
        },
      ]
    );
  }

  #[test]
  fn begin_for_a_new_window_sends_no_event_and_gives_it_thirty_seconds_to_claim() {
    let mut book = TransferBook::default();
    let ready = |_: &str| false;
    let Begin::Started { t, actions } = book
      .begin(
        "doc-a",
        tab("n"),
        fresh("doc-new"),
        T0(),
        &ctx(false, &ready),
      )
      .unwrap()
    else {
      panic!("refused");
    };
    assert!(!actions.iter().any(|a| matches!(a, Action::EmitIn { .. })));
    assert!(actions.contains(&Action::Schedule {
      t,
      after: Duration::from_secs(30)
    }));
  }

  #[test]
  fn begin_is_refused_for_a_note_in_transfer_during_a_quit_and_for_a_target_not_ready() {
    let mut book = TransferBook::default();
    begin_with(&mut book, "n", existing("doc-b"), T0());
    let ready = |_: &str| true;
    assert_eq!(
      book
        .begin(
          "doc-a",
          tab("n"),
          existing("doc-c"),
          T0(),
          &ctx(false, &ready)
        )
        .unwrap(),
      Begin::Refused(Refusal::Busy)
    );
    assert_eq!(
      book
        .begin(
          "doc-a",
          tab("m"),
          existing("doc-c"),
          T0(),
          &ctx(true, &ready)
        )
        .unwrap(),
      Begin::Refused(Refusal::Quitting)
    );
    let not_ready = |label: &str| label != "doc-c";
    assert_eq!(
      book
        .begin(
          "doc-a",
          tab("m"),
          existing("doc-c"),
          T0(),
          &ctx(false, &not_ready)
        )
        .unwrap(),
      Begin::Refused(Refusal::NotReady)
    );
    // A new window is never "not ready": it has not loaded yet by design.
    assert!(matches!(
      book
        .begin(
          "doc-a",
          tab("m"),
          fresh("doc-new"),
          T0(),
          &ctx(false, &not_ready)
        )
        .unwrap(),
      Begin::Started { .. }
    ));
    // A refusal opened nothing.
    assert_eq!(book.len(), 2);
  }

  #[test]
  fn begin_needs_a_tab_id_and_a_receiver_that_is_not_the_sender() {
    let mut book = TransferBook::default();
    let ready = |_: &str| true;
    assert!(book
      .begin(
        "doc-a",
        json!({}),
        existing("doc-b"),
        T0(),
        &ctx(false, &ready)
      )
      .is_err());
    assert!(book
      .begin(
        "doc-a",
        tab("n"),
        existing("doc-a"),
        T0(),
        &ctx(false, &ready)
      )
      .is_err());
  }

  #[test]
  fn the_note_is_free_again_after_the_transfer_ends() {
    let mut book = TransferBook::default();
    let t = begin_with(&mut book, "n", existing("doc-b"), T0());
    book.cancel(t, "doc-a");
    begin_with(&mut book, "n", existing("doc-b"), T0());
  }

  #[test]
  fn answer_commits_only_before_expiry() {
    let mut book = TransferBook::default();
    let now = T0();
    let t = begin_with(&mut book, "n", existing("doc-b"), now);
    book.claim(t, "doc-b", now);
    let late = now + Duration::from_secs(5);
    let (answer, actions) = book.answer(t, true, "doc-b", late);
    assert_eq!(answer, Answer::Expired);
    assert_eq!(emits(&actions), cancelled_for(t, "doc-a", "doc-b"));
    // The call-off removed it.
    assert_eq!(book.status(t, "doc-a"), Status::Gone);
    let t = begin_with(&mut book, "m", existing("doc-b"), now);
    book.claim(t, "doc-b", now);
    assert_eq!(
      book
        .answer(t, true, "doc-b", now + Duration::from_millis(4999))
        .0,
      Answer::Commit
    );
  }

  #[test]
  fn a_receiver_that_cannot_take_the_tab_calls_the_transfer_off() {
    let mut book = TransferBook::default();
    let t = begin_with(&mut book, "n", existing("doc-b"), T0());
    book.claim(t, "doc-b", T0());
    let (answer, actions) = book.answer(t, false, "doc-b", T0());
    assert_eq!(answer, Answer::Expired);
    assert_eq!(emits(&actions), cancelled_for(t, "doc-a", "doc-b"));
    assert!(actions.contains(&Action::SetOwner {
      note: "n".to_string(),
      label: "doc-a".to_string()
    }));
  }

  #[test]
  fn answering_never_releases_the_sender() {
    let mut book = TransferBook::default();
    let t = begin_with(&mut book, "n", existing("doc-b"), T0());
    book.claim(t, "doc-b", T0());
    let (_, actions) = book.answer(t, true, "doc-b", T0());
    assert!(actions.is_empty());
    assert_eq!(book.status(t, "doc-a"), Status::Pending);
  }

  #[test]
  fn committed_before_any_call_off_is_accepted_and_does_everything_once() {
    let mut book = TransferBook::default();
    let t = answered(&mut book, "n", "doc-b", T0());
    let store = FakeStore {
      records: RefCell::new(vec!["n".to_string()]),
      ..FakeStore::default()
    };
    let (result, actions) = book.committed(t, "doc-b", &meta(), &store);
    assert_eq!(result, CommitResult::Accepted);
    assert_eq!(
      actions,
      vec![Action::EmitRelease {
        label: "doc-a".to_string(),
        t
      }]
    );
    assert_eq!(store.placements.borrow().len(), 1);
    assert_eq!(store.placements.borrow()[0].0, "n");
    assert_eq!(store.placements.borrow()[0].1.group, "g-b");
    assert_eq!(
      *store.owners.borrow(),
      vec![("n".to_string(), "doc-b".to_string())]
    );
    assert!(store.retargets.borrow().is_empty());
    assert_eq!(book.status(t, "doc-b"), Status::Accepted);
    // Again: accepted, and nothing more happens.
    let (again, actions) = book.committed(t, "doc-b", &meta(), &store);
    assert_eq!((again, actions), (CommitResult::Accepted, vec![]));
    assert_eq!(store.placements.borrow().len(), 1);
  }

  #[test]
  fn committed_after_a_call_off_is_rejected_and_touches_nothing() {
    let mut book = TransferBook::default();
    let t = answered(&mut book, "n", "doc-b", T0());
    book.cancel(t, "doc-a");
    let store = FakeStore::default();
    let (result, actions) = book.committed(t, "doc-b", &meta(), &store);
    assert_eq!((result, actions), (CommitResult::Rejected, vec![]));
    assert!(store.placements.borrow().is_empty());
    assert!(store.owners.borrow().is_empty());
  }

  #[test]
  fn committed_for_a_tab_without_a_record_is_accepted_and_creates_none() {
    let mut book = TransferBook::default();
    let t = begin_with(&mut book, "n", existing("doc-b"), T0());
    book.claim(t, "doc-b", T0());
    book.answer(t, true, "doc-b", T0());
    // The store finds no record: `Ok(false)`.
    let store = FakeStore::default();
    let (result, actions) = book.committed(t, "doc-b", &meta(), &store);
    assert_eq!(result, CommitResult::Accepted);
    assert_eq!(actions.len(), 1);
    assert_eq!(
      *store.owners.borrow(),
      vec![("n".to_string(), "doc-b".to_string())]
    );
  }

  #[test]
  fn committed_retargets_the_handed_off_sticky_with_the_tab() {
    let mut book = TransferBook::default();
    let ready = |_: &str| true;
    let Begin::Started { t, .. } = book
      .begin(
        "doc-a",
        sticky_tab("n", "s1"),
        existing("doc-b"),
        T0(),
        &ctx(false, &ready),
      )
      .unwrap()
    else {
      panic!("refused");
    };
    book.claim(t, "doc-b", T0());
    book.answer(t, true, "doc-b", T0());
    let store = FakeStore::default();
    book.committed(t, "doc-b", &meta(), &store);
    assert_eq!(
      *store.retargets.borrow(),
      vec![("s1".to_string(), "doc-b".to_string())]
    );
  }

  #[test]
  fn a_failing_store_write_during_committed_calls_the_transfer_off() {
    let mut book = TransferBook::default();
    let t = answered(&mut book, "n", "doc-b", T0());
    let store = FakeStore {
      fail: true,
      ..FakeStore::default()
    };
    let (result, actions) = book.committed(t, "doc-b", &meta(), &store);
    assert_eq!(result, CommitResult::Rejected);
    assert_eq!(emits(&actions), cancelled_for(t, "doc-a", "doc-b"));
    assert!(store.owners.borrow().is_empty());
    assert_eq!(book.status(t, "doc-a"), Status::Gone);
  }

  #[test]
  fn committed_needs_an_answer_first_and_the_receiver_as_caller() {
    let mut book = TransferBook::default();
    let t = begin_with(&mut book, "n", existing("doc-b"), T0());
    let store = FakeStore::default();
    assert_eq!(
      book.committed(t, "doc-b", &meta(), &store).0,
      CommitResult::Rejected
    );
    book.claim(t, "doc-b", T0());
    book.answer(t, true, "doc-b", T0());
    assert_eq!(
      book.committed(t, "doc-c", &meta(), &store).0,
      CommitResult::Rejected
    );
    assert!(store.placements.borrow().is_empty());
    assert_eq!(
      book.committed(t, "doc-b", &meta(), &store).0,
      CommitResult::Accepted
    );
  }

  #[test]
  fn a_sender_gone_before_commit_calls_off_and_after_it_does_not() {
    let now = T0();
    let mut book = TransferBook::default();
    let t = begin_with(&mut book, "n", existing("doc-b"), now);
    book.claim(t, "doc-b", now);
    let actions = book.window_gone("doc-a");
    assert_eq!(emits(&actions), cancelled_for(t, "doc-a", "doc-b"));
    assert_eq!(book.len(), 0);
    // After the receiver was told to commit the sender's going changes nothing...
    let t = answered(&mut book, "m", "doc-b", now);
    assert!(book.window_gone("doc-a").is_empty());
    assert_eq!(book.status(t, "doc-b"), Status::Pending);
    // ...the receiver still reports, and the entry goes with the release that
    // nobody is left to answer.
    let store = FakeStore::default();
    assert_eq!(
      book.committed(t, "doc-b", &meta(), &store).0,
      CommitResult::Accepted
    );
    assert_eq!(book.len(), 0);
  }

  #[test]
  fn a_receiver_gone_before_committed_calls_the_transfer_off() {
    let mut book = TransferBook::default();
    let t = answered(&mut book, "n", "doc-b", T0());
    let actions = book.window_gone("doc-b");
    assert_eq!(emits(&actions), cancelled_for(t, "doc-a", "doc-b"));
    assert_eq!(book.len(), 0);
  }

  #[test]
  fn an_accepted_transfer_only_waits_for_released_or_for_the_sender_to_go() {
    let mut book = TransferBook::default();
    let store = FakeStore::default();
    let t = answered(&mut book, "n", "doc-b", T0());
    book.committed(t, "doc-b", &meta(), &store);
    // The receiver going now changes nothing about the transfer.
    assert!(book.window_gone("doc-b").is_empty());
    assert_eq!(book.status(t, "doc-a"), Status::Accepted);
    // The sender going first removes the entry, without any action.
    assert!(book.window_gone("doc-a").is_empty());
    assert_eq!(book.len(), 0);
    let t = answered(&mut book, "m", "doc-b", T0());
    book.committed(t, "doc-b", &meta(), &store);
    book.released(t, "doc-a");
    assert_eq!(book.len(), 0);
    assert_eq!(book.status(t, "doc-a"), Status::Gone);
  }

  #[test]
  fn quit_calls_off_what_is_not_accepted_and_leaves_what_is() {
    let mut book = TransferBook::default();
    let store = FakeStore::default();
    let open = begin_with(&mut book, "open", existing("doc-b"), T0());
    let done = answered(&mut book, "done", "doc-c", T0());
    book.committed(done, "doc-c", &meta(), &store);
    let actions = book.quit_call_off();
    assert_eq!(emits(&actions), cancelled_for(open, "doc-a", "doc-b"));
    assert_eq!(book.status(open, "doc-a"), Status::Gone);
    assert_eq!(book.status(done, "doc-a"), Status::Accepted);
  }

  #[test]
  fn quit_destroys_the_new_windows_it_calls_off_and_the_ack_set_leaves_them_out() {
    let mut book = TransferBook::default();
    begin_with(&mut book, "n", fresh("doc-new"), T0());
    begin_with(&mut book, "m", existing("doc-b"), T0());
    let actions = book.quit_call_off();
    let destroyed = destroyed_by(&actions);
    assert_eq!(destroyed, vec!["doc-new".to_string()]);
    let labels = ["doc-a", "doc-b", "doc-new"].map(String::from);
    let acks = ack_set(labels, &destroyed);
    assert_eq!(
      acks,
      HashSet::from(["doc-a".to_string(), "doc-b".to_string()])
    );
  }

  #[test]
  fn a_timer_after_accepted_does_nothing_and_one_before_the_deadline_neither() {
    let now = T0();
    let mut book = TransferBook::default();
    let store = FakeStore::default();
    let t = begin_with(&mut book, "n", existing("doc-b"), now);
    assert!(book.expire(t, now + Duration::from_secs(1)).is_empty());
    assert_eq!(book.status(t, "doc-a"), Status::Pending);
    book.claim(t, "doc-b", now);
    book.answer(t, true, "doc-b", now);
    book.committed(t, "doc-b", &meta(), &store);
    assert!(book.expire(t, now + Duration::from_secs(60)).is_empty());
    assert_eq!(book.status(t, "doc-a"), Status::Accepted);
    // Not accepted and past its deadline: called off.
    let u = begin_with(&mut book, "m", existing("doc-b"), now);
    let actions = book.expire(u, now + Duration::from_secs(5));
    assert_eq!(emits(&actions), cancelled_for(u, "doc-a", "doc-b"));
  }

  #[test]
  fn a_new_window_has_five_seconds_from_its_claim_and_the_first_timer_leaves_it_be() {
    let now = T0();
    let mut book = TransferBook::default();
    let t = begin_with(&mut book, "n", fresh("doc-new"), now);
    let claimed_at = now + Duration::from_secs(28);
    let (claimed, actions) = book.claim(t, "doc-new", claimed_at);
    assert!(claimed.is_some());
    assert_eq!(
      actions,
      vec![Action::Schedule {
        t,
        after: Duration::from_secs(5)
      }]
    );
    // The first timer (30 s from begin) fires into the extended deadline.
    assert!(book.expire(t, now + Duration::from_secs(30)).is_empty());
    let late = book.expire(t, claimed_at + Duration::from_secs(5));
    assert_eq!(
      emits(&late),
      [
        cancelled_for(t, "doc-a", "doc-new"),
        vec![Action::Destroy {
          label: "doc-new".to_string()
        }]
      ]
      .concat()
    );
  }

  #[test]
  fn a_new_window_that_never_claims_is_called_off_and_destroyed() {
    let now = T0();
    let mut book = TransferBook::default();
    let t = begin_with(&mut book, "n", fresh("doc-new"), now);
    assert!(book.expire(t, now + Duration::from_secs(29)).is_empty());
    let actions = book.expire(t, now + Duration::from_secs(30));
    assert!(actions.contains(&Action::Destroy {
      label: "doc-new".to_string()
    }));
    // An existing window is never destroyed.
    let t = begin_with(&mut book, "m", existing("doc-b"), now);
    let actions = book.expire(t, now + Duration::from_secs(5));
    assert!(!actions.iter().any(|a| matches!(a, Action::Destroy { .. })));
  }

  #[test]
  fn settling_calls_off_every_unaccepted_transfer_of_the_window_in_both_directions() {
    let mut book = TransferBook::default();
    let store = FakeStore::default();
    let ready = |_: &str| true;
    // Outgoing from doc-w, not accepted.
    let out = {
      let Begin::Started { t, .. } = book
        .begin(
          "doc-w",
          tab("out"),
          existing("doc-x"),
          T0(),
          &ctx(false, &ready),
        )
        .unwrap()
      else {
        panic!("refused");
      };
      t
    };
    // Outgoing from doc-w, accepted by doc-x.
    let sent = {
      let Begin::Started { t, .. } = book
        .begin(
          "doc-w",
          tab("sent"),
          existing("doc-x"),
          T0(),
          &ctx(false, &ready),
        )
        .unwrap()
      else {
        panic!("refused");
      };
      book.claim(t, "doc-x", T0());
      book.answer(t, true, "doc-x", T0());
      book.committed(t, "doc-x", &meta(), &store);
      t
    };
    // Incoming to doc-w, not accepted; and incoming to doc-w, accepted.
    let into = {
      let Begin::Started { t, .. } = book
        .begin(
          "doc-y",
          tab("in"),
          existing("doc-w"),
          T0(),
          &ctx(false, &ready),
        )
        .unwrap()
      else {
        panic!("refused");
      };
      t
    };
    let landed = {
      let Begin::Started { t, .. } = book
        .begin(
          "doc-y",
          tab("landed"),
          existing("doc-w"),
          T0(),
          &ctx(false, &ready),
        )
        .unwrap()
      else {
        panic!("refused");
      };
      book.claim(t, "doc-w", T0());
      book.answer(t, true, "doc-w", T0());
      book.committed(t, "doc-w", &meta(), &store);
      t
    };
    // A transfer between two other windows is none of doc-w's business.
    let other = {
      let Begin::Started { t, .. } = book
        .begin(
          "doc-y",
          tab("other"),
          existing("doc-x"),
          T0(),
          &ctx(false, &ready),
        )
        .unwrap()
      else {
        panic!("refused");
      };
      t
    };
    let (settled, actions) = book.settle_window("doc-w");
    assert_eq!(
      settled,
      vec![
        SettleAction::Unfreeze {
          t: out,
          note_id: "out".to_string()
        },
        SettleAction::Release {
          t: sent,
          note_id: "sent".to_string()
        },
        SettleAction::DropIncoming { t: into },
      ]
    );
    assert!(actions.contains(&Action::EmitCancel {
      label: "doc-w".to_string(),
      t: out
    }));
    assert!(actions.contains(&Action::EmitCancel {
      label: "doc-y".to_string(),
      t: into
    }));
    assert_eq!(book.status(out, "doc-w"), Status::Gone);
    assert_eq!(book.status(into, "doc-w"), Status::Gone);
    // The accepted ones wait for their `released`; the other pair is untouched.
    assert_eq!(book.status(sent, "doc-w"), Status::Accepted);
    assert_eq!(book.status(landed, "doc-w"), Status::Accepted);
    assert_eq!(book.status(other, "doc-x"), Status::Pending);
  }

  #[test]
  fn cancel_is_cancelled_before_accepted_and_accepted_after() {
    let mut book = TransferBook::default();
    let store = FakeStore::default();
    let t = begin_with(&mut book, "n", existing("doc-b"), T0());
    let (result, actions) = book.cancel(t, "doc-a");
    assert_eq!(result, CancelResult::Cancelled);
    assert_eq!(emits(&actions), cancelled_for(t, "doc-a", "doc-b"));
    let t = answered(&mut book, "m", "doc-b", T0());
    book.committed(t, "doc-b", &meta(), &store);
    assert_eq!(
      book.cancel(t, "doc-a"),
      (CancelResult::Accepted, Vec::<Action>::new())
    );
    // Still there: cancelling an accepted transfer calls nothing off.
    assert_eq!(book.status(t, "doc-a"), Status::Accepted);
  }

  #[test]
  fn claim_gives_the_offset_of_a_doc_target_and_none_for_a_new_window() {
    let mut book = TransferBook::default();
    let t = begin_with(&mut book, "n", existing("doc-b"), T0());
    let (claimed, _) = book.claim(t, "doc-b", T0());
    let claimed = claimed.unwrap();
    assert_eq!(claimed.offset, Some(Point { x: 12.5, y: 7.25 }));
    assert_eq!(claimed.payload, tab("n"));
    // A second claim gives the same.
    assert_eq!(book.claim(t, "doc-b", T0()).0.unwrap(), claimed);
    let u = begin_with(&mut book, "m", fresh("doc-new"), T0());
    let (claimed, _) = book.claim(u, "doc-new", T0());
    assert_eq!(claimed.unwrap().offset, None);
  }

  #[test]
  fn calls_naming_an_entry_that_is_gone_get_the_empty_answers() {
    let mut book = TransferBook::default();
    let store = FakeStore::default();
    assert_eq!(book.claim(99, "doc-b", T0()).0, None);
    assert_eq!(book.answer(99, true, "doc-b", T0()).0, Answer::Expired);
    assert_eq!(
      book.committed(99, "doc-b", &meta(), &store).0,
      CommitResult::Rejected
    );
    assert_eq!(book.status(99, "doc-a"), Status::Gone);
    let t = begin_with(&mut book, "n", existing("doc-b"), T0());
    book.cancel(t, "doc-a");
    assert_eq!(book.claim(t, "doc-b", T0()).0, None);
    assert_eq!(book.answer(t, true, "doc-b", T0()).0, Answer::Expired);
    assert_eq!(
      book.committed(t, "doc-b", &meta(), &store).0,
      CommitResult::Rejected
    );
    assert_eq!(book.status(t, "doc-b"), Status::Gone);
  }

  #[test]
  fn the_wrong_window_is_refused_and_changes_nothing() {
    let mut book = TransferBook::default();
    let store = FakeStore::default();
    let t = begin_with(&mut book, "n", existing("doc-b"), T0());
    // claim, answer and committed are the receiver's; cancel and released the sender's.
    assert_eq!(book.claim(t, "doc-a", T0()).0, None);
    assert_eq!(book.claim(t, "doc-c", T0()).0, None);
    book.claim(t, "doc-b", T0());
    assert_eq!(book.answer(t, true, "doc-a", T0()).0, Answer::Expired);
    assert_eq!(book.answer(t, true, "doc-c", T0()).0, Answer::Expired);
    book.answer(t, true, "doc-b", T0());
    assert_eq!(
      book.committed(t, "doc-a", &meta(), &store).0,
      CommitResult::Rejected
    );
    assert_eq!(book.cancel(t, "doc-b").1, vec![]);
    assert_eq!(book.cancel(t, "doc-c").1, vec![]);
    assert_eq!(book.status(t, "doc-c"), Status::Gone);
    assert_eq!(book.status(t, "doc-a"), Status::Pending);
    book.committed(t, "doc-b", &meta(), &store);
    book.released(t, "doc-b");
    book.released(t, "doc-c");
    assert_eq!(book.status(t, "doc-a"), Status::Accepted);
    book.released(t, "doc-a");
    assert_eq!(book.status(t, "doc-a"), Status::Gone);
  }

  #[test]
  fn following_a_rename_rewrites_only_the_path_of_the_tab_in_flight() {
    let mut book = TransferBook::default();
    let ready = |_: &str| true;
    let payload = json!({
      "tab": { "id": "n", "path": "/old/a.txt", "language": "/old" },
      "scroll": { "path": "/old/a.txt" },
      "editor": "/old/a.txt",
    });
    let Begin::Started { t, .. } = book
      .begin(
        "doc-a",
        payload,
        existing("doc-b"),
        T0(),
        &ctx(false, &ready),
      )
      .unwrap()
    else {
      panic!("refused");
    };
    book.retarget_paths("/old", "/new");
    let claimed = book.claim(t, "doc-b", T0()).0.unwrap().payload;
    assert_eq!(claimed["tab"]["path"], "/new/a.txt");
    assert_eq!(claimed["tab"]["language"], "/old");
    assert_eq!(claimed["scroll"]["path"], "/old/a.txt");
    assert_eq!(claimed["editor"], "/old/a.txt");
  }

  #[test]
  fn begin_takes_only_a_doc_or_a_new_window_target() {
    let point = Point { x: 1.5, y: 2.5 };
    let mint = || "doc-new".to_string();
    assert_eq!(
      Target::from_drop(
        &DropTarget::Doc {
          label: "doc-b".to_string(),
          offset: point
        },
        mint
      ),
      Ok(existing_at("doc-b", point))
    );
    assert_eq!(
      Target::from_drop(&DropTarget::NewWindow { point }, mint),
      Ok(fresh("doc-new"))
    );
    for rejected in [
      DropTarget::SelfWindow,
      DropTarget::MoveWindow { point },
      DropTarget::Cancel,
    ] {
      assert!(Target::from_drop(&rejected, mint).is_err(), "{rejected:?}");
    }
  }
  fn existing_at(label: &str, offset: Point) -> Target {
    Target::Existing {
      label: label.to_string(),
      offset,
    }
  }
  // The JSON below is pinned by `src/lib/util/tabTransferWire.test.ts` too: the
  // same literals, so a change on one side alone fails a test on the other.
  const DROP_SELF: &str = r#"{"kind":"self"}"#;
  const DROP_DOC: &str = r#"{"kind":"doc","label":"doc-b","offset":{"x":12.5,"y":7.25}}"#;
  const DROP_NEW: &str = r#"{"kind":"new_window","point":{"x":100.5,"y":200.25}}"#;
  const DROP_MOVE: &str = r#"{"kind":"move_window","point":{"x":100.5,"y":200.25}}"#;
  const DROP_CANCEL: &str = r#"{"kind":"cancel"}"#;
  const BEGIN_STARTED: &str = r#"{"kind":"started","t":7}"#;
  const BEGIN_REFUSED_BUSY: &str = r#"{"kind":"refused","reason":"busy"}"#;
  const BEGIN_REFUSED_QUITTING: &str = r#"{"kind":"refused","reason":"quitting"}"#;
  const BEGIN_REFUSED_NOT_READY: &str = r#"{"kind":"refused","reason":"not_ready"}"#;
  const CLAIMED_DOC: &str = r#"{"payload":{"tab":{"id":"n"}},"offset":{"x":12.5,"y":7.25}}"#;
  const CLAIMED_NEW: &str = r#"{"payload":{"tab":{"id":"n"}}}"#;
  const COMMITTED_META: &str = r#"{"tabIndex":3,"order":1.5,"group":"g-b","project":"/proj","bounds":{"x":1.5,"y":null,"width":300.5,"height":null}}"#;
  const COMMITTED_META_NULLS: &str = r#"{"tabIndex":0,"order":0.5,"group":"g","project":null,"bounds":{"x":null,"y":null,"width":null,"height":null}}"#;
  const SETTLE: &str = r#"[{"kind":"unfreeze","t":1,"noteId":"n"},{"kind":"drop_incoming","t":2},{"kind":"release","t":3,"noteId":"m"}]"#;
  const EVENT: &str = r#"{"t":9}"#;

  fn json_of<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap()
  }

  #[test]
  fn the_wire_types_serialize_to_exactly_the_json_the_frontend_reads() {
    let doc_point = Point { x: 12.5, y: 7.25 };
    let at = Point {
      x: 100.5,
      y: 200.25,
    };
    assert_eq!(json_of(&DropTarget::SelfWindow), DROP_SELF);
    assert_eq!(
      json_of(&DropTarget::Doc {
        label: "doc-b".to_string(),
        offset: doc_point
      }),
      DROP_DOC
    );
    assert_eq!(json_of(&DropTarget::NewWindow { point: at }), DROP_NEW);
    assert_eq!(json_of(&DropTarget::MoveWindow { point: at }), DROP_MOVE);
    assert_eq!(json_of(&DropTarget::Cancel), DROP_CANCEL);
    assert_eq!(json_of(&BeginResult::Started { t: 7 }), BEGIN_STARTED);
    assert_eq!(
      json_of(&BeginResult::Refused {
        reason: Refusal::Busy
      }),
      BEGIN_REFUSED_BUSY
    );
    assert_eq!(
      json_of(&BeginResult::Refused {
        reason: Refusal::Quitting
      }),
      BEGIN_REFUSED_QUITTING
    );
    assert_eq!(
      json_of(&BeginResult::Refused {
        reason: Refusal::NotReady
      }),
      BEGIN_REFUSED_NOT_READY
    );
    assert_eq!(
      json_of(&Claimed {
        payload: json!({ "tab": { "id": "n" } }),
        offset: Some(doc_point)
      }),
      CLAIMED_DOC
    );
    assert_eq!(
      json_of(&Claimed {
        payload: json!({ "tab": { "id": "n" } }),
        offset: None
      }),
      CLAIMED_NEW
    );
    assert_eq!(json_of(&Answer::Commit), r#""commit""#);
    assert_eq!(json_of(&Answer::Expired), r#""expired""#);
    assert_eq!(json_of(&CommitResult::Accepted), r#""accepted""#);
    assert_eq!(json_of(&CommitResult::Rejected), r#""rejected""#);
    assert_eq!(json_of(&CancelResult::Cancelled), r#""cancelled""#);
    assert_eq!(json_of(&CancelResult::Accepted), r#""accepted""#);
    assert_eq!(json_of(&Status::Pending), r#""pending""#);
    assert_eq!(json_of(&Status::Accepted), r#""accepted""#);
    assert_eq!(json_of(&Status::Gone), r#""gone""#);
    assert_eq!(
      json_of(&vec![
        SettleAction::Unfreeze {
          t: 1,
          note_id: "n".to_string()
        },
        SettleAction::DropIncoming { t: 2 },
        SettleAction::Release {
          t: 3,
          note_id: "m".to_string()
        },
      ]),
      SETTLE
    );
    assert_eq!(json_of(&TransferEvent { t: 9 }), EVENT);
    let mut meta = meta();
    meta.bounds.x = Some(1.5);
    meta.bounds.width = Some(300.5);
    assert_eq!(json_of(&meta), COMMITTED_META);
  }

  #[test]
  fn a_serialized_doc_or_new_window_target_is_what_begin_takes_back() {
    for literal in [DROP_DOC, DROP_NEW] {
      let target: DropTarget = serde_json::from_str(literal).unwrap();
      assert_eq!(json_of(&target), literal);
      assert!(Target::from_drop(&target, || "doc-x".to_string()).is_ok());
    }
    for literal in [DROP_SELF, DROP_MOVE, DROP_CANCEL] {
      let target: DropTarget = serde_json::from_str(literal).unwrap();
      assert!(Target::from_drop(&target, || "doc-x".to_string()).is_err());
    }
  }

  #[test]
  fn the_committed_meta_reads_camel_case_keys_and_null_bounds() {
    let meta: CommittedMeta = serde_json::from_str(COMMITTED_META_NULLS).unwrap();
    assert_eq!(meta.tab_index, 0);
    assert_eq!(meta.order, 0.5);
    assert_eq!(meta.group, "g");
    assert_eq!(meta.project, None);
    assert_eq!(
      meta.bounds,
      Bounds {
        x: None,
        y: None,
        width: None,
        height: None
      }
    );
    let meta: CommittedMeta = serde_json::from_str(COMMITTED_META).unwrap();
    assert_eq!(meta.project.as_deref(), Some("/proj"));
    assert_eq!(meta.bounds.width, Some(300.5));
    // The snake_case spelling is not the wire.
    assert!(serde_json::from_str::<CommittedMeta>(
      r#"{"tab_index":0,"order":0.5,"group":"g","project":null,"bounds":{"x":null,"y":null,"width":null,"height":null}}"#
    )
    .is_err());
  }

  #[test]
  fn a_release_becomes_the_drop_target_of_its_decision() {
    let point = Point { x: 5.5, y: 6.5 };
    let doc = Hit::Doc {
      label: "doc-b".to_string(),
      offset: Point { x: 1.5, y: 2.5 },
    };
    assert_eq!(
      drop_target_for(&doc, false, true, false, point),
      DropTarget::Doc {
        label: "doc-b".to_string(),
        offset: Point { x: 1.5, y: 2.5 }
      }
    );
    assert_eq!(
      drop_target_for(&Hit::SelfWindow, false, true, false, point),
      DropTarget::SelfWindow
    );
    assert_eq!(
      drop_target_for(&Hit::Outside, false, true, false, point),
      DropTarget::NewWindow { point }
    );
    assert_eq!(
      drop_target_for(&Hit::Outside, false, true, true, point),
      DropTarget::MoveWindow { point }
    );
    assert_eq!(
      drop_target_for(&Hit::Outside, true, true, false, point),
      DropTarget::Cancel
    );
  }

  #[test]
  fn the_first_load_of_a_window_is_its_start_and_a_later_one_a_reload() {
    let mut loaded = HashSet::new();
    assert!(!note_page_load(&mut loaded, "doc-a"));
    assert!(!note_page_load(&mut loaded, "doc-b"));
    assert!(note_page_load(&mut loaded, "doc-a"));
    assert!(note_page_load(&mut loaded, "doc-a"));
    assert!(note_page_load(&mut loaded, "doc-b"));
  }

  #[test]
  fn the_command_that_builds_a_window_is_async() {
    let source = include_str!("tab_transfer.rs");
    let at = source.find("pub fn tab_transfer_begin").unwrap();
    assert!(source[..at]
      .trim_end()
      .ends_with("#[tauri::command(async)]"));
  }

  #[test]
  fn every_command_checks_the_calling_window() {
    let source = include_str!("tab_transfer.rs");
    for name in [
      "tab_drop_target",
      "tab_move_window",
      "tab_transfer_begin",
      "tab_transfer_claim",
      "tab_transfer_answer",
      "tab_transfer_committed",
      "tab_transfer_cancel",
      "tab_transfer_released",
      "tab_transfer_status",
      "tab_transfer_settle_window",
    ] {
      let at = source.find(&format!("pub fn {name}")).unwrap();
      let signature = &source[at..];
      let signature = &signature[..signature.find(") ").unwrap()];
      assert!(signature.contains("window: tauri::WebviewWindow"), "{name}");
    }
  }

  #[test]
  fn the_quit_calls_transfers_off_before_it_arms_and_waits_only_for_windows_that_stay() {
    let source = include_str!("lib.rs");
    let at = source.find("pub(crate) fn flush_then_exit").unwrap();
    let body = &source[at..];
    let body = &body[..body.find("\n}\n").unwrap()];
    let called_off = body.find("tab_transfer::quit_call_off(app)").unwrap();
    let arm = body.find(".arm(").unwrap();
    assert!(called_off < arm);
    assert!(body.contains("tab_transfer::ack_set("));
    assert!(body.contains("&destroyed,"));
  }
}
