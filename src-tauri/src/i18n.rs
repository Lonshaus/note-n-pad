// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Rust-side localization for native menus (app menu, tray, context menus). The
// frontend has its own typed dictionary; this module mirrors the same locales
// for strings the WebView never renders. Missing a translation is a compile
// error: `strings` is exhaustive over `Key` and `tr` is exhaustive over
// `Locale`, matching the frontend's `satisfies` guarantee.

/// A concrete UI language the native menus render in. Mirrors the frontend
/// `Locale` union. Every variant has its own native-menu translation.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Locale {
  ZhTw,
  ZhCn,
  Ja,
  En,
  Ru,
  Es,
  PtBr,
  De,
  Fr,
  Ko,
  Pl,
  Tr,
  It,
  Th,
  Vi,
}

/// Every native-menu string key. Adding a variant without a `strings` arm fails
/// to compile, so a menu label can never ship untranslated.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Key {
  // App menu
  About,
  Settings,
  Quit,
  // File submenu
  FileMenu,
  NewSticky,
  NewTab,
  Open,
  Save,
  Close,
  // Edit submenu
  EditMenu,
  // Predefined Edit items: Tauri's PredefinedMenuItem defaults are English-only,
  // so we pass these translations in explicitly at build/rebuild time.
  Undo,
  Redo,
  Cut,
  Copy,
  Paste,
  SelectAll,
  Find,
  FindReplace,
  FindNext,
  FindPrev,
  // File submenu additions (menu-bar overhaul)
  SaveAs,
  OpenRecent,
  ClearMenu,
  CopyFilePath,
  // Format submenu
  FormatMenu,
  LineEndingMenu,
  Encoding,
  Syntax,
  WordWrap,
  // View submenu
  ViewMenu,
  LineNumbers,
  // Window submenu
  WindowMenu,
  // Predefined Window item, same reason as the Edit ones above.
  Minimize,
  // Predefined Window items (Zoom is the Maximize role; Bring All to Front is
  // its own role), localized the same way as the Edit predefined items.
  Zoom,
  BringAllToFront,
  // Per-window always-on-top toggle in the Window menu.
  AlwaysOnTop,
  Workspace,
  // Settings window title. The menu's Settings key carries a trailing ellipsis
  // (it opens a window), which a window title must not, so it needs its own key.
  SettingsTitle,
  // Help submenu. KeyboardShortcuts labels both the menu item and its window
  // title, the same way Workspace does for its own window.
  HelpMenu,
  Documentation,
  ReportIssue,
  KeyboardShortcuts,
  // Acknowledgements labels both the menu item and its window title, the same
  // way KeyboardShortcuts and Workspace do for their own windows.
  Acknowledgements,
  // Privacy Policy labels both the menu item and its window title, the same
  // way Acknowledgements does for its own window.
  PrivacyPolicy,
  // Rows in the Keyboard Shortcuts window for shortcuts that have no menu
  // item, so they never appear in the menu-driven `ACCELERATOR_TABLE`. Each
  // pair is a section heading plus the row it labels.
  TabsSection,
  NextTab,
  PrevTab,
  LargeFileSection,
  GoToLine,
  // macOS Dock right-click menu and the Windows Jump List, which reuses these
  // same labels. Both builders are platform-gated, so on Linux nothing
  // constructs these four and the exemption below is what keeps the dead-code
  // lint honest there without silencing it for the rest of the enum.
  // Action item that opens the workspace; shown only while the workspace window
  // is not visible (a visible one is already in the system window list).
  #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
  DockOpenWorkspace,
  // Fallback label for a blank sticky listed in the Dock menu.
  #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
  DockBlankSticky,
  // Non-clickable section header above the sticky list in the Dock menu.
  #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
  DockStickiesSection,
  // Non-clickable section header above the open-document list in the Dock menu.
  #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
  DockDocumentsSection,
  // Title for a document window with no file yet (untitled), set at window birth
  // so macOS never shows its own empty-title placeholder before the frontend loads.
  UntitledDocument,
  // Title of a sticky window (invisible in normal use — stickies are frameless —
  // but surfaces in the Windows taskbar/Alt-Tab and some Linux WM switchers).
  // Singular, unlike `DockStickiesSection`'s plural section header: a taskbar
  // full of stickies must not show an identical plural label on every entry.
  StickyWindowTitle,
  // Tray (Workspace and Settings are reused from above)
  TrayNewNote,
  TrayShowAll,
  TrayQuit,
  // Context menus (Close is reused from File)
  CtxOpen,
  CtxOpenSelected,
  CtxNewFile,
  CtxNewFolder,
  CtxShowInFinder,
  CtxRename,
  CtxDelete,
  CtxSaveAsDoc,
  CtxCloseTab,
  // Fatal startup message shown in a native message box on Windows when the
  // WebView2 Runtime is absent (see `webview2_runtime`). No webview can exist at
  // point, so this is the only text the user will ever see.
  #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
  WebView2MissingTitle,
  #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
  WebView2MissingBody,
}

