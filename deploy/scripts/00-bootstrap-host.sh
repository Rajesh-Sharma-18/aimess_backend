#!/usr/bin/env bash
# Prepare a bare Ubuntu 24.04 host: Docker, nginx, certbot, directories.
#
#   sudo bash 00-bootstrap-host.sh dev01     # 76.13.216.164
#   sudo bash 00-bootstrap-host.sh dev02     # 76.13.216.171
#
# Idempotent — safe to re-run.
#
# Verified starting state (2026-08-06): both app servers had ONLY sshd running.
# No Docker, Node, nginx, or certbot. Everything below is a fresh install.
set -euo pipefail

ROLE="${1:-}"
if [ "$ROLE" != "dev01" ] && [ "$ROLE" != "dev02" ]; then
  echo "usage: sudo bash 00-bootstrap-host.sh <dev01|dev02>" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run as root (use sudo)." >&2
  exit 1
fi

DEPLOY_USER="${SUDO_USER:-rajvasu}"

echo "==> [1/7] apt update + base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg lsb-release \
  nginx certbot python3-certbot-nginx \
  gettext-base jq \
  iptables-persistent netfilter-persistent

echo "==> [2/7] Docker Engine + Compose plugin (official repo)"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "    docker already installed: $(docker --version)"
fi

systemctl enable --now docker

echo "==> [3/7] allow ${DEPLOY_USER} to run docker without sudo"
usermod -aG docker "$DEPLOY_USER"
echo "    NOTE: ${DEPLOY_USER} must log out and back in for this to take effect."

echo "==> [4/7] cap Docker's global log size"
# Without this a chatty container fills the disk with JSON logs and takes the
# whole host down. The per-service logging block in compose covers our own
# services; this catches everything else.
if [ ! -f /etc/docker/daemon.json ]; then
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
JSON
  systemctl restart docker
else
  echo "    /etc/docker/daemon.json already exists — left untouched."
fi

echo "==> [5/7] directories"
mkdir -p /opt/aimess /var/www/certbot
chown -R "$DEPLOY_USER":"$DEPLOY_USER" /opt/aimess
chown -R www-data:www-data /var/www/certbot

echo "==> [6/7] nginx snippets"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 0644 "$SCRIPT_DIR/../nginx/snippets/proxy-common.conf" \
  /etc/nginx/snippets/aimess-proxy-common.conf
install -m 0644 "$SCRIPT_DIR/../nginx/snippets/security-headers.conf" \
  /etc/nginx/snippets/aimess-security-headers.conf
bash "$SCRIPT_DIR/refresh-cloudflare-ips.sh" || {
  echo "WARNING: could not fetch Cloudflare ranges; writing a passthrough stub." >&2
  echo "# stub — run refresh-cloudflare-ips.sh once the host has outbound access." \
    > /etc/nginx/snippets/aimess-cloudflare-realip.conf
}

if [ "$ROLE" = "dev01" ]; then
  echo "==> [7/7] MongoDB replica-set keyfile"
  # replSet + auth requires a shared internal-auth keyfile. mongod REFUSES to
  # start if it is group- or world-readable, and the mongo image runs as uid 999.
  KEYFILE=/opt/aimess/mongo-keyfile
  if [ -f "$KEYFILE" ]; then
    echo "    keyfile already exists — left untouched (regenerating would break"
    echo "    an initialised replica set)."
  else
    openssl rand -base64 756 > "$KEYFILE"
    chmod 400 "$KEYFILE"
    chown 999:999 "$KEYFILE"
    echo "    created $KEYFILE (mode 400, owner 999:999)"
  fi
else
  echo "==> [7/7] no dev01-specific steps for this role"
fi

echo
echo "Bootstrap complete for ${ROLE}."
echo "Next:"
echo "  1. Run the firewall script for this host (0{1,2}-firewall-*.sh)."
echo "  2. Log out and back in so the docker group applies to ${DEPLOY_USER}."
echo "  3. Follow deploy/README.md from step 3."
