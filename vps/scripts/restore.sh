#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 || "$#" -ne 2 ]]; then
  echo "Usage: sudo bash restore.sh <operational|notifier> /var/backups/tianxun/<backup>.sqlite" >&2
  exit 2
fi

database="$1"
backup="$(readlink -f -- "$2")"
case "$backup" in /var/backups/tianxun/*.sqlite) ;; *) echo "Backup must be under /var/backups/tianxun" >&2; exit 2 ;; esac
[[ -f "$backup" ]] || { echo "Backup does not exist: $backup" >&2; exit 2; }
checksum_file="${backup}.sha256"
[[ -f "$checksum_file" ]] || { echo "Backup checksum is missing: $checksum_file" >&2; exit 2; }
(cd "$(dirname "$backup")" && sha256sum --check "$(basename "$checksum_file")" >/dev/null) || { echo "Backup checksum verification failed" >&2; exit 1; }
[[ "$(sqlite3 "$backup" 'PRAGMA quick_check;')" == "ok" ]] || { echo "Backup integrity check failed" >&2; exit 1; }

case "$database" in
  operational) target="/var/lib/tianxun/engine/operational.sqlite"; owner="tianxun-engine:tianxun-engine"; services=(tianxun-ingest.timer tianxun-ingest.service tianxun-notifier.timer tianxun-notifier.service tianxun-orbit-refresh.timer tianxun-orbit-refresh.service tianxun-engine.service) ;;
  notifier) target="/var/lib/tianxun/notifier/notifier.sqlite"; owner="tianxun-notifier:tianxun-notifier"; services=(tianxun-notifier.timer tianxun-notifier.service) ;;
  *) echo "Unknown database: $database" >&2; exit 2 ;;
esac

for service in "${services[@]}"; do systemctl stop "$service"; done
rollback="${target}.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -f "$target" ]]; then cp --preserve=mode,ownership,timestamps -- "$target" "$rollback"; fi
rm -f -- "$target-wal" "$target-shm"
sqlite3 "$target" ".restore '$backup'"
chown "$owner" "$target"
chmod 0600 "$target"
[[ "$(sqlite3 "$target" 'PRAGMA quick_check;')" == "ok" ]] || { echo "Restored database is invalid; services remain stopped. Rollback: $rollback" >&2; exit 1; }
if [[ "$database" == "operational" ]]; then
  systemctl start tianxun-engine.service
  systemctl start tianxun-ingest.timer tianxun-orbit-refresh.timer
fi
systemctl start tianxun-notifier.timer
echo "Restored $database from $backup. Pre-restore copy: $rollback"
