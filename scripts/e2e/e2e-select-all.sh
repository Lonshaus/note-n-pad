#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: Select All over a whole large file (setting large_select_all = 'file').
# A 110 MB file opened for windowed editing is selected from its start to its
# end: with the key, the Edit menu and the browser's own select-all. While the
# selection is larger than one window, an edit that is none of the global
# operations (see e2e-global-edit.sh) is refused and a copy writes nothing to
# the web clipboard (it goes through a clip file; e2e-clip.sh covers the copy
# and the cut); a Select All waits for the queue, the window swaps and the edits
# in flight, and takes no new input meanwhile. Also covers the viewer's
# whole-file flag, the General settings page (full and free edition) and, on
# Linux, the peak memory of the Select All over a file whose last line is 60 MB.
# Input methods: text goes in through document.execCommand('insertText') with
# focus in the editor (not __auto.typeText, which carries no user event and would
# walk through the guard); keys are keydown events dispatched at the editor,
# with Cmd on Darwin and Ctrl elsewhere as the modifier; clipboard actions are
# synthetic events carrying a DataTransfer, so the event itself is inspected and
# the system clipboard is not used.
# LESSON: never put `await` inside an eval string; use `.then((r)=>{window.__x=r;})`.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. The trap restores the language and the two large-file
# settings, patching settings.json directly once the app is dead, and wipes this
# suite's own document snapshots (matched by the fixture path).
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/select-all-fixture"
PASS=0
FAIL=0
mkdir -p "$OUT"
: >"$OUT/dev-select-all.log"

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
        *select-all-fixture*)
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
# $1 is the edition to force ("lite"), or nothing for the build's own.
launch() {
  local edition="${1:-}"
  e2e_require_clean_slate
  if [ -n "$edition" ]; then
    NOTENPAD_EDITION="$edition" NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-select-all.log" 2>&1 &
  else
    NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-select-all.log" 2>&1 &
  fi
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
  e2e_require_automation_listener "$OUT/dev-select-all.log"
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
  const codes = { a: 65, k: 75, x: 88, y: 89, z: 90, ArrowRight: 39, End: 35, Delete: 46 };
  const content = () => document.querySelector('.cm-content');
  const key = (k, mods) => {
    const e = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {}));
    Object.defineProperty(e, 'keyCode', { get: () => codes[k] || 0 });
    content().dispatchEvent(e);
    return e.defaultPrevented;
  };
  const mod = (k, extra) => key(k, Object.assign({ __MOD__: true }, extra || {}));
  const clip = (type, text, target) => {
    const dt = new DataTransfer();
    if (text !== undefined) { dt.setData('text/plain', text); }
    const e = new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true });
    (target || document.activeElement || document.body).dispatchEvent(e);
    return JSON.stringify({ prevented: e.defaultPrevented, types: dt.types.length, data: dt.getData('text/plain') });
  };
  const drop = (text) => {
    const c = content();
    const r = c.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 });
    c.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const isAll = (line, col) => {
    const g = __auto.windowedGlobalSel();
    return g !== null && g.anchor.line === 0 && g.anchor.col === 0 && g.head.line === line && g.head.col === col;
  };
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
  return { content, key, mod, clip, drop, isAll, collapsed, inside, focus: () => content().focus() };
})();
'ok'
JS
HELPERS="${HELPERS//__MOD__/$MODPROP}"
# Predicates over the page, as JS source for e2e_wait_eval / e2e_read.
js_all() { echo "String(__t.isAll($END_LINE,$END_COL))"; }
js_total() { echo "String(__auto.windowedInfo().totalBytes)"; }
js_errors() { echo "String(window.__errs.length)"; }
# Press Right and wait for the selection to collapse, so the next entry starts
# from a caret.
collapse_selection() {
  evl "$DL" "__t.focus();__t.key('ArrowRight')" >/dev/null
  e2e_wait_eval "$DL" "String(__t.collapsed())" "true"
}
# Sleep long enough for a refused action to have shown itself if it were going
# to: the apply result of an accepted edit lands well inside this.
settle_pause() {
  sleep 3
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
# lines.log: 2,400,000 lines of 47 characters ('0000000001 ' and 36 'x'), the
# last without a line break: 115,199,999 bytes, over the 100 MiB large-file
# threshold. The file ends at line 2,399,999 (0-based), column 47.
N_LINES=2400000
END_LINE=$((N_LINES - 1))
END_COL=47
python3 - <<PYEOF
n = $N_LINES
with open('$WORK/lines.log', 'w', newline='') as f:
    buf = []
    first = True
    for i in range(1, n + 1):
        buf.append(f'{i:010d} ' + 'x' * 36)
        if len(buf) == 20000 or i == n:
            # A line break goes before every batch but the first, so none follows the last line.
            if not first:
                f.write('\n')
            f.write('\n'.join(buf))
            first = False
            buf = []
PYEOF
echo "lines.log bytes: $(file_size "$WORK/lines.log")"
check "lines.log has no final line break" "$(tail -c 1 "$WORK/lines.log")" "x"
printf 'seed\n' >"$WORK/seed.txt"
# The viewer opens its own copy, so the edits to lines.log leave it alone.
cp "$WORK/lines.log" "$WORK/viewer.log"
if [ "$(uname -s)" = "Linux" ]; then
  # longlast.log: 50 MiB of short lines, then one 60 MiB line without a line
  # break, so the end of the file lies in a line the Select All must not read
  # whole.
  python3 - <<PYEOF
with open('$WORK/longlast.log', 'w', newline='') as f:
    line = 'z' * 46 + '\n'
    count = (50 * 1024 * 1024) // len(line)
    for start in range(0, count, 20000):
        f.write(line * min(20000, count - start))
    f.write('y' * (60 * 1024 * 1024))
PYEOF
  echo "longlast.log bytes: $(file_size "$WORK/longlast.log")"
fi

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
# Pin the language for the page text read below, and capture what the trap
# restores. The settings are the user's real ones.
ORIG_LANG=$(e2e_read "$DL" "String(__auto.getLanguage())")
ORIG_MODE=$(e2e_read "$DL" "String(__auto.getLargeOpenMode())")
ORIG_SELECT=$(e2e_read "$DL" "String(__auto.largeSelectAllMode())")
echo "original language: $ORIG_LANG, large_open_mode: $ORIG_MODE, large_select_all: $ORIG_SELECT"
restore_state() {
  trap '' INT TERM
  local dl
  dl=$(doc_label 2>/dev/null)
  if [ -n "$dl" ]; then
    if [ -n "${ORIG_LANG:-}" ]; then
      evl "$dl" "__auto.setLanguage('$ORIG_LANG')" >/dev/null 2>&1
    fi
    if [ -n "${ORIG_MODE:-}" ]; then
      evl "$dl" "__auto.setLargeOpenMode('$ORIG_MODE')" >/dev/null 2>&1
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
    if [ -n "${ORIG_MODE:-}" ]; then
      jq --arg v "$ORIG_MODE" '.large_open_mode = $v' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
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
trap restore_state EXIT INT TERM
evl "$DL" "__auto.setLanguage('en')" >/dev/null
evl "$DL" "__auto.setLargeSelectAll('file')" >/dev/null
e2e_wait_setting large_select_all "file"
check "setting is file" "$(e2e_read "$DL" "String(__auto.largeSelectAllMode())")" "file"

echo "=== open lines.log for windowed editing ==="
evl "$DL" "__auto.windowedOpen('$WORK/lines.log').then((r)=>{window.__ow=r;})" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length===2 && __auto.isWindowedTab() && __auto.getContent().startsWith('0000000001 ') && __auto.windowedInfo().windowStartLine===0)" "true"
check "lines.log opened without refusal" "$(e2e_read "$DL" "String(window.__ow===null)")" "true"
check "total lines" "$(e2e_read "$DL" "String(__auto.windowedInfo().totalLines)")" "$N_LINES"
evl "$DL" "$HELPERS" >/dev/null
check "helpers installed" "$(e2e_read "$DL" "typeof __t")" "object"
# Xvfb has no window manager, so the window must be given focus or CodeMirror ignores DOM selections.
auto "{\"id\":2,\"cmd\":\"focus\",\"label\":\"$DL\"}" >/dev/null
sleep 1
check "setup: the window has OS focus" "$(e2e_read "$DL" "String(document.hasFocus())")" "true"
evl "$DL" "__t.focus()" >/dev/null
check "editor holds focus" "$(e2e_read "$DL" "String(document.activeElement===document.querySelector('.cm-content'))")" "true"

echo "=== 1. all three entries select from the start to the end of the file ==="
evl "$DL" "window.__ep=undefined;__auto.windowedEndPos().then((p)=>{window.__ep=p;});1" >/dev/null
e2e_wait_eval "$DL" "String(window.__ep!==undefined)" "true"
check "windowed_end_pos is the end of the file" "$(e2e_read "$DL" "JSON.stringify(window.__ep)")" "{\"line\":$END_LINE,\"col\":$END_COL}"
evl "$DL" "__t.mod('a')" >/dev/null
e2e_wait_until 60 _e2e_eval_equals "$DL" "$(js_all)" "true"
check "key: Select All covers the file" "$(e2e_read "$DL" "$(js_all)")" "true"
collapse_selection
evl "$DL" "__auto.menuAction('select-all')" >/dev/null
e2e_wait_until 60 _e2e_eval_equals "$DL" "$(js_all)" "true"
check "menu: Select All covers the file" "$(e2e_read "$DL" "$(js_all)")" "true"
collapse_selection
evl "$DL" "__t.focus();document.execCommand('selectAll')" >/dev/null
e2e_wait_until 60 _e2e_eval_equals "$DL" "$(js_all)" "true"
check "native: select-all covers the file" "$(e2e_read "$DL" "$(js_all)")" "true"
check "no exception thrown" "$(e2e_read "$DL" "$(js_errors)")" "0"

echo "=== 2. a deleted line and a drop change nothing while the selection is larger than a window ==="
# Typing, Delete and a paste replace the selection (see e2e-global-edit.sh);
# what stays refused is an edit that is none of the global operations. A copy
# goes through a clip file, not the web clipboard (the cut is in e2e-clip.sh).
BASE=$(e2e_read "$DL" "$(js_total)")
echo "total bytes: $BASE"
evl "$DL" "__t.focus()" >/dev/null
evl "$DL" "__t.mod('k',{shiftKey:true})" >/dev/null
evl "$DL" "__t.drop('DROPPED')" >/dev/null
settle_pause
check "delete line and a drop leave the size alone" "$(e2e_read "$DL" "$(js_total)")" "$BASE"
check "the selection is still the file" "$(e2e_read "$DL" "$(js_all)")" "true"
COPY=$(e2e_read "$DL" "__t.clip('copy')")
check "copy is prevented" "$(printf '%s' "$COPY" | jq -r '.prevented')" "true"
check "copy writes nothing" "$(printf '%s' "$COPY" | jq -r '.types')" "0"
settle_pause
check "copy leaves the size alone" "$(e2e_read "$DL" "$(js_total)")" "$BASE"
check "the selection is still the file after copy" "$(e2e_read "$DL" "$(js_all)")" "true"

echo "=== 3. a paste into the search field is not refused ==="
evl "$DL" "__auto.openFind()" >/dev/null
e2e_wait_eval "$DL" "String(document.activeElement===document.querySelector('.search-panel input.cm-textfield'))" "true"
evl "$DL" "window.__pasteSeen=null;document.querySelector('.search-panel input.cm-textfield').addEventListener('paste',(e)=>{window.__pasteSeen=e.defaultPrevented;})" >/dev/null
FIELD=$(e2e_read "$DL" "__t.clip('paste','SEARCHED')")
check "the search field got the paste" "$(e2e_read "$DL" "String(window.__pasteSeen!==null)")" "true"
check "the paste into the search field is not prevented" "$(printf '%s' "$FIELD" | jq -r '.prevented')" "false"
evl "$DL" "__auto.closeFind()" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.search-panel')===null)" "true"

echo "=== 4. an arrow key ends the whole-file selection at the end of the file, and typing works again ==="
evl "$DL" "__t.focus();__t.key('ArrowRight')" >/dev/null
e2e_wait_eval "$DL" "String(__t.collapsed())" "true"
# As CodeMirror collapses a range with the Right key: to its later end.
check "the selection collapsed to the end of the file" "$(e2e_read "$DL" "JSON.stringify(__auto.windowedGlobalSel().head)")" "{\"line\":$END_LINE,\"col\":$END_COL}"
evl "$DL" "document.execCommand('insertText',false,'Q')" >/dev/null
e2e_wait_eval "$DL" "$(js_total)" "$((BASE + 1))"
check "one typed character adds one byte" "$(e2e_read "$DL" "$(js_total)")" "$((BASE + 1))"

echo "=== 5. a Select All waits for an edit still on its way to the core ==="
LAST_LINE=$N_LINES
evl "$DL" "__auto.windowedGoto($LAST_LINE)" >/dev/null
# The Q of item 4 sits at the end of the file, so the last line ends in x and Q.
e2e_wait_eval "$DL" "String(__auto.getContent().endsWith('$(printf '%010d' "$N_LINES") ' + 'x'.repeat(36) + 'Q') && __auto.windowedInfo().windowStartLine > $((N_LINES - 4000)))" "true"
evl "$DL" "__t.focus();__t.key('End')" >/dev/null
sleep 1
B5=$(e2e_read "$DL" "$(js_total)")
evl "$DL" "__auto.holdWindowedResults(true)" >/dev/null
evl "$DL" "document.execCommand('insertText',false,'a')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.heldWindowedResults()===1)" "true"
check "the edit is on its way (result parked)" "$(e2e_read "$DL" "String(__auto.heldWindowedResults()===1)")" "true"
evl "$DL" "__t.mod('a')" >/dev/null
sleep 2
check "Select All has not run yet (the selection is still a caret)" "$(e2e_read "$DL" "String(__t.collapsed())")" "true"
evl "$DL" "__auto.holdWindowedResults(false);__auto.releaseWindowedResults()" >/dev/null
e2e_wait_until 10 _e2e_eval_equals "$DL" "String(__t.isAll($END_LINE,$((END_COL + 2))))" "true"
check "Select All ran after the edit landed" "$(e2e_read "$DL" "String(__t.isAll($END_LINE,$((END_COL + 2))))")" "true"
evl "$DL" "__t.key('ArrowRight')" >/dev/null
e2e_wait_eval "$DL" "String(__t.collapsed())" "true"
evl "$DL" "document.execCommand('insertText',false,'b')" >/dev/null
e2e_wait_eval "$DL" "$(js_total)" "$((B5 + 2))"
check "both characters reached the core" "$(e2e_read "$DL" "$(js_total)")" "$((B5 + 2))"
END_COL=$((END_COL + 3))
evl "$DL" "window.__wr=undefined" >/dev/null
evl "$DL" "__auto.windowedSave().then((r)=>{window.__wr=r;})" >/dev/null
e2e_wait_eval "$DL" "String(window.__wr!==undefined)" "true"
check "save ok" "$(e2e_read "$DL" "String(window.__wr)")" "ok"
check "the file ends with ab" "$(tail -c 2 "$WORK/lines.log")" "ab"

echo "=== 6. input accepted before the Select All is applied first ==="
# The expected bytes come from a reference pass on a fresh copy of the same
# file: the same steps, with only the x typed after the undo and no Select All.
# The real pass, with the Select All and a y typed behind it, must save the
# same bytes.
# Caret to line 1000, column 5 (so the x does not land on the last line by
# accident, and both passes put it at the same place), a replace all over
# '5555', and a wait until the pass is over and the editor is editable again.
# Leaves focus in the editor.
replace_all_pass() {
  evl "$DL" "__auto.windowedGoto(1000)" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.windowedInfo().windowStartLine < 1000 && __auto.getContent().includes('0000001000 '))" "true"
  evl "$DL" "__t.focus();for(let i=0;i<5;i++){__t.key('ArrowRight');}" >/dev/null
  e2e_wait_eval "$DL" "JSON.stringify(__auto.getCursor())" '{"line":1000,"col":6}'
  evl "$DL" "__auto.openFindReplace()" >/dev/null
  e2e_wait_eval "$DL" "String(document.querySelectorAll('.search-panel input.cm-textfield').length===2)" "true"
  evl "$DL" "(()=>{const f=document.querySelectorAll('.search-panel input.cm-textfield');const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};set(f[0],'5555');set(f[1],'55-55');return 1;})()" >/dev/null
  local before
  before=$(e2e_read "$DL" "$(js_total)")
  evl "$DL" "(()=>{const b=[...document.querySelectorAll('.search-panel .cm-button')].find((x)=>x.textContent.trim()==='Replace All');b.click();return 1;})()" >/dev/null
  e2e_wait_until _e2e_eval_equals "$DL" "String(__auto.windowedInfo().totalBytes>$before)" "true"
  e2e_wait_eval "$DL" "String(document.querySelector('.cm-content').getAttribute('contenteditable'))" "true"
  sleep 2
  evl "$DL" "__auto.closeFind();__t.focus()" >/dev/null
  e2e_wait_eval "$DL" "String(document.activeElement===document.querySelector('.cm-content'))" "true"
}
save_active() {
  evl "$DL" "window.__wr=undefined" >/dev/null
  evl "$DL" "__auto.windowedSave().then((r)=>{window.__wr=r;})" >/dev/null
  e2e_wait_eval "$DL" "String(window.__wr!==undefined)" "true"
  check "save ok" "$(e2e_read "$DL" "String(window.__wr)")" "ok"
}
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

