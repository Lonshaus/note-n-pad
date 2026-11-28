// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A tab dragged out of its tab bar becomes a window that follows the pointer
// until the button is released, and the only tab of a window moves the window
// live. `TearOffBook` is the pure state of that loop: it lives inside
// `TransferBook`, under the same lock, and every method returns the actions to
// perform, so the rules are tested without a window. The platform side (cursor,
// button, window position, hit test) is `tab_follow` and stays thin.
#![cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]

use crate::window_at::{Hit, Point};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
/// How far above and below its bar a point still counts as over it, in CSS
/// pixels.
pub const BAND: f64 = 15.0;
/// How often the follow loop looks at the pointer.
pub const STEP_INTERVAL: Duration = Duration::from_millis(8);
/// A recorded release that finds no `released` within this long is dropped to a
/// plain reveal.
pub const RECORD_TIMEOUT: Duration = Duration::from_secs(5);
/// A hover over the same target is sent again after this many steps, so a
/// receiver that locks or unlocks while the pointer rests answers again.
pub const HOVER_KEEPALIVE_STEPS: u32 = 30;
/// What the page tells the core about the dragged tab when it leaves the bar:
/// every value is in client CSS pixels of the sender.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TearSpec {
  /// Minted by the page; names this drag in events and commands.
  pub id: String,
  /// The pointer's distance from the dragged tab's left edge as drawn, and its
  /// client y.
  pub grab: Point,
  /// Where the first tab of a bar starts: the bar's left plus the tab's left.
  pub first_tab_client_x: f64,
  /// Where the tab goes back to in the sender on Esc.
  pub esc_offset: Point,
  /// The sender's `devicePixelRatio`.
  pub dpr: f64,
  /// The dragged tab's width.
  pub width: f64,
  /// The dragged tab's display name.
  pub title: String,
}
/// What a hover that comes from a follow adds to the event: the receiver answers
/// it and draws the tab under the pointer. `grab_x` is the pointer's distance
/// from the tab's left edge.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoverFollow {
  pub generation: u64,
  pub title: String,
  pub grab_x: f64,
}
/// A window's tab bar in its client CSS pixels, as the page reports it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BarReport {
  pub top: f64,
  pub bottom: f64,
  pub left: f64,
  pub right: f64,
  pub dpr: f64,
}
/// Where a release lands.
#[derive(Clone, Debug, PartialEq)]
pub enum ReleaseTarget {
  /// Over another window's bar, at `offset` from its inner origin in native
  /// units.
  Doc { label: String, offset: Point },
  /// Anywhere else.
  Elsewhere,
}
/// Something the caller of a `TearOffBook` method carries out.
#[derive(Clone, Debug, PartialEq)]
pub enum TearAction {
  /// Tell `label` to send the tab `note` to the bar of window `to`.
  EmitSend {
    label: String,
    note: String,
    to: String,
    offset: Point,
  },
  /// Bring the tear-off forward; always paired with `EmitRoleEnd`.
  Reveal {
    label: String,
  },
  /// The follow `id` is over: tell its sender.
  EmitEnd {
    label: String,
    id: String,
  },
  /// The tear-off's waiting role is over.
  EmitRoleEnd {
    label: String,
  },
  /// The dragged tab is at (`x`, `y`) from the window's inner origin.
  Hover {
    label: String,
    x: f64,
    y: f64,
    width: f64,
    follow: HoverFollow,
  },
  HoverEnd {
    label: String,
  },
  /// Make the following window invisible, in place.
  Hide {
    label: String,
  },
  /// Make the window visible again; nothing for a window that is not hidden.
  Show {
    label: String,
  },
  /// Put the window back where it was, and maximize it again if it was.
  MoveTo {
    label: String,
    point: Point,
    remaximize: bool,
  },
  /// Call the first transfer `t` off.
  Cancel {
    t: u64,
  },
  /// Look at the recorded release of `t` again after `after`.
  ArmOverdue {
    t: u64,
    after: Duration,
  },
}
/// The offset (native units) of a point over a window's bar, with y clamped into
/// the bar, or none when the point is not over it. `windows` says a CSS pixel is
/// the window's `dpr` native units; on macOS it is one. A window without a
/// report is never over a bar.
pub fn bar_target(offset: Point, report: Option<&BarReport>, windows: bool) -> Option<Point> {
  let report = report?;
  let scale = if windows && report.dpr > 0.0 {
    report.dpr
  } else {
    1.0
  };
  let (x, y) = (offset.x / scale, offset.y / scale);
  if x < report.left || x >= report.right || y < report.top - BAND || y >= report.bottom + BAND {
    return None;
  }
  let inside = y.clamp(report.top, (report.bottom - 0.5).max(report.top));
  Some(Point {
    x: x * scale,
    y: inside * scale,
  })
}
/// Native units per CSS pixel while following: one on macOS, and on Windows the
/// following window's latest reported `devicePixelRatio` (the sender's until it
/// reports), which includes text scaling and not only the monitor's scale.
pub fn follow_scale(windows: bool, report_dpr: Option<f64>, sender_dpr: f64) -> f64 {
  if windows {
    report_dpr.unwrap_or(sender_dpr)
  } else {
    1.0
  }
}
/// The outer top left of the tear-off that keeps the grabbed spot of its tab
/// under the pointer: the pointer minus the grab in client pixels (scaled) minus
/// the inner-minus-outer offset measured in the same step.
pub fn tearoff_outer_top_left(
  cursor: Point,
  first_tab_client_x: f64,
  grab: Point,
  scale: f64,
  inner_minus_outer: Point,
) -> Point {
  Point {
    x: cursor.x - (first_tab_client_x + grab.x) * scale - inner_minus_outer.x,
    y: cursor.y - grab.y * scale - inner_minus_outer.y,
  }
}
/// The outer top left of a window that moves with the pointer.
pub fn move_outer_top_left(cursor: Point, grab: Point) -> Point {
  Point {
    x: cursor.x - grab.x,
    y: cursor.y - grab.y,
  }
}
/// The screen point a window whose outer top left is `outer` holds at the client
/// point `pressed`: its page inset plus the point, scaled to native units.
#[cfg(any(target_os = "macos", windows, test))]
pub fn held_point(outer: Point, inset: Point, pressed: Point, scale: f64) -> Point {
  Point {
    x: outer.x + inset.x + pressed.x * scale,
    y: outer.y + inset.y + pressed.y * scale,
  }
}
/// The grab in a restored window of width `restored_width` for a pointer at
/// `cursor` over a maximized frame of `max_width` whose top left is `max_origin`:
/// the pointer keeps its fraction of the width and its distance from the top.
pub fn maximized_grab(
  cursor: Point,
  max_origin: Point,
  max_width: f64,
  restored_width: f64,
) -> Point {
  Point {
    x: (cursor.x - max_origin.x) / max_width * restored_width,
    y: cursor.y - max_origin.y,
  }
}
/// The logical inner size of a tear-off made from a maximized Windows sender:
/// the restored outer size (physical) less the sender's current frame, title bar
/// and menu bar, over the sender's scale.
#[cfg(any(windows, test))]
pub fn windows_tearoff_inner(
  restored_outer: (f64, f64),
  sender_outer: (f64, f64),
  sender_inner: (f64, f64),
  scale: f64,
) -> (f64, f64) {
  (
    (restored_outer.0 - (sender_outer.0 - sender_inner.0)) / scale,
    (restored_outer.1 - (sender_outer.1 - sender_inner.1)) / scale,
  )
}
/// The size of the frame of a macOS window whose content is `content`: the
/// content plus the title bar.
#[cfg(any(target_os = "macos", test))]
pub fn mac_restored_outer(content: (f64, f64), title_bar: f64) -> (f64, f64) {
  (content.0, content.1 + title_bar)
}
/// `esc_offset` in native units: CSS pixels on macOS, times the sender's `dpr`
/// on Windows.
pub fn esc_native(esc: Point, windows: bool, dpr: f64) -> Point {
  if windows {
    Point {
      x: esc.x * dpr,
      y: esc.y * dpr,
    }
  } else {
    esc
  }
}
/// Whether a step may start: at most one is outstanding.
#[derive(Default)]
pub struct StepGate {
  pending: AtomicBool,
}
impl StepGate {
  /// True when the caller may schedule a step; it then owes a `finish`.
  pub fn try_begin(&self) -> bool {
    !self.pending.swap(true, Ordering::SeqCst)
  }
  pub fn finish(&self) {
    self.pending.store(false, Ordering::SeqCst);
  }
}
/// What the page's tear-off role did, for a page that announces itself late.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RoleState {
  pub ended: bool,
  pub revealed: bool,
}
/// How the follow moves a window.
#[derive(Clone, Debug, PartialEq)]
pub enum Mode {
  /// The first transfer `t` of a tab into the new window `window`.
  TearOff {
    t: u64,
    window: String,
    note: String,
    accepted: bool,
    first_ended: bool,
  },
  /// The sender, with its only tab, moves.
  MoveWindow {
    note: String,
    was_maximized: bool,
    start: Point,
  },
}
/// The live loop, at most one.
#[derive(Clone, Debug)]
pub struct Follow {
  pub id: String,
  pub generation: u64,
  pub mode: Mode,
  pub sender: String,
  pub grab: Point,
  pub first_tab_client_x: f64,
  pub esc_offset: Point,
  pub dpr: f64,
  pub width: f64,
  pub hover: Option<String>,
  /// The last hover emitted: the window, the clamped offset and the width.
  hover_sent: Option<(String, Point, f64)>,
  /// Steps since the last hover was emitted, while the same one is due.
  hover_quiet: u32,
  /// The latest answer of the hovered window to a hover: whether it takes the tab.
  ack: Option<(String, bool)>,
  /// The dragged tab's display name.
  title: String,
  /// The pointer's distance from the dragged tab's left edge.
  tab_grab_x: f64,
  release_seen: bool,
}
impl Follow {
  fn following(&self) -> &str {
    match &self.mode {
      Mode::TearOff { window, .. } => window,
      Mode::MoveWindow { .. } => &self.sender,
    }
  }
}
/// A release that waits for the first transfer to end.
struct Recorded {
  sender: String,
  tearoff: String,
  note: String,
  target: ReleaseTarget,
}
/// What a step needs of the book before it touches a window.
#[derive(Clone, Debug, PartialEq)]
pub struct StepPlan {
  /// The window that follows the pointer.
  pub following: String,
  pub kind: StepKind,
}
#[derive(Clone, Debug, PartialEq)]
pub enum StepKind {
  TearOff {
    first_tab_client_x: f64,
    grab: Point,
    scale: f64,
  },
  Move {
    grab: Point,
  },
}
/// The follow loop, the releases that wait, the tab bars windows reported and
/// the role of each tear-off.
#[derive(Default)]
pub struct TearOffBook {
  follow: Option<Follow>,
  last_generation: u64,
  recorded: HashMap<u64, Recorded>,
  reports: HashMap<String, BarReport>,
  roles: HashMap<String, RoleState>,
  /// Windows that are closing: nothing is shown or sent to them, and their
  /// role stays as it is in case the close is called off.
  closing: HashSet<String>,
  /// Windows made invisible by a follow, until a show: a vetoed close or a
  /// cancelled quit still finds them.
  hidden: HashSet<String>,
  quitting: bool,
  live: Arc<AtomicU64>,
}
impl TearOffBook {
  /// Whether a follow exists: a second one is refused.
  pub fn busy(&self) -> bool {
    self.follow.is_some()
  }
  /// The generation of the live follow.
  pub fn generation(&self) -> Option<u64> {
    self.follow.as_ref().map(|follow| follow.generation)
  }
  /// The generation of the live follow, or 0; the timer thread reads it without
  /// the book's lock.
  pub fn live_flag(&self) -> Arc<AtomicU64> {
    self.live.clone()
  }
  /// Whether `label` leads or follows the pointer, or waits to send: it takes no
  /// tab meanwhile.
  pub fn holds(&self, label: &str) -> bool {
    self
      .follow
      .as_ref()
      .is_some_and(|follow| follow.sender == label || follow.following() == label)
      || self
        .recorded
        .values()
        .any(|record| record.tearoff == label || record.sender == label)
  }
  /// The live follow of the first transfer `t`.
  pub fn follows(&self, t: u64) -> bool {
    matches!(&self.follow, Some(Follow { mode: Mode::TearOff { t: ft, .. }, .. }) if *ft == t)
  }
  /// Whether `label` is the sender of a live follow.
  pub fn is_sender(&self, label: &str) -> bool {
    self
      .follow
      .as_ref()
      .is_some_and(|follow| follow.sender == label)
  }
  fn open(&mut self, follow: impl FnOnce(u64) -> Follow) -> u64 {
    self.last_generation += 1;
    let generation = self.last_generation;
    self.follow = Some(follow(generation));
    self.live.store(generation, Ordering::SeqCst);
    generation
  }
  /// The first transfer `t` of `note` from `sender` into the new window `window`
  /// begins. None when a follow exists.
  pub fn start_tearoff(
    &mut self,
    spec: &TearSpec,
    sender: &str,
    window: &str,
    note: &str,
    t: u64,
  ) -> Option<u64> {
    if self.follow.is_some() {
      return None;
    }
    self.roles.insert(window.to_string(), RoleState::default());
    Some(self.open(|generation| Follow {
      id: spec.id.clone(),
      generation,
      mode: Mode::TearOff {
        t,
        window: window.to_string(),
        note: note.to_string(),
        accepted: false,
        first_ended: false,
      },
      sender: sender.to_string(),
      grab: spec.grab,
      first_tab_client_x: spec.first_tab_client_x,
      esc_offset: spec.esc_offset,
      dpr: spec.dpr,
      width: spec.width,
      hover: None,
      hover_sent: None,
      hover_quiet: 0,
      ack: None,
      title: spec.title.clone(),
      tab_grab_x: spec.grab.x,
      release_seen: false,
    }))
  }
  /// The window `sender`, whose only tab is `note`, starts to move with the
  /// pointer; `grab` is where the pointer holds it and `tab_grab_x` is the
  /// pointer's distance from the tab's left edge. None when a follow exists.
  #[allow(clippy::too_many_arguments)]
  pub fn start_move(
    &mut self,
    spec: &TearSpec,
    sender: &str,
    note: &str,
    grab: Point,
    was_maximized: bool,
    start: Point,
    tab_grab_x: f64,
  ) -> Option<u64> {
    if self.follow.is_some() {
      return None;
    }
    Some(self.open(|generation| Follow {
      id: spec.id.clone(),
      generation,
      mode: Mode::MoveWindow {
        note: note.to_string(),
        was_maximized,
        start,
      },
      sender: sender.to_string(),
      grab,
      first_tab_client_x: spec.first_tab_client_x,
      esc_offset: spec.esc_offset,
      dpr: spec.dpr,
      width: spec.width,
      hover: None,
      hover_sent: None,
      hover_quiet: 0,
      ack: None,
      title: spec.title.clone(),
      tab_grab_x,
      release_seen: false,
    }))
  }
  /// The window of the follow of transfer `t` could not be opened: the follow and
  /// its role go without a word, as the page that is still waiting for `begin`
  /// hears of the refusal from its answer.
  pub fn abort_start(&mut self, t: u64) {
    if !self.follows(t) {
      return;
    }
    self.live.store(0, Ordering::SeqCst);
    if let Some(Follow {
      mode: Mode::TearOff { window, .. },
      ..
    }) = self.follow.take()
    {
      self.roles.remove(&window);
    }
  }
  /// A window reported its tab bar.
  pub fn set_bar_report(&mut self, label: &str, report: BarReport) {
    self.reports.insert(label.to_string(), report);
  }
  /// The hovered window `label` answers the hover of follow `generation`: whether
  /// it takes the tab. Only the window under the pointer now is heard, and only
  /// for the live follow.
  pub fn hover_ack(&mut self, label: &str, generation: u64, accepted: bool) {
    let Some(follow) = self
      .follow
      .as_mut()
      .filter(|f| f.generation == generation && f.hover.as_deref() == Some(label))
    else {
      return;
    };
    follow.ack = Some((label.to_string(), accepted));
  }
  /// Whether the book marks `label` as made invisible.
  #[cfg(test)]
  pub fn is_hidden(&self, label: &str) -> bool {
    self.hidden.contains(label)
  }
  /// `label` was made visible: the mark goes, and a live follow that still wants
  /// it hidden says so again at its next step.
  pub fn clear_hidden(&mut self, label: &str) {
    self.hidden.remove(label);
  }
  /// A `Show` for `label` if it is marked hidden; the mark goes with it.
  fn take_hidden(&mut self, label: &str) -> Option<TearAction> {
    self.hidden.remove(label).then(|| TearAction::Show {
      label: label.to_string(),
    })
  }
  /// The state of a tear-off's role, for a page that announces itself.
  pub fn role_state(&self, label: &str) -> RoleState {
    self.roles.get(label).copied().unwrap_or_default()
  }
  /// The core showed the window itself.
  pub fn mark_revealed(&mut self, label: &str) {
    if let Some(role) = self.roles.get_mut(label) {
      role.revealed = true;
    }
  }
  /// The follow ends: its sender hears of it unless `notify_sender` is false (it
  /// is gone), and the window it hovered ends the hover unless that is `gone`.
  /// The following window is shown first if it is hidden, unless `keep_hidden`
  /// says it merges into the window it hovered.
  fn end(&mut self, notify_sender: bool, gone: Option<&str>, keep_hidden: bool) -> Vec<TearAction> {
    let Some(follow) = self.follow.take() else {
      return Vec::new();
    };
    self.live.store(0, Ordering::SeqCst);
    let mut actions = Vec::new();
    if !keep_hidden {
      actions.extend(self.take_hidden(follow.following()));
    }
    if notify_sender {
      actions.push(TearAction::EmitEnd {
        label: follow.sender,
        id: follow.id,
      });
    }
    if let Some(label) = follow.hover.filter(|label| Some(label.as_str()) != gone) {
      actions.push(TearAction::HoverEnd { label });
    }
    actions
  }
  /// What a step needs before it moves the following window; none for a stale
  /// generation.
  pub fn plan_step(&self, generation: u64, windows: bool) -> Option<StepPlan> {
    let follow = self
      .follow
      .as_ref()
      .filter(|f| f.generation == generation)?;
    let kind = match &follow.mode {
      Mode::TearOff { window, .. } => StepKind::TearOff {
        first_tab_client_x: follow.first_tab_client_x,
        grab: follow.grab,
        scale: follow_scale(
          windows,
          self.reports.get(window).map(|report| report.dpr),
          follow.dpr,
        ),
      },
      Mode::MoveWindow { .. } => StepKind::Move { grab: follow.grab },
    };
    Some(StepPlan {
      following: follow.following().to_string(),
      kind,
    })
  }
  /// What the window under the pointer is, as a release or hover target.
  fn target_of(&self, hit: &Hit, windows: bool) -> ReleaseTarget {
    if let Hit::Doc { label, offset } = hit {
      if let Some(offset) = bar_target(*offset, self.reports.get(label), windows) {
        return ReleaseTarget::Doc {
          label: label.clone(),
          offset,
        };
      }
    }
    ReleaseTarget::Elsewhere
  }
  /// A step moved the following window and found `hit` under the pointer with
  /// the button `down` (or not). A button up ends the follow and decides where
  /// the tab goes; otherwise the hover follows the pointer. The button counts as
  /// up once the page said it saw the release.
  pub fn finish_step(
    &mut self,
    generation: u64,
    down: bool,
    hit: &Hit,
    windows: bool,
  ) -> Vec<TearAction> {
    let target = self.target_of(hit, windows);
    let Some(follow) = self.follow.as_mut().filter(|f| f.generation == generation) else {
      return Vec::new();
    };
    if down && !follow.release_seen {
      let next = match &target {
        ReleaseTarget::Doc { label, offset } => Some((label.as_str(), *offset)),
        ReleaseTarget::Elsewhere => None,
      };
      let info = HoverFollow {
        generation: follow.generation,
        title: follow.title.clone(),
        grab_x: follow.tab_grab_x,
      };
      let mut actions = hover_actions(follow.hover.as_deref(), next, follow.width, &info);
      let sent = next.map(|(label, offset)| (label.to_string(), offset, follow.width));
      // The same hover as the last one says nothing new, until the keepalive.
      if sent.is_some() && sent == follow.hover_sent {
        follow.hover_quiet += 1;
        if follow.hover_quiet >= HOVER_KEEPALIVE_STEPS {
          follow.hover_quiet = 0;
        } else {
          actions.retain(|action| !matches!(action, TearAction::Hover { .. }));
        }
      } else {
        follow.hover_quiet = 0;
      }
      let target_changed = follow.hover.as_deref() != next.map(|(label, _)| label);
      follow.hover = next.map(|(label, _)| label.to_string());
      follow.hover_sent = sent;
      if target_changed {
        follow.ack = None;
      }
      // Visible or not follows the state: the hovered window took the tab.
      let want_hidden = matches!(
        (&next, &follow.ack),
        (Some((label, _)), Some((acked, true))) if acked == label
      );
      let label = follow.following().to_string();
      if want_hidden && self.hidden.insert(label.clone()) {
        actions.push(TearAction::Hide { label });
      } else if !want_hidden && self.hidden.remove(&label) {
        actions.push(TearAction::Show { label });
      }
      return actions;
    }
    let mode = follow.mode.clone();
    let sender = follow.sender.clone();
    // A release over a window that took the tab merges: the follower stays hidden.
    let merges = matches!(
      (&target, &follow.ack),
      (ReleaseTarget::Doc { label, .. }, Some((acked, true))) if acked == label
    );
    let mut actions = self.end(true, None, merges);
    match mode {
      Mode::MoveWindow { note, .. } => {
        if let ReleaseTarget::Doc { label, offset } = target {
          actions.push(TearAction::EmitSend {
            label: sender,
            note,
            to: label,
            offset,
          });
        }
      }
      Mode::TearOff {
        t,
        window,
        note,
        first_ended,
        ..
      } => actions.extend(self.apply_or_record(t, &sender, &window, note, target, first_ended)),
    }
    actions
  }
  /// The release target applies at once when the first transfer has ended;
  /// otherwise it is recorded until `released`.
  fn apply_or_record(
    &mut self,
    t: u64,
    sender: &str,
    window: &str,
    note: String,
    target: ReleaseTarget,
    first_ended: bool,
  ) -> Vec<TearAction> {
    if first_ended {
      return self.apply(window, note, target);
    }
    self.recorded.insert(
      t,
      Recorded {
        sender: sender.to_string(),
        tearoff: window.to_string(),
        note,
        target,
      },
    );
    vec![TearAction::ArmOverdue {
      t,
      after: RECORD_TIMEOUT,
    }]
  }
  fn apply(&mut self, window: &str, note: String, target: ReleaseTarget) -> Vec<TearAction> {
    match target {
      ReleaseTarget::Doc { label, offset } => self.send(window, note, label, offset),
      ReleaseTarget::Elsewhere => self.reveal(window),
    }
  }
  /// The tear-off sends its tab on to the bar of `to`; its role ends with it.
  fn send(&mut self, window: &str, note: String, to: String, offset: Point) -> Vec<TearAction> {
    let closing = self.closing.contains(window);
    let Some(role) = self.roles.get_mut(window).filter(|role| !role.ended) else {
      return Vec::new();
    };
    if closing {
      return Vec::new();
    }
    role.ended = true;
    vec![TearAction::EmitSend {
      label: window.to_string(),
      note,
      to,
      offset,
    }]
  }
  /// The tear-off is shown and its role ends; while a quit is under way neither
  /// happens, and a quit that is called off shows it.
  pub fn reveal(&mut self, window: &str) -> Vec<TearAction> {
    let quitting = self.quitting;
    let closing = self.closing.contains(window);
    let Some(role) = self.roles.get_mut(window) else {
      return Vec::new();
    };
    if quitting || closing || role.ended {
      return Vec::new();
    }
    role.ended = true;
    let mut actions: Vec<TearAction> = self.take_hidden(window).into_iter().collect();
    actions.push(TearAction::Reveal {
      label: window.to_string(),
    });
    actions.push(TearAction::EmitRoleEnd {
      label: window.to_string(),
    });
    actions
  }
  /// The page saw the button go up; the next step takes the release point.
  pub fn release_seen(&mut self, id: &str, caller: &str) {
    if let Some(follow) = self
      .follow
      .as_mut()
      .filter(|f| f.id == id && f.sender == caller)
    {
      follow.release_seen = true;
    }
  }
  /// Esc from the sender: a tab not yet in the tear-off goes back by calling the
  /// transfer off, one that is goes back to the sender's bar, and a moving window
  /// goes back where it started. Nothing for another follow or another caller.
  pub fn cancel(&mut self, id: &str, caller: &str, windows: bool) -> Vec<TearAction> {
    let Some(follow) = self
      .follow
      .as_ref()
      .filter(|f| f.id == id && f.sender == caller)
    else {
      return Vec::new();
    };
    let mode = follow.mode.clone();
    let sender = follow.sender.clone();
    let esc = esc_native(follow.esc_offset, windows, follow.dpr);
    let mut actions = self.end(true, None, false);
    match mode {
      Mode::MoveWindow {
        was_maximized,
        start,
        ..
      } => actions.push(TearAction::MoveTo {
        label: sender,
        point: start,
        remaximize: was_maximized,
      }),
      Mode::TearOff {
        t, accepted: false, ..
      } => actions.push(TearAction::Cancel { t }),
      Mode::TearOff {
        t,
        window,
        note,
        first_ended,
        ..
      } => {
        let target = ReleaseTarget::Doc {
          label: sender.clone(),
          offset: esc,
        };
        actions.extend(self.apply_or_record(t, &sender, &window, note, target, first_ended));
      }
    }
    actions
  }
  /// The core has the first transfer `t` accepted.
  pub fn on_accepted(&mut self, t: u64) {
    if let Some(Follow {
      mode: Mode::TearOff {
        t: ft, accepted, ..
      },
      ..
    }) = self.follow.as_mut()
    {
      if *ft == t {
        *accepted = true;
      }
    }
  }
  /// The sender let the first transfer `t` go: it has ended, and a release that
  /// waited for it applies now.
  pub fn on_released(&mut self, t: u64) -> Vec<TearAction> {
    if let Some(Follow {
      mode: Mode::TearOff {
        t: ft, first_ended, ..
      },
      ..
    }) = self.follow.as_mut()
    {
      if *ft == t {
        *first_ended = true;
      }
    }
    match self.recorded.remove(&t) {
      Some(record) => self.apply(&record.tearoff, record.note, record.target),
      None => Vec::new(),
    }
  }
  /// The first transfer `t` was called off: its follow and release are over.
  pub fn first_called_off(&mut self, t: u64) -> Vec<TearAction> {
    self.recorded.remove(&t);
    if self.follows(t) {
      return self.end(true, None, false);
    }
    Vec::new()
  }
  /// The sender of the first transfer `t` closes or is gone, with the tab already
  /// in the tear-off or about to be: the follow and the release are dropped.
  pub fn drop_first(&mut self, t: u64, notify_sender: bool) -> Vec<TearAction> {
    self.recorded.remove(&t);
    if self.follows(t) {
      return self.end(notify_sender, None, false);
    }
    Vec::new()
  }
  /// A recorded release got no `released` in time: the tear-off is shown, never
  /// a send. Nothing while the follow is still live.
  pub fn record_overdue(&mut self, t: u64) -> Vec<TearAction> {
    if self.follows(t) {
      return Vec::new();
    }
    match self.recorded.remove(&t) {
      Some(record) => self.reveal(&record.tearoff),
      None => Vec::new(),
    }
  }
  /// Window `label` is closing: a follow it leads or moves and the releases that
  /// name it end, and nothing is shown or sent to it afterwards. A hover over it
  /// is not told to end. `notify_sender` says the sender of the follow is alive.
  pub fn window_closing(&mut self, label: &str, notify_sender: bool) -> Vec<TearAction> {
    self.closing.insert(label.to_string());
    self
      .recorded
      .retain(|_, record| record.tearoff != label && record.sender != label);
    let Some(follow) = self.follow.as_mut() else {
      return Vec::new();
    };
    if follow.hover.as_deref() == Some(label) {
      follow.hover = None;
      follow.hover_sent = None;
      follow.ack = None;
    }
    let leads = match &follow.mode {
      Mode::TearOff { window, .. } => window == label,
      Mode::MoveWindow { .. } => false,
    };
    if leads {
      return self.end(true, Some(label), false);
    }
    if follow.sender == label {
      return self.end(notify_sender, Some(label), false);
    }
    Vec::new()
  }
  /// Window `label` is gone: it is closing, and its report and role go too. A
  /// window still marked hidden is shown before the mark goes: the page of a live
  /// window may only have loaded again.
  pub fn window_gone(&mut self, label: &str, notify_sender: bool) -> Vec<TearAction> {
    let mut actions = self.window_closing(label, notify_sender);
    actions.extend(self.take_hidden(label));
    self.closing.remove(label);
    self.reports.remove(label);
    self.roles.remove(label);
    actions
  }
  /// The close of window `label` was called off: it is shown again if it was
  /// made invisible, and brought forward if it still waits in its role.
  pub fn close_vetoed(&mut self, label: &str) -> Vec<TearAction> {
    self.closing.remove(label);
    let mut actions: Vec<TearAction> = self.take_hidden(label).into_iter().collect();
    actions.extend(self.reveal(label));
    actions
  }
  /// A quit starts: nothing follows, nothing waits, and nothing is shown until
  /// the quit is called off.
  pub fn quit(&mut self) -> Vec<TearAction> {
    self.quitting = true;
    self.recorded.clear();
    self.end(true, None, false)
  }
  /// The quit was called off: every window made invisible is visible again, and
  /// every tear-off that holds its tab and was never shown is shown now.
  pub fn quit_cancelled(&mut self) -> Vec<TearAction> {
    self.quitting = false;
    // No window is closing for a quit that did not happen.
    self.closing.clear();
    let mut hidden: Vec<String> = self.hidden.drain().collect();
    hidden.sort();
    let mut actions: Vec<TearAction> = hidden
      .into_iter()
      .map(|label| TearAction::Show { label })
      .collect();
    let mut labels: Vec<String> = self
      .roles
      .iter()
      .filter(|(_, role)| !role.ended)
      .map(|(label, _)| label.clone())
      .collect();
    labels.sort();
    actions.extend(labels.iter().flat_map(|label| self.reveal(label)));
    actions
  }
}
/// The hover messages for a drag that was over `prev` and is now over `next`.
fn hover_actions(
  prev: Option<&str>,
  next: Option<(&str, Point)>,
  width: f64,
  follow: &HoverFollow,
) -> Vec<TearAction> {
  let mut actions = Vec::new();
  let label = next.map(|(label, _)| label);
  if let Some(prev) = prev.filter(|prev| Some(*prev) != label) {
    actions.push(TearAction::HoverEnd {
      label: prev.to_string(),
    });
  }
  if let Some((label, offset)) = next {
    actions.push(TearAction::Hover {
      label: label.to_string(),
      x: offset.x,
      y: offset.y,
      width,
      follow: follow.clone(),
    });
  }
  actions
}
/// What the core does to show a tear-off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevealCall {
  /// Show it and focus it.
  Reveal,
  /// Leave it as it is: it is on screen already, and any call would bring the
  /// app forward.
  Nothing,
}
/// The one decision of a reveal: a window is shown and focused only while the app
/// is the active one.
pub fn reveal_call(app_active: bool) -> RevealCall {
  if app_active {
    RevealCall::Reveal
  } else {
    RevealCall::Nothing
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn p(x: f64, y: f64) -> Point {
    Point { x, y }
  }
  fn report() -> BarReport {
    BarReport {
      top: 0.0,
      bottom: 30.0,
      left: 0.0,
      right: 600.0,
      dpr: 1.5,
    }
  }
  fn spec(id: &str) -> TearSpec {
    TearSpec {
      id: id.to_string(),
      grab: p(20.0, 14.0),
      first_tab_client_x: 4.0,
      esc_offset: p(101.0, 15.0),
      dpr: 2.0,
      width: 90.0,
      title: "a.txt".to_string(),
    }
  }
  /// What a hover of the follow `generation` of `spec("a")` carries.
  fn info(generation: u64) -> HoverFollow {
    HoverFollow {
      generation,
      title: "a.txt".to_string(),
      grab_x: 20.0,
    }
  }
  fn doc(label: &str, x: f64, y: f64) -> Hit {
    Hit::Doc {
      label: label.to_string(),
      offset: p(x, y),
    }
  }

  #[test]
  fn a_point_is_over_a_bar_inside_it_and_within_the_band_above_and_below() {
    let r = report();
    assert_eq!(
      bar_target(p(10.0, 10.0), Some(&r), false),
      Some(p(10.0, 10.0))
    );
    // 15 px above the top is in, 16 px is out.
    assert!(bar_target(p(10.0, -15.0), Some(&r), false).is_some());
    assert!(bar_target(p(10.0, -16.0), Some(&r), false).is_none());
    // 15 px below the bottom is out: the band is half open like the bar.
    assert!(bar_target(p(10.0, 44.0), Some(&r), false).is_some());
    assert!(bar_target(p(10.0, 45.0), Some(&r), false).is_none());
    assert!(bar_target(p(10.0, 46.0), Some(&r), false).is_none());
  }

  #[test]
  fn x_outside_the_bar_is_never_over_it() {
    let r = report();
    assert!(bar_target(p(-1.0, 10.0), Some(&r), false).is_none());
    assert!(bar_target(p(600.0, 10.0), Some(&r), false).is_none());
    assert!(bar_target(p(599.5, 10.0), Some(&r), false).is_some());
  }

  #[test]
  fn a_window_without_a_report_is_never_over_a_bar() {
    assert!(bar_target(p(10.0, 10.0), None, false).is_none());
    assert!(bar_target(p(10.0, 10.0), None, true).is_none());
  }

  #[test]
  fn y_is_clamped_into_the_bar_so_the_receiver_reads_a_point_on_it() {
    let r = report();
    let above = bar_target(p(10.0, -10.0), Some(&r), false).unwrap();
    assert_eq!(above, p(10.0, 0.0));
    let below = bar_target(p(10.0, 40.0), Some(&r), false).unwrap();
    assert!(below.y < r.bottom && below.y >= r.top);
    assert_eq!(below.x, 10.0);
  }

  #[test]
  fn on_windows_the_band_is_in_css_pixels_of_the_reported_ratio() {
    let r = report();
    // 1.5 native units per CSS pixel: 15 CSS px above is 22.5 native units.
    assert!(bar_target(p(30.0, -22.5), Some(&r), true).is_some());
    assert!(bar_target(p(30.0, -24.0), Some(&r), true).is_none());
    // The clamped offset is native again.
    let at = bar_target(p(30.0, -22.0), Some(&r), true).unwrap();
    assert_eq!(at, p(30.0, 0.0));
    let inside = bar_target(p(30.0, 15.0), Some(&r), true).unwrap();
    assert_eq!(inside, p(30.0, 15.0));
  }

  #[test]
  fn the_tear_off_goes_where_the_grabbed_spot_of_its_tab_is_under_the_pointer() {
    // 800x600 pointer, tab at 4 + 20 into the window, 14 down, 1:1, no frame.
    let at = tearoff_outer_top_left(p(800.0, 600.0), 4.0, p(20.0, 14.0), 1.0, p(0.0, 0.0));
    assert_eq!(at, p(776.0, 586.0));
    // The frame (inner minus outer) is taken off.
    let framed = tearoff_outer_top_left(p(800.0, 600.0), 4.0, p(20.0, 14.0), 1.0, p(1.0, 28.0));
    assert_eq!(framed, p(775.0, 558.0));
    // CSS pixels are scaled to native units.
    let scaled = tearoff_outer_top_left(p(800.0, 600.0), 4.0, p(20.0, 14.0), 1.5, p(0.0, 0.0));
    assert_eq!(scaled, p(764.0, 579.0));
  }

  #[test]
  fn a_moving_window_is_held_where_the_button_went_down() {
    // Outer top left 100,200, page 32 below it, pressed at client 40,15.
    assert_eq!(
      held_point(p(100.0, 200.0), p(0.0, 32.0), p(40.0, 15.0), 1.0),
      p(140.0, 247.0)
    );
    // On Windows a CSS pixel is `dpr` physical pixels.
    assert_eq!(
      held_point(p(100.0, 200.0), p(8.0, 31.0), p(40.0, 15.0), 1.5),
      p(168.0, 253.5)
    );
  }
  #[test]
  fn a_moving_window_keeps_the_pointer_at_its_grab() {
    assert_eq!(
      move_outer_top_left(p(500.0, 300.0), p(120.0, 40.0)),
      p(380.0, 260.0)
    );
  }

  #[test]
  fn the_scale_is_one_on_macos_and_the_reported_ratio_on_windows() {
    assert_eq!(follow_scale(false, Some(1.5), 2.0), 1.0);
    assert_eq!(follow_scale(true, Some(1.5), 2.0), 1.5);
    // The sender's until the tear-off reports.
    assert_eq!(follow_scale(true, None, 2.0), 2.0);
  }

  #[test]
  fn the_step_uses_the_reported_ratio_and_not_the_displays_scale() {
    let mut book = TearOffBook::default();
    let g = book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    // Until the tear-off reports: the sender's 2.0.
    let plan = book.plan_step(g, true).unwrap();
    assert_eq!(
      plan.kind,
      StepKind::TearOff {
        first_tab_client_x: 4.0,
        grab: p(20.0, 14.0),
        scale: 2.0
      }
    );
    book.set_bar_report("doc-t", report());
    // Then the report's 1.5, though the display's scale factor may say 1.25.
    let StepKind::TearOff { scale, .. } = book.plan_step(g, true).unwrap().kind else {
      panic!("not a tear-off");
    };
    assert_eq!(scale, 1.5);
    let at = tearoff_outer_top_left(p(1000.0, 800.0), 4.0, p(20.0, 14.0), scale, p(0.0, 0.0));
    assert_eq!(at, p(1000.0 - 24.0 * 1.5, 800.0 - 14.0 * 1.5));
    // macOS never scales.
    let StepKind::TearOff { scale, .. } = book.plan_step(g, false).unwrap().kind else {
      panic!("not a tear-off");
    };
    assert_eq!(scale, 1.0);
  }

  #[test]
  fn a_maximized_windows_sender_gives_a_tear_off_the_restored_size_less_its_frame() {
    // Scale 1.5, restored outer 1200x900 physical, the sender's frame, title bar
    // and menu bar take 16x70 physical.
    let inner = windows_tearoff_inner((1200.0, 900.0), (1920.0, 1040.0), (1904.0, 970.0), 1.5);
    assert_eq!(inner, ((1200.0 - 16.0) / 1.5, (900.0 - 70.0) / 1.5));
    // The raw outer size is not the inner size.
    assert_ne!(inner, (1200.0 / 1.5, 900.0 / 1.5));
  }

  #[test]
  fn a_maximized_grab_keeps_the_pointers_fraction_of_the_width_in_the_raw_outer_size() {
    // The pointer is at a third of a 1800 wide maximized frame; the window
    // restores to 1200 physical wide (the raw outer width, never the inner).
    let grab = maximized_grab(p(600.0, 25.0), p(0.0, 0.0), 1800.0, 1200.0);
    assert_eq!(grab, p(400.0, 25.0));
    let moved = maximized_grab(p(700.0, 55.0), p(100.0, 30.0), 1800.0, 900.0);
    assert_eq!(moved, p(300.0, 25.0));
  }

  #[test]
  fn a_zoomed_macos_window_restores_to_a_frame_of_the_remembered_content_and_the_title_bar() {
    let frame = mac_restored_outer((900.0, 640.0), 28.0);
    assert_eq!(frame, (900.0, 668.0));
    // The content is what is remembered: the frame is taller by the title bar.
    assert_ne!(frame, (900.0, 640.0));
  }

  #[test]
  fn the_esc_offset_is_css_pixels_on_macos_and_scaled_by_the_ratio_on_windows() {
    assert_eq!(esc_native(p(101.0, 15.0), false, 2.0), p(101.0, 15.0));
    assert_eq!(esc_native(p(101.0, 15.0), true, 2.0), p(202.0, 30.0));
  }

  #[test]
  fn at_most_one_step_is_outstanding() {
    let gate = StepGate::default();
    assert!(gate.try_begin());
    assert!(!gate.try_begin());
    gate.finish();
    assert!(gate.try_begin());
  }

  #[test]
  fn a_second_follow_is_refused_while_one_exists() {
    let mut book = TearOffBook::default();
    assert!(book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .is_some());
    assert!(book
      .start_tearoff(&spec("b"), "doc-x", "doc-u", "m", 2)
      .is_none());
    assert!(book
      .start_move(
        &spec("c"),
        "doc-y",
        "k",
        p(1.0, 1.0),
        false,
        p(0.0, 0.0),
        20.0
      )
      .is_none());
    assert!(book.busy());
  }

  #[test]
  fn a_step_of_an_old_generation_does_nothing() {
    let mut book = TearOffBook::default();
    let g = book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    assert!(book.plan_step(g + 1, false).is_none());
    assert!(book
      .finish_step(g + 1, false, &Hit::Outside, false)
      .is_empty());
    // The follow is still live: the stale step ended nothing.
    assert!(book.busy());
    assert_eq!(book.live_flag().load(Ordering::SeqCst), g);
  }

  #[test]
  fn the_live_flag_is_zero_once_the_follow_ends() {
    let mut book = TearOffBook::default();
    let g = book
      .start_move(
        &spec("a"),
        "doc-s",
        "n",
        p(1.0, 1.0),
        false,
        p(0.0, 0.0),
        20.0,
      )
      .unwrap();
    assert_eq!(book.live_flag().load(Ordering::SeqCst), g);
    book.finish_step(g, false, &Hit::Outside, false);
    assert_eq!(book.live_flag().load(Ordering::SeqCst), 0);
    // A new follow gets a new generation.
    let next = book
      .start_move(
        &spec("b"),
        "doc-s",
        "n",
        p(1.0, 1.0),
        false,
        p(0.0, 0.0),
        20.0,
      )
      .unwrap();
    assert!(next > g);
  }

  #[test]
  fn the_hover_follows_the_pointer_and_carries_the_width_of_the_tab() {
    let mut book = TearOffBook::default();
    book.set_bar_report("doc-a", report());
    book.set_bar_report("doc-b", report());
    let g = book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    assert_eq!(
      book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false),
      vec![TearAction::Hover {
        label: "doc-a".to_string(),
        x: 40.0,
        y: 10.0,
        width: 90.0,
        follow: info(g)
      }]
    );
    // Moving to another window ends the first and hovers the second.
    assert_eq!(
      book.finish_step(g, true, &doc("doc-b", 50.0, 10.0), false),
      vec![
        TearAction::HoverEnd {
          label: "doc-a".to_string()
        },
        TearAction::Hover {
          label: "doc-b".to_string(),
          x: 50.0,
          y: 10.0,
          width: 90.0,
          follow: info(g)
        }
      ]
    );
    // Leaving every bar ends it.
    assert_eq!(
      book.finish_step(g, true, &Hit::Outside, false),
      vec![TearAction::HoverEnd {
        label: "doc-b".to_string()
      }]
    );
    assert!(book.finish_step(g, true, &Hit::Outside, false).is_empty());
  }

  #[test]
  fn a_hover_is_emitted_only_when_the_window_the_offset_or_the_width_differs_from_the_last() {
    let mut book = TearOffBook::default();
    book.set_bar_report("doc-a", report());
    book.set_bar_report("doc-b", report());
    let g = book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    let hover = |label: &str, x: f64, y: f64| TearAction::Hover {
      label: label.to_string(),
      x,
      y,
      width: 90.0,
      follow: info(g),
    };
    // Two steps at the same point: one hover.
    assert_eq!(
      book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false),
      vec![hover("doc-a", 40.0, 10.0)]
    );
    assert!(book
      .finish_step(g, true, &doc("doc-a", 40.0, 10.0), false)
      .is_empty());
    // A moved point: a second one.
    assert_eq!(
      book.finish_step(g, true, &doc("doc-a", 41.0, 10.0), false),
      vec![hover("doc-a", 41.0, 10.0)]
    );
    // The clamped offset counts, not the raw one: both of these clamp to y 0.
    assert_eq!(
      book.finish_step(g, true, &doc("doc-a", 41.0, -3.0), false),
      vec![hover("doc-a", 41.0, 0.0)]
    );
    assert!(book
      .finish_step(g, true, &doc("doc-a", 41.0, -5.0), false)
      .is_empty());
    // Another window ends the old hover and emits for the new one.
    assert_eq!(
      book.finish_step(g, true, &doc("doc-b", 41.0, 0.0), false),
      vec![
        TearAction::HoverEnd {
          label: "doc-a".to_string()
        },
        hover("doc-b", 41.0, 0.0)
      ]
    );
    // Back out and in again at the same point emits again.
    assert_eq!(
      book.finish_step(g, true, &Hit::Outside, false),
      vec![TearAction::HoverEnd {
        label: "doc-b".to_string()
      }]
    );
    assert_eq!(
      book.finish_step(g, true, &doc("doc-b", 41.0, 0.0), false),
      vec![hover("doc-b", 41.0, 0.0)]
    );
  }

  #[test]
  fn a_closing_window_is_neither_shown_nor_sent_to_until_its_close_is_called_off() {
    let mut book = TearOffBook::default();
    book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    book.window_closing("doc-t", true);
    assert!(book.reveal("doc-t").is_empty());
    assert!(book
      .send("doc-t", "n".to_string(), "doc-b".to_string(), p(1.0, 1.0))
      .is_empty());
    // Its role is as it was.
    assert!(!book.role_state("doc-t").ended);
    let shown = book.close_vetoed("doc-t");
    assert!(matches!(shown.first(), Some(TearAction::Reveal { .. })));
    assert_eq!(shown.len(), 2);
    // Once.
    assert!(book.close_vetoed("doc-t").is_empty());
  }

  #[test]
  fn a_window_over_the_band_but_not_the_bar_is_not_hovered() {
    let mut book = TearOffBook::default();
    book.set_bar_report("doc-a", report());
    let g = book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    // 100 px below the bar is inside the window and not over its bar.
    assert!(book
      .finish_step(g, true, &doc("doc-a", 40.0, 130.0), false)
      .is_empty());
  }

  #[test]
  fn the_button_counts_as_up_once_the_page_saw_the_release() {
    let mut book = TearOffBook::default();
    let g = book
      .start_move(
        &spec("a"),
        "doc-s",
        "n",
        p(1.0, 1.0),
        false,
        p(0.0, 0.0),
        20.0,
      )
      .unwrap();
    // Another id or another caller marks nothing.
    book.release_seen("x", "doc-s");
    book.release_seen("a", "doc-other");
    assert!(book.finish_step(g, true, &Hit::Outside, false).is_empty());
    book.release_seen("a", "doc-s");
    let actions = book.finish_step(g, true, &Hit::Outside, false);
    assert_eq!(
      actions,
      vec![TearAction::EmitEnd {
        label: "doc-s".to_string(),
        id: "a".to_string()
      }]
    );
  }

  #[test]
  fn moving_a_window_over_another_bar_sends_its_only_tab_there_and_elsewhere_nothing() {
    let mut book = TearOffBook::default();
    book.set_bar_report("doc-a", report());
    let g = book
      .start_move(
        &spec("a"),
        "doc-s",
        "n",
        p(1.0, 1.0),
        false,
        p(0.0, 0.0),
        20.0,
      )
      .unwrap();
    book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false);
    let actions = book.finish_step(g, false, &doc("doc-a", 42.0, 10.0), false);
    assert_eq!(
      actions,
      vec![
        TearAction::EmitEnd {
          label: "doc-s".to_string(),
          id: "a".to_string()
        },
        TearAction::HoverEnd {
          label: "doc-a".to_string()
        },
        TearAction::EmitSend {
          label: "doc-s".to_string(),
          note: "n".to_string(),
          to: "doc-a".to_string(),
          offset: p(42.0, 10.0)
        }
      ]
    );
    let g = book
      .start_move(
        &spec("b"),
        "doc-s",
        "n",
        p(1.0, 1.0),
        false,
        p(0.0, 0.0),
        20.0,
      )
      .unwrap();
    let actions = book.finish_step(g, false, &Hit::Outside, false);
    assert_eq!(
      actions,
      vec![TearAction::EmitEnd {
        label: "doc-s".to_string(),
        id: "b".to_string()
      }]
    );
  }

  #[test]
  fn esc_puts_a_moving_window_back_and_maximizes_it_again_if_it_was() {
    let mut book = TearOffBook::default();
    book
      .start_move(
        &spec("a"),
        "doc-s",
        "n",
        p(1.0, 1.0),
        true,
        p(30.0, 40.0),
        20.0,
      )
      .unwrap();
    // A stale id or a caller that is not the sender does nothing.
    assert!(book.cancel("old", "doc-s", false).is_empty());
    assert!(book.cancel("a", "doc-x", false).is_empty());
    assert!(book.busy());
    let actions = book.cancel("a", "doc-s", false);
    assert!(actions.contains(&TearAction::MoveTo {
      label: "doc-s".to_string(),
      point: p(30.0, 40.0),
      remaximize: true
    }));
    assert!(!book.busy());
  }

  #[test]
  fn the_reveal_decision_shows_the_window_only_while_the_app_is_active() {
    assert_eq!(reveal_call(true), RevealCall::Reveal);
    assert_eq!(reveal_call(false), RevealCall::Nothing);
  }

  #[test]
  fn every_reveal_comes_with_the_end_of_the_role() {
    let mut book = TearOffBook::default();
    book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    let actions = book.reveal("doc-t");
    assert_eq!(
      actions,
      vec![
        TearAction::Reveal {
          label: "doc-t".to_string()
        },
        TearAction::EmitRoleEnd {
          label: "doc-t".to_string()
        }
      ]
    );
    // Once.
    assert!(book.reveal("doc-t").is_empty());
    assert!(book.role_state("doc-t").ended);
    assert!(!book.role_state("doc-t").revealed);
    book.mark_revealed("doc-t");
    assert!(book.role_state("doc-t").revealed);
  }

  #[test]
  fn a_quit_shows_nothing_and_a_quit_called_off_shows_the_tear_off_that_waited() {
    let mut book = TearOffBook::default();
    book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    let ended = book.quit();
    assert_eq!(
      ended,
      vec![TearAction::EmitEnd {
        label: "doc-s".to_string(),
        id: "a".to_string()
      }]
    );
    assert!(book.reveal("doc-t").is_empty());
    assert!(!book.role_state("doc-t").ended);
    let shown = book.quit_cancelled();
    assert_eq!(
      shown,
      vec![
        TearAction::Reveal {
          label: "doc-t".to_string()
        },
        TearAction::EmitRoleEnd {
          label: "doc-t".to_string()
        }
      ]
    );
    // Not twice.
    assert!(book.quit_cancelled().is_empty());
  }

  #[test]
  fn a_gone_window_takes_its_report_role_and_releases_with_it() {
    let mut book = TearOffBook::default();
    book.set_bar_report("doc-t", report());
    let g = book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    book.finish_step(g, false, &Hit::Outside, false);
    // The release waits for `released`.
    assert!(!book.busy());
    let actions = book.window_gone("doc-t", true);
    assert!(actions.is_empty());
    assert!(book.record_overdue(1).is_empty());
    assert!(book.on_released(1).is_empty());
    assert!(!book.role_state("doc-t").ended);
    assert!(bar_target(p(1.0, 1.0), book.reports.get("doc-t"), false).is_none());
  }

  fn hide(label: &str) -> TearAction {
    TearAction::Hide {
      label: label.to_string(),
    }
  }
  fn show(label: &str) -> TearAction {
    TearAction::Show {
      label: label.to_string(),
    }
  }
  /// A tear-off follow of `spec("a")` into doc-t, with doc-a and doc-b to hover.
  fn tear_follow() -> (TearOffBook, u64) {
    let mut book = TearOffBook::default();
    book.set_bar_report("doc-a", report());
    book.set_bar_report("doc-b", report());
    let g = book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    (book, g)
  }
  /// A moving window follow of `spec("a")` with doc-a and doc-b to hover.
  fn move_follow() -> (TearOffBook, u64) {
    let mut book = TearOffBook::default();
    book.set_bar_report("doc-a", report());
    book.set_bar_report("doc-b", report());
    let g = book
      .start_move(
        &spec("a"),
        "doc-s",
        "n",
        p(1.0, 1.0),
        false,
        p(0.0, 0.0),
        12.0,
      )
      .unwrap();
    (book, g)
  }
  /// The follow hovers `label` and `label` took the tab: the follower is hidden.
  fn hidden_over(book: &mut TearOffBook, g: u64, label: &str) {
    assert!(book
      .finish_step(g, true, &doc(label, 40.0, 10.0), false)
      .iter()
      .all(|a| !matches!(a, TearAction::Hide { .. })));
    book.hover_ack(label, g, true);
    let actions = book.finish_step(g, true, &doc(label, 40.0, 10.0), false);
    assert!(actions.iter().any(|a| matches!(a, TearAction::Hide { .. })));
  }

  #[test]
  fn the_follower_is_hidden_only_after_the_hovered_window_took_the_tab() {
    let (mut book, g) = tear_follow();
    // Over a bar, no answer yet: nothing is hidden, however many steps pass.
    for _ in 0..5 {
      let actions = book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false);
      assert!(!actions.contains(&hide("doc-t")));
    }
    assert!(!book.is_hidden("doc-t"));
    book.hover_ack("doc-a", g, true);
    assert_eq!(
      book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false),
      vec![hide("doc-t")]
    );
    assert!(book.is_hidden("doc-t"));
    // Once.
    assert!(book
      .finish_step(g, true, &doc("doc-a", 40.0, 10.0), false)
      .is_empty());
  }

  #[test]
  fn an_answer_that_says_no_shows_the_follower_at_the_next_step() {
    let (mut book, g) = tear_follow();
    hidden_over(&mut book, g, "doc-a");
    book.hover_ack("doc-a", g, false);
    assert_eq!(
      book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false),
      vec![show("doc-t")]
    );
    assert!(!book.is_hidden("doc-t"));
    // And a window that says no from the start never hides it.
    let (mut book, g) = tear_follow();
    book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false);
    book.hover_ack("doc-a", g, false);
    assert!(!book
      .finish_step(g, true, &doc("doc-a", 40.0, 10.0), false)
      .contains(&hide("doc-t")));
  }

  #[test]
  fn an_answer_of_another_follow_or_another_window_is_ignored() {
    let (mut book, g) = tear_follow();
    book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false);
    book.hover_ack("doc-a", g + 1, true);
    book.hover_ack("doc-b", g, true);
    assert!(book
      .finish_step(g, true, &doc("doc-a", 40.0, 10.0), false)
      .is_empty());
    assert!(!book.is_hidden("doc-t"));
    // Without a follow at all.
    let mut idle = TearOffBook::default();
    idle.hover_ack("doc-a", 1, true);
    assert!(!idle.busy());
  }

  #[test]
  fn leaving_the_bar_or_moving_to_another_window_shows_the_follower_and_needs_a_new_answer() {
    let (mut book, g) = tear_follow();
    hidden_over(&mut book, g, "doc-a");
    assert_eq!(
      book.finish_step(g, true, &Hit::Outside, false),
      vec![
        TearAction::HoverEnd {
          label: "doc-a".to_string()
        },
        show("doc-t")
      ]
    );
    // Back over doc-a: its old answer does not count.
    let actions = book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false);
    assert!(!actions.contains(&hide("doc-t")));
    book.hover_ack("doc-a", g, true);
    assert_eq!(
      book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false),
      vec![hide("doc-t")]
    );
    // From one window to the next: shown, then hidden again once doc-b says yes.
    let actions = book.finish_step(g, true, &doc("doc-b", 40.0, 10.0), false);
    assert!(actions.contains(&show("doc-t")));
    assert!(!actions.contains(&hide("doc-t")));
    book.hover_ack("doc-b", g, true);
    assert_eq!(
      book.finish_step(g, true, &doc("doc-b", 40.0, 10.0), false),
      vec![hide("doc-t")]
    );
  }

  #[test]
  fn a_hovered_window_that_closes_shows_the_follower_exactly_once() {
    for gone in [false, true] {
      let (mut book, g) = tear_follow();
      hidden_over(&mut book, g, "doc-a");
      let closed = if gone {
        book.window_gone("doc-a", true)
      } else {
        book.window_closing("doc-a", true)
      };
      // It is the hovered window that closes: the follower is not its to show.
      assert!(!closed.contains(&show("doc-t")));
      let actions = book.finish_step(g, true, &Hit::Outside, false);
      assert_eq!(
        actions
          .iter()
          .filter(|a| matches!(a, TearAction::Show { .. }))
          .count(),
        1,
        "{gone}"
      );
      assert!(book.finish_step(g, true, &Hit::Outside, false).is_empty());
    }
  }

  #[test]
  fn the_same_hover_is_sent_again_after_the_keepalive_and_not_before() {
    let (mut book, g) = tear_follow();
    let still = |book: &mut TearOffBook| {
      book
        .finish_step(g, true, &doc("doc-a", 40.0, 10.0), false)
        .iter()
        .filter(|a| matches!(a, TearAction::Hover { .. }))
        .count()
    };
    assert_eq!(still(&mut book), 1);
    for step in 1..HOVER_KEEPALIVE_STEPS {
      assert_eq!(still(&mut book), 0, "{step}");
    }
    assert_eq!(still(&mut book), 1);
    // And the count starts over.
    for step in 1..HOVER_KEEPALIVE_STEPS {
      assert_eq!(still(&mut book), 0, "{step}");
    }
    assert_eq!(still(&mut book), 1);
  }

  #[test]
  fn a_hover_that_moves_restarts_the_keepalive_count() {
    let (mut book, g) = tear_follow();
    book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false);
    for _ in 1..HOVER_KEEPALIVE_STEPS {
      book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false);
    }
    // One step short of the keepalive, the pointer moves: a hover of its own.
    assert!(!book
      .finish_step(g, true, &doc("doc-a", 41.0, 10.0), false)
      .is_empty());
    for step in 1..HOVER_KEEPALIVE_STEPS {
      assert!(
        book
          .finish_step(g, true, &doc("doc-a", 41.0, 10.0), false)
          .is_empty(),
        "{step}"
      );
    }
  }

  #[test]
  fn a_restore_clears_the_mark_and_the_next_step_over_a_taking_bar_hides_again() {
    let (mut book, g) = tear_follow();
    hidden_over(&mut book, g, "doc-a");
    book.clear_hidden("doc-t");
    assert!(!book.is_hidden("doc-t"));
    assert_eq!(
      book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false),
      vec![hide("doc-t")]
    );
    assert!(book.is_hidden("doc-t"));
    // Over nothing a restore leaves it shown.
    book.clear_hidden("doc-t");
    assert!(book.finish_step(g, true, &Hit::Outside, false).len() == 1);
    assert!(!book.is_hidden("doc-t"));
  }

  #[test]
  fn a_release_over_a_bar_that_took_the_tab_keeps_the_follower_hidden() {
    for moving in [false, true] {
      let (mut book, g) = if moving { move_follow() } else { tear_follow() };
      let label = if moving { "doc-s" } else { "doc-t" };
      hidden_over(&mut book, g, "doc-a");
      let actions = book.finish_step(g, false, &doc("doc-a", 42.0, 10.0), false);
      assert!(!actions.iter().any(|a| matches!(a, TearAction::Show { .. })));
      assert!(book.is_hidden(label), "{moving}");
    }
  }

  #[test]
  fn a_release_anywhere_else_shows_the_follower_before_the_end_of_the_follow() {
    // Elsewhere, over a bar that did not answer, over one that said no.
    for case in 0..3 {
      let (mut book, g) = tear_follow();
      hidden_over(&mut book, g, "doc-a");
      let hit = match case {
        0 => Hit::Outside,
        1 => doc("doc-b", 40.0, 10.0),
        _ => {
          book.hover_ack("doc-a", g, false);
          doc("doc-a", 40.0, 10.0)
        }
      };
      let actions = book.finish_step(g, false, &hit, false);
      assert_eq!(actions.first(), Some(&show("doc-t")), "{case}");
      assert!(!book.is_hidden("doc-t"));
    }
  }

  #[test]
  fn esc_a_called_off_transfer_and_a_closing_sender_show_a_hidden_follower_first() {
    let (mut book, g) = move_follow();
    hidden_over(&mut book, g, "doc-a");
    let actions = book.cancel("a", "doc-s", false);
    let shown = actions.iter().position(|a| *a == show("doc-s")).unwrap();
    let moved = actions
      .iter()
      .position(|a| matches!(a, TearAction::MoveTo { .. }))
      .unwrap();
    assert!(shown < moved);
    let (mut book, g) = tear_follow();
    hidden_over(&mut book, g, "doc-a");
    assert_eq!(book.first_called_off(1).first(), Some(&show("doc-t")));
    let (mut book, g) = tear_follow();
    hidden_over(&mut book, g, "doc-a");
    assert_eq!(book.drop_first(1, true).first(), Some(&show("doc-t")));
    let (mut book, g) = tear_follow();
    hidden_over(&mut book, g, "doc-a");
    assert_eq!(
      book.window_closing("doc-s", true).first(),
      Some(&show("doc-t"))
    );
    let (mut book, g) = tear_follow();
    hidden_over(&mut book, g, "doc-a");
    assert_eq!(book.quit().first(), Some(&show("doc-t")));
  }

  #[test]
  fn a_window_that_is_gone_is_shown_before_its_mark_goes() {
    // A merged moving window.
    let (mut book, g) = move_follow();
    hidden_over(&mut book, g, "doc-a");
    book.finish_step(g, false, &doc("doc-a", 42.0, 10.0), false);
    let gone = book.window_gone("doc-s", false);
    assert_eq!(gone, vec![show("doc-s")]);
    assert!(!book.is_hidden("doc-s"));
    // A tear-off with the follow live.
    let (mut book, g) = tear_follow();
    hidden_over(&mut book, g, "doc-a");
    let gone = book.window_gone("doc-t", true);
    assert_eq!(gone.iter().filter(|a| **a == show("doc-t")).count(), 1);
    assert!(!book.is_hidden("doc-t"));
    // A window that was never hidden is not told.
    assert!(book.window_gone("doc-x", true).is_empty());
  }

  #[test]
  fn a_close_called_off_and_a_quit_called_off_show_what_a_merge_left_hidden() {
    let (mut book, g) = move_follow();
    hidden_over(&mut book, g, "doc-a");
    book.finish_step(g, false, &doc("doc-a", 42.0, 10.0), false);
    book.window_closing("doc-s", true);
    // Whatever the role: the moving window has none.
    assert_eq!(book.close_vetoed("doc-s"), vec![show("doc-s")]);
    assert!(book.close_vetoed("doc-s").is_empty());
    let (mut book, g) = move_follow();
    hidden_over(&mut book, g, "doc-a");
    book.finish_step(g, false, &doc("doc-a", 42.0, 10.0), false);
    book.quit();
    book.window_closing("doc-s", true);
    assert_eq!(book.quit_cancelled(), vec![show("doc-s")]);
    assert!(book.quit_cancelled().is_empty());
  }

  #[test]
  fn a_reveal_shows_a_hidden_tear_off_first_and_only_then() {
    let (mut book, g) = tear_follow();
    hidden_over(&mut book, g, "doc-a");
    book.finish_step(g, false, &doc("doc-a", 42.0, 10.0), false);
    assert!(book.is_hidden("doc-t"));
    assert_eq!(
      book.reveal("doc-t"),
      vec![
        show("doc-t"),
        TearAction::Reveal {
          label: "doc-t".to_string()
        },
        TearAction::EmitRoleEnd {
          label: "doc-t".to_string()
        }
      ]
    );
    assert!(!book.is_hidden("doc-t"));
  }

  #[test]
  fn the_hover_of_a_follow_carries_the_title_and_the_grab_inside_the_tab_in_both_modes() {
    let (mut book, g) = tear_follow();
    let want = |grab_x: f64| TearAction::Hover {
      label: "doc-a".to_string(),
      x: 40.0,
      y: 10.0,
      width: 90.0,
      follow: HoverFollow {
        generation: 0,
        title: "a.txt".to_string(),
        grab_x,
      },
    };
    let with = |mut action: TearAction, generation: u64| {
      if let TearAction::Hover { follow, .. } = &mut action {
        follow.generation = generation;
      }
      action
    };
    // A tear-off: the grab within the tab.
    assert_eq!(
      book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false),
      vec![with(want(20.0), g)]
    );
    // A moving window: what the page measured, not the window's grab.
    let (mut book, g) = move_follow();
    assert_eq!(
      book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false),
      vec![with(want(12.0), g)]
    );
  }

  #[test]
  fn a_hover_over_a_window_that_is_gone_is_not_ended() {
    let mut book = TearOffBook::default();
    book.set_bar_report("doc-a", report());
    let g = book
      .start_tearoff(&spec("a"), "doc-s", "doc-t", "n", 1)
      .unwrap();
    book.finish_step(g, true, &doc("doc-a", 40.0, 10.0), false);
    assert!(book.window_gone("doc-a", true).is_empty());
    let actions = book.finish_step(g, false, &Hit::Outside, false);
    assert!(!actions
      .iter()
      .any(|action| matches!(action, TearAction::HoverEnd { .. })));
  }
}
