// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::file_ops::{follow_move, segment_spans, validate_name};
use crate::note_store::NoteStore;
use serde::Serialize;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

const FOLD_CASE: bool = cfg!(any(target_os = "macos", target_os = "windows"));
const BACKSLASH: bool = cfg!(target_os = "windows");
/// Why a move or copy did not happen. The first four mean the request does not
/// fit the folder tree, or that the tree changed between the drop check and
/// this call. `Other` carries the system's own words.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum TransferError {
  CrossProject,
  CrossVolume,
  SameName,
  IntoSelf,
  Other(String),
}

impl From<io::Error> for TransferError {
  fn from(e: io::Error) -> Self {
    TransferError::Other(e.to_string())
  }
}
/// A link the copy left out, with the path it would have had below the
/// destination folder and a code the page turns into words.
#[derive(Debug, PartialEq, Serialize)]
pub struct SkippedLink {
  pub path: String,
  pub reason: &'static str,
}
/// A finished copy: where it landed and which links could not be made.
#[derive(Debug, Serialize)]
pub struct Copied {
  pub path: String,
  pub skipped: Vec<SkippedLink>,
}
/// Identifier of the disk holding `path`, links followed, so a disk mounted on a
/// folder reports the mounted disk. This is the disk of a destination folder.
#[cfg(unix)]
pub(crate) fn volume_of(path: &Path) -> Result<u64, String> {
  use std::os::unix::fs::MetadataExt;
  fs::metadata(path)
    .map(|m| m.dev())
    .map_err(|e| e.to_string())
}
/// Identifier of the disk the item at `path` itself is on: a link reports the
/// disk it lives on, not the one it points to, and a dangling link has one too.
/// This is the disk of an item that is moved or copied.
#[cfg(unix)]
pub(crate) fn source_volume_of(path: &Path) -> Result<u64, String> {
  use std::os::unix::fs::MetadataExt;
  fs::symlink_metadata(path)
    .map(|m| m.dev())
    .map_err(|e| e.to_string())
}
/// Volume serial number of the disk `path` is on. Opened with no access and
/// every share mode, so a file another app holds exclusively can still be
/// asked; `flags` decides whether a link is entered or read as itself.
#[cfg(windows)]
fn volume_serial(path: &Path, flags: u32) -> Result<u64, String> {
  use std::os::windows::fs::OpenOptionsExt;
  use std::os::windows::io::AsRawHandle;
  use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
  };
  // A directory can only be opened with backup semantics.
  let file = fs::OpenOptions::new()
    .access_mode(0)
    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | flags)
    .open(path)
    .map_err(|e| e.to_string())?;
  let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
  let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) };
  if ok == 0 {
    return Err(io::Error::last_os_error().to_string());
  }
  Ok(u64::from(info.dwVolumeSerialNumber))
}
/// Identifier of the disk holding `path`, links followed, so a disk mounted on a
/// folder reports the mounted disk. This is the disk of a destination folder.
#[cfg(windows)]
pub(crate) fn volume_of(path: &Path) -> Result<u64, String> {
  volume_serial(path, 0)
}
/// Identifier of the disk the item at `path` itself is on: a link or mount
/// point reports the disk it lives on, not the one it leads to. This is the
/// disk of an item that is moved or copied.
#[cfg(windows)]
pub(crate) fn source_volume_of(path: &Path) -> Result<u64, String> {
  use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

  volume_serial(path, FILE_FLAG_OPEN_REPARSE_POINT)
}
/// The disk of `path`: that of the item itself, or with `follow` that of what a
/// link leads to.
fn disk_of(path: &Path, follow: bool) -> Result<u64, String> {
  if follow {
    volume_of(path)
  } else {
    source_volume_of(path)
  }
}
/// Asks for the disk of a path; `true` follows links.
type VolumeOf<'a> = &'a dyn Fn(&Path, bool) -> Result<u64, String>;
/// True when `path` is `dir` or lies below it, matched by whole segment.
fn within_with(path: &str, dir: &str, fold_case: bool, backslash: bool) -> bool {
  let dir_spans = segment_spans(dir, backslash);
  let path_spans = segment_spans(path, backslash);
  !dir_spans.is_empty()
    && path_spans.len() >= dir_spans.len()
    && dir_spans.iter().zip(&path_spans).all(|(d, p)| {
      let (d, p) = (&dir[d.0..d.1], &path[p.0..p.1]);
      if fold_case {
        d.to_lowercase() == p.to_lowercase()
      } else {
        d == p
      }
    })
}
/// `within_with` under this platform's rules.
fn within(path: &Path, dir: &Path) -> bool {
  within_with(
    &path.to_string_lossy(),
    &dir.to_string_lossy(),
    FOLD_CASE,
    BACKSLASH,
  )
}

