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
install -d -o tianxun-notifier -g tianxun-notifier -m 0750 /var/lib/tianxun/notifier
install -d -o root -g root -m 0755 "$install_root/releases" "$release_dir"
# Copy an explicit release allow-list. This prevents local .env files, VCS
# history, editor state, test fixtures and cached databases from ever entering
# the release directory, even briefly.
for directory in .openai app build db drizzle lib public vps worker; do
  [[ -d "$project_dir/$directory" ]] || { echo "Missing release directory: $directory" >&2; exit 1; }
  cp -a "$project_dir/$directory" "$release_dir/"
done
for file in package.json package-lock.json tsconfig.json vite.config.ts next.config.ts next-env.d.ts postcss.config.mjs drizzle.config.ts; do
  [[ -f "$project_dir/$file" ]] || { echo "Missing release file: $file" >&2; exit 1; }
  cp -a "$project_dir/$file" "$release_dir/"
done
chmod 0755 "$release_dir"

cd "$release_dir"
install -d -o tianxun-engine -g tianxun-engine -m 0750 /var/cache/tianxun/npm
chown -R tianxun-engine:tianxun-engine "$release_dir"
runuser -u tianxun-engine -- env npm_config_cache=/var/cache/tianxun/npm "$npm_bin" ci
runuser -u tianxun-engine -- env npm_config_cache=/var/cache/tianxun/npm "$npm_bin" run build
chown -R root:root "$release_dir"
previous_target="$(readlink -f "$install_root/current" 2>/dev/null || true)"
ln -sfn "$release_dir" "$install_root/current"

rollback_release() {
  if [[ -n "$previous_target" && "$previous_target" == /opt/tianxun/releases/* ]]; then
    ln -sfn "$previous_target" "$install_root/current"
    systemctl restart tianxun-engine.service || true
    echo "Restored previous release: $previous_target" >&2
  fi
}

install -d -o root -g root -m 0755 /etc/tianxun
if [[ ! -f /etc/tianxun/engine.env ]]; then
  install -o root -g tianxun-engine -m 0640 "$release_dir/vps/engine.env.example" /etc/tianxun/engine.env
fi
if [[ ! -f /etc/tianxun/notifier.env ]]; then
  install -o root -g tianxun-notifier -m 0640 "$release_dir/vps/notifier.env.example" /etc/tianxun/notifier.env
fi
engine_token="$(sed -n 's/^TIANXUN_API_TOKEN=//p' /etc/tianxun/engine.env | head -n1)"
if [[ ! "$engine_token" =~ ^[a-fA-F0-9]{64}$ ]]; then
  engine_token="$(openssl rand -hex 32)"
fi
sed -i -E "s|^TIANXUN_API_TOKEN=.*$|TIANXUN_API_TOKEN=$engine_token|" /etc/tianxun/engine.env
sed -i -E "s|^TIANXUN_API_TOKEN=.*$|TIANXUN_API_TOKEN=$engine_token|" /etc/tianxun/notifier.env
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

install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-engine.service" /etc/systemd/system/tianxun-engine.service
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-notifier.service" /etc/systemd/system/tianxun-notifier.service
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-notifier.timer" /etc/systemd/system/tianxun-notifier.timer
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-ingest.service" /etc/systemd/system/tianxun-ingest.service
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-ingest.timer" /etc/systemd/system/tianxun-ingest.timer
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-backup.service" /etc/systemd/system/tianxun-backup.service
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-backup.timer" /etc/systemd/system/tianxun-backup.timer
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-orbit-refresh.service" /etc/systemd/system/tianxun-orbit-refresh.service
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-orbit-refresh.timer" /etc/systemd/system/tianxun-orbit-refresh.timer

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
if ! curl --fail --silent --show-error -H "Authorization: Bearer $engine_token" http://127.0.0.1:3000/api/health >/dev/null; then
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

echo
echo "Tianxun backend installed at $release_dir."
echo "Before the first alert test:"
echo "  1. Fill /etc/tianxun/engine.env and /etc/tianxun/notifier.env."
echo "     A shared random TIANXUN_API_TOKEN was generated without printing it."
echo "  2. Configure Hermes Feishu/Webhooks and create the tianxun-alerts route."
echo "  3. Run: systemctl restart tianxun-engine.service"
echo "  4. Run: systemctl start tianxun-notifier.service"
echo "  5. If the test succeeds: systemctl enable --now tianxun-notifier.timer"
echo "No public application port was opened."
