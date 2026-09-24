#!/usr/bin/env bash
# Download one HTTPS resource; publish it only after its pinned digest matches.
set -euo pipefail

fail() {
  printf 'Verified download: %s\n' "$*" >&2
  exit 1
}

[[ $# == 4 ]] || fail 'usage: download-verified.sh sha256|sha512 URL HASH DESTINATION'
algorithm=$1
url=$2
expected=${3,,}
destination=$4

case "$algorithm" in
  sha256) [[ $expected =~ ^[0-9a-f]{64}$ ]] || fail 'invalid SHA-256 digest' ;;
  sha512) [[ $expected =~ ^[0-9a-f]{128}$ ]] || fail 'invalid SHA-512 digest' ;;
  *) fail 'supported algorithms are sha256 and sha512' ;;
esac
[[ $url == https://?* ]] || fail 'the URL must use HTTPS'
[[ ! -d $destination ]] || fail 'the destination must not be a directory'

# A sibling temporary file makes the final rename atomic on the same filesystem.
temporary=$(mktemp --tmpdir="$(dirname -- "$destination")" .stackma-download.XXXXXXXXXX)
trap 'rm -f -- "$temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Disable curlrc before processing any options. Limit redirects and retries as
# well as the whole transfer, including a slow final retry and termination.
timeout --signal=TERM --kill-after=10s 300s \
  curl --disable --fail --silent --show-error --location --globoff \
    --proto '=https' --proto-redir '=https' --max-redirs 5 \
    --connect-timeout 15 --max-time 120 \
    --retry 2 --retry-delay 2 --retry-max-time 240 \
    --output "$temporary" -- "$url"

# Read from stdin so a destination containing spaces cannot affect digest parsing.
actual=$("${algorithm}sum" < "$temporary")
actual=${actual%% *}
[[ $actual == "$expected" ]] || fail "$algorithm mismatch; destination was not changed"
mv --force --no-target-directory -- "$temporary" "$destination"
