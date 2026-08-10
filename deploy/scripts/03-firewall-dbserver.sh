#!/usr/bin/env bash
# Firewall for the database server (187.77.130.157).
#
#   sudo bash 03-firewall-dbserver.sh
#
# ============================================================================
# ⚠ THIS HOST ALSO RUNS YOUR WAZUH SIEM (manager, indexer, dashboard).
#
# Observed listening state on 2026-08-06:
#     52023  Redis      (127.0.0.1 and 187.77.130.157)
#     22223  sshd
#       443  wazuh-dashboard
#      1514  wazuh-manager  (agent event ingest)
#      1515  wazuh-manager  (agent enrollment)
#     55000  wazuh-manager  (REST API)
#      9200  wazuh-indexer  (127.0.0.1 only)
#      9300  wazuh-indexer  (127.0.0.1 only)
#
# Every one of those is explicitly allowed below. If you enable ufw without
# them, agents stop reporting and you lose security telemetry silently — the
# dashboard keeps loading, it just shows nothing new.
#
# There is NO Docker on this host, so ufw alone is sufficient here (unlike
# Dev 01 and Dev 02).
#
# The MAIN purpose of this script: Redis on 52023 is currently reachable from
# the entire internet with only a password. That is the single largest exposure
# in the current setup.
# ============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run as root (use sudo)." >&2
  exit 1
fi

SSH_PORT=22223
DEV01_IP=76.13.216.164
DEV02_IP=76.13.216.171

echo "==> [1/2] recording current listeners for comparison"
ss -tulnp | grep -i listen | tee /root/pre-ufw-listeners.txt
echo "    saved to /root/pre-ufw-listeners.txt"

echo "==> [2/2] ufw rules"

# Allow SSH FIRST — enabling default-deny before this drops this session.
ufw allow "${SSH_PORT}/tcp" comment 'SSH'

ufw default deny incoming
ufw default allow outgoing

# --- Redis: the whole point of this script -----------------------------------
# Only the two application servers may connect. Redis holds sessions, OTP
# state, socket routing and the media scan queue — a public port here is a
# direct path to hijacking live user sessions.
ufw allow from "${DEV01_IP}" to any port 52023 proto tcp comment 'Redis <- dev01'
ufw allow from "${DEV02_IP}" to any port 52023 proto tcp comment 'Redis <- dev02'

# --- Wazuh: preserve existing behaviour --------------------------------------
# Agents connect from arbitrary addresses, so 1514/1515 stay open.
ufw allow 1514 comment 'Wazuh agent events'
ufw allow 1515/tcp comment 'Wazuh agent enrollment'

# Dashboard and REST API. Consider narrowing these to your office/VPN egress:
#   ufw allow from <your-ip> to any port 443 proto tcp
ufw allow 443/tcp   comment 'Wazuh dashboard'
ufw allow 55000/tcp comment 'Wazuh API'

# 9200/9300 (indexer) are bound to 127.0.0.1 and deliberately get no rule.

ufw --force enable

echo
ufw status verbose
echo
echo "Database server firewall configured."
echo
echo "VERIFY:"
echo "  # From an outside machine — MUST time out:"
echo "  nc -vz 187.77.130.157 52023"
echo "  # From Dev 01 and Dev 02 — MUST connect:"
echo "  redis-cli -h 187.77.130.157 -p 52023 -a '<password>' --no-auth-warning ping"
echo "  # Confirm Wazuh still healthy:"
echo "  systemctl status wazuh-manager wazuh-indexer wazuh-dashboard --no-pager"
echo "  /var/ossec/bin/agent_control -l"
