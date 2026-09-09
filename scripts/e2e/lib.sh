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
# macOS, usually unset on Linux). On Windows, Git Bash's own TMPDIR resolves to
# an MSYS path that native tools (python, the app) cannot see, so cygpath -m
# is used instead to get the mixed form (C:/Users/...) that every consumer
# accepts. The basename stays note-n-pad-e2e so the snapshot-cleanup guards can
# match fixture paths by substring.
case "$(uname -s)" in
  MINGW64_NT* | MSYS_NT*)
    E2E_TMP_BASE="$(cygpath -m "${TEMP:-$LOCALAPPDATA/Temp}")"
    ;;
  *)
    E2E_TMP_BASE="${TMPDIR:-/tmp}"
    ;;
esac
OUT="${NOTE_N_PAD_E2E_OUT:-${E2E_TMP_BASE%/}/note-n-pad-e2e}"
OUT="${OUT%/}"
# Echoed to stderr, not stdout: the workflow captures this file's OUT by
# running `bash -c '. scripts/e2e/lib.sh; printf %s "$OUT"'`, and an extra
# stdout line here would corrupt that captured path. Each suite's own log
# still tees stderr, so this line lands there.
echo "e2e: OUT=$OUT" >&2

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
      # $APPDATA is a Windows path with backslashes; cygpath -m gives the
      # mixed form (C:/Users/...) that shell built-ins, jq, rm and ls all
      # accept, and that matches the OUT convention above. The tr/sed pair is
      # only a fallback for images that lack cygpath.
      if command -v cygpath >/dev/null 2>&1; then
        printf '%s/%s\n' "$(cygpath -m "$APPDATA")" "$E2E_APP_IDENTIFIER"
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

# Next eval request id, unique across the whole suite run. The 3 s
# EVAL_TIMEOUT lets an eval's JS keep running after wait() gives up on it; a
# late automation_result() then fills whatever slot currently carries that
# id, corrupting an unrelated later eval, if every request reuses the same
# literal id. The counter is a file under $OUT rather than a shell variable
# because nearly every `evl` call runs inside `$( )`, and a variable
# incremented in a subshell is lost the moment it exits. Seeded at 1000 so it
# never collides with the small literal ids the non-eval commands use. The
# suites are single-threaded, so no locking is needed.
E2E_ID_FILE="$OUT/req-id"
e2e_next_id() {
  local next
  # A write that fails leaves the counter at its seed, which is the very bug
  # this replaces, so make sure the directory exists rather than trusting the
  # caller to have created it.
  mkdir -p "$OUT" 2>/dev/null
  next="$(cat "$E2E_ID_FILE" 2>/dev/null || echo 1000)"
  echo "$((next + 1))" >"$E2E_ID_FILE"
  printf '%s\n' "$next"
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

# Read the JS expression <js> in window <label> through the suite-local `evl`,
# retrying only while the result is exactly `null`: automation.rs times an
# eval out after 3 s and a timed-out request comes back as an error, which
# `jq -r '.data'` renders as the literal string `null` — indistinguishable
# from a real value unless the caller knows a null there can only be a failed
# measurement. Six attempts, 1 s apart, an order of magnitude over that 3 s
# timeout without approaching any suite's own waits. Returns the first
# non-null result, or `null` after six attempts, so an assertion against a
# genuinely absent window still fails exactly as before. One line per retry
# goes to stderr, never stdout, which is the captured value.
e2e_read() {
  local label="$1" js="$2" attempt=1 result err
  while [ "$attempt" -le 6 ]; do
    result="$(evl "$label" "$js")"
    # A thrown eval comes back as the object automation.rs answers on its catch
    # path, which jq prints over four lines and `check` then compares as if it
    # were a value: a read that never ran reads exactly like one that did. Reads
    # that legitimately return objects (largeInfo, rangeInfo, windowedInfo) carry
    # no `error` key, so keying on it leaves them alone.
    err="$(printf '%s' "$result" | jq -r 'select(type == "object" and has("error")) | .error' 2>/dev/null)"
    if [ -n "$err" ]; then
      echo "e2e_read: retry $attempt after eval error: $err" >&2
    elif [ "$result" != "null" ]; then
      printf '%s\n' "$result"
      return 0
    else
      echo "e2e_read: retry $attempt after null" >&2
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  if [ -n "$err" ]; then
    printf 'EVAL-ERROR: %s\n' "$err"
    return 0
  fi
  printf '%s\n' "$result"
}

# The automation socket the app listens on. Outside every platform's ephemeral
# range on purpose: Linux hands out 32768-60999 as source ports, macOS and
# Windows 49152-65535, and a port inside that range can be taken as some other
# process's client-side source port. Such a socket is not a listener, so the
# LISTEN-only check below cannot see it, yet it still makes the app's bind fail
# with EADDRINUSE; and a loopback connect to a port in that range can even
# connect to itself. 45678 was inside the Linux range and did all three.
E2E_AUTOMATION_PORT=21456
# Ports this project's own E2E run is allowed to reclaim: 1420 is the Vite dev
# server `tauri dev` spawns, the other is the automation socket above.
# Never add 5173 here (or anywhere else in these scripts) — it is the user's
# own dev server, not ours, and must never be touched.
E2E_OWNED_PORTS="1420 $E2E_AUTOMATION_PORT"

# PIDs listening on <port>, one per line, empty when nothing is bound. The
# one place a listener is identified, so the kill path and the port-free check
# can never disagree about what counts as bound.
e2e_port_listeners() {
  case "$(uname -s)" in
    MINGW64_NT* | MSYS_NT*)
      # netstat -ano columns: Proto  Local  Foreign  State  PID. No -p filter:
      # on Windows the address family is part of that filter, so `-p tcp`
      # drops every IPv6 row — and Node resolves `localhost` to ::1, so vite
      # binds [::1]:1420 and was invisible here while the app's own IPv4
      # automation socket was not.
      netstat -ano | awk -v p=":$1\$" '$1 == "TCP" && $2 ~ p && $4 == "LISTENING" {print $5}' | sort -u
      ;;
    *)
      lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null
      ;;
  esac
}
_e2e_kill_pid() {
  case "$(uname -s)" in
    MINGW64_NT* | MSYS_NT*)
      taskkill //PID "$1" >/dev/null 2>&1
      ;;
    *)
      kill "$1" 2>/dev/null
      ;;
  esac
}
_e2e_force_kill_pid() {
  case "$(uname -s)" in
    MINGW64_NT* | MSYS_NT*)
      taskkill //F //PID "$1" >/dev/null 2>&1
      ;;
    *)
      kill -9 "$1" 2>/dev/null
      ;;
  esac
}
# Stop whatever is listening on our owned ports. Processes are
# identified by listening port via e2e_port_listeners, never by command-line
# pattern —
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
  local timeout_s="${1:-3}" port pid pids waited
  for port in $E2E_OWNED_PORTS; do
    pids="$(e2e_port_listeners "$port")"
    if [ -z "$pids" ]; then
      continue
    fi
    for pid in $pids; do
      _e2e_kill_pid "$pid"
    done
    waited=0
    while [ "$waited" -lt "$timeout_s" ] && [ -n "$pids" ]; do
      sleep 1
      waited=$((waited + 1))
      pids="$(e2e_port_listeners "$port")"
    done
    for pid in $pids; do
      _e2e_force_kill_pid "$pid"
    done
  done
  return 0
}

