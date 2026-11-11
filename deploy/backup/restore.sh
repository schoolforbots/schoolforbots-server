#!/bin/sh
# Restores a backup into an empty database:
#   restore.sh <object name> <age private key file> <target database URL>
# The object name is the file under backups/ (for example 2026-11-11T0330.dump.age). The S3 variables of backup.sh
# (BACKUP_S3_*) say where it is. Downloads, decrypts and pg_restores in one pipe, so the plaintext never touches the
# disk. Refuses a target database that has any table in it.
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <object name> <age private key file> <target database URL>" >&2
  exit 2
fi
object="${1#backups/}"
key="$2"
target="$3"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is not set}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is not set}"
: "${BACKUP_S3_ACCESS_KEY_ID:?BACKUP_S3_ACCESS_KEY_ID is not set}"
: "${BACKUP_S3_SECRET_ACCESS_KEY:?BACKUP_S3_SECRET_ACCESS_KEY is not set}"
[ -f "$key" ] || { echo "restore: no such key file: $key" >&2; exit 2; }

export RCLONE_CONFIG_BK_TYPE=s3
export RCLONE_CONFIG_BK_PROVIDER=Other
export RCLONE_CONFIG_BK_ENDPOINT="$BACKUP_S3_ENDPOINT"
export RCLONE_CONFIG_BK_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_BK_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_BK_FORCE_PATH_STYLE=true

set -o pipefail 2>/dev/null || { echo "restore: this shell has no pipefail" >&2; exit 2; }

tables="$(psql "$target" -v ON_ERROR_STOP=1 -tAc "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")"
if [ "$tables" != 0 ]; then
  echo "restore: the target database is not empty ($tables tables); restore into a new, empty database" >&2
  exit 1
fi

echo "restore: downloading, decrypting and restoring backups/$object"
rclone cat "bk:$BACKUP_S3_BUCKET/backups/$object" | age -d -i "$key" | pg_restore --no-owner --exit-on-error -d "$target"
echo "restore: done"