/// The translations for a key, one per locale in `Locale`-enum order:
/// `[zh-TW, zh-CN, ja, en, ru, es, pt-BR, de, fr, ko, pl, tr, it, th, vi]`.
/// Japanese uses the concise UI conventions (体言止め / short imperatives) of the
/// frontend dictionary. Wording tracks the frontend where an equivalent term
/// already exists.
fn strings(key: Key) -> [&'static str; 15] {
  match key {
    Key::About => [
      "關於 Note&Pad",
      "关于 Note&Pad",
      "Note&Pad について",
      "About Note&Pad",
      "О приложении Note&Pad",
      "Acerca de Note&Pad",
      "Sobre o Note&Pad",
      "Über Note&Pad",
      "À propos de Note&Pad",
      "Note&Pad 정보",
      "O programie Note&Pad",
      "Note&Pad Hakkında",
      "Informazioni su Note&Pad",
      "เกี่ยวกับ Note&Pad",
      "Giới thiệu Note&Pad",
    ],
    Key::Settings => [
      "設定…",
      "设置…",
      "設定…",
      "Settings…",
      "Настройки…",
      "Configuración…",
      "Configurações…",
      "Einstellungen…",
      "Réglages…",
      "설정…",
      "Ustawienia…",
      "Ayarlar…",
      "Impostazioni…",
      "การตั้งค่า…",
      "Cài đặt…",
    ],
    Key::Quit => [
      "結束 Note&Pad",
      "退出 Note&Pad",
      "Note&Pad を終了",
      "Quit Note&Pad",
      "Завершить Note&Pad",
      "Salir de Note&Pad",
      "Sair do Note&Pad",
      "Note&Pad beenden",
      "Quitter Note&Pad",
      "Note&Pad 종료",
      "Zakończ Note&Pad",
      "Note&Pad’ten Çık",
      "Esci da Note&Pad",
      "ออกจาก Note&Pad",
      "Thoát Note&Pad",
    ],
    Key::FileMenu => [
      "檔案",
      "文件",
      "ファイル",
      "File",
      "Файл",
      "Archivo",
      "Arquivo",
      "Datei",
      "Fichier",
      "파일",
      "Plik",
      "Dosya",
      "File",
      "ไฟล์",
      "Tệp",
    ],
    Key::NewSticky => [
      "新增便利貼",
      "新建便签",
      "新しい付箋",
      "New Sticky",
      "Новая заметка",
      "Nueva nota adhesiva",
      "Nova nota adesiva",
      "Neue Haftnotiz",
      "Nouveau pense-bête",
      "새 메모지",
      "Nowa karteczka",
      "Yeni Yapışkan Not",
      "Nuovo foglietto",
      "โน้ตกระดาษใหม่",
      "Ghi chú dán mới",
    ],
    Key::NewTab => [
      "新增分頁",
      "新建标签页",
      "新しいタブ",
      "New Tab",
      "Новая вкладка",
      "Nueva pestaña",
      "Nova aba",
      "Neuer Tab",
      "Nouvel onglet",
      "새 탭",
      "Nowa karta",
      "Yeni Sekme",
      "Nuova scheda",
      "แท็บใหม่",
      "Thẻ mới",
    ],
    Key::Open => [
      "開啟…",
      "打开…",
      "開く…",
      "Open…",
      "Открыть…",
      "Abrir…",
      "Abrir…",
      "Öffnen…",
      "Ouvrir…",
      "열기…",
      "Otwórz…",
      "Aç…",
      "Apri…",
      "เปิด…",
      "Mở…",
    ],
    Key::Save => [
      "儲存",
      "保存",
      "保存",
      "Save",
      "Сохранить",
      "Guardar",
      "Salvar",
      "Speichern",
      "Enregistrer",
      "저장",
      "Zapisz",
      "Kaydet",
      "Salva",
      "บันทึก",
      "Lưu",
    ],
    Key::Close => [
      "關閉",
      "关闭",
      "閉じる",
      "Close",
      "Закрыть",
      "Cerrar",
      "Fechar",
      "Schließen",
      "Fermer",
      "닫기",
      "Zamknij",
      "Kapat",
      "Chiudi",
      "ปิด",
      "Đóng",
    ],
    Key::EditMenu => [
      "編輯",
      "编辑",
      "編集",
      "Edit",
      "Правка",
      "Edición",
      "Editar",
      "Bearbeiten",
      "Édition",
      "편집",
      "Edycja",
      "Düzen",
      "Modifica",
      "แก้ไข",
      "Chỉnh sửa",
    ],
    Key::Undo => [
      "復原",
      "撤销",
      "元に戻す",
      "Undo",
      "Отменить",
      "Deshacer",
      "Desfazer",
      "Rückgängig",
      "Annuler",
      "실행 취소",
      "Cofnij",
      "Geri Al",
      "Annulla",
      "เลิกทำ",
      "Hoàn tác",
    ],
    Key::Redo => [
      "重做",
      "重做",
      "やり直す",
      "Redo",
      "Повторить",
      "Rehacer",
      "Refazer",
      "Wiederholen",
      "Rétablir",
      "다시 실행",
      "Ponów",
      "Yinele",
      "Ripristina",
      "ทำซ้ำ",
      "Làm lại",
    ],
    Key::Cut => [
      "剪下",
      "剪切",
      "カット",
      "Cut",
      "Вырезать",
      "Cortar",
      "Recortar",
      "Ausschneiden",
      "Couper",
      "잘라내기",
      "Wytnij",
      "Kes",
      "Taglia",
      "ตัด",
      "Cắt",
    ],
    Key::Copy => [
      "拷貝",
      "复制",
      "コピー",
      "Copy",
      "Копировать",
      "Copiar",
      "Copiar",
      "Kopieren",
      "Copier",
      "복사",
      "Kopiuj",
      "Kopyala",
      "Copia",
      "คัดลอก",
      "Sao chép",
    ],
    Key::Paste => [
      "貼上",
      "粘贴",
      "ペースト",
      "Paste",
      "Вставить",
      "Pegar",
      "Colar",
      "Einfügen",
      "Coller",
      "붙여넣기",
      "Wklej",
      "Yapıştır",
      "Incolla",
      "วาง",
      "Dán",
    ],
    Key::SelectAll => [
      "全選",
      "全选",
      "すべてを選択",
      "Select All",
      "Выделить все",
      "Seleccionar todo",
      "Selecionar tudo",
      "Alles auswählen",
      "Tout sélectionner",
      "전체 선택",
      "Zaznacz wszystko",
      "Tümünü Seç",
      "Seleziona tutto",
      "เลือกทั้งหมด",
      "Chọn tất cả",
    ],
    Key::Find => [
      "尋找…",
      "查找…",
      "検索…",
      "Find…",
      "Найти…",
      "Buscar…",
      "Localizar…",
      "Suchen…",
      "Rechercher…",
      "찾기…",
      "Znajdź…",
      "Bul…",
      "Trova…",
      "ค้นหา…",
      "Tìm…",
    ],
    Key::FindReplace => [
      "尋找與取代…",
      "查找与替换…",
      "検索と置換…",
      "Find and Replace…",
      "Найти и заменить…",
      "Buscar y reemplazar…",
      "Localizar e substituir…",
      "Suchen und Ersetzen…",
      "Rechercher et remplacer…",
      "찾기 및 바꾸기…",
      "Znajdź i zamień…",
      "Bul ve Değiştir…",
      "Trova e sostituisci…",
      "ค้นหาและแทนที่…",
      "Tìm và thay thế…",
    ],
    Key::FindNext => [
      "找下一個",
      "查找下一个",
      "次を検索",
      "Find Next",
      "Найти далее",
      "Buscar siguiente",
      "Localizar próxima",
      "Weitersuchen",
      "Rechercher le suivant",
      "다음 찾기",
      "Znajdź następny",
      "Sonrakini Bul",
      "Trova successivo",
      "ค้นหาถัดไป",
      "Tìm tiếp",
    ],
    Key::FindPrev => [
      "找上一個",
      "查找上一个",
      "前を検索",
      "Find Previous",
      "Найти ранее",
      "Buscar anterior",
      "Localizar anterior",
      "Vorheriges suchen",
      "Rechercher le précédent",
      "이전 찾기",
      "Znajdź poprzedni",
      "Öncekini Bul",
      "Trova precedente",
      "ค้นหาก่อนหน้า",
      "Tìm trước",
    ],
    Key::SaveAs => [
      "另存新檔…",
      "另存为…",
      "別名で保存…",
      "Save As…",
      "Сохранить как…",
      "Guardar como…",
      "Salvar como…",
      "Sichern unter…",
      "Enregistrer sous…",
      "다른 이름으로 저장…",
      "Zapisz jako…",
      "Farklı Kaydet…",
      "Salva col nome…",
      "บันทึกเป็น…",
      "Lưu thành…",
    ],
    Key::OpenRecent => [
      "開啟最近使用",
      "打开最近使用",
      "最近使ったファイルを開く",
      "Open Recent",
      "Недавние документы",
      "Abrir reciente",
      "Abrir recente",
      "Benutzte Dokumente",
      "Ouvrir l’élément récent",
      "최근 사용 열기",
      "Otwórz ostatnie",
      "Son Kullanılanı Aç",
      "Apri recenti",
      "เปิดที่ใช้ล่าสุด",
      "Mở gần đây",
    ],
    Key::ClearMenu => [
      "清除選單",
      "清除菜单",
      "メニューをクリア",
      "Clear Menu",
      "Очистить меню",
      "Vaciar menú",
      "Limpar menu",
      "Einträge löschen",
      "Effacer le menu",
      "메뉴 지우기",
      "Wyczyść menu",
      "Menüyü Temizle",
      "Vuota menu",
      "ล้างเมนู",
      "Xóa menu",
    ],
    Key::CopyFilePath => [
      "拷貝檔案路徑",
      "复制文件路径",
      "ファイルパスをコピー",
      "Copy File Path",
      "Скопировать путь к файлу",
      "Copiar ruta del archivo",
      "Copiar caminho do arquivo",
      "Dateipfad kopieren",
      "Copier le chemin du fichier",
      "파일 경로 복사",
      "Kopiuj ścieżkę pliku",
      "Dosya Yolunu Kopyala",
      "Copia percorso del file",
      "คัดลอกเส้นทางไฟล์",
      "Sao chép đường dẫn tệp",
    ],
    Key::FormatMenu => [
      "格式",
      "格式",
      "フォーマット",
      "Format",
      "Формат",
      "Formato",
      "Formato",
      "Format",
      "Format",
      "포맷",
      "Format",
      "Biçim",
      "Formato",
      "รูปแบบ",
      "Định dạng",
    ],
    Key::LineEndingMenu => [
      "行尾符號",
      "行尾符号",
      "改行コード",
      "Line Endings",
      "Символы конца строки",
      "Fin de línea",
      "Fim de linha",
      "Zeilenende",
      "Fins de ligne",
      "줄 바꿈 문자",
      "Znaki końca wiersza",
      "Satır Sonları",
      "Fine riga",
      "อักขระท้ายบรรทัด",
      "Ký tự xuống dòng",
    ],
    Key::Encoding => [
      "文字編碼",
      "文本编码",
      "テキストエンコーディング",
      "Text Encoding",
      "Кодировка текста",
      "Codificación de texto",
      "Codificação de texto",
      "Textcodierung",
      "Encodage du texte",
      "텍스트 인코딩",
      "Kodowanie tekstu",
      "Metin Kodlaması",
      "Codifica del testo",
      "การเข้ารหัสข้อความ",
      "Mã hóa văn bản",
    ],
    Key::Syntax => [
      "語法",
      "语法",
      "シンタックス",
      "Syntax",
      "Синтаксис",
      "Sintaxis",
      "Sintaxe",
      "Syntax",
      "Syntaxe",
      "구문",
      "Składnia",
      "Sözdizimi",
      "Sintassi",
      "ไวยากรณ์",
      "Cú pháp",
    ],
    Key::WordWrap => [
      "自動換行",
      "自动换行",
      "自動折り返し",
      "Word Wrap",
      "Перенос по словам",
      "Ajuste de línea",
      "Quebra de linha",
      "Zeilenumbruch",
      "Retour à la ligne automatique",
      "자동 줄 바꿈",
      "Zawijanie wierszy",
      "Sözcük Kaydırma",
      "A capo automatico",
      "ตัดคำขึ้นบรรทัดใหม่",
      "Tự động xuống dòng",
    ],
    Key::ViewMenu => [
      "顯示",
      "显示",
      "表示",
      "View",
      "Вид",
      "Visualización",
      "Exibir",
      "Darstellung",
      "Présentation",
      "보기",
      "Widok",
      "Görünüm",
      "Vista",
      "มุมมอง",
      "Hiển thị",
    ],
    Key::LineNumbers => [
      "顯示行號",
      "显示行号",
      "行番号を表示",
      "Line Numbers",
      "Номера строк",
      "Números de línea",
      "Números de linha",
      "Zeilennummern",
      "Numéros de ligne",
      "줄 번호",
      "Numery wierszy",
      "Satır Numaraları",
      "Numeri di riga",
      "หมายเลขบรรทัด",
      "Số dòng",
    ],
    Key::WindowMenu => [
      "視窗",
      "窗口",
      "ウィンドウ",
      "Window",
      "Окно",
      "Ventana",
      "Janela",
      "Fenster",
      "Fenêtre",
      "창",
      "Okno",
      "Pencere",
      "Finestra",
      "หน้าต่าง",
      "Cửa sổ",
    ],
    Key::Zoom => [
      "縮放",
      "缩放",
      "ズーム",
      "Zoom",
      "Масштаб",
      "Zoom",
      "Zoom",
      "Zoomen",
      "Réduire/Agrandir",
      "확대/축소",
      "Powiększenie",
      "Yakınlaştır",
      "Zoom",
      "ซูม",
      "Thu phóng",
    ],
    Key::BringAllToFront => [
      "全部移至最前",
      "全部置于最前",
      "すべてを手前に移動",
      "Bring All to Front",
      "Все окна на передний план",
      "Traer todo al frente",
      "Trazer tudo para a frente",
      "Alle nach vorne bringen",
      "Tout ramener au premier plan",
      "모두 앞으로 가져오기",
      "Przenieś wszystko na wierzch",
      "Tümünü Öne Getir",
      "Porta tutto in primo piano",
      "นำทั้งหมดมาไว้ด้านหน้า",
      "Đưa tất cả lên trước",
    ],
    Key::AlwaysOnTop => [
      "置頂",
      "置顶",
      "最前面に表示",
      "Always on Top",
      "Поверх всех окон",
      "Mantener al frente",
      "Manter sempre no topo",
      "Immer im Vordergrund",
      "Toujours au premier plan",
      "항상 위에 표시",
      "Zawsze na wierzchu",
      "Her Zaman Üstte",
      "Sempre in primo piano",
      "อยู่บนสุดเสมอ",
      "Luôn ở trên cùng",
    ],
    Key::Minimize => [
      "縮到最小",
      "最小化",
      "しまう",
      "Minimize",
      "Свернуть",
      "Minimizar",
      "Minimizar",
      "Im Dock ablegen",
      "Réduire",
      "최소화",
      "Minimalizuj",
      "Küçült",
      "Riduci a icona",
      "ย่อหน้าต่าง",
      "Thu nhỏ",
    ],
    Key::Workspace => [
      "工作區",
      "工作区",
      "ワークスペース",
      "Workspace",
      "Рабочая область",
      "Espacio de trabajo",
      "Área de trabalho",
      "Arbeitsbereich",
      "Espace de travail",
      "작업 공간",
      "Obszar roboczy",
      "Çalışma Alanı",
      "Area di lavoro",
      "พื้นที่ทำงาน",
      "Không gian làm việc",
    ],
    Key::SettingsTitle => [
      "設定",
      "设置",
      "設定",
      "Settings",
      "Настройки",
      "Configuración",
      "Configurações",
      "Einstellungen",
      "Réglages",
      "설정",
      "Ustawienia",
      "Ayarlar",
      "Impostazioni",
      "การตั้งค่า",
      "Cài đặt",
    ],
    Key::HelpMenu => [
      "輔助說明",
      "帮助",
      "ヘルプ",
      "Help",
      "Справка",
      "Ayuda",
      "Ajuda",
      "Hilfe",
      "Aide",
      "도움말",
      "Pomoc",
      "Yardım",
      "Aiuto",
      "วิธีใช้",
      "Trợ giúp",
    ],
    Key::Documentation => [
      "Note&Pad 說明",
      "Note&Pad 帮助",
      "Note&Pad ヘルプ",
      "Note&Pad Help",
      "Справка Note&Pad",
      "Ayuda de Note&Pad",
      "Ajuda do Note&Pad",
      "Note&Pad-Hilfe",
      "Aide Note&Pad",
      "Note&Pad 도움말",
      "Pomoc Note&Pad",
      "Note&Pad Yardımı",
      "Guida di Note&Pad",
      "วิธีใช้ Note&Pad",
      "Trợ giúp Note&Pad",
    ],
    Key::ReportIssue => [
      "回報問題",
      "报告问题",
      "問題を報告",
      "Report an Issue",
      "Сообщить о проблеме",
      "Informar un problema",
      "Relatar um problema",
      "Problem melden",
      "Signaler un problème",
      "문제 신고",
      "Zgłoś problem",
      "Sorun Bildir",
      "Segnala un problema",
      "รายงานปัญหา",
      "Báo cáo sự cố",
    ],
    Key::KeyboardShortcuts => [
      "快速鍵",
      "键盘快捷键",
      "キーボードショートカット",
      "Keyboard Shortcuts",
      "Сочетания клавиш",
      "Atajos de teclado",
      "Atalhos de teclado",
      "Tastenkombinationen",
      "Raccourcis clavier",
      "키보드 단축키",
      "Skróty klawiszowe",
      "Klavye Kısayolları",
      "Scorciatoie da tastiera",
      "แป้นพิมพ์ลัด",
      "Phím tắt",
    ],
    Key::Acknowledgements => [
      "致謝",
      "致谢",
      "謝辞",
      "Acknowledgements",
      "Благодарности",
      "Agradecimientos",
      "Agradecimentos",
      "Danksagungen",
      "Remerciements",
      "감사의 말",
      "Podziękowania",
      "Teşekkürler",
      "Ringraziamenti",
      "กิตติกรรมประกาศ",
      "Lời cảm ơn",
    ],
    Key::PrivacyPolicy => [
      "隱私權政策",
      "隐私政策",
      "プライバシーポリシー",
      "Privacy Policy",
      "Политика конфиденциальности",
      "Política de privacidad",
      "Política de privacidade",
      "Datenschutzerklärung",
      "Politique de confidentialité",
      "개인정보 처리방침",
      "Polityka prywatności",
      "Gizlilik Politikası",
      "Informativa sulla privacy",
      "นโยบายความเป็นส่วนตัว",
      "Chính sách quyền riêng tư",
    ],
    Key::TabsSection => [
      "分頁",
      "标签页",
      "タブ",
      "Tabs",
      "Вкладки",
      "Pestañas",
      "Abas",
      "Tabs",
      "Onglets",
      "탭",
      "Karty",
      "Sekmeler",
      "Schede",
      "แท็บ",
      "Thẻ",
    ],
    Key::NextTab => [
      "下一個分頁",
      "下一个标签页",
      "次のタブ",
      "Next Tab",
      "Следующая вкладка",
      "Pestaña siguiente",
      "Próxima aba",
      "Nächster Tab",
      "Onglet suivant",
      "다음 탭",
      "Następna karta",
      "Sonraki Sekme",
      "Scheda successiva",
      "แท็บถัดไป",
      "Thẻ tiếp theo",
    ],
    Key::PrevTab => [
      "上一個分頁",
      "上一个标签页",
      "前のタブ",
      "Previous Tab",
      "Предыдущая вкладка",
      "Pestaña anterior",
      "Aba anterior",
      "Vorheriger Tab",
      "Onglet précédent",
      "이전 탭",
      "Poprzednia karta",
      "Önceki Sekme",
      "Scheda precedente",
      "แท็บก่อนหน้า",
      "Thẻ trước",
    ],
    Key::LargeFileSection => [
      "大型檔案閱覽模式",
      "大文件阅览模式",
      "大容量ファイル閲覧モード",
      "Large File Viewer",
      "Просмотр больших файлов",
      "Visor de archivos grandes",
      "Visualizador de arquivos grandes",
      "Anzeige für große Dateien",
      "Affichage des fichiers volumineux",
      "대용량 파일 보기",
      "Podgląd dużych plików",
      "Büyük Dosya Görüntüleyici",
      "Visualizzatore file di grandi dimensioni",
      "ตัวแสดงไฟล์ขนาดใหญ่",
      "Trình xem tệp lớn",
    ],
    Key::GoToLine => [
      "跳至行號",
      "跳至行号",
      "指定行へ移動",
      "Go to Line",
      "Перейти к строке",
      "Ir a la línea",
      "Ir para linha",
      "Gehe zu Zeile",
      "Atteindre la ligne",
      "줄로 이동",
      "Przejdź do wiersza",
      "Satıra Git",
      "Vai alla riga",
      "ไปที่บรรทัด",
      "Đi đến dòng",
    ],
    Key::DockOpenWorkspace => [
      "開啟工作區",
      "打开工作区",
      "ワークスペースを開く",
      "Open Workspace",
      "Открыть рабочую область",
      "Abrir espacio de trabajo",
      "Abrir área de trabalho",
      "Arbeitsbereich öffnen",
      "Ouvrir l'espace de travail",
      "작업 공간 열기",
      "Otwórz obszar roboczy",
      "Çalışma Alanını Aç",
      "Apri area di lavoro",
      "เปิดพื้นที่ทำงาน",
      "Mở không gian làm việc",
    ],
    Key::DockBlankSticky => [
      "空白便利貼",
      "空白便签",
      "空の付箋",
      "Blank sticky note",
      "Пустая заметка",
      "Nota adhesiva en blanco",
      "Nota adesiva em branco",
      "Leere Haftnotiz",
      "Pense-bête vierge",
      "빈 메모지",
      "Pusta karteczka",
      "Boş yapışkan not",
      "Foglietto adesivo vuoto",
      "โน้ตกระดาษว่าง",
      "Ghi chú dán trống",
    ],
    Key::DockStickiesSection => [
      "便利貼",
      "便签",
      "付箋",
      "Sticky Notes",
      "Заметки",
      "Notas adhesivas",
      "Notas adesivas",
      "Haftnotizen",
      "Pense-bêtes",
      "메모지",
      "Karteczki",
      "Yapışkan Notlar",
      "Foglietti adesivi",
      "โน้ตกระดาษ",
      "Ghi chú dán",
    ],
    Key::DockDocumentsSection => [
      "文件",
      "文档",
      "ドキュメント",
      "Documents",
      "Документы",
      "Documentos",
      "Documentos",
      "Dokumente",
      "Documents",
      "문서",
      "Dokumenty",
      "Belgeler",
      "Documenti",
      "เอกสาร",
      "Tài liệu",
    ],
    Key::UntitledDocument => [
      "未命名",
      "未命名",
      "無題",
      "Untitled",
      "Без названия",
      "Sin título",
      "Sem título",
      "Unbenannt",
      "Sans titre",
      "제목 없음",
      "Bez nazwy",
      "Adsız",
      "Senza titolo",
      "ไม่มีชื่อ",
      "Không có tiêu đề",
    ],
    Key::StickyWindowTitle => [
      "便利貼",
      "便签",
      "付箋",
      "Sticky Note",
      "Заметка",
      "Nota adhesiva",
      "Nota adesiva",
      "Haftnotiz",
      "Pense-bête",
      "메모지",
      "Karteczka",
      "Yapışkan Not",
      "Foglietto adesivo",
      "โน้ตกระดาษ",
      "Ghi chú dán",
    ],
    Key::TrayNewNote => [
      "新增便利貼",
      "新建便签",
      "新しい付箋",
      "New Note",
      "Новая заметка",
      "Nueva nota",
      "Nova nota",
      "Neue Notiz",
      "Nouvelle note",
      "새 메모",
      "Nowa notatka",
      "Yeni Not",
      "Nuovo foglietto",
      "โน้ตใหม่",
      "Ghi chú mới",
    ],
    Key::TrayShowAll => [
      "顯示所有便利貼",
      "显示所有便签",
      "すべての付箋を表示",
      "Show All Notes",
      "Показать все заметки",
      "Mostrar todas las notas",
      "Mostrar todas as notas",
      "Alle Notizen anzeigen",
      "Afficher toutes les notes",
      "모든 메모 표시",
      "Pokaż wszystkie notatki",
      "Tüm Notları Göster",
      "Mostra tutti i foglietti",
      "แสดงโน้ตทั้งหมด",
      "Hiện tất cả ghi chú",
    ],
    Key::TrayQuit => [
      "結束",
      "退出",
      "終了",
      "Quit",
      "Завершить",
      "Salir",
      "Sair",
      "Beenden",
      "Quitter",
      "종료",
      "Zakończ",
      "Çık",
      "Esci",
      "ออก",
      "Thoát",
    ],
    Key::CtxOpen => [
      "開啟",
      "打开",
      "開く",
      "Open",
      "Открыть",
      "Abrir",
      "Abrir",
      "Öffnen",
      "Ouvrir",
      "열기",
      "Otwórz",
      "Aç",
      "Apri",
      "เปิด",
      "Mở",
    ],
    Key::CtxOpenSelected => [
      "開啟選取的檔案",
      "打开选中的文件",
      "選択したファイルを開く",
      "Open Selected Files",
      "Открыть выбранные файлы",
      "Abrir archivos seleccionados",
      "Abrir arquivos selecionados",
      "Ausgewählte Dateien öffnen",
      "Ouvrir les fichiers sélectionnés",
      "선택한 파일 열기",
      "Otwórz zaznaczone pliki",
      "Seçili Dosyaları Aç",
      "Apri i file selezionati",
      "เปิดไฟล์ที่เลือก",
      "Mở các tệp đã chọn",
    ],
    Key::CtxNewFile => [
      "新增檔案",
      "新建文件",
      "新規ファイル",
      "New File",
      "Новый файл",
      "Nuevo archivo",
      "Novo arquivo",
      "Neue Datei",
      "Nouveau fichier",
      "새 파일",
      "Nowy plik",
      "Yeni Dosya",
      "Nuovo file",
      "ไฟล์ใหม่",
      "Tệp mới",
    ],
    Key::CtxNewFolder => [
      "新增資料夾",
      "新建文件夹",
      "新規フォルダー",
      "New Folder",
      "Новая папка",
      "Nueva carpeta",
      "Nova pasta",
      "Neuer Ordner",
      "Nouveau dossier",
      "새 폴더",
      "Nowy folder",
      "Yeni Klasör",
      "Nuova cartella",
      "โฟลเดอร์ใหม่",
      "Thư mục mới",
    ],
    Key::CtxShowInFinder => show_in_file_browser_strings(),
    Key::CtxRename => [
      "重新命名",
      "重命名",
      "名前を変更",
      "Rename",
      "Переименовать",
      "Cambiar nombre",
      "Renomear",
      "Umbenennen",
      "Renommer",
      "이름 변경",
      "Zmień nazwę",
      "Yeniden Adlandır",
      "Rinomina",
      "เปลี่ยนชื่อ",
      "Đổi tên",
    ],
    Key::CtxDelete => [
      "刪除",
      "删除",
      "削除",
      "Delete",
      "Удалить",
      "Eliminar",
      "Excluir",
      "Löschen",
      "Supprimer",
      "삭제",
      "Usuń",
      "Sil",
      "Elimina",
      "ลบ",
      "Xóa",
    ],
    Key::CtxSaveAsDoc => [
      "另存為文件",
      "另存为文档",
      "ドキュメントとして保存",
      "Save as Document",
      "Сохранить как документ",
      "Guardar como documento",
      "Salvar como documento",
      "Als Dokument speichern",
      "Enregistrer comme document",
      "문서로 저장",
      "Zapisz jako dokument",
      "Belge Olarak Kaydet",
      "Salva come documento",
      "บันทึกเป็นเอกสาร",
      "Lưu thành tài liệu",
    ],
    Key::CtxCloseTab => [
      "關閉分頁",
      "关闭标签页",
      "タブを閉じる",
      "Close Tab",
      "Закрыть вкладку",
      "Cerrar pestaña",
      "Fechar aba",
      "Tab schließen",
      "Fermer l’onglet",
      "탭 닫기",
      "Zamknij kartę",
      "Sekmeyi Kapat",
      "Chiudi scheda",
      "ปิดแท็บ",
      "Đóng thẻ",
    ],
    Key::WebView2MissingTitle => [
      "缺少 WebView2 執行環境",
      "缺少 WebView2 运行时",
      "WebView2 ランタイムがありません",
      "WebView2 Runtime is missing",
      "Среда выполнения WebView2 отсутствует",
      "Falta el entorno de ejecución WebView2",
      "O runtime do WebView2 está ausente",
      "WebView2-Runtime fehlt",
      "Environnement d’exécution WebView2 introuvable",
      "WebView2 런타임이 없습니다",
      "Brak środowiska uruchomieniowego WebView2",
      "WebView2 Çalışma Zamanı eksik",
      "Runtime di WebView2 mancante",
      "ไม่พบ WebView2 Runtime",
      "Thiếu WebView2 Runtime",
    ],
    Key::WebView2MissingBody => [
      "Note&Pad 需要 Microsoft Edge WebView2 執行環境才能顯示視窗，但這台電腦上找不到它。請從下列網址安裝，然後重新開啟 Note&Pad。",
      "Note&Pad 需要 Microsoft Edge WebView2 运行时才能显示窗口，但这台电脑上找不到它。请从下列网址安装，然后重新打开 Note&Pad。",
      "Note&Pad のウィンドウ表示には Microsoft Edge WebView2 ランタイムが必要ですが、このコンピューターで見つかりませんでした。下記からインストールして、Note&Pad を開き直してください。",
      "Note&Pad needs the Microsoft Edge WebView2 Runtime to show its windows, and it was not found on this computer. Install it from the address below, then open Note&Pad again.",
      "Для отображения окон Note&Pad требуется среда выполнения Microsoft Edge WebView2, но она не найдена на этом компьютере. Установите её по адресу ниже и снова откройте Note&Pad.",
      "Note&Pad necesita el entorno de ejecución Microsoft Edge WebView2 para mostrar sus ventanas y no se encontró en este equipo. Instálelo desde la dirección siguiente y vuelva a abrir Note&Pad.",
      "O Note&Pad precisa do runtime do Microsoft Edge WebView2 para exibir suas janelas, e ele não foi encontrado neste computador. Instale-o pelo endereço abaixo e abra o Note&Pad novamente.",
      "Note&Pad benötigt die Microsoft Edge WebView2-Runtime, um seine Fenster anzuzeigen; sie wurde auf diesem Computer nicht gefunden. Installieren Sie sie über die untenstehende Adresse und öffnen Sie Note&Pad erneut.",
      "Note&Pad a besoin de l’environnement d’exécution Microsoft Edge WebView2 pour afficher ses fenêtres, et il est introuvable sur cet ordinateur. Installez-le depuis l’adresse ci-dessous, puis rouvrez Note&Pad.",
      "Note&Pad에서 창을 표시하려면 Microsoft Edge WebView2 런타임이 필요하지만 이 컴퓨터에서 찾을 수 없습니다. 아래 주소에서 설치한 후 Note&Pad를 다시 여세요.",
      "Note&Pad potrzebuje środowiska uruchomieniowego Microsoft Edge WebView2, aby wyświetlać okna, a nie znaleziono go na tym komputerze. Zainstaluj je spod poniższego adresu, a następnie ponownie otwórz Note&Pad.",
      "Note&Pad pencerelerini göstermek için Microsoft Edge WebView2 Çalışma Zamanı gerekir, ancak bu bilgisayarda bulunamadı. Aşağıdaki adresten yükleyin ve Note&Pad’i yeniden açın.",
      "Note&Pad ha bisogno del runtime di Microsoft Edge WebView2 per mostrare le sue finestre e non è stato trovato su questo computer. Installalo dall’indirizzo qui sotto, poi riapri Note&Pad.",
      "Note&Pad ต้องใช้ Microsoft Edge WebView2 Runtime เพื่อแสดงหน้าต่าง แต่ไม่พบบนคอมพิวเตอร์เครื่องนี้ โปรดติดตั้งจากที่อยู่ด้านล่าง แล้วเปิด Note&Pad อีกครั้ง",
      "Note&Pad cần Microsoft Edge WebView2 Runtime để hiển thị cửa sổ, nhưng không tìm thấy trên máy tính này. Hãy cài đặt từ địa chỉ bên dưới rồi mở lại Note&Pad.",
    ],
  }
}

