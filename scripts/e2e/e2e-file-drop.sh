#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: files dropped onto a window open as tabs or in new windows.
# simulate_drop hands a list of paths to the same handler a native drop reaches,
# so the routing is exercised without a real drag. Only one document window (D1)
# exists, so "the topmost document window" is always D1. Scenarios:
#   A. Two files dropped on D1 become two tabs of D1; no window is added.
#   B. The same file dropped on D1 again adds no tab and raises no failure.
#   C. One drop of [file, folder, missing path] opens only the file: the folder
#      and the missing path are skipped, so no open failure is raised.
#   D. Tab mode: a drop on a sticky opens in D1.
#   E. Tab mode: a drop on the workspace opens in D1.
#   F. Window mode: a drop on a sticky opens a new document window.
# D and E need D1 to be the window the shell picks, so they start by focusing
# D1 and waiting until the app reports it focused.
# The open_target setting is the user's real preference: the trap restores it
# on any exit, and patches settings.json directly if the app is already gone.
# The trap also wipes only this suite's own document snapshots (matched by the
# fixture path), and deletes the sticky this suite created, if it had to create
# one. A sticky that existed before the suite is never touched.
# Showing the workspace can make the app save its window bounds, so the four
# workspace_* keys are put back (or deleted, if absent) after the app quits.
# LESSON: never put `await` inside an eval string.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/file-drop-fixture"
PASS=0
FAIL=0
mkdir -p "$OUT"
: >"$OUT/dev-file-drop.log"

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
        *file-drop-fixture*)
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
# jq is a native binary on Windows and writes CRLF, so every value captured
# from it is stripped before it is compared.
evl() {
  auto "{\"id\":$(e2e_next_id),\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data' | tr -d '\r'
}
doc_labels() {
  auto '{"id":30,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label' | tr -d '\r'
}
doc_label() {
  doc_labels | head -1
}
doc_count() {
  auto '{"id":33,"cmd":"list_windows"}' | jq -r '[.data[]|select(.label|startswith("doc-"))]|length' | tr -d '\r'
}
doc_exists_any() {
  [ -n "$(doc_label)" ]
}
note_label() {
  auto '{"id":34,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-"))|.label' | tr -d '\r' | head -1
}
note_exists() {
  [ -n "$(note_label)" ]
}
# The first doc window that was not in $1, a newline-separated list captured
# before the window was asked for, or empty if none has appeared yet.
new_doc_label() {
  local known="$1" l
  doc_labels | while read -r l; do
    case "$known" in
      *"$l"*) ;;
      *)
        printf '%s\n' "$l"
        return 0
        ;;
    esac
  done
}
new_doc_exists() {
  [ -n "$(new_doc_label "$1")" ]
}
window_exists() {
  [ "$(auto '{"id":35,"cmd":"list_windows"}' | jq -r --arg l "$1" '[.data[]|select(.label==$l)]|length' | tr -d '\r')" = "1" ]
}
d1_focused() {
  [ "$(auto '{"id":36,"cmd":"list_windows"}' | jq -r --arg l "$D1" '.data[]|select(.label==$l)|.focused' | tr -d '\r')" = "true" ]
}
# Tab reads below always go to D1 unless a label is given.
tab_count() {
  e2e_read "${1:-$D1}" "String(__auto.getTabs().length)"
}
tabs_are() {
  [ "$(tab_count)" = "$1" ]
}
# Whether a tab of window ${2:-D1} has a path ending in the file name $1.
has_tab() {
  e2e_read "${2:-$D1}" "JSON.stringify(__auto.getTabs())" | jq -r --arg n "$1" 'any(.[]; .path | endswith($n))' | tr -d '\r'
}
tab_present() {
  [ "$(has_tab "$1")" = "true" ]
}
active_is() {
  [ "$(e2e_read "$D1" "JSON.stringify(__auto.getTabs())" | jq -r --arg n "$1" 'any(.[]; .active and (.path | endswith($n)))' | tr -d '\r')" = "true" ]
}
# String(null) would read as a failed measurement to e2e_read, so the test runs
# in the page.
no_open_failure() {
  e2e_read "$D1" "String(__auto.openFailed() === null)"
}
# Drop the paths $2... onto window $1.
drop() {
  local label="$1" paths req
  shift
  paths="$(printf '%s\n' "$@" | jq -R . | jq -sc .)"
  # Built outside the "$(...)" argument: bash 3.2 (macOS /bin/bash) brace-expands
  # a {...,...} written there and sends the request as four fragments.
  req="{\"id\":$(e2e_next_id),\"cmd\":\"simulate_drop\",\"label\":\"$label\",\"paths\":$paths}"
  check "simulate_drop on $label accepted" "$(auto "$req" | jq -r '.ok' | tr -d '\r')" "true"
}
launch() {
  e2e_require_clean_slate
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-file-drop.log" 2>&1 &
  e2e_report_port_holders
  local tries=0
  until e2e_automation_up; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 240 ]; then
      e2e_report_port_holders
      echo "FATAL: automation port never opened"
      exit 1
    fi
  done
  e2e_require_automation_listener "$OUT/dev-file-drop.log"
  # The dev server binds 1420 while the app is coming up, so this is the
  # first moment a leftover holding it is visible.
  e2e_report_port_holders
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
mkdir -p "$WORK/c-folder"
for name in d1 a1 a2 c-base d-drop e-drop f-drop; do
  printf 'fixture %s\n' "$name" >"$WORK/$name.txt"
