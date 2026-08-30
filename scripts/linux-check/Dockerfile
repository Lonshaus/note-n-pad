# Linux build/test environment for Note&Pad, mirroring the CI ubuntu-24.04 job.
# The macOS host cannot compile the Linux-gated code at all, so without this the
# only thing that ever builds it is CI.
#
# Doubles as the dependency recipe for packaging Note&Pad on Linux yourself:
# apt-packages.txt is everything the build needs beyond a Rust toolchain.
FROM ubuntu:24.04

# The same list .github/workflows/ci.yml installs, read from one file so this
# container cannot quietly drift from the job it stands in for.
COPY apt-packages.txt /tmp/apt-packages.txt
RUN apt-get update \
    && grep -vE '^[[:space:]]*(#|$)' /tmp/apt-packages.txt \
       | xargs apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /tmp/apt-packages.txt

# rustup rather than the distro's rustc, so the toolchain matches what
# dtolnay/rust-toolchain installs in CI. rustfmt and clippy are not in the
# minimal profile, so they are requested explicitly, exactly as CI does.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | \
      sh -s -- -y --profile minimal \
        --component rustfmt --component clippy --no-modify-path

# The host's target/ directory holds macOS artifacts; sharing it would make the
# two toolchains overwrite each other's output on every switch. A separate
# directory inside the container keeps them apart, and mounting a volume there
# keeps Linux builds incremental across runs — and keeps build output out of the
# repo entirely.
ENV CARGO_TARGET_DIR=/target
WORKDIR /repo
