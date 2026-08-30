// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Security-scoped bookmarks, the only way a sandboxed build keeps a folder the
//! user picked once.
//!
//! Outside the sandbox a stored path is enough: the app can reopen it whenever
//! it likes. Inside it, the panel the user picked the folder in grants access
//! to *this* process, and that grant dies with it — next launch the same path
//! is denied, which is how the snapshot folder setting (and with it the iCloud
//! option) stops working. A security-scoped bookmark is the grant written down:
//! made while access is live, resolved on the next launch to get it back.
//!
//! The bookmark goes in its own settings field, `snapshot_dir_bookmark`, beside
//! the plain `snapshot_dir` rather than instead of it. An unsandboxed process
//! can make one too (measured), so a single field would have turned every
//! unsandboxed build's readable setting into a kilobyte of base64,
//! and left nothing to fall back on when a bookmark stops resolving — a folder
//! deleted and recreated at the same place is reachable by path but not by
//! bookmark. Two fields keep the path authoritative and the bookmark an extra.

use std::path::{Path, PathBuf};

/// Write down the grant on a folder the user just picked, base64 for a settings
/// file that has to stay plain JSON. `None` when there is nothing to write down
/// — every platform but macOS, and any folder macOS refuses to bookmark — and
/// the caller then has only the path, which is what every build had before this
/// existed.
pub fn encode(path: &Path) -> Option<String> {
  #[cfg(target_os = "macos")]
  {
    mac::encode(path)
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = path;
    None
  }
}

/// The folder a stored bookmark points at, with access to it re-acquired.
/// `None` when it cannot be used: it no longer resolves (folder deleted, volume
/// not mounted), or this is not macOS and the value came from a settings file
/// that was. The caller falls back to the plain path stored beside it.
pub fn to_path(stored: &str) -> Option<PathBuf> {
  #[cfg(target_os = "macos")]
  {
    mac::resolve(stored)
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = stored;
    None
  }
}

#[cfg(target_os = "macos")]
mod mac {
  use objc2::AnyThread;
  use objc2_foundation::{
    NSData, NSDataBase64DecodingOptions, NSDataBase64EncodingOptions, NSString,
    NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
  };
  use std::path::{Path, PathBuf};

  fn url(path: &Path) -> Option<objc2::rc::Retained<NSURL>> {
    Some(NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?)))
  }

  pub(super) fn encode(path: &Path) -> Option<String> {
    let data = url(path)?
      .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
        NSURLBookmarkCreationOptions::WithSecurityScope,
        None,
        None,
      )
      .map_err(|e| log::warn!("no security-scoped bookmark for {}: {e}", path.display()))
      .ok()?;
    Some(
      data
        .base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty())
        .to_string(),
    )
  }

  /// Resolve and start accessing. The access is deliberately never stopped: it
  /// has to last as long as the app can write snapshots, which is the whole
  /// run, and the process exiting releases it anyway. A stale bookmark (the
  /// folder moved) still resolves to where the folder went, which is the point
  /// of a bookmark over a path, so staleness is not treated as failure.
  pub(super) fn resolve(encoded: &str) -> Option<PathBuf> {
    let data = NSData::initWithBase64EncodedString_options(
      NSData::alloc(),
      &NSString::from_str(encoded),
      NSDataBase64DecodingOptions::empty(),
    )?;
    let resolved = unsafe {
      NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
        &data,
        // WithoutMounting: resolving may otherwise try to mount the volume, and
        // this runs on the startup path. A network share that is slow to answer
        // would freeze the app before it drew anything, with the user given no
        // idea what it is waiting for. An unmounted volume is treated as an
        // unavailable folder instead, which the settings window reports.
        NSURLBookmarkResolutionOptions::WithSecurityScope
          | NSURLBookmarkResolutionOptions::WithoutMounting,
        None,
        std::ptr::null_mut(),
      )
    }
    .map_err(|e| log::warn!("stored snapshot-folder bookmark did not resolve: {e}"))
    .ok()?;
    if !unsafe { resolved.startAccessingSecurityScopedResource() } {
      log::warn!("resolved the snapshot-folder bookmark but was refused access");
      return None;
    }
    let path = PathBuf::from(resolved.path()?.to_string());
    std::mem::forget(resolved);
    Some(path)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_unresolvable_bookmark_is_not_a_path() {
    // Never hand back the stored text as if it were a folder name: the caller
    // has to see it as unusable so it falls back to the path beside it.
    assert_eq!(to_path("AAAA"), None);
  }

  #[test]
  fn nonsense_is_refused_rather_than_guessed_at() {
    assert_eq!(to_path(""), None);
    assert_eq!(to_path("/Users/someone/Snapshots"), None);
  }
}
