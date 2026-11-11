#!/usr/bin/env bash
# The restore drill, on this machine or in CI: proves that the nightly backup can be restored. It starts a local S3 server
# (rclone serve s3, which is MinIO's role here: MinIO no longer publishes its image on Docker Hub) in place of the real
# S3-compatible storage and a database with a seeded class, makes a throwaway age key pair, runs
# backup.sh, restores the object into a new empty database with restore.sh, starts both services on it and compares
# the student counts. Then it checks that each of three failures (wrong public key, missing bucket, unreachable
# database) records a row with ok = false, and that only backups older than BACKUP_KEEP_DAYS are deleted. Everything
# it makes is removed at the end. Needs Docker and, on the host, the repository's dependencies (npm ci): the seed
# runs from the host against a port published on 127.0.0.1, as npm run dev:seed only talks to a local database.
#   deploy/backup/drill.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
deploy="$(cd "$here/.." && pwd -P)"
root="$(cd "$deploy/.." && pwd -P)"
project="sfb-drill-$$"
net="${project}-net"
minio="${project}-minio"
src="${project}-src"
backup_image="${project}-backup:local"
work="$(mktemp -d)"
work="$(cd "$work" && pwd -P)"
bucket=drill-bucket
pg_password=drill-only-password
minio_user=drilluser
minio_password=drill-only-secret-1234

step() { echo; echo "drill: $*"; }
fail() { echo "drill: FAILED: $*" >&2; exit 1; }

compose() { docker compose -p "$project" -f "$work/compose.yml" -f "$work/compose.local.yml" -f "$work/network.yml" "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$work/compose.yml" ]; then
    echo "drill: the last log lines of each service:" >&2
    compose logs --tail 20 >&2 || true
  fi
  step "cleaning up"
  if [ -f "$work/compose.yml" ]; then compose down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true; fi
  docker rm -f -v "$minio" "$src" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  docker image rm "$backup_image" schoolforbots-server:local >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

step "checking the scripts parse"
for f in backup.sh restore.sh entrypoint.sh drill.sh; do
  [ -f "$here/$f" ] || fail "$here/$f does not exist"
done
sh -n "$here/backup.sh"
sh -n "$here/restore.sh"
sh -n "$here/entrypoint.sh"
bash -n "$here/drill.sh"

step "preparing a working copy of deploy/ in $work"
cp "$deploy"/compose.yml "$deploy"/compose.local.yml "$work"/
mkdir -p "$work/private"
cat > "$work/.env" <<ENV
IMAGE_TAG=local
SCHOOL_DOMAIN=localhost
SCHOOL_PRIVATE_DIR=$work/private
POSTGRES_PASSWORD=$pg_password
DATABASE_URL=postgres://school:$pg_password@postgres:5432/school
MAIL_FROM=School <no-reply@school.example.org>
BUILD_CONTEXT=$root
ENV
# Every service of the stack joins the drill's own network, where MinIO and the source database are.
cat > "$work/network.yml" <<NET
networks:
  default:
    name: $net
    external: true
NET

step "building the backup image"
docker build -q -t "$backup_image" "$here"

step "starting the S3 storage and the source database"
docker network create "$net" >/dev/null
docker run -d --name "$minio" --network "$net" rclone/rclone:1.76.0 serve s3 /data --addr :9000 \
  --auth-key "$minio_user,$minio_password" >/dev/null
docker run -d --name "$src" --network "$net" -p 127.0.0.1::5432 \
  -e POSTGRES_USER=school -e POSTGRES_DB=school -e POSTGRES_PASSWORD="$pg_password" postgres:17-alpine >/dev/null
src_port="$(docker port "$src" 5432/tcp | head -1 | sed 's/.*://')"
[ -n "$src_port" ] || fail "the source database has no published port"
for _ in $(seq 1 60); do
  docker exec "$src" pg_isready -U school -d school -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$src" pg_isready -U school -d school -h 127.0.0.1 >/dev/null || fail "the source database did not start"

