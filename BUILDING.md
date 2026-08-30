# Building Note&Pad from source

English · [正體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md)

Note&Pad is released under GPL-3.0-only. You don't have to pay for it: you can build the current version straight from source.

For the same version, the build behaves identically to the store release. The only two differences are that the store build is signed and notarized so the OS lets it run without complaint, while a self-built binary is unsigned, so the first launch needs an extra click or two, and it doesn't support auto-updates, so a new release means repackaging by hand.

## Common prerequisites

- **Node.js 24**
- **Rust stable** (the floor pinned in `src-tauri/Cargo.toml` is 1.77.2)

```sh
npm ci
npm run tauri -- build
```

Use `npm ci`, not `npm install`. It installs exactly what `package-lock.json` says, so version drift can't quietly change what you build.

The build command generates the frontend and packages it in one step; there's no separate build-then-package sequence to run.

## macOS

Requires Xcode Command Line Tools:

```sh
xcode-select --install
npm run tauri -- build
```

The output lands under `src-tauri/target/release/bundle/`, as `macos/Note&Pad.app` and `dmg/*.dmg`.

If you only want the app bundle and not the disk image, add `--bundles app`.

The minimum supported system version is **macOS 13.3**, set via `bundle.macOS.minimumSystemVersion` in `src-tauri/tauri.conf.json`.

To build a universal binary for both Apple Silicon and Intel:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri -- build --target universal-apple-darwin
```

`universal-apple-darwin` is a pseudo-target the Tauri CLI understands, not an actual rustup target: the CLI builds each architecture separately and merges them with `lipo`, so both real targets need to be installed first, and the build takes roughly twice as long.

**Gatekeeper will block the first launch**, since the app isn't signed. Pick one:

- Right-click the app in Finder, choose "Open", then confirm "Open" again.
- Or strip the quarantine attribute directly:

```sh
xattr -cr "/Applications/Note&Pad.app"
```

## Windows

Two things are required:

- **Visual Studio Build Tools**, with the "Desktop development with C++" workload (this brings the MSVC compiler and the Windows SDK)
- The **WebView2** runtime. Windows 11 ships with it; on Windows 10 you may need to install it yourself.

```sh
npm run tauri -- build
```

The output is `src-tauri\target\release\bundle\nsis\*-setup.exe`. **Only the NSIS installer is produced, not an MSI**: the `&` in the product name turns the WiX file Tauri would generate into invalid XML.

**The source path must not contain `&`.** The intermediate command that `npm run` produces gets split by PowerShell at the `&`, and the build fails with an error that reads `Cannot find module '...\@tauri-apps\cli\tauri.js'` — which looks like a broken dependency, not a path problem. A folder created by `git clone` is named `note-n-pad` and won't hit this, so it only bites if you've renamed the folder yourself.

The installer does a per-user install, into `%LOCALAPPDATA%\Note&Pad`, and doesn't need administrator rights.

The command above builds for whatever architecture your machine is running. To build for a different one, install the target first and then specify it:

```sh
rustup target add x86_64-pc-windows-msvc
npm run tauri -- build --target x86_64-pc-windows-msvc
```

For ARM64, use `aarch64-pc-windows-msvc` instead. Cross-compiling works in either direction.

Running the installer means clearing two gates:

- **SmartScreen** pops a blue warning. Click "More info", then "Run anyway".
- **Windows Defender may quarantine the installer outright**, not just warn — the file simply vanishes, and double-clicking it appears to do nothing. Machine-learning heuristics flagging an unsigned NSIS installer is common. Restore it from "Protection history" in Windows Security, or just rebuild it.

If you run into problems during the build or packaging, please open an issue: <https://github.com/Lonshaus/note-n-pad/issues>. Include your OS version, `node --version`, `rustc --version`, and the full error message.
