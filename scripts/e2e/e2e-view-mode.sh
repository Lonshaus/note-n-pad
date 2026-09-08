#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# E2E: per-tab view modes and the JSON preview.
# DocumentApp remembers each tab's view mode in a map keyed by tab id, and the
# status bar switcher offers whatever modes the file's extension allows.
# Scenarios:
#   A. Three tabs, each given a remembered mode: the count is 3.
#   B. Close two clean tabs: the count falls to 1. Fails before the fix (stays 3).
#   C. A dirty tab closed through the confirm modal's "don't save" path clears
#      its entry too — every close route funnels through the same function, and
#      this is the one that goes the long way round.
#   D. The JSON preview mounts, renders a tree, injects no markup, and unmounts.
#   E. A syntax error shows a message instead of an empty pane.
#   F. Past the preview ceiling the option is disabled with a reason, not hidden.
#   G. The Markdown preview mounts, renders a tree, injects no markup, and
#      unmounts.
#   H. Find from a preview returns to the editor before opening the panel.
# LESSON: never put `await` inside an eval string; use `.then((r)=>{window.__x=r;})`.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
WORK="$OUT/view-mode-fixture"
PASS=0
FAIL=0
mkdir -p "$OUT"
: >"$OUT/dev-view-mode.log"

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
evl() {
  auto "{\"id\":$(e2e_next_id),\"cmd\":\"eval\",\"label\":\"$1\",\"js\":$(jq -Rn --arg js "$2" '$js')}" | jq -r '.data'
}
entry_count() {
  evl "$DL" "String(__auto.viewModeEntryCount())"
}
tab_count() {
  evl "$DL" "String(__auto.getTabs().length)"
}
# The view-mode switcher is the only select in the status bar's right-hand
# group, so its options can be counted without a test-only marker. 0 means the
# switcher is not rendered at all.
open_and_confirm() {
  local path="$1" bytes
  bytes=$(wc -c <"$path" | tr -d ' ')
  evl "$DL" "__auto.openTab('$path')" >/dev/null
  e2e_wait_eval "$DL" "String(__auto.activeContentLength())" "$bytes"
  check "opened $(basename "$path") (premise for what follows)" \
    "$(evl "$DL" "String(__auto.activeContentLength())")" "$bytes"
}
mode_option_count() {
  evl "$DL" "String(document.querySelectorAll('.statusbar .right select option').length)"
}
disabled_count() {
  evl "$DL" "String(document.querySelectorAll('.statusbar .right select option[disabled]').length)"
}

launch() {
  e2e_require_clean_slate
  NOTE_N_PAD_AUTOMATION=1 npm run tauri dev >>"$OUT/dev-view-mode.log" 2>&1 &
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
# Open the first fixture in a fresh doc window and wait for its hooks; sets DL.
open_doc() {
  local boot
  boot=$(auto '{"id":1,"cmd":"list_windows"}' | jq -r '.data[]|select(.label|startswith("note-") or startswith("doc-"))|.label' | head -1)
  evl "$boot" "window.__TAURI_INTERNALS__.invoke('open_document_window',{path:'$WORK/a.csv'})" >/dev/null
  sleep 3
  DL=$(doc_label)
  local tries=0
  until [ -n "$DL" ] && [ "$(evl "$DL" "typeof __auto!=='undefined' && typeof __auto.viewModeEntryCount==='function'")" = "true" ]; do
    sleep 1
    tries=$((tries + 1))
    if [ "$tries" -gt 30 ]; then
      echo "FATAL: doc window/hooks never appeared"
      quit_app
      exit 1
    fi
    DL=$(doc_label)
  done
}

echo "=== preflight ==="
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
printf 'a,b\n1,2\n' >"$WORK/a.csv"
printf 'c,d\n3,4\n' >"$WORK/b.csv"
printf 'e,f\n5,6\n' >"$WORK/c.csv"
printf '{\n  "name": "note",\n  "tags": ["a", "b"],\n  "nested": { "on": true }\n}\n' >"$WORK/good.json"
printf '{\n  "a": ,\n}\n' >"$WORK/bad.json"
printf '<root>\n  <item id="1" lang="zh">x</item>\n  <!-- note -->\n  <empty/>\n</root>\n' >"$WORK/doc.xml"
printf '<root><item>oops</wrong></root>\n' >"$WORK/bad.xml"
# 20,000 siblings under one root. Rendering them all is what cost 6GB of
# WebContent RSS and stopped the window answering; section R asserts the DOM
# row count tracks the viewport instead.
node -e '
  const fs = require("fs");
  const rows = ["<catalog>\n"];
  for (let i = 0; i < 20000; i += 1) {
    rows.push(`  <item id="${i}"><name>row ${i}</name></item>\n`);
  }
  rows.push("</catalog>\n");
  fs.writeFileSync(process.argv[1], rows.join(""));
' "$WORK/wide.xml"
# Valid, but carries an element named parsererror. Matching that name without
# checking the namespace reported the document as malformed and showed its own
# content back as the error text.
printf '<report>\n  <summary>valid</summary>\n  <parsererror>a field named that</parsererror>\n</report>\n' >"$WORK/named-error.xml"
# Nested entity definitions: a few hundred bytes that expand to tens of millions
# of characters in a parser that expands them, before any length check can run.
# Section O asserts nothing here is ever expanded.
cat >"$WORK/entities.xml" <<'XMLEOF'
<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
  <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
  <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
  <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">
  <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">
  <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">
]>
<lolz>&lol8;</lolz>
XMLEOF
# Everything a foreign document can carry that must never become a live node:
# an XHTML script element, an image with an error handler, and an inline
# handler attribute. If any of them is imported rather than read as text, the
# marker below is set and the assertion catches it.
cat >"$WORK/hostile.xml" <<'XMLEOF'
<?xml version="1.0"?>
<root xmlns:h="http://www.w3.org/1999/xhtml">
  <h:script>window.__xmlPwned = 'script';</h:script>
  <h:img src="does-not-exist" onerror="window.__xmlPwned = 'img'"/>
  <item onclick="window.__xmlPwned = 'click'">plain text</item>
</root>
XMLEOF
cat >"$WORK/doc.md" <<'MDEOF'
# Title

Some **bold**, *italic* and `code` text.

```
code line one

code line two
```

- item one

- item two

| A | B |
| - | - |
| 1 | 2 |

---
MDEOF
# Everything a foreign document can carry that must never become a live node:
# a script block, an image with an error handler, and a link whose destination
# is a javascript: URI. A link can now become a real <a href>, so
# what keeps this inert is linkKind refusing the scheme, not the absence of
# hrefs; the marker fires if either that or the text-only rendering gives way.
cat >"$WORK/anchors.md" <<'MDEOF'
# Top

