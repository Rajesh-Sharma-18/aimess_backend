#!/usr/bin/env bash
# ============================================================================
# One-time, per host. Caps Docker's BuildKit cache so it can never grow
# without bound, and caps the journal so logs cannot fill the disk either.
#
#   sudo bash deploy/scripts/10-docker-gc-setup.sh [cap-gb]
#
# WHY THIS EXISTS
# ---------------
# Every service Dockerfile runs an UNFILTERED workspace install — the build
# log shows "Scope: all 23 workspace projects" / "Packages: +993" even for a
# service that needs a fraction of them. Each builder stage is therefore
# ~3-4 GB, and because the RUN command differs per service, BuildKit stores a
# SEPARATE copy for each of the nine. One pass of a full rebuild can leave
# ~30 GB of cache behind, and nothing ever removed it. On 2026-08-24 that
# filled the disk completely: builds died with ENOSPC and Docker could not
# even write its own activity timestamp file.
#
# deploy.sh reclaims opportunistically, but a daemon-level cap is what makes
# the problem structurally impossible rather than merely unlikely.
#
# Safe to re-run. Does not touch images, containers or volumes.
# ============================================================================
set -euo pipefail

CAP_GB="${1:-20}"
DAEMON_JSON=/etc/docker/daemon.json

[ "$(id -u)" = "0" ] || { echo "ERROR: run with sudo" >&2; exit 1; }

echo "==> capping BuildKit cache at ${CAP_GB}GB in $DAEMON_JSON"

mkdir -p /etc/docker

if [ -f "$DAEMON_JSON" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  cp -a "$DAEMON_JSON" "${DAEMON_JSON}.bak-${STAMP}"
  echo "    existing config backed up to ${DAEMON_JSON}.bak-${STAMP}"

  # Merge rather than overwrite — this file may already carry log-driver,
  # registry-mirror or storage-driver settings that must be preserved.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$DAEMON_JSON" "$CAP_GB" <<'PY'
import json, sys
path, cap = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        cfg = json.load(f)
except (ValueError, FileNotFoundError):
    cfg = {}
cfg.setdefault("builder", {})["gc"] = {
    "enabled": True,
    "defaultKeepStorage": f"{cap}GB",
}
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY
  else
    echo "ERROR: python3 not found and $DAEMON_JSON already exists." >&2
    echo "       Refusing to overwrite it blindly. Add this block by hand:" >&2
    echo '       "builder": { "gc": { "enabled": true, "defaultKeepStorage": "'"${CAP_GB}"'GB" } }' >&2
    exit 1
  fi
else
  cat > "$DAEMON_JSON" <<EOF
{
  "builder": {
    "gc": {
      "enabled": true,
      "defaultKeepStorage": "${CAP_GB}GB"
    }
  }
}
EOF
fi

echo "    $DAEMON_JSON now:"
sed 's/^/      /' "$DAEMON_JSON"

# A reload is enough for builder GC; it does not restart containers.
echo "==> reloading docker"
systemctl reload docker || systemctl restart docker

echo "==> capping the systemd journal at 500M"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/99-size-cap.conf <<'EOF'
[Journal]
SystemMaxUse=500M
EOF
systemctl restart systemd-journald
journalctl --vacuum-size=500M >/dev/null 2>&1 || true

echo
echo "==> reclaiming whatever is already stale"
docker builder prune -af >/dev/null 2>&1 || true
docker image   prune -f  >/dev/null 2>&1 || true

echo
echo "==> current state"
docker system df
df -h /
df -i /
echo
echo "Done. Build cache will now self-trim at ${CAP_GB}GB."
echo "Container logs are already capped at 20m x 5 per service by the compose"
echo "x-common logging block, so that side is covered too."
