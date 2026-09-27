#!/bin/sh
# Nightly database backup to ./backups on the server. Keeps BACKUP_KEEP_DAYS days.
set -eu
echo "backup service started; first backup in 5 minutes, then daily"
sleep 300
while true; do
  file="/backups/liveassist-$(date -u +%Y%m%d-%H%M%S).sql.gz"
  if pg_dump --no-owner | gzip > "$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "backup written: $file"
  else
    rm -f "$file.tmp"
    echo "backup FAILED" >&2
  fi
  find /backups -name 'liveassist-*.sql.gz' -mtime +"${BACKUP_KEEP_DAYS:-14}" -delete
  sleep 86400
done
