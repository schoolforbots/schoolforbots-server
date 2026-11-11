#!/usr/bin/env bash
# Updates the school to an image tag:
#   deploy/deploy.sh <image-tag> [--now]
# Pulls the image, recreates the registration service (it upgrades the database when it starts) and waits until it is
# healthy, waits for the class service to be free (no class on, none opening within 15 minutes; --now skips the wait),
# recreates it and waits until it is healthy, then brings up the rest. Stops with a non-zero exit code at the first
# step that fails.
#
# For a trial on one machine: COMPOSE_FILES="compose.yml compose.local.yml" SKIP_PULL=1 deploy/deploy.sh <tag> --now
set -euo pipefail

usage() {
  echo "usage: $0 <image-tag> [--now]" >&2
  exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
tag="$1"
now=0
if [ $# -eq 2 ]; then
  [ "$2" = "--now" ] || usage
  now=1
fi

cd "$(dirname "$0")"
[ -f .env ] || { echo "deploy: there is no .env next to this script (see env.example)" >&2; exit 1; }

files=()
for f in ${COMPOSE_FILES:-compose.yml}; do files+=(-f "$f"); done
compose() { docker compose "${files[@]}" "$@"; }

export IMAGE_TAG="$tag"
wait_timeout=240

echo "deploy: step 1/5: pulling the image (tag ${tag})"
if [ "${SKIP_PULL:-0}" = 1 ]; then
  echo "deploy: SKIP_PULL is set, not pulling"
else
  compose pull registration class
fi

echo "deploy: step 2/5: recreating registration (migrates the database) and waiting until it is healthy"
compose up -d --no-deps --force-recreate --wait --wait-timeout "$wait_timeout" registration

echo "deploy: step 3/5: waiting for the class service to be free"
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

echo "deploy: step 4/5: recreating class and waiting until it is healthy"
compose up -d --no-deps --force-recreate --wait --wait-timeout "$wait_timeout" class

echo "deploy: step 5/5: bringing up the other services"
compose up -d --wait --wait-timeout "$wait_timeout"

# Remembered, so that a later `docker compose up` does not go back to the old tag.
if grep -q '^IMAGE_TAG=' .env; then
  sed "s|^IMAGE_TAG=.*|IMAGE_TAG=${tag}|" .env > .env.new && cat .env.new > .env && rm .env.new
else
  echo "IMAGE_TAG=${tag}" >> .env
fi
echo "deploy: done, running ${tag}"
