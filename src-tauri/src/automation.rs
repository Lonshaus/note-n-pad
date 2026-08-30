// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

/// How long an `eval` waits for the webview to report its result before failing.
const EVAL_TIMEOUT: Duration = Duration::from_secs(3);
/// Default TCP port when NOTE_N_PAD_AUTOMATION_PORT is unset.
const DEFAULT_PORT: u16 = 45678;

/// One line-delimited JSON request. Unknown params for a given command are simply
/// left as None; each command reads only the fields it needs.
#[derive(Debug, Deserialize, PartialEq)]
struct Request {
  id: u64,
  cmd: String,
  #[serde(default)]
  label: Option<String>,
  #[serde(default)]
  js: Option<String>,
}

/// One entry of the `list_windows` response.
#[derive(Debug, Serialize)]
struct WindowInfo {
  label: String,
  title: String,
  focused: bool,
}

/// Correlates async `eval` results back to the TCP handler that requested them.
/// The handler registers an id, injects JS that invokes `automation_result`, and
/// blocks in `wait`; the command resolves the slot and wakes the waiter.
#[derive(Default)]
pub struct Correlator {
  slots: Mutex<HashMap<u64, Option<Value>>>,
  ready: Condvar,
}

impl Correlator {
  /// Reserve a slot for `id` so a later resolve is not dropped as unknown.
  pub fn register(&self, id: u64) {
    self.slots.lock().unwrap().insert(id, None);
  }

  /// Fill the slot for `id` and wake the waiter. Unknown ids are ignored.
  pub fn resolve(&self, id: u64, value: Value) {
    let mut slots = self.slots.lock().unwrap();
    if let Some(slot) = slots.get_mut(&id) {
      *slot = Some(value);
      self.ready.notify_all();
    }
  }

  /// Block until the slot for `id` is filled or `timeout` elapses; the slot is
  /// consumed either way so a late resolve cannot leak.
  pub fn wait(&self, id: u64, timeout: Duration) -> Option<Value> {
    let deadline = Instant::now() + timeout;
    let mut slots = self.slots.lock().unwrap();
    loop {
      if matches!(slots.get(&id), Some(Some(_))) {
        return slots.remove(&id).flatten();
      }
      match deadline.checked_duration_since(Instant::now()) {
        Some(remaining) => {
          let (guard, _) = self.ready.wait_timeout(slots, remaining).unwrap();
          slots = guard;
        }
        None => {
          slots.remove(&id);
          return None;
        }
      }
    }
  }
}

fn ok_response(id: u64, data: Value) -> String {
  json!({ "id": id, "ok": true, "data": data }).to_string()
}

fn err_response(id: u64, error: &str) -> String {
  json!({ "id": id, "ok": false, "error": error }).to_string()
}

/// Parse one request line and turn it into a response line.
fn process_line(app: &AppHandle, line: &str) -> String {
  let req: Request = match serde_json::from_str(line) {
    Ok(req) => req,
    Err(e) => return err_response(0, &format!("bad request: {e}")),
  };
  match dispatch(app, &req) {
    Ok(data) => ok_response(req.id, data),
    Err(e) => err_response(req.id, &e),
  }
}

fn dispatch(app: &AppHandle, req: &Request) -> Result<Value, String> {
  match req.cmd.as_str() {
    "list_windows" => Ok(json!(list_windows(app))),
    "store_list" => {
      let store = app.state::<crate::note_store::NoteStore>();
      Ok(json!(store.list()))
    }
    "new_sticky" => {
      let store = app.state::<crate::note_store::NoteStore>();
      let note = crate::windows::new_sticky(app, &store)?;
      Ok(json!(note))
    }
    "focus" => {
      let win = window(app, req)?;
      win.set_focus().map_err(|e| e.to_string())?;
      Ok(Value::Null)
    }
    "window_number" => window_number(app, req),
    "eval" => eval(app, req),
    "quit" => {
      crate::flush_then_exit(app);
      Ok(Value::Null)
    }
    // Two things the webview cannot see: the tray icon's menu is native and
    // Tauri has no getter for it, and a sticky's transparency is the window's
    // own alpha, not a CSS value.
    "tray_menu" => Ok(json!(crate::tray_menu_labels())),
    "window_alpha" => {
      let win = window(app, req)?;
      Ok(json!(crate::windows::window_alpha(&win)))
    }
    other => Err(format!("unknown cmd: {other}")),
  }
}

fn list_windows(app: &AppHandle) -> Vec<WindowInfo> {
  app
    .webview_windows()
    .into_iter()
    .map(|(label, win)| WindowInfo {
      title: win.title().unwrap_or_default(),
      focused: win.is_focused().unwrap_or(false),
      label,
    })
    .collect()
}

/// Resolve the `label` param to a live webview window.
fn window(app: &AppHandle, req: &Request) -> Result<tauri::WebviewWindow, String> {
  let label = req.label.as_deref().ok_or("missing 'label'")?;
  app
    .get_webview_window(label)
    .ok_or_else(|| format!("no such window: {label}"))
}

/// Run JS in a window and return its completion value. The injected wrapper evals
/// the source (so both expressions and statement lists work), then reports the
/// value back through the `automation_result` command keyed by request id.
fn eval(app: &AppHandle, req: &Request) -> Result<Value, String> {
  let win = window(app, req)?;
  let js = req.js.as_deref().ok_or("missing 'js'")?;
  let source = serde_json::to_string(js).unwrap();
  let wrapped = format!(
        "(async () => {{ \
           const done = (value) => window.__TAURI_INTERNALS__.invoke('automation_result', {{ id: {id}, value }}); \
           try {{ const v = await (0, eval)({source}); done(v === undefined ? null : v); }} \
           catch (e) {{ done({{ error: String(e) }}); }} \
         }})();",
        id = req.id,
        source = source,
    );
  let correlator = app.state::<Correlator>();
  correlator.register(req.id);
  win.eval(&wrapped).map_err(|e| e.to_string())?;
  correlator
    .wait(req.id, EVAL_TIMEOUT)
    .ok_or_else(|| "eval timed out".to_string())
}