[to install](#install-steps)

[to notes](#notes)

[to the second notes](#notes-1)

[nowhere](#missing)

Filler paragraph 0.

Filler paragraph 1.

Filler paragraph 2.

Filler paragraph 3.

Filler paragraph 4.

Filler paragraph 5.

Filler paragraph 6.

Filler paragraph 7.

Filler paragraph 8.

Filler paragraph 9.

Filler paragraph 10.

Filler paragraph 11.

Filler paragraph 12.

Filler paragraph 13.

Filler paragraph 14.

Filler paragraph 15.

Filler paragraph 16.

Filler paragraph 17.

Filler paragraph 18.

Filler paragraph 19.

Filler paragraph 20.

Filler paragraph 21.

Filler paragraph 22.

Filler paragraph 23.

Filler paragraph 24.

Filler paragraph 25.

Filler paragraph 26.

Filler paragraph 27.

Filler paragraph 28.

Filler paragraph 29.

Filler paragraph 30.

Filler paragraph 31.

Filler paragraph 32.

Filler paragraph 33.

Filler paragraph 34.

Filler paragraph 35.

Filler paragraph 36.

Filler paragraph 37.

Filler paragraph 38.

Filler paragraph 39.

Filler paragraph 40.

Filler paragraph 41.

Filler paragraph 42.

Filler paragraph 43.

Filler paragraph 44.

Filler paragraph 45.

Filler paragraph 46.

Filler paragraph 47.

Filler paragraph 48.

Filler paragraph 49.

Filler paragraph 50.

Filler paragraph 51.

Filler paragraph 52.

Filler paragraph 53.

Filler paragraph 54.

Filler paragraph 55.

Filler paragraph 56.

Filler paragraph 57.

Filler paragraph 58.

Filler paragraph 59.

Filler paragraph 60.

Filler paragraph 61.

Filler paragraph 62.

Filler paragraph 63.

Filler paragraph 64.

Filler paragraph 65.

Filler paragraph 66.

Filler paragraph 67.

Filler paragraph 68.

Filler paragraph 69.

Filler paragraph 70.

Filler paragraph 71.

Filler paragraph 72.

Filler paragraph 73.

Filler paragraph 74.

Filler paragraph 75.

Filler paragraph 76.

Filler paragraph 77.

Filler paragraph 78.

Filler paragraph 79.

Filler paragraph 80.

Filler paragraph 81.

Filler paragraph 82.

Filler paragraph 83.

Filler paragraph 84.

Filler paragraph 85.

Filler paragraph 86.

Filler paragraph 87.

Filler paragraph 88.

Filler paragraph 89.

Filler paragraph 90.

Filler paragraph 91.

Filler paragraph 92.

Filler paragraph 93.

Filler paragraph 94.

Filler paragraph 95.

Filler paragraph 96.

Filler paragraph 97.

Filler paragraph 98.

Filler paragraph 99.

Filler paragraph 100.

Filler paragraph 101.

Filler paragraph 102.

Filler paragraph 103.

Filler paragraph 104.

Filler paragraph 105.

Filler paragraph 106.

Filler paragraph 107.

Filler paragraph 108.

Filler paragraph 109.

Filler paragraph 110.

Filler paragraph 111.

Filler paragraph 112.

Filler paragraph 113.

Filler paragraph 114.

Filler paragraph 115.

Filler paragraph 116.

Filler paragraph 117.

Filler paragraph 118.

Filler paragraph 119.

Filler paragraph 120.

Filler paragraph 121.

Filler paragraph 122.

Filler paragraph 123.

Filler paragraph 124.

Filler paragraph 125.

Filler paragraph 126.

Filler paragraph 127.

Filler paragraph 128.

Filler paragraph 129.

Filler paragraph 130.

Filler paragraph 131.

Filler paragraph 132.

Filler paragraph 133.

Filler paragraph 134.

Filler paragraph 135.

Filler paragraph 136.

Filler paragraph 137.

Filler paragraph 138.

Filler paragraph 139.

Filler paragraph 140.

Filler paragraph 141.

Filler paragraph 142.

Filler paragraph 143.

Filler paragraph 144.

Filler paragraph 145.

Filler paragraph 146.

Filler paragraph 147.

Filler paragraph 148.

Filler paragraph 149.

Filler paragraph 150.

Filler paragraph 151.

Filler paragraph 152.

Filler paragraph 153.

Filler paragraph 154.

Filler paragraph 155.

Filler paragraph 156.

Filler paragraph 157.

Filler paragraph 158.

Filler paragraph 159.

Filler paragraph 160.

Filler paragraph 161.

Filler paragraph 162.

Filler paragraph 163.

Filler paragraph 164.

Filler paragraph 165.

Filler paragraph 166.

Filler paragraph 167.

Filler paragraph 168.

Filler paragraph 169.

Filler paragraph 170.

Filler paragraph 171.

Filler paragraph 172.

Filler paragraph 173.

Filler paragraph 174.

Filler paragraph 175.

Filler paragraph 176.

Filler paragraph 177.

Filler paragraph 178.

Filler paragraph 179.

Filler paragraph 180.

Filler paragraph 181.

Filler paragraph 182.

Filler paragraph 183.

Filler paragraph 184.

Filler paragraph 185.

Filler paragraph 186.

Filler paragraph 187.

Filler paragraph 188.

Filler paragraph 189.

Filler paragraph 190.

Filler paragraph 191.

Filler paragraph 192.

Filler paragraph 193.

Filler paragraph 194.

Filler paragraph 195.

Filler paragraph 196.

Filler paragraph 197.

Filler paragraph 198.

Filler paragraph 199.

## Install Steps

install body

## Notes

first notes body

Gap paragraph 0.

Gap paragraph 1.

Gap paragraph 2.

Gap paragraph 3.

Gap paragraph 4.

Gap paragraph 5.

Gap paragraph 6.

Gap paragraph 7.

Gap paragraph 8.

Gap paragraph 9.

Gap paragraph 10.

Gap paragraph 11.

Gap paragraph 12.

Gap paragraph 13.

Gap paragraph 14.

Gap paragraph 15.

Gap paragraph 16.

Gap paragraph 17.

Gap paragraph 18.

Gap paragraph 19.

Gap paragraph 20.

Gap paragraph 21.

Gap paragraph 22.

Gap paragraph 23.

Gap paragraph 24.

Gap paragraph 25.

Gap paragraph 26.

Gap paragraph 27.

Gap paragraph 28.

Gap paragraph 29.

Gap paragraph 30.

Gap paragraph 31.

Gap paragraph 32.

Gap paragraph 33.

Gap paragraph 34.

Gap paragraph 35.

Gap paragraph 36.

Gap paragraph 37.

Gap paragraph 38.

Gap paragraph 39.

Gap paragraph 40.

Gap paragraph 41.

Gap paragraph 42.

Gap paragraph 43.

Gap paragraph 44.

Gap paragraph 45.

Gap paragraph 46.

Gap paragraph 47.

Gap paragraph 48.

Gap paragraph 49.

Gap paragraph 50.

Gap paragraph 51.

Gap paragraph 52.

Gap paragraph 53.

Gap paragraph 54.

Gap paragraph 55.

Gap paragraph 56.

Gap paragraph 57.

Gap paragraph 58.

Gap paragraph 59.

Gap paragraph 60.

Gap paragraph 61.

Gap paragraph 62.

Gap paragraph 63.

Gap paragraph 64.

Gap paragraph 65.

Gap paragraph 66.

Gap paragraph 67.

Gap paragraph 68.

Gap paragraph 69.

Gap paragraph 70.

Gap paragraph 71.

Gap paragraph 72.

Gap paragraph 73.

Gap paragraph 74.

Gap paragraph 75.

Gap paragraph 76.

Gap paragraph 77.

Gap paragraph 78.

Gap paragraph 79.

Gap paragraph 80.

Gap paragraph 81.

Gap paragraph 82.

Gap paragraph 83.

Gap paragraph 84.

Gap paragraph 85.

Gap paragraph 86.

Gap paragraph 87.

Gap paragraph 88.

Gap paragraph 89.

Gap paragraph 90.

Gap paragraph 91.

Gap paragraph 92.

Gap paragraph 93.

Gap paragraph 94.

Gap paragraph 95.

Gap paragraph 96.

Gap paragraph 97.

Gap paragraph 98.

Gap paragraph 99.

Gap paragraph 100.

Gap paragraph 101.

Gap paragraph 102.

Gap paragraph 103.

Gap paragraph 104.

Gap paragraph 105.

Gap paragraph 106.

Gap paragraph 107.

Gap paragraph 108.

Gap paragraph 109.

Gap paragraph 110.

Gap paragraph 111.

Gap paragraph 112.

Gap paragraph 113.

Gap paragraph 114.

Gap paragraph 115.

Gap paragraph 116.

Gap paragraph 117.

Gap paragraph 118.

Gap paragraph 119.

## Notes

second notes body

```
row 001 | 2026-08-18T09:00:01.549Z | render.worker | watcher dropped 302 events
row 002 | 2026-08-18T09:00:02.549Z | render.worker | watcher dropped 304 events
row 003 | 2026-08-18T09:00:03.549Z | render.worker | watcher dropped 306 events
row 004 | 2026-08-18T09:00:04.549Z | render.worker | watcher dropped 308 events
row 005 | 2026-08-18T09:00:05.549Z | render.worker | watcher dropped 310 events
row 006 | 2026-08-18T09:00:06.549Z | render.worker | watcher dropped 312 events
row 007 | 2026-08-18T09:00:07.549Z | render.worker | watcher dropped 314 events
row 008 | 2026-08-18T09:00:08.549Z | render.worker | watcher dropped 316 events
row 009 | 2026-08-18T09:00:09.549Z | render.worker | watcher dropped 318 events
row 010 | 2026-08-18T09:00:10.549Z | render.worker | watcher dropped 320 events
row 011 | 2026-08-18T09:00:11.549Z | render.worker | watcher dropped 322 events
row 012 | 2026-08-18T09:00:12.549Z | render.worker | watcher dropped 324 events
row 013 | 2026-08-18T09:00:13.549Z | render.worker | watcher dropped 326 events
row 014 | 2026-08-18T09:00:14.549Z | render.worker | watcher dropped 328 events
row 015 | 2026-08-18T09:00:15.549Z | render.worker | watcher dropped 330 events
row 016 | 2026-08-18T09:00:16.549Z | render.worker | watcher dropped 332 events
row 017 | 2026-08-18T09:00:17.549Z | render.worker | watcher dropped 334 events
row 018 | 2026-08-18T09:00:18.549Z | render.worker | watcher dropped 336 events
row 019 | 2026-08-18T09:00:19.549Z | render.worker | watcher dropped 338 events
row 020 | 2026-08-18T09:00:20.549Z | render.worker | watcher dropped 340 events
row 021 | 2026-08-18T09:00:21.549Z | render.worker | watcher dropped 342 events
row 022 | 2026-08-18T09:00:22.549Z | render.worker | watcher dropped 344 events
row 023 | 2026-08-18T09:00:23.549Z | render.worker | watcher dropped 346 events
row 024 | 2026-08-18T09:00:24.549Z | render.worker | watcher dropped 348 events
row 025 | 2026-08-18T09:00:25.549Z | render.worker | watcher dropped 350 events
row 026 | 2026-08-18T09:00:26.549Z | render.worker | watcher dropped 352 events
row 027 | 2026-08-18T09:00:27.549Z | render.worker | watcher dropped 354 events
row 028 | 2026-08-18T09:00:28.549Z | render.worker | watcher dropped 356 events
row 029 | 2026-08-18T09:00:29.549Z | render.worker | watcher dropped 358 events
row 030 | 2026-08-18T09:00:30.549Z | render.worker | watcher dropped 360 events
row 031 | 2026-08-18T09:00:31.549Z | render.worker | watcher dropped 362 events
row 032 | 2026-08-18T09:00:32.549Z | render.worker | watcher dropped 364 events
row 033 | 2026-08-18T09:00:33.549Z | render.worker | watcher dropped 366 events
row 034 | 2026-08-18T09:00:34.549Z | render.worker | watcher dropped 368 events
row 035 | 2026-08-18T09:00:35.549Z | render.worker | watcher dropped 370 events
row 036 | 2026-08-18T09:00:36.549Z | render.worker | watcher dropped 372 events
row 037 | 2026-08-18T09:00:37.549Z | render.worker | watcher dropped 374 events
row 038 | 2026-08-18T09:00:38.549Z | render.worker | watcher dropped 376 events
row 039 | 2026-08-18T09:00:39.549Z | render.worker | watcher dropped 378 events
row 040 | 2026-08-18T09:00:40.549Z | render.worker | watcher dropped 380 events
row 041 | 2026-08-18T09:00:41.549Z | render.worker | watcher dropped 382 events
row 042 | 2026-08-18T09:00:42.549Z | render.worker | watcher dropped 384 events
row 043 | 2026-08-18T09:00:43.549Z | render.worker | watcher dropped 386 events
row 044 | 2026-08-18T09:00:44.549Z | render.worker | watcher dropped 388 events
row 045 | 2026-08-18T09:00:45.549Z | render.worker | watcher dropped 390 events
row 046 | 2026-08-18T09:00:46.549Z | render.worker | watcher dropped 392 events
row 047 | 2026-08-18T09:00:47.549Z | render.worker | watcher dropped 394 events
row 048 | 2026-08-18T09:00:48.549Z | render.worker | watcher dropped 396 events
row 049 | 2026-08-18T09:00:49.549Z | render.worker | watcher dropped 398 events
row 050 | 2026-08-18T09:00:50.549Z | render.worker | watcher dropped 400 events
row 051 | 2026-08-18T09:00:51.549Z | render.worker | watcher dropped 402 events
row 052 | 2026-08-18T09:00:52.549Z | render.worker | watcher dropped 404 events
row 053 | 2026-08-18T09:00:53.549Z | render.worker | watcher dropped 406 events
row 054 | 2026-08-18T09:00:54.549Z | render.worker | watcher dropped 408 events
row 055 | 2026-08-18T09:00:55.549Z | render.worker | watcher dropped 410 events
row 056 | 2026-08-18T09:00:56.549Z | render.worker | watcher dropped 412 events
row 057 | 2026-08-18T09:00:57.549Z | render.worker | watcher dropped 414 events
row 058 | 2026-08-18T09:00:58.549Z | render.worker | watcher dropped 416 events
row 059 | 2026-08-18T09:00:59.549Z | render.worker | watcher dropped 418 events
row 060 | 2026-08-18T09:00:00.549Z | render.worker | watcher dropped 420 events
row 061 | 2026-08-18T09:00:01.549Z | render.worker | watcher dropped 422 events
row 062 | 2026-08-18T09:00:02.549Z | render.worker | watcher dropped 424 events
row 063 | 2026-08-18T09:00:03.549Z | render.worker | watcher dropped 426 events
row 064 | 2026-08-18T09:00:04.549Z | render.worker | watcher dropped 428 events
row 065 | 2026-08-18T09:00:05.549Z | render.worker | watcher dropped 430 events
row 066 | 2026-08-18T09:00:06.549Z | render.worker | watcher dropped 432 events
row 067 | 2026-08-18T09:00:07.549Z | render.worker | watcher dropped 434 events
row 068 | 2026-08-18T09:00:08.549Z | render.worker | watcher dropped 436 events
row 069 | 2026-08-18T09:00:09.549Z | render.worker | watcher dropped 438 events
row 070 | 2026-08-18T09:00:10.549Z | render.worker | watcher dropped 440 events
row 071 | 2026-08-18T09:00:11.549Z | render.worker | watcher dropped 442 events
row 072 | 2026-08-18T09:00:12.549Z | render.worker | watcher dropped 444 events
row 073 | 2026-08-18T09:00:13.549Z | render.worker | watcher dropped 446 events
row 074 | 2026-08-18T09:00:14.549Z | render.worker | watcher dropped 448 events
row 075 | 2026-08-18T09:00:15.549Z | render.worker | watcher dropped 450 events
row 076 | 2026-08-18T09:00:16.549Z | render.worker | watcher dropped 452 events
row 077 | 2026-08-18T09:00:17.549Z | render.worker | watcher dropped 454 events
row 078 | 2026-08-18T09:00:18.549Z | render.worker | watcher dropped 456 events
row 079 | 2026-08-18T09:00:19.549Z | render.worker | watcher dropped 458 events
row 080 | 2026-08-18T09:00:20.549Z | render.worker | watcher dropped 460 events
row 081 | 2026-08-18T09:00:21.549Z | render.worker | watcher dropped 462 events
row 082 | 2026-08-18T09:00:22.549Z | render.worker | watcher dropped 464 events
row 083 | 2026-08-18T09:00:23.549Z | render.worker | watcher dropped 466 events
row 084 | 2026-08-18T09:00:24.549Z | render.worker | watcher dropped 468 events
row 085 | 2026-08-18T09:00:25.549Z | render.worker | watcher dropped 470 events
row 086 | 2026-08-18T09:00:26.549Z | render.worker | watcher dropped 472 events
row 087 | 2026-08-18T09:00:27.549Z | render.worker | watcher dropped 474 events
row 088 | 2026-08-18T09:00:28.549Z | render.worker | watcher dropped 476 events
row 089 | 2026-08-18T09:00:29.549Z | render.worker | watcher dropped 478 events
row 090 | 2026-08-18T09:00:30.549Z | render.worker | watcher dropped 480 events
row 091 | 2026-08-18T09:00:31.549Z | render.worker | watcher dropped 482 events
row 092 | 2026-08-18T09:00:32.549Z | render.worker | watcher dropped 484 events
row 093 | 2026-08-18T09:00:33.549Z | render.worker | watcher dropped 486 events
row 094 | 2026-08-18T09:00:34.549Z | render.worker | watcher dropped 488 events
row 095 | 2026-08-18T09:00:35.549Z | render.worker | watcher dropped 490 events
row 096 | 2026-08-18T09:00:36.549Z | render.worker | watcher dropped 492 events
row 097 | 2026-08-18T09:00:37.549Z | render.worker | watcher dropped 494 events
row 098 | 2026-08-18T09:00:38.549Z | render.worker | watcher dropped 496 events
row 099 | 2026-08-18T09:00:39.549Z | render.worker | watcher dropped 498 events
row 100 | 2026-08-18T09:00:40.549Z | render.worker | watcher dropped 500 events
row 101 | 2026-08-18T09:00:41.549Z | render.worker | watcher dropped 502 events
row 102 | 2026-08-18T09:00:42.549Z | render.worker | watcher dropped 504 events
row 103 | 2026-08-18T09:00:43.549Z | render.worker | watcher dropped 506 events
row 104 | 2026-08-18T09:00:44.549Z | render.worker | watcher dropped 508 events
row 105 | 2026-08-18T09:00:45.549Z | render.worker | watcher dropped 510 events
row 106 | 2026-08-18T09:00:46.549Z | render.worker | watcher dropped 512 events
row 107 | 2026-08-18T09:00:47.549Z | render.worker | watcher dropped 514 events
row 108 | 2026-08-18T09:00:48.549Z | render.worker | watcher dropped 516 events
row 109 | 2026-08-18T09:00:49.549Z | render.worker | watcher dropped 518 events
row 110 | 2026-08-18T09:00:50.549Z | render.worker | watcher dropped 520 events
row 111 | 2026-08-18T09:00:51.549Z | render.worker | watcher dropped 522 events
row 112 | 2026-08-18T09:00:52.549Z | render.worker | watcher dropped 524 events
row 113 | 2026-08-18T09:00:53.549Z | render.worker | watcher dropped 526 events
row 114 | 2026-08-18T09:00:54.549Z | render.worker | watcher dropped 528 events
row 115 | 2026-08-18T09:00:55.549Z | render.worker | watcher dropped 530 events
row 116 | 2026-08-18T09:00:56.549Z | render.worker | watcher dropped 532 events
row 117 | 2026-08-18T09:00:57.549Z | render.worker | watcher dropped 534 events
row 118 | 2026-08-18T09:00:58.549Z | render.worker | watcher dropped 536 events
row 119 | 2026-08-18T09:00:59.549Z | render.worker | watcher dropped 538 events
row 120 | 2026-08-18T09:00:00.549Z | render.worker | watcher dropped 540 events
```
MDEOF
cat >"$WORK/hostile.md" <<'MDEOF'
<script>window.__mdPwned = 'block'</script>

An inline image: <img src="does-not-exist" onerror="window.__mdPwned = 'img'">

A [bad link](javascript:window.__mdPwned='link')
MDEOF
# Just over MAX_PREVIEW_CHARS (10,000,000) so the ceiling actually trips. One
# record per line on purpose: a single 10M-character line trips the long-line
# open gate instead, which stages the tab behind a confirm and never opens it —
# the file then never reaches the preview at all.
node -e '
  const fs = require("fs");
  const parts = ["[\n"];
  let len = 2;
  let i = 0;
  while (len < 10_000_100) {
    const row =
      (i === 0 ? "  " : ",\n  ") +
      JSON.stringify({ id: i, note: "padding value for size" });
    parts.push(row);
    len += row.length;
    i += 1;
  }
  parts.push("\n]\n");
  fs.writeFileSync(process.argv[1], parts.join(""));
' "$WORK/huge.json"
echo "huge.json: $(file_size "$WORK/huge.json") bytes"
# Same ceiling as huge.json, but markdown enforces its own (much higher) limit,
# so this must land under json's/xml's 10,000,000 and still be read whole.
# Many short lines, never one giant line, for the same reason as huge.json.
node -e '
  const fs = require("fs");
  const lines = [];
  let len = 0;
  let i = 0;
  while (len < 10_000_100) {
    const line = "line " + i + " padding text for size\n";
    lines.push(line);
    len += line.length;
    i += 1;
  }
  fs.writeFileSync(process.argv[1], lines.join(""));
' "$WORK/huge.md"
echo "huge.md: $(file_size "$WORK/huge.md") bytes"
# Over the 100MB large-file threshold, valid UTF-8, and line-broken so the
# windowed unlock can accept it. Written the same way e2e-windowed.sh writes
# its fixture, in blocks rather than line by line.
python3 - <<PYEOF
# 40 bytes per line including the newline; size the run from that rather than
# copying another suite's line count, which silently produced a 91MB file that
# never crossed the threshold and made this whole section pass for the wrong
# reason.
line_bytes = 40
n = (115 * 1024 * 1024) // line_bytes
with open('$WORK/big.json', 'w', newline='') as f:
    buf = []
    for i in range(n):
        buf.append('{"id": %s, "note": "padding"}' % f'{i:012d}')
        if len(buf) == 20000:
            f.write('\n'.join(buf) + '\n')
            buf = []
    if buf:
        f.write('\n'.join(buf) + '\n')
PYEOF
BIG_SIZE=$(file_size "$WORK/big.json")
echo "big.json: $BIG_SIZE bytes"
if [ "$BIG_SIZE" -le 104857600 ]; then
  echo "FATAL: big.json is under the 100MB large-file threshold; sections I/J would test nothing"
  exit 1
fi

launch
trap 'quit_app' EXIT INT TERM
open_doc

echo "=== A. three tabs, each with a remembered mode ==="
evl "$DL" "__auto.openTab('$WORK/b.csv')" >/dev/null
sleep 2
evl "$DL" "__auto.openTab('$WORK/c.csv')" >/dev/null
sleep 2
check "three tabs open" "$(tab_count)" "3"
# The map only gains an entry when a mode is actually chosen, so choose one on
# every tab; 'source' is the non-default for a .csv, which also proves the
# switch took effect rather than silently no-opping.
for i in 0 1 2; do
  evl "$DL" "__auto.switchTab($i)" >/dev/null
  sleep 1
  evl "$DL" "__auto.setViewMode('source')" >/dev/null
  sleep 1
done
check "all three tabs remembered" "$(entry_count)" "3"

echo "=== B. closing clean tabs forgets their modes ==="
evl "$DL" "__auto.switchTab(2)" >/dev/null
sleep 1
evl "$DL" "__auto.closeActiveTab()" >/dev/null
sleep 2
evl "$DL" "__auto.switchTab(1)" >/dev/null
sleep 1
evl "$DL" "__auto.closeActiveTab()" >/dev/null
sleep 2
check "one tab left" "$(tab_count)" "1"
check "one remembered mode left" "$(entry_count)" "1"

echo "=== C. the dirty-close 'don't save' route clears its entry too ==="
evl "$DL" "__auto.openTab('$WORK/b.csv')" >/dev/null
sleep 2
evl "$DL" "__auto.setViewMode('source')" >/dev/null
sleep 1
check "two remembered modes" "$(entry_count)" "2"
# Dirty the tab through the table editor, which is the only content mutation
# the automation surface exposes for a .csv tab.
evl "$DL" "__auto.setViewMode('table')" >/dev/null
sleep 1
evl "$DL" "__auto.setTableCell(1,0,'99')" >/dev/null
sleep 2
evl "$DL" "__auto.closeActiveTab()" >/dev/null
sleep 2
MODAL=$(evl "$DL" "String(document.querySelectorAll('.modal-actions .btn').length)")
check "confirm modal raised" "$MODAL" "3"
# Buttons render primary (save), secondary (don't save), cancel — take the
# middle one so the tab closes without writing the fixture back to disk.
evl "$DL" "document.querySelectorAll('.modal-actions .btn')[1].click()" >/dev/null
sleep 3
check "back to one tab" "$(tab_count)" "1"
check "discarded tab forgotten" "$(entry_count)" "1"

echo "=== D. the JSON preview switches on and off ==="
evl "$DL" "__auto.openTab('$WORK/good.json')" >/dev/null
sleep 2
check "json tab starts in source" "$(evl "$DL" "String(__auto.getViewMode())")" "source"
check "switcher offers two modes" "$(mode_option_count)" "2"
evl "$DL" "__auto.setViewMode('json')" >/dev/null
sleep 2
check "switched to the preview" "$(evl "$DL" "String(__auto.getViewMode())")" "json"
check "tree rendered" "$(evl "$DL" "String(document.querySelectorAll('.json-view .row').length > 0)")" "true"
check "no raw html was injected" "$(evl "$DL" "String(document.querySelectorAll('.json-view script').length)")" "0"
evl "$DL" "__auto.setViewMode('source')" >/dev/null
sleep 2
check "switched back" "$(evl "$DL" "String(__auto.getViewMode())")" "source"
check "preview unmounted" "$(evl "$DL" "String(document.querySelectorAll('.json-view').length)")" "0"

echo "=== E. a syntax error shows a message rather than an empty pane ==="
evl "$DL" "__auto.openTab('$WORK/bad.json')" >/dev/null
sleep 2
evl "$DL" "__auto.setViewMode('json')" >/dev/null
sleep 2
check "error shown" "$(evl "$DL" "String((document.querySelector('.json-view .error')||{}).textContent||'').length > 0")" "true"
check "no tree rows for a failed parse" "$(evl "$DL" "String(document.querySelectorAll('.json-view .row').length)")" "0"

echo "=== F. past the preview ceiling the option is disabled, not hidden ==="
evl "$DL" "__auto.openTab('$WORK/huge.json')" >/dev/null
# A ten-megabyte file takes its time to land; asserting on a fixed sleep read
# the *previous* tab and quietly passed the wrong thing. Wait for the active
# tab to actually be the big one before looking at the switcher.
e2e_wait_eval "$DL" "String(__auto.activeContentLength() > 10000000)" "true"
check "the big tab is the active one" "$(evl "$DL" "String(__auto.activeContentLength() > 10000000)")" "true"
check "switcher still shown" "$(mode_option_count)" "2"
check "json option disabled" "$(disabled_count)" "1"
check "disabled option explains itself" "$(evl "$DL" "String(Array.from(document.querySelectorAll('.statusbar .right option')).filter((o)=>o.disabled).every((o)=>o.title.length>0))")" "true"

echo "=== G. the markdown preview switches on and off ==="
evl "$DL" "__auto.openTab('$WORK/doc.md')" >/dev/null
sleep 2
check "markdown tab starts in source" "$(evl "$DL" "String(__auto.getViewMode())")" "source"
check "switcher offers two modes" "$(mode_option_count)" "2"
evl "$DL" "__auto.setViewMode('markdown')" >/dev/null
sleep 2
check "switched to the preview" "$(evl "$DL" "String(__auto.getViewMode())")" "markdown"
check "at least one block rendered" "$(evl "$DL" "String(document.querySelectorAll('.markdown-view .blocks > *').length > 0)")" "true"
check "the heading text is shown" "$(evl "$DL" "String((document.querySelector('.markdown-view .heading')||{}).textContent||'').trim()")" "Title"
check "emphasis marks were stripped, not left as source" "$(evl "$DL" "String((document.querySelector('.markdown-view')||{}).textContent.includes('**'))")" "false"
check "the fenced code block kept its blank line" "$(evl "$DL" "String((document.querySelector('.markdown-view pre.block')||{}).textContent.includes('code line one\n\ncode line two'))")" "true"
check "the loose list has two items" "$(evl "$DL" "String(document.querySelectorAll('.markdown-view li').length)")" "2"
check "the table rendered its one data row" "$(evl "$DL" "String(document.querySelectorAll('.markdown-view table td').length)")" "2"
check "the rule rendered" "$(evl "$DL" "String(document.querySelectorAll('.markdown-view hr').length)")" "1"
evl "$DL" "__auto.setViewMode('source')" >/dev/null
sleep 2
check "switched back" "$(evl "$DL" "String(__auto.getViewMode())")" "source"
check "preview unmounted" "$(evl "$DL" "String(document.querySelectorAll('.markdown-view').length)")" "0"

echo "=== H. find from a preview returns to the editor first ==="
evl "$DL" "__auto.openTab('$WORK/good.json')" >/dev/null
sleep 2
evl "$DL" "__auto.setViewMode('json')" >/dev/null
sleep 2
evl "$DL" "__auto.openFind()" >/dev/null
sleep 2
check "back on the editor" "$(evl "$DL" "String(__auto.getViewMode())")" "source"
check "search panel open" "$(evl "$DL" "String(__auto.searchPanelOpen())")" "true"
evl "$DL" "__auto.closeFind()" >/dev/null
sleep 1

echo "=== I. anchor links jump to their heading ==="
# Anchors are deliberately not behind the preview-local-resources setting: the
# jump stays inside the document. So this runs with the setting at its default.
evl "$DL" "__auto.openTab('$WORK/anchors.md')" >/dev/null
sleep 2
evl "$DL" "__auto.setViewMode('markdown')" >/dev/null
sleep 2
check "an anchor with a matching heading is a link" \
  "$(evl "$DL" "String(!!document.querySelector('.markdown-view a[href=\"#install-steps\"]'))")" "true"
check "an anchor naming no heading is not a link" \
  "$(evl "$DL" "String(!!document.querySelector('.markdown-view a[href=\"#missing\"]'))")" "false"
check "the dead anchor still shows its text" \
  "$(evl "$DL" "String(document.querySelector('.markdown-view').textContent.includes('nowhere'))")" "true"
check "the target heading is not rendered yet" \
  "$(evl "$DL" "String(document.querySelector('.markdown-view').textContent.includes('Install Steps'))")" "false"
check "starts at the top" \
  "$(evl "$DL" "String(document.querySelector('.markdown-view').scrollTop)")" "0"
evl "$DL" "document.querySelector('.markdown-view a[href=\"#install-steps\"]').click()" >/dev/null
sleep 2
check "the click scrolled away from the top" \
  "$(evl "$DL" "String(document.querySelector('.markdown-view').scrollTop > 0)")" "true"
check "the target heading is on screen now" \
  "$(evl "$DL" "String(document.querySelector('.markdown-view').textContent.includes('Install Steps'))")" "true"
# Two headings share the text "Notes". The bodies sit far enough apart that the
# rendered window can hold one but not both, which is the only arrangement that
# tells a suffixed lookup apart from a first-match one.
evl "$DL" "document.querySelector('.markdown-view').scrollTop = 0" >/dev/null
sleep 1
evl "$DL" "document.querySelector('.markdown-view a[href=\"#notes\"]').click()" >/dev/null
sleep 2
check "the bare anchor reached the first heading of that name" \
  "$(evl "$DL" "String(document.querySelector('.markdown-view').textContent.includes('first notes body'))")" "true"
check "and did not reach the second" \
  "$(evl "$DL" "String(document.querySelector('.markdown-view').textContent.includes('second notes body'))")" "false"
evl "$DL" "document.querySelector('.markdown-view').scrollTop = 0" >/dev/null
sleep 1
evl "$DL" "document.querySelector('.markdown-view a[href=\"#notes-1\"]').click()" >/dev/null
sleep 2
check "the suffixed anchor reached the second heading of that name" \
  "$(evl "$DL" "String(document.querySelector('.markdown-view').textContent.includes('second notes body'))")" "true"
check "and not the first" \
  "$(evl "$DL" "String(document.querySelector('.markdown-view').textContent.includes('first notes body'))")" "false"

# The right blocks being in the DOM is not enough: `.blocks` is absolutely
# positioned, so a wrong offset leaves an empty pane with every block present.
# One stop per call with a settle between — writing `scrollTop` and reading the
# box back in the same task measures the previous window at its previous
# position, because Svelte has not re-rendered yet.
BLIND=0
for FRAC in 0 25 50 75 100 75 50 25 0; do
  evl "$DL" "(()=>{const el=document.querySelector('.markdown-view');el.scrollTop=Math.round((el.scrollHeight-el.clientHeight)*$FRAC/100);return '';})()" >/dev/null
  sleep 2
  # Assigned first rather than substituted straight into `[`: this shell's
  # `$( )` mis-parses a nested expansion carrying JS this brace-heavy, and the
  # failure is a `[` error the loop would count as a pass.
  TOUCHING=$(evl "$DL" "(()=>{const el=document.querySelector('.markdown-view');if(el===null){return 'false';}const b=el.querySelector('.blocks');if(b===null){return 'false';}const s=el.getBoundingClientRect(),r=b.getBoundingClientRect();return String(Math.min(s.bottom,r.bottom)-Math.max(s.top,r.top)>0);})()")
  if [ "$TOUCHING" != "true" ]; then
    BLIND=$((BLIND + 1))
  fi
done
check "the rendered blocks touch the viewport at every scroll position, both directions" \
  "$BLIND" "0"
evl "$DL" "document.querySelector('.markdown-view').scrollTop = 0" >/dev/null
sleep 1
evl "$DL" "__auto.setViewMode('source')" >/dev/null
sleep 2

# NOT covered here: that the preview ceiling never disables the table view. A
# .csv opens straight into the table, and rendering a quarter of a million rows
# leaves the webview unresponsive long enough that the rest of the suite stops
# answering — existing behaviour, since the table view has no size ceiling of
# its own. The rule itself is exhaustively covered by modeBlockedBy's unit
# tests in src/lib/util/viewModes.test.ts, which is where it belongs.

# Heaviest section last: it needs a file over the 100MB large-file threshold.
echo "=== J. a read-only large tab keeps the status bar it always had ==="
ORIG_MODE=$(evl "$DL" "String(__auto.getLargeOpenMode())")
echo "original large_open_mode: $ORIG_MODE"
restore_mode() {
  if [ -n "${ORIG_MODE:-}" ] && [ -f "$APPDIR/settings.json" ]; then
    jq --arg m "$ORIG_MODE" '.large_open_mode = $m' "$APPDIR/settings.json" \
      >"$APPDIR/settings.json.tmp" \
      && mv "$APPDIR/settings.json.tmp" "$APPDIR/settings.json"
  fi
}
trap 'quit_app; restore_mode' EXIT INT TERM
evl "$DL" "__auto.setLargeOpenMode('view')" >/dev/null
e2e_wait_setting large_open_mode "view"
evl "$DL" "__auto.openTab('$WORK/big.json')" >/dev/null
e2e_wait_until 180 _e2e_eval_equals "$DL" "String(__auto.isLargeTab())" "true"
check "opened as a large read-only tab" "$(evl "$DL" "String(__auto.isLargeTab())")" "true"
check "large tab has no view switcher, exactly as before" "$(mode_option_count)" "0"

echo "=== K. a windowed tab shows the switcher with everything but source off ==="
evl "$DL" "__auto.setLargeOpenMode('edit')" >/dev/null
e2e_wait_setting large_open_mode "edit"
evl "$DL" "__auto.largeUnlockEdit().then((r)=>{window.__u=r;})" >/dev/null
e2e_wait_until 180 _e2e_eval_equals "$DL" "String(__auto.isWindowedTab())" "true"
check "unlocked into windowed editing" "$(evl "$DL" "String(__auto.isWindowedTab())")" "true"
check "switcher is still there" "$(mode_option_count)" "2"
check "every non-source option is off" "$(disabled_count)" "1"
check "the disabled option says why" "$(evl "$DL" "String(Array.from(document.querySelectorAll('.statusbar .right option')).filter((o)=>o.disabled).every((o)=>o.title.length>0))")" "true"
check "the tab itself stays on source" "$(evl "$DL" "String(__auto.getViewMode())")" "source"

echo
echo "=== L. the XML preview switches on and off ==="
open_and_confirm "$WORK/doc.xml"
check "xml tab starts in source" "$(evl "$DL" "String(__auto.getViewMode())")" "source"
check "switcher offers two modes" "$(mode_option_count)" "2"
evl "$DL" "__auto.setViewMode('xml')" >/dev/null
sleep 2
check "switched to the preview" "$(evl "$DL" "String(__auto.getViewMode())")" "xml"
check "tree rendered" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length > 0)")" "true"
check "the element name is shown" "$(evl "$DL" "String((document.querySelector('.xml-view')||{}).textContent.includes('<item>'))")" "true"
check "its attributes are shown" "$(evl "$DL" "String((document.querySelector('.xml-view')||{}).textContent.includes('lang'))")" "true"
# Collapsed subtrees are not built: the empty element and the comment are
# siblings of item, so the root must be open while their children are not.
check "a collapsed row builds no children" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length < 12)")" "true"
# Expanding is driven by a plain click, and the rows are rebuilt from the
# expansion set on every scroll. A set that mutates without notifying passes
# every unit test and never redraws, so this has to be clicked for real.
# Twisty 0 is the root, which starts open — clicking it would collapse. Twisty 1
# is the first child, which starts closed.
ROWS_CLOSED=$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length)")
OPEN_CLOSED=$(evl "$DL" "String(document.querySelectorAll('.xml-view .twisty[aria-expanded]').length)")
evl "$DL" "document.querySelectorAll('.xml-view .row .twisty')[1].click()" >/dev/null
sleep 1
check "expanding a child shows more rows" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length > $ROWS_CLOSED)")" "true"
check "one more row now reports itself expanded" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .twisty[aria-expanded=\"true\"]').length)")" "2"
evl "$DL" "document.querySelectorAll('.xml-view .row .twisty')[1].click()" >/dev/null
sleep 1
check "collapsing it takes them away again" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length)")" "$ROWS_CLOSED"
evl "$DL" "__auto.setViewMode('source')" >/dev/null
sleep 2
check "switched back" "$(evl "$DL" "String(__auto.getViewMode())")" "source"
check "preview unmounted" "$(evl "$DL" "String(document.querySelectorAll('.xml-view').length)")" "0"
# Closing the preview releases its copy of the document. Reopening has to parse
# it again from scratch — if the release left anything half-torn-down, this is
# where an empty pane shows up.
evl "$DL" "__auto.setViewMode('xml')" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelectorAll('.xml-view .row').length > 0)" "true"
check "reopening after the release renders again" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length > 0)")" "true"
check "and the element name is still right" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row .tag')[0].textContent)")" "<root>"
evl "$DL" "__auto.setViewMode('source')" >/dev/null
sleep 1

