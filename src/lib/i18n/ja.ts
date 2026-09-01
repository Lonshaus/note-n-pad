// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { I18nKey } from './index';

// Japanese. Uses concise UI conventions (体言止め / short imperatives), not
// polite です・ます prose. `satisfies` enforces the exact master key set.
export const ja = {
  // Settings — section rail
  'settings.section.general': '一般',
  'settings.section.sticky': '付箋',
  'settings.section.editor': 'エディター',
  'settings.section.language': '言語',
  // Settings — appearance
  'settings.theme.light': 'ライト',
  'settings.theme.dark': 'ダーク',
  'settings.theme.customSuffix': '（カスタム）',
  'settings.interface.label': '外観',
  'settings.interface.system': 'システムに従う',
  'settings.theme.reset': '元に戻す',
  'settings.theme.resetConfirm': 'テーマ「{name}」を既定に戻しますか？',
  'settings.theme.saveAsNew': '新しいテーマとして保存',
  'settings.theme.import': 'テーマをインポート',
  'settings.theme.export': 'テーマをエクスポート',
  'settings.theme.delete': '削除',
  'settings.theme.deleteConfirm': 'テーマ「{name}」を削除しますか？',
  'settings.theme.nameLabel': 'テーマ名',
  'settings.theme.importError':
    'テーマファイルを読み込めないか、形式が正しくありません',
  'settings.theme.exportError':
    'このテーマをエクスポートできません。ディスクの空き容量が不足しているか、権限が変更された可能性があります。',
  'settings.theme.group.editor': 'エディター',
  'settings.theme.group.ui': 'インターフェース',
  'settings.theme.group.syntax': '構文',
  'settings.theme.color.editorBg': '背景',
  'settings.theme.color.editorFg': '文字',
  'settings.theme.color.uiBg': 'インターフェース背景',
  'settings.theme.color.uiFg': 'インターフェース文字',
  'settings.theme.color.uiAccent': 'アクセント',
  'settings.theme.color.uiBorder': '枠線',
  'settings.theme.color.danger': '警告色',
  // Files a data folder held that could not be loaded (snapshots, themes,
  // locales). The reason names the case; `skipReasonKey` maps it.
  'skipped.heading': '{count} 件のファイルを読み込めませんでした',
  'skipped.snapshotHeading':
    '{count} 件の付箋・書類のスナップショットを読み込めませんでした',
  'skipped.windowHint':
    'Note&Pad の起動時にこれらのファイルを読み込めなかったため、その内容はどのウィンドウにも表示されていません。',
  'skipped.reason.notJson': 'JSON ファイルではありません',
  'skipped.reason.unreadable': '読み取れませんでした',
  'skipped.reason.unparsable': '有効な JSON ではありません',
  'skipped.reason.invalid': '項目の形式が正しくありません',
  'skipped.reason.foreignId': 'ファイル名と中の id が一致しません',
  'skipped.reason.duplicateId': 'id が先に読み込んだファイルと重複しています',
  // One per platform, picked at runtime: the file browser has a different name
  // on each, and the native context menu already says it this way.
  'skipped.reveal.macos': 'Finder で表示',
  'skipped.reveal.windows': 'エクスプローラーで表示',
  'skipped.reveal.linux': 'ファイルマネージャーで表示',
  'skipped.delete': '削除',
  'skipped.deleteConfirm': 'ファイル「{name}」を削除しますか？',
  // Settings — sticky
  'settings.sticky.newNoteShortcut': '付箋作成のショートカット',
  'settings.sticky.recording': 'キーの組み合わせを入力',
  'settings.sticky.recordCancelHint': 'Esc でキャンセル',
  'settings.sticky.recordHint': 'クリックして新しいキーの組み合わせを入力',
  'settings.sticky.shortcutError': 'このショートカットは設定できません',
  'settings.sticky.defaultSize': '付箋の既定サイズ',
  'settings.sticky.resetSize': 'リセット',
  // Settings — editor
  'settings.editor.wordWrap': '自動折り返し',
  'settings.editor.lineNumbers': '行番号を表示',
  'settings.editor.workerHighlight':
    '大きなファイルでも構文ハイライトを有効にする',
  'settings.editor.workerHighlightHint':
    'しきい値を超えるファイルはバックグラウンドで処理するため、色付けは遅れて表示されます。非常に複雑な内容では動作が遅くなり、メモリ使用量が増える場合があります。',
  'settings.editor.font': 'フォント',
  'settings.editor.fontCustom': 'カスタム…',
  'settings.editor.fontDefault': 'システム標準',
  'settings.editor.fontNamePlaceholder': 'フォント名',
  'settings.editor.fontSize': '文字サイズ',
  'settings.editor.fontSizeDecrease': '小さく',
  'settings.editor.fontSizeIncrease': '大きく',
  'settings.editor.defaultLineEnding': '既定の改行コード',
  'settings.editor.defaultEncoding': '既定のエンコーディング',
  'settings.editor.tabTheme': 'テーマ',
  // Settings — general
  'settings.general.snapshotLocation': 'スナップショットの保存先',
  'settings.general.snapshotChoose': 'フォルダを選択…',
  'settings.general.snapshotReset': '既定の場所に戻す',
  'settings.general.snapshotMoveTitle': '既存の付箋を移動しますか？',
  'settings.general.snapshotMoveBody':
    '現在のフォルダーには{count}件の付箋と未保存の文書内容があります。移動しない場合、それらはNote&Padに表示されなくなり、元のフォルダーに残ります。',
  'settings.general.snapshotMoveConfirm': '移動する',
  'settings.general.snapshotMoveSkip': '移動しない',
  'settings.general.snapshotCollisionTitle':
    '指定したフォルダーには既に{count}件の同じスナップショットがあります',
  'settings.general.snapshotCollisionSource': '元のフォルダーの内容で上書き',
  'settings.general.snapshotCollisionDest': '指定したフォルダーの内容で上書き',
  'settings.general.snapshotCollisionBoth': '両方とも保持',
  'settings.general.snapshotCloudHint':
    'クラウドドライブを指定すると、付箋がデバイス間で同期されます。ドキュメントの未保存の内容もここに保存されますが、そちらは同期されません。ファイル自体が別のデバイスにあるとは限らないためです。',
  'settings.general.largeOpenMode': '大きなファイルの開き方',
  'settings.general.largeOpenModeAsk': '毎回確認（既定）',
  'settings.general.largeOpenModeView': '閲覧',
  'settings.general.largeOpenModeEdit': '編集',
  'settings.general.openTarget': 'ファイルの開き方',
  'settings.general.openTargetTab': '新しいタブ（既定）',
  'settings.general.openTargetWindow': '新しいウィンドウ',
  'settings.general.showTrayIcon': 'ステータスバーにアイコンを表示',
  'settings.general.openWorkspaceOnStartup': '起動時にワークスペースを開く',
  // Settings — language (list lives on the language tab)
  'settings.language.label': '言語',
  'settings.language.system': 'システムに合わせる',
  'settings.language.import': '言語をインポート',
  'settings.language.export': '言語をエクスポート',
  'settings.language.delete': '削除',
  'settings.language.deleteConfirm': '言語「{name}」を削除しますか？',
  'settings.language.importError':
    '言語ファイルを読み込めないか、形式が不正です',
  'settings.language.reset': '元に戻す',
  'settings.language.resetConfirm': '言語「{name}」を既定に戻しますか？',
  'settings.language.customSuffix': '（カスタム）',
  'settings.language.save': '保存',
  'settings.language.updateFromJson': 'JSON で更新',
  'settings.language.unsaved': '未保存',
  'settings.language.discardConfirm':
    '未保存の変更があります。言語を切り替えると破棄されます。続けますか？',
  'settings.language.followSystemHint': '編集する言語を選択',
  'settings.language.idMismatch':
    'このファイルは別の言語（{id}）のため、現在の言語を更新できません',
  // Common actions, reused across dialogs and toolbars
  'common.open': '開く',
  'common.cancel': 'キャンセル',
  'common.save': '保存',
  'common.close': '閉じる',
  // Shared dialogs
  'dialog.saveBeforeClose': '閉じる前に変更を保存する？',
  'dialog.dontSave': '保存しない',
  // Document window
  'doc.untitled': '無題',
  'doc.tab.close': 'タブを閉じる',
  'doc.tab.readonly': '読み取り専用',
  'doc.tab.unsaved': '未保存',
  'doc.tab.new': '新しいタブ',
  'doc.lock.oversized': '特大ファイルは閲覧のみ',
  'doc.lock.restoring': '再読み込み中は閲覧のみ',
  'doc.lock.edit': '編集モードに切り替え',
  'doc.lock.readOnlyFile': 'このファイルは読み取り専用です',
  'doc.large.confirm': '「{name}」のサイズは {size}。',
  'doc.conflict.writeAnyway': 'それでも書き戻す',
  'doc.conflict.saveAsNew': '別名で保存',
  'doc.rangeConflict.message':
    '元のファイルが変更されています。書き戻すと他の変更を上書きする可能性があります。',
  'doc.windowedConflict.message':
    '元のファイルが別のプログラムによって変更されています。書き戻すと現在の内容でファイル全体を上書きし、外部の変更は失われます。',
  'doc.oversized.message':
    'このタブの未保存の内容は大きすぎてスナップショットを保持できません。閉じる前に処理が必要です。',
  'doc.oversized.discard': '変更を破棄',
  'doc.snapshotFailed.message':
    'このタブの未保存の内容を復元用スナップショットに保存できませんでした。閉じる前に処理が必要です。',
  'sticky.snapshotFailed.message':
    'この付箋の内容を復元用スナップショットに保存できませんでした。閉じる前に処理が必要です。',
  'doc.edit.notUtf8': 'このファイルは UTF-8 ではないため編集できません。',
  'doc.edit.cannot': 'このファイルは編集できません。',
  'doc.edit.tooLarge': 'このファイルは大きすぎるため編集できません。',
  'doc.unlock.notUtf8':
    'このファイルは UTF-8 ではないため編集できません。閲覧のみ可能です。',
  'doc.unlock.cannot': 'このファイルは編集できません。閲覧のみ可能です。',
  'doc.range.lossyRefusal':
    'この範囲には UTF-8 で表現できない内容が含まれます。書き戻すとファイルが破損するため、「範囲を保存」のみ利用できます',
  'doc.range.displayName': '{name}（{start}–{end} 行目）',
  // Windowed editor — lock reasons (carry the raw failure detail)
  'editor.locked.write':
    '書き込みに失敗。内容の破損を防ぐためエディターをロック：{detail}',
  'editor.locked.undo': '取り消しに失敗。エディターをロック：{detail}',
  'editor.locked.read': '読み込みに失敗。エディターをロック：{detail}',
  'editor.locked.swap':
    'ウィンドウ切り替えに失敗。エディターをロック：{detail}',
  // Large-file view
  'large.gutter.title': '行番号をクリックして範囲を選択（Shift で拡張）',
  'large.goto.placeholder': '行番号',
  'large.goto.aria': '指定行へ移動',
  'large.range.info': '{start}–{end} 行目（{count} 行、約 {size}）',
  'large.range.edit': 'この範囲を編集',
  'large.range.saveAs': '範囲を保存',
  'large.range.tooBig':
    '範囲は約 {size} で上限 {max} を超えます。選択を狭めてください。',
  'large.range.extractFailed':
    'この範囲を読み込めません。ファイルが移動・削除されたか、読み取れなくなった可能性があります。',
  'large.range.saveFailed':
    'この範囲を保存できません。ディスクの空き容量が不足しているか、権限が変更された可能性があります。',
  'large.search.label': '検索',
  'large.search.case': '大文字と小文字',
  'large.search.searching': '検索中… {count} 件',
  'large.search.results': '{count} 件',
  'large.search.truncatedSuffix': '（切り捨て）',
  'large.search.failed':
    '検索に失敗しました。ファイルが移動されたか、読み取れなくなった可能性があります。',
  'large.index.failed':
    '「{name}」のインデックス作成を完了できませんでした。このファイルでは行数の表示と指定行への移動は使用できません。',
  'large.read.failed':
    'このファイルの一部を読み込めません。ファイルが移動されたか、読み取れなくなった可能性があります。',
  // Status bar
  'status.view': '閲覧',
  'status.indexing': 'インデックス作成中… {count} 行',
  'status.lines': '{count} 行',
  'status.lineEnding': '改行コード',
  'status.encoding': 'エンコーディング',
  'status.language': '言語',
  'status.lossy': '置換文字でデコードされました。別のエンコーディングを選択',
  'status.viewMode': '表示方法',
  'status.viewTable': 'テーブル',
  'status.viewSource': 'ソース',
  'status.viewTooLarge':
    'このドキュメントはプレビューできる大きさを超えています',
  'status.viewUnavailableHere':
    'このビューはウィンドウ編集モードでは利用できません',
  // Preview
  'preview.jsonError': 'JSON の構文エラー: {detail}',
  'preview.jsonErrorAt':
    'JSON の構文エラー（行 {line}、列 {column}）: {detail}',
  'preview.xmlError': 'XML の構文エラー: {detail}',
  'preview.xmlErrorAt': 'XML の構文エラー（行 {line}、列 {column}）: {detail}',
  // Table view
  'table.headerRow.title': '最初の行をヘッダー行にする（スタイルのみ）',
  'table.headerRow.label': 'ヘッダー行',
  'table.selectAll': 'テーブル全体を選択',
  'table.selectCol': '列を選択',
  'table.selectRow': '行を選択',
  'table.addRow.title': '行を追加',
  'table.addRow.aria': '末尾に行を追加',
  'table.addCol.title': '列を追加',
  'table.addCol.aria': '末尾に列を追加',
  'table.menu.rowAbove': '上に行を挿入',
  'table.menu.rowBelow': '下に行を挿入',
  'table.menu.rowDelete': '行を削除',
  'table.menu.colLeft': '左に列を挿入',
  'table.menu.colRight': '右に列を挿入',
  'table.menu.colDelete': '列を削除',
  // About
  'about.version': 'バージョン {version}',
  'about.desc': '軽量な付箋とプレーンテキストエディター。',
  'about.license': 'GNU General Public License v3.0 のもとで公開。',
  // Acknowledgements
  'acknowledgements.intro':
    'Note&Pad は以下のオープンソースパッケージを使用して構築されています。作者および貢献者の皆様に感謝します。',
  'acknowledgements.canonicalNote':
    'パッケージ自体にライセンスファイルが同梱されていない場合は、宣言されたライセンスの正規テキストを代わりに表示します。',
  'acknowledgements.loadError': 'ライセンス一覧の読み込みに失敗：{detail}',
  // Privacy Policy
  'privacy.loadError': 'プライバシーポリシーの読み込みに失敗：{detail}',
  // Sticky note window
  'sticky.pin.unpin': 'ピン解除',
  'sticky.pin.pinnedApp': 'アプリにピン留め中',
  'sticky.pin.onTop': '最前面にピン留め',
  'sticky.pin.options': 'ピンのオプション',
  'sticky.pin.alwaysOnTop': '常に最前面',
  'sticky.pin.toApp': 'アプリにピン留め',
  'sticky.paperColor': '付箋の色',
  'sticky.opacity': '不透明度',
  // Workspace
  'workspace.section.stickies': '付箋',
  'workspace.stickies.empty': '付箋なし',
  'workspace.sticky.blank': '空の付箋',
  'workspace.section.docs': '開いているドキュメント',
  'workspace.docs.empty': '開いているドキュメントなし',
  'workspace.section.project': 'プロジェクト',
  'workspace.project.refresh': '再読み込み',
  'workspace.project.add': 'プロジェクトフォルダーを追加',
  'workspace.project.empty': 'プロジェクト未選択',
  'workspace.project.loadError': 'プロジェクトフォルダーを読み込めません',
  'workspace.project.close': 'プロジェクトを閉じる',
  'workspace.tree.newFile': '新規ファイル',
  'workspace.tree.newFileAria': 'このフォルダーに新規ファイル',
  'workspace.tree.newFolder': '新規フォルダー',
  'workspace.tree.newFolderAria': 'このフォルダーにサブフォルダーを作成',
  // Long-line handling
  'status.longLine.worker':
    '長い行：シンタックスハイライトをバックグラウンドスレッドで実行',
  'status.longLine.disabled': '長い行：シンタックスハイライトを無効化',
  'status.longLine.reason':
    'このファイルには非常に長い行があり、キー入力ごとの解析で入力が遅くなります。',
  'doc.openFailed':
    '「{name}」を開けません。ファイルが移動・削除されたか、ファイル名にこのアプリが対応していない文字が含まれている可能性があります。',
  'doc.revealFailed':
    '「{name}」を表示できません。ファイルが移動または削除された可能性があります。',
  'doc.saveFailed': '「{name}」を保存できません：{error}',
  'doc.saveReadOnly':
    '「{name}」は読み取り専用のため、保存されませんでした。ファイルの権限を変更してから保存してください。',
  'sticky.saveFailed': 'この付箋を保存できません：{error}',
  'sticky.saveReadOnly':
    '「{name}」は読み取り専用のため、この付箋は保存されませんでした。ファイルの権限を変更してから保存してください。',
  'doc.encodingFailed':
    '「{name}」のエンコーディングを変更できません。ファイルが移動・削除されたか、読み取れなくなった可能性があります。',
  'settings.saveFailed':
    'この変更を保存できません。設定ファイルが読み取り専用か、ディスクの空き容量が不足している可能性があります。',
  'settings.loadRepaired':
    '一部の設定を読み込めなかったため、既定値にリセットされました。',
  'settings.snapshotDirUnavailable':
    '選択したスナップショットフォルダーを利用できないため、現在は既定のフォルダーを使用しています。',
  'doc.longLine.confirm':
    '「{name}」には非常に長い行が含まれ、編集が遅くなることがあります。どのように開きますか？',
  'doc.longLine.openAsIs': 'そのまま開く',
  'doc.longLine.format': '整形して開く',
  'doc.longLine.softWrap': 'ソフト改行して開く',
  'settings.general.askLongLineOpen':
    '非常に長い行を含むファイルを開くとき確認する',
  'settings.general.previewLocalResources':
    'プレビューでローカル画像とリンクを有効にする',
  // Settings — general, Windows only
  'settings.general.defaultApps': '既定で開くファイルの種類',
  'settings.general.defaultAppsOpen': 'Windows の設定を開く',
} satisfies Record<I18nKey, string>;
