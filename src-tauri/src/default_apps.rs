// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! The Windows "Default apps" deep link.
//!
//! Windows offers no supported way to set file-type defaults programmatically:
//! the user has to pick each extension in Settings. `ms-settings:defaultapps`
//! takes a parameter naming one application, which opens that application's own
//! page directly instead of the full list, so the picking is one click away
//! rather than a search.
//!
//! Everything below is Windows-only except `parameter_supported`, which is a
//! plain numeric predicate and so is compiled and tested on every platform.

/// Whether the `ms-settings:defaultapps` app parameter exists on this build.
/// The parameter shipped in the 2023-04 cumulative updates — KB5025239 raised
/// Windows 11 22H2 to 22621.1555 and KB5025224 raised 21H2 to 22000.1817 — and
/// in every build after them. An older build opens the plain Default apps list
/// and ignores the parameter, so the row is hidden there rather than sending
/// the user somewhere that does not answer the question.
///
/// The `test` arm keeps the predicate compiled where its only caller is the
/// test module: without it a release build for any other platform has no
/// caller at all, and `cargo clippy -D warnings` fails the whole run on dead
/// code.
#[cfg(any(target_os = "windows", test))]
pub fn parameter_supported(build: u32, ubr: u32) -> bool {
  build >= 22631 || (build == 22621 && ubr >= 1555) || (build == 22000 && ubr >= 1817)
}

/// The app name as it appears under `RegisteredApplications`, percent-encoded
/// for the query string. `&` left raw would end the query at "Note", and the
/// Settings page would find no application by that name.
#[cfg(target_os = "windows")]
const REGISTERED_APP_USER: &str = "Note%26Pad";

#[cfg(target_os = "windows")]
mod win {
  use windows::core::PWSTR;
  use windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
  use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName;
  use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
  };

  /// Where Windows records its own version. Read from the registry rather than
  /// from `GetVersionEx`/`RtlGetVersion`-style APIs, which report a shimmed
  /// version to any process without a supportedOS manifest entry. The UBR only
  /// exists here in the first place, so a registry read is unavoidable; taking
  /// the build from a second, differently-shimmed source would be worse than
  /// taking both from the one place that agrees with itself.
  ///
  /// Measured on a real Windows VM: both values are readable from a
  /// non-elevated process.
  const VERSION_KEY: &str = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";

  /// A NUL-terminated UTF-16 copy, the only string form the Win32 registry
  /// functions accept.
  fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
  }

  /// `CurrentBuild`, a REG_SZ holding the decimal build number ("22631").
  fn current_build() -> Option<u32> {
    let subkey = wide(VERSION_KEY);
    let name = wide("CurrentBuild");
    let mut buf = [0u16; 32];
    let mut size = std::mem::size_of_val(&buf) as u32;
    // Contained unsafe: one read-only registry query into a fixed local buffer,
    // whose byte size is what `size` carries in and out.
    let rc = unsafe {
      RegGetValueW(
        HKEY_LOCAL_MACHINE,
        subkey.as_ptr(),
        name.as_ptr(),
        RRF_RT_REG_SZ,
        std::ptr::null_mut(),
        buf.as_mut_ptr().cast(),
        &mut size,
      )
    };
    if rc != 0 {
      return None;
    }
    let text: String = String::from_utf16_lossy(&buf);
    text.trim_end_matches('\0').trim().parse().ok()
  }

  /// `UBR`, a REG_DWORD holding the update revision (the ".1555" of 22621.1555).
  fn update_build_revision() -> Option<u32> {
    let subkey = wide(VERSION_KEY);
    let name = wide("UBR");
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // Contained unsafe: as above, into one `u32`.
    let rc = unsafe {
      RegGetValueW(
        HKEY_LOCAL_MACHINE,
        subkey.as_ptr(),
        name.as_ptr(),
        RRF_RT_REG_DWORD,
        std::ptr::null_mut(),
        &mut data as *mut u32 as *mut _,
        &mut size,
      )
    };
    if rc != 0 {
      return None;
    }
    Some(data)
  }

  /// This build's version, or `None` when either value is unreadable — which
  /// the caller treats as "not supported", the same as an old build.
  pub(super) fn os_version() -> Option<(u32, u32)> {
    Some((current_build()?, update_build_revision()?))
  }

  /// The package family name of the running MSIX package, e.g.
  /// `Publisher.App_abc123def456`. Only meaningful under a package identity;
  /// `has_package_identity` is what decides that, this only fetches the name.
  fn package_family_name() -> Option<String> {
    let mut len: u32 = 0;
    // Contained unsafe: the documented length probe. A packaged process cannot
    // fit the name in zero characters, so ERROR_INSUFFICIENT_BUFFER is the
    // success answer here and `len` comes back as the needed length.
    let rc = unsafe { GetCurrentPackageFamilyName(&mut len, None) };
    if rc != ERROR_INSUFFICIENT_BUFFER {
      return None;
    }
    let mut buf = vec![0u16; len as usize];
    // Contained unsafe: the buffer is exactly the length just asked for, and
    // `len` is updated to the characters written.
    let rc = unsafe { GetCurrentPackageFamilyName(&mut len, Some(PWSTR(buf.as_mut_ptr()))) };
    if rc.is_err() {
      return None;
    }
    buf.truncate(len.saturating_sub(1) as usize);
    Some(String::from_utf16_lossy(&buf))
  }

  /// The deep link for this build. A packaged build is addressed by its
  /// AppUserModelID (`<PackageFamilyName>!App`, the id in the manifest's only
  /// Application element); every other build by the name it registers under
  /// `HKCU\Software\RegisteredApplications`, which the installers write.
  pub(super) fn settings_uri() -> String {
    if crate::jumplist::has_package_identity() {
      if let Some(family) = package_family_name() {
        return format!("ms-settings:defaultapps?registeredAUMID={family}!App");
      }
      log::warn!("packaged process could not read its package family name");
    }
    format!(
      "ms-settings:defaultapps?registeredAppUser={}",
      super::REGISTERED_APP_USER
    )
  }
}

