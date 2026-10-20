// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Exclusive lock on a snapshots folder, so two apps (or two copies of this
//! app) pointed at the same folder cannot both write to it. The lock lives on
//! a hidden file inside the folder and is held for as long as the returned
//! `File` is alive; the OS drops it when the process dies.

use std::fs::{File, OpenOptions};
use std::path::Path;

pub const LOCK_FILE_NAME: &str = ".snapshots.lock";
/// Why a folder could not be locked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockError {
  /// Another process holds the lock.
  Busy,
  /// The file system has no lock support (some NAS / SMB / NFS shares).
  Unsupported,
  /// Anything else, such as a lock file that cannot be created or opened.
  Other,
}
/// A failed lock attempt: the class decides what happens next, the detail is
/// only for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockFailure {
  pub kind: LockError,
  pub detail: String,
}

impl LockFailure {
  fn from_io(e: &std::io::Error) -> Self {
    LockFailure {
      kind: e.raw_os_error().map_or(LockError::Other, classify),
      detail: e.to_string(),
    }
  }
}
/// Maps a raw OS error code from opening or locking the file to a `LockError`.
#[cfg(unix)]
pub fn classify(code: i32) -> LockError {
  // An if-chain, not a match: several of these codes are equal on some systems.
  if code == libc::EWOULDBLOCK {
    LockError::Busy
  } else if [libc::ENOTSUP, libc::EOPNOTSUPP, libc::ENOSYS, libc::ENOLCK].contains(&code) {
    LockError::Unsupported
  } else {
    LockError::Other
  }
}

#[cfg(windows)]
pub fn classify(code: i32) -> LockError {
  use windows_sys::Win32::Foundation::{
    ERROR_CALL_NOT_IMPLEMENTED, ERROR_INVALID_FUNCTION, ERROR_LOCK_VIOLATION, ERROR_NOT_SUPPORTED,
    ERROR_SHARING_VIOLATION,
  };
  match code as u32 {
    ERROR_LOCK_VIOLATION | ERROR_SHARING_VIOLATION => LockError::Busy,
    ERROR_NOT_SUPPORTED | ERROR_INVALID_FUNCTION | ERROR_CALL_NOT_IMPLEMENTED => {
      LockError::Unsupported
    }
    _ => LockError::Other,
  }
}
/// Takes the exclusive, non-blocking lock on `dir`'s lock file, creating the
/// file when it is missing. `dir` must exist.
pub fn try_lock(dir: &Path) -> Result<File, LockFailure> {
  let file = OpenOptions::new()
    .read(true)
    .write(true)
    .create(true)
    .truncate(false)
    .open(dir.join(LOCK_FILE_NAME))
    .map_err(|e| LockFailure::from_io(&e))?;
  lock_exclusive_nonblocking(&file).map_err(|e| LockFailure::from_io(&e))?;
  Ok(file)
}

#[cfg(unix)]
fn lock_exclusive_nonblocking(file: &File) -> std::io::Result<()> {
  use std::os::fd::AsRawFd;
  loop {
    // Safety: flock on an fd this File owns.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
      return Ok(());
    }
    let e = std::io::Error::last_os_error();
    if e.kind() != std::io::ErrorKind::Interrupted {
      return Err(e);
    }
  }
}

#[cfg(windows)]
fn lock_exclusive_nonblocking(file: &File) -> std::io::Result<()> {
  use std::os::windows::io::AsRawHandle;
  use windows_sys::Win32::Storage::FileSystem::{
    LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
  };
  use windows_sys::Win32::System::IO::OVERLAPPED;
  // Safety: an all-zero OVERLAPPED is the documented "offset 0, no event" form,
  // and the handle belongs to this File.
  let ok = unsafe {
    let mut overlapped: OVERLAPPED = std::mem::zeroed();
    LockFileEx(
      file.as_raw_handle(),
      LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
      0,
      1,
      0,
      &mut overlapped,
    )
  };
  if ok == 0 {
    return Err(std::io::Error::last_os_error());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  #[test]
  fn a_held_lock_blocks_a_second_one_until_it_is_released() {
    let dir = tempdir().unwrap();
    let held = try_lock(dir.path()).unwrap();
    let second = try_lock(dir.path()).unwrap_err();
    assert_eq!(second.kind, LockError::Busy);
    drop(held);
    assert!(try_lock(dir.path()).is_ok());
  }

  #[test]
  fn locking_a_missing_folder_is_other() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("nope");
    assert_eq!(try_lock(&missing).unwrap_err().kind, LockError::Other);
  }

  #[cfg(unix)]
  #[test]
  fn unix_errors_are_classified() {
    assert_eq!(classify(libc::EWOULDBLOCK), LockError::Busy);
    assert_eq!(classify(libc::EAGAIN), LockError::Busy);
    assert_eq!(classify(libc::ENOTSUP), LockError::Unsupported);
    assert_eq!(classify(libc::EOPNOTSUPP), LockError::Unsupported);
    assert_eq!(classify(libc::ENOSYS), LockError::Unsupported);
    assert_eq!(classify(libc::ENOLCK), LockError::Unsupported);
    assert_eq!(classify(libc::EACCES), LockError::Other);
    assert_eq!(classify(libc::EROFS), LockError::Other);
    assert_eq!(classify(libc::EIO), LockError::Other);
  }

  #[cfg(windows)]
  #[test]
  fn windows_errors_are_classified() {
    assert_eq!(classify(33), LockError::Busy);
    assert_eq!(classify(32), LockError::Busy);
    assert_eq!(classify(50), LockError::Unsupported);
    assert_eq!(classify(1), LockError::Unsupported);
    assert_eq!(classify(120), LockError::Unsupported);
    assert_eq!(classify(5), LockError::Other);
    assert_eq!(classify(112), LockError::Other);
  }
}