/// Platform-specific label for the "reveal in file browser" action, in the same
/// 15-locale order as `strings`: Finder on macOS, File Explorer on Windows, and
/// a generic File Manager on Linux/other. The action itself is cross-platform;
/// only the name of the OS file browser changes.
fn show_in_file_browser_strings() -> [&'static str; 15] {
  #[cfg(target_os = "macos")]
  {
    [
      "在 Finder 中顯示",
      "在访达中显示",
      "Finder で表示",
      "Show in Finder",
      "Показать в Finder",
      "Mostrar en Finder",
      "Mostrar no Finder",
      "Im Finder anzeigen",
      "Afficher dans le Finder",
      "Finder에서 보기",
      "Pokaż w Finderze",
      "Finder’da Göster",
      "Mostra nel Finder",
      "แสดงใน Finder",
      "Hiển thị trong Finder",
    ]
  }
  #[cfg(target_os = "windows")]
  {
    [
      "在檔案總管中顯示",
      "在文件资源管理器中显示",
      "エクスプローラーで表示",
      "Show in File Explorer",
      "Показать в проводнике",
      "Mostrar en el Explorador de archivos",
      "Mostrar no Explorador de Arquivos",
      "Im Explorer anzeigen",
      "Afficher dans l’Explorateur de fichiers",
      "파일 탐색기에서 보기",
      "Pokaż w Eksploratorze plików",
      "Dosya Gezgini’nde Göster",
      "Mostra in Esplora file",
      "แสดงใน File Explorer",
      "Hiển thị trong File Explorer",
    ]
  }
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  {
    [
      "在檔案管理員中顯示",
      "在文件管理器中显示",
      "ファイルマネージャーで表示",
      "Show in File Manager",
      "Показать в файловом менеджере",
      "Mostrar en el gestor de archivos",
      "Mostrar no gerenciador de arquivos",
      "Im Dateimanager anzeigen",
      "Afficher dans le gestionnaire de fichiers",
      "파일 관리자에서 보기",
      "Pokaż w menedżerze plików",
      "Dosya Yöneticisi’nde Göster",
      "Mostra nel file manager",
      "แสดงในตัวจัดการไฟล์",
      "Hiển thị trong trình quản lý tệp",
    ]
  }
}