echo "--- setup: both passes start from the same saved bytes ---"
# Items 4 and 5 edited and saved lines.log, so the copy is taken now, from the
# saved file, with the tab clean.
save_active
check "setup: lines.log tab is clean after the save" "$(e2e_read "$DL" "String(__auto.windowedInfo().dirty)")" "false"
cp "$WORK/lines.log" "$WORK/lines.ref.log"
SETUP_A=$(file_sha256 "$WORK/lines.log")
SETUP_B=$(file_sha256 "$WORK/lines.ref.log")
if [ "$SETUP_A" != "$SETUP_B" ]; then
  bad "setup: lines.ref.log differs from lines.log before either pass (got: [$SETUP_B], want: [$SETUP_A])"
  echo "FATAL: setup failure, item 6 not run"
  echo "=== result: PASS=$PASS FAIL=$FAIL ==="
  exit 1
fi
ok "setup: lines.ref.log and lines.log have the same sha256 ($SETUP_A)"

echo "--- reference pass (copy of the saved file, undo and x only) ---"
evl "$DL" "__auto.windowedOpen('$WORK/lines.ref.log').then((r)=>{window.__or=r;})" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length===3 && __auto.getTabs()[2].active && __auto.isWindowedTab() && __auto.getContent().startsWith('0000000001 ') && __auto.windowedInfo().windowStartLine===0)" "true"
check "reference copy opened without refusal" "$(e2e_read "$DL" "String(window.__or===null)")" "true"
replace_all_pass
REF_QUEUED=$(e2e_read "$DL" "(()=>{__t.mod('z');__t.key('x');return String(__auto.windowedReplayLength());})()")
check "reference: x is in the replay queue behind the undo" "$REF_QUEUED" "1"
e2e_wait_until _e2e_eval_equals "$DL" "String(__auto.windowedReplayLength()===0 && document.querySelector('.cm-content').getAttribute('contenteditable')==='true')" "true"
sleep 2
save_active
REF_SHA=$(file_sha256 "$WORK/lines.ref.log")
echo "reference sha256: $REF_SHA"
# Where the reference file ends: the x may be on the last line, and then the
# end column is one more.
END_COL=$(python3 - <<PYEOF
data = open('$WORK/lines.ref.log', 'rb').read()
print(len(data.rsplit(b'\n', 1)[-1]))
PYEOF
)
echo "end column of the reference file: $END_COL"
evl "$DL" "__auto.closeActiveTab()" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length)" "2"
evl "$DL" "__auto.switchTab(1)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs()[1].active && __auto.isWindowedTab() && __auto.getContent().startsWith('0000000001 ') && __auto.windowedInfo().windowStartLine===0)" "true"
rm -f "$WORK/lines.ref.log"

