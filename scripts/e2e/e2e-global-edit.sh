#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: global edits of a selection larger than one window (large_select_all =
# 'file'). Delete, typing, paste, Enter, Tab and Shift+Tab over the whole of a
# 110 MB file; the selection keys against CodeMirror in a small ordinary tab;
# the delete keys; input methods (the editor and the find bar) with the
# synthetic composition hook, also while the operation or the window swap is
# held; undo, redo and replace all following the selection; lone CR lines; the
# order of keys that were queued before an operation.
# Input methods: keys are keydown events dispatched at the editor
# (__auto.windowedPressKey), with Cmd on Darwin and Ctrl elsewhere as the
# modifier and the platform's own keys for the rest. Keys only move the
# selection and run commands: a synthetic keydown types nothing where the
# selection is inside the window, so text goes in through
# document.execCommand('insertText' ...) there, and through keydown events only
# over a selection larger than a window, which the replay types. A composition
# is __auto.windowedCompose (it never sets view.composing, a real input method is
# checked by hand). The paste is a synthetic event carrying a DataTransfer; where
# there are clips (macOS, Windows) the core asks the system clipboard what it
# holds, so the text is put there first (e2e_paste_os).
# Every read of /proc for VmRSS runs on Linux only and prints a SKIP elsewhere.
# LESSON: never put `await` inside an eval string; use `.then((r)=>{window.__x=r;})`
# and end a fire-and-forget eval with `;1` so it does not wait for the promise.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. The trap restores the language and the Select All
# setting, patching settings.json directly once the app is dead, and wipes this
# suite's own document snapshots (matched by the fixture path).
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/global-edit-fixture"
PASS=0
FAIL=0
# 20,000 lines of 47 characters and a line break each (the last has none).
N_LINES=20000
LINE_BYTES=48
BASE_SIZE=$((N_LINES * LINE_BYTES - 1))
END_LINE=$((N_LINES - 1))
END_COL=47
# The big file: 2,400,000 such lines.
BIG_LINES=2400000
BIG_SIZE=$((BIG_LINES * LINE_BYTES - 1))
# The most a main process's resident set may grow during one step over the big file.
RSS_LIMIT_KB=65536
mkdir -p "$OUT"
: >"$OUT/dev-global-edit.log"
DIAG_LOG="$OUT/dev-diag-global-edit.log"
: >"$DIAG_LOG"

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
    bad "$1 (got: [$(e2e_show "$2")], want: [$(e2e_show "$3")])"
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
        *global-edit-fixture*)
          rm -f "$f"
          ;;
      esac
    fi
  done
}

cd "$REPO" || exit 1
source "$HOME/.cargo/env" 2>/dev/null

