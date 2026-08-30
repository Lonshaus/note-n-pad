#!/usr/bin/env bash
# Copyright © 2026 Lonshaus
# SPDX-License-Identifier: GPL-3.0-only
# Run the Rust gates against real Linux, in the container built from the
# Dockerfile beside this script. The macOS host cannot compile the Linux-gated
# code at all, so this is the only local way to know it builds.
#
# Usage:
#   scripts/linux-check/check.sh                  # fmt + test + clippy, the CI ubuntu job's Rust half
#   scripts/linux-check/check.sh <cargo args...>  # anything else, e.g. build --release
#
# The repo is mounted read-write because cargo needs to write Cargo.lock, but
# build output goes to a named volume rather than the host's target/ directory:
# sharing it would make the macOS and Linux toolchains overwrite each other's
# artifacts on every switch, forcing a full rebuild each way.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="note-n-pad-linux:24.04"

# The VM is meant to be off unless something needs it, so say what to run rather
# than starting it as a side effect of a check.
if ! docker info >/dev/null 2>&1; then
  echo "docker is not reachable — start the VM first:" >&2
  echo "  colima start" >&2
  echo "and stop it again when you are done:" >&2
  echo "  colima stop" >&2
  exit 1
fi
# Built on demand so a fresh checkout does not fail with a bare "image not
# found"; once it exists this is a single cheap inspect.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "=== building $IMAGE ==="
  docker build -t "$IMAGE" "$SCRIPT_DIR" || exit 1
fi
# Defaults to the checkout this script lives in. Set NOTE_N_PAD_REPO to point at a
# worktree instead, so a branch can be checked before it is merged — which is
# the whole point, since the host cannot compile this code at all. Resolved
# rather than assumed, and checked: a failed `cd` inside a command substitution
# only yields an empty string, which docker would then read as a malformed mount
# spec and report obscurely instead of saying the path is wrong.
REPO_ROOT="$(cd "${NOTE_N_PAD_REPO:-$SCRIPT_DIR/../..}" 2>/dev/null && pwd)"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT/src-tauri" ]; then
  echo "no repo at ${NOTE_N_PAD_REPO:-$SCRIPT_DIR/../..}" >&2
  exit 1
fi
echo "repo: $REPO_ROOT"

# Docker defaults to root, and root reads a file whose mode is 000 — which made
# the settings test for an unreadable file fail here and pass on CI, where the
# runner is an ordinary user. Matching CI's user is what keeps this container an
# honest stand-in; it also leaves build output owned by whoever ran it.
DOCKER_USER="$(id -u):$(id -g)"

# The named volumes were created by earlier root runs, so the first run as the
# host user cannot write to them. Done once, by root, rather than on every run:
# chown -R over a populated target directory is not free.
if ! docker run --rm --user "$DOCKER_USER" \
    -v note-n-pad-linux-target:/target \
    -v note-n-pad-linux-cargo:/usr/local/cargo/registry \
    "$IMAGE" sh -c 'test -w /target && test -w /usr/local/cargo/registry' \
    >/dev/null 2>&1; then
  echo "=== taking ownership of the build volumes ==="
  docker run --rm \
    -v note-n-pad-linux-target:/target \
    -v note-n-pad-linux-cargo:/usr/local/cargo/registry \
    "$IMAGE" chown -R "$DOCKER_USER" /target /usr/local/cargo/registry || exit 1
fi

run() {
  # No passwd entry matches --user, so HOME would be unset and cargo would try
  # to write to /.
  docker run --rm -t \
    --user "$DOCKER_USER" \
    -e HOME=/tmp \
    -v "$REPO_ROOT:/repo" \
    -v note-n-pad-linux-target:/target \
    -v note-n-pad-linux-cargo:/usr/local/cargo/registry \
    -w /repo/src-tauri \
    "$IMAGE" "$@"
}

if [ "$#" -gt 0 ]; then
  run cargo "$@"
  exit $?
fi

status=0
# Cheapest first: formatting needs no compilation, so a failure here costs
# nothing to discover.
echo "=== cargo fmt --check ==="
run cargo fmt --check || status=1
echo "=== cargo test ==="
run cargo test || status=1
# Runs last because it is the slowest, and because a compile error would have
# already surfaced in the test run.
echo "=== cargo clippy --all-targets -- -D warnings ==="
run cargo clippy --all-targets -- -D warnings || status=1

if [ "$status" -eq 0 ]; then
  echo "=== all Linux gates passed ==="
else
  echo "=== FAILED ==="
fi
exit "$status"