echo "=== M. a malformed document shows a message rather than an empty pane ==="
open_and_confirm "$WORK/bad.xml"
evl "$DL" "__auto.setViewMode('xml')" >/dev/null
sleep 2
check "error shown" "$(evl "$DL" "String((document.querySelector('.xml-view .error')||{}).textContent||'').length > 0")" "true"
check "no tree rows for a failed parse" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length)")" "0"

echo "=== N. no node of the parsed document reaches the screen ==="
evl "$DL" "window.__xmlPwned = undefined" >/dev/null
open_and_confirm "$WORK/hostile.xml"
evl "$DL" "__auto.setViewMode('xml')" >/dev/null
sleep 3
# Premise: the hostile document really did parse and render, otherwise every
# assertion below is vacuously true.
check "the hostile document rendered" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length > 0)")" "true"
check "its script element is visible as text" "$(evl "$DL" "String((document.querySelector('.xml-view')||{}).textContent.includes('script'))")" "true"
check "its handler attribute is visible as text" "$(evl "$DL" "String((document.querySelector('.xml-view')||{}).textContent.includes('onclick'))")" "true"
# The conclusions.
check "nothing from the document ran" "$(evl "$DL" "String(window.__xmlPwned === undefined)")" "true"
check "no script element was inserted" "$(evl "$DL" "String(document.querySelectorAll('.xml-view script').length)")" "0"
check "no image element was inserted" "$(evl "$DL" "String(document.querySelectorAll('.xml-view img').length)")" "0"
check "every rendered element is one the view builds itself" "$(evl "$DL" "String([...document.querySelectorAll('.xml-view *')].every((e)=>['DIV','SPAN','BUTTON'].includes(e.tagName)))")" "true"
check "every rendered element is HTML-namespaced" "$(evl "$DL" "String([...document.querySelectorAll('.xml-view *')].every((e)=>e.namespaceURI==='http://www.w3.org/1999/xhtml'))")" "true"
check "no on* attribute survived onto a live element" "$(evl "$DL" "String([...document.querySelectorAll('.xml-view *')].some((e)=>[...e.attributes].some((a)=>a.name.toLowerCase().startsWith('on'))))")" "false"