/// Translate `key` into `locale`. Exhaustive over `Locale`, so adding a language
/// forces every call site to account for it.
pub fn tr(locale: Locale, key: Key) -> &'static str {
  let s = strings(key);
  let idx = match locale {
    Locale::ZhTw => 0,
    Locale::ZhCn => 1,
    Locale::Ja => 2,
    Locale::En => 3,
    Locale::Ru => 4,
    Locale::Es => 5,
    Locale::PtBr => 6,
    Locale::De => 7,
    Locale::Fr => 8,
    Locale::Ko => 9,
    Locale::Pl => 10,
    Locale::Tr => 11,
    Locale::It => 12,
    Locale::Th => 13,
    Locale::Vi => 14,
  };
  s[idx]
}

/// Resolve a stored `language` preference into a concrete locale. Mirrors the
/// frontend `resolveLocale`: a concrete value maps directly, `system` maps the
/// OS UI language by prefix, and any unknown value (e.g. a hand-edited `en-US`)
/// falls back to English rather than being returned verbatim.
pub fn resolve_locale(language: &str, system_lang: Option<&str>) -> Locale {
  match language {
    "zh-TW" => Locale::ZhTw,
    "zh-CN" => Locale::ZhCn,
    "ja" => Locale::Ja,
    "en" => Locale::En,
    "ru" => Locale::Ru,
    "es" => Locale::Es,
    "pt-BR" => Locale::PtBr,
    "de" => Locale::De,
    "fr" => Locale::Fr,
    "ko" => Locale::Ko,
    "pl" => Locale::Pl,
    "tr" => Locale::Tr,
    "it" => Locale::It,
    "th" => Locale::Th,
    "vi" => Locale::Vi,
    "system" => from_system(system_lang),
    // An unknown id — a data locale the frontend loads at runtime (e.g. an
    // imported third-party language), or a hand-edited value — has no native
    // menu translation, so the menus follow the OS language rather than snapping
    // to English. `None` system still ends at English via `from_system`.
    _ => from_system(system_lang),
  }
}

