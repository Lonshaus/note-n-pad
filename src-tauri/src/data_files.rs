// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

//! The two actions offered on a file that failed to load. Both take a store and
//! a file name, never a path: the folder is resolved here, so a name that tries
//! to leave it is refused rather than repaired.

use crate::note_store::NoteStore;
use crate::{file_ops, locale_store, theme_store};
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, State};

/// Which of the three data folders a file lives in.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataKind {
  Snapshots,
  Themes,
  Locales,
}

/// Accept only a name that is exactly one ordinary path component. This rejects
/// `..` and separators, and also the Windows-only shapes a substring check
/// would miss: `C:\x` is absolute, and `C:x` is drive-relative, so joining
/// either onto a folder discards that folder entirely.
fn plain_file_name(name: &str) -> Result<(), String> {
  let mut components = Path::new(name).components();
  match (components.next(), components.next()) {
    (Some(Component::Normal(single)), None) if single == name => Ok(()),
    _ => Err(format!("not a plain file name: {name}")),
  }
}

fn resolve(
  app: &AppHandle,
  store: &NoteStore,
  kind: DataKind,
  name: &str,
) -> Result<PathBuf, String> {
  plain_file_name(name)?;
  let dir = match kind {
    DataKind::Snapshots => store.current_dir(),
    DataKind::Themes => theme_store::themes_dir(app)?,
    DataKind::Locales => locale_store::app_data_locales_dir(app)?,
  };
  Ok(dir.join(name))
}

/// Delete one file that failed to load. It is addressed by name because the
/// per-store delete commands all build `{id}.json` from an id, which cannot
/// name a conflict copy or a file whose id is the reason it was skipped.
#[tauri::command]
pub fn delete_data_file(
  app: AppHandle,
  store: State<NoteStore>,
  kind: DataKind,
  name: String,
) -> Result<(), String> {
  let path = resolve(&app, &store, kind, &name)?;
  std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Show one file that failed to load in the system file browser.
#[tauri::command]
pub fn reveal_data_file(
  app: AppHandle,
  store: State<NoteStore>,
  kind: DataKind,
  name: String,
) -> Result<(), String> {
  let path = resolve(&app, &store, kind, &name)?;
  file_ops::reveal_in_finder(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_plain_file_name_is_accepted() {
    assert!(plain_file_name("a (conflicted copy).json").is_ok());
    assert!(plain_file_name("ocean.json").is_ok());
  }

  #[test]
  fn a_name_that_could_leave_the_folder_is_refused() {
    for name in ["..", ".", "", "../a.json", "a/b.json", "/etc/passwd"] {
      assert!(plain_file_name(name).is_err(), "accepted {name:?}");
    }
  }

  #[test]
  fn a_backslash_follows_the_platform() {
    // `\` separates path components on Windows only. Everywhere else it is an
    // ordinary character, and a file really can be named with one, so refusing
    // it there would refuse a file that exists.
    let refused = plain_file_name("a\\b.json").is_err();
    assert_eq!(refused, cfg!(target_os = "windows"));
  }

  #[cfg(target_os = "windows")]
  #[test]
  fn a_windows_drive_prefix_is_refused() {
    // Both discard the folder they are joined onto: absolute, and drive-relative.
    assert!(plain_file_name("C:\\a.json").is_err());
    assert!(plain_file_name("C:a.json").is_err());
  }
}
