// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// One third-party package's attribution entry, as emitted by
/// `scripts/gen-licenses.mjs` into `resources/licenses.json`. `texts` holds
/// indices into `LicenseIndex::texts` rather than the text itself, since many
/// packages share an identical licence text (e.g. every MIT crate with no
/// copyright-holder-specific wording).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LicensedPackage {
  pub name: String,
  pub version: String,
  pub ecosystem: String,
  pub license: String,
  #[serde(default)]
  pub repository: String,
  #[serde(default)]
  pub authors: Vec<String>,
  pub texts: Vec<usize>,
}

/// The full attribution index: a deduplicated pool of licence texts, plus
/// every shipped package pointing into it by index.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LicenseIndex {
  pub texts: Vec<String>,
  pub packages: Vec<LicensedPackage>,
}

/// Parse `resources/licenses.json`'s text as a `LicenseIndex`.
fn parse(text: &str) -> Result<LicenseIndex, String> {
  serde_json::from_str(text).map_err(|e| e.to_string())
}

/// Every `texts` index must point at a real slot, and every package must
/// carry at least one licence text (the property the generator promises —
/// see `scripts/gen-licenses.mjs`'s "fail loudly" step).
pub fn validate(index: &LicenseIndex) -> Result<(), String> {
  for pkg in &index.packages {
    if pkg.texts.is_empty() {
      return Err(format!(
        "package {}@{} has no licence texts",
        pkg.name, pkg.version
      ));
    }
    for &i in &pkg.texts {
      if i >= index.texts.len() {
        return Err(format!(
          "package {}@{} has out-of-range texts index {i} (only {} texts)",
          pkg.name,
          pkg.version,
          index.texts.len()
        ));
      }
    }
  }
  Ok(())
}

/// Parse and validate the licence index at `path`.
fn load_from(path: &Path) -> Result<LicenseIndex, String> {
  let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
  let index = parse(&text)?;
  validate(&index)?;
  Ok(index)
}

/// Absolute path of the bundled `licenses.json` resource (see
/// `tauri.conf.json`'s `bundle.resources` mapping).
fn resource_licenses_file(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(
    app
      .path()
      .resource_dir()
      .map_err(|e| e.to_string())?
      .join("licenses.json"),
  )
}

/// The acknowledgements data, read once by the Acknowledgements window.
#[tauri::command]
pub fn list_acknowledgements(app: AppHandle) -> Result<LicenseIndex, String> {
  load_from(&resource_licenses_file(&app)?)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fixture() -> LicenseIndex {
    LicenseIndex {
      texts: vec!["MIT text".to_string(), "Apache text".to_string()],
      packages: vec![
        LicensedPackage {
          name: "foo".to_string(),
          version: "1.0.0".to_string(),
          ecosystem: "cargo".to_string(),
          license: "MIT".to_string(),
          repository: String::new(),
          authors: vec![],
          texts: vec![0],
        },
        LicensedPackage {
          name: "bar".to_string(),
          version: "2.0.0".to_string(),
          ecosystem: "npm".to_string(),
          license: "MIT OR Apache-2.0".to_string(),
          repository: "https://example.com/bar".to_string(),
          authors: vec!["Someone".to_string()],
          texts: vec![0, 1],
        },
      ],
    }
  }

  #[test]
  fn fixture_validates() {
    validate(&fixture()).unwrap();
  }

  #[test]
  fn rejects_out_of_range_index() {
    let mut index = fixture();
    index.packages[0].texts = vec![99];
    let err = validate(&index).unwrap_err();
    assert!(err.contains("out-of-range"));
  }

  #[test]
  fn rejects_package_with_no_texts() {
    let mut index = fixture();
    index.packages[0].texts = vec![];
    let err = validate(&index).unwrap_err();
    assert!(err.contains("no licence texts"));
  }

  #[test]
  fn parses_minimal_json() {
    let json = r#"{"texts":["t"],"packages":[{"name":"n","version":"1","ecosystem":"cargo","license":"MIT","texts":[0]}]}"#;
    let index = parse(json).unwrap();
    assert_eq!(index.packages[0].repository, "");
    assert!(index.packages[0].authors.is_empty());
  }

  #[test]
  fn rejects_missing_required_field() {
    let json =
      r#"{"texts":["t"],"packages":[{"name":"n","version":"1","ecosystem":"cargo","texts":[0]}]}"#;
    assert!(parse(json).is_err());
  }

  /// The real committed resource must parse and validate without any test-only massaging.
  #[test]
  fn real_committed_licenses_json_parses_and_validates() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/licenses.json");
    let index = load_from(&path).unwrap();
    assert!(!index.packages.is_empty());
    assert!(!index.texts.is_empty());
  }

  #[test]
  fn every_package_in_real_file_has_at_least_one_text() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/licenses.json");
    let text = std::fs::read_to_string(&path).unwrap();
    let index = parse(&text).unwrap();
    for pkg in &index.packages {
      assert!(
        !pkg.texts.is_empty(),
        "{}@{} has zero licence texts",
        pkg.name,
        pkg.version
      );
    }
  }

  #[test]
  fn every_index_in_real_file_is_in_range() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/licenses.json");
    let text = std::fs::read_to_string(&path).unwrap();
    let index = parse(&text).unwrap();
    for pkg in &index.packages {
      for &i in &pkg.texts {
        assert!(
          i < index.texts.len(),
          "{}@{} has out-of-range index {i}",
          pkg.name,
          pkg.version
        );
      }
    }
  }
}
