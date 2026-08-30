// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Pure label/reference rules shared by the macOS Dock menu (`dock.rs`) and the
// Windows Jump List (`jumplist.rs`). Split out of `dock.rs` so the Windows-only
// module can reuse them without depending on a macOS-only module, and so the
// two menus never drift into different label rules.

/// Max characters kept from a sticky's first line in its menu label. Longer
/// lines are cut here and marked with a trailing ellipsis to bound menu width.
/// Both consumers are platform-gated, so on any other target this really is
/// unused; the exemption is conditional rather than blanket so a future item
/// that is dead everywhere still gets reported.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
const STICKY_LABEL_MAX: usize = 40;

/// Derive a sticky's menu label from its content: the first non-blank line,
/// trimmed and cut to `STICKY_LABEL_MAX` characters (counted by char, never
/// splitting a multi-byte character). A wholly blank sticky uses `blank`.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub fn sticky_label(content: &str, blank: &str) -> String {
  let first = content.trim_start().lines().next().unwrap_or("").trim();
  if first.is_empty() {
    return blank.to_string();
  }
  if first.chars().count() > STICKY_LABEL_MAX {
    let cut: String = first.chars().take(STICKY_LABEL_MAX).collect();
    format!("{cut}…")
  } else {
    first.to_string()
  }
}

/// Encode a document tab reference (group + tab index) for a Dock menu item's
/// represented object. The group is a UUID, so a tab separator is unambiguous.
// Used by dock.rs on macOS only; the Windows Jump List passes group and tab
// index as separate argv tokens instead, so this is unused elsewhere.
#[allow(dead_code)]
pub fn doc_ref(group: &str, tab_index: i64) -> String {
  format!("{group}\t{tab_index}")
}

/// Parse a `doc_ref` string back into its group and tab index.
#[allow(dead_code)]
pub fn parse_doc_ref(s: &str) -> Option<(String, i64)> {
  let (group, idx) = s.split_once('\t')?;
  Some((group.to_string(), idx.parse().ok()?))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn label_uses_first_nonblank_line_trimmed() {
    assert_eq!(
      sticky_label("  hello world  \nsecond", "BLANK"),
      "hello world"
    );
  }

  #[test]
  fn label_skips_leading_blank_lines() {
    assert_eq!(sticky_label("\n\n  title\nbody", "BLANK"), "title");
  }

  #[test]
  fn label_blank_content_uses_fallback() {
    assert_eq!(sticky_label("   \n\t\n", "BLANK"), "BLANK");
    assert_eq!(sticky_label("", "BLANK"), "BLANK");
  }

  #[test]
  fn label_truncates_long_first_line_with_ellipsis() {
    let line = "x".repeat(50);
    let out = sticky_label(&line, "BLANK");
    assert_eq!(out.chars().count(), STICKY_LABEL_MAX + 1);
    assert!(out.ends_with('…'));
  }

  #[test]
  fn label_counts_chars_not_bytes() {
    // Multi-byte characters must be cut on a char boundary, counted by char.
    let line = "あ".repeat(50);
    let out = sticky_label(&line, "BLANK");
    assert_eq!(out.chars().count(), STICKY_LABEL_MAX + 1);
    assert!(out.ends_with('…'));
  }

  #[test]
  fn doc_ref_roundtrips() {
    assert_eq!(
      parse_doc_ref(&doc_ref("group-uuid", 7)),
      Some(("group-uuid".to_string(), 7))
    );
    assert_eq!(parse_doc_ref("no-separator"), None);
  }
}
