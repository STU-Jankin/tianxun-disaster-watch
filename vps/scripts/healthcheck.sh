#!/usr/bin/env bash
set -euo pipefail

engine="$(curl --fail --silent --show-error http://127.0.0.1:3000/api/health)"
hermes="$(curl --fail --silent --show-error http://127.0.0.1:8644/health)"
timer="$(systemctl is-active tianxun-notifier.timer)"
db="/var/lib/tianxun/notifier/notifier.sqlite"
if [[ ! -f "$db" ]]; then
  echo "notifier database missing: $db" >&2
  exit 1
fi
dead_letters="$(sqlite3 "$db" "SELECT COUNT(*) FROM notification_queue WHERE status='dead_letter';")"
old_pending="$(sqlite3 "$db" "SELECT COUNT(*) FROM notification_queue WHERE status IN ('pending','retry','in_flight') AND created_at < datetime('now','-30 minutes');")"
last_ok="$(sqlite3 "$db" "SELECT completed_at FROM collection_runs WHERE status='ok' ORDER BY id DESC LIMIT 1;")"
if [[ -z "$last_ok" ]] || [[ "$(date -u -d "$last_ok" +%s)" -lt "$(( $(date -u +%s) - 1200 ))" ]]; then
  echo "notifier has no successful collection in the last 20 minutes" >&2
  exit 1
fi
if [[ "$dead_letters" -gt 0 || "$old_pending" -gt 0 ]]; then
  echo "unhealthy queue: dead_letter=$dead_letters old_pending=$old_pending" >&2
  exit 1
fi

printf 'engine: %s\n' "$engine"
printf 'hermes: %s\n' "$hermes"
printf 'notifier timer: %s\n' "$timer"
printf 'last successful collection: %s\n' "$last_ok"
systemctl --no-pager --full status tianxun-engine.service tianxun-notifier.timer | sed -n '1,28p'
