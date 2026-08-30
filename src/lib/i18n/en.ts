// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { I18nKey } from './index';

// English. `satisfies` enforces the exact key set from the master dictionary:
// a missing key or a stray extra key fails `npm run check`.
export const en = {
  // Settings — section rail
  'settings.section.general': 'General',
  'settings.section.sticky': 'Sticky Notes',
  'settings.section.editor': 'Editor',
  'settings.section.language': 'Language',
  // Settings — appearance
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.theme.customSuffix': ' (Custom)',
  'settings.interface.label': 'Interface',
  'settings.interface.system': 'Follow system',
  'settings.theme.reset': 'Reset',
  'settings.theme.resetConfirm': 'Restore the theme “{name}” to its default?',
  'settings.theme.saveAsNew': 'Save as new theme',
  'settings.theme.import': 'Import Theme',
  'settings.theme.export': 'Export Theme',
  'settings.theme.delete': 'Delete',
  'settings.theme.deleteConfirm': 'Delete the theme “{name}”?',
  'settings.theme.nameLabel': 'Theme Name',
  'settings.theme.importError':
    'The theme file could not be read or is invalid',
  'settings.theme.exportError':
    'Couldn’t export this theme. The disk may be full, or permission may have changed.',
  'settings.theme.group.editor': 'Editor',
  'settings.theme.group.ui': 'Interface',
  'settings.theme.group.syntax': 'Syntax',
  'settings.theme.color.editorBg': 'Background',
  'settings.theme.color.editorFg': 'Text',
  'settings.theme.color.uiBg': 'Interface Background',
  'settings.theme.color.uiFg': 'Interface Text',
  'settings.theme.color.uiAccent': 'Accent',
  'settings.theme.color.uiBorder': 'Border',
  'settings.theme.color.danger': 'Danger',
  // Files a data folder held that could not be loaded (snapshots, themes,
  // locales). The reason names the case; `skipReasonKey` maps it.
  'skipped.heading': '{count} files could not be loaded',
  'skipped.snapshotHeading':
    '{count} sticky or document snapshots could not be loaded',
  'skipped.windowHint':
    'These files could not be read when Note&Pad started, so nothing they hold is showing in any window.',
  'skipped.reason.notJson': 'Not a JSON file',
  'skipped.reason.unreadable': 'Could not be read',
  'skipped.reason.unparsable': 'Not valid JSON',
  'skipped.reason.invalid': 'A field is not in the expected format',
  'skipped.reason.foreignId': 'The file name does not match the id inside it',
  'skipped.reason.duplicateId': 'Its id was already claimed by another file',
  // One per platform, picked at runtime: the file browser has a different name
  // on each, and the native context menu already says it this way.
  'skipped.reveal.macos': 'Show in Finder',
  'skipped.reveal.windows': 'Show in File Explorer',
  'skipped.reveal.linux': 'Show in File Manager',
  'skipped.delete': 'Delete',
  'skipped.deleteConfirm': 'Delete the file "{name}"?',
  // Settings — sticky
  'settings.sticky.newNoteShortcut': 'New note shortcut',
  'settings.sticky.recording': 'Press a key combination…',
  'settings.sticky.recordCancelHint': 'Press Esc to cancel',
  'settings.sticky.recordHint': 'Click, then press a new key combination',
  'settings.sticky.shortcutError': 'Couldn’t set this shortcut',
  'settings.sticky.defaultSize': 'Default note size',
  'settings.sticky.resetSize': 'Reset',
  // Settings — editor
  'settings.editor.wordWrap': 'Word wrap',
  'settings.editor.lineNumbers': 'Line numbers',
  'settings.editor.workerHighlight':
    'Enable syntax highlighting for very large files',
  'settings.editor.workerHighlightHint':
    'Large files are processed in the background, so colors appear with a delay. Very complex content may still be slow and use more memory.',
  'settings.editor.font': 'Font',
  'settings.editor.fontCustom': 'Custom…',
  'settings.editor.fontDefault': 'System default',
  'settings.editor.fontNamePlaceholder': 'Font name',
  'settings.editor.fontSize': 'Font size',
  'settings.editor.fontSizeDecrease': 'Decrease',
  'settings.editor.fontSizeIncrease': 'Increase',
  'settings.editor.defaultLineEnding': 'Default line ending',
  'settings.editor.defaultEncoding': 'Default encoding',
  'settings.editor.tabTheme': 'Theme',
  // Settings — general
  'settings.general.snapshotLocation': 'Snapshot location',
  'settings.general.snapshotChoose': 'Choose folder…',
  'settings.general.snapshotReset': 'Reset to default',
  'settings.general.snapshotMoveTitle': 'Move the existing sticky notes over?',
  'settings.general.snapshotMoveBody':
    "The current folder has {count} sticky notes and unsaved document content. If you don't move them, they won't show up in Note&Pad anymore — they'll stay in the original folder.",
  'settings.general.snapshotMoveConfirm': 'Move',
  'settings.general.snapshotMoveSkip': "Don't move",
  'settings.general.snapshotCollisionTitle':
    'The chosen folder already has {count} matching snapshots',
  'settings.general.snapshotCollisionSource':
    "Overwrite with this folder's copies",
  'settings.general.snapshotCollisionDest':
    "Overwrite with the destination's copies",
  'settings.general.snapshotCollisionBoth': 'Keep both',
  'settings.general.snapshotCloudHint':
    'Point this at a cloud drive and your sticky notes sync across devices. Documents keep their unsaved changes here too, but those do not sync — the files themselves may not exist on the other device.',
  'settings.general.largeOpenMode': 'Large file open mode',
  'settings.general.largeOpenModeAsk': 'Ask every time (default)',
  'settings.general.largeOpenModeView': 'View',
  'settings.general.largeOpenModeEdit': 'Edit',
  'settings.general.openTarget': 'Open files in',
  'settings.general.openTargetTab': 'New tab (default)',
  'settings.general.openTargetWindow': 'New window',
  'settings.general.showTrayIcon': 'Show icon in the status bar',
  'settings.general.openWorkspaceOnStartup': 'Open the workspace at startup',
  // Settings — language (list lives on the language tab)
  'settings.language.label': 'Language',
  'settings.language.system': 'Follow system',
  'settings.language.import': 'Import language',
  'settings.language.export': 'Export language',
  'settings.language.delete': 'Delete',
  'settings.language.deleteConfirm': 'Delete the language “{name}”?',
  'settings.language.importError':
    'The language file could not be read or is malformed',
  'settings.language.reset': 'Reset',
  'settings.language.resetConfirm':
    'Restore the language “{name}” to its default?',
  'settings.language.customSuffix': ' (Custom)',
  'settings.language.save': 'Save',
  'settings.language.updateFromJson': 'Update from JSON',
  'settings.language.unsaved': 'Unsaved',
  'settings.language.discardConfirm':
    'You have unsaved changes. Switching languages discards them. Continue?',
  'settings.language.followSystemHint': 'Pick a language to edit its strings',
  'settings.language.idMismatch':
    'This file is for a different language ({id}) and cannot update the current one',
  // Common actions, reused across dialogs and toolbars
  'common.open': 'Open',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.close': 'Close',
  // Shared dialogs
  'dialog.saveBeforeClose': 'Save changes before closing?',
  'dialog.dontSave': 'Don’t Save',
  // Document window
  'doc.untitled': 'Untitled',
  'doc.tab.close': 'Close tab',
  'doc.tab.readonly': 'Read-only',
  'doc.tab.unsaved': 'Unsaved',
  'doc.tab.new': 'New tab',
  'doc.lock.oversized': 'Very large file — view only',
  'doc.lock.restoring': 'Reopening — view only for now',
  'doc.lock.edit': 'Switch to edit mode',
  'doc.lock.readOnlyFile': 'This file is read-only',
  'doc.large.confirm': '“{name}” is {size}.',
  'doc.conflict.writeAnyway': 'Write Anyway',
  'doc.conflict.saveAsNew': 'Save As New',
  'doc.rangeConflict.message':
    'The source file has changed; writing back may overwrite other edits.',
  'doc.windowedConflict.message':
    'The source file was changed by another program. Writing back overwrites the whole file with the current content, and external changes will be lost.',
  'doc.oversized.message':
    'This tab’s unsaved content is too large to snapshot and must be handled before closing.',
  'doc.oversized.discard': 'Discard Changes',
  'doc.snapshotFailed.message':
    'This tab’s unsaved content could not be saved to the recovery snapshot and must be handled before closing.',
  'sticky.snapshotFailed.message':
    'This note’s content could not be saved to the recovery snapshot and must be handled before closing.',
  'doc.edit.notUtf8': 'This file is not UTF-8 encoded and cannot be edited.',
  'doc.edit.cannot': 'This file cannot be edited.',
  'doc.edit.tooLarge': 'This file is too large to edit in place.',
  'doc.unlock.notUtf8':
    'This file is not UTF-8 encoded and cannot be edited; read-only viewing is still available.',
  'doc.unlock.cannot':
    'This file cannot be edited; read-only viewing is still available.',
  'doc.range.lossyRefusal':
    'This range contains content that cannot be represented as UTF-8; writing it back would corrupt the file. Use “save range” instead.',
  'doc.range.displayName': '{name} (lines {start}–{end})',
  // Windowed editor — lock reasons (carry the raw failure detail)
  'editor.locked.write':
    'Write failed; the editor is locked to prevent corruption: {detail}',
  'editor.locked.undo': 'Undo failed; the editor is locked: {detail}',
  'editor.locked.read': 'Read failed; the editor is locked: {detail}',
  'editor.locked.swap': 'Window swap failed; the editor is locked: {detail}',
  // Large-file view
  'large.gutter.title': 'Click a line number to select a range (Shift extends)',
  'large.goto.placeholder': 'Line',
  'large.goto.aria': 'Go to line',
  'large.range.info': 'Lines {start}–{end} ({count} lines, ~{size})',
  'large.range.edit': 'Edit this range',
  'large.range.saveAs': 'Save range',
  'large.range.tooBig':
    'The range is about {size}, over the {max} limit. Narrow the selection.',
  'large.range.extractFailed':
    'Couldn’t read this range. The file may have been moved, deleted, or become unreadable.',
  'large.range.saveFailed':
    'Couldn’t save this range. The disk may be full, or permission may have changed.',
  'large.search.label': 'Search',
  'large.search.case': 'Case',
  'large.search.searching': 'Searching… {count} found',
  'large.search.results': '{count} results',
  'large.search.truncatedSuffix': ' (truncated)',
  'large.search.failed':
    'Search failed. The file may have been moved or become unreadable.',
  'large.index.failed':
    'Couldn’t finish indexing “{name}”. Line count and jump-to-line are unavailable for this file.',
  'large.read.failed':
    'Couldn’t read part of this file. It may have been moved or become unreadable.',
  // Status bar
  'status.view': 'View',
  'status.indexing': 'Indexing… {count} lines',
  'status.lines': '{count} lines',
  'status.lineEnding': 'Line ending',
  'status.encoding': 'Encoding',
  'status.language': 'Language',
  'status.lossy': 'Decoded with replacement characters — pick another encoding',
  'status.viewMode': 'View mode',
  'status.viewTable': 'Table',
  'status.viewSource': 'Source',
  'status.viewTooLarge': 'This document is too large to preview',
  'status.viewUnavailableHere':
    'This view isn’t available while editing in windowed mode',
  // Preview
  'preview.jsonError': 'JSON syntax error: {detail}',
  'preview.jsonErrorAt':
    'JSON syntax error (line {line}, column {column}): {detail}',
  'preview.xmlError': 'XML syntax error: {detail}',
  'preview.xmlErrorAt':
    'XML syntax error (line {line}, column {column}): {detail}',
  // Table view
  'table.headerRow.title': 'Use the first row as a header row (styling only)',
  'table.headerRow.label': 'Header row',
  'table.selectAll': 'Select whole table',
  'table.selectCol': 'Select column',
  'table.selectRow': 'Select row',
  'table.addRow.title': 'Add row',
  'table.addRow.aria': 'Add a row at the end',
  'table.addCol.title': 'Add column',
  'table.addCol.aria': 'Add a column at the end',
  'table.menu.rowAbove': 'Insert Row Above',
  'table.menu.rowBelow': 'Insert Row Below',
  'table.menu.rowDelete': 'Delete Row',
  'table.menu.colLeft': 'Insert Column Left',
  'table.menu.colRight': 'Insert Column Right',
  'table.menu.colDelete': 'Delete Column',
  // About
  'about.version': 'Version {version}',
  'about.desc': 'A lightweight sticky-note and plain-text editor.',
  'about.license': 'Released under the GNU General Public License v3.0.',
  // Acknowledgements
  'acknowledgements.intro':
    'Note&Pad is built with the open-source packages listed below. Thanks to their authors and contributors.',
  'acknowledgements.canonicalNote':
    'Where a package ships no licence file of its own, the canonical text of its declared licence is shown instead.',
  'acknowledgements.loadError': 'Couldn’t load the licence list: {detail}',
  // Privacy Policy
  'privacy.loadError': 'Couldn’t load the privacy policy: {detail}',
  // Sticky note window
  'sticky.pin.unpin': 'Unpin',
  'sticky.pin.pinnedApp': 'Pinned to app',
  'sticky.pin.onTop': 'Pin on top',
  'sticky.pin.options': 'Pin options',
  'sticky.pin.alwaysOnTop': 'Always on top',
  'sticky.pin.toApp': 'Pin to app',
  'sticky.paperColor': 'Paper color',
  'sticky.opacity': 'Opacity',
  // Workspace
  'workspace.section.stickies': 'Sticky Notes',
  'workspace.stickies.empty': 'No sticky notes',
  'workspace.sticky.blank': 'Blank sticky note',
  'workspace.section.docs': 'Open Documents',
  'workspace.docs.empty': 'No open documents',
  'workspace.section.project': 'Projects',
  'workspace.project.refresh': 'Refresh',
  'workspace.project.add': 'Add project folder',
  'workspace.project.empty': 'No project selected',
  'workspace.project.loadError': 'Couldn’t load the project folder',
  'workspace.project.close': 'Close project',
  'workspace.tree.newFile': 'New file',
  'workspace.tree.newFileAria': 'New file in this folder',
  'workspace.tree.newFolder': 'New folder',
  'workspace.tree.newFolderAria': 'New subfolder in this folder',
  // Long-line handling
  'status.longLine.worker':
    'Long lines: syntax highlighting moved to a background thread',
  'status.longLine.disabled': 'Long lines: syntax highlighting turned off',
  'status.longLine.reason':
    'This file has a very long line; parsing it on every keystroke would slow typing.',
  'doc.openFailed':
    'Couldn’t open “{name}”. The file may have been moved or deleted, or its name may contain characters this app doesn’t support.',
  'doc.revealFailed':
    'Couldn’t show “{name}”. The file may have been moved or deleted.',
  'doc.saveFailed': 'Couldn’t save “{name}”: {error}',
  'doc.saveReadOnly':
    '“{name}” is read-only, so nothing was saved. Change the file’s permissions to save to it.',
  'sticky.saveFailed': 'Couldn’t save this note: {error}',
  'sticky.saveReadOnly':
    '“{name}” is read-only, so this note wasn’t saved. Change the file’s permissions to save to it.',
  'doc.encodingFailed':
    'Couldn’t change the encoding of “{name}”. The file may have been moved or deleted, or become unreadable.',
  'settings.saveFailed':
    'Couldn’t save this change. The settings file may be read-only, or the disk may be full.',
  'settings.loadRepaired':
    'Some of your settings couldn’t be read and were reset to their defaults.',
  'settings.snapshotDirUnavailable':
    'The snapshot folder you chose is unavailable, so the default folder is being used for now.',
  'doc.longLine.confirm':
    '“{name}” contains a very long line, which can slow down editing. How would you like to open it?',
  'doc.longLine.openAsIs': 'Open As-Is',
  'doc.longLine.format': 'Format and Open',
  'doc.longLine.softWrap': 'Soft-Wrap and Open',
  'settings.general.askLongLineOpen':
    'Ask when opening files with very long lines',
  'settings.general.previewLocalResources':
    'Show local images and clickable links in preview',
} satisfies Record<I18nKey, string>;
