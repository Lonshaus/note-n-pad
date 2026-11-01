#!/bin/bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# The E2E suites split into the groups that run on separate runners.
#   shards.sh <1-4>   the suite names of that group, one per line
#   shards.sh check   every scripts/e2e/e2e-*.sh is in exactly one group
set -u
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

group() {
  case "$1" in
    1) echo e2e-global-edit ;;
    2) printf '%s\n' e2e-paste e2e-close-flush e2e-highlight e2e-goto e2e-i18n ;;
    3) printf '%s\n' e2e-select-all e2e-view-mode e2e-table e2e-spill ;;
    4) printf '%s\n' e2e-windowed e2e-clip e2e-large e2e-range e2e-editor-focus e2e-longline e2e-file-drop e2e-windowed-two-tabs ;;
    *) return 1 ;;
  esac
}

check() {
  local bad=0 n name hits f
  for f in "$dir"/e2e-*.sh; do
    name="$(basename "$f" .sh)"
    hits=0
    for n in 1 2 3 4; do
      if group "$n" | grep -qx "$name"; then
        hits=$((hits + 1))
      fi
    done
    if [ "$hits" != 1 ]; then
      echo "$name is in $hits groups, expected 1" >&2
      bad=1
    fi
  done
  for n in 1 2 3 4; do
    for name in $(group "$n"); do
      if [ ! -f "$dir/$name.sh" ]; then
        echo "group $n lists $name, which has no script" >&2
        bad=1
      fi
    done
  done
  return "$bad"
}

case "${1-}" in
  check) check ;;
  1 | 2 | 3 | 4) group "$1" ;;
  *)
    echo "usage: shards.sh <1-4>|check" >&2
    exit 1
    ;;
esac