// Non-Chinese OS UI language prefixes, mapped to a locale. No prefix is a prefix
// of another, so match order is irrelevant.
const PREFIX_MAP: [(&str, Locale); 13] = [
  ("ja", Locale::Ja),
  ("ko", Locale::Ko),
  ("de", Locale::De),
  ("fr", Locale::Fr),
  ("es", Locale::Es),
  ("pt", Locale::PtBr),
  ("it", Locale::It),
  ("pl", Locale::Pl),
  ("ru", Locale::Ru),
  ("tr", Locale::Tr),
  ("th", Locale::Th),
  ("vi", Locale::Vi),
  ("en", Locale::En),
];

/// Map an OS UI language tag to a locale. Mirrors the frontend `fromSystem`: the
/// `zh` macrolanguage splits by script/region (Traditional for Hant / TW / HK /
/// MO, Simplified otherwise — including bare `zh`, which CLDR likely-subtags
/// expands to `zh-Hans-CN`); every other language matches by prefix, and an
/// unmatched or absent tag falls back to English.
fn from_system(system_lang: Option<&str>) -> Locale {
  let lang = system_lang.unwrap_or("").to_ascii_lowercase();
  if lang.starts_with("zh") {
    if lang.starts_with("zh-hant")
      || lang.starts_with("zh-tw")
      || lang.starts_with("zh-hk")
      || lang.starts_with("zh-mo")
    {
      return Locale::ZhTw;
    }
    return Locale::ZhCn;
  }
  for (prefix, locale) in PREFIX_MAP {
    if lang.starts_with(prefix) {
      return locale;
    }
  }
  Locale::En
}