echo "--- real pass (undo, x, Select All, y) ---"
replace_all_pass
# One synchronous turn: undo takes its hold, x is queued behind it, Select All
# waits, y arrives while it waits and is dropped.
QUEUED=$(e2e_read "$DL" "(()=>{__t.mod('z');__t.key('x');__t.mod('a');__t.key('y');return String(__auto.windowedReplayLength());})()")
check "x is in the replay queue behind the undo" "$QUEUED" "1"
e2e_wait_until _e2e_eval_equals "$DL" "$(js_all)" "true"
check "Select All ran after the replay" "$(e2e_read "$DL" "$(js_all)")" "true"
save_active
check "the saved file equals the reference: the undone content plus x, no y" "$(file_sha256 "$WORK/lines.log")" "$REF_SHA"

echo "=== 7. a Select All made during the swap back to the caret ==="
evl "$DL" "__auto.windowedGoto(1)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getContent().startsWith('0000000001 ') && __auto.windowedInfo().windowStartLine===0)" "true"
evl "$DL" "__t.focus()" >/dev/null
tries=0
until [ "$(e2e_read "$DL" "String(__auto.windowedInfo().windowStartLine > 5000)")" = "true" ]; do
  evl "$DL" "(()=>{const s=document.querySelector('.cm-scroller');s.scrollTop=s.scrollHeight;return 1;})()" >/dev/null
  sleep 2
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    break
  fi
