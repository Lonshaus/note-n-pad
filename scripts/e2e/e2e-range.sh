#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: range editing.
# Open a line range of a large file in the edit box over its viewer tab, edit
# it, write it back, and verify the original file byte-precisely. Also covers
# cancel, conflict handling (write anyway, save as a new file), byte-faithful
# save range (opens the new file as a new tab), the close gate (tab, window,
# quit) while the box has changes, and the records an earlier version left: a
# range tab with edits opens as an untitled tab, one without is deleted.
# LESSON: never put `await` inside an eval string.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. If the automation port is already dead when the trap
# fires, the app-side restore call (ECONNREFUSED) is skipped and settings.json
# is left pinned. As a fallback once the app is confirmed dead, patch
# settings.json directly with jq so the on-disk language always reverts.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/range-fixture"
PASS=0
FAIL=0
mkdir -p "$OUT"
: >"$OUT/dev-range.log"

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
doc_count() {
  auto '{"id":3,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label' | wc -l | tr -d ' '
}
evl() {
  auto "{\"id\":$(e2e_next_id),\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
launch() {
  e2e_require_clean_slate
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-range.log" 2>&1 &
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
  e2e_require_automation_listener "$OUT/dev-range.log"
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
open_large() {
  # $1 = path; opens it and accepts the large-view confirm; sets DL.
  local boot
  boot=$(auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1)
  evl "$boot" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$1'})" >/dev/null
  sleep 4
  DL=$(doc_label)
  local tries=0
  until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.largeConfirmVisible==='function'")" = "true" ]; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 30 ]; then
      echo "FATAL: doc window never appeared"
      quit_app
      exit 1
    fi
    DL=$(doc_label)
  done
  if [ "$(e2e_read "$DL" "String(__auto.largeConfirmVisible())")" = "true" ]; then
    evl "$DL" "__auto.largeConfirmAccept()" >/dev/null
    sleep 2
  fi
}

box_save() {
  # Runs the box's write-back and prints its result ('ok', 'mismatch', 'error').
  evl "$DL" "window.__r=undefined" >/dev/null
  evl "$DL" "__auto.rangeBoxSave().then((r)=>{window.__r=r;},(e)=>{window.__r='ERR '+String(e);})" >/dev/null
  e2e_wait_eval "$DL" "String(window.__r!==undefined)" "true"
  e2e_read "$DL" "String(window.__r)"
}
wait_indexed() {
  e2e_wait_eval "$DL" "String(__auto.largeInfo().totalLines !== null)" "true"
}
open_box() {
  # $1 $2 = first and last line; waits for the box to be up.
  evl "$DL" "__auto.largeSelectRange($1, $2)" >/dev/null
  evl "$DL" "__auto.largeRangeEdit()" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.rangeBoxVisible())" "true"
}
tab_count() {
  e2e_read "$DL" "String(__auto.getTabs().length)"
}
active_tab() {
  # $1 = jq field of the active tab.
  e2e_read "$DL" "JSON.stringify(__auto.getTabs())" | jq -r ".[]|select(.active)|.$1"
}
file_has() {
  # $1 = marker; prints True when the source holds it.
  python3 -c "print(b'$1' in open('$WORK/big.log','rb').read())"
}

