// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Read a file as UTF-8 text.
pub fn read_text(path: &Path) -> Result<String, String> {
  fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Attempts for the final rename step of `write_bytes_atomic`. On Windows a
/// cloud-sync client or antivirus can transiently hold the target file open
/// (a sharing violation) for a few tens of milliseconds; retrying rides that
/// out instead of surfacing a spurious failure. Elsewhere a rename failure is
/// not transient, so a single attempt (no retry, no sleep) keeps behavior
/// unchanged.
#[cfg(target_os = "windows")]
const RENAME_RETRY_ATTEMPTS: u32 = 5;
#[cfg(not(target_os = "windows"))]
const RENAME_RETRY_ATTEMPTS: u32 = 1;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(50);

/// A save aimed at something this user may not write answers with exactly this,
/// so the frontend can say why instead of showing a raw errno. Protocol value.
pub const READ_ONLY_DESTINATION: &str = "read-only-destination";

/// Why one file in a data folder was not loaded. Only the case is named here;
/// the wording belongs to the frontend, so snapshots, themes and locales all
/// report through the same set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
  /// Not a `.json` file at all.
  NotJson,
  /// The file could not be read (permissions, an I/O error).
  Unreadable,
  /// The bytes are not the JSON this store expects.
  Unparsable,
  /// It parsed, but a field the store requires is not usable.
  Invalid,
  /// It carries an id that does not match its file name.
  ForeignId,
  /// Its id was already claimed by a file loaded earlier.
  DuplicateId,
}

/// One file a loader could not use. The file name is enough to identify it to
/// a person, and every action offered on it goes back through a command that
/// resolves the folder itself, so no path leaves the core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
  pub name: String,
  pub reason: SkipReason,
}

/// What one `load_dir` found: the files it could use, and the ones it could not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded<T> {
  pub items: Vec<T>,
  pub skipped: Vec<SkippedFile>,
}

/// Whether a directory entry is something no user put there as data, and so is
/// never worth reporting as unusable. Everything hidden is excluded rather than
/// enumerated, which covers three cases at once: `.DS_Store` (recreated the
/// moment a file browser displays the folder, so reporting it would produce a
/// notice that cannot be cleared), an iCloud `.name.icloud` placeholder (the
/// real file is intact, just evicted), and this module's own `.name.tmp`
/// staging file left behind by an interrupted write. `Thumbs.db` and
/// `desktop.ini` are the Windows equivalents, which are not hidden by name.
pub fn is_ignored_file(name: &str) -> bool {
  name.starts_with('.')
    || name.eq_ignore_ascii_case("Thumbs.db")
    || name.eq_ignore_ascii_case("desktop.ini")
}

/// Call `f` up to `attempts` times (the first try plus up to `attempts - 1`
/// retries), sleeping `delay` between attempts, returning the first success or
/// the last error. `attempts` must be at least 1.
fn retry<T, E>(
  mut attempts: u32,
  delay: Duration,
  mut f: impl FnMut() -> Result<T, E>,
) -> Result<T, E> {
  debug_assert!(attempts >= 1);
  loop {
    match f() {
      Ok(v) => return Ok(v),
      Err(e) => {
        if attempts <= 1 {
          return Err(e);
        }
        attempts -= 1;
        std::thread::sleep(delay);
      }
    }
  }
}

/// Atomically write raw bytes to `path`: write to a temp file in the same
/// directory, fsync it, rename over the target, then fsync the directory so the
/// rename itself is durable. Without the fsyncs, rename only gives atomicity
/// against a concurrent reader, not against power loss: a crash could leave the
/// target's directory entry pointing at a temp file whose bytes never reached
/// disk, after the previous content is already gone.
///
/// Cost measured on this machine (2026-08-20), with the real `sync_all` (macOS
/// uses `F_FULLFSYNC`, not plain `fsync`): ~8 ms per write, flat regardless of
/// payload size, versus ~0.1-0.3 ms without. Affordable for every save path in
/// this app; no config switch, decide again only if that number changes.
///
/// Durability against power loss cannot be exercised by a unit test (it needs
/// an actual crash mid-write), so there is no automated coverage for that
/// property itself — only for the fact that a normal write still lands correctly.
///
/// `rename` replaces a directory entry, not file content, so it is only safe
/// when the destination *is* the identity the user cares about. When the
/// destination is a symlink or has other hard links, renaming over it detaches
/// the link from the new content (the link keeps pointing at the old inode,
/// which the rename left untouched) instead of updating what the user actually
/// opened. Vim, Neovim and VS Code all special-case this the same way: rename
/// only when the target is not a link.
/// Unix modes for data that is the app's own and nobody else's business. Used
/// for snapshots: a sticky note has no file of its own, so its snapshot is the
/// only copy of text the user has not saved anywhere.
///
/// The directory mode is the one with specification backing — XDG says to create
/// an application's data directory `0700` — and it is what actually keeps other
/// local users out, since without `x` on the directory they cannot resolve a
/// path under it at all. The file mode is the second layer, for when the
/// directory's mode is later widened by something else (a sync client, a backup
/// restore, the user's own `chmod` on a parent).
///
/// This protects a real filesystem on a shared path and nothing else. exFAT
/// synthesises modes from mount options, and a File Provider cloud root rejects
/// `chmod` outright while already sitting under a `0700` parent. Nothing in the
/// UI may claim snapshots are "protected".
#[derive(Clone, Copy)]
struct PrivateModes {
  file: u32,
  dir: u32,
}

const PRIVATE: PrivateModes = PrivateModes {
  file: 0o600,
  dir: 0o700,
};

/// `fs::create_dir_all`, but giving every directory this call creates `mode`.
/// A directory that already exists is left exactly as it is.
fn create_dir_all_with_mode(dir: &Path, mode: Option<u32>) -> std::io::Result<()> {
  #[cfg(unix)]
  if let Some(mode) = mode {
    use std::os::unix::fs::DirBuilderExt;
    return fs::DirBuilder::new().recursive(true).mode(mode).create(dir);
  }
  let _ = mode;
  fs::create_dir_all(dir)
}

pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
  write_bytes_atomic_with(path, bytes, None)
}

/// `write_bytes_atomic` plus the mode to give a file and a directory this call
/// has to create. Only applies on Unix, only to things that did not exist yet:
/// an existing file keeps its own mode and an existing directory is left alone,
/// per the XDG rule that a directory already there is not re-permissioned.
/// Failing to apply a mode is never fatal — a filesystem that cannot store one
/// (exFAT, a File Provider cloud root) still gets the write.
fn write_bytes_atomic_with(
  path: &Path,
  bytes: &[u8],
  private: Option<PrivateModes>,
) -> Result<(), String> {
  let dir = path
    .parent()
    .ok_or_else(|| "path has no parent directory".to_string())?;
  // Only create what is missing. A sandboxed process can be allowed to write a
  // file the user opened while `create_dir_all` on the folder it lives in comes
  // back denied, and treating that as fatal would refuse a save that is about
  // to succeed.
  if !dir.is_dir() {
    create_dir_all_with_mode(dir, private.map(|m| m.dir)).map_err(|e| e.to_string())?;
  }
  replace_with(path, "", false, private.map(|m| m.file), |file| {
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
  })
}

/// Build the replacement for `dest` with `fill`, then put it in `dest`'s place
/// while keeping whatever links point there.
///
/// The single implementation of that rule. Every writer in the app goes through
/// here, so a destination one of them protects cannot be quietly detached by
/// another -- which is exactly what happened while the rule lived in three
/// hand-copied places and the third copy was never written.
///
/// `fill` receives the staged file and writes the whole new content into it,
/// fsyncing before it returns. It is called once, after the staging location is
/// settled, so a staging that is refused costs nothing.
pub fn replace_with<F>(
  dest: &Path,
  label: &str,
  exclusive: bool,
  new_mode: Option<u32>,
  fill: F,
) -> Result<(), String>
where
  F: FnOnce(&mut fs::File) -> Result<(), String>,
{
  let kind = classify(dest);
  // A symlink is only a name: the file it points at is the one being replaced,
  // so the replacement is built beside that target and renamed onto it. The
  // link is left exactly as it was -- still a link, still pointing where it
  // pointed -- and the swap keeps its power-loss atomicity. This is the only
  // kind with somewhere else to go if the staging is refused, hence first.
  if let Destination::Symlink(target) = &kind {
    match stage(target, label, exclusive, new_mode) {
      Ok((mut file, staged)) => {
        if let Err(e) = fill(&mut file) {
          drop(file);
          staged.discard();
          return Err(e);
        }
        drop(file);
        return commit(staged, target);
      }
      // A refusal the user needs words for, not an errno from a second attempt.
      Err(e) if e == READ_ONLY_DESTINATION => return Err(e),
      // Under the sandbox the grant covers the link the user picked, not the
      // folder its target lives in, so there is nowhere beside the target to
      // build the replacement (measured). Nothing has been touched yet, and
      // writing through the link itself is still allowed, so fall through.
      Err(_) => {}
    }
  }
  let (mut file, staged) = stage(dest, label, exclusive, new_mode)?;
  if let Err(e) = fill(&mut file) {
    drop(file);
    staged.discard();
    return Err(e);
  }
  drop(file);
  if matches!(kind, Destination::Plain) {
    return commit(staged, dest);
  }
  // Shared, or a symlink the sandbox would not let us stage beside. The staged
  // file is written and fsynced *before* the destination is touched, on
  // purpose: pouring truncates first, which leaves the destination briefly
  // short, and if the process dies in that window the complete new content
  // still exists in the staged file. Nothing recovers from that automatically
  // and nothing is meant to -- the file being there is enough to salvage by
  // hand. The window is not instantaneous either: measured at 0.06s for
  // 100 MiB and 0.5s for 4 GiB on an internal SSD, longer on slower media.
  //
  // What it costs is the power-loss atomicity the rename gives everyone else.
  // That is an OS-level limit rather than a shortcut: no filesystem this app
  // ships on can replace an inode's contents atomically, so holding several
  // names on one inode together and surviving a crash mid-write cannot both be
  // had. `vim` makes the same call by default (`backupcopy=yes`).
  //
  // Kept on failure on purpose: the destination is truncated at that point and
  // the staged file is the only complete copy of the new content left.
  copy_into_place(staged.path(), dest)?;
  staged.discard();
  Ok(())
}

