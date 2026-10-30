// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Files routed into an existing document window as tabs. A window that is still
// loading has no `open-file-here` listener and `emit_to` succeeds without one,
// so paths for a window that has not announced itself are queued here and
// handed over when it does. A converted document handed over from a sticky
// (`convert_handoff`) waits in the same queue, in the order it arrived.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
/// Something routed into a document window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Pending {
  /// A file to open as a tab.
  Path(String),
  /// A converted document to claim (`convert_claim`), by handoff id.
  Handoff(u64),
}
/// One guard covers the queue and the ready set, so a path is either queued
/// before the window's drain or delivered directly after it, never both or
/// neither.
#[derive(Default)]
struct Inner {
  queued: HashMap<String, Vec<Pending>>,
  ready: HashSet<String>,
}
/// What `PendingOpens::route` decided for one path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
  /// The window is ready: the caller emits the path to it.
  Deliver,
  /// The path was queued until the window announces itself.
  Queued,
}

#[derive(Default)]
pub struct PendingOpens {
  inner: Mutex<Inner>,
}

impl PendingOpens {
  /// Decide for `path` bound for `label` and, when not ready, queue it.
  pub fn route(&self, label: &str, path: &str) -> Route {
    self.route_item(label, Pending::Path(path.to_string()))
  }
  /// `route`, for the converted document of handoff `handoff_id`.
  pub fn route_handoff(&self, label: &str, handoff_id: u64) -> Route {
    self.route_item(label, Pending::Handoff(handoff_id))
  }
  fn route_item(&self, label: &str, item: Pending) -> Route {
    let mut inner = self.inner.lock().unwrap();
    if inner.ready.contains(label) {
      Route::Deliver
    } else {
      inner
        .queued
        .entry(label.to_string())
        .or_default()
        .push(item);
      Route::Queued
    }
  }
  /// Mark `label` ready and take what was queued for it, in arrival order.
  pub fn mark_ready(&self, label: &str) -> Vec<Pending> {
    let mut inner = self.inner.lock().unwrap();
    inner.ready.insert(label.to_string());
    inner.queued.remove(label).unwrap_or_default()
  }
  /// Forget a destroyed window and return what it never received.
  pub fn forget(&self, label: &str) -> Vec<Pending> {
    let mut inner = self.inner.lock().unwrap();
    inner.ready.remove(label);
    inner.queued.remove(label).unwrap_or_default()
  }
}
/// Open `path` as a tab of document window `window`. A ready window gets the
/// event and is raised; one still loading has the path queued and shows itself
/// when its own themed reveal runs. False only when the event could not be
/// sent.
pub fn open_in_window(window: &tauri::WebviewWindow, path: &str) -> bool {
  let route = window
    .try_state::<PendingOpens>()
    .map_or(Route::Deliver, |pending| {
      pending.route(window.label(), path)
    });
  if route == Route::Queued {
    return true;
  }
  if window
    .emit_to(window.label(), "open-file-here", path)
    .is_err()
  {
    return false;
  }
  crate::windows::reveal(window);
  true
}
/// Hand the converted document of handoff `handoff_id` to document window
/// `window`, as `open_in_window` does a path: a ready window gets the
/// `open-converted` event (payload `{ handoff_id }`) and is raised; one still
/// loading has it queued. False only when the event could not be sent.
pub fn open_converted_in_window(window: &tauri::WebviewWindow, handoff_id: u64) -> bool {
  let route = window
    .try_state::<PendingOpens>()
    .map_or(Route::Deliver, |pending| {
      pending.route_handoff(window.label(), handoff_id)
    });
  if route == Route::Queued {
    return true;
  }
  if window
    .emit_to(
      window.label(),
      "open-converted",
      serde_json::json!({ "handoff_id": handoff_id }),
    )
    .is_err()
  {
    return false;
  }
  crate::windows::reveal(window);
  true
}
/// What a window that went away never received, as the paths to open elsewhere
/// and the handoffs to give back: a converted document is never opened as a path.
pub fn split_released(items: Vec<Pending>) -> (Vec<String>, Vec<u64>) {
  let (mut paths, mut handoffs) = (Vec::new(), Vec::new());
  for item in items {
    match item {
      Pending::Path(path) => paths.push(path),
      Pending::Handoff(id) => handoffs.push(id),
    }
  }
  (paths, handoffs)
}
/// The window announced itself: hand over what was queued for it, paths as
/// `{ kind: 'path', value: <path> }` and converted documents as
/// `{ kind: 'handoff', value: <handoff id> }`.
#[tauri::command]
pub fn doc_window_ready(app: tauri::AppHandle, label: String) -> Vec<Pending> {
  app.state::<PendingOpens>().mark_ready(&label)
}
/// The document window a file joins as a tab when the open target is "tab":
/// the window the user was in most recently, else the last window the startup
/// restore created (`restored` is in restore order).
pub fn choose_tab_target(explicit: Option<&str>, restored: &[String]) -> Option<String> {
  explicit
    .map(str::to_string)
    .or_else(|| restored.last().cloned())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn paths(items: &[&str]) -> Vec<Pending> {
    items.iter().map(|p| Pending::Path(p.to_string())).collect()
  }
  fn strings(items: Vec<Pending>) -> Vec<String> {
    items
      .into_iter()
      .map(|item| match item {
        Pending::Path(path) => path,
        other => panic!("{other:?}"),
      })
      .collect()
  }

  #[test]
  fn a_path_queued_before_ready_is_drained_once() {
    let pending = PendingOpens::default();
    assert_eq!(pending.route("doc-a", "one.txt"), Route::Queued);
    assert_eq!(pending.route("doc-a", "two.txt"), Route::Queued);
    assert_eq!(pending.mark_ready("doc-a"), paths(&["one.txt", "two.txt"]));
    assert!(pending.mark_ready("doc-a").is_empty());
  }

  #[test]
  fn a_path_after_ready_is_delivered_directly_and_never_queued() {
    let pending = PendingOpens::default();
    assert!(pending.mark_ready("doc-a").is_empty());
    assert_eq!(pending.route("doc-a", "one.txt"), Route::Deliver);
    assert!(pending.mark_ready("doc-a").is_empty());
  }

  #[test]
  fn every_path_is_drained_or_delivered_exactly_once_in_both_orders() {
    let pending = PendingOpens::default();
    let mut ready = false;
    let mut seen = Vec::new();
    for path in ["p1", "p2", "p3", "p4"] {
      if path == "p3" {
        seen.extend(strings(pending.mark_ready("doc-a")));
        ready = true;
      }
      let route = pending.route("doc-a", path);
      assert_eq!(route == Route::Deliver, ready, "{path} routed before ready");
      if route == Route::Deliver {
        seen.push(path.to_string());
      }
    }
    seen.extend(strings(pending.mark_ready("doc-a")));
    assert_eq!(seen, vec!["p1", "p2", "p3", "p4"]);
  }

  #[test]
  fn labels_are_independent() {
    let pending = PendingOpens::default();
    assert_eq!(pending.route("doc-a", "one.txt"), Route::Queued);
    assert!(pending.mark_ready("doc-b").is_empty());
    assert_eq!(pending.route("doc-b", "two.txt"), Route::Deliver);
    assert_eq!(pending.mark_ready("doc-a"), paths(&["one.txt"]));
  }

  #[test]
  fn destroying_a_not_ready_label_returns_its_paths_once() {
    let pending = PendingOpens::default();
    pending.route("doc-a", "one.txt");
    pending.route("doc-a", "two.txt");
    assert_eq!(pending.forget("doc-a"), paths(&["one.txt", "two.txt"]));
    assert!(pending.forget("doc-a").is_empty());
    assert!(pending.mark_ready("doc-a").is_empty());
  }

  #[test]
  fn destroying_a_ready_label_clears_the_flag() {
    let pending = PendingOpens::default();
    pending.mark_ready("doc-a");
    assert!(pending.forget("doc-a").is_empty());
    assert_eq!(pending.route("doc-a", "one.txt"), Route::Queued);
  }

  #[test]
  fn concurrent_routing_and_ready_lose_and_duplicate_nothing() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let pending = std::sync::Arc::new(PendingOpens::default());
    let routed = std::sync::Arc::new(AtomicUsize::new(0));
    let ready_started = std::sync::Arc::new(AtomicBool::new(false));
    let router = {
      let (pending, routed, ready_started) =
        (pending.clone(), routed.clone(), ready_started.clone());
      std::thread::spawn(move || {
        let mut delivered = Vec::new();
        for i in 0..200 {
          let path = format!("p{i}");
          if pending.route("doc-a", &path) == Route::Deliver {
            // The flag is set before `mark_ready` runs, and a Deliver needs it.
            assert!(
              ready_started.load(Ordering::SeqCst),
              "{path} delivered before the window was ready"
            );
            delivered.push(path);
          }
          routed.fetch_add(1, Ordering::SeqCst);
        }
        delivered
      })
    };
    while routed.load(Ordering::SeqCst) < 50 && !router.is_finished() {
      std::thread::yield_now();
    }
    ready_started.store(true, Ordering::SeqCst);
    let drained = pending.mark_ready("doc-a");
    let delivered = router.join().unwrap();
    let mut all: Vec<String> = drained
      .into_iter()
      .map(|item| match item {
        Pending::Path(path) => path,
        other => panic!("{other:?}"),
      })
      .chain(delivered)
      .collect();
    all.sort_by_key(|p| p[1..].parse::<u32>().unwrap());
    let expected: Vec<String> = (0..200).map(|i| format!("p{i}")).collect();
    assert_eq!(all, expected);
  }

  fn labels(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn no_restored_window_and_no_explicit_target_means_none() {
    assert_eq!(choose_tab_target(None, &[]), None);
  }

  #[test]
  fn one_restored_window_is_the_target() {
    assert_eq!(
      choose_tab_target(None, &labels(&["doc-a"])),
      Some("doc-a".to_string())
    );
  }

  #[test]
  fn the_last_restored_window_is_the_target() {
    assert_eq!(
      choose_tab_target(None, &labels(&["doc-a", "doc-b", "doc-c"])),
      Some("doc-c".to_string())
    );
  }

  #[test]
  fn an_explicit_target_wins_over_the_restored_windows() {
    assert_eq!(
      choose_tab_target(Some("doc-x"), &labels(&["doc-a", "doc-b"])),
      Some("doc-x".to_string())
    );
  }

  #[test]
  fn a_handoff_waits_in_the_queue_in_the_order_it_came() {
    let pending = PendingOpens::default();
    pending.route("doc-a", "one.txt");
    assert_eq!(pending.route_handoff("doc-a", 7), Route::Queued);
    pending.route("doc-a", "two.txt");
    assert_eq!(
      pending.mark_ready("doc-a"),
      vec![
        Pending::Path("one.txt".to_string()),
        Pending::Handoff(7),
        Pending::Path("two.txt".to_string()),
      ]
    );
    assert_eq!(pending.route_handoff("doc-a", 8), Route::Deliver);
  }

  #[test]
  fn a_window_closed_before_ready_gives_its_handoffs_back_not_as_paths() {
    let pending = PendingOpens::default();
    pending.route("doc-a", "one.txt");
    pending.route_handoff("doc-a", 7);
    pending.route_handoff("doc-a", 9);
    let (paths, handoffs) = split_released(pending.forget("doc-a"));
    assert_eq!(paths, vec!["one.txt"]);
    assert_eq!(handoffs, vec![7, 9]);
    assert_eq!(split_released(pending.forget("doc-a")), (vec![], vec![]));
  }

  #[test]
  fn the_queue_is_sent_as_kind_and_value() {
    let items = vec![Pending::Path("a.txt".to_string()), Pending::Handoff(3)];
    assert_eq!(
      serde_json::to_string(&items).unwrap(),
      r#"[{"kind":"path","value":"a.txt"},{"kind":"handoff","value":3}]"#
    );
  }
}
