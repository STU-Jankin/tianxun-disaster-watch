#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash vps/scripts/install-osm-jiangsu.sh" >&2
  exit 1
fi

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
engine_env="/etc/tianxun/engine.env"
osm_env="/etc/tianxun/osm-jiangsu.env"
[[ -f "$engine_env" ]] || { echo "Install the Tianxun engine first; $engine_env is missing." >&2; exit 1; }
for required in curl unzip sqlite3 openssl nginx /usr/bin/node; do
  if [[ "$required" == /* ]]; then [[ -x "$required" ]] || { echo "Missing required executable: $required" >&2; exit 1; }
  else command -v "$required" >/dev/null 2>&1 || { echo "Missing required command: $required" >&2; exit 1; }
  fi
done

if ! id -u tianxun-osm >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /var/lib/tianxun/osm-jiangsu --shell /usr/sbin/nologin tianxun-osm
fi
install -d -o root -g root -m 0755 /etc/tianxun /etc/nginx/snippets
install -d -o tianxun-osm -g tianxun-osm -m 0750 /var/lib/tianxun/osm-jiangsu

token="$(sed -n 's/^JIANGSU_OSM_API_TOKEN=//p' "$osm_env" 2>/dev/null | head -n1 || true)"
if [[ ! "$token" =~ ^[a-fA-F0-9]{64}$ ]]; then token="$(openssl rand -hex 32)"; fi
cat > "$osm_env" <<EOF
JIANGSU_OSM_INDEX_PATH=/var/lib/tianxun/osm-jiangsu/jiangsu.sqlite
JIANGSU_OSM_PORT=8791
JIANGSU_OSM_API_TOKEN=$token
EOF
chown root:tianxun-osm "$osm_env"
chmod 0640 "$osm_env"

upsert_env() {
  local name="$1" value="$2"
  if grep -q "^${name}=" "$engine_env"; then sed -i -E "s|^${name}=.*$|${name}=${value}|" "$engine_env"
  else printf '%s=%s\n' "$name" "$value" >> "$engine_env"
  fi
}
upsert_env JIANGSU_OSM_API_URL http://127.0.0.1:8791/v1/exposure
upsert_env JIANGSU_OSM_API_TOKEN "$token"
upsert_env JIANGSU_OSM_ALLOW_PRIVATE_ENDPOINT true
upsert_env JIANGSU_OSM_MAX_AREA_KM2 120000
upsert_env JIANGSU_OSM_TIMEOUT_SECONDS 15

for unit in tianxun-osm-jiangsu.service tianxun-osm-jiangsu-refresh.service tianxun-osm-jiangsu-refresh.timer; do
  install -o root -g root -m 0644 "$project_dir/vps/systemd/$unit" "/etc/systemd/system/$unit"
done
install -o root -g root -m 0644 "$project_dir/vps/nginx/tianxun-osm-jiangsu.conf" /etc/nginx/snippets/tianxun-osm-jiangsu.conf

site_available="/etc/nginx/sites-available/tianxun-public-readonly"
if [[ -f "$site_available" && $(grep -c 'ssl_certificate' "$site_available" || true) -gt 0 && $(grep -c 'tianxun-osm-jiangsu' "$site_available" || true) -eq 0 ]]; then
  sed -i '/    location = \/api\/health\/live {/i\    include /etc/nginx/snippets/tianxun-osm-jiangsu*.conf;\n' "$site_available"
fi
nginx -t
systemctl reload nginx.service
systemctl daemon-reload

systemctl stop tianxun-osm-jiangsu.service >/dev/null 2>&1 || true
bash "$project_dir/vps/osm-jiangsu/refresh.sh" --force
systemctl enable --now tianxun-osm-jiangsu.service
systemctl enable --now tianxun-osm-jiangsu-refresh.timer
systemctl restart tianxun-engine.service
curl --fail --silent --show-error http://127.0.0.1:8791/health >/dev/null
echo "Jiangsu OSM local index is ready. The access token was stored without printing it."