# What the backup container is given, as the .env gives it on a server. The rclone variables are for this script's own
# helper commands (remote "drill"); backup.sh makes its own.
cat > "$work/backup.env" <<ENV
DATABASE_URL=postgres://school:$pg_password@$src:5432/school
BACKUP_S3_ENDPOINT=http://$minio:9000
BACKUP_S3_BUCKET=$bucket
BACKUP_S3_ACCESS_KEY_ID=$minio_user
BACKUP_S3_SECRET_ACCESS_KEY=$minio_password
BACKUP_KEEP_DAYS=14
RCLONE_CONFIG_DRILL_TYPE=s3
RCLONE_CONFIG_DRILL_PROVIDER=Other
RCLONE_CONFIG_DRILL_ENDPOINT=http://$minio:9000
RCLONE_CONFIG_DRILL_ACCESS_KEY_ID=$minio_user
RCLONE_CONFIG_DRILL_SECRET_ACCESS_KEY=$minio_password
RCLONE_CONFIG_DRILL_FORCE_PATH_STYLE=true
ENV

# In the backup image on the drill's network, with the extra docker run options in DRILL_RUN_ARGS.
in_image() { docker run --rm --network "$net" --env-file "$work/backup.env" ${DRILL_RUN_ARGS[@]+"${DRILL_RUN_ARGS[@]}"} "$backup_image" "$@"; }
DRILL_RUN_ARGS=()
rc() { docker run --rm --network "$net" --env-file "$work/backup.env" --entrypoint rclone "$backup_image" "$@"; }
src_sql() { docker exec "$src" psql -U school -d school -tAc "$1"; }
runs() { src_sql "select count(*) from backup_runs where ok = $1"; }

step "waiting for the storage, then making the bucket"
for _ in $(seq 1 30); do
  rc lsd drill: >/dev/null 2>&1 && break
  sleep 1
done
rc mkdir "drill:$bucket"

step "migrating the source database and seeding a class (from the host, through 127.0.0.1:$src_port)"
host_url="postgres://school:$pg_password@127.0.0.1:$src_port/school"
(
  cd "$root"
  DATABASE_URL="$host_url" npx tsx -e "
    import { createDb, migrateToLatest } from './src/shared/db.ts'
    const db = createDb(process.env.DATABASE_URL)
    migrateToLatest(db).then(() => db.destroy(), (err) => { console.error(err); process.exit(1) })
  "
  DATABASE_URL="$host_url" SCHOOL_CONFIG=config/school.example.json PROMPTS_DIR=data/prompts \
    MODERATION_DATA_DIR=data/moderation LLM_FAKE=1 \
    npm run --silent dev:seed -- --division junior --slot evening --students 5 --out "$work/keys.json"
)
students="$(src_sql 'select count(*) from students')"
[ "$students" -ge 1 ] || fail "the source database has no students"
echo "drill: the source database has $students students"

step "making a throwaway age key pair (the private key stays in $work, never in the backup container's environment)"
docker run --rm --entrypoint age-keygen "$backup_image" > "$work/age-key.txt" 2>"$work/age-key.pub.txt"
recipient="$(sed -n 's/^Public key: //p' "$work/age-key.pub.txt")"
[ -n "$recipient" ] || recipient="$(sed -n 's/^# public key: //p' "$work/age-key.txt")"
[ -n "$recipient" ] || fail "could not read the public key"
echo "BACKUP_AGE_RECIPIENT=$recipient" >> "$work/backup.env"

step "1/5 a backup"
in_image backup.sh
objects="$(rc lsf "drill:$bucket/backups/")"
echo "drill: the bucket holds: $objects"
[ "$(echo "$objects" | grep -c '\.dump\.age$')" = 1 ] || fail "expected one .dump.age object in the bucket"
[ "$(runs true)" = 1 ] && [ "$(runs false)" = 0 ] || fail "backup_runs should hold one ok row and no failed row"
object="$(echo "$objects" | head -1)"
# The object must really be encrypted, not a dump.
rc cat "drill:$bucket/backups/$object" > "$work/object.age"
head -c 21 "$work/object.age" | grep -q 'age-encryption.org/v1' || fail "the object is not an age file"
! grep -q 'PGDMP' "$work/object.age" || fail "the object holds a plain dump"

step "2/5 restoring into a new empty database, and starting both services on it"
compose build registration
compose up -d --wait --wait-timeout 120 postgres
restore() { docker run --rm --network "$net" --env-file "$work/backup.env" -v "$work/age-key.txt:/key.txt:ro" "$backup_image" restore.sh "$@"; }
restore "$object" /key.txt "postgres://school:$pg_password@postgres:5432/school"
echo "drill: asking restore.sh to restore into the database that is now full: it must refuse"
if restore "$object" /key.txt "postgres://school:$pg_password@postgres:5432/school"; then
  fail "restore.sh restored into a database that was not empty"
