#!/bin/bash
# Daily pg_dump of the tnved database. Runs as the postgres OS user (peer
# auth, no password needed) via the tnved-db-backup systemd timer.
# Installed on the VPS as /usr/local/bin/tnved-db-backup.sh; this copy in the
# repo is the source — edit here, then copy it over.
# Backups live outside /opt/tnved deliberately - that directory is nginx's
# document root (root /opt/tnved; try_files $uri ...) and serves any file
# placed in it directly over HTTPS, so dumps (password hashes, session
# data) must never land there.
set -euo pipefail

BACKUP_DIR=/var/backups/tnved-db
RETENTION_DAYS=14
TS=$(date -u +%Y%m%d_%H%M%S)
FILE="$BACKUP_DIR/tnved_${TS}.dump"

pg_dump -Fc -d tnved -f "$FILE"
chmod 600 "$FILE"

find "$BACKUP_DIR" -maxdepth 1 -name 'tnved_*.dump' -mtime +"$RETENTION_DAYS" -delete

# Restore check (17.09.2026): a dump that has never been restored is a hope,
# not a backup. Every night the fresh dump is restored into a throwaway
# database and the row counts of the tables that matter are compared with the
# live ones. Any failure fails the unit, which shows in `systemctl --failed`.
# Between dump and count the live database may have grown by a few rows or shrunk
# (deleting a user cascades to their assistant_log), so "more rows in the copy" is
# not a failure - until 21.09.2026 it was, a false alarm waiting for the first
# deletion at backup time. A failure is an empty users table or a visible loss of rows.
CHECK_DB=tnved_restore_check
dropdb --if-exists "$CHECK_DB"
createdb "$CHECK_DB"
trap 'dropdb --if-exists "$CHECK_DB"' EXIT
pg_restore --no-owner --exit-on-error -d "$CHECK_DB" "$FILE"

summary=""
for t in users admin_audit_log assistant_log; do
  restored=$(psql -At -d "$CHECK_DB" -c "select count(*) from $t")
  live=$(psql -At -d tnved -c "select count(*) from $t")
  if { [ "$t" = users ] && [ "$restored" -eq 0 ]; } || [ $((restored + 100)) -lt "$live" ]; then
    echo "restore check FAILED: $t restored=$restored live=$live" >&2
    exit 1
  fi
  summary="$summary $t=$restored/$live"
done
echo "backup $FILE ok, restore check ok:$summary"
