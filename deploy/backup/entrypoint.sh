#!/bin/sh
# With arguments, runs them (docker compose run --rm backup backup.sh). Without, sleeps until BACKUP_AT every day and
# runs backup.sh; a failed run is recorded by backup.sh itself and the loop goes on to the next day.
set -eu

if [ "$#" -gt 0 ]; then exec "$@"; fi

at="${BACKUP_AT:-03:30}"
case "$at" in
  [0-1][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
  *) echo "backup: BACKUP_AT must be HH:MM, got: ${at}" >&2; exit 2 ;;
esac
target_seconds=$(( 10#${at%:*} * 3600 + 10#${at#*:} * 60 ))

while true; do
  now="$(date +%H:%M:%S)"
  now_seconds=$(( 10#${now%%:*} * 3600 + 10#$(echo "$now" | cut -d: -f2) * 60 + 10#${now##*:} ))
  wait=$(( target_seconds - now_seconds ))
  [ "$wait" -gt 0 ] || wait=$(( wait + 86400 ))
  echo "backup: next backup at ${at} ${TZ:-}, in ${wait} seconds"
  sleep "$wait"
  backup.sh || echo "backup: the run failed (see above)" >&2
  # Never start twice in the same minute.
  sleep 60
done