/// macOS NSWindow windowNumber, for `screencapture -l <n>`. AppKit access must
/// happen on the main thread, so we hop there and pass the value back.
#[cfg(target_os = "macos")]
fn window_number(app: &AppHandle, req: &Request) -> Result<Value, String> {
  let win = window(app, req)?;
  let (tx, rx) = std::sync::mpsc::channel();
  app
    .run_on_main_thread(move || {
      let _ = tx.send(ns_window_number(&win));
    })
    .map_err(|e| e.to_string())?;
  let number = rx
    .recv_timeout(Duration::from_secs(2))
    .map_err(|e| e.to_string())??;
  Ok(json!(number))
}

#[cfg(target_os = "macos")]
fn ns_window_number(win: &tauri::WebviewWindow) -> Result<i64, String> {
  use objc2::msg_send;
  use objc2::runtime::AnyObject;
  let ns_window = win.ns_window().map_err(|e| e.to_string())? as *mut AnyObject;
  // Contained unsafe: NSWindow.windowNumber returns an NSInteger (i64 here).
  let number: i64 = unsafe { msg_send![ns_window, windowNumber] };
  Ok(number)
}

#[cfg(not(target_os = "macos"))]
fn window_number(_app: &AppHandle, _req: &Request) -> Result<Value, String> {
  Err("window_number is macOS-only".to_string())
}

/// The webview-invoked sink that resolves a pending `eval` by request id.
#[tauri::command]
pub fn automation_result(correlator: State<'_, Correlator>, id: u64, value: Value) {
  correlator.resolve(id, value);
}

/// Serve one client at a time: read request lines, write one response line each.
fn handle_client(app: &AppHandle, stream: TcpStream) {
  let reader = match stream.try_clone() {
    Ok(clone) => BufReader::new(clone),
    Err(e) => {
      log::warn!("automation: clone stream failed: {e}");
      return;
    }
  };
  let mut writer = stream;
  for line in reader.lines() {
    let Ok(line) = line else { break };
    if line.trim().is_empty() {
      continue;
    }
    let response = process_line(app, &line);
    if writeln!(writer, "{response}").is_err() || writer.flush().is_err() {
      break;
    }
  }
}

/// Start the automation listener when NOTE_N_PAD_AUTOMATION=1. No-op otherwise, so a
/// plain `tauri dev` is unaffected. Debug-only (the whole module is cfg-gated).
pub fn start(app: AppHandle) {
  if std::env::var("NOTE_N_PAD_AUTOMATION").ok().as_deref() != Some("1") {
    return;
  }
  app.manage(Correlator::default());
  let port = std::env::var("NOTE_N_PAD_AUTOMATION_PORT")
    .ok()
    .and_then(|p| p.parse::<u16>().ok())
    .unwrap_or(DEFAULT_PORT);
  std::thread::spawn(move || {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
      Ok(listener) => listener,
      Err(e) => {
        log::error!("automation: bind 127.0.0.1:{port} failed: {e}");
        return;
      }
    };
    log::info!("automation listening on 127.0.0.1:{port}");
    for stream in listener.incoming() {
      match stream {
        Ok(stream) => handle_client(&app, stream),
        Err(e) => log::warn!("automation: accept failed: {e}"),
      }
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_request_with_params() {
    let req: Request =
      serde_json::from_str(r#"{"id":7,"cmd":"eval","label":"note-1","js":"1+1"}"#).unwrap();
    assert_eq!(
      req,
      Request {
        id: 7,
        cmd: "eval".into(),
        label: Some("note-1".into()),
        js: Some("1+1".into()),
      }
    );
  }

  #[test]
  fn parses_request_without_optional_params() {
    let req: Request = serde_json::from_str(r#"{"id":1,"cmd":"list_windows"}"#).unwrap();
    assert_eq!(req.id, 1);
    assert_eq!(req.cmd, "list_windows");
    assert_eq!(req.label, None);
    assert_eq!(req.js, None);
  }

  #[test]
  fn ok_response_shape() {
    let line = ok_response(3, json!({ "k": "v" }));
    let parsed: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(parsed["id"], 3);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["data"]["k"], "v");
  }

  #[test]
  fn err_response_shape() {
    let line = err_response(4, "boom");
    let parsed: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(parsed["id"], 4);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["error"], "boom");
  }

  #[test]
  fn correlator_resolves_registered_id() {
    let c = Correlator::default();
    c.register(1);
    c.resolve(1, json!("hi"));
    assert_eq!(c.wait(1, Duration::from_millis(50)), Some(json!("hi")));
  }

  #[test]
  fn correlator_times_out_without_resolve() {
    let c = Correlator::default();
    c.register(2);
    assert_eq!(c.wait(2, Duration::from_millis(20)), None);
  }

  #[test]
  fn correlator_ignores_unknown_id() {
    let c = Correlator::default();
    // Resolving an id that was never registered must not panic or leak.
    c.resolve(99, json!("stray"));
    assert_eq!(c.wait(99, Duration::from_millis(10)), None);
  }

  #[test]
  fn correlator_resolve_across_threads() {
    use std::sync::Arc;
    let c = Arc::new(Correlator::default());
    c.register(5);
    let c2 = Arc::clone(&c);
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(10));
      c2.resolve(5, json!(42));
    });
    assert_eq!(c.wait(5, Duration::from_secs(1)), Some(json!(42)));
  }
}