echo "=== O. a valid document is not mistaken for a parse error ==="
open_and_confirm "$WORK/named-error.xml"
evl "$DL" "__auto.setViewMode('xml')" >/dev/null
sleep 2
check "the tree rendered" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length > 0)")" "true"
check "no error was reported" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .error').length)")" "0"
check "the element is shown as content" "$(evl "$DL" "String((document.querySelector('.xml-view')||{}).textContent.includes('parsererror'))")" "true"

echo "=== P. an entity-defining document previews without expanding anything ==="
open_and_confirm "$WORK/entities.xml"
evl "$DL" "__auto.setViewMode('xml')" >/dev/null
# The parse runs in slices now, so wait for the tree rather than guessing a
# sleep long enough for it.
e2e_wait_eval "$DL" "String(document.querySelectorAll('.xml-view .row').length > 0)" "true"
# The whole point: the window still answers. Parsing this used to wedge it for
# good, taking every other tab in the window with it, which is why the document
# used to be refused outright rather than previewed.
check "the window still answers" "$(evl "$DL" "String(6*7)")" "42"
check "the document previewed instead of being refused" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length > 0)")" "true"
check "no error message" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .error').length)")" "0"
# The reference is shown as the characters the author typed. Expanding it is
# what produced tens of millions of characters from a 794-byte file, so both
# halves matter: the text is there, and the pane did not grow.
check "the entity reference was not expanded" "$(evl "$DL" "String((document.querySelector('.xml-view')||{}).textContent.includes('&lol8;'))")" "true"
check "the pane did not blow up" "$(evl "$DL" "String((document.querySelector('.xml-view')||{}).textContent.length < 4000)")" "true"
evl "$DL" "__auto.setViewMode('source')" >/dev/null
sleep 2
check "the source view still works for it" "$(evl "$DL" "String(__auto.getViewMode())")" "source"