/// Resolve `language` against the real OS locale, read via `sys-locale` (no
/// network, cross-platform). Used at menu-build time.
pub fn current_locale(language: &str) -> Locale {
  resolve_locale(language, sys_locale::get_locale().as_deref())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn translates_representative_keys_in_every_locale() {
    assert_eq!(tr(Locale::ZhTw, Key::FileMenu), "檔案");
    assert_eq!(tr(Locale::Ja, Key::FileMenu), "ファイル");
    assert_eq!(tr(Locale::En, Key::FileMenu), "File");
    assert_eq!(tr(Locale::ZhTw, Key::EditMenu), "編輯");
    assert_eq!(tr(Locale::Ja, Key::EditMenu), "編集");
    assert_eq!(tr(Locale::En, Key::EditMenu), "Edit");
    assert_eq!(tr(Locale::ZhTw, Key::Save), "儲存");
    assert_eq!(tr(Locale::Ja, Key::Save), "保存");
    // The reveal label is platform-specific (Finder / File Explorer / File
    // Manager); assert the one for the platform the test is compiled on.
    #[cfg(target_os = "macos")]
    assert_eq!(tr(Locale::En, Key::CtxShowInFinder), "Show in Finder");
    #[cfg(target_os = "windows")]
    assert_eq!(
      tr(Locale::En, Key::CtxShowInFinder),
      "Show in File Explorer"
    );
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    assert_eq!(tr(Locale::En, Key::CtxShowInFinder), "Show in File Manager");
    assert_eq!(tr(Locale::ZhTw, Key::CtxOpen), "開啟");
    assert_eq!(
      tr(Locale::Ja, Key::CtxOpenSelected),
      "選択したファイルを開く"
    );
    assert_eq!(tr(Locale::En, Key::CtxOpenSelected), "Open Selected Files");
    // Predefined menu-item labels passed into Tauri's PredefinedMenuItem.
    assert_eq!(tr(Locale::ZhTw, Key::Undo), "復原");
    assert_eq!(tr(Locale::Ja, Key::Paste), "ペースト");
    assert_eq!(tr(Locale::Ja, Key::Minimize), "しまう");
    assert_eq!(tr(Locale::En, Key::SelectAll), "Select All");
    // Settings window title carries no ellipsis, unlike the menu item.
    assert_eq!(tr(Locale::ZhTw, Key::SettingsTitle), "設定");
  }

  #[test]
  fn every_locale_has_its_own_translation() {
    // The twelve data locales render their own strings, not the
    // English fallback the scaffold used before the translations landed.
    assert_eq!(tr(Locale::ZhCn, Key::FileMenu), "文件");
    assert_eq!(tr(Locale::Ru, Key::Save), "Сохранить");
    assert_eq!(tr(Locale::Es, Key::EditMenu), "Edición");
    assert_eq!(tr(Locale::PtBr, Key::EditMenu), "Editar");
    assert_eq!(tr(Locale::De, Key::CtxNewFolder), "Neuer Ordner");
    assert_eq!(tr(Locale::Ko, Key::TrayQuit), "종료");
    assert_eq!(tr(Locale::Pl, Key::SelectAll), "Zaznacz wszystko");
    assert_eq!(tr(Locale::It, Key::WindowMenu), "Finestra");
    assert_eq!(tr(Locale::Th, Key::Close), "ปิด");
    assert_eq!(tr(Locale::Vi, Key::CtxOpen), "Mở");
    // Turkish apostrophe (U+2019) and French apostrophe are preserved verbatim.
    assert_eq!(tr(Locale::Tr, Key::Quit), "Note&Pad’ten Çık");
    assert_eq!(tr(Locale::Fr, Key::CtxCloseTab), "Fermer l’onglet");
  }

  #[test]
  fn concrete_language_maps_directly() {
    assert_eq!(resolve_locale("zh-TW", None), Locale::ZhTw);
    assert_eq!(resolve_locale("zh-CN", None), Locale::ZhCn);
    assert_eq!(resolve_locale("ja", None), Locale::Ja);
    assert_eq!(resolve_locale("en", None), Locale::En);
    assert_eq!(resolve_locale("pt-BR", None), Locale::PtBr);
    assert_eq!(resolve_locale("ko", None), Locale::Ko);
    assert_eq!(resolve_locale("vi", None), Locale::Vi);
  }

  #[test]
  fn chinese_splits_by_script_and_region() {
    // Traditional: Hant script or a Traditional-using region.
    assert_eq!(resolve_locale("system", Some("zh-Hant-TW")), Locale::ZhTw);
    assert_eq!(resolve_locale("system", Some("zh-Hant")), Locale::ZhTw);
    assert_eq!(resolve_locale("system", Some("zh-HK")), Locale::ZhTw);
    assert_eq!(resolve_locale("system", Some("zh-MO")), Locale::ZhTw);
    // Simplified: Hans script, a Simplified-using region, or bare `zh`.
    assert_eq!(resolve_locale("system", Some("zh-Hans-CN")), Locale::ZhCn);
    assert_eq!(resolve_locale("system", Some("ZH-CN")), Locale::ZhCn);
    assert_eq!(resolve_locale("system", Some("zh-SG")), Locale::ZhCn);
    assert_eq!(resolve_locale("system", Some("zh")), Locale::ZhCn);
  }

  #[test]
  fn system_language_maps_by_prefix() {
    assert_eq!(resolve_locale("system", Some("ja-JP")), Locale::Ja);
    assert_eq!(resolve_locale("system", Some("ko-KR")), Locale::Ko);
    assert_eq!(resolve_locale("system", Some("de-DE")), Locale::De);
    assert_eq!(resolve_locale("system", Some("fr-FR")), Locale::Fr);
    assert_eq!(resolve_locale("system", Some("ru-RU")), Locale::Ru);
    assert_eq!(resolve_locale("system", Some("vi-VN")), Locale::Vi);
    // Any Portuguese variant routes to the Brazilian dictionary.
    assert_eq!(resolve_locale("system", Some("pt-BR")), Locale::PtBr);
    assert_eq!(resolve_locale("system", Some("pt-PT")), Locale::PtBr);
    assert_eq!(resolve_locale("system", Some("en-US")), Locale::En);
    // An unsupported or absent OS tag falls back to English.
    assert_eq!(resolve_locale("system", Some("eo")), Locale::En);
    assert_eq!(resolve_locale("system", None), Locale::En);
  }

  #[test]
  fn unknown_language_follows_system_then_english() {
    // An unsupported value — a hand-edited settings.json or a runtime data
    // locale with no native-menu translation — makes the menus follow the OS
    // language, falling back to English only when the OS language is unknown.
    assert_eq!(resolve_locale("my-custom", Some("fr-FR")), Locale::Fr);
    assert_eq!(resolve_locale("eo", Some("ja-JP")), Locale::Ja);
    assert_eq!(resolve_locale("en-US", None), Locale::En);
    assert_eq!(resolve_locale("eo", None), Locale::En);
    assert_eq!(resolve_locale("", None), Locale::En);
  }
}
