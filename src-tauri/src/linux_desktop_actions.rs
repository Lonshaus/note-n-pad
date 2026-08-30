// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Guards `linux/note-n-pad.desktop.hbs`'s two Desktop Action name blocks
//! against drifting from `i18n.rs`. The template is hand-written and does not
//! regenerate itself, so this only reads it and asserts every `Name[xx]=`
//! (and the bare `Name=` for English) matches `i18n::tr()` for the same
//! locale and key — see `desktop_actions_match_i18n` below.

#[cfg(test)]
mod tests {
  use crate::i18n::{self, Key, Locale};
  use std::collections::BTreeMap;
  use std::path::Path;

  /// Every `Locale` variant paired with the `.desktop` locale tag it renders
  /// as. Most tags are the lowercase Rust variant name; `zh_TW`, `zh_CN` and
  /// `pt_BR` use the underscore-region form instead, and `en` has no `[xx]`
  /// suffix at all (it is the file's bare `Name=`).
  const LOCALE_TAGS: [(&str, Locale); 15] = [
    ("zh_TW", Locale::ZhTw),
    ("zh_CN", Locale::ZhCn),
    ("ja", Locale::Ja),
    ("en", Locale::En),
    ("ru", Locale::Ru),
    ("es", Locale::Es),
    ("pt_BR", Locale::PtBr),
    ("de", Locale::De),
    ("fr", Locale::Fr),
    ("ko", Locale::Ko),
    ("pl", Locale::Pl),
    ("tr", Locale::Tr),
    ("it", Locale::It),
    ("th", Locale::Th),
    ("vi", Locale::Vi),
  ];

  /// Parse the `Name=`/`Name[xx]=` entries out of one `[group header]` block
  /// of a `.desktop` (ini-like) file, keyed by locale tag (`"en"` for the
  /// bare `Name=`). Section-aware: lines outside `group_header`'s block, such
  /// as `[Desktop Entry]`'s own untranslated `Name=`, are ignored.
  fn parse_group_names(text: &str, group_header: &str) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    let mut in_group = false;
    for line in text.lines() {
      let line = line.trim_end();
      if line.starts_with('[') && line.ends_with(']') {
        in_group = line == group_header;
        continue;
      }
      if !in_group {
        continue;
      }
      let Some(rest) = line.strip_prefix("Name") else {
        continue;
      };
      if let Some(value) = rest.strip_prefix('=') {
        names.insert("en".to_string(), value.to_string());
      } else if let Some(rest) = rest.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
          if let Some(value) = rest[end + 1..].strip_prefix('=') {
            names.insert(rest[..end].to_string(), value.to_string());
          }
        }
      }
    }
    names
  }

  /// The names `i18n::tr` would produce for `key`, keyed the same way as
  /// `parse_group_names`, for a direct comparison.
  fn expected_names(key: Key) -> BTreeMap<String, String> {
    LOCALE_TAGS
      .iter()
      .map(|(tag, locale)| (tag.to_string(), i18n::tr(*locale, key).to_string()))
      .collect()
  }

  /// Asserts the real committed template's translations for one Desktop
  /// Action match `i18n::tr()` exactly, locale for locale. `assert_eq!` on
  /// the two maps fails on any mismatched value, any locale the template has
  /// that `i18n.rs` doesn't, and any locale `i18n.rs` has that the template
  /// is missing.
  #[test]
  fn desktop_actions_match_i18n() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("linux/note-n-pad.desktop.hbs");
    let text = std::fs::read_to_string(&path).unwrap();

    assert_eq!(
      parse_group_names(&text, "[Desktop Action NewSticky]"),
      expected_names(Key::NewSticky),
      "NewSticky action names in note-n-pad.desktop.hbs are out of sync with i18n::tr(Key::NewSticky)"
    );
    assert_eq!(
      parse_group_names(&text, "[Desktop Action OpenWorkspace]"),
      expected_names(Key::DockOpenWorkspace),
      "OpenWorkspace action names in note-n-pad.desktop.hbs are out of sync with i18n::tr(Key::DockOpenWorkspace)"
    );
  }
}
