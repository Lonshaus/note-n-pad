// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Files routed into an existing document window as tabs. A window that is still
// loading has no `open-file-here` listener and `emit_to` succeeds without one,
// so paths for a window that has not announced itself are queued here and
// handed over when it does.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
/// One guard covers the queue and the ready set, so a path is either queued
/// before the window's drain or delivered directly after it, never both or
/// neither.
#[derive(Default)]
struct Inner {
  queued: HashMap<String, Vec<String>>,
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
    let mut inner = self.inner.lock().unwrap();
    if inner.ready.contains(label) {
      Route::Deliver
    } else {
      inner
        .queued
        .entry(label.to_string())
        .or_default()
        .push(path.to_string());
      Route::Queued
    }
  }
  /// Mark `label` ready and take its queued paths, in arrival order.
  pub fn mark_ready(&self, label: &str) -> Vec<String> {
    let mut inner = self.inner.lock().unwrap();
    inner.ready.insert(label.to_string());
    inner.queued.remove(label).unwrap_or_default()
  }
  /// Forget a destroyed window and return the paths it never received.
  pub fn forget(&self, label: &str) -> Vec<String> {
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
/// The window announced itself: hand over what was queued for it.
#[tauri::command]
pub fn doc_window_ready(app: tauri::AppHandle, label: String) -> Vec<String> {
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

  #[test]
  fn a_path_queued_before_ready_is_drained_once() {
    let pending = PendingOpens::default();
    assert_eq!(pending.route("doc-a", "one.txt"), Route::Queued);
    assert_eq!(pending.route("doc-a", "two.txt"), Route::Queued);
    assert_eq!(pending.mark_ready("doc-a"), vec!["one.txt", "two.txt"]);
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
        seen.extend(pending.mark_ready("doc-a"));
        ready = true;
      }
      let route = pending.route("doc-a", path);
      assert_eq!(route == Route::Deliver, ready, "{path} routed before ready");
      if route == Route::Deliver {
        seen.push(path.to_string());
      }
    }
    seen.extend(pending.mark_ready("doc-a"));
    assert_eq!(seen, vec!["p1", "p2", "p3", "p4"]);
  }

  #[test]
  fn labels_are_independent() {
    let pending = PendingOpens::default();
    assert_eq!(pending.route("doc-a", "one.txt"), Route::Queued);
    assert!(pending.mark_ready("doc-b").is_empty());
    assert_eq!(pending.route("doc-b", "two.txt"), Route::Deliver);
    assert_eq!(pending.mark_ready("doc-a"), vec!["one.txt"]);
  }

  #[test]
  fn destroying_a_not_ready_label_returns_its_paths_once() {
    let pending = PendingOpens::default();
    pending.route("doc-a", "one.txt");
    pending.route("doc-a", "two.txt");
    assert_eq!(pending.forget("doc-a"), vec!["one.txt", "two.txt"]);
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
    let mut all: Vec<String> = drained.into_iter().chain(delivered).collect();
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
}
