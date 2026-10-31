#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: removed content kept on disk (spill files) for windowed editing.
# The debug build runs with NOTENPAD_SPILL_MIN lowered, so deleting a screenful
# of a small file spills like deleting a hundred megabytes would. Covers the
# spill file coming and going with the tab, undo and redo giving back the exact
# bytes, a click queued behind an undo being carried through the text the undo
# puts back, and an undo made far from the change jumping to it.
# Input methods: keys are keydown events dispatched at the editor, with Cmd on
# Darwin and Ctrl elsewhere as the modifier; the click is the pointer selection
# the editor's own hook sends (select.pointer), which joins the replay queue the
# way a real click does.
# LESSON: never put `await` inside an eval string; use `.then((r)=>{window.__x=r;})`.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. The trap restores the Select All setting, patching
# settings.json directly once the app is dead, and wipes this suite's own
# document snapshots (matched by the fixture path).
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/spill-fixture"
PASS=0
FAIL=0
# Bytes of removed content past which a removal spills (debug builds only).
SPILL_MIN=512
# Every line is 47 characters and a line break.
LINE_BYTES=48
N_LINES=20000
mkdir -p "$OUT"
: >"$OUT/dev-spill.log"

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
        *spill-fixture*)
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
boot_label() {
  auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1
}
evl() {
  auto "{\"id\":$(e2e_next_id),\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
launch() {
  e2e_require_clean_slate
  NOTENPAD_SPILL_MIN="$SPILL_MIN" NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-spill.log" 2>&1 &
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
  e2e_require_automation_listener "$OUT/dev-spill.log"
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
# Cmd on Darwin, Ctrl elsewhere (Git Bash on Windows included).
case "$(uname -s)" in
  Darwin) MODPROP="metaKey" ;;
  *) MODPROP="ctrlKey" ;;
