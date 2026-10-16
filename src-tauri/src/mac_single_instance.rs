// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! One instance per app data directory on macOS.
//!
//! Launch Services reuses a running instance for ordinary opens, but `open -n`
//! or running the executable directly starts a second process, and two
//! processes overwrite each other's notes, settings and snapshots. The first
//! process holds an exclusive `flock` on a file in the data directory. A later
//! one asks Launch Services to open the running instance, which then behaves
//! as for a Dock-icon click, and exits before it reads any app data.
//!
//! Nothing is read from the other process: the lock and the `.quitting`
//! marker are the only shared state.
use block2::RcBlock;
use objc2::rc::{autoreleasepool, Retained};
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSBundle, NSError, NSString, NSURL};
use std::ffi::CStr;
use std::fs::{DirBuilder, File};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};
/// `identifier` in tauri.conf.json.
const IDENTIFIER_FULL: &str = "net.lonshaus.note-n-pad";
/// `identifier` in tauri.lite.conf.json.
const IDENTIFIER_LITE: &str = "net.lonshaus.note-n-pad-lite";
/// The bundle identifier, which also names the app data directory.
const IDENTIFIER: &str = if cfg!(feature = "lite") {
  IDENTIFIER_LITE
} else {
  IDENTIFIER_FULL
};
const LOCK_NAME: &CStr = c".instance.lock";
/// Exists while the lock holder runs its quit handshake.
const QUITTING_NAME: &CStr = c".quitting";
/// How long a second start keeps trying to reach the running instance.
const BUDGET: Duration = Duration::from_secs(5);
/// The budget while `.quitting` exists: the quit may wait on the user's
/// save/discard decision or a slow disk.
const QUIT_BUDGET: Duration = Duration::from_secs(60);
/// How long the lock is watched after a hand-over, in case the holder was
/// exiting anyway.
const CONFIRM: Duration = Duration::from_millis(1500);
const POLL: Duration = Duration::from_millis(100);
/// `O_NONBLOCK` keeps a FIFO planted under the file's name from blocking the
/// open; there is no `O_TRUNC`, the file's content is never used.
const FILE_FLAGS: libc::c_int =
  libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