auto() {
  node scripts/auto.mjs "$1" </dev/null
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
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-global-edit.log" 2>&1 &
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
  e2e_require_automation_listener "$OUT/dev-global-edit.log"
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
  const content = () => {
    const all = [...document.querySelectorAll('.cm-content')];
    return all.find((el) => el.getClientRects().length > 0) || all[0];
  };
  const press = (k, mods) => __auto.windowedPressKey(k, mods || {});
  const mod = (k, extra) => press(k, Object.assign({ __MOD__: true }, extra || {}));
  const clip = (type, text) => {
    const dt = new DataTransfer();
    if (text !== undefined) { dt.setData('text/plain', text); }
    const e = new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(e);
    return JSON.stringify({ prevented: e.defaultPrevented, types: dt.types.length });
  };
  const isAll = (line, col) => {
    const g = __auto.windowedGlobalSel();
    return g !== null && g.anchor.line === 0 && g.anchor.col === 0 && g.head.line === line && g.head.col === col;
  };
  const collapsed = () => {
    const g = __auto.windowedGlobalSel();
    return g !== null && g.anchor.line === g.head.line && g.anchor.col === g.head.col;
  };
  const editable = () => content().getAttribute('contenteditable') === 'true';
  return { content, press, mod, clip, isAll, collapsed, editable, focus: () => content().focus() };
})();
'ok'
JS
HELPERS="${HELPERS//__MOD__/$MODPROP}"
js_total() { echo "String(__auto.windowedInfo().totalBytes)"; }
js_errors() { echo "String(window.__errs.length)"; }
js_settled() { echo "String(__auto.windowedGlobalInfo().settled)"; }
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
# Wait for no swap and an empty queue, then a moment for what a settled editor
# may still start.
settle() {
  if ! e2e_wait_until "${1:-300}" _e2e_eval_equals "$DL" "$(js_settled)" "true"; then
    bad "settle: the editor did not settle in ${1:-300} s"
  fi
  sleep 1
}
# Press a key at the editor: $1 the key name, $2 the modifiers as a JS object.
press() {
  local mods="${2-}"
  if [ -z "$mods" ]; then
    mods='{}'
  fi
  evl "$DL" "__t.press('$1',$mods)" >/dev/null
}
# Press a key with the platform's modifier, $2 more modifiers.
press_mod() {
  local mods="${2-}"
  if [ -z "$mods" ]; then
    mods='{}'
  fi
  evl "$DL" "__t.mod('$1',$mods)" >/dev/null
}
select_all() {
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  if ! e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($END_LINE,$END_COL))" "true"; then
    bad "select_all: the selection never became the whole file"
  fi
}
total() {
  e2e_read "$DL" "$(js_total)"
}
gsel() {
  e2e_read "$DL" "JSON.stringify(__auto.windowedGlobalSel())"
}
ginfo() {
  e2e_read "$DL" "String(__auto.windowedGlobalInfo().$1)"
}
save_active() {
  evl "$DL" "window.__wr=undefined" >/dev/null
  evl "$DL" "__auto.windowedSave().then((r)=>{window.__wr=r;});1" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(window.__wr!==undefined)" "true"
  check "save ok" "$(e2e_read "$DL" "String(window.__wr)")" "ok"
}
# Undo through the editor's own hook and wait for the bytes it gives back.
undo_to() {
  evl "$DL" "__auto.windowedUndo()" >/dev/null
  settle 600
  e2e_wait_until 600 _e2e_eval_equals "$DL" "$(js_total)" "$1"
}
NEXT=0
DOC=""
# A copy of the base file nothing else uses; sets DOC.
fresh_doc() {
  NEXT=$((NEXT + 1))
  DOC="$WORK/doc$NEXT.log"
  cp "$WORK/base.log" "$DOC"
}
# Open $1 for windowed editing as tab number $2 (1-based) and give the editor
# focus.
open_windowed() {
  evl "$DL" "__auto.windowedOpen('$1').then((r)=>{window.__ow=r;});1" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getTabs().length===$2 && __auto.getTabs()[$2-1].active && __auto.isWindowedTab() && __auto.windowedInfo().windowStartLine===0)" "true"
  check "$1 opened without refusal" "$(e2e_read "$DL" "String(window.__ow===null)")" "true"
  evl "$DL" "__t.focus()" >/dev/null
  e2e_wait_eval "$DL" "String(document.activeElement===__t.content())" "true"
}
# Save, then close the active tab, back to the seed tab.
close_windowed() {
  save_active
  evl "$DL" "__auto.closeActiveTab()" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getTabs().length)" "1"
}
# One scenario's fresh file, opened as tab 2.
begin_doc() {
  fresh_doc
  open_windowed "$DOC" 2
}
# Resident set of the main process: the peak since rss_begin may not exceed the
# limit above the start. Linux only.
RSS_ON=0
RSS_PID=""
RSS_BEFORE=0
rss_begin() {
  RSS_ON=0
  if [ "$(uname -s)" = "Linux" ]; then
    RSS_PID=$(pgrep -x note-n-pad | head -1)
    if [ -n "$RSS_PID" ]; then
      echo 5 >"/proc/$RSS_PID/clear_refs"
      RSS_BEFORE=$(awk '/^VmRSS:/ {print $2}' "/proc/$RSS_PID/status")
      RSS_ON=1
    fi
  fi
}
rss_check() {
  if [ "$RSS_ON" = "1" ]; then
    local hwm growth
    hwm=$(awk '/^VmHWM:/ {print $2}' "/proc/$RSS_PID/status")
    growth=$((hwm - RSS_BEFORE))
    echo "RSS before: ${RSS_BEFORE} kB, peak after: ${hwm} kB, growth: ${growth} kB"
    if [ "$growth" -le "$RSS_LIMIT_KB" ]; then
      ok "$1: the peak grew by at most $((RSS_LIMIT_KB / 1024)) MB"
    else
      bad "$1: the peak grew by ${growth} kB (more than $((RSS_LIMIT_KB / 1024)) MB)"
    fi
  else
    echo "SKIP: VmRSS of $1 (Linux only; measured by hand on the other platforms)"
  fi
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
# Every line is '0000000001 ' and 36 'x' (47 characters) and an LF, the last line
# without one. base.log has 20,000 lines, big.log 2,400,000 (about 110 MB),
# small.log the first 4,000 of them (the ordinary tab the selection keys are
# compared with). cr.log has 3,000 lines of which every fifth ends in a lone CR.
python3 - <<PYEOF
def write(path, n, tail_newline=False):
    with open(path, 'w', newline='') as f:
        buf = []
        first = True
        for i in range(1, n + 1):
            buf.append(f'{i:010d} ' + 'x' * 36)
            if len(buf) == 20000 or i == n:
                if not first:
                    f.write('\n')
                f.write('\n'.join(buf))
                first = False
                buf = []
write('$WORK/base.log', $N_LINES)
write('$WORK/big.log', $BIG_LINES)
write('$WORK/small.log', 4000)
with open('$WORK/cr.log', 'w', newline='') as f:
    for i in range(1, 3001):
        f.write(f'cr{i:05d} ' + 'y' * 20)
        if i < 3000:
            f.write('\r' if i % 5 == 2 else '\n')
PYEOF
echo "base.log bytes: $(file_size "$WORK/base.log")"
check "base.log has the size of $N_LINES lines" "$(file_size "$WORK/base.log")" "$BASE_SIZE"
check "big.log has the size of $BIG_LINES lines" "$(file_size "$WORK/big.log")" "$BIG_SIZE"
BIG_SHA=$(file_sha256 "$WORK/big.log")
printf 'seed\n' >"$WORK/seed.txt"
# What the file checks below read: modes of one script.
cat >"$WORK/chk.py" <<'PYEOF'
import re
import sys


def line(i):
    return f'{i:010d} ' + 'x' * 36


mode = sys.argv[1]
if mode == 'lines':
    # lines FILE N DEPTH: every line carries DEPTH more indentation levels (two
    # spaces each) and nothing else changed.
    path, n, depth = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    pad = ' ' * (2 * depth)
    ok = True
    count = 0
    with open(path, 'rb') as f:
        for i, got in enumerate(f, 1):
            want = (pad + line(i) + ('\n' if i < n else '')).encode()
            count = i
            if got != want:
                ok = False
                break
    print('true' if ok and count == n else 'false')
elif mode == 'click':
    # click FILE N LINE COL: every line indented by two spaces, and a Q typed at
    # column COL of LINE (counted in the line before it was indented).
    path, n, at, col = sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    ok = True
    count = 0
    with open(path, 'rb') as f:
        for i, got in enumerate(f, 1):
            text = line(i)
            if i - 1 == at:
                text = text[:col] + 'Q' + text[col:]
            want = ('  ' + text + ('\n' if i < n else '')).encode()
            count = i
            if got != want:
                ok = False
                break
    print('true' if ok and count == n else 'false')
elif mode == 'append':
    # append FILE BASE SUFFIX: FILE is BASE with SUFFIX added at its end.
    new = open(sys.argv[2], 'rb').read()
    base = open(sys.argv[3], 'rb').read()
    print('true' if new == base + sys.argv[4].encode() else 'false')
elif mode == 'tail':
    # tail ORIG NEW LINE COL: NEW is what ORIG holds from (LINE, COL) on, the
    # lines split at CR, LF and CRLF as CodeMirror splits them.
    orig = open(sys.argv[2], 'rb').read().decode()
    new = open(sys.argv[3], 'rb').read().decode()
    at, col = int(sys.argv[4]), int(sys.argv[5])
    starts = [0] + [m.end() for m in re.finditer(r'\r\n|\r|\n', orig)]
    print('true' if new == orig[starts[at] + col:] else 'false')
PYEOF

restore_state() {
  trap '' INT TERM
  local dl
  dl=$(doc_label 2>/dev/null)
  if [ -n "$dl" ]; then
    if [ -n "${ORIG_LANG:-}" ]; then
      evl "$dl" "__auto.setLanguage('$ORIG_LANG')" >/dev/null 2>&1
    fi
    if [ -n "${ORIG_SELECT:-}" ]; then
      evl "$dl" "__auto.setLargeSelectAll('$ORIG_SELECT')" >/dev/null 2>&1
    fi
  fi
  quit_app
  # Fallback: the app is dead now, so patch settings.json directly in case the
  # app-side restore above never reached a live automation port.
  if [ -f "$APPDIR/settings.json" ]; then
    if [ -n "${ORIG_LANG:-}" ]; then
      jq --arg v "$ORIG_LANG" '.language = $v' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
        && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
    fi
    if [ -n "${ORIG_SELECT:-}" ]; then
      jq --arg v "$ORIG_SELECT" '.large_select_all = $v' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
        && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
    fi
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
# The settings are the user's real ones: capture them for the trap to restore.
ORIG_LANG=$(e2e_read "$DL" "String(__auto.getLanguage())")
ORIG_SELECT=$(e2e_read "$DL" "String(__auto.largeSelectAllMode())")
echo "original language: $ORIG_LANG, large_select_all: $ORIG_SELECT"
evl "$DL" "__auto.setLanguage('en')" >/dev/null
evl "$DL" "__auto.setLargeSelectAll('file')" >/dev/null
e2e_wait_setting large_select_all "file"
# Xvfb has no window manager, so the window must be given focus or CodeMirror ignores DOM selections.
auto "{\"id\":2,\"cmd\":\"focus\",\"label\":\"$DL\"}" >/dev/null
sleep 1
check "setup: the window has OS focus" "$(e2e_read "$DL" "String(document.hasFocus())")" "true"
evl "$DL" "$HELPERS" >/dev/null
check "helpers installed" "$(e2e_read "$DL" "typeof __t")" "object"

echo "=== 1. the whole of a 110 MB file: delete, type, Tab, Shift+Tab, paste, Enter ==="
# The tab ends in the fixture's selection of the whole file at the end of the
# line count, which the Select All below needs: END_LINE and END_COL of the big file.
BIG_END_LINE=$((BIG_LINES - 1))
open_windowed "$WORK/big.log" 2
big_select_all() {
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  if ! e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($BIG_END_LINE,$END_COL))" "true"; then
    bad "big_select_all: the selection never became the whole file"
  fi
}
check "the big file has the lines" "$(e2e_read "$DL" "String(__auto.windowedInfo().totalLines)")" "$BIG_LINES"

echo "--- delete, then undo ---"
big_select_all
rss_begin
press Delete
settle 600
e2e_wait_until 600 _e2e_eval_equals "$DL" "$(js_total)" "0"
rss_check "delete"
save_active
check "the saved file is empty" "$(file_size "$WORK/big.log")" "0"
rss_begin
undo_to "$BIG_SIZE"
rss_check "undo of the delete"
save_active
check "one undo gives the original back" "$(file_sha256 "$WORK/big.log")" "$BIG_SHA"

echo "--- typing replaces the selection, one undo gives it back ---"
big_select_all
rss_begin
evl "$DL" "document.execCommand('insertText',false,'Z')" >/dev/null
settle 600
e2e_wait_until 600 _e2e_eval_equals "$DL" "$(js_total)" "1"
rss_check "typing over the file"
save_active
check "the saved file is the typed character" "$(file_size "$WORK/big.log")" "1"
check "the saved file holds Z" "$(cat "$WORK/big.log")" "Z"
undo_to "$BIG_SIZE"
save_active
check "a single undo gives the original back" "$(file_sha256 "$WORK/big.log")" "$BIG_SHA"

echo "--- Tab twice, Shift+Tab, then undo ---"
big_select_all
rss_begin
press Tab
settle 600
e2e_wait_until 600 _e2e_eval_equals "$DL" "$(js_total)" "$((BIG_SIZE + 2 * BIG_LINES))"
rss_check "Tab"
save_active
check "every line has one more level" "$(python3 "$WORK/chk.py" lines "$WORK/big.log" "$BIG_LINES" 1)" "true"
# Both ends map with mapPos(..., 1): the anchor at (0, 0) lands after the new
# indentation of line 0, the head moves with its line's two spaces.
check "the selection is the file from after the first indentation to the end" "$(gsel)" "{\"anchor\":{\"line\":0,\"col\":2},\"head\":{\"line\":$BIG_END_LINE,\"col\":$((END_COL + 2))}}"
rss_begin
press Tab
settle 600
e2e_wait_until 600 _e2e_eval_equals "$DL" "$(js_total)" "$((BIG_SIZE + 4 * BIG_LINES))"
rss_check "the second Tab"
save_active
check "every line has two more levels" "$(python3 "$WORK/chk.py" lines "$WORK/big.log" "$BIG_LINES" 2)" "true"
rss_begin
press Tab '{shiftKey:true}'
settle 600
e2e_wait_until 600 _e2e_eval_equals "$DL" "$(js_total)" "$((BIG_SIZE + 2 * BIG_LINES))"
rss_check "Shift+Tab"
save_active
check "Shift+Tab takes one level back" "$(python3 "$WORK/chk.py" lines "$WORK/big.log" "$BIG_LINES" 1)" "true"
undo_to "$((BIG_SIZE + 4 * BIG_LINES))"
undo_to "$((BIG_SIZE + 2 * BIG_LINES))"
undo_to "$BIG_SIZE"
save_active
check "three undos give the file from before the indentation" "$(file_sha256 "$WORK/big.log")" "$BIG_SHA"

echo "--- a multi-line paste ---"
big_select_all
# Where there are clips the core reads the system clipboard, not the event.
e2e_paste_os "$(printf 'one\r\ntwo\nthree')"
rss_begin
evl "$DL" "__t.clip('paste','one\\r\\ntwo\\nthree')" >/dev/null
settle 600
e2e_wait_until 600 _e2e_eval_equals "$DL" "$(js_total)" "13"
rss_check "paste"
save_active
check "the file holds the pasted text with the file's breaks" "$(cat "$WORK/big.log")" "$(printf 'one\ntwo\nthree')"
check "the pasted text has LF breaks only" "$(file_size "$WORK/big.log")" "13"
undo_to "$BIG_SIZE"
save_active
check "undo of the paste gives the original back" "$(file_sha256 "$WORK/big.log")" "$BIG_SHA"

echo "--- Enter ---"
big_select_all
rss_begin
press Enter
settle 600
e2e_wait_until 600 _e2e_eval_equals "$DL" "$(js_total)" "1"
rss_check "Enter"
save_active
check "the file is one line break: byte 0 takes no indentation" "$(file_sha256 "$WORK/big.log")" "$(printf '\n' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"
undo_to "$BIG_SIZE"
save_active
check "undo of Enter gives the original back" "$(file_sha256 "$WORK/big.log")" "$BIG_SHA"
check "no exception thrown" "$(e2e_read "$DL" "$(js_errors)")" "0"
close_windowed
rm -f "$WORK/big.log"

echo "=== 2. the find bar takes Enter, typing and a composition; the file stays ==="
begin_doc
select_all
S2_SIZE=$(total)
S2_OPS=$(ginfo globalOps)
evl "$DL" "__auto.openFind()" >/dev/null
e2e_wait_eval "$DL" "String(document.activeElement===document.querySelector('.search-panel input.cm-textfield'))" "true"
evl "$DL" "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true,cancelable:true}))" >/dev/null
evl "$DL" "document.execCommand('insertText',false,'abc')" >/dev/null
check "the text went to the find bar" "$(e2e_read "$DL" "document.querySelector('.search-panel input.cm-textfield').value")" "abc"
evl "$DL" "__auto.windowedCompose({target:'find',updates:[],endData:'xyz'}).then(()=>{window.__fc=1;});1" >/dev/null
e2e_wait_eval "$DL" "String(window.__fc===1)" "true"
sleep 2
check "the file is the same size" "$(total)" "$S2_SIZE"
check "the file is not changed" "$(e2e_read "$DL" "String(__auto.windowedInfo().dirty)")" "false"
check "no global command was sent" "$(ginfo globalOps)" "$S2_OPS"
check "the selection is still the file" "$(e2e_read "$DL" "String(__t.isAll($END_LINE,$END_COL))")" "true"
check "nothing is queued" "$(e2e_read "$DL" "String(__auto.windowedReplayLength())")" "0"
evl "$DL" "__auto.closeFind()" >/dev/null
close_windowed

echo "=== 3. End with the head at the end of the line, then x ==="
begin_doc
select_all
press End
settle
check "the selection is a caret at the end of the file" "$(gsel)" "{\"anchor\":{\"line\":$END_LINE,\"col\":$END_COL},\"head\":{\"line\":$END_LINE,\"col\":$END_COL}}"
evl "$DL" "__t.focus();document.execCommand('insertText',false,'x')" >/dev/null
settle
close_windowed
check "x follows the end of the file, the rest is as it was" "$(python3 "$WORK/chk.py" append "$DOC" "$WORK/base.log" x)" "true"

echo "=== 3b. text that came with no keydown replaces a whole-file selection ==="
# execCommand('insertText') reaches the editor as a DOM change with no keydown:
# the filter queues it for the replay, which deletes the selection first.
begin_doc
select_all
evl "$DL" "__t.focus();document.execCommand('insertText',false,'Q')" >/dev/null
settle
e2e_wait_until 60 _e2e_eval_equals "$DL" "$(js_total)" "1"
close_windowed
check "the file holds the typed text and nothing else" "$(cat "$DOC")" "Q"
check "no exception thrown" "$(e2e_read "$DL" "$(js_errors)")" "0"

echo "=== 4. the selection keys, against CodeMirror in a small ordinary tab ==="
# The same keys on the same selection (set from the start of the file, or from
# its end) in a 4,000 line ordinary tab, where CodeMirror alone acts, and in the
# windowed tab, where the selection is larger than a window. The ends are
# compared as lines from the start (S) or from the end of the file (E), since
# the two files have different lengths.
SMALL_END_LINE=3999
norm_sel() {
  # $1 the selection as JSON, $2 the last line of its file.
  printf '%s' "$1" | jq -r --argjson e "$2" 'def n: if .line < 1500 then "S\(.line):\(.col)" else "E\(.line - $e):\(.col)" end; "\(.anchor | n) \(.head | n)"'
}
# The rows: id|key|modifiers (a JS object).
key_rows() {
  cat <<EOF
left|ArrowLeft|{}
right|ArrowRight|{}
up|ArrowUp|{}
down|ArrowDown|{}
sleft|ArrowLeft|{shiftKey:true}
sright|ArrowRight|{shiftKey:true}
sup|ArrowUp|{shiftKey:true}
sdown|ArrowDown|{shiftKey:true}
home|Home|{}
end|End|{}
shome|Home|{shiftKey:true}
send|End|{shiftKey:true}
pageup|PageUp|{}
pagedown|PageDown|{}
spageup|PageUp|{shiftKey:true}
spagedown|PageDown|{shiftKey:true}
escape|Escape|{}
EOF
  case "$(uname -s)" in
    Darwin)
      cat <<EOF
wleft|ArrowLeft|{altKey:true}
wright|ArrowRight|{altKey:true}
swleft|ArrowLeft|{altKey:true,shiftKey:true}
swright|ArrowRight|{altKey:true,shiftKey:true}
lbleft|ArrowLeft|{metaKey:true}
lbright|ArrowRight|{metaKey:true}
slbleft|ArrowLeft|{metaKey:true,shiftKey:true}
slbright|ArrowRight|{metaKey:true,shiftKey:true}
docup|ArrowUp|{metaKey:true}
docdown|ArrowDown|{metaKey:true}
sdocup|ArrowUp|{metaKey:true,shiftKey:true}
sdocdown|ArrowDown|{metaKey:true,shiftKey:true}
emacs-b|b|{ctrlKey:true}
emacs-f|f|{ctrlKey:true}
emacs-p|p|{ctrlKey:true}
emacs-n|n|{ctrlKey:true}
emacs-a|a|{ctrlKey:true}
emacs-e|e|{ctrlKey:true}
emacs-v|v|{ctrlKey:true}
selectline|l|{ctrlKey:true}
EOF
      ;;
    *)
      cat <<EOF