# Prints one line per owned port naming who holds it, or that it is free.
# Detection goes through e2e_port_listeners so this can never disagree with
# the kill path about what counts as bound; on Windows each pid is also
# resolved to an image name via tasklist, since a bare pid means nothing to a
# human reading the log. Writes to stdout so the line lands in the suite log.
e2e_report_port_holders() {   # prints one line per owned port: pid(s) + image, or free
  local port pids pid image images
  for port in $E2E_OWNED_PORTS; do
    pids="$(e2e_port_listeners "$port")"
    if [ -z "$pids" ]; then
      echo "port $port: free"
      continue
    fi
    case "$(uname -s)" in
      MINGW64_NT* | MSYS_NT*)
        images=""
        for pid in $pids; do
          image="$(tasklist //FI "PID eq $pid" 2>/dev/null | awk -v p="$pid" '$2 == p {print $1}')"
          images="$images $pid(${image:-unknown})"
        done
        echo "port $port: held by${images}"
        ;;
      *)
        echo "port $port: held by pid(s) $pids"
        ;;
    esac
  done
}

# Whether the app's own process is running, by exact release process name.
# Used by every suite's quit_app to wait for a real exit.
e2e_app_running() {
  case "$(uname -s)" in
    MINGW64_NT* | MSYS_NT*)
      tasklist //FI "IMAGENAME eq note-n-pad.exe" | grep -q note-n-pad.exe
      ;;
    *)
      pgrep -x note-n-pad >/dev/null 2>&1
      ;;
  esac
}
e2e_app_gone() {
  ! e2e_app_running
}

# Whether the dev binary (cargo run's debug build, matched by path) is
# running. Narrower than e2e_app_running on purpose: the RSS attribution and
# the exit-after-discard checks must not start matching an installed build.
e2e_dev_app_running() {
  case "$(uname -s)" in
    MINGW64_NT* | MSYS_NT*)
      powershell -NoProfile -Command \
        "if (Get-Process | Where-Object { \$_.Path -like '*\\target\\debug\\note-n-pad.exe' }) { exit 0 } else { exit 1 }"
      ;;
    *)
      pgrep -f 'target/debug/note-n-pad' >/dev/null 2>&1
      ;;
  esac
}

