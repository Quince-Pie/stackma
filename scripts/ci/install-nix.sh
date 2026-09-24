#!/usr/bin/env bash
# The reviewed upstream bootstrap verifies its embedded binary-archive digest.
set -euo pipefail

fail() {
  printf 'Nix installation: %s\n' "$*" >&2
  exit 1
}

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'requires Linux x86_64'
if command -v nix >/dev/null 2>&1 || [[ -e /nix || -L /nix || -e /etc/nix/nix.conf ]]; then
  fail 'an existing Nix installation was found; refusing to replace it'
fi
[[ -r /etc/ssl/certs/ca-certificates.crt ]] || fail 'Ubuntu CA certificates are missing'
export NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
sudo --non-interactive true

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d "$RUNNER_TEMP/stackma-nix.XXXXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bash "$script_dir/download-verified.sh" sha256 \
  https://releases.nixos.org/nix/nix-2.35.2/install \
  9adda97297d9e8ab360df95c729eabff4f4f93d6db091953c3a68f29e3fb130c \
  "$work/install"
printf '%s\n' \
  'experimental-features = nix-command flakes' \
  'accept-flake-config = false' > "$work/nix.conf"

# Bound the complete upstream installation, including its archive transfer.
# Do not grant repository code a trusted-user entry or persist a GitHub token.
timeout --signal=TERM --kill-after=10s 8m \
  sh "$work/install" --daemon --yes --no-channel-add \
    --nix-extra-conf-file "$work/nix.conf"

nix_bin=/nix/var/nix/profiles/default/bin
[[ $("$nix_bin/nix" --version) == 'nix (Nix) 2.35.2' ]] || fail 'unexpected installed version'
printf '%s\n' "$nix_bin" >> "$GITHUB_PATH"
printf '%s\n' \
  'NIX_REMOTE=daemon' \
  'NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt' >> "$GITHUB_ENV"