wleft|ArrowLeft|{ctrlKey:true}
wright|ArrowRight|{ctrlKey:true}
swleft|ArrowLeft|{ctrlKey:true,shiftKey:true}
swright|ArrowRight|{ctrlKey:true,shiftKey:true}
docstart|Home|{ctrlKey:true}
docend|End|{ctrlKey:true}
sdocstart|Home|{ctrlKey:true,shiftKey:true}
sdocend|End|{ctrlKey:true,shiftKey:true}
selectline|l|{altKey:true}
EOF
      ;;
  esac
}
# The two ways to have a selection to start from, as the ends in the small
# file (offsets) and as the keys that make it in the windowed file:
#   a: from the start of the file to the start of the last line but one
#      (Select All, Shift+Up twice)
#   b: from the end of the file back to the start of the second line (Select
#      All, Right, Shift+document start, Shift+Down)
SMALL_A_FROM=0
SMALL_A_TO=$(((SMALL_END_LINE - 2) * LINE_BYTES + END_COL))
SMALL_B_FROM=$((SMALL_END_LINE * LINE_BYTES + END_COL))
SMALL_B_TO=$((1 * LINE_BYTES))
# Select All and the keys of a start $1 (a or b) in the windowed tab.
if [ "$(uname -s)" = "Darwin" ]; then
  DOC_START_KEY="ArrowUp"
  DOC_START_MODS="{metaKey:true,shiftKey:true}"