# Prints "pid rss_kib" per process matching <pattern>, one line per match,
# nothing when there is none. POSIX keeps the existing pgrep -f + ps -o rss=,
# which sees the pattern as a command-line substring. Git Bash's pgrep/ps
# cannot see a native Windows process at all, so both mem_capture loops would
# read empty there without this. Get-Process exposes no command-line-substring
# match, so the same one-argument call needs two different strategies on
# Windows depending on what kind of pattern it was given: a pattern with a
# slash is the main process's executable path fragment (as
# e2e_dev_app_running matches it at :291-292 above), matched via
# $_.Path -like after the fragment's forward slashes become the backslashes a
# Windows path actually has; anything else is a renderer name from
# webcontent_pattern() (e.g. msedgewebview2.exe), matched via ProcessName —
# which never carries the trailing .exe an image-name filter would need, so it
# is stripped before the comparison. WorkingSet64 is bytes; dividing by 1024
# matches ps -o rss='s KiB.
e2e_process_rss() {
  local pattern="$1"
  case "$(uname -s)" in
    MINGW64_NT* | MSYS_NT*)
      case "$pattern" in
        */*)
          local winpat="${pattern//\//\\}"
          case "$winpat" in
            *.exe) ;;
            *) winpat="$winpat.exe" ;;
          esac
          powershell -NoProfile -Command \
            "Get-Process | Where-Object { \$_.Path -like '*\\$winpat' } | ForEach-Object { \"\$(\$_.Id) \$([int64](\$_.WorkingSet64 / 1024))\" }"
          ;;
        *)
          local name="${pattern%.exe}"
          powershell -NoProfile -Command \
            "Get-Process | Where-Object { \$_.ProcessName -eq '$name' } | ForEach-Object { \"\$(\$_.Id) \$([int64](\$_.WorkingSet64 / 1024))\" }"
          ;;
      esac
      ;;
    *)
      local pid rss
      for pid in $(pgrep -f "$pattern" 2>/dev/null); do
        rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
        if [ -n "$rss" ]; then
          echo "$pid $rss"
        fi
      done
      ;;
  esac
}

# Whether the automation socket answers at all, regardless of whose process it
# is. Bounded by NOTE_N_PAD_AUTO_TIMEOUT_MS so a socket that accepts but never
# answers cannot hang this check.
e2e_automation_up() {
  NOTE_N_PAD_AUTO_TIMEOUT_MS=5000 node "$REPO/scripts/auto.mjs" \
    '{"id":0,"cmd":"list_windows"}' >/dev/null 2>&1
}
_e2e_automation_down() {
  ! e2e_automation_up
}

# Called by every suite's launch() the moment its readiness loop exits. The loop
# only proves something answered; this proves the app actually holds the port.
# The app's own bind failure goes to its dev log and never to the suite log, so
# a launch onto an occupied port otherwise surfaces as a puzzling failure two
# sections later instead of here. $1 is that dev log.
e2e_require_automation_listener() {
  if [ -n "$(e2e_port_listeners "$E2E_AUTOMATION_PORT")" ]; then
    return 0
  fi
  echo "FATAL: nothing is listening on automation port $E2E_AUTOMATION_PORT after the readiness probe"
  if [ -n "${1:-}" ] && [ -f "${1:-}" ]; then
    echo "--- last 30 lines of $(basename "$1") ---"
    tail -30 "$1"
  fi
  exit 1
}

# Refuse to launch onto anything the previous launch left behind. The
# single-instance plugin makes a second app process defer and exit, so
# "something answers on the automation port" is not proof the app under test is the one
# about to start; and a vite still holding 1420 is the dev server the next
# `tauri dev` silently ends up serving from. Both ports must be free, and the
# app gone, before a launch is allowed. Reclaiming is retried because a
# process can outlive the first SIGTERM by more than the kill helper waits.
_e2e_owned_ports_free() {
  local port
  for port in $E2E_OWNED_PORTS; do
    if [ -n "$(e2e_port_listeners "$port")" ]; then
      return 1
    fi
  done
  return 0
}
e2e_require_clean_slate() {
  local round=0
  while [ "$round" -lt 3 ]; do
    e2e_kill_owned_ports
    # Checked twice, one second apart: a leftover mid-rebind can pass a single
    # free check and still take the port before vite binds it, reopening the
    # window this whole function exists to close.
    if e2e_wait_until 20 e2e_app_gone &&
      e2e_wait_until 20 _e2e_automation_down &&
      e2e_wait_until 10 _e2e_owned_ports_free &&
      { sleep 1; _e2e_owned_ports_free; }; then
      return 0
    fi
    round=$((round + 1))
  done
  echo "FATAL: a previous app instance is still alive; refusing to launch"
  exit 1
}