done
check "the window moved away from the caret on line 1" "$(e2e_read "$DL" "String(__auto.windowedInfo().windowStartLine > 5000 && __auto.getCursor().line===1)")" "true"
B7=$(e2e_read "$DL" "$(js_total)")
evl "$DL" "__auto.holdWindowedReads(true)" >/dev/null
evl "$DL" "__t.focus();__t.key('ArrowRight')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.heldWindowedReads()===1 && __auto.windowedSwapKeepsInput()===true && document.activeElement===document.querySelector('.cm-content'))" "true"
check "the swap is parked with the editor open to input" "$(e2e_read "$DL" "String(__auto.heldWindowedReads()===1 && __auto.windowedSwapKeepsInput()===true)")" "true"
evl "$DL" "document.execCommand('selectAll')" >/dev/null
sleep 1
evl "$DL" "document.execCommand('insertText',false,'x')" >/dev/null
sleep 1
evl "$DL" "__auto.holdWindowedReads(false);__auto.releaseWindowedReads()" >/dev/null
e2e_wait_until _e2e_eval_equals "$DL" "$(js_all)" "true"
check "Select All ran once the swap was over" "$(e2e_read "$DL" "$(js_all)")" "true"
settle_pause
check "the x typed during the swap was dropped" "$(e2e_read "$DL" "$(js_total)")" "$B7"

