#!/usr/bin/env bash
# Build HAProxy's certificate directory from certbot's.
#
#   sudo bash bundle-certs.sh [name-to-skip ...]
#
# HAProxy wants fullchain AND privkey concatenated into a single file per
# domain; certbot keeps them apart. This regenerates /etc/haproxy/certs/ from
# whatever certbot currently holds, then reloads HAProxy if it is running.
#
# Also installed as a certbot deploy hook, so a renewal 60 days from now
# refreshes these bundles automatically. Without that, HAProxy keeps serving
# the old certificate until someone notices it expired.
set -euo pipefail

LIVE=/etc/letsencrypt/live
DEST=/etc/haproxy/certs

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root." >&2; exit 1; }
[ -d "$LIVE" ] || { echo "ERROR: $LIVE not found — no certificates issued yet." >&2; exit 1; }

mkdir -p "$DEST"
chmod 750 "$DEST"

SKIP=("$@")

skip_this() {
  local n="$1" s
  for s in "${SKIP[@]:-}"; do [ "$n" = "$s" ] && return 0; done
  return 1
}

made=0

for dir in "$LIVE"/*/; do
  name="$(basename "$dir")"
  [ "$name" = "README" ] && continue
  [ -f "$dir/fullchain.pem" ] || continue

  if skip_this "$name"; then
    echo "  skip   $name (retired)"
    rm -f "$DEST/$name.pem"
    continue
  fi

  # Written to a temp file first: HAProxy re-reads this directory on reload and
  # a half-written PEM would take the whole frontend down.
  tmp="$DEST/.$name.pem.tmp"
  cat "$dir/fullchain.pem" "$dir/privkey.pem" > "$tmp"
  chmod 640 "$tmp"
  chown root:haproxy "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$DEST/$name.pem"
  echo "  bundle $name"
  made=$((made + 1))
done

echo "  $made certificate(s) in $DEST"

if systemctl is-active --quiet haproxy; then
  # `reload` re-execs without dropping established connections; `restart` would.
  haproxy -c -f /etc/haproxy/haproxy.cfg >/dev/null
  systemctl reload haproxy
  echo "  haproxy reloaded"
fi