else
  DOC_START_KEY="Home"
  DOC_START_MODS="{ctrlKey:true,shiftKey:true}"
fi
windowed_start() {
  select_all
  if [ "$1" = "a" ]; then
    press ArrowUp '{shiftKey:true}'
    settle
    press ArrowUp '{shiftKey:true}'
    settle
  else
    press ArrowRight
    settle
    press "$DOC_START_KEY" "$DOC_START_MODS"
    settle
    press ArrowDown '{shiftKey:true}'
    settle
  fi
}
begin_doc
WIN_TAB=2
evl "$DL" "__auto.openTab('$WORK/small.log')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length===3 && __auto.getTabs()[2].active && !__auto.isWindowedTab() && __auto.getContent().length>100000)" "true"
SMALL_TAB=3
echo "--- reference: CodeMirror in the ordinary tab ---"
: >"$WORK/ref.txt"
for start in a b; do
  if [ "$start" = "a" ]; then
    FROM=$SMALL_A_FROM
    TO=$SMALL_A_TO
  else
    FROM=$SMALL_B_FROM
    TO=$SMALL_B_TO
  fi
  while IFS='|' read -r id key mods; do
    evl "$DL" "__auto.setDocSelection($FROM,$TO);1" >/dev/null
    sleep 0.3
    press "$key" "$mods"
    sleep 0.7
    printf '%s|%s|%s\n' "$start" "$id" "$(norm_sel "$(e2e_read "$DL" "JSON.stringify(__auto.getDocSelection())")" "$SMALL_END_LINE")" >>"$WORK/ref.txt"
  done < <(key_rows)
  evl "$DL" "__auto.setDocSelection($FROM,$TO);1" >/dev/null
  printf '%s|start|%s\n' "$start" "$(norm_sel "$(e2e_read "$DL" "JSON.stringify(__auto.getDocSelection())")" "$SMALL_END_LINE")" >>"$WORK/ref.txt"
