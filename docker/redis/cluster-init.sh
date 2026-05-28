#!/bin/sh
# Redis Cluster formation script — runs once at startup via docker compose.
# Uses the internal Docker network (container names) to CLUSTER MEET the nodes,
# then assigns the full 0-16383 slot range across the three primaries.
set -e

PORT=6379
NODES="redis-node-1 redis-node-2 redis-node-3"

echo "==> Waiting for Redis cluster nodes to be ready..."
for NODE in $NODES; do
  until redis-cli -h "$NODE" -p $PORT ping 2>/dev/null | grep -q PONG; do
    echo "    Waiting for $NODE:$PORT ..."
    sleep 1
  done
  echo "    $NODE is ready"
done

# Skip init if the cluster is already formed
CLUSTER_STATE=$(redis-cli -h redis-node-1 -p $PORT CLUSTER INFO 2>/dev/null \
  | grep cluster_state \
  | awk -F: '{print $2}' \
  | tr -d '[:space:]\r')
if [ "$CLUSTER_STATE" = "ok" ]; then
  echo "==> Cluster already in state 'ok' — skipping init"
  exit 0
fi

echo "==> Resolving internal node IPs..."
NODE1_IP=$(getent hosts redis-node-1 | awk '{print $1}')
NODE2_IP=$(getent hosts redis-node-2 | awk '{print $1}')
NODE3_IP=$(getent hosts redis-node-3 | awk '{print $1}')
echo "    redis-node-1 -> $NODE1_IP"
echo "    redis-node-2 -> $NODE2_IP"
echo "    redis-node-3 -> $NODE3_IP"

echo "==> Creating Redis Cluster (3 primaries, no replicas)..."
redis-cli --cluster create \
  "$NODE1_IP:$PORT" \
  "$NODE2_IP:$PORT" \
  "$NODE3_IP:$PORT" \
  --cluster-replicas 0 \
  --cluster-yes

echo "==> Cluster initialised successfully"
redis-cli -h redis-node-1 -p $PORT CLUSTER INFO
