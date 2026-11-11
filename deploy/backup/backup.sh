#!/bin/sh
# One backup: pg_dump -Fc, encrypted with age to BACKUP_AGE_RECIPIENT (a public key; the private key is not on this
# server), uploaded to s3://<BACKUP_S3_BUCKET>/backups/<YYYY-MM-DDTHHMM>.dump.age, then the objects under backups/ older
# than BACKUP_KEEP_DAYS days (14 by default) are deleted, then a row goes into backup_runs. Any failing step records
# ok = false and exits non-zero. The plaintext dump never touches the disk: pg_dump is piped into age, and only the
# encrypted file is kept (in a temporary folder that is removed at the end) until the upload has succeeded.
#
# DATABASE_URL: the database, as in .env. BACKUP_DATABASE_URL (optional) is the database to dump when it is not the
# one that records the runs.
set -eu

: "${DATABASE_URL:?DATABASE_URL is not set}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is not set}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is not set}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is not set}"
: "${BACKUP_S3_ACCESS_KEY_ID:?BACKUP_S3_ACCESS_KEY_ID is not set}"
: "${BACKUP_S3_SECRET_ACCESS_KEY:?BACKUP_S3_SECRET_ACCESS_KEY is not set}"
keep_days="${BACKUP_KEEP_DAYS:-14}"
case "$keep_days" in '' | *[!0-9]*) echo "backup: BACKUP_KEEP_DAYS must be a whole number of days" >&2; exit 2 ;; esac
dump_url="${BACKUP_DATABASE_URL:-$DATABASE_URL}"

# The remote "bk", configured through the environment so that no config file with the keys is written. A bucket that
# does not exist must be an error, not something rclone makes.
export RCLONE_CONFIG_BK_TYPE=s3
export RCLONE_CONFIG_BK_PROVIDER=Other
export RCLONE_CONFIG_BK_ENDPOINT="$BACKUP_S3_ENDPOINT"
export RCLONE_CONFIG_BK_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_BK_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_BK_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_BK_NO_CHECK_BUCKET=true

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

record() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "insert into backup_runs(finished_at, ok) values (now(), $1)"
}

# Run in an "if", where set -e does not stop anything: every step says so itself with || return 1.
run() {
  name="$(date +%Y-%m-%dT%H%M).dump.age"
  echo "backup: dumping and encrypting"
  pg_dump -Fc "$dump_url" | age -r "$BACKUP_AGE_RECIPIENT" > "$tmp/dump.age" || return 1
  echo "backup: uploading to backups/$name"
  rclone copyto "$tmp/dump.age" "bk:$BACKUP_S3_BUCKET/backups/$name" || return 1
  echo "backup: deleting backups older than $keep_days days"
  rclone delete "bk:$BACKUP_S3_BUCKET/backups" --min-age "${keep_days}d" --include '*.dump.age'
}

# Without pipefail a failing pg_dump would hide behind a succeeding age.
set -o pipefail 2>/dev/null || { echo "backup: this shell has no pipefail" >&2; exit 2; }

if (run); then
  record true
  echo "backup: done"
else
  echo "backup: FAILED" >&2
  record false || echo "backup: could not record the failed run in backup_runs" >&2
  exit 1
fi
