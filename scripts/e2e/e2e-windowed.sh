#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# PENDING LIVE RUN: updated for the unified large_open_mode ('ask'|'view'|'edit')
# that replaced the ask_before_large_open toggle; the edit-mode section no longer
# expects a confirm (edit opens straight through). Also updated for the
# lazy-reopen change: the restart-restore section now expects the tab to reopen
# into windowed editing again (no more permanent read-only fallback) and
# checks the restored top line. Not yet re-run against the app.
# E2E: windowed editing.
# Open a ~240 MB file read-only, unlock it for editing in place via the tab-bar
# lock icon, edit at the head and 4.8M lines deep, save byte-precisely, exercise
# undo/redo, a save conflict, the oversized quit gate, restart restore, and a
# real memory measurement that editing stays far below a whole-file load. Also
# covers the tab lock staying disabled for a non-UTF-8 file, and the
# large_open_mode='edit' setting opening a large file straight into editing.
# LESSON: never put `await` inside an eval string; use `.then((r)=>{window.__x=r;})`.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. If the automation port is already dead when the trap
# fires, the app-side restore call (ECONNREFUSED) is skipped and settings.json
# is left pinned. As a fallback once the app is confirmed dead, patch
# settings.json directly with jq so the on-disk language and large_open_mode
# always revert.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/windowed-fixture"
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
doc_count() {
  auto '{"id":3,"cmd":"list_windows"}' | jq -r '[.data[]|select(.label|startswith("doc-"))]|length'
}
doc_labels() {
  auto '{"id":31,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label'
}
# The label of the first doc window that was not in $1 (a newline-separated list
# captured before the window was asked for), or empty if none has appeared yet.
#
# Identifying the new window as "the one that is not $DL" does not work: closing
# a tab closes its window only after a delay, so a window on its way out is
# still listed and gets picked as the new one, and every eval against it comes
# back null once it finally goes. A window that already existed is
# in the list either way, so comparing against the full set skips it.
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
evl() {
  auto "{\"id\":9,\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
launch() {
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >"$OUT/dev-windowed.log" 2>&1 &
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
open_large() {
  # $1 = path; opens it in a doc window and accepts the read-only confirm; sets DL.
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
    sleep 3
  fi
}

# Record the main app process RSS and every WebKit WebContent process RSS to $1.
# Attribution logic (see the diff computation below): the main `app` process
# holds the Rust windowed session (its line index), and each app window's
# WKWebView spawns its own `com.apple.WebKit.WebContent` renderer. WebContent
# processes are system-shared across all WKWebView apps, so we cannot name ours
# by process alone; instead we attribute by PID delta between a baseline taken
# BEFORE the doc window opens and a sample taken AFTER the edit: a WebContent PID
# absent at baseline is the doc window's renderer (counted whole), and growth of
# a surviving PID is counted too. Error sources: RSS counts shared pages (an
# overestimate) and an unrelated WKWebView app growing concurrently would be
# misattributed (also an overestimate) — both make the bound stricter, never
# looser, so a pass is trustworthy.
mem_capture() {
  {
    echo "MAIN"
    for pid in $(pgrep -f "target/debug/note-n-pad"); do
      rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
      if [ -n "$rss" ]; then
        echo "$pid $rss"
      fi
    done
    echo "WEBCONTENT"
    for pid in $(pgrep -f "$(webcontent_pattern)"); do
      rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
      if [ -n "$rss" ]; then
        echo "$pid $rss"
      fi
    done
  } >"$1"
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
# big.log: 5,000,000 lines, 10-digit line number + space + 36 'x' (47 chars). The
# last line carries no trailing LF, so the core counts exactly 5,000,000 lines (a
# trailing LF would add a 5,000,001st empty line). Size 239,999,999 bytes (~240MB).
python3 - <<PYEOF
import os
n = 5_000_000
with open('$WORK/big.log', 'w') as f:
    buf = []
    for i in range(1, n + 1):
        buf.append(f'{i:010d} ' + 'x' * 36)
        if len(buf) == 20000:
            f.write('\n'.join(buf) + '\n')
            buf = []
    if buf:
        f.write('\n'.join(buf) + '\n')
os.truncate('$WORK/big.log', os.path.getsize('$WORK/big.log') - 1)
PYEOF
cp "$WORK/big.log" "$WORK/big.orig"
ORIG_SIZE=$(file_size "$WORK/big.log")
echo "big.log bytes: $ORIG_SIZE"
check "fixture is ~240MB" "$ORIG_SIZE" "239999999"
# bad.log: ~105MB (over the 100MB large-file threshold) of ASCII with a single
# invalid UTF-8 byte (0xFF) near the start, so windowed_open fast-fails NOT_UTF8
# and the lock stays disabled.
python3 - <<PYEOF
n = (105 * 1024 * 1024) // 48 + 1
with open('$WORK/bad.log', 'w') as f:
    buf = []
    for i in range(n):
        buf.append('A' * 47)
        if len(buf) == 20000:
            f.write('\n'.join(buf) + '\n')
            buf = []
    if buf:
        f.write('\n'.join(buf) + '\n')
with open('$WORK/bad.log', 'r+b') as f:
    f.seek(100)
    f.write(b'\xff')
PYEOF
BAD_SIZE=$(file_size "$WORK/bad.log")
echo "bad.log bytes: $BAD_SIZE (>104857600 required)"

launch

echo "=== non-UTF-8: lock disabled ==="
open_large "$WORK/bad.log"
tries=0
until [ "$(evl "$DL" "String(__auto.isLargeTab())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
done
# Pin the UI language before any text-dependent assertion so results never
# depend on the host system language. A single combined trap restores both the
# language and the large-open mode (captured just below); it must be the only
# trap, since a later trap would silently replace this one.
ORIG_LANG=$(evl "$DL" "String(__auto.getLanguage())")
echo "original language: $ORIG_LANG"
restore_state() {
  trap '' INT TERM
  if [ -n "${DL:-}" ] && [ -n "${ORIG_LANG:-}" ]; then
    evl "$DL" "__auto.setLanguage('$ORIG_LANG')" >/dev/null 2>&1
  fi
  if [ -n "${DL:-}" ] && [ -n "${ORIG_MODE:-}" ]; then
    evl "$DL" "__auto.setLargeOpenMode('$ORIG_MODE')" >/dev/null 2>&1
  fi
  quit_app
  # Fallback: app is dead now, so patch settings.json directly in case the
  # app-side restore above never reached a live automation port.
  if [ -n "${ORIG_LANG:-}" ] && [ -f "$APPDIR/settings.json" ]; then
    jq --arg l "$ORIG_LANG" '.language = $l' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
      && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
  fi
  if [ -n "${ORIG_MODE:-}" ] && [ -f "$APPDIR/settings.json" ]; then
    jq --arg m "$ORIG_MODE" '.large_open_mode = $m' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
      && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
  fi
  e2e_kill_owned_ports
}
trap restore_state EXIT INT TERM
evl "$DL" "__auto.setLanguage('zh-TW')" >/dev/null
sleep 1
check "bad.log opened read-only" "$(evl "$DL" "String(__auto.isLargeTab())")" "true"
# The large-open-mode setting writes the user's real settings.json; capture its
# value now and restore it on any exit (see edit-mode section and restore_state
# above), and force 'view' for the whole read-only-then-manual-unlock flow below.
ORIG_MODE=$(evl "$DL" "String(__auto.getLargeOpenMode())")
echo "original large_open_mode: $ORIG_MODE"
evl "$DL" "__auto.setLargeOpenMode('view')" >/dev/null
e2e_wait_setting large_open_mode "view"
check "lock available before probe" "$(evl "$DL" "String(__auto.largeUnlockAvailable())")" "true"
evl "$DL" "__auto.largeUnlockEdit().then((r)=>{window.__u=r;})" >/dev/null
sleep 3
check "unlock refused with UTF-8 reason" "$(evl "$DL" "String(window.__u).includes('UTF-8')")" "true"
check "lock disabled after refusal" "$(evl "$DL" "String(__auto.largeUnlockAvailable())")" "false"
check "stayed read-only (not windowed)" "$(evl "$DL" "String(__auto.isWindowedTab())")" "false"
evl "$DL" "__auto.closeActiveTab()" >/dev/null
tries=0
until [ "$(doc_count)" = "0" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
done

echo "=== memory baseline (before opening big.log) ==="
mem_capture "$OUT/mem-base.txt"

echo "=== open big.log read-only, then unlock in place ==="
open_large "$WORK/big.log"
tries=0
until [ "$(evl "$DL" "String(__auto.isLargeTab())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
done
check "big.log opened read-only" "$(evl "$DL" "String(__auto.isLargeTab())")" "true"
# Wait for the precise line index so scroll math is exact, then view line 3,000,000.
tries=0
until [ "$(evl "$DL" "String(__auto.largeInfo().totalLines !== null)")" = "true" ]; do
  sleep 2
  tries=$((tries + 1))
  if [ "$tries" -gt 90 ]; then
    break
  fi
done
evl "$DL" "__auto.largeGoto(3000000)" >/dev/null
sleep 2
check "lock available for editable file" "$(evl "$DL" "String(__auto.largeUnlockAvailable())")" "true"
evl "$DL" "__auto.largeUnlockEdit().then((r)=>{window.__u=r;})" >/dev/null
tries=0
until [ "$(evl "$DL" "String(__auto.isWindowedTab())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
done
check "unlocked into windowed edit in place" "$(evl "$DL" "String(__auto.isWindowedTab())")" "true"
check "window opened at the viewed position (line 3,000,000)" "$(evl "$DL" "String(__auto.windowedInfo().windowStartLine > 2900000 && __auto.windowedInfo().windowStartLine < 3000000)")" "true"

echo "=== total lines ==="
check "total lines 5,000,000" "$(evl "$DL" "String(__auto.windowedInfo().totalLines)")" "5000000"

echo "=== marker at file head ==="
evl "$DL" "__auto.windowedGoto(1)" >/dev/null
# The goto loads a fresh window from a 240 MB file; typing before it lands puts
# the marker at the old position and takes the neighbour check down with it.
# Requires the text AND the reported position together: either one alone can be
# true mid-load, and an insert that lands between the two is wiped by the rest
# of the load — which shows up as a dirty tab whose marker is nowhere.
e2e_wait_eval "$DL" "String(__auto.getContent().startsWith('0000000001 ') && __auto.windowedInfo().windowStartLine === 0)" "true"
# `typeText` inserts at the caret, which a goto leaves on the requested line —
# not at the window's start, and not where a window-relative reading would put
# it. Logged rather than asserted so a CI failure says where the marker went.
echo "head window: caret=$(evl "$DL" "String(__auto.getCursor().line)") start=$(evl "$DL" "String(__auto.windowedInfo().windowStartLine)") head20=$(evl "$DL" "JSON.stringify(__auto.getContent().slice(0,20))")"
echo "swap trace: $(evl "$DL" "JSON.stringify(__auto.windowedTrace())")"
evl "$DL" "__auto.typeText('MARKERONE')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getContent().startsWith('MARKERONE0000000001 '))" "true"
check "dirty after head edit" "$(evl "$DL" "String(__auto.windowedInfo().dirty)")" "true"
check "head window content" "$(evl "$DL" "String(__auto.getContent().startsWith('MARKERONE0000000001 '))")" "true"

echo "=== deep jump to line 4,800,000 ==="
evl "$DL" "__auto.windowedGoto(4800000)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getContent().includes('0004800000 ') && __auto.windowedInfo().windowStartLine > 4700000)" "true"
check "window moved deep" "$(evl "$DL" "String(__auto.windowedInfo().windowStartLine > 4700000)")" "true"
check "deep window has line 4,800,000" "$(evl "$DL" "String(__auto.getContent().includes('0004800000 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'))")" "true"

echo "=== marker deep and save ==="
echo "deep window: caret=$(evl "$DL" "String(__auto.getCursor().line)") start=$(evl "$DL" "String(__auto.windowedInfo().windowStartLine)") head20=$(evl "$DL" "JSON.stringify(__auto.getContent().slice(0,20))")"
echo "swap trace: $(evl "$DL" "JSON.stringify(__auto.windowedTrace())")"
evl "$DL" "__auto.typeText('MARKERTWO')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getContent().includes('MARKERTWO0004800000 '))" "true"
evl "$DL" "window.__wr=undefined" >/dev/null
evl "$DL" "__auto.windowedSave().then((r)=>{window.__wr=r;})" >/dev/null
e2e_wait_eval "$DL" "String(window.__wr!==undefined)" "true"
check "deep save ok" "$(evl "$DL" "String(window.__wr)")" "ok"
PYOUT=$(python3 - <<PYEOF
import sys
lines = open('$WORK/big.log', 'rb').read().split(b'\n')
def orig(i):
    return b'%010d ' % i + b'x' * 36
checks = [
    ('head line', lines[0], b'MARKERONE' + orig(1)),
    ('deep line', lines[4799999], b'MARKERTWO' + orig(4800000)),
    ('line before deep', lines[4799998], orig(4799999)),
    ('line after deep', lines[4800000], orig(4800001)),
]
# Print what each mismatching line actually holds. Reporting only True/False
# left a CI failure with no way to tell where a marker had gone.
for name, got, want in checks:
    if got != want:
        print(f'{name}: got {got[:60]!r} want {want[:60]!r}', file=sys.stderr)
print(all(got == want for _, got, want in checks))
PYEOF
)
check "both markers placed, neighbours intact" "$PYOUT" "True"
NEW_SIZE=$(file_size "$WORK/big.log")
check "size grew by 18 bytes" "$((NEW_SIZE - ORIG_SIZE))" "18"

echo "=== memory after (open + unlock + deep jump + edit) ==="
mem_capture "$OUT/mem-after.txt"
MEM=$(python3 - <<PYEOF
def parse(fn):
    main, web, sec = {}, {}, None
    for line in open(fn):
        line = line.strip()
        if line in ('MAIN', 'WEBCONTENT'):
            sec = line
            continue
        if not line:
            continue
        pid, rss = line.split()
        (main if sec == 'MAIN' else web)[pid] = int(rss)
    return main, web
mb, wb = parse('$OUT/mem-base.txt')
ma, wa = parse('$OUT/mem-after.txt')
main_inc = sum(ma.values()) - sum(mb.values())
web_inc = sum(max(0, rss - wb.get(pid, 0)) for pid, rss in wa.items())
total_kb = main_inc + web_inc
print(f'{sum(mb.values())} {sum(ma.values())} {main_inc} {web_inc} {total_kb} {total_kb / 1024:.1f}')
PYEOF
)
echo "MEM base_main_kb after_main_kb main_inc_kb web_inc_kb total_inc_kb total_inc_mb"
echo "MEM $MEM"
TOTAL_MB=$(echo "$MEM" | awk '{print $6}')
UNDER=$(awk -v m="$TOTAL_MB" 'BEGIN{print (m < 300) ? "true" : "false"}')
check "memory increase under 300MB (windowed, not whole-load)" "$UNDER" "true"

echo "=== undo x2 back to original ==="
evl "$DL" "__auto.windowedUndo()" >/dev/null
sleep 2
evl "$DL" "__auto.windowedUndo()" >/dev/null
sleep 2
evl "$DL" "window.__wr=undefined" >/dev/null
evl "$DL" "__auto.windowedSave().then((r)=>{window.__wr=r;})" >/dev/null
e2e_wait_eval "$DL" "String(window.__wr!==undefined)" "true"
check "undo save ok" "$(evl "$DL" "String(window.__wr)")" "ok"
if cmp -s "$WORK/big.log" "$WORK/big.orig"; then
  ok "undo restored the original file byte-for-byte"
else
  bad "undo did not restore the original file"
fi

echo "=== redo brings a marker back ==="
evl "$DL" "__auto.windowedRedo()" >/dev/null
sleep 2
evl "$DL" "window.__wr=undefined" >/dev/null
evl "$DL" "__auto.windowedSave().then((r)=>{window.__wr=r;})" >/dev/null
e2e_wait_eval "$DL" "String(window.__wr!==undefined)" "true"
check "redo save ok" "$(evl "$DL" "String(window.__wr)")" "ok"
check "redo restored MARKERONE" "$(python3 -c "print(b'MARKERONE' in open('$WORK/big.log','rb').read())")" "True"

echo "=== conflict: external change then save ==="
printf 'EXTERNALAPPEND\n' >>"$WORK/big.log"
evl "$DL" "__auto.typeText('MARKERTRE')" >/dev/null
sleep 1
evl "$DL" "window.__wr=undefined" >/dev/null
evl "$DL" "__auto.windowedSave().then((r)=>{window.__wr=r;})" >/dev/null
e2e_wait_eval "$DL" "String(window.__wr!==undefined)" "true"
check "fingerprint mismatch detected" "$(evl "$DL" "String(window.__wr)")" "mismatch"
check "conflict modal visible" "$(evl "$DL" "String(__auto.windowedConflictVisible())")" "true"
evl "$DL" "window.__wr=undefined" >/dev/null
evl "$DL" "__auto.windowedSaveForce().then((r)=>{window.__wr=r;})" >/dev/null
e2e_wait_eval "$DL" "String(window.__wr!==undefined)" "true"
check "force write ok" "$(evl "$DL" "String(window.__wr)")" "ok"
check "conflict modal gone after force" "$(evl "$DL" "String(__auto.windowedConflictVisible())")" "false"
# Windowed save is a full-file atomic rewrite (temp + rename), NOT a range
# splice: forcing past the conflict writes the session's whole document, so the
# in-session edit lands and the out-of-band append is deliberately overwritten.
check "forced edit landed" "$(python3 -c "print(b'MARKERTRE' in open('$WORK/big.log','rb').read())")" "True"
check "out-of-band append overwritten by full rewrite" "$(python3 -c "print(b'EXTERNALAPPEND' not in open('$WORK/big.log','rb').read())")" "True"

echo "=== oversized quit gate ==="
evl "$DL" "__auto.typeText('MARKERFOR')" >/dev/null
sleep 1
check "dirty before quit" "$(evl "$DL" "String(__auto.windowedInfo().dirty)")" "true"
# quit is vetoed by the oversized gate; the call returns once the window cancels.
auto '{"id":50,"cmd":"quit"}' >/dev/null 2>&1
sleep 2
check "oversized gate visible" "$(evl "$DL" "String(__auto.oversizedGateVisible())")" "true"
# Discard the windowed edits: the session reopens clean, the gate clears, and the
# pending quit resumes via request_exit, so the process must actually exit.
evl "$DL" "__auto.oversizedGateDiscard()" >/dev/null 2>&1
tries=0
while pgrep -f "target/debug/note-n-pad" >/dev/null 2>&1; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
done
check "app exited after discard" "$(pgrep -f 'target/debug/note-n-pad' >/dev/null 2>&1 && echo alive || echo gone)" "gone"
e2e_kill_owned_ports
sleep 3

echo "=== restart restore (windowed tab reopens editable, no rescan) ==="
# The tab was a windowed-editing tab last session (its persisted
# windowed_index is what marks it as "was unlocked" — see snapshot()/loadTab()),
# and big.log was not touched on disk since the discard above rebased the
# session onto it — fingerprint and digest still match, so windowed_reopen takes
# the no-scan fast path. The lazy restore (beginWindowedRestore) should therefore
# swap the tab from its momentary pending state into `windowed` well within this
# poll's first second or two; it must never settle into the permanent read-only
# large view (that would be the regression this test guards against).
launch
sleep 3
DL=$(doc_label)
tries=0
until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.isWindowedTab==='function'")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
  DL=$(doc_label)
done
tries=0
until [ "$(evl "$DL" "String(__auto.getTabs().length)")" -ge "1" ] 2>/dev/null; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
done
tries=0
until [ "$(evl "$DL" "String(__auto.isWindowedTab())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    break
  fi
done
check "tab restored straight into windowed editing (fast-path reopen)" "$(evl "$DL" "String(__auto.isWindowedTab())")" "true"
# F1: `isWindowedTab()` alone cannot tell a fast-path reopen from a rescan that
# merely finished within this poll's timeout — both end with the tab in
# `windowed`. `windowedRestoreRescanned()` reads `windowed_reopen`'s own
# `rescanned` flag, so this is the actual assertion that catches the digest
# silently rounding through the IPC boundary and permanently defeating the
# fast path (see windowed.rs's `IndexSnapshot`/`parse_digest`).
check "restart restore took the fast path, not a rescan" "$(evl "$DL" "String(__auto.windowedRestoreRescanned())")" "false"
check "tab restored, not range" "$(evl "$DL" "String(__auto.isRangeTab())")" "false"
check "not left in the read-only large view" "$(evl "$DL" "String(__auto.isLargeTab())")" "false"
# The top-of-viewport line at last quit (reset to 0 by the discard just
# above, which reopens a fresh session at the on-disk baseline) is persisted as
# windowed_top_line and fed back through initialTopLine, so the restored window
# should again cover the start of the file rather than defaulting somewhere else.
check "restored top line matches the persisted position (0, from the discard reset)" "$(evl "$DL" "String(__auto.windowedInfo().windowStartLine < 50)")" "true"

echo "=== edit mode: opens straight into editing ==="
# With large_open_mode 'edit', opening a large file skips the confirm entirely and
# auto-unlocks into in-place editing — no modal, no manual lock click. Uses
# big.orig (a distinct 240MB UTF-8 file) so it opens in its own window rather than
# refocusing the restored tab.
evl "$DL" "__auto.setLargeOpenMode('edit')" >/dev/null
e2e_wait_setting large_open_mode "edit"
check "mode set to edit" "$(evl "$DL" "String(__auto.getLargeOpenMode())")" "edit"
BOOT2=$(auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1)
DOCS_BEFORE=$(doc_labels)
evl "$BOOT2" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/big.orig'})" >/dev/null
e2e_wait_until new_doc_exists "$DOCS_BEFORE"
DLE=$(new_doc_label "$DOCS_BEFORE")
if [ -z "$DLE" ]; then
  DLE="$DL"
fi
e2e_wait_eval "$DLE" "typeof __auto!=='undefined' && typeof __auto.isWindowedTab==='function'" "true"
# Opening straight into editing scans the whole 240 MB file first, so this is
# the longest wait in the suite; the old 30 s bound expired mid-scan on a
# 2-core VM and reported the still-unfinished state as a failure.
e2e_wait_eval "$DLE" "String(__auto.isWindowedTab())" "true"
check "edit mode raises no confirm" "$(evl "$DLE" "String(__auto.largeConfirmVisible())")" "false"
check "edit mode opens straight into windowed editing" "$(evl "$DLE" "String(__auto.isWindowedTab())")" "true"
check "not left in read-only large view" "$(evl "$DLE" "String(__auto.isLargeTab())")" "false"
evl "$DLE" "__auto.closeActiveTab()" >/dev/null
sleep 2
evl "$DL" "__auto.setLargeOpenMode('$ORIG_MODE')" >/dev/null 2>&1
e2e_wait_setting large_open_mode "$ORIG_MODE"
check "mode restored to original" "$(evl "$DL" "String(__auto.getLargeOpenMode())")" "$ORIG_MODE"

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
rm -f "$OUT/mem-base.txt" "$OUT/mem-after.txt"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
