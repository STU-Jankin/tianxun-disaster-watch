#!/usr/bin/env bash
set -euo pipefail

backup_dir="/var/backups/tianxun"
state_dir="/var/lib/tianxun"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

install -d -o root -g root -m 0750 "$backup_dir"
declare -A databases=( [operational]="$state_dir/engine/operational.sqlite" [notifier]="$state_dir/notifier/notifier.sqlite" )
for database in operational notifier; do
  source_file="${databases[$database]}"
  if [[ ! -f "$source_file" ]]; then
    echo "Required database is missing; backup aborted: $source_file" >&2
    exit 1
  fi
  if [[ "$(sqlite3 "$source_file" 'PRAGMA quick_check;')" != "ok" ]]; then
    echo "Source database integrity check failed: $source_file" >&2
    exit 1
  fi
  target="$backup_dir/${database}-${timestamp}.sqlite"
  sqlite3 "$source_file" ".backup '$target'"
  if [[ "$(sqlite3 "$target" 'PRAGMA quick_check;')" != "ok" ]]; then
    echo "Backup integrity check failed: $target" >&2
    exit 1
  fi
  sha256sum "$target" > "$target.sha256"
done

find "$backup_dir" -type f -name '*.sqlite' -mtime +14 -delete
find "$backup_dir" -type f -name '*.sqlite.sha256' -mtime +14 -delete
echo "Backup complete: $backup_dir ($timestamp)"