/// The data directory, kept open for the `.quitting` marker.
static DIR: OnceLock<File> = OnceLock::new();
/// The locked file. Closing it would release the lock, so it is never dropped.
static LOCK: OnceLock<File> = OnceLock::new();
/// The validated data directory and the lock file opened in it.
struct Fds {
  dir: File,
  lock: File,
}
/// What a `flock` result means for this start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Decision {
  /// The lock was acquired: this is the only instance.
  Launch,
  /// Another process holds the lock.
  HandOver,
  /// `flock` itself failed (for example on a network home): launch without
  /// the guard.
  LaunchUnguarded(i32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
  /// Looking for the running instance to open.
  Seeking,
  /// The open request reached a running instance at this elapsed time.
  HandedOver(Duration),
}
/// One poll of the hand-over loop.
#[derive(Clone, Copy, Debug)]
struct Seen {
  lock: Decision,
  quitting: bool,
  candidate: bool,
  elapsed: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Exit {
  HandedOver,
  BudgetExhausted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
  Launch,
  LaunchUnguarded(i32),
  /// Ask Launch Services to open the candidate.
  Open,
  /// Sleep one poll interval, then look again in this phase.
  Wait(Phase),
  Exit(Exit),
}
/// A running application with this bundle identifier.
#[derive(Clone, Debug)]
struct Candidate {
  pid: i32,
  terminated: bool,
  bundle: Option<String>,
}
/// Makes this process the only instance for its data directory, or hands
/// over to the running one and exits. Returns when this process may launch.
pub fn ensure() {
  let Some(dir) = data_dir() else {
    eprintln!("single-instance guard is off: no data directory");
    return;
  };
  match start_in(&dir) {
    Ok((fds, Decision::Launch)) => keep(fds),
    Ok((fds, Decision::HandOver)) => hand_over(fds),
    Ok((_, Decision::LaunchUnguarded(errno))) => {
      eprintln!(
        "single-instance guard is off: flock failed: {}",
        io::Error::from_raw_os_error(errno)
      );
    }
    Err(why) => eprintln!("single-instance guard is off: {why}"),
  }
}
/// Creates `.quitting`; called when the quit handshake starts.
pub fn mark_quitting() {
  if LOCK.get().is_none() {
    return;
  }
  if let Some(dir) = DIR.get() {
    if let Err(why) = open_in(dir, QUITTING_NAME) {
      log::warn!("could not create the quitting marker: {why}");
    }
  }
}
/// Removes `.quitting`; called when the quit handshake is vetoed.
pub fn clear_quitting() {
  if let Some(dir) = DIR.get() {
    remove_marker(dir);
  }
}
/// The app data directory by the rule Tauri's `app_data_dir` uses on macOS,
/// so the lock always sits beside the data it protects.
fn data_dir() -> Option<PathBuf> {
  dirs::data_dir().map(|dir| dir.join(IDENTIFIER))
}

fn start_in(dir: &Path) -> Result<(Fds, Decision), String> {
  DirBuilder::new()
    .recursive(true)
    .mode(0o700)
    .create(dir)
    .map_err(|e| format!("create {}: {e}", dir.display()))?;
  let dir = open_dir(dir)?;
  let lock = open_in(&dir, LOCK_NAME)?;
  let fds = Fds { dir, lock };
  let decision = decide(try_lock(&fds.lock));
  if decision == Decision::Launch {
    remove_marker(&fds.dir);
  }
  Ok((fds, decision))
}
/// Holds both fds for the rest of the process.
fn keep(fds: Fds) {
  let _ = DIR.set(fds.dir);
  let _ = LOCK.set(fds.lock);
}

fn hand_over(fds: Fds) {
  let start = Instant::now();
  let mut phase = Phase::Seeking;
  loop {
    let lock = decide(try_lock(&fds.lock));
    let quitting = lock == Decision::HandOver && marker_exists(&fds.dir);
    let target = if lock == Decision::HandOver && !quitting && phase == Phase::Seeking {
      find_target()
    } else {
      None
    };
    let seen = Seen {
      lock,
      quitting,
      candidate: target.is_some(),
      elapsed: start.elapsed(),
    };
    match (step(phase, seen), target) {
      (Step::Launch, _) => {
        remove_marker(&fds.dir);
        keep(fds);
        return;
      }
      (Step::LaunchUnguarded(errno), _) => {
        eprintln!(
          "single-instance guard is off: flock failed: {}",
          io::Error::from_raw_os_error(errno)
        );
        return;
      }
      (Step::Open, Some(url)) => {
        if open(&url, BUDGET.saturating_sub(start.elapsed())) {
          phase = Phase::HandedOver(start.elapsed());
        } else {
          phase = Phase::Seeking;
          std::thread::sleep(POLL);
        }
      }
      (Step::Open, None) => {
        phase = Phase::Seeking;
        std::thread::sleep(POLL);
      }
      (Step::Wait(next), _) => {
        phase = next;
        std::thread::sleep(POLL);
      }
      (Step::Exit(Exit::HandedOver), _) => {
        eprintln!("handed over to the running instance");
        std::process::exit(0);
      }
      (Step::Exit(Exit::BudgetExhausted), _) => {
        eprintln!("another instance holds the lock and could not be reached; exiting");
        std::process::exit(0);
      }
    }
  }
}
/// The hand-over loop's decision for one poll.
fn step(phase: Phase, seen: Seen) -> Step {
  match seen.lock {
    Decision::Launch => return Step::Launch,
    Decision::LaunchUnguarded(errno) => return Step::LaunchUnguarded(errno),
    Decision::HandOver => {}
  }
  if seen.quitting {
    if seen.elapsed >= QUIT_BUDGET {
      return Step::Exit(Exit::BudgetExhausted);
    }
    return Step::Wait(Phase::Seeking);
  }
  if let Phase::HandedOver(at) = phase {
    if seen.elapsed >= at + CONFIRM {
      return Step::Exit(Exit::HandedOver);
    }
    return Step::Wait(phase);
  }
  if seen.elapsed >= BUDGET {
    return Step::Exit(Exit::BudgetExhausted);
  }
  if seen.candidate {
    Step::Open
  } else {
    Step::Wait(Phase::Seeking)
  }
}

fn decide(result: Result<(), i32>) -> Decision {
  match result {
    Ok(()) => Decision::Launch,
    Err(libc::EWOULDBLOCK) => Decision::HandOver,
    Err(errno) => Decision::LaunchUnguarded(errno),
  }
}
/// Non-blocking exclusive `flock`, retried on `EINTR`; `Err` carries errno.
fn try_lock(file: &File) -> Result<(), i32> {
  loop {
    // Contained unsafe: flock on an fd this File owns.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
      return Ok(());
    }
    let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
    if errno != libc::EINTR {
      return Err(errno);
    }
  }
}