echo "=== Q. no node of the hostile markdown document reaches the screen ==="
evl "$DL" "window.__mdPwned = undefined" >/dev/null
open_and_confirm "$WORK/hostile.md"
evl "$DL" "__auto.setViewMode('markdown')" >/dev/null
sleep 2
# Premise: the hostile document really did render, otherwise every assertion
# below is vacuously true.
check "the hostile document rendered" "$(evl "$DL" "String(document.querySelectorAll('.markdown-view .blocks > *').length > 0)")" "true"
check "no script element was inserted" "$(evl "$DL" "String(document.querySelectorAll('.markdown-view script').length)")" "0"
check "no image element was inserted" "$(evl "$DL" "String(document.querySelectorAll('.markdown-view img').length)")" "0"
check "no anchor element was inserted" "$(evl "$DL" "String(document.querySelectorAll('.markdown-view a').length)")" "0"
check "nothing from the document ran" "$(evl "$DL" "String(window.__mdPwned === undefined)")" "true"
check "the script tag is visible as text" "$(evl "$DL" "String((document.querySelector('.markdown-view')||{}).textContent.includes('<script>'))")" "true"

echo "=== R. markdown is not held to the JSON/XML preview ceiling ==="
evl "$DL" "__auto.openTab('$WORK/huge.md')" >/dev/null
# huge.json (section F) proved a fixed sleep reads the previous tab and
# passes for the wrong reason; wait for the active tab to actually be this one.
e2e_wait_eval "$DL" "String(__auto.activeContentLength() > 10000000)" "true"
check "the big markdown tab is the active one" "$(evl "$DL" "String(__auto.activeContentLength() > 10000000)")" "true"
check "switcher still shown" "$(mode_option_count)" "2"
check "markdown option is not disabled, unlike json/xml past their ceiling" "$(disabled_count)" "0"
evl "$DL" "__auto.setViewMode('markdown')" >/dev/null
sleep 2
check "switched to the preview" "$(evl "$DL" "String(__auto.getViewMode())")" "markdown"
check "blocks actually rendered" "$(evl "$DL" "String(document.querySelectorAll('.markdown-view .blocks > *').length > 0)")" "true"

