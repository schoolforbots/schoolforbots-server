#!/bin/sh
# Every WATCHDOG_INTERVAL seconds (30 by default) restarts each running container labelled school.watchdog=true whose
# health check says unhealthy. `docker ps` lists running containers only, so one stopped by hand is left alone.
set -eu

interval="${WATCHDOG_INTERVAL:-30}"
echo "watchdog: looking at labelled containers every ${interval} seconds"

while true; do
  ids="$(docker ps --quiet --filter label=school.watchdog=true --filter health=unhealthy --filter status=running)"
  for id in $ids; do
    name="$(docker inspect --format '{{.Name}}' "$id")"
    echo "watchdog: ${name#/} is unhealthy, restarting it"
    docker restart "$id" >/dev/null || echo "watchdog: could not restart ${name#/}"
  done
  sleep "$interval"
done