fn euid() -> libc::uid_t {
  // Contained unsafe: geteuid has no preconditions.
  unsafe { libc::geteuid() }
}

fn fstat(file: &File) -> Result<libc::stat, String> {
  let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
  // Contained unsafe: fstat fills `st` on success, which is checked first.
  if unsafe { libc::fstat(file.as_raw_fd(), st.as_mut_ptr()) } != 0 {
    return Err(format!("fstat: {}", io::Error::last_os_error()));
  }
  Ok(unsafe { st.assume_init() })
}
/// Group-writable is accepted; other-writable is not.
fn check_dir(mode: libc::mode_t, uid: libc::uid_t, euid: libc::uid_t) -> Result<(), String> {
  if mode & libc::S_IFMT != libc::S_IFDIR {
    return Err("the data directory is not a directory".into());
  }
  if uid != euid {
    return Err("the data directory belongs to another user".into());
  }
  if mode & libc::S_IWOTH != 0 {
    return Err("the data directory is writable by others".into());
  }
  Ok(())
}

fn check_file(mode: libc::mode_t, uid: libc::uid_t, euid: libc::uid_t) -> Result<(), String> {
  if mode & libc::S_IFMT != libc::S_IFREG {
    return Err("not a regular file".into());
  }
  if uid != euid {
    return Err("belongs to another user".into());
  }
  Ok(())
}
/// Opens `dir` without following a symlink at its last component, then
/// checks what was opened.
fn open_dir(dir: &Path) -> Result<File, String> {
  let path = std::ffi::CString::new(dir.as_os_str().as_bytes())
    .map_err(|_| format!("{} contains a NUL byte", dir.display()))?;
  // Contained unsafe: open with a NUL-terminated path; the fd is owned below.
  let fd = unsafe {
    libc::open(
      path.as_ptr(),
      libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
  };
  if fd < 0 {
    return Err(format!(
      "open {}: {}",
      dir.display(),
      io::Error::last_os_error()
    ));
  }
  // Contained unsafe: `fd` is a fresh descriptor nothing else owns.
  let file = unsafe { File::from_raw_fd(fd) };
  let st = fstat(&file)?;
  check_dir(st.st_mode, st.st_uid, euid())?;
  Ok(file)
}
/// Opens or creates `name` inside `dir` without following a symlink or
/// blocking on a FIFO, then checks what was opened.
fn open_in(dir: &File, name: &CStr) -> Result<File, String> {
  // Contained unsafe: openat relative to an fd this File owns; the fd is
  // owned below.
  let fd = unsafe {
    libc::openat(
      dir.as_raw_fd(),
      name.as_ptr(),
      FILE_FLAGS,
      0o600 as libc::c_uint,
    )
  };
  if fd < 0 {
    return Err(format!(
      "open {}: {}",
      name.to_string_lossy(),
      io::Error::last_os_error()
    ));
  }
  // Contained unsafe: `fd` is a fresh descriptor nothing else owns.
  let file = unsafe { File::from_raw_fd(fd) };
  let st = fstat(&file)?;
  check_file(st.st_mode, st.st_uid, euid())
    .map_err(|why| format!("{}: {why}", name.to_string_lossy()))?;
  Ok(file)
}

fn marker_exists(dir: &File) -> bool {
  let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
  // Contained unsafe: fstatat relative to an fd this File owns, not
  // following a symlink; `st` is not read.
  unsafe {
    libc::fstatat(
      dir.as_raw_fd(),
      QUITTING_NAME.as_ptr(),
      st.as_mut_ptr(),
      libc::AT_SYMLINK_NOFOLLOW,
    ) == 0
  }
}

fn remove_marker(dir: &File) {
  // Contained unsafe: unlinkat relative to an fd this File owns; it removes
  // a symlink itself, never its target. A missing marker is not an error.
  unsafe {
    libc::unlinkat(dir.as_raw_fd(), QUITTING_NAME.as_ptr(), 0);
  }
}
/// Index of the instance to open: never this process, a terminated entry or
/// one without a bundle URL; one from this process's own bundle first.
fn choose(candidates: &[Candidate], own_pid: i32, own_bundle: Option<&str>) -> Option<usize> {
  let usable = |c: &Candidate| c.pid != own_pid && !c.terminated && c.bundle.is_some();
  own_bundle
    .and_then(|own| {
      candidates
        .iter()
        .position(|c| usable(c) && c.bundle.as_deref() == Some(own))
    })
    .or_else(|| candidates.iter().position(usable))
}
/// The bundle URL of the running instance to open, if one is registered yet.
fn find_target() -> Option<Retained<NSURL>> {
  autoreleasepool(|_| {
    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(
      IDENTIFIER,
    ));
    let own_bundle = NSBundle::mainBundle()
      .bundleURL()
      .path()
      .map(|p| p.to_string());
    let mut candidates = Vec::new();
    let mut urls = Vec::new();
    for app in apps.iter() {
      let url = app.bundleURL();
      candidates.push(Candidate {
        pid: app.processIdentifier(),
        terminated: app.isTerminated(),
        bundle: url.as_ref().and_then(|u| u.path()).map(|p| p.to_string()),
      });
      urls.push(url);
    }
    let index = choose(
      &candidates,
      std::process::id() as i32,
      own_bundle.as_deref(),
    )?;
    urls.swap_remove(index)
  })
}
/// The same request `open -a` and a Dock-icon click make. Waits up to `wait`
/// for Launch Services' answer; `true` when it reached a running instance.
fn open(url: &NSURL, wait: Duration) -> bool {
  let (tx, rx) = mpsc::channel();
  let handler = RcBlock::new(
    move |app: *mut NSRunningApplication, _error: *mut NSError| {
      let _ = tx.send(!app.is_null());
    },
  );
  autoreleasepool(|_| {
    let config = NSWorkspaceOpenConfiguration::configuration();
    config.setActivates(true);
    config.setCreatesNewApplicationInstance(false);
    NSWorkspace::sharedWorkspace().openApplicationAtURL_configuration_completionHandler(
      url,
      &config,
      Some(&*handler),
    );
  });
  rx.recv_timeout(wait).unwrap_or(false)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::os::unix::fs::{symlink, PermissionsExt};

  fn conf_identifier(file: &str) -> String {
    let path = format!("{}/{file}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(path).unwrap();
    let conf: serde_json::Value = serde_json::from_str(&text).unwrap();
    conf["identifier"].as_str().unwrap().to_owned()
  }

  fn seen(lock: Decision, quitting: bool, candidate: bool, elapsed_ms: u64) -> Seen {
    Seen {
      lock,
      quitting,
      candidate,
      elapsed: Duration::from_millis(elapsed_ms),
    }
  }

  fn candidate(pid: i32, terminated: bool, bundle: Option<&str>) -> Candidate {
    Candidate {
      pid,
      terminated,
      bundle: bundle.map(str::to_owned),
    }
  }

  fn dir_with_mode(root: &Path, mode: u32) -> PathBuf {
    let dir = root.join(format!("d{mode:o}"));
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();
    dir
  }

  #[test]
  fn identifiers_match_the_conf_files() {
    assert_eq!(IDENTIFIER_FULL, conf_identifier("tauri.conf.json"));
    assert_eq!(IDENTIFIER_LITE, conf_identifier("tauri.lite.conf.json"));
    let expected = if cfg!(feature = "lite") {
      IDENTIFIER_LITE
    } else {
      IDENTIFIER_FULL
    };
    assert_eq!(IDENTIFIER, expected);
  }

  #[test]
  fn data_dir_follows_the_tauri_rule() {
    assert_eq!(data_dir(), Some(dirs::data_dir().unwrap().join(IDENTIFIER)));
  }

  #[test]
  fn check_dir_accepts_owner_and_group_writable_rejects_others() {
    let me = 501;
    for mode in [0o700, 0o755, 0o775] {
      assert!(check_dir(libc::S_IFDIR | mode, me, me).is_ok(), "{mode:o}");
    }
    assert!(check_dir(libc::S_IFDIR | 0o777, me, me).is_err());
    assert!(check_dir(libc::S_IFDIR | 0o702, me, me).is_err());
    assert!(check_dir(libc::S_IFDIR | 0o700, 0, me).is_err());
    assert!(check_dir(libc::S_IFREG | 0o700, me, me).is_err());
  }

  #[test]
  fn open_dir_checks_real_directories() {
    let root = tempfile::tempdir().unwrap();
    for mode in [0o700, 0o755, 0o775] {
      assert!(
        open_dir(&dir_with_mode(root.path(), mode)).is_ok(),
        "{mode:o}"
      );
    }
    for mode in [0o777, 0o757] {
      assert!(
        open_dir(&dir_with_mode(root.path(), mode)).is_err(),
        "{mode:o}"
      );
    }
  }

  #[test]
  fn open_dir_rejects_a_symlinked_directory() {
    let root = tempfile::tempdir().unwrap();
    let real = dir_with_mode(root.path(), 0o700);
    let link = root.path().join("link");
    symlink(&real, &link).unwrap();
    assert!(open_dir(&link).is_err());
  }

  #[test]
  fn check_file_rejects_non_regular_and_foreign_files() {
    let me = 501;
    assert!(check_file(libc::S_IFREG | 0o600, me, me).is_ok());
    assert!(check_file(libc::S_IFREG | 0o600, 0, me).is_err());
    assert!(check_file(libc::S_IFIFO | 0o600, me, me).is_err());
    assert!(check_file(libc::S_IFDIR | 0o700, me, me).is_err());
  }

  #[test]
  fn lock_open_rejects_a_symlink() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    std::fs::write(&target, b"").unwrap();
    symlink(&target, root.path().join(".instance.lock")).unwrap();
    let dir = open_dir(root.path()).unwrap();
    assert!(open_in(&dir, LOCK_NAME).is_err());
  }

  #[test]
  fn lock_open_rejects_a_fifo_without_blocking() {
    let root = tempfile::tempdir().unwrap();
    let fifo =
      std::ffi::CString::new(root.path().join(".instance.lock").as_os_str().as_bytes()).unwrap();
    // Contained unsafe: mkfifo with a NUL-terminated path.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let dir = open_dir(root.path()).unwrap();
    assert!(open_in(&dir, LOCK_NAME).is_err());
  }

  #[test]
  fn lock_open_rejects_a_directory() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join(".instance.lock")).unwrap();
    let dir = open_dir(root.path()).unwrap();
    assert!(open_in(&dir, LOCK_NAME).is_err());
  }

  #[test]
  fn decide_maps_each_flock_result() {
    assert_eq!(decide(Ok(())), Decision::Launch);
    assert_eq!(decide(Err(libc::EWOULDBLOCK)), Decision::HandOver);
    assert_eq!(
      decide(Err(libc::ENOTSUP)),
      Decision::LaunchUnguarded(libc::ENOTSUP)
    );
    assert_eq!(
      decide(Err(libc::ENOLCK)),
      Decision::LaunchUnguarded(libc::ENOLCK)
    );
  }

  #[test]
  fn second_flock_fails_while_held_and_succeeds_after_release() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("lock");
    let first = File::create(&path).unwrap();
    let second = File::open(&path).unwrap();
    assert_eq!(try_lock(&first), Ok(()));
    assert_eq!(try_lock(&second), Err(libc::EWOULDBLOCK));
    drop(first);
    assert_eq!(try_lock(&second), Ok(()));
  }

  #[test]
  fn start_in_creates_a_private_directory_and_takes_the_lock() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("app");
    let (held, decision) = start_in(&dir).unwrap();
    assert_eq!(decision, Decision::Launch);
    let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
    let lock_mode = std::fs::metadata(dir.join(".instance.lock"))
      .unwrap()
      .permissions()
      .mode();
    assert_eq!(lock_mode & 0o777, 0o600);
    let (_, second) = start_in(&dir).unwrap();
    assert_eq!(second, Decision::HandOver);
    drop(held);
    let (_, third) = start_in(&dir).unwrap();
    assert_eq!(third, Decision::Launch);
  }

  #[test]
  fn new_lock_holder_removes_a_stale_quitting_marker() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("app");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(dir.join(".quitting"), b"").unwrap();
    let (held, decision) = start_in(&dir).unwrap();
    assert_eq!(decision, Decision::Launch);
    assert!(!dir.join(".quitting").exists());
    assert!(!marker_exists(&held.dir));
  }

  #[test]
  fn waiting_start_leaves_the_quitting_marker() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("app");
    let (held, _) = start_in(&dir).unwrap();
    open_in(&held.dir, QUITTING_NAME).unwrap();
    let (_, decision) = start_in(&dir).unwrap();
    assert_eq!(decision, Decision::HandOver);
    assert!(marker_exists(&held.dir));
    remove_marker(&held.dir);
    assert!(!marker_exists(&held.dir));
  }

  #[test]
  fn choose_prefers_the_own_bundle_and_skips_unusable_entries() {
    let own = "/Applications/Note&Pad.app";
    let list = [
      candidate(10, false, Some("/tmp/Other.app")),
      candidate(11, false, Some(own)),
    ];
    assert_eq!(choose(&list, 99, Some(own)), Some(1));
    assert_eq!(choose(&list, 99, None), Some(0));
    let skipped = [
      candidate(99, false, Some(own)),
      candidate(12, true, Some(own)),
      candidate(13, false, None),
      candidate(14, false, Some("/tmp/Other.app")),
    ];
    assert_eq!(choose(&skipped, 99, Some(own)), Some(3));
    assert_eq!(choose(&skipped[..3], 99, Some(own)), None);
    assert_eq!(choose(&[], 99, Some(own)), None);
  }

  #[test]
  fn step_waits_while_quitting_then_launches() {
    let held = Decision::HandOver;
    assert_eq!(
      step(Phase::Seeking, seen(held, true, true, 10_000)),
      Step::Wait(Phase::Seeking)
    );
    assert_eq!(
      step(Phase::Seeking, seen(Decision::Launch, true, false, 20_000)),
      Step::Launch
    );
    assert_eq!(
      step(Phase::Seeking, seen(held, true, false, 60_000)),
      Step::Exit(Exit::BudgetExhausted)
    );
  }

  #[test]
  fn step_opens_a_candidate_or_keeps_seeking() {
    let held = Decision::HandOver;
    assert_eq!(step(Phase::Seeking, seen(held, false, true, 0)), Step::Open);
    assert_eq!(
      step(Phase::Seeking, seen(held, false, false, 300)),
      Step::Wait(Phase::Seeking)
    );
  }

  #[test]
  fn step_after_hand_over() {
    let held = Decision::HandOver;
    let phase = Phase::HandedOver(Duration::from_millis(1000));
    assert_eq!(
      step(phase, seen(Decision::Launch, false, false, 2000)),
      Step::Launch
    );
    assert_eq!(
      step(phase, seen(held, false, false, 2000)),
      Step::Wait(phase)
    );
    assert_eq!(
      step(phase, seen(held, false, false, 2500)),
      Step::Exit(Exit::HandedOver)
    );
    assert_eq!(
      step(phase, seen(held, true, false, 2000)),
      Step::Wait(Phase::Seeking)
    );
  }

  #[test]
  fn step_exits_when_the_budget_ends() {
    let held = Decision::HandOver;
    assert_eq!(
      step(Phase::Seeking, seen(held, false, true, 5000)),
      Step::Exit(Exit::BudgetExhausted)
    );
    assert_eq!(
      step(Phase::Seeking, seen(held, false, false, 5000)),
      Step::Exit(Exit::BudgetExhausted)
    );
  }

  #[test]
  fn step_launches_unguarded_on_a_flock_error() {
    assert_eq!(
      step(
        Phase::Seeking,
        seen(Decision::LaunchUnguarded(libc::ENOLCK), false, false, 0)
      ),
      Step::LaunchUnguarded(libc::ENOLCK)
    );
  }
}
