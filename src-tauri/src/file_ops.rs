// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::note_store::NoteStore;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

/// Validate a user-entered file or folder name. Trims surrounding whitespace and
/// rejects empty names, the `.`/`..` directory aliases, and any path separator so
/// the name can only ever create a sibling inside its parent directory.
pub(crate) fn validate_name(name: &str) -> Result<&str, String> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err("name cannot be empty".to_string());
  }
  if trimmed == "." || trimmed == ".." {
    return Err("invalid name".to_string());
  }
  if trimmed.contains('/') || trimmed.contains('\\') {
    return Err("name cannot contain path separators".to_string());
  }
  Ok(trimmed)
}

/// Create an empty file named `name` inside `parent`. Errors on a bad name, a
/// missing parent directory, or an existing target (collision).
fn create_file_at(parent: &Path, name: &str) -> Result<PathBuf, String> {
  let name = validate_name(name)?;
  if !parent.is_dir() {
    return Err(format!(
      "parent directory does not exist: {}",
      parent.display()
    ));
  }
  let target = parent.join(name);
  if target.exists() {
    return Err(format!("already exists: {name}"));
  }
  fs::File::create(&target).map_err(|e| e.to_string())?;
  Ok(target)
}

/// Create a folder named `name` inside `parent`. Same validation and collision
/// rules as `create_file_at`.
fn create_folder_at(parent: &Path, name: &str) -> Result<PathBuf, String> {
  let name = validate_name(name)?;
  if !parent.is_dir() {
    return Err(format!(
      "parent directory does not exist: {}",
      parent.display()
    ));
  }
  let target = parent.join(name);
  if target.exists() {
    return Err(format!("already exists: {name}"));
  }
  fs::create_dir(&target).map_err(|e| e.to_string())?;
  Ok(target)
}

/// Rename `path` to `new_name`, keeping it in the same parent directory. A rename
/// to the current name is a no-op; any other existing sibling is a collision.
fn rename_to(path: &Path, new_name: &str) -> Result<PathBuf, String> {
  let new_name = validate_name(new_name)?;
  let parent = path
    .parent()
    .ok_or_else(|| "path has no parent directory".to_string())?;
  let target = parent.join(new_name);
  if target == path {
    return Ok(target);
  }
  if target.exists() {
    return Err(format!("already exists: {new_name}"));
  }
  fs::rename(path, &target).map_err(|e| e.to_string())?;
  Ok(target)
}

/// Pre-validate a trash request. The actual `trash::delete` is not covered by a
/// unit test (it would pollute the real system Trash), so this split keeps the
/// "missing path" guard testable on its own.
fn ensure_trashable(path: &Path) -> Result<(), String> {
  if !path.exists() {
    return Err(format!("path does not exist: {}", path.display()));
  }
  Ok(())
}