echo "=== preflight ==="
for f in "$STORE"/*.json; do
  if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
    FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
    RS=$(jq -r '.range_source // empty' "$f" 2>/dev/null)
    case "$FP$RS" in
      *note-n-pad-e2e*)
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
python3 - <<PYEOF
lines = 2400000
with open('$WORK/big.log', 'w', newline='') as f:
    for i in range(1, lines + 1):
        f.write(f'line {i:07d} abcdefghijklmnopqrstuvwxyz0123456789\n')
PYEOF
ORIG_SIZE=$(file_size "$WORK/big.log")
echo "big.log bytes: $ORIG_SIZE"
# Restore the user's UI language and kill the app on interrupt or normal exit.
# The trap looks the doc label up live because the restart section reassigns DL.
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
trap restore_lang EXIT
trap 'exit 1' INT TERM

launch
open_large "$WORK/big.log"

# Pin the UI language so the text assertions below never depend on the host
# system language; the trap restores the user's real preference.
ORIG_LANG=$(e2e_read "$DL" "String(__auto.getLanguage())")
echo "original language: $ORIG_LANG"
evl "$DL" "__auto.setLanguage('zh-TW')" >/dev/null
sleep 1

echo "=== select and open the edit box ==="
wait_indexed
evl "$DL" "__auto.largeSelectRange(100, 200)" >/dev/null
check "range recorded" "$(e2e_read "$DL" "JSON.stringify(__auto.largeGetRange())")" '{"startLine":100,"endLine":200}'
evl "$DL" "__auto.largeRangeEdit()" >/dev/null
e2e_wait_eval "$DL" "String(__auto.rangeBoxVisible())" "true"
check "edit box opened" "$(e2e_read "$DL" "String(__auto.rangeBoxVisible())")" "true"
check "no tab was added" "$(tab_count)" "1"
check "box covers the lines picked" "$(e2e_read "$DL" "JSON.stringify(__auto.rangeBoxInfo())" | jq -c '{startByte,endByte}')" '{"startByte":4950,"endByte":10000}'
check "content starts at line 100" "$(e2e_read "$DL" "String(__auto.getContent().startsWith('line 0000100 '))")" "true"
check "content ends at line 200" "$(e2e_read "$DL" "String(__auto.getContent().trimEnd().endsWith('line 0000200 abcdefghijklmnopqrstuvwxyz0123456789'))")" "true"
check "box starts clean" "$(e2e_read "$DL" "String(__auto.rangeBoxDirty())")" "false"

echo "=== edit and write back ==="
evl "$DL" "__auto.typeText('EDITED>>')" >/dev/null
check "box is dirty after typing" "$(e2e_read "$DL" "String(__auto.rangeBoxDirty())")" "true"
check "the viewer tab itself stays clean" "$(active_tab dirty)" "false"
check "write-back result ok" "$(box_save)" "ok"
PYOUT=$(python3 - <<PYEOF
lines = open('$WORK/big.log', 'rb').read().split(b'\n')
r = []
r.append(lines[98] == b'line 0000099 abcdefghijklmnopqrstuvwxyz0123456789')
r.append(b'EDITED>>' in lines[99])
r.append(lines[200] == b'line 0000201 abcdefghijklmnopqrstuvwxyz0123456789')
print(all(r))
PYEOF
)
check "original file spliced precisely" "$PYOUT" "True"
NEW_SIZE=$(file_size "$WORK/big.log")
check "size grew by 8 bytes" "$((NEW_SIZE - ORIG_SIZE))" "8"
check "box closed after the write" "$(e2e_read "$DL" "String(__auto.rangeBoxVisible())")" "false"
check "still one tab" "$(tab_count)" "1"
check "viewer tab clean" "$(active_tab dirty)" "false"
wait_indexed
check "viewer shows the edit" "$(e2e_read "$DL" "String(__auto.largeInfo().size)")" "$NEW_SIZE"

echo "=== cancel drops the edit ==="
open_box 300 310
evl "$DL" "__auto.typeText('LOST>>')" >/dev/null
check "box dirty" "$(e2e_read "$DL" "String(__auto.rangeBoxDirty())")" "true"
evl "$DL" "__auto.rangeBoxCancel()" >/dev/null
check "box closed by cancel" "$(e2e_read "$DL" "String(__auto.rangeBoxVisible())")" "false"
check "source untouched by cancel" "$(file_has LOST)" "False"
check "size untouched by cancel" "$(file_size "$WORK/big.log")" "$NEW_SIZE"

echo "=== conflict flow: write anyway ==="
open_box 300 310
evl "$DL" "__auto.typeText('AGAIN>>')" >/dev/null
# The source changes while the box is open.
printf 'external change\n' >>"$WORK/big.log"
check "mismatch detected" "$(box_save)" "mismatch"
check "conflict modal shown" "$(e2e_read "$DL" "String(__auto.rangeConflictVisible())")" "true"
check "box kept under the modal" "$(e2e_read "$DL" "String(__auto.rangeBoxVisible())")" "true"
evl "$DL" "window.__r=undefined" >/dev/null
evl "$DL" "__auto.rangeConflictForce().then((r)=>{window.__r=r;},(e)=>{window.__r='ERR '+String(e);})" >/dev/null
e2e_wait_eval "$DL" "String(window.__r!==undefined)" "true"
check "force write landed" "$(python3 -c "
data = open('$WORK/big.log','rb').read()
print(b'AGAIN>>' in data and b'external change' in data)
")" "True"
check "modal gone after force" "$(e2e_read "$DL" "String(__auto.rangeConflictVisible())")" "false"
check "box closed after force" "$(e2e_read "$DL" "String(__auto.rangeBoxVisible())")" "false"
wait_indexed

echo "=== conflict flow: save as a new file ==="
open_box 300 310
evl "$DL" "__auto.typeText('SAVEAS>>')" >/dev/null
printf 'external change two\n' >>"$WORK/big.log"
SIZE_BEFORE=$(file_size "$WORK/big.log")
check "mismatch detected again" "$(box_save)" "mismatch"
evl "$DL" "window.__r=undefined" >/dev/null
evl "$DL" "__auto.rangeConflictSaveAs('$WORK/conflict-out.txt').then((r)=>{window.__r=String(r);},(e)=>{window.__r='ERR '+String(e);})" >/dev/null
e2e_wait_eval "$DL" "String(window.__r!==undefined)" "true"
check "save as reported success" "$(e2e_read "$DL" "String(window.__r)")" "true"
check "new file holds the edited text" "$(python3 -c "
data = open('$WORK/conflict-out.txt','rb').read()
print(data.startswith(b'SAVEAS>>AGAIN>>line 0000300 '))
")" "True"
check "source left as it was" "$(file_size "$WORK/big.log")" "$SIZE_BEFORE"
check "box closed" "$(e2e_read "$DL" "String(__auto.rangeBoxVisible())")" "false"
check "new file opened as a new tab" "$(tab_count)" "2"
check "the new tab is the active one" "$(active_tab path)" "$WORK/conflict-out.txt"
evl "$DL" "__auto.switchTab(0)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.isLargeTab())" "true"
wait_indexed

echo "=== save range: byte-faithful, opens as a new tab ==="
evl "$DL" "__auto.largeSelectRange(100, 200)" >/dev/null
evl "$DL" "window.__r=undefined" >/dev/null
evl "$DL" "__auto.largeRangeSaveAs('$WORK/slice.bin').then((r)=>{window.__r=String(r);},(e)=>{window.__r='ERR '+String(e);})" >/dev/null
e2e_wait_eval "$DL" "String(window.__r!==undefined)" "true"
check "save range reported success" "$(e2e_read "$DL" "String(window.__r)")" "true"
CMP=$(python3 - <<PYEOF
lines = open('$WORK/big.log', 'rb').read().splitlines(keepends=True)
print(b''.join(lines[99:200]) == open('$WORK/slice.bin', 'rb').read())
PYEOF
)
check "saved bytes identical to the source lines" "$CMP" "True"
check "saved file opened as a new tab" "$(tab_count)" "3"
check "the new tab is the active one" "$(active_tab path)" "$WORK/slice.bin"
evl "$DL" "__auto.switchTab(0)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.isLargeTab())" "true"
wait_indexed

echo "=== a box with changes holds back the tab, the window and the quit ==="
open_box 400 410
evl "$DL" "__auto.typeText('GATE>>')" >/dev/null
evl "$DL" "__auto.closeActiveTab()" >/dev/null
e2e_wait_eval "$DL" "String(__auto.oversizedGateVisible())" "true"
check "closing the tab raises the gate" "$(e2e_read "$DL" "String(__auto.oversizedGateVisible())")" "true"
check "the tab stays" "$(tab_count)" "3"
evl "$DL" "__auto.oversizedGateCancel()" >/dev/null
check "cancel dismisses the gate" "$(e2e_read "$DL" "String(__auto.oversizedGateVisible())")" "false"
check "the box keeps its edit" "$(e2e_read "$DL" "String(__auto.rangeBoxDirty())")" "true"
evl "$DL" "window.__TAURI_INTERNALS__.invoke('plugin:window|close')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.oversizedGateVisible())" "true"
check "closing the window raises the gate" "$(e2e_read "$DL" "String(__auto.oversizedGateVisible())")" "true"
check "the window stays" "$(doc_count)" "1"
evl "$DL" "__auto.oversizedGateCancel()" >/dev/null
auto "{\"id\":$(e2e_next_id),\"cmd\":\"quit\"}" >/dev/null
e2e_wait_eval "$DL" "String(__auto.oversizedGateVisible())" "true"
check "quitting raises the gate" "$(e2e_read "$DL" "String(__auto.oversizedGateVisible())")" "true"
check "the app is still running" "$(e2e_app_running && echo alive || echo gone)" "alive"
evl "$DL" "__auto.oversizedGateCancel()" >/dev/null
sleep 2
check "the quit stays vetoed after cancel" "$(e2e_app_running && echo alive || echo gone)" "alive"
check "the box keeps its edit after the veto" "$(e2e_read "$DL" "String(__auto.rangeBoxDirty())")" "true"
auto "{\"id\":$(e2e_next_id),\"cmd\":\"quit\"}" >/dev/null
e2e_wait_eval "$DL" "String(__auto.oversizedGateVisible())" "true"
evl "$DL" "__auto.oversizedGateSave()" >/dev/null
e2e_wait_until 60 e2e_app_gone
check "the quit went on once the box was written back" "$(e2e_app_running && echo alive || echo gone)" "gone"
e2e_kill_owned_ports
check "the write landed" "$(file_has 'GATE>>')" "True"

echo "=== restart: the box leaves no record ==="
launch
sleep 3
DL=$(doc_label)
tries=0
until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.rangeBoxVisible==='function'")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
  DL=$(doc_label)
done
check "no box after restart" "$(e2e_read "$DL" "String(__auto.rangeBoxVisible())")" "false"
RANGE_SNAPS=$(jq -r 'select(.range_source != null) | .range_source' "$STORE"/*.json 2>/dev/null | grep -c "big.log" || true)
check "no range record in the store" "$RANGE_SNAPS" "0"

echo "=== records an earlier version left ==="
quit_app
for f in "$STORE"/*.json; do
  if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
    rm -f "$f"
  fi
done
cat >"$STORE/old-dirty.json" <<JSONEOF
{"id":"old-dirty","content":"OLD-EDIT>>\nsecond line","file_path":"","kind":"document","dirty":true,"window_group":"old-dirty-group","tab_index":0,"line_ending":"LF","range_source":"$WORK/big.log","range_start":0,"range_end":100,"range_start_line":1}
JSONEOF
cat >"$STORE/old-clean.json" <<JSONEOF
{"id":"old-clean","content":"","file_path":"","kind":"document","dirty":false,"window_group":"old-clean-group","tab_index":0,"line_ending":"LF","range_source":"$WORK/big.log","range_start":0,"range_end":100,"range_start_line":1}
JSONEOF
launch
sleep 4
check "a record with nothing unsaved is deleted at startup" "$([ -f "$STORE/old-clean.json" ] && echo present || echo absent)" "absent"
check "and its group opened no window" "$(auto '{"id":3,"cmd":"list_windows"}' | jq -r '.data[].label' | grep -c '^doc-old-clean-group$' || true)" "0"
OLD_DL="doc-old-dirty-group"
e2e_wait_eval "$OLD_DL" "typeof __auto!=='undefined' && typeof __auto.getTabs==='function'" "true"
check "a record with edits opened as one tab" "$(e2e_read "$OLD_DL" "String(__auto.getTabs().length)")" "1"
check "the tab is untitled" "$(e2e_read "$OLD_DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[0].path')" ""
check "the tab is dirty" "$(e2e_read "$OLD_DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[0].dirty')" "true"
check "the tab holds the stored text" "$(e2e_read "$OLD_DL" "String(__auto.getContent().startsWith('OLD-EDIT>>'))")" "true"
sleep 1
check "its record no longer names a range" "$(jq -r '.range_source // "none"' "$STORE/old-dirty.json")" "none"
check "its record keeps the text" "$(jq -r '.content' "$STORE/old-dirty.json" | head -1)" "OLD-EDIT>>"
check "big.log is untouched by the old record" "$(file_has 'OLD-EDIT')" "False"

echo "=== teardown ==="
evl "$OLD_DL" "__auto.setLanguage('$ORIG_LANG')" >/dev/null
sleep 1
quit_app
for f in "$STORE"/*.json; do
  if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
    rm -f "$f"
    echo "cleaned leftover: $f"
  fi
done
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
