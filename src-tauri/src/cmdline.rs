// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The Windows Jump List (`jumplist.rs`) cannot focus an in-process window
// directly — every entry is a shell link that relaunches the executable with
// arguments. This module defines that small argument protocol as one pure,
// platform-independent parser, so it is unit-testable on any OS and the
// single-instance handler in `lib.rs` can route a recognized launch without
// re-parsing logic living inside Windows-only code.

use std::path::{Component, Path, MAIN_SEPARATOR_STR};
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

/// What the Lite edition does with a parsed launch: `--workspace` is ignored,
/// everything else goes through.
// Called on Windows/Linux; compiled (and tested) on every platform.
#[allow(dead_code)]
pub fn for_edition(action: Action, lite: bool) -> Action {
  match action {
    Action::Workspace if !crate::edition::workspace_enabled(lite) => Action::None,
    other => other,
  }
}
/// `path` made absolute, a relative one taken from `cwd`. Works on the text
/// alone: a missing file still resolves and links are not followed. A path that
/// cannot be placed under `cwd` comes back byte for byte.
// Assembled as text: `PathBuf::push` reads a segment like `a:b` as a Windows
// drive and discards everything before it.
// Called on Windows/Linux; compiled (and tested) on every platform.
#[allow(dead_code)]
pub fn absolute_from(path: &str, cwd: &Path) -> String {
  let target = Path::new(path);
  if cwd.to_str().is_none()
    || !cwd.is_absolute()
    || target.is_absolute()
    || names_server_or_device(path)
  {
    return path.to_string();
  }
  // `C:foo` hangs off that drive's own working directory; only `cwd`'s is known.
  if let Some(Component::Prefix(drive)) = target.components().next() {
    let same_drive = cwd
      .components()
      .next()
      .is_some_and(|first| first.as_os_str().eq_ignore_ascii_case(drive.as_os_str()));
    if !same_drive {
      return path.to_string();
    }
  }
  let mut head = String::new();
  let mut segments = Vec::new();
  for part in cwd.components() {
    match part {
      Component::Prefix(_) | Component::RootDir => {
        head.push_str(&part.as_os_str().to_string_lossy());
      }
      other => apply_component(&mut segments, other),
    }
  }
  // Only `\foo` gets here with a root: the top of `cwd`'s drive.
  if target.has_root() {
    segments.clear();
  }
  for part in target.components() {
    apply_component(&mut segments, part);
  }
  head + &segments.join(MAIN_SEPARATOR_STR)
}
/// Windows forms that `is_absolute` calls relative but that never hang off a
/// folder: `\\server`, `\\.`, `\??\C:\foo`. On Unix these are file names.
fn names_server_or_device(path: &str) -> bool {
  if !cfg!(windows) {
    return false;
  }
  let mut start = path.chars().map(|c| c == '\\' || c == '/');
  (start.next() == Some(true) && start.next() == Some(true)) || path.starts_with(r"\??\")
}
/// Add one path component to `segments`; `..` at the root stays at the root.
fn apply_component(segments: &mut Vec<String>, part: Component) {
  match part {
    Component::ParentDir => {
      segments.pop();
    }
    Component::Normal(name) => segments.push(name.to_string_lossy().into_owned()),
    Component::Prefix(_) | Component::RootDir | Component::CurDir => {}
  }
}
/// `action` with every file it opens made absolute; any other action as it came.
// Called on Windows/Linux; compiled (and tested) on every platform.
#[allow(dead_code)]
pub fn absolute_files(action: Action, cwd: &Path) -> Action {
  match action {
    Action::OpenFiles(paths) => {
      Action::OpenFiles(paths.iter().map(|path| absolute_from(path, cwd)).collect())
    }
    other => other,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::{PathBuf, MAIN_SEPARATOR as SEP};

  #[test]
  fn lite_ignores_the_workspace_flag_only() {
    assert_eq!(for_edition(Action::Workspace, true), Action::None);
    assert_eq!(for_edition(Action::Workspace, false), Action::Workspace);
    assert_eq!(for_edition(Action::NewSticky, true), Action::NewSticky);
    assert_eq!(
      for_edition(Action::Doc("g".into(), 1), true),
      Action::Doc("g".into(), 1)
    );
  }

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
  /// An absolute working directory below the temp folder, and the same as text.
  fn work() -> (PathBuf, String) {
    let cwd = std::env::temp_dir().join("np-base").join("work");
    let text = cwd.to_str().unwrap().to_string();
    (cwd, text)
  }

  #[test]
  fn relative_paths_resolve_against_the_working_directory() {
    let (cwd, text) = work();
    let parent = text.strip_suffix(&format!("{SEP}work")).unwrap();
    for (input, expected) in [
      ("foo.txt", format!("{text}{SEP}foo.txt")),
      ("sub/foo.txt", format!("{text}{SEP}sub{SEP}foo.txt")),
      ("./foo.txt", format!("{text}{SEP}foo.txt")),
      ("../foo.txt", format!("{parent}{SEP}foo.txt")),
      ("a/../b/./c.txt", format!("{text}{SEP}b{SEP}c.txt")),
      ("./../foo.txt", format!("{parent}{SEP}foo.txt")),
    ] {
      assert_eq!(absolute_from(input, &cwd), expected, "{input}");
    }
  }

  #[test]
  fn going_up_past_the_root_stops_at_the_root() {
    let (cwd, _) = work();
    let root = cwd.ancestors().last().unwrap().to_str().unwrap();
    let ups = "../".repeat(cwd.components().count() + 2);
    assert_eq!(
      absolute_from(&format!("{ups}foo.txt"), &cwd),
      format!("{root}foo.txt")
    );
  }

  #[test]
  fn an_absolute_path_comes_back_unchanged() {
    let (cwd, text) = work();
    for input in [
      format!("{text}{SEP}foo.txt"),
      format!("{text}{SEP}a{SEP}..{SEP}b.txt"),
      format!("{text}{SEP}.{SEP}b.txt"),
    ] {
      assert_eq!(absolute_from(&input, &cwd), input);
    }
  }

  #[test]
  fn a_working_directory_that_is_not_absolute_leaves_the_path_unchanged() {
    for cwd in ["", ".", "rel/dir"] {
      for input in ["./foo.txt", "a/../b.txt"] {
        assert_eq!(absolute_from(input, Path::new(cwd)), input, "cwd {cwd:?}");
      }
    }
  }

  #[test]
  fn spaces_and_non_ascii_survive() {
    let (cwd, text) = work();
    let cwd = cwd.join("空 白");
    assert_eq!(
      absolute_from("my notes/メモ 1.txt", &cwd),
      format!("{text}{SEP}空 白{SEP}my notes{SEP}メモ 1.txt")
    );
  }

  #[test]
  fn a_missing_file_still_resolves_and_nothing_is_created() {
    let dir = tempfile::tempdir().unwrap();
    let text = dir.path().to_str().unwrap();
    assert_eq!(
      absolute_from("missing/foo.txt", dir.path()),
      format!("{text}{SEP}missing{SEP}foo.txt")
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
  }

  #[cfg(unix)]
  #[test]
  fn a_working_directory_that_is_not_unicode_leaves_the_path_unchanged() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let cwd = Path::new(OsStr::from_bytes(b"/tmp/\xFF"));
    assert!(cwd.is_absolute());
    assert_eq!(absolute_from("./foo.txt", cwd), "./foo.txt");
  }

  #[cfg(unix)]
  #[test]
  fn windows_shapes_are_ordinary_names_on_unix() {
    let cwd = Path::new("/tmp/work");
    for (input, expected) in [
      ("sub/a:b.txt", "/tmp/work/sub/a:b.txt"),
      ("C:foo.txt", "/tmp/work/C:foo.txt"),
      (r"\\server", r"/tmp/work/\\server"),
      (r"\??\C:\foo.txt", r"/tmp/work/\??\C:\foo.txt"),
    ] {
      assert_eq!(absolute_from(input, cwd), expected);
    }
  }

  #[cfg(windows)]
  #[test]
  fn windows_absolute_and_server_or_device_forms_come_back_unchanged() {
    let cwd = Path::new(r"C:\x");
    for input in [
      r"C:\x\foo.txt",
      r"\\server\share\foo.txt",
      r"\\?\C:\foo.txt",
      r"\\server",
      r"\\server\",
      r"\\.",
      r"\\?",
      "//server",
      r"\/server",
      r"\??\C:\foo.txt",
    ] {
      assert_eq!(absolute_from(input, cwd), input);
    }
  }

  #[cfg(windows)]
  #[test]
  fn windows_paths_resolve_against_the_working_directory() {
    for (cwd, input, expected) in [
      (r"C:\x\y", r"\foo.txt", r"C:\foo.txt"),
      (r"C:\x\y", r"..\foo.txt", r"C:\x\foo.txt"),
      (r"C:\x", "sub/foo.txt", r"C:\x\sub\foo.txt"),
      (
        r"\\srv\share\dir",
        r"..\..\..\foo.txt",
        r"\\srv\share\foo.txt",
      ),
    ] {
      assert_eq!(absolute_from(input, Path::new(cwd)), expected, "{input}");
    }
  }

  #[cfg(windows)]
  #[test]
  fn windows_drive_relative_paths_need_the_working_directorys_drive() {
    let cwd = Path::new(r"C:\x");
    assert_eq!(absolute_from("C:foo.txt", cwd), r"C:\x\foo.txt");
    assert_eq!(absolute_from("c:foo.txt", cwd), r"C:\x\foo.txt");
    assert_eq!(absolute_from("D:foo.txt", cwd), "D:foo.txt");
  }

  #[cfg(windows)]
  #[test]
  fn windows_segments_that_look_like_drives_stay_segments() {
    let cwd = Path::new(r"C:\x");
    for (input, expected) in [
      (r"sub\a:b.txt", r"C:\x\sub\a:b.txt"),
      (r"sub\C:\foo.txt", r"C:\x\sub\C:\foo.txt"),
      ("C:a:b", r"C:\x\a:b"),
    ] {
      assert_eq!(absolute_from(input, cwd), expected);
    }
  }

  #[test]
  fn absolute_files_resolves_every_path_in_order() {
    let (cwd, text) = work();
    let absolute = format!("{text}{SEP}c.txt");
    assert_eq!(
      absolute_files(
        Action::OpenFiles(vec!["b.txt".into(), "./a.txt".into(), absolute.clone()]),
        &cwd
      ),
      Action::OpenFiles(vec![
        format!("{text}{SEP}b.txt"),
        format!("{text}{SEP}a.txt"),
        absolute
      ])
    );
  }

  #[test]
  fn absolute_files_leaves_every_other_action_alone() {
    let (cwd, _) = work();
    for action in [
      Action::NewSticky,
      Action::Workspace,
      Action::Note("./n".into()),
      Action::Doc("./g".into(), 1),
      Action::None,
    ] {
      assert_eq!(absolute_files(action.clone(), &cwd), action);
    }
  }
}