/// Whether the Settings row should be shown at all: Windows only, and only on
/// a build that understands the parameter.
#[tauri::command]
pub fn default_apps_page_supported() -> bool {
  #[cfg(target_os = "windows")]
  {
    win::os_version().is_some_and(|(build, ubr)| parameter_supported(build, ubr))
  }
  #[cfg(not(target_os = "windows"))]
  {
    false
  }
}

/// Open this app's own page in the Windows Default apps settings. A no-op
/// elsewhere; the row that calls it is hidden on every other platform.
#[tauri::command]
pub fn open_default_apps_page() {
  #[cfg(target_os = "windows")]
  {
    // The same shell hand-off every external link uses, so this inherits its
    // off-thread launch and its avoidance of spawning a helper process.
    crate::navigation::open_externally(&win::settings_uri());
  }
}

#[cfg(test)]
mod tests {
  use super::parameter_supported;

  /// The two servicing boundaries are the whole point of the predicate: one
  /// revision below each is an unsupported machine that would be sent to a
  /// page that ignores the parameter.
  #[test]
  fn the_2023_04_updates_are_the_boundary() {
    assert!(!parameter_supported(22000, 1816));
    assert!(parameter_supported(22000, 1817));
    assert!(!parameter_supported(22621, 1554));
    assert!(parameter_supported(22621, 1555));
  }

  #[test]
  fn every_later_build_is_supported_at_any_revision() {
    assert!(parameter_supported(22631, 0));
    assert!(parameter_supported(26100, 0));
  }

  /// Builds outside the three supported branches never got the parameter, no
  /// matter how patched: 19045 is Windows 10 22H2, and 21390.1 is what the
  /// Windows 10 VM used for testing actually reports.
  #[test]
  fn older_branches_stay_unsupported_however_patched() {
    assert!(!parameter_supported(19045, 9999));
    assert!(!parameter_supported(21390, 1));
  }
}