done
echo "reference rows: $(wc -l <"$WORK/ref.txt" | tr -d ' ')"
evl "$DL" "__auto.switchTab($((WIN_TAB - 1)))" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs()[$((WIN_TAB - 1))].active && __auto.isWindowedTab())" "true"
evl "$DL" "__t.focus()" >/dev/null
echo "--- the windowed tab ---"
for start in a b; do
  windowed_start "$start"
  got=$(norm_sel "$(gsel)" "$END_LINE")
  want=$(grep "^$start|start|" "$WORK/ref.txt" | cut -d'|' -f3)
  check "start $start: the selection is the same before any key" "$got" "$want"
  while IFS='|' read -r id key mods; do
    windowed_start "$start"
    press "$key" "$mods"
    settle
    got=$(norm_sel "$(gsel)" "$END_LINE")
    want=$(grep "^$start|$id|" "$WORK/ref.txt" | cut -d'|' -f3)
    check "start $start, $id: the same as CodeMirror" "$got" "$want"
  done < <(key_rows)
done
check "no exception thrown" "$(e2e_read "$DL" "$(js_errors)")" "0"

echo "--- Select Line after Shift+Down from column 0, and after Select All ---"
case "$(uname -s)" in
  Darwin)
    LINE_KEY="l"
    LINE_MODS="{ctrlKey:true}"
    ;;
  *)
    LINE_KEY="l"
    LINE_MODS="{altKey:true}"
    ;;
