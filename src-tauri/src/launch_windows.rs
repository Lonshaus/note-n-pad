// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Document windows opened for the files a launch carried. Such a launch skips
// the fallback sticky, so a launch window that then collapses (the file is
// missing, unreadable, or its open prompt is cancelled) must bring it back or
// the app is left without a window.

use crate::cmdline::{parse_args, Action};
use std::collections::BTreeSet;
use std::sync::Mutex;
/// Whether the launch itself hands the app files to open. Every other launch
/// action (no arguments, Jump List tasks) keeps the fallback sticky.
// Called on Windows/Linux; compiled (and tested) on every platform.
#[allow(dead_code)]
pub fn launch_carries_files(action: &Action) -> bool {
  matches!(action, Action::OpenFiles(paths) if !paths.is_empty())
}
/// Whether the process command line hands the app files to open: what
/// `setup` asks on Windows and Linux.
// Called on Windows/Linux; compiled (and tested) on every platform.
#[allow(dead_code)]
pub fn launch_carries_files_in_argv(argv: &[String]) -> bool {
  launch_carries_files(&parse_args(argv))
}
/// Whether setup opens the fallback sticky: nothing was restored and the
/// launch carries no files.
pub fn fallback_needed_at_setup(restored: usize, launch_has_files: bool) -> bool {
  restored == 0 && !launch_has_files
}
/// Whether a collapsing document window leaves the fallback sticky behind: it
/// was a launch window and no other window remains.
pub fn collapse_needs_fallback(recorded: bool, other_windows: usize) -> bool {
  recorded && other_windows == 0
}

struct LaunchRecord {
  starting: bool,
  opened: usize,
  labels: BTreeSet<String>,
  last: Option<String>,
  focus_after_workspace: bool,
}

impl LaunchRecord {
  const fn new() -> Self {
    Self {
      starting: true,
      opened: 0,
      labels: BTreeSet::new(),
      last: None,
      focus_after_workspace: false,
    }
  }

  fn record_if_starting(&mut self, label: &str) {
    if self.starting {
      self.opened += 1;
      self.labels.insert(label.to_string());
      self.last = Some(label.to_string());
    }
  }
  /// A file went into a window that already existed: it is not at risk of
  /// collapsing, but it holds the launch's file, so it is where focus goes.
  fn record_routed_if_starting(&mut self, label: &str) {
    if self.starting {
      self.last = Some(label.to_string());
    }
  }

  fn focus_target(&mut self, consume: bool) -> Option<String> {
    if !self.focus_after_workspace {
      return None;
    }
    if consume {
      self.focus_after_workspace = false;
    }
    self.last.clone()
  }

  fn take(&mut self, label: &str) -> bool {
    self.labels.remove(label)
  }
}
/// A static, not managed state: macOS delivers the opened files before `setup`.
static RECORD: Mutex<LaunchRecord> = Mutex::new(LaunchRecord::new());
/// Remember a document window opened for a file while startup is still running.
pub fn record_if_starting(label: &str) {
  RECORD.lock().unwrap().record_if_starting(label);
}
/// Remember the existing window a launch's file was routed into (the
/// open-target "tab" setting) while startup is still running.
pub fn record_routed_if_starting(label: &str) {
  RECORD.lock().unwrap().record_routed_if_starting(label);
}
/// Whether any launch window was opened.
pub fn opened_any() -> bool {
  RECORD.lock().unwrap().opened > 0
}
/// Startup is over; later opens are not launch windows.
pub fn finish_startup() {
  RECORD.lock().unwrap().starting = false;
}
/// The startup workspace must not end up above the window of a file the app
/// was launched with: the workspace's reveal hands focus back to it once.
#[cfg(not(feature = "lite"))]
pub fn focus_launch_window_after_workspace() {
  RECORD.lock().unwrap().focus_after_workspace = true;
}
/// The launch window the workspace's reveal hands focus to. The workspace's own
/// reveal consumes it; the grace-timer show that may come first does not.
pub fn focus_target(consume: bool) -> Option<String> {
  RECORD.lock().unwrap().focus_target(consume)
}
/// Forget `label`; whether it was a recorded launch window.
pub fn take(label: &str) -> bool {
  RECORD.lock().unwrap().take(label)
}
/// A launch window loaded its file, so it is no longer at risk of collapsing.
#[tauri::command]
pub fn launch_window_loaded(label: String) {
  take(&label);
}

#[cfg(test)]
mod tests {
  use super::*;