/// Where a replacement file is being built before it takes the destination's
/// place. Shared by every writer in the app — `write_bytes_atomic_with` here,
/// `range_edit::splice_at` and `windowed::write_document` — so that all three
/// answer the sandbox the same way instead of drifting apart.
enum Spot {
  /// Beside the destination, to be renamed over it. The normal case, and the
  /// only one outside macOS.
  Sibling,
  /// In the item-replacement directory the system hands out for the
  /// destination's volume, because the destination's own folder refuses new
  /// files: the macOS App Sandbox grants a file the user opened by hand without
  /// granting the folder it sits in. Finished with `replaceItemAtURL:`, which
  /// works off the grant on the destination file itself.
  #[cfg(target_os = "macos")]
  Replacement(PathBuf),
}

/// A replacement file in progress: where it is, and how it has to land.
pub struct Staged {
  path: PathBuf,
  spot: Spot,
}

impl Staged {
  /// The path to write the replacement content to.
  pub fn path(&self) -> &Path {
    &self.path
  }

  /// Throw the staged file away. Never fails: this runs on paths that are
  /// already reporting some other error, and a leftover temp file must not
  /// replace that error with a less useful one.
  pub fn discard(self) {
    match self.spot {
      Spot::Sibling => {
        let _ = fs::remove_file(&self.path);
      }
      #[cfg(target_os = "macos")]
      Spot::Replacement(dir) => {
        let _ = fs::remove_dir_all(&dir);
      }
    }
  }
}

/// Create the file that will take `dest`'s place. Beside `dest` when that is
/// allowed; see `Spot` for the two macOS sandbox routes taken when it is not.
///
/// `label` goes into the staged file's name, for callers that need two writes
/// to the same destination to stage under different names. `exclusive` refuses
/// to reuse an existing staged file rather than truncating it, for callers that
/// treat a colliding temp as a bug worth reporting.
pub fn stage(
  dest: &Path,
  label: &str,
  exclusive: bool,
  new_mode: Option<u32>,
) -> Result<(fs::File, Staged), String> {
  if !writable(dest) {
    return Err(READ_ONLY_DESTINATION.to_string());
  }
  let dir = dest
    .parent()
    .ok_or_else(|| "path has no parent directory".to_string())?;
  let file_name = dest
    .file_name()
    .and_then(|n| n.to_str())
    .ok_or_else(|| "path has no file name".to_string())?;
  let sibling = dir.join(format!(".{file_name}{label}.tmp"));
  let refused = match create_temp_file(&sibling, dest, new_mode, exclusive) {
    Ok(file) => {
      return Ok((
        file,
        Staged {
          path: sibling,
          spot: Spot::Sibling,
        },
      ));
    }
    Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => e,
    Err(e) => return Err(e.to_string()),
  };
  #[cfg(target_os = "macos")]
  {
    let _ = refused;
    // A destination that does not exist yet is not created here: see `commit`,
    // which makes it exist immediately before the swap so that a write that
    // fails part way leaves nothing at all under the name the user chose.
    if !dest.exists() || dest.is_file() {
      let replacement = macos::item_replacement_dir(dest)?;
      let path = replacement.join(file_name);
      let file = create_temp_file(&path, dest, new_mode, exclusive).map_err(|e| {
        let _ = fs::remove_dir_all(&replacement);
        e.to_string()
      })?;
      return Ok((
        file,
        Staged {
          path,
          spot: Spot::Replacement(replacement),
        },
      ));
    }
    Err(format!(
      "{} is not a file that can be replaced",
      dest.display()
    ))
  }
  #[cfg(not(target_os = "macos"))]
  Err(refused.to_string())
}

/// Put the staged file in `dest`'s place, carrying over what the swap would
/// otherwise drop.
pub fn commit(staged: Staged, dest: &Path) -> Result<(), String> {
  match staged.spot {
    Spot::Sibling => {
      // Read while the destination still exists; the part that has to wait
      // until after the swap comes back in `carried`.
      let carried = capture_access_metadata(dest, &staged.path);
      wear_destination_mode(dest, &staged.path);
      let renamed = retry(RENAME_RETRY_ATTEMPTS, RENAME_RETRY_DELAY, || {
        fs::rename(&staged.path, dest)
      });
      if let Err(refused) = renamed {
        // A destination carrying `deny delete` refuses to have its directory
        // entry replaced while staying perfectly writable itself, and answers
        // exactly this. Pour the new content into it instead.
        // Only a file that is there and refuses to be replaced. Windows answers
        // the same PermissionDenied for a rename onto a *directory*, and
        // pouring into one leaves the staged file behind for nothing.
        if refused.kind() == std::io::ErrorKind::PermissionDenied && dest.is_file() {
          // Pouring truncates first, so a failure part way leaves the
          // destination short and the staged file holding the only whole copy.
          // It stays where it is in that case, exactly as `copy_into_place`
          // leaves it for a linked destination.
          copy_into_place(&staged.path, dest)?;
          // The staged file wears a copy of the destination's ACL, and a
          // `deny delete` entry among them refuses its own removal.
          clear_acl(&staged.path);
          let _ = fs::remove_file(&staged.path);
          return Ok(());
        }
        // Nothing was destroyed — the destination still holds its old content —
        // so the staged file is only clutter now. Leaving it would hide a
        // complete copy of the document beside the original under a dot name.
        let _ = fs::remove_file(&staged.path);
        return Err(refused.to_string());
      }
      carried.apply_to(dest);
      // Sync the parent directory so the rename's directory-entry update is
      // durable too, not just the file content. On Windows a directory can't be
      // opened as a File without FILE_FLAG_BACKUP_SEMANTICS, so this fails
      // there — expected and harmless, since NTFS journals the rename itself.
      if let Some(dir) = dest.parent() {
        if let Ok(handle) = fs::File::open(dir) {
          let _ = handle.sync_all();
        }
      }
      Ok(())
    }
    #[cfg(target_os = "macos")]
    Spot::Replacement(replacement) => {
      // `replaceItemAtURL:` needs something to replace, and this route is also
      // how a file the user just named in a save panel gets written: the panel
      // grants that exact path, so creating it is allowed even though creating
      // a sibling beside it is not. Created here rather than when staging
      // started, so that a write that failed part way leaves nothing behind
      // under the name the user chose.
      let created = !dest.exists();
      if created {
        if let Err(e) = fs::File::create(dest) {
          let _ = fs::remove_dir_all(&replacement);
          return Err(e.to_string());
        }
      }
      // Same carry as the rename path, and needed for the same reason:
      // `replaceItemAtURL:` brings the destination's own extended attributes
      // across but drops `com.apple.quarantine` specifically, which would let
      // an edit-and-save launder a downloaded file's provenance. Copying the
      // attributes onto the staged file first survives the swap (measured).
      //
      // What it cannot keep byte for byte is the rest of that mark. The App
      // Sandbox stamps its own quarantine record on every file the app writes
      // — measured: the app's own snapshots inside its container come out
      // marked, and a file that had no mark at all comes back
      // `0082;<now>;Note&Pad;` with no event id — and that stamp lands on top,
      // refreshing the flags, the time and the agent name. Writing the original
      // value back afterwards is not open to us either: `setxattr` for
      // `com.apple.quarantine` is refused inside the sandbox (measured: EPERM),
      // which is the rule that stops an app clearing its own quarantine. What
      // the carry does buy is the event id: a marked file keeps the id that
      // Launch Services looks the download up by, so where the file came from
      // is still answerable. A file saved by the unsandboxed build never
      // reaches here and keeps its mark exactly.
      let carried = capture_access_metadata(dest, &staged.path);
      wear_destination_mode(dest, &staged.path);
      let result = macos::try_replace(
        dest,
        &staged.path,
        objc2_foundation::NSFileManagerItemReplacementOptions::empty(),
      )
      .or_else(|refused| copy_into_place(&staged.path, dest).map_err(|_| refused));
      // The replacement directory is ours either way: `replaceItemAtURL:`
      // consumes the staged file on success and leaves it there on failure —
      // and a staged file wearing the destination's `deny delete` entry refuses
      // to go until that copy comes off.
      clear_acl(&staged.path);
      let _ = fs::remove_dir_all(&replacement);
      if let Err(e) = result {
        // That empty file was ours, made a moment ago only so the swap had
        // something to replace. A save-as that got no further must not leave a
        // nought-byte file sitting under the name the user chose.
        if created {
          let _ = fs::remove_file(dest);
        }
        return Err(e);
      }
      carried.apply_to(dest);
      Ok(())
    }
  }
}

#[cfg(target_os = "macos")]
mod macos {
  use objc2_foundation::{
    NSFileManager, NSFileManagerItemReplacementOptions, NSSearchPathDirectory,
    NSSearchPathDomainMask, NSString, NSURL,
  };
  use std::path::{Path, PathBuf};

  fn url(path: &Path) -> Result<objc2::rc::Retained<NSURL>, String> {
    let path = path
      .to_str()
      .ok_or_else(|| "path is not UTF-8".to_string())?;
    Ok(NSURL::fileURLWithPath(&NSString::from_str(path)))
  }

