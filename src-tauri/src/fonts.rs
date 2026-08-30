// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use std::collections::BTreeSet;

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
  use super::{authoritative_families, parse_fc_list};

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
}