esac
# The page-side helpers every step below calls as __t.*.
read -r -d '' HELPERS <<'JS'
window.__errs = [];
window.addEventListener('error', (e) => { window.__errs.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => { window.__errs.push(String(e.reason)); });
window.__t = (() => {
  const codes = { a: 65, b: 66, z: 90, Delete: 46 };
  const content = () => document.querySelector('.cm-content');
  const key = (k, mods) => {
    const e = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {}));
    Object.defineProperty(e, 'keyCode', { get: () => codes[k] || 0 });
    content().dispatchEvent(e);
    return e.defaultPrevented;
  };
  const mod = (k, extra) => key(k, Object.assign({ __MOD__: true }, extra || {}));
  const collapsed = () => {
    const g = __auto.windowedGlobalSel();
    return g !== null && g.anchor.line === g.head.line && g.anchor.col === g.head.col;
  };
  const inside = () => {
    const g = __auto.windowedGlobalSel();
    const w = __auto.windowedInfo();
    const n = __auto.getContent().split('\n').length;
    const within = (p) => p.line >= w.windowStartLine && p.line < w.windowStartLine + n;
    return g !== null && within(g.anchor) && within(g.head);
  };
  return { content, key, mod, collapsed, inside, focus: () => content().focus() };
})();
'ok'
JS
HELPERS="${HELPERS//__MOD__/$MODPROP}"
js_total() { echo "String(__auto.windowedInfo().totalBytes)"; }
js_errors() { echo "String(window.__errs.length)"; }
# The editor is idle: nothing queued and editable again.
js_idle() { echo "String(__auto.windowedReplayLength()===0 && document.querySelector('.cm-content').getAttribute('contenteditable')==='true')"; }
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
# Spill files in the app's temp folder.
sp_count() {
  local n=0 f
  for f in "$APPDIR"/windowed-tmp/sp-*.bin; do
    if [ -e "$f" ]; then
      n=$((n + 1))
    fi
  done
  echo "$n"
}
sp_count_is() {
  [ "$(sp_count)" = "$1" ]
}
save_active() {
  evl "$DL" "window.__wr=undefined" >/dev/null
  evl "$DL" "__auto.windowedSave().then((r)=>{window.__wr=r;})" >/dev/null
  e2e_wait_eval "$DL" "String(window.__wr!==undefined)" "true"
  check "save ok" "$(e2e_read "$DL" "String(window.__wr)")" "ok"
}
# Open $1 for windowed editing as tab number $2 (1-based) and give the editor
# focus.
open_windowed() {
  evl "$DL" "__auto.windowedOpen('$1').then((r)=>{window.__ow=r;})" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getTabs().length===$2 && __auto.getTabs()[$2-1].active && __auto.isWindowedTab() && __auto.getContent().startsWith('0000000001 ') && __auto.windowedInfo().windowStartLine===0)" "true"
  check "$1 opened without refusal" "$(e2e_read "$DL" "String(window.__ow===null)")" "true"
  evl "$DL" "__t.focus()" >/dev/null
  e2e_wait_eval "$DL" "String(document.activeElement===document.querySelector('.cm-content'))" "true"
}
# Close the active tab, back to the seed tab.
close_windowed() {
  evl "$DL" "__auto.closeActiveTab()" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getTabs().length)" "1"
}
# Go to line $1, select what is on screen and delete it: sets P (first byte),
# L (bytes) and SIZE (the file's size before) for the caller, and waits for the
# core to have it.
delete_screenful() {
  evl "$DL" "__auto.windowedGoto($1)" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.windowedInfo().windowStartLine <= $1 && $1 < __auto.windowedInfo().windowStartLine + __auto.getContent().split('\\n').length)" "true"
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_eval "$DL" "String(__t.inside() && !__t.collapsed())" "true"
  local sel a h
  sel=$(e2e_read "$DL" "JSON.stringify(__auto.windowedGlobalSel())")
  a=$(($(printf '%s' "$sel" | jq -r '.anchor.line') * LINE_BYTES + $(printf '%s' "$sel" | jq -r '.anchor.col')))
  h=$(($(printf '%s' "$sel" | jq -r '.head.line') * LINE_BYTES + $(printf '%s' "$sel" | jq -r '.head.col')))
  if [ "$a" -le "$h" ]; then
    P=$a
    L=$((h - a))
  else
    P=$h
    L=$((a - h))
  fi
  SIZE=$(e2e_read "$DL" "$(js_total)")
  FIRST_LINE=$(printf '%s' "$sel" | jq -r '[.anchor.line, .head.line] | min')
  echo "selected [$P, $((P + L))): $L bytes of $SIZE"
  evl "$DL" "__t.key('Delete')" >/dev/null
  e2e_wait_eval "$DL" "$(js_total)" "$((SIZE - L))"
  e2e_wait_until _e2e_eval_equals "$DL" "$(js_idle)" "true"
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
# base.log: 20,000 lines of 47 characters ('0000000001 ' and 36 'x') and a line
# break each: 960,000 bytes. Each item below edits a copy of its own.
python3 - <<PYEOF
n = $N_LINES
with open('$WORK/base.log', 'w', newline='') as f:
    for i in range(1, n + 1):
        f.write(f'{i:010d} ' + 'x' * 36 + '\n')
PYEOF
echo "base.log bytes: $(file_size "$WORK/base.log")"
check "base.log is $((N_LINES * LINE_BYTES)) bytes" "$(file_size "$WORK/base.log")" "$((N_LINES * LINE_BYTES))"
for n in 1 2 3; do
  cp "$WORK/base.log" "$WORK/doc$n.log"
done
printf 'seed\n' >"$WORK/seed.txt"

restore_state() {
  trap '' INT TERM
  local dl
  dl=$(doc_label 2>/dev/null)
  if [ -n "$dl" ] && [ -n "${ORIG_SELECT:-}" ]; then
    evl "$dl" "__auto.setLargeSelectAll('$ORIG_SELECT')" >/dev/null 2>&1
  fi
  quit_app
  # Fallback: the app is dead now, so patch settings.json directly in case the
  # app-side restore above never reached a live automation port.
  if [ -f "$APPDIR/settings.json" ] && [ -n "${ORIG_SELECT:-}" ]; then
    jq --arg v "$ORIG_SELECT" '.large_select_all = $v' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
      && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
  fi
  wipe_test_docs
  e2e_kill_owned_ports
}
trap restore_state EXIT
trap 'exit 1' INT TERM
launch
BOOT=$(boot_label)
evl "$BOOT" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/seed.txt'})" >/dev/null
e2e_wait_until doc_label_ready
DL=$(doc_label)
if [ -z "$DL" ]; then
  echo "FATAL: no document window appeared"
  exit 1
