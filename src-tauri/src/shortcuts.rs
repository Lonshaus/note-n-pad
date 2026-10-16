// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! The single shortcut registry: every keyboard shortcut the app owns, its
//! per-platform default, the canonical key format, and the deterministic
//! resolution of stored overrides into the keys that are actually in effect.

use crate::i18n::{self, Key};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
/// Which modifier and key rules apply. Linux shares Windows' rules and defaults.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Platform {
  MacOS,
  Other,
}

impl Platform {
  pub const fn current() -> Platform {
    if cfg!(target_os = "macos") {
      Platform::MacOS
    } else {
      Platform::Other
    }
  }
}

const CTRL: u8 = 1;
const ALT: u8 = 2;
const SHIFT: u8 = 4;
const SUPER: u8 = 8;
/// A parsed key combination in canonical form. Equality is the conflict test.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Accel {
  mods: u8,
  key: String,
}

const PUNCTUATION: &str = ",./\\;'[]-=`";
/// Canonical spelling of a named (non-character) key, or `None`.
fn named_key(token: &str) -> Option<&'static str> {
  Some(match token.to_ascii_lowercase().as_str() {
    "arrowup" | "up" => "ArrowUp",
    "arrowdown" | "down" => "ArrowDown",
    "arrowleft" | "left" => "ArrowLeft",
    "arrowright" | "right" => "ArrowRight",
    "tab" => "Tab",
    "space" => "Space",
    "enter" => "Enter",
    "backspace" => "Backspace",
    "delete" => "Delete",
    "home" => "Home",
    "end" => "End",
    "pageup" => "PageUp",
    "pagedown" => "PageDown",
    "escape" | "esc" => "Escape",
    "insert" => "Insert",
    "pause" | "pausebreak" => "Pause",
    "capslock" => "CapsLock",
    "printscreen" => "PrintScreen",
    "scrolllock" => "ScrollLock",
    "numlock" => "NumLock",
    "numpad0" | "num0" => "Numpad0",
    "numpad1" | "num1" => "Numpad1",
    "numpad2" | "num2" => "Numpad2",
    "numpad3" | "num3" => "Numpad3",
    "numpad4" | "num4" => "Numpad4",
    "numpad5" | "num5" => "Numpad5",
    "numpad6" | "num6" => "Numpad6",
    "numpad7" | "num7" => "Numpad7",
    "numpad8" | "num8" => "Numpad8",
    "numpad9" | "num9" => "Numpad9",
    "numpadadd" | "numadd" | "numpadplus" | "numplus" => "NumpadAdd",
    "numpaddecimal" | "numdecimal" => "NumpadDecimal",
    "numpaddivide" | "numdivide" => "NumpadDivide",
    "numpadenter" | "numenter" => "NumpadEnter",
    "numpadequal" | "numequal" => "NumpadEqual",
    "numpadmultiply" | "nummultiply" => "NumpadMultiply",
    "numpadsubtract" | "numsubtract" => "NumpadSubtract",
    "audiovolumedown" | "volumedown" => "AudioVolumeDown",
    "audiovolumeup" | "volumeup" => "AudioVolumeUp",
    "audiovolumemute" | "volumemute" => "AudioVolumeMute",
    "mediaplay" => "MediaPlay",
    "mediapause" => "MediaPause",
    "mediaplaypause" => "MediaPlayPause",
    "mediastop" => "MediaStop",
    "mediatracknext" => "MediaTrackNext",
    "mediatrackprev" | "mediatrackprevious" => "MediaTrackPrevious",
    _ => return None,
  })
}
/// A key the global-shortcut parser spells out in words (`KeyA`, `Digit1`,
/// `Comma`) instead of as the character, as the canonical character.
fn spelled_out_key(token: &str) -> Option<char> {
  let lower = token.to_ascii_lowercase();
  if let Some(rest) = lower.strip_prefix("key").or(lower.strip_prefix("digit")) {
    let mut chars = rest.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
      if c.is_ascii_alphanumeric() {
        return Some(c.to_ascii_uppercase());
      }
    }
  }
  Some(match lower.as_str() {
    "backquote" => '`',
    "backslash" => '\\',
    "bracketleft" => '[',
    "bracketright" => ']',
    "comma" => ',',
    "equal" => '=',
    "minus" => '-',
    "period" => '.',
    "quote" => '\'',
    "semicolon" => ';',
    "slash" => '/',
    _ => return None,
  })
}

fn is_f_key(key: &str) -> bool {
  let Some(digits) = key.strip_prefix('F') else {
    return false;
  };
  !digits.starts_with('0')
    && digits.chars().all(|c| c.is_ascii_digit())
    && digits.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n))
}

fn parse_key(token: &str) -> Result<String, String> {
  let mut chars = token.chars();
  if let (Some(c), None) = (chars.next(), chars.next()) {
    if c.is_ascii_alphabetic() {
      return Ok(c.to_ascii_uppercase().to_string());
    }
    if c.is_ascii_digit() || PUNCTUATION.contains(c) {
      return Ok(c.to_string());
    }
  }
  if let Some(name) = named_key(token) {
    return Ok(name.to_string());
  }
  if let Some(c) = spelled_out_key(token) {
    return Ok(c.to_string());
  }
  let upper = token.to_ascii_uppercase();
  if is_f_key(&upper) {
    return Ok(upper);
  }
  Err(format!("unsupported key '{token}'"))
}

fn parse_modifier(token: &str, platform: Platform) -> Result<u8, String> {
  Ok(match token.to_ascii_lowercase().as_str() {
    "ctrl" | "control" => CTRL,
    "alt" | "option" => ALT,
    "shift" => SHIFT,
    "cmdorctrl" | "commandorcontrol" | "cmdorcontrol" | "commandorctrl" => {
      if platform == Platform::MacOS {
        SUPER
      } else {
        CTRL
      }
    }
    "cmd" | "command" | "super" | "meta" => SUPER,
    "win" | "windows" if platform == Platform::Other => SUPER,
    _ => return Err(format!("unsupported modifier '{token}'")),
  })
}
/// Parse any accepted spelling (canonical or legacy) into an `Accel`.
pub fn normalize(input: &str, platform: Platform) -> Result<Accel, String> {
  let input = input.trim();
  if input.is_empty() {
    return Err("empty shortcut".to_string());
  }
  let tokens: Vec<&str> = input.split('+').map(str::trim).collect();
  let Some((key, mods)) = tokens.split_last() else {
    return Err("empty shortcut".to_string());
  };
  let mut bits = 0;
  for token in mods {
    bits |= parse_modifier(token, platform)?;
  }
  Ok(Accel {
    mods: bits,
    key: parse_key(key)?,
  })
}

impl Accel {
  /// Canonical text: `Ctrl+Alt+Shift+Cmd|Win+<Key>`.
  pub fn canonical(&self, platform: Platform) -> String {
    let mut out = String::new();
    for (bit, name) in [
      (CTRL, "Ctrl"),
      (ALT, "Alt"),
      (SHIFT, "Shift"),
      (
        SUPER,
        if platform == Platform::MacOS {
          "Cmd"
        } else {
          "Win"
        },
      ),
    ] {
      if self.mods & bit != 0 {
        out.push_str(name);
        out.push('+');
      }
    }
    out.push_str(&self.key);
    out
  }
  /// Spelling that both the Tauri menu and the global-shortcut plugin parse.
  pub fn to_tauri(&self) -> String {
    let mut out = String::new();
    for (bit, name) in [
      (CTRL, "Ctrl"),
      (ALT, "Alt"),
      (SHIFT, "Shift"),
      (SUPER, "Super"),
    ] {
      if self.mods & bit != 0 {
        out.push_str(name);
        out.push('+');
      }
    }
    out.push_str(&self.key);
    out
  }

  fn with_shift(&self) -> Accel {
    Accel {
      mods: self.mods | SHIFT,
      key: self.key.clone(),
    }
  }
  /// A shortcut needs Command/Control/Alt, or must be a bare F1-F24.
  pub fn has_required_modifier(&self) -> bool {
    if self.mods == 0 {
      return is_f_key(&self.key);
    }
    self.mods & (CTRL | ALT | SUPER) != 0
  }
  /// A key that types a character, which macOS treats as text when only Option
  /// (with or without Shift) is held.
  fn is_character_key(&self) -> bool {
    let mut chars = self.key.chars();
    matches!((chars.next(), chars.next()), (Some(_), None)) || self.key == "Space"
  }
  /// Ctrl+Alt+Shift on a digit or punctuation key. On Windows and Linux
  /// CodeMirror treats Ctrl+Alt as AltGr and skips its physical-key fallback,
  /// and with Shift the typed character (`!`, `{`) never equals the bound
  /// digit or punctuation. Letters are handled by a second spelling.
  fn is_altgr_shifted_symbol(&self) -> bool {
    self.mods & (CTRL | ALT | SHIFT) == CTRL | ALT | SHIFT
      && self.key.len() == 1
      && !self.key.as_bytes()[0].is_ascii_alphabetic()
  }
  /// CodeMirror ignores Option(+Shift)+character on macOS: it is typing.
  pub fn is_mac_option_typing(&self) -> bool {
    self.mods & ALT != 0 && self.mods & (CTRL | SUPER) == 0 && self.is_character_key()
  }
  pub fn is_numpad_key(&self) -> bool {
    self.key.starts_with("Numpad")
  }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
  Global,
  Menu,
  Window,
  Editor,
}
impl Scope {
  fn name(self) -> &'static str {
    match self {
      Scope::Global => "global",
      Scope::Menu => "menu",
      Scope::Window => "window",
      Scope::Editor => "editor",
    }
  }
}
/// How a row's display name is built from the dictionary.
#[derive(Clone, Copy, Debug)]
pub enum Label {
  One(Key),
  /// Two names joined, for the one row whose meaning follows the focus.
  Pair(Key, Key),
}

pub struct Row {
  pub id: &'static str,
  /// Section heading key; `None` is the unlocalized app-name section.
  pub section: Option<Key>,
  pub label: Label,
  pub scopes: &'static [Scope],
  pub mac: &'static str,
  pub win: &'static str,
  pub customizable: bool,
  /// Id of the native menu item that carries this accelerator, if any.
  pub menu_id: Option<&'static str>,
}

impl Row {
  pub fn default_text(&self, platform: Platform) -> &'static str {
    if platform == Platform::MacOS {
      self.mac
    } else {
      self.win
    }
  }
}

const fn fixed(
  id: &'static str,
  section: Option<Key>,
  label: Key,
  mac: &'static str,
  win: &'static str,
  menu_id: Option<&'static str>,
) -> Row {
  Row {
    id,
    section,
    label: Label::One(label),
    scopes: &[Scope::Menu],
    mac,
    win,
    customizable: false,
    menu_id,
  }
}

const fn custom(
  id: &'static str,
  section: Option<Key>,
  label: Label,
  scopes: &'static [Scope],
  mac: &'static str,
  win: &'static str,
  menu_id: Option<&'static str>,
) -> Row {
  Row {
    id,
    section,
    label,
    scopes,
    mac,
    win,
    customizable: true,
    menu_id,
  }
}

pub const GLOBAL_STICKY_ID: &str = "global.new-sticky";

