// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
//! Where a link may take the app. A webview that leaves the app's own page
//! loses its IPC context, and this codebase has no way back — so every
//! navigation is decided here, and the two commands the preview calls run the
//! same decision rather than relying on the hook to catch what they miss.

use crate::path_guard::resolve_within;
use crate::preview_img::PreviewBases;
use crate::settings;
use crate::windows::open_document;
use std::path::{Path, PathBuf};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, State, Url, Webview};

/// What a navigation target is allowed to do.
#[derive(Debug, PartialEq, Eq)]
enum Nav {
  /// The app's own page — the only thing a webview may load.
  InApp,
  /// Handed to the OS, and the navigation cancelled.
  External,
  Blocked,
}

/// Schemes the OS opener may be handed. An allowlist, because the opener runs
/// whatever program the system registered for a scheme: `file:` would open a
/// local file with it, and an unknown custom scheme whatever claimed it.
const EXTERNAL_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// The app's own custom protocols. `docimg` never reaches navigation — an image
/// load is not one — but is allowed rather than silently relied on.
const APP_SCHEMES: [&str; 2] = ["tauri", "docimg"];

/// True for the app's own page. Mirrors tauri's private
/// `AppManager::tauri_protocol_url`: a custom scheme is served as
/// `<scheme>://localhost`, except on Windows and Android where wry serves it as
/// `http(s)://<scheme>.localhost`. Only the form the running build actually
/// uses is allowed — trusting `http://tauri.localhost` on macOS would trust
/// whatever a local resolver points that name at.
fn is_app_origin(url: &Url) -> bool {
  // An explicit port is never the app: `http://tauri.localhost:8080` is
  // whatever happens to be listening on 8080.
  if url.port().is_some() {
    return false;
  }
  if cfg!(any(windows, target_os = "android")) {
    let host = url.host_str().unwrap_or_default();
    matches!(url.scheme(), "http" | "https")
      && APP_SCHEMES.iter().any(|s| {
        host.len() == s.len() + ".localhost".len()
          && host.starts_with(s)
          && host.ends_with(".localhost")
      })
  } else {
    APP_SCHEMES.contains(&url.scheme()) && url.host_str() == Some("localhost")
  }
}

/// Scheme, host and port — never `Url::origin`, which is opaque for a
/// non-special scheme like `tauri:` and so never compares equal to itself.
fn same_origin(a: &Url, b: &Url) -> bool {
  a.scheme() == b.scheme()
    && a.host_str() == b.host_str()
    && a.port_or_known_default() == b.port_or_known_default()
}

/// The app only ever loads its one entry document; a same-origin navigation to
/// any other path is something else driving the webview. A preview link's
/// `href` is same-origin by construction, so without this the hook would wave
/// it through if a click ever reached the browser.
fn is_entry_document(url: &Url) -> bool {
  matches!(url.path(), "" | "/" | "/index.html")
}

/// `dev_origin` is the dev server in a dev build and `None` otherwise: in a
/// release build the configured `devUrl` is still baked into the config, and
/// trusting it would mean trusting whatever is listening on that port.
fn decide(url: &Url, dev_origin: Option<&Url>) -> Nav {
  if is_app_origin(url) || dev_origin.is_some_and(|d| same_origin(url, d)) {
    if is_entry_document(url) {
      return Nav::InApp;
    }
    return Nav::Blocked;
  }
  if EXTERNAL_SCHEMES.contains(&url.scheme()) {
    return Nav::External;
  }
  Nav::Blocked
}

/// The dev server the app is served from, in a dev build only.
fn dev_origin<R: Runtime, M: Manager<R>>(manager: &M) -> Option<Url> {
  if cfg!(dev) {
    manager.config().build.dev_url.clone()
  } else {
    None
  }
}

/// Hand `url` to the OS. The free function rather than `OpenerExt::opener`:
/// this also runs from the navigation hook, which tauri calls with its plugin
/// store locked, and a state lookup there is one more lock than the job needs.
pub(crate) fn open_externally(url: &str) {
  #[cfg(target_os = "windows")]
  {
    shell::hand_over(url);
  }
  #[cfg(not(target_os = "windows"))]
  {
    if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
      log::warn!("failed to open {url}: {e}");
    }
  }
}

