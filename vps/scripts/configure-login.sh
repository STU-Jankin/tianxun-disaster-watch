#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash vps/scripts/configure-login.sh" >&2
  exit 1
fi

engine_env="/etc/tianxun/engine.env"
hash_script="/opt/tianxun/current/vps/scripts/hash-password.mjs"
[[ -f "$engine_env" && -f "$hash_script" ]] || { echo "Install Tianxun before configuring login." >&2; exit 1; }

read -r -p "Login username [admin]: " login_username
login_username="${login_username:-admin}"
[[ "$login_username" =~ ^[A-Za-z0-9@._-]{3,120}$ ]] || { echo "Username may contain only letters, numbers, @ . _ - (3-120 characters)." >&2; exit 1; }
read -r -s -p "New password (12-128 characters): " login_password
echo
read -r -s -p "Repeat password: " login_password_repeat
echo
[[ "$login_password" == "$login_password_repeat" ]] || { echo "Passwords do not match." >&2; exit 1; }
login_hash="$(printf '%s' "$login_password" | /usr/bin/node "$hash_script")"
unset login_password login_password_repeat

set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$engine_env"; then
    sed -i -E "s|^${key}=.*$|${key}=${value}|" "$engine_env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$engine_env"
  fi
}

set_env_value TIANXUN_LOGIN_USERNAME "$login_username"
set_env_value TIANXUN_LOGIN_PASSWORD_HASH "$login_hash"
set_env_value TIANXUN_LOGIN_ROLE admin
chown root:tianxun-engine "$engine_env"
chmod 0640 "$engine_env"
systemctl restart tianxun-engine.service
echo "Tianxun login configured. Existing browser sessions are invalidated when the username or role changes."
