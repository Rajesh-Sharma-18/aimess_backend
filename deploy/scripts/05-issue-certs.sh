#!/usr/bin/env bash
# Obtain Let's Encrypt certificates, then enable the real nginx sites.
#
#   sudo bash 05-issue-certs.sh dev01 you@example.com
#   sudo bash 05-issue-certs.sh dev02 you@example.com
#
# ============================================================================
# ORDER MATTERS — the real site configs reference
# /etc/letsencrypt/live/<domain>/fullchain.pem, so nginx will not start until
# the certs exist; but certbot needs a live nginx on port 80 to answer the
# HTTP-01 challenge. This script breaks the cycle:
#
#   1. install ONLY the bootstrap vhost (serves the ACME challenge, nothing else)
#   2. obtain every certificate
#   3. remove the bootstrap vhost, install the real sites, reload
#
# ⚠ CLOUDFLARE: HTTP-01 validation reaches this host through Cloudflare for any
# PROXIED (orange-cloud) record. That works — Cloudflare forwards port 80 — but
# only once the record actually points at this server. If a name still points
# somewhere else, validation fails with an unhelpful "Invalid response" error.
#
# For grey-cloud names (minio, livekit — see the notes in their site configs)
# validation comes straight here, which is simpler.
#
# If any record cannot serve HTTP-01, switch to DNS-01 instead:
#   apt-get install python3-certbot-dns-cloudflare
#   certbot certonly --dns-cloudflare \
#     --dns-cloudflare-credentials /root/.secrets/cloudflare.ini -d <domain>
# ============================================================================
set -euo pipefail

ROLE="${1:-}"
EMAIL="${2:-}"

