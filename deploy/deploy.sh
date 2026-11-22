#!/usr/bin/env bash
# Updates the school to an image tag:
#   deploy/deploy.sh <image-tag> [--now]
# Pulls the image, starts postgres (a no-op when it runs; on a new server this is what creates it) and waits until it
# is healthy, backs the database up (stopping there if the backup fails; a new database with nothing in it yet is not
# backed up), recreates the registration service (it upgrades the database when it starts) and waits until it is
# healthy, waits for the class service to be free (no class on, none opening within 15 minutes; --now skips the wait),
# recreates it and waits until it is healthy, recreates the club service and waits until it is healthy (with no wait
# before: a game being played when it stops is played out and stored first), brings up the rest, and makes the proxy use
# this folder's Caddyfile (nothing changes when it is the same). Stops with a non-zero exit code at the
# first step that fails.
#
# For a trial on one machine, with no backup storage:
#   COMPOSE_FILES="compose.yml compose.local.yml" SKIP_PULL=1 SKIP_BACKUP=1 deploy/deploy.sh <tag> --now
set -euo pipefail

usage() {
  echo "usage: $0 <image-tag> [--now]" >&2
  exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
tag="$1"
# Docker's grammar of a tag; it also keeps the value safe to write into .env.
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "deploy: not a valid image tag: ${tag}" >&2; exit 2; }
now=0
if [ $# -eq 2 ]; then
  [ "$2" = "--now" ] || usage
  now=1
fi

cd "$(dirname "$0")"
# shellcheck source=env-tag.sh
. ./env-tag.sh
[ -f .env ] || { echo "deploy: there is no .env next to this script (see env.example)" >&2; exit 1; }
[ -f backup.env ] || { echo "deploy: there is no backup.env next to this script (see backup.env.example)" >&2; exit 1; }

files=()
for f in ${COMPOSE_FILES:-compose.yml}; do files+=(-f "$f"); done
compose() { docker compose "${files[@]}" "$@"; }

# The tag running before this deploy, to go back to if a later step fails.
previous="$(sed -n 's/^IMAGE_TAG=//p' .env | tail -n 1)"
export IMAGE_TAG="$tag"
wait_timeout=240
# The registration service migrates the database before it is healthy: its start period in compose.yml (10 minutes),
# then three failed checks 30 seconds apart before it counts as unhealthy.
registration_wait_timeout=720

echo "deploy: step 1/9: pulling the image (tag ${tag})"
if [ "${SKIP_PULL:-0}" = 1 ]; then
  echo "deploy: SKIP_PULL is set, not pulling"
else
  compose pull registration class club
fi

echo "deploy: step 2/9: starting postgres if it is not running, and waiting until it is healthy"
compose up -d --wait --wait-timeout "$wait_timeout" postgres

echo "deploy: step 3/9: backing up the database before it is migrated"
# Asked apart, so that a failure to ask stops the script (`set -e`) rather than reading as a new database.
migrated=f
[ "${SKIP_BACKUP:-0}" = 1 ] || migrated="$(compose exec -T postgres psql -U school -d school -tAc "select to_regclass('public.backup_runs') is not null")"
if [ "${SKIP_BACKUP:-0}" = 1 ]; then
  echo "deploy: SKIP_BACKUP is set, not backing up"
elif [ "$migrated" != t ]; then
  # A new server: the registration service has not made the tables yet, so there is nothing to keep.
  echo "deploy: the database has no tables yet, nothing to back up"
else
  compose run --rm backup backup.sh || {
    echo "deploy: the backup failed; nothing was changed, ${previous:-the old version} is still running" >&2
    exit 1
  }
fi

# From here on the database may be migrated: a failure says how to go back.
trap 'echo "deploy: failed; to go back to the version before: deploy/deploy.sh ${previous:-<previous tag>} --now (the backup of step 3 is in the storage)" >&2' ERR

echo "deploy: step 4/9: recreating registration (migrates the database) and waiting until it is healthy"
compose up -d --no-deps --force-recreate --wait --wait-timeout "$registration_wait_timeout" registration

echo "deploy: step 5/9: waiting for the class service to be free"
if [ "$now" = 1 ]; then
  echo "deploy: --now, not waiting"
else
  while true; do
    # 0 free, 3 busy; anything else is a failure and `set -e` stops here.
    code=0
    compose exec -T registration node dist/tools/class-busy.js || code=$?
    [ "$code" -eq 0 ] && break
    [ "$code" -eq 3 ] || { echo "deploy: the busy check failed (exit code ${code})" >&2; exit 1; }
    echo "deploy: checking again in a minute"
    sleep 60
  done
fi

echo "deploy: step 6/9: recreating class and waiting until it is healthy"
compose up -d --no-deps --force-recreate --wait --wait-timeout "$wait_timeout" class

echo "deploy: step 7/9: recreating club and waiting until it is healthy"
compose up -d --no-deps --force-recreate --wait --wait-timeout "$wait_timeout" club

echo "deploy: step 8/9: bringing up the other services"
compose up -d --build --wait --wait-timeout "$wait_timeout"

echo "deploy: step 9/9: having the proxy use this folder's Caddyfile"
# The Caddyfile is mounted as a single file. A new copy put in its place (tar, git, an editor that writes a new file)
# is a new file, which the running container does not see: then the proxy is recreated, which mounts and loads it.
# Otherwise it is told to load the file again, which is graceful, and changes nothing when the file is the same.
mounted="$(compose exec -T caddy cat /etc/caddy/Caddyfile | cksum)"
if [ "$mounted" != "$(cksum < Caddyfile)" ]; then
  echo "deploy: the proxy does not see this Caddyfile, recreating it"
  compose up -d --no-deps --force-recreate --wait --wait-timeout "$wait_timeout" caddy
else
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi

# Remembered, so that a later `docker compose up` does not go back to the old tag. A failure here stops the script.
write_image_tag .env "$tag" || { echo "deploy: could not write IMAGE_TAG to .env" >&2; exit 1; }
echo "deploy: done, running ${tag}"
