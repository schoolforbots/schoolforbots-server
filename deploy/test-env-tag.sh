#!/usr/bin/env bash
# Checks write_image_tag (env-tag.sh): the rewrite works and keeps the file's mode and inode, a forced failure leaves
# the .env byte for byte as it was with no leftovers, and deploy.sh stops on it. No Docker needed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=env-tag.sh
. "$here/env-tag.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "test-env-tag: FAILED: $*" >&2; exit 1; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
inode_of() { stat -c %i "$1" 2>/dev/null || stat -f %i "$1"; }

printf 'A=1\nIMAGE_TAG=old\nSECRET=x$y\n' > "$work/.env"
chmod 640 "$work/.env"
inode="$(inode_of "$work/.env")"

echo "test-env-tag: rewrites an existing IMAGE_TAG line"
write_image_tag "$work/.env" v1.2 || fail "the rewrite failed"
[ "$(cat "$work/.env")" = "$(printf 'A=1\nIMAGE_TAG=v1.2\nSECRET=x$y')" ] || fail "wrong content"
[ "$(mode_of "$work/.env")" = 640 ] || fail "mode changed"
[ "$(inode_of "$work/.env")" = "$inode" ] || fail "inode changed"
ls "$work"/.env.* >/dev/null 2>&1 && fail "leftover files" || true

echo "test-env-tag: appends the line when there is none"
printf 'A=1\n' > "$work/.env2"
write_image_tag "$work/.env2" v3 || fail "append failed"
[ "$(cat "$work/.env2")" = "$(printf 'A=1\nIMAGE_TAG=v3')" ] || fail "wrong appended content"

echo "test-env-tag: a failing sed leaves .env untouched and returns non-zero"
cp "$work/.env" "$work/before"
mkdir "$work/bin"
printf '#!/bin/sh\necho partial\nexit 1\n' > "$work/bin/sed"
chmod +x "$work/bin/sed"
code=0
( PATH="$work/bin:$PATH"; write_image_tag "$work/.env" v9 ) || code=$?
[ "$code" -ne 0 ] || fail "a failing sed did not fail the rewrite"
cmp "$work/.env" "$work/before" || fail ".env changed"
ls "$work"/.env.new "$work"/.env.old >/dev/null 2>&1 && fail "leftover files after the failure" || true

echo "test-env-tag: deploy.sh stops (non-zero, no done) when the rewrite fails"
# A stand-in docker that succeeds at everything, and the failing sed.
printf '#!/bin/sh\nexit 0\n' > "$work/bin/docker"
chmod +x "$work/bin/docker"
mkdir "$work/d"
cp "$here/deploy.sh" "$here/env-tag.sh" "$work/d/"
cp "$work/before" "$work/d/.env"
code=0
out="$(cd "$work/d" && PATH="$work/bin:$PATH" SKIP_PULL=1 ./deploy.sh v9 --now 2>&1)" || code=$?
[ "$code" -ne 0 ] || fail "deploy.sh exited 0 although the rewrite failed"
echo "$out" | grep -q 'could not write IMAGE_TAG' || fail "deploy.sh did not stop at the rewrite"
echo "$out" | grep -q 'deploy: done' && fail "deploy.sh said done"
cmp "$work/d/.env" "$work/before" || fail "deploy.sh changed .env"
echo "test-env-tag: all passed"
