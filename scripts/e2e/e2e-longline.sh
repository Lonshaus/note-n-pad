#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: new-window long-line open-dialog flow.
# Regression cover for three bugs that all slipped through the unautomated
# "open a fresh document window -> long-line confirm -> pick an option" path
# found while accepting the long-line work:
#   bug a: Enter splitting a super-long line did not lift the long-line gate live.
#   bug b: the empty-window guard flash-closed a fresh window mid-dialog, because
#          the pendingLongLineOpen flag was missing from shouldCollapseEmptyWindow.
#   bug c: a pathologically deep JSON single line froze the window while the open
#          tried to pretty-print it, instead of the depth guard refusing "format".
# The suite drives the real app over the automation port (window.__auto via eval),
# opening each case in its own document window through the Rust open_document_window
# command (the same entry a File>Open-in-new-window uses), and also runs the
# existing in-window openTab path once through all three options so both routes
# are covered.
# LESSON (inherited from the other suites): never put `await` inside an eval
# string; use `.then((r)=>{window.__x=r;})` and poll for window.__x.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. The trap restores the ask_long_line_open setting (pinned
# on for a deterministic run) both via the live app and, as a fallback once the
# app is dead, straight in settings.json with jq.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/longline-fixture"
SEEN="$OUT/longline-seen-docs.txt"
PASS=0
FAIL=0
mkdir -p "$OUT"
: >"$OUT/dev-longline.log"

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
evl() {
  auto "{\"id\":$(e2e_next_id),\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
# Whether a doc- window with this label is currently present.
label_present() {
  auto '{"id":3,"cmd":"list_windows"}' | jq -e --arg l "$1" '.data[]|select(.label==$l)' >/dev/null 2>&1
}
# Wait for a doc- window label not seen before, record it, and echo it. A window
# that the empty-window guard wrongly collapses never yields a stable new label,
# so a timeout here doubles as the bug-b failure signal.
new_doc_label() {
  local tries=0 lab
  while [ "$tries" -lt 30 ]; do
    # jq writes CRLF on Windows; -x needs a whole-line match, so the CR has
    # to come off the stream before it can compare against $SEEN's CR-free
    # entries (each was captured through a $( ) that already stripped it).
    lab=$(auto '{"id":3,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label' | tr -d '\r' | grep -vxF -f "$SEEN" 2>/dev/null | head -1)
    if [ -n "$lab" ]; then
      echo "$lab" >>"$SEEN"
      printf '%s\n' "$lab"
      return 0
    fi
    sleep 1
    tries=$((tries + 1))
  done
  return 1
}
# Block until a doc window's __auto surface is installed and carries the
# long-line hooks (the window has mounted its DocumentApp).
wait_hooks() {
  local tries=0
  until [ "$(evl "$1" "typeof __auto!=='undefined' && typeof __auto.longLineConfirmVisible==='function'")" = "true" ]; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 30 ]; then
      break
    fi
  done
}
# Open $1 in a fresh document window; sets DL to its label. Waits for the window
# and its hooks, so DL is ready to eval against on return.
open_window() {
  evl "$BOOT" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$1'})" >/dev/null
  DL=$(new_doc_label)
  if [ -z "${DL:-}" ]; then
    bad "new window for $1 never appeared (empty-window guard collapsed it?)"
    return 1
  fi
  wait_hooks "$DL"
}
# dirty flag of the active tab in doc window $1.
active_dirty() {
  evl "$1" "String((__auto.getTabs().find((t)=>t.active)||{}).dirty)"
}
# Wait until the long-line gate for doc window $1 reads $2 (true/false).
wait_gate() {
  local tries=0
  until [ "$(evl "$1" "String(__auto.longLineActive())")" = "$2" ]; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 20 ]; then
      break
    fi
  done
}
launch() {
  e2e_require_clean_slate
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-longline.log" 2>&1 &
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
# Remove only this suite's own leftover snapshots (fixtures live under
# note-n-pad-e2e); anything else is real user data and aborts the run.
for f in "$STORE"/*.json; do
  if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
    FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
    case "$FP" in
      *note-n-pad-e2e*)
        rm -f "$f"
        echo "preflight: removed test snapshot ($FP)"
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
: >"$SEEN"
# All fixtures are single-line files whose one line is well past the 10,000-unit
# long-line threshold, so every open trips the long-line gate. Distinct paths per
# case matter: openTab/open_document_window dedupe by path and would otherwise
# focus an already-open window instead of raising a fresh confirm.
python3 - <<PYEOF
import json
w = '$WORK'
# Plain long lines (non-JSON): 15,000 'a' on one line. Splittable in half so an
# Enter at the midpoint yields two sub-threshold lines. Two distinct copies.
for name in ('plain-a.txt', 'plain-b.txt', 'otab-plain.txt'):
    with open(f'{w}/{name}', 'w', newline='') as f:
        f.write('a' * 15000)
# Flat, shallow JSON on one line (~18k chars, depth 2): beautify succeeds, so the
# confirm offers "format". Two distinct copies (new-window + openTab paths).
flat = json.dumps({'items': list(range(3000))}, separators=(',', ':'))
assert '\n' not in flat and len(flat) > 10000
for name in ('flat.json', 'otab-flat.json'):
    with open(f'{w}/{name}', 'w', newline='') as f:
        f.write(flat)
# Pathologically deep but valid JSON: 30,000 nested arrays on one line. maxJsonDepth
# exceeds the beautify cap, so "format" must be refused and the open must not freeze.
with open(f'{w}/deep.json', 'w', newline='') as f:
    f.write('[' * 30000 + ']' * 30000)
# Astral emoji line: 8,000 U+1F600 = 16,000 UTF-16 units on one line. Soft-wrap
# must break it into pieces without ever cutting a surrogate pair. Two copies.
for name in ('emoji.txt', 'otab-emoji.txt'):
    with open(f'{w}/{name}', 'w', encoding='utf-8', newline='') as f:
        f.write('\U0001F600' * 8000)
# Short host file (no long line): opens a plain document window with no confirm,
# used as the live window the in-window openTab path runs against.
with open(f'{w}/host.txt', 'w', newline='') as f:
    f.write('short host document\n')
PYEOF
echo "fixtures:"
ls -l "$WORK"

# Pin ask_long_line_open on for a deterministic run and restore it on exit. The
# app reads settings.json at startup, so patch the file before launch; capture the
# user's value first (default true when the file or key is absent).
if [ -f "$APPDIR/settings.json" ]; then
  ORIG_ASK=$(jq -r '.ask_long_line_open // true' "$APPDIR/settings.json")
  jq '.ask_long_line_open = true' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
    && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
else
  ORIG_ASK=true
fi
echo "original ask_long_line_open: $ORIG_ASK"
restore_settings() {
  trap '' INT TERM
  quit_app
  # App is dead now; patch settings.json directly so ask_long_line_open reverts
  # even if a live restore never reached the automation port.
  if [ -n "${ORIG_ASK:-}" ] && [ -f "$APPDIR/settings.json" ]; then
    jq --argjson a "$ORIG_ASK" '.ask_long_line_open = $a' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
      && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
  fi
  # Drop any snapshot this suite's fixtures left behind.
  for f in "$STORE"/*.json; do
    if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
      FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
      case "$FP" in
        *note-n-pad-e2e*) rm -f "$f" ;;
      esac
    fi
  done
  rm -rf "$WORK"
  rm -f "$SEEN"
  e2e_kill_owned_ports
}
trap restore_settings EXIT INT TERM

launch
BOOT=$(boot_label)
if [ -z "$BOOT" ]; then
  echo "FATAL: no bootstrap window"
  exit 1
fi

echo "=== 1+2. new window, open as-is: window survives, gate holds ==="
# bug b: the fresh window must stay alive to show the confirm.
open_window "$WORK/plain-a.txt" || true
# open_window only waits for the window's hooks; the confirm itself renders
# after that, so an assertion right behind it is a race.
e2e_wait_eval "$DL" "String(__auto.longLineConfirmVisible())" "true"
check "confirm visible in fresh window" "$(evl "$DL" "String(__auto.longLineConfirmVisible())")" "true"
check "format not offered for plain text" "$(evl "$DL" "String(__auto.longLineFormatAvailable())")" "false"
sleep 2
check "window not collapsed mid-dialog (bug b)" "$(label_present "$DL" && echo present || echo gone)" "present"
evl "$DL" "__auto.longLineConfirmAsIs()" >/dev/null
wait_gate "$DL" "true"
check "gate active after as-is open" "$(evl "$DL" "String(__auto.longLineActive())")" "true"
check "content opened unchanged (15000 units, one line)" "$(evl "$DL" "String(__auto.getContent().length===15000 && !__auto.getContent().includes('\n'))")" "true"
check "as-is tab is not dirty" "$(active_dirty "$DL")" "false"
evl "$DL" "document.querySelector('.cm-content').focus()" >/dev/null
evl "$DL" "__auto.typeText('MARK2')" >/dev/null
sleep 1
check "typing lands in as-is tab" "$(evl "$DL" "String(__auto.getContent().startsWith('MARK2'))")" "true"

echo "=== 3. new window, format: multi-line, gate lifts, dirty, disk untouched ==="
FLAT_SIZE=$(file_size "$WORK/flat.json")
open_window "$WORK/flat.json" || true
# Same hooks-vs-render race as above.
e2e_wait_eval "$DL" "String(__auto.longLineConfirmVisible())" "true"
check "format offered for flat JSON" "$(evl "$DL" "String(__auto.longLineFormatAvailable())")" "true"
evl "$DL" "__auto.longLineConfirmFormat()" >/dev/null
wait_gate "$DL" "false"
check "gate lifted after format" "$(evl "$DL" "String(__auto.longLineActive())")" "false"
check "formatted content is multi-line" "$(evl "$DL" "String(__auto.getContent().split('\n').length>1)")" "true"
check "format tab is dirty" "$(active_dirty "$DL")" "true"
check "disk file not auto-saved (still one line)" "$(file_size "$WORK/flat.json")" "$FLAT_SIZE"
check "disk file still single-line" "$(python3 -c "print(open('$WORK/flat.json').read().count(chr(10)))")" "0"

echo "=== 4. new window, deep JSON: no format option, no freeze (bug c) ==="
T0=$(date +%s.%N)
open_window "$WORK/deep.json" || true
T1=$(date +%s.%N)
OPEN_RT=$(python3 -c "print(round($T1-$T0,2))")
echo "deep-file open->confirm elapsed: ${OPEN_RT}s"
# Same hooks-vs-render race as above.
e2e_wait_eval "$DL" "String(__auto.longLineConfirmVisible())" "true"
check "deep open reached the confirm without freezing" "$(evl "$DL" "String(__auto.longLineConfirmVisible())")" "true"
check "format refused for over-deep nesting" "$(evl "$DL" "String(__auto.longLineFormatAvailable())")" "false"
# Main thread stayed responsive: a fresh eval round-trips quickly (a real freeze
# in JSON.stringify would hang this well past the bound).
T2=$(date +%s.%N)
PONG=$(evl "$DL" "'pong'")
T3=$(date +%s.%N)
PONG_RT=$(python3 -c "print(round($T3-$T2,2))")
check "eval responsive after deep open" "$(python3 -c "print($PONG_RT < 2.0)")" "True"
check "eval round-trip returned" "$PONG" "pong"
evl "$DL" "__auto.longLineConfirmCancel()" >/dev/null
sleep 2

echo "=== 5. new window, soft-wrap: multi-line, gate lifts, surrogates intact ==="
open_window "$WORK/emoji.txt" || true
# Same hooks-vs-render race as above.
e2e_wait_eval "$DL" "String(__auto.longLineConfirmVisible())" "true"
check "confirm visible for emoji line" "$(evl "$DL" "String(__auto.longLineConfirmVisible())")" "true"
evl "$DL" "__auto.longLineConfirmSoftWrap()" >/dev/null
wait_gate "$DL" "false"
check "gate lifted after soft-wrap" "$(evl "$DL" "String(__auto.longLineActive())")" "false"
check "soft-wrapped content is multi-line" "$(evl "$DL" "String(__auto.getContent().split('\n').length>1)")" "true"
# Iterating with the spread operator yields code points; a broken pair would show
# as a lone surrogate, so an all-emoji (plus newline) content proves no cut pair.
check "no surrogate pair split at a break" "$(evl "$DL" "String([...__auto.getContent()].every((cp)=>cp==='\n'||cp==='\u{1F600}'))")" "true"

echo "=== 6. new window, Enter mid super-long line lifts the gate live (bug a) ==="
open_window "$WORK/plain-b.txt" || true
# No waited assertion precedes this action: without the wait, a confirm that
# has not rendered yet turns the click into a no-op and wait_gate below burns
# its full bound before the run goes red for exactly this race.
e2e_wait_eval "$DL" "String(__auto.longLineConfirmVisible())" "true"
evl "$DL" "__auto.longLineConfirmAsIs()" >/dev/null
wait_gate "$DL" "true"
check "gate active before split" "$(evl "$DL" "String(__auto.longLineActive())")" "true"
# Place the caret at the midpoint of the 15,000-unit line and insert a newline;
# both halves fall under the threshold, so the gate must lift without a tab split.
evl "$DL" "__auto.setDocSelection(7500,7500)" >/dev/null
sleep 1
evl "$DL" "__auto.typeText('\n')" >/dev/null
wait_gate "$DL" "false"
check "gate lifted immediately after Enter split (bug a)" "$(evl "$DL" "String(__auto.longLineActive())")" "false"
check "line was split in two" "$(evl "$DL" "String(__auto.getContent().split('\n').length===2)")" "true"

echo "=== 7. in-window openTab path runs all three options ==="
# A short host file opens a plain document window (no confirm); the openTab hook
# then drives the same long-line dialog from inside a live window.
open_window "$WORK/host.txt" || true
DHOST="$DL"
check "host window has no confirm" "$(evl "$DHOST" "String(__auto.longLineConfirmVisible())")" "false"
# openTab -> format
evl "$DHOST" "__auto.openTab('$WORK/otab-flat.json')" >/dev/null
tries=0
until [ "$(evl "$DHOST" "String(__auto.longLineConfirmVisible())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 20 ]; then
    break
  fi
done
check "openTab raises the confirm" "$(evl "$DHOST" "String(__auto.longLineConfirmVisible())")" "true"
check "openTab confirm offers format (three options)" "$(evl "$DHOST" "String(__auto.longLineFormatAvailable())")" "true"
evl "$DHOST" "__auto.longLineConfirmFormat()" >/dev/null
wait_gate "$DHOST" "false"
check "openTab format lifted the gate" "$(evl "$DHOST" "String(__auto.longLineActive())")" "false"
check "openTab format tab is dirty" "$(active_dirty "$DHOST")" "true"
# openTab -> as-is
evl "$DHOST" "__auto.openTab('$WORK/otab-plain.txt')" >/dev/null
tries=0
until [ "$(evl "$DHOST" "String(__auto.longLineConfirmVisible())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 20 ]; then
    break
  fi
done
evl "$DHOST" "__auto.longLineConfirmAsIs()" >/dev/null
wait_gate "$DHOST" "true"
check "openTab as-is keeps the gate active" "$(evl "$DHOST" "String(__auto.longLineActive())")" "true"
check "openTab as-is tab is not dirty" "$(active_dirty "$DHOST")" "false"
# openTab -> soft-wrap
evl "$DHOST" "__auto.openTab('$WORK/otab-emoji.txt')" >/dev/null
tries=0
until [ "$(evl "$DHOST" "String(__auto.longLineConfirmVisible())")" = "true" ]; do
  sleep 1
  tries=$((tries + 1))
  if [ "$tries" -gt 20 ]; then
    break
  fi
done
evl "$DHOST" "__auto.longLineConfirmSoftWrap()" >/dev/null
wait_gate "$DHOST" "false"
check "openTab soft-wrap lifted the gate" "$(evl "$DHOST" "String(__auto.longLineActive())")" "false"
check "openTab soft-wrap content is multi-line" "$(evl "$DHOST" "String(__auto.getContent().split('\n').length>1)")" "true"

echo "=== 8. a file that cannot be read is reported, not opened blank ==="
# The same empty-window guard as the long-line gate: a window opened solely for
# a file that fails to load must stay up long enough to say so. Forgetting to
# tell `shouldCollapseEmptyWindow` about a new pending state flash-closes the
# window and the open looks like nothing happened — this is that regression.
GHOST="$WORK/no-such-file.md"
rm -f "$GHOST"
open_window "$GHOST" || true
if [ -n "${DL:-}" ]; then
  check "the failed open is reported" \
    "$(evl "$DL" "String(document.querySelectorAll('.modal').length)")" "1"
  check "the report offers one button, not a choice" \
    "$(evl "$DL" "String(document.querySelectorAll('.modal .btn').length)")" "1"
  check "the report names the file" \
    "$(evl "$DL" "String((document.querySelector('.modal p')||{}).textContent.includes('no-such-file.md'))")" "true"
  check "no tab was opened for it" \
    "$(evl "$DL" "String(__auto.getTabs().length)")" "0"
  # Closing the report leaves nothing to show, so the window collapses itself
  # rather than sitting there empty.
  evl "$DL" "document.querySelector('.modal .btn').click()" >/dev/null
  gone=false
  tries=0
  while [ "$tries" -lt 15 ]; do
    if ! auto '{"id":3,"cmd":"list_windows"}' | jq -e --arg l "$DL" '.data[]|select(.label==$l)' >/dev/null 2>&1; then
      gone=true
      break
    fi
    sleep 1
    tries=$((tries + 1))
  done
  check "closing the report collapses the empty window" "$gone" "true"
fi

echo "=== teardown ==="
quit_app
for f in "$STORE"/*.json; do
  if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
    FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
    case "$FP" in
      *note-n-pad-e2e*)
        rm -f "$f"
        echo "cleaned leftover: $f"
        ;;
    esac
  fi
done
rm -rf "$WORK"
rm -f "$SEEN"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
