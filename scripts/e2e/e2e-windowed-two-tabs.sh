#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: a windowed editor's result is applied to the tab that sent it.
# Two windowed tabs A and B are open in one document window. An edit is typed in
# A and the continuation of its windowed_apply result is parked in the editor
# (dev hook `holdWindowedResults`); B becomes the active tab; the result is then
# released. A, not B, must end up dirty.
# `switchTab` settles and drains the active editor first, so the held result
# would be applied before B became active and the race would never happen. The
# dev hook `switchTabNow` skips that wait, which is the only way to put the
# result after the switch.
# LESSON: never put `await` inside an eval string; use `.then((r)=>{window.__x=r;})`.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. The trap only quits the app and wipes this suite's own
# document snapshots (matched by the fixture path); no user setting is touched.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/windowed-two-tabs-fixture"
PASS=0
FAIL=0
mkdir -p "$OUT"
: >"$OUT/dev-windowed-two-tabs.log"

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
        *windowed-two-tabs-fixture*)
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
doc_label_ready() {
  [ -n "$(doc_label)" ]
}
evl() {
  auto "{\"id\":$(e2e_next_id),\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
launch() {
  e2e_require_clean_slate
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-windowed-two-tabs.log" 2>&1 &
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
  e2e_require_automation_listener "$OUT/dev-windowed-two-tabs.log"
  # The dev server binds 1420 while the app is coming up, so this is the
  # first moment a leftover holding it is visible; the app answering on
  # the automation port does not mean vite got its port.
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
# Dirty flag of the tab whose path ends in $1, as the tab bar reads it.
tab_dirty() {
  e2e_read "$DL" "String(__auto.getTabs().find((t)=>t.path.endsWith('$1')).dirty)"
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
# seed.txt only gives the document window something to open on; a.log and b.log
# are the two windowed tabs. Their lines differ in the 12th character so the
# editor on screen can be told apart from the content.
python3 - <<PYEOF
with open('$WORK/seed.txt', 'w', newline='') as f:
    f.write('seed\n')
for name in ('a', 'b'):
    with open('$WORK/' + name + '.log', 'w', newline='') as f:
        f.write('\n'.join(f'{i:010d} {name}' + 'x' * 35 for i in range(1, 100001)) + '\n')
PYEOF

restore_state() {
  trap '' INT TERM
  quit_app
  wipe_test_docs
  e2e_kill_owned_ports
}
trap restore_state EXIT
trap 'exit 1' INT TERM

echo "=== open two windowed tabs ==="
launch
BOOT=$(auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1)
evl "$BOOT" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/seed.txt'})" >/dev/null
e2e_wait_until doc_label_ready
DL=$(doc_label)
if [ -z "$DL" ]; then
  echo "FATAL: no document window appeared"
  exit 1
fi
e2e_wait_eval "$DL" "String(typeof __auto!=='undefined' && typeof __auto.windowedOpen==='function' && __auto.getTabs().length===1)" "true"
evl "$DL" "__auto.windowedOpen('$WORK/a.log').then((r)=>{window.__oa=r;})" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length===2 && __auto.isWindowedTab())" "true"
evl "$DL" "__auto.windowedOpen('$WORK/b.log').then((r)=>{window.__ob=r;})" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length===3 && __auto.isWindowedTab())" "true"
# A refused open answers with a message, an accepted one with null; `e2e_read`
# takes a literal null for a failed read, so the comparison happens in the page.
check "a.log opened without refusal" "$(e2e_read "$DL" "String(window.__oa===null)")" "true"
check "b.log opened without refusal" "$(e2e_read "$DL" "String(window.__ob===null)")" "true"
# Tabs are in open order: 0 seed, 1 a.log, 2 b.log.
evl "$DL" "__auto.switchTab(1)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs()[1].active && __auto.isWindowedTab() && __auto.getContent().startsWith('0000000001 a') && __auto.windowedInfo().windowStartLine===0)" "true"
check "a.log starts clean" "$(tab_dirty '/a.log')" "false"
check "b.log starts clean" "$(tab_dirty '/b.log')" "false"

echo "=== hold the apply result of an edit in A ==="
# window.__TAURI_INTERNALS__.invoke is defined non-writable, so it cannot be
# wrapped from the page; the editor parks the result itself instead.
evl "$DL" "__auto.holdWindowedResults(true)" >/dev/null
evl "$DL" "__auto.typeText('RACEMARK')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.heldWindowedResults()>=1)" "true"
check "the result is parked in the editor" "$(e2e_read "$DL" "String(__auto.heldWindowedResults()>=1)")" "true"
check "A's edit was sent but its result is held" "$(tab_dirty '/a.log')" "false"

echo "=== switch to B before the result lands ==="
evl "$DL" "__auto.switchTabNow(2)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs()[2].active && __auto.isWindowedTab() && __auto.getContent().startsWith('0000000001 b'))" "true"
check "B is the active tab, showing b.log" "$(e2e_read "$DL" "String(__auto.getContent().startsWith('0000000001 b'))")" "true"
check "result still held after the switch" "$(e2e_read "$DL" "String(__auto.heldWindowedResults()>=1)")" "true"

echo "=== release the result ==="
evl "$DL" "__auto.releaseWindowedResults()" >/dev/null
# Whichever tab the result was applied to turns dirty; the 20 s bound only
# decides how long a result that never lands takes to report.
e2e_wait_until 20 _e2e_eval_equals "$DL" "String(__auto.getTabs().some((t)=>t.dirty))" "true"
sleep 1
check "A is dirty" "$(tab_dirty '/a.log')" "true"
check "B is not dirty" "$(tab_dirty '/b.log')" "false"
check "the seed tab is not dirty" "$(tab_dirty '/seed.txt')" "false"
check "B is still the active tab" "$(e2e_read "$DL" "String(__auto.getTabs()[2].active)")" "true"

echo "=== undo in A is clean again ==="
evl "$DL" "__auto.holdWindowedResults(false)" >/dev/null
evl "$DL" "__auto.switchTab(1)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs()[1].active && __auto.isWindowedTab() && __auto.getContent().startsWith('RACEMARK0000000001 a'))" "true"
evl "$DL" "__auto.windowedUndo()" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getContent().startsWith('0000000001 a'))" "true"
check "A back to its saved content is clean" "$(tab_dirty '/a.log')" "false"

echo "=== teardown ==="
quit_app
wipe_test_docs
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
