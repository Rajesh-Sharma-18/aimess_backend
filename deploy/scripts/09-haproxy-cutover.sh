#!/usr/bin/env bash
# Replace nginx with HAProxy as the edge proxy.
#
#   sudo bash 09-haproxy-cutover.sh dev01
#   sudo bash 09-haproxy-cutover.sh dev02
#
# TLS still terminates here, reusing the existing Let's Encrypt certificates —
# Cloudflare stays Full (strict), so nothing has to change on the Cloudflare
# side and the origin leg stays encrypted. Cloudflare continues to hide the
# origin IP exactly as before.
#
# The swap itself is a few seconds of downtime: nginx cannot hand over :80/:443
# while it is still bound. Every backend is checked BEFORE that happens, and if
# the post-swap verification fails the script puts nginx back automatically.
set -euo pipefail

ROLE="${1:-}"
case "$ROLE" in
  dev01) DOMAINS=(ai5dev.tech www.ai5dev.tech minio.ai5dev.tech auth.ai5dev.tech rabbitmq.ai5dev.tech)
         BACKENDS=(3000 9000 9001 15672)
         # Retired with the move to the apex: no longer served, so its
         # certificate is deliberately left out of HAProxy's bundle.
         SKIP_CERTS=(website.ai5dev.tech)
         ;;
  dev02) DOMAINS=(api.ai5dev.tech admin.ai5dev.tech backoffice.ai5dev.tech)
         BACKENDS=(3000 3010 3011)
         SKIP_CERTS=()
         ;;
  *) echo "usage: sudo bash 09-haproxy-cutover.sh <dev01|dev02>" >&2; exit 1 ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "ERROR: must run as root (use sudo)." >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAP_SRC="$SCRIPT_DIR/../haproxy"
STAMP="$(date +%F-%H%M%S)"

echo "==> [1/8] pre-flight — are the backends actually up?"
fail=0
for p in "${BACKENDS[@]}"; do
  if ss -lnt "sport = :$p" 2>/dev/null | grep -q ":$p"; then
    echo "    ok   127.0.0.1:$p"
  else
    echo "    MISSING  nothing listening on :$p"
    fail=1
  fi
done
[ "$fail" -eq 0 ] || { echo "Refusing to cut over — start the missing services first." >&2; exit 1; }

echo "==> [2/8] pre-flight — certificates"
for d in "${DOMAINS[@]}"; do
  # www is a SAN on the apex certificate, not a directory of its own.
  [ "$d" = "www.ai5dev.tech" ] && continue
  if [ -f "/etc/letsencrypt/live/$d/fullchain.pem" ]; then
    echo "    ok   $d"
  else
    echo "    MISSING  /etc/letsencrypt/live/$d/fullchain.pem"
    fail=1
  fi
done
[ "$fail" -eq 0 ] || { echo "Refusing to cut over — issue the certificates first (05-issue-certs.sh)." >&2; exit 1; }

echo "==> [3/8] installing haproxy"
if ! command -v haproxy >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq haproxy
fi
haproxy -v | head -1 | sed 's/^/    /'

echo "==> [4/8] config + certificate bundles"
install -d -m 755 /etc/haproxy
[ -f /etc/haproxy/haproxy.cfg ] && cp -a /etc/haproxy/haproxy.cfg "/etc/haproxy/haproxy.cfg.bak-$STAMP"
install -m 0644 "$HAP_SRC/$ROLE.cfg" /etc/haproxy/haproxy.cfg
bash "$HAP_SRC/bundle-certs.sh" "${SKIP_CERTS[@]:-}"

echo "==> [5/8] validating config"
haproxy -c -f /etc/haproxy/haproxy.cfg
echo "    config OK"

echo "==> [6/8] switching certbot renewal to standalone:8888"
# nginx served /.well-known from a webroot. With nginx gone nothing does, so
# renewal moves to certbot's own listener on 8888, which HAProxy forwards to.
# Leaving this on webroot renews fine today and fails silently in 60 days.
cp -a /etc/letsencrypt/renewal "/etc/letsencrypt/renewal.bak-$STAMP"
for conf in /etc/letsencrypt/renewal/*.conf; do
  [ -f "$conf" ] || continue
  sed -i \
    -e 's/^authenticator = webroot/authenticator = standalone/' \
    -e '/^webroot_path *=/d' \
    -e '/^\[\[webroot_map\]\]/d' \
    -e '/^ai5dev\.tech *=/d' \
    -e '/^[a-z0-9.-]* = \/var\/www\/certbot$/d' \
    "$conf"
  grep -q '^http01_port' "$conf" || sed -i '/^authenticator = standalone/a http01_port = 8888' "$conf"
done
echo "    renewal configs updated (backup: /etc/letsencrypt/renewal.bak-$STAMP)"

echo "==> [7/8] cutover"
systemctl stop nginx
systemctl disable nginx >/dev/null 2>&1 || true
systemctl enable haproxy >/dev/null 2>&1 || true
if systemctl restart haproxy; then
  echo "    haproxy started"
else
  echo "    haproxy FAILED to start — rolling back to nginx" >&2
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl start nginx
  exit 1
fi

echo "==> [8/8] verifying every domain through haproxy"
sleep 2
bad=0
for d in "${DOMAINS[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 --resolve "$d:443:127.0.0.1" "https://$d/" || echo 000)
  case "$code" in
    200|301|302|401|403|404) echo "    ok   $d -> $code" ;;
    *)                       echo "    BAD  $d -> $code"; bad=1 ;;
  esac
done

if [ "$bad" -ne 0 ]; then
  echo
  echo "Verification FAILED — restoring nginx." >&2
  systemctl stop haproxy
  systemctl disable haproxy >/dev/null 2>&1 || true
  cp -a "/etc/letsencrypt/renewal.bak-$STAMP/." /etc/letsencrypt/renewal/
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl start nginx
  echo "nginx is back. Nothing else was changed." >&2
  exit 1
fi

# Renewal must refresh HAProxy's bundles, not just certbot's directory.
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/haproxy-bundle.sh <<EOF
#!/bin/sh
# Regenerate /etc/haproxy/certs/ after a renewal and reload HAProxy.
exec bash $HAP_SRC/bundle-certs.sh ${SKIP_CERTS[*]:-}
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/haproxy-bundle.sh
rm -f /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo
echo "Done. HAProxy is serving ${#DOMAINS[@]} domain(s) on $ROLE."
echo
echo "Check renewal still works end to end:"
echo "  sudo certbot renew --dry-run"
echo
echo "Roll back to nginx:"
echo "  sudo systemctl stop haproxy && sudo systemctl disable haproxy"
echo "  sudo cp -a /etc/letsencrypt/renewal.bak-$STAMP/. /etc/letsencrypt/renewal/"
echo "  sudo systemctl enable nginx && sudo systemctl start nginx"
