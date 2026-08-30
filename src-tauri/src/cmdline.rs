// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The Windows Jump List (`jumplist.rs`) cannot focus an in-process window
// directly — every entry is a shell link that relaunches the executable with
// arguments. This module defines that small argument protocol as one pure,
// platform-independent parser, so it is unit-testable on any OS and the
// single-instance handler in `lib.rs` can route a recognized launch without
// re-parsing logic living inside Windows-only code.

/// A parsed command line, or `None` for anything not recognized (including a
/// plain double-launch with no flags), which falls back to the existing
/// "activate the running instance" behavior.
// Used on Windows/Linux at runtime (routing a second launch) and by tests on
// every platform.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
  NewSticky,
  Workspace,
  Note(String),
  Doc(String, i64),
  // File paths handed to the app by the shell: a double-click on an associated
  // file, "Open with", or a drop onto the executable. macOS never uses this —
  // it delivers those through the Opened event instead of the command line.
  OpenFiles(Vec<String>),
  None,
}

/// Parse `args` (as `std::env::args()` yields them, program path included as
/// the first element) into an `Action`. The first token starting with `--` is
/// taken as the flag; anything before it (the program path, always present in
/// practice) is ignored. Malformed operands (missing, empty, or a non-numeric
/// tab index) fall back to `Action::None` rather than partially acting.
///
/// Leading non-flag arguments are the shell handing over files to open. They
/// are taken before the flag scan, which skips non-flag tokens hunting for a
/// `--` and would otherwise swallow the paths. A flag-led command line falls
/// through untouched: `take_while` stops on the first `--`, leaving no files.
/// Empty strings are dropped so a stray quoted argument cannot become an
/// attempt to open "".
// Called on Windows/Linux; compiled (and tested) on every platform.
#[allow(dead_code)]
pub fn parse_args(args: &[String]) -> Action {
  let files: Vec<String> = args
    .iter()
    .skip(1)
    .take_while(|a| !a.starts_with("--"))
    .filter(|a| !a.is_empty())
    .cloned()
    .collect();
  if !files.is_empty() {
    return Action::OpenFiles(files);
  }
  let mut rest = args.iter().skip_while(|a| !a.starts_with("--"));
  match rest.next().map(String::as_str) {
    Some("--new-sticky") => Action::NewSticky,
    Some("--workspace") => Action::Workspace,
    Some("--note") => match rest.next() {
      Some(id) if !id.is_empty() => Action::Note(id.clone()),
      _ => Action::None,
    },
    Some("--doc") => match (rest.next(), rest.next()) {
      (Some(group), Some(idx)) if !group.is_empty() => idx
        .parse::<i64>()
        .map(|n| Action::Doc(group.clone(), n))
        .unwrap_or(Action::None),
      _ => Action::None,
    },
    _ => Action::None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn new_sticky_recognized() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--new-sticky"])),
      Action::NewSticky
    );
  }

  #[test]
  fn workspace_recognized() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--workspace"])),
      Action::Workspace
    );
  }

  #[test]
  fn note_recognized_with_id() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--note", "abc-123"])),
      Action::Note("abc-123".to_string())
    );
  }

  #[test]
  fn doc_recognized_with_group_and_tab_index() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--doc", "group-uuid", "3"])),
      Action::Doc("group-uuid".to_string(), 3)
    );
  }

  #[test]
  fn doc_accepts_negative_tab_index() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--doc", "group-uuid", "-1"])),
      Action::Doc("group-uuid".to_string(), -1)
    );
  }

  #[test]
  fn empty_argv_is_none() {
    assert_eq!(parse_args(&args(&[])), Action::None);
  }

  #[test]
  fn program_path_only_is_none() {
    assert_eq!(parse_args(&args(&["note-n-pad.exe"])), Action::None);
  }

  #[test]
  fn unknown_flag_is_none() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--bogus"])),
      Action::None
    );
  }

  #[test]
  fn note_missing_operand_is_none() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--note"])),
      Action::None
    );
  }

  #[test]
  fn note_empty_operand_is_none() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--note", ""])),
      Action::None
    );
  }

  #[test]
  fn doc_missing_tab_index_is_none() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--doc", "group-uuid"])),
      Action::None
    );
  }

  #[test]
  fn doc_garbage_tab_index_is_none() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--doc", "group-uuid", "nope"])),
      Action::None
    );
  }

  #[test]
  fn doc_empty_group_is_none() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--doc", "", "3"])),
      Action::None
    );
  }

  #[test]
  fn a_single_file_path_is_opened() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", r"C:\Users\me\notes.txt"])),
      Action::OpenFiles(vec![r"C:\Users\me\notes.txt".into()])
    );
  }

  #[test]
  fn several_file_paths_are_all_opened() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "/tmp/a.txt", "/tmp/b.log"])),
      Action::OpenFiles(vec!["/tmp/a.txt".into(), "/tmp/b.log".into()])
    );
  }

  #[test]
  fn a_path_containing_spaces_stays_one_operand() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", r"C:\Program Files\a b.txt"])),
      Action::OpenFiles(vec![r"C:\Program Files\a b.txt".into()])
    );
  }

  #[test]
  fn empty_operands_are_dropped() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "", "/tmp/a.txt", ""])),
      Action::OpenFiles(vec!["/tmp/a.txt".into()])
    );
  }

  #[test]
  fn only_empty_operands_is_none() {
    assert_eq!(parse_args(&args(&["note-n-pad.exe", "", ""])), Action::None);
  }

  #[test]
  fn a_bare_launch_is_still_none() {
    assert_eq!(parse_args(&args(&["note-n-pad.exe"])), Action::None);
  }

  // The flag protocol must keep winning when a flag leads, or a Jump List entry
  // would start being read as a file to open.
  #[test]
  fn a_leading_flag_still_beats_path_parsing() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "--workspace", "/tmp/a.txt"])),
      Action::Workspace
    );
  }

  #[test]
  fn paths_stop_at_a_trailing_flag() {
    assert_eq!(
      parse_args(&args(&["note-n-pad.exe", "/tmp/a.txt", "--new-sticky"])),
      Action::OpenFiles(vec!["/tmp/a.txt".into()])
    );
  }
}