esac
# A caret at column 0 of line 10, Shift+Down, then Select Line: the line the
# selection ends on at column 0 is left out.
evl "$DL" "__auto.switchTab($((SMALL_TAB - 1)))" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs()[$((SMALL_TAB - 1))].active)" "true"
evl "$DL" "__auto.setDocSelection($((10 * LINE_BYTES)),$((10 * LINE_BYTES)));1" >/dev/null
sleep 0.3
press ArrowDown '{shiftKey:true}'
sleep 0.5
press "$LINE_KEY" "$LINE_MODS"
sleep 0.7
REF_LINE=$(norm_sel "$(e2e_read "$DL" "JSON.stringify(__auto.getDocSelection())")" "$SMALL_END_LINE")
evl "$DL" "__auto.setDocSelection(0,$((SMALL_END_LINE * LINE_BYTES + END_COL)));1" >/dev/null
sleep 0.3
press "$LINE_KEY" "$LINE_MODS"
sleep 0.5
press ArrowUp '{shiftKey:true}'
sleep 0.7
REF_ALL_UP=$(norm_sel "$(e2e_read "$DL" "JSON.stringify(__auto.getDocSelection())")" "$SMALL_END_LINE")
evl "$DL" "__auto.setDocSelection(0,$((SMALL_END_LINE * LINE_BYTES + END_COL)));1" >/dev/null
sleep 0.3
press "$LINE_KEY" "$LINE_MODS"
sleep 0.5
press ArrowDown '{shiftKey:true}'
sleep 0.7
REF_ALL_DOWN=$(norm_sel "$(e2e_read "$DL" "JSON.stringify(__auto.getDocSelection())")" "$SMALL_END_LINE")
evl "$DL" "__auto.switchTab($((WIN_TAB - 1)))" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs()[$((WIN_TAB - 1))].active && __auto.isWindowedTab())" "true"
# The click must land in the loaded window, which Select All moved to the end.
evl "$DL" "__auto.windowedGoto(11)" >/dev/null
e2e_wait_until 60 _e2e_eval_equals "$DL" "String(__auto.windowedInfo().windowStartLine<=10 && __auto.windowedGlobalInfo().settled)" "true"
evl "$DL" "__t.focus()" >/dev/null
check "the click at line 10 was made" "$(e2e_read "$DL" "String(__auto.windowedPointerSelect($((10 * LINE_BYTES))))")" "true"
settle
press ArrowDown '{shiftKey:true}'
settle
press "$LINE_KEY" "$LINE_MODS"
settle
check "Shift+Down from column 0 and Select Line: the same as CodeMirror" "$(norm_sel "$(gsel)" "$END_LINE")" "$REF_LINE"
select_all
press "$LINE_KEY" "$LINE_MODS"
settle
press ArrowUp '{shiftKey:true}'
settle
check "Select All, Select Line and Shift+Up: the same as CodeMirror" "$(norm_sel "$(gsel)" "$END_LINE")" "$REF_ALL_UP"
select_all
press "$LINE_KEY" "$LINE_MODS"
settle
press ArrowDown '{shiftKey:true}'
settle
check "Select All, Select Line and Shift+Down: the same as CodeMirror" "$(norm_sel "$(gsel)" "$END_LINE")" "$REF_ALL_DOWN"
# The small ordinary tab is closed; the windowed tab goes on.
evl "$DL" "__auto.switchTab($((SMALL_TAB - 1)))" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs()[$((SMALL_TAB - 1))].active)" "true"
evl "$DL" "__auto.closeActiveTab()" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length)" "2"
evl "$DL" "__auto.switchTab($((WIN_TAB - 1)))" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs()[$((WIN_TAB - 1))].active && __auto.isWindowedTab())" "true"
close_windowed

echo "=== 5. the delete keys remove the whole selection ==="
begin_doc
S5_SIZE=$(total)
case "$(uname -s)" in
  Darwin)
    DELETE_KEYS="Backspace|{}
Delete|{}
Backspace|{altKey:true}
Delete|{altKey:true}
Backspace|{metaKey:true}
Delete|{metaKey:true}
d|{ctrlKey:true}
h|{ctrlKey:true}
k|{ctrlKey:true}"
    ;;
  *)
    DELETE_KEYS="Backspace|{}
Delete|{}
Backspace|{ctrlKey:true}
Delete|{ctrlKey:true}"
    ;;
esac
while IFS='|' read -r key mods; do
  select_all
  press "$key" "$mods"
  settle
  check "$key $mods deletes the whole selection" "$(total)" "0"
  undo_to "$S5_SIZE"
done <<EOF
$DELETE_KEYS
EOF
check "no exception thrown" "$(e2e_read "$DL" "$(js_errors)")" "0"
close_windowed

echo "=== 6. while an indentation is held ==="
# The window swap's read is held (holdWindowedReads), so the operation is done
# in the core and the old window is still shown, open to input.
hold_reads() {
  evl "$DL" "__auto.holdWindowedReads(true)" >/dev/null
}
release_reads() {
  evl "$DL" "__auto.holdWindowedReads(false);__auto.releaseWindowedReads()" >/dev/null
}
echo "--- an undo key is queued behind the indentation ---"
begin_doc
select_all
hold_reads
press Tab
e2e_wait_eval "$DL" "String(__auto.heldWindowedReads()===1)" "true"
check "the indentation was sent to the core" "$(ginfo globalOps)" "1"
press_mod z
check "the undo is in the queue" "$(e2e_read "$DL" "String(__auto.windowedReplayLength()>=1)")" "true"
release_reads
settle
e2e_wait_until 60 _e2e_eval_equals "$DL" "$(js_total)" "$BASE_SIZE"
check "the undo ran after the indentation: the file is as it was" "$(total)" "$BASE_SIZE"
close_windowed
echo "--- a click in the window is carried through the indentation ---"
begin_doc
select_all
hold_reads
press Tab
e2e_wait_eval "$DL" "String(__auto.heldWindowedReads()===1)" "true"
CLICK_LINE=5
CLICK_COL=7
check "the click was made" "$(e2e_read "$DL" "String(__auto.windowedPointerSelect($((CLICK_LINE * LINE_BYTES + CLICK_COL))))")" "true"
press Q
release_reads
settle
close_windowed
check "Q is typed where the click was, in the indented line" "$(python3 "$WORK/chk.py" click "$DOC" "$N_LINES" "$CLICK_LINE" "$CLICK_COL")" "true"
echo "--- a composition begins and ends: no read-only editor, one undo step ---"
begin_doc
select_all
hold_reads
press Tab
e2e_wait_eval "$DL" "String(__auto.heldWindowedReads()===1)" "true"
evl "$DL" "__auto.windowedCompose({target:'editor',updates:['か','かな'],endData:'かな'}).then(()=>{window.__cd=1;});1" >/dev/null
e2e_wait_eval "$DL" "String(window.__cd===1)" "true"
check "the editor is not read-only" "$(e2e_read "$DL" "String(__t.editable())")" "true"
release_reads
settle
# The anchor sat after the two spaces of line 0, so they stay: two spaces and
# the 6 bytes of the committed text.
e2e_wait_until 60 _e2e_eval_equals "$DL" "$(js_total)" "8"
check "the committed text replaced the indented selection, line 0's indentation stays" "$(total)" "8"
undo_to "$((BASE_SIZE + 2 * N_LINES))"
check "one undo gives the indented file back" "$(total)" "$((BASE_SIZE + 2 * N_LINES))"
undo_to "$BASE_SIZE"
check "the second undo gives the original back" "$(total)" "$BASE_SIZE"
close_windowed

