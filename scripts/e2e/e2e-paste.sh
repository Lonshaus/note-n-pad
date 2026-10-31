#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: the paste side. A paste into a document or a sticky note that makes it
# larger than its editor turns it into a large file (D8, D12), keeping the line
# ending and the encoding (D13); a result too big to edit is saved and shown in
# the view (D16); a clip of ours is pasted from the file, never read by the page.
# Where each row runs (the script picks by uname -s; every row says which):
#   Linux (CI, ubuntu): only the rows without clips. A Linux build has none, so a
#     paste is the text of the event, which the page hands to the conversion; the
#     rows that need a clip or the system clipboard print an explicit SKIP.
#   macOS (CI, local): the system clipboard is read with pbpaste and written with
#     pbcopy; memory is phys_footprint (footprint -j). A paste here is routed
#     through the core: the page never reads a clip, and the text of another
#     program arrives as the paste the core sends to the focused element.
#   Windows (CI, the acceptance VM): the clipboard is read with Get-Clipboard and
#     written with Set-Clipboard; memory is the private bytes of the process. The
#     text of another program is read by the page with navigator.clipboard.
# The debug build runs with NOTENPAD_LARGE_EDIT_MAX at 101 MiB, so a paste of
# 102 MiB reaches the D16 question with files a runner can afford.
# Input methods: a paste is __auto.pasteText(text), a paste event with a
# DataTransfer at the focused element: where there are clips the event's text is
# ignored (the core is asked what the clipboard holds), so the text is put on the
# system clipboard first; the count of getData calls it returns shows whether the
# page read the clipboard by itself. Keys are __auto.windowedPressKey, Cmd on
# Darwin and Ctrl elsewhere. The native save dialog is not driven: a save names
# its path (saveActive(path), saveAs(path)); the button that opens that dialog
# (D13 "save as UTF-8") is covered by Vitest.
# LESSON: never put `await` inside an eval string; use `.then((r)=>{window.__x=r;})`
# and end a fire-and-forget eval with `;1` so it does not wait for the promise.
# The trap restores the language, the open target and the two large-file
# settings (patching settings.json once the app is dead) and wipes this suite's
# own snapshots (matched by the fixture path).
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/paste-fixture"
PASS=0
FAIL=0
MIB=$((1024 * 1024))
# Pasted: just over the 100 MiB a document may hold; the editable limit is 101.
OK_N=$((100 * MIB + 4096))
BIG_N=$((102 * MIB))
NOTE_N=16000001
LARGE_EDIT_MAX_BYTES=$((101 * MIB))
# The most the main process's private memory may grow while a clip is pasted.
MEM_LIMIT=$((64 * MIB))
# The 110 MB file of the clip suite: 2,400,000 lines of 47 characters and a break.
N_LINES=20000
LINE_BYTES=48
BASE_SIZE=$((N_LINES * LINE_BYTES - 1))
END_LINE=$((N_LINES - 1))
END_COL=47
BIG_LINES=2400000
BIG_SIZE=$((BIG_LINES * LINE_BYTES - 1))
BIG_END_LINE=$((BIG_LINES - 1))
# The mid file: 105,359,999 bytes. A paste of it into 'abc' is over the 100 MiB
# a document may hold and under the 101 MiB that can be edited.
MID_LINES=2195000
MID_SIZE=$((MID_LINES * LINE_BYTES - 1))
MID_END_LINE=$((MID_LINES - 1))
mkdir -p "$OUT"
: >"$OUT/dev-paste.log"
DIAG_LOG="$OUT/dev-diag-paste.log"
: >"$DIAG_LOG"

case "$(uname -s)" in
  Darwin)
    ENV_NAME="macos"
    MODPROP="metaKey"
    ;;
  MINGW64_NT* | MSYS_NT*)
    ENV_NAME="windows"
    MODPROP="ctrlKey"
    ;;
  Linux)
    ENV_NAME="linux"
    MODPROP="ctrlKey"
    ;;
  *)
    echo "FATAL: unsupported system $(uname -s)"
    exit 1
    ;;