done
MISSING="$WORK/c-missing.txt"
ls "$WORK"

ORIG_TARGET=""
# The workspace_* keys that were present in settings.json at setup, as sorted
# compact JSON; empty until captured.
WS_ORIG=""
WS_FILTER='with_entries(select(.key | IN("workspace_x", "workspace_y", "workspace_width", "workspace_height")))'
# Put the four workspace_* keys back exactly as captured, touching no others.
# Run after the app has quit.
restore_workspace_bounds() {
  if [ -z "$WS_ORIG" ] || [ ! -f "$APPDIR/settings.json" ]; then
    return 0
  fi
  if [ "$(jq -cS "$WS_FILTER" "$APPDIR/settings.json" 2>/dev/null | tr -d '\r')" = "$WS_ORIG" ]; then
    return 0
  fi
  jq --argjson o "$WS_ORIG" 'del(.workspace_x, .workspace_y, .workspace_width, .workspace_height) + $o' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" &&
    mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
}
# Id of the sticky this suite created with new_sticky; empty when it did not.
CREATED_STICKY=""
# Delete the created sticky through the app, via window $1.
delete_created_sticky() {
  if [ -n "$CREATED_STICKY" ] && [ -n "${1:-}" ]; then
    evl "$1" "window.__TAURI_INTERNALS__.invoke('delete_note',{id:'$CREATED_STICKY'})" >/dev/null 2>&1
  fi
}
# Remove the created sticky's snapshot file; the app may have written it back
# while quitting, or may already be gone. Run after the app has quit.
remove_created_sticky_file() {
  case "$CREATED_STICKY" in
    '' | *[!0-9a-f-]*) ;;
    *)
      rm -f "$STORE/$CREATED_STICKY.json"
      ;;
  esac
  CREATED_STICKY=""
}
restore_state() {
  trap '' INT TERM
  local dl
  dl=$(doc_label 2>/dev/null)
  if [ -n "$dl" ] && [ -n "$ORIG_TARGET" ]; then
    evl "$dl" "__auto.setOpenTarget('$ORIG_TARGET')" >/dev/null 2>&1
  fi
  if [ -z "$dl" ]; then
    dl=$(note_label 2>/dev/null)
  fi
  delete_created_sticky "$dl"
  quit_app
  remove_created_sticky_file
  restore_workspace_bounds
  # The app is gone now; patch the file in case the call above never landed.
  if [ -n "$ORIG_TARGET" ] && [ -f "$APPDIR/settings.json" ] &&
    [ "$(jq -r '.open_target // empty' "$APPDIR/settings.json" 2>/dev/null)" != "$ORIG_TARGET" ]; then
    jq --arg t "$ORIG_TARGET" '.open_target = $t' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" &&
      mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
  fi
  wipe_test_docs
  e2e_kill_owned_ports
}
trap restore_state EXIT
trap 'exit 1' INT TERM

echo "=== setup ==="
launch
STICKY="$(note_label)"
if [ -z "$STICKY" ]; then
  CREATED_STICKY="$(auto '{"id":5,"cmd":"new_sticky"}' | jq -r '.data.id // empty' | tr -d '\r')"
  e2e_wait_until note_exists
  STICKY="$(note_label)"
fi
if [ -z "$STICKY" ]; then
  echo "FATAL: no sticky window"
  exit 1
fi
echo "sticky: $STICKY"
ORIG_TARGET="$(jq -r '.open_target // empty' "$APPDIR/settings.json" 2>/dev/null)"
if [ -z "$ORIG_TARGET" ]; then
  ORIG_TARGET="tab"
fi
echo "original open_target: $ORIG_TARGET"
if [ -f "$APPDIR/settings.json" ]; then
  WS_ORIG="$(jq -cS "$WS_FILTER" "$APPDIR/settings.json" 2>/dev/null | tr -d '\r')"
else
  WS_ORIG='{}'
fi
echo "original workspace keys: $WS_ORIG"
evl "$STICKY" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/d1.txt'})" >/dev/null
e2e_wait_until doc_exists_any
D1="$(doc_label)"
if [ -z "$D1" ]; then
  echo "FATAL: doc window never appeared"
  exit 1
fi
e2e_wait_eval "$D1" "String(typeof __auto!=='undefined' && typeof __auto.getTabs==='function' && __auto.getTabs().length===1)" "true"
echo "D1: $D1"
evl "$D1" "__auto.setOpenTarget('tab')" >/dev/null
if ! e2e_wait_setting open_target "tab"; then
  bad "open_target never became tab"
fi
check "setup: D1 holds d1.txt only" "$(has_tab d1.txt)/$(tab_count)" "true/1"