#[derive(Clone, Copy, PartialEq)]
enum Op {
  Move,
  Copy,
}
/// A request that passed every check: the path the item gets, and whether it
/// already is there (a move into the folder it sits in).
struct Planned {
  dest: PathBuf,
  in_place: bool,
}
/// Check a move or copy of `src` into the folder `dest_dir` of project `root`.
/// A request that fits no rule is refused with the first reason, in this order:
/// another project, another disk, into itself, a name already taken.
fn plan_transfer(
  op: Op,
  src: &Path,
  dest_dir: &Path,
  root: &Path,
  volume: VolumeOf,
) -> Result<Planned, TransferError> {
  let name = src
    .file_name()
    .and_then(|n| n.to_str())
    .ok_or_else(|| TransferError::Other("path has no name".to_string()))?;
  let name = validate_name(name).map_err(TransferError::Other)?;
  if !within(src, root) || !within(dest_dir, root) {
    return Err(TransferError::CrossProject);
  }
  fs::symlink_metadata(src)?;
  if !fs::metadata(dest_dir)?.is_dir() {
    return Err(TransferError::Other(format!(
      "not a directory: {}",
      dest_dir.display()
    )));
  }
  // The item is judged where it lives, the folder where it leads.
  if volume(src, false).map_err(TransferError::Other)?
    != volume(dest_dir, true).map_err(TransferError::Other)?
  {
    return Err(TransferError::CrossVolume);
  }
  // The item itself, not what a link at its place points to; the folder it goes
  // into, with every link resolved so a link back into the item counts.
  let parent = src
    .parent()
    .ok_or_else(|| TransferError::Other("path has no parent directory".to_string()))?;
  let canon_parent = fs::canonicalize(parent)?;
  let canon_src = canon_parent.join(name);
  let canon_dest = fs::canonicalize(dest_dir)?;
  if within(&canon_dest, &canon_src) {
    return Err(TransferError::IntoSelf);
  }
  if op == Op::Move && within(&canon_parent, &canon_dest) && within(&canon_dest, &canon_parent) {
    return Ok(Planned {
      dest: src.to_path_buf(),
      in_place: true,
    });
  }
  let dest = dest_dir.join(name);
  if fs::symlink_metadata(&dest).is_ok() {
    return Err(TransferError::SameName);
  }
  Ok(Planned {
    dest,
    in_place: false,
  })
}
/// Move `src` into `dest_dir`, then hand the old and new path to `follow`. A
/// refused or failed move calls nothing, and neither does a move that leaves
/// the item where it is.
fn move_following(
  src: &Path,
  dest_dir: &Path,
  root: &Path,
  volume: VolumeOf,
  follow: impl FnOnce(&str, &str),
) -> Result<String, TransferError> {
  let plan = plan_transfer(Op::Move, src, dest_dir, root, volume)?;
  let to = plan.dest.to_string_lossy().to_string();
  if plan.in_place {
    return Ok(to);
  }
  fs::rename(src, &plan.dest)?;
  follow(&src.to_string_lossy(), &to);
  Ok(to)
}

#[derive(Debug, PartialEq)]
enum LinkOutcome {
  Created,
  /// Only Windows has links the user may not be allowed to make.
  #[cfg_attr(not(windows), allow(dead_code))]
  NoPrivilege,
  /// A reparse point that is not a link we recreate (a WSL link, a cloud
  /// placeholder): it is copied as the file or folder it presents.
  #[cfg_attr(not(windows), allow(dead_code))]
  Content,
}
/// Make a link at `dest` like the one at `src`, without looking at what it
/// points to.
#[cfg(unix)]
fn copy_link(src: &Path, dest: &Path) -> io::Result<LinkOutcome> {
  std::os::unix::fs::symlink(fs::read_link(src)?, dest)?;
  Ok(LinkOutcome::Created)
}
/// What a Windows reparse point is, by its tag.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq)]
enum LinkKind {
  /// A junction, or a disk mounted on a folder.
  Junction,
  Symlink,
  Other,
}

#[cfg(any(windows, test))]
fn link_kind(tag: u32) -> LinkKind {
  match tag {
    0xA000_0003 => LinkKind::Junction,
    0xA000_000C => LinkKind::Symlink,
    _ => LinkKind::Other,
  }
}
/// The target written in the reparse data of a symbolic link: the name it shows,
/// else the name it resolves (without the `\??\` device prefix).
#[cfg(any(windows, test))]
fn symlink_target(data: &[u8]) -> Option<String> {
  let u16_at = |at: usize| {
    data
      .get(at..at + 2)
      .map(|b| usize::from(u16::from_le_bytes([b[0], b[1]])))
  };
  let read = |offset: usize, len: usize| -> Option<String> {
    let bytes = data.get(20 + offset..20 + offset + len)?;
    let units: Vec<u16> = bytes
      .chunks_exact(2)
      .map(|c| u16::from_le_bytes([c[0], c[1]]))
      .collect();
    Some(String::from_utf16_lossy(&units))
  };
  let (substitute, print) = ((u16_at(8)?, u16_at(10)?), (u16_at(12)?, u16_at(14)?));
  if print.1 > 0 {
    return read(print.0, print.1);
  }
  let name = read(substitute.0, substitute.1)?;
  Some(match name.strip_prefix(r"\??\") {
    Some(rest) => rest.to_string(),
    None => name,
  })
}