echo "=== 8. the visible setting selects what is on screen ==="
evl "$DL" "__auto.setLargeSelectAll('visible')" >/dev/null
e2e_wait_setting large_select_all "visible"
# The menu path calls selectVisible directly, so its selection is the reference
# for the key. Both are taken from a caret, with no scrolling in between.
collapse_selection
sleep 2
evl "$DL" "__auto.menuAction('select-all')" >/dev/null
e2e_wait_eval "$DL" "String(__t.inside() && !__t.collapsed())" "true"
MENU_SEL=$(e2e_read "$DL" "JSON.stringify(__auto.windowedGlobalSel())")
MENU_SCROLL=$(e2e_read "$DL" "String(document.querySelector('.cm-scroller').scrollTop)")
collapse_selection
evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
e2e_wait_eval "$DL" "String(__t.inside() && !__t.collapsed())" "true"
check "both ends are inside the window" "$(e2e_read "$DL" "String(__t.inside())")" "true"
check "the selection is not the file" "$(e2e_read "$DL" "$(js_all)")" "false"
check "no scrolling between the menu and the key selection" "$(e2e_read "$DL" "String(document.querySelector('.cm-scroller').scrollTop)")" "$MENU_SCROLL"
check "the key selects exactly what the menu selects" "$(e2e_read "$DL" "JSON.stringify(__auto.windowedGlobalSel())")" "$MENU_SEL"
check "the selection is smaller than the loaded window" "$(e2e_read "$DL" "(()=>{const g=__auto.windowedGlobalSel();return String(g.head.line-g.anchor.line<__auto.getContent().split('\\n').length-1);})()")" "true"