esac
echo "environment: $ENV_NAME"
has_clipboard() {
  [ "$ENV_NAME" != "linux" ]
}

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
skip() {
  echo "SKIP: $1"
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
# Every document snapshot: the preflight requires none at the start, so all that
# exist now are this suite's, the ones of an unnamed tab included.
wipe_test_docs() {
  for f in "$STORE"/*.json; do
    if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
      rm -f "$f"
    fi
  done
}

cd "$REPO" || exit 1
source "$HOME/.cargo/env" 2>/dev/null

auto() {
  node scripts/auto.mjs "$1" </dev/null
}
doc_labels() {
  auto '{"id":3,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("doc-"))|.label'
}
doc_label() {
  doc_labels | head -1
}
doc_label_ready() {
  [ -n "$(doc_label)" ]
}
note_label() {
  auto '{"id":4,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-"))|.label' | head -1
}
note_gone() {
  [ -z "$(note_label)" ]
}
note_exists() {
  [ -n "$(note_label)" ]
}
# The document window that is not in the list $1 (labels, one a line).
new_doc_label() {
  local l
  for l in $(doc_labels); do
    case "
$1
" in
      *"
$l
"*) ;;
      *)
        echo "$l"
        return 0
        ;;
    esac
  done
}
# Opens seed.txt in a window of its own, asked from window $1; sets WIN_B once
# the window has its page, and gives it the helpers.
open_second() {
  local before tries=0
  before="$(doc_labels)"
  evl "$1" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/seed.txt'})" >/dev/null
  WIN_B=""
  while [ -z "$WIN_B" ] && [ "$tries" -lt 60 ]; do
    WIN_B="$(new_doc_label "$before")"
    sleep 1
    tries=$((tries + 1))
  done
  e2e_wait_eval "$WIN_B" "String(typeof __auto!=='undefined' && __auto.getTabs().length===1)" "true"
  evl "$WIN_B" "$HELPERS" >/dev/null
}
# Gives window $1 the OS focus.
focus_window() {
  auto "{\"id\":2,\"cmd\":\"focus\",\"label\":\"$1\"}" >/dev/null
  sleep 1
}
# Whether the list of notes (list_notes) names the sticky note $CREATED_STICKY.
# Asked in window $1.
note_listed() {
  evl "$1" "window.__nl=undefined;window.__TAURI_INTERNALS__.invoke('list_notes').then((r)=>{window.__nl=r.some((n)=>n.id==='$CREATED_STICKY');});1" >/dev/null
  e2e_wait_eval "$1" "String(window.__nl!==undefined)" "true"
  e2e_read "$1" "String(window.__nl)"
}
# Whether the sticky note $CREATED_STICKY is handed to a document window: its
# record is there, no list shows it. Asked in window $1.
note_handed_off() {
  evl "$1" "window.__nh=undefined;__auto.noteHandedOff('$CREATED_STICKY').then((r)=>{window.__nh=r;});1" >/dev/null
  e2e_wait_eval "$1" "String(window.__nh!==undefined)" "true"
  e2e_read "$1" "String(window.__nh)"
}
boot_label() {
  auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1
}
evl() {
  auto "{\"id\":$(e2e_next_id),\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
launch() {
  e2e_require_clean_slate
  NOTENPAD_LARGE_EDIT_MAX="$LARGE_EDIT_MAX_BYTES" NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-paste.log" 2>&1 &
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
  e2e_require_automation_listener "$OUT/dev-paste.log"
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
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
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
  const searchInput = () => document.querySelector('.search-panel input.cm-textfield');
  // The buttons of the question on screen, or null.
  const buttons = () => { const d = __auto.convertDialog(); return d === null ? null : d.buttons; };
  const kind = () => { const d = __auto.convertDialog(); return d === null ? 'none' : d.kind; };
  // Presses the button at index i (-1: the last, Cancel or the "do not" button).
  const answer = (i) => { const b = buttons(); if (b === null) { return false; } return __auto.convertAnswer(b[i < 0 ? b.length - 1 : i]); };
  const isAll = (line, col) => {
    const g = __auto.windowedGlobalSel();
    return g !== null && g.anchor.line === 0 && g.anchor.col === 0 && g.head.line === line && g.head.col === col;
  };
  return { content, press, mod, searchInput, buttons, kind, answer, isAll, focus: () => content().focus() };
})();
'ok'
JS
HELPERS="${HELPERS//__MOD__/$MODPROP}"
# --- The system clipboard ----------------------------------------------------
if [ "$ENV_NAME" = "windows" ]; then
  cat >"$OUT/clip-text.ps1" <<'PSEOF'
$t = Get-Clipboard -Raw
if ($null -eq $t) { exit 0 }
[Console]::Out.Write($t)
PSEOF
  cat >"$OUT/clip-set.ps1" <<'PSEOF'
param([string]$Text)
Set-Clipboard -Value $Text
PSEOF
  cat >"$OUT/clip-set-file.ps1" <<'PSEOF'
param([string]$Path)
Set-Clipboard -Value ([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8))
PSEOF
  cat >"$OUT/private-bytes.ps1" <<'PSEOF'
$p = Get-Process -Name note-n-pad -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $p) { Write-Output 0; exit 0 }
Write-Output $p.PrivateMemorySize64
PSEOF
  ps_file() {
    powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$OUT/$1")" "${@:2}" | tr -d '\r'
  }
fi
clip_text() {
  case "$ENV_NAME" in
    macos) LANG=en_US.UTF-8 pbpaste ;;
    windows) ps_file clip-text.ps1 ;;
  esac
}
clip_set() {
  case "$ENV_NAME" in
    macos) printf '%s' "$1" | LANG=en_US.UTF-8 pbcopy ;;
    windows) ps_file clip-set.ps1 "$1" ;;
  esac
}
# The file $1 (UTF-8) onto the system clipboard.
clip_set_file() {
  case "$ENV_NAME" in
    macos) LANG=en_US.UTF-8 pbcopy <"$1" ;;
    windows) ps_file clip-set-file.ps1 "$(cygpath -w "$1")" ;;
  esac
}
app_private_bytes() {
  case "$ENV_NAME" in
    macos)
      local pid
      pid=$(pgrep -x note-n-pad | head -1)
      if [ -z "$pid" ]; then
        echo 0
        return 0
      fi
      footprint -j "$OUT/footprint.json" "$pid" >/dev/null 2>&1
      jq -r '.processes[0].footprint // 0' "$OUT/footprint.json" 2>/dev/null || echo 0
      ;;
    windows) ps_file private-bytes.ps1 ;;
    *) echo 0 ;;
  esac
}
clip_status() {
  evl "$DL" "window.__cs=undefined;__auto.clipStatus().then((r)=>{window.__cs=r;},(e)=>{window.__cs='error: '+e;});1" >/dev/null
  e2e_wait_eval "$DL" "String(window.__cs!==undefined)" "true"
  e2e_read "$DL" "JSON.stringify({s:window.__cs})"
}
clip_id() {
  clip_status | jq -r '.s.id // empty'
}
# Wait for a clip other than $1 to be on the clipboard; sets CLIP_ID and PEAK.
wait_clip() {
  local tries=0 mem
  PEAK=0
  CLIP_ID=""
  while [ "$tries" -lt 240 ]; do
    CLIP_ID=$(clip_id)
    if [ -n "$CLIP_ID" ] && [ "$CLIP_ID" != "$1" ]; then
      break
    fi
    mem=$(app_private_bytes)
    if [ "$mem" -gt "$PEAK" ]; then
      PEAK=$mem
    fi
    sleep 0.5
    tries=$((tries + 1))
  done
  mem=$(app_private_bytes)
  if [ "$mem" -gt "$PEAK" ]; then
    PEAK=$mem
  fi
}
check_memory() {
  local growth=$((PEAK - MEM_BEFORE))
  echo "private memory before: $MEM_BEFORE, peak: $PEAK, growth: $growth"
  if [ "$MEM_BEFORE" -le 0 ] || [ "$PEAK" -le 0 ]; then
    bad "$1: the private memory could not be measured (before: $MEM_BEFORE, peak: $PEAK)"
  elif [ "$growth" -le "$MEM_LIMIT" ]; then
    ok "$1: the private memory grew by at most $((MEM_LIMIT / MIB)) MB"
  else
    bad "$1: the private memory grew by $growth bytes (more than $((MEM_LIMIT / MIB)) MB)"
  fi
}
cv_files() {
  local n=0 f
  for f in "$APPDIR"/windowed-tmp/cv-*; do
    if [ -e "$f" ]; then
      n=$((n + 1))
    fi
  done
  echo "$n"
}
# --- Steps -------------------------------------------------------------------
# Wait for the question of the conversion of kind $2 in window $1.
wait_dialog() {
  e2e_wait_eval "$1" "__t.kind()" "$2"
}
# The text of the paste: the file it is on the clipboard from, and the
# JavaScript that makes the same text in the page (where there are no clips the
# event carries it).
#   ok:    OK_N x, a break, "end"          emoji: OK_N x and an emoji
#   big:   BIG_N x                          note:  NOTE_N x
js_paste() {
  case "$1" in
    ok) echo "'x'.repeat($OK_N)+'\\nend'" ;;
    emoji) echo "'x'.repeat($OK_N)+'😀'" ;;
    big) echo "'x'.repeat($BIG_N)" ;;
    note) echo "'x'.repeat($NOTE_N)" ;;
  esac
}
# Paste the text $2 into window $1.
do_paste() {
  local label="$1" kind="$2"
  if has_clipboard; then
    clip_set_file "$WORK/paste-$kind.txt"
    evl "$label" "window.__pr=undefined;window.__pr=__auto.pasteText('');1" >/dev/null
  else
    evl "$label" "window.__pr=undefined;window.__pr=__auto.pasteText($(js_paste "$kind"));1" >/dev/null
  fi
}
# Put the caret of the active document at its end.
caret_end() {
  evl "$DL" "(()=>{const n=__auto.getContent().length;__auto.setDocSelection(n,n);return 1;})()" >/dev/null
}
# Wait for a tab that a paste made, unsaved, and read what it says.
ctinfo() {
  evl "$DL" "window.__ci=undefined;__auto.convertTabInfo().then((r)=>{window.__ci=r;});1" >/dev/null
  e2e_wait_eval "$DL" "String(window.__ci!==undefined)" "true"
  e2e_read "$DL" "JSON.stringify(window.__ci)"
}
wait_converted() {
  e2e_wait_eval "$DL" "String(__auto.isWindowedTab())" "true"
}
# Save the active tab: $1 the path, or none for the file it has. Waits for it;
# with SAVE_DIAG set, the page is watched meanwhile (diag_save).
save_to() {
  evl "$DL" "window.__sv=undefined" >/dev/null
  if [ -n "${1:-}" ]; then
    evl "$DL" "__auto.saveActive('$1').then((r)=>{window.__sv=r;});1" >/dev/null
  else
    evl "$DL" "__auto.saveActive().then((r)=>{window.__sv=r;});1" >/dev/null
  fi
  if [ -n "${SAVE_DIAG:-}" ]; then
    diag_save "$SAVE_DIAG"
  fi
  e2e_wait_eval "$DL" "String(window.__sv!==undefined)" "true"
  check "the save ended well" "$(e2e_read "$DL" "String(window.__sv)")" "true"
}
# Close the active tab without saving, through the app's own close.
close_tab() {
  evl "$DL" "__auto.closeActiveTab()" >/dev/null
}
tab_count() {
  e2e_read "$DL" "String(__auto.getTabs().length)"
}
# A fresh copy of fixture $1 as a document the suite owns; sets DOC and opens it.
# openTab makes an ordinary tab of a file under the large-file threshold
# (LARGE_FILE_THRESHOLD, 100 MiB), so a large-file tab of base.log or seed.txt
# is asked for with $2 = windowed (windowedOpen, as e2e-select-all.sh does).
NEXT=0
DOC=""
open_fresh() {
  NEXT=$((NEXT + 1))
  DOC="$WORK/run$NEXT.${1##*.}"
  cp "$WORK/$1" "$DOC"
  if [ "${2:-}" = "windowed" ]; then
    evl "$DL" "__auto.windowedOpen('$DOC').then((r)=>{window.__ow=r;});1" >/dev/null
    e2e_wait_eval "$DL" "String(__auto.getTabs().some((t)=>t.path==='$DOC' && t.active) && __auto.isWindowedTab() && __auto.windowedInfo().windowStartLine===0)" "true"
    check "$1 opened without refusal" "$(e2e_read "$DL" "String(window.__ow===null)")" "true"
  else
    evl "$DL" "__auto.openTab('$DOC')" >/dev/null
    e2e_wait_eval "$DL" "String(__auto.getTabs().some((t)=>t.path==='$DOC' && t.active))" "true"
  fi
  evl "$DL" "__t.focus()" >/dev/null
  e2e_wait_eval "$DL" "String(document.activeElement===__t.content())" "true"
}
# Close every tab but the first, whatever they hold: changes are discarded first.
back_to_seed() {
  local n now
  n=$(tab_count)
  while [ "$n" -gt 1 ]; do
    evl "$DL" "(async()=>{if(__auto.isWindowedTab()){await __auto.windowedDiscard();}__auto.closeActiveTab();})();1" >/dev/null
    sleep 2
    if [ "$(e2e_read "$DL" "String(__auto.oversizedGateVisible())")" = "true" ]; then
      evl "$DL" "__auto.oversizedGateDiscard()" >/dev/null
      sleep 1
    fi
    now=$(tab_count)
    if [ "$now" = "$n" ]; then
      break
    fi
    n=$now
  done
}
# One diagnostic line: shortened in the log, whole in $DIAG_LOG.
diag_line() {
  echo "DIAG $1: $(e2e_show "$2")"
  printf 'DIAG %s: %s\n' "$1" "$2" >>"$DIAG_LOG"
}
# Every tab (id, active, windowed, converted), the conversions under way and how
# the last conversion ended. $1 names the moment.
diag_convert_state() {
  # Held in a variable: bash 3.2 brace-expands {a,b} in a double-quoted string nested in "$( )".
  local tabs_js='JSON.stringify(__auto.getTabs().map((t)=>({id:t.id,active:t.active,windowed:t.windowed,converted:t.converted})))'
  diag_line "$1 tabs" "$(e2e_read "$DL" "$tabs_js")"
  diag_line "$1 convertJobs" "$(e2e_read "$DL" "JSON.stringify(__auto.convertJobs())")"
  diag_line "$1 lastConvertExit" "$(e2e_read "$DL" "JSON.stringify(__auto.lastConvertExit())")"
}
# After a save was started: once a second, until it ended or 60 seconds are
# over, how long ago the page's timer last ran (a page whose script is stuck
# stops it) and whether the save has ended. $1 names the section.
diag_save() {
  local started second=0 ended
  started=$(date +%s)
  while [ "$second" -le 60 ]; do
    diag_line "$1 t=${second}s timerAge" "$(e2e_read "$DL" "String(Math.round(performance.now()-window.__tick))")"
    ended="$(e2e_read "$DL" "String(window.__sv!==undefined)")"
    diag_line "$1 t=${second}s saveEnded" "$ended"
    if [ "$ended" = "true" ]; then
      return 0
    fi
    sleep 1
    second=$(($(date +%s) - started))
  done
}
# After the answer Continue: once a second, until the tab is a converted tab or
# 60 seconds are over, what the page says. $1 names the section.
diag_convert() {
  local started second=0 info
  started=$(date +%s)
  while [ "$second" -le 60 ]; do
    diag_convert_state "$1 t=${second}s"
    diag_line "$1 t=${second}s dialog" "$(e2e_read "$DL" "JSON.stringify(__auto.convertDialog())")"
    evl "$DL" "window.__ci=undefined;__auto.convertTabInfo().then((r)=>{window.__ci=r;});1" >/dev/null
    e2e_wait_until 5 _e2e_eval_equals "$DL" "String(window.__ci!==undefined)" "true"
    info="$(e2e_read "$DL" "JSON.stringify(window.__ci)")"
    diag_line "$1 t=${second}s tabInfo" "$info"
    diag_line "$1 t=${second}s isWindowedTab" "$(e2e_read "$DL" "String(__auto.isWindowedTab())")"
    diag_line "$1 t=${second}s errors" "$(e2e_read "$DL" "JSON.stringify(window.__errs)")"
    if [ "$(printf '%s' "$info" | jq -r '.converted != null' 2>/dev/null)" = "true" ]; then
      return 0
    fi
    sleep 1
    second=$(($(date +%s) - started))
  done
}
# A document that holds the pasted text and the question, confirm: continues.
# With $2, the page is watched after the answer (diag_convert).
paste_and_continue() {
  do_paste "$DL" "$1"
  wait_dialog "$DL" confirm
  check "the question is the one of D8: Continue first, Cancel last" "$(e2e_read "$DL" "JSON.stringify(__t.buttons())")" '["Continue","Cancel"]'
  evl "$DL" "__t.answer(0)" >/dev/null
  if [ -n "${2:-}" ]; then
    diag_convert "$2"
  fi
  wait_converted
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
if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is needed"
  exit 1
fi

echo "=== fixtures ==="
rm -rf "$WORK"
mkdir -p "$WORK"
python3 - <<PYEOF
import os
w = '$WORK'
ok_n, big_n, note_n = $OK_N, $BIG_N, $NOTE_N
def put(name, data):
    with open(os.path.join(w, name), 'wb') as f:
        f.write(data)
paste_ok = ('x' * ok_n + '\nend').encode()
paste_emoji = ('x' * ok_n + '\U0001F600').encode()
put('paste-ok.txt', paste_ok)
put('paste-emoji.txt', paste_emoji)
put('paste-big.txt', ('x' * big_n).encode())
put('paste-note.txt', ('x' * note_n).encode())
put('seed.txt', b'seed\n')
put('plain.txt', b'abc')
put('crlf.txt', b'one\r\ntwo')
put('sjis.txt', 'あいう'.encode('shift_jis'))
put('bom.txt', b'\xef\xbb\xbfbom')
put('ref-plain.txt', b'abc' + paste_ok)
put('ref-crlf.txt', b'one\r\ntwo' + paste_ok.replace(b'\n', b'\r\n'))
put('ref-sjis.txt', 'あいう'.encode('shift_jis') + paste_ok)
put('ref-bom.txt', b'\xef\xbb\xbfbom' + paste_ok)
put('ref-sjis-utf8.txt', 'あいう'.encode('utf-8') + paste_emoji)
put('ref-big.txt', b'abc' + ('x' * big_n).encode())
put('ref-note.txt', ('x' * note_n).encode())
def write(path, n):
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
write(os.path.join(w, 'base.log'), $N_LINES)
write(os.path.join(w, 'mid.log'), $MID_LINES)
write(os.path.join(w, 'big.log'), $BIG_LINES)
PYEOF
BASE_SHA=$(file_sha256 "$WORK/base.log")
BIG_SHA=$(file_sha256 "$WORK/big.log")
check "base.log has the size of $N_LINES lines" "$(file_size "$WORK/base.log")" "$BASE_SIZE"
check "mid.log has the size of $MID_LINES lines" "$(file_size "$WORK/mid.log")" "$MID_SIZE"
check "big.log has the size of $BIG_LINES lines" "$(file_size "$WORK/big.log")" "$BIG_SIZE"

CREATED_STICKY=""
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
    if [ -n "${ORIG_TARGET:-}" ]; then
      evl "$dl" "__auto.setOpenTarget('$ORIG_TARGET')" >/dev/null 2>&1
    fi
    if [ -n "$CREATED_STICKY" ]; then
      evl "$dl" "window.__TAURI_INTERNALS__.invoke('delete_note',{id:'$CREATED_STICKY'})" >/dev/null 2>&1
    fi
  fi
  quit_app
  if [ -f "$APPDIR/settings.json" ]; then
    for pair in "language:${ORIG_LANG:-}" "large_open_mode:${ORIG_MODE:-}" "large_select_all:${ORIG_SELECT:-}" "open_target:${ORIG_TARGET:-}"; do
      key="${pair%%:*}"
      val="${pair#*:}"
      if [ -n "$val" ]; then
        jq --arg k "$key" --arg v "$val" '.[$k] = $v' "$APPDIR/settings.json" >"$APPDIR/settings.json.tmp" \
          && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
      fi
    done
  fi
  if [ -n "$CREATED_STICKY" ]; then
    case "$CREATED_STICKY" in
      *[!0-9a-f-]*) ;;
      *) rm -f "$STORE/$CREATED_STICKY.json" ;;
    esac
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
BASE_DL="$DL"
e2e_wait_eval "$DL" "String(typeof __auto!=='undefined' && typeof __auto.convertTabInfo==='function' && typeof __auto.convertDialog==='function' && __auto.getTabs().length===1)" "true"
ORIG_LANG=$(e2e_read "$DL" "String(__auto.getLanguage())")
ORIG_MODE=$(e2e_read "$DL" "String(__auto.getLargeOpenMode())")
ORIG_SELECT=$(e2e_read "$DL" "String(__auto.largeSelectAllMode())")
ORIG_TARGET="$(jq -r '.open_target // empty' "$APPDIR/settings.json" 2>/dev/null)"
if [ -z "$ORIG_TARGET" ]; then
  ORIG_TARGET="tab"
fi
echo "original language: $ORIG_LANG, large_open_mode: $ORIG_MODE, large_select_all: $ORIG_SELECT, open_target: $ORIG_TARGET"
evl "$DL" "__auto.setLanguage('en')" >/dev/null
evl "$DL" "__auto.setLargeSelectAll('file')" >/dev/null
e2e_wait_setting large_select_all "file"
evl "$DL" "__auto.setLargeOpenMode('edit')" >/dev/null
e2e_wait_setting large_open_mode "edit"
auto "{\"id\":2,\"cmd\":\"focus\",\"label\":\"$DL\"}" >/dev/null
sleep 1
check "setup: the window has OS focus" "$(e2e_read "$DL" "String(document.hasFocus())")" "true"
evl "$DL" "$HELPERS" >/dev/null
check "helpers installed" "$(e2e_read "$DL" "typeof __t")" "object"

echo "=== 1. [all] a document pasted too much into asks first; cancel changes nothing, continue converts ==="
open_fresh plain.txt
caret_end
do_paste "$DL" ok
wait_dialog "$DL" confirm
check "the tab is locked while the question is up" "$(e2e_read "$DL" "String(__auto.pasteLocked())")" "true"
check "the question is the one of D8" "$(e2e_read "$DL" "__auto.convertDialog().message")" "There is too much content. It will be converted to a large file. Continue?"
evl "$DL" "__t.answer(-1)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.pasteLocked())" "false"
check "cancel left the document as it was" "$(e2e_read "$DL" "__auto.getContent()")" "abc"
check "cancel left the tab ordinary" "$(e2e_read "$DL" "String(__auto.isWindowedTab())")" "false"
check "cancel wrote no conversion file" "$(cv_files)" "0"
do_paste "$DL" ok
wait_dialog "$DL" confirm
diag_convert_state "1 before Continue"
evl "$DL" "__t.answer(0)" >/dev/null
diag_convert "1"
wait_converted
INFO=$(ctinfo)
check "the tab is unsaved" "$(printf '%s' "$INFO" | jq -r '.dirty')" "true"
check "the tab remembers the file it came from" "$(printf '%s' "$INFO" | jq -r '.converted.target')" "$DOC"
check "the tab is not saved yet" "$(printf '%s' "$INFO" | jq -r '.converted.saved')" "false"
check "the lock is off" "$(e2e_read "$DL" "String(__auto.pasteLocked())")" "false"
save_to
check "the saved file is the document and the pasted text (SHA-256)" "$(file_sha256 "$DOC")" "$(file_sha256 "$WORK/ref-plain.txt")"
INFO=$(ctinfo)
check "the tab is a plain large file after the save" "$(printf '%s' "$INFO" | jq -r '.converted')" "null"
check "no conversion file is left" "$(cv_files)" "0"
back_to_seed

echo "=== 2. [all] an untitled document asks where it goes at its first save ==="
evl "$DL" "__auto.newTab()" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length===2 && __auto.getTabs()[1].active)" "true"
evl "$DL" "__t.focus()" >/dev/null
e2e_wait_eval "$DL" "String(document.activeElement===__t.content())" "true"
paste_and_continue ok "2"
INFO=$(ctinfo)
check "an untitled tab has no file to write to" "$(printf '%s' "$INFO" | jq -r '.converted.target')" "null"
SAVED_TO="$WORK/untitled-saved.txt"
evl "$DL" "window.__tick=performance.now();window.__tickTimer=setInterval(()=>{window.__tick=performance.now();},100);1" >/dev/null
SAVE_DIAG="2" save_to "$SAVED_TO"
evl "$DL" "clearInterval(window.__tickTimer);1" >/dev/null
diag_line "2 save result" "$(e2e_read "$DL" "String(window.__sv)")"
diag_line "2 tabs" "$(e2e_read "$DL" "JSON.stringify(__auto.getTabs())")"
check "the saved file is the pasted text (SHA-256)" "$(file_sha256 "$SAVED_TO")" "$(file_sha256 "$WORK/paste-ok.txt")"
check "the tab has the path now" "$(e2e_read "$DL" "__auto.getTabs().find((t)=>t.active).path")" "$SAVED_TO"
back_to_seed

echo "=== 3. [all] the line ending and the encoding are kept; an emoji in Shift_JIS is asked about (D13) ==="
open_fresh crlf.txt
caret_end
paste_and_continue ok
save_to
check "a CRLF document stays CRLF" "$(file_sha256 "$DOC")" "$(file_sha256 "$WORK/ref-crlf.txt")"
back_to_seed
open_fresh sjis.txt
evl "$DL" "__auto.setEncoding('Shift_JIS')" >/dev/null
e2e_wait_eval "$DL" "__auto.getTabs().find((t)=>t.active).encoding" "Shift_JIS"
caret_end
paste_and_continue ok
INFO=$(ctinfo)
check "the encoding is kept" "$(printf '%s' "$INFO" | jq -r '.converted.encoding')" "Shift_JIS"
check "the session writes it" "$(printf '%s' "$INFO" | jq -r '.conv.encoding')" "Shift_JIS"
save_to
check "a Shift_JIS document stays Shift_JIS (SHA-256)" "$(file_sha256 "$DOC")" "$(file_sha256 "$WORK/ref-sjis.txt")"
INFO=$(ctinfo)
check "it is still converted after the save, for it is not plain UTF-8" "$(printf '%s' "$INFO" | jq -r '.converted.saved')" "true"
back_to_seed
open_fresh bom.txt
caret_end
paste_and_continue ok
INFO=$(ctinfo)
check "the byte order mark is kept" "$(printf '%s' "$INFO" | jq -r '.converted.bom')" "true"
save_to
check "a UTF-8 document with a mark keeps it (SHA-256)" "$(file_sha256 "$DOC")" "$(file_sha256 "$WORK/ref-bom.txt")"
back_to_seed
# D13: three ways out of a save that cannot be written in Shift_JIS.
for way in cancel utf8; do
  open_fresh sjis.txt
  evl "$DL" "__auto.setEncoding('Shift_JIS')" >/dev/null
  e2e_wait_eval "$DL" "__auto.getTabs().find((t)=>t.active).encoding" "Shift_JIS"
  caret_end
  paste_and_continue emoji
  evl "$DL" "window.__sv=undefined;__auto.saveActive().then((r)=>{window.__sv=r;});1" >/dev/null
  wait_dialog "$DL" unmappable
  check "$way: the message names the file and the encoding" "$(e2e_read "$DL" "__auto.convertDialog().message")" "“$(basename "$DOC")” contains characters that can’t be represented in Shift_JIS."
  check "$way: three buttons" "$(e2e_read "$DL" "String(__t.buttons().length)")" "3"
  if [ "$way" = "cancel" ]; then
    evl "$DL" "__t.answer(-1)" >/dev/null
    e2e_wait_eval "$DL" "String(window.__sv)" "false"
    check "cancel: the file on disk is as it was" "$(file_sha256 "$DOC")" "$(file_sha256 "$WORK/sjis.txt")"
    check "cancel: the tab is still unsaved" "$(ctinfo | jq -r '.dirty')" "true"
  else
    evl "$DL" "__t.answer(0)" >/dev/null
    e2e_wait_eval "$DL" "String(window.__sv)" "true"
    check "utf8: the file is the text in UTF-8 (SHA-256)" "$(file_sha256 "$DOC")" "$(file_sha256 "$WORK/ref-sjis-utf8.txt")"
    check "utf8: the tab is a plain large file" "$(ctinfo | jq -r '.converted')" "null"
  fi
  back_to_seed
done
skip "3. D13 'save as UTF-8' opens the native save dialog (Vitest covers it)"

echo "=== 4. [all] D16: a result too big to edit ==="
open_fresh plain.txt
caret_end
do_paste "$DL" big
wait_dialog "$DL" confirm
evl "$DL" "__t.answer(0)" >/dev/null
wait_dialog "$DL" tooBig
check "D16: the question has a save button and a do-not-paste button" "$(e2e_read "$DL" "String(__t.buttons().length)")" "2"
evl "$DL" "__t.answer(-1)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.pasteLocked())" "false"
check "do not paste: the document is as it was" "$(e2e_read "$DL" "__auto.getContent()")" "abc"
check "do not paste: no conversion file is left" "$(cv_files)" "0"
do_paste "$DL" big
wait_dialog "$DL" confirm
evl "$DL" "__t.answer(0)" >/dev/null
wait_dialog "$DL" tooBig
evl "$DL" "__t.answer(0)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.isLargeTab())" "true"
check "save: the file is the document and the pasted text (SHA-256)" "$(file_sha256 "$DOC")" "$(file_sha256 "$WORK/ref-big.txt")"
check "save: no conversion file is left" "$(cv_files)" "0"
back_to_seed

echo "=== 5. [all] the tab is held while it is converted ==="
open_fresh plain.txt
caret_end
do_paste "$DL" ok
wait_dialog "$DL" confirm
evl "$DL" "__auto.openFindReplace()" >/dev/null
sleep 1
evl "$DL" "__auto.menuAction('undo');__auto.menuAction('redo');1" >/dev/null
evl "$DL" "(()=>{for (const n of ['replace','replaceAll']) { document.querySelector('.cm-search button[name='+n+']')?.click(); } return 1;})()" >/dev/null
check "undo, redo, replace and replace all changed nothing" "$(e2e_read "$DL" "__auto.getContent()")" "abc"
evl "$DL" "__t.answer(-1)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.pasteLocked())" "false"
back_to_seed

echo "=== 6. [all] a sticky note pasted too much becomes a tab of a document window ==="
# A sticky note of its own for this suite.
CREATED_STICKY="$(auto '{"id":5,"cmd":"new_sticky"}' | jq -r '.data.id // empty' | tr -d '\r')"
e2e_wait_until 60 note_exists
STICKY="$(note_label)"
if [ -z "$STICKY" ]; then
  echo "FATAL: no sticky window"
  exit 1
fi
for mode in tab window; do
  echo "--- open target: $mode ---"
  evl "$DL" "__auto.setOpenTarget('$mode')" >/dev/null
  e2e_wait_setting open_target "$mode"
  STICKY="$(note_label)"
  BEFORE_LABELS="$(doc_labels)"
  evl "$STICKY" "$HELPERS" >/dev/null
  evl "$STICKY" "document.querySelector('.cm-content').focus()" >/dev/null
  sleep 1
  do_paste "$STICKY" note
  wait_dialog "$STICKY" confirm
  evl "$STICKY" "__t.answer(0)" >/dev/null
  e2e_wait_until 180 note_gone
  check "the window of the note closed" "$(note_label)" ""
  if [ "$mode" = "window" ]; then
    NEW_DL=""
    tries=0
    while [ -z "$NEW_DL" ] && [ "$tries" -lt 60 ]; do
      NEW_DL="$(new_doc_label "$BEFORE_LABELS")"
      sleep 1
      tries=$((tries + 1))
    done
    check "a window of its own opened for the note" "$([ -n "$NEW_DL" ] && echo yes || echo no)" "yes"
    DL="${NEW_DL:-$DL}"
    evl "$DL" "$HELPERS" >/dev/null
  fi
  e2e_wait_eval "$DL" "String(typeof __auto!=='undefined' && typeof __auto.isWindowedTab==='function' && __auto.isWindowedTab())" "true"
  check "the note is a tab with no file yet" "$(ctinfo | jq -r '.converted.target')" "null"
  check "the note's record is still there, but no list shows it" "$(note_handed_off "$DL")" "true"
  check "the list of notes has no such note" "$(note_listed "$DL")" "false"
  if [ "$mode" = "tab" ]; then
    # Changes discarded: the note comes back.
    evl "$DL" "__auto.windowedDiscard();1" >/dev/null
    e2e_wait_until 60 note_exists
    check "the note is back after the changes are discarded" "$(note_exists && echo yes || echo no)" "yes"
    check "the note is not handed off any more" "$(note_handed_off "$DL")" "false"
    check "the list of notes has the note again" "$(note_listed "$DL")" "true"
    DL="$BASE_DL"
    back_to_seed
  else
    # Saved: the record is gone.
    NOTE_SAVED="$WORK/note-saved.txt"
    save_to "$NOTE_SAVED"
    check "the note's text is the file (SHA-256)" "$(file_sha256 "$NOTE_SAVED")" "$(file_sha256 "$WORK/ref-note.txt")"
    check "the note's record is deleted by the first save" "$([ -e "$STORE/$CREATED_STICKY.json" ] && echo yes || echo no)" "no"
    check "the list of notes has no such note after the save" "$(note_listed "$DL")" "false"
    CREATED_STICKY=""
    DL="$BASE_DL"
    back_to_seed
  fi
done

echo "=== 7. [macOS, Windows] a clip of 110 MB is pasted from its file, never read by the page ==="
if has_clipboard; then
  evl "$DL" "__auto.setOpenTarget('tab')" >/dev/null
  DL="$BASE_DL"
  open_fresh big.log
  evl "$DL" "__t.focus()" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.isWindowedTab())" "true"
  PREV_ID=$(clip_id)
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($BIG_END_LINE,$END_COL))" "true"
  MEM_BEFORE=$(app_private_bytes)
  evl "$DL" "__auto.windowedCopy()" >/dev/null
  wait_clip "$PREV_ID"
  # Another windowed tab to paste into: a file the paste replaces.
  evl "$DL" "__auto.closeActiveTab()" >/dev/null
  open_fresh base.log windowed
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($END_LINE,$END_COL))" "true"
  evl "$DL" "window.__pr=__auto.pasteText('');1" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__auto.windowedInfo().totalBytes)" "$BIG_SIZE"
  mem=$(app_private_bytes)
  if [ "$mem" -gt "$PEAK" ]; then
    PEAK=$mem
  fi
  check "the page was not asked for the text of the paste" "$(e2e_read "$DL" "String(window.__pr.getDataCalls)")" "0"
  check_memory "paste of the clip"
  save_to
  check "the saved file is the pasted file (SHA-256)" "$(file_sha256 "$DOC")" "$BIG_SHA"
  back_to_seed
else
  skip "7. a clip of 110 MB pasted from its file (macOS and Windows)"
fi

echo "=== 8. [macOS, Windows] a clip over the limit pasted into a document asks (D8) ==="
# mid.log is over the 100 MiB a document may hold and, pasted into abc, under the
# 101 MiB that can be edited: Continue makes an editable large file (D8). big.log
# is over the editable limit as well: after Continue the question of D16 comes.
if has_clipboard; then
  for src in mid big; do
    echo "--- $src.log ---"
    if [ "$src" = "mid" ]; then
      open_fresh mid.log windowed
      SRC_END_LINE=$MID_END_LINE
    else
      open_fresh big.log
      SRC_END_LINE=$BIG_END_LINE
    fi
    evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
    e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($SRC_END_LINE,$END_COL))" "true"
    PREV_ID=$(clip_id)
    evl "$DL" "__auto.windowedCopy()" >/dev/null
    wait_clip "$PREV_ID"
    back_to_seed
    open_fresh plain.txt
    caret_end
    evl "$DL" "window.__pr=__auto.pasteText('');1" >/dev/null
    wait_dialog "$DL" confirm
    evl "$DL" "__t.answer(0)" >/dev/null
    if [ "$src" = "mid" ]; then
      wait_converted
      check "the clip was not read by the page" "$(e2e_read "$DL" "String(window.__pr.getDataCalls)")" "0"
      save_to
      python3 - <<PYEOF
with open('$WORK/ref-clip-doc.txt', 'wb') as out, open('$WORK/mid.log', 'rb') as mid:
    out.write(b'abc')
    while True:
        block = mid.read(1 << 20)
        if not block:
            break
        out.write(block)
PYEOF
      check "the saved file is the document and the clip (SHA-256)" "$(file_sha256 "$DOC")" "$(file_sha256 "$WORK/ref-clip-doc.txt")"
      rm -f "$WORK/ref-clip-doc.txt"
    else
      wait_dialog "$DL" tooBig
      check "D16: the question has a save button and a do-not-paste button" "$(e2e_read "$DL" "String(__t.buttons().length)")" "2"
      check "the clip was not read by the page" "$(e2e_read "$DL" "String(window.__pr.getDataCalls)")" "0"
      evl "$DL" "__t.answer(-1)" >/dev/null
      e2e_wait_eval "$DL" "String(__auto.pasteLocked())" "false"
      check "do not paste: the document is as it was" "$(e2e_read "$DL" "__auto.getContent()")" "abc"
    fi
    back_to_seed
  done
else
  skip "8. a clip pasted into a document over the limit (macOS and Windows)"
fi

echo "=== 9. [macOS, Windows] a clip pasted into the search field is refused ==="
if has_clipboard; then
  open_fresh base.log windowed
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($END_LINE,$END_COL))" "true"
  PREV_ID=$(clip_id)
  evl "$DL" "__auto.windowedCopy()" >/dev/null
  wait_clip "$PREV_ID"
  TOTAL=$(e2e_read "$DL" "String(__auto.windowedInfo().totalBytes)")
  evl "$DL" "__auto.openFind()" >/dev/null
  e2e_wait_eval "$DL" "String(document.activeElement===__t.searchInput())" "true"
  evl "$DL" "window.__pr=__auto.pasteText('');1" >/dev/null
  sleep 2
  check "windowed: the field is as it was" "$(e2e_read "$DL" "__t.searchInput().value")" ""
  check "windowed: the document is as it was" "$(e2e_read "$DL" "String(__auto.windowedInfo().totalBytes)")" "$TOTAL"
  evl "$DL" "__auto.closeFind()" >/dev/null
  back_to_seed
  open_fresh plain.txt
  evl "$DL" "__auto.openFind()" >/dev/null
  e2e_wait_eval "$DL" "String(document.activeElement===document.querySelector('.cm-search input'))" "true"
  evl "$DL" "window.__pr=__auto.pasteText('');1" >/dev/null
  sleep 2
  check "ordinary: the field is as it was" "$(e2e_read "$DL" "document.querySelector('.cm-search input').value")" ""
  check "ordinary: the document is as it was" "$(e2e_read "$DL" "__auto.getContent()")" "abc"
  evl "$DL" "__auto.closeFind()" >/dev/null
  back_to_seed
else
  skip "9. a clip pasted into the search field (macOS and Windows)"
fi

echo "=== 10. [macOS, Windows] typed, pasted and typed again keep their order ==="
if has_clipboard; then
  open_fresh base.log windowed
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($END_LINE,$END_COL))" "true"
  PREV_ID=$(clip_id)
  evl "$DL" "__auto.windowedCopy()" >/dev/null
  wait_clip "$PREV_ID"
  back_to_seed
  # The file the typing, the clip and the typing make, byte for byte.
  {
    printf 'a'
    cat "$WORK/base.log"
    printf 'bseed\n'
  } >"$WORK/ref-order.txt"
  ORDER_SIZE=$(file_size "$WORK/ref-order.txt")
  open_fresh seed.txt windowed
  evl "$DL" "__auto.holdWindowedReads(true)" >/dev/null
  # The caret is at (0, 0), where windowedOpen leaves it. The clip is pasted by
  # the core and waits in the queue behind the a; the b waits behind the paste.
  evl "$DL" "(()=>{document.execCommand('insertText',false,'a');window.__pr=__auto.pasteText('');document.execCommand('insertText',false,'b');return 1;})()" >/dev/null
  evl "$DL" "__auto.holdWindowedReads(false);__auto.releaseWindowedReads()" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__auto.windowedInfo().totalBytes)" "$ORDER_SIZE"
  check "the file is as long as a, the clip, b and seed" "$(e2e_read "$DL" "String(__auto.windowedInfo().totalBytes)")" "$ORDER_SIZE"
  save_to
  check "the file is a, the clip, b, seed (SHA-256)" "$(file_sha256 "$DOC")" "$(file_sha256 "$WORK/ref-order.txt")"
  back_to_seed
else
  skip "10. the order of typing, a clip and typing (macOS and Windows)"
fi

echo "=== 11. [macOS, Windows] a paste right after the copy, while the copy still waits ==="
if has_clipboard; then
  open_fresh big.log
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($BIG_END_LINE,$END_COL))" "true"
  evl "$DL" "window.__rs=undefined" >/dev/null
  evl "$DL" "(()=>{__auto.windowedCopy();return 1;})()" >/dev/null
  open_fresh base.log windowed
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($END_LINE,$END_COL))" "true"
  evl "$DL" "window.__pr=__auto.pasteText('');1" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__auto.windowedInfo().totalBytes)" "$BIG_SIZE"
  check "the page was not asked for the text" "$(e2e_read "$DL" "String(window.__pr.getDataCalls)")" "0"
  save_to
  check "the saved file is the copied file (SHA-256)" "$(file_sha256 "$DOC")" "$BIG_SHA"
  back_to_seed
else
  skip "11. a paste right after the copy (macOS and Windows)"
fi

echo "=== 12. [macOS, Windows] the text of another program is pasted, not the clip ==="
if has_clipboard; then
  open_fresh base.log windowed
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($END_LINE,$END_COL))" "true"
  PREV_ID=$(clip_id)
  evl "$DL" "__auto.windowedCopy()" >/dev/null
  wait_clip "$PREV_ID"
  clip_set "EXTERNAL"
  back_to_seed
  open_fresh plain.txt
  caret_end
  START=$(date +%s)
  evl "$DL" "window.__pr=__auto.pasteText('');1" >/dev/null
  e2e_wait_eval "$DL" "__auto.getContent()" "abcEXTERNAL"
  ELAPSED=$(($(date +%s) - START))
  check "a document got the text of the other program" "$(e2e_read "$DL" "__auto.getContent()")" "abcEXTERNAL"
  if [ "$ELAPSED" -le 3 ]; then
    ok "it arrived within the timeout of the wait (took ${ELAPSED}s with the cost of the eval)"
  else
    bad "it took ${ELAPSED}s"
  fi
  back_to_seed
  open_fresh base.log windowed
  evl "$DL" "__t.focus();__t.mod('Home')" >/dev/null
  evl "$DL" "window.__pr=__auto.pasteText('');1" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__auto.windowedInfo().totalBytes)" "$((BASE_SIZE + 8))"
  check "a large file (the window holds the selection) got it too" "$(e2e_read "$DL" "String(__auto.windowedInfo().totalBytes)")" "$((BASE_SIZE + 8))"
  # A selection no window holds is replaced by the text.
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($END_LINE,$END_COL + 8))" "true"
  evl "$DL" "window.__pr=__auto.pasteText('');1" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__auto.windowedInfo().totalBytes)" "8"
  check "a selection past the window was replaced by it" "$(e2e_read "$DL" "String(__auto.windowedInfo().totalBytes)")" "8"
  back_to_seed
else
  skip "12. the text of another program (macOS and Windows)"
fi

echo "=== 13. [macOS, Windows] a copy that waits in one window is pasted in another ==="
if has_clipboard; then
  open_fresh base.log windowed
  WIN_A="$DL"
  evl "$WIN_A" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$WIN_A" "String(__t.isAll($END_LINE,$END_COL))" "true"
  evl "$WIN_A" "__auto.holdWindowedReads(true)" >/dev/null
  evl "$WIN_A" "__auto.windowedCopy()" >/dev/null
  check "the copy is reserved" "$(e2e_read "$WIN_A" "String(__auto.clipReservations())")" "1"
  open_second "$WIN_A"
  focus_window "$WIN_B"
  evl "$WIN_B" "__t.focus();__auto.setDocSelection(0,0)" >/dev/null
  evl "$WIN_B" "window.__pr=__auto.pasteText('');1" >/dev/null
  evl "$WIN_A" "__auto.holdWindowedReads(false);__auto.releaseWindowedReads()" >/dev/null
  e2e_wait_until 120 _e2e_eval_equals "$WIN_B" "String(__auto.getContent().length)" "$((BASE_SIZE + 5))"
  check "the other window got the copy of this one" "$(e2e_read "$WIN_B" "String(__auto.getContent().length)")" "$((BASE_SIZE + 5))"
  check "and did not read it by itself" "$(e2e_read "$WIN_B" "String(window.__pr.getDataCalls)")" "0"
  DL="$WIN_A"
  back_to_seed
else
  skip "13. a copy that waits in one window, pasted in another (macOS and Windows)"
fi

echo "=== 13b. [macOS, Windows] a copy queued behind a select key copies what the key selected ==="
if has_clipboard; then
  open_fresh base.log windowed
  WIN_A="$DL"
  evl "$WIN_A" "__t.focus();__t.mod('Home')" >/dev/null
  # The reads are held: the select key and the copy wait in the queue, and the
  # selection is still the caret, which one window holds, when the copy is queued.
  evl "$WIN_A" "__auto.holdWindowedReads(true)" >/dev/null
  evl "$WIN_A" "(()=>{__t.mod('End',{shiftKey:true});__auto.windowedCopy();return 1;})()" >/dev/null
  check "the copy is reserved" "$(e2e_read "$WIN_A" "String(__auto.clipReservations())")" "1"
  open_second "$WIN_A"
  focus_window "$WIN_B"
  evl "$WIN_B" "__t.focus();__auto.setDocSelection(0,0)" >/dev/null
  evl "$WIN_B" "window.__pr=__auto.pasteText('');1" >/dev/null
  evl "$WIN_A" "__auto.holdWindowedReads(false);__auto.releaseWindowedReads()" >/dev/null
  e2e_wait_until 120 _e2e_eval_equals "$WIN_B" "String(__auto.getContent().length)" "$((BASE_SIZE + 5))"
  check "the other window got the whole file the key selected, as one clip" "$(e2e_read "$WIN_B" "String(__auto.getContent().length)")" "$((BASE_SIZE + 5))"
  check "and did not read it by itself" "$(e2e_read "$WIN_B" "String(window.__pr.getDataCalls)")" "0"
  DL="$WIN_A"
  back_to_seed
else
  skip "13b. a copy queued behind a select key (macOS and Windows)"
fi

echo "=== 13c. [macOS, Windows] a paste queued in a window the focus leaves is made by the core in order ==="
if has_clipboard; then
  open_fresh base.log windowed
  WIN_A="$DL"
  evl "$WIN_A" "__t.focus();__t.mod('Home')" >/dev/null
  open_second "$WIN_A"
  focus_window "$WIN_A"
  clip_set "EXTQ"
  # A typed key waits behind the held read, the paste behind the key.
  evl "$WIN_A" "__auto.holdWindowedReads(true)" >/dev/null
  evl "$WIN_A" "(()=>{__t.focus();document.execCommand('insertText',false,'a');window.__pr=__auto.pasteText('');return 1;})()" >/dev/null
  focus_window "$WIN_B"
  evl "$WIN_A" "__auto.holdWindowedReads(false);__auto.releaseWindowedReads()" >/dev/null
  e2e_wait_until 120 _e2e_eval_equals "$WIN_A" "String(__auto.windowedInfo().totalBytes)" "$((BASE_SIZE + 5))"
  check "the paste was made in the window it was queued in, after the key" "$(e2e_read "$WIN_A" "String(__auto.windowedInfo().totalBytes)")" "$((BASE_SIZE + 5))"
  check "the window that got the focus is as it was" "$(e2e_read "$WIN_B" "__auto.getContent()")" "seed"
  DL="$WIN_A"
  back_to_seed
else
  skip "13c. a paste queued in a window the focus leaves (macOS and Windows)"
fi

echo "=== 14. [macOS, Windows] a paste held in the core keeps its tab locked across a tab switch ==="
if has_clipboard; then
  open_fresh plain.txt
  FIRST_INDEX=$(e2e_read "$DL" "String(__auto.getTabs().findIndex((t)=>t.active))")
  clip_set "LOCKTEST"
  evl "$DL" "__auto.holdClipStatus(true)" >/dev/null
  evl "$DL" "window.__pr=__auto.pasteText('');1" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.pasteLocked())" "true"
  # Another tab and back again.
  evl "$DL" "__auto.switchTab(0)" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getTabs()[0].active)" "true"
  check "the other tab is not locked for typing" "$(e2e_read "$DL" "String(document.querySelector('.cm-content')!==null)")" "true"
  evl "$DL" "__auto.switchTab($FIRST_INDEX)" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getTabs()[$FIRST_INDEX].active)" "true"
  check "the lock is still on after the switch" "$(e2e_read "$DL" "String(__auto.pasteLocked())")" "true"
  evl "$DL" "__auto.typeText('TYPED')" >/dev/null
  check "typing into the locked tab changes nothing" "$(e2e_read "$DL" "__auto.getContent()")" "abc"
  evl "$DL" "__auto.releaseClipStatus()" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.pasteLocked())" "false"
  evl "$DL" "__auto.typeText('Z')" >/dev/null
  check "typing works again once the lock is off" "$(e2e_read "$DL" "String(__auto.getContent().includes('Z'))")" "true"
  back_to_seed
else
  skip "14. a lock that survives a tab switch (macOS and Windows)"
fi

echo "=== 14b. [macOS] a paste waiting for the text of another program does not follow the focus to another window ==="
if [ "$ENV_NAME" = "macos" ]; then
  open_fresh plain.txt
  WIN_A="$DL"
  open_second "$WIN_A"
  focus_window "$WIN_A"
  clip_set "NOT-FOR-B"
  evl "$WIN_A" "__auto.holdClipStatus(true)" >/dev/null
  evl "$WIN_A" "window.__pr=__auto.pasteText('');1" >/dev/null
  e2e_wait_eval "$WIN_A" "String(__auto.pasteLocked())" "true"
  focus_window "$WIN_B"
  evl "$WIN_A" "__auto.releaseClipStatus()" >/dev/null
  e2e_wait_eval "$WIN_A" "String(__auto.pasteLocked())" "false"
  check "the window that got the focus is as it was" "$(e2e_read "$WIN_B" "__auto.getContent()")" "seed"
  check "the window that pasted is unlocked and as it was" "$(e2e_read "$WIN_A" "__auto.getContent()")" "abc"
  DL="$WIN_A"
  back_to_seed
else
  skip "14b. a paste waiting for the text of another program (macOS only)"
fi

echo "=== 15. [macOS, Windows] a whole line copied with no selection is pasted above the caret line ==="
if has_clipboard; then
  open_fresh base.log windowed
  evl "$DL" "__t.focus();__t.mod('Home')" >/dev/null
  PREV_ID=$(clip_id)
  evl "$DL" "(()=>{__t.press('ArrowDown',{});return 1;})()" >/dev/null
  evl "$DL" "__auto.windowedCopy()" >/dev/null
  evl "$DL" "__t.press('ArrowDown',{});__t.press('ArrowDown',{});window.__pr=__auto.pasteText('');1" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__auto.windowedInfo().totalLines)" "$((N_LINES + 1))"
  check "the file has a line more" "$(e2e_read "$DL" "String(__auto.windowedInfo().totalLines)")" "$((N_LINES + 1))"
  back_to_seed
else
  skip "15. a whole line pasted above the caret line (macOS and Windows)"
fi

echo "=== teardown ==="
if e2e_app_running; then
  check "no exception thrown in the whole run" "$(e2e_read "$DL" "String(window.__errs.length)")" "0"
  evl "$DL" "__auto.setLanguage('$ORIG_LANG')" >/dev/null
  e2e_wait_setting language "$ORIG_LANG"
  evl "$DL" "__auto.setLargeOpenMode('$ORIG_MODE')" >/dev/null
  evl "$DL" "__auto.setLargeSelectAll('$ORIG_SELECT')" >/dev/null
  evl "$DL" "__auto.setOpenTarget('$ORIG_TARGET')" >/dev/null
  quit_app
fi
wipe_test_docs
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
