#!/usr/bin/env bash
set -euo pipefail

engine_token="$(sed -n 's/^TIANXUN_VIEWER_TOKEN=//p' /etc/tianxun/engine.env | head -n1)"
[[ "$engine_token" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "engine API token is missing or invalid" >&2; exit 1; }
engine="$(curl --fail --silent --show-error -H "Authorization: Bearer $engine_token" http://127.0.0.1:3000/api/health)"
hermes="$(curl --fail --silent --show-error http://127.0.0.1:8644/health)"
timer="$(systemctl is-active tianxun-notifier.timer)"
ingest_timer="$(systemctl is-active tianxun-ingest.timer)"
orbit_timer="$(systemctl is-active tianxun-orbit-refresh.timer)"
backup_timer="$(systemctl is-active tianxun-backup.timer)"
db="/var/lib/tianxun/notifier/notifier.sqlite"
if [[ ! -f "$db" ]]; then
  echo "notifier database missing: $db" >&2
  exit 1
fi
dead_letters="$(sqlite3 "$db" "SELECT COUNT(*) FROM notification_queue WHERE status='dead_letter';")"
old_pending="$(sqlite3 "$db" "SELECT COUNT(*) FROM notification_queue WHERE status IN ('pending','retry','in_flight') AND created_at < datetime('now','-30 minutes');")"
last_ok="$(sqlite3 "$db" "SELECT completed_at FROM collection_runs WHERE status='ok' ORDER BY id DESC LIMIT 1;")"
change_error="$(sqlite3 "$db" "SELECT value FROM metadata WHERE key='operational_change_error';")"
if [[ -z "$last_ok" ]] || [[ "$(date -u -d "$last_ok" +%s)" -lt "$(( $(date -u +%s) - 1200 ))" ]]; then
  echo "notifier has no successful collection in the last 20 minutes" >&2
  exit 1
fi
if [[ "$dead_letters" -gt 0 || "$old_pending" -gt 0 ]]; then
  echo "unhealthy queue: dead_letter=$dead_letters old_pending=$old_pending" >&2
  exit 1
fi
if [[ -n "$change_error" ]]; then
  echo "operational change stream is degraded: $change_error" >&2
  exit 1
fi
for database in operational notifier; do
  latest_backup="$(find /var/backups/tianxun -maxdepth 1 -type f -name "${database}-*.sqlite" -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-)"
  if [[ -z "$latest_backup" || "$(date -r "$latest_backup" +%s)" -lt "$(( $(date +%s) - 97200 ))" ]]; then
    echo "no recent $database backup (last 27 hours)" >&2
    exit 1
  fi
  (cd "$(dirname "$latest_backup")" && sha256sum --check "$(basename "$latest_backup").sha256" >/dev/null)
done

printf 'engine: %s\n' "$engine"
printf 'hermes: %s\n' "$hermes"
printf 'notifier timer: %s\n' "$timer"
printf 'ingestion timer: %s\n' "$ingest_timer"
printf 'orbit refresh timer: %s\n' "$orbit_timer"
printf 'backup timer: %s\n' "$backup_timer"
printf 'last successful collection: %s\n' "$last_ok"
systemctl --no-pager --full status tianxun-engine.service tianxun-ingest.timer tianxun-notifier.timer tianxun-orbit-refresh.timer tianxun-backup.timer | sed -n '1,48p'