fi
e2e_wait_eval "$DL" "String(typeof __auto!=='undefined' && typeof __auto.windowedOpen==='function' && __auto.getTabs().length===1)" "true"
# The setting is the user's real one: capture it for the trap to restore.
ORIG_SELECT=$(e2e_read "$DL" "String(__auto.largeSelectAllMode())")
echo "original large_select_all: $ORIG_SELECT"
evl "$DL" "__auto.setLargeSelectAll('visible')" >/dev/null
e2e_wait_setting large_select_all "visible"
# Xvfb has no window manager, so the window must be given focus or CodeMirror ignores DOM selections.
auto "{\"id\":2,\"cmd\":\"focus\",\"label\":\"$DL\"}" >/dev/null
sleep 1
check "setup: the window has OS focus" "$(e2e_read "$DL" "String(document.hasFocus())")" "true"
check "setup: no spill file before the first removal" "$(sp_count)" "0"
evl "$DL" "$HELPERS" >/dev/null
check "helpers installed" "$(e2e_read "$DL" "typeof __t")" "object"

echo "=== 1. a removal past the threshold spills; undo and redo give back the exact bytes ==="
SHA_BEFORE=$(file_sha256 "$WORK/doc1.log")
open_windowed "$WORK/doc1.log" 2
delete_screenful 500
check "the screenful is more than the threshold" "$([ "$L" -gt "$SPILL_MIN" ] && echo yes || echo no)" "yes"
e2e_wait_until sp_count_is 1
check "the deletion left one spill file" "$(sp_count)" "1"
save_active
SHA_DELETED=$(file_sha256 "$WORK/doc1.log")
check "the deletion shortened the file by the selection" "$(file_size "$WORK/doc1.log")" "$((SIZE - L))"
check "the spill file outlives the save" "$(sp_count)" "1"
evl "$DL" "__auto.windowedUndo()" >/dev/null
e2e_wait_eval "$DL" "$(js_total)" "$SIZE"
e2e_wait_until _e2e_eval_equals "$DL" "$(js_idle)" "true"
save_active
check "undo gives back the bytes (sha256 of the saved file)" "$(file_sha256 "$WORK/doc1.log")" "$SHA_BEFORE"
check "the undo put the spill back into the document and the save dropped the file" "$(sp_count)" "0"
evl "$DL" "__auto.windowedRedo()" >/dev/null
e2e_wait_eval "$DL" "$(js_total)" "$((SIZE - L))"
e2e_wait_until _e2e_eval_equals "$DL" "$(js_idle)" "true"
save_active
check "redo gives the deleted bytes again (sha256 of the saved file)" "$(file_sha256 "$WORK/doc1.log")" "$SHA_DELETED"
check "the redo made the spill file again" "$(sp_count)" "1"
check "no exception thrown" "$(e2e_read "$DL" "$(js_errors)")" "0"
close_windowed
e2e_wait_until sp_count_is 0
check "closing the tab removed the spill file" "$(sp_count)" "0"

echo "=== 2. a click queued behind an undo is carried through the text the undo puts back ==="
cp "$WORK/doc2.log" "$WORK/doc2.orig"
open_windowed "$WORK/doc2.log" 2
delete_screenful 500
e2e_wait_until sp_count_is 1
# C: a byte of the file after the deletion, five lines and a few columns past
# the deletion's start, inside the loaded window.
C=$((P + 5 * LINE_BYTES + 7))
echo "click at byte $C of the file after the deletion"
# One synchronous turn: the undo takes its hold, a is queued behind it as text,
# the click joins the queue at its place, and b is queued behind the click.
QUEUED=$(e2e_read "$DL" "(()=>{__t.mod('z');__t.key('a');const ok=__auto.windowedPointerSelect($C);__t.key('b');return String(ok)+':'+String(__auto.windowedReplayLength());})()")
check "the click was made and the queue holds a, the click and b" "$QUEUED" "true:3"
e2e_wait_until _e2e_eval_equals "$DL" "$(js_idle)" "true"
sleep 2
check "the file grew by the two letters" "$(e2e_read "$DL" "$(js_total)")" "$((SIZE + 2))"
save_active
cat >"$WORK/check2.py" <<'PYEOF'
import sys

