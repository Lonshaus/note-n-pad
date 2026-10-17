// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use std::collections::BTreeSet;
/// The monospace faces the font picker offers as its main rows when the host
/// has them installed. Mirrors `FONT_CANDIDATES` in `src/lib/util/font.ts`
/// (the `builtin_list_matches_the_frontend_list` test keeps them in step).
pub const BUILTIN_FONT_FAMILIES: [&str; 14] = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "Cascadia Mono",
  "Cascadia Code",
  "Consolas",
  "Noto Sans Mono",
  "DejaVu Sans Mono",
  "Ubuntu Mono",
  "Liberation Mono",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "Courier New",
];

/// Parse `fc-list : family` output into a de-duplicated, sorted list of family
/// names. Each line may carry comma-separated aliases
/// (one face can be known under several names); every alias is kept as its
/// own entry, trimmed and with blanks dropped.
///
/// Only called from the Linux branch below; other platforms still compile and
/// test this pure function, hence the `dead_code` allowance there.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_fc_list(output: &str) -> Vec<String> {
  let mut families = BTreeSet::new();
  for line in output.lines() {
    for alias in line.split(',') {
      let trimmed = alias.trim();
      if !trimmed.is_empty() {
        families.insert(trimmed.to_string());
      }
    }
  }
  families.into_iter().collect()
}

/// List the font families actually installed on the host, when that can be
/// determined authoritatively. `None` means "no authoritative list" (the
/// frontend falls back to its rendered-width heuristic) — distinct from
/// `Some(vec![])`, which would wrongly claim nothing is installed.
#[tauri::command]
pub fn installed_font_families() -> Option<Vec<String>> {
  list_via_fc_list()
}
/// Every font family installed on the host, for the picker's "Choose another
/// font" list only; the main picker rows do not use it. Sorted
/// case-insensitively and de-duplicated. An empty list covers both "no
/// families" and "the host could not be asked".
///
/// A synchronous command runs on the main thread, which AppKit's font manager
/// requires.
#[tauri::command]
pub fn list_font_families() -> Vec<String> {
  normalize_families(host_families())
}
/// Trim, drop blanks, de-duplicate and sort case-insensitively (exact spelling
/// breaks ties, so the order is stable).
fn normalize_families(names: Vec<String>) -> Vec<String> {
  let mut families: Vec<String> = names
    .into_iter()
    .map(|name| name.trim().to_string())
    .filter(|name| !name.is_empty())
    .collect();
  families.sort_by(|a, b| {
    a.to_lowercase()
      .cmp(&b.to_lowercase())
      .then_with(|| a.cmp(b))
  });
  families.dedup();
  families
}
/// GDI lists a vertical-writing variant of each family under an `@`-prefixed
/// name; it is not a separate family to pick.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_vertical_family(name: &str) -> bool {
  name.starts_with('@')
}

#[cfg(target_os = "macos")]
fn host_families() -> Vec<String> {
  use objc2::MainThreadMarker;
  use objc2_app_kit::NSFontManager;
  let Some(mtm) = MainThreadMarker::new() else {
    return Vec::new();
  };
  NSFontManager::sharedFontManager(mtm)
    .availableFontFamilies()
    .iter()
    .map(|name| name.to_string())
    .collect()
}

#[cfg(target_os = "windows")]
fn host_families() -> Vec<String> {
  use windows_sys::Win32::Foundation::LPARAM;
  use windows_sys::Win32::Graphics::Gdi::{
    EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
  };

  unsafe extern "system" fn collect(
    logfont: *const LOGFONTW,
    _metric: *const TEXTMETRICW,
    _font_type: u32,
    lparam: LPARAM,
  ) -> i32 {
    // SAFETY: `lparam` is the `Vec<String>` passed to `EnumFontFamiliesExW`
    // below, alive for the whole enumeration; `logfont` is valid per GDI.
    let names = unsafe { &mut *(lparam as *mut Vec<String>) };
    let face = unsafe { &(*logfont).lfFaceName };
    let len = face.iter().position(|&c| c == 0).unwrap_or(face.len());
    names.push(String::from_utf16_lossy(&face[..len]));
    1
  }

  let mut names: Vec<String> = Vec::new();
  // SAFETY: plain GDI calls on a screen DC that is released before returning.
  unsafe {
    let hdc = GetDC(std::ptr::null_mut());
    if hdc.is_null() {
      return names;
    }
    let mut query: LOGFONTW = std::mem::zeroed();
    query.lfCharSet = DEFAULT_CHARSET;
    EnumFontFamiliesExW(
      hdc,
      &query,
      Some(collect),
      &mut names as *mut Vec<String> as LPARAM,
      0,
    );
    ReleaseDC(std::ptr::null_mut(), hdc);
  }
  names.retain(|name| !is_vertical_family(name));
  names
}

