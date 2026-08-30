// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use std::fs;
use std::path::{Path, PathBuf};

/// Validate a user-entered file or folder name. Trims surrounding whitespace and
/// rejects empty names, the `.`/`..` directory aliases, and any path separator so
/// the name can only ever create a sibling inside its parent directory.
fn validate_name(name: &str) -> Result<&str, String> {
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

#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
  rename_to(Path::new(&path), &new_name).map(|p| p.to_string_lossy().to_string())
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

  #[test]
  fn trash_prevalidation_rejects_missing_path() {
    let dir = tempdir().unwrap();
    assert!(ensure_trashable(&dir.path().join("ghost.txt")).is_err());
    let existing = create_file_at(dir.path(), "real.txt").unwrap();
    assert!(ensure_trashable(&existing).is_ok());
  }
}
