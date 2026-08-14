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

for required_command in sqlite3 curl; do
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
cp -a "$project_dir/." "$release_dir/"
# cp -a also copies the source directory mode. Releases are often unpacked in a
# private mktemp directory (0700), so restore traverse permission for the
# dedicated service users before switching the current symlink.
chmod 0755 "$release_dir"
rm -rf "$release_dir/node_modules" "$release_dir/.git" "$release_dir/.next" "$release_dir/.vinext" "$release_dir/.wrangler" "$release_dir/.data"
find "$release_dir" -maxdepth 1 -type f -name '.env*' ! -name '.env.example' -delete
rm -f "$release_dir/.dev-output.log" "$release_dir/.dev-error.log"

cd "$release_dir"
install -d -o tianxun-engine -g tianxun-engine -m 0750 /var/cache/tianxun/npm
chown -R tianxun-engine:tianxun-engine "$release_dir"
runuser -u tianxun-engine -- env npm_config_cache=/var/cache/tianxun/npm "$npm_bin" ci
runuser -u tianxun-engine -- env npm_config_cache=/var/cache/tianxun/npm "$npm_bin" run build
chown -R root:root "$release_dir"
previous_target="$(readlink -f "$install_root/current" 2>/dev/null || true)"
ln -sfn "$release_dir" "$install_root/current"

install -d -o root -g root -m 0755 /etc/tianxun
if [[ ! -f /etc/tianxun/engine.env ]]; then
  install -o root -g tianxun-engine -m 0640 "$release_dir/vps/engine.env.example" /etc/tianxun/engine.env
fi
if [[ ! -f /etc/tianxun/notifier.env ]]; then
  install -o root -g tianxun-notifier -m 0640 "$release_dir/vps/notifier.env.example" /etc/tianxun/notifier.env
fi
chown root:tianxun-engine /etc/tianxun/engine.env
chmod 0640 /etc/tianxun/engine.env
chown root:tianxun-notifier /etc/tianxun/notifier.env
chmod 0640 /etc/tianxun/notifier.env

install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-engine.service" /etc/systemd/system/tianxun-engine.service
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-notifier.service" /etc/systemd/system/tianxun-notifier.service
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-notifier.timer" /etc/systemd/system/tianxun-notifier.timer
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-backup.service" /etc/systemd/system/tianxun-backup.service
install -o root -g root -m 0644 "$release_dir/vps/systemd/tianxun-backup.timer" /etc/systemd/system/tianxun-backup.timer

systemctl daemon-reload
if ! systemctl enable tianxun-engine.service \
  || ! systemctl restart tianxun-engine.service \
  || ! curl --fail --silent --show-error --retry 5 --retry-delay 2 http://127.0.0.1:3000/api/health >/dev/null; then
  if [[ -n "$previous_target" && "$previous_target" == /opt/tianxun/releases/* ]]; then
    ln -sfn "$previous_target" "$install_root/current"
    systemctl restart tianxun-engine.service || true
    echo "Engine health check failed; restored previous release: $previous_target" >&2
  fi
  exit 1
fi
systemctl enable tianxun-notifier.timer
systemctl enable --now tianxun-backup.timer

echo
echo "Tianxun backend installed at $release_dir."
echo "Before the first alert test:"
echo "  1. Fill /etc/tianxun/engine.env and /etc/tianxun/notifier.env."
echo "     Use the same random TIANXUN_API_TOKEN in both files."
echo "  2. Configure Hermes Feishu/Webhooks and create the tianxun-alerts route."
echo "  3. Run: systemctl restart tianxun-engine.service"
echo "  4. Run: systemctl start tianxun-notifier.service"
echo "  5. If the test succeeds: systemctl enable --now tianxun-notifier.timer"
echo "No public application port was opened."