echo "=== scenario A: two files dropped on D1 ==="
DOCS_BEFORE="$(doc_count)"
TABS_BEFORE="$(tab_count)"
drop "$D1" "$WORK/a1.txt" "$WORK/a2.txt"
e2e_wait_until tabs_are $((TABS_BEFORE + 2))
check "A: two tabs added to D1" "$(tab_count)" "$((TABS_BEFORE + 2))"
check "A: a1.txt is a tab of D1" "$(has_tab a1.txt)" "true"
check "A: a2.txt is a tab of D1" "$(has_tab a2.txt)" "true"
check "A: document window count unchanged" "$(doc_count)" "$DOCS_BEFORE"

echo "=== scenario B: the same file dropped again ==="
evl "$D1" "__auto.switchTab(0)" >/dev/null
e2e_wait_until active_is d1.txt
TABS_BEFORE="$(tab_count)"
drop "$D1" "$WORK/a1.txt"
# The existing tab is activated, which is the open finishing.
e2e_wait_until active_is a1.txt
sleep 2
check "B: no open failure" "$(no_open_failure)" "true"
check "B: tab count unchanged" "$(tab_count)" "$TABS_BEFORE"
check "B: document window count unchanged" "$(doc_count)" "$DOCS_BEFORE"

echo "=== scenario C: file, folder and missing path in one drop ==="
TABS_BEFORE="$(tab_count)"
drop "$D1" "$WORK/c-base.txt" "$WORK/c-folder" "$MISSING"
e2e_wait_until tab_present c-base.txt
sleep 2
check "C: base file opened" "$(has_tab c-base.txt)" "true"
check "C: no open failure" "$(no_open_failure)" "true"
check "C: only the base file added a tab" "$(tab_count)" "$((TABS_BEFORE + 1))"
check "C: document window count unchanged" "$(doc_count)" "$DOCS_BEFORE"

echo "=== focus D1 ==="
auto "{\"id\":$(e2e_next_id),\"cmd\":\"focus\",\"label\":\"$D1\"}" >/dev/null
FOCUS_OK=1
if ! e2e_wait_until 60 d1_focused; then
  FOCUS_OK=0
  bad "precondition: D1 never got focus"
fi

if [ "$FOCUS_OK" = "1" ]; then
  echo "=== scenario D: tab mode, drop on a sticky ==="
  TABS_BEFORE="$(tab_count)"
  drop "$STICKY" "$WORK/d-drop.txt"
  e2e_wait_until tab_present d-drop.txt
  check "D: file opened in D1" "$(has_tab d-drop.txt)" "true"
  check "D: one tab added to D1" "$(tab_count)" "$((TABS_BEFORE + 1))"
  check "D: document window count unchanged" "$(doc_count)" "$DOCS_BEFORE"

  echo "=== scenario E: tab mode, drop on the workspace ==="
  evl "$D1" "window.__TAURI_INTERNALS__.invoke('show_workspace_window')" >/dev/null
  if e2e_wait_until window_exists workspace; then
    TABS_BEFORE="$(tab_count)"
    drop workspace "$WORK/e-drop.txt"
    e2e_wait_until tab_present e-drop.txt
    check "E: file opened in D1" "$(has_tab e-drop.txt)" "true"
    check "E: one tab added to D1" "$(tab_count)" "$((TABS_BEFORE + 1))"
    check "E: document window count unchanged" "$(doc_count)" "$DOCS_BEFORE"
  else
    bad "E: workspace window never appeared"
  fi
fi

echo "=== scenario F: window mode, drop on a sticky ==="
evl "$D1" "__auto.setOpenTarget('window')" >/dev/null
if ! e2e_wait_setting open_target "window"; then
  bad "open_target never became window"
fi
TABS_BEFORE="$(tab_count)"
KNOWN="$(doc_labels)"
drop "$STICKY" "$WORK/f-drop.txt"
e2e_wait_until 60 new_doc_exists "$KNOWN"
check "F: a document window was added" "$(doc_count)" "$((DOCS_BEFORE + 1))"
F1="$(new_doc_label "$KNOWN")"
if [ -n "$F1" ]; then
  e2e_wait_eval "$F1" "String(typeof __auto!=='undefined' && typeof __auto.getTabs==='function' && __auto.getTabs().length===1)" "true"
  check "F: the new window holds the dropped file" "$(has_tab f-drop.txt "$F1")" "true"
  check "F: the new window holds one tab" "$(tab_count "$F1")" "1"
else
  bad "F: the new window never appeared"
fi
check "F: D1 tab count unchanged" "$(tab_count)" "$TABS_BEFORE"
check "F: D1 did not take the file" "$(has_tab f-drop.txt)" "false"

echo "=== restore open_target ==="
evl "$D1" "__auto.setOpenTarget('$ORIG_TARGET')" >/dev/null
e2e_wait_setting open_target "$ORIG_TARGET"
check "open_target restored" "$(jq -r '.open_target // empty' "$APPDIR/settings.json" 2>/dev/null)" "$ORIG_TARGET"

echo "=== teardown ==="
delete_created_sticky "$D1"
quit_app
remove_created_sticky_file
restore_workspace_bounds
wipe_test_docs
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
