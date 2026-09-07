#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: interface translation.
# Language switching is live via the settings-changed broadcast, resolvedLocale
# tracks the stored preference, 'system' resolves to the host locale, and the
# choice survives a restart. Asserts a stable status-bar string (the line-ending
# picker's tooltip) flips language WITHOUT a restart, and that a change made in
# the settings window reaches an open document window.
# LESSON: never put `await` inside an eval string.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/i18n-fixture"
PASS=0
FAIL=0
mkdir -p "$OUT"
: >"$OUT/dev-i18n.log"

ok() {
  PASS=$((PASS + 1))
  echo "PASS: $1"
}
bad() {
  FAIL=$((FAIL + 1))
  echo "FAIL: $1"
}
check() {
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    bad "$1 (got: [$2], want: [$3])"
  fi
}
count_kind() {
  local n=0
  for f in "$STORE"/*.json; do
    if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "$1" ]; then
      n=$((n + 1))
    fi
  done
  echo "$n"
}

cd "$REPO" || exit 1
source "$HOME/.cargo/env" 2>/dev/null

auto() {
  node scripts/auto.mjs "$1"
}
doc_label() {
  auto '{"id":3,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label' | head -1
}
evl() {
  auto "{\"id\":9,\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at the same time. If the automation port is already dead by the
# time the trap fires, the app-side restore call (ECONNREFUSED) is skipped and
# settings.json is left pinned. As a fallback once the app is confirmed dead,
# patch settings.json directly with jq so the on-disk language always reverts.
# Tooltip of the status bar's first select — the line-ending picker, whose
# title is t('status.lineEnding') ($1 = doc label). Deliberately NOT the
# language select's "Plain Text" option: language names, "Plain Text" and
# encoding labels are never translated in any locale, so that option's text is
# the same string everywhere and can never show a language change. This select
# is unconditional (the two conditional siblings, the lossy warning and the BOM
# badge, are spans and cannot shift its index) and its title is translated in
# all three dictionaries, so it flips with the UI language and needs no
# test-only markup.
line_ending_label() {
  evl "$1" "String((document.querySelector('.statusbar select.lang')||{}).title||'').trim()"
}
# The status bar picks a language change up through the settings-changed
# broadcast, so the label itself is the thing to wait on. A fixed sleep was
# enough on a fast machine and not on a CI runner.
_label_is() {
  [ "$(line_ending_label "$1")" = "$2" ]
}
# `evl` against a window that does not exist yet fails, and every assertion in
# the settings section runs in that window.
_settings_auto_ready() {
  [ "$(evl settings "String(typeof __auto)")" = "object" ]
}
launch() {
  e2e_require_clean_slate
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-i18n.log" 2>&1 &
  local tries=0
  until e2e_automation_up; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 240 ]; then
      echo "FATAL: automation port never opened"
      exit 1
    fi
  done
  sleep 4
}
quit_app() {
  auto '{"id":99,"cmd":"quit"}' >/dev/null 2>&1
  local tries=0
  while e2e_app_running; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 20 ]; then
      break
    fi
  done
  e2e_kill_owned_ports
  sleep 4
}
# Open the fixture in a fresh doc window and wait for its i18n hooks; sets DL.
open_doc() {
  local boot
  boot=$(auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1)
  evl "$boot" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/note.txt'})" >/dev/null
  sleep 3
  DL=$(doc_label)
  local tries=0
  until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.setLanguage==='function'")" = "true" ]; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 30 ]; then
      echo "FATAL: doc window/hooks never appeared"
      quit_app
      exit 1
    fi
    DL=$(doc_label)
  done
}

echo "=== preflight ==="
for f in "$STORE"/*.json; do
  if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
    FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
    case "$FP" in
      *note-n-pad-e2e*)
        rm -f "$f"
        echo "preflight: removed scratchpad snapshot ($FP)"
        ;;
    esac
  fi
done
DOCS_NOW=$(count_kind document)
if [ "$DOCS_NOW" != "0" ]; then
  echo "FATAL: store already has $DOCS_NOW document snapshot(s); refusing to run"
  exit 1
fi

echo "=== fixtures ==="
rm -rf "$WORK"
mkdir -p "$WORK"
printf 'hello\nworld\n' >"$WORK/note.txt"

launch
open_doc

# Pin/restore the UI language: capture the user's real preference so an
# interrupt or normal exit restores it (and kills the app) instead of leaving
# settings.json flipped. The trap looks the doc label up live so it works after
# the restart below reassigns DL.
ORIG_LANG=$(evl "$DL" "String(__auto.getLanguage())")
echo "original language: $ORIG_LANG"
restore_lang() {
  trap '' INT TERM
  local dl
  dl=$(doc_label 2>/dev/null)
  if [ -n "$dl" ] && [ -n "${ORIG_LANG:-}" ]; then
    evl "$dl" "__auto.setLanguage('$ORIG_LANG')" >/dev/null 2>&1
  fi
  quit_app
  # Fallback: app is dead now, so patch settings.json directly in case the
  # app-side restore above never reached a live automation port.
  if [ -n "${ORIG_LANG:-}" ] && [ -f "$APPDIR/settings.json" ]; then
    jq --arg l "$ORIG_LANG" '.language = $l' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
      && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
  fi
  e2e_kill_owned_ports
}
trap restore_lang EXIT INT TERM

echo "=== live switch in the document window ==="
evl "$DL" "__auto.setLanguage('zh-TW')" >/dev/null
e2e_wait_until _label_is "$DL" "換行字元"
check "zh-TW status text" "$(line_ending_label "$DL")" "換行字元"
evl "$DL" "__auto.setLanguage('en')" >/dev/null
e2e_wait_until _label_is "$DL" "Line ending"
check "en status text (live, no restart)" "$(line_ending_label "$DL")" "Line ending"
evl "$DL" "__auto.setLanguage('ja')" >/dev/null
e2e_wait_until _label_is "$DL" "改行コード"
check "ja status text (live, no restart)" "$(line_ending_label "$DL")" "改行コード"

echo "=== resolvedLocale tracks the stored preference ==="
evl "$DL" "window.__TAURI_INTERNALS__.invoke('show_settings_window')" >/dev/null
e2e_wait_until _settings_auto_ready
evl "settings" "__auto.setLanguage('zh-TW')" >/dev/null
e2e_wait_eval "settings" "String(__auto.getSettings().resolvedLocale)" "zh-TW"
check "resolvedLocale for zh-TW" "$(evl "settings" "String(__auto.getSettings().resolvedLocale)")" "zh-TW"
evl "settings" "__auto.setLanguage('en')" >/dev/null
e2e_wait_eval "settings" "String(__auto.getSettings().resolvedLocale)" "en"
check "resolvedLocale for en" "$(evl "settings" "String(__auto.getSettings().resolvedLocale)")" "en"
evl "settings" "__auto.setLanguage('ja')" >/dev/null
e2e_wait_eval "settings" "String(__auto.getSettings().resolvedLocale)" "ja"
check "resolvedLocale for ja" "$(evl "settings" "String(__auto.getSettings().resolvedLocale)")" "ja"

echo "=== system mode resolves to the host locale ==="
# Derive the expected locale from the host UI language with the same prefix rule
# the app's resolveLocale uses, so the assertion tracks whatever machine runs it
# instead of hard-coding one host.
HOST_LOCALE=$(evl "settings" "(()=>{const l=(navigator.language||'').toLowerCase();return l.startsWith('zh')?'zh-TW':l.startsWith('ja')?'ja':'en';})()")
echo "host locale resolves to: $HOST_LOCALE"
evl "settings" "__auto.setLanguage('system')" >/dev/null
e2e_wait_eval "settings" "String(__auto.getSettings().resolvedLocale)" "$HOST_LOCALE"
check "system resolves to host locale ($HOST_LOCALE)" "$(evl "settings" "String(__auto.getSettings().resolvedLocale)")" "$HOST_LOCALE"

echo "=== cross-window sync (settings-changed broadcast) ==="
evl "settings" "__auto.setLanguage('en')" >/dev/null
e2e_wait_until _label_is "$DL" "Line ending"
check "settings change reaches the doc window (en)" "$(line_ending_label "$DL")" "Line ending"
evl "settings" "__auto.setLanguage('ja')" >/dev/null
e2e_wait_until _label_is "$DL" "改行コード"
check "doc window follows settings to ja" "$(line_ending_label "$DL")" "改行コード"

echo "=== persistence across restart ==="
evl "$DL" "__auto.setLanguage('ja')" >/dev/null
e2e_wait_setting language ja
quit_app
launch
open_doc
check "language persisted across restart" "$(evl "$DL" "String(__auto.getLanguage())")" "ja"
check "restored language renders in DOM (ja)" "$(line_ending_label "$DL")" "改行コード"

echo "=== teardown ==="
evl "$DL" "__auto.setLanguage('$ORIG_LANG')" >/dev/null
e2e_wait_setting language "$ORIG_LANG"
quit_app
for f in "$STORE"/*.json; do
  if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
    FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
    case "$FP" in
      *note-n-pad-e2e*)
        rm -f "$f"
        echo "cleaned: $f"
        ;;
    esac
  fi
done
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