#[tauri::command]
pub fn create_file(parent: String, name: String) -> Result<String, String> {
  create_file_at(Path::new(&parent), &name).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_folder(parent: String, name: String) -> Result<String, String> {
  create_folder_at(Path::new(&parent), &name).map(|p| p.to_string_lossy().to_string())
}
/// Rename `path`, then hand the old and new path to `follow`. A failed rename
/// calls nothing, so no record is rewritten for a path that did not move.
fn rename_following(
  path: &Path,
  new_name: &str,
  follow: impl FnOnce(&str, &str),
) -> Result<String, String> {
  let renamed = rename_to(path, new_name)?.to_string_lossy().to_string();
  let from = path.to_string_lossy();
  if renamed != from {
    follow(&from, &renamed);
  }
  Ok(renamed)
}

#[derive(Clone, Serialize)]
struct PathsMoved {
  from: String,
  to: String,
}
/// Point everything that remembers `from` at `to`: stored tabs, the recent list
/// and sandbox grants, then tell the open windows. A failure to follow is
/// logged and never undoes the rename.
pub(crate) fn follow_move(app: &AppHandle, store: &NoteStore, from: &str, to: &str) {
  if let Err(e) = store.retarget_paths(from, to) {
    log::warn!("could not follow a rename in the stored tabs: {e}");
  }
  crate::retarget_recent(app, from, to);
  crate::grants::rekey(from, to);
  crate::note_store::emit_store_changed(app, None);
  let _ = app.emit(
    "paths-moved",
    PathsMoved {
      from: from.to_string(),
      to: to.to_string(),
    },
  );
}

#[tauri::command(async)]
pub fn rename_path(
  app: AppHandle,
  store: State<NoteStore>,
  path: String,
  new_name: String,
) -> Result<String, String> {
  rename_following(Path::new(&path), &new_name, |from, to| {
    follow_move(&app, &store, from, to)
  })
}
/// Byte span of every segment of `path`. `/` always separates; a backslash does
/// only when `backslash` is set, since it is an ordinary name character on Unix.
pub(crate) fn segment_spans(path: &str, backslash: bool) -> Vec<(usize, usize)> {
  let mut spans = Vec::new();
  let mut start = None;
  for (i, c) in path.char_indices() {
    if c == '/' || (backslash && c == '\\') {
      if let Some(s) = start.take() {
        spans.push((s, i));
      }
    } else if start.is_none() {
      start = Some(i);
    }
  }
  if let Some(s) = start {
    spans.push((s, path.len()));
  }
  spans
}
/// `path` with the leading `from` replaced by `to`, when `path` is `from` or lies
/// below it; otherwise `path` unchanged. Matched by whole segment, so `/a/Tools`
/// does not match `/a/Tools2`.
fn retarget_with(path: &str, from: &str, to: &str, fold_case: bool, backslash: bool) -> String {
  let from_spans = segment_spans(from, backslash);
  let path_spans = segment_spans(path, backslash);
  let Some(last) = from_spans.len().checked_sub(1) else {
    return path.to_string();
  };
  let inside = path_spans.len() > last
    && from_spans.iter().zip(&path_spans).all(|(f, p)| {
      let (f, p) = (&from[f.0..f.1], &path[p.0..p.1]);
      if fold_case {
        f.to_lowercase() == p.to_lowercase()
      } else {
        f == p
      }
    });
  match path_spans.get(last) {
    Some(&(_, end)) if inside => format!("{to}{}", &path[end..]),
    _ => path.to_string(),
  }
}
/// `retarget_with` under this platform's rules: macOS and Windows ignore case,
/// and Windows accepts both separators.
pub(crate) fn retarget_path(path: &str, from: &str, to: &str) -> String {
  retarget_with(
    path,
    from,
    to,
    cfg!(any(target_os = "macos", target_os = "windows")),
    cfg!(target_os = "windows"),
  )
}
/// The paths of `paths` that do not exist. Only a plain "not found" counts: a
/// path that cannot be examined for another reason (permissions, a volume that
/// is away) is not reported as gone.
fn missing_among(paths: &[String]) -> Vec<String> {
  paths
    .iter()
    .filter(|p| {
      matches!(
        std::fs::symlink_metadata(p),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
      )
    })
    .cloned()
    .collect()
}
/// Which of `paths` have been deleted or moved away since they were opened.
#[tauri::command(async)]
pub fn missing_paths(paths: Vec<String>) -> Vec<String> {
  missing_among(&paths)
}

/// Move `path` to the system Trash (recoverable). Uses the `trash` crate so the
/// item lands where the OS "Put Back" expects it. The actual delete must run on
/// the main thread: macOS's trashItemAtURL hangs forever when called from a
/// Tauri command worker thread (found live in E2E).
#[tauri::command]
pub fn trash_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
  ensure_trashable(Path::new(&path))?;
  let (tx, rx) = std::sync::mpsc::channel();
  app
    .run_on_main_thread(move || {
      let _ = tx.send(trash::delete(Path::new(&path)).map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
  rx.recv().map_err(|e| e.to_string())?
}

/// Reveal `path` in the system file browser, selecting it where the platform
/// supports selection (Finder on macOS, File Explorer on Windows). Linux opens
/// the containing directory via xdg-open (no portable "select item" without a
/// DBus dependency).
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
  // A tab outlives the file it was opened from (deleted or moved while the
  // window stayed open with its unsaved content). Revealing one is not a
  // harmless no-op on Windows: `explorer /select,` treats a path it cannot
  // resolve as no argument at all and opens the user's home folder with an
  // arbitrary item selected, which reads as "reveal picked the wrong file"
  // rather than "that file is gone". Measured on Windows 11.
  if !Path::new(&path).exists() {
    return Err(format!("path no longer exists: {path}"));
  }
  let (program, args) = reveal_command(&path)?;
  std::process::Command::new(program)
    .args(&args)
    .spawn()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Assemble the (program, args) that reveals `path` for the current platform.
/// Split out so the command construction is unit-testable without spawning.
/// Windows' `explorer /select,` highlights the item; Linux' `xdg-open` on the
/// parent directory only opens the folder (selection needs DBus, deliberately
/// avoided to keep the dependency footprint small).
fn reveal_command(path: &str) -> Result<(&'static str, Vec<String>), String> {
  #[cfg(target_os = "macos")]
  {
    Ok(("open", vec!["-R".to_string(), path.to_string()]))
  }
  #[cfg(target_os = "windows")]
  {
    // explorer returns a non-zero exit code even on success, so the caller only
    // spawns it and ignores the status.
    // Separators are normalised first: `/select,` accepts only backslashes.
    // Measured on Windows 11 — a forward-slash path does not error, it silently
    // opens the user's home folder with nothing of the target selected, which
    // reads as "reveal picked the wrong place" rather than as a failure.
    let native = path.replace('/', "\\");
    Ok(("explorer", vec![format!("/select,{native}")]))
  }
  #[cfg(target_os = "linux")]
  {
    let parent = Path::new(path)
      .parent()
      .filter(|p| !p.as_os_str().is_empty())
      .map(|p| p.to_string_lossy().into_owned())
      .unwrap_or_else(|| path.to_string());
    Ok(("xdg-open", vec![parent]))
  }
  #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
  {
    let _ = path;
    Err("reveal in file browser is not supported on this platform".to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  #[test]
  fn reveal_refuses_a_path_that_is_gone() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("deleted.txt");
    assert!(reveal_in_finder(missing.to_string_lossy().to_string()).is_err());
  }

  #[test]
  fn reveal_command_is_assembled_per_platform() {
    let (program, args) = reveal_command("/tmp/dir/note.txt").unwrap();
    #[cfg(target_os = "macos")]
    {
      assert_eq!(program, "open");
      assert_eq!(
        args,
        vec!["-R".to_string(), "/tmp/dir/note.txt".to_string()]
      );
    }
    #[cfg(target_os = "windows")]
    {
      assert_eq!(program, "explorer");
      // Separators normalised: forward slashes make explorer open the home
      // folder with nothing selected.
      assert_eq!(args, vec!["/select,\\tmp\\dir\\note.txt".to_string()]);
    }
    #[cfg(target_os = "linux")]
    {
      // Linux opens the containing directory, not the file itself.
      assert_eq!(program, "xdg-open");
      assert_eq!(args, vec!["/tmp/dir".to_string()]);
    }
  }

  #[cfg(target_os = "windows")]
  #[test]
  fn reveal_keeps_a_native_windows_path_intact() {
    let (_, args) = reveal_command("C:\\Users\\me\\note.txt").unwrap();
    assert_eq!(args, vec!["/select,C:\\Users\\me\\note.txt".to_string()]);
  }
}

#[cfg(test)]
mod tree_tests {
  use super::*;
  use tempfile::tempdir;

  #[test]
  fn create_file_happy_path() {
    let dir = tempdir().unwrap();
    let path = create_file_at(dir.path(), "note.txt").unwrap();
    assert!(path.is_file());
    assert_eq!(path, dir.path().join("note.txt"));
  }

  #[test]
  fn create_file_collision_errors() {
    let dir = tempdir().unwrap();
    create_file_at(dir.path(), "note.txt").unwrap();
    assert!(create_file_at(dir.path(), "note.txt").is_err());
  }

  #[test]
  fn create_file_rejects_bad_names() {
    let dir = tempdir().unwrap();
    assert!(create_file_at(dir.path(), "").is_err());
    assert!(create_file_at(dir.path(), "   ").is_err());
    assert!(create_file_at(dir.path(), ".").is_err());
    assert!(create_file_at(dir.path(), "..").is_err());
    assert!(create_file_at(dir.path(), "a/b").is_err());
    assert!(create_file_at(dir.path(), "a\\b").is_err());
    // A leading dot is allowed (dotfiles are legitimate names).
    assert!(create_file_at(dir.path(), ".gitignore").is_ok());
  }

  #[test]
  fn create_file_missing_parent_errors() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("nope");
    assert!(create_file_at(&missing, "note.txt").is_err());
  }

  #[test]
  fn create_folder_happy_path_and_collision() {
    let dir = tempdir().unwrap();
    let path = create_folder_at(dir.path(), "sub").unwrap();
    assert!(path.is_dir());
    assert!(create_folder_at(dir.path(), "sub").is_err());
  }

  #[test]
  fn create_folder_missing_parent_errors() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("nope");
    assert!(create_folder_at(&missing, "sub").is_err());
  }

  #[test]
  fn rename_moves_within_parent() {
    let dir = tempdir().unwrap();
    let src = create_file_at(dir.path(), "old.txt").unwrap();
    let dst = rename_to(&src, "new.txt").unwrap();
    assert!(!src.exists());
    assert!(dst.is_file());
    assert_eq!(dst, dir.path().join("new.txt"));
  }

  #[test]
  fn rename_to_same_name_is_noop() {
    let dir = tempdir().unwrap();
    let src = create_file_at(dir.path(), "keep.txt").unwrap();
    let dst = rename_to(&src, "keep.txt").unwrap();
    assert_eq!(src, dst);
    assert!(dst.is_file());
  }

  #[test]
  fn rename_collision_errors() {
    let dir = tempdir().unwrap();
    let src = create_file_at(dir.path(), "a.txt").unwrap();
    create_file_at(dir.path(), "b.txt").unwrap();
    assert!(rename_to(&src, "b.txt").is_err());
    // Source is untouched after a rejected rename.
    assert!(src.is_file());
  }

  #[test]
  fn rename_rejects_bad_names() {
    let dir = tempdir().unwrap();
    let src = create_file_at(dir.path(), "a.txt").unwrap();
    assert!(rename_to(&src, "").is_err());
    assert!(rename_to(&src, "x/y").is_err());
  }

  #[test]
  fn trash_prevalidation_rejects_missing_path() {
    let dir = tempdir().unwrap();
    assert!(ensure_trashable(&dir.path().join("ghost.txt")).is_err());
    let existing = create_file_at(dir.path(), "real.txt").unwrap();
    assert!(ensure_trashable(&existing).is_ok());
  }

  fn retarget(path: &str, from: &str, to: &str) -> String {
    retarget_with(path, from, to, false, false)
  }

  #[test]
  fn retarget_replaces_the_path_itself_and_everything_below_it() {
    assert_eq!(retarget("/a/f.txt", "/a/f.txt", "/a/g.txt"), "/a/g.txt");
    assert_eq!(retarget("/a/y/f.txt", "/a/y", "/a/z"), "/a/z/f.txt");
    assert_eq!(retarget("/a/y/b/c.txt", "/a/y", "/a/z"), "/a/z/b/c.txt");
  }

  #[test]
  fn retarget_matches_whole_segments_not_a_string_prefix() {
    assert_eq!(retarget("/a/Tools2/f", "/a/Tools", "/a/X"), "/a/Tools2/f");
    assert_eq!(retarget("/a/Tools2", "/a/Tools", "/a/X"), "/a/Tools2");
    assert_eq!(
      retarget("/a/Tools-old/f", "/a/Tools", "/a/X"),
      "/a/Tools-old/f"
    );
  }

  #[test]
  fn retarget_leaves_unrelated_and_shorter_paths_alone() {
    assert_eq!(retarget("/b/f.txt", "/a", "/c"), "/b/f.txt");
    assert_eq!(retarget("/a", "/a/y", "/a/z"), "/a");
    assert_eq!(retarget("", "/a", "/c"), "");
    assert_eq!(retarget("/a/f", "", "/c"), "/a/f");
  }

  #[test]
  fn retarget_ignores_case_only_when_asked_to() {
    assert_eq!(
      retarget_with("/A/y/f", "/a/Y", "/a/z", true, false),
      "/a/z/f"
    );
    assert_eq!(
      retarget_with("/A/y/f", "/a/Y", "/a/z", false, false),
      "/A/y/f"
    );
  }

  #[test]
  fn retarget_reads_both_separators_only_where_a_backslash_separates() {
    assert_eq!(
      retarget_with("C:\\p\\y/f.txt", "C:/p/y", "C:\\p\\z", true, true),
      "C:\\p\\z/f.txt"
    );
    // On Unix a backslash is part of a name: `y\\f` is one segment.
    assert_eq!(retarget("/p/y\\f", "/p/y", "/p/z"), "/p/y\\f");
    assert_eq!(retarget("/p/y\\f", "/p/y\\f", "/p/z"), "/p/z");
  }

  #[test]
  fn retarget_keeps_what_follows_the_moved_part_verbatim() {
    assert_eq!(retarget("/a/y//f.txt", "/a/y", "/a/z"), "/a/z//f.txt");
  }

  #[test]
  fn a_failed_rename_follows_nothing() {
    let dir = tempdir().unwrap();
    let src = create_file_at(dir.path(), "a.txt").unwrap();
    create_file_at(dir.path(), "b.txt").unwrap();
    let mut followed = Vec::new();
    let result = rename_following(&src, "b.txt", |f, t| {
      followed.push((f.to_string(), t.to_string()))
    });
    assert!(result.is_err());
    assert!(followed.is_empty());
    let ghost = dir.path().join("ghost.txt");
    assert!(rename_following(&ghost, "x.txt", |f, t| {
      followed.push((f.to_string(), t.to_string()))
    })
    .is_err());
    assert!(followed.is_empty());
  }

  #[test]
  fn a_rename_follows_with_the_old_and_the_new_path() {
    let dir = tempdir().unwrap();
    let src = create_file_at(dir.path(), "a.txt").unwrap();
    let mut followed = Vec::new();
    let renamed = rename_following(&src, "c.txt", |f, t| {
      followed.push((f.to_string(), t.to_string()))
    })
    .unwrap();
    assert_eq!(followed.len(), 1);
    assert_eq!(followed[0].0, src.to_string_lossy());
    assert_eq!(followed[0].1, renamed);
    // Renaming to the same name moves nothing, so there is nothing to follow.
    let mut again = 0;
    rename_following(Path::new(&renamed), "c.txt", |_, _| again += 1).unwrap();
    assert_eq!(again, 0);
  }

  #[test]
  fn rename_command_is_async() {
    let source = include_str!("file_ops.rs");
    let at = source.find("pub fn rename_path(").unwrap();
    assert!(source[..at]
      .trim_end()
      .ends_with("#[tauri::command(async)]"));
  }
}

#[cfg(test)]
mod missing_tests {
  use super::*;
  use tempfile::tempdir;

  fn probe(paths: &[&Path]) -> Vec<String> {
    let given: Vec<String> = paths
      .iter()
      .map(|p| p.to_string_lossy().to_string())
      .collect();
    missing_among(&given)
  }

  #[test]
  fn only_the_paths_that_do_not_exist_are_reported() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("here.txt");
    std::fs::write(&file, "x").unwrap();
    let gone = dir.path().join("gone.txt");
    let gone_below = dir.path().join("no-such-dir").join("f.txt");
    let found = probe(&[dir.path(), &file, &gone, &gone_below]);
    assert_eq!(
      found,
      vec![
        gone.to_string_lossy().to_string(),
        gone_below.to_string_lossy().to_string()
      ]
    );
    assert!(probe(&[]).is_empty());
  }

  #[test]
  fn a_dangling_link_still_exists_as_a_link() {
    #[cfg(unix)]
    {
      let dir = tempdir().unwrap();
      let link = dir.path().join("link");
      std::os::unix::fs::symlink(dir.path().join("nowhere"), &link).unwrap();
      assert!(probe(&[&link]).is_empty());
    }
  }

  #[cfg(unix)]
  #[test]
  fn a_path_that_cannot_be_examined_is_not_reported() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let sealed = dir.path().join("sealed");
    std::fs::create_dir(&sealed).unwrap();
    let inside = sealed.join("f.txt");
    std::fs::write(&inside, "x").unwrap();
    std::fs::set_permissions(&sealed, std::fs::Permissions::from_mode(0o000)).unwrap();
    let denied = std::fs::symlink_metadata(&inside)
      .is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied);
    let found = probe(&[&inside]);
    std::fs::set_permissions(&sealed, std::fs::Permissions::from_mode(0o755)).unwrap();
    // A superuser can look inside anyway, which leaves nothing to assert.
    if denied {
      assert!(found.is_empty());
    }
  }

  #[test]
  fn missing_paths_is_async() {
    let source = include_str!("file_ops.rs");
    let at = source.find("pub fn missing_paths(").unwrap();
    assert!(source[..at]
      .trim_end()
      .ends_with("#[tauri::command(async)]"));
  }
}