  /// A directory on the same volume as `dest` that this process may write to,
  /// even when `dest`'s own directory is out of bounds. The system makes a
  /// fresh one per call, so the caller owns it and removes it when done.
  pub(super) fn item_replacement_dir(dest: &Path) -> Result<PathBuf, String> {
    let dest_url = url(dest)?;
    let directory = NSFileManager::defaultManager()
      .URLForDirectory_inDomain_appropriateForURL_create_error(
        NSSearchPathDirectory::ItemReplacementDirectory,
        NSSearchPathDomainMask::UserDomainMask,
        Some(&dest_url),
        true,
      )
      .map_err(|e| e.localizedDescription().to_string())?;
    Ok(PathBuf::from(
      directory
        .path()
        .ok_or_else(|| "the item-replacement directory has no path".to_string())?
        .to_string(),
    ))
  }

  /// Swap `staged` into `dest`'s place through the grant on `dest` itself: the
  /// sandbox hands over the file the user opened, not the folder it sits in, so
  /// this is the only way a save reaches it. A destination this user may not
  /// write never gets here — `stage` turns that away before anything is
  /// written — and one that refuses to be replaced is poured into instead, the
  /// same way the rename path handles it.
  pub(super) fn try_replace(
    dest: &Path,
    staged: &Path,
    options: NSFileManagerItemReplacementOptions,
  ) -> Result<(), String> {
    let (dest_url, staged_url) = (url(dest)?, url(staged)?);
    NSFileManager::defaultManager()
      .replaceItemAtURL_withItemAtURL_backupItemName_options_resultingItemURL_error(
        &dest_url,
        &staged_url,
        None,
        options,
        None,
      )
      .map_err(|e| e.localizedDescription().to_string())
  }
}

/// Take the owner's write bit back off the staged file, once everything that
/// needed it is done. See `create_temp_file` for why it was on. A destination
/// that does not exist yet has no mode to wear, and the staged file keeps
/// whatever the caller asked for.
#[cfg(unix)]
fn wear_destination_mode(dest: &Path, staged: &Path) {
  use std::os::unix::fs::PermissionsExt;

  let Ok(mode) = fs::metadata(dest).map(|m| m.permissions().mode()) else {
    return;
  };
  // Best effort, like every other piece of carried metadata: a filesystem that
  // cannot store a mode still gets the write.
  let _ = fs::set_permissions(staged, fs::Permissions::from_mode(mode & 0o7777));
}

/// Nothing to do where there is no mode to carry.
#[cfg(not(unix))]
fn wear_destination_mode(_dest: &Path, _staged: &Path) {}

/// Create the temp file that will be renamed onto `dest`. On Unix, when
/// `dest` already exists, the temp file is created *with `dest`'s mode from
/// the start*, via `OpenOptionsExt::mode` — not created with the default mode
/// and `chmod`'d afterward.
///
/// Plus the owner's write bit, always, which `commit` takes off again just
/// before the swap. Without it a read-only destination produces a read-only
/// staged file, and `setxattr` needs write permission: every extended
/// attribute the destination carried would fail to copy across, silently, and
/// a downloaded file would come out of a save with its provenance laundered.
/// The bit is the owner's own and is gone before the file is visible under the
/// destination's name, so it never widens what anyone else can reach. Doing it after leaves a window, between the
/// content write and the `chmod`, where the temp file already holds the
/// (possibly secret) content at the default `0o666 & !umask` mode — typically
/// `0644`, world-readable — even though the destination was `0600`. Creating
/// at the right mode means the temp file is never wider open than the
/// original. When `dest` does not exist yet, `new_mode` decides: `None` keeps
/// the default `0o666 & !umask`, and a caller that wants its own files created
/// narrower passes the mode it wants. An existing destination always wins over
/// `new_mode`, so a mode the user chose by hand is never widened or narrowed.
#[cfg(unix)]
fn create_temp_file(
  tmp: &Path,
  dest: &Path,
  new_mode: Option<u32>,
  exclusive: bool,
) -> std::io::Result<fs::File> {
  use std::os::unix::fs::OpenOptionsExt;

  let mode = fs::metadata(dest)
    .ok()
    .map(|m| {
      use std::os::unix::fs::PermissionsExt;
      m.permissions().mode()
    })
    .or(new_mode);
  let mut opts = fs::OpenOptions::new();
  opts.write(true);
  if exclusive {
    opts.create_new(true);
  } else {
    opts.create(true).truncate(true);
  }
  if let Some(mode) = mode {
    opts.mode(mode | 0o200);
  }
  opts.open(tmp)
}

/// Windows has no equivalent knob here: `std::fs::set_permissions` on Windows
/// maps to `SetFileAttributes`, which only toggles the read-only attribute
/// and has nothing to do with the security descriptor (DACL) that actually
/// governs access there. There is no std-level "mode" to carry across at
/// creation time the way `OpenOptionsExt::mode` does on Unix. Copying the
/// DACL itself is a separate, larger undertaking - see the filed issue.
#[cfg(windows)]
fn create_temp_file(
  tmp: &Path,
  _dest: &Path,
  _new_mode: Option<u32>,
  exclusive: bool,
) -> std::io::Result<fs::File> {
  create_plain(tmp, exclusive)
}

#[cfg(not(any(unix, windows)))]
fn create_temp_file(
  tmp: &Path,
  _dest: &Path,
  _new_mode: Option<u32>,
  exclusive: bool,
) -> std::io::Result<fs::File> {
  create_plain(tmp, exclusive)
}

/// The platforms with no mode to carry share this.
#[cfg(not(unix))]
fn create_plain(tmp: &Path, exclusive: bool) -> std::io::Result<fs::File> {
  let mut opts = fs::OpenOptions::new();
  opts.write(true);
  if exclusive {
    opts.create_new(true);
  } else {
    opts.create(true).truncate(true);
  }
  opts.open(tmp)
}

/// Overwrite `path` in place, following a symlink to its target rather than
/// replacing the link itself. Truncates first, so callers must have the full
/// new content already durable elsewhere (see the temp-file comment above).
/// Pour the staged file into `dest` without replacing it, keeping the inode and
/// everything hanging off it. The way out when the directory entry cannot be
/// swapped: a `deny delete` entry on the destination refuses `rename` (errno 13)
/// and `replaceItemAtURL:` alike, while the file's own content stays perfectly
/// writable — measured. The user who set that entry meant "do not replace this
/// file", not "do not edit it".
///
/// The cost is the one every linked destination carries: see `replace_with`
/// destination: truncating leaves the file briefly empty, so this is not
/// power-loss atomic. The staged file is the complete copy while that window is
/// open, which is why a failure here leaves it where it is.
pub fn copy_into_place(staged: &Path, dest: &Path) -> Result<(), String> {
  let mut source = fs::File::open(staged).map_err(|e| e.to_string())?;
  let mut out = fs::OpenOptions::new()
    .write(true)
    .truncate(true)
    .open(dest)
    .map_err(|e| e.to_string())?;
  std::io::copy(&mut source, &mut out).map_err(|e| e.to_string())?;
  out.sync_all().map_err(|e| e.to_string())?;
  Ok(())
}

/// Whether this user may write the file a save is aimed at.
///
/// A file the user marked read-only must not be saved over, and nothing else in
/// the write path notices. `rename` is a directory operation — it never
/// consults the permissions of the file it replaces — so a 0444 file was being
/// replaced as readily as any other. `access` is the check rather than the mode
/// bits because it answers for the caller's real identity and folds in the ACL.
///
/// Only an existing destination is judged. A name that is not taken yet has no
/// permissions to respect, and asking its folder instead would be wrong where
/// it matters most: the App Sandbox grants the exact path a save panel handed
/// back while refusing the folder around it (measured), so a folder-level guess
/// would turn away every save-as in the store build. A folder that really does
/// refuse is caught a moment later, by the staging attempt, with the error the
/// filesystem gave.
#[cfg(unix)]
pub fn writable(dest: &Path) -> bool {
  use std::ffi::CString;
  use std::os::unix::ffi::OsStrExt;

  const W_OK: std::ffi::c_int = 2;
  if !dest.exists() {
    return true;
  }
  let Ok(path) = CString::new(dest.as_os_str().as_bytes()) else {
    return false;
  };
  // Contained unsafe: a permission query against a borrowed, NUL-terminated
  // path that outlives the call. Nothing is written and nothing is retained.
  unsafe { ffi::access(path.as_ptr(), W_OK) == 0 }
}

/// Windows keeps this as a file attribute. A destination that is not there yet
/// is left to the staging attempt, for the same reason as above.
#[cfg(windows)]
pub fn writable(dest: &Path) -> bool {
  match fs::metadata(dest) {
    Ok(meta) => !meta.permissions().readonly(),
    Err(_) => true,
  }
}

#[cfg(not(any(unix, windows)))]
pub fn writable(_dest: &Path) -> bool {
  true
}

/// Link-behaviour helpers shared by the tests of all three writers, so the one
/// rule they now share is checked the same way in each of them.
#[cfg(test)]
pub(crate) mod linktest {
  use std::path::Path;

  /// Point `link` at `target`, answering false when this platform will not make
  /// a symlink for an unprivileged process -- Windows wants Developer Mode or
  /// an administrator, so tests there skip instead of failing.
  pub(crate) fn symlink(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
      std::os::windows::fs::symlink_file(target, link).is_ok()
    }
    #[cfg(not(any(unix, windows)))]
    {
      let _ = (target, link);
      false
    }
  }

  /// How many names share the file at `path`. Reads the same counter the
  /// writers decide on, so a test failure means the writers were wrong rather
  /// than the test measuring something else.
  pub(crate) fn links(path: &Path) -> u64 {
    let meta = std::fs::metadata(path).expect("the file is there");
    super::hard_link_count(&meta, path)
  }
}

/// What finishing a write to a path has to do to leave its links intact.
pub enum Destination {
  /// Nothing to protect: rename the replacement over it.
  Plain,
  /// A symlink, carrying the path it resolves to. The link is only a name, so
  /// the swap happens at that target and the link itself is never touched --
  /// it keeps pointing where it pointed, and the write stays atomic.
  Symlink(PathBuf),
  /// More than one name shares this inode. Holding them together means writing
  /// into the inode itself, and no filesystem offers that atomically:
  /// `rename`, `renamex_np(RENAME_SWAP)` and `ReplaceFileW` all move directory
  /// entries, and `exchangedata(2)`, the one call that swapped contents, is
  /// documented as unsupported on APFS.
  Shared,
}

