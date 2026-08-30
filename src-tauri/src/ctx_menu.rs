// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::i18n::{self, Key, Locale};
use std::sync::Mutex;
use tauri::menu::{ContextMenu, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager};

/// The row payload from the last `popup_row_menu` call, stashed so the global
/// menu-event handler can echo it back with the chosen action. Only one context
/// menu can be open at a time, so a single slot is enough.
#[derive(Default)]
pub struct CtxPending(pub Mutex<Option<serde_json::Value>>);

/// Add a namespaced item to a menu builder's item list, localized to `locale`.
/// Ids are prefixed with `ctx:` so they can never collide with the app-menu or
/// tray ids.
fn item(
  app: &AppHandle,
  id: &str,
  key: Key,
  locale: Locale,
) -> Result<MenuItem<tauri::Wry>, String> {
  MenuItem::with_id(
    app,
    format!("ctx:{id}"),
    crate::escape_menu_label(i18n::tr(locale, key)),
    true,
    None::<&str>,
  )
  .map_err(|e| e.to_string())
}

/// Build the context menu for a workspace row `kind` in `locale`. `payload`
/// carries the row identity and the flags that shape the menu (`root` for tree
/// folders, an empty `file_path` for untitled documents).
fn build_menu(
  app: &AppHandle,
  locale: Locale,
  kind: &str,
  payload: &serde_json::Value,
) -> Result<Menu<tauri::Wry>, String> {
  let sep = || PredefinedMenuItem::separator(app).map_err(|e| e.to_string());
  match kind {
    "tree-folder" => {
      let is_root = payload
        .get("root")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
      let new_file = item(app, "new-file", Key::CtxNewFile, locale)?;
      let new_folder = item(app, "new-folder", Key::CtxNewFolder, locale)?;
      let show = item(app, "show-in-finder", Key::CtxShowInFinder, locale)?;
      if is_root {
        // Roots represent the folder on disk: renaming would break the
        // stored project root, and closing uses the existing × instead.
        Menu::with_items(app, &[&new_file, &new_folder, &sep()?, &show])
      } else {
        let rename = item(app, "rename", Key::CtxRename, locale)?;
        let delete = item(app, "delete", Key::CtxDelete, locale)?;
        Menu::with_items(
          app,
          &[&new_file, &new_folder, &rename, &sep()?, &delete, &show],
        )
      }
      .map_err(|e| e.to_string())
    }
    "tree-file" => {
      // Top item opens files. "Open Selected Files" applies when at least
      // two files are selected and this row is one of them; the frontend
      // owns the path set and opens them on the echoed action.
      let target_selected = payload
        .get("targetSelected")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
      let selection_count = payload
        .get("selectionCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
      let open = if selection_count >= 2 && target_selected {
        item(app, "open-selected", Key::CtxOpenSelected, locale)?
      } else {
        item(app, "open", Key::CtxOpen, locale)?
      };
      let new_file = item(app, "new-file", Key::CtxNewFile, locale)?;
      let rename = item(app, "rename", Key::CtxRename, locale)?;
      let delete = item(app, "delete", Key::CtxDelete, locale)?;
      let show = item(app, "show-in-finder", Key::CtxShowInFinder, locale)?;
      Menu::with_items(
        app,
        &[&open, &sep()?, &new_file, &rename, &sep()?, &delete, &show],
      )
      .map_err(|e| e.to_string())
    }
    "sticky" => {
      let save = item(app, "save-doc", Key::CtxSaveAsDoc, locale)?;
      let close = item(app, "close", Key::Close, locale)?;
      Menu::with_items(app, &[&save, &close]).map_err(|e| e.to_string())
    }
    "doc" => {
      let close = item(app, "close-tab", Key::CtxCloseTab, locale)?;
      let has_path = payload
        .get("file_path")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
      if has_path {
        let show = item(app, "show-in-finder", Key::CtxShowInFinder, locale)?;
        Menu::with_items(app, &[&close, &show])
      } else {
        Menu::with_items(app, &[&close])
      }
      .map_err(|e| e.to_string())
    }
    other => Err(format!("unknown context-menu kind: {other}")),
  }
}

/// Build and pop up the native context menu for a workspace row at the cursor,
/// stashing `payload` so the chosen item routes back to the frontend.
#[tauri::command]
pub fn popup_row_menu(
  app: AppHandle,
  window: tauri::Window,
  kind: String,
  payload: serde_json::Value,
) -> Result<(), String> {
  // Read the current locale at popup time so the menu always matches the
  // active language, no rebuild bookkeeping needed.
  let locale = i18n::current_locale(&crate::settings::app_settings(&app).language);
  let menu = build_menu(&app, locale, &kind, &payload)?;
  *app.state::<CtxPending>().0.lock().unwrap() = Some(payload);
  // `popup` (no position) opens at the current cursor, which is exactly where
  // the frontend contextmenu event fired.
  menu.popup(window).map_err(|e| e.to_string())
}

/// Route a `ctx:*` menu selection: pair the action with the stashed row payload
/// and emit `ctx-action` to the workspace window, which owns every row handler.
pub fn route_ctx_event(app: &AppHandle, id: &str) {
  let Some(action) = id.strip_prefix("ctx:") else {
    return;
  };
  let payload = app.state::<CtxPending>().0.lock().unwrap().take();
  let _ = app.emit_to(
    "workspace",
    "ctx-action",
    serde_json::json!({ "action": action, "payload": payload }),
  );
}