echo "=== 7. two compositions in a row over a selection larger than a window ==="
# The second one starts within CHAIN_MS (40 ms) of the first one's end; its
# update and end come later, and its end data is empty.
for variant in outside inside; do
  begin_doc
  select_all
  if [ "$variant" = "inside" ]; then
    # Collapse to the end, then Shift+document start: the anchor stays at the
    # end, the head is at the start, in the loaded window.
    press ArrowRight
    settle
    press "$DOC_START_KEY" "$DOC_START_MODS"
    settle
  fi
  evl "$DL" "window.__cc=undefined;__auto.windowedCompose({target:'editor',updates:['ab'],endData:'ab'}).then(()=>__auto.windowedCompose({target:'editor',updates:['cd'],endData:'',delays:{beforeStart:10,afterStart:100,beforeEnd:100}})).then(()=>{window.__cc=1;});1" >/dev/null
  e2e_wait_eval "$DL" "String(window.__cc===1)" "true"
  settle
  close_windowed
  check "$variant: both compositions are in, in order" "$(cat "$DOC")" "abcd"
done

echo "=== 8. Shift+Up and then Delete, or x, equals the keys one after another ==="
hq_run() {
  # $1 the key after Shift+Up, $2 fast (at once) or slow (settled in between);
  # sets HQ_SHA.
  begin_doc
  select_all
  press ArrowUp '{shiftKey:true}'
  if [ "$2" = "slow" ]; then
    settle
  fi
  press "$1"
  settle
  close_windowed
  HQ_SHA=$(file_sha256 "$DOC")
}
for key in Delete x; do
  hq_run "$key" slow
  SLOW_SHA=$HQ_SHA
  hq_run "$key" fast
  check "$key right after Shift+Up: the same file as one after another" "$HQ_SHA" "$SLOW_SHA"
done

echo "=== 9. lone CR lines: the global delete removes what the screen showed selected ==="
evl "$DL" "__auto.windowedOpen('$WORK/cr.log').then((r)=>{window.__ow=r;});1" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length===2 && __auto.getTabs()[1].active && __auto.isWindowedTab() && __auto.windowedInfo().windowStartLine===0)" "true"
CR_END_LINE=2999
evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
e2e_wait_until 60 _e2e_eval_equals "$DL" "String(__auto.windowedGlobalSel().head.line===$CR_END_LINE)" "true"
for i in 1 2 3; do
  press ArrowUp '{shiftKey:true}'
  settle
done
CR_SEL=$(gsel)
echo "selection before the delete: $CR_SEL"
press Delete
settle
CR_LINE=$(printf '%s' "$CR_SEL" | jq -r '.head.line')
CR_COL=$(printf '%s' "$CR_SEL" | jq -r '.head.col')
cp "$WORK/cr.log" "$WORK/cr.orig"
close_windowed
check "the selection ended on a line below the first" "$([ "$CR_LINE" -gt 2000 ] && echo yes || echo no)" "yes"
check "what is left is what the selection did not cover" "$(python3 "$WORK/chk.py" tail "$WORK/cr.orig" "$WORK/cr.log" "$CR_LINE" "$CR_COL")" "true"

echo "=== 10. a global operation sends no windowed_apply ==="
begin_doc
select_all
APPLIES0=$(ginfo applies)
press Tab
settle
press Delete
settle
check "two global commands were sent" "$(ginfo globalOps)" "2"
# Delete took the selection from after line 0's new indentation: two spaces stay.
check "the Delete left the two spaces of line 0" "$(total)" "2"
check "windowed_apply was not called" "$(ginfo applies)" "$APPLIES0"
close_windowed

echo "=== 11. a held global operation: the editor stays open to a composition ==="
begin_doc
select_all
evl "$DL" "__auto.holdGlobalOps(true)" >/dev/null
press Delete
e2e_wait_eval "$DL" "String(__auto.heldGlobalOps()===1)" "true"
check "the swap leaves the editor open to input" "$(ginfo keepsInput)" "true"
evl "$DL" "window.__cd=undefined;__auto.windowedCompose({target:'editor',updates:['か'],endData:'か',delays:{beforeEnd:4000}}).then(()=>{window.__cd=1;});1" >/dev/null
sleep 1.5
check "the composition's selection was not dropped (the caret follows its text)" "$(e2e_read "$DL" "JSON.stringify(__auto.windowedLiveSelection().head)")" '{"line":0,"col":1}'
e2e_wait_eval "$DL" "String(window.__cd===1)" "true"
evl "$DL" "__auto.holdGlobalOps(false);__auto.releaseGlobalOps()" >/dev/null
settle
close_windowed
check "the committed text was applied once the operation was through" "$(cat "$DOC")" "か"

echo "=== 12. replace all that changes the line count, then Delete ==="
begin_doc
select_all
evl "$DL" "__auto.openFindReplace()" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelectorAll('.search-panel input.cm-textfield').length===2)" "true"
# The replacement holds a line break: an input strips one from a value it is
# given, so the value is read back from a getter.
read -r -d '' SET_FIELDS <<'JS'
(()=>{
  const f = document.querySelectorAll('.search-panel input.cm-textfield');
  f[0].value = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  f[0].dispatchEvent(new Event('input', { bubbles: true }));
  Object.defineProperty(f[1], 'value', { configurable: true, get: () => 'a\nb', set: () => {} });
  f[1].dispatchEvent(new Event('input', { bubbles: true }));
  return 1;
})()
JS
evl "$DL" "$SET_FIELDS" >/dev/null
evl "$DL" "(()=>{const b=[...document.querySelectorAll('.search-panel .cm-button')].find((x)=>x.textContent.trim()==='Replace All');b.click();return 1;})()" >/dev/null
e2e_wait_until 120 _e2e_eval_equals "$DL" "String(__auto.windowedInfo().totalLines>$N_LINES)" "true"
e2e_wait_until 120 _e2e_eval_equals "$DL" "String(__t.editable())" "true"
sleep 2
evl "$DL" "__auto.closeFind();__t.focus()" >/dev/null
e2e_wait_eval "$DL" "String(document.activeElement===__t.content())" "true"
LAST=$(e2e_read "$DL" "String(__auto.windowedInfo().totalLines-1)")
check "the selection still covers the file after the lines changed" "$(e2e_read "$DL" "String(__auto.windowedGlobalSel().anchor.line===0 && __auto.windowedGlobalSel().head.line===$LAST)")" "true"
press Delete
settle
e2e_wait_until 120 _e2e_eval_equals "$DL" "$(js_total)" "0"
check "the editor is not locked" "$(e2e_read "$DL" "String(document.querySelector('.windowed-error')===null && __t.editable())")" "true"
close_windowed
check "the saved file is empty" "$(file_size "$DOC")" "0"