echo "--- input queued before a Select All stays ahead of it ---"
# Undo, x and Select All in one synchronous turn: with the undo out, x and the
# Select All must both wait in the replay queue, in that order. A Select All
# that jumped the queue would be answered by the x replacing the span, so the
# size would not grow by one byte and the caret would end up collapsed.
T8=$(e2e_read "$DL" "$(js_total)")
replace_all_pass
Q8=$(e2e_read "$DL" "(()=>{__t.mod('z');__t.key('x');__t.mod('a');return String(__auto.windowedReplayLength());})()")
check "visible: x and Select All are both in the replay queue behind the undo" "$Q8" "2"
e2e_wait_until _e2e_eval_equals "$DL" "String(__auto.windowedReplayLength()===0 && document.querySelector('.cm-content').getAttribute('contenteditable')==='true')" "true"
sleep 2
check "visible: the x was inserted, nothing on screen was replaced" "$(e2e_read "$DL" "$(js_total)")" "$((T8 + 1))"
check "visible: Select All ran after the x (a span inside the window)" "$(e2e_read "$DL" "String(__t.inside() && !__t.collapsed())")" "true"
Q_SEL=$(e2e_read "$DL" "JSON.stringify(__auto.windowedGlobalSel())")
Q_SCROLL=$(e2e_read "$DL" "String(document.querySelector('.cm-scroller').scrollTop)")
check "visible: the queued Select All is smaller than the loaded window" "$(e2e_read "$DL" "(()=>{const g=__auto.windowedGlobalSel();return String(g.head.line-g.anchor.line<__auto.getContent().split('\\n').length-1);})()")" "true"
collapse_selection
evl "$DL" "__auto.menuAction('select-all')" >/dev/null
e2e_wait_eval "$DL" "String(__t.inside() && !__t.collapsed())" "true"
check "visible: no scrolling between the queued and the menu Select All" "$(e2e_read "$DL" "String(document.querySelector('.cm-scroller').scrollTop)")" "$Q_SCROLL"
check "visible: the queued Select All selects exactly what the menu selects" "$(e2e_read "$DL" "JSON.stringify(__auto.windowedGlobalSel())")" "$Q_SEL"
save_active
check "visible: the tab is clean after the save" "$(e2e_read "$DL" "String(__auto.windowedInfo().dirty)")" "false"
evl "$DL" "__auto.setLargeSelectAll('file')" >/dev/null
e2e_wait_setting large_select_all "file"