echo "=== S. a wide document renders a windowful of rows, not all of them ==="
open_and_confirm "$WORK/wide.xml"
evl "$DL" "__auto.setViewMode('xml')" >/dev/null
e2e_wait_eval "$DL" "String(document.querySelectorAll('.xml-view .row').length > 0)" "true"
# The root is a depth-0 row and starts open, so all 20,000 children are visible
# rows. Without virtualization every one of them would be in the DOM.
check "only a windowful is in the DOM" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length < 500)")" "true"
# ...but the scrollbar has to know they exist, otherwise "few rows" would also
# be what a broken view that lost the children looks like.
check "the scrollbar spans all of them" "$(evl "$DL" "String(document.querySelector('.xml-view .spacer').offsetHeight > 300000)")" "true"
# Collapsing the root is the discriminating half: the pane must actually shrink
# to one row, which a view that was ignoring the expansion state could not do.
evl "$DL" "document.querySelectorAll('.xml-view .row .twisty')[0].click()" >/dev/null
sleep 2
check "collapsing the root leaves one row" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row').length)")" "1"
check "and that row reports its twenty thousand children" "$(evl "$DL" "String(document.querySelectorAll('.xml-view .row .summary')[0].textContent)")" "20000"
check "the scrollbar shrank with it" "$(evl "$DL" "String(document.querySelector('.xml-view .spacer').offsetHeight < 1000)")" "true"
check "the window still answers" "$(evl "$DL" "String(6*7)")" "42"
evl "$DL" "__auto.setViewMode('source')" >/dev/null
sleep 2

echo "=== result: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