if [ -z "$EMAIL" ] || { [ "$ROLE" != "dev01" ] && [ "$ROLE" != "dev02" ]; }; then
  echo "usage: sudo bash 05-issue-certs.sh <dev01|dev02> <email>" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run as root (use sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_SRC="$SCRIPT_DIR/../nginx"

if [ "$ROLE" = "dev01" ]; then
  # minio-console is listed last because its DNS record may not exist yet — see
  # the note in dev01-minio-console.conf.
  # notification.ai5dev.tech serves LiveKit signaling (the name is reused —
  # notification-service itself is internal only). auth.ai5dev.tech serves the
  # MinIO console for the same reason.
  DOMAINS=(website.ai5dev.tech minio.ai5dev.tech rabbitmq.ai5dev.tech notification.ai5dev.tech auth.ai5dev.tech)
  SITES=(dev01-website.conf dev01-minio.conf dev01-rabbitmq.conf dev01-livekit.conf dev01-minio-console.conf)
else
  DOMAINS=(api.ai5dev.tech admin.ai5dev.tech backoffice.ai5dev.tech)
  SITES=(dev02-api.conf dev02-admin.conf dev02-backoffice.conf)
fi

echo "==> [1/5] DNS pre-flight"
MYIP=$(curl -fsS https://api.ipify.org || echo "unknown")
echo "    this host's public IP: $MYIP"
for d in "${DOMAINS[@]}"; do
  resolved=$(getent hosts "$d" | awk '{print $1}' | paste -sd, - || true)
  if [ -z "$resolved" ]; then
    echo "    ✗ $d — NO DNS RECORD (certbot will fail for this name)"
  else
    echo "    • $d -> $resolved"
  fi
done
echo
echo "    Names resolving to 104.21.x / 172.67.x are Cloudflare-proxied — that is"
echo "    expected, provided the Cloudflare origin already points at $MYIP."
echo
read -r -p "Continue? [y/N] " ok
[ "$ok" = "y" ] || { echo "aborted."; exit 1; }

echo "==> [2/5] bootstrap vhost (ACME challenge only)"
mkdir -p /var/www/certbot
rm -f /etc/nginx/sites-enabled/default
install -m 0644 "$NGINX_SRC/bootstrap-http.conf" /etc/nginx/sites-available/00-bootstrap.conf
ln -sf /etc/nginx/sites-available/00-bootstrap.conf /etc/nginx/sites-enabled/00-bootstrap.conf
# Take down any real sites from a previous run so nginx can start without certs.
for s in "${SITES[@]}"; do rm -f "/etc/nginx/sites-enabled/$s"; done
nginx -t
systemctl reload nginx || systemctl start nginx
echo "    bootstrap vhost live."

echo "==> [3/5] obtaining certificates"
FAILED=()
for d in "${DOMAINS[@]}"; do
  echo "--- $d ---"
  # One certificate per name (not one SAN cert for all) so a single failing
  # domain does not block the others — important because minio-console may not
  # have a DNS record yet.
  if certbot certonly --webroot -w /var/www/certbot \
      -d "$d" \
      --non-interactive --agree-tos -m "$EMAIL" \
      --keep-until-expiring; then
    echo "    ✓ $d"
  else
    echo "    ✗ $d — FAILED"
    FAILED+=("$d")
  fi
done

echo "==> [4/5] installing real site configs"
# The site configs include these two. certbot only drops them in when the
# --nginx installer runs; we use --webroot, so they may be absent.
#
# Written locally rather than downloaded: the upstream raw.githubusercontent
# path moves between certbot releases, and a 404 there aborts the whole script
# after the certificates have already been issued.
if [ ! -f /etc/letsencrypt/options-ssl-nginx.conf ]; then
  PKG=/usr/lib/python3/dist-packages/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf
  if [ -f "$PKG" ]; then
    cp "$PKG" /etc/letsencrypt/options-ssl-nginx.conf
    echo "    installed options-ssl-nginx.conf from the certbot package"
  else
    cat > /etc/letsencrypt/options-ssl-nginx.conf <<'SSLCONF'
# Mozilla intermediate profile. Equivalent to certbot's shipped defaults.
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;

ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;

ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-CHACHA20-POLY1305";
SSLCONF
    echo "    wrote a built-in options-ssl-nginx.conf"
  fi
fi

# 2048-bit takes ~10-30s; only ever generated once.
[ -f /etc/letsencrypt/ssl-dhparams.pem ] || \
  openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048 2>/dev/null

for i in "${!SITES[@]}"; do
  site="${SITES[$i]}"
  domain="${DOMAINS[$i]}"
  if [ ! -d "/etc/letsencrypt/live/$domain" ]; then
    echo "    skipping $site — no certificate for $domain"
    continue
  fi
  install -m 0644 "$NGINX_SRC/sites/$site" "/etc/nginx/sites-available/$site"
  ln -sf "/etc/nginx/sites-available/$site" "/etc/nginx/sites-enabled/$site"
  echo "    enabled $site"
done

# The bootstrap vhost is `default_server` on :80 and would shadow the real
# vhosts' redirect blocks, so it must go now that the sites are in place.
rm -f /etc/nginx/sites-enabled/00-bootstrap.conf

echo "==> [5/5] reload + renewal check"
nginx -t
systemctl reload nginx

# certbot's packaged systemd timer handles renewal; make sure nginx picks up
# the new cert without a manual reload.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# LiveKit's embedded TURN reads its certificate ONCE at startup — unlike nginx
# it cannot be reloaded — so a renewal leaves it serving the expired one. The
# failure is invisible: signaling and direct-UDP calls keep working, and only
# clients that need the TURN relay break, three months after anyone touched
# this. Restart is a sub-second blip and drops no established call.
# Dev 01 only; the container does not exist on Dev 02.
if [ "$ROLE" = "dev01" ]; then
  cat > /etc/letsencrypt/renewal-hooks/deploy/restart-livekit.sh <<'EOF'
#!/bin/sh
docker restart aimess-livekit 2>/dev/null || true
EOF
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/restart-livekit.sh
  echo "    installed LiveKit TURN certificate-renewal hook"
fi

systemctl list-timers 'certbot*' --no-pager || true
certbot renew --dry-run || echo "WARNING: renewal dry-run failed — investigate before the 90-day expiry."

echo
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "COMPLETED WITH FAILURES. No certificate for: ${FAILED[*]}"
  echo "Those sites are NOT enabled. Fix DNS and re-run this script."
  exit 1
fi
echo "All certificates issued and all ${ROLE} sites enabled."
