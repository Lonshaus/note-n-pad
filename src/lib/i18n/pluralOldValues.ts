// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Shipped values replaced by the count-neutral rewording. Mirrors REWORDED in
// src-tauri/src/locale_store.rs (pluralWording.test.ts keeps the two in step).
export const OLD_SHIPPED: Record<string, Record<string, string>> = {
  en: {
    'skipped.heading': '{count} files could not be loaded',
    'skipped.snapshotHeading':
      '{count} sticky or document snapshots could not be loaded',
    'settings.general.snapshotMoveBody':
      "The current folder has {count} sticky notes and unsaved document content. If you don't move them, they won't show up in Note&Pad anymore — they'll stay in the original folder.",
    'settings.general.snapshotCollisionTitle':
      'The chosen folder already has {count} matching snapshots',
    'large.range.info': 'Lines {start}–{end} ({count} lines, ~{size})',
    'large.search.results': '{count} results',
    'status.indexing': 'Indexing… {count} lines',
    'status.lines': '{count} lines',
    'doc.restoreUnreadable':
      'Couldn’t read {names}. Open them again to continue.',
    'settings.editor.fontCustom': 'Custom…',
  },
  de: {
    'skipped.heading': '{count} Dateien konnten nicht geladen werden',
    'skipped.snapshotHeading':
      '{count} Notiz- oder Dokument-Sicherungen konnten nicht geladen werden',
    'settings.general.snapshotCollisionTitle':
      'Der ausgewählte Ordner enthält bereits {count} gleiche Schnappschüsse',
    'large.range.info': 'Zeilen {start}–{end} ({count} Zeilen, ca. {size})',
    'large.search.results': '{count} Ergebnisse',
    'status.indexing': 'Indizierung… {count} Zeilen',
    'status.lines': '{count} Zeilen',
    'doc.restoreUnreadable':
      '{names} konnte nicht gelesen werden. Öffne die Dateien erneut, um fortzufahren.',
    'settings.editor.fontCustom': 'Benutzerdefiniert…',
  },
  fr: {
    'skipped.heading': '{count} fichiers n’ont pas pu être chargés',
    'skipped.snapshotHeading':
      '{count} instantanés de notes ou de documents n’ont pas pu être chargés',
    'settings.general.snapshotMoveBody':
      "Le dossier actuel contient {count} pense-bêtes et du contenu de document non enregistré. Si vous ne les déplacez pas, ils n'apparaîtront plus dans Note&Pad et resteront uniquement dans le dossier d'origine.",
    'settings.general.snapshotCollisionTitle':
      'Le dossier choisi contient déjà {count} instantanés identiques',
    'large.range.info': 'Lignes {start}–{end} ({count} lignes, ~{size})',
    'large.search.results': '{count} résultats',
    'status.indexing': 'Indexation… {count} lignes',
    'status.lines': '{count} lignes',
    'doc.restoreUnreadable':
      'Impossible de lire {names}. Rouvrez les fichiers pour continuer.',
    'settings.editor.fontCustom': 'Personnalisée…',
  },
  es: {
    'skipped.heading': 'No se pudieron cargar {count} archivos',
    'skipped.snapshotHeading':
      'No se pudieron cargar {count} instantáneas de notas o documentos',
    'settings.general.snapshotMoveBody':
      'La carpeta actual tiene {count} notas adhesivas y contenido de documentos sin guardar. Si no las mueve, dejarán de aparecer en Note&Pad y solo permanecerán en la carpeta original.',
    'settings.general.snapshotCollisionTitle':
      'La carpeta seleccionada ya tiene {count} instantáneas iguales',
    'large.range.info': 'Líneas {start}–{end} ({count} líneas, ~{size})',
    'large.search.searching': 'Buscando… {count} encontrados',
    'large.search.results': '{count} resultados',
    'status.indexing': 'Indexando… {count} líneas',
    'status.lines': '{count} líneas',
    'doc.restoreUnreadable':
      'No se pudo leer {names}. Ábrelos de nuevo para continuar.',
    'settings.editor.fontCustom': 'Personalizada…',
  },
  it: {
    'skipped.snapshotHeading':
      'Non è stato possibile caricare {count} istantanee di note o documenti',
    'settings.general.snapshotCollisionTitle':
      'La cartella scelta contiene già {count} snapshot identici',
    'large.range.info': 'Righe {start}–{end} ({count} righe, ~{size})',
    'large.search.searching': 'Ricerca in corso… {count} trovati',
    'large.search.results': '{count} risultati',
    'status.indexing': 'Indicizzazione… {count} righe',
    'status.lines': '{count} righe',
    'doc.restoreUnreadable':
      'Impossibile leggere {names}. Riaprili per continuare.',
    'settings.editor.fontCustom': 'Personalizzato…',
  },
  'pt-BR': {
    'skipped.heading': 'Não foi possível carregar {count} arquivos',
    'skipped.snapshotHeading':
      'Não foi possível carregar {count} instantâneos de notas ou documentos',
    'settings.general.snapshotMoveBody':
      'A pasta atual tem {count} notas adesivas e conteúdo de documentos não salvo. Se você não movê-las, elas deixarão de aparecer no Note&Pad e permanecerão apenas na pasta original.',
    'settings.general.snapshotCollisionTitle':
      'A pasta escolhida já tem {count} instantâneos iguais',
    'large.range.info': 'Linhas {start}–{end} ({count} linhas, ~{size})',
    'large.search.searching': 'Pesquisando… {count} encontrados',
    'large.search.results': '{count} resultados',
    'status.indexing': 'Indexando… {count} linhas',
    'status.lines': '{count} linhas',
    'doc.restoreUnreadable':
      'Não foi possível ler {names}. Abra os arquivos novamente para continuar.',
    'settings.editor.fontCustom': 'Personalizada…',
  },
  ru: {
    'settings.general.snapshotMoveBody':
      'В текущей папке находится {count} стикеров и несохранённое содержимое документов. Если их не переместить, они больше не будут отображаться в Note&Pad и останутся только в исходной папке.',
    'settings.general.snapshotCollisionTitle':
      'В выбранной папке уже есть {count} таких же снимков',
    'large.range.info': 'Строки {start}–{end} ({count} строк, ~{size})',
    'status.indexing': 'Индексирование… {count} строк',
    'doc.restoreUnreadable':
      'Не удалось прочитать: {names}. Откройте файлы снова, чтобы продолжить.',
    'settings.editor.fontCustom': 'Другой…',
  },
  pl: {
    'settings.general.snapshotMoveBody':
      'Bieżący folder zawiera {count} karteczek i niezapisaną zawartość dokumentów. Jeśli ich nie przeniesiesz, nie będą już widoczne w Note&Pad i pozostaną tylko w pierwotnym folderze.',
    'settings.general.snapshotCollisionTitle':
      'Wybrany folder zawiera już {count} takich samych migawek',
    'large.range.info': 'Wiersze {start}–{end} ({count} wierszy, ~{size})',
    'status.indexing': 'Indeksowanie… {count} wierszy',
    'status.lines': '{count} wierszy',
    'doc.restoreUnreadable':
      'Nie można odczytać: {names}. Otwórz pliki ponownie, aby kontynuować.',
    'settings.editor.fontCustom': 'Niestandardowa…',
  },
  tr: {
    'doc.restoreUnreadable':
      '{names} okunamadı. Devam etmek için dosyaları yeniden açın.',
    'settings.editor.fontCustom': 'Özel…',
  },
  vi: {
    'doc.restoreUnreadable':
      'Không đọc được {names}. Hãy mở lại các tệp để tiếp tục.',
    'settings.editor.fontCustom': 'Tùy chỉnh…',
  },
  ko: {
    'settings.editor.fontCustom': '사용자 지정…',
  },
  th: {
    'settings.editor.fontCustom': 'กำหนดเอง…',
  },
  'zh-CN': {
    'settings.editor.fontCustom': '自定义…',
  },
  'zh-TW': {
    'settings.editor.fontCustom': '自訂…',
  },
  ja: {
    'settings.editor.fontCustom': 'カスタム…',
  },
};