/// How `path` has to be written to keep whatever links point at it.
///
/// A symlink is resolved *before* the hard-link count is taken. The link may
/// point at a file other names share, and that inode still has to be written
/// in place, so the shared answer has to win over the symlink one. `fs::metadata`
/// (unlike `symlink_metadata`) follows a link and reports the target's count,
/// so the order matters both ways round.
///
/// Read by all three writers, so a destination one of them protects is never
/// quietly detached by another.
pub fn classify(path: &Path) -> Destination {
  let Ok(meta) = fs::symlink_metadata(path) else {
    // A name not taken yet has no link to sever.
    return Destination::Plain;
  };
  if meta.file_type().is_symlink() {
    // A dangling link resolves to nothing, which leaves the name free.
    let Ok(target) = fs::canonicalize(path) else {
      return Destination::Plain;
    };
    return match fs::metadata(&target) {
      Ok(m) if m.is_file() && hard_link_count(&m, &target) > 1 => Destination::Shared,
      _ => Destination::Symlink(target),
    };
  }
  // Only a regular file carries links worth protecting. A directory reports a
  // link count of two or more for its own entries, and calling that shared
  // would send "rename onto a directory" down the in-place route -- which keeps
  // the staged file on purpose, leaving a temp behind for a destination that
  // was never writable in the first place.
  if meta.is_file() && hard_link_count(&meta, path) > 1 {
    Destination::Shared
  } else {
    Destination::Plain
  }
}

#[cfg(unix)]
fn hard_link_count(meta: &fs::Metadata, _path: &Path) -> u64 {
  use std::os::unix::fs::MetadataExt;
  meta.nlink()
}

/// std's `MetadataExt::number_of_links()` for Windows is nightly-only
/// (`windows_by_handle`, rust-lang/rust#63010), so the count comes from the
/// raw Win32 call instead: open the file, ask `GetFileInformationByHandle` for
/// `BY_HANDLE_FILE_INFORMATION`, and read `nNumberOfLinks`. Any failure to open
/// the file or make the call is treated as "not linked" rather than failing
/// the save — the file was already established to exist and not be a symlink
/// by `symlink_metadata` above, so this can only under-detect a hardlink on an
/// unusual filesystem, never crash a save that would otherwise succeed.
#[cfg(windows)]
fn hard_link_count(_meta: &fs::Metadata, path: &Path) -> u64 {
  use std::os::windows::io::AsRawHandle;
  use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
  };

  let Ok(file) = fs::File::open(path) else {
    return 1;
  };
  let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
  let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) };
  if ok == 0 {
    return 1;
  }
  info.nNumberOfLinks as u64
}

#[cfg(not(any(unix, windows)))]
fn hard_link_count(_meta: &fs::Metadata, _path: &Path) -> u64 {
  1
}

/// What a rename would drop, and where each piece can be put back.
///
/// A rename installs a brand-new inode, so without this every ACL and extended
/// attribute the user put on the file is dropped the first time the app saves.
/// On macOS that includes the `com.apple.quarantine` mark, so dropping it would
/// let an edit-and-save launder a downloaded file's provenance.
///
/// Most of it can be copied onto the temp file before the swap. Windows has to
/// hold the DACL back until afterwards — see `CarriedMetadata`. Best effort on
/// purpose: a lost ACL is bad, refusing to save the user's document over one is
/// worse, so failures are logged and the save continues. Only the rename path
/// needs any of this; writing through keeps the original inode and its metadata
/// with it.
#[cfg(unix)]
pub fn capture_access_metadata(dest: &Path, tmp: &Path) -> CarriedMetadata {
  use std::ffi::CString;
  use std::os::unix::ffi::OsStrExt;

  let (Ok(from), Ok(to)) = (
    CString::new(dest.as_os_str().as_bytes()),
    CString::new(tmp.as_os_str().as_bytes()),
  ) else {
    return CarriedMetadata;
  };
  // The ACL goes first. `copyfile` rewrites `com.apple.quarantine` on the file
  // it copies onto — new flags, a fresh timestamp, and the agent name erased —
  // so running it after the attributes launders a downloaded file's provenance
  // even though the attribute copy itself is byte-for-byte.
  #[cfg(target_os = "macos")]
  let _ = copy_acl(&from, &to);
  copy_xattrs(&from, &to);
  CarriedMetadata
}

/// Nothing on Unix: everything there can be put on the temp file before the
/// swap, so there is nothing left to apply afterwards.
#[cfg(unix)]
pub struct CarriedMetadata;

#[cfg(unix)]
impl CarriedMetadata {
  pub fn apply_to(self, _path: &Path) {}
}

/// Windows keeps this in three unrelated places, none of which a rename carries:
/// the security descriptor, the alternate data streams, and two file attributes.
///
/// `ReplaceFileW` would move all of it in one call, and was measured against
/// this on Windows 11 / NTFS. It was rejected because of how it behaves on the
/// files that most need it: against a destination carrying a deny ACE it fails
/// outright, or — with the ignore flags set — succeeds while silently dropping
/// every alternate stream. It also stops being an atomic rename.
#[cfg(windows)]
pub fn capture_access_metadata(dest: &Path, tmp: &Path) -> CarriedMetadata {
  copy_alternate_streams(dest, tmp);
  copy_creation_time(dest, tmp);
  copy_encrypted_attribute(dest, tmp);
  CarriedMetadata {
    dacl: read_dacl(dest),
  }
}

/// The DACL, held back until after the rename.
///
/// Putting it on the temp file first does not work: `icacls /deny <user>:(W)` —
/// the ordinary way to deny write — includes SYNCHRONIZE, and a file whose DACL
/// denies SYNCHRONIZE cannot be renamed at all. Measured on Windows 11: the
/// rename fails with ERROR_ACCESS_DENIED, so the save would fail on a file that
/// saves fine today. Applying it afterwards leaves the new file briefly under
/// the folder's inherited permissions, which is what it has permanently today.
#[cfg(windows)]
pub struct CarriedMetadata {
  dacl: Option<Dacl>,
}

#[cfg(windows)]
impl CarriedMetadata {
  pub fn apply_to(self, path: &Path) {
    if let Some(dacl) = self.dacl {
      dacl.apply_to(path);
    }
  }
}

/// An owned copy of a DACL, taken before the swap because the file it came from
/// no longer exists afterwards.
#[cfg(windows)]
struct Dacl {
  bytes: Vec<u8>,
  protected: bool,
}

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
  use std::os::windows::ffi::OsStrExt;
  path
    .as_os_str()
    .encode_wide()
    .chain(std::iter::once(0))
    .collect()
}

#[cfg(windows)]
fn read_dacl(dest: &Path) -> Option<Dacl> {
  use windows_sys::Win32::Foundation::LocalFree;
  use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
  use windows_sys::Win32::Security::{
    GetSecurityDescriptorControl, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    SE_DACL_PROTECTED,
  };

  let from = wide(dest);
  let mut acl: *mut ACL = std::ptr::null_mut();
  let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
  let rc = unsafe {
    GetNamedSecurityInfoW(
      from.as_ptr(),
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION,
      std::ptr::null_mut(),
      std::ptr::null_mut(),
      &mut acl,
      std::ptr::null_mut(),
      &mut descriptor,
    )
  };
  if rc != 0 {
    log::debug!("could not read the DACL of {}", dest.display());
    return None;
  }
  // Whether inheritance is blocked lives in the descriptor's control bits, not
  // in the DACL, and has to be asked for by name when setting it back.
  let mut control = 0u16;
  let mut revision = 0u32;
  let protected = unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }
    != 0
    && control & SE_DACL_PROTECTED != 0;
  // The ACL lives inside an allocation that has to be freed here, so copy it
  // out: the file it describes is gone by the time this is applied.
  let bytes = if acl.is_null() {
    Vec::new()
  } else {
    let size = unsafe { (*acl).AclSize } as usize;
    unsafe { std::slice::from_raw_parts(acl.cast::<u8>(), size) }.to_vec()
  };
  unsafe { LocalFree(descriptor) };
  if bytes.is_empty() {
    return None;
  }
  Some(Dacl { bytes, protected })
}

#[cfg(windows)]
impl Dacl {
  fn apply_to(self, path: &Path) {
    use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
      ACL, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
      UNPROTECTED_DACL_SECURITY_INFORMATION,
    };

    let to = wide(path);
    let inheritance = if self.protected {
      PROTECTED_DACL_SECURITY_INFORMATION
    } else {
      UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    let rc = unsafe {
      SetNamedSecurityInfoW(
        to.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | inheritance,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        self.bytes.as_ptr().cast::<ACL>(),
        std::ptr::null(),
      )
    };
    if rc != 0 {
      log::debug!("could not carry over the DACL to {}", path.display());
    }
  }
}

/// Copy every alternate data stream, `com.apple.quarantine`'s Windows
/// counterpart `Zone.Identifier` among them.
#[cfg(windows)]
fn copy_alternate_streams(dest: &Path, tmp: &Path) {
  use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
  use windows_sys::Win32::Storage::FileSystem::{
    FindClose, FindFirstStreamW, FindNextStreamW, FindStreamInfoStandard, WIN32_FIND_STREAM_DATA,
  };

  let from = wide(dest);
  let mut found = WIN32_FIND_STREAM_DATA {
    StreamSize: 0,
    cStreamName: [0; 296],
  };
  let handle = unsafe {
    FindFirstStreamW(
      from.as_ptr(),
      FindStreamInfoStandard,
      (&mut found as *mut WIN32_FIND_STREAM_DATA).cast(),
      0,
    )
  };
  if handle == INVALID_HANDLE_VALUE {
    return;
  }
  loop {
    let end = found
      .cStreamName
      .iter()
      .position(|c| *c == 0)
      .unwrap_or(found.cStreamName.len());
    let name = String::from_utf16_lossy(&found.cStreamName[..end]);
    // The unnamed stream is the file's own contents, already written.
    if name != "::$DATA" {
      copy_one_stream(dest, tmp, &name);
    }
    if unsafe { FindNextStreamW(handle, (&mut found as *mut WIN32_FIND_STREAM_DATA).cast()) } == 0 {
      break;
    }
  }
  unsafe { FindClose(handle) };
}