const MENU: &[Scope] = &[Scope::Menu];
const WINDOW: &[Scope] = &[Scope::Window];
const EDITOR: &[Scope] = &[Scope::Editor];
/// Every shortcut with a name. Order matters: it is the order in which stored
/// overrides claim keys during resolution.
pub const ROWS: &[Row] = &[
  fixed(
    "menu.quit",
    None,
    Key::Quit,
    "Cmd+Q",
    "Ctrl+Q",
    Some("quit"),
  ),
  fixed(
    "menu.settings",
    None,
    Key::Settings,
    "Cmd+,",
    "Ctrl+,",
    Some("settings"),
  ),
  fixed(
    "menu.new-tab",
    Some(Key::FileMenu),
    Key::NewTab,
    "Cmd+T",
    "Ctrl+T",
    Some("new-tab"),
  ),
  fixed(
    "menu.open",
    Some(Key::FileMenu),
    Key::Open,
    "Cmd+O",
    "Ctrl+O",
    Some("open"),
  ),
  fixed(
    "menu.close",
    Some(Key::FileMenu),
    Key::Close,
    "Cmd+W",
    "Ctrl+W",
    Some("close"),
  ),
  fixed(
    "menu.save",
    Some(Key::FileMenu),
    Key::Save,
    "Cmd+S",
    "Ctrl+S",
    Some("save"),
  ),
  fixed(
    "menu.save-as",
    Some(Key::FileMenu),
    Key::SaveAs,
    "Shift+Cmd+S",
    "Ctrl+Shift+S",
    Some("save-as"),
  ),
  fixed(
    "menu.find",
    Some(Key::EditMenu),
    Key::Find,
    "Cmd+F",
    "Ctrl+F",
    Some("find"),
  ),
  fixed(
    "menu.find-next",
    Some(Key::EditMenu),
    Key::FindNext,
    "Cmd+G",
    "Ctrl+G",
    Some("find-next"),
  ),
  fixed(
    "menu.find-prev",
    Some(Key::EditMenu),
    Key::FindPrev,
    "Shift+Cmd+G",
    "Ctrl+Shift+G",
    Some("find-prev"),
  ),
  fixed(
    "menu.undo",
    Some(Key::EditMenu),
    Key::Undo,
    "Cmd+Z",
    "Ctrl+Z",
    None,
  ),
  fixed(
    "menu.redo",
    Some(Key::EditMenu),
    Key::Redo,
    "Shift+Cmd+Z",
    "Ctrl+Y",
    None,
  ),
  fixed(
    "menu.cut",
    Some(Key::EditMenu),
    Key::Cut,
    "Cmd+X",
    "Ctrl+X",
    None,
  ),
  fixed(
    "menu.copy",
    Some(Key::EditMenu),
    Key::Copy,
    "Cmd+C",
    "Ctrl+C",
    None,
  ),
  fixed(
    "menu.paste",
    Some(Key::EditMenu),
    Key::Paste,
    "Cmd+V",
    "Ctrl+V",
    None,
  ),
  fixed(
    "menu.select-all",
    Some(Key::EditMenu),
    Key::SelectAll,
    "Cmd+A",
    "Ctrl+A",
    None,
  ),
  fixed(
    "menu.minimize",
    Some(Key::WindowMenu),
    Key::Minimize,
    "Cmd+M",
    "",
    Some("minimize"),
  ),
  custom(
    GLOBAL_STICKY_ID,
    Some(Key::FileMenu),
    Label::One(Key::NewStickyGlobal),
    &[Scope::Global],
    "Shift+Cmd+N",
    "Ctrl+Shift+N",
    None,
  ),
  custom(
    "menu.new",
    Some(Key::FileMenu),
    Label::Pair(Key::NewSticky, Key::NewWindow),
    MENU,
    "Cmd+N",
    "Ctrl+N",
    Some("new-sticky"),
  ),
  custom(
    "menu.find-replace",
    Some(Key::EditMenu),
    Label::One(Key::FindReplace),
    MENU,
    "Alt+Cmd+F",
    "Ctrl+Alt+F",
    Some("find-replace"),
  ),
  custom(
    "menu.workspace",
    Some(Key::ViewMenu),
    Label::One(Key::Workspace),
    MENU,
    "Shift+Cmd+E",
    "Ctrl+Shift+E",
    Some("workspace"),
  ),
  custom(
    "menu.show-in-finder",
    Some(Key::FileMenu),
    Label::One(Key::CtxShowInFinder),
    MENU,
    "",
    "",
    Some("show-in-finder"),
  ),
  custom(
    "menu.copy-path",
    Some(Key::FileMenu),
    Label::One(Key::CopyFilePath),
    MENU,
    "",
    "",
    Some("copy-path"),
  ),
  custom(
    "menu.word-wrap",
    Some(Key::FormatMenu),
    Label::One(Key::WordWrap),
    MENU,
    "",
    "",
    Some("word-wrap"),
  ),
  custom(
    "menu.line-numbers",
    Some(Key::ViewMenu),
    Label::One(Key::LineNumbers),
    MENU,
    "",
    "",
    Some("line-numbers"),
  ),
  custom(
    "menu.always-on-top",
    Some(Key::WindowMenu),
    Label::One(Key::AlwaysOnTop),
    MENU,
    "",
    "",
    Some("always-on-top"),
  ),
  custom(
    "menu.about",
    None,
    Label::One(Key::About),
    MENU,
    "",
    "",
    Some("about"),
  ),
  custom(
    "menu.help-documentation",
    Some(Key::HelpMenu),
    Label::One(Key::Documentation),
    MENU,
    "",
    "",
    Some("help-documentation"),
  ),
  custom(
    "menu.help-report-issue",
    Some(Key::HelpMenu),
    Label::One(Key::ReportIssue),
    MENU,
    "",
    "",
    Some("help-report-issue"),
  ),
  custom(
    "menu.help-acknowledgements",
    Some(Key::HelpMenu),
    Label::One(Key::Acknowledgements),
    MENU,
    "",
    "",
    Some("help-acknowledgements"),
  ),
  custom(
    "menu.help-privacy",
    Some(Key::HelpMenu),
    Label::One(Key::PrivacyPolicy),
    MENU,
    "",
    "",
    Some("help-privacy"),
  ),
  custom(
    "window.next-tab",
    Some(Key::TabsSection),
    Label::One(Key::NextTab),
    WINDOW,
    "Ctrl+Tab",
    "Ctrl+Tab",
    None,
  ),
  custom(
    "window.prev-tab",
    Some(Key::TabsSection),
    Label::One(Key::PrevTab),
    WINDOW,
    "Ctrl+Shift+Tab",
    "Ctrl+Shift+Tab",
    None,
  ),
  custom(
    "goto-line",
    Some(Key::EditMenu),
    Label::One(Key::GoToLine),
    &[Scope::Editor, Scope::Window],
    "Alt+Cmd+G",
    "Ctrl+Alt+G",
    None,
  ),
  custom(
    "editor.move-line-up",
    Some(Key::EditMenu),
    Label::One(Key::EdMoveLineUp),
    EDITOR,
    "Alt+ArrowUp",
    "Alt+ArrowUp",
    None,
  ),
  custom(
    "editor.move-line-down",
    Some(Key::EditMenu),
    Label::One(Key::EdMoveLineDown),
    EDITOR,
    "Alt+ArrowDown",
    "Alt+ArrowDown",
    None,
  ),
  custom(
    "editor.copy-line-up",
    Some(Key::EditMenu),
    Label::One(Key::EdCopyLineUp),
    EDITOR,
    "Alt+Shift+ArrowUp",
    "Alt+Shift+ArrowUp",
    None,
  ),
  custom(
    "editor.copy-line-down",
    Some(Key::EditMenu),
    Label::One(Key::EdCopyLineDown),
    EDITOR,
    "Alt+Shift+ArrowDown",
    "Alt+Shift+ArrowDown",
    None,
  ),
  custom(
    "editor.add-cursor-above",
    Some(Key::EditMenu),
    Label::One(Key::EdAddCursorAbove),
    EDITOR,
    "Alt+Cmd+ArrowUp",
    "Ctrl+Alt+ArrowUp",
    None,
  ),
  custom(
    "editor.add-cursor-below",
    Some(Key::EditMenu),
    Label::One(Key::EdAddCursorBelow),
    EDITOR,
    "Alt+Cmd+ArrowDown",
    "Ctrl+Alt+ArrowDown",
    None,
  ),
  custom(
    "editor.insert-line-below",
    Some(Key::EditMenu),
    Label::One(Key::EdInsertLineBelow),
    EDITOR,
    "Cmd+Enter",
    "Ctrl+Enter",
    None,
  ),
  custom(
    "editor.select-line",
    Some(Key::EditMenu),
    Label::One(Key::EdSelectLine),
    EDITOR,
    "Ctrl+L",
    "Alt+L",
    None,
  ),
  custom(
    "editor.expand-selection",
    Some(Key::EditMenu),
    Label::One(Key::EdExpandSelection),
    EDITOR,
    "Cmd+I",
    "Ctrl+I",
    None,
  ),
  custom(
    "editor.outdent",
    Some(Key::EditMenu),
    Label::One(Key::EdOutdent),
    EDITOR,
    "Cmd+[",
    "Ctrl+[",
    None,
  ),
  custom(
    "editor.indent",
    Some(Key::EditMenu),
    Label::One(Key::EdIndent),
    EDITOR,
    "Cmd+]",
    "Ctrl+]",
    None,
  ),
  custom(
    "editor.reindent",
    Some(Key::EditMenu),
    Label::One(Key::EdReindent),
    EDITOR,
    "Alt+Cmd+\\",
    "Ctrl+Alt+\\",
    None,
  ),
  custom(
    "editor.delete-line",
    Some(Key::EditMenu),
    Label::One(Key::EdDeleteLine),
    EDITOR,
    "Shift+Cmd+K",
    "Ctrl+Shift+K",
    None,
  ),
  custom(
    "editor.go-to-bracket",
    Some(Key::EditMenu),
    Label::One(Key::EdGoToBracket),
    EDITOR,
    "Shift+Cmd+\\",
    "Ctrl+Shift+\\",
    None,
  ),
  custom(
    "editor.toggle-line-comment",
    Some(Key::EditMenu),
    Label::One(Key::EdToggleLineComment),
    EDITOR,
    "Cmd+/",
    "Ctrl+/",
    None,
  ),
  custom(
    "editor.toggle-block-comment",
    Some(Key::EditMenu),
    Label::One(Key::EdToggleBlockComment),
    EDITOR,
    "Ctrl+Shift+A",
    "Alt+Shift+A",
    None,
  ),
  custom(
    "editor.toggle-tab-focus",
    Some(Key::EditMenu),
    Label::One(Key::EdToggleTabFocus),
    EDITOR,
    "Ctrl+Shift+M",
    "Ctrl+M",
    None,
  ),
  custom(
    "editor.cursor-undo",
    Some(Key::EditMenu),
    Label::One(Key::EdCursorUndo),
    EDITOR,
    "Cmd+U",
    "Ctrl+U",
    None,
  ),
  custom(
    "editor.cursor-redo",
    Some(Key::EditMenu),
    Label::One(Key::EdCursorRedo),
    EDITOR,
    "Shift+Cmd+U",
    "Alt+U",
    None,
  ),
  custom(
    "editor.add-next-occurrence",
    Some(Key::EditMenu),
    Label::One(Key::EdAddNextOccurrence),
    EDITOR,
    "Cmd+D",
    "Ctrl+D",
    None,
  ),
  custom(
    "editor.select-all-occurrences",
    Some(Key::EditMenu),
    Label::One(Key::EdSelectAllOccurrences),
    EDITOR,
    "Shift+Cmd+L",
    "Ctrl+Shift+L",
    None,
  ),
  custom(
    "editor.fold",
    Some(Key::EditMenu),
    Label::One(Key::EdFold),
    EDITOR,
    "Alt+Cmd+[",
    "Ctrl+Shift+[",
    None,
  ),
  custom(
    "editor.unfold",
    Some(Key::EditMenu),
    Label::One(Key::EdUnfold),
    EDITOR,
    "Alt+Cmd+]",
    "Ctrl+Shift+]",
    None,
  ),
  custom(
    "editor.fold-all",
    Some(Key::EditMenu),
    Label::One(Key::EdFoldAll),
    EDITOR,
    "Ctrl+Alt+[",
    "Ctrl+Alt+[",
    None,
  ),
  custom(
    "editor.unfold-all",
    Some(Key::EditMenu),
    Label::One(Key::EdUnfoldAll),
    EDITOR,
    "Ctrl+Alt+]",
    "Ctrl+Alt+]",
    None,
  ),
  custom(
    "editor.trigger-suggest",
    Some(Key::EditMenu),
    Label::One(Key::EdTriggerSuggest),
    EDITOR,
    "Alt+Escape",
    "Ctrl+Space",
    None,
  ),
  custom(
    "editor.trim-trailing-whitespace",
    Some(Key::EditMenu),
    Label::One(Key::EdTrimTrailingWhitespace),
    EDITOR,
    "",
    "",
    None,
  ),
  custom(
    "editor.add-line-comment",
    Some(Key::EditMenu),
    Label::One(Key::EdAddLineComment),
    EDITOR,
    "",
    "",
    None,
  ),
  custom(
    "editor.remove-line-comment",
    Some(Key::EditMenu),
    Label::One(Key::EdRemoveLineComment),
    EDITOR,
    "",
    "",
    None,
  ),
  custom(
    "editor.select-to-bracket",
    Some(Key::EditMenu),
    Label::One(Key::EdSelectToBracket),
    EDITOR,
    "",
    "",
    None,
  ),
];
/// Editor and system keys that are not customizable and have no display name
/// yet, kept so a custom key can never shadow them: (id, macOS, other,
/// also the Shift variant). Bare and Shift-only keys are omitted because a
/// custom key always needs a modifier. Keys already listed in `ROWS` (Cmd+A,
/// Cmd+Z, Cmd+F, Cmd+G ...) are not repeated.
const RESERVED: &[(&str, &str, &str, bool)] = &[
  ("fixed.group-left", "Alt+ArrowLeft", "Ctrl+ArrowLeft", true),
  (
    "fixed.group-right",
    "Alt+ArrowRight",
    "Ctrl+ArrowRight",
    true,
  ),
  ("fixed.syntax-left", "Ctrl+ArrowLeft", "Alt+ArrowLeft", true),
  (
    "fixed.syntax-right",
    "Ctrl+ArrowRight",
    "Alt+ArrowRight",
    true,
  ),
  ("fixed.line-boundary-left", "Cmd+ArrowLeft", "", true),
  ("fixed.line-boundary-right", "Cmd+ArrowRight", "", true),
  ("fixed.doc-start-arrow", "Cmd+ArrowUp", "", true),
  ("fixed.doc-end-arrow", "Cmd+ArrowDown", "", true),
  ("fixed.page-up-arrow", "Ctrl+ArrowUp", "", true),
  ("fixed.page-down-arrow", "Ctrl+ArrowDown", "", true),
  ("fixed.doc-start-home", "Cmd+Home", "Ctrl+Home", true),
  ("fixed.doc-end-end", "Cmd+End", "Ctrl+End", true),
  (
    "fixed.delete-group-backward",
    "Alt+Backspace",
    "Ctrl+Backspace",
    false,
  ),
  (
    "fixed.delete-group-forward",
    "Alt+Delete",
    "Ctrl+Delete",
    false,
  ),
  ("fixed.delete-line-start", "Cmd+Backspace", "", false),
  ("fixed.delete-line-end", "Cmd+Delete", "", false),
  ("fixed.find-next-f3", "F3", "F3", true),
  ("fixed.windowed-redo", "", "Ctrl+Shift+Z", false),
  ("fixed.emacs-char-left", "Ctrl+B", "", true),
  ("fixed.emacs-char-right", "Ctrl+F", "", true),
  ("fixed.emacs-line-up", "Ctrl+P", "", true),
  ("fixed.emacs-line-down", "Ctrl+N", "", true),
  ("fixed.emacs-line-start", "Ctrl+A", "", false),
  ("fixed.emacs-line-end", "Ctrl+E", "", true),
  ("fixed.emacs-delete-forward", "Ctrl+D", "", false),
  ("fixed.emacs-delete-backward", "Ctrl+H", "", false),
  ("fixed.emacs-delete-to-end", "Ctrl+K", "", false),
  ("fixed.emacs-delete-group", "Ctrl+Alt+H", "", false),
  ("fixed.emacs-split-line", "Ctrl+O", "", false),
  ("fixed.emacs-transpose", "Ctrl+T", "", false),
  ("fixed.emacs-page-down", "Ctrl+V", "", false),
];
/// Which group of "Other fixed keys" a row belongs to. The heading text comes
/// from the dictionary, the id is what the frontend groups by.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Heading {
  Cursor,
  Editing,
  Emacs,
}

impl Heading {
  pub const fn id(self) -> &'static str {
    match self {
      Heading::Cursor => "cursor",
      Heading::Editing => "editing",
      Heading::Emacs => "emacs",
    }
  }

  const fn key(self) -> Key {
    match self {
      Heading::Cursor => Key::FxHdCursor,
      Heading::Editing => Key::FxHdEditing,
      Heading::Emacs => Key::FxHdEmacs,
    }
  }
}
/// A read-only row of the "Other fixed keys" list. It never takes part in
/// conflict checking itself: `aliases` names the `RESERVED` entries whose keys
/// the row shows, so a `conflict:<id>` for any of them still finds its row.
pub struct OtherRow {
  pub id: &'static str,
  pub heading: Heading,
  pub label: Label,
  /// Display keys on macOS, `None` when the row does not exist there.
  pub mac: Option<&'static [&'static str]>,
  /// Display keys on Windows and Linux, `None` when the row does not exist.
  pub other: Option<&'static [&'static str]>,
  pub aliases: &'static [&'static str],
}

const fn one(key: Key) -> Label {
  Label::One(key)
}

const fn both(
  id: &'static str,
  heading: Heading,
  label: Label,
  keys: &'static [&'static str],
  aliases: &'static [&'static str],
) -> OtherRow {
  OtherRow {
    id,
    heading,
    label,
    mac: Some(keys),
    other: Some(keys),
    aliases,
  }
}

const fn split(
  id: &'static str,
  heading: Heading,
  label: Label,
  mac: Option<&'static [&'static str]>,
  other: Option<&'static [&'static str]>,
  aliases: &'static [&'static str],
) -> OtherRow {
  OtherRow {
    id,
    heading,
    label,
    mac,
    other,
    aliases,
  }
}

