#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: document-window close flush + oversized gate.
# The OS close of a document window is intercepted in Rust and routed through a
# per-window flush handshake so dirty tabs are snapshotted before the window is
# destroyed — a raw close used to drop unsaved content. Three scenarios:
#   A. A ~2M-char dirty tab: close the window (it must really close after the
#      flush), quit, restart, and confirm the typed marker was restored.
#   B. A >16M-char dirty tab is too big to snapshot, so close raises the oversized
#      gate instead of destroying the window: Cancel leaves the window open, and a
#      second close + Discard finally closes it while the app keeps running.
#   C. A clean tab closes straight through, no prompt.
# LESSON: never put `await` inside an eval string; use `.then((r)=>{window.__x=r;})`.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. The trap only quits the app and wipes this suite's own
# document snapshots (matched by the fixture path); no user setting is touched.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/close-flush-fixture"
MARKER="CLOSEFLUSHMARKERA"
PASS=0
FAIL=0
mkdir -p "$OUT"

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
        *close-flush-fixture*)
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
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >"$OUT/dev-close-flush.log" 2>&1 &
  local tries=0
  until nc -z 127.0.0.1 45678 2>/dev/null; do
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
  while pgrep -x note-n-pad >/dev/null 2>&1; do
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
# Close DL's window via the OS-close IPC and wait until it is really gone.
close_window_expect_gone() {
  evl "$DL" "window.__TAURI_INTERNALS__.invoke('plugin:window|close')" >/dev/null
  local tries=0
  until [ "$(doc_count)" = "0" ]; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 30 ]; then
      break
    fi
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
# mid.txt: ~2M chars (40,000 lines of 50 'm' + LF). Dirty, it stays well under the
# 16M snapshot ceiling, so it rides along in a snapshot and restores after a quit.
python3 - <<PYEOF
with open('$WORK/mid.txt', 'w') as f:
    f.write(('m' * 50 + '\n') * 40000)
PYEOF
# huge.txt: ~16.8M chars (330,000 lines of 50 'h' + LF). Once dirty it exceeds the
# 16M ceiling ('skip'), so it cannot be snapshotted and the close raises the gate.
python3 - <<PYEOF
with open('$WORK/huge.txt', 'w') as f:
    f.write(('h' * 50 + '\n') * 330000)
PYEOF
# clean.txt: a few KB, opened and never edited (scenario C).
python3 - <<PYEOF
with open('$WORK/clean.txt', 'w') as f:
    f.write(('c' * 50 + '\n') * 100)
PYEOF
echo "mid.txt bytes:   $(file_size "$WORK/mid.txt")"
echo "huge.txt bytes:  $(file_size "$WORK/huge.txt")"
echo "clean.txt bytes: $(file_size "$WORK/clean.txt")"

restore_state() {
  trap '' INT TERM
  quit_app
  wipe_test_docs
  e2e_kill_owned_ports
}
trap restore_state EXIT INT TERM

echo "=== scenario A: mid dirty close + restart restore ==="
launch
open_doc "$WORK/mid.txt"
check "mid.txt opened as an editable tab" "$(evl "$DL" "String(__auto.isLargeTab())")" "false"
evl "$DL" "__auto.typeText('$MARKER')" >/dev/null
sleep 1
check "dirty after typing marker" "$(evl "$DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[]|select(.active)|.dirty')" "true"
check "marker present in buffer" "$(evl "$DL" "String(__auto.getContent().includes('$MARKER'))")" "true"
DOC_BEFORE=$(doc_count)
check "one doc window before close" "$DOC_BEFORE" "1"
close_window_expect_gone
check "window closed after flush" "$(doc_count)" "0"
quit_app

echo "=== scenario A: restart ==="
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
check "restored tab still holds the marker" "$(evl "$DL" "String(__auto.getContent().includes('$MARKER'))")" "true"
check "restored tab is still dirty" "$(evl "$DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[]|select(.active)|.dirty')" "true"
quit_app
wipe_test_docs

echo "=== scenario C: clean tab closes straight through ==="
launch
open_doc "$WORK/clean.txt"
check "clean.txt not dirty" "$(evl "$DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[]|select(.active)|.dirty')" "false"
close_window_expect_gone
check "clean window closed without a prompt" "$(doc_count)" "0"

echo "=== scenario B: oversized dirty close gate ==="
open_doc "$WORK/huge.txt"
check "huge.txt opened as an editable tab" "$(evl "$DL" "String(__auto.isLargeTab())")" "false"
evl "$DL" "__auto.typeText('X')" >/dev/null
sleep 1
check "dirty after typing" "$(evl "$DL" "JSON.stringify(__auto.getTabs())" | jq -r '.[]|select(.active)|.dirty')" "true"
# First close: the buffer is too big to snapshot, so the gate must appear and the
# window must stay put (no destroy).
evl "$DL" "window.__TAURI_INTERNALS__.invoke('plugin:window|close')" >/dev/null
tries=0
until [ "$(evl "$DL" "String(__auto.oversizedGateVisible())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 20 ]; then
    break
  fi
done
check "oversized gate visible on close" "$(evl "$DL" "String(__auto.oversizedGateVisible())")" "true"
check "window still open while gate is up" "$(doc_count)" "1"
# Cancel: the gate clears and the window remains (the close was already prevented).
evl "$DL" "__auto.oversizedGateCancel()" >/dev/null
sleep 1
check "gate dismissed after cancel" "$(evl "$DL" "String(__auto.oversizedGateVisible())")" "false"
check "window still open after cancel" "$(doc_count)" "1"
# Second close then discard: the tab reverts to clean, the gate clears, and the
# pending close resumes and destroys the window — while the app keeps running.
evl "$DL" "window.__TAURI_INTERNALS__.invoke('plugin:window|close')" >/dev/null
tries=0
until [ "$(evl "$DL" "String(__auto.oversizedGateVisible())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 20 ]; then
    break
  fi
done
check "gate visible again on second close" "$(evl "$DL" "String(__auto.oversizedGateVisible())")" "true"
evl "$DL" "__auto.oversizedGateDiscard()" >/dev/null
tries=0
until [ "$(doc_count)" = "0" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
done
check "window closed after discard" "$(doc_count)" "0"
check "app still running after close" "$(pgrep -f 'target/debug/note-n-pad' >/dev/null 2>&1 && echo alive || echo gone)" "alive"
quit_app
wipe_test_docs

echo "=== teardown ==="
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
