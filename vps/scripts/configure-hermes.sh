#!/usr/bin/env bash
set -euo pipefail

if ! command -v hermes >/dev/null 2>&1; then
  echo "Hermes CLI is not installed or not on PATH." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this script as the ordinary Linux user that owns the Hermes profile, not with sudo." >&2
  exit 1
fi

secret="${1:-}"
if [[ -z "$secret" ]]; then
  secret="$(openssl rand -hex 32)"
fi

if ! curl --fail --silent --show-error http://127.0.0.1:8644/health >/dev/null; then
  echo "Hermes webhook adapter is not healthy on 127.0.0.1:8644." >&2
  echo "Run 'hermes gateway setup', enable Webhooks, then restart the gateway." >&2
  exit 1
fi

if command -v ss >/dev/null 2>&1; then
  listeners="$(ss -H -ltn 'sport = :8644' || true)"
  if grep -Eq '0\.0\.0\.0:8644|\*:8644|\[::\]:8644' <<<"$listeners"; then
    echo "Port 8644 is listening beyond loopback. Set platforms.webhook.extra.host to 127.0.0.1 and restart Hermes." >&2
    exit 1
  fi
fi

if hermes webhook list 2>/dev/null | grep -Fq "tianxun-alerts"; then
  echo "Hermes route tianxun-alerts already exists; it was not overwritten."
  echo "Use its existing secret in /etc/tianxun/notifier.env."
  exit 0
fi

hermes webhook subscribe tianxun-alerts \
  --deliver feishu \
  --deliver-only \
  --prompt "{message}" \
  --description "Tianxun verified disaster and system alerts" \
  --secret "$secret"

echo
echo "Route created. Put this value in /etc/tianxun/notifier.env:"
echo "HERMES_WEBHOOK_SECRET=$secret"
echo "The route listens only through the Hermes gateway; keep port 8644 firewalled from the Internet."