orig = open(sys.argv[1], 'rb').read()
new = open(sys.argv[2], 'rb').read()
c = int(sys.argv[3])
l = int(sys.argv[4])
p = int(sys.argv[5])
at = c + l + 1
# Where the first differing byte is: the a, typed at the caret the undo left.
k = next((i for i in range(min(len(orig), len(new))) if orig[i] != new[i]), len(orig))
expect = orig[:k] + b'a' + orig[k:]
expect = expect[:at] + b'b' + expect[at:]
# Without the b at at and the a at k, the file must be the original.
rest = new[:at] + new[at + 1:] if new[at:at + 1] == b'b' else b''
rest = rest[:k] + rest[k + 1:] if rest[k:k + 1] == b'a' else b''
print('length', 'true' if len(new) == len(orig) + 2 else 'false')
print('b', 'true' if len(new) > at and new[at:at + 1] == b'b' else 'false')
print('a', 'true' if rest == orig and p <= k <= p + l else 'false')
print('whole', 'true' if new == expect else 'false')
PYEOF
RESULT=$(python3 "$WORK/check2.py" "$WORK/doc2.orig" "$WORK/doc2.log" "$C" "$L" "$P")
check "the saved file is $((SIZE + 2)) bytes" "$(printf '%s\n' "$RESULT" | awk '$1=="length"{print $2}')" "true"
check "the byte at C + L + 1 is b (the click moved with the put-back text)" "$(printf '%s\n' "$RESULT" | awk '$1=="b"{print $2}')" "true"
check "removing a and b leaves the original, and a lies within the span the undo put back" "$(printf '%s\n' "$RESULT" | awk '$1=="a"{print $2}')" "true"
check "the saved file is the original with a and b added, nothing else" "$(printf '%s\n' "$RESULT" | awk '$1=="whole"{print $2}')" "true"
check "no exception thrown" "$(e2e_read "$DL" "$(js_errors)")" "0"
close_windowed
e2e_wait_until sp_count_is 0
check "closing the tab removed the spill file" "$(sp_count)" "0"

echo "=== 3. an undo made far from the change jumps to it ==="
open_windowed "$WORK/doc3.log" 2
delete_screenful 500
e2e_wait_until sp_count_is 1
evl "$DL" "__auto.windowedGoto(15000)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.windowedInfo().windowStartLine > 5000)" "true"
check "the window is far from the change" "$(e2e_read "$DL" "String(__auto.windowedInfo().windowStartLine > $((FIRST_LINE + 2000)))")" "true"
evl "$DL" "__auto.windowedUndo()" >/dev/null
e2e_wait_eval "$DL" "$(js_total)" "$SIZE"
e2e_wait_until _e2e_eval_equals "$DL" "$(js_idle)" "true"
check "the window now covers the line of the change" "$(e2e_read "$DL" "String(__auto.windowedInfo().windowStartLine <= $FIRST_LINE && $FIRST_LINE < __auto.windowedInfo().windowStartLine + __auto.getContent().split('\\n').length)")" "true"
check "no exception thrown" "$(e2e_read "$DL" "$(js_errors)")" "0"
save_active
close_windowed
e2e_wait_until sp_count_is 0
check "closing the tab removed the spill file" "$(sp_count)" "0"

echo "=== teardown ==="
evl "$DL" "__auto.setLargeSelectAll('$ORIG_SELECT')" >/dev/null
e2e_wait_setting large_select_all "$ORIG_SELECT"
quit_app
wipe_test_docs
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
