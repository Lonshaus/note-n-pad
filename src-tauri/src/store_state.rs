// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The in-app purchase's edition decision, and the bookkeeping that keeps a
// store read that started earlier from overwriting one that started later.
// Pure and compiled in every build so its tests run everywhere; only the
// sandboxed store build feeds it real reads, so elsewhere most of it is unused.
use std::ffi::CStr;

/// The non-consumable product that unlocks the full version.
pub const PRODUCT_ID: &str = "net.lonshaus.note.n.pad.full";

/// The last version that was sold paid. An install whose original version is
/// at most this one was bought, so it is full without the purchase.
pub const PAID_CUTOFF: &str = "1.1.3";

/// Whether the store says the product is owned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreRead {
  Owned,
  NotOwned,
  Unknown,
}

/// What the app's own signed store record says about the first install.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OriginalRead {
  /// Verified, from the production store, with the version first installed.
  VerifiedProduction(String),
  /// Verified, from a test environment.
  VerifiedOther,
  /// The record came back but its signature did not verify.
  Unverified,
  /// No record: timed out, threw, or the value was unusable.
  Unknown,
}

/// The owned read's return code.
pub fn owned_from_code(code: i32) -> StoreRead {
  match code {
    1 => StoreRead::Owned,
    0 => StoreRead::NotOwned,
    _ => StoreRead::Unknown,
  }
}

/// The NUL-terminated UTF-8 text in `buf`, or `None`.
fn text_of(buf: &[u8]) -> Option<String> {
  CStr::from_bytes_until_nul(buf)
    .ok()
    .and_then(|text| text.to_str().ok())
    .map(str::to_owned)
}

/// The original read's return code, with the version it wrote into `buf`.
pub fn original_from_code(code: i32, buf: &[u8]) -> OriginalRead {
  match code {
    1 => text_of(buf).map_or(OriginalRead::Unknown, OriginalRead::VerifiedProduction),
    3 => OriginalRead::VerifiedOther,
    0 => OriginalRead::Unverified,
    _ => OriginalRead::Unknown,
  }
}

/// The price read's return code, with the price it wrote into `buf`.
pub fn price_from_code(code: i32, buf: &[u8]) -> Option<String> {
  if code == 1 {
    text_of(buf)
  } else {
    None
  }
}

/// Whether the store answered about the original version at all. When it did
/// not, the window offers a retry instead of a purchase.
pub fn original_known(original: &OriginalRead) -> bool {
  !matches!(original, OriginalRead::Unknown)
}

/// The numeric segments of a version, or `None` if any segment is not plain
/// digits.
fn segments(version: &str) -> Option<Vec<u64>> {
  version
    .split('.')
    .map(|part| {
      if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
        None
      } else {
        part.parse().ok()
      }
    })
    .collect()
}

/// Whether `version` is at most `cutoff`, segment by segment, a missing segment
/// counting as 0. Anything that is not a plain dotted number is not.
pub fn paid_period(version: &str, cutoff: &str) -> bool {
  let (Some(version), Some(cutoff)) = (segments(version), segments(cutoff)) else {
    return false;
  };
  let len = version.len().max(cutoff.len());
  for i in 0..len {
    let v = version.get(i).copied().unwrap_or(0);
    let c = cutoff.get(i).copied().unwrap_or(0);
    if v != c {
      return v < c;
    }
  }
  true
}

/// Whether the store build is lite: full when the product is owned, or when
/// the production store says the app was first installed in the paid period.
pub fn resolve_store(owned: &StoreRead, original: &OriginalRead) -> bool {
  if *owned == StoreRead::Owned {
    return false;
  }
  if let OriginalRead::VerifiedProduction(version) = original {
    if paid_period(version, PAID_CUTOFF) {
      return false;
    }
  }
  true
}

/// The latest reads and the ticket of the read that wrote each one. A read takes
/// a ticket when it starts; a field only accepts a read that started after the
/// one it holds, whichever finishes first.
pub struct StoreState {
  owned: StoreRead,
  owned_ticket: u64,
  original: OriginalRead,
  original_ticket: u64,
  next_ticket: u64,
}

