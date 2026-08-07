#!/usr/bin/env bash
# Initiate the single-node replica set rs0, idempotently.
#
# Run once by the `mongo-init` compose service. Safe to re-run: if the set is
# already initiated it reports the current state and exits 0.
#
# The member host is the LAN IP on purpose. MongoDB drivers ask the node for the
# replica set topology and then connect to whatever host the set advertises. If
# the set advertises "localhost:27017", a client on Dev 02 resolves that to its
# own loopback and every operation fails with a server-selection timeout.
set -euo pipefail

HOST="${LAN_IP:?LAN_IP must be set}"
USER="${MONGO_ROOT_USERNAME:?MONGO_ROOT_USERNAME must be set}"
PASS="${MONGO_ROOT_PASSWORD:?MONGO_ROOT_PASSWORD must be set}"

# mongo-init starts as soon as mongodb reports healthy, but the node may still
# be a few hundred ms away from accepting authenticated commands.
for i in $(seq 1 30); do
  if mongosh --quiet --host mongodb --username "$USER" --password "$PASS" \
       --authenticationDatabase admin --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1; then
    break
  fi
  echo "waiting for mongod to accept auth ($i/30)..."
  sleep 2
done

mongosh --quiet --host mongodb --username "$USER" --password "$PASS" \
  --authenticationDatabase admin <<EOF
try {
  const s = rs.status();
  print("replica set already initiated: " + s.set + " (state: " + s.myState + ")");
} catch (e) {
  // NotYetInitialized (94) is the only error we want to act on. Anything else
  // is a real failure and should surface rather than be papered over.
  if (e.code !== 94 && !/no replset config/i.test(e.message)) { throw e; }
  print("initiating replica set rs0 with member ${HOST}:27017");
  rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "${HOST}:27017" }] });
}
EOF

# ---------------------------------------------------------------------------
# Confirm the node actually reached PRIMARY. Initiating is not enough: mongod
# runs an "isSelf" check against the member host, which for ${HOST} means
# connecting out to the host's public IP and back into this container (hairpin
# NAT). That normally works under Docker, but if it does not, the node stays in
# STARTUP/REMOVED forever — rs.initiate() still returned ok, so without this
# check the stack would come up looking healthy while every Prisma write failed
# with "Transactions are not supported by this deployment".
# ---------------------------------------------------------------------------
for i in $(seq 1 30); do
  state=$(mongosh --quiet --host mongodb --username "$USER" --password "$PASS" \
    --authenticationDatabase admin --eval 'try { rs.status().myState } catch (e) { -1 }' 2>/dev/null || echo -1)
  if [ "$state" = "1" ]; then
    echo "node is PRIMARY — replica set ready."
    exit 0
  fi
  echo "waiting for PRIMARY (myState=$state, $i/30)..."
  sleep 2
done

cat >&2 <<EOM

ERROR: the replica set was initiated but never elected a PRIMARY.

Almost always this is the isSelf check failing: mongod cannot reach itself at
${HOST}:27017 from inside the container, because hairpin NAT back through the
published port is not working on this host.

FIX — re-initiate using localhost, which mongod always recognises as itself:

  docker exec -it aimess-mongodb mongosh -u "\$MONGO_ROOT_USERNAME" \\
    -p "\$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --eval \\
    'rs.reconfig({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]},{force:true})'

This is safe here ONLY because every service connects with
directConnection=true (see apps/*/src/config/env.ts), so no client relies on
the advertised topology. If you ever drop directConnection from a connection
string, this must be changed back to ${HOST}:27017 and the hairpin issue fixed.

EOM
exit 1