use Heading::{Cursor, Editing, Emacs};
/// The "Other fixed keys" list, in display order. Keys are canonical text.
/// Sources: the `RESERVED` entries (through `aliases`) and CodeMirror's
/// standard keymap for the bare keys.
pub const OTHER_ROWS: &[OtherRow] = &[
  both(
    "other.cursor-left",
    Cursor,
    one(Key::FxCursorLeft),
    &["ArrowLeft"],
    &[],
  ),
  both(
    "other.cursor-right",
    Cursor,
    one(Key::FxCursorRight),
    &["ArrowRight"],
    &[],
  ),
  both(
    "other.cursor-up",
    Cursor,
    one(Key::FxCursorUp),
    &["ArrowUp"],
    &[],
  ),
  both(
    "other.cursor-down",
    Cursor,
    one(Key::FxCursorDown),
    &["ArrowDown"],
    &[],
  ),
  split(
    "other.word-left",
    Cursor,
    one(Key::FxWordLeft),
    Some(&["Alt+ArrowLeft"]),
    Some(&["Ctrl+ArrowLeft"]),
    &["fixed.group-left"],
  ),
  split(
    "other.word-right",
    Cursor,
    one(Key::FxWordRight),
    Some(&["Alt+ArrowRight"]),
    Some(&["Ctrl+ArrowRight"]),
    &["fixed.group-right"],
  ),
  split(
    "other.syntax-left",
    Cursor,
    one(Key::FxSyntaxLeft),
    Some(&["Ctrl+ArrowLeft"]),
    Some(&["Alt+ArrowLeft"]),
    &["fixed.syntax-left"],
  ),
  split(
    "other.syntax-right",
    Cursor,
    one(Key::FxSyntaxRight),
    Some(&["Ctrl+ArrowRight"]),
    Some(&["Alt+ArrowRight"]),
    &["fixed.syntax-right"],
  ),
  split(
    "other.line-start",
    Cursor,
    one(Key::FxLineStart),
    Some(&["Home", "Cmd+ArrowLeft"]),
    Some(&["Home"]),
    &["fixed.line-boundary-left"],
  ),
  split(
    "other.line-end",
    Cursor,
    one(Key::FxLineEnd),
    Some(&["End", "Cmd+ArrowRight"]),
    Some(&["End"]),
    &["fixed.line-boundary-right"],
  ),
  split(
    "other.page-up",
    Cursor,
    one(Key::FxPageUp),
    Some(&["PageUp", "Ctrl+ArrowUp"]),
    Some(&["PageUp"]),
    &["fixed.page-up-arrow"],
  ),
  split(
    "other.page-down",
    Cursor,
    one(Key::FxPageDown),
    Some(&["PageDown", "Ctrl+ArrowDown"]),
    Some(&["PageDown"]),
    &["fixed.page-down-arrow"],
  ),
  split(
    "other.doc-start",
    Cursor,
    one(Key::FxDocStart),
    Some(&["Cmd+ArrowUp", "Cmd+Home"]),
    Some(&["Ctrl+Home"]),
    &["fixed.doc-start-arrow", "fixed.doc-start-home"],
  ),
  split(
    "other.doc-end",
    Cursor,
    one(Key::FxDocEnd),
    Some(&["Cmd+ArrowDown", "Cmd+End"]),
    Some(&["Ctrl+End"]),
    &["fixed.doc-end-arrow", "fixed.doc-end-end"],
  ),
  both("other.add-shift", Cursor, one(Key::FxAddShift), &[], &[]),
  both(
    "other.new-line",
    Editing,
    one(Key::FxNewLine),
    &["Enter"],
    &[],
  ),
  both(
    "other.delete-left",
    Editing,
    one(Key::FxDeleteLeft),
    &["Backspace"],
    &[],
  ),
  both(
    "other.delete-right",
    Editing,
    one(Key::FxDeleteRight),
    &["Delete"],
    &[],
  ),
  split(
    "other.delete-word-left",
    Editing,
    one(Key::FxDeleteWordLeft),
    Some(&["Alt+Backspace"]),
    Some(&["Ctrl+Backspace"]),
    &["fixed.delete-group-backward"],
  ),
  split(
    "other.delete-word-right",
    Editing,
    one(Key::FxDeleteWordRight),
    Some(&["Alt+Delete"]),
    Some(&["Ctrl+Delete"]),
    &["fixed.delete-group-forward"],
  ),
  split(
    "other.delete-to-start",
    Editing,
    one(Key::FxDeleteToStart),
    Some(&["Cmd+Backspace"]),
    None,
    &["fixed.delete-line-start"],
  ),
  split(
    "other.delete-to-end",
    Editing,
    one(Key::FxDeleteToEnd),
    Some(&["Cmd+Delete"]),
    None,
    &["fixed.delete-line-end"],
  ),
  both(
    "other.find-next",
    Editing,
    one(Key::FindNext),
    &["F3"],
    &["fixed.find-next-f3"],
  ),
  split(
    "other.redo-large",
    Editing,
    one(Key::FxRedoLarge),
    None,
    Some(&["Ctrl+Shift+Z"]),
    &["fixed.windowed-redo"],
  ),
  split(
    "emacs.cursor-left",
    Emacs,
    one(Key::FxCursorLeft),
    Some(&["Ctrl+B"]),
    None,
    &["fixed.emacs-char-left"],
  ),
  split(
    "emacs.cursor-right",
    Emacs,
    one(Key::FxCursorRight),
    Some(&["Ctrl+F"]),
    None,
    &["fixed.emacs-char-right"],
  ),
  split(
    "emacs.cursor-up",
    Emacs,
    one(Key::FxCursorUp),
    Some(&["Ctrl+P"]),
    None,
    &["fixed.emacs-line-up"],
  ),
  split(
    "emacs.cursor-down",
    Emacs,
    one(Key::FxCursorDown),
    Some(&["Ctrl+N"]),
    None,
    &["fixed.emacs-line-down"],
  ),
  split(
    "emacs.line-start",
    Emacs,
    one(Key::FxLineStart),
    Some(&["Ctrl+A"]),
    None,
    &["fixed.emacs-line-start"],
  ),
  split(
    "emacs.line-end",
    Emacs,
    one(Key::FxLineEnd),
    Some(&["Ctrl+E"]),
    None,
    &["fixed.emacs-line-end"],
  ),
  split(
    "emacs.delete-right",
    Emacs,
    one(Key::FxDeleteRight),
    Some(&["Ctrl+D"]),
    None,
    &["fixed.emacs-delete-forward"],
  ),
  split(
    "emacs.delete-left",
    Emacs,
    one(Key::FxDeleteLeft),
    Some(&["Ctrl+H"]),
    None,
    &["fixed.emacs-delete-backward"],
  ),
  split(
    "emacs.delete-to-end",
    Emacs,
    one(Key::FxDeleteToEnd),
    Some(&["Ctrl+K"]),
    None,
    &["fixed.emacs-delete-to-end"],
  ),
  split(
    "emacs.delete-word-left",
    Emacs,
    one(Key::FxDeleteWordLeft),
    Some(&["Ctrl+Alt+H"]),
    None,
    &["fixed.emacs-delete-group"],
  ),
  split(
    "emacs.split-line",
    Emacs,
    one(Key::FxSplitLine),
    Some(&["Ctrl+O"]),
    None,
    &["fixed.emacs-split-line"],
  ),
  split(
    "emacs.transpose",
    Emacs,
    one(Key::FxTranspose),
    Some(&["Ctrl+T"]),
    None,
    &["fixed.emacs-transpose"],
  ),
  split(
    "emacs.page-down",
    Emacs,
    one(Key::FxPageDown),
    Some(&["Ctrl+V"]),
    None,
    &["fixed.emacs-page-down"],
  ),
];
/// Every reserved key for `platform`, Shift variants expanded.
fn reserved_accels(platform: Platform) -> Vec<(&'static str, Accel)> {
  let mut out = Vec::new();
  for (id, mac, other, with_shift) in RESERVED {
    let text = if platform == Platform::MacOS {
      mac
    } else {
      other
    };
    if text.is_empty() {
      continue;
    }
    let Ok(accel) = normalize(text, platform) else {
      continue;
    };
    if *with_shift {
      out.push((*id, accel.with_shift()));
    }
    out.push((*id, accel));
  }
  out
}

fn row_index(id: &str) -> Option<usize> {
  ROWS.iter().position(|row| row.id == id)
}

fn default_accel(row: &Row, platform: Platform) -> Option<Accel> {
  let text = row.default_text(platform);
  if text.is_empty() {
    None
  } else {
    normalize(text, platform).ok()
  }
}
/// Why a key is refused for a row, before any conflict check.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum RuleError {
  NeedsModifier,
  MacOption,
  /// A Windows/Linux combination the row's handler can never receive.
  Unreachable,
  /// A numpad key on a row the frontend matches by key name, which has no
  /// numpad names.
  NumpadKey,
}

pub fn rule_violation(row: &Row, accel: &Accel, platform: Platform) -> Option<RuleError> {
  if !accel.has_required_modifier() {
    return Some(RuleError::NeedsModifier);
  }
  // Only the global key is registered with the OS, which does fire numpad keys.
  if accel.is_numpad_key() && row.id != GLOBAL_STICKY_ID {
    return Some(RuleError::NumpadKey);
  }
  if platform == Platform::MacOS
    && row.scopes.contains(&Scope::Editor)
    && accel.is_mac_option_typing()
  {
    return Some(RuleError::MacOption);
  }
  if platform == Platform::Other && accel.is_altgr_shifted_symbol() {
    let is_digit = accel.key.as_bytes()[0].is_ascii_digit();
    // The window handler reads digits off the physical key, so only the
    // editor loses them; punctuation is lost in both.
    if row.scopes.contains(&Scope::Editor) || (row.scopes.contains(&Scope::Window) && !is_digit) {
      return Some(RuleError::Unreachable);
    }
  }
  None
}
/// The registry id of the workspace key.
const WORKSPACE_ID: &str = "menu.workspace";
/// The keys in effect, resolved from stored settings.
#[derive(Debug)]
pub struct Resolved {
  /// Canonical text of the global new-sticky key, empty when unset.
  pub new_note_shortcut: String,
  /// Stored overrides that survived, in canonical form.
  pub overrides: BTreeMap<String, String>,
  accels: Vec<Option<Accel>>,
  platform: Platform,
  /// Stored settings that were invalid and dropped or reset.
  pub repaired: Vec<String>,
  /// Rows whose default key is held by a stored override and so stay unset.
  pub unset_defaults: Vec<String>,
  /// Whether the workspace exists. Without it (lite) its row is hidden, so its
  /// key is no conflict for another row.
  workspace: bool,
}
/// Resolve stored settings into effective keys in one deterministic pass:
/// reserved and fixed keys first, then the global key, then overrides in
/// registry order, then defaults for everything left. The first claimant wins.
#[cfg(test)]
pub fn resolve(
  new_note_shortcut: &str,
  overrides: &BTreeMap<String, String>,
  platform: Platform,
) -> Resolved {
  resolve_in(new_note_shortcut, overrides, platform, true)
}
/// `resolve`, for an edition with (`workspace`) or without the workspace. In
/// lite its row is hidden, so its key is claimed by nobody and cannot collide
/// with, block or invalidate another row; its stored override is carried along
/// exactly as stored, for when the edition is full again.
pub fn resolve_in(
  new_note_shortcut: &str,
  overrides: &BTreeMap<String, String>,
  platform: Platform,
  workspace: bool,
) -> Resolved {
  let mut occupied: HashMap<Accel, &'static str> = HashMap::new();
  let mut accels: Vec<Option<Accel>> = vec![None; ROWS.len()];
  let mut repaired = Vec::new();
  let mut unset_defaults = Vec::new();
  for (id, accel) in reserved_accels(platform) {
    occupied.entry(accel).or_insert(id);
  }
  for (i, row) in ROWS.iter().enumerate() {
    if row.customizable {
      continue;
    }
    if let Some(accel) = default_accel(row, platform) {
      accels[i] = Some(accel.clone());
      occupied.entry(accel).or_insert(row.id);
    }
  }
  let global_index = row_index(GLOBAL_STICKY_ID).expect("global row exists");
  let global_row = &ROWS[global_index];
  let mut global_text = String::new();
  if !new_note_shortcut.is_empty() {
    let usable = normalize(new_note_shortcut, platform)
      .ok()
      .filter(|a| rule_violation(global_row, a, platform).is_none() && !occupied.contains_key(a));
    match usable {
      Some(accel) => {
        global_text = accel.canonical(platform);
        occupied.insert(accel.clone(), GLOBAL_STICKY_ID);
        accels[global_index] = Some(accel);
      }
      None => {
        repaired.push("new_note_shortcut".to_string());
        if let Some(accel) = default_accel(global_row, platform) {
          if !occupied.contains_key(&accel) {
            global_text = accel.canonical(platform);
            occupied.insert(accel.clone(), GLOBAL_STICKY_ID);
            accels[global_index] = Some(accel);
          }
        }
      }
    }
  }
  let mut kept: BTreeMap<String, String> = BTreeMap::new();
  let mut settled = vec![false; ROWS.len()];
  for (i, row) in ROWS.iter().enumerate() {
    if !row.customizable || row.id == GLOBAL_STICKY_ID {
      continue;
    }
    let Some(stored) = overrides.get(row.id) else {
      continue;
    };
    if !workspace && row.id == WORKSPACE_ID {
      kept.insert(row.id.to_string(), stored.clone());
      settled[i] = true;
      continue;
    }
    if stored.is_empty() {
      kept.insert(row.id.to_string(), String::new());
      settled[i] = true;
      continue;
    }
    let usable = normalize(stored, platform)
      .ok()
      .filter(|a| rule_violation(row, a, platform).is_none() && !occupied.contains_key(a));
    match usable {
      Some(accel) => {
        kept.insert(row.id.to_string(), accel.canonical(platform));
        occupied.insert(accel.clone(), row.id);
        accels[i] = Some(accel);
        settled[i] = true;
      }
      None => repaired.push(format!("shortcut_overrides.{}", row.id)),
    }
  }
  for key in overrides.keys() {
    let known = ROWS
      .iter()
      .any(|row| row.id == key && row.customizable && row.id != GLOBAL_STICKY_ID);
    if !known {
      repaired.push(format!("shortcut_overrides.{key}"));
    }
  }
  for (i, row) in ROWS.iter().enumerate() {
    if !row.customizable || row.id == GLOBAL_STICKY_ID || settled[i] {
      continue;
    }
    if !workspace && row.id == WORKSPACE_ID {
      continue;
    }
    if let Some(accel) = default_accel(row, platform) {
      if occupied.contains_key(&accel) {
        unset_defaults.push(row.id.to_string());
      } else {
        occupied.insert(accel.clone(), row.id);
        accels[i] = Some(accel);
      }
    }
  }
  Resolved {
    new_note_shortcut: global_text,
    overrides: kept,
    accels,
    platform,
    repaired,
    unset_defaults,
    workspace,
  }
}

impl Resolved {
  pub fn accel(&self, id: &str) -> Option<&Accel> {
    row_index(id).and_then(|i| self.accels[i].as_ref())
  }
  /// The accelerator text for the native menu item `menu_id`, if it has one.
  pub fn menu_accelerator(&self, menu_id: &str) -> Option<String> {
    let i = ROWS.iter().position(|row| row.menu_id == Some(menu_id))?;
    self.accels[i].as_ref().map(Accel::to_tauri)
  }
  /// The native menu item id whose accelerator is `accel` (any spelling).
  pub fn menu_id_for_accelerator(&self, accel: &str) -> Option<&'static str> {
    let wanted = normalize(accel, self.platform).ok()?;
    ROWS.iter().enumerate().find_map(|(i, row)| {
      let id = row.menu_id?;
      (self.accels[i].as_ref() == Some(&wanted)).then_some(id)
    })
  }
  /// Canonical accelerators of every native menu item that can be triggered.
  #[cfg(test)]
  pub fn menu_accelerators(&self) -> Vec<String> {
    self.menu_accelerators_for(true)
  }
  /// The same, without the workspace's when `workspace` is false: with no menu
  /// item it must not swallow its key.
  pub fn menu_accelerators_for(&self, workspace: bool) -> Vec<String> {
    ROWS
      .iter()
      .enumerate()
      .filter(|(_, row)| row.menu_id.is_some())
      .filter(|(_, row)| workspace || row.menu_id != Some("workspace"))
      .filter_map(|(i, _)| self.accels[i].as_ref())
      .map(|a| a.canonical(self.platform))
      .collect()
  }
  /// The id of whatever already holds `accel`, ignoring row `except`.
  pub fn conflict(&self, accel: &Accel, except: &str) -> Option<&'static str> {
    for (i, row) in ROWS.iter().enumerate() {
      if row.id != except
        && (self.workspace || row.id != WORKSPACE_ID)
        && self.accels[i].as_ref() == Some(accel)
      {
        return Some(row.id);
      }
    }
    reserved_accels(self.platform)
      .into_iter()
      .find(|(_, a)| a == accel)
      .map(|(id, _)| id)
  }
}
/// Why a shortcut change was refused. `code` is what the frontend receives.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SetError {
  UnknownId,
  Fixed,
  Invalid(String),
  NeedsModifier,
  MacOption,
  Unreachable,
  NumpadKey,
  Conflict(String),
}