#[cfg(target_os = "linux")]
fn host_families() -> Vec<String> {
  list_via_fc_list().unwrap_or_default()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn host_families() -> Vec<String> {
  Vec::new()
}

#[cfg(target_os = "linux")]
fn list_via_fc_list() -> Option<Vec<String>> {
  let output = std::process::Command::new("fc-list")
    .args([":", "family"])
    .output()
    .ok()?;
  if !output.status.success() {
    return None;
  }
  authoritative_families(&String::from_utf8_lossy(&output.stdout))
}

/// Parsed families, or `None` when the output named none. Empty means fontconfig
/// answered with nothing useful, not that the host owns no fonts — reporting it
/// as `Some` would blank the picker instead of falling back to the heuristic.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn authoritative_families(output: &str) -> Option<Vec<String>> {
  let families = parse_fc_list(output);
  if families.is_empty() {
    return None;
  }
  Some(families)
}

#[cfg(not(target_os = "linux"))]
fn list_via_fc_list() -> Option<Vec<String>> {
  None
}

#[cfg(test)]
mod tests {
  use super::{
    authoritative_families, is_vertical_family, normalize_families, parse_fc_list,
    BUILTIN_FONT_FAMILIES,
  };

  const SAMPLE: &str = "AR PL UKai CN\n\
Bitstream Charter\n\
Courier 10 Pitch\n\
DejaVu Sans Mono\n\
Liberation Mono\n\
Nimbus Mono PS\n\
Noto Sans CJK TC,Noto Sans CJK TC Medium\n\
Noto Sans Anatolian Hieroglyphs,Noto Sans AnatoHiero\n\
Noto Serif CJK KR,Noto Serif CJK KR Black\n";

  #[test]
  fn splits_aliases_and_sorts_deduplicated() {
    let families = parse_fc_list(SAMPLE);
    assert_eq!(
      families,
      vec![
        "AR PL UKai CN",
        "Bitstream Charter",
        "Courier 10 Pitch",
        "DejaVu Sans Mono",
        "Liberation Mono",
        "Nimbus Mono PS",
        "Noto Sans AnatoHiero",
        "Noto Sans Anatolian Hieroglyphs",
        "Noto Sans CJK TC",
        "Noto Sans CJK TC Medium",
        "Noto Serif CJK KR",
        "Noto Serif CJK KR Black",
      ]
    );
  }

  #[test]
  fn ignores_blank_lines_and_trims_trailing_whitespace() {
    let families = parse_fc_list("Liberation Mono  \n\n  \nDejaVu Sans Mono\n");
    assert_eq!(families, vec!["DejaVu Sans Mono", "Liberation Mono"]);
  }

  #[test]
  fn deduplicates_a_family_repeated_across_faces() {
    let families = parse_fc_list("Liberation Mono\nLiberation Mono\nLiberation Mono\n");
    assert_eq!(families, vec!["Liberation Mono"]);
  }

  #[test]
  fn empty_input_yields_empty_list() {
    let families = parse_fc_list("");
    assert!(families.is_empty());
  }

  #[test]
  fn output_naming_no_family_is_not_authoritative() {
    assert_eq!(authoritative_families(""), None);
    assert_eq!(authoritative_families("\n  \n"), None);
  }

  #[test]
  fn output_naming_families_is_authoritative() {
    assert_eq!(
      authoritative_families("Liberation Mono\n"),
      Some(vec!["Liberation Mono".to_string()])
    );
  }

  fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn families_are_sorted_case_insensitively() {
    assert_eq!(
      normalize_families(strings(&[
        "menlo",
        "Arial",
        "courier",
        "Zapfino",
        "Apple Symbols"
      ])),
      strings(&["Apple Symbols", "Arial", "courier", "menlo", "Zapfino"])
    );
  }

  #[test]
  fn families_are_deduplicated_and_blanks_dropped() {
    assert_eq!(
      normalize_families(strings(&["Arial", " Arial ", "", "  ", "Arial", "Menlo"])),
      strings(&["Arial", "Menlo"])
    );
  }

  #[test]
  fn families_differing_only_in_case_are_both_kept_in_a_stable_order() {
    assert_eq!(
      normalize_families(strings(&["arial", "Arial"])),
      strings(&["Arial", "arial"])
    );
  }

  #[test]
  fn no_families_yield_an_empty_list() {
    assert!(normalize_families(Vec::new()).is_empty());
  }

  #[test]
  fn builtin_list_matches_the_frontend_list() {
    let ts = include_str!("../../src/lib/util/font.ts");
    let start = ts.find("FONT_CANDIDATES: readonly string[] = [").unwrap();
    let list = &ts[start..];
    let list = &list[..list.find("];").unwrap()];
    let frontend: Vec<&str> = list
      .lines()
      .skip(1)
      .map(|line| line.trim().trim_end_matches(',').trim_matches('\''))
      .collect();
    assert_eq!(frontend, BUILTIN_FONT_FAMILIES);
  }

  #[test]
  fn at_prefixed_families_are_vertical_variants() {
    assert!(is_vertical_family("@MS Gothic"));
    assert!(!is_vertical_family("MS Gothic"));
    assert!(!is_vertical_family("Foo@Bar"));
  }
}