#[cfg(windows)]
mod win {
  use std::fs;
  use std::io;
  use std::os::windows::fs::OpenOptionsExt;
  use std::os::windows::io::AsRawHandle;
  use std::path::Path;
  use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE,
  };
  use windows_sys::Win32::System::IO::DeviceIoControl;

  const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
  const FSCTL_GET_REPARSE_POINT: u32 = 0x0009_00A8;
  pub(super) const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;
  /// Open the link itself (not what it points to), for reading or writing.
  fn open_link(path: &Path, write: bool) -> io::Result<fs::File> {
    fs::OpenOptions::new()
      .read(!write)
      .write(write)
      .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
      .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
      .open(path)
  }
  /// The raw reparse data of the link at `path`: its tag, then its payload.
  pub(super) fn read_reparse(path: &Path) -> io::Result<Vec<u8>> {
    let file = open_link(path, false)?;
    let mut data = vec![0u8; 16 * 1024];
    let mut len = 0u32;
    let ok = unsafe {
      DeviceIoControl(
        file.as_raw_handle() as _,
        FSCTL_GET_REPARSE_POINT,
        std::ptr::null(),
        0,
        data.as_mut_ptr().cast(),
        data.len() as u32,
        &mut len,
        std::ptr::null_mut(),
      )
    };
    if ok == 0 {
      return Err(io::Error::last_os_error());
    }
    data.truncate(len as usize);
    Ok(data)
  }
  /// Make `dest` a junction (or disk mount) carrying the reparse data `data`
  /// read from the original. An empty folder is left behind by nothing.
  pub(super) fn write_junction(dest: &Path, data: &[u8]) -> io::Result<()> {
    fs::create_dir(dest)?;
    let set = || -> io::Result<()> {
      let file = open_link(dest, true)?;
      let mut len = 0u32;
      let ok = unsafe {
        DeviceIoControl(
          file.as_raw_handle() as _,
          FSCTL_SET_REPARSE_POINT,
          data.as_ptr().cast(),
          data.len() as u32,
          std::ptr::null_mut(),
          0,
          &mut len,
          std::ptr::null_mut(),
        )
      };
      if ok == 0 {
        return Err(io::Error::last_os_error());
      }
      Ok(())
    };
    let result = set();
    if result.is_err() {
      let _ = fs::remove_dir(dest);
    }
    result
  }
}
/// Create the symbolic link `link` to `target`, of the type of its original.
#[cfg(windows)]
fn make_symlink(target: &Path, link: &Path, is_dir: bool) -> io::Result<()> {
  if is_dir {
    std::os::windows::fs::symlink_dir(target, link)
  } else {
    std::os::windows::fs::symlink_file(target, link)
  }
}
/// Make a link at `dest` like the one at `src`, without looking at what it
/// points to: a junction or disk mount stays one, a symbolic link keeps its
/// type. A symbolic link the user may not create is left out.
#[cfg(windows)]
fn copy_link(src: &Path, dest: &Path) -> io::Result<LinkOutcome> {
  copy_link_with(src, dest, &make_symlink)
}
#[cfg(windows)]
fn copy_link_with(
  src: &Path,
  dest: &Path,
  make: &dyn Fn(&Path, &Path, bool) -> io::Result<()>,
) -> io::Result<LinkOutcome> {
  use std::os::windows::fs::FileTypeExt;

  let data = win::read_reparse(src)?;
  let tag = data
    .get(..4)
    .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    .ok_or_else(|| io::Error::other("empty reparse data"))?;
  match link_kind(tag) {
    LinkKind::Junction => {
      win::write_junction(dest, &data)?;
      Ok(LinkOutcome::Created)
    }
    LinkKind::Symlink => {
      let target =
        symlink_target(&data).ok_or_else(|| io::Error::other("unreadable link target"))?;
      let is_dir = fs::symlink_metadata(src)?.file_type().is_symlink_dir();
      match make(Path::new(&target), dest, is_dir) {
        Ok(()) => Ok(LinkOutcome::Created),
        Err(e) if e.raw_os_error() == Some(win::ERROR_PRIVILEGE_NOT_HELD) => {
          Ok(LinkOutcome::NoPrivilege)
        }
        Err(e) => Err(e),
      }
    }
    LinkKind::Other => Ok(LinkOutcome::Content),
  }
}

struct CopyRun {
  dest_dir: PathBuf,
  /// Something exists at the destination because of this run.
  created: bool,
  skipped: Vec<SkippedLink>,
  /// Folder permissions, applied once everything is in place.
  folder_modes: Vec<(PathBuf, fs::Permissions)>,
}
/// Copy the file, folder or link at `src` to the new path `dest`. Links are
/// recreated, never followed; anything else that is not a file or folder fails.
fn copy_entry(src: &Path, dest: &Path, run: &mut CopyRun) -> io::Result<()> {
  let mut meta = fs::symlink_metadata(src)?;
  if meta.file_type().is_symlink() {
    match copy_link(src, dest)? {
      LinkOutcome::Created => {
        run.created = true;
        return Ok(());
      }
      LinkOutcome::NoPrivilege => {
        run.skipped.push(SkippedLink {
          path: dest
            .strip_prefix(&run.dest_dir)
            .unwrap_or(dest)
            .to_string_lossy()
            .to_string(),
          reason: "symlinkPrivilege",
        });
        return Ok(());
      }
      // What it presents is read like any other file or folder.
      LinkOutcome::Content => meta = fs::metadata(src)?,
    }
  }
  let kind = meta.file_type();
  if kind.is_dir() {
    fs::create_dir(dest)?;
    run.created = true;
    let mut names = fs::read_dir(src)?
      .map(|e| e.map(|e| e.file_name()))
      .collect::<io::Result<Vec<OsString>>>()?;
    names.sort();
    for name in names {
      copy_entry(&src.join(&name), &dest.join(&name), run)?;
    }
    run
      .folder_modes
      .push((dest.to_path_buf(), meta.permissions()));
  } else if kind.is_file() {
    let mut input = fs::File::open(src)?;
    // Never `fs::copy`: it replaces a file that appeared in the meantime.
    let mut output = fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(dest)?;
    run.created = true;
    io::copy(&mut input, &mut output)?;
    drop(output);
    fs::set_permissions(dest, meta.permissions())?;
  } else {
    return Err(io::Error::other("not a regular file, folder or link"));
  }
  Ok(())
}
/// Remove what a failed copy created at `path`. A link is removed, never
/// entered, so what it points to is left alone.
fn remove_created(path: &Path) {
  let Ok(meta) = fs::symlink_metadata(path) else {
    return;
  };
  if meta.is_dir() {
    let _ = fs::remove_dir_all(path);
  } else {
    let _ = fs::remove_file(path).or_else(|_| fs::remove_dir(path));
  }
}
/// Copy `src` to the path of `plan`. `before_create` runs after the checks and
/// before anything is made.
fn copy_after_check(
  plan: &Planned,
  src: &Path,
  dest_dir: &Path,
  before_create: impl FnOnce(&Path),
) -> Result<Copied, TransferError> {
  before_create(&plan.dest);
  let mut run = CopyRun {
    dest_dir: dest_dir.to_path_buf(),
    created: false,
    skipped: Vec::new(),
    folder_modes: Vec::new(),
  };
  if let Err(e) = copy_entry(src, &plan.dest, &mut run) {
    if !run.created {
      // Nothing of ours is there: a name taken in the meantime is not to be
      // touched.
      return Err(if e.kind() == io::ErrorKind::AlreadyExists {
        TransferError::SameName
      } else {
        TransferError::from(e)
      });
    }
    remove_created(&plan.dest);
    return Err(e.into());
  }
  for (folder, mode) in run.folder_modes {
    let _ = fs::set_permissions(folder, mode);
  }
  Ok(Copied {
    path: plan.dest.to_string_lossy().to_string(),
    skipped: run.skipped,
  })
}

