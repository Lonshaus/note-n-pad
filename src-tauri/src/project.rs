// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::note_store::NoteStore;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};
/// One node of the project tree. `children` is always `None`: the tree is read
/// one folder at a time, so a folder's entries come from its own listing.
/// `volume` names the disk the entry itself is on (a link reports its own, not
/// the one it points to); when that cannot be read it is `None` and
/// `volume_error` says why. A folder also carries `target_volume`, the disk it
/// leads to: a disk mounted on it, or the folder a link points to.
#[derive(Debug, Serialize, PartialEq)]
pub struct TreeEntry {
  pub name: String,
  pub path: String,
  pub is_dir: bool,
  pub children: Option<Vec<TreeEntry>>,
  pub volume: Option<u64>,
  pub volume_error: Option<String>,
  pub target_volume: Option<u64>,
  pub target_volume_error: Option<String>,
}
/// Read one directory level. An unreadable entry is skipped.
fn read_level(dir: &Path) -> Result<Vec<TreeEntry>, String> {
  let read = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
  let mut entries = Vec::new();
  for entry in read.flatten() {
    let name = entry.file_name().to_string_lossy().to_string();
    // Skip dotfiles/dotfolders.
    if name.starts_with('.') {
      continue;
    }
    let path = entry.path();
    let volume = crate::transfer::source_volume_of(&path);
    let is_dir = path.is_dir();
    let target = is_dir.then(|| crate::transfer::volume_of(&path));
    entries.push(TreeEntry {
      name,
      is_dir,
      path: path.to_string_lossy().to_string(),
      children: None,
      volume: volume.as_ref().ok().copied(),
      volume_error: volume.err(),
      target_volume: target.as_ref().and_then(|t| t.as_ref().ok().copied()),
      target_volume_error: target.and_then(Result::err),
    });
  }
  // Directories first, then case-insensitive alphabetical.
  entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
    (true, false) => std::cmp::Ordering::Less,
    (false, true) => std::cmp::Ordering::Greater,
    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
  });
  Ok(entries)
}
/// List the entries directly inside `dir`, one level only. Errors when `dir` is
/// missing or is not a directory. Async so a slow volume never blocks the UI
/// thread.
#[tauri::command(async)]
pub fn list_project_dir(dir: String) -> Result<Vec<TreeEntry>, String> {
  let path = Path::new(&dir);
  if !path.is_dir() {
    return Err(format!("not a directory: {dir}"));
  }
  read_level(path)
}
/// A stored document tab, reduced to what the window choice looks at.
struct StoredTab<'a> {
  group: &'a str,
  file_path: Option<&'a str>,
  project: Option<&'a str>,
}
/// Which document window a tree-open goes to.
#[derive(Debug, PartialEq)]
enum OpenTarget {
  /// A live window already holding the file: switch to its tab.
  Holder(String),
  /// A live window bound to the project.
  Project(String),
  /// No such window: open a new one.
  Fresh,
}
/// Choose the window for opening `path` from project `root`. Only live windows
/// count: a stored group whose window is closed is skipped in both steps. A
/// window holding the file wins, so one file never opens in two windows; then a
/// window bound to the project.
fn choose_window(
  tabs: &[StoredTab],
  path: &str,
  root: &str,
  is_live: impl Fn(&str) -> bool,
) -> OpenTarget {
  if let Some(tab) = tabs
    .iter()
    .find(|t| t.file_path == Some(path) && is_live(t.group))
  {
    return OpenTarget::Holder(tab.group.to_string());
  }
  if let Some(tab) = tabs
    .iter()
    .find(|t| t.project == Some(root) && is_live(t.group))
  {
    return OpenTarget::Project(tab.group.to_string());
  }
  OpenTarget::Fresh
}
/// Open a file picked under a project `root` in the workspace tree. Tree-opens
/// are isolated per project: a live window already holding the file gets it
/// switched to, else the live window bound to `root` opens it as a tab, else a
/// fresh document window is opened tagged with the project so its tabs adopt it.
#[tauri::command(async)]
pub fn open_project_file(
  app: AppHandle,
  store: State<NoteStore>,
  path: String,
  root: String,
) -> Result<(), String> {
  let notes = store.list();
  let tabs: Vec<StoredTab> = notes
    .iter()
    .filter(|n| n.kind == "document")
    .map(|n| StoredTab {
      group: crate::note_store::resolved_group(n),
      file_path: n.file_path.as_deref(),
      project: n.project.as_deref(),
    })
    .collect();
  let window_of = |group: &str| app.get_webview_window(&format!("doc-{group}"));
  let target = choose_window(&tabs, &path, &root, |group| window_of(group).is_some());
  if let OpenTarget::Holder(group) | OpenTarget::Project(group) = target {
    if let Some(win) = window_of(&group) {
      let _ = crate::pending_opens::open_in_window(&win, &path);
      return Ok(());
    }
  }
  crate::windows::open_document(&app, &path, Some(&root))
}
/// These folders are projects of their own again (just added, or kept at
/// startup): any rebind that folded one into another project is forgotten, so
/// writes still tagged with it stay on it.
#[tauri::command(async)]
pub fn forget_project_rebinds(store: State<NoteStore>, roots: Vec<String>) {
  for root in &roots {
    store.forget_rebind(root);
  }
}
#[derive(Clone, Serialize)]
struct ProjectRebound {
  from: String,
  to: String,
}
/// Move every stored document tab of project `from` to project `to` (the folder
/// `from` now lives under), then tell the open windows so they re-tag their next
/// snapshots. Called when a project is merged into the one above it.
#[tauri::command(async)]
pub fn rebind_project(
  app: AppHandle,
  store: State<NoteStore>,
  from: String,
  to: String,
) -> Result<(), String> {
  store.rebind_project(&from, &to)?;
  crate::note_store::emit_store_changed(&app, None);
  let _ = app.emit("project-rebound", ProjectRebound { from, to });
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use tempfile::tempdir;

  fn names(entries: &[TreeEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.name.as_str()).collect()
  }

  fn list(dir: &Path) -> Vec<TreeEntry> {
    list_project_dir(dir.to_string_lossy().to_string()).unwrap()
  }

  #[test]
  fn lists_one_level_and_never_loads_children() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("a/b/c")).unwrap();
    fs::write(dir.path().join("a/b/c/deep.txt"), "x").unwrap();
    fs::write(dir.path().join("a/mid.txt"), "x").unwrap();
    fs::write(dir.path().join("top.txt"), "x").unwrap();
    let top = list(dir.path());
    assert_eq!(names(&top), vec!["a", "top.txt"]);
    assert!(top[0].is_dir && !top[1].is_dir);
    assert!(top.iter().all(|e| e.children.is_none()));
    let a = list(&dir.path().join("a"));
    assert_eq!(names(&a), vec!["b", "mid.txt"]);
    assert_eq!(
      a[1].path,
      dir
        .path()
        .join("a")
        .join("mid.txt")
        .to_string_lossy()
        .to_string()
    );
    assert!(a.iter().all(|e| e.children.is_none()));
  }

  #[cfg(unix)]
  #[test]
  fn children_of_the_filesystem_root_are_named_slash_name() {
    let top = list(Path::new("/"));
    assert!(!top.is_empty());
    assert!(top.iter().all(|e| e.path == format!("/{}", e.name)));
  }

  #[test]
  fn hidden_entries_are_filtered() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join(".secret"), "x").unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join("visible.txt"), "x").unwrap();
    assert_eq!(names(&list(root)), vec!["visible.txt"]);
  }

  #[test]
  fn dirs_before_files_then_case_insensitive_alpha() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("Zebra.txt"), "x").unwrap();
    fs::write(root.join("apple.txt"), "x").unwrap();
    fs::create_dir(root.join("src")).unwrap();
    fs::create_dir(root.join("Docs")).unwrap();
    assert_eq!(
      names(&list(root)),
      vec!["Docs", "src", "apple.txt", "Zebra.txt"]
    );
  }

  #[test]
  fn entries_carry_the_disk_they_are_on() {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("a")).unwrap();
    fs::write(dir.path().join("f.txt"), "x").unwrap();
    let here = crate::transfer::volume_of(dir.path()).unwrap();
    let top = list(dir.path());
    assert_eq!(top.len(), 2);
    assert!(top
      .iter()
      .all(|e| e.volume == Some(here) && e.volume_error.is_none()));
    // Only a folder can be dropped into, so only a folder has a disk it leads to.
    assert_eq!(top[0].target_volume, Some(here));
    assert_eq!(top[1].target_volume, None);
    assert!(top.iter().all(|e| e.target_volume_error.is_none()));
  }
  /// A folder that lives on another disk than a temp folder, if this machine
  /// has one reachable.
  #[cfg(unix)]
  fn other_disk(here: u64) -> Option<&'static Path> {
    ["/dev", "/proc", "/sys"]
      .into_iter()
      .map(Path::new)
      .find(|p| p.is_dir() && crate::transfer::volume_of(p).is_ok_and(|v| v != here))
  }

  #[cfg(unix)]
  #[test]
  fn a_link_is_on_its_own_disk_and_leads_to_the_one_it_points_to() {
    let dir = tempdir().unwrap();
    let here = crate::transfer::volume_of(dir.path()).unwrap();
    let Some(elsewhere) = other_disk(here) else {
      return;
    };
    std::os::unix::fs::symlink(elsewhere, dir.path().join("portal")).unwrap();
    let top = list(dir.path());
    assert_eq!(top.len(), 1);
    assert!(top[0].is_dir);
    assert_eq!(top[0].volume, Some(here));
    assert_eq!(
      top[0].target_volume,
      Some(crate::transfer::volume_of(elsewhere).unwrap())
    );
    assert_ne!(top[0].target_volume, top[0].volume);
  }

  #[cfg(unix)]
  #[test]
  fn a_dangling_link_still_has_a_disk_of_its_own() {
    let dir = tempdir().unwrap();
    std::os::unix::fs::symlink(dir.path().join("nowhere"), dir.path().join("dangling")).unwrap();
    let top = list(dir.path());
    assert_eq!(top.len(), 1);
    assert!(!top[0].is_dir);
    assert_eq!(
      top[0].volume,
      Some(crate::transfer::volume_of(dir.path()).unwrap())
    );
    assert_eq!(top[0].volume_error, None);
    assert_eq!(top[0].target_volume, None);
  }

  #[test]
  fn missing_dir_errors() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");
    assert!(list_project_dir(missing.to_string_lossy().to_string()).is_err());
  }

  #[test]
  fn file_as_dir_errors() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("file.txt");
    fs::write(&file, "x").unwrap();
    assert!(list_project_dir(file.to_string_lossy().to_string()).is_err());
  }

  fn tab<'a>(group: &'a str, file: Option<&'a str>, project: Option<&'a str>) -> StoredTab<'a> {
    StoredTab {
      group,
      file_path: file,
      project,
    }
  }

  #[test]
  fn window_holding_the_file_wins_over_the_project_window() {
    let tabs = [
      tab("proj", Some("/x/other.txt"), Some("/x")),
      tab("holder", Some("/x/y/a.txt"), Some("/x/y")),
    ];
    let target = choose_window(&tabs, "/x/y/a.txt", "/x", |_| true);
    assert_eq!(target, OpenTarget::Holder("holder".into()));
  }

  #[test]
  fn project_window_is_used_when_nothing_holds_the_file() {
    let tabs = [
      tab("elsewhere", Some("/z/a.txt"), Some("/z")),
      tab("proj", Some("/x/other.txt"), Some("/x")),
    ];
    let target = choose_window(&tabs, "/x/new.txt", "/x", |_| true);
    assert_eq!(target, OpenTarget::Project("proj".into()));
  }

  #[test]
  fn a_new_window_opens_when_no_live_window_matches() {
    let tabs = [tab("elsewhere", Some("/z/a.txt"), Some("/z"))];
    let target = choose_window(&tabs, "/x/new.txt", "/x", |_| true);
    assert_eq!(target, OpenTarget::Fresh);
    assert_eq!(
      choose_window(&[], "/x/new.txt", "/x", |_| true),
      OpenTarget::Fresh
    );
  }

  #[test]
  fn a_closed_group_listed_first_never_wins_over_a_live_one() {
    let tabs = [
      tab("closed", Some("/x/other.txt"), Some("/x")),
      tab("live", Some("/x/more.txt"), Some("/x")),
    ];
    let live = |group: &str| group == "live";
    let target = choose_window(&tabs, "/x/new.txt", "/x", live);
    assert_eq!(target, OpenTarget::Project("live".into()));
    // The same holds for the window holding the file.
    let tabs = [
      tab("closed", Some("/x/a.txt"), Some("/x")),
      tab("live", Some("/x/a.txt"), Some("/x")),
    ];
    let target = choose_window(&tabs, "/x/a.txt", "/x", live);
    assert_eq!(target, OpenTarget::Holder("live".into()));
  }

  #[test]
  fn only_closed_groups_open_a_new_window() {
    let tabs = [
      tab("closed", Some("/x/a.txt"), Some("/x")),
      tab("closed2", Some("/x/b.txt"), Some("/x")),
    ];
    assert_eq!(
      choose_window(&tabs, "/x/a.txt", "/x", |_| false),
      OpenTarget::Fresh
    );
  }
}

#[cfg(test)]
mod window_command_threading_tests {
  const SOURCE: &str = include_str!("project.rs");

  fn assert_async(function: &str) {
    let at = SOURCE
      .find(&format!("pub fn {function}("))
      .unwrap_or_else(|| panic!("{function}"));
    let attribute = SOURCE[..at].trim_end();
    assert!(
      attribute.ends_with("#[tauri::command(async)]"),
      "{function} must be #[tauri::command(async)]"
    );
  }

  #[test]
  fn open_project_file_is_async() {
    // A blocking command that builds a window deadlocks the Windows UI thread.
    assert_async("open_project_file");
  }

  #[test]
  fn list_project_dir_is_async() {
    // A synchronous command reads the folder on the main thread.
    assert_async("list_project_dir");
  }

  #[test]
  fn forget_project_rebinds_is_async() {
    // Same worker-thread rule as the other project commands.
    assert_async("forget_project_rebinds");
  }

  #[test]
  fn rebind_project_is_async() {
    // It rewrites snapshot files, which a worker thread should do.
    assert_async("rebind_project");
  }
}
