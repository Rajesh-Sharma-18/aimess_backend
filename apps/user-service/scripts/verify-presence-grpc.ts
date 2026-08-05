/**
 * Wire test for the hand-written FilterVisiblePresence RPC.
 *
 * The server and the api-gateway client both load user.proto with
 * `keepCase: false`, so `viewer_id`/`peer_ids`/`visible_peer_ids` must surface
 * as `viewerId`/`peerIds`/`visiblePeerIds`. If that mapping is wrong the
 * handler silently sees an empty peer list and returns `[]` — which reads as
 * "hide everyone's presence" rather than as an error. Only a real round trip
 * catches it.
 *
 * Boots the real gRPC server in-process on a throwaway port and calls it with a
 * real client. Read-only: it queries privacy_settings/friendships for ids that
 * do not exist, so nothing is written.
 *
 *   npx tsx scripts/verify-presence-grpc.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { startUserGrpcServer } from "../src/grpc/server.js";
import { prisma } from "../src/config/prisma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../packages/grpc-contracts/proto/user.proto"
);

// Non-existent users: no privacy_settings row → the schema default (FRIENDS)
// applies, so a stranger must NOT see them.
const VIEWER = "00000000-0000-4000-8000-0000000000a1";
const PEERS = [
  "00000000-0000-4000-8000-0000000000e1",
  "00000000-0000-4000-8000-0000000000f1",
];

async function main() {
  const server = startUserGrpcServer();
  // Give bindAsync a moment to finish before dialing.
  await new Promise((r) => setTimeout(r, 1500));

  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const Ctor = (proto["user"] as grpc.GrpcObject)[
    "UserService"
  ] as grpc.ServiceClientConstructor;

  const port = process.env.USER_GRPC_PORT ?? "4002";
  const client = new Ctor(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure()
  );

  const meta = new grpc.Metadata();
  const token = process.env.GRPC_SERVICE_TOKEN;
  if (token) meta.set("x-aimess-service-token", token);

  const res = await new Promise<{ visiblePeerIds?: string[] }>(
    (resolve, reject) => {
      client.FilterVisiblePresence(
        { viewerId: VIEWER, peerIds: PEERS },
        meta,
        (err: grpc.ServiceError | null, r: { visiblePeerIds?: string[] }) =>
          err ? reject(err) : resolve(r)
      );
    }
  );

  const checks: [string, boolean, string][] = [
    [
      "RPC exists and responds (proto + handler registered)",
      res !== null && typeof res === "object",
      JSON.stringify(res),
    ],
    [
      "response field maps to camelCase visiblePeerIds",
      Array.isArray(res.visiblePeerIds),
      `got ${typeof res.visiblePeerIds}`,
    ],
    [
      "non-friend peers with no settings row are HIDDEN (defaults to FRIENDS)",
      res.visiblePeerIds?.length === 0,
      `visible: ${JSON.stringify(res.visiblePeerIds)}`,
    ],
  ];

  // If viewer_id/peer_ids failed to map, the handler would short-circuit on the
  // empty-peerIds guard — indistinguishable from the check above. Prove the
  // request really arrived by asking for the viewer's OWN presence, which
  // scopeAdmits always admits via isSelf.
  const selfRes = await new Promise<{ visiblePeerIds?: string[] }>(
    (resolve, reject) => {
      client.FilterVisiblePresence(
        { viewerId: VIEWER, peerIds: [VIEWER] },
        meta,
        (err: grpc.ServiceError | null, r: { visiblePeerIds?: string[] }) =>
          err ? reject(err) : resolve(r)
      );
    }
  );
  checks.push([
    "request fields arrived (self-presence echoes back → viewerId/peerIds mapped)",
    selfRes.visiblePeerIds?.length === 1 &&
      selfRes.visiblePeerIds[0] === VIEWER,
    `visible: ${JSON.stringify(selfRes.visiblePeerIds)}`,
  ]);

  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exitCode = failed > 0 ? 1 : 0;

  client.close();
  server.forceShutdown();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  void prisma.$disconnect();
});
