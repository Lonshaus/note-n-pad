# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# Shared helpers for the Note&Pad E2E suites.
# Sourced by every scripts/e2e/*.sh so the OS-specific bits — scratch dir,
# app-data dir, file size, sparse-file creation, renderer process name — live
# in one portable place. OUT now resolves under TMPDIR, so on macOS it moves
# from the old /private/tmp to $TMPDIR/note-n-pad-e2e (the intended portable
# result); every other value resolves exactly as on master.

# Repo root, derived from this file's location (scripts/e2e -> two levels up).
E2E_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$E2E_LIB_DIR/../.." && pwd)"

# Tauri bundle identifier; the Rust core's app_data_dir() hangs off this.
E2E_APP_IDENTIFIER="net.lonshaus.note-n-pad"

# Throwaway scratch base for fixtures and dev logs. Honors TMPDIR (set on
# macOS, usually unset on Linux). The basename stays note-n-pad-e2e so the
# snapshot-cleanup guards can match fixture paths by substring.
E2E_TMP_BASE="${TMPDIR:-/tmp}"
OUT="${NOTE_N_PAD_E2E_OUT:-${E2E_TMP_BASE%/}/note-n-pad-e2e}"
OUT="${OUT%/}"

# Tauri v2 app_data_dir() for E2E_APP_IDENTIFIER:
#   macOS   -> ~/Library/Application Support/<id>
#   Linux   -> $XDG_DATA_HOME/<id>  (default ~/.local/share/<id>)
#   Windows -> %APPDATA%\<id>  (the Roaming folder)
app_data_dir() {
  case "$(uname -s)" in
    Darwin)
      printf '%s\n' "$HOME/Library/Application Support/$E2E_APP_IDENTIFIER"
      ;;
    MINGW64_NT* | MSYS_NT*)
      # $APPDATA is a Windows path with backslashes; cygpath -u is what the
      # runner actually has, the tr/sed pair is only a fallback for images
      # that lack it.
      if command -v cygpath >/dev/null 2>&1; then
        printf '%s/%s\n' "$(cygpath -u "$APPDATA")" "$E2E_APP_IDENTIFIER"
      else
        printf '%s/%s\n' "$(printf '%s' "$APPDATA" | sed 's#^\([A-Za-z]\):#/\L\1#; s#\\#/#g')" "$E2E_APP_IDENTIFIER"
      fi
      ;;
    *)
      printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/$E2E_APP_IDENTIFIER"
      ;;
  esac
}
APPDIR="$(app_data_dir)"
STORE="$APPDIR/snapshots"

# Byte size of a file. BSD stat (-f %z) and GNU stat (-c %s) disagree on flags,
# so use wc -c, which is portable and needs no platform branch.
file_size() {
  wc -c <"$1" | tr -d ' '
}

# Create a sparse file of <megabytes> MiB at <path>. Prefer GNU truncate, fall
# back to macOS mkfile, then a zero-count dd seek that works anywhere.
make_sparse_file() {
  local path="$1" mb="$2"
  if command -v truncate >/dev/null 2>&1; then
    truncate -s "${mb}M" "$path"
  elif command -v mkfile >/dev/null 2>&1; then
    mkfile -n "${mb}m" "$path"
  else
    dd if=/dev/zero of="$path" bs=1048576 count=0 seek="$mb" 2>/dev/null
  fi
}

# Name of the WebView renderer process, for RSS attribution in the memory
# checks. macOS shares a system WebContent process; Linux uses WebKitGTK;
# Windows uses WebView2, backed by msedgewebview2.exe.
webcontent_pattern() {
  case "$(uname -s)" in
    Darwin)
      printf '%s\n' "com.apple.WebKit.WebContent"
      ;;
    MINGW64_NT* | MSYS_NT*)
      printf '%s\n' "msedgewebview2.exe"
      ;;
    *)
      printf '%s\n' "WebKitWebProcess"
      ;;
  esac
}

