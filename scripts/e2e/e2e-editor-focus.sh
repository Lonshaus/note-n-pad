#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: editor keyboard-focus handoff.
# A document window opened programmatically or restored on launch used to leave
# focus on BODY, so the WebView silently dropped the first keystrokes until the
# user clicked the editor. The fix reclaims focus for the active editor at load,
# on window focus, and after a tab switch — but never while a dialog is up or an
# input field holds focus. Three scenarios:
#   A. Restore-then-type: open + dirty a tab, quit (snapshot), relaunch, and with
#      NO focus operation assert the editor already holds focus; then inject text
#      via the DOM (execCommand insertText) and confirm it lands and marks dirty.
#      This is the exact user-visible flow the bug broke.
#   B. Dialog not stolen: with the oversized gate up, fire the window-focus path
#      and assert focus stays OFF the editor (the dialog keeps the keyboard).
#   C. Open-then-type: open a fresh file window, and with no click assert the
#      editor holds focus.
# BLIND SPOT: this suite proves the WEB-layer focus (document.activeElement on
# .cm-content), but it CANNOT see the macOS native responder chain. show() alone
# does not make the WKWebView first responder, so real hardware keystrokes are
# dropped until a click even when these checks are green; the Rust `reveal_self`
# command pairs show() with set_focus() to fix it. Automation (CM txns, DOM
# events) bypasses the native layer, so verify that part by hand: launch, then
# type WITHOUT clicking the editor and confirm the characters appear.
# LESSON: never put `await` inside an eval string; use `.then((r)=>{window.__x=r;})`.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. The trap only quits the app and wipes this suite's own
# document snapshots (matched by the fixture path); no user setting is touched.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/editor-focus-fixture"
MARKER="FOCUSMARKERA"
DOMMARK="FOCUSDOMB"
PASS=0
FAIL=0
mkdir -p "$OUT"
: >"$OUT/dev-editor-focus.log"

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
wipe_test_docs() {
  for f in "$STORE"/*.json; do
    if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
      FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
      case "$FP" in
        *editor-focus-fixture*)
          rm -f "$f"
          ;;
      esac
    fi
  done
}

cd "$REPO" || exit 1
source "$HOME/.cargo/env" 2>/dev/null

auto() {
  node scripts/auto.mjs "$1"
}
doc_label() {
  auto '{"id":3,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label' | head -1
}
doc_count() {
  auto '{"id":3,"cmd":"list_windows"}' | jq -r '[.data[]|select(.label|startswith("doc-"))]|length'
}
evl() {
  auto "{\"id\":9,\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
launch() {
  e2e_require_clean_slate
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-editor-focus.log" 2>&1 &
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
open_doc() {
  # $1 = path; opens it as a normal editable tab and sets DL to its window label.
  local boot
  boot=$(auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1)
  evl "$boot" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$1'})" >/dev/null
  sleep 3
  DL=$(doc_label)
  local tries=0
  until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.getTabs==='function' && __auto.getTabs().length>=1")" = "true" ]; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 60 ]; then
      echo "FATAL: doc window never appeared for $1"
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
      *note-n-pad-e2e* | *note-n-pad-test*)
        rm -f "$f"
        echo "preflight: removed test snapshot"
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
# small.txt: a few KB editable tab (scenarios A and C).
python3 - <<PYEOF
with open('$WORK/small.txt', 'w', newline='') as f:
    f.write(('s' * 40 + '\n') * 200)
PYEOF
# huge.txt: ~16.8M chars; once dirty it exceeds the 16M snapshot ceiling so a
# close raises the oversized gate (scenario B reuses that dialog).
python3 - <<PYEOF
with open('$WORK/huge.txt', 'w', newline='') as f:
    f.write(('h' * 50 + '\n') * 330000)
PYEOF
echo "small.txt bytes: $(file_size "$WORK/small.txt")"
echo "huge.txt bytes:  $(file_size "$WORK/huge.txt")"

restore_state() {
  trap '' INT TERM
  quit_app
  wipe_test_docs
  e2e_kill_owned_ports
}
trap restore_state EXIT INT TERM

echo "=== scenario C: open new file, no click, editor is focused ==="
launch
open_doc "$WORK/small.txt"
check "opened as an editable tab" "$(evl "$DL" "String(__auto.isLargeTab())")" "false"
# No click, no focus op: the load-time handoff must have focused the editor.
check "editor holds focus right after open" "$(evl "$DL" "String(__auto.editorFocused())")" "true"

echo "=== scenario A setup: dirty the tab, quit to snapshot ==="
evl "$DL" "__auto.typeText('$MARKER')" >/dev/null
sleep 1
check "dirty after typing marker" "$(evl "$DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[]|select(.active)|.dirty')" "true"
quit_app

echo "=== scenario A: restore then type via the DOM, no focus op ==="
launch
sleep 3
DL=$(doc_label)
tries=0
until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.getContent==='function'")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
  DL=$(doc_label)
done
tries=0
until [ "$(evl "$DL" "String(__auto.getContent().includes('$MARKER'))")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
done
check "restored tab holds the marker" "$(evl "$DL" "String(__auto.getContent().includes('$MARKER'))")" "true"
# THE bug: without any focus operation the editor must already own the keyboard,
# and .cm-content must be the document's activeElement.
check "editor holds focus after restore" "$(evl "$DL" "String(__auto.editorFocused())")" "true"
check "cm-content is activeElement" "$(evl "$DL" "String(document.activeElement===document.querySelector('.cm-content'))")" "true"
# Inject text through the real DOM path (execCommand insertText fires the same
# beforeinput/input CM handles for a keystroke). This is what the WebView dropped.
evl "$DL" "document.execCommand('insertText',false,'$DOMMARK')" >/dev/null
sleep 1
check "DOM-typed text landed in the buffer" "$(evl "$DL" "String(__auto.getContent().includes('$DOMMARK'))")" "true"
check "tab is dirty after DOM typing" "$(evl "$DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[]|select(.active)|.dirty')" "true"
quit_app
wipe_test_docs

echo "=== scenario B: oversized gate keeps the keyboard on window focus ==="
launch
open_doc "$WORK/huge.txt"
evl "$DL" "__auto.typeText('X')" >/dev/null
sleep 1
check "huge tab dirty after typing" "$(evl "$DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[]|select(.active)|.dirty')" "true"
# Close raises the oversized gate (too big to snapshot); the window stays.
evl "$DL" "window.__TAURI_INTERNALS__.invoke('plugin:window|close')" >/dev/null
tries=0
until [ "$(evl "$DL" "String(__auto.oversizedGateVisible())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 20 ]; then
    break
  fi
done
check "oversized gate visible" "$(evl "$DL" "String(__auto.oversizedGateVisible())")" "true"
# Fire the window-focus handoff path while the gate is up: focus must NOT move to
# the editor, so a dialog button keeps the keyboard.
evl "$DL" "__auto.windowFocusGained()" >/dev/null
sleep 1
check "gate still up after window focus" "$(evl "$DL" "String(__auto.oversizedGateVisible())")" "true"
check "editor did NOT steal focus from the gate" "$(evl "$DL" "String(__auto.editorFocused())")" "false"
# Cancel the gate and leave the window open; teardown quits.
evl "$DL" "__auto.oversizedGateCancel()" >/dev/null
sleep 1
check "gate dismissed after cancel" "$(evl "$DL" "String(__auto.oversizedGateVisible())")" "false"
quit_app
wipe_test_docs

echo "=== teardown ==="
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
