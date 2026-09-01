#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash vps/scripts/install.sh" >&2
  exit 1
fi

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
install_root="/opt/tianxun"
release_dir="$install_root/releases/$(date -u +%Y%m%dT%H%M%SZ)"

case "$release_dir" in
  /opt/tianxun/releases/*) ;;
  *) echo "Refusing unsafe release path: $release_dir" >&2; exit 1 ;;
esac

node_bin="/usr/bin/node"
npm_bin="/usr/bin/npm"
if [[ ! -x "$node_bin" || ! -x "$npm_bin" ]]; then
  echo "System-wide Node.js and npm are required at /usr/bin/node and /usr/bin/npm." >&2
  echo "Do not rely on a root-only nvm/Hermes Node installation for system services." >&2
  exit 1
fi

node_version="$("$node_bin" --version 2>/dev/null | sed -E 's/^v//' || true)"
node_major="${node_version%%.*}"
node_minor="$(cut -d. -f2 <<<"$node_version")"
if [[ -z "$node_major" || "$node_major" -lt 22 || ( "$node_major" -eq 22 && "${node_minor:-0}" -lt 13 ) ]]; then
  echo "Node.js 22.13+ is required. Install it first, then rerun this script." >&2
  exit 1
fi

for required_command in sqlite3 curl openssl; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 1
  fi
done

for service_user in tianxun-engine tianxun-notifier; do
  if ! id -u "$service_user" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir "/var/lib/$service_user" --shell /usr/sbin/nologin "$service_user"
  fi
done

install -d -o root -g root -m 0755 /var/lib/tianxun
install -d -o tianxun-engine -g tianxun-engine -m 0750 /var/lib/tianxun/engine
install -d -o tianxun-engine -g tianxun-engine -m 0750 /var/lib/tianxun/engine/forecast-archive
install -d -o tianxun-notifier -g tianxun-notifier -m 0750 /var/lib/tianxun/notifier
install -d -o root -g root -m 0755 "$install_root/releases" "$release_dir"
# Copy an explicit release allow-list. This prevents local .env files, VCS
# history, editor state, test fixtures and cached databases from ever entering
# the release directory, even briefly.
for directory in .openai app build db drizzle lib public tests types vps worker; do
  [[ -d "$project_dir/$directory" ]] || { echo "Missing release directory: $directory" >&2; exit 1; }
  cp -a "$project_dir/$directory" "$release_dir/"
done
for file in package.json package-lock.json tsconfig.json vite.config.ts next.config.ts next-env.d.ts postcss.config.mjs drizzle.config.ts eslint.config.mjs; do
  [[ -f "$project_dir/$file" ]] || { echo "Missing release file: $file" >&2; exit 1; }
  cp -a "$project_dir/$file" "$release_dir/"
done
# ZIP/TAR packages created on Windows may drop Unix executable bits even when
# Git records the scripts as executable. Normalize them before systemd points
# at the new release so timers cannot fail with status 203/EXEC.
find "$release_dir/vps/scripts" -type f -name '*.sh' -exec chmod 0755 {} +
chmod 0755 "$release_dir"

cd "$release_dir"
install -d -o tianxun-engine -g tianxun-engine -m 0750 /var/cache/tianxun/npm
chown -R tianxun-engine:tianxun-engine "$release_dir"
runuser -u tianxun-engine -- env npm_config_cache=/var/cache/tianxun/npm "$npm_bin" ci
runuser -u tianxun-engine -- env npm_config_cache=/var/cache/tianxun/npm "$npm_bin" run verify
chown -R root:root "$release_dir"
previous_target="$(readlink -f "$install_root/current" 2>/dev/null || true)"
rollback_db_snapshot=""
if [[ -f /var/lib/tianxun/engine/operational.sqlite ]]; then
  install -d -o root -g root -m 0700 "$release_dir/.rollback-data"
  rollback_db_snapshot="$release_dir/.rollback-data/operational.sqlite"
  sqlite3 /var/lib/tianxun/engine/operational.sqlite ".backup '$rollback_db_snapshot'"
  chmod 0600 "$rollback_db_snapshot"
fi
ln -sfn "$release_dir" "$install_root/current"

rollback_release() {
  trap - ERR
  systemctl stop tianxun-engine.service >/dev/null 2>&1 || true
  if [[ -n "${unit_backup_dir:-}" && -d "$unit_backup_dir" ]]; then
    for unit_name in "${unit_names[@]}"; do
      if [[ -f "$unit_backup_dir/$unit_name" ]]; then
        install -o root -g root -m 0644 "$unit_backup_dir/$unit_name" "/etc/systemd/system/$unit_name"
      else
        rm -f -- "/etc/systemd/system/$unit_name"
      fi
    done
    systemctl daemon-reload || true
  fi
  if [[ -n "$previous_target" && "$previous_target" == /opt/tianxun/releases/* ]]; then
    ln -sfn "$previous_target" "$install_root/current"
    systemctl restart tianxun-engine.service || true
    echo "Restored previous release: $previous_target" >&2
  fi
  if [[ -n "$rollback_db_snapshot" ]]; then
    echo "Pre-deploy database snapshot retained at $rollback_db_snapshot" >&2
  fi
}
trap rollback_release ERR

install -d -o root -g root -m 0755 /etc/tianxun
if [[ ! -f /etc/tianxun/engine.env ]]; then
  install -o root -g tianxun-engine -m 0640 "$release_dir/vps/engine.env.example" /etc/tianxun/engine.env
fi
if [[ ! -f /etc/tianxun/notifier.env ]]; then
  install -o root -g tianxun-notifier -m 0640 "$release_dir/vps/notifier.env.example" /etc/tianxun/notifier.env
fi
if [[ ! -f /etc/tianxun/backup.env ]]; then
  install -o root -g root -m 0600 "$release_dir/vps/backup.env.example" /etc/tianxun/backup.env
fi
forecast_archive_dir="/var/lib/tianxun/engine/forecast-archive"
if grep -q '^TIANXUN_FORECAST_ARCHIVE_DIR=' /etc/tianxun/engine.env; then
  sed -i -E "s|^TIANXUN_FORECAST_ARCHIVE_DIR=.*$|TIANXUN_FORECAST_ARCHIVE_DIR=$forecast_archive_dir|" /etc/tianxun/engine.env
else
  printf '%s=%s\n' 'TIANXUN_FORECAST_ARCHIVE_DIR' "$forecast_archive_dir" >> /etc/tianxun/engine.env
fi
engine_token="$(sed -n 's/^TIANXUN_API_TOKEN=//p' /etc/tianxun/engine.env | head -n1)"
if [[ ! "$engine_token" =~ ^[a-fA-F0-9]{64}$ ]]; then
  engine_token="$(openssl rand -hex 32)"
fi
sed -i -E "s|^TIANXUN_API_TOKEN=.*$|TIANXUN_API_TOKEN=$engine_token|" /etc/tianxun/engine.env
viewer_token="$(sed -n 's/^TIANXUN_VIEWER_TOKEN=//p' /etc/tianxun/engine.env | head -n1)"
if [[ ! "$viewer_token" =~ ^[a-fA-F0-9]{64}$ ]]; then viewer_token="$(openssl rand -hex 32)"; fi
if grep -q '^TIANXUN_VIEWER_TOKEN=' /etc/tianxun/engine.env; then
  sed -i -E "s|^TIANXUN_VIEWER_TOKEN=.*$|TIANXUN_VIEWER_TOKEN=$viewer_token|" /etc/tianxun/engine.env
else
  printf '%s=%s\n' 'TIANXUN_VIEWER_TOKEN' "$viewer_token" >> /etc/tianxun/engine.env
fi
if grep -q '^TIANXUN_VIEWER_TOKEN=' /etc/tianxun/notifier.env; then
  sed -i -E "s|^TIANXUN_VIEWER_TOKEN=.*$|TIANXUN_VIEWER_TOKEN=$viewer_token|" /etc/tianxun/notifier.env
else
  printf '%s=%s\n' 'TIANXUN_VIEWER_TOKEN' "$viewer_token" >> /etc/tianxun/notifier.env
fi
# Remove the legacy shared administrator token from the notifier environment.
sed -i -E '/^TIANXUN_API_TOKEN=/d' /etc/tianxun/notifier.env
for role in OPERATOR EXECUTOR; do
  variable="TIANXUN_${role}_TOKEN"
  role_token="$(sed -n "s/^${variable}=//p" /etc/tianxun/engine.env | head -n1)"
  if [[ ! "$role_token" =~ ^[a-fA-F0-9]{64}$ ]]; then role_token="$(openssl rand -hex 32)"; fi
  if grep -q "^${variable}=" /etc/tianxun/engine.env; then
    sed -i -E "s|^${variable}=.*$|${variable}=${role_token}|" /etc/tianxun/engine.env
  else
    printf '%s=%s\n' "$variable" "$role_token" >> /etc/tianxun/engine.env
  fi
done
chown root:tianxun-engine /etc/tianxun/engine.env
chmod 0640 /etc/tianxun/engine.env
chown root:tianxun-notifier /etc/tianxun/notifier.env
chmod 0640 /etc/tianxun/notifier.env

unit_names=(tianxun-engine.service tianxun-notifier.service tianxun-notifier.timer tianxun-ingest.service tianxun-ingest.timer tianxun-backup.service tianxun-backup.timer tianxun-orbit-refresh.service tianxun-orbit-refresh.timer)
unit_backup_dir="$release_dir/.rollback-units"
install -d -o root -g root -m 0700 "$unit_backup_dir"
for unit_name in "${unit_names[@]}"; do
  [[ -f "/etc/systemd/system/$unit_name" ]] && cp -a "/etc/systemd/system/$unit_name" "$unit_backup_dir/$unit_name"
  install -o root -g root -m 0644 "$release_dir/vps/systemd/$unit_name" "/etc/systemd/system/$unit_name"
done

systemctl daemon-reload
engine_ready=false
if systemctl enable tianxun-engine.service && systemctl restart tianxun-engine.service; then
  for _attempt in {1..15}; do
    if curl --fail --silent --show-error http://127.0.0.1:3000/api/health/live >/dev/null 2>&1; then
      engine_ready=true
      break
    fi
    sleep 1
  done
fi
if [[ "$engine_ready" != true ]]; then
  rollback_release
  echo "Engine liveness check failed." >&2
  exit 1
fi
if ! systemctl start tianxun-ingest.service; then
  rollback_release
  echo "Initial source ingestion failed; release is not ready." >&2
  exit 1
fi
if ! curl --fail --silent --show-error -H "Authorization: Bearer $viewer_token" http://127.0.0.1:3000/api/health >/dev/null; then
  rollback_release
  echo "Readiness check failed after initial ingestion." >&2
  exit 1
fi
mapfile -t old_releases < <(find "$install_root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | tail -n +4 | cut -d' ' -f2-)
for old_release in "${old_releases[@]}"; do
  case "$old_release" in
    /opt/tianxun/releases/*) rm -rf -- "$old_release" ;;
    *) echo "Skipping unsafe release cleanup target: $old_release" >&2 ;;
  esac
done
systemctl enable tianxun-notifier.timer
systemctl enable --now tianxun-ingest.timer
systemctl enable --now tianxun-backup.timer
systemctl enable --now tianxun-orbit-refresh.timer
trap - ERR

echo
echo "Tianxun backend installed at $release_dir."
echo "Before the first alert test:"
echo "  1. Fill /etc/tianxun/engine.env and /etc/tianxun/notifier.env."
echo "     Separate random admin and read-only service tokens were generated without printing them."
echo "  2. Configure the browser login: sudo bash /opt/tianxun/current/vps/scripts/configure-login.sh"
echo "  3. Configure HTTPS before exposing the web console; production login rejects HTTP."
echo "  4. Configure Hermes Feishu/Webhooks and create the tianxun-alerts route."
echo "  5. Run: systemctl restart tianxun-engine.service"
echo "  6. Run: systemctl start tianxun-notifier.service"
echo "  7. If the test succeeds: systemctl enable --now tianxun-notifier.timer"
echo "No public application port was opened."
