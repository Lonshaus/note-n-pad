#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# Per-keystroke latency probe for the NORMAL editor path.
# Opens a plain text file of a given size as an editable tab, types single
# characters through the automation bridge, and reports the p50 / p95 latency
# of a keystroke at that size, plus the dirty-quit flush time. All sizes stay
# below the 100 MB large-file threshold, so this exercises the normal editor,
# not the windowed viewer.
#
# Prerequisite: the dev app must be buildable/launchable from this checkout
# (run `npm install` once, and a first `npm run tauri dev` to warm the build).
# The probe then manages the app itself: it launches
# `NOTE_N_PAD_AUTOMATION=1 npm run tauri dev` per size, drives it over TCP 45678,
# and quits it between sizes. Nothing needs to be running beforehand.
#
# Usage, optionally with a custom size list in MB:
#     scripts/perf/typing-probe.sh            # default 1 2 4 8 16 32 64
#     scripts/perf/typing-probe.sh 1 16       # just these two
#
# Sizes past the 16M-char snapshot cap hit the oversized-dirty quit gate (a
# confirm dialog); the script clicks its discard button so quit can proceed,
# and the reported flush time for those rows is answered-dialog time, not a
# real flush.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/../e2e/lib.sh"
# Keep perf fixtures/logs in their own tmp dir, separate from the E2E suites.
PERF_TMP_BASE="${TMPDIR:-/tmp}"
OUT="${PERF_TMP_BASE%/}/note-n-pad-perf"
mkdir -p "$OUT"

SIZES=("$@")
if [ "${#SIZES[@]}" -eq 0 ]; then
  SIZES=(1 2 4 8 16 32 64)
fi

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
clean_snaps() {
  for f in "$STORE"/*.json; do
    [ -f "$f" ] || continue
    if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
      case "$(jq -r '.file_path // empty' "$f")" in
        *note-n-pad-perf*)
          rm -f "$f"
          ;;
      esac
    fi
  done
}
launch() {
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >"$OUT/dev-perf.log" 2>&1 &
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
discard_gate() {
  # Above the 16M-char snapshot cap, quit raises the oversized-dirty gate.
  # Click its discard button so the quit can proceed.
  local dl js
  dl=$(doc_label)
  [ -n "$dl" ] || return 1
  js="(() => { const b=[...document.querySelectorAll('button.btn')].find(x=>x.textContent.includes('放棄')||x.textContent.includes('Discard')); if(!b){return 'no-button';} b.click(); return 'clicked'; })()"
  evl "$dl" "$js"
}
quit_and_time() {
  # Returns elapsed ms from the quit command until the app process is gone,
  # which includes the dirty-tab flush write. Coarse (0.1s polling). Sizes that
  # end up over the snapshot cap raise the oversized-dirty gate instead of
  # flushing, so poke discard_gate periodically regardless of size — it is a
  # harmless no-op (returns 'no-button') when no gate is up.
  local t0 t1 waited=0
  t0=$(python3 -c 'import time; print(time.time())')
  auto '{"id":99,"cmd":"quit"}' >/dev/null 2>&1
  while e2e_app_running; do
    sleep 0.1
    waited=$((waited + 1))
    if [ $((waited % 20)) -eq 0 ]; then
      discard_gate >/dev/null 2>&1
    fi
    if [ "$waited" -gt 600 ]; then
      e2e_kill_owned_ports
    fi
  done
  t1=$(python3 -c 'import time; print(time.time())')
  e2e_kill_owned_ports
  sleep 3
  python3 -c "print(round(($t1 - $t0) * 1000))"
}

printf '%-9s %-10s %-10s %-14s\n' "size_MB" "p50_ms" "p95_ms" "quit_flush_ms"
printf '%-9s %-10s %-10s %-14s\n' "-------" "------" "------" "-------------"
for MB in "${SIZES[@]}"; do
  clean_snaps
  python3 - "$MB" "$OUT" <<'PYEOF'
import sys
mb = int(sys.argv[1])
out = sys.argv[2]
line = 'probe line abcdefghijklmnopqrstuvwxyz 0123456789\n'  # 48 chars
# Drop 100 lines (~4800 chars) of headroom. Without it a "16 MB" file lands at
# 15,999,984 chars, and the 50 probe keystrokes push it past the 16,000,000
# snapshot cap mid-run, so quit hits the oversized gate instead of a real
# flush. The margin keeps "file + 50 keystrokes" clearly on one side of the
# cap (under for <=16 MB, over for larger).
n = (mb * 1_000_000) // len(line) - 100
with open(f'{out}/f{mb}mb.txt', 'w') as f:
    for _ in range(n):
        f.write(line)
PYEOF
  launch
  BOOT=$(auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1)
  evl "$BOOT" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$OUT/f${MB}mb.txt'})" >/dev/null
  sleep 5
  DL=$(doc_label)
  tries=0
  until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.typeText==='function'")" = "true" ]; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 40 ]; then
      echo "FATAL: doc window for ${MB}MB never ready"
      exit 1
    fi
    DL=$(doc_label)
  done
  # Give decode/render a moment to settle before sampling.
  sleep 3
  STATS=$(evl "$DL" "(() => { const s=[]; for (let i=0;i<50;i++){ const t0=performance.now(); __auto.typeText('x'); s.push(performance.now()-t0);} s.sort((a,b)=>a-b); const q=(p)=>s[Math.min(s.length-1,Math.max(0,Math.ceil(p*s.length)-1))]; return [q(0.5).toFixed(1), q(0.95).toFixed(1)].join(','); })()")
  P50="${STATS%%,*}"
  P95="${STATS##*,}"
  # Leave the tab dirty so quit exercises the full flush write.
  Q=$(quit_and_time)
  printf '%-9s %-10s %-10s %-14s\n' "$MB" "$P50" "$P95" "$Q"
done
clean_snaps
rm -f "$OUT"/f*.txt
echo "PROBE DONE"
