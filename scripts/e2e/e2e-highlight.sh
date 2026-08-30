#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: off-thread worker highlighting.
# Fixture: nested JSON above the 10M-char sync-highlight gate. Asserts the UI
# stays responsive while the worker colors it, and that the toggle wires
# through settings.
# LESSON: never put `await` inside an eval string.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. If the automation port is already dead when the trap
# fires, the app-side restore call (ECONNREFUSED) is skipped and settings.json
# is left pinned. As a fallback once the app is confirmed dead, patch
# settings.json directly with jq so the on-disk language and worker_highlight
# always revert.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/highlight-fixture"
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
launch() {
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >"$OUT/dev-highlight.log" 2>&1 &
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

echo "=== preflight ==="
for f in "$STORE"/*.json; do
  if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
    FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
    case "$FP" in
      *note-n-pad-e2e/*)
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
python3 - <<PYEOF
import json
n = 150000
with open('$WORK/nested.json', 'w') as f:
    f.write('[\n')
    for i in range(n):
        obj = {'id': i, 'name': f'item-{i}', 'tags': ['a', 'b', 'c'],
               'meta': {'active': i % 2 == 0, 'score': i * 1.5,
                        'nested': {'deep': {'value': i}}}}
        f.write(json.dumps(obj))
        f.write(',\n' if i < n - 1 else '\n')
    f.write(']\n')
PYEOF
FIXSIZE=$(file_size "$WORK/nested.json")
echo "nested.json bytes: $FIXSIZE (needs > 10,000,000 chars)"

launch
BOOT=$(auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1)
evl "$BOOT" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/nested.json'})" >/dev/null
sleep 5
DL=$(doc_label)
tries=0
until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.getWorkerHighlight==='function'")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    echo "FATAL: doc window/hooks never appeared"
    quit_app
    exit 1
  fi
  DL=$(doc_label)
done

echo "=== baseline (flag off) ==="
ORIG_FLAG=$(evl "$DL" "String(__auto.getWorkerHighlight())")
echo "original flag: $ORIG_FLAG"
# Pin the UI language so text assertions never depend on the host system
# language; restored alongside the flag below.
ORIG_LANG=$(evl "$DL" "String(__auto.getLanguage())")
echo "original language: $ORIG_LANG"
# The flag writes the user's real settings.json; make sure an interrupt between
# enable and teardown still restores it and the language (and kills the app)
# instead of leaving worker_highlight silently flipped on.
restore_flag() {
  trap '' INT TERM
  if [ -n "${DL:-}" ] && [ -n "${ORIG_FLAG:-}" ]; then
    evl "$DL" "__auto.setWorkerHighlight($ORIG_FLAG)" >/dev/null 2>&1
  fi
  if [ -n "${DL:-}" ] && [ -n "${ORIG_LANG:-}" ]; then
    evl "$DL" "__auto.setLanguage('$ORIG_LANG')" >/dev/null 2>&1
  fi
  quit_app
  # Fallback: app is dead now, so patch settings.json directly in case the
  # app-side restore above never reached a live automation port.
  if [ -n "${ORIG_LANG:-}" ] && [ -f "$APPDIR/settings.json" ]; then
    jq --arg l "$ORIG_LANG" '.language = $l' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
      && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
  fi
  if [ -n "${ORIG_FLAG:-}" ] && [ -f "$APPDIR/settings.json" ]; then
    jq --argjson h "$ORIG_FLAG" '.worker_highlight = $h' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
      && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
  fi
  e2e_kill_owned_ports
}
trap restore_flag EXIT INT TERM
evl "$DL" "__auto.setLanguage('zh-TW')" >/dev/null
sleep 1
evl "$DL" "__auto.setWorkerHighlight(false)" >/dev/null
sleep 1
check "worker inactive when off" "$(evl "$DL" "String(__auto.workerHighlightActive())")" "false"
check "no tok spans when off" "$(evl "$DL" "String(document.querySelectorAll('.cm-content [class*=tok-]').length)")" "0"

echo "=== enable and color ==="
evl "$DL" "__auto.setWorkerHighlight(true)" >/dev/null
tries=0
until [ "$(evl "$DL" "String(__auto.workerHighlightActive())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 15 ]; then
    break
  fi
done
check "worker active when on" "$(evl "$DL" "String(__auto.workerHighlightActive())")" "true"
TOKN=0
tries=0
until [ "$TOKN" != "0" ] && [ "$TOKN" != "null" ]; do
  TOKN=$(evl "$DL" "String(document.querySelectorAll('.cm-content [class*=tok-]').length)")
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    break
  fi
  sleep 1
done
if [ "$TOKN" != "0" ] && [ "$TOKN" != "null" ] && [ -n "$TOKN" ]; then
  ok "viewport colored by worker (tok spans=$TOKN)"
else
  bad "viewport colored by worker (tok spans=$TOKN)"
fi

echo "=== UI responsiveness during/after parse ==="
T0=$(date +%s.%N)
PONG=$(evl "$DL" "'pong'")
T1=$(date +%s.%N)
RT=$(python3 -c "print(round($T1-$T0,2))")
check "eval roundtrip responsive" "$(python3 -c "print($RT < 2.0)")" "True"
evl "$DL" "document.querySelector('.cm-content').focus()" >/dev/null
evl "$DL" "__auto.typeText('E2E_MARK')" >/dev/null
sleep 1
check "typing lands while highlighting" "$(evl "$DL" "String(__auto.getContent().includes('E2E_MARK'))")" "true"

echo "=== disable cleans up ==="
evl "$DL" "__auto.setWorkerHighlight(false)" >/dev/null
sleep 2
check "worker inactive after off" "$(evl "$DL" "String(__auto.workerHighlightActive())")" "false"
check "tok spans removed" "$(evl "$DL" "String(document.querySelectorAll('.cm-content [class*=tok-]').length)")" "0"

echo "=== teardown ==="
evl "$DL" "__auto.setWorkerHighlight($ORIG_FLAG)" >/dev/null
evl "$DL" "__auto.setLanguage('$ORIG_LANG')" >/dev/null
sleep 1
quit_app
for f in "$STORE"/*.json; do
  if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
    FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
    case "$FP" in
      *note-n-pad-e2e/*)
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