impl StoreState {
  pub const fn new() -> Self {
    Self {
      owned: StoreRead::Unknown,
      owned_ticket: 0,
      original: OriginalRead::Unknown,
      original_ticket: 0,
      next_ticket: 1,
    }
  }

  /// The ticket of a read that starts now.
  pub fn take_ticket(&mut self) -> u64 {
    let ticket = self.next_ticket;
    self.next_ticket += 1;
    ticket
  }

  /// Write each given field the read with `ticket` produced, unless a read that
  /// started later already wrote it. Returns the new lite value when a field
  /// changed.
  pub fn apply(
    &mut self,
    ticket: u64,
    owned: Option<StoreRead>,
    original: Option<OriginalRead>,
  ) -> Option<bool> {
    let mut changed = false;
    if let Some(owned) = owned {
      if ticket > self.owned_ticket {
        self.owned_ticket = ticket;
        changed |= self.owned != owned;
        self.owned = owned;
      }
    }
    if let Some(original) = original {
      if ticket > self.original_ticket {
        self.original_ticket = ticket;
        changed |= self.original != original;
        self.original = original;
      }
    }
    changed.then(|| self.lite())
  }

  pub fn lite(&self) -> bool {
    resolve_store(&self.owned, &self.original)
  }

  pub fn original(&self) -> &OriginalRead {
    &self.original
  }
}

/// The only window that may start a purchase, a restore or a retry.
pub fn store_caller_allowed(label: &str) -> bool {
  label == "edition"
}

/// Who applied a late store result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LateSource {
  /// The applier of a launch read that outlived `setup`'s wait.
  Init,
  /// A purchase, restore, retry or store update. Those never consult the
  /// token, so only the tests name it.
  #[cfg_attr(not(test), allow(dead_code))]
  Other,
}

/// Whether `source` takes the open-workspace-on-startup token: only a late
/// launch read does, whatever its result.
pub fn takes_token(source: LateSource) -> bool {
  source == LateSource::Init
}

/// Whether a late result opens the workspace the startup check skipped.
pub fn late_open(source: LateSource, took_token: bool, now_lite: bool) -> bool {
  source == LateSource::Init && took_token && !now_lite
}

/// What the edition window shows about the purchase.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfo {
  pub available: bool,
  pub price: Option<String>,
  pub original_known: bool,
}

