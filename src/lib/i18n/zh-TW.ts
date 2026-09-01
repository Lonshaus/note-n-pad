// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Traditional Chinese (Taiwan) — the master key set. Every user-visible string
// is declared here first; `en.ts` and `ja.ts` are type-checked against these
// keys, so a missing or extra translation fails `npm run check`.
export const zhTW = {
  // Settings — section rail
  'settings.section.general': '一般',
  'settings.section.sticky': '便利貼',
  'settings.section.editor': '編輯器',
  'settings.section.language': '語系',
  // Settings — appearance
  'settings.theme.light': '淺色',
  'settings.theme.dark': '深色',
  'settings.theme.customSuffix': '（自訂）',
  'settings.interface.label': '介面外觀',
  'settings.interface.system': '跟隨系統',
  'settings.theme.reset': '復原',
  'settings.theme.resetConfirm': '確定要把主題「{name}」還原成預設嗎？',
  'settings.theme.saveAsNew': '儲存成新主題',
  'settings.theme.import': '匯入主題',
  'settings.theme.export': '匯出主題',
  'settings.theme.delete': '刪除',
  'settings.theme.deleteConfirm': '確定要刪除主題「{name}」嗎？',
  'settings.theme.nameLabel': '主題名稱',
  'settings.theme.importError': '主題檔無法讀取或格式不符',
  'settings.theme.exportError':
    '無法匯出這個主題。磁碟空間可能不足，或存取權限可能已變更。',
  'settings.theme.group.editor': '編輯器',
  'settings.theme.group.ui': '介面',
  'settings.theme.group.syntax': '語法',
  'settings.theme.color.editorBg': '背景',
  'settings.theme.color.editorFg': '文字',
  'settings.theme.color.uiBg': '介面背景',
  'settings.theme.color.uiFg': '介面文字',
  'settings.theme.color.uiAccent': '強調色',
  'settings.theme.color.uiBorder': '邊框',
  'settings.theme.color.danger': '警示色',
  // Files a data folder held that could not be loaded (snapshots, themes,
  // locales). The reason names the case; `skipReasonKey` maps it.
  'skipped.heading': '有 {count} 個檔案無法載入',
  'skipped.snapshotHeading': '有 {count} 個便利貼或文件的快照無法載入',
  'skipped.windowHint':
    '這些檔案在開啟 Note&Pad 時無法載入，裡面的內容沒有顯示在任何視窗。',
  'skipped.reason.notJson': '不是 JSON 檔',
  'skipped.reason.unreadable': '讀取失敗',
  'skipped.reason.unparsable': '內容不是有效的 JSON',
  'skipped.reason.invalid': '內容有欄位不合格式',
  'skipped.reason.foreignId': '檔名與檔案內的 id 不符',
  'skipped.reason.duplicateId': 'id 與先載入的檔案重複',
  // One per platform, picked at runtime: the file browser has a different name
  // on each, and the native context menu already says it this way.
  'skipped.reveal.macos': '在 Finder 中顯示',
  'skipped.reveal.windows': '在檔案總管中顯示',
  'skipped.reveal.linux': '在檔案管理員中顯示',
  'skipped.delete': '刪除',
  'skipped.deleteConfirm': '確定要刪除檔案「{name}」嗎？',
  // Settings — sticky
  'settings.sticky.newNoteShortcut': '新增便利貼快速鍵',
  'settings.sticky.recording': '請按下組合鍵…',
  'settings.sticky.recordCancelHint': '按 Esc 取消',
  'settings.sticky.recordHint': '點擊後按下新的組合鍵',
  'settings.sticky.shortcutError': '無法設定此快速鍵',
  'settings.sticky.defaultSize': '預設便利貼尺寸',
  'settings.sticky.resetSize': '重設',
  // Settings — editor
  'settings.editor.wordWrap': '自動換行',
  'settings.editor.lineNumbers': '顯示行號',
  'settings.editor.workerHighlight': '為超大檔案啟用語法著色',
  'settings.editor.workerHighlightHint':
    '以背景處理超過門檻的檔案，顏色會較晚顯示；結構極複雜的內容仍可能緩慢並占用較多記憶體。',
  'settings.editor.font': '字型',
  'settings.editor.fontCustom': '自訂…',
  'settings.editor.fontDefault': '系統預設',
  'settings.editor.fontNamePlaceholder': '字型名稱',
  'settings.editor.fontSize': '字級',
  'settings.editor.fontSizeDecrease': '縮小',
  'settings.editor.fontSizeIncrease': '放大',
  'settings.editor.defaultLineEnding': '預設換行字元',
  'settings.editor.defaultEncoding': '預設編碼',
  'settings.editor.tabTheme': '主題',
  // Settings — general
  'settings.general.snapshotLocation': '快照儲存位置',
  'settings.general.snapshotChoose': '選擇資料夾…',
  'settings.general.snapshotReset': '回到預設位置',
  'settings.general.snapshotCloudHint':
    '指定在雲端硬碟時，便利貼可以跨裝置同步。文件的未儲存內容也存放在這裡，但不會跨裝置，因為檔案本身不一定在另一台裝置上。',
  'settings.general.snapshotMoveTitle': '要把現有的便利貼搬過去嗎？',
  'settings.general.snapshotMoveBody':
    '目前的資料夾裡有 {count} 張便利貼和未儲存的文件內容。不搬過去的話，它們不會再出現在 Note&Pad 裡，只會留在原本的資料夾。',
  'settings.general.snapshotMoveConfirm': '搬過去',
  'settings.general.snapshotMoveSkip': '不搬',
  'settings.general.snapshotCollisionTitle':
    '指定的資料夾裡已經有 {count} 張同樣的快照',
  'settings.general.snapshotCollisionSource': '以原本資料夾內的覆蓋',
  'settings.general.snapshotCollisionDest': '以指定資料夾內的覆蓋',
  'settings.general.snapshotCollisionBoth': '兩者皆保留',
  'settings.general.largeOpenMode': '大型檔案開啟模式',
  'settings.general.largeOpenModeAsk': '詢問（預設）',
  'settings.general.largeOpenModeView': '閱覽',
  'settings.general.largeOpenModeEdit': '編輯',
  'settings.general.openTarget': '開啟檔案方式',
  'settings.general.openTargetTab': '新分頁（預設）',
  'settings.general.openTargetWindow': '新視窗',
  'settings.general.showTrayIcon': '在狀態列顯示圖示',
  'settings.general.openWorkspaceOnStartup': '啟動時開啟工作區',
  // Settings — language (list lives on the language tab)
  'settings.language.label': '語言',
  'settings.language.system': '跟隨系統',
  'settings.language.import': '匯入語言',
  'settings.language.export': '匯出語言',
  'settings.language.delete': '刪除',
  'settings.language.deleteConfirm': '確定要刪除語言「{name}」嗎？',
  'settings.language.importError': '語言檔無法讀取或格式不符',
  'settings.language.reset': '復原',
  'settings.language.resetConfirm': '確定要將語言「{name}」還原成預設嗎？',
  'settings.language.customSuffix': '（自訂）',
  'settings.language.save': '儲存',
  'settings.language.updateFromJson': '以 JSON 更新',
  'settings.language.unsaved': '尚未儲存',
  'settings.language.discardConfirm':
    '有尚未儲存的變更，切換語言會捨棄它們。要繼續嗎？',
  'settings.language.followSystemHint': '選擇一個語言即可編輯它的字串',
  'settings.language.idMismatch':
    '這個檔案是其他語言（{id}），無法用來更新目前的語言',
  // Common actions, reused across dialogs and toolbars
  'common.open': '開啟',
  'common.cancel': '取消',
  'common.save': '儲存',
  'common.close': '關閉',
  // Shared dialogs
  'dialog.saveBeforeClose': '關閉前要儲存變更嗎？',
  'dialog.dontSave': '不儲存',
  // Document window
  'doc.untitled': '未命名',
  'doc.tab.close': '關閉分頁',
  'doc.tab.readonly': '唯讀',
  'doc.tab.unsaved': '未儲存',
  'doc.tab.new': '新增分頁',
  'doc.lock.oversized': '超大型檔案僅供閱覽',
  'doc.lock.restoring': '重新開啟中，暫僅供閱覽',
  'doc.lock.edit': '切換至編輯模式',
  'doc.lock.readOnlyFile': '此檔案為唯讀',
  'doc.large.confirm': '「{name}」大小為 {size}。',
  'doc.conflict.writeAnyway': '仍要寫回',
  'doc.conflict.saveAsNew': '另存新檔',
  'doc.rangeConflict.message': '原始檔案已被修改，寫回可能覆蓋其他變更。',
  'doc.windowedConflict.message':
    '原始檔案已被其他程式修改。寫回會以目前內容整檔覆蓋，外部變更將遺失。',
  'doc.oversized.message':
    '此分頁的未儲存內容過大，無法保留快照，關閉前必須處理。',
  'doc.oversized.discard': '放棄變更',
  'doc.snapshotFailed.message':
    '此分頁的未儲存內容無法寫入還原快照，關閉前必須處理。',
  'sticky.snapshotFailed.message':
    '這張便利貼的內容無法寫入還原快照，關閉前必須處理。',
  'doc.edit.notUtf8': '此檔案不是 UTF-8 編碼，無法編輯。',
  'doc.edit.cannot': '無法編輯此檔案。',
  'doc.edit.tooLarge': '此檔案過大，無法直接編輯。',
  'doc.unlock.notUtf8': '此檔案不是 UTF-8 編碼，無法編輯，仍可唯讀閱覽。',
  'doc.unlock.cannot': '無法編輯此檔案，仍可唯讀閱覽。',
  'doc.range.lossyRefusal':
    '此範圍含無法以 UTF-8 表示的內容，寫回會毀損檔案，僅能使用另存範圍',
  'doc.range.displayName': '{name}（第 {start}–{end} 行）',
  // Windowed editor — lock reasons (carry the raw failure detail)
  'editor.locked.write': '寫入失敗，編輯器已鎖定以避免內容錯亂：{detail}',
  'editor.locked.undo': '還原失敗，編輯器已鎖定：{detail}',
  'editor.locked.read': '讀取失敗，編輯器已鎖定：{detail}',
  'editor.locked.swap': '換窗失敗，編輯器已鎖定：{detail}',
  // Large-file view
  'large.gutter.title': '點選行號選取範圍（Shift 擴選）',
  'large.goto.placeholder': '行號',
  'large.goto.aria': '跳至行號',
  'large.range.info': '第 {start}–{end} 行（{count} 行，約 {size}）',
  'large.range.edit': '編輯此範圍',
  'large.range.saveAs': '另存範圍',
  'large.range.tooBig': '範圍約 {size}，超過上限 {max}，請縮小選取範圍。',
  'large.range.extractFailed':
    '無法讀取這個範圍。這個檔案可能已被移動、刪除，或變得無法讀取。',
  'large.range.saveFailed':
    '無法儲存這個範圍。磁碟空間可能不足，或存取權限可能已變更。',
  'large.search.label': '搜尋',
  'large.search.case': '大小寫',
  'large.search.searching': '搜尋中… {count} 筆',
  'large.search.results': '{count} 筆結果',
  'large.search.truncatedSuffix': '（已截斷）',
  'large.search.failed': '搜尋失敗。檔案可能已被移動，或無法讀取。',
  'large.index.failed':
    '無法完成「{name}」的索引建立。這個檔案目前無法顯示行數，也無法跳至指定行。',
  'large.read.failed':
    '無法讀取這個檔案的一部分。檔案可能已被移動，或變得無法讀取。',
  // Status bar
  'status.view': '閱覽',
  'status.indexing': '索引中… {count} 行',
  'status.lines': '{count} 行',
  'status.lineEnding': '換行字元',
  'status.encoding': '編碼',
  'status.language': '語言',
  'status.lossy': '以替代字元解碼，請改選其他編碼',
  'status.viewMode': '檢視方式',
  'status.viewTable': '表格',
  'status.viewSource': '原文',
  'status.viewTooLarge': '文件超過預覽上限，無法預覽',
  'status.viewUnavailableHere': '此檢視方式在視窗化編輯下無法使用',
  // Preview
  'preview.jsonError': 'JSON 語法錯誤：{detail}',
  'preview.jsonErrorAt':
    'JSON 語法錯誤（第 {line} 行第 {column} 字）：{detail}',
  'preview.xmlError': 'XML 語法錯誤：{detail}',
  'preview.xmlErrorAt': 'XML 語法錯誤（第 {line} 行第 {column} 字）：{detail}',
  // Table view
  'table.headerRow.title': '將第一列作為標題列（僅樣式）',
  'table.headerRow.label': '標題列',
  'table.selectAll': '全選表格',
  'table.selectCol': '選取欄',
  'table.selectRow': '選取列',
  'table.addRow.title': '新增列',
  'table.addRow.aria': '在結尾新增列',
  'table.addCol.title': '新增欄',
  'table.addCol.aria': '在結尾新增欄',
  'table.menu.rowAbove': '在上方插入列',
  'table.menu.rowBelow': '在下方插入列',
  'table.menu.rowDelete': '刪除列',
  'table.menu.colLeft': '在左方插入欄',
  'table.menu.colRight': '在右方插入欄',
  'table.menu.colDelete': '刪除欄',
  // About
  'about.version': '版本 {version}',
  'about.desc': '輕巧的便利貼與純文字編輯器。',
  'about.license': '以 GNU General Public License v3.0 授權釋出。',
  // Acknowledgements
  'acknowledgements.intro':
    'Note&Pad 使用下列開放原始碼套件建置而成，感謝其作者與貢獻者。',
  'acknowledgements.canonicalNote':
    '若套件本身未附授權條款檔案，則改為顯示其宣告授權條款的標準文字。',
  'acknowledgements.loadError': '無法載入授權清單：{detail}',
  // Privacy Policy
  'privacy.loadError': '無法載入隱私權政策：{detail}',
  // Sticky note window
  'sticky.pin.unpin': '取消釘選',
  'sticky.pin.pinnedApp': '已釘選至應用程式',
  'sticky.pin.onTop': '釘選在最上層',
  'sticky.pin.options': '釘選選項',
  'sticky.pin.alwaysOnTop': '總在最上層',
  'sticky.pin.toApp': '釘選至應用程式',
  'sticky.paperColor': '便條紙顏色',
  'sticky.opacity': '透明度',
  // Workspace
  'workspace.section.stickies': '便利貼',
  'workspace.stickies.empty': '沒有便利貼',
  'workspace.sticky.blank': '空白便利貼',
  'workspace.section.docs': '開啟的文件',
  'workspace.docs.empty': '沒有開啟的文件',
  'workspace.section.project': '專案',
  'workspace.project.refresh': '重新整理',
  'workspace.project.add': '加入專案資料夾',
  'workspace.project.empty': '未選擇專案',
  'workspace.project.loadError': '無法載入專案資料夾',
  'workspace.project.close': '關閉專案',
  'workspace.tree.newFile': '新增檔案',
  'workspace.tree.newFileAria': '在此資料夾新增檔案',
  'workspace.tree.newFolder': '新增資料夾',
  'workspace.tree.newFolderAria': '在此資料夾新增子資料夾',
  // Long-line handling
  'status.longLine.worker': '超長行：語法著色改走背景執行緒',
  'status.longLine.disabled': '超長行：語法著色已停用',
  'status.longLine.reason':
    '這個檔案有超長的行，每次按鍵都要同步解析會拖慢輸入。',
  'doc.openFailed':
    '無法開啟「{name}」。這個檔案可能已被移動或刪除，或是檔案名稱含有這個應用程式不支援的字元。',
  'doc.revealFailed': '無法顯示「{name}」。這個檔案可能已被移動或刪除。',
  'doc.saveFailed': '無法儲存「{name}」：{error}',
  'doc.saveReadOnly':
    '「{name}」是唯讀檔案，因此未儲存任何內容。請變更該檔案的權限後再儲存。',
  'sticky.saveFailed': '無法儲存這則便利貼：{error}',
  'sticky.saveReadOnly':
    '「{name}」是唯讀檔案，因此這則便利貼未被儲存。請變更該檔案的權限後再儲存。',
  'doc.encodingFailed':
    '無法變更「{name}」的編碼。這個檔案可能已被移動、刪除，或變得無法讀取。',
  'settings.saveFailed':
    '無法儲存這項變更。設定檔可能是唯讀的，或磁碟空間不足。',
  'settings.loadRepaired': '部分設定值無法讀取，已重設為預設值。',
  'settings.snapshotDirUnavailable':
    '你選擇的快照資料夾無法使用，目前暫時改用預設資料夾。',
  'doc.longLine.confirm': '「{name}」包含超長的行，可能拖慢編輯。要如何開啟？',
  'doc.longLine.openAsIs': '原樣開啟',
  'doc.longLine.format': '格式化後開啟',
  'doc.longLine.softWrap': '軟斷行開啟',
  'settings.general.askLongLineOpen': '開啟含超長行的檔案時詢問',
  'settings.general.previewLocalResources': '預覽顯示本機圖片與可點擊連結',
  // Settings — general, Windows only
  'settings.general.defaultApps': '預設開啟的檔案類型',
  'settings.general.defaultAppsOpen': '開啟 Windows 設定',
} as const;
