#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: table view row virtualization.
# Before the fix the table view put one `<tr>` in the DOM per row of the file,
# so opening a 270,000-row CSV built ~1.1M cell inputs and froze the window for
# tens of seconds. Measured on this machine beforehand: 25k rows 2s, 50k rows
# 4s, 100k rows 12s, all with rows_in_dom equal to the row count.
# The suite opens a real 270,000-row file and asserts, in this order:
#   - the premise (the tab really holds 270,000 rows and is in the table view),
#   - only a window of rows reaches the DOM and the window stays responsive,
#   - the scrollbar still measures the whole document (spacer arithmetic),
#   - scrolling to either end shows the right rows,
#   - a pending cell edit is committed, not dropped, when its row leaves the
#     window (a removed input fires no blur) — by scrolling and by resizing,
#   - the promoted header row stays pinned, and
#   - a small file still reaches every row and still edits.
# LESSON (inherited from the other suites): never put `await` inside an eval
# string; use `.then((r)=>{window.__x=r;})` and poll for window.__x.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/table-fixture"
PASS=0
FAIL=0
mkdir -p "$OUT"
: >"$OUT/dev-table.log"

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
evl() {
  auto "{\"id\":$(e2e_next_id),\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
# Rows currently in the DOM, spacers and gutter strip included.
rows_in_dom() {
  evl "$1" "String(document.querySelectorAll('.table-view .grid tr').length)"
}
# Value of the cell input at (r, c), or 'absent' when that row is not rendered.
cell_value() {
  evl "$1" "String((document.querySelector('.cell[data-r=\"$2\"][data-c=\"$3\"]')||{value:'absent'}).value)"
}
# Type <value> into the cell at (r, c): set the value and fire `input`, which is
# what a keystroke does. A bare assignment fires no event and would not reach the
# component at all.
type_cell() {
  evl "$1" "var e=document.querySelector('.cell[data-r=\"$2\"][data-c=\"$3\"]');e.value='$4';e.dispatchEvent(new Event('input',{bubbles:true}))" >/dev/null
}
# Focus the cell input and leave it again, which is all a click in and a click
# out does. Focus first: `blur()` on an element that never had focus fires no
# blur event, so the assertion would pass without the handler ever running.
focus_blur_cell() {
  evl "$1" "var e=document.querySelector('.cell[data-r=\"$2\"][data-c=\"$3\"]');e.focus();e.blur()" >/dev/null
}
# Press Escape in the cell input, the way the keymap sees it.
escape_cell() {
  evl "$1" "var e=document.querySelector('.cell[data-r=\"$2\"][data-c=\"$3\"]');e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))" >/dev/null
}
_pane_height() {
  evl "$1" "String(document.querySelector('.grid-scroll').clientHeight)"
}
_pane_shorter_than() {
  [ "$(_pane_height "$1")" -lt "$2" ] 2>/dev/null
}
_pane_taller_than() {
  [ "$(_pane_height "$1")" -gt "$2" ] 2>/dev/null
}
launch() {
  e2e_require_clean_slate
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-table.log" 2>&1 &
  e2e_report_port_holders
  if ! e2e_wait_until 240 e2e_automation_up; then
    e2e_report_port_holders
    echo "FATAL: automation port never opened"
    exit 1
  fi
  e2e_require_automation_listener "$OUT/dev-table.log"
  # The dev server binds 1420 while the app is coming up, so this is the
  # first moment a leftover holding it is visible; the app answering on
  # the automation port does not mean vite got its port.
  e2e_report_port_holders
  sleep 4
}
quit_app() {
  auto '{"id":99,"cmd":"quit"}' >/dev/null 2>&1
  e2e_wait_until 20 e2e_app_gone
  e2e_kill_owned_ports
  sleep 3
}

echo "=== preflight ==="
# Wait for any previous instance to be gone before looking at the store. A port
# check cannot see an app that has stopped listening but is still exiting, and
# it writes its dirty tabs to snapshots on the way out — which the next run's
# app would then adopt, so its very first assertions would read another run's
# leftovers. (Seen: a 270,001-row fixture opening with 270,002 rows and dirty.)
if ! e2e_wait_until 60 e2e_app_gone; then
  echo "FATAL: a note-n-pad process is still running; refusing to start"
  exit 1
fi
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
# 270,000 data rows plus a header line, matching the file size in the bug report.
# Every row carries its own index so a rendered cell proves which row it is.
python3 - <<PYEOF
w = '$WORK'
with open(f'{w}/big.csv', 'w', newline='') as f:
    f.write('col a,col b,col c\n')
    for i in range(270000):
        f.write(f'{i},value {i},another {i}\n')
with open(f'{w}/small.csv', 'w', newline='') as f:
    f.write('col a,col b,col c\n')
    for i in range(50):
        f.write(f'{i},value {i},another {i}\n')
with open(f'{w}/huge.csv', 'w', newline='') as f:
    f.write('n,v\n')
    for i in range(1600000):
        f.write(f'{i},r{i}\n')
for name, tag in (('a.csv', 'A'), ('b.csv', 'B')):
    with open(f'{w}/{name}', 'w', newline='') as f:
        f.write('col a,col b,col c\n')
        for i in range(2000):
            f.write(f'{i},{tag}-{i},another {i}\n')
with open(f'{w}/quoted.csv', 'w', newline='') as f:
    f.write('"multi\nline",x\ny,z\n')
with open(f'{w}/host.txt', 'w', newline='') as f:
    f.write('short host document\n')
PYEOF
BIG_LINES=$(wc -l <"$WORK/big.csv" | tr -d ' ')
echo "fixtures:"
ls -l "$WORK"
# Assert the fixture before asserting anything about it: a short file would make
# every "did not freeze" claim below vacuously true.
if [ "$BIG_LINES" != "270001" ]; then
  echo "FATAL: big.csv has $BIG_LINES lines, expected 270001"
  exit 1
fi

cleanup() {
  trap '' INT TERM
  quit_app
  for f in "$STORE"/*.json; do
    if [ "$(jq -r '.kind' "$f" 2>/dev/null)" = "document" ]; then
      FP=$(jq -r '.file_path // empty' "$f" 2>/dev/null)
      case "$FP" in
        *note-n-pad-e2e*) rm -f "$f" ;;
      esac
    fi
  done
  rm -rf "$WORK"
  e2e_kill_owned_ports
}
trap cleanup EXIT INT TERM

launch
BOOT=$(boot_label)
if [ -z "$BOOT" ]; then
  echo "FATAL: no bootstrap window"
  exit 1
fi
# A plain host window: every case below runs through its in-window openTab, and
# a tab that stays open keeps the window alive between cases.
evl "$BOOT" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/host.txt'})" >/dev/null
e2e_wait_until 60 test -n "$(doc_label)"
DL=$(doc_label)
if [ -z "$DL" ]; then
  echo "FATAL: no document window"
  exit 1
fi
e2e_wait_eval "$DL" "typeof __auto!=='undefined' && typeof __auto.tableDims==='function'" "true"

echo "=== A. 270k-row open: premise, DOM size, responsiveness ==="
T0=$(date +%s.%N)
# `void` keeps the eval's own value undefined: the automation wrapper awaits
# that value, so handing it the open's promise would block the eval on the
# whole open. The settle marker read back below is what tells a rejected open
# apart from a route that returned quietly without opening anything.
evl "$DL" "void __auto.openTabSettled('$WORK/big.csv').then(()=>{window.__openSettled='ok'},(e)=>{window.__openSettled='ERR '+String(e)})" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "270001"
T1=$(date +%s.%N)
OPEN_RT=$(python3 -c "print(round($T1-$T0,2))")
echo "open->table-ready elapsed: ${OPEN_RT}s"
# The premise as one value, so a failed open is named once instead of being
# inferred from three assertions that each restate it. `tableDims().rows` comes
# from the path, not the view mode, so a tab open in source mode reports the
# full row count too — hence the `.table-view` term. Through e2e_read because
# the only values this can hold are true and false: a null is a timed-out eval.
BIG_OPENED=$(e2e_read "$DL" "String(__auto.tableDims().rows===270001 && document.querySelector('.table-view')!==null)")
# Four reads that tell the silent endings of the open apart: a rejection, a
# swallowed loadTab failure, a focus handed to another window, a tab that
# opened without the table view. None of them can render null except by timing
# out, which is why openFailed carries a sentinel: its clean value is null.
echo "open settled: $(e2e_read "$DL" "String(window.__openSettled)")"
# Pairs, not objects: `{a,b}` inside a double-quoted `$( )` nested in a
# double-quoted string is brace-expanded before the string ever reaches the
# app, which silently splits the read into two broken evals.
echo "tabs after open: $(e2e_read "$DL" "JSON.stringify(__auto.getTabs().map((t)=>[t.path,t.active]))")"
echo "view mode after open: $(e2e_read "$DL" "String(__auto.getViewMode())")"
echo "openFailed after open: $(e2e_read "$DL" "String(__auto.openFailed() ?? 'none')")"
check "the open produced the 270k table" "$BIG_OPENED" "true"
if [ "$BIG_OPENED" = "true" ]; then
  # Premise: this really is a 270,001-row table view, not a source tab or a
  # confirm dialog that never opened anything.
  check "tab holds 270001 rows" "$(evl "$DL" "String(__auto.tableDims().rows)")" "270001"
  check "table view is mounted" "$(evl "$DL" "String(document.querySelector('.table-view')!==null)")" "true"
  # The fix itself: a window of rows, not the whole file.
  DOM_ROWS=$(rows_in_dom "$DL")
  echo "rows in DOM: $DOM_ROWS"
  check "only a window of rows is in the DOM" "$(python3 -c "print(0 < $DOM_ROWS < 200)")" "True"
fi
# Responsive: a fresh eval round-trips quickly. Before the fix this call sat
# behind tens of seconds of DOM construction.
T2=$(date +%s.%N)
PONG=$(evl "$DL" "'pong'")
T3=$(date +%s.%N)
PONG_RT=$(python3 -c "print(round($T3-$T2,2))")
echo "eval round-trip after open: ${PONG_RT}s"
check "eval round-trip returned" "$PONG" "pong"
check "window responsive right after the open" "$(python3 -c "print($PONG_RT < 2.0)")" "True"

if [ "$BIG_OPENED" = "true" ]; then
  echo "=== B. the scrollbar still measures the whole document ==="
  # Spacer arithmetic: the table's own height must match every row being there.
  # A 2% tolerance covers the gutter strip and the append bar.
  ROW_H=$(evl "$DL" "String(document.querySelector('.cell').closest('tr').offsetHeight)")
  GRID_H=$(evl "$DL" "String(document.querySelector('.table-view .grid').offsetHeight)")
  echo "row height: ${ROW_H}px, grid height: ${GRID_H}px, expected ~$((270001 * ROW_H))px"
  check "grid height covers all 270001 rows" \
    "$(python3 -c "print(abs($GRID_H - 270001*$ROW_H) < 270001*$ROW_H*0.02)")" "True"

  echo "=== C. both ends of the document render the right rows ==="
  check "row 0 is the header line" "$(cell_value "$DL" 0 0)" "col a"
  COL_W_TOP=$(evl "$DL" "String(Math.round(document.querySelector('.cell[data-c=\"1\"]').getBoundingClientRect().width))")
  evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight" >/dev/null
  e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"270000\"][data-c=\"0\"]')!==null)" "true"
  check "last row rendered after scrolling to the bottom" "$(cell_value "$DL" 270000 0)" "269999"
  # Column widths must not depend on which rows happen to be rendered, or the
  # table would shift sideways under the pointer while scrolling.
  COL_W_BOTTOM=$(evl "$DL" "String(Math.round(document.querySelector('.cell[data-c=\"1\"]').getBoundingClientRect().width))")
  echo "column 1 width: top ${COL_W_TOP}px, bottom ${COL_W_BOTTOM}px"
  check "column width does not change between the two ends" "$COL_W_TOP" "$COL_W_BOTTOM"
  check "first row dropped at the bottom" "$(cell_value "$DL" 0 0)" "absent"
  DOM_ROWS_BOTTOM=$(rows_in_dom "$DL")
  check "still only a window of rows at the bottom" "$(python3 -c "print(0 < $DOM_ROWS_BOTTOM < 200)")" "True"
  evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
  e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"0\"][data-c=\"0\"]')!==null)" "true"
  check "back at the top, row 0 is rendered again" "$(cell_value "$DL" 0 0)" "col a"

  echo "=== D. an edit is not lost when its row scrolls out of the window ==="
  # The input holding a pending edit is destroyed once its row leaves the window,
  # and a removed element fires no blur event, so the typed text would disappear
  # with no commit and no dirty flag. Type into row 5, scroll far past it, and the
  # value must have committed on the way out.
  check "tab is clean before the edit" \
    "$(evl "$DL" "String((__auto.getTabs().find((t)=>t.active)||{}).dirty)")" "false"
  evl "$DL" "document.querySelector('.cell[data-r=\"5\"][data-c=\"1\"]').focus()" >/dev/null
  type_cell "$DL" 5 1 "EDITED-WHILE-SCROLLING"
  check "the cell really holds the typed value before scrolling" \
    "$(cell_value "$DL" 5 1)" "EDITED-WHILE-SCROLLING"
  evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight/2" >/dev/null
  e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"5\"][data-c=\"1\"]')===null)" "true"
  check "the row did leave the window" \
    "$(evl "$DL" "String(document.querySelector('.cell[data-r=\"5\"][data-c=\"1\"]')===null)")" "true"
  check "the edit committed on the way out" \
    "$(evl "$DL" "String(__auto.getContent().includes('EDITED-WHILE-SCROLLING'))")" "true"
  check "the tab is dirty after the edit" \
    "$(evl "$DL" "String((__auto.getTabs().find((t)=>t.active)||{}).dirty)")" "true"
  # Scrolling back must show the committed value, not the old one.
  evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
  e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"5\"][data-c=\"1\"]')!==null)" "true"
  check "the committed value is there on the way back" \
    "$(cell_value "$DL" 5 1)" "EDITED-WHILE-SCROLLING"
  GRID_H2=$(evl "$DL" "String(document.querySelector('.table-view .grid').offsetHeight)")
  check "the grid height is unchanged by the edit" "$GRID_H2" "$GRID_H"

  echo "=== D2. an edit is not lost when the pane shrinks under it ==="
  # The sibling of D: a shorter pane narrows the window and drops rows off the
  # bottom with no scroll event at all, so a guard on the scroll path alone
  # misses it. Resize the real window rather than restyle the pane, and prove the
  # pane actually got shorter before reading anything into what followed.
  evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
  e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"0\"][data-c=\"0\"]')!==null)" "true"
  PANE_BEFORE=$(evl "$DL" "String(document.querySelector('.grid-scroll').clientHeight)")
  LAST_VIS=$(evl "$DL" "String(Math.max(...[...document.querySelectorAll('.cell[data-c=\"1\"]')].map((e)=>Number(e.dataset.r))))")
  echo "pane height ${PANE_BEFORE}px, bottom-most rendered row $LAST_VIS"
  check "a bottom-most row was found" "$(python3 -c "print(0 < $LAST_VIS < 1000)")" "True"
  type_cell "$DL" "$LAST_VIS" 1 "EDITED-WHILE-SHRINKING"
  check "the cell holds the typed value before the resize" \
    "$(cell_value "$DL" "$LAST_VIS" 1)" "EDITED-WHILE-SHRINKING"
  evl "$DL" "window.__TAURI_INTERNALS__.invoke('plugin:window|set_size',{label:'$DL',value:{Logical:{width:900,height:260}}})" >/dev/null
  e2e_wait_until 30 _pane_shorter_than "$DL" "$PANE_BEFORE"
  PANE_AFTER=$(evl "$DL" "String(document.querySelector('.grid-scroll').clientHeight)")
  echo "pane height after resize: ${PANE_AFTER}px"
  # Premise: the pane really is shorter. Without this the checks below can pass
  # for the wrong reason (a scroll that moved the row out on its own).
  check "the pane actually got shorter" \
    "$(python3 -c "print($PANE_AFTER < $PANE_BEFORE)")" "True"
  check "the scroll position did not move" \
    "$(evl "$DL" "String(document.querySelector('.grid-scroll').scrollTop)")" "0"
  check "the row left the window because of the resize" \
    "$(evl "$DL" "String(document.querySelector('.cell[data-r=\"$LAST_VIS\"][data-c=\"1\"]')===null)")" "true"
  check "the edit committed on the resize" \
    "$(evl "$DL" "String(__auto.getContent().includes('EDITED-WHILE-SHRINKING'))")" "true"
  evl "$DL" "window.__TAURI_INTERNALS__.invoke('plugin:window|set_size',{label:'$DL',value:{Logical:{width:1000,height:700}}})" >/dev/null
  e2e_wait_until 30 _pane_taller_than "$DL" "$PANE_AFTER"

  echo "=== E. the context menu reaches a row that is not rendered ==="
  evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
  e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"0\"][data-c=\"0\"]')!==null)" "true"
  check "target row is not rendered to begin with" \
    "$(evl "$DL" "String(document.querySelector('.cell[data-r=\"200000\"][data-c=\"1\"]')!==null)")" "false"
  evl "$DL" "__auto.openTableMenu(200000,1)" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.tableMenuOpen())" "true"
  check "menu opened for an off-screen row" "$(evl "$DL" "String(__auto.tableMenuOpen())")" "true"
  # The menu opening proves nothing on its own: it opens at the 0,0 corner even
  # when the scroll landed nowhere near the row. The row has to be rendered.
  check "the target row was actually scrolled into the window" \
    "$(evl "$DL" "String(document.querySelector('.cell[data-r=\"200000\"][data-c=\"1\"]')!==null)")" "true"
  evl "$DL" "document.querySelector('.menu-backdrop').click()" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.tableMenuOpen())" "false"

  echo "=== F. the promoted header row stays pinned while scrolled away ==="
  evl "$DL" "__auto.setHeaderRow(true)" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.getHeaderRow())" "true"
  evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight" >/dev/null
  e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"270000\"][data-c=\"0\"]')!==null)" "true"
  check "header row is still rendered at the bottom of the file" \
    "$(evl "$DL" "String(document.querySelector('.cell[data-r=\"0\"][data-c=\"0\"]')!==null)")" "true"
  check "and it still shows the header text" "$(cell_value "$DL" 0 0)" "col a"
  evl "$DL" "__auto.setHeaderRow(false)" >/dev/null
  evl "$DL" "__auto.closeActiveTab()" >/dev/null
  sleep 2
else
  echo "SKIP: B-F need the 270k table, which never opened"
fi

echo "=== G. a small file still reaches every row and still edits ==="
# A 51-row file is still taller than the pane, so it is windowed too — the count
# of rendered rows depends on the window size and is deliberately not asserted.
# What must hold is that both ends are reachable and editing still works.
evl "$DL" "__auto.openTab('$WORK/small.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "51"
check "small file holds 51 rows" "$(evl "$DL" "String(__auto.tableDims().rows)")" "51"
# The scroll container is shared by every tab and nothing resets it, so a new
# tab inherits wherever the previous one was left; scroll to the top first
# rather than assert on that inherited position.
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"0\"][data-c=\"0\"]')!==null)" "true"
check "row 0 of the small file is the header line" "$(cell_value "$DL" 0 0)" "col a"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"50\"][data-c=\"0\"]')!==null)" "true"
check "last row of the small file is reachable" "$(cell_value "$DL" 50 0)" "49"
evl "$DL" "__auto.insertTableRow(51)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "52"
check "insert row still works" "$(evl "$DL" "String(__auto.tableDims().rows)")" "52"
evl "$DL" "__auto.setTableCell(51,0,'appended')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getContent().includes('appended'))" "true"
check "the appended row took the edit" \
  "$(evl "$DL" "String(__auto.getContent().includes('appended'))")" "true"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"51\"][data-c=\"0\"]')!==null)" "true"
check "the appended row renders at the end" "$(cell_value "$DL" 51 0)" "appended"

echo "=== H. a pending edit never reaches another document ==="
# The edit is held in component state, and one TableView instance serves every
# tab, so a tab switch must drop the pending edit rather than commit it into
# whatever document arrived in its place. Sections I and J cover the other two
# ways the content can change under a pending edit.
evl "$DL" "__auto.openTab('$WORK/a.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "2001"
evl "$DL" "__auto.openTab('$WORK/b.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "2001"
# Back to a.csv and type into a row without committing it.
A_IDX=$(evl "$DL" "String(__auto.getTabs().findIndex((t)=>(t.path||'').endsWith('a.csv')))")
B_IDX=$(evl "$DL" "String(__auto.getTabs().findIndex((t)=>(t.path||'').endsWith('b.csv')))")
check "both fixture tabs are open" "$(python3 -c "print($A_IDX >= 0 and $B_IDX >= 0)")" "True"
evl "$DL" "__auto.switchTab($A_IDX)" >/dev/null
e2e_wait_eval "$DL" "String(((__auto.getTabs().find((t)=>t.active)||{}).path||'').endsWith('a.csv'))" "true"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"5\"][data-c=\"1\"]')!==null)" "true"
check "a.csv row 5 starts as its own value" "$(cell_value "$DL" 5 1)" "A-4"
type_cell "$DL" 5 1 "LEAK-MARKER"
# Switch to b.csv, then scroll: scrolling is what runs the commit guard.
evl "$DL" "__auto.switchTab($B_IDX)" >/dev/null
e2e_wait_eval "$DL" "String(((__auto.getTabs().find((t)=>t.active)||{}).path||'').endsWith('b.csv'))" "true"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight" >/dev/null
sleep 2
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"5\"][data-c=\"1\"]')!==null)" "true"
check "b.csv row 5 kept its own value" "$(cell_value "$DL" 5 1)" "B-4"
check "b.csv never received the other document's edit" \
  "$(evl "$DL" "String(__auto.getContent().includes('LEAK-MARKER'))")" "false"
check "b.csv is not dirty" \
  "$(evl "$DL" "String((__auto.getTabs().find((t)=>t.active)||{}).dirty)")" "false"

echo "=== I. a pending edit dies with the content it was typed against ==="
# Switching away and back re-renders the cell from the document, so the app has
# already shown the user that their text is gone and the tab is clean. A later
# scroll must not resurrect it.
evl "$DL" "__auto.switchTab($A_IDX)" >/dev/null
e2e_wait_eval "$DL" "String(((__auto.getTabs().find((t)=>t.active)||{}).path||'').endsWith('a.csv'))" "true"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"6\"][data-c=\"1\"]')!==null)" "true"
check "a.csv is clean before the round trip" \
  "$(evl "$DL" "String((__auto.getTabs().find((t)=>t.active)||{}).dirty)")" "false"
type_cell "$DL" 6 1 "RESURRECT-MARKER"
evl "$DL" "__auto.switchTab($B_IDX)" >/dev/null
e2e_wait_eval "$DL" "String(((__auto.getTabs().find((t)=>t.active)||{}).path||'').endsWith('b.csv'))" "true"
evl "$DL" "__auto.switchTab($A_IDX)" >/dev/null
e2e_wait_eval "$DL" "String(((__auto.getTabs().find((t)=>t.active)||{}).path||'').endsWith('a.csv'))" "true"
# Premise: the app itself has already reverted the cell and reports it clean.
check "the cell reverted on the way back" "$(cell_value "$DL" 6 1)" "A-5"
check "a.csv still reports clean" \
  "$(evl "$DL" "String((__auto.getTabs().find((t)=>t.active)||{}).dirty)")" "false"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight" >/dev/null
sleep 2
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"6\"][data-c=\"1\"]')!==null)" "true"
check "the scroll did not resurrect the edit" "$(cell_value "$DL" 6 1)" "A-5"
check "a.csv is still clean after the scroll" \
  "$(evl "$DL" "String((__auto.getTabs().find((t)=>t.active)||{}).dirty)")" "false"

echo "=== J. a pending edit never lands on a row that moved under it ==="
# Inserting a row shifts every index below it. The edit was typed against the
# old grid, so committing it by index would overwrite an unrelated cell.
check "row 9 holds its own value" "$(cell_value "$DL" 9 1)" "A-8"
type_cell "$DL" 9 1 "WRONGROW-MARKER"
evl "$DL" "__auto.insertTableRow(0)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "2002"
check "the insert shifted the rows" "$(cell_value "$DL" 10 1)" "A-8"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight" >/dev/null
sleep 2
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"9\"][data-c=\"1\"]')!==null)" "true"
check "the shifted-into row was not overwritten" "$(cell_value "$DL" 9 1)" "A-7"
check "no stray marker landed anywhere" \
  "$(evl "$DL" "String(__auto.getContent().includes('WRONGROW-MARKER'))")" "false"

echo "=== K. every row of an over-tall table is still reachable ==="
# 1,600,001 rows x 23px = 36,800,023px, past the 33,554,428px this engine will
# lay out (measured). Without a compressed scroll axis the tail is unreachable:
# before this was handled, the bottom-most row was 1,458,899 and the last
# 141,101 rows could not be scrolled to at all.
evl "$DL" "__auto.openTab('$WORK/huge.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "1600001"
check "the tab really holds 1600001 rows" \
  "$(evl "$DL" "String(__auto.tableDims().rows)")" "1600001"
HUGE_ROW_H=$(evl "$DL" "String(document.querySelector('.cell').closest('tr').offsetHeight)")
HUGE_GRID_H=$(evl "$DL" "String(document.querySelector('.table-view .grid').offsetHeight)")
echo "row height ${HUGE_ROW_H}px, true height $((1600001 * HUGE_ROW_H))px, grid height ${HUGE_GRID_H}px"
# Premise: this file really is past the ceiling, so the axis really is compressed.
check "the document is taller than the engine will lay out" \
  "$(python3 -c "print($((1600001 * HUGE_ROW_H)) > 33554428)")" "True"
check "the grid was capped, not laid out in full" \
  "$(python3 -c "print($HUGE_GRID_H <= 33554432)")" "True"
check "still only a window of rows in the DOM" \
  "$(python3 -c "print(0 < $(rows_in_dom "$DL") < 200)")" "True"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"1600000\"][data-c=\"0\"]')!==null)" "true"
check "the very last row is reachable" "$(cell_value "$DL" 1600000 0)" "1599999"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=0" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"0\"][data-c=\"0\"]')!==null)" "true"
check "the first row is still reachable" "$(cell_value "$DL" 0 0)" "n"
# The middle of the scrollbar must land in the middle of the document.
evl "$DL" "var s=document.querySelector('.grid-scroll');s.scrollTop=Math.round((s.scrollHeight-s.clientHeight)*0.5)" >/dev/null
sleep 2
MID=$(evl "$DL" "String(Math.min(...[...document.querySelectorAll('.cell[data-c=\"0\"]')].map((e)=>Number(e.dataset.r))))")
echo "row at the halfway scroll position: $MID"
check "halfway down the scrollbar is halfway down the document" \
  "$(python3 -c "print(abs($MID - 800000) < 40000)")" "True"
# Jumping to a row goes through lineToScrollTop, which has to use the same axis
# the window is derived from. On an uncompressed table the two agree whether or
# not that is deliberate, so this is the only place it discriminates.
evl "$DL" "__auto.openTableMenu(1200000,1)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableMenuOpen())" "true"
check "the menu reached a far row on a compressed axis" \
  "$(evl "$DL" "String(document.querySelector('.cell[data-r=\"1200000\"][data-c=\"1\"]')!==null)")" "true"
evl "$DL" "document.querySelector('.menu-backdrop').click()" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableMenuOpen())" "false"
evl "$DL" "__auto.closeActiveTab()" >/dev/null
sleep 2

echo "=== L. a change in row height does not shrink the scroll axis ==="
# The engine ceiling is a property of the engine, not of this table. Reading it
# off the live table made a row-height change look like the engine had clamped
# us, which permanently compressed a document that fits, and followed the shared
# component into every other tab. Row height is forced here with injected CSS
# because nothing in the UI changes it today.
evl "$DL" "__auto.openTab('$WORK/huge.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "1600001"
HUGE_H_BEFORE=$(evl "$DL" "String(document.querySelector('.table-view .grid').offsetHeight)")
evl "$DL" "__auto.closeActiveTab()" >/dev/null
sleep 2
evl "$DL" "__auto.openTab('$WORK/big.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "270001"
evl "$DL" "var st=document.createElement('style');st.id='rowh';st.textContent='.table-view .grid .cell{height:31px}';document.head.appendChild(st)" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell').closest('tr').offsetHeight>23)" "true"
BIG_ROW_H=$(evl "$DL" "String(document.querySelector('.cell').closest('tr').offsetHeight)")
BIG_H_AFTER=$(evl "$DL" "String(document.querySelector('.table-view .grid').offsetHeight)")
echo "row height now ${BIG_ROW_H}px, grid height ${BIG_H_AFTER}px, true height $((270001 * BIG_ROW_H))px"
# Premise: the row really did get taller, so the scenario is actually exercised.
check "the row really got taller" "$(python3 -c "print($BIG_ROW_H > 23)")" "True"
check "a table that fits is not compressed" \
  "$(python3 -c "print(abs($BIG_H_AFTER - 270001*$BIG_ROW_H) < 200)")" "True"
# And the shared component must not carry a shrunken axis into another tab.
evl "$DL" "document.getElementById('rowh').remove()" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell').closest('tr').offsetHeight)" "23"
# The other direction: a shorter row must shorten the axis too. Nothing resizes
# the pane here, so this only works if the table itself is being watched.
BIG_H_SHRUNK=$(evl "$DL" "String(document.querySelector('.table-view .grid').offsetHeight)")
echo "grid height back at 23px rows: ${BIG_H_SHRUNK}px"
check "the axis followed the row height back down" \
  "$(python3 -c "print(abs($BIG_H_SHRUNK - 270001*23) < 200)")" "True"
evl "$DL" "__auto.openTab('$WORK/huge.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "1600001"
HUGE_H_AFTER=$(evl "$DL" "String(document.querySelector('.table-view .grid').offsetHeight)")
echo "over-tall grid height: ${HUGE_H_BEFORE}px before, ${HUGE_H_AFTER}px after"
check "the over-tall table kept its full axis" "$HUGE_H_AFTER" "$HUGE_H_BEFORE"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"1600000\"][data-c=\"0\"]')!==null)" "true"
check "its last row is still reachable" "$(cell_value "$DL" 1600000 0)" "1599999"
evl "$DL" "__auto.closeActiveTab()" >/dev/null
sleep 2

echo "=== M. a new tab does not inherit the previous tab's scroll position ==="
# The scroll container used to be shared by every tab with nothing resetting it,
# so opening a short file right after scrolling a long one landed at its bottom.
evl "$DL" "__auto.openTab('$WORK/big.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "270001"
evl "$DL" "document.querySelector('.grid-scroll').scrollTop=document.querySelector('.grid-scroll').scrollHeight" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelector('.cell[data-r=\"270000\"][data-c=\"0\"]')!==null)" "true"
# Premise: the tab we are leaving really is scrolled to the bottom.
check "the long file is scrolled to its end" \
  "$(evl "$DL" "String(document.querySelector('.grid-scroll').scrollTop > 6000000)")" "true"
evl "$DL" "__auto.openTab('$WORK/small.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "51"
check "the new tab starts at the top" \
  "$(evl "$DL" "String(document.querySelector('.grid-scroll').scrollTop)")" "0"
check "and shows its first row" "$(cell_value "$DL" 0 0)" "col a"
# Switching back must not drag the short file's position onto the long one.
A_BIG=$(evl "$DL" "String(__auto.getTabs().findIndex((t)=>(t.path||'').endsWith('big.csv')))")
evl "$DL" "__auto.switchTab($A_BIG)" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "270001"
check "the long file also starts at the top when switched back" \
  "$(evl "$DL" "String(document.querySelector('.grid-scroll').scrollTop)")" "0"
check "and shows its first row" "$(cell_value "$DL" 0 0)" "col a"
echo "=== N. the add-column button stays reachable on a tall table ==="
# The strip is as tall as the table, so a centred glyph on a 270,000-row file
# sat around three million pixels down and could never be clicked.
evl "$DL" "__auto.openTab('$WORK/big.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().rows)" "270001"
COLS_BEFORE=$(evl "$DL" "String(__auto.tableDims().cols)")
check "the table starts with 3 columns" "$COLS_BEFORE" "3"
# Premise: the lane really is far taller than the pane, so this is the case
# that used to be unreachable.
check "the strip is far taller than the pane" \
  "$(evl "$DL" "String(document.querySelector('.ins.col-strip').offsetHeight > document.querySelector('.grid-scroll').clientHeight * 100)")" "true"
for FRAC in 0 0.5 1; do
  evl "$DL" "var s=document.querySelector('.grid-scroll');s.scrollTop=Math.round((s.scrollHeight-s.clientHeight)*$FRAC)" >/dev/null
  sleep 1
  VISIBLE=$(evl "$DL" "var g=document.querySelector('.ins.col-strip svg').getBoundingClientRect();var p=document.querySelector('.grid-scroll').getBoundingClientRect();String(g.top>=p.top-1 && g.bottom<=p.bottom+1)")
  check "the plus glyph is on screen at scroll fraction $FRAC" "$VISIBLE" "true"
done
# And it still does its job from there.
evl "$DL" "document.querySelector('.ins.col-strip').click()" >/dev/null
e2e_wait_eval "$DL" "String(__auto.tableDims().cols)" "4"
check "clicking it still adds a column" "$(evl "$DL" "String(__auto.tableDims().cols)")" "4"

echo "=== O. a quoted field spanning two lines survives being clicked on ==="
# An `<input>` cannot hold a newline, so the element hands back a copy with the
# newline stripped. Committing that copy on a bare focus-and-blur deleted the
# newline although nothing was edited, and Escape did the same by assigning the
# original value back into the input before blurring.
evl "$DL" "__auto.openTab('$WORK/quoted.csv')" >/dev/null
e2e_wait_eval "$DL" "String(__auto.getViewMode())" "table"
auto "{\"id\":2,\"cmd\":\"focus\",\"label\":\"$DL\"}" >/dev/null
sleep 1
check "the document really holds a two-line field" \
  "$(evl "$DL" "String(__auto.getContent().includes('multi\nline'))")" "true"
check "the input hands back that field without its newline" \
  "$(cell_value "$DL" 0 0)" "multiline"
check "the window has focus, so blur events will fire" \
  "$(evl "$DL" "String(document.hasFocus())")" "true"

focus_blur_cell "$DL" 0 0
sleep 1
check "a bare focus and blur keeps the newline" \
  "$(evl "$DL" "String(__auto.getContent().includes('multi\nline'))")" "true"
check "and leaves the tab clean" \
  "$(evl "$DL" "String((__auto.getTabs().find((t)=>t.active)||{}).dirty)")" "false"

evl "$DL" "document.querySelector('.cell[data-r=\"0\"][data-c=\"0\"]').focus()" >/dev/null
type_cell "$DL" 0 0 "WRECK"
escape_cell "$DL" 0 0
sleep 1
check "Escape after typing keeps the newline" \
  "$(evl "$DL" "String(__auto.getContent().includes('multi\nline'))")" "true"
check "and still leaves the tab clean" \
  "$(evl "$DL" "String((__auto.getTabs().find((t)=>t.active)||{}).dirty)")" "false"

evl "$DL" "document.querySelector('.cell[data-r=\"1\"][data-c=\"0\"]').focus()" >/dev/null
type_cell "$DL" 1 0 "TYPED"
focus_blur_cell "$DL" 1 0
sleep 1
check "a cell that was typed into still commits" "$(cell_value "$DL" 1 0)" "TYPED"
check "and the two-line field is untouched by that edit" \
  "$(evl "$DL" "String(__auto.getContent().includes('multi\nline'))")" "true"

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
echo "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then
  exit 1
fi
