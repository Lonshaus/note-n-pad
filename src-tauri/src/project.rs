// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::note_store::NoteStore;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

/// One node of the project tree. `children` is populated only for directories
/// whose path was in the expanded set; every other directory carries `None`.
#[derive(Debug, Serialize, PartialEq)]
pub struct TreeEntry {
  pub name: String,
  pub path: String,
  pub is_dir: bool,
  pub children: Option<Vec<TreeEntry>>,
}

/// Read one directory level. A child directory is read too (recursively) when
/// its path string is in `expanded`; otherwise it carries `None` children. An
/// unreadable directory yields an empty list instead of failing the whole tree.
fn read_level(dir: &Path, expanded: &HashSet<&str>) -> Vec<TreeEntry> {
  let mut entries = Vec::new();
  let Ok(read) = std::fs::read_dir(dir) else {
    return entries;
  };
  for entry in read.flatten() {
    let name = entry.file_name().to_string_lossy().to_string();
    // Skip dotfiles/dotfolders.
    if name.starts_with('.') {
      continue;
    }
    let path = entry.path();
    let is_dir = path.is_dir();
    let path_str = path.to_string_lossy().to_string();
    let children = if is_dir && expanded.contains(path_str.as_str()) {
      Some(read_level(&path, expanded))
    } else {
      None
    };
    entries.push(TreeEntry {
      name,
      path: path_str,
      is_dir,
      children,
    });
  }
  // Directories first, then case-insensitive alphabetical.
  entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
    (true, false) => std::cmp::Ordering::Less,
    (false, true) => std::cmp::Ordering::Greater,
    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
  });
  entries
}

/// List `root` and every directory below it whose path is in `expanded`. Errors
/// when `root` is missing or is not a directory.
#[tauri::command]
pub fn list_project_tree(root: String, expanded: Vec<String>) -> Result<Vec<TreeEntry>, String> {
  let path = Path::new(&root);
  if !path.is_dir() {
    return Err(format!("not a directory: {root}"));
  }
  let expanded: HashSet<&str> = expanded.iter().map(String::as_str).collect();
  Ok(read_level(path, &expanded))
}