fi
compose up -d --wait --wait-timeout 180 registration class
for port_service in "8080 registration" "8081 class"; do
  set -- $port_service
  compose exec -T "$2" node dist/tools/healthcheck.js "$1" || fail "$2 is not healthy on the restored database"
  echo "drill: $2 answers /healthz"
done
restored="$(compose exec -T postgres psql -U school -d school -tAc 'select count(*) from students' | tr -d '[:space:]')"
echo "drill: students in the restored database: $restored, in the source: $students"
[ "$restored" = "$students" ] || fail "the restored database has $restored students, the source $students"

echo "drill: the README's restore, with docker exec in place of ssh: decrypt outside the server, stream in"
compose exec -T postgres createdb -U school school_restored
docker run --rm --network "$net" --env-file "$work/backup.env" -v "$work/age-key.txt:/key.txt:ro" --entrypoint sh "$backup_image" -c \
  "rclone cat drill:$bucket/backups/$object | age -d -i /key.txt" \
  | compose exec -T postgres pg_restore --single-transaction --no-owner -U school -d school_restored
streamed="$(compose exec -T postgres psql -U school -d school_restored -tAc 'select count(*) from students' | tr -d '[:space:]')"
[ "$streamed" = "$students" ] || fail "the streamed restore has $streamed students, the source $students"
echo "drill: students after the streamed restore: $streamed"

step "3/5 each of three failures records a failed run and exits non-zero"
expect_failure() {
  local what="$1" before after
  shift
  before="$(runs false)"
  DRILL_RUN_ARGS=("$@")
  if in_image backup.sh; then fail "backup.sh succeeded with $what"; fi
  DRILL_RUN_ARGS=()
  after="$(runs false)"
  [ "$after" = "$((before + 1))" ] || fail "with $what the failed runs went from $before to $after"
  echo "drill: $what -> exit non-zero and one more ok = false row"
}
# A valid key that is not an age key at all.
expect_failure "a wrong public key" -e BACKUP_AGE_RECIPIENT=age1notakeynotakeynotakeynotakeynotakeynotakeynotakeynotakeynotake
expect_failure "a bucket that does not exist" -e BACKUP_S3_BUCKET=no-such-bucket
# The dump cannot connect; the run is still recorded in the real database.
expect_failure "an unreachable database" -e "BACKUP_DATABASE_URL=postgres://school:$pg_password@$src:1/school?connect_timeout=3"
expect_failure "BACKUP_KEEP_DAYS=0" -e BACKUP_KEEP_DAYS=0
[ "$(rc lsf "drill:$bucket/backups/" | grep -c '\.dump\.age$')" = 1 ] || fail "a failed backup left an object in the bucket"
[ "$(runs true)" = 1 ] || fail "the failed runs changed the ok rows"

step "4/5 only backups older than BACKUP_KEEP_DAYS are deleted"
rc delete "drill:$bucket/backups/"
in_image sh -c '
  set -e
  old="$(date -d "@$(( $(date +%s) - 15 * 86400 ))" +%Y-%m-%dT%H%M)"
  recent="$(date -d "@$(( $(date +%s) - 86400 ))" +%Y-%m-%dT%H%M)"
  echo old > /tmp/old; echo recent > /tmp/recent
  touch -d "@$(( $(date +%s) - 15 * 86400 ))" /tmp/old
  touch -d "@$(( $(date +%s) - 86400 ))" /tmp/recent
  rclone copyto /tmp/old "drill:$BACKUP_S3_BUCKET/backups/$old.dump.age"
  rclone copyto /tmp/recent "drill:$BACKUP_S3_BUCKET/backups/$recent.dump.age"
  rclone lsf "drill:$BACKUP_S3_BUCKET/backups/"
' > "$work/before.txt"
[ "$(wc -l < "$work/before.txt" | tr -d ' ')" = 2 ] || fail "could not put the two old objects in the bucket"
old_name="$(sort "$work/before.txt" | head -1)"
recent_name="$(sort "$work/before.txt" | tail -1)"
in_image backup.sh
rc lsf "drill:$bucket/backups/" | sort > "$work/after.txt"
cat "$work/after.txt"
[ "$(wc -l < "$work/after.txt" | tr -d ' ')" = 2 ] || fail "expected the recent object and the new one to be left"
grep -qx "$recent_name" "$work/after.txt" || fail "the one-day-old backup was deleted"
if grep -qx "$old_name" "$work/after.txt"; then fail "the 15-day-old backup was not deleted"; fi
echo "drill: the 15-day-old object is gone, the 1-day-old one and the new one are left"

step "5/5 everything passed"