echo "=== 13. type in the window, Select All, undo, Delete ==="
begin_doc
evl "$DL" "__t.focus();document.execCommand('insertText',false,'abc')" >/dev/null
e2e_wait_eval "$DL" "$(js_total)" "$((BASE_SIZE + 3))"
select_all
press_mod z
e2e_wait_until 60 _e2e_eval_equals "$DL" "$(js_total)" "$BASE_SIZE"
settle
check "the selection still covers the file after the undo" "$(e2e_read "$DL" "String(__t.isAll($END_LINE,$END_COL))")" "true"
press Delete
settle
e2e_wait_until 60 _e2e_eval_equals "$DL" "$(js_total)" "0"
close_windowed
check "the saved file is empty" "$(file_size "$DOC")" "0"

echo "=== 14. an undo queued before a composition runs in the shadow ==="
# Select All, Shift+Up (a swap, held at its read), Cmd/Ctrl+Z (queued behind
# it), a composition that stays open, the read released: the shadow replays the
# Shift+Up and the undo while the composition is open. Then Delete.
# One diagnostic line: shortened in the log, whole in $DIAG_LOG.
diag_line() {
  echo "DIAG $1: $(e2e_show "$2")"
  printf 'DIAG %s: %s\n' "$1" "$2" >>"$DIAG_LOG"
}
# The editor's state and the last 50 entries of its trace, one entry a line.
diag_state() {
  local tag="$1" trace entries entry
  diag_line "$tag globalSel" "$(gsel)"
  diag_line "$tag info" "$(e2e_read "$DL" "JSON.stringify(__auto.windowedInfo())")"
  diag_line "$tag replayLength" "$(e2e_read "$DL" "String(__auto.windowedReplayLength())")"
  trace="$(e2e_read "$DL" "JSON.stringify(__auto.windowedTrace().slice(-50).map((e)=>JSON.stringify(e)))")"
  entries="$(printf '%s' "$trace" | jq -r '.[]' 2>/dev/null)"
  if [ -z "$entries" ]; then
    diag_line "$tag trace (unparsed)" "$trace"
    return 0
  fi
  while IFS= read -r entry; do
    diag_line "$tag trace" "$entry"
  done <<<"$entries"
}
shadow_run() {
  # $1 shadow or plain; sets SHADOW_SHA.
  begin_doc
  evl "$DL" "__t.focus();document.execCommand('insertText',false,'abc')" >/dev/null
  e2e_wait_eval "$DL" "$(js_total)" "$((BASE_SIZE + 3))"
  select_all
  if [ "$1" = "shadow" ]; then
    hold_reads
    press ArrowUp '{shiftKey:true}'
    e2e_wait_eval "$DL" "String(__auto.heldWindowedReads()===1)" "true"
    press_mod z
    evl "$DL" "window.__cd=undefined;__auto.windowedCompose({target:'editor',updates:[],endData:'',delays:{beforeEnd:4000}}).then(()=>{window.__cd=1;});1" >/dev/null
    sleep 1
    release_reads
    e2e_wait_eval "$DL" "String(window.__cd===1)" "true"
    settle
  else
    press ArrowUp '{shiftKey:true}'
    settle
    press_mod z
    settle
    e2e_wait_until 60 _e2e_eval_equals "$DL" "$(js_total)" "$BASE_SIZE"
  fi
  diag_state "$1 before Delete"
  press Delete
  settle
  diag_state "$1 after Delete"
  close_windowed
  SHADOW_SHA=$(file_sha256 "$DOC")
}
shadow_run plain
PLAIN_SHA=$SHADOW_SHA
shadow_run shadow
check "the undo in the shadow and the Delete after it: the same file as one after another" "$SHADOW_SHA" "$PLAIN_SHA"

echo "=== 15. a selection key queued before a composition ==="
# Records what decides whether a composition is captured, just before and just
# after its compositionstart is handled (read as window.__imeAt). The listener is
# on window so it runs ahead of the app's own document capture listener.
diag_ime_listen() {
  evl "$DL" "window.__imeAt=undefined;window.addEventListener('compositionstart',()=>{const before=__auto.windowedImeState();queueMicrotask(()=>{window.__imeAt={before,after:__auto.windowedImeState()};});},{capture:true,once:true});1" >/dev/null
}
# The composition of queued_run $1 with that state printed around it.
diag_ime_compose() {
  diag_line "15 $1 before the composition" "$(e2e_read "$DL" "JSON.stringify(__auto.windowedImeState())")"
  diag_ime_listen
  evl "$DL" "window.__cd=undefined;__auto.windowedCompose({target:'editor',updates:['x'],endData:'x'}).then(()=>{window.__cd=1;});1" >/dev/null
  e2e_wait_eval "$DL" "String(window.__cd===1)" "true"
  diag_line "15 $1 around compositionstart" "$(e2e_read "$DL" "JSON.stringify(window.__imeAt)")"
  diag_line "15 $1 after the composition" "$(e2e_read "$DL" "JSON.stringify(__auto.windowedImeState())")"
}
# The head is outside the window; Shift+End is queued and its swap is held at
# the read, a composition begins and ends, the read is released.
queued_run() {
  # $1 held or plain; sets QUEUED_SHA.
  begin_doc
  select_all
  press ArrowLeft '{shiftKey:true}'
  settle
  if [ "$1" = "held" ]; then
    hold_reads
    press End '{shiftKey:true}'
    e2e_wait_eval "$DL" "String(__auto.heldWindowedReads()===1)" "true"
    diag_ime_compose "$1"
    release_reads
    settle
  else
    press End '{shiftKey:true}'
    settle
    diag_ime_compose "$1"
    settle
  fi
  close_windowed
  QUEUED_SHA=$(file_sha256 "$DOC")
}
queued_run plain
PLAIN_SHA=$QUEUED_SHA
queued_run held
check "Shift+End and then the composition: the same file as one after another" "$QUEUED_SHA" "$PLAIN_SHA"
check "no exception thrown in the whole run" "$(e2e_read "$DL" "$(js_errors)")" "0"

echo "=== teardown ==="
evl "$DL" "__auto.setLanguage('$ORIG_LANG')" >/dev/null
e2e_wait_setting language "$ORIG_LANG"
evl "$DL" "__auto.setLargeSelectAll('$ORIG_SELECT')" >/dev/null
e2e_wait_setting large_select_all "$ORIG_SELECT"
quit_app
wipe_test_docs
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