echo "=== 9. the viewer's whole-file flag ==="
evl "$DL" "__auto.setLargeOpenMode('view')" >/dev/null
e2e_wait_setting large_open_mode "view"
evl "$DL" "__auto.openTab('$WORK/viewer.log')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length===3 && __auto.isLargeTab())" "true"
e2e_wait_eval "$DL" "String(document.querySelectorAll('.large-wrap .row .text').length>0)" "true"
check "the viewer starts without a whole-file selection" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "false"
evl "$DL" "__auto.menuAction('select-all')" >/dev/null
check "file setting: menu Select All sets the flag" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "true"
evl "$DL" "document.querySelector('.large-wrap .row .text').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))" >/dev/null
check "a click clears it" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "false"
evl "$DL" "__auto.menuAction('select-all')" >/dev/null
evl "$DL" "window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))" >/dev/null
check "an arrow key clears it" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "false"
evl "$DL" "__auto.menuAction('select-all')" >/dev/null
evl "$DL" "__auto.largeSelectRange(1,5)" >/dev/null
check "a new selection clears it" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "false"
evl "$DL" "__auto.menuAction('select-all')" >/dev/null
check "file setting: Select All sets the flag again before Shift+End" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "true"
evl "$DL" "window.dispatchEvent(new KeyboardEvent('keydown',{key:'End',shiftKey:true,bubbles:true}))" >/dev/null
check "Shift+End clears it" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "false"
evl "$DL" "__auto.menuAction('select-all')" >/dev/null
check "file setting: Select All sets the flag again before PageDown" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "true"
evl "$DL" "window.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true}))" >/dev/null
check "PageDown clears it" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "false"
evl "$DL" "document.getSelection().removeAllRanges();document.execCommand('selectAll')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.largeWholeFile())" "true"
check "file setting: the native select-all sets the flag" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "true"
evl "$DL" "__auto.setLargeSelectAll('visible')" >/dev/null
e2e_wait_setting large_select_all "visible"
evl "$DL" "__auto.menuAction('select-all')" >/dev/null
check "visible setting: Select All leaves the flag off" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "false"
evl "$DL" "__auto.setLargeSelectAll('file')" >/dev/null
e2e_wait_setting large_select_all "file"
evl "$DL" "__auto.setLargeOpenMode('$ORIG_MODE')" >/dev/null
e2e_wait_setting large_open_mode "$ORIG_MODE"
check "no exception thrown in the whole run" "$(e2e_read "$DL" "$(js_errors)")" "0"