/// Windows' half of `open_externally`. The opener plugin reaches the shell by
/// spawning `powershell.exe` (with `explorer.exe` as a fallback), and a Store
/// package cannot count on launching either: S mode blocks executables that did
/// not come from the Store, and the strings alone make the app look like it
/// shells out. `ShellExecuteW` asks the shell directly -- no child process, and
/// nothing for that policy to block.
#[cfg(target_os = "windows")]
mod shell {
  use windows::core::HSTRING;
  use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
  };
  use windows::Win32::UI::Shell::ShellExecuteW;
  use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

  /// `ShellExecuteW` answers with a pretend `HINSTANCE`: above 32 it launched
  /// something, at or below 32 the value is an error code. Split out because
  /// that boundary is the whole contract and is easy to get wrong (`>= 32`
  /// would read `SE_ERR_ACCESSDENIED`, which is 5, no differently than success
  /// -- and 32 itself is `SE_ERR_SHARE`).
  fn launched(rc: isize) -> bool {
    rc > 32
  }

  /// Hand the URL to the shell off the calling thread. `ShellExecuteW` starts
  /// the default handler and can take a moment to return; the navigation hook
  /// runs on the UI thread, and a link click must not freeze the window.
  pub(super) fn hand_over(url: &str) {
    let url = url.to_string();
    std::thread::spawn(move || {
      // `ShellExecuteW` can hand the URL to a Shell extension activated through
      // COM -- which is how a packaged app registers itself as the handler for
      // a protocol -- and its documentation asks for an initialized apartment,
      // single-threaded for the extensions that need one. This thread exists
      // only for this call, so initializing here cannot disturb the apartment
      // any other part of the app is running in.
      // Contained unsafe: paired with the `CoUninitialize` below on every exit
      // from this thread, and nothing else on it touches COM.
      let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
      if com.is_err() {
        log::warn!("COM was not initialized for {url}: {com:?}; opening anyway");
      }
      let target = HSTRING::from(url.as_str());
      let verb = HSTRING::from("open");
      // Contained unsafe: every pointer handed over outlives the call, and the
      // two null arguments are the documented "no parameters, no working
      // directory" form.
      let rc = unsafe {
        ShellExecuteW(
          None,
          &verb,
          &target,
          windows::core::PCWSTR::null(),
          windows::core::PCWSTR::null(),
          SW_SHOWNORMAL,
        )
      };
      if !launched(rc.0 as isize) {
        log::warn!(
          "failed to open {url}: ShellExecuteW returned {}",
          rc.0 as isize
        );
      }
      if com.is_ok() {
        unsafe { CoUninitialize() };
      }
    });
  }

  #[cfg(test)]
  mod tests {
    use super::launched;

    #[test]
    fn only_above_32_counts_as_launched() {
      // The documented boundary, and the error codes that sit right under it.
      assert!(!launched(0)); // out of memory
      assert!(!launched(2)); // SE_ERR_FNF
      assert!(!launched(5)); // SE_ERR_ACCESSDENIED
      assert!(!launched(31)); // SE_ERR_NOASSOC
      assert!(!launched(32)); // SE_ERR_SHARE
      assert!(launched(33));
      assert!(launched(42));
    }
  }
}

/// The navigation guard. A plugin so one registration covers every window,
/// present and future; tauri 2.11 has no app-wide `on_navigation`, and the
/// per-webview form would have to be repeated at every builder site.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("navigation-guard")
    .on_navigation(
      |webview, url| match decide(url, dev_origin(webview).as_ref()) {
        Nav::InApp => true,
        Nav::External => {
          open_externally(url.as_str());
          false
        }
        Nav::Blocked => false,
      },
    )
    .build()
}

/// Open an external link the preview was clicked on. The frontend names the
/// destination; this decides whether it may be handed to the OS, with the same
/// function the navigation hook uses.
///
/// No dev origin is passed: `InApp` is never an answer the frontend may get,
/// since nothing it says should be able to navigate a window.
#[tauri::command]
pub fn open_external_link(url: String) -> Result<(), String> {
  let parsed = Url::parse(&url).map_err(|_| REFUSED.to_string())?;
  if decide(&parsed, None) != Nav::External {
    return Err(REFUSED.to_string());
  }
  open_externally(parsed.as_str());
  Ok(())
}

