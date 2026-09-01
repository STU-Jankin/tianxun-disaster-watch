#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash vps/osm-jiangsu/refresh.sh [--force]" >&2
  exit 1
fi

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
data_root="/var/lib/tianxun/osm-jiangsu"
index_path="$data_root/jiangsu.sqlite"
force="${1:-}"
state_url="https://download.geofabrik.de/asia/china/jiangsu-updates/state.txt"
gpkg_url="https://download.geofabrik.de/asia/china/jiangsu-latest-free.gpkg.zip"
poly_url="https://download.geofabrik.de/asia/china/jiangsu.poly"

for required in curl unzip sqlite3 /usr/bin/node; do
  if [[ "$required" == /* ]]; then [[ -x "$required" ]] || { echo "Missing required executable: $required" >&2; exit 1; }
  else command -v "$required" >/dev/null 2>&1 || { echo "Missing required command: $required" >&2; exit 1; }
  fi
done

install -d -o tianxun-osm -g tianxun-osm -m 0750 "$data_root"
staging="$(mktemp -d "$data_root/staging.XXXXXX")"
case "$staging" in "$data_root"/staging.*) ;; *) echo "Unsafe staging path: $staging" >&2; exit 1 ;; esac
cleanup() {
  case "${staging:-}" in "$data_root"/staging.*) rm -rf -- "$staging" ;; esac
}
trap cleanup EXIT

curl --fail --silent --show-error --location --retry 3 "$state_url" -o "$staging/state.txt"
source_timestamp="$(sed -n 's/^timestamp=//p' "$staging/state.txt" | tail -n1 | sed 's/\\:/\:/g')"
[[ -n "$source_timestamp" && "$source_timestamp" == *T* ]] || { echo "Geofabrik state timestamp is missing." >&2; exit 1; }
current_timestamp=""
if [[ -f "$index_path" ]]; then current_timestamp="$(sqlite3 "$index_path" "SELECT value FROM metadata WHERE key='source_timestamp';" 2>/dev/null || true)"; fi
if [[ "$force" != "--force" && -n "$current_timestamp" && "$(date -u -d "$source_timestamp" +%s)" -le "$(date -u -d "$current_timestamp" +%s)" ]]; then
  echo "Jiangsu OSM index is already current at $current_timestamp"
  exit 0
fi

curl --fail --silent --show-error --location --retry 3 "$gpkg_url" -o "$staging/jiangsu.gpkg.zip"
curl --fail --silent --show-error --location --retry 3 "$poly_url" -o "$staging/jiangsu.poly"
unzip -q "$staging/jiangsu.gpkg.zip" -d "$staging/gpkg"
gpkg_path="$(find "$staging/gpkg" -maxdepth 2 -type f -name '*.gpkg' -print -quit)"
[[ -n "$gpkg_path" && -f "$gpkg_path" ]] || { echo "The Jiangsu GeoPackage archive did not contain a .gpkg file." >&2; exit 1; }

/usr/bin/node "$project_dir/vps/osm-jiangsu/build-index.mjs" \
  --gpkg "$gpkg_path" \
  --poly "$staging/jiangsu.poly" \
  --out "$staging/jiangsu.sqlite" \
  --source-timestamp "$source_timestamp" \
  --grid-size 0.01 >/dev/null
validation_output="$(sqlite3 "$staging/jiangsu.sqlite" "PRAGMA quick_check; SELECT value FROM metadata WHERE key='source_timestamp';")"
[[ "$(printf '%s\n' "$validation_output" | sed -n '1p')" == "ok" ]] || { echo "Jiangsu OSM index integrity check failed." >&2; exit 1; }
validation_timestamp="$(printf '%s\n' "$validation_output" | sed -n '2p')"
[[ -n "$validation_timestamp" && "$(date -u -d "$validation_timestamp" +%s)" == "$(date -u -d "$source_timestamp" +%s)" ]] || { echo "Jiangsu OSM source timestamp validation failed." >&2; exit 1; }
chown tianxun-osm:tianxun-osm "$staging/jiangsu.sqlite"
chmod 0640 "$staging/jiangsu.sqlite"

previous="$data_root/jiangsu.sqlite.previous"
if [[ -f "$index_path" ]]; then mv -f -- "$index_path" "$previous"; fi
mv -f -- "$staging/jiangsu.sqlite" "$index_path"
if ! systemctl try-restart tianxun-osm-jiangsu.service; then
  if [[ -f "$previous" ]]; then mv -f -- "$previous" "$index_path"; systemctl restart tianxun-osm-jiangsu.service || true; fi
  echo "Jiangsu OSM service restart failed; the previous index was restored." >&2
  exit 1
fi
rm -f -- "$previous"
echo "Jiangsu OSM index updated to $(date -u -d "$source_timestamp" --iso-8601=seconds)"