if [ "$(uname -s)" = "Linux" ]; then
  echo "=== 11. peak memory of a Select All over a file ending in a 60 MiB line ==="
  evl "$DL" "__auto.windowedOpen('$WORK/longlast.log').then((r)=>{window.__ol=r;})" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getTabs().length===4 && __auto.isWindowedTab() && __auto.getContent().startsWith('zzzz') && __auto.windowedInfo().windowStartLine===0)" "true"
  check "longlast.log opened without refusal" "$(e2e_read "$DL" "String(window.__ol===null)")" "true"
  PID=$(pgrep -x note-n-pad | head -1)
  echo "app pid: $PID"
  evl "$DL" "__t.focus()" >/dev/null
  sleep 3
  echo 5 >"/proc/$PID/clear_refs"
  RSS_BEFORE=$(awk '/^VmRSS:/ {print $2}' "/proc/$PID/status")
  evl "$DL" "__t.mod('a')" >/dev/null
  e2e_wait_until 60 _e2e_eval_equals "$DL" "String(__auto.windowedGlobalSel().head.line>0)" "true"
  sleep 3
  HWM=$(awk '/^VmHWM:/ {print $2}' "/proc/$PID/status")
  GROWTH=$((HWM - RSS_BEFORE))
  echo "RSS before: ${RSS_BEFORE} kB, peak after: ${HWM} kB, growth: ${GROWTH} kB"
  if [ "$GROWTH" -le 16384 ]; then
    ok "the peak grew by at most 16 MB"
  else
    bad "the peak grew by ${GROWTH} kB (more than 16 MB)"
  fi
else
  echo "SKIP: 11. peak memory (Linux only; measured by hand on the other platforms)"
fi

echo "=== 10. the General page, full edition ==="
evl "$DL" "window.__TAURI_INTERNALS__.invoke('show_settings_window')" >/dev/null
settings_ready() {
  [ "$(evl settings "String(typeof __auto)")" = "object" ]
}
# The names of the page's fields and toggles in document order, and
# whether this platform has the default apps page.
settings_order() {
  evl settings "(()=>{const out=[];document.querySelectorAll('.pane .field-label, .pane label.toggle > span').forEach((e)=>{out.push(e.textContent.trim());});return out.join('|');})()"
}
settings_default_apps() {
  evl settings "window.__dap=undefined;window.__TAURI_INTERNALS__.invoke('default_apps_page_supported').then((v)=>{window.__dap=v;});1" >/dev/null
  e2e_wait_eval settings "String(window.__dap!==undefined)" "true"
  e2e_read settings "String(window.__dap)"
}
# $1 is "true" when the default apps row is on the page, $2 the edition.
expected_order() {
  local dap="$1" edition="$2" list
  list="Appearance|Show icon in the status bar|Snapshot location|Open files in"
  if [ "$edition" = "full" ]; then
    list="$list|Open the workspace at startup"
  fi
  list="$list|Show local images and clickable links in preview"
  if [ "$edition" = "full" ]; then
    list="$list|Ask when opening files with very long lines"
  fi
  if [ "$dap" = "true" ]; then
    list="$list|Default file types"
  fi
  if [ "$edition" = "full" ]; then
    list="$list|Large file open mode|Large file Select All range"
  fi
  printf '%s' "$list"
}
order_is() {
  [ "$(settings_order)" = "$1" ]
}
e2e_wait_until settings_ready
evl settings "__auto.setLanguage('en')" >/dev/null
DAP=$(settings_default_apps)
echo "default apps page supported: $DAP"
WANT=$(expected_order "$DAP" full)
e2e_wait_until order_is "$WANT"
check "full edition: settings in order" "$(settings_order)" "$WANT"

echo "=== the full edition run is over ==="
evl "$DL" "__auto.setLanguage('$ORIG_LANG')" >/dev/null
e2e_wait_setting language "$ORIG_LANG"
evl "$DL" "__auto.setLargeSelectAll('$ORIG_SELECT')" >/dev/null
e2e_wait_setting large_select_all "$ORIG_SELECT"
quit_app
wipe_test_docs

echo "=== 10. the General page, free edition ==="
launch lite
BOOT=$(boot_label)
if [ -z "$BOOT" ]; then
  echo "FATAL: no window appeared in the free edition"
  exit 1
fi
evl "$BOOT" "window.__TAURI_INTERNALS__.invoke('show_settings_window')" >/dev/null
e2e_wait_until settings_ready
evl settings "__auto.setLanguage('en')" >/dev/null
DAP=$(settings_default_apps)
WANT=$(expected_order "$DAP" lite)
e2e_wait_until order_is "$WANT"
check "free edition: settings in order, no large file settings" "$(settings_order)" "$WANT"
evl settings "__auto.setLanguage('$ORIG_LANG')" >/dev/null
e2e_wait_setting language "$ORIG_LANG"

echo "=== teardown ==="
quit_app
wipe_test_docs
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