/// One refusal string for every reason. A reason could only tell the caller
/// which guard it hit.
const REFUSED: &str = "link refused";

/// Drop a `#fragment` or `?query` before the destination is treated as a path.
/// Cut on the raw text, ahead of `resolve_within`'s percent-decoding, so an
/// escaped `%23` stays part of a filename that really contains `#`.
fn strip_fragment(dest: &str) -> &str {
  let end = dest.find(['#', '?']).unwrap_or(dest.len());
  &dest[..end]
}

/// Every decision the relative-link command makes, with no app handle in sight
/// so `cargo test` can drive each refusal.
fn resolve_link(enabled: bool, base: Option<&Path>, dest: &str) -> Result<PathBuf, String> {
  if !enabled {
    return Err(REFUSED.to_string());
  }
  let base = base.ok_or_else(|| REFUSED.to_string())?;
  resolve_within(base, strip_fragment(dest)).map_err(|_| REFUSED.to_string())
}

/// `resolve_within` returns a canonicalized path, which on Windows is verbatim
/// (`\\?\C:\…`). That form travels on into the window title, the recent-files
/// menu and the note store, so the prefix comes off — but only for a drive
/// path: `\\?\UNC\server\share` is not `UNC\server\share`.
fn openable_path(path: &Path) -> String {
  let s = path.to_string_lossy().into_owned();
  match s.strip_prefix(r"\\?\") {
    Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
    _ => s,
  }
}