/// Streamed rather than read whole: an alternate stream has no size limit, and
/// nothing stops another program from parking something large in one.
#[cfg(windows)]
fn copy_one_stream(dest: &Path, tmp: &Path, name: &str) {
  // Built on the OsString, not on `display()`, which is lossy for a path that
  // is not valid Unicode.
  let stream_path = |path: &Path| {
    let mut p = path.as_os_str().to_os_string();
    p.push(name);
    p
  };
  let mut source = match fs::File::open(stream_path(dest)) {
    Ok(f) => f,
    Err(_) => return,
  };
  let target = fs::OpenOptions::new()
    .write(true)
    .create(true)
    .truncate(true)
    .open(stream_path(tmp));
  match target {
    Ok(mut target) => {
      if std::io::copy(&mut source, &mut target).is_err() {
        log::debug!("could not carry over the stream {name}");
      }
    }
    Err(_) => log::debug!("could not create the stream {name}"),
  }
}

#[cfg(windows)]
fn copy_creation_time(dest: &Path, tmp: &Path) {
  use std::os::windows::fs::FileTimesExt;

  let Ok(created) = fs::metadata(dest).and_then(|m| m.created()) else {
    return;
  };
  let Ok(file) = fs::OpenOptions::new().write(true).open(tmp) else {
    return;
  };
  if file
    .set_times(fs::FileTimes::new().set_created(created))
    .is_err()
  {
    log::debug!(
      "could not carry over the creation time to {}",
      tmp.display()
    );
  }
}

/// An EFS-encrypted destination must not come back unencrypted, which is what a
/// plain rename leaves behind. The temp file is written in the clear and
/// encrypted here, so the new content does touch the disk unencrypted first —
/// still strictly better than today, where it stays that way for good.
#[cfg(windows)]
fn copy_encrypted_attribute(dest: &Path, tmp: &Path) {
  use windows_sys::Win32::Storage::FileSystem::{
    EncryptFileW, GetFileAttributesW, FILE_ATTRIBUTE_ENCRYPTED, INVALID_FILE_ATTRIBUTES,
  };

  let from = wide(dest);
  let attributes = unsafe { GetFileAttributesW(from.as_ptr()) };
  if attributes == INVALID_FILE_ATTRIBUTES || attributes & FILE_ATTRIBUTE_ENCRYPTED == 0 {
    return;
  }
  let to = wide(tmp);
  if unsafe { EncryptFileW(to.as_ptr()) } == 0 {
    log::debug!("could not carry over encryption to {}", tmp.display());
  }
}

#[cfg(not(any(unix, windows)))]
pub fn capture_access_metadata(_dest: &Path, _tmp: &Path) -> CarriedMetadata {
  CarriedMetadata
}

#[cfg(not(any(unix, windows)))]
pub struct CarriedMetadata;

#[cfg(not(any(unix, windows)))]
impl CarriedMetadata {
  pub fn apply_to(self, _path: &Path) {}
}

/// The libc entry points, declared by hand rather than pulled in with a crate:
/// four functions do not justify a dependency. macOS takes two extra arguments
/// (a read offset, only meaningful for resource forks, and an options flag),
/// which is why the shims below exist instead of one shared signature.
#[cfg(unix)]
mod ffi {
  use std::ffi::{c_char, c_int, c_void};

  extern "C" {
    pub fn access(path: *const c_char, mode: c_int) -> c_int;
  }

  #[cfg(target_os = "macos")]
  extern "C" {
    pub fn copyfile(
      from: *const c_char,
      to: *const c_char,
      state: *mut c_void,
      flags: u32,
    ) -> c_int;
    pub fn acl_init(count: c_int) -> *mut c_void;
    pub fn acl_set_file(path: *const c_char, acl_type: c_int, acl: *mut c_void) -> c_int;
    pub fn acl_free(obj: *mut c_void) -> c_int;
    pub fn listxattr(path: *const c_char, buf: *mut c_char, size: usize, options: c_int) -> isize;
    pub fn getxattr(
      path: *const c_char,
      name: *const c_char,
      value: *mut c_void,
      size: usize,
      position: u32,
      options: c_int,
    ) -> isize;
    pub fn setxattr(
      path: *const c_char,
      name: *const c_char,
      value: *const c_void,
      size: usize,
      position: u32,
      options: c_int,
    ) -> c_int;
  }

  #[cfg(not(target_os = "macos"))]
  extern "C" {
    pub fn listxattr(path: *const c_char, buf: *mut c_char, size: usize) -> isize;
    pub fn getxattr(
      path: *const c_char,
      name: *const c_char,
      value: *mut c_void,
      size: usize,
    ) -> isize;
    pub fn setxattr(
      path: *const c_char,
      name: *const c_char,
      value: *const c_void,
      size: usize,
      flags: c_int,
    ) -> c_int;
  }
}

#[cfg(all(unix, target_os = "macos"))]
unsafe fn list_xattr(
  path: *const std::ffi::c_char,
  buf: *mut std::ffi::c_char,
  size: usize,
) -> isize {
  ffi::listxattr(path, buf, size, 0)
}

#[cfg(all(unix, target_os = "macos"))]
unsafe fn get_xattr(
  path: *const std::ffi::c_char,
  name: *const std::ffi::c_char,
  value: *mut std::ffi::c_void,
  size: usize,
) -> isize {
  ffi::getxattr(path, name, value, size, 0, 0)
}

#[cfg(all(unix, target_os = "macos"))]
unsafe fn set_xattr(
  path: *const std::ffi::c_char,
  name: *const std::ffi::c_char,
  value: *const std::ffi::c_void,
  size: usize,
) -> std::ffi::c_int {
  ffi::setxattr(path, name, value, size, 0, 0)
}

#[cfg(all(unix, not(target_os = "macos")))]
unsafe fn list_xattr(
  path: *const std::ffi::c_char,
  buf: *mut std::ffi::c_char,
  size: usize,
) -> isize {
  ffi::listxattr(path, buf, size)
}

#[cfg(all(unix, not(target_os = "macos")))]
unsafe fn get_xattr(
  path: *const std::ffi::c_char,
  name: *const std::ffi::c_char,
  value: *mut std::ffi::c_void,
  size: usize,
) -> isize {
  ffi::getxattr(path, name, value, size)
}

#[cfg(all(unix, not(target_os = "macos")))]
unsafe fn set_xattr(
  path: *const std::ffi::c_char,
  name: *const std::ffi::c_char,
  value: *const std::ffi::c_void,
  size: usize,
) -> std::ffi::c_int {
  ffi::setxattr(path, name, value, size, 0)
}

/// Copy every extended attribute readable on `from` onto `to`. On Linux this
/// carries POSIX ACLs too: they live in `system.posix_acl_access`, which an
/// ordinary owner can both list and set. macOS keeps its ACLs outside the
/// attribute list, hence the separate `copy_acl`.
#[cfg(unix)]
fn copy_xattrs(from: &std::ffi::CStr, to: &std::ffi::CStr) {
  use std::ffi::CString;

  let size = unsafe { list_xattr(from.as_ptr(), std::ptr::null_mut(), 0) };
  if size <= 0 {
    return;
  }
  let mut names = vec![0u8; size as usize];
  let size = unsafe { list_xattr(from.as_ptr(), names.as_mut_ptr().cast(), names.len()) };
  if size <= 0 {
    return;
  }
  names.truncate(size as usize);
  // The buffer is a run of NUL-terminated names; the trailing NUL leaves an
  // empty last element behind.
  for name in names.split(|b| *b == 0) {
    let Ok(name) = CString::new(name) else {
      continue;
    };
    if name.as_bytes().is_empty() {
      continue;
    }
    let Some(value) = read_xattr(from, &name) else {
      continue;
    };
    let rc = unsafe {
      set_xattr(
        to.as_ptr(),
        name.as_ptr(),
        value.as_ptr().cast(),
        value.len(),
      )
    };
    if rc != 0 {
      // Namespaces like `security.*` need privileges the app does not have.
      // Expected, not a fault, so this stays below the warning level.
      log::debug!("could not carry over xattr {}", name.to_string_lossy());
    }
  }
}

#[cfg(unix)]
fn read_xattr(path: &std::ffi::CStr, name: &std::ffi::CStr) -> Option<Vec<u8>> {
  let size = unsafe { get_xattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0) };
  if size < 0 {
    return None;
  }
  let mut value = vec![0u8; size as usize];
  let size = unsafe {
    get_xattr(
      path.as_ptr(),
      name.as_ptr(),
      value.as_mut_ptr().cast(),
      value.len(),
    )
  };
  if size < 0 {
    return None;
  }
  value.truncate(size as usize);
  Some(value)
}

/// Test-only extended-attribute helpers, at module level so `range_edit`'s
/// tests can reach the same shims the copy itself uses.
#[cfg(all(unix, test))]
pub(crate) fn set_test_xattr(path: &Path, name: &str, value: &[u8]) {
  use std::ffi::CString;
  use std::os::unix::ffi::OsStrExt;
  let p = CString::new(path.as_os_str().as_bytes()).unwrap();
  let n = CString::new(name).unwrap();
  let rc = unsafe { set_xattr(p.as_ptr(), n.as_ptr(), value.as_ptr().cast(), value.len()) };
  assert_eq!(rc, 0, "could not set {name} for the test");
}