  fn argv(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
  }

  fn setup_opens_fallback(restored: usize, args: &[&str]) -> bool {
    fallback_needed_at_setup(restored, launch_carries_files_in_argv(&argv(args)))
  }

  #[test]
  fn a_launch_with_files_skips_the_fallback_sticky() {
    assert!(!setup_opens_fallback(0, &["note-n-pad.exe", "a.txt"]));
    assert!(!setup_opens_fallback(
      0,
      &["note-n-pad.exe", "a.txt", "b.txt"]
    ));
  }

  #[test]
  fn the_command_line_decides_whether_the_launch_carries_files() {
    assert!(launch_carries_files_in_argv(&argv(&[
      "note-n-pad.exe",
      "a.txt"
    ])));
    assert!(!launch_carries_files_in_argv(&argv(&["note-n-pad.exe"])));
    assert!(!launch_carries_files_in_argv(&argv(&[
      "note-n-pad.exe",
      "--new-sticky"
    ])));
  }

  #[test]
  fn the_workspace_hands_focus_to_the_last_launch_window_once() {
    let mut record = LaunchRecord::new();
    record.record_if_starting("doc-1");
    record.record_if_starting("doc-2");
    assert_eq!(record.focus_target(true), None);
    record.focus_after_workspace = true;
    assert_eq!(record.focus_target(false).as_deref(), Some("doc-2"));
    assert_eq!(record.focus_target(true).as_deref(), Some("doc-2"));
    assert_eq!(record.focus_target(true), None);
  }

  #[test]
  fn a_file_routed_into_an_existing_window_is_where_focus_goes() {
    let mut record = LaunchRecord::new();
    record.focus_after_workspace = true;
    record.record_routed_if_starting("doc-restored");
    assert_eq!(record.focus_target(true).as_deref(), Some("doc-restored"));
    // The window was not opened for the file, so nothing can collapse.
    assert_eq!(record.opened, 0);
    assert!(!record.take("doc-restored"));
  }

  #[test]
  fn a_file_routed_after_startup_changes_nothing() {
    let mut record = LaunchRecord::new();
    record.record_if_starting("doc-new");
    record.starting = false;
    record.record_routed_if_starting("doc-restored");
    record.focus_after_workspace = true;
    assert_eq!(record.focus_target(true).as_deref(), Some("doc-new"));
  }

  #[test]
  fn a_launch_without_files_opens_the_fallback_sticky() {
    assert!(setup_opens_fallback(0, &["note-n-pad.exe"]));
  }

  #[test]
  fn a_non_file_launch_action_still_opens_the_fallback_sticky() {
    for args in [
      &["note-n-pad.exe", "--new-sticky"][..],
      &["note-n-pad.exe", "--workspace"],
      &["note-n-pad.exe", "--note", "abc"],
      &["note-n-pad.exe", "--doc", "group", "1"],
      &["note-n-pad.exe", "--unknown"],
    ] {
      assert!(setup_opens_fallback(0, args), "{args:?}");
    }
  }

  #[test]
  fn a_restored_window_never_needs_the_fallback_sticky() {
    assert!(!setup_opens_fallback(1, &["note-n-pad.exe"]));
    assert!(!setup_opens_fallback(
      2,
      &["note-n-pad.exe", "--new-sticky"]
    ));
  }

  #[test]
  fn a_collapsing_launch_window_with_nothing_else_opens_the_fallback_sticky() {
    assert!(collapse_needs_fallback(true, 0));
  }

  #[test]
  fn a_collapsing_launch_window_with_another_window_does_not() {
    assert!(!collapse_needs_fallback(true, 1));
  }

  #[test]
  fn a_collapsing_window_that_is_not_a_launch_window_does_not() {
    assert!(!collapse_needs_fallback(false, 0));
  }

  #[test]
  fn only_windows_opened_during_startup_are_recorded() {
    let mut record = LaunchRecord::new();
    record.record_if_starting("doc-a");
    record.starting = false;
    record.record_if_starting("doc-b");
    assert_eq!(record.opened, 1);
    assert!(record.take("doc-a"));
    assert!(!record.take("doc-b"));
  }

  #[test]
  fn a_launch_window_is_taken_once() {
    let mut record = LaunchRecord::new();
    record.record_if_starting("doc-a");
    assert!(record.take("doc-a"));
    assert!(!record.take("doc-a"));
    assert_eq!(record.opened, 1);
  }
}
