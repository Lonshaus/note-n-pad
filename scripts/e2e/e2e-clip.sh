#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: copy and cut of a selection larger than one window through a clip file
# (large_select_all = 'file'), and the viewer's copy of the whole file or of a
# line range. The core writes the text to a clip file in windowed-tmp and hands
# it to the system clipboard; the app's memory does not grow with the text.
# Where each row runs (the script picks by uname -s; every row says which):
#   Linux (CI, container): copy and cut change nothing (a Linux build has no
#     clips, so they end as OfferFailed); every other row prints an explicit SKIP.
#   macOS (local and CI): the system clipboard is read with pbpaste, written with
#     pbcopy, and memory is phys_footprint (footprint -j).
#   Windows (CI, the acceptance VM): the clipboard is read with PowerShell
#     Get-Clipboard and written with Set-Clipboard, memory is the private bytes
#     of the process. The rows marked "macOS" alone are not run there.
# Input methods: keys are keydown events dispatched at the editor
# (__auto.windowedPressKey), with Cmd on Darwin and Ctrl elsewhere as the
# modifier; copy and cut are events dispatched at the focused element
# (__auto.windowedCopy, windowedCut, viewerCopy); a field's own copy and cut are
# document.execCommand; a composition is __auto.windowedCompose. The clip
# itself reaches the system clipboard from the core, so these events are enough.
# A real keystroke into a window the app has not made first responder is not
# covered here (see e2e-editor-focus.sh): type without a click by hand.
# The viewer's calls to clip_copy_file cannot be counted by wrapping invoke
# (Tauri defines it read-only); the clip ids carry a number that counts the
# clips this run has made, so a known copy before and after shows how many were
# made in between.
# LESSON: never put `await` inside an eval string; use `.then((r)=>{window.__x=r;})`
# and end a fire-and-forget eval with `;1` so it does not wait for the promise.
# A real Ctrl-C sends SIGINT to the whole process group, so app and node get
# interrupted at once. The trap restores the language and the two large-file
# settings, patching settings.json directly once the app is dead, and wipes this
# suite's own document snapshots (matched by the fixture path).
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/clip-fixture"
PASS=0
FAIL=0
# 20,000 lines of 47 characters and a line break each (the last has none).
N_LINES=20000
LINE_BYTES=48
BASE_SIZE=$((N_LINES * LINE_BYTES - 1))
END_LINE=$((N_LINES - 1))
END_COL=47
# The big file: 2,400,000 such lines, about 110 MB.
BIG_LINES=2400000
BIG_SIZE=$((BIG_LINES * LINE_BYTES - 1))
BIG_END_LINE=$((BIG_LINES - 1))
# The most the main process's private memory may grow while a clip is made.
MEM_LIMIT=$((64 * 1024 * 1024))
mkdir -p "$OUT"
: >"$OUT/dev-clip.log"

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
# Whether this environment hands clips to a system clipboard.
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
wipe_test_docs() {
  for f in "$STORE"/*.json; do
    if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
      FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
      case "$FP" in
        *clip-fixture*)
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
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-clip.log" 2>&1 &
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
  e2e_require_automation_listener "$OUT/dev-clip.log"
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
# The page-side helpers every step below calls as __t.*.
read -r -d '' HELPERS <<'JS'
window.__errs = [];
window.addEventListener('error', (e) => { window.__errs.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => { window.__errs.push(String(e.reason)); });
window.__cp = [];
document.addEventListener('copy', (e) => { window.__cp.push({ type: 'copy', prevented: e.defaultPrevented }); });
document.addEventListener('cut', (e) => { window.__cp.push({ type: 'cut', prevented: e.defaultPrevented }); });
window.__t = (() => {
  const content = () => {
    const all = [...document.querySelectorAll('.cm-content')];
    return all.find((el) => el.getClientRects().length > 0) || all[0];
  };
  const press = (k, mods) => __auto.windowedPressKey(k, mods || {});
  const mod = (k, extra) => press(k, Object.assign({ __MOD__: true }, extra || {}));
  const isAll = (line, col) => {
    const g = __auto.windowedGlobalSel();
    return g !== null && g.anchor.line === 0 && g.anchor.col === 0 && g.head.line === line && g.head.col === col;
  };
  const collapsed = () => {
    const g = __auto.windowedGlobalSel();
    return g !== null && g.anchor.line === g.head.line && g.anchor.col === g.head.col;
  };
  const traced = (at) => __auto.windowedTrace().filter((e) => e.at === at).length;
  const searchInput = () => document.querySelector('.search-panel input.cm-textfield');
  // Put text in the search field and select it, as a user typing and then
  // selecting would; the field takes focus first.
  const fill = (text) => {
    const input = searchInput();
    input.focus();
    input.select();
    document.execCommand('insertText', false, text);
    input.select();
    return input.value;
  };
  return { content, press, mod, isAll, collapsed, traced, searchInput, fill, focus: () => content().focus() };
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
# The SHA-256 of bytes [$2, $3) of file $1.
range_sha256() {
  python3 - "$1" "$2" "$3" <<'PYEOF'
import hashlib
import sys

path, start, end = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
h = hashlib.sha256()
with open(path, 'rb') as f:
    f.seek(start)
    left = end - start
    while left > 0:
        block = f.read(min(left, 1 << 20))
        if not block:
            break
        h.update(block)
        left -= len(block)
print(h.hexdigest())
PYEOF
}
# Wait for no swap and an empty queue, then a moment for what a settled editor
# may still start.
settle() {
  e2e_wait_until "${1:-300}" _e2e_eval_equals "$DL" "$(js_settled)" "true"
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
# Select All of a file whose last line is $1 (0-based) and is 47 characters.
select_all() {
  evl "$DL" "__t.focus();__t.mod('a')" >/dev/null
  e2e_wait_until 600 _e2e_eval_equals "$DL" "String(__t.isAll($1,$END_COL))" "true"
}
total() {
  e2e_read "$DL" "$(js_total)"
}
dirty() {
  e2e_read "$DL" "String(__auto.windowedInfo().dirty)"
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
# Open $1 for windowed editing as tab number $2 (1-based) and give the editor
# focus.
open_windowed() {
  evl "$DL" "__auto.windowedOpen('$1').then((r)=>{window.__ow=r;});1" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getTabs().length===$2 && __auto.getTabs()[$2-1].active && __auto.isWindowedTab() && __auto.windowedInfo().windowStartLine===0)" "true"
  check "$1 opened without refusal" "$(e2e_read "$DL" "String(window.__ow===null)")" "true"
  evl "$DL" "__t.focus()" >/dev/null
  e2e_wait_eval "$DL" "String(document.activeElement===__t.content())" "true"
}
# Close the active tab, back to the seed tab. A tab nothing changed closes
# without a save.
close_tab() {
  evl "$DL" "__auto.closeActiveTab()" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getTabs().length)" "1"
}
# Save, then close.
close_windowed() {
  save_active
  close_tab
}
NEXT=0
DOC=""
# A copy of the base file nothing else uses; sets DOC.
fresh_doc() {
  NEXT=$((NEXT + 1))
  DOC="$WORK/doc$NEXT.log"
  cp "$WORK/base.log" "$DOC"
}
begin_doc() {
  fresh_doc
  open_windowed "$DOC" 2
}
# --- The system clipboard ----------------------------------------------------
# The helpers for PowerShell are files, so no quoting crosses Git Bash.
if [ "$ENV_NAME" = "windows" ]; then
  mkdir -p "$OUT"
  cat >"$OUT/clip-digest.ps1" <<'PSEOF'
$t = Get-Clipboard -Raw
if ($null -eq $t) { Write-Output '0 empty'; exit 0 }
$b = [Text.Encoding]::UTF8.GetBytes($t)
$sha = [Security.Cryptography.SHA256]::Create()
$h = [BitConverter]::ToString($sha.ComputeHash($b)).Replace('-', '').ToLower()
Write-Output "$($b.Length) $h"
PSEOF
  cat >"$OUT/clip-set.ps1" <<'PSEOF'
param([string]$Text)
Set-Clipboard -Value $Text
PSEOF
  cat >"$OUT/clip-text.ps1" <<'PSEOF'
$t = Get-Clipboard -Raw
if ($null -eq $t) { exit 0 }
[Console]::Out.Write($t)
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
# "<bytes> <sha256>" of the text on the system clipboard, as UTF-8.
clip_digest() {
  case "$ENV_NAME" in
    macos)
      LANG=en_US.UTF-8 pbpaste >"$OUT/clip.out"
      echo "$(file_size "$OUT/clip.out") $(file_sha256 "$OUT/clip.out")"
      rm -f "$OUT/clip.out"
      ;;
    windows)
      ps_file clip-digest.ps1
      ;;
  esac
}
# The text on the system clipboard (short texts only).
clip_text() {
  case "$ENV_NAME" in
    macos)
      LANG=en_US.UTF-8 pbpaste
      ;;
    windows)
      ps_file clip-text.ps1
      ;;
  esac
}
# Put $1 on the system clipboard from outside the app.
clip_set() {
  case "$ENV_NAME" in
    macos)
      printf '%s' "$1" | LANG=en_US.UTF-8 pbcopy
      ;;
    windows)
      ps_file clip-set.ps1 "$1"
      ;;
  esac
}
# Private memory of the main process in bytes: phys_footprint on macOS, the
# private bytes on Windows; 0 where it is not measured.
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
    windows)
      ps_file private-bytes.ps1
      ;;
    *)
      echo 0
      ;;
  esac
}
# What clip_status() says now, as {"s": ...}: a null result would read as a
# failed measurement.
clip_status() {
  evl "$DL" "window.__cs=undefined;__auto.clipStatus().then((r)=>{window.__cs=r;},(e)=>{window.__cs='error: '+e;});1" >/dev/null
  e2e_wait_eval "$DL" "String(window.__cs!==undefined)" "true"
  e2e_read "$DL" "JSON.stringify({s:window.__cs})"
}
clip_id() {
  clip_status | jq -r '.s.id // empty'
}
# The number a clip id carries: how many clips this run had made when it began.
clip_seq() {
  printf '%s' "$1" | cut -d- -f2
}
# Wait for a clip other than $1 to be on the clipboard; sets CLIP_ID and, the
# private memory being polled meanwhile, PEAK.
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
# The clip files in the temp folder.
clip_files() {
  local n=0 f
  for f in "$APPDIR"/windowed-tmp/clip-*; do
    if [ -e "$f" ]; then
      n=$((n + 1))
    fi
  done
  echo "$n"
}
# Whether a cliphelper.exe is running (Windows).
helper_running() {
  tasklist //FI "IMAGENAME eq cliphelper.exe" 2>/dev/null | grep -q cliphelper.exe
}
helper_gone() {
  ! helper_running
}
# The checks on a clip of the whole file: its size on the system clipboard, the
# numbers clip_status() reports, the memory it took. $1 names the step.
check_big_clip() {
  local digest status
  digest=$(clip_digest)
  check "$1: the clipboard holds the file (bytes and SHA-256)" "$digest" "$BIG_SIZE $BIG_SHA"
  status=$(clip_status)
  check "$1: clip_status bytes" "$(printf '%s' "$status" | jq -r '.s.bytes')" "$BIG_SIZE"
  check "$1: clip_status utf16_len" "$(printf '%s' "$status" | jq -r '.s.utf16_len')" "$BIG_SIZE"
  check "$1: clip_status lines" "$(printf '%s' "$status" | jq -r '.s.lines')" "$BIG_LINES"
  check "$1: clip_status linewise" "$(printf '%s' "$status" | jq -r '.s.linewise')" "false"
}
check_memory() {
  local growth=$((PEAK - MEM_BEFORE))
  echo "private memory before: $MEM_BEFORE, peak: $PEAK, growth: $growth"
  if [ "$growth" -le "$MEM_LIMIT" ]; then
    ok "$1: the private memory grew by at most $((MEM_LIMIT / 1048576)) MB"
  else
    bad "$1: the private memory grew by $growth bytes (more than $((MEM_LIMIT / 1048576)) MB)"
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
if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is needed"
  exit 1
fi

echo "=== fixtures ==="
rm -rf "$WORK"
mkdir -p "$WORK"
# Every line is '0000000001 ' and 36 'x' (47 characters) and an LF, the last line
# without one. base.log has 20,000 lines, big.log 2,400,000 (about 110 MB).
python3 - <<PYEOF
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
write('$WORK/base.log', $N_LINES)
write('$WORK/big.log', $BIG_LINES)
PYEOF
echo "base.log bytes: $(file_size "$WORK/base.log")"
check "base.log has the size of $N_LINES lines" "$(file_size "$WORK/base.log")" "$BASE_SIZE"
check "big.log has the size of $BIG_LINES lines" "$(file_size "$WORK/big.log")" "$BIG_SIZE"
BIG_SHA=$(file_sha256 "$WORK/big.log")
# The big file the cut works on.
cp "$WORK/big.log" "$WORK/big-cut.log"
printf 'seed\n' >"$WORK/seed.txt"
# What the base file holds once every line is indented by two spaces, without
# its first two bytes: the text a copy of the whole selection takes after the
# indentation (the selection then begins behind line 0's new indentation).
python3 - <<PYEOF
import hashlib
lines = [f'{i:010d} ' + 'x' * 36 for i in range(1, $N_LINES + 1)]
text = '\n'.join('  ' + line for line in lines).encode()
open('$WORK/indented.sha', 'w').write(hashlib.sha256(text[2:]).hexdigest())
PYEOF
INDENTED_SHA=$(cat "$WORK/indented.sha")

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
e2e_wait_eval "$DL" "String(typeof __auto!=='undefined' && typeof __auto.windowedOpen==='function' && typeof __auto.clipStatus==='function' && __auto.getTabs().length===1)" "true"
# The settings are the user's real ones: capture them for the trap to restore.
ORIG_LANG=$(e2e_read "$DL" "String(__auto.getLanguage())")
ORIG_MODE=$(e2e_read "$DL" "String(__auto.getLargeOpenMode())")
ORIG_SELECT=$(e2e_read "$DL" "String(__auto.largeSelectAllMode())")
echo "original language: $ORIG_LANG, large_open_mode: $ORIG_MODE, large_select_all: $ORIG_SELECT"
evl "$DL" "__auto.setLanguage('en')" >/dev/null
evl "$DL" "__auto.setLargeSelectAll('file')" >/dev/null
e2e_wait_setting large_select_all "file"
# Xvfb has no window manager, so the window must be given focus or CodeMirror ignores DOM selections.
auto "{\"id\":2,\"cmd\":\"focus\",\"label\":\"$DL\"}" >/dev/null
sleep 1
check "setup: the window has OS focus" "$(e2e_read "$DL" "String(document.hasFocus())")" "true"
evl "$DL" "$HELPERS" >/dev/null
check "helpers installed" "$(e2e_read "$DL" "typeof __t")" "object"
check "the clip hooks are installed" "$(e2e_read "$DL" "String(typeof __auto.windowedCopy==='function' && typeof __auto.windowedCut==='function' && typeof __auto.viewerCopy==='function')")" "true"

echo "=== 1. [macOS, Windows; Linux: nothing changes] Select All and copy of a 110 MB file ==="
open_windowed "$WORK/big.log" 2
check "the big file has the lines" "$(e2e_read "$DL" "String(__auto.windowedInfo().totalLines)")" "$BIG_LINES"
select_all "$BIG_END_LINE"
PREV_ID=$(clip_id)
MEM_BEFORE=$(app_private_bytes)
COPY=$(e2e_read "$DL" "JSON.stringify(__auto.windowedCopy())")
check "copy is prevented" "$(printf '%s' "$COPY" | jq -r '.prevented')" "true"
check "copy writes nothing to the web clipboard" "$(printf '%s' "$COPY" | jq -r '.types')" "0"
if has_clipboard; then
  wait_clip "$PREV_ID"
  check "a clip was offered" "$([ -n "$CLIP_ID" ] && [ "$CLIP_ID" != "$PREV_ID" ] && echo yes || echo no)" "yes"
  check_big_clip "copy"
  check_memory "copy"
else
  settle
  check "no clip is made on this system" "$(clip_status | jq -c '.s')" "null"
  skip "1. the clipboard, clip_status and memory of the copy (macOS and Windows)"
fi
check "the copy left the file as it was" "$(total)" "$BIG_SIZE"
check "the copy left the tab clean" "$(dirty)" "false"
check "the selection is still the file" "$(e2e_read "$DL" "String(__t.isAll($BIG_END_LINE,$END_COL))")" "true"
close_tab
check "the file on disk is as it was" "$(file_sha256 "$WORK/big.log")" "$BIG_SHA"

echo "=== 2. [macOS, Windows; Linux: nothing changes] Select All and cut of a 110 MB file ==="
open_windowed "$WORK/big-cut.log" 2
select_all "$BIG_END_LINE"
PREV_ID=$(clip_id)
CUT=$(e2e_read "$DL" "JSON.stringify(__auto.windowedCut())")
check "cut is prevented" "$(printf '%s' "$CUT" | jq -r '.prevented')" "true"
check "cut writes nothing to the web clipboard" "$(printf '%s' "$CUT" | jq -r '.types')" "0"
if has_clipboard; then
  wait_clip "$PREV_ID"
  check "a clip was offered" "$([ -n "$CLIP_ID" ] && [ "$CLIP_ID" != "$PREV_ID" ] && echo yes || echo no)" "yes"
  e2e_wait_until 600 _e2e_eval_equals "$DL" "$(js_total)" "0"
  check "the cut took the whole file out" "$(total)" "0"
  check_big_clip "cut"
  save_active
  check "the saved file is empty" "$(file_size "$WORK/big-cut.log")" "0"
  undo_to "$BIG_SIZE"
  check "one undo gives the file back" "$(total)" "$BIG_SIZE"
  save_active
  check "the restored file is the original" "$(file_sha256 "$WORK/big-cut.log")" "$BIG_SHA"
  close_tab
else
  settle
  check "no clip is made on this system" "$(clip_status | jq -c '.s')" "null"
  check "the cut changed nothing" "$(total)" "$BIG_SIZE"
  check "the cut left the tab clean" "$(dirty)" "false"
  skip "2. the clipboard, the saved empty file and the undo of the cut (macOS and Windows)"
  close_tab
  check "the file on disk is as it was" "$(file_sha256 "$WORK/big-cut.log")" "$BIG_SHA"
fi

echo "=== 3. [macOS, Windows] a write from outside ends the clip ==="
if has_clipboard; then
  begin_doc
  select_all "$END_LINE"
  PREV_ID=$(clip_id)
  evl "$DL" "__auto.windowedCopy()" >/dev/null
  wait_clip "$PREV_ID"
  check "a clip is on the clipboard" "$([ -n "$CLIP_ID" ] && [ "$CLIP_ID" != "$PREV_ID" ] && echo yes || echo no)" "yes"
  if [ "$ENV_NAME" = "macos" ]; then
    check "the clip file is there" "$([ "$(clip_files)" -ge 1 ] && echo yes || echo no)" "yes"
  else
    check "the helper runs" "$(helper_running && echo yes || echo no)" "yes"
  fi
  clip_set "from outside the app"
  sleep 1
  check "clip_status is null once the clipboard was written from outside" "$(clip_status | jq -c '.s')" "null"
  if [ "$ENV_NAME" = "macos" ]; then
    check "the clip file is gone after that clip_status" "$(clip_files)" "0"
  else
    e2e_wait_until 5 helper_gone
    check "the helper has ended" "$(helper_gone && echo yes || echo no)" "yes"
  fi
  check "the clipboard is the text from outside" "$(clip_text)" "from outside the app"
  close_tab
else
  skip "3. a write from outside ends the clip (macOS and Windows)"
fi

echo "=== 4. [macOS, Windows; Linux: nothing changes] the viewer copies the whole file and a line range ==="
evl "$DL" "__auto.setLargeOpenMode('view')" >/dev/null
e2e_wait_setting large_open_mode "view"
evl "$DL" "__auto.openTab('$WORK/big.log')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getTabs().length===2 && __auto.isLargeTab())" "true"
e2e_wait_eval "$DL" "String(document.querySelectorAll('.large-wrap .row .text').length>0)" "true"
PREV_ID=$(clip_id)
evl "$DL" "__auto.menuAction('select-all')" >/dev/null
check "Select All stands for the whole file" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "true"
VCOPY=$(e2e_read "$DL" "JSON.stringify(__auto.viewerCopy())")
check "viewer copy of the whole file is prevented" "$(printf '%s' "$VCOPY" | jq -r '.prevented')" "true"
check "it writes nothing to the web clipboard" "$(printf '%s' "$VCOPY" | jq -r '.types')" "0"
if has_clipboard; then
  wait_clip "$PREV_ID"
  check "viewer whole file: the clipboard holds the file (bytes and SHA-256)" "$(clip_digest)" "$BIG_SIZE $BIG_SHA"
  # Lines 10 to 2,000,000 (1-based) are bytes [9 lines, 2,000,000 lines).
  RANGE_FROM=$((9 * LINE_BYTES))
  RANGE_TO=$((2000000 * LINE_BYTES))
  RANGE_SHA=$(range_sha256 "$WORK/big.log" "$RANGE_FROM" "$RANGE_TO")
  PREV_ID=$CLIP_ID
  # The rows Select All drew are a selection of the page too, and a newer one
  # than the range from the gutter, which sets none.
  evl "$DL" "document.getSelection().removeAllRanges()" >/dev/null
  evl "$DL" "__auto.largeSelectRange(10,2000000)" >/dev/null
  check "the line range is set" "$(e2e_read "$DL" "JSON.stringify(__auto.largeGetRange())")" '{"startLine":10,"endLine":2000000}'
  check "the line range is not the whole file" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "false"
  VCOPY=$(e2e_read "$DL" "JSON.stringify(__auto.viewerCopy())")
  check "viewer copy of a line range past the loaded rows is prevented" "$(printf '%s' "$VCOPY" | jq -r '.prevented')" "true"
  wait_clip "$PREV_ID"
  check "viewer line range: the clipboard holds those lines (bytes and SHA-256)" "$(clip_digest)" "$((RANGE_TO - RANGE_FROM)) $RANGE_SHA"
else
  sleep 3
  check "no clip is made on this system" "$(clip_status | jq -c '.s')" "null"
  skip "4. the clipboard of the viewer's copies (macOS and Windows)"
fi
check "the viewer left the file as it was" "$(file_sha256 "$WORK/big.log")" "$BIG_SHA"
evl "$DL" "__auto.setLargeOpenMode('$ORIG_MODE')" >/dev/null
e2e_wait_setting large_open_mode "$ORIG_MODE"
close_tab

echo "=== 5. [all] a selection one window holds is copied and cut through the web clipboard ==="
begin_doc
check "the caret is at the start" "$(e2e_read "$DL" "JSON.stringify(__auto.windowedGlobalSel().head)")" '{"line":0,"col":0}'
for i in 1 2 3; do
  press ArrowDown '{shiftKey:true}'
done
check "three lines are selected" "$(e2e_read "$DL" "JSON.stringify(__auto.windowedGlobalSel().head)")" '{"line":3,"col":0}'
PREV_ID=$(clip_id)
FIT_TEXT=$(head -c $((3 * LINE_BYTES)) "$WORK/base.log")
# The result with the byte count and the CR count of its text, taken in the
# page: the evidence of where a CR comes from, which jq -r may add on Windows.
js_with_bytes() {
  echo "(()=>{const r=__auto.$1();return JSON.stringify(Object.assign({},r,{bytes:new TextEncoder().encode(r.data).length,cr:(r.data.match(/\\r/g)||[]).length}));})()"
}
# The text of such a result as the checks compare it: the breaks of the text
# are LF, so on Windows a CRLF jq wrote is made LF.
data_of() {
  if [ "$ENV_NAME" = "windows" ]; then
    printf '%s' "$1" | jq -r '.data' | sed 's/\r$//'
  else
    printf '%s' "$1" | jq -r '.data'
  fi
}
log_data() {
  echo "$1: $(printf '%s' "$2" | jq -r '.bytes') bytes and $(printf '%s' "$2" | jq -r '.cr') CR in the page (want $((3 * LINE_BYTES)) and 0), $(printf '%s' "$2" | jq -r '.data' | wc -c | tr -d ' ') bytes through jq -r (want $((3 * LINE_BYTES + 1)))"
}
SMALL_COPY=$(e2e_read "$DL" "$(js_with_bytes windowedCopy)")
log_data "copy data" "$SMALL_COPY"
check "copy goes to the web clipboard (types)" "$(printf '%s' "$SMALL_COPY" | jq -r '.types')" "1"
check "copy goes to the web clipboard (the three lines)" "$(data_of "$SMALL_COPY")" "$FIT_TEXT"
check "copy changed nothing" "$(total)" "$BASE_SIZE"
SMALL_CUT=$(e2e_read "$DL" "$(js_with_bytes windowedCut)")
log_data "cut data" "$SMALL_CUT"
check "cut goes to the web clipboard (types)" "$(printf '%s' "$SMALL_CUT" | jq -r '.types')" "1"
check "cut goes to the web clipboard (the three lines)" "$(data_of "$SMALL_CUT")" "$FIT_TEXT"
check "cut took the three lines out" "$(total)" "$((BASE_SIZE - 3 * LINE_BYTES))"
check "no clip copy was made" "$(e2e_read "$DL" "String(__t.traced('clipCopy'))")" "0"
check "the clip on the clipboard is as it was" "$(clip_id)" "$PREV_ID"
close_windowed

echo "=== 6. [macOS, Windows; Linux: totalBytes only] cut and copy in the search field under a selection larger than a window ==="
begin_doc
select_all "$END_LINE"
evl "$DL" "window.__cp=[];__auto.openFind()" >/dev/null
e2e_wait_eval "$DL" "String(document.activeElement===__t.searchInput())" "true"
CLIPS_BEFORE=$(e2e_read "$DL" "String(__t.traced('clipCopy'))")
check "the field holds the text" "$(e2e_read "$DL" "__t.fill('CUTFIELD')")" "CUTFIELD"
check "cut in the field ran" "$(e2e_read "$DL" "String(document.execCommand('cut'))")" "true"
check "the cut emptied the field" "$(e2e_read "$DL" "__t.searchInput().value")" ""
if has_clipboard; then
  check "the clipboard is the field's text after the cut" "$(clip_text)" "CUTFIELD"
else
  skip "6. the clipboard after the cut in the field (macOS and Windows)"
fi
check "the field holds the text again" "$(e2e_read "$DL" "__t.fill('COPYFIELD')")" "COPYFIELD"
check "copy in the field ran" "$(e2e_read "$DL" "String(document.execCommand('copy'))")" "true"
if has_clipboard; then
  check "the clipboard is the field's text after the copy" "$(clip_text)" "COPYFIELD"
else
  skip "6. the clipboard after the copy in the field (macOS and Windows)"
fi
check "neither was prevented" "$(e2e_read "$DL" "JSON.stringify(window.__cp.map((e)=>e.prevented))")" "[false,false]"
check "totalBytes did not change" "$(total)" "$BASE_SIZE"
check "no clip copy was made" "$(e2e_read "$DL" "String(__t.traced('clipCopy'))")" "$CLIPS_BEFORE"
check "the selection is still the file" "$(e2e_read "$DL" "String(__t.isAll($END_LINE,$END_COL))")" "true"
evl "$DL" "__auto.closeFind()" >/dev/null
close_tab

echo "=== 7. [macOS] the viewer's find field under Select All or a range past the loaded rows ==="
if [ "$ENV_NAME" = "macos" ]; then
  evl "$DL" "__auto.setLargeOpenMode('view')" >/dev/null
  e2e_wait_setting large_open_mode "view"
  evl "$DL" "__auto.openTab('$WORK/big.log')" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getTabs().length===2 && __auto.isLargeTab())" "true"
  e2e_wait_eval "$DL" "String(document.querySelectorAll('.large-wrap .row .text').length>0)" "true"
  # A known copy of the whole file, to count the clips made between two of them.
  known_copy() {
    evl "$DL" "__auto.largeSearchClose()" >/dev/null
    evl "$DL" "__auto.menuAction('select-all')" >/dev/null
    local prev
    prev=$(clip_id)
    evl "$DL" "__auto.viewerCopy()" >/dev/null
    wait_clip "$prev"
    KNOWN_SEQ=$(clip_seq "$CLIP_ID")
  }
  for variant in whole range; do
    echo "--- $variant ---"
    known_copy
    SEQ_BEFORE=$KNOWN_SEQ
    if [ "$variant" = "whole" ]; then
      evl "$DL" "__auto.menuAction('select-all')" >/dev/null
      check "Select All stands for the whole file" "$(e2e_read "$DL" "String(__auto.largeWholeFile())")" "true"
    else
      evl "$DL" "document.getSelection().removeAllRanges()" >/dev/null
      evl "$DL" "__auto.largeSelectRange(10,2000000)" >/dev/null
      check "the line range is set" "$(e2e_read "$DL" "JSON.stringify(__auto.largeGetRange())")" '{"startLine":10,"endLine":2000000}'
    fi
    # The find field opens by the viewer's own shortcut path, with no click.
    evl "$DL" "window.__cp=[];__auto.largeSearchOpen()" >/dev/null
    e2e_wait_eval "$DL" "String(document.activeElement===__t.searchInput())" "true"
    check "the field holds the text" "$(e2e_read "$DL" "__t.fill('VIEWFIELD')")" "VIEWFIELD"
    check "copy in the field ran" "$(e2e_read "$DL" "String(document.execCommand('copy'))")" "true"
    check "the copy was not prevented" "$(e2e_read "$DL" "JSON.stringify(window.__cp.map((e)=>e.prevented))")" "[false]"
    check "the clipboard is the field's text" "$(clip_text)" "VIEWFIELD"
    known_copy
    check "clip_copy_file was not called in between (the next clip is the very next one)" "$KNOWN_SEQ" "$((SEQ_BEFORE + 1))"
  done
  evl "$DL" "__auto.largeSearchClose()" >/dev/null
  evl "$DL" "__auto.setLargeOpenMode('$ORIG_MODE')" >/dev/null
  e2e_wait_setting large_open_mode "$ORIG_MODE"
  close_tab
else
  skip "7. the viewer's find field (macOS only)"
fi

echo "=== 8. [macOS] the shadow meets a clip copy ==="
if [ "$ENV_NAME" = "macos" ]; then
  begin_doc
  select_all "$END_LINE"
  evl "$DL" "__auto.holdWindowedReads(true)" >/dev/null
  # The indentation is a window swap whose read is held.
  press Tab
  e2e_wait_eval "$DL" "String(__auto.heldWindowedReads()===1)" "true"
  PREV_ID=$(clip_id)
  # The copy waits in the queue behind the indentation.
  evl "$DL" "__auto.windowedCopy()" >/dev/null
  check "the copy is in the queue" "$(e2e_read "$DL" "String(__auto.windowedReplayLength()>=1)")" "true"
  # An open composition makes the read loop drain the queue in a shadow.
  evl "$DL" "window.__cd=undefined;__auto.windowedCompose({target:'editor',updates:['あ'],endData:'あ',delays:{beforeEnd:4000}}).then(()=>{window.__cd=1;});1" >/dev/null
  sleep 1.5
  evl "$DL" "__auto.holdWindowedReads(false);__auto.releaseWindowedReads()" >/dev/null
  e2e_wait_until 60 _e2e_eval_equals "$DL" "String(__t.traced('clipCopy')>=1)" "true"
  check "the clip copy ran" "$(e2e_read "$DL" "String(__t.traced('clipCopy')>=1)")" "true"
  check "the composition was still open when it ran" "$(e2e_read "$DL" "String(window.__cd!==1)")" "true"
  e2e_wait_eval "$DL" "String(window.__cd===1)" "true"
  settle
  # From the last clip copy to the next placed window: no new swap began (no
  # enter) and the window was read at least once (skips may be there).
  TRACE=$(e2e_read "$DL" "JSON.stringify(__auto.windowedTrace())")
  echo "swap trace: $TRACE"
  SHADOW_OK=$(printf '%s' "$TRACE" | jq '
    [.[].at] as $a
    | ([range(0; $a | length) | select($a[.] == "clipCopy")] | last) as $i
    | if $i == null then false else
        ($a[$i + 1:]) as $rest
        | ($rest | index("placed")) as $p
        | if $p == null then false else
            ($rest[0:$p]) as $between
            | (($between | index("enter")) == null) and (($between | index("read")) != null)
          end
      end')
  check "no swap began between the clip copy and the next placed window, and the window was read" "$SHADOW_OK" "true"
  CLIP_ID=$(clip_id)
  check "a clip was offered" "$([ -n "$CLIP_ID" ] && [ "$CLIP_ID" != "$PREV_ID" ] && echo yes || echo no)" "yes"
  CLIP_DIGEST=$(clip_digest)
  check "the clipboard holds the indented file without its first two bytes (bytes)" "${CLIP_DIGEST%% *}" "$((BASE_SIZE + 2 * N_LINES - 2))"
  check "the clipboard holds the indented file without its first two bytes (SHA-256)" "${CLIP_DIGEST#* }" "$INDENTED_SHA"
  check "the clip is not linewise" "$(clip_status | jq -r '.s.linewise')" "false"
  evl "$DL" "document.execCommand('insertText',false,'Z')" >/dev/null
  settle
  save_active
  close_tab
  check "the file is two spaces and the committed text and Z" "$(cat "$DOC")" "  あZ"
else
  skip "8. the shadow meets a clip copy (macOS only)"
fi

echo "=== 9. [macOS] copy and cut with the selection collapsed by queued typing ==="
if [ "$ENV_NAME" = "macos" ]; then
  for what in copy cut; do
    begin_doc
    select_all "$END_LINE"
    PREV_ID=$(clip_id)
    # One eval, so both are queued before the selection has changed.
    if [ "$what" = "copy" ]; then
      evl "$DL" "(()=>{__t.press('Q',{});__auto.windowedCopy();return 1;})()" >/dev/null
    else
      evl "$DL" "(()=>{__t.press('Q',{});__auto.windowedCut();return 1;})()" >/dev/null
    fi
    wait_clip "$PREV_ID"
    check "$what: a clip was offered" "$([ -n "$CLIP_ID" ] && [ "$CLIP_ID" != "$PREV_ID" ] && echo yes || echo no)" "yes"
    settle
    check "$what: the clipboard is the line of the caret, Q" "$(clip_text)" "Q"
    check "$what: the clip is linewise" "$(clip_status | jq -r '.s.linewise')" "true"
    if [ "$what" = "copy" ]; then
      check "copy: the file is Q" "$(total)" "1"
    else
      check "cut: the only line was taken out" "$(total)" "0"
    fi
    save_active
    close_tab
    if [ "$what" = "copy" ]; then
      check "copy: the saved file is Q" "$(cat "$DOC")" "Q"
    else
      check "cut: the saved file is empty" "$(file_size "$DOC")" "0"
    fi
  done
else
  skip "9. copy and cut with the selection collapsed (macOS only)"
fi

echo "=== 10. [macOS, Windows; Linux: SKIP] the clip survives the end of the app ==="
# The app ends in this section, so the whole run's exceptions are read before.
check "no exception thrown in the whole run" "$(e2e_read "$DL" "$(js_errors)")" "0"
if has_clipboard; then
  open_windowed "$WORK/big.log" 2
  select_all "$BIG_END_LINE"
  PREV_ID=$(clip_id)
  evl "$DL" "__auto.windowedCopy()" >/dev/null
  wait_clip "$PREV_ID"
  check "a clip is on the clipboard" "$([ -n "$CLIP_ID" ] && [ "$CLIP_ID" != "$PREV_ID" ] && echo yes || echo no)" "yes"
  evl "$DL" "window.__TAURI_INTERNALS__.invoke('request_exit');1" >/dev/null
  e2e_wait_until 60 e2e_app_gone
  check "the app has ended" "$(e2e_app_gone && echo yes || echo no)" "yes"
  check "the clipboard still holds the file after the app ended (bytes and SHA-256)" "$(clip_digest)" "$BIG_SIZE $BIG_SHA"
  check "windowed-tmp holds no clip" "$(clip_files)" "0"
  if [ "$ENV_NAME" = "windows" ]; then
    e2e_wait_until 2 helper_gone
    check "no cliphelper.exe runs 2 seconds after the app ended" "$(helper_gone && echo yes || echo no)" "yes"
  fi
else
  skip "10. the clip survives the end of the app (macOS and Windows)"
fi

echo "=== teardown ==="
if e2e_app_running; then
  evl "$DL" "__auto.setLanguage('$ORIG_LANG')" >/dev/null
  e2e_wait_setting language "$ORIG_LANG"
  evl "$DL" "__auto.setLargeSelectAll('$ORIG_SELECT')" >/dev/null
  e2e_wait_setting large_select_all "$ORIG_SELECT"
  quit_app
fi
wipe_test_docs
rm -rf "$WORK"
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