impl SetError {
  pub fn code(&self) -> String {
    match self {
      SetError::UnknownId => "unknown-id".to_string(),
      SetError::Fixed => "fixed".to_string(),
      SetError::Invalid(why) => format!("invalid:{why}"),
      SetError::NeedsModifier => "needs-modifier".to_string(),
      SetError::MacOption => "mac-option".to_string(),
      SetError::Unreachable => "unreachable".to_string(),
      SetError::NumpadKey => "unsupported-key".to_string(),
      SetError::Conflict(id) => format!("conflict:{id}"),
    }
  }
}
/// The stored state a change produces: the global key text and the overrides.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NextState {
  pub new_note_shortcut: String,
  pub overrides: BTreeMap<String, String>,
}

fn customizable_row(id: &str) -> Result<&'static Row, SetError> {
  let row = &ROWS[row_index(id).ok_or(SetError::UnknownId)?];
  if row.customizable {
    Ok(row)
  } else {
    Err(SetError::Fixed)
  }
}

fn finish(next: NextState, platform: Platform, workspace: bool) -> Result<NextState, SetError> {
  let check = resolve_in(
    &next.new_note_shortcut,
    &next.overrides,
    platform,
    workspace,
  );
  if check.repaired.is_empty() {
    Ok(next)
  } else {
    Err(SetError::Invalid(check.repaired.join(",")))
  }
}

fn state_of(resolved: &Resolved) -> NextState {
  NextState {
    new_note_shortcut: resolved.new_note_shortcut.clone(),
    overrides: resolved.overrides.clone(),
  }
}

fn validate_for(
  resolved: &Resolved,
  row: &Row,
  accel: &Accel,
  platform: Platform,
) -> Result<(), SetError> {
  match rule_violation(row, accel, platform) {
    Some(RuleError::NeedsModifier) => return Err(SetError::NeedsModifier),
    Some(RuleError::MacOption) => return Err(SetError::MacOption),
    Some(RuleError::Unreachable) => return Err(SetError::Unreachable),
    Some(RuleError::NumpadKey) => return Err(SetError::NumpadKey),
    None => {}
  }
  match resolved.conflict(accel, row.id) {
    Some(other) => Err(SetError::Conflict(other.to_string())),
    None => Ok(()),
  }
}
/// Plan binding row `id` to `accel` (`None` clears it).
pub fn plan_set(
  resolved: &Resolved,
  id: &str,
  accel: Option<&str>,
  platform: Platform,
) -> Result<NextState, SetError> {
  let row = customizable_row(id)?;
  let mut next = state_of(resolved);
  let text = match accel {
    None => String::new(),
    Some(raw) => {
      let parsed = normalize(raw, platform).map_err(SetError::Invalid)?;
      validate_for(resolved, row, &parsed, platform)?;
      parsed.canonical(platform)
    }
  };
  if id == GLOBAL_STICKY_ID {
    next.new_note_shortcut = text;
  } else {
    next.overrides.insert(id.to_string(), text);
  }
  finish(next, platform, resolved.workspace)
}
/// Plan returning row `id` to its default key.
pub fn plan_reset(
  resolved: &Resolved,
  id: &str,
  platform: Platform,
) -> Result<NextState, SetError> {
  let row = customizable_row(id)?;
  let mut next = state_of(resolved);
  let default = default_accel(row, platform);
  if let Some(accel) = &default {
    validate_for(resolved, row, accel, platform)?;
  }
  if id == GLOBAL_STICKY_ID {
    next.new_note_shortcut = default.map(|a| a.canonical(platform)).unwrap_or_default();
  } else {
    next.overrides.remove(id);
  }
  finish(next, platform, resolved.workspace)
}
/// Canonical default key of row `id` for `platform`; empty when it has none.
pub fn default_canonical(id: &str, platform: Platform) -> String {
  row_index(id)
    .and_then(|i| default_accel(&ROWS[i], platform))
    .map(|a| a.canonical(platform))
    .unwrap_or_default()
}
/// The state with nothing customized.
pub fn plan_reset_all(platform: Platform) -> NextState {
  let global = ROWS
    .iter()
    .find(|row| row.id == GLOBAL_STICKY_ID)
    .and_then(|row| default_accel(row, platform))
    .map(|a| a.canonical(platform))
    .unwrap_or_default();
  NextState {
    new_note_shortcut: global,
    overrides: BTreeMap::new(),
  }
}
/// The shortcut settings as `settings.rs` stores them, resolved for this OS.
pub fn resolve_current(settings: &crate::settings::AppSettings) -> Resolved {
  resolve_in(
    &settings.new_note_shortcut,
    &settings.shortcut_overrides,
    Platform::current(),
    crate::edition::workspace_enabled(crate::edition::is_lite()),
  )
}

fn label_text(label: Label, locale: i18n::Locale) -> String {
  match label {
    Label::One(key) => i18n::tr(locale, key).to_string(),
    Label::Pair(a, b) => {
      let joiner = match locale {
        i18n::Locale::ZhTw | i18n::Locale::ZhCn | i18n::Locale::Ja => "／",
        _ => " / ",
      };
      format!("{}{joiner}{}", i18n::tr(locale, a), i18n::tr(locale, b))
    }
  }
}
/// One row of the shortcut list handed to the frontend.
#[derive(Serialize, Debug)]
pub struct ShortcutRow {
  pub id: &'static str,
  pub section: String,
  pub label: String,
  /// Effective canonical key, empty when unset.
  pub accelerator: String,
  /// Default canonical key, empty when the row has none.
  pub default: String,
  pub customizable: bool,
  /// Where the key is handled: "global", "menu", "window" and/or "editor".
  /// Empty for an "other" row. The recorder applies the rules of these scopes.
  pub scopes: Vec<&'static str>,
  /// Keys to display, in order: a registry row's effective key, or the keys of
  /// a read-only "other" row.
  pub keys: Vec<String>,
  /// Every conflict-capable id whose key this row shows besides its own `id`.
  pub alias_ids: Vec<&'static str>,
  /// A read-only row of the "Other fixed keys" group.
  pub other: bool,
  /// Group id of an "other" row, empty for a registry row.
  pub heading: &'static str,
}
/// The `RESERVED` ids that have a key on `platform`.
fn reserved_ids_on(platform: Platform) -> Vec<&'static str> {
  RESERVED
    .iter()
    .filter(|(_, mac, other, _)| {
      let text = if platform == Platform::MacOS {
        mac
      } else {
        other
      };
      !text.is_empty()
    })
    .map(|(id, ..)| *id)
    .collect()
}

pub fn shortcut_rows(
  resolved: &Resolved,
  locale: i18n::Locale,
  platform: Platform,
) -> Vec<ShortcutRow> {
  let mut out: Vec<ShortcutRow> = ROWS
    .iter()
    .enumerate()
    .map(|(i, row)| {
      let accelerator = resolved.accels[i]
        .as_ref()
        .map(|a| a.canonical(platform))
        .unwrap_or_default();
      ShortcutRow {
        id: row.id,
        section: row.section.map_or_else(
          || "Note&Pad".to_string(),
          |key| i18n::tr(locale, key).to_string(),
        ),
        label: label_text(row.label, locale),
        keys: if accelerator.is_empty() {
          Vec::new()
        } else {
          vec![accelerator.clone()]
        },
        accelerator,
        default: default_accel(row, platform)
          .map(|a| a.canonical(platform))
          .unwrap_or_default(),
        customizable: row.customizable,
        scopes: row.scopes.iter().map(|scope| scope.name()).collect(),
        alias_ids: Vec::new(),
        other: false,
        heading: "",
      }
    })
    .collect();
  let reserved = reserved_ids_on(platform);
  for row in OTHER_ROWS {
    let keys = if platform == Platform::MacOS {
      row.mac
    } else {
      row.other
    };
    let Some(keys) = keys else {
      continue;
    };
    out.push(ShortcutRow {
      id: row.id,
      section: i18n::tr(locale, row.heading.key()).to_string(),
      label: label_text(row.label, locale),
      accelerator: String::new(),
      default: String::new(),
      customizable: false,
      scopes: Vec::new(),
      keys: keys.iter().map(|k| k.to_string()).collect(),
      alias_ids: row
        .aliases
        .iter()
        .copied()
        .filter(|id| reserved.contains(id))
        .collect(),
      other: true,
      heading: row.heading.id(),
    });
  }
  out
}

/// The rows the Settings list shows. The Lite edition has no workspace, so no
/// row for its key either; the stored override stays.
pub fn rows_for_edition(rows: Vec<ShortcutRow>, lite: bool) -> Vec<ShortcutRow> {
  rows
    .into_iter()
    .filter(|row| crate::edition::workspace_enabled(lite) || row.id != "menu.workspace")
    .collect()
}

#[tauri::command]
pub fn get_shortcuts(app: AppHandle) -> Vec<ShortcutRow> {
  let settings = crate::settings::app_settings(&app);
  let locale = i18n::current_locale(&settings.language);
  rows_for_edition(
    shortcut_rows(&resolve_current(&settings), locale, Platform::current()),
    crate::edition::is_lite(),
  )
}
/// The stable code the frontend maps to "another app may be using it".
fn global_register_error(detail: impl std::fmt::Display) -> String {
  format!("global-register:{detail}")
}
/// Register `accel` as the global new-sticky key.
fn register_global(app: &AppHandle, accel: &Accel) -> Result<(), String> {
  let shortcut = crate::shortcut::parse_accelerator(&accel.to_tauri())?;
  app
    .global_shortcut()
    .register(shortcut)
    .map_err(global_register_error)
}

fn unregister_global(app: &AppHandle, accel: &Accel) {
  if let Ok(shortcut) = crate::shortcut::parse_accelerator(&accel.to_tauri()) {
    let _ = app.global_shortcut().unregister(shortcut);
  }
}
/// Persist `next` and apply it to the running app. The global key is
/// registered before the file is written and the old one released after, so a
/// refused registration or a failed write leaves the working key untouched.
fn commit(app: &AppHandle, current: &Resolved, next: NextState) -> Result<(), String> {
  let platform = Platform::current();
  let old_global = current.accel(GLOBAL_STICKY_ID).cloned();
  let new_global = if next.new_note_shortcut.is_empty() {
    None
  } else {
    normalize(&next.new_note_shortcut, platform).ok()
  };
  let global_changed = old_global != new_global;
  if global_changed {
    if let Some(accel) = &new_global {
      register_global(app, accel)?;
    }
  }
  let patch = serde_json::json!({
    "new_note_shortcut": next.new_note_shortcut,
    "shortcut_overrides": next.overrides,
  });
  if let Err(e) = crate::settings::save_settings(app.clone(), patch) {
    if global_changed {
      if let Some(accel) = &new_global {
        unregister_global(app, accel);
      }
    }
    return Err(e);
  }
  if global_changed {
    if let Some(accel) = &old_global {
      unregister_global(app, accel);
    }
  }
  let locale = i18n::current_locale(&crate::settings::app_settings(app).language);
  crate::rebuild_menus(app, locale);
  crate::reapply_focus_menu(app);
  Ok(())
}

fn change(
  app: &AppHandle,
  plan: impl FnOnce(&Resolved, Platform) -> Result<NextState, SetError>,
) -> Result<(), String> {
  let path = crate::settings::settings_path(app)?;
  let stored = crate::settings::load_or_default_for_write(&path)?;
  let platform = Platform::current();
  let current = resolve_current(&stored);
  let next = plan(&current, platform).map_err(|e| e.code())?;
  commit(app, &current, next)
}
/// Bind a row to a key, or clear it with `None`. Errors are the codes in
/// `SetError::code`.
#[tauri::command]
pub fn set_shortcut(app: AppHandle, id: String, accel: Option<String>) -> Result<(), String> {
  change(&app, |resolved, platform| {
    plan_set(resolved, &id, accel.as_deref(), platform)
  })
}

#[tauri::command]
pub fn reset_shortcut(app: AppHandle, id: String) -> Result<(), String> {
  change(&app, |resolved, platform| {
    plan_reset(resolved, &id, platform)
  })
}

#[tauri::command]
pub fn reset_all_shortcuts(app: AppHandle) -> Result<(), String> {
  change(&app, |_, platform| Ok(plan_reset_all(platform)))
}
/// Register the global new-sticky key at startup.
pub fn register_startup_global(app: &AppHandle) {
  let settings = crate::settings::app_settings(app);
  let resolved = resolve_current(&settings);
  if let Some(accel) = resolved.accel(GLOBAL_STICKY_ID) {
    if let Err(e) = register_global(app, accel) {
      log::warn!(
        "failed to register global shortcut '{}': {e}",
        accel.to_tauri()
      );
    }
  }
}
/// macOS virtual key code of the physical key named by a DOM `code` that is
/// a letter key, or `None`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_letter_keycode(code: &str) -> Option<u16> {
  Some(match code {
    "KeyA" => 0x00,
    "KeyS" => 0x01,
    "KeyD" => 0x02,
    "KeyF" => 0x03,
    "KeyH" => 0x04,
    "KeyG" => 0x05,
    "KeyZ" => 0x06,
    "KeyX" => 0x07,
    "KeyC" => 0x08,
    "KeyV" => 0x09,
    "KeyB" => 0x0B,
    "KeyQ" => 0x0C,
    "KeyW" => 0x0D,
    "KeyE" => 0x0E,
    "KeyR" => 0x0F,
    "KeyY" => 0x10,
    "KeyT" => 0x11,
    "KeyO" => 0x1F,
    "KeyU" => 0x20,
    "KeyI" => 0x22,
    "KeyP" => 0x23,
    "KeyL" => 0x25,
    "KeyJ" => 0x26,
    "KeyK" => 0x28,
    "KeyN" => 0x2D,
    "KeyM" => 0x2E,
    _ => return None,
  })
}
/// The lowercase ASCII letter a layout produced, or `None` when it produced
/// anything else (a symbol, a non-Latin letter, nothing, several characters).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn ascii_letter_of(utf16: &[u16]) -> Option<String> {
  let [unit] = utf16 else {
    return None;
  };
  let c = char::from_u32(u32::from(*unit))?;
  c.is_ascii_alphabetic()
    .then(|| c.to_ascii_lowercase().to_string())
}

#[cfg(target_os = "macos")]
mod mac_layout {
  use std::ffi::c_void;

  type CfRef = *const c_void;

  #[link(name = "Carbon", kind = "framework")]
  extern "C" {
    static kTISPropertyUnicodeKeyLayoutData: CfRef;
    fn TISCopyCurrentKeyboardLayoutInputSource() -> CfRef;
    fn TISGetInputSourceProperty(source: CfRef, key: CfRef) -> CfRef;
    fn LMGetKbdType() -> u8;
    #[allow(clippy::too_many_arguments)]
    fn UCKeyTranslate(
      layout: *const c_void,
      virtual_key_code: u16,
      key_action: u16,
      modifier_key_state: u32,
      keyboard_type: u32,
      options: u32,
      dead_key_state: *mut u32,
      max_length: usize,
      actual_length: *mut usize,
      out: *mut u16,
    ) -> i32;
  }