fn copy_to(
  src: &Path,
  dest_dir: &Path,
  root: &Path,
  volume: VolumeOf,
) -> Result<Copied, TransferError> {
  let plan = plan_transfer(Op::Copy, src, dest_dir, root, volume)?;
  copy_after_check(&plan, src, dest_dir, |_| {})
}
/// The disk holding `path`. Async so a slow volume never blocks the UI thread.
#[tauri::command(async)]
pub fn path_volume(path: String) -> Result<u64, String> {
  volume_of(Path::new(&path))
}
/// Move `src` into the folder `dest_dir`, both inside project `root`. Stored
/// tabs, the recent list and open windows follow the new path.
#[tauri::command(async)]
pub fn move_path(
  app: AppHandle,
  store: State<NoteStore>,
  src: String,
  dest_dir: String,
  root: String,
) -> Result<String, TransferError> {
  move_following(
    Path::new(&src),
    Path::new(&dest_dir),
    Path::new(&root),
    &disk_of,
    |from, to| follow_move(&app, &store, from, to),
  )
}
/// Copy `src` into the folder `dest_dir`, both inside project `root`. The
/// original stays where it is, so no record is rewritten.
#[tauri::command(async)]
pub fn copy_path(src: String, dest_dir: String, root: String) -> Result<Copied, TransferError> {
  copy_to(
    Path::new(&src),
    Path::new(&dest_dir),
    Path::new(&root),
    &disk_of,
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  fn same_disk(_: &Path, _: bool) -> Result<u64, String> {
    Ok(1)
  }
  /// A project folder `p` with a destination folder `d` beside the files.
  fn project() -> (tempfile::TempDir, PathBuf) {
    let dir = tempdir().unwrap();
    let root = dir.path().join("p");
    fs::create_dir_all(root.join("d")).unwrap();
    (dir, root)
  }

  fn mv(src: &Path, dest: &Path, root: &Path) -> Result<String, TransferError> {
    move_following(src, dest, root, &same_disk, |_, _| {})
  }

  fn cp(src: &Path, dest: &Path, root: &Path) -> Result<Copied, TransferError> {
    copy_to(src, dest, root, &same_disk)
  }

  #[test]
  fn a_file_moves_into_a_folder() {
    let (_dir, root) = project();
    let file = root.join("a.txt");
    fs::write(&file, "hello").unwrap();
    let to = mv(&file, &root.join("d"), &root).unwrap();
    assert_eq!(to, root.join("d").join("a.txt").to_string_lossy());
    assert!(!file.exists());
    assert_eq!(fs::read_to_string(&to).unwrap(), "hello");
  }

  #[test]
  fn a_folder_moves_with_everything_in_it() {
    let (_dir, root) = project();
    fs::create_dir_all(root.join("y/sub")).unwrap();
    fs::write(root.join("y/sub/f.txt"), "x").unwrap();
    let to = mv(&root.join("y"), &root.join("d"), &root).unwrap();
    assert!(!root.join("y").exists());
    assert_eq!(
      fs::read_to_string(Path::new(&to).join("sub/f.txt")).unwrap(),
      "x"
    );
  }

  #[test]
  fn nothing_moves_into_itself_or_below_itself() {
    let (_dir, root) = project();
    fs::create_dir_all(root.join("y/sub")).unwrap();
    for dest in [root.join("y"), root.join("y/sub")] {
      assert_eq!(
        mv(&root.join("y"), &dest, &root),
        Err(TransferError::IntoSelf)
      );
      assert_eq!(
        cp(&root.join("y"), &dest, &root).map(|c| c.path),
        Err(TransferError::IntoSelf)
      );
    }
    assert!(root.join("y/sub").is_dir());
    assert!(!root.join("y/sub/y").exists());
  }

  #[cfg(unix)]
  #[test]
  fn a_link_back_into_the_item_counts_as_inside_it() {
    let (_dir, root) = project();
    fs::create_dir_all(root.join("y/sub")).unwrap();
    std::os::unix::fs::symlink(root.join("y/sub"), root.join("d/back")).unwrap();
    let dest = root.join("d/back");
    assert_eq!(
      mv(&root.join("y"), &dest, &root),
      Err(TransferError::IntoSelf)
    );
    assert_eq!(
      cp(&root.join("y"), &dest, &root).map(|c| c.path),
      Err(TransferError::IntoSelf)
    );
  }

  #[cfg(unix)]
  #[test]
  fn a_link_moves_into_the_folder_it_points_to() {
    let (_dir, root) = project();
    std::os::unix::fs::symlink(root.join("d"), root.join("ln")).unwrap();
    let to = mv(&root.join("ln"), &root.join("d"), &root).unwrap();
    assert!(fs::symlink_metadata(to).unwrap().file_type().is_symlink());
  }

  #[test]
  fn a_taken_name_is_refused_and_nothing_is_touched() {
    let (_dir, root) = project();
    fs::write(root.join("a.txt"), "new").unwrap();
    fs::write(root.join("d/a.txt"), "old").unwrap();
    assert_eq!(
      mv(&root.join("a.txt"), &root.join("d"), &root),
      Err(TransferError::SameName)
    );
    assert_eq!(
      cp(&root.join("a.txt"), &root.join("d"), &root).map(|c| c.path),
      Err(TransferError::SameName)
    );
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "new");
    assert_eq!(fs::read_to_string(root.join("d/a.txt")).unwrap(), "old");
  }

  #[test]
  fn a_move_within_its_own_folder_does_nothing() {
    let (_dir, root) = project();
    let file = root.join("d/a.txt");
    fs::write(&file, "x").unwrap();
    let mut followed = 0;
    let to = move_following(&file, &root.join("d"), &root, &same_disk, |_, _| {
      followed += 1
    })
    .unwrap();
    assert_eq!(to, file.to_string_lossy());
    assert_eq!(followed, 0);
    assert_eq!(fs::read_to_string(&file).unwrap(), "x");
  }

  #[test]
  fn a_copy_within_its_own_folder_is_refused_by_name() {
    let (_dir, root) = project();
    let file = root.join("d/a.txt");
    fs::write(&file, "x").unwrap();
    assert_eq!(
      cp(&file, &root.join("d"), &root).map(|c| c.path),
      Err(TransferError::SameName)
    );
    assert_eq!(fs::read_dir(root.join("d")).unwrap().count(), 1);
  }

  #[test]
  fn another_disk_is_refused() {
    let (_dir, root) = project();
    let file = root.join("a.txt");
    fs::write(&file, "x").unwrap();
    let dest = root.join("d");
    let elsewhere = |p: &Path, _| Ok(if p == dest { 2 } else { 1 });
    assert_eq!(
      move_following(&file, &dest, &root, &elsewhere, |_, _| {}),
      Err(TransferError::CrossVolume)
    );
    assert_eq!(
      copy_to(&file, &dest, &root, &elsewhere).map(|c| c.path),
      Err(TransferError::CrossVolume)
    );
    assert!(file.exists());
    assert!(!dest.join("a.txt").exists());
  }

  #[test]
  fn a_disk_that_cannot_be_read_is_refused_with_its_reason() {
    let (_dir, root) = project();
    let file = root.join("a.txt");
    fs::write(&file, "x").unwrap();
    let broken = |_: &Path, _| Err("no volume information".to_string());
    assert_eq!(
      move_following(&file, &root.join("d"), &root, &broken, |_, _| {}),
      Err(TransferError::Other("no volume information".to_string()))
    );
    assert!(file.exists());
  }

  #[test]
  fn another_project_is_refused_even_on_another_disk() {
    let (dir, root) = project();
    let other = dir.path().join("q");
    fs::create_dir(&other).unwrap();
    let file = root.join("a.txt");
    fs::write(&file, "x").unwrap();
    let elsewhere = |p: &Path, _| Ok(if p == other { 2 } else { 1 });
    assert_eq!(
      move_following(&file, &other, &root, &elsewhere, |_, _| {}),
      Err(TransferError::CrossProject)
    );
    assert_eq!(
      copy_to(&file, &other, &root, &elsewhere).map(|c| c.path),
      Err(TransferError::CrossProject)
    );
    assert!(file.exists());
    assert!(!other.join("a.txt").exists());
  }

  #[test]
  fn a_project_whose_name_starts_like_another_is_another_project() {
    let (dir, root) = project();
    let sibling = dir.path().join("p2");
    fs::create_dir(&sibling).unwrap();
    let file = root.join("a.txt");
    fs::write(&file, "x").unwrap();
    assert_eq!(mv(&file, &sibling, &root), Err(TransferError::CrossProject));
  }

  #[test]
  fn a_source_that_is_gone_fails_with_the_system_reason() {
    let (_dir, root) = project();
    let ghost = root.join("ghost.txt");
    assert!(matches!(
      mv(&ghost, &root.join("d"), &root),
      Err(TransferError::Other(_))
    ));
    assert!(matches!(
      cp(&ghost, &root.join("d"), &root).map(|c| c.path),
      Err(TransferError::Other(_))
    ));
  }
  /// The real disk lookups, as the commands use them.
  #[cfg(unix)]
  fn real(p: &Path, follow: bool) -> Result<u64, String> {
    disk_of(p, follow)
  }
  /// A folder on another disk than `here`, if this machine has one.
  #[cfg(unix)]
  fn other_disk(here: &Path) -> Option<&'static Path> {
    let own = volume_of(here).unwrap();
    ["/dev", "/proc", "/sys"]
      .into_iter()
      .map(Path::new)
      .find(|p| p.is_dir() && volume_of(p).is_ok_and(|v| v != own))
  }

  #[test]
  fn an_item_is_judged_where_it_lives_and_a_folder_where_it_leads() {
    let (_dir, root) = project();
    let link = root.join("ln");
    fs::write(&link, "x").unwrap();
    // The item is on disk 1 even though what it stands for is on disk 2.
    let source_here = |p: &Path, follow: bool| Ok(if follow && p == link { 2 } else { 1 });
    assert!(move_following(&link, &root.join("d"), &root, &source_here, |_, _| {}).is_ok());
    fs::write(root.join("copy.txt"), "x").unwrap();
    assert!(copy_to(&root.join("copy.txt"), &root.join("d"), &root, &source_here).is_ok());
    // The folder is on disk 1 but leads to disk 2.
    fs::write(root.join("a.txt"), "x").unwrap();
    let dest = root.join("d");
    let leads_away = |p: &Path, follow: bool| Ok(if follow && p == dest { 2 } else { 1 });
    assert_eq!(mv(&root.join("a.txt"), &dest, &root).map(|_| ()), Ok(()));
    fs::write(root.join("b.txt"), "x").unwrap();
    assert_eq!(
      move_following(&root.join("b.txt"), &dest, &root, &leads_away, |_, _| {}),
      Err(TransferError::CrossVolume)
    );
    assert_eq!(
      copy_to(&root.join("b.txt"), &dest, &root, &leads_away).map(|c| c.path),
      Err(TransferError::CrossVolume)
    );
  }

  #[cfg(unix)]
  #[test]
  fn a_link_to_another_disk_moves_and_copies_within_the_project() {
    let (_dir, root) = project();
    let Some(elsewhere) = other_disk(&root) else {
      return;
    };
    std::os::unix::fs::symlink(elsewhere, root.join("ln")).unwrap();
    let to = move_following(&root.join("ln"), &root.join("d"), &root, &real, |_, _| {}).unwrap();
    assert_eq!(fs::read_link(&to).unwrap(), elsewhere);
    assert!(fs::symlink_metadata(root.join("ln")).is_err());
    let copied = copy_to(Path::new(&to), &root, &root, &real).unwrap();
    assert_eq!(fs::read_link(copied.path).unwrap(), elsewhere);
  }

  #[cfg(unix)]
  #[test]
  fn a_dangling_link_moves_and_copies() {
    let (_dir, root) = project();
    std::os::unix::fs::symlink(root.join("nowhere"), root.join("ln")).unwrap();
    let copied = copy_to(&root.join("ln"), &root.join("d"), &root, &real).unwrap();
    assert!(fs::symlink_metadata(copied.path)
      .unwrap()
      .file_type()
      .is_symlink());
    fs::remove_file(root.join("d/ln")).unwrap();
    let to = move_following(&root.join("ln"), &root.join("d"), &root, &real, |_, _| {}).unwrap();
    assert!(fs::symlink_metadata(to).unwrap().file_type().is_symlink());
    assert!(fs::symlink_metadata(root.join("ln")).is_err());
  }

  #[cfg(unix)]
  #[test]
  fn dropping_into_a_link_to_another_disk_is_refused() {
    let (_dir, root) = project();
    let Some(elsewhere) = other_disk(&root) else {
      return;
    };
    std::os::unix::fs::symlink(elsewhere, root.join("portal")).unwrap();
    fs::write(root.join("a.txt"), "x").unwrap();
    assert_eq!(
      move_following(
        &root.join("a.txt"),
        &root.join("portal"),
        &root,
        &real,
        |_, _| {}
      ),
      Err(TransferError::CrossVolume)
    );
    assert_eq!(
      copy_to(&root.join("a.txt"), &root.join("portal"), &root, &real).map(|c| c.path),
      Err(TransferError::CrossVolume)
    );
    assert!(root.join("a.txt").exists());
  }

  #[test]
  fn a_move_follows_with_the_old_and_the_new_path() {
    let (_dir, root) = project();
    let file = root.join("a.txt");
    fs::write(&file, "x").unwrap();
    let mut followed = Vec::new();
    let to = move_following(&file, &root.join("d"), &root, &same_disk, |f, t| {
      followed.push((f.to_string(), t.to_string()))
    })
    .unwrap();
    assert_eq!(followed, vec![(file.to_string_lossy().to_string(), to)]);
  }

  #[test]
  fn a_refused_move_follows_nothing() {
    let (_dir, root) = project();
    fs::write(root.join("a.txt"), "x").unwrap();
    fs::write(root.join("d/a.txt"), "y").unwrap();
    let mut followed = 0;
    let result = move_following(
      &root.join("a.txt"),
      &root.join("d"),
      &root,
      &same_disk,
      |_, _| followed += 1,
    );
    assert!(result.is_err());
    assert_eq!(followed, 0);
  }

  #[test]
  fn a_copy_rewrites_no_record() {
    // `copy_path` has no way to follow anything, and says so in its source.
    let source = include_str!("transfer.rs");
    let at = source.find("pub fn copy_path(").unwrap();
    let body = &source[at..source[at..].find("\n}\n").unwrap() + at];
    assert!(!body.contains("follow_move"));
    let at = source.find("pub fn move_path(").unwrap();
    let body = &source[at..source[at..].find("\n}\n").unwrap() + at];
    assert!(body.contains("follow_move"));
  }

  #[test]
  fn the_commands_are_async() {
    let source = include_str!("transfer.rs");
    for name in ["path_volume", "move_path", "copy_path"] {
      let at = source.find(&format!("pub fn {name}(")).unwrap();
      assert!(
        source[..at]
          .trim_end()
          .ends_with("#[tauri::command(async)]"),
        "{name}"
      );
    }
  }

  fn tree(root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
      let mut names: Vec<_> = fs::read_dir(dir).unwrap().flatten().collect();
      names.sort_by_key(|e| e.file_name());
      for e in names {
        let rel = e.path().strip_prefix(base).unwrap().display().to_string();
        let meta = fs::symlink_metadata(e.path()).unwrap();
        if meta.is_dir() {
          out.push((rel, "dir".to_string()));
          walk(base, &e.path(), out);
        } else {
          out.push((rel, fs::read_to_string(e.path()).unwrap()));
        }
      }
    }
    walk(root, root, &mut out);
    out
  }

  #[test]
  fn a_folder_is_copied_with_the_same_content() {
    let (_dir, root) = project();
    fs::create_dir_all(root.join("y/sub/empty")).unwrap();
    fs::write(root.join("y/a.txt"), "a").unwrap();
    fs::write(root.join("y/sub/b.txt"), "b").unwrap();
    let copied = cp(&root.join("y"), &root.join("d"), &root).unwrap();
    assert!(copied.skipped.is_empty());
    assert_eq!(
      copied.path,
      root.join("d").join("y").to_string_lossy().to_string()
    );
    assert_eq!(tree(&root.join("y")), tree(&root.join("d/y")));
    assert!(root.join("y/a.txt").exists());
  }

  #[cfg(unix)]
  #[test]
  fn a_link_is_recreated_not_followed() {
    let (dir, root) = project();
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("o.txt"), "o").unwrap();
    fs::create_dir(root.join("y")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("y/ln")).unwrap();
    cp(&root.join("y"), &root.join("d"), &root).unwrap();
    let copy = root.join("d/y/ln");
    assert!(fs::symlink_metadata(&copy)
      .unwrap()
      .file_type()
      .is_symlink());
    assert_eq!(fs::read_link(&copy).unwrap(), outside);
    assert_eq!(fs::read_to_string(outside.join("o.txt")).unwrap(), "o");
  }

  #[cfg(unix)]
  fn is_superuser() -> bool {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let probe = dir.path().join("probe");
    fs::write(&probe, "x").unwrap();
    fs::set_permissions(&probe, fs::Permissions::from_mode(0o000)).unwrap();
    let readable = fs::File::open(&probe).is_ok();
    fs::set_permissions(&probe, fs::Permissions::from_mode(0o644)).unwrap();
    readable
  }

  #[cfg(unix)]
  #[test]
  fn a_copy_that_fails_leaves_nothing_and_spares_what_a_link_points_to() {
    use std::os::unix::fs::PermissionsExt;
    if is_superuser() {
      return;
    }
    let (dir, root) = project();
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("o.txt"), "o").unwrap();
    fs::create_dir(root.join("y")).unwrap();
    // Entries are copied in name order: the link is made before the file fails.
    std::os::unix::fs::symlink(&outside, root.join("y/a-link")).unwrap();
    fs::write(root.join("y/b.txt"), "b").unwrap();
    fs::write(root.join("y/z-sealed.txt"), "z").unwrap();
    fs::set_permissions(
      root.join("y/z-sealed.txt"),
      fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    let result = cp(&root.join("y"), &root.join("d"), &root);
    fs::set_permissions(
      root.join("y/z-sealed.txt"),
      fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(matches!(result, Err(TransferError::Other(_))));
    assert!(fs::symlink_metadata(root.join("d/y")).is_err());
    assert_eq!(fs::read_to_string(outside.join("o.txt")).unwrap(), "o");
  }

  #[test]
  fn a_name_taken_just_before_the_copy_is_left_alone() {
    let (_dir, root) = project();
    fs::write(root.join("a.txt"), "new").unwrap();
    let dest = root.join("d");
    let plan = plan_transfer(Op::Copy, &root.join("a.txt"), &dest, &root, &same_disk).unwrap();
    let result = copy_after_check(&plan, &root.join("a.txt"), &dest, |taken| {
      fs::write(taken, "someone else").unwrap();
    });
    assert_eq!(result.map(|c| c.path), Err(TransferError::SameName));
    assert_eq!(
      fs::read_to_string(dest.join("a.txt")).unwrap(),
      "someone else"
    );
  }

  #[test]
  fn a_folder_taken_just_before_the_copy_is_left_alone() {
    let (_dir, root) = project();
    fs::create_dir(root.join("y")).unwrap();
    fs::write(root.join("y/a.txt"), "new").unwrap();
    let dest = root.join("d");
    let plan = plan_transfer(Op::Copy, &root.join("y"), &dest, &root, &same_disk).unwrap();
    let result = copy_after_check(&plan, &root.join("y"), &dest, |taken| {
      fs::create_dir(taken).unwrap();
      fs::write(taken.join("keep.txt"), "mine").unwrap();
    });
    assert_eq!(result.map(|c| c.path), Err(TransferError::SameName));
    assert_eq!(fs::read_to_string(dest.join("y/keep.txt")).unwrap(), "mine");
    assert!(!dest.join("y/a.txt").exists());
  }

  #[cfg(unix)]
  #[test]
  fn permissions_are_kept() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root) = project();
    fs::create_dir(root.join("y")).unwrap();
    fs::write(root.join("y/run.sh"), "x").unwrap();
    fs::write(root.join("y/ro.txt"), "x").unwrap();
    fs::set_permissions(root.join("y/run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(root.join("y/ro.txt"), fs::Permissions::from_mode(0o444)).unwrap();
    cp(&root.join("y"), &root.join("d"), &root).unwrap();
    let mode = |p: &str| fs::metadata(root.join(p)).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode("d/y/run.sh"), 0o755);
    assert_eq!(mode("d/y/ro.txt"), 0o444);
  }

  #[cfg(unix)]
  #[test]
  fn a_read_only_folder_is_copied_whole_and_stays_read_only() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root) = project();
    fs::create_dir(root.join("y")).unwrap();
    fs::write(root.join("y/a.txt"), "a").unwrap();
    fs::set_permissions(root.join("y"), fs::Permissions::from_mode(0o555)).unwrap();
    let result = cp(&root.join("y"), &root.join("d"), &root);
    let mode = fs::metadata(root.join("d/y")).map(|m| m.permissions().mode() & 0o777);
    // Let the temp folder be removed.
    fs::set_permissions(root.join("y"), fs::Permissions::from_mode(0o755)).unwrap();
    let _ = fs::set_permissions(root.join("d/y"), fs::Permissions::from_mode(0o755));
    assert!(result.is_ok());
    assert_eq!(mode.unwrap(), 0o555);
    assert_eq!(fs::read_to_string(root.join("d/y/a.txt")).unwrap(), "a");
  }

  #[cfg(unix)]
  #[test]
  fn a_pipe_in_the_folder_fails_the_copy_without_hanging() {
    let (_dir, root) = project();
    fs::create_dir(root.join("y")).unwrap();
    fs::write(root.join("y/a.txt"), "a").unwrap();
    let made = std::process::Command::new("mkfifo")
      .arg(root.join("y/pipe"))
      .status()
      .map(|s| s.success())
      .unwrap_or(false);
    if !made {
      return;
    }
    let result = cp(&root.join("y"), &root.join("d"), &root);
    assert!(matches!(result, Err(TransferError::Other(_))));
    assert!(fs::symlink_metadata(root.join("d/y")).is_err());
  }

  #[test]
  fn paths_are_matched_by_whole_segment() {
    assert!(within_with("/a/b/c", "/a/b", false, false));
    assert!(within_with("/a/b", "/a/b", false, false));
    assert!(!within_with("/a/bc", "/a/b", false, false));
    assert!(!within_with("/a", "/a/b", false, false));
    assert!(!within_with("/a/b", "", false, false));
    assert!(within_with("/A/B/c", "/a/b", true, false));
    assert!(!within_with("/A/B/c", "/a/b", false, false));
    assert!(within_with("C:\\p\\y/f", "C:/p/y", true, true));
  }

  #[test]
  fn the_error_reaches_the_page_as_a_kind() {
    assert_eq!(
      serde_json::to_string(&TransferError::CrossVolume).unwrap(),
      r#"{"kind":"CrossVolume"}"#
    );
    assert_eq!(
      serde_json::to_string(&TransferError::Other("disk full".to_string())).unwrap(),
      r#"{"kind":"Other","message":"disk full"}"#
    );
  }

  #[test]
  fn a_volume_is_the_same_for_everything_on_one_disk() {
    let (_dir, root) = project();
    fs::write(root.join("a.txt"), "x").unwrap();
    let on = |p: &Path| volume_of(p).unwrap();
    assert_eq!(on(&root), on(&root.join("a.txt")));
    assert_eq!(on(&root), on(&root.join("d")));
    assert!(path_volume(root.to_string_lossy().to_string()).is_ok());
    assert!(path_volume(root.join("nope").to_string_lossy().to_string()).is_err());
  }

  fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
  }
  /// Reparse data of a symbolic link: header, offsets, flags, path buffer.
  fn symlink_data(substitute: &str, print: &str) -> Vec<u8> {
    let (sub, prt) = (utf16(substitute), utf16(print));
    let mut data = vec![0x0C, 0, 0, 0xA0, 0, 0, 0, 0];
    for field in [0, sub.len(), sub.len(), prt.len()] {
      data.extend_from_slice(&(field as u16).to_le_bytes());
    }
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend(sub);
    data.extend(prt);
    data
  }

  #[test]
  fn a_symbolic_link_target_is_read_from_the_reparse_data() {
    assert_eq!(
      symlink_target(&symlink_data(r"\??\C:\x\y", r"C:\x\y")),
      Some(r"C:\x\y".to_string())
    );
    assert_eq!(
      symlink_target(&symlink_data(r"\??\C:\x\y", "")),
      Some(r"C:\x\y".to_string())
    );
    assert_eq!(
      symlink_target(&symlink_data(r"..\z", "")),
      Some(r"..\z".to_string())
    );
    assert_eq!(symlink_target(&[1, 2, 3]), None);
  }

  #[test]
  fn reparse_tags_are_told_apart() {
    assert_eq!(link_kind(0xA000_0003), LinkKind::Junction);
    assert_eq!(link_kind(0xA000_000C), LinkKind::Symlink);
    // A cloud placeholder and an unknown tag are neither.
    assert_eq!(link_kind(0x9000_001A), LinkKind::Other);
    assert_eq!(link_kind(0), LinkKind::Other);
    // A WSL link, a WCI reparse point and an AF_UNIX socket are copied as content.
    for tag in [0xA000_001D, 0x8000_0018, 0x8000_0023, 0xA000_0010] {
      assert_eq!(link_kind(tag), LinkKind::Other, "{tag:#x}");
    }
  }
}

