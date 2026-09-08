#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: range editing.
# Extract a line range from a large file, edit it, splice it back, and verify
# the original file byte-precisely. Also covers conflict handling, byte-faithful
# save-as, and restart persistence of a dirty range tab.
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
  # The dev server binds 1420 while the app is coming up, so this is the
  # first moment a leftover holding it is visible; the app answering on
  # 45678 does not mean vite got its port.
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
  if [ "$(evl "$DL" "String(__auto.largeConfirmVisible())")" = "true" ]; then
    evl "$DL" "__auto.largeConfirmAccept()" >/dev/null
    sleep 2
  fi
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

launch
open_large "$WORK/big.log"

# Pin the UI language so the text assertions below never depend on the host
# system language; restore the user's real preference on exit or interrupt. The
# trap looks the doc label up live because the restart section reassigns DL.
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
evl "$DL" "__auto.setLanguage('zh-TW')" >/dev/null
sleep 1

echo "=== select and extract ==="
tries=0
until [ "$(evl "$DL" "String(__auto.largeInfo().totalLines !== null)")" = "true" ]; do
  sleep 2
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    break
  fi
done
evl "$DL" "__auto.largeSelectRange(100, 200)" >/dev/null
check "range recorded" "$(evl "$DL" "JSON.stringify(__auto.largeGetRange())")" '{"startLine":100,"endLine":200}'
evl "$DL" "__auto.largeRangeEdit()" >/dev/null
sleep 3
check "range tab opened" "$(evl "$DL" "String(__auto.isRangeTab())")" "true"
check "content starts at line 100" "$(evl "$DL" "String(__auto.getContent().startsWith('line 0000100 '))")" "true"
check "content ends at line 200" "$(evl "$DL" "String(__auto.getContent().trimEnd().endsWith('line 0000200 abcdefghijklmnopqrstuvwxyz0123456789'))")" "true"

echo "=== edit and splice back ==="
evl "$DL" "__auto.typeText('EDITED>>')" >/dev/null
sleep 1
RES=$(evl "$DL" "'pending'")
SAVE=$(evl "$DL" "__auto.rangeSave().then((r)=>{window.__rangeSaveResult=r;}) && 'started'")
sleep 3
check "splice result ok" "$(evl "$DL" "String(window.__rangeSaveResult)")" "ok"
python3 - <<PYEOF
lines = open('$WORK/big.log', 'rb').read().split(b'\n')
l99 = lines[98]
l100 = lines[99]
l201 = lines[200]
total_ok = l99 == b'line 0000099 abcdefghijklmnopqrstuvwxyz0123456789'
mark_ok = b'EDITED>>' in l100
after_ok = l201 == b'line 0000201 abcdefghijklmnopqrstuvwxyz0123456789'
print('L99_INTACT' if total_ok else 'L99_BROKEN')
print('L100_EDITED' if mark_ok else 'L100_MISSING')
print('L201_INTACT' if after_ok else 'L201_BROKEN')
PYEOF
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
check "tab clean after splice" "$(evl "$DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[]|select(.active)|.dirty')" "false"

echo "=== conflict flow ==="
printf 'external change\n' >>"$WORK/big.log"
evl "$DL" "__auto.typeText('AGAIN>>')" >/dev/null
sleep 1
evl "$DL" "__auto.rangeSave().then((r)=>{window.__rangeSaveResult=r;})" >/dev/null
sleep 3
check "mismatch detected" "$(evl "$DL" "String(window.__rangeSaveResult)")" "mismatch"
check "conflict modal shown" "$(evl "$DL" "String(__auto.rangeConflictVisible())")" "true"
evl "$DL" "__auto.rangeConflictForce()" >/dev/null
sleep 3
check "force write landed" "$(python3 -c "
data = open('$WORK/big.log','rb').read()
print(b'AGAIN>>' in data and b'external change' in data)
")" "True"
check "modal gone after force" "$(evl "$DL" "String(__auto.rangeConflictVisible())")" "false"

echo "=== byte-faithful save-as ==="
evl "$DL" "__auto.rangeSaveAsBytes('$WORK/slice.bin')" >/dev/null
sleep 2
CMP=$(python3 - <<PYEOF
import json
info = json.loads('''$(evl "$DL" "JSON.stringify(__auto.rangeInfo())")''')
src = open('$WORK/big.log', 'rb').read()
sl = open('$WORK/slice.bin', 'rb').read()
print(src[info['startByte']:info['endByte']] == sl)
PYEOF
)
check "saved bytes identical to source span" "$CMP" "True"

echo "=== restart persistence ==="
evl "$DL" "__auto.typeText('DIRTY>>')" >/dev/null
sleep 1
quit_app
RANGE_SNAPS=$(jq -r 'select(.range_source != null) | .range_source' "$STORE"/*.json 2>/dev/null | grep -c "big.log" || true)
check "dirty range tab persisted" "$RANGE_SNAPS" "1"
launch
sleep 3
DL=$(doc_label)
tries=0
until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.isRangeTab==='function'")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
  DL=$(doc_label)
done
# Restore reopens BOTH tabs (large view at tab_index 0, range tab at 1) and
# activates index 0, so locate the range tab (the one with no path) and switch
# to it before asserting. Wait for both tabs to finish loading first.
tries=0
until [ "$(evl "$DL" "String(__auto.getTabs().length)")" = "2" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
done
RIDX=$(evl "$DL" "JSON.stringify(__auto.getTabs())" | jq -r 'to_entries[]|select(.value.path=="")|.key' | head -1)
check "range tab present after restart" "$([ -n "$RIDX" ] && echo yes)" "yes"
evl "$DL" "__auto.switchTab(${RIDX:-0})" >/dev/null
sleep 2
check "range tab restored" "$(evl "$DL" "String(__auto.isRangeTab())")" "true"
check "restored dirty" "$(evl "$DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[]|select(.active)|.dirty')" "true"
check "restored content keeps edit" "$(evl "$DL" "String(__auto.getContent().includes('DIRTY>>'))")" "true"
evl "$DL" "__auto.rangeSave().then((r)=>{window.__rangeSaveResult=r;})" >/dev/null
sleep 3
check "restored tab splices ok" "$(evl "$DL" "String(window.__rangeSaveResult)")" "ok"

echo "=== teardown ==="
evl "$DL" "__auto.setLanguage('$ORIG_LANG')" >/dev/null
sleep 1
evl "$DL" "__auto.closeActiveTab()" >/dev/null
sleep 2
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
