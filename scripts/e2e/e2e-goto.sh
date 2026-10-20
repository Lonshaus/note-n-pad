#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: centered go-to-line jumps in a document tall enough for CodeMirror's
# BigScaler (1,000,000 lines, 100,000,000 bytes, still a normal document).
# Drives the real go-to-line panel through window.__auto, then measures how far
# the cursor row's middle sits from the scroller's middle, with word wrap off
# and on. Needs the dev frontend: window.__auto exists only under DEV.
# LESSON (inherited from the other suites): never put `await` inside an eval
# string; use callbacks and poll for a window property.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/goto-fixture"
PASS=0
FAIL=0
mkdir -p "$OUT"
: >"$OUT/dev-goto.log"

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
# Assert the jq boolean expression $3 over the JSON measurement $2.
check_jq() {
  local got
  got=$(printf '%s' "$2" | jq -r "$3" 2>/dev/null | tr -d '\r')
  check "$1" "$got" "true"
}

cd "$REPO" || exit 1
source "$HOME/.cargo/env" 2>/dev/null

auto() {
  node scripts/auto.mjs "$1"
}
boot_label() {
  auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1
}
doc_label() {
  auto '{"id":3,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label' | head -1 | tr -d '\r'
}
evl() {
  auto "{\"id\":$(e2e_next_id),\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
launch() {
  e2e_require_clean_slate
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-goto.log" 2>&1 &
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
  e2e_require_automation_listener "$OUT/dev-goto.log"
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
# Wait until scrollTop of the editor in window $1 is unchanged over two
# consecutive animation frames (at most 3 s); prints true when it settled.
wait_scroll_settled() {
  evl "$1" "window.__settled=null;(function(){var sc=document.querySelector('.cm-scroller');var last=-1,same=0,t0=performance.now();function f(){var v=sc.scrollTop;if(v===last){same++;}else{same=0;last=v;}if(same>=2||performance.now()-t0>3000){window.__settled=String(same>=2);return;}requestAnimationFrame(f);}requestAnimationFrame(f);})();'started'" >/dev/null
  local tries=0 r
  while [ "$tries" -lt 20 ]; do
    r=$(evl "$1" "String(window.__settled)")
    if [ "$r" = "true" ] || [ "$r" = "false" ]; then
      printf '%s\n' "$r"
      return 0
    fi
    sleep 0.5
    tries=$((tries + 1))
  done
  printf 'timeout\n'
}
# Jump window $1 to line $2 through the go-to-line panel and measure; sets M.
jump() {
  evl "$1" "JSON.stringify(__auto.consoleWarnings())" >/dev/null
  check "gotoLine($2) submitted ($3)" "$(e2e_read "$1" "String(__auto.gotoLine($2))")" "true"
  check "scroll settled after line $2 ($3)" "$(wait_scroll_settled "$1")" "true"
  M=$(e2e_read "$1" "JSON.stringify(__auto.lineCenterOffset($2))")
  WARN=$(e2e_read "$1" "JSON.stringify(__auto.consoleWarnings())")
  echo "measure ($3) line $2: $M"
  check "no viewport warning for line $2 ($3)" \
    "$(printf '%s' "$WARN" | jq -r 'map(select(contains("Viewport failed to stabilize")))|length' | tr -d '\r')" "0"
}
# One full pass over the six jumps; $1 is the window, $2 the mode label, $3 the
# wrap flag (true/false).
run_pass() {
  local dl="$1" mode="$2" wrap="$3" n
  for n in 123456 500000 777777 300000; do
    jump "$dl" "$n" "$mode"
    check_jq "line $n centered within one line height ($mode)" "$M" '(.offset|fabs) <= .defaultLineHeight'
    if [ "$wrap" = "true" ]; then
      check_jq "line $n wrapped ($mode)" "$M" '.lineHeight > 1.5 * .defaultLineHeight'
    fi
  done
  jump "$dl" 1 "$mode"
  check_jq "line 1 at scrollTop 0 ($mode)" "$M" '.scrollTop == 0'
  if [ "$wrap" = "true" ]; then
    check_jq "line 1 wrapped ($mode)" "$M" '.lineHeight > 1.5 * .defaultLineHeight'
  fi
  jump "$dl" 999999 "$mode"
  check_jq "line 999999 at max scrollTop ($mode)" "$M" '(.scrollTop - .maxScrollTop | fabs) <= 1'
  check_jq "line 999999 in view ($mode)" "$M" '.inView'
  if [ "$wrap" = "true" ]; then
    check_jq "line 999999 wrapped ($mode)" "$M" '.lineHeight > 1.5 * .defaultLineHeight'
  fi
}

echo "=== fixtures ==="
rm -rf "$WORK"
mkdir -p "$WORK"
# 1,000,000 lines of 100 bytes: line number, filler up to 99 chars, LF.
python3 - <<PYEOF
with open('$WORK/million.txt', 'w', newline='') as f:
    for start in range(1, 1000001, 10000):
        f.write(''.join(str(i).ljust(99, 'x') + '\n' for i in range(start, start + 10000)))
PYEOF
SIZE=$(file_size "$WORK/million.txt")
check "fixture is 100,000,000 bytes" "$SIZE" "100000000"

restore_wrap() {
  trap '' INT TERM
  local dl
  dl=$(doc_label 2>/dev/null)
  if [ -n "$dl" ] && [ -n "${ORIG_WRAP:-}" ]; then
    evl "$dl" "__auto.setWordWrap($ORIG_WRAP);1" >/dev/null 2>&1
    sleep 1
  fi
  quit_app
  # App is dead now; patch settings.json directly in case the live restore
  # never reached the automation port.
  if [ -n "${ORIG_WRAP:-}" ] && [ -f "$APPDIR/settings.json" ]; then
    jq --argjson w "$ORIG_WRAP" '.editor_word_wrap = $w' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
      && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
  fi
  rm -rf "$WORK"
  e2e_kill_owned_ports
}
trap restore_wrap EXIT INT TERM

launch
BOOT=$(boot_label)
if [ -z "$BOOT" ]; then
  echo "FATAL: no bootstrap window"
  exit 1
fi
evl "$BOOT" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/million.txt'})" >/dev/null
DL=""
tries=0
until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.gotoLine==='function' && typeof __auto.lineCenterOffset==='function' && typeof __auto.consoleWarnings==='function'")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    echo "FATAL: doc window/hooks never appeared"
    exit 1
  fi
  DL=$(doc_label)
done
ORIG_WRAP=$(e2e_read "$DL" "String(__auto.getEditorState().wordWrap)")
echo "original editor_word_wrap: $ORIG_WRAP"

echo "=== open as a normal document ==="
e2e_wait_eval "$DL" "String(__auto.activeContentLength())" "100000000" || true
check "content fully loaded" "$(e2e_read "$DL" "String(__auto.activeContentLength())")" "100000000"
check "not a large tab" "$(e2e_read "$DL" "String(__auto.isLargeTab())")" "false"
# The first call only starts collecting.
evl "$DL" "JSON.stringify(__auto.consoleWarnings())" >/dev/null

for mode in off on; do
  if [ "$mode" = "on" ]; then
    wrap=true
  else
    wrap=false
  fi
  echo "=== word wrap $mode ==="
  evl "$DL" "__auto.setWordWrap($wrap);1" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getEditorState().wordWrap)" "$wrap" || true
  check "word wrap is $mode" "$(e2e_read "$DL" "String(__auto.getEditorState().wordWrap)")" "$wrap"
  sleep 3
  run_pass "$DL" "wrap $mode" "$wrap"
done

echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