#[cfg(all(test, windows))]
mod windows_tests {
  use super::*;
  use std::os::windows::fs::OpenOptionsExt;
  use tempfile::tempdir;

  fn same_disk(_: &Path, _: bool) -> Result<u64, String> {
    Ok(1)
  }

  fn tag_of(path: &Path) -> u32 {
    let data = win::read_reparse(path).unwrap();
    u32::from_le_bytes([data[0], data[1], data[2], data[3]])
  }

  #[test]
  fn reparse_tags_other_than_junctions_and_symlinks_are_content() {
    assert_eq!(link_kind(0xA000_0003), LinkKind::Junction);
    assert_eq!(link_kind(0xA000_000C), LinkKind::Symlink);
    for tag in [0xA000_001D, 0x8000_0018, 0x9000_001A, 0x8000_0023] {
      assert_eq!(link_kind(tag), LinkKind::Other, "{tag:#x}");
    }
  }

  #[test]
  fn a_volume_is_known_for_a_file_held_exclusively() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("held.txt");
    let held = fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .share_mode(0)
      .open(&file)
      .unwrap();
    assert_eq!(volume_of(&file).unwrap(), volume_of(dir.path()).unwrap());
    drop(held);
  }

  #[test]
  fn a_junction_is_copied_as_a_junction() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("p");
    fs::create_dir_all(root.join("y")).unwrap();
    fs::create_dir_all(root.join("d")).unwrap();
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("o.txt"), "o").unwrap();
    let made = std::process::Command::new("cmd")
      .args(["/C", "mklink", "/J"])
      .arg(root.join("y").join("jn"))
      .arg(&outside)
      .output()
      .unwrap();
    assert!(made.status.success());
    let copied = copy_to(&root.join("y"), &root.join("d"), &root, &same_disk).unwrap();
    assert!(copied.skipped.is_empty());
    let copy = root.join("d").join("y").join("jn");
    assert_eq!(link_kind(tag_of(&copy)), LinkKind::Junction);
    assert_eq!(fs::read_to_string(copy.join("o.txt")).unwrap(), "o");
    assert_eq!(fs::read_to_string(outside.join("o.txt")).unwrap(), "o");
  }

  #[test]
  fn a_symbolic_link_the_user_may_not_make_is_skipped_and_noted() {
    let dir = tempdir().unwrap();
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let link = dir.path().join("ln");
    if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
      return;
    }
    let denied = |_: &Path, _: &Path, _: bool| {
      Err(io::Error::from_raw_os_error(win::ERROR_PRIVILEGE_NOT_HELD))
    };
    let copy = dir.path().join("copy");
    assert_eq!(
      copy_link_with(&link, &copy, &denied).unwrap(),
      LinkOutcome::NoPrivilege
    );
    assert!(fs::symlink_metadata(&copy).is_err());
    let broken = |_: &Path, _: &Path, _: bool| Err(io::Error::from_raw_os_error(5));
    assert!(copy_link_with(&link, &copy, &broken).is_err());
  }

  #[test]
  fn symbolic_links_keep_their_type_and_target() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("p");
    fs::create_dir_all(root.join("y")).unwrap();
    fs::create_dir_all(root.join("d")).unwrap();
    fs::write(dir.path().join("t.txt"), "t").unwrap();
    fs::create_dir(dir.path().join("td")).unwrap();
    let file_link = root.join("y").join("fl");
    let dir_link = root.join("y").join("dl");
    if std::os::windows::fs::symlink_file(dir.path().join("t.txt"), &file_link).is_err() {
      return;
    }
    std::os::windows::fs::symlink_dir(dir.path().join("td"), &dir_link).unwrap();
    let copied = copy_to(&root.join("y"), &root.join("d"), &root, &same_disk).unwrap();
    assert!(copied.skipped.is_empty());
    let copy = root.join("d").join("y");
    use std::os::windows::fs::FileTypeExt;
    assert!(fs::symlink_metadata(copy.join("fl"))
      .unwrap()
      .file_type()
      .is_symlink_file());
    assert!(fs::symlink_metadata(copy.join("dl"))
      .unwrap()
      .file_type()
      .is_symlink_dir());
    assert_eq!(
      fs::read_link(copy.join("dl")).unwrap(),
      dir.path().join("td")
    );
  }
}
