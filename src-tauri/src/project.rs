// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::note_store::NoteStore;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};

/// One node of the project tree. `children` is populated only for depth-1 dirs;
/// depth-2 dirs carry `None` (present but not expandable further).
#[derive(Debug, Serialize, PartialEq)]
pub struct TreeEntry {
  pub name: String,
  pub path: String,
  pub is_dir: bool,
  pub children: Option<Vec<TreeEntry>>,
}

/// Read one directory level. When `descend` is set, each child directory is read
/// one level deeper; otherwise directories carry `None` children. An unreadable
/// directory yields an empty list instead of failing the whole tree.
fn read_level(dir: &Path, descend: bool) -> Vec<TreeEntry> {
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
    let children = if is_dir && descend {
      Some(read_level(&path, false))
    } else {
      None
    };
    entries.push(TreeEntry {
      name,
      path: path.to_string_lossy().to_string(),
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

/// List `root` and one level below (total depth 2). Errors when `root` is missing
/// or is not a directory.
#[tauri::command]
pub fn list_project_tree(root: String) -> Result<Vec<TreeEntry>, String> {
  let path = Path::new(&root);
  if !path.is_dir() {
    return Err(format!("not a directory: {root}"));
  }
  Ok(read_level(path, true))
}

/// Open a file picked under a project `root` in the workspace tree. Tree-opens
/// are isolated per project: route to the open document window whose tabs belong
/// to `root` (found via the note store), else open a fresh document window tagged
/// with the project so its tabs adopt it.
#[tauri::command]
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
      crate::windows::reveal(&win);
      let _ = app.emit_to(label, "open-file-here", path);
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

  #[test]
  fn depth_limited_to_two_levels() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("a/b")).unwrap();
    fs::write(root.join("a/b/deep.txt"), "x").unwrap();
    fs::write(root.join("a/mid.txt"), "x").unwrap();
    let tree = list_project_tree(root.to_string_lossy().to_string()).unwrap();
    // Depth 1: only "a".
    assert_eq!(names(&tree), vec!["a"]);
    let a = &tree[0];
    let a_children = a.children.as_ref().unwrap();
    // Depth 2: "b" (dir, not expanded further) and "mid.txt".
    assert_eq!(names(a_children), vec!["b", "mid.txt"]);
    let b = &a_children[0];
    assert!(b.is_dir);
    // Level-3 content is absent: the depth-2 dir carries no children.
    assert_eq!(b.children, None);
  }

  #[test]
  fn hidden_entries_are_filtered() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join(".secret"), "x").unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join("visible.txt"), "x").unwrap();
    let tree = list_project_tree(root.to_string_lossy().to_string()).unwrap();
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
    let tree = list_project_tree(root.to_string_lossy().to_string()).unwrap();
    assert_eq!(names(&tree), vec!["Docs", "src", "apple.txt", "Zebra.txt"]);
  }

  #[test]
  fn missing_root_errors() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");
    assert!(list_project_tree(missing.to_string_lossy().to_string()).is_err());
  }

  #[test]
  fn file_as_root_errors() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("file.txt");
    fs::write(&file, "x").unwrap();
    assert!(list_project_tree(file.to_string_lossy().to_string()).is_err());
  }
}
