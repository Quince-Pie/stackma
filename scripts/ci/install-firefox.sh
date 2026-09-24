#!/usr/bin/env bash
# Fixed qualification target. Hash source:
# https://archive.mozilla.org/pub/firefox/releases/156.0/SHA512SUMS
set -euo pipefail

fail() {
  printf 'Firefox installation: %s\n' "$*" >&2
  exit 1
}

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'requires Linux x86_64'
destination="$RUNNER_TEMP/stackma-firefox-156.0"
[[ ! -e $destination && ! -L $destination ]] || fail 'destination already exists'
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d "$RUNNER_TEMP/stackma-firefox.XXXXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bash "$script_dir/download-verified.sh" sha512 \
  https://archive.mozilla.org/pub/firefox/releases/156.0/linux-x86_64/en-US/firefox-156.0.tar.xz \
  0d412c90b4ec2a0b0690790a864a17e32187a32ecb2a616fea49b8b9f193f4225ea220e476cf220fc362d5322bee5e9f515a3b2d52e224c9ac659980942465b9 \
  "$work/firefox.tar.xz"

timeout --signal=TERM --kill-after=10s 60s \
  tar --extract --xz --file "$work/firefox.tar.xz" --directory "$work" --no-same-owner
[[ -f $work/firefox/firefox && -x $work/firefox/firefox ]] || fail 'archive has no Firefox executable'
mv --no-target-directory -- "$work/firefox" "$destination"
printf 'FIREFOX=%s/firefox\n' "$destination" >> "$GITHUB_ENV"
