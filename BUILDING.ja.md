# Note&Pad をソースからビルドする

[English](BUILDING.md) · [正體中文](BUILDING.zh-TW.md) · 日本語

Note&Pad は GPL-3.0-only ライセンスで公開されています。購入しなくても、ソースコードから現行バージョンをそのままビルドできます。

同じバージョンであれば、機能はストア版とまったく同じです。違いは署名とアップデートの 2 点だけです。ストア版は署名と公証を済ませているため OS にブロックされませんが、自分でビルドしたものは未署名なので、初回起動時に一手間余計にかかります。また新しいバージョンは、ストア版なら購入したストアから配信されますが、自分でビルドした場合は再度ビルドし直す必要があります。

## 共通の前提条件

- **Node.js 24**
- **Rust stable**（`src-tauri/Cargo.toml` が示す最低バージョンは 1.77.2）

```sh
npm ci
npm run tauri -- build
```

`npm install` ではなく `npm ci` を使ってください。`package-lock.json` の内容を厳密に再現するため、バージョンのずれによって想定と異なるビルドになることがありません。

ビルドコマンドはフロントエンドの生成とパッケージングをまとめて行うので、2 段階に分ける必要はありません。

## macOS

Xcode Command Line Tools が必要です。

```sh
xcode-select --install
npm run tauri -- build
```

成果物は `src-tauri/target/release/bundle/` 以下の `macos/Note&Pad.app` と `dmg/*.dmg` です。

ディスクイメージが不要で app ファイルだけでよい場合は `--bundles app` を付けてください。

最低対応バージョンは **macOS 13.3** で、`src-tauri/tauri.conf.json` の `bundle.macOS.minimumSystemVersion` に設定されています。

Apple Silicon と Intel の両方に対応させるには次のようにします。

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri -- build --target universal-apple-darwin
```

`universal-apple-darwin` は Tauri CLI 側の擬似ターゲットであり、rustup のターゲットではありません。CLI が内部で両方のアーキテクチャをそれぞれビルドし、`lipo` で結合する仕組みのため、実際の 2 つのターゲットを事前にインストールしておく必要があり、ビルド時間もおよそ 2 倍になります。

**初回起動は未署名のため Gatekeeper にブロックされます。** 次のどちらかで対処してください。

- Finder で app を右クリック →「開く」を選び、もう一度「開く」を押す。
- または隔離属性を解除する。

```sh
xattr -cr "/Applications/Note&Pad.app"
```

## Windows

以下の 2 つが必要です。

- **Visual Studio Build Tools**（「C++ によるデスクトップ開発」ワークロードを含む。MSVC コンパイラと Windows SDK が入ります）
- **WebView2 ランタイム**。Windows 11 には標準搭載されていますが、Windows 10 では入っていない場合は別途インストールが必要です。

```sh
npm run tauri -- build
```

成果物は `src-tauri\target\release\bundle\nsis\*-setup.exe` です。**生成されるのは NSIS インストーラーのみで、MSI は生成されません。** 製品名に含まれる `&` により、Tauri が生成する WiX ファイルが不正な XML になってしまうためです。

**ソースコードの配置パスに `&` を含めてはいけません。** `npm run` が生成する中間コマンドは、PowerShell によって `&` の位置で分断されてしまいます。ビルドは失敗しますが、エラーメッセージは `Cannot find module '...\@tauri-apps\cli\tauri.js'` となり、一見すると依存パッケージが壊れているように見えます。`git clone` で作られるフォルダー名は `note-n-pad` なのでこの問題は起きませんが、フォルダー名を自分で変更した場合は注意してください。

インストーラーは per-user インストールで、`%LOCALAPPDATA%\Note&Pad` にインストールされ、管理者権限は不要です。

上記のコマンドは実行しているマシンのアーキテクチャ向けにビルドされます。別のアーキテクチャ向けにビルドするには、先にターゲットを追加してから指定します。

```sh
rustup target add x86_64-pc-windows-msvc
npm run tauri -- build --target x86_64-pc-windows-msvc
```

ARM64 向けには `aarch64-pc-windows-msvc` に置き換えてください。どちら向きのクロスコンパイルも可能です。

インストーラーを実行すると、次の 2 つの関門に遭遇します。

- **SmartScreen** が青い警告画面を表示します。「詳細情報」→「実行」の順にクリックしてください。
- **Windows Defender がインストーラーを警告なしにそのまま隔離してしまうことがあります。** 警告ではなく隔離なので、ファイルが跡形もなく消え、ダブルクリックしても何も起きていないように見えます。未署名の NSIS インストーラーが機械学習ベースのヒューリスティックに誤検知されるのはよくあることです。Windows セキュリティの「保護の履歴」から復元するか、もう一度ビルドし直せば解決します。

ビルドやパッケージングで問題が発生した場合は、issue を立てて報告してください。<https://github.com/Lonshaus/note-n-pad/issues>。OS のバージョン、`node --version`、`rustc --version`、そして完全なエラーメッセージを添付してください。