#[cfg(all(unix, test))]
pub(crate) fn read_test_xattr(path: &Path, name: &str) -> Option<Vec<u8>> {
  use std::ffi::CString;
  use std::os::unix::ffi::OsStrExt;
  let p = CString::new(path.as_os_str().as_bytes()).unwrap();
  let n = CString::new(name).unwrap();
  read_xattr(&p, &n)
}

/// Wipe the ACL from a staged file of our own that is about to be cleared away.
///
/// The staged file is handed the destination's ACL before the swap, and a
/// `deny delete` entry among them refuses the staged file's own removal
/// (measured) — so the copy has to come off before it can be tidied up. Only
/// ever called on a file this module created; nothing of the user's reaches it.
/// `acl_delete_file_np` reads like the call for this and answers ENOTSUP,
/// sandbox or no sandbox; setting an empty ACL is what works.
#[cfg(target_os = "macos")]
fn clear_acl(path: &Path) {
  use std::ffi::CString;
  use std::os::unix::ffi::OsStrExt;

  const ACL_TYPE_EXTENDED: std::ffi::c_int = 0x0000_0100;
  let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
    return;
  };
  // Contained unsafe: the empty ACL is freed on every way out, and the path
  // outlives the call.
  unsafe {
    let empty = ffi::acl_init(0);
    if empty.is_null() {
      return;
    }
    ffi::acl_set_file(path.as_ptr(), ACL_TYPE_EXTENDED, empty);
    ffi::acl_free(empty);
  }
}

#[cfg(not(target_os = "macos"))]
fn clear_acl(_path: &Path) {}

/// macOS ACLs are not extended attributes, so they need `copyfile`.
#[cfg(target_os = "macos")]
fn copy_acl(from: &std::ffi::CStr, to: &std::ffi::CStr) -> bool {
  // COPYFILE_ACL only. COPYFILE_METADATA would drag in COPYFILE_STAT, which
  // stamps the old file's mtime onto the new one — saving would move the
  // modification time *backwards*.
  const COPYFILE_ACL: u32 = 1 << 0;
  let rc = unsafe {
    ffi::copyfile(
      from.as_ptr(),
      to.as_ptr(),
      std::ptr::null_mut(),
      COPYFILE_ACL,
    )
  };
  if rc != 0 {
    log::debug!("could not carry over the ACL of {}", from.to_string_lossy());
  }
  rc == 0
}

/// Atomically write text to `path` (UTF-8, no BOM). Thin wrapper over
/// `write_bytes_atomic` for the plain-text callers (stickies, older paths).
pub fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
  write_bytes_atomic(path, content.as_bytes())
}

/// `write_text_atomic` for the app's own private data: anything this call has
/// to create is created owner-only. See `PrivateModes` for what that does and
/// does not buy.
pub fn write_text_atomic_private(path: &Path, content: &str) -> Result<(), String> {
  write_bytes_atomic_with(path, content.as_bytes(), Some(PRIVATE))
}

/// Whether a save aimed at this path would be allowed to land, asked at open
/// time so a read-only file can say so before the user types into it rather
/// than after. The same question `stage` asks before it writes anything.
#[tauri::command]
pub fn path_writable(path: String) -> bool {
  writable(Path::new(&path))
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
  read_text(Path::new(&path))
}

