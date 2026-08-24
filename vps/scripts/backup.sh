#!/usr/bin/env bash
set -euo pipefail

backup_dir="/var/backups/tianxun"
state_dir="/var/lib/tianxun"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
offsite_remote="${TIANXUN_BACKUP_RCLONE_REMOTE:-}"
backup_files=()

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
  backup_files+=("$target" "$target.sha256")
done

if [[ -n "$offsite_remote" ]]; then
  command -v rclone >/dev/null 2>&1 || { echo "TIANXUN_BACKUP_RCLONE_REMOTE is configured but rclone is unavailable" >&2; exit 1; }
  for backup_file in "${backup_files[@]}"; do
    rclone copyto --checksum --retries 3 --low-level-retries 5 "$backup_file" "${offsite_remote%/}/$(basename "$backup_file")"
  done
fi

find "$backup_dir" -type f -name '*.sqlite' -mtime +14 -delete
find "$backup_dir" -type f -name '*.sqlite.sha256' -mtime +14 -delete
echo "Backup complete: $backup_dir ($timestamp)${offsite_remote:+ and $offsite_remote}"