/// Open a relative Markdown link in the app. Same layering as `preview_img`:
/// the frontend is trusted to name a destination, never to authorise one, so
/// the setting, the calling webview's registered base folder and
/// `resolve_within` all decide again here.
///
/// Commands that build a window must be `(async)`; see `open_document_window`.
#[tauri::command(async)]
pub fn open_preview_link(
  app: AppHandle,
  webview: Webview,
  bases: State<'_, PreviewBases>,
  dest: String,
) -> Result<(), String> {
  let enabled = settings::app_settings(&app).preview_local_resources;
  let base = bases.base_for(webview.label());
  let path = resolve_link(enabled, base.as_deref(), &dest)?;
  open_document(&app, &openable_path(&path), None)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use tempfile::{tempdir, TempDir};

  /// The app's own page, spelled the way the running build serves it.
  fn app_url(path: &str) -> Url {
    if cfg!(any(windows, target_os = "android")) {
      Url::parse(&format!("http://tauri.localhost/{path}")).unwrap()
    } else {
      Url::parse(&format!("tauri://localhost/{path}")).unwrap()
    }
  }

  fn nav(raw: &str) -> Nav {
    decide(&Url::parse(raw).unwrap(), None)
  }

  #[test]
  fn the_apps_own_origin_is_allowed() {
    assert_eq!(decide(&app_url("index.html"), None), Nav::InApp);
    assert_eq!(
      decide(&app_url("index.html?mode=workspace"), None),
      Nav::InApp
    );
  }

  #[test]
  fn the_dev_server_is_allowed_only_when_it_is_passed() {
    let dev = Url::parse("http://localhost:1420").unwrap();
    let page = Url::parse("http://localhost:1420/index.html").unwrap();
    assert_eq!(decide(&page, Some(&dev)), Nav::InApp);
    // A release build passes None, and then the same URL is just a web page.
    assert_eq!(decide(&page, None), Nav::External);
    // A different port on the same host is a different server.
    assert_eq!(
      decide(&Url::parse("http://localhost:8080/").unwrap(), Some(&dev)),
      Nav::External
    );
  }

  #[test]
  fn a_port_on_the_app_host_is_not_the_app() {
    assert_ne!(nav("http://tauri.localhost:8080/"), Nav::InApp);
    assert_ne!(nav("tauri://localhost:8080/"), Nav::InApp);
  }

  #[test]
  fn web_and_mail_schemes_go_to_the_os() {
    assert_eq!(nav("http://example.com/a"), Nav::External);
    assert_eq!(nav("https://example.com/a"), Nav::External);
    assert_eq!(nav("mailto:someone@example.com"), Nav::External);
  }

  #[test]
  fn every_other_scheme_is_blocked() {
    for raw in [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "about:blank",
      "ftp://example.com/a",
      "x-note-n-pad-evil:whatever",
    ] {
      assert_eq!(nav(raw), Nav::Blocked, "{raw}");
    }
  }

  #[test]
  fn whitespace_and_case_do_not_smuggle_a_scheme_past() {
    // The URL parser strips leading C0 controls and spaces and lowercases the
    // scheme before the hook sees anything, which is exactly how a naive
    // `starts_with("javascript:")` check gets walked past. The decision is on
    // the parsed scheme, so both still land as blocked.
    for raw in [" JavaScript:alert(1)", "\u{1}\t\nJAVASCRIPT:alert(1)"] {
      let url = Url::parse(raw).unwrap();
      assert_eq!(url.scheme(), "javascript", "{raw}");
      assert_eq!(decide(&url, None), Nav::Blocked, "{raw}");
    }
  }

  struct Fixture {
    _dir: TempDir,
    base: PathBuf,
  }

  /// `<tmp>/notes` holding one document, with a secret one level up.
  fn fixture() -> Fixture {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let base = root.join("notes");
    fs::create_dir(&base).unwrap();
    fs::write(base.join("b.md"), "x").unwrap();
    fs::write(root.join("secret.md"), "x").unwrap();
    Fixture { _dir: dir, base }
  }

  #[test]
  fn setting_off_refuses_an_otherwise_valid_link() {
    let f = fixture();
    // The same destination resolves with the setting on, so this pins the gate
    // rather than some unrelated failure.
    assert!(resolve_link(true, Some(&f.base), "b.md").is_ok());
    assert!(resolve_link(false, Some(&f.base), "b.md").is_err());
  }

  /// The refusal itself is the type: there is no `&Path` to hand
  /// `resolve_within` without inventing one. This pins that the destination is
  /// never the reason — the same one resolves the moment a base exists.
  #[test]
  fn no_registered_base_refuses() {
    let f = fixture();
    assert!(resolve_link(true, Some(&f.base), "b.md").is_ok());
    assert!(resolve_link(true, None, "b.md").is_err());
  }

  #[test]
  fn escaping_the_base_refuses() {
    let f = fixture();
    assert!(resolve_link(true, Some(&f.base), "../secret.md").is_err());
    assert!(resolve_link(true, Some(&f.base), "%2e%2e%2fsecret.md").is_err());
  }

  #[test]
  fn a_contained_link_resolves_to_the_real_file() {
    let f = fixture();
    let want = f.base.join("b.md").canonicalize().unwrap();
    assert_eq!(resolve_link(true, Some(&f.base), "b.md").unwrap(), want);
  }

  #[test]
  fn a_same_origin_path_that_is_not_the_entry_document_is_blocked() {
    // A preview link's href is same-origin by construction, so this is the
    // difference between the hook being a backstop and being decorative.
    assert_eq!(decide(&app_url(""), None), Nav::InApp);
    assert_eq!(decide(&app_url("index.html"), None), Nav::InApp);
    assert_eq!(decide(&app_url("notes/secret.md"), None), Nav::Blocked);
    assert_eq!(decide(&app_url("../../etc/passwd"), None), Nav::Blocked);
  }

  #[test]
  fn a_fragment_or_query_is_cut_before_the_destination_is_a_path() {
    let f = fixture();
    let want = f.base.join("b.md").canonicalize().unwrap();
    assert_eq!(resolve_link(true, Some(&f.base), "b.md#top").unwrap(), want);
    assert_eq!(resolve_link(true, Some(&f.base), "b.md?v=1").unwrap(), want);
    // Cut before decoding, so an escaped hash stays part of the name.
    assert_eq!(strip_fragment("a%23b.md"), "a%23b.md");
  }

  #[test]
  fn a_verbatim_drive_path_loses_its_prefix_and_a_unc_one_does_not() {
    assert_eq!(
      openable_path(Path::new(r"\\?\C:\notes\b.md")),
      r"C:\notes\b.md"
    );
    assert_eq!(
      openable_path(Path::new(r"\\?\UNC\server\share\b.md")),
      r"\\?\UNC\server\share\b.md"
    );
    assert_eq!(
      openable_path(Path::new("/home/u/notes/b.md")),
      "/home/u/notes/b.md"
    );
  }
}
