#!/usr/bin/env bash
# Fixed Chrome for Testing builds: the tested stable release and the declared
# minimum_chrome_version. Archives come from Google's chrome-for-testing-public
# bucket, listed at https://googlechromelabs.github.io/chrome-for-testing/;
# each SHA-256 was pinned after matching the bucket's own MD5 object metadata.
set -euo pipefail

fail() {
  printf 'Chrome installation: %s\n' "$*" >&2
  exit 1
}

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'requires Linux x86_64'
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d "$RUNNER_TEMP/tab-gantry-chrome.XXXXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install_chrome() {
  local version=$1 digest=$2 name=$3
  local destination="$RUNNER_TEMP/tab-gantry-chrome-$version"
  [[ ! -e $destination && ! -L $destination ]] || fail 'destination already exists'
  bash "$script_dir/download-verified.sh" sha256 \
    "https://storage.googleapis.com/chrome-for-testing-public/$version/linux64/chrome-linux64.zip" \
    "$digest" "$work/$version.zip"
  mkdir -- "$work/$version"
  timeout --signal=TERM --kill-after=10s 120s unzip -q "$work/$version.zip" -d "$work/$version"
  [[ -f $work/$version/chrome-linux64/chrome && -x $work/$version/chrome-linux64/chrome ]] || fail 'archive has no Chrome executable'
  mv --no-target-directory -- "$work/$version/chrome-linux64" "$destination"
  # Ubuntu 23.10+ restricts unprivileged user namespaces for binaries outside
  # /opt/google/chrome. Chromium's apparmor-userns-restrictions.md names the
  # setuid helper as the safest option; Chrome falls back to it when set.
  # install(1) writes a new root-owned copy, never following a replaced path.
  local sandbox="$RUNNER_TEMP/tab-gantry-chrome-sandbox-$version"
  [[ -f $destination/chrome_sandbox && ! -L $destination/chrome_sandbox ]] || fail 'archive has no regular sandbox helper'
  [[ ! -e $sandbox && ! -L $sandbox ]] || fail 'sandbox destination already exists'
  sudo install -o root -g root -m 4755 -- "$destination/chrome_sandbox" "$sandbox"
  printf '%s=%s/chrome\n%s_SANDBOX=%s\n%s_VERSION=%s\n' \
    "$name" "$destination" "$name" "$sandbox" "$name" "$version" >> "$GITHUB_ENV"
}

install_chrome 154.0.8037.57 ceee2972074d441ea7c4ba8bcc0eaab77e7e87680f6653d73d3065851fe10302 CHROME_STABLE
install_chrome 148.0.7778.178 05b6843867b4ee40f280327b748397a158b84ccbe20b94c3e89740d15422988f CHROME_MINIMUM
