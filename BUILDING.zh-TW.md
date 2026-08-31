# 自行建置 Note&Pad

[English](BUILDING.md) · 正體中文 · [日本語](BUILDING.ja.md)

Note&Pad 以 GPL-3.0-only 授權釋出。不必付費購買，可以直接從原始碼建置當前的版本。

相同版本下，功能與商店版完全相同。唯二的差別是簽章與更新：商店版經過簽章與公證，作業系統不會攔，自己建的沒有簽章，第一次執行要多按一兩下；商店版的新版本由購買的商店派送，自己建的則要重新建置。

## 共同前置

- **Node.js 24**
- **Rust stable**（`src-tauri/Cargo.toml` 標示的最低版本是 1.77.2）

```sh
npm ci
npm run tauri -- build
```

用 `npm ci` 而不是 `npm install`，它完全依照 `package-lock.json`，不會因為版本漂移建出跟預期不同的東西。

建置指令會自己先產生前端再打包，不需要分兩步。

## macOS

需要 Xcode Command Line Tools：

```sh
xcode-select --install
npm run tauri -- build
```

產物在 `src-tauri/target/release/bundle/` 底下的 `macos/Note&Pad.app` 與 `dmg/*.dmg`。

只要 app 檔、不要磁碟映像檔的話可加 `--bundles app`。

最低系統版本是 **macOS 13.3**，設在 `src-tauri/tauri.conf.json` 的 `bundle.macOS.minimumSystemVersion`。

要同時支援 Apple Silicon 與 Intel：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri -- build --target universal-apple-darwin
```

`universal-apple-darwin` 是 Tauri CLI 的偽目標，不是 rustup 目標——CLI 會把兩個架構各建一次再用 `lipo` 合併，所以兩個真實目標都得先裝好，編譯時間也大約是兩倍。

**第一次開啟會被 Gatekeeper 擋**，因為沒有簽章。任選一種：

- 在 Finder 裡對 app 按右鍵 →「打開」，再按一次「打開」。
- 或清掉隔離屬性：

```sh
xattr -cr "/Applications/Note&Pad.app"
```

## Windows

需要兩樣東西：

- **Visual Studio Build Tools**，含「使用 C++ 的桌面開發」工作負載（MSVC 編譯器與 Windows SDK）
- **WebView2 執行環境**。Windows 11 內建，Windows 10 若沒有需自行安裝。

```sh
npm run tauri -- build
```

產物是 `src-tauri\target\release\bundle\nsis\*-setup.exe`。**只出 NSIS 安裝程式，不出 MSI**：產品名裡的 `&` 會讓 Tauri 產生的 WiX 檔變成無效 XML。

**原始碼所在路徑不能有 `&`。** `npm run` 產生的中介指令會被 PowerShell 在 `&` 處切開，建置失敗，錯誤訊息卻是 `Cannot find module '...\@tauri-apps\cli\tauri.js'`，看起來像相依套件壞掉。`git clone` 建出來的資料夾叫 `note-n-pad`，不會有這個問題；自己改過資料夾名稱才要留意。

安裝程式是 per-user 安裝，裝到 `%LOCALAPPDATA%\Note&Pad`，不需要系統管理員權限。

上面的指令建的是你這台機器的架構。要建另一個架構，先裝目標再指定：

```sh
rustup target add x86_64-pc-windows-msvc
npm run tauri -- build --target x86_64-pc-windows-msvc
```

ARM64 換成 `aarch64-pc-windows-msvc`。兩個方向都能交叉編譯。

執行安裝程式時會遇到兩道關卡：

- **SmartScreen** 跳藍色警告視窗 → 點「更多資訊」→「仍要執行」。
- **Windows Defender 可能直接把安裝程式隔離掉**，而且是隔離不是警告：檔案會憑空消失，雙擊後看起來像沒反應。未簽章的 NSIS 安裝程式被機器學習啟發式誤判是常見狀況。從 Windows 安全性的「保護紀錄」把它還原，或重新建置一次即可。

建置封裝過程中如遇各種問題，請開 issue 回報：<https://github.com/Lonshaus/note-n-pad/issues>。附上作業系統版本、`node --version`、`rustc --version` 與完整錯誤訊息。