/// Open a file picked under a project `root` in the workspace tree. Tree-opens
/// are isolated per project: route to the open document window whose tabs belong
/// to `root` (found via the note store), else open a fresh document window tagged
/// with the project so its tabs adopt it.
#[tauri::command(async)]
pub fn open_project_file(
  app: AppHandle,
  store: State<NoteStore>,
  path: String,
  root: String,
) -> Result<(), String> {
  // A document window bound to this project has at least one stored tab whose
  // `project == root`; its group id names the window.
  let group = store.list().into_iter().find_map(|n| {
    if n.kind == "document" && n.project.as_deref() == Some(root.as_str()) {
      Some(n.window_group.unwrap_or(n.id))
    } else {
      None
    }
  });
  if let Some(group) = group {
    let label = format!("doc-{group}");
    if let Some(win) = app.get_webview_window(&label) {
      let _ = crate::pending_opens::open_in_window(&win, &path);
      return Ok(());
    }
  }
  // No window for this project yet: open a fresh one carrying the project root.
  crate::windows::open_document(&app, &path, Some(&root))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use tempfile::tempdir;

  fn names(entries: &[TreeEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.name.as_str()).collect()
  }

  fn list(root: &Path, expanded: &[&Path]) -> Vec<TreeEntry> {
    list_project_tree(
      root.to_string_lossy().to_string(),
      expanded
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect(),
    )
    .unwrap()
  }

  fn nested_root() -> tempfile::TempDir {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("a/b/c")).unwrap();
    fs::write(dir.path().join("a/b/c/deep.txt"), "x").unwrap();
    fs::write(dir.path().join("a/mid.txt"), "x").unwrap();
    dir
  }

  #[test]
  fn nothing_expanded_lists_root_entries_only() {
    let dir = nested_root();
    let tree = list(dir.path(), &[]);
    assert_eq!(names(&tree), vec!["a"]);
    assert!(tree[0].is_dir);
    assert_eq!(tree[0].children, None);
  }

  #[test]
  fn expanded_dir_loads_one_level() {
    let dir = nested_root();
    let a = dir.path().join("a");
    let tree = list(dir.path(), &[&a]);
    let a_children = tree[0].children.as_ref().unwrap();
    assert_eq!(names(a_children), vec!["b", "mid.txt"]);
    assert_eq!(a_children[0].children, None);
  }

  #[test]
  fn deeply_expanded_dirs_load_every_level() {
    let dir = nested_root();
    let a = dir.path().join("a");
    let b = a.join("b");
    let c = b.join("c");
    let tree = list(dir.path(), &[&a, &b, &c]);
    let a_children = tree[0].children.as_ref().unwrap();
    let b_children = a_children[0].children.as_ref().unwrap();
    let c_children = b_children[0].children.as_ref().unwrap();
    assert_eq!(names(c_children), vec!["deep.txt"]);
    assert_eq!(
      c_children[0].path,
      c.join("deep.txt").to_string_lossy().to_string()
    );
  }

  #[test]
  fn expanded_child_without_expanded_parent_stays_unloaded() {
    let dir = nested_root();
    let b = dir.path().join("a/b");
    let tree = list(dir.path(), &[&b]);
    assert_eq!(tree[0].children, None);
  }

  #[test]
  fn missing_expanded_path_is_ignored() {
    let dir = nested_root();
    let a = dir.path().join("a");
    let gone = dir.path().join("a/gone");
    let tree = list(dir.path(), &[&a, &gone]);
    let a_children = tree[0].children.as_ref().unwrap();
    assert_eq!(names(a_children), vec!["b", "mid.txt"]);
  }

  #[cfg(unix)]
  #[test]
  fn unreadable_expanded_dir_yields_empty_list_and_rest_loads() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("locked")).unwrap();
    fs::write(root.join("locked/x.txt"), "x").unwrap();
    fs::create_dir(root.join("open")).unwrap();
    fs::write(root.join("open/y.txt"), "x").unwrap();
    let locked = root.join("locked");
    let open = root.join("open");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let tree = list(root, &[&locked, &open]);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(names(&tree), vec!["locked", "open"]);
    // Running as root can read a mode-000 directory, so only the shape is fixed.
    if let Some(children) = tree[0].children.as_ref() {
      assert!(children.is_empty() || names(children) == vec!["x.txt"]);
    }
    assert_eq!(names(tree[1].children.as_ref().unwrap()), vec!["y.txt"]);
  }

  #[test]
  fn expanded_path_outside_root_is_ignored() {
    let dir = nested_root();
    let other = nested_root();
    let other_a = other.path().join("a");
    let tree = list(dir.path(), &[&other_a]);
    assert_eq!(tree[0].children, None);
  }

  #[test]
  fn expanded_matches_whole_path_not_prefix() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("Tools")).unwrap();
    fs::write(root.join("Tools/t.txt"), "x").unwrap();
    fs::create_dir(root.join("Tools2")).unwrap();
    fs::write(root.join("Tools2/u.txt"), "x").unwrap();
    let tools2 = root.join("Tools2");
    let tree = list(root, &[&tools2]);
    assert_eq!(names(&tree), vec!["Tools", "Tools2"]);
    assert_eq!(tree[0].children, None);
    assert_eq!(names(tree[1].children.as_ref().unwrap()), vec!["u.txt"]);
  }

  #[test]
  fn hidden_entries_are_filtered() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join(".secret"), "x").unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join("visible.txt"), "x").unwrap();
    let tree = list(root, &[]);
    assert_eq!(names(&tree), vec!["visible.txt"]);
  }

  #[test]
  fn dirs_before_files_then_case_insensitive_alpha() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("Zebra.txt"), "x").unwrap();
    fs::write(root.join("apple.txt"), "x").unwrap();
    fs::create_dir(root.join("src")).unwrap();
    fs::create_dir(root.join("Docs")).unwrap();
    let tree = list(root, &[]);
    assert_eq!(names(&tree), vec!["Docs", "src", "apple.txt", "Zebra.txt"]);
  }

  #[test]
  fn missing_root_errors() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");
    assert!(list_project_tree(missing.to_string_lossy().to_string(), vec![]).is_err());
  }

  #[test]
  fn file_as_root_errors() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("file.txt");
    fs::write(&file, "x").unwrap();
    assert!(list_project_tree(file.to_string_lossy().to_string(), vec![]).is_err());
  }
}

#[cfg(test)]
mod window_command_threading_tests {
  const SOURCE: &str = include_str!("project.rs");

  #[test]
  fn open_project_file_is_async() {
    let at = SOURCE
      .find("pub fn open_project_file")
      .expect("open_project_file");
    let attribute = SOURCE[..at].trim_end();
    assert!(
      attribute.ends_with("#[tauri::command(async)]"),
      "open_project_file must be #[tauri::command(async)]: a blocking command that \
       builds a window deadlocks the Windows UI thread"
    );
  }
}
