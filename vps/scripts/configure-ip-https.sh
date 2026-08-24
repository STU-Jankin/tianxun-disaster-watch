#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash vps/scripts/configure-ip-https.sh PUBLIC_IP [HTTPS_PORT]" >&2
  exit 1
fi

public_ip="${1:-}"
https_port="${2:-8443}"
[[ "$public_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "A public IPv4 address is required." >&2; exit 1; }
[[ "$https_port" =~ ^[0-9]+$ && "$https_port" -ge 1024 && "$https_port" -le 65535 ]] || { echo "HTTPS port must be between 1024 and 65535." >&2; exit 1; }

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bootstrap_template="$project_dir/vps/nginx/tianxun-ip-bootstrap.conf.template"
https_template="$project_dir/vps/nginx/tianxun-ip-https.conf.template"
site_available="/etc/nginx/sites-available/tianxun-public-readonly"
site_enabled="/etc/nginx/sites-enabled/tianxun-public-readonly"
certbot_root="/opt/tianxun-certbot"
webroot="/var/www/letsencrypt"

for required in nginx python3 openssl curl; do
  command -v "$required" >/dev/null 2>&1 || { echo "Missing required command: $required" >&2; exit 1; }
done
[[ -f "$bootstrap_template" && -f "$https_template" ]] || { echo "HTTPS templates are missing." >&2; exit 1; }
if ss -lnt | awk '{print $4}' | grep -Eq "(^|:)${https_port}$"; then
  echo "Port $https_port is already in use." >&2
  exit 1
fi

install -d -m 0755 "$webroot/.well-known/acme-challenge"
backup="$(mktemp /tmp/tianxun-nginx-backup.XXXXXX)"
if [[ -f "$site_available" ]]; then cp -a "$site_available" "$backup"; else : > "$backup"; fi
bootstrap_rendered="$(mktemp /tmp/tianxun-nginx-bootstrap.XXXXXX)"
https_rendered="$(mktemp /tmp/tianxun-nginx-https.XXXXXX)"
render_template() {
  sed -e "s/__PUBLIC_IP__/$public_ip/g" -e "s/__HTTPS_PORT__/$https_port/g" "$1" > "$2"
}
render_template "$bootstrap_template" "$bootstrap_rendered"
render_template "$https_template" "$https_rendered"

restore_nginx() {
  if [[ -s "$backup" ]]; then install -o root -g root -m 0644 "$backup" "$site_available"; else rm -f "$site_available"; fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx.service || true
}
trap restore_nginx ERR

install -o root -g root -m 0644 "$bootstrap_rendered" "$site_available"
ln -sfn "$site_available" "$site_enabled"
nginx -t
systemctl reload nginx.service

if [[ ! -x "$certbot_root/bin/certbot" ]]; then
  python3 -m venv "$certbot_root"
  "$certbot_root/bin/pip" install --upgrade pip
  "$certbot_root/bin/pip" install 'certbot>=5.4,<6'
fi
"$certbot_root/bin/certbot" certonly \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path "$webroot" \
  --ip-address "$public_ip" \
  --cert-name "$public_ip"

install -o root -g root -m 0644 "$https_rendered" "$site_available"
install -o root -g root -m 0644 "$project_dir/vps/systemd/tianxun-cert-renew.service" /etc/systemd/system/tianxun-cert-renew.service
install -o root -g root -m 0644 "$project_dir/vps/systemd/tianxun-cert-renew.timer" /etc/systemd/system/tianxun-cert-renew.timer
nginx -t
systemctl reload nginx.service
systemctl daemon-reload
systemctl enable --now tianxun-cert-renew.timer

curl --fail --silent --show-error \
  --resolve "$public_ip:$https_port:127.0.0.1" \
  "https://$public_ip:$https_port/api/health/live" >/dev/null
trap - ERR
rm -f "$backup" "$bootstrap_rendered" "$https_rendered"
echo "Tianxun HTTPS is available at https://$public_ip:$https_port/"