# How long the wait helpers below poll before giving up, in seconds. Generous
# on purpose: every one of these waits is for something the app is expected to
# finish, so the bound only decides how long a genuine failure takes to report,
# never how long a passing run takes. The old hand-copied `tries > 30` bounds
# were tuned on a fast desktop and were not enough to unlock a 240 MB file into
# windowed editing on a 2-core VM. Override with
# NOTE_N_PAD_E2E_WAIT_SECS for a very slow or very fast machine.
E2E_WAIT_SECS="${NOTE_N_PAD_E2E_WAIT_SECS:-180}"

# Poll until <command...> succeeds, up to E2E_WAIT_SECS (or $1 seconds if the
# first argument is a bare integer). Returns 0 as soon as it succeeds, 1 on
# timeout — callers assert the real condition afterwards, so a timeout shows up
# as the assertion's own FAIL with its own message rather than a bare abort.
#
# Replaces ~60 hand-copied `until … tries=$((tries+1)) … break` blocks whose
# bounds were each written out separately.
e2e_wait_until() {
  local timeout="$E2E_WAIT_SECS"
  case "$1" in
    '' | *[!0-9]*) ;;
    *)
      timeout="$1"
      shift
      ;;
  esac
  local waited=0
  while ! "$@"; do
    if [ "$waited" -ge "$timeout" ]; then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 0
}

# Poll until settings.json's <key> equals <value>. A window created after a
# setting changes reads it while mounting, so asserting on a window opened right
# after the change is a race: on a slow machine it mounts with the old value and
# a 'view'/'edit' open still raises the 'ask' confirm. The on-disk
# file is the same source that window reads, so waiting for it is a real signal
# rather than a guessed number of seconds.
e2e_wait_setting() {
  e2e_wait_until _e2e_setting_equals "$1" "$2"
}
_e2e_setting_equals() {
  [ "$(jq -r --arg k "$1" '.[$k] // empty' "$APPDIR/settings.json" 2>/dev/null)" = "$2" ]
}

# Poll until the JS expression <expr> evaluated in window <label> equals
# <expected>. Needs the sourcing script's own `evl` helper, which every E2E
# script defines identically (it carries that script's automation id).
e2e_wait_eval() {
  local label="$1" expr="$2" expected="$3"
  e2e_wait_until _e2e_eval_equals "$label" "$expr" "$expected"
}
_e2e_eval_equals() {
  [ "$(evl "$1" "$2")" = "$3" ]
}

# Ports this project's own E2E run is allowed to reclaim: 1420 is the Vite dev
# server `tauri dev` spawns, 45678 is the automation socket the app listens on.
# Never add 5173 here (or anywhere else in these scripts) — it is the user's
# own dev server, not ours, and must never be touched.
E2E_OWNED_PORTS="1420 45678"

# Stop whatever is listening on our owned ports. Processes are
# identified by listening port via lsof, never by command-line pattern —
# `pkill -f vite` or `pkill -f "tauri dev"` also matches any other project's
# unrelated dev session, which is the bug this replaces. For each owned port:
# send SIGTERM, wait up to <timeout_s> seconds (default 3) for the port to
# free up, then SIGKILL anything still listening. A port with no listener
# (the common case) is skipped without error; always returns 0 so `set -e`
# callers are unaffected.
#
# Caveat: a process that has already stopped listening but is still alive
# (e.g. the app binary mid-shutdown, past the point it closed its socket) is
# invisible to a port-based check and won't be reached here. Left as a known
# gap rather than reintroducing a broad process-name pattern to cover it.
e2e_kill_owned_ports() {
  local timeout_s="${1:-3}" port pid waited
  for port in $E2E_OWNED_PORTS; do
    pid="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null)"
    if [ -z "$pid" ]; then
      continue
    fi
    kill $pid 2>/dev/null
    waited=0
    while [ "$waited" -lt "$timeout_s" ] && [ -n "$pid" ]; do
      sleep 1
      waited=$((waited + 1))
      pid="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null)"
    done
    if [ -n "$pid" ]; then
      kill -9 $pid 2>/dev/null
    fi
  done
  return 0
}
