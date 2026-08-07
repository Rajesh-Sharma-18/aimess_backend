#!/usr/bin/env bash
# Enable AOF persistence on the existing Redis (187.77.130.157:52023).
#
#   sudo bash 04-redis-enable-aof.sh
#
# ============================================================================
# WHY
#
# Verified config on 2026-08-06:
#     redis_version    7.0.15          ✓
#     maxmemory        0 (unlimited)   ✓
#     maxmemory-policy noeviction      ✓  REQUIRED — Bull/BullMQ silently lose
#                                          jobs under any eviction policy
#     cluster_enabled  0               ✓  chat-service supports single-node
#     appendonly       no              ✗  ← this script fixes this
#     save             3600 1 300 100 60 10000
#
# With RDB snapshots alone, up to 60 seconds of writes are lost on an unclean
# shutdown. For this workload that means queued media-scan jobs disappearing,
# and users being logged out or losing pending OTP verifications.
#
# AOF with everysec fsync bounds worst-case loss to ~1 second at a small write
# cost. RDB stays enabled as well — the two are complementary, not alternatives.
#
# CONFIG REWRITE is used rather than editing redis.conf by hand so the change
# takes effect immediately AND survives restart, with no downtime.
# ============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run as root (use sudo)." >&2
  exit 1
fi

read -r -s -p "Redis password: " REDIS_PASSWORD
echo

R=(redis-cli -h 127.0.0.1 -p 52023 -a "$REDIS_PASSWORD" --no-auth-warning)

echo "==> [1/5] connectivity"
if [ "$("${R[@]}" ping 2>/dev/null)" != "PONG" ]; then
  echo "ERROR: cannot authenticate to Redis on 127.0.0.1:52023." >&2
  exit 1
fi
echo "    PONG"

echo "==> [2/5] current state"
"${R[@]}" config get appendonly
"${R[@]}" config get maxmemory-policy
"${R[@]}" info persistence | grep -E 'aof_enabled|rdb_last_bgsave_status'

echo "==> [3/5] re-asserting maxmemory-policy=noeviction"
# Belt and braces: if this is ever changed to an eviction policy, Bull job keys
# get evicted under memory pressure and scans vanish with no error anywhere.
"${R[@]}" config set maxmemory-policy noeviction

echo "==> [4/5] enabling AOF"
"${R[@]}" config set appendfsync everysec
"${R[@]}" config set appendonly yes

# The initial rewrite runs in the background; wait for it rather than reporting
# success while the AOF is still being built.
echo -n "    waiting for initial AOF rewrite"
for _ in $(seq 1 60); do
  if [ "$("${R[@]}" info persistence | grep -c 'aof_rewrite_in_progress:0')" -eq 1 ]; then
    echo " — done"
    break
  fi
  echo -n "."
  sleep 1
done

echo "==> [5/5] persisting to /etc/redis/redis.conf"
# Without CONFIG REWRITE the change is lost on the next restart, which is the
# worst outcome: it looks configured until the day it matters.
"${R[@]}" config rewrite
echo "    written."

echo
echo "--- final state ---"
"${R[@]}" config get appendonly
"${R[@]}" config get appendfsync
"${R[@]}" config get maxmemory-policy
"${R[@]}" info persistence | grep -E 'aof_enabled|aof_last_write_status|aof_last_bgrewrite_status'

echo
echo "AOF enabled. Redis needs no restart."
echo
echo "NOTE: this Redis is shared with the Wazuh box's other workloads and has"
echo "16 logical databases, of which only db0 was in use (4 keys) at audit time."
echo "All AIMESS services use db0 by default."
