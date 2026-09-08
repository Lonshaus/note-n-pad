#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# PENDING LIVE RUN: updated for the unified large_open_mode ('ask'|'view'|'edit')
# that replaced the ask_before_large_open toggle; not yet re-run against the app.
# E2E: the large-file viewer.
# Fixtures: 120MB numbered-line file (real content) + 600MB sparse file (only
# for the confirm-modal edit-cap check; never opened).
# LESSON: never put `await` inside an eval string.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. If the automation port is already dead when the trap
# fires, the app-side restore call (ECONNREFUSED) is skipped and settings.json
# is left pinned. As a fallback once the app is confirmed dead, patch
# settings.json directly with jq so the on-disk language always reverts.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Fixtures and logs live in a throwaway tmp dir, never in the repo.
WORK="$OUT/large-fixture"
mkdir -p "$OUT"
: >"$OUT/dev-large.log"
PASS=0
FAIL=0

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
boot_label() {
  auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1
}
doc_label() {
  auto '{"id":3,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label' | head -1
}
# jq is a native binary on Windows and writes CRLF; `read -r` keeps the CR
# and `$( )` strips only the trailing one, so a captured set and a streamed
# line would silently never match without stripping it here.
doc_labels() {
  auto '{"id":30,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label' | tr -d '\r'
}
doc_count() {
  auto '{"id":33,"cmd":"list_windows"}' | jq -r '[.data[]|select(.label|startswith("doc-"))]|length'
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
  auto "{\"id\":$(e2e_next_id),\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
launch() {
  e2e_require_clean_slate
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-large.log" 2>&1 &
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

echo "=== preflight ==="
# Snapshots for files under any session scratchpad are demo/test artifacts left
# by acceptance sessions; clean them automatically. Anything else is real user
# data and still aborts the run.
for f in "$STORE"/*.json; do
  if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
    FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
    case "$FP" in
      *note-n-pad-e2e*)
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
lines = 2400000
with open('$WORK/big.log', 'w', newline='') as f:
    for i in range(1, lines + 1):
        f.write(f'line {i:07d} abcdefghijklmnopqrstuvwxyz0123456789\n')
PYEOF
# A second copy for the ask-mode check below. Opening a path that is already
# open in another window adds no tab there, and a document window with no tabs
# closes itself — so reusing big.log leaves the block with a window that is gone
# a second later and every eval against it fails. e2e-windowed.sh
# keeps a big.orig copy for the same reason.
cp "$WORK/big.log" "$WORK/big.ask"
make_sparse_file "$WORK/huge.bin" 600
BIGSIZE=$(file_size "$WORK/big.log")
echo "big.log bytes: $BIGSIZE  huge.bin bytes: $(file_size "$WORK/huge.bin")"

launch
BOOT=$(boot_label)
if [ -z "$BOOT" ]; then
  echo "FATAL: no bootstrap window"
  quit_app
  exit 1
fi
evl "$BOOT" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/big.log'})" >/dev/null
sleep 4
DL=$(doc_label)
tries=0
until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.largeConfirmVisible==='function'")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 20 ]; then
    echo "FATAL: doc window/hooks never appeared"
    quit_app
    exit 1
  fi
  DL=$(doc_label)
done

# Pin the UI language so text assertions never depend on the host system
# language; restore the user's real preference on exit or interrupt. The trap
# looks the doc label up live because the restart section opens a fresh window.
ORIG_LANG=$(evl "$DL" "String(__auto.getLanguage())")
echo "original language: $ORIG_LANG"
# The open-modes section writes the user's real large_open_mode; capture it now
# and restore it on any exit (single value, replacing the old ask toggle).
ORIG_MODE=$(evl "$DL" "String(__auto.getLargeOpenMode())")
echo "original large_open_mode: $ORIG_MODE"
restore_lang() {
  trap '' INT TERM
  local dl
  dl=$(doc_label 2>/dev/null)
  if [ -n "$dl" ] && [ -n "${ORIG_LANG:-}" ]; then
    evl "$dl" "__auto.setLanguage('$ORIG_LANG')" >/dev/null 2>&1
  fi
  if [ -n "$dl" ] && [ -n "${ORIG_MODE:-}" ]; then
    evl "$dl" "__auto.setLargeOpenMode('$ORIG_MODE')" >/dev/null 2>&1
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
trap restore_lang EXIT INT TERM
evl "$DL" "__auto.setLanguage('zh-TW')" >/dev/null
sleep 1

echo "=== confirm modal ==="
check "confirm visible for >100MB" "$(evl "$DL" "String(__auto.largeConfirmVisible())")" "true"
evl "$DL" "__auto.largeConfirmAccept()" >/dev/null
sleep 2
check "large tab active" "$(evl "$DL" "String(__auto.isLargeTab())")" "true"
check "lock available for editable large file (<512MB)" "$(evl "$DL" "String(__auto.largeUnlockAvailable())")" "true"
check "size reported" "$(evl "$DL" "JSON.stringify(__auto.largeInfo().size)")" "$BIGSIZE"
check "first line rendered" "$(evl "$DL" "String(__auto.largeVisibleText().includes('line 0000001 '))")" "true"

echo "=== index completes ==="
tries=0
until [ "$(evl "$DL" "String(__auto.largeInfo().totalLines !== null)")" = "true" ]; do
  sleep 2
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    break
  fi
done
# 2400001 = 2.4M newlines + the addressable empty last line, matching how the
# editor shows a trailing newline.
check "total lines exact" "$(evl "$DL" "JSON.stringify(__auto.largeInfo().totalLines)")" "2400001"

echo "=== deep jump ==="
evl "$DL" "void __auto.largeScrollToLine(1999999)" >/dev/null
sleep 3
FIRST=$(evl "$DL" "String(__auto.largeVisibleFirstLine())")
case "$FIRST" in
  199*) ok "scrolled near line 2000000 (first=$FIRST)" ;;
  200*) ok "scrolled near line 2000000 (first=$FIRST)" ;;
  *) bad "scrolled near line 2000000 (first=$FIRST)" ;;
esac
check "deep content correct" "$(evl "$DL" "String(__auto.largeVisibleText().includes('line 2000000 '))")" "true"

echo "=== goto line ==="
check "goto hidden initially" "$(evl "$DL" "String(__auto.largeGotoVisible())")" "false"
evl "$DL" "__auto.largeGotoOpen()" >/dev/null
check "goto opens" "$(evl "$DL" "String(__auto.largeGotoVisible())")" "true"
evl "$DL" "__auto.largeGoto(42)" >/dev/null
sleep 2
FIRST_G=$(evl "$DL" "String(__auto.largeVisibleFirstLine())")
case "$FIRST_G" in
  4[0-9]) ok "goto landed near line 42 (first=$FIRST_G)" ;;
  *) bad "goto landed near line 42 (first=$FIRST_G)" ;;
esac
check "goto content correct" "$(evl "$DL" "String(__auto.largeVisibleText().includes('line 0000042 '))")" "true"

echo "=== stream search ==="
evl "$DL" "__auto.largeSearchOpen()" >/dev/null
check "search panel opens" "$(evl "$DL" "String(__auto.largeSearchVisible())")" "true"
evl "$DL" "__auto.largeSearch('line 0000777 ', false)" >/dev/null
tries=0
until [ "$(evl "$DL" "String(__auto.largeSearchDone())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    break
  fi
done
check "unique query found once" "$(evl "$DL" "JSON.stringify(__auto.largeSearchResults().length)")" "1"
check "hit line correct (1-based)" "$(evl "$DL" "JSON.stringify(__auto.largeSearchResults()[0]?.line)")" "777"
evl "$DL" "__auto.largeSearchJump(0)" >/dev/null
sleep 2
check "jump to hit shows content" "$(evl "$DL" "String(__auto.largeVisibleText().includes('line 0000777 '))")" "true"
evl "$DL" "__auto.largeSearch('line 0', false)" >/dev/null
tries=0
until [ "$(evl "$DL" "String(__auto.largeSearchDone())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 90 ]; then
    break
  fi
done
check "broad query hits capped at 5000" "$(evl "$DL" "JSON.stringify(__auto.largeSearchResults().length)")" "5000"
evl "$DL" "__auto.largeSearchClose()" >/dev/null
check "search closes" "$(evl "$DL" "String(__auto.largeSearchVisible())")" "false"

echo "=== range actions on a file that has gone away ==="
# `lineToOffset` answers null once the file is unreadable, and both range
# buttons used to take that as "nothing to do" and return without a word: the
# click looked like it had missed the button.
evl "$DL" "__auto.largeSelectRange(10,20)" >/dev/null
check "a range is selected" "$(evl "$DL" "JSON.stringify(__auto.largeGetRange())")" '{"startLine":10,"endLine":20}'
check "no error is showing yet" "$(evl "$DL" "String((document.querySelector('.range-error')||{textContent:''}).textContent)")" ""
mv "$WORK/big.log" "$WORK/big.gone"
evl "$DL" "__auto.largeRangeEdit()" >/dev/null
e2e_wait_eval "$DL" "String((document.querySelector('.range-error')||{textContent:''}).textContent!=='')" "true"
check "edit-range says why nothing opened" "$(evl "$DL" "String((document.querySelector('.range-error')||{textContent:''}).textContent!=='')")" "true"
check "no range tab was opened" "$(evl "$DL" "String(__auto.isRangeTab())")" "false"
evl "$DL" "window.__rsa='pending';__auto.largeRangeSaveAs('$WORK/vanished.out').then(function(r){window.__rsa=String(r)}).catch(function(e){window.__rsa='err'})" >/dev/null
e2e_wait_eval "$DL" "String(window.__rsa)" "false"
check "save-range reports failure rather than resolving quietly" "$(evl "$DL" "String((document.querySelector('.range-error')||{textContent:''}).textContent!=='')")" "true"
check "no half-written destination was left" "$([ -f "$WORK/vanished.out" ] && echo present || echo absent)" "absent"
mv "$WORK/big.gone" "$WORK/big.log"
evl "$DL" "__auto.largeSelectRange(10,20)" >/dev/null

echo "=== cap and cancel ==="
# The second open lands in a NEW doc window; query the newest doc- label.
evl "$DL" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/huge.bin'})" >/dev/null
sleep 4
# jq writes CRLF on Windows, so the stream needs the same tr -d '\r' as
# doc_labels before it can be compared against a $( )-captured, CR-free $DL.
DL2=$(auto '{"id":13,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label' | tr -d '\r' | grep -v "^$DL$" | head -1)
if [ -z "$DL2" ]; then
  DL2="$DL"
fi
check "confirm visible for 600MB" "$(evl "$DL2" "String(__auto.largeConfirmVisible())")" "true"
evl "$DL2" "__auto.largeConfirmCancel()" >/dev/null
sleep 2
WIN_COUNT=$(auto '{"id":14,"cmd":"list_windows"}' | jq -r '[.data[]|select(.label|startswith("doc-"))]|length')
check "cancel collapses the empty window" "$WIN_COUNT" "1"
check "original large tab intact" "$(evl "$DL" "String(__auto.isLargeTab())")" "true"

echo "=== open modes ==="
check "mode defaults to ask" "$ORIG_MODE" "ask"
# 'view' mode: no confirm, the file opens straight in the read-only large view.
evl "$DL" "__auto.setLargeOpenMode('view')" >/dev/null
e2e_wait_setting large_open_mode "view"
DOCS_BEFORE=$(doc_labels)
evl "$DL" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/huge.bin'})" >/dev/null
e2e_wait_until new_doc_exists "$DOCS_BEFORE"
DL4=$(new_doc_label "$DOCS_BEFORE")
if [ -n "$DL4" ]; then
  # The window exists; its tab still has to finish opening before either
  # assertion means anything.
  e2e_wait_eval "$DL4" "String(__auto.isLargeTab())" "true"
  check "no confirm in view mode" "$(evl "$DL4" "String(__auto.largeConfirmVisible())")" "false"
  check "opened straight into large view" "$(evl "$DL4" "String(__auto.isLargeTab())")" "true"
  # Both assertions above pass whichever window is bound; the size pins it
  # down to the huge.bin window actually meant by this block.
  check "view-mode window is the huge.bin window" "$(evl "$DL4" "String(__auto.largeInfo().size)")" "629145600"
  evl "$DL4" "__auto.closeActiveTab()" >/dev/null
else
  bad "view-mode window never appeared"
fi
# 'ask' mode: an editable large file's confirm offers an Edit button that unlocks
# straight into in-place (windowed) editing. big.ask is UTF-8 and under the 512MB
# cap, and is a separate copy so this open really does get its own window.
ASK_EVAL_RESULT="$(evl "$DL" "__auto.setLargeOpenMode('ask')")"
e2e_wait_setting large_open_mode "ask"
ASK_WAIT_STATUS=$?
DOCS_BEFORE=$(doc_labels)
evl "$DL" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/big.ask'})" >/dev/null
e2e_wait_until new_doc_exists "$DOCS_BEFORE"
DL5=$(new_doc_label "$DOCS_BEFORE")
if [ -n "$DL5" ]; then
  # Every other block waits for the window's hooks before touching them; this
  # one did not, and an eval that runs before __auto exists throws, which the
  # harness reports as an error and evl renders as a bare "null".
  e2e_wait_eval "$DL5" "typeof __auto!=='undefined' && typeof __auto.largeConfirmVisible==='function'" "true"
  # $DL5 must be the new window for big.ask, not $DL itself: both existing
  # assertions in this block pass whichever window is bound, which is how a
  # wrong binding survived five runs.
  check "ask-mode open bound its own window" "$([ "$DL5" != "$DL" ] && echo true || echo false)" "true"
  if ! e2e_wait_eval "$DL5" "String(__auto.largeConfirmVisible())" "true"; then
    # Distinguishes "the setting never landed / $DL was already dead" from
    # "the setting landed and the new window still showed no confirm", so a
    # fix is not guessed at from the assertion failure alone.
    echo "=== ask-mode diagnostics ==="
    echo "setLargeOpenMode('ask') eval returned: $ASK_EVAL_RESULT"
    echo "e2e_wait_setting large_open_mode ask exit status: $ASK_WAIT_STATUS"
    echo "large_open_mode in settings.json: $(jq -r '.large_open_mode // empty' "$APPDIR/settings.json" 2>/dev/null)"
    case "$(doc_labels 2>/dev/null)" in
      *"$DL"*)
        echo "\$DL ($DL) still in window list: yes"
        ;;
      *)
        echo "\$DL ($DL) still in window list: no"
        ;;
    esac
    echo "full window list: $(auto '{"id":96,"cmd":"list_windows"}' 2>/dev/null)"
    echo "new window getLargeOpenMode(): $(evl "$DL5" "String(__auto.getLargeOpenMode())" 2>/dev/null)"
    echo "new window largeInfo(): $(evl "$DL5" "JSON.stringify(__auto.largeInfo())" 2>/dev/null)"
  fi
  check "ask mode shows confirm" "$(evl "$DL5" "String(__auto.largeConfirmVisible())")" "true"
  evl "$DL5" "__auto.largeConfirmEdit()" >/dev/null
  # Unlocking scans the whole file, so this is the longest wait in the suite —
  # 30 s was not enough for 120 MB on a 2-core VM.
  e2e_wait_eval "$DL5" "String(__auto.isWindowedTab())" "true"
  check "edit button unlocks into windowed editing" "$(evl "$DL5" "String(__auto.isWindowedTab())")" "true"
  evl "$DL5" "__auto.closeActiveTab()" >/dev/null
else
  bad "ask-mode window never appeared"
fi
evl "$DL" "__auto.setLargeOpenMode('$ORIG_MODE')" >/dev/null
e2e_wait_setting large_open_mode "$ORIG_MODE"
MODE_RESTORED="$(evl "$DL" "String(__auto.getLargeOpenMode())")"
if [ "$MODE_RESTORED" != "$ORIG_MODE" ]; then
  # $DL can be gone by the time this reads it; dump the window list so a
  # missing window is distinguished from a setting that never landed.
  echo "full window list: $(auto '{"id":96,"cmd":"list_windows"}' 2>/dev/null)"
  case "$(doc_labels 2>/dev/null)" in
    *"$DL"*)
      echo "\$DL ($DL) still in window list: yes"
      ;;
    *)
      echo "\$DL ($DL) still in window list: no"
      ;;
  esac
fi
check "mode restored" "$MODE_RESTORED" "$ORIG_MODE"

echo "=== restart restore ==="
quit_app
check "large tab persisted a snapshot" "$(count_kind document)" "1"
launch
sleep 3
DLR=$(doc_label)
tries=0
until [ -n "$DLR" ] && [ "$(evl "$DLR" "typeof __auto!=='undefined' && typeof __auto.isLargeTab==='function'")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 20 ]; then
    break
  fi
  DLR=$(doc_label)
done
evl "$DLR" "__auto.setLanguage('$ORIG_LANG')" >/dev/null
sleep 1
check "restored without confirm" "$(evl "$DLR" "String(__auto.largeConfirmVisible())")" "false"
check "restored as large tab" "$(evl "$DLR" "String(__auto.isLargeTab())")" "true"
check "restored size intact" "$(evl "$DLR" "JSON.stringify(__auto.largeInfo().size)")" "$BIGSIZE"
check "restored content renders" "$(evl "$DLR" "String(__auto.largeVisibleText().includes('line '))")" "true"
evl "$DLR" "__auto.closeActiveTab()" >/dev/null
sleep 2
check "closing large tab deletes snapshot" "$(count_kind document)" "0"

echo "=== teardown ==="
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