impl StoreInfo {
  /// A build without the store.
  #[cfg_attr(all(target_os = "macos", feature = "storekit"), allow(dead_code))]
  pub fn unavailable() -> Self {
    Self {
      available: false,
      price: None,
      original_known: true,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_paid_period_ends_at_the_cutoff() {
    for version in ["1.0.1", "1.1.3", "1.0", "1", "1.1.3.0"] {
      assert!(paid_period(version, "1.1.3"), "{version}");
    }
    for version in ["1.1.4", "1.2.0", "2.0.0", "10.0", "1.1.3.1"] {
      assert!(!paid_period(version, "1.1.3"), "{version}");
    }
  }

  #[test]
  fn a_version_that_is_not_a_plain_number_is_never_paid() {
    for version in ["", "abc", "+1.0", "1..3", "1.1.3-beta", " 1.0", "1.0 "] {
      assert!(!paid_period(version, "1.1.3"), "{version:?}");
    }
    assert!(!paid_period("1.0", ""));
  }

  #[test]
  fn the_cutoff_is_the_last_version_sold_paid() {
    assert_eq!(PAID_CUTOFF, "1.1.3");
  }

  #[test]
  fn owned_codes_map_and_anything_else_is_unknown() {
    assert_eq!(owned_from_code(1), StoreRead::Owned);
    assert_eq!(owned_from_code(0), StoreRead::NotOwned);
    for code in [-1, -2, -3, 2, 3] {
      assert_eq!(owned_from_code(code), StoreRead::Unknown, "{code}");
    }
  }

  #[test]
  fn original_codes_map_and_anything_else_is_unknown() {
    assert_eq!(
      original_from_code(1, b"1.0.3\0garbage"),
      OriginalRead::VerifiedProduction("1.0.3".into())
    );
    assert_eq!(original_from_code(3, b"\0"), OriginalRead::VerifiedOther);
    assert_eq!(original_from_code(0, b"\0"), OriginalRead::Unverified);
    for code in [-1, -2, -3, 2] {
      assert_eq!(
        original_from_code(code, b"1.0\0"),
        OriginalRead::Unknown,
        "{code}"
      );
    }
  }

  #[test]
  fn an_unreadable_version_is_unknown() {
    assert_eq!(original_from_code(1, b"1.0"), OriginalRead::Unknown);
    assert_eq!(original_from_code(1, b"\xff\xfe\0"), OriginalRead::Unknown);
  }

  #[test]
  fn a_price_is_read_only_on_success() {
    assert_eq!(price_from_code(1, b"$4.99\0"), Some("$4.99".into()));
    assert_eq!(price_from_code(1, b"$4.99"), None);
    for code in [-1, -2, -3] {
      assert_eq!(price_from_code(code, b"$4.99\0"), None);
    }
  }

  #[test]
  fn only_an_unanswered_original_is_unknown() {
    assert!(original_known(&OriginalRead::VerifiedProduction(
      "1.0".into()
    )));
    assert!(original_known(&OriginalRead::VerifiedOther));
    assert!(original_known(&OriginalRead::Unverified));
    assert!(!original_known(&OriginalRead::Unknown));
  }

  #[test]
  fn resolve_store_is_full_only_when_owned_or_bought_in_the_paid_period() {
    let originals = [
      (OriginalRead::VerifiedProduction("1.0.1".into()), true),
      (OriginalRead::VerifiedProduction("1.1.3".into()), true),
      (OriginalRead::VerifiedProduction("1.1.4".into()), false),
      (OriginalRead::VerifiedProduction("".into()), false),
      (OriginalRead::VerifiedOther, false),
      (OriginalRead::Unverified, false),
      (OriginalRead::Unknown, false),
    ];
    for (original, paid) in &originals {
      assert!(!resolve_store(&StoreRead::Owned, original), "{original:?}");
      for owned in [StoreRead::NotOwned, StoreRead::Unknown] {
        assert_eq!(
          resolve_store(&owned, original),
          !paid,
          "{owned:?} {original:?}"
        );
      }
    }
  }

  #[test]
  fn a_new_state_is_lite() {
    assert!(StoreState::new().lite());
  }

  #[test]
  fn a_refresh_after_an_unknown_launch_original_unlocks() {
    // (a)
    let mut state = StoreState::new();
    let owned = state.take_ticket();
    let original = state.take_ticket();
    state.apply(owned, Some(StoreRead::NotOwned), None);
    state.apply(original, None, Some(OriginalRead::Unknown));
    assert!(state.lite());
    let refresh = state.take_ticket();
    let lite = state.apply(
      refresh,
      None,
      Some(OriginalRead::VerifiedProduction("1.1.3".into())),
    );
    assert_eq!(lite, Some(false));
    assert!(!state.lite());
  }

  #[test]
  fn a_watch_read_of_owned_leaves_the_launch_original_to_land() {
    // (b)
    let mut state = StoreState::new();
    let init_owned = state.take_ticket();
    let init_original = state.take_ticket();
    let watch = state.take_ticket();
    state.apply(watch, Some(StoreRead::NotOwned), None);
    state.apply(init_owned, Some(StoreRead::Unknown), None);
    state.apply(
      init_original,
      None,
      Some(OriginalRead::VerifiedProduction("1.0.2".into())),
    );
    assert_eq!(state.owned, StoreRead::NotOwned);
    assert_eq!(
      state.original,
      OriginalRead::VerifiedProduction("1.0.2".into())
    );
    assert!(!state.lite());
  }

  #[test]
  fn a_late_launch_read_lands_when_nothing_else_happened() {
    // (c) The timeout itself takes no ticket and writes nothing.
    let mut state = StoreState::new();
    let owned = state.take_ticket();
    let original = state.take_ticket();
    assert!(state.lite());
    assert_eq!(
      state.apply(owned, Some(StoreRead::Owned), None),
      Some(false)
    );
    state.apply(original, None, Some(OriginalRead::Unknown));
    assert!(!state.lite());
  }

  #[test]
  fn a_stale_launch_read_loses_to_a_later_purchase() {
    // (d)
    let mut state = StoreState::new();
    let init = state.take_ticket();
    let purchase = state.take_ticket();
    state.apply(purchase, Some(StoreRead::Owned), None);
    assert_eq!(state.apply(init, Some(StoreRead::NotOwned), None), None);
    assert!(!state.lite());
  }

  #[test]
  fn a_stale_owned_launch_read_loses_to_a_later_refund() {
    // (e)
    let mut state = StoreState::new();
    let init = state.take_ticket();
    let watch = state.take_ticket();
    state.apply(watch, Some(StoreRead::NotOwned), None);
    assert_eq!(state.apply(init, Some(StoreRead::Owned), None), None);
    assert!(state.lite());
  }

  #[test]
  fn the_later_started_read_wins_when_it_also_finishes_later() {
    // (f)
    let mut state = StoreState::new();
    let first = state.take_ticket();
    let second = state.take_ticket();
    state.apply(first, Some(StoreRead::NotOwned), None);
    assert_eq!(
      state.apply(second, Some(StoreRead::Owned), None),
      Some(false)
    );
    assert_eq!(state.owned, StoreRead::Owned);
  }

  #[test]
  fn the_later_started_read_stays_when_it_finishes_first() {
    // (g)
    let mut state = StoreState::new();
    let first = state.take_ticket();
    let second = state.take_ticket();
    state.apply(second, Some(StoreRead::Owned), None);
    state.apply(first, Some(StoreRead::NotOwned), None);
    assert_eq!(state.owned, StoreRead::Owned);
  }

  #[test]
  fn an_older_owned_read_lands_after_a_newer_original_only_read() {
    // Each field keeps its own ticket; the original's must not block owned.
    let mut state = StoreState::new();
    let owned = state.take_ticket();
    let refresh = state.take_ticket();
    state.apply(refresh, None, Some(OriginalRead::Unknown));
    assert_eq!(
      state.apply(owned, Some(StoreRead::Owned), None),
      Some(false)
    );
    assert_eq!(state.owned, StoreRead::Owned);
    assert!(!state.lite());
  }

  #[test]
  fn tickets_strictly_increase() {
    let mut state = StoreState::new();
    let tickets: Vec<u64> = (0..4).map(|_| state.take_ticket()).collect();
    assert_eq!(tickets, vec![1, 2, 3, 4]);
  }

  #[test]
  fn an_unchanged_value_reports_no_change() {
    let mut state = StoreState::new();
    let ticket = state.take_ticket();
    assert_eq!(state.apply(ticket, Some(StoreRead::Unknown), None), None);
    let ticket = state.take_ticket();
    assert_eq!(
      state.apply(ticket, Some(StoreRead::NotOwned), None),
      Some(true)
    );
  }

  #[test]
  fn only_a_late_launch_read_takes_the_token() {
    assert!(takes_token(LateSource::Init));
    assert!(!takes_token(LateSource::Other));
  }

  #[test]
  fn late_open_truth_table() {
    for source in [LateSource::Init, LateSource::Other] {
      for took in [false, true] {
        for lite in [false, true] {
          assert_eq!(
            late_open(source, took, lite),
            source == LateSource::Init && took && !lite,
            "{source:?} took={took} lite={lite}"
          );
        }
      }
    }
  }

  #[test]
  fn other_never_opens() {
    assert!(!late_open(LateSource::Other, true, false));
    assert!(!takes_token(LateSource::Other));
  }

  #[test]
  fn init_with_a_lite_result_opens_nothing_and_takes_the_token() {
    assert!(takes_token(LateSource::Init));
    assert!(!late_open(LateSource::Init, true, true));
  }

  #[test]
  fn init_without_the_token_opens_nothing() {
    assert!(!late_open(LateSource::Init, false, false));
  }

  #[test]
  fn only_the_edition_window_may_buy() {
    assert!(store_caller_allowed("edition"));
    for label in [
      "settings",
      "about",
      "workspace",
      "doc-1",
      "note-1",
      "Edition",
      "",
    ] {
      assert!(!store_caller_allowed(label), "{label}");
    }
  }

  #[test]
  fn a_build_without_the_store_shows_no_store() {
    assert_eq!(
      serde_json::to_value(StoreInfo::unavailable()).unwrap(),
      serde_json::json!({ "available": false, "price": null, "originalKnown": true })
    );
  }
}