  #[link(name = "CoreFoundation", kind = "framework")]
  extern "C" {
    fn CFDataGetBytePtr(data: CfRef) -> *const u8;
    fn CFRelease(value: CfRef);
  }
  /// What the current keyboard layout types for `key_code` with no modifiers.
  /// Must run on the main thread.
  pub fn translate(key_code: u16) -> Option<Vec<u16>> {
    // SAFETY: the input source is owned by this call and released below; the
    // layout data it points into stays valid until then, and the output
    // buffer length passed matches the buffer.
    unsafe {
      let source = TISCopyCurrentKeyboardLayoutInputSource();
      if source.is_null() {
        return None;
      }
      let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
      let result = if data.is_null() {
        None
      } else {
        let layout = CFDataGetBytePtr(data).cast::<c_void>();
        let mut dead_keys = 0u32;
        let mut out = [0u16; 8];
        let mut len = 0usize;
        let status = UCKeyTranslate(
          layout,
          key_code,
          0,
          0,
          u32::from(LMGetKbdType()),
          1,
          &mut dead_keys,
          out.len(),
          &mut len,
          out.as_mut_ptr(),
        );
        (status == 0).then(|| out[..len.min(out.len())].to_vec())
      };
      CFRelease(source);
      result
    }
  }
}
/// The lowercase letter the current keyboard layout types on the physical key
/// `code` names, or `None` when the layout has no letter there. Synchronous on
/// purpose: Tauri runs a plain command on the main thread, which is the only
/// thread the text-input-source calls may use.
#[tauri::command]
pub fn layout_char_for_code(code: String) -> Option<String> {
  #[cfg(target_os = "macos")]
  {
    let key_code = mac_letter_keycode(&code)?;
    ascii_letter_of(&mac_layout::translate(key_code)?)
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = code;
    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const MAC: Platform = Platform::MacOS;
  const OTHER: Platform = Platform::Other;

  fn none() -> BTreeMap<String, String> {
    BTreeMap::new()
  }

  fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
      .iter()
      .map(|(k, v)| (k.to_string(), v.to_string()))
      .collect()
  }

  fn defaults(platform: Platform) -> Resolved {
    resolve(
      &default_canonical(GLOBAL_STICKY_ID, platform),
      &none(),
      platform,
    )
  }

  #[test]
  fn lite_has_no_workspace_shortcut_row_and_full_does() {
    let rows = |lite| {
      rows_for_edition(
        shortcut_rows(&defaults(OTHER), i18n::Locale::En, OTHER),
        lite,
      )
    };
    assert!(!rows(true).iter().any(|row| row.id == "menu.workspace"));
    assert!(rows(false).iter().any(|row| row.id == "menu.workspace"));
    // Nothing else goes with it.
    assert_eq!(rows(true).len() + 1, rows(false).len());
  }

  fn with_workspace_override(workspace: bool) -> Resolved {
    resolve_in(
      &default_canonical(GLOBAL_STICKY_ID, OTHER),
      &map(&[("menu.workspace", "Ctrl+Alt+K")]),
      OTHER,
      workspace,
    )
  }

  #[test]
  fn lite_ignores_the_hidden_workspace_row_when_looking_for_a_conflict() {
    let key = normalize("Ctrl+Alt+K", OTHER).unwrap();
    assert_eq!(
      with_workspace_override(true).conflict(&key, "menu.find"),
      Some("menu.workspace")
    );
    let lite = with_workspace_override(false);
    assert_eq!(lite.conflict(&key, "menu.find"), None);
    // Another row's key is still a conflict.
    let other = normalize("Ctrl+N", OTHER).unwrap();
    assert_eq!(lite.conflict(&other, "menu.find"), Some("menu.new"));
  }

  #[test]
  fn lite_lets_another_row_take_the_hidden_workspace_key_and_keeps_its_override() {
    let lite = with_workspace_override(false);
    for id in ["menu.find-replace", "menu.line-numbers", "menu.word-wrap"] {
      let next = plan_set(&lite, id, Some("Ctrl+Alt+K"), OTHER)
        .unwrap_or_else(|e| panic!("{id}: {}", e.code()));
      assert_eq!(next.overrides[id], "Ctrl+Alt+K");
      // The workspace override rides along exactly as stored.
      assert_eq!(next.overrides["menu.workspace"], "Ctrl+Alt+K");
    }
    // The workspace default key is free too.
    let default = default_canonical("menu.workspace", OTHER);
    assert!(plan_set(&lite, "menu.line-numbers", Some(&default), OTHER).is_ok());
  }

  #[test]
  fn a_reset_in_lite_keeps_the_workspace_override_too() {
    let lite = with_workspace_override(false);
    let next = plan_reset(&lite, "menu.find-replace", OTHER).unwrap();
    assert_eq!(next.overrides["menu.workspace"], "Ctrl+Alt+K");
  }

  #[test]
  fn full_still_reports_the_workspace_key_as_taken() {
    let full = with_workspace_override(true);
    for id in ["menu.find-replace", "menu.line-numbers", "menu.word-wrap"] {
      assert!(
        matches!(
          plan_set(&full, id, Some("Ctrl+Alt+K"), OTHER),
          Err(SetError::Conflict(other)) if other == "menu.workspace"
        ),
        "{id}"
      );
    }
  }

  #[test]
  fn lite_resolution_neither_claims_nor_repairs_the_workspace_row() {
    // A stored override that would collide, and one that is not even a key.
    for stored in ["Ctrl+N", "nonsense"] {
      let lite = resolve_in(
        &default_canonical(GLOBAL_STICKY_ID, OTHER),
        &map(&[("menu.workspace", stored)]),
        OTHER,
        false,
      );
      assert!(lite.repaired.is_empty(), "{stored}");
      assert_eq!(lite.overrides["menu.workspace"], stored);
      assert!(lite.accel("menu.workspace").is_none());
    }
    // Nor does its default key, when nothing is stored for it.
    let bare = resolve_in(
      &default_canonical(GLOBAL_STICKY_ID, OTHER),
      &none(),
      OTHER,
      false,
    );
    assert!(bare.accel("menu.workspace").is_none());
  }

  #[test]
  fn lite_does_not_claim_the_workspace_key_for_the_menu() {
    let keys = defaults(OTHER);
    let workspace = keys.accel("menu.workspace").unwrap().canonical(OTHER);
    assert!(keys.menu_accelerators_for(true).contains(&workspace));
    assert!(!keys.menu_accelerators_for(false).contains(&workspace));
    assert_eq!(
      keys.menu_accelerators_for(false).len() + 1,
      keys.menu_accelerators_for(true).len()
    );
  }

  fn canon(text: &str, platform: Platform) -> String {
    normalize(text, platform).unwrap().canonical(platform)
  }
  /// The confirmed registry list, typed out independently of `ROWS`:
  /// (id, scopes, customizable, macOS default, Windows/Linux default).
  /// Scopes: G global, M menu, W window, E editor.
  const EXPECTED: &[(&str, &str, bool, &str, &str)] = &[
    ("menu.quit", "M", false, "Cmd+Q", "Ctrl+Q"),
    ("menu.settings", "M", false, "Cmd+,", "Ctrl+,"),
    ("menu.new-tab", "M", false, "Cmd+T", "Ctrl+T"),
    ("menu.open", "M", false, "Cmd+O", "Ctrl+O"),
    ("menu.close", "M", false, "Cmd+W", "Ctrl+W"),
    ("menu.save", "M", false, "Cmd+S", "Ctrl+S"),
    ("menu.save-as", "M", false, "Shift+Cmd+S", "Ctrl+Shift+S"),
    ("menu.find", "M", false, "Cmd+F", "Ctrl+F"),
    ("menu.find-next", "M", false, "Cmd+G", "Ctrl+G"),
    ("menu.find-prev", "M", false, "Shift+Cmd+G", "Ctrl+Shift+G"),
    ("menu.undo", "M", false, "Cmd+Z", "Ctrl+Z"),
    ("menu.redo", "M", false, "Shift+Cmd+Z", "Ctrl+Y"),
    ("menu.cut", "M", false, "Cmd+X", "Ctrl+X"),
    ("menu.copy", "M", false, "Cmd+C", "Ctrl+C"),
    ("menu.paste", "M", false, "Cmd+V", "Ctrl+V"),
    ("menu.select-all", "M", false, "Cmd+A", "Ctrl+A"),
    ("menu.minimize", "M", false, "Cmd+M", ""),
    (
      "global.new-sticky",
      "G",
      true,
      "Shift+Cmd+N",
      "Ctrl+Shift+N",
    ),
    ("menu.new", "M", true, "Cmd+N", "Ctrl+N"),
    ("menu.find-replace", "M", true, "Alt+Cmd+F", "Ctrl+Alt+F"),
    ("menu.workspace", "M", true, "Shift+Cmd+E", "Ctrl+Shift+E"),
    ("menu.show-in-finder", "M", true, "", ""),
    ("menu.copy-path", "M", true, "", ""),
    ("menu.word-wrap", "M", true, "", ""),
    ("menu.line-numbers", "M", true, "", ""),
    ("menu.always-on-top", "M", true, "", ""),
    ("menu.about", "M", true, "", ""),
    ("menu.help-documentation", "M", true, "", ""),
    ("menu.help-report-issue", "M", true, "", ""),
    ("menu.help-acknowledgements", "M", true, "", ""),
    ("menu.help-privacy", "M", true, "", ""),
    ("window.next-tab", "W", true, "Ctrl+Tab", "Ctrl+Tab"),
    (
      "window.prev-tab",
      "W",
      true,
      "Ctrl+Shift+Tab",
      "Ctrl+Shift+Tab",
    ),
    ("goto-line", "EW", true, "Alt+Cmd+G", "Ctrl+Alt+G"),
    (
      "editor.move-line-up",
      "E",
      true,
      "Alt+ArrowUp",
      "Alt+ArrowUp",
    ),
    (
      "editor.move-line-down",
      "E",
      true,
      "Alt+ArrowDown",
      "Alt+ArrowDown",
    ),
    (
      "editor.copy-line-up",
      "E",
      true,
      "Alt+Shift+ArrowUp",
      "Alt+Shift+ArrowUp",
    ),
    (
      "editor.copy-line-down",
      "E",
      true,
      "Alt+Shift+ArrowDown",
      "Alt+Shift+ArrowDown",
    ),
    (
      "editor.add-cursor-above",
      "E",
      true,
      "Alt+Cmd+ArrowUp",
      "Ctrl+Alt+ArrowUp",
    ),
    (
      "editor.add-cursor-below",
      "E",
      true,
      "Alt+Cmd+ArrowDown",
      "Ctrl+Alt+ArrowDown",
    ),
    (
      "editor.insert-line-below",
      "E",
      true,
      "Cmd+Enter",
      "Ctrl+Enter",
    ),
    ("editor.select-line", "E", true, "Ctrl+L", "Alt+L"),
    ("editor.expand-selection", "E", true, "Cmd+I", "Ctrl+I"),
    ("editor.outdent", "E", true, "Cmd+[", "Ctrl+["),
    ("editor.indent", "E", true, "Cmd+]", "Ctrl+]"),
    ("editor.reindent", "E", true, "Alt+Cmd+\\", "Ctrl+Alt+\\"),
    (
      "editor.delete-line",
      "E",
      true,
      "Shift+Cmd+K",
      "Ctrl+Shift+K",
    ),
    (
      "editor.go-to-bracket",
      "E",
      true,
      "Shift+Cmd+\\",
      "Ctrl+Shift+\\",
    ),
    ("editor.toggle-line-comment", "E", true, "Cmd+/", "Ctrl+/"),
    (
      "editor.toggle-block-comment",
      "E",
      true,
      "Ctrl+Shift+A",
      "Alt+Shift+A",
    ),
    (
      "editor.toggle-tab-focus",
      "E",
      true,
      "Ctrl+Shift+M",
      "Ctrl+M",
    ),
    ("editor.cursor-undo", "E", true, "Cmd+U", "Ctrl+U"),
    ("editor.cursor-redo", "E", true, "Shift+Cmd+U", "Alt+U"),
    ("editor.add-next-occurrence", "E", true, "Cmd+D", "Ctrl+D"),
    (
      "editor.select-all-occurrences",
      "E",
      true,
      "Shift+Cmd+L",
      "Ctrl+Shift+L",
    ),
    ("editor.fold", "E", true, "Alt+Cmd+[", "Ctrl+Shift+["),
    ("editor.unfold", "E", true, "Alt+Cmd+]", "Ctrl+Shift+]"),
    ("editor.fold-all", "E", true, "Ctrl+Alt+[", "Ctrl+Alt+["),
    ("editor.unfold-all", "E", true, "Ctrl+Alt+]", "Ctrl+Alt+]"),
    (
      "editor.trigger-suggest",
      "E",
      true,
      "Alt+Escape",
      "Ctrl+Space",
    ),
    ("editor.trim-trailing-whitespace", "E", true, "", ""),
    ("editor.add-line-comment", "E", true, "", ""),
    ("editor.remove-line-comment", "E", true, "", ""),
    ("editor.select-to-bracket", "E", true, "", ""),
  ];

  fn scope_letters(row: &Row) -> String {
    row
      .scopes
      .iter()
      .map(|s| match s {
        Scope::Global => 'G',
        Scope::Menu => 'M',
        Scope::Window => 'W',
        Scope::Editor => 'E',
      })
      .collect()
  }

  #[test]
  fn the_registry_matches_the_confirmed_list_row_for_row() {
    assert_eq!(ROWS.len(), EXPECTED.len());
    assert_eq!(ROWS.len(), 17 + 47);
    for (row, (id, scopes, customizable, mac, win)) in ROWS.iter().zip(EXPECTED) {
      assert_eq!(row.id, *id);
      assert_eq!(scope_letters(row), *scopes, "{id}");
      assert_eq!(row.customizable, *customizable, "{id}");
      assert_eq!(row.mac, *mac, "{id}");
      assert_eq!(row.win, *win, "{id}");
    }
  }

  #[test]
  fn ids_are_unique() {
    let mut seen: Vec<&str> = Vec::new();
    for row in ROWS {
      assert!(!seen.contains(&row.id), "{} twice", row.id);
      seen.push(row.id);
    }
  }

  #[test]
  fn every_default_is_canonical() {
    for platform in [MAC, OTHER] {
      for row in ROWS {
        let text = row.default_text(platform);
        if !text.is_empty() {
          assert_eq!(canon(text, platform), text, "{}", row.id);
        }
      }
      for (id, mac, other, _) in RESERVED {
        let text = match platform {
          MAC => mac,
          _ => other,
        };
        if !text.is_empty() {
          assert_eq!(canon(text, platform), *text, "{id}");
        }
      }
    }
  }

  #[test]
  fn no_two_defaults_share_a_key() {
    for platform in [MAC, OTHER] {
      let mut seen: HashMap<Accel, &str> = HashMap::new();
      let rows = ROWS
        .iter()
        .filter_map(|r| default_accel(r, platform).map(|a| (r.id, a)));
      for (id, accel) in rows.chain(reserved_accels(platform)) {
        if let Some(other) = seen.insert(accel.clone(), id) {
          panic!(
            "{id} and {other} both default to {}",
            accel.canonical(platform)
          );
        }
      }
    }
  }

  #[test]
  fn default_settings_resolve_without_any_repair() {
    for platform in [MAC, OTHER] {
      let resolved = defaults(platform);
      assert!(resolved.repaired.is_empty(), "{:?}", resolved.repaired);
      assert!(resolved.unset_defaults.is_empty());
      assert!(resolved.overrides.is_empty());
    }
  }

  #[test]
  fn trigger_suggest_defaults_to_a_non_typing_key_on_mac() {
    let accel = normalize("Alt+Escape", MAC).unwrap();
    assert!(!accel.is_mac_option_typing());
    let mac = defaults(MAC);
    assert_eq!(
      mac
        .accel("editor.trigger-suggest")
        .map(|a| a.canonical(MAC))
        .as_deref(),
      Some("Alt+Escape")
    );
    let other = defaults(OTHER);
    assert_eq!(
      other
        .accel("editor.trigger-suggest")
        .map(|a| a.canonical(OTHER))
        .as_deref(),
      Some("Ctrl+Space")
    );
  }

  #[test]
  fn go_to_line_defaults_to_one_key_per_platform() {
    let mac = defaults(MAC);
    assert_eq!(
      mac.accel("goto-line").map(|a| a.canonical(MAC)).as_deref(),
      Some("Alt+Cmd+G")
    );
    let other = defaults(OTHER);
    assert_eq!(
      other
        .accel("goto-line")
        .map(|a| a.canonical(OTHER))
        .as_deref(),
      Some("Ctrl+Alt+G")
    );
  }

  #[test]
  fn every_mac_editor_default_passes_the_option_rule() {
    let resolved = defaults(MAC);
    for row in ROWS.iter().filter(|r| r.scopes.contains(&Scope::Editor)) {
      let text = row.default_text(MAC);
      if text.is_empty() {
        continue;
      }
      let accel = normalize(text, MAC).unwrap();
      assert!(!accel.is_mac_option_typing(), "{}", row.id);
      assert_eq!(rule_violation(row, &accel, MAC), None, "{}", row.id);
      if row.customizable {
        assert!(
          plan_set(&resolved, row.id, Some(text), MAC).is_ok(),
          "{}",
          row.id
        );
      }
    }
  }

  #[test]
  fn legacy_defaults_normalize_and_round_trip() {
    let legacy = [
      "CmdOrCtrl+Q",
      "CmdOrCtrl+,",
      "CmdOrCtrl+N",
      "CmdOrCtrl+T",
      "CmdOrCtrl+O",
      "CmdOrCtrl+S",
      "CmdOrCtrl+Shift+S",
      "CmdOrCtrl+W",
      "CmdOrCtrl+F",
      "CmdOrCtrl+Alt+F",
      "CmdOrCtrl+G",
      "CmdOrCtrl+Shift+G",
      "CmdOrCtrl+Shift+E",
      "CmdOrCtrl+Shift+N",
      "CmdOrCtrl+Alt+M",
      "Ctrl+Tab",
      "Ctrl+Shift+Tab",
    ];
    for platform in [MAC, OTHER] {
      for text in legacy {
        let once = normalize(text, platform).unwrap();
        let canonical = once.canonical(platform);
        assert_eq!(normalize(&canonical, platform).unwrap(), once, "{text}");
        let tauri = once.to_tauri();
        assert_eq!(normalize(&tauri, platform).unwrap(), once, "{text}");
      }
    }
    assert_eq!(canon("CmdOrCtrl+Shift+N", MAC), "Shift+Cmd+N");
    assert_eq!(canon("CmdOrCtrl+Shift+N", OTHER), "Ctrl+Shift+N");
    assert_eq!(canon("CmdOrCtrl+Alt+M", MAC), "Alt+Cmd+M");
    assert_eq!(canon("CmdOrCtrl+Alt+M", OTHER), "Ctrl+Alt+M");
  }

  #[test]
  fn legacy_modifier_and_key_spellings_convert_per_platform() {
    assert_eq!(canon("Super+Up", OTHER), "Win+ArrowUp");
    assert_eq!(canon("Super+Up", MAC), "Cmd+ArrowUp");
    assert_eq!(canon("command+option+left", MAC), "Alt+Cmd+ArrowLeft");
    assert_eq!(canon("Control+Esc", OTHER), "Ctrl+Escape");
    assert_eq!(canon("Meta+k", OTHER), "Win+K");
    assert_eq!(canon("Cmd+K", OTHER), "Win+K");
    assert_eq!(canon("ctrl+ctrl+a", OTHER), "Ctrl+A");
    assert_eq!(canon("CommandOrControl+F5", MAC), "Cmd+F5");
  }

  #[test]
  fn control_and_command_stay_apart_on_mac() {
    let ctrl = normalize("Ctrl+Tab", MAC).unwrap();
    let cmd = normalize("Cmd+Tab", MAC).unwrap();
    assert_ne!(ctrl, cmd);
    assert_eq!(ctrl.canonical(MAC), "Ctrl+Tab");
    assert_eq!(cmd.canonical(MAC), "Cmd+Tab");
  }

  #[test]
  fn modifier_order_does_not_matter() {
    assert_eq!(
      normalize("Shift+Cmd+G", MAC).unwrap(),
      normalize("Cmd+Shift+G", MAC).unwrap()
    );
    let resolved = defaults(MAC);
    // Shift+Cmd+G is Find Previous, however it is spelled.
    for spelling in ["Shift+Cmd+G", "Cmd+Shift+G", "cmd+shift+g"] {
      let accel = normalize(spelling, MAC).unwrap();
      assert_eq!(
        resolved.conflict(&accel, "editor.fold"),
        Some("menu.find-prev"),
        "{spelling}"
      );
    }
  }

  #[test]
  fn malformed_input_is_rejected() {
    for bad in [
      "",
      "   ",
      "+",
      "Cmd+",
      "Cmd++",
      "NotAKey",
      "Cmd+Foo+A",
      "Win+A",
      "F25",
      "F0",
      "Cmd+F01",
      "Cmd+A+B",
      "Cmd+Ab",
    ] {
      let platform = match bad {
        "Win+A" => MAC,
        _ => OTHER,
      };
      assert!(normalize(bad, platform).is_err(), "{bad:?}");
    }
    assert!(normalize("Win+A", OTHER).is_ok());
  }

  #[test]
  fn modifier_requirement_matches_the_old_global_rule() {
    let ok = [
      "Ctrl+N",
      "Alt+J",
      "Cmd+N",
      "F5",
      "F24",
      "Shift+Cmd+N",
      "Win+A",
    ];
    for text in ok {
      assert!(
        normalize(text, OTHER)
          .or_else(|_| normalize(text, MAC))
          .unwrap()
          .has_required_modifier(),
        "{text}"
      );
    }
    for text in ["Enter", "N", "Shift+N", "Shift+F5", "Shift+Enter", "Space"] {
      assert!(
        !normalize(text, OTHER).unwrap().has_required_modifier(),
        "{text}"
      );
    }
  }

  #[test]
  fn every_emitted_accelerator_parses_in_the_hotkey_plugin() {
    for platform in [MAC, OTHER] {
      let mut texts: Vec<String> = ROWS
        .iter()
        .filter_map(|r| default_accel(r, platform))
        .map(|a| a.to_tauri())
        .collect();
      texts.extend(reserved_accels(platform).iter().map(|(_, a)| a.to_tauri()));
      // Every key name the canonical format allows, with all four modifiers.
      let mut keys: Vec<String> = ('A'..='Z').map(String::from).collect();
      keys.extend((0..=9).map(|d| d.to_string()));
      keys.extend((1..=24).map(|n| format!("F{n}")));
      keys.extend(PUNCTUATION.chars().map(String::from));
      keys.extend(
        [
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Tab",
          "Space",
          "Enter",
          "Backspace",
          "Delete",
          "Home",
          "End",
          "PageUp",
          "PageDown",
          "Escape",
        ]
        .map(String::from),
      );
      let modifiers = if platform == MAC {
        "Ctrl+Alt+Shift+Cmd+"
      } else {
        "Ctrl+Alt+Shift+Win+"
      };
      texts.extend(keys.iter().map(|k| {
        normalize(&format!("{modifiers}{k}"), platform)
          .unwrap()
          .to_tauri()
      }));
      for text in &texts {
        assert!(
          crate::shortcut::parse_accelerator(text).is_ok(),
          "hotkey plugin rejects {text}"
        );
      }
    }
  }

  #[test]
  fn menu_accelerator_reads_the_effective_key() {
    let resolved = defaults(OTHER);
    assert_eq!(resolved.menu_accelerator("save").as_deref(), Some("Ctrl+S"));
    assert_eq!(
      resolved.menu_accelerator("save-as").as_deref(),
      Some("Ctrl+Shift+S")
    );
    assert_eq!(resolved.menu_accelerator("about"), None);
    assert_eq!(resolved.menu_accelerator("minimize"), None);
    let mac = defaults(MAC);
    assert_eq!(mac.menu_accelerator("minimize").as_deref(), Some("Super+M"));
    assert_eq!(
      mac.menu_accelerator("new-sticky").as_deref(),
      Some("Super+N")
    );
    let moved = resolve("", &map(&[("menu.workspace", "Ctrl+Shift+1")]), OTHER);
    assert_eq!(
      moved.menu_accelerator("workspace").as_deref(),
      Some("Ctrl+Shift+1")
    );
    assert_eq!(
      moved.menu_id_for_accelerator("Ctrl+Shift+1"),
      Some("workspace")
    );
    assert_eq!(moved.menu_id_for_accelerator("Ctrl+Shift+E"), None);
  }

  #[test]
  fn only_menu_items_are_offered_to_the_windows_key_path() {
    let list = defaults(OTHER).menu_accelerators();
    assert!(list.contains(&"Ctrl+S".to_string()));
    assert!(list.contains(&"Ctrl+Alt+F".to_string()));
    for not_menu in ["Ctrl+Tab", "Ctrl+Alt+G", "Ctrl+Z", "Alt+ArrowUp"] {
      assert!(!list.contains(&not_menu.to_string()), "{not_menu}");
    }
  }
  // ---- repair -----------------------------------------------------------

  #[test]
  fn an_unknown_fixed_or_global_id_is_dropped_and_reported() {
    let r = resolve(
      "",
      &map(&[
        ("no.such-row", "Ctrl+Alt+Q"),
        ("menu.save", "Ctrl+Alt+W"),
        (GLOBAL_STICKY_ID, "Ctrl+Alt+E"),
      ]),
      OTHER,
    );
    assert!(r.overrides.is_empty());
    assert_eq!(
      r.repaired,
      vec![
        "shortcut_overrides.global.new-sticky",
        "shortcut_overrides.menu.save",
        "shortcut_overrides.no.such-row",
      ]
    );
  }

  #[test]
  fn unparseable_or_rule_breaking_overrides_fall_back_to_the_default() {
    let r = resolve(
      &default_canonical(GLOBAL_STICKY_ID, OTHER),
      &map(&[
        ("editor.indent", "garbage"),
        ("editor.outdent", "Shift+A"),
        ("editor.delete-line", "Enter"),
      ]),
      OTHER,
    );
    assert!(r.overrides.is_empty());
    assert_eq!(r.repaired.len(), 3);
    assert_eq!(
      r.accel("editor.indent")
        .map(|a| a.canonical(OTHER))
        .as_deref(),
      Some("Ctrl+]")
    );
    assert!(r.unset_defaults.is_empty());
  }

  #[test]
  fn the_mac_option_rule_applies_to_editor_rows_only() {
    let r = resolve(
      &default_canonical(GLOBAL_STICKY_ID, MAC),
      &map(&[
        ("editor.indent", "Alt+J"),
        ("editor.outdent", "Alt+Shift+K"),
        ("editor.delete-line", "Alt+ArrowLeft"),
        ("menu.workspace", "Alt+J"),
      ]),
      MAC,
    );
    // Alt+ArrowLeft is held by the fixed word-jump, so it conflicts instead.
    assert_eq!(
      r.repaired,
      vec![
        "shortcut_overrides.editor.outdent",
        "shortcut_overrides.editor.indent",
        "shortcut_overrides.editor.delete-line",
      ]
    );
    assert_eq!(
      r.overrides.get("menu.workspace").map(String::as_str),
      Some("Alt+J")
    );
    let other = resolve("", &map(&[("editor.indent", "Alt+J")]), OTHER);
    assert!(other.repaired.is_empty());
  }

  #[test]
  fn an_override_cannot_take_a_fixed_or_reserved_key() {
    let r = resolve(
      "",
      &map(&[
        ("editor.indent", "Cmd+S"),
        ("editor.outdent", "Ctrl+B"),
        ("editor.fold", "F3"),
      ]),
      MAC,
    );
    assert_eq!(r.repaired.len(), 3);
    assert!(r.overrides.is_empty());
  }

  #[test]
  fn colliding_overrides_are_settled_by_registry_order_not_by_name() {
    // `editor.add-cursor-above` sorts before `editor.move-line-up` by name but
    // comes after it in the registry, so the registry decides.
    assert!(
      row_index("editor.move-line-up").unwrap() < row_index("editor.add-cursor-above").unwrap()
    );
    let r = resolve(
      "",
      &map(&[
        ("editor.add-cursor-above", "Ctrl+Alt+Q"),
        ("editor.move-line-up", "Ctrl+Alt+Q"),
      ]),
      OTHER,
    );
    assert_eq!(
      r.overrides.get("editor.move-line-up").map(String::as_str),
      Some("Ctrl+Alt+Q")
    );
    assert!(!r.overrides.contains_key("editor.add-cursor-above"));
    assert_eq!(
      r.repaired,
      vec!["shortcut_overrides.editor.add-cursor-above"]
    );
    // The loser falls back to its default, which is still free.
    assert_eq!(
      r.accel("editor.add-cursor-above")
        .map(|a| a.canonical(OTHER))
        .as_deref(),
      Some("Ctrl+Alt+ArrowUp")
    );
  }

  #[test]
  fn an_override_that_takes_another_rows_default_blocks_it_and_chains() {
    // Fold is garbage, so it wants its default back; Unfold already took that
    // default key as its override, so Fold ends up unset.
    let r = resolve(
      "",
      &map(&[
        ("editor.fold", "garbage"),
        ("editor.unfold", "Ctrl+Shift+["),
      ]),
      OTHER,
    );
    assert_eq!(r.repaired, vec!["shortcut_overrides.editor.fold"]);
    assert_eq!(r.unset_defaults, vec!["editor.fold"]);
    assert_eq!(r.accel("editor.fold"), None);
    assert_eq!(
      r.accel("editor.unfold")
        .map(|a| a.canonical(OTHER))
        .as_deref(),
      Some("Ctrl+Shift+[")
    );
  }

  #[test]
  fn a_new_default_held_by_an_override_leaves_that_row_unset() {
    let r = resolve("", &map(&[("editor.fold", "Ctrl+Alt+G")]), OTHER);
    assert!(r.repaired.is_empty());
    assert_eq!(r.unset_defaults, vec!["goto-line"]);
    assert_eq!(r.accel("goto-line"), None);
  }

  #[test]
  fn the_global_key_claims_before_overrides() {
    let r = resolve("Ctrl+Alt+K", &map(&[("editor.fold", "Alt+Ctrl+K")]), OTHER);
    assert_eq!(r.new_note_shortcut, "Ctrl+Alt+K");
    assert_eq!(r.repaired, vec!["shortcut_overrides.editor.fold"]);
    assert!(r.overrides.is_empty());
  }

  #[test]
  fn a_global_key_that_collides_with_a_fixed_key_resets_to_the_default() {
    for bad in ["Cmd+S", "Shift+N", "garbage"] {
      let r = resolve(bad, &none(), MAC);
      assert_eq!(r.new_note_shortcut, "Shift+Cmd+N", "{bad}");
      assert_eq!(r.repaired, vec!["new_note_shortcut"], "{bad}");
    }
  }

  #[test]
  fn a_global_key_and_an_override_that_share_a_key_keep_only_the_global() {
    let r = resolve(
      "Ctrl+Alt+K",
      &map(&[("menu.workspace", "Ctrl+Alt+K")]),
      OTHER,
    );
    assert_eq!(r.new_note_shortcut, "Ctrl+Alt+K");
    assert_eq!(r.repaired, vec!["shortcut_overrides.menu.workspace"]);
    assert_eq!(
      r.accel("menu.workspace")
        .map(|a| a.canonical(OTHER))
        .as_deref(),
      Some("Ctrl+Shift+E")
    );
  }

  #[test]
  fn a_cleared_row_stays_unset_without_a_repair_and_frees_its_key() {
    let r = resolve(
      &default_canonical(GLOBAL_STICKY_ID, OTHER),
      &map(&[("editor.indent", "")]),
      OTHER,
    );
    assert!(r.repaired.is_empty());
    assert_eq!(r.accel("editor.indent"), None);
    assert_eq!(
      r.overrides.get("editor.indent").map(String::as_str),
      Some("")
    );
    // Another row may now take the freed default.
    assert!(plan_set(&r, "editor.outdent", Some("Ctrl+]"), OTHER).is_ok());
  }

  #[test]
  fn a_cleared_global_key_is_not_a_repair() {
    let r = resolve("", &none(), MAC);
    assert!(r.repaired.is_empty());
    assert_eq!(r.new_note_shortcut, "");
    assert_eq!(r.accel(GLOBAL_STICKY_ID), None);
  }

  #[test]
  fn legacy_spellings_are_not_repairs_and_come_back_canonical() {
    let r = resolve(
      "CmdOrCtrl+Alt+M",
      &map(&[("editor.fold", "CmdOrCtrl+Alt+K")]),
      MAC,
    );
    assert!(r.repaired.is_empty());
    assert_eq!(r.new_note_shortcut, "Alt+Cmd+M");
    assert_eq!(
      r.overrides.get("editor.fold").map(String::as_str),
      Some("Alt+Cmd+K")
    );
  }

  #[test]
  fn resolution_is_a_fixed_point() {
    let messy = map(&[
      ("editor.fold", "CmdOrCtrl+Alt+K"),
      ("editor.unfold", "CmdOrCtrl+Alt+K"),
      ("editor.indent", "nonsense"),
      ("editor.outdent", ""),
      ("nope", "Ctrl+A"),
      ("window.next-tab", "Ctrl+Shift+Tab"),
    ]);
    for platform in [MAC, OTHER] {
      let first = resolve("Cmd+S", &messy, platform);
      assert!(!first.repaired.is_empty());
      let second = resolve(&first.new_note_shortcut, &first.overrides, platform);
      assert!(second.repaired.is_empty(), "{:?}", second.repaired);
      assert_eq!(second.overrides, first.overrides);
      assert_eq!(second.new_note_shortcut, first.new_note_shortcut);
      assert_eq!(second.accels, first.accels);
    }
  }
  // ---- set / reset ------------------------------------------------------

  #[test]
  fn set_shortcut_refuses_fixed_and_unknown_rows() {
    let r = defaults(MAC);
    assert_eq!(
      plan_set(&r, "menu.save", Some("Cmd+Alt+S"), MAC),
      Err(SetError::Fixed)
    );
    assert_eq!(
      plan_set(&r, "menu.minimize", None, MAC),
      Err(SetError::Fixed)
    );
    assert_eq!(
      plan_set(&r, "nope", Some("Cmd+Alt+S"), MAC),
      Err(SetError::UnknownId)
    );
    assert_eq!(plan_reset(&r, "menu.save", MAC), Err(SetError::Fixed));
  }

  #[test]
  fn set_shortcut_names_the_row_that_holds_the_key() {
    let r = defaults(MAC);
    assert_eq!(
      plan_set(&r, "editor.fold", Some("Cmd+Shift+G"), MAC),
      Err(SetError::Conflict("menu.find-prev".to_string()))
    );
    assert_eq!(
      plan_set(&r, "editor.fold", Some("Alt+Cmd+G"), MAC),
      Err(SetError::Conflict("goto-line".to_string()))
    );
    assert_eq!(
      plan_set(&r, "menu.workspace", Some("Cmd+D"), MAC),
      Err(SetError::Conflict("editor.add-next-occurrence".to_string()))
    );
    assert_eq!(
      plan_set(&r, "window.next-tab", Some("Ctrl+B"), MAC),
      Err(SetError::Conflict("fixed.emacs-char-left".to_string()))
    );
    assert_eq!(
      SetError::Conflict("goto-line".to_string()).code(),
      "conflict:goto-line"
    );
  }

  #[test]
  fn set_shortcut_checks_the_global_row_like_every_other() {
    let r = defaults(OTHER);
    assert_eq!(
      plan_set(&r, GLOBAL_STICKY_ID, Some("Ctrl+S"), OTHER),
      Err(SetError::Conflict("menu.save".to_string()))
    );
    assert_eq!(
      plan_set(&r, GLOBAL_STICKY_ID, Some("N"), OTHER),
      Err(SetError::NeedsModifier)
    );
    let next = plan_set(&r, GLOBAL_STICKY_ID, Some("CmdOrCtrl+Alt+M"), OTHER).unwrap();
    assert_eq!(next.new_note_shortcut, "Ctrl+Alt+M");
    assert!(next.overrides.is_empty());
    let cleared = plan_set(&r, GLOBAL_STICKY_ID, None, OTHER).unwrap();
    assert_eq!(cleared.new_note_shortcut, "");
  }

  #[test]
  fn set_shortcut_enforces_the_mac_option_rule_for_editor_rows() {
    let r = defaults(MAC);
    for typed in ["Alt+J", "Alt+Shift+J", "Alt+1", "Alt+Space", "Alt+["] {
      assert_eq!(
        plan_set(&r, "editor.fold", Some(typed), MAC),
        Err(SetError::MacOption),
        "{typed}"
      );
    }
    for fine in [
      "Alt+ArrowUp",
      "Alt+Cmd+J",
      "Ctrl+Alt+J",
      "Alt+F5",
      "Alt+Enter",
    ] {
      let result = plan_set(&r, "editor.fold", Some(fine), MAC);
      assert!(
        !matches!(result, Err(SetError::MacOption)),
        "{fine}: {result:?}"
      );
    }
    // Non-editor rows are not subject to it, and neither is Windows.
    assert!(plan_set(&r, "menu.workspace", Some("Alt+J"), MAC).is_ok());
    assert!(plan_set(&defaults(OTHER), "editor.fold", Some("Alt+J"), OTHER).is_ok());
    // goto-line is also an editor row.
    assert_eq!(
      plan_set(&r, "goto-line", Some("Alt+J"), MAC),
      Err(SetError::MacOption)
    );
  }

  #[test]
  fn set_shortcut_rejects_combinations_the_handler_cannot_receive_off_mac() {
    let r = defaults(OTHER);
    // Editor scope: CodeMirror reads Ctrl+Alt as AltGr and the shifted
    // character never equals the bound digit or punctuation key.
    for bad in [
      "Ctrl+Alt+Shift+1",
      "Ctrl+Alt+Shift+[",
      "Ctrl+Alt+Shift+Win+0",
    ] {
      assert_eq!(
        plan_set(&r, "editor.fold", Some(bad), OTHER),
        Err(SetError::Unreachable),
        "{bad}"
      );
      assert_eq!(
        plan_set(&r, "goto-line", Some(bad), OTHER),
        Err(SetError::Unreachable),
        "goto-line {bad}"
      );
    }
    // Window scope reads digits off the physical key, so only punctuation
    // is lost there.
    assert_eq!(
      plan_set(&r, "window.next-tab", Some("Ctrl+Alt+Shift+["), OTHER),
      Err(SetError::Unreachable)
    );
    assert!(plan_set(&r, "window.next-tab", Some("Ctrl+Alt+Shift+1"), OTHER).is_ok());
    // Menu and global scopes are not affected.
    for ok_row in ["menu.workspace", GLOBAL_STICKY_ID] {
      for fine in ["Ctrl+Alt+Shift+1", "Ctrl+Alt+Shift+["] {
        assert!(
          plan_set(&r, ok_row, Some(fine), OTHER).is_ok(),
          "{ok_row} {fine}"
        );
      }
    }
    // Combinations that do fire stay allowed in the editor.
    for fine in [
      "Ctrl+Alt+1",
      "Ctrl+Alt+;",
      "Ctrl+Shift+1",
      "Alt+Shift+1",
      "Ctrl+Alt+Shift+K",
      "Ctrl+Alt+Shift+F5",
      "Ctrl+Alt+Shift+ArrowUp",
      "Ctrl+Alt+Shift+Space",
    ] {
      assert!(
        plan_set(&r, "editor.fold", Some(fine), OTHER).is_ok(),
        "{fine}"
      );
    }
    // macOS has no AltGr rule.
    assert!(plan_set(&defaults(MAC), "editor.fold", Some("Ctrl+Alt+Shift+1"), MAC).is_ok());
    assert_eq!(SetError::Unreachable.code(), "unreachable");
  }

  #[test]
  fn numpad_keys_are_refused_for_every_row_but_the_global_key() {
    for platform in [OTHER, MAC] {
      let r = defaults(platform);
      for row in ["editor.fold", "menu.workspace", "window.next-tab"] {
        assert_eq!(
          plan_set(&r, row, Some("Ctrl+Numpad1"), platform),
          Err(SetError::NumpadKey),
          "{row}"
        );
      }
      let global = plan_set(&r, GLOBAL_STICKY_ID, Some("Ctrl+Alt+Numpad1"), platform).unwrap();
      assert_eq!(global.new_note_shortcut, "Ctrl+Alt+Numpad1");
    }
    assert_eq!(SetError::NumpadKey.code(), "unsupported-key");
  }

  #[test]
  fn stored_numpad_overrides_are_repaired_but_the_global_numpad_key_is_kept() {
    for platform in [OTHER, MAC] {
      let r = resolve(
        "Ctrl+Alt+Numpad1",
        &map(&[
          ("editor.fold", "Ctrl+Numpad1"),
          ("menu.workspace", "Ctrl+Numpad1"),
        ]),
        platform,
      );
      assert!(r.overrides.is_empty());
      assert_eq!(
        r.repaired,
        vec![
          "shortcut_overrides.menu.workspace",
          "shortcut_overrides.editor.fold"
        ]
      );
      assert_eq!(r.new_note_shortcut, "Ctrl+Alt+Numpad1");
    }
  }

  #[test]
  fn unreachable_stored_overrides_are_repaired_off_mac() {
    let r = resolve(
      "",
      &map(&[
        ("editor.fold", "Ctrl+Alt+Shift+1"),
        ("window.next-tab", "Ctrl+Alt+Shift+,"),
        ("window.prev-tab", "Ctrl+Alt+Shift+2"),
        ("menu.workspace", "Ctrl+Alt+Shift+3"),
      ]),
      OTHER,
    );
    assert_eq!(
      r.repaired,
      vec![
        "shortcut_overrides.window.next-tab",
        "shortcut_overrides.editor.fold"
      ]
    );
    assert!(r.overrides.contains_key("window.prev-tab"));
    assert!(r.overrides.contains_key("menu.workspace"));
  }

  #[test]
  fn keys_the_global_shortcut_parser_accepts_survive_normalization() {
    // Every key global-hotkey 0.8.0 spells without a character, as an old
    // stored global shortcut may hold it.
    let named = [
      "Insert",
      "Pause",
      "CapsLock",
      "PrintScreen",
      "ScrollLock",
      "NumLock",
      "Numpad0",
      "Numpad9",
      "NumpadAdd",
      "NumpadDecimal",
      "NumpadDivide",
      "NumpadEnter",
      "NumpadEqual",
      "NumpadMultiply",
      "NumpadSubtract",
      "AudioVolumeDown",
      "AudioVolumeUp",
      "AudioVolumeMute",
      "MediaPlay",
      "MediaPause",
      "MediaPlayPause",
      "MediaStop",
      "MediaTrackNext",
      "MediaTrackPrevious",
    ];
    for platform in [MAC, OTHER] {
      for key in named {
        let stored = format!("Ctrl+Shift+{key}");
        assert!(
          crate::shortcut::parse_accelerator(&stored).is_ok(),
          "{stored}"
        );
        let r = resolve(&stored, &none(), platform);
        assert!(r.repaired.is_empty(), "{stored}: {:?}", r.repaired);
        let accel = normalize(&stored, platform).unwrap();
        assert_eq!(accel.canonical(platform), stored);
        let tauri = accel.to_tauri();
        assert!(
          crate::shortcut::parse_accelerator(&tauri).is_ok(),
          "{tauri}"
        );
      }
    }
    assert_eq!(canon("Super+insert", OTHER), "Win+Insert");
    assert_eq!(canon("Ctrl+NumPlus", OTHER), "Ctrl+NumpadAdd");
    assert_eq!(canon("Ctrl+VolumeUp", OTHER), "Ctrl+AudioVolumeUp");
    assert_eq!(canon("Ctrl+PauseBreak", OTHER), "Ctrl+Pause");
  }

  #[test]
  fn spelled_out_keys_normalize_to_the_character() {
    assert_eq!(canon("Ctrl+KeyN", OTHER), "Ctrl+N");
    assert_eq!(canon("Ctrl+Digit5", OTHER), "Ctrl+5");
    assert_eq!(canon("Ctrl+Comma", OTHER), "Ctrl+,");
    assert_eq!(canon("Ctrl+BracketLeft", OTHER), "Ctrl+[");
    assert_eq!(canon("Ctrl+Backslash", OTHER), "Ctrl+\\");
    let r = resolve("Ctrl+Shift+KeyN", &none(), OTHER);
    assert!(r.repaired.is_empty());
    assert_eq!(r.new_note_shortcut, "Ctrl+Shift+N");
  }

  #[test]
  fn set_shortcut_rejects_tab_and_shift_tab_on_both_platforms() {
    for os in [MAC, OTHER] {
      let r = defaults(os);
      for bad in ["Tab", "Shift+Tab"] {
        assert_eq!(
          plan_set(&r, "editor.indent", Some(bad), os),
          Err(SetError::NeedsModifier),
          "{bad}"
        );
      }
    }
  }

  #[test]
  fn set_shortcut_rejects_a_key_with_no_required_modifier() {
    let r = defaults(OTHER);
    for bad in ["Shift+A", "A", "Enter", "Shift+F5"] {
      assert_eq!(
        plan_set(&r, "editor.fold", Some(bad), OTHER),
        Err(SetError::NeedsModifier),
        "{bad}"
      );
    }
    assert!(plan_set(&r, "editor.fold", Some("F5"), OTHER).is_ok());
    assert!(matches!(
      plan_set(&r, "editor.fold", Some("???"), OTHER),
      Err(SetError::Invalid(_))
    ));
  }

  #[test]
  fn set_then_reset_round_trips_through_the_stored_state() {
    let r = defaults(OTHER);
    let moved = plan_set(&r, "editor.fold", Some("Ctrl+Alt+K"), OTHER).unwrap();
    assert_eq!(
      moved.overrides.get("editor.fold").map(String::as_str),
      Some("Ctrl+Alt+K")
    );
    let r2 = resolve(&moved.new_note_shortcut, &moved.overrides, OTHER);
    assert_eq!(
      r2.accel("editor.fold")
        .map(|a| a.canonical(OTHER))
        .as_deref(),
      Some("Ctrl+Alt+K")
    );
    let back = plan_reset(&r2, "editor.fold", OTHER).unwrap();
    assert!(back.overrides.is_empty());
    let cleared = plan_set(&r2, "editor.fold", None, OTHER).unwrap();
    assert_eq!(
      cleared.overrides.get("editor.fold").map(String::as_str),
      Some("")
    );
  }

  #[test]
  fn reset_is_refused_while_another_row_holds_the_default() {
    let r = resolve("", &map(&[("editor.unfold", "Ctrl+Shift+[")]), OTHER);
    assert_eq!(
      plan_reset(&r, "editor.fold", OTHER),
      Err(SetError::Conflict("editor.unfold".to_string()))
    );
    // A row whose default is empty always resets.
    assert!(plan_reset(&r, "editor.select-to-bracket", OTHER).is_ok());
  }

  #[test]
  fn reset_all_clears_every_override_and_restores_the_global_default() {
    let next = plan_reset_all(MAC);
    assert!(next.overrides.is_empty());
    assert_eq!(next.new_note_shortcut, "Shift+Cmd+N");
    let r = resolve(&next.new_note_shortcut, &next.overrides, MAC);
    assert!(r.repaired.is_empty());
  }
  // ---- list handed to the frontend --------------------------------------

  #[test]
  fn the_list_carries_effective_and_default_keys() {
    let r = resolve("", &map(&[("editor.fold", "Ctrl+Alt+K")]), OTHER);
    let rows = shortcut_rows(&r, i18n::Locale::En, OTHER);
    assert_eq!(rows.iter().filter(|row| !row.other).count(), ROWS.len());
    let fold = rows.iter().find(|row| row.id == "editor.fold").unwrap();
    assert_eq!(fold.accelerator, "Ctrl+Alt+K");
    assert_eq!(fold.default, "Ctrl+Shift+[");
    assert!(fold.customizable);
    assert_eq!(fold.label, "Fold");
    assert_eq!(fold.scopes, vec!["editor"]);
    assert_eq!(fold.keys, vec!["Ctrl+Alt+K"]);
    let global = rows.iter().find(|row| row.id == GLOBAL_STICKY_ID).unwrap();
    assert_eq!(global.scopes, vec!["global"]);
    let save = rows.iter().find(|row| row.id == "menu.save").unwrap();
    assert_eq!(save.section, "File");
    assert!(!save.customizable);
    let quit = rows.iter().find(|row| row.id == "menu.quit").unwrap();
    assert_eq!(quit.section, "Note&Pad");
    let new = rows.iter().find(|row| row.id == "menu.new").unwrap();
    assert_eq!(new.label, "New Sticky / New Window");
    let zh = shortcut_rows(&r, i18n::Locale::ZhTw, OTHER);
    let new = zh.iter().find(|row| row.id == "menu.new").unwrap();
    assert_eq!(new.label, "新增便利貼／新增視窗");
  }

  #[test]
  fn names_are_distinct_within_each_section_in_every_locale() {
    use i18n::Locale::*;
    let locales = [
      ZhTw, ZhCn, Ja, En, Ru, Es, PtBr, De, Fr, Ko, Pl, Tr, It, Th, Vi,
    ];
    let r = defaults(OTHER);
    for locale in locales {
      let rows = shortcut_rows(&r, locale, OTHER);
      let mut seen: HashMap<(bool, String, String), &str> = HashMap::new();
      for row in &rows {
        assert!(!row.label.is_empty(), "{locale:?} {}", row.id);
        let slot = (row.other, row.section.clone(), row.label.clone());
        if let Some(other) = seen.insert(slot, row.id) {
          panic!(
            "{locale:?}: {} and {other} share the name {:?} in section {:?}",
            row.id, row.label, row.section
          );
        }
      }
    }
  }
  // Reads the source because the failure is a crash or a deadlock at run time,
  // with nothing to assert on. These commands rebuild native menus and, for
  // the layout lookup, call text-input-source APIs: both belong on the main
  // thread, which is where Tauri runs a command that is not `(async)`.
  #[test]
  fn the_shortcut_commands_run_on_the_main_thread() {
    const SOURCE: &str = include_str!("shortcuts.rs");
    for name in [
      "set_shortcut",
      "reset_shortcut",
      "reset_all_shortcuts",
      "layout_char_for_code",
    ] {
      let at = SOURCE
        .find(&format!("pub fn {name}("))
        .unwrap_or_else(|| panic!("{name} no longer exists"));
      let attribute = SOURCE[..at].trim_end();
      assert!(
        attribute.ends_with("#[tauri::command]"),
        "{name} must be a plain #[tauri::command], not (async)"
      );
    }
  }
  // ---- "Other fixed keys" ------------------------------------------------
  /// The confirmed "Other fixed keys" list, typed out independently of
  /// `OTHER_ROWS`: (id, macOS keys, Windows/Linux keys), keys separated by a
  /// space. `-` means the row does not exist on that platform; empty means it
  /// has no key of its own.
  const EXPECTED_OTHER: &[(&str, &str, &str)] = &[
    ("other.cursor-left", "ArrowLeft", "ArrowLeft"),
    ("other.cursor-right", "ArrowRight", "ArrowRight"),
    ("other.cursor-up", "ArrowUp", "ArrowUp"),
    ("other.cursor-down", "ArrowDown", "ArrowDown"),
    ("other.word-left", "Alt+ArrowLeft", "Ctrl+ArrowLeft"),
    ("other.word-right", "Alt+ArrowRight", "Ctrl+ArrowRight"),
    ("other.syntax-left", "Ctrl+ArrowLeft", "Alt+ArrowLeft"),
    ("other.syntax-right", "Ctrl+ArrowRight", "Alt+ArrowRight"),
    ("other.line-start", "Home Cmd+ArrowLeft", "Home"),
    ("other.line-end", "End Cmd+ArrowRight", "End"),
    ("other.page-up", "PageUp Ctrl+ArrowUp", "PageUp"),
    ("other.page-down", "PageDown Ctrl+ArrowDown", "PageDown"),
    ("other.doc-start", "Cmd+ArrowUp Cmd+Home", "Ctrl+Home"),
    ("other.doc-end", "Cmd+ArrowDown Cmd+End", "Ctrl+End"),
    ("other.add-shift", "", ""),
    ("other.new-line", "Enter", "Enter"),
    ("other.delete-left", "Backspace", "Backspace"),
    ("other.delete-right", "Delete", "Delete"),
    ("other.delete-word-left", "Alt+Backspace", "Ctrl+Backspace"),
    ("other.delete-word-right", "Alt+Delete", "Ctrl+Delete"),
    ("other.delete-to-start", "Cmd+Backspace", "-"),
    ("other.delete-to-end", "Cmd+Delete", "-"),
    ("other.find-next", "F3", "F3"),
    ("other.redo-large", "-", "Ctrl+Shift+Z"),
    ("emacs.cursor-left", "Ctrl+B", "-"),
    ("emacs.cursor-right", "Ctrl+F", "-"),
    ("emacs.cursor-up", "Ctrl+P", "-"),
    ("emacs.cursor-down", "Ctrl+N", "-"),
    ("emacs.line-start", "Ctrl+A", "-"),
    ("emacs.line-end", "Ctrl+E", "-"),
    ("emacs.delete-right", "Ctrl+D", "-"),
    ("emacs.delete-left", "Ctrl+H", "-"),
    ("emacs.delete-to-end", "Ctrl+K", "-"),
    ("emacs.delete-word-left", "Ctrl+Alt+H", "-"),
    ("emacs.split-line", "Ctrl+O", "-"),
    ("emacs.transpose", "Ctrl+T", "-"),
    ("emacs.page-down", "Ctrl+V", "-"),
  ];

  #[test]
  fn the_other_rows_are_the_confirmed_list_on_each_platform() {
    for (platform, index) in [(MAC, 1), (OTHER, 2)] {
      let rows = shortcut_rows(&defaults(platform), i18n::Locale::En, platform);
      let got: Vec<(&str, String)> = rows
        .iter()
        .filter(|row| row.other)
        .map(|row| (row.id, row.keys.join(" ")))
        .collect();
      let want: Vec<(&str, String)> = EXPECTED_OTHER
        .iter()
        .filter_map(|entry| {
          let keys = if index == 1 { entry.1 } else { entry.2 };
          (keys != "-").then(|| (entry.0, keys.to_string()))
        })
        .collect();
      assert_eq!(got, want, "{platform:?}");
      // Read-only: no effective key of their own, never customizable.
      assert!(rows
        .iter()
        .filter(|row| row.other)
        .all(|row| !row.customizable && row.accelerator.is_empty()));
    }
  }

  #[test]
  fn the_other_rows_follow_the_confirmed_headings_and_names() {
    let rows = shortcut_rows(&defaults(MAC), i18n::Locale::En, MAC);
    let name = |id: &str| {
      let row = rows.iter().find(|row| row.id == id).unwrap();
      (row.section.clone(), row.label.clone(), row.heading)
    };
    assert_eq!(
      name("other.doc-start"),
      (
        "Cursor Movement".to_string(),
        "Cursor Document Start".to_string(),
        "cursor"
      )
    );
    assert_eq!(name("emacs.transpose").0, "Emacs-style Keys");
    let zh = shortcut_rows(&defaults(MAC), i18n::Locale::ZhTw, MAC);
    let row = zh.iter().find(|row| row.id == "emacs.transpose").unwrap();
    assert_eq!(row.label, "調換字母");
    assert_eq!(row.section, "Emacs 式按鍵");
    let ja = shortcut_rows(&defaults(MAC), i18n::Locale::Ja, MAC);
    let row = ja.iter().find(|row| row.id == "other.add-shift").unwrap();
    assert_eq!(row.label, "⇧ を加えると選択");
  }

  #[test]
  fn every_row_and_heading_has_a_name_in_all_fifteen_locales() {
    use i18n::Locale::*;
    let locales = [
      ZhTw, ZhCn, Ja, En, Ru, Es, PtBr, De, Fr, Ko, Pl, Tr, It, Th, Vi,
    ];
    for locale in locales {
      for platform in [MAC, OTHER] {
        for row in shortcut_rows(&defaults(platform), locale, platform) {
          assert!(!row.label.trim().is_empty(), "{locale:?} {} label", row.id);
          assert!(
            !row.section.trim().is_empty(),
            "{locale:?} {} section",
            row.id
          );
        }
      }
    }
  }

  #[test]
  fn every_conflict_capable_id_resolves_to_exactly_one_row() {
    for platform in [MAC, OTHER] {
      let rows = shortcut_rows(&defaults(platform), i18n::Locale::En, platform);
      let mut ids: Vec<&str> = ROWS.iter().map(|row| row.id).collect();
      ids.extend(reserved_accels(platform).iter().map(|(id, _)| *id));
      ids.sort_unstable();
      ids.dedup();
      for id in ids {
        let owners: Vec<&ShortcutRow> = rows
          .iter()
          .filter(|row| row.id == id || row.alias_ids.contains(&id))
          .collect();
        assert_eq!(
          owners.len(),
          1,
          "{platform:?}: {id} has {} rows",
          owners.len()
        );
        assert!(!owners[0].label.is_empty(), "{platform:?}: {id}");
      }
    }
  }

  #[test]
  fn merged_rows_carry_every_reserved_id_they_show() {
    let rows = shortcut_rows(&defaults(MAC), i18n::Locale::En, MAC);
    let owner = |id: &str| {
      rows
        .iter()
        .find(|row| row.id == id || row.alias_ids.contains(&id))
        .map(|row| row.id)
    };
    assert_eq!(owner("fixed.doc-start-home"), Some("other.doc-start"));
    assert_eq!(owner("fixed.doc-start-arrow"), Some("other.doc-start"));
    assert_eq!(owner("fixed.line-boundary-left"), Some("other.line-start"));
    assert_eq!(owner("fixed.page-up-arrow"), Some("other.page-up"));
    assert_eq!(
      owner("fixed.emacs-delete-group"),
      Some("emacs.delete-word-left")
    );
    let merged = rows.iter().find(|row| row.id == "other.doc-start").unwrap();
    assert_eq!(
      merged.alias_ids,
      vec!["fixed.doc-start-arrow", "fixed.doc-start-home"]
    );
    // A platform without the key does not list its id.
    let other = shortcut_rows(&defaults(OTHER), i18n::Locale::En, OTHER);
    let merged = other
      .iter()
      .find(|row| row.id == "other.doc-start")
      .unwrap();
    assert_eq!(merged.alias_ids, vec!["fixed.doc-start-home"]);
  }

  #[test]
  fn a_refused_global_registration_carries_its_stable_code() {
    assert_eq!(
      global_register_error("already registered"),
      "global-register:already registered"
    );
    // `register_global` must route the plugin's error through it.
    let at = include_str!("shortcuts.rs")
      .find("fn register_global")
      .unwrap();
    let body = &include_str!("shortcuts.rs")[at..at + 400];
    assert!(body.contains(".map_err(global_register_error)"));
  }

  #[test]
  fn the_shortcuts_overview_window_is_gone() {
    let removed = [
      ["show", "_shortcuts"].concat(),
      ["help-keyboard", "-shortcuts"].concat(),
      ["mode=", "shortcuts"].concat(),
      ["Keyboard", "Shortcuts"].concat(),
      ["\"short", "cuts\""].concat(),
    ];
    for (file, source) in [
      ("lib.rs", include_str!("lib.rs")),
      ("windows.rs", include_str!("windows.rs")),
      ("i18n.rs", include_str!("i18n.rs")),
      (
        "capabilities/default.json",
        include_str!("../capabilities/default.json"),
      ),
    ] {
      for needle in &removed {
        assert!(
          !source.contains(needle.as_str()),
          "{file} still has {needle}"
        );
      }
    }
  }
  // ---- keyboard layout lookup -------------------------------------------

  #[test]
  fn layout_lookup_maps_letter_codes_to_mac_key_codes() {
    assert_eq!(mac_letter_keycode("KeyA"), Some(0x00));
    assert_eq!(mac_letter_keycode("KeyQ"), Some(0x0C));
    assert_eq!(mac_letter_keycode("KeyM"), Some(0x2E));
    let mut seen = Vec::new();
    for c in 'A'..='Z' {
      let code = mac_letter_keycode(&format!("Key{c}")).unwrap_or_else(|| panic!("Key{c}"));
      assert!(!seen.contains(&code), "Key{c} repeats a key code");
      seen.push(code);
    }
    for not_a_letter in ["Digit1", "BracketLeft", "Space", "ArrowUp", "KeyÄ", ""] {
      assert_eq!(mac_letter_keycode(not_a_letter), None, "{not_a_letter}");
    }
  }

  #[test]
  fn layout_lookup_only_accepts_a_single_ascii_letter() {
    let utf16 = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    assert_eq!(ascii_letter_of(&utf16("a")).as_deref(), Some("a"));
    assert_eq!(ascii_letter_of(&utf16("Q")).as_deref(), Some("q"));
    for failure in ["", "ф", "1", "é", "´", "ab", " "] {
      assert_eq!(ascii_letter_of(&utf16(failure)), None, "{failure:?}");
    }
    assert_eq!(ascii_letter_of(&[]), None);
  }
}
