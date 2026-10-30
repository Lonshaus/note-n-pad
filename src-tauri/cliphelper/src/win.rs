// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! The Windows side: a hidden window that owns the clipboard with a delayed
//! `CF_UNICODETEXT` and renders it from the clip file when asked.
//!
//! The app starts this program with the clip path as its only argument and its
//! own pid in `NOTENPAD_CLIP_PARENT_PID`, stdin and stdout piped. The talk is
//! line based: `ready` once the clip is held open, `arm` back from the app, then
//! `armed` once this window owns the clipboard, or `failed` at any point.
//!
//! `cliphelper.exe release` asks every running helper to hand its text to the
//! clipboard for real and exit; the installer runs it before replacing files.
use crate::convert::stream_reader_utf16;
use std::fs::File;
use std::io::{BufRead, Seek, SeekFrom, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
  CloseHandle, GetLastError, GlobalFree, HWND, INVALID_HANDLE_VALUE, LPARAM, LRESULT, WPARAM,
};
use windows_sys::Win32::System::DataExchange::{
  CloseClipboard, EmptyClipboard, GetClipboardOwner, IsClipboardFormatAvailable, OpenClipboard,
  SetClipboardData,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
  CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Threading::{
  CreateEventW, OpenProcess, ResetEvent, SetEvent, WaitForSingleObject, INFINITE,
  PROCESS_SYNCHRONIZE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostMessageW,
  PostQuitMessage, RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WM_DESTROYCLIPBOARD,
  WM_RENDERALLFORMATS, WM_RENDERFORMAT, WNDCLASSW,
};
// CF_UNICODETEXT, as a literal to keep the Win32_System_Ole feature out.
const CF_UNICODETEXT: u32 = 13;
const GENERIC_READ: u32 = 0x8000_0000;
const DELETE_ACCESS: u32 = 0x0001_0000;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
/// Posted to the window to hand the text over and exit.
const WM_APP_RELEASE: u32 = 0x8000 + 1;
/// One per login session, manual-reset, so one `SetEvent` reaches every helper.
const RELEASE_EVENT: &str = "Local\\NoteNPad-cliphelper-release";
const PARENT_PID_VAR: &str = "NOTENPAD_CLIP_PARENT_PID";
const HELPER_EXE: &str = "cliphelper.exe";
/// How long `release` waits for the other helpers to go.
const RELEASE_WAIT: Duration = Duration::from_secs(10);
/// The clip, held open with `FILE_FLAG_DELETE_ON_CLOSE` and shared for reading
/// only, so nothing else can delete it while it is the clipboard; closing the
/// handle deletes it.
static CLIP_FILE: Mutex<Option<File>> = Mutex::new(None);
/// Set once the clipboard was taken over, the text handed over or the clip
/// closed: later render requests are refused.
static CLIP_RELEASED: AtomicBool = AtomicBool::new(false);
static HELPER_HWND: AtomicIsize = AtomicIsize::new(0);

fn wide(s: &str) -> Vec<u16> {
  s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn say(line: &str) {
  let mut out = std::io::stdout();
  let _ = writeln!(out, "{line}");
  let _ = out.flush();
}

unsafe fn create_message_window() -> HWND {
  let hinst = GetModuleHandleW(null());
  let class_name = wide("NoteNPadClipHelperWindow");
  let mut wc: WNDCLASSW = std::mem::zeroed();
  wc.lpfnWndProc = Some(wnd_proc);
  wc.hInstance = hinst;
  wc.lpszClassName = class_name.as_ptr();
  RegisterClassW(&wc);
  let title = wide("cliphelper");
  CreateWindowExW(
    0,
    class_name.as_ptr(),
    title.as_ptr(),
    0,
    0,
    0,
    0,
    0,
    HWND_MESSAGE,
    null_mut(),
    hinst,
    null(),
  )
}
/// Puts the clip's text on the open clipboard as `CF_UNICODETEXT`. Two streaming
/// passes (count, then copy) keep the peak at the output block plus one input
/// chunk and one converted piece.
unsafe fn render() -> Result<(), String> {
  if CLIP_RELEASED.load(Ordering::SeqCst) {
    return Err("the clip is released".to_string());
  }
  let mut held = CLIP_FILE.lock().unwrap();
  let file = held.as_mut().ok_or("no clip")?;
  let mut pass = |sink: &mut dyn FnMut(&[u16])| -> std::io::Result<u64> {
    file.seek(SeekFrom::Start(0))?;
    stream_reader_utf16(file, |piece| sink(piece)).map(|(_, units)| units)
  };
  let units = pass(&mut |_| {}).map_err(|e| format!("count pass: {e}"))? as usize;
  let hmem = GlobalAlloc(GMEM_MOVEABLE, (units + 1) * 2);
  if hmem.is_null() {
    return Err(format!("GlobalAlloc failed, error {}", GetLastError()));
  }
  let ptr = GlobalLock(hmem) as *mut u16;
  if ptr.is_null() {
    GlobalFree(hmem);
    return Err(format!("GlobalLock failed, error {}", GetLastError()));
  }
  let buf = std::slice::from_raw_parts_mut(ptr, units + 1);
  let mut at = 0usize;
  let copied = pass(&mut |piece| {
    // The file does not change, but never write past the block.
    let n = piece.len().min(units - at);
    buf[at..at + n].copy_from_slice(&piece[..n]);
    at += n;
  });
  if let Err(e) = copied {
    GlobalUnlock(hmem);
    GlobalFree(hmem);
    return Err(format!("copy pass: {e}"));
  }
  buf[at] = 0;
  GlobalUnlock(hmem);
  if SetClipboardData(CF_UNICODETEXT, hmem).is_null() {
    let err = GetLastError();
    GlobalFree(hmem);
    return Err(format!("SetClipboardData failed, error {err}"));
  }
  Ok(())
}
/// Closes the clip, which deletes it, and ends the message loop.
fn finish() {
  CLIP_RELEASED.store(true, Ordering::SeqCst);
  drop(CLIP_FILE.lock().unwrap().take());
  unsafe { PostQuitMessage(0) };
}

unsafe extern "system" fn wnd_proc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM,
) -> LRESULT {
  match msg {
    WM_RENDERFORMAT => {
      if wparam as u32 == CF_UNICODETEXT {
        let _ = render();
      }
      0
    }
    // Also sent after WM_DESTROYCLIPBOARD, when the text is no longer wanted:
    // `render` refuses then.
    WM_RENDERALLFORMATS => {
      if !CLIP_RELEASED.load(Ordering::SeqCst) && OpenClipboard(hwnd) != 0 {
        if GetClipboardOwner() == hwnd {
          let _ = render();
        }
        CloseClipboard();
      }
      0
    }
    WM_DESTROYCLIPBOARD => {
      finish();
      0
    }
    WM_APP_RELEASE => {
      if !CLIP_RELEASED.load(Ordering::SeqCst) && OpenClipboard(hwnd) != 0 {
        if GetClipboardOwner() == hwnd {
          let _ = render();
        }
        CloseClipboard();
      }
      finish();
      0
    }
    _ => DefWindowProcW(hwnd, msg, wparam, lparam),
  }
}

unsafe fn pump_messages() {
  let mut msg: MSG = std::mem::zeroed();
  while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
}

fn post_release() {
  unsafe {
    PostMessageW(
      HELPER_HWND.load(Ordering::SeqCst) as HWND,
      WM_APP_RELEASE,
      0,
      0,
    )
  };
}
/// Announces `CF_UNICODETEXT` with no data, so the window owns the clipboard.
unsafe fn take_clipboard(hwnd: HWND) -> bool {
  for _ in 0..40 {
    if OpenClipboard(hwnd) != 0 {
      EmptyClipboard();
      SetClipboardData(CF_UNICODETEXT, null_mut());
      let ours = GetClipboardOwner() == hwnd && IsClipboardFormatAvailable(CF_UNICODETEXT) != 0;
      CloseClipboard();
      return ours;
    }
    std::thread::sleep(Duration::from_millis(50));
  }
  false
}
/// Ends the helper when the app goes, however it goes, handing the text over.
fn watch_parent(pid: u32) {
  std::thread::spawn(move || unsafe {
    let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
    if !process.is_null() {
      WaitForSingleObject(process, INFINITE);
    }
    post_release();
  });
}
/// Ends the helper when the installer's `release` asks.
fn watch_release_event() {
  std::thread::spawn(|| unsafe {
    let name = wide(RELEASE_EVENT);
    let event = CreateEventW(null(), 1, 0, name.as_ptr());
    if !event.is_null() {
      WaitForSingleObject(event, INFINITE);
      post_release();
    }
  });
}

fn serve(clip: &Path) -> i32 {
  let opened = std::fs::OpenOptions::new()
    .access_mode(GENERIC_READ | DELETE_ACCESS)
    .share_mode(FILE_SHARE_READ)
    .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
    .open(clip);
  match opened {
    Ok(file) => *CLIP_FILE.lock().unwrap() = Some(file),
    Err(_) => {
      say("failed");
      return 1;
    }
  }
  say("ready");
  let mut line = String::new();
  let _ = std::io::stdin().lock().read_line(&mut line);
  if line.trim() != "arm" {
    return 1;
  }
  unsafe {
    let hwnd = create_message_window();
    if hwnd.is_null() || !take_clipboard(hwnd) {
      say("failed");
      return 1;
    }
    HELPER_HWND.store(hwnd as isize, Ordering::SeqCst);
    say("armed");
    watch_release_event();
    match std::env::var(PARENT_PID_VAR)
      .ok()
      .and_then(|v| v.parse::<u32>().ok())
    {
      Some(pid) => watch_parent(pid),
      // Without the app to watch there is nobody to hand the text to.
      None => post_release(),
    }
    pump_messages();
    DestroyWindow(hwnd);
  }
  0
}
/// How many helpers other than this process are running.
fn other_helpers() -> usize {
  unsafe {
    let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if snapshot == INVALID_HANDLE_VALUE {
      return 0;
    }
    let mut entry: PROCESSENTRY32W = std::mem::zeroed();
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let me = std::process::id();
    let mut count = 0;
    let mut more = Process32FirstW(snapshot, &mut entry);
    while more != 0 {
      let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
      let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
      if name.eq_ignore_ascii_case(HELPER_EXE) && entry.th32ProcessID != me {
        count += 1;
      }
      more = Process32NextW(snapshot, &mut entry);
    }
    CloseHandle(snapshot);
    count
  }
}
/// What the installer's hook runs: signal every live helper, then wait until
/// none is left.
fn release_all() -> i32 {
  unsafe {
    let name = wide(RELEASE_EVENT);
    let event = CreateEventW(null(), 1, 0, name.as_ptr());
    if event.is_null() {
      return 1;
    }
    SetEvent(event);
    let start = Instant::now();
    while other_helpers() > 0 && start.elapsed() < RELEASE_WAIT {
      std::thread::sleep(Duration::from_millis(100));
    }
    // Manual-reset: clear it, or a helper started later would exit at once.
    ResetEvent(event);
  }
  0
}

pub fn run() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let code = match args.as_slice() {
    [command] if command == "release" => release_all(),
    [clip] => serve(Path::new(clip)),
    _ => 2,
  };
  std::process::exit(code);
}
