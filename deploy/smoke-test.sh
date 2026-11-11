#!/usr/bin/env bash
# Smoke test of the packaged school, on this machine or in CI: builds the image, starts everything with
# compose.yml + compose.local.yml, checks the health checks, that only the backup service sees backup.env, and the
# proxy, runs deploy.sh once, checks the watchdog, and removes everything it made. Needs Docker and curl; no sudo. Ports 80 and 443 must be free, or set
# HTTP_PORT and HTTPS_PORT.
#   deploy/smoke-test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
project="sfb-smoke-$$"
https_port="${HTTPS_PORT:-443}"
base="https://localhost"
[ "$https_port" = 443 ] || base="https://localhost:${https_port}"
work="$(mktemp -d)"
work="$(cd "$work" && pwd -P)"
canary="${project}-canary"

step() { echo; echo "smoke: $*"; }
fail() { echo "smoke: FAILED: $*" >&2; exit 1; }

compose() { docker compose -p "$project" -f "$work/compose.yml" -f "$work/compose.local.yml" "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$work/compose.yml" ]; then
    echo "smoke: the last log lines of each service:" >&2
    compose logs --tail 20 >&2 || true
  fi
  step "cleaning up"
  docker rm -f "$canary" >/dev/null 2>&1 || true
  if [ -f "$work/compose.yml" ]; then compose down --volumes --remove-orphans --rmi local --timeout 5 || true; fi
  docker image rm schoolforbots-server:local >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

# A working copy of deploy/, so that the .env and the private folder made here never touch the checkout.
step "preparing a working copy of deploy/ in $work"
cp "$here"/compose.yml "$here"/compose.local.yml "$here"/Caddyfile "$here"/watchdog.sh "$here"/deploy.sh "$here"/env-tag.sh "$work"/
cp -R "$here"/backup "$work"/backup
mkdir -p "$work/private"
cat > "$work/.env" <<ENV
IMAGE_TAG=local
SCHOOL_DOMAIN=localhost
SCHOOL_PRIVATE_DIR=$work/private
POSTGRES_PASSWORD=smoke-test-only
DATABASE_URL=postgres://school:smoke-test-only@postgres:5432/school
MAIL_FROM=School <no-reply@school.example.org>
HTTPS_PORT=$https_port
BUILD_CONTEXT=$(cd "$here/.." && pwd -P)
ENV
[ -z "${HTTP_PORT:-}" ] || echo "HTTP_PORT=$HTTP_PORT" >> "$work/.env"
# Only the backup service may see it (checked below). Its storage is left unset: the smoke test runs no backup.
cat > "$work/backup.env" <<ENV
BACKUP_S3_SECRET_ACCESS_KEY=smoke-test-canary
ENV

step "checking the scripts parse"
sh -n "$here/watchdog.sh"
bash -n "$here/deploy.sh"
bash -n "$here/smoke-test.sh"
bash -n "$here/env-tag.sh"
bash -n "$here/test-env-tag.sh"
sh -n "$here/backup/backup.sh"
sh -n "$here/backup/restore.sh"
sh -n "$here/backup/entrypoint.sh"
bash -n "$here/backup/drill.sh"

step "checking the .env tag rewrite"
"$here/test-env-tag.sh"

step "1/5 building the image and starting everything"
compose build
compose up -d

step "2/5 waiting for both services to be healthy"
wait_healthy() {
  local service="$1" id state
  for _ in $(seq 1 60); do
    id="$(compose ps -q "$service")"
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo missing)"
    echo "smoke: $service is $state"
    [ "$state" = healthy ] && return 0
    sleep 3
  done
  fail "$service did not become healthy"
}
wait_healthy registration
wait_healthy class

step "the backup settings reach the backup service, and not the services that face the internet"
env_in() { compose exec -T "$1" sh -c "printf %s \"\${$2:-}\""; }
[ "$(env_in backup BACKUP_S3_SECRET_ACCESS_KEY)" = smoke-test-canary ] || fail "the backup service did not get backup.env"
[ -n "$(env_in backup DATABASE_URL)" ] || fail "the backup service has no DATABASE_URL"
for service in registration class; do
  [ -z "$(env_in "$service" BACKUP_S3_SECRET_ACCESS_KEY)" ] || fail "$service can see the backup storage key"
done
echo "smoke: only the backup service sees backup.env"

step "3/5 asking through the proxy"
expect_status() {
  local want="$1" path="$2" got
  # The proxy needs a moment after the services are up to have its certificate.
  for _ in $(seq 1 30); do
    got="$(curl -ksS -o /dev/null -w '%{http_code}' "$base$path" || true)"
    [ "$got" = "$want" ] && { echo "smoke: GET $path -> $got"; return 0; }
    sleep 2
  done
  fail "GET $path answered $got, wanted $want"
}
expect_status 200 /healthz
expect_status 200 /healthz/class
expect_status 200 /healthz/mail
expect_status 200 /v1/school-calendar

# A WebSocket upgrade without a key is turned away by the class service itself (401 with its own error), not by the
# proxy (502 or 404). HTTP/1.1 is forced: over HTTP/2 curl sends no Upgrade header at all.
ws_reply="$(curl -ksS -i --http1.1 --max-time 10 "$base/v1/class" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: c21va2UtdGVzdC1rZXktMTY=' || true)"
echo "$ws_reply" | head -1
echo "$ws_reply" | head -1 | grep -q '^HTTP/1.1 401' || fail "the upgrade without a key was not refused with HTTP/1.1 401"
echo "$ws_reply" | grep -q 'unauthorized' || fail "the refusal does not come from the class service"

step "running deploy.sh on the local files"
(cd "$work" && COMPOSE_FILES="compose.yml compose.local.yml" SKIP_PULL=1 COMPOSE_PROJECT_NAME="$project" ./deploy.sh local --now)
expect_status 200 /healthz
expect_status 200 /healthz/class

step "4/5 the watchdog restarts an unhealthy container, and leaves a stopped one alone"
started_at() { docker inspect --format '{{.State.StartedAt}}' "$1"; }
docker run -d --name "$canary" --label school.watchdog=true \
  --health-cmd false --health-interval 2s --health-retries 1 busybox sleep 3600 >/dev/null
first="$(started_at "$canary")"
for _ in $(seq 1 30); do
  [ "$(started_at "$canary")" != "$first" ] && break
  sleep 2
done
[ "$(started_at "$canary")" != "$first" ] || fail "the unhealthy container was not restarted"
echo "smoke: the unhealthy container was restarted"
compose logs watchdog | grep -q "watchdog: $canary is unhealthy" || fail "the watchdog did not log the restart"

compose stop class
sleep 15 # three rounds of the watchdog, which looks every 5 seconds here
class_id="$(compose ps -a -q class)"
running="$(docker inspect --format '{{.State.Running}}' "$class_id")"
[ "$running" = false ] || fail "the watchdog started the stopped class service again"
echo "smoke: the stopped class service stayed stopped"

step "5/5 everything passed"