/// Off the UI thread: the write (serialize is trivial here, but the `fs::write`
/// + fsync + rename inside `write_text_atomic` is not) would otherwise block
/// the main thread for as long as the file takes to land. Every call site
/// awaits this one call before its next action, so there is no overlapping
/// write to reorder.
#[tauri::command(async)]
pub fn write_file(path: String, content: String) -> Result<(), String> {
  write_text_atomic(Path::new(&path), &content)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::Cell;
  use tempfile::tempdir;

  // Portable tests for the retry policy itself: the CI machine is macOS, so
  // these exercise `retry` directly with a fake operation rather than a real
  // `fs::rename` sharing violation, which only Windows can produce.
  #[test]
  fn retry_succeeds_after_transient_failures() {
    let calls = Cell::new(0);
    let result: Result<i32, &str> = retry(3, Duration::from_millis(1), || {
      calls.set(calls.get() + 1);
      if calls.get() < 3 {
        Err("busy")
      } else {
        Ok(42)
      }
    });
    assert_eq!(result, Ok(42));
    assert_eq!(calls.get(), 3);
  }

  #[test]
  fn retry_gives_up_after_exhausting_attempts() {
    let calls = Cell::new(0);
    let result: Result<i32, &str> = retry(3, Duration::from_millis(1), || {
      calls.set(calls.get() + 1);
      Err("still busy")
    });
    assert_eq!(result, Err("still busy"));
    assert_eq!(calls.get(), 3);
  }

  #[test]
  fn retry_with_one_attempt_never_sleeps() {
    // Covers the non-Windows constant: a single attempt must behave exactly
    // like a bare call, with no retry loop overhead. A long delay here would
    // make the test itself slow if this regressed.
    let calls = Cell::new(0);
    let result: Result<i32, &str> = retry(1, Duration::from_secs(5), || {
      calls.set(calls.get() + 1);
      Err("nope")
    });
    assert_eq!(result, Err("nope"));
    assert_eq!(calls.get(), 1);
  }

  #[test]
  fn atomic_write_lands_content() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.txt");
    write_text_atomic(&path, "hello").unwrap();
    assert_eq!(read_text(&path).unwrap(), "hello");
  }

  #[test]
  fn atomic_write_overwrites_existing() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.txt");
    write_text_atomic(&path, "first").unwrap();
    write_text_atomic(&path, "second").unwrap();
    assert_eq!(read_text(&path).unwrap(), "second");
    // No leftover temp file.
    let leftovers: Vec<_> = fs::read_dir(dir.path())
      .unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
      .collect();
    assert!(leftovers.is_empty());
  }

  /// A rename installs a new inode, so an attribute the user set on the file is
  /// gone after the first save unless it is carried over.
  #[cfg(unix)]
  #[test]
  fn atomic_write_carries_over_extended_attributes() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.txt");
    fs::write(&path, b"old").unwrap();
    set_test_xattr(&path, "user.note_n_pad_test", b"kept");

    write_bytes_atomic(&path, b"new").unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert_eq!(
      read_test_xattr(&path, "user.note_n_pad_test").as_deref(),
      Some(b"kept".as_slice()),
      "the attribute must survive the save"
    );
  }

  /// Deny an Everyone right through `icacls`, by SID so the call does not
  /// depend on the machine's language, and with inheritance turned into
  /// explicit entries so the file carries a DACL of its own.
  #[cfg(windows)]
  fn deny_everyone(path: &Path, rights: &str) {
    use std::process::Command;
    for args in [
      vec!["/inheritance:d"],
      vec!["/deny", &format!("*S-1-1-0:({rights})")],
    ] {
      let ok = Command::new("icacls")
        .arg(path)
        .args(&args)
        .status()
        .unwrap();
      assert!(ok.success(), "icacls {args:?} failed");
    }
  }

  /// Put the file back within reach of the tempdir cleanup.
  #[cfg(windows)]
  fn undeny_everyone(path: &Path) {
    let _ = std::process::Command::new("icacls")
      .arg(path)
      .args(["/remove:d", "*S-1-1-0"])
      .status();
  }

  /// Windows has no mode bits to check, so the DACL is asserted by behaviour: a
  /// deny-write ACE that survives the save still refuses a direct write.
  /// Reading the ACL back as text would depend on the machine's locale.
  #[cfg(windows)]
  #[test]
  fn atomic_write_carries_over_the_dacl_streams_and_creation_time() {
    use std::os::windows::fs::FileTimesExt;

    let dir = tempdir().unwrap();
    let path = dir.path().join("note.txt");
    fs::write(&path, b"old").unwrap();
    let mut stream = path.as_os_str().to_os_string();
    stream.push(":Zone.Identifier");
    fs::write(&stream, b"[ZoneTransfer]\r\nZoneId=3").unwrap();
    // An old creation time: a plain rename gives the saved file the temp's.
    let created = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
    fs::OpenOptions::new()
      .write(true)
      .open(&path)
      .unwrap()
      .set_times(fs::FileTimes::new().set_created(created))
      .unwrap();
    // WD alone, not the (W) group: that one also denies SYNCHRONIZE, which
    // makes the file unopenable even for reading, so nothing below could be
    // checked. The SYNCHRONIZE case has its own test.
    deny_everyone(&path, "WD");
    assert!(
      fs::OpenOptions::new().write(true).open(&path).is_err(),
      "the deny ACE must be in force before the save, or the test proves nothing"
    );

    write_bytes_atomic(&path, b"new").unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert!(
      fs::OpenOptions::new().write(true).open(&path).is_err(),
      "the deny ACE must survive the save"
    );
    assert_eq!(
      fs::read(&stream).unwrap(),
      b"[ZoneTransfer]\r\nZoneId=3",
      "the alternate data stream must survive the save"
    );
    assert_eq!(
      fs::metadata(&path).unwrap().created().unwrap(),
      created,
      "the creation time must survive the save"
    );
    undeny_everyone(&path);
  }

  /// A plain rename leaves an EFS-encrypted file unencrypted for good.
  ///
  /// Needs a temp directory outside `%SystemRoot%`: EFS refuses to encrypt
  /// anything under it, so running the suite as a user whose TEMP is
  /// `C:\WINDOWS\TEMP` (SYSTEM, for one) fails this on the setup line.
  #[cfg(windows)]
  #[test]
  fn atomic_write_carries_over_encryption() {
    use std::os::windows::fs::MetadataExt;
    const ENCRYPTED: u32 = 0x4000;

    let dir = tempdir().unwrap();
    let path = dir.path().join("note.txt");
    fs::write(&path, b"old").unwrap();
    // `cipher /e` reports success without encrypting when the account running
    // the tests has no EFS profile; the API says so directly.
    let name = wide(&path);
    assert!(
      unsafe { windows_sys::Win32::Storage::FileSystem::EncryptFileW(name.as_ptr()) } != 0,
      "EncryptFileW failed"
    );
    assert!(
      fs::metadata(&path).unwrap().file_attributes() & ENCRYPTED != 0,
      "the file must be encrypted before the save, or the test proves nothing"
    );

    write_bytes_atomic(&path, b"new").unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert!(
      fs::metadata(&path).unwrap().file_attributes() & ENCRYPTED != 0,
      "encryption must survive the save"
    );
  }

  /// `icacls /deny <user>:(W)` — the ordinary way to deny write — also denies
  /// SYNCHRONIZE, and a file whose DACL denies SYNCHRONIZE cannot be renamed.
  /// Putting the destination's DACL on the temp file before the swap therefore
  /// breaks the save outright on exactly the files it is meant to protect.
  #[cfg(windows)]
  #[test]
  fn a_dacl_that_denies_synchronize_does_not_break_the_save() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.txt");
    fs::write(&path, b"old").unwrap();
    deny_everyone(&path, "W");

    write_bytes_atomic(&path, b"new").unwrap();

    assert!(
      fs::read(&path).is_err(),
      "denying SYNCHRONIZE blocks even a read, so this failing read is what \
       proves the DACL reached the saved file"
    );
    undeny_everyone(&path);
    assert_eq!(fs::read(&path).unwrap(), b"new");
  }

  /// macOS keeps ACLs outside the attribute list, so they travel separately.
  #[cfg(target_os = "macos")]
  #[test]
  fn atomic_write_carries_over_the_acl_without_rewinding_mtime() {
    use std::process::Command;

    let dir = tempdir().unwrap();
    let path = dir.path().join("note.txt");
    fs::write(&path, b"old").unwrap();
    // An old mtime: `COPYFILE_METADATA` would drag it onto the new file and the
    // save would appear to move the file's modification time backwards.
    let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
    fs::File::open(&path)
      .unwrap()
      .set_times(fs::FileTimes::new().set_modified(old))
      .unwrap();
    // An allow entry, because this test is about the rename path carrying an
    // ACL across to a new inode. A deny-write entry is turned away by the guard
    // in `stage`, and a deny-delete one takes the in-place route, where there is
    // no new inode and nothing to carry.
    let ok = Command::new("/bin/chmod")
      .args(["+a", "everyone allow read"])
      .arg(&path)
      .status()
      .unwrap();
    assert!(ok.success(), "could not set the ACL for the test");

    write_bytes_atomic(&path, b"new").unwrap();

    let listing = Command::new("/bin/ls")
      .arg("-le")
      .arg(&path)
      .output()
      .unwrap();
    let listing = String::from_utf8_lossy(&listing.stdout);
    assert!(
      listing.contains("everyone allow read"),
      "the ACL must survive the save, got: {listing}"
    );
    assert!(
      fs::metadata(&path).unwrap().modified().unwrap() > old,
      "the save must not move the modification time backwards"
    );
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn a_file_that_refuses_to_be_replaced_is_written_in_place() {
    use std::os::unix::fs::MetadataExt;
    use std::process::Command;

    // `deny delete` refuses to have the directory entry swapped -- `rename`
    // answers errno 13 and `replaceItemAtURL:` refuses too (measured) -- while
    // the file's own content stays writable. Whoever set that entry meant "do
    // not replace this file", not "do not edit it", so the content goes into
    // the file that is already there. Before this the save just failed.
    let dir = tempdir().unwrap();
    let path = dir.path().join("undeletable.txt");
    fs::write(&path, b"old").unwrap();
    let ok = Command::new("/bin/chmod")
      .args(["+a", "everyone deny delete"])
      .arg(&path)
      .status()
      .unwrap();
    assert!(ok.success(), "could not set the ACL for the test");
    let before = fs::metadata(&path).unwrap().ino();

    write_bytes_atomic(&path, b"new").unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert_eq!(
      fs::metadata(&path).unwrap().ino(),
      before,
      "the file must be the same one, not a replacement"
    );
    let left = acl_entries(&path);
    assert!(
      left.iter().any(|line| line.contains("deny delete")),
      "the entry must still be there: {left:?}"
    );
    let staged: Vec<_> = fs::read_dir(dir.path())
      .unwrap()
      .flatten()
      .map(|e| e.file_name())
      .filter(|n| n.to_string_lossy().ends_with(".tmp"))
      .collect();
    assert!(
      staged.is_empty(),
      "the staged file must be gone: {staged:?}"
    );
    // The entry that survived also stops the tempdir being cleared.
    let _ = Command::new("/bin/chmod").arg("-N").arg(&path).status();
  }

  /// The ACL entry lines `ls` reports for a path, without its header line.
  #[cfg(target_os = "macos")]
  fn acl_entries(path: &Path) -> Vec<String> {
    let out = std::process::Command::new("/bin/ls")
      .arg("-lde")
      .arg(path)
      .output()
      .unwrap();
    String::from_utf8_lossy(&out.stdout)
      .lines()
      .skip(1)
      .map(str::to_string)
      .collect()
  }

  #[cfg(unix)]
  #[test]
  fn a_read_only_file_is_not_saved_over() {
    use std::os::unix::fs::PermissionsExt;

    // Read-only means read-only. `rename` is a directory operation and never
    // consults the permissions of the file it replaces, so without the guard a
    // 0444 file was replaced as readily as any other -- and the user was told
    // the save had succeeded.
    let dir = tempdir().unwrap();
    let path = dir.path().join("locked.txt");
    fs::write(&path, b"old").unwrap();
    fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();

    let refused = write_bytes_atomic(&path, b"new").unwrap_err();

    assert_eq!(refused, READ_ONLY_DESTINATION);
    assert_eq!(
      fs::read(&path).unwrap(),
      b"old",
      "the file must be untouched"
    );
    assert_eq!(
      fs::metadata(&path).unwrap().permissions().mode() & 0o777,
      0o444
    );
    let left: Vec<_> = fs::read_dir(dir.path())
      .unwrap()
      .flatten()
      .map(|e| e.file_name())
      .collect();
    assert_eq!(left.len(), 1, "a refused save must stage nothing: {left:?}");
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn a_file_closed_by_an_acl_alone_is_not_saved_over() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    // The mode bits say 0644 and the ACL says no. Reading `mode & 0o200` would
    // call this file writable and save straight over it, which is why the guard
    // asks `access` -- it answers for the caller's real identity and folds the
    // ACL in.
    let dir = tempdir().unwrap();
    let path = dir.path().join("guarded.txt");
    fs::write(&path, b"old").unwrap();
    let ok = Command::new("/bin/chmod")
      .args(["+a", "everyone deny write"])
      .arg(&path)
      .status()
      .unwrap();
    assert!(ok.success(), "could not set the ACL for the test");
    assert_eq!(
      fs::metadata(&path).unwrap().permissions().mode() & 0o200,
      0o200,
      "the mode bits must still look writable, or this test proves nothing"
    );

    let refused = write_bytes_atomic(&path, b"new").unwrap_err();

    assert_eq!(refused, READ_ONLY_DESTINATION);
    assert_eq!(fs::read(&path).unwrap(), b"old");
    let _ = Command::new("/bin/chmod").arg("-N").arg(&path).status();
  }

  #[cfg(unix)]
  #[test]
  fn a_writable_file_is_still_saved_over() {
    // The guard must turn away only what the user closed. Every ordinary save
    // in the app goes through the same door.
    let dir = tempdir().unwrap();
    let path = dir.path().join("ordinary.txt");
    fs::write(&path, b"old").unwrap();

    write_bytes_atomic(&path, b"new").unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"new");
  }

  #[cfg(unix)]
  #[test]
  fn a_name_that_is_not_taken_yet_is_left_to_the_filesystem() {
    use std::os::unix::fs::PermissionsExt;

    // The guard must not answer for a file that does not exist. Under the App
    // Sandbox a save panel grants the exact path it handed back and nothing
    // else, so judging the folder would refuse every save-as in the store
    // build. A folder that really refuses still stops the save -- just at the
    // staging attempt, with the filesystem's own error rather than ours.
    let dir = tempdir().unwrap();
    let closed = dir.path().join("closed");
    fs::create_dir(&closed).unwrap();
    fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o555)).unwrap();

    let refused = write_bytes_atomic(&closed.join("new.txt"), b"x").unwrap_err();
    assert_ne!(
      refused, READ_ONLY_DESTINATION,
      "an unwritable folder is not this guard's answer to give"
    );
    assert!(!closed.join("new.txt").exists());

    let fresh = dir.path().join("brand-new.txt");
    write_bytes_atomic(&fresh, b"x").unwrap();
    assert_eq!(fs::read(&fresh).unwrap(), b"x");
    fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o755)).unwrap();
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn atomic_write_keeps_the_quarantine_value_byte_for_byte() {
    use std::process::Command;

    let dir = tempdir().unwrap();
    let path = dir.path().join("note.txt");
    fs::write(&path, b"old").unwrap();
    // A record written by a browser: the third field is the app that downloaded
    // the file, and losing it is how an edit-and-save launders provenance.
    let stamp = "0083;68a6a000;Safari;TESTUUID";
    set_test_xattr(&path, "com.apple.quarantine", stamp.as_bytes());
    // The ACL must be there too: it is `copyfile`, run to carry the ACL, that
    // rewrites the quarantine record, so without an ACL this test cannot fail.
    let ok = Command::new("/bin/chmod")
      .args(["+a", "everyone allow read"])
      .arg(&path)
      .status()
      .unwrap();
    assert!(ok.success(), "could not set the ACL for the test");

    write_bytes_atomic(&path, b"new").unwrap();

    let got = read_test_xattr(&path, "com.apple.quarantine")
      .expect("the quarantine attribute must survive the save");
    assert_eq!(
      String::from_utf8_lossy(&got),
      stamp,
      "the quarantine record must survive unchanged"
    );
    let listing = Command::new("/bin/ls")
      .arg("-le")
      .arg(&path)
      .output()
      .unwrap();
    let listing = String::from_utf8_lossy(&listing.stdout);
    assert!(
      listing.contains("everyone allow read"),
      "the ACL must survive too, got: {listing}"
    );
  }

  #[test]
  fn write_bytes_atomic_lands_raw_bytes() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.bin");
    let bytes = [0xFF, 0xFE, 0x41, 0x00];
    write_bytes_atomic(&path, &bytes).unwrap();
    assert_eq!(fs::read(&path).unwrap(), bytes);
    // No leftover temp file.
    let leftovers: Vec<_> = fs::read_dir(dir.path())
      .unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
      .collect();
    assert!(leftovers.is_empty());
  }

  #[test]
  fn read_missing_file_errors() {
    let dir = tempdir().unwrap();
    assert!(read_text(&dir.path().join("nope.txt")).is_err());
  }

  // The write still has to succeed even when the parent-directory fsync itself
  // is unavailable — that's the real case on Windows, and reproducible here on
  // Unix by revoking read permission on the directory (write+execute is kept,
  // so create/rename still work, but `File::open(dir)` - which opens for
  // reading - fails with EACCES). Root bypasses Unix permission checks, so
  // skip if the revoke turns out to be a no-op (e.g. tests running as root in
  // a container).
  #[cfg(unix)]
  #[test]
  fn atomic_write_succeeds_when_dir_sync_is_unavailable() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempdir().unwrap();
    let original_perms = fs::metadata(dir.path()).unwrap().permissions();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o300)).unwrap();
    if fs::File::open(dir.path()).is_ok() {
      // Permission revoke had no effect (likely running as root) - nothing to
      // exercise here.
      fs::set_permissions(dir.path(), original_perms).unwrap();
      return;
    }
    let path = dir.path().join("note.txt");
    let result = write_text_atomic(&path, "hello");
    fs::set_permissions(dir.path(), original_perms).unwrap();
    result.unwrap();
    assert_eq!(read_text(&path).unwrap(), "hello");
  }

  #[test]
  fn saving_through_a_symlink_replaces_the_target_and_keeps_the_link() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("real.txt");
    let link = dir.path().join("link.txt");
    fs::write(&target, "old").unwrap();
    if !linktest::symlink(&target, &link) {
      return; // this platform will not make one for us; nothing to check
    }
    #[cfg(unix)]
    let before = {
      use std::os::unix::fs::MetadataExt;
      fs::metadata(&target).unwrap().ino()
    };

    write_text_atomic(&link, "new").unwrap();

    assert!(
      fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink(),
      "the save must not put a plain file where the link was"
    );
    assert_eq!(read_text(&target).unwrap(), "new");
    // The swap lands on the target, which is what keeps it atomic. Writing
    // through the link instead would work too, and would leave the target
    // briefly truncated for no reason -- the inode changing is the difference.
    #[cfg(unix)]
    {
      use std::os::unix::fs::MetadataExt;
      assert_ne!(
        fs::metadata(&target).unwrap().ino(),
        before,
        "a lone target is replaced, not poured into"
      );
    }
  }

  #[test]
  fn saving_a_hardlinked_file_keeps_both_names_linked() {
    let dir = tempdir().unwrap();
    let a = dir.path().join("a.txt");
    let b = dir.path().join("b.txt");
    fs::write(&a, "old").unwrap();
    fs::hard_link(&a, &b).unwrap();
    #[cfg(unix)]
    let before = {
      use std::os::unix::fs::MetadataExt;
      fs::metadata(&a).unwrap().ino()
    };

    write_text_atomic(&a, "new").unwrap();

    assert_eq!(
      linktest::links(&a),
      2,
      "the two names must still share one file"
    );
    assert_eq!(read_text(&a).unwrap(), "new");
    assert_eq!(read_text(&b).unwrap(), "new");
    #[cfg(unix)]
    {
      use std::os::unix::fs::MetadataExt;
      assert_eq!(
        fs::metadata(&a).unwrap().ino(),
        before,
        "holding the names together means writing into the file they share"
      );
    }
  }

  #[test]
  fn a_symlink_onto_a_shared_file_is_written_in_place() {
    // The link resolves to a file another name also holds. Replacing that file
    // would drop the other name, so the shared answer has to beat the symlink
    // one -- which only works if the link is resolved before the count is read.
    let dir = tempdir().unwrap();
    let target = dir.path().join("shared.txt");
    let other = dir.path().join("other.txt");
    let link = dir.path().join("link.txt");
    fs::write(&target, "old").unwrap();
    fs::hard_link(&target, &other).unwrap();
    if !linktest::symlink(&target, &link) {
      return;
    }

    write_text_atomic(&link, "new").unwrap();

    assert_eq!(linktest::links(&target), 2, "the other name must survive");
    assert_eq!(read_text(&target).unwrap(), "new");
    assert_eq!(read_text(&other).unwrap(), "new");
    assert!(fs::symlink_metadata(&link)
      .unwrap()
      .file_type()
      .is_symlink());
  }

  #[test]
  fn a_dangling_symlink_is_replaced_by_the_file_written_to_it() {
    // A link that resolves to nothing severs nothing, so the name is free and
    // the file lands where the user pointed. Following it instead would write
    // into a directory they never chose, which is the surprising half of the
    // two: the link may name anywhere on the volume.
    let dir = tempdir().unwrap();
    let elsewhere = dir.path().join("gone.txt");
    let link = dir.path().join("link.txt");
    if !linktest::symlink(&elsewhere, &link) {
      return;
    }

    write_text_atomic(&link, "new").unwrap();

    assert_eq!(read_text(&link).unwrap(), "new");
    assert!(
      !fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink(),
      "a link that pointed nowhere is replaced, not followed"
    );
    assert!(!elsewhere.exists(), "nothing is written where it pointed");
  }

  #[cfg(unix)]
  #[test]
  fn saving_an_ordinary_file_still_replaces_the_inode() {
    use std::os::unix::fs::MetadataExt;

    let dir = tempdir().unwrap();
    let path = dir.path().join("plain.txt");
    fs::write(&path, "old").unwrap();
    let inode_before = fs::metadata(&path).unwrap().ino();

    write_text_atomic(&path, "new").unwrap();

    assert_ne!(
      fs::metadata(&path).unwrap().ino(),
      inode_before,
      "an unlinked file must still go through rename, not in-place overwrite"
    );
    assert_eq!(read_text(&path).unwrap(), "new");
  }

  #[cfg(unix)]
  #[test]
  fn saving_to_a_new_path_still_works() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("brand-new.txt");
    assert!(!path.exists());

    write_text_atomic(&path, "hello").unwrap();

    assert_eq!(read_text(&path).unwrap(), "hello");
  }

  #[cfg(unix)]
  #[test]
  fn saving_a_0600_file_keeps_its_mode() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempdir().unwrap();
    let path = dir.path().join("secret.txt");
    fs::write(&path, "old").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

    write_text_atomic(&path, "new").unwrap();

    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "mode must survive the save, not widen to 0644");
    assert_eq!(read_text(&path).unwrap(), "new");
  }

  #[cfg(unix)]
  #[test]
  fn saving_a_new_file_that_does_not_exist_yet_still_succeeds() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("does-not-exist-yet.txt");
    assert!(!path.exists());

    write_text_atomic(&path, "hello").unwrap();

    assert_eq!(read_text(&path).unwrap(), "hello");
  }

  #[cfg(unix)]
  #[test]
  fn a_private_write_creates_the_file_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempdir().unwrap();
    let path = dir.path().join("note.json");

    write_text_atomic_private(&path, "{}").unwrap();

    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(
      mode, 0o600,
      "a snapshot must not be readable by other users"
    );
  }

  #[cfg(unix)]
  #[test]
  fn a_private_write_creates_the_directory_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempdir().unwrap();
    let dir = root.path().join("Note&Pad/snapshots");
    assert!(!dir.exists());

    write_text_atomic_private(&dir.join("note.json"), "{}").unwrap();

    // Without `x` on the directory another local user cannot resolve a path
    // under it, so this is what hides the file names, not just the contents.
    let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
  }

  #[cfg(unix)]
  #[test]
  fn a_private_write_leaves_an_existing_directory_alone() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempdir().unwrap();
    let dir = root.path().join("snapshots");
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();

    write_text_atomic_private(&dir.join("note.json"), "{}").unwrap();

    // A directory the user already had is theirs, not ours to re-permission.
    let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o755);
  }

  #[cfg(unix)]
  #[test]
  fn a_private_write_leaves_an_existing_file_mode_alone() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempdir().unwrap();
    let path = dir.path().join("note.json");
    fs::write(&path, "{}").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

    write_text_atomic_private(&path, "{\"a\":1}").unwrap();

    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(
      mode, 0o644,
      "an existing mode is the user's, not ours to narrow"
    );
  }

  #[cfg(unix)]
  #[test]
  fn an_ordinary_write_is_not_narrowed_to_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempdir().unwrap();
    let path = dir.path().join("document.txt");

    write_text_atomic(&path, "hello").unwrap();

    // Documents are the user's own files and follow the umask, exactly as
    // every other editor's saves do. The private mode must not leak here.
    // The reference is a file created the plain way in the same process, so
    // the comparison holds under whatever umask the test runs with.
    let reference = dir.path().join("reference.txt");
    fs::File::create(&reference).unwrap();
    let expected = fs::metadata(&reference).unwrap().permissions().mode() & 0o777;

    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, expected);
    assert_ne!(mode, 0o600, "an ordinary save must not become owner-only");
  }
}
