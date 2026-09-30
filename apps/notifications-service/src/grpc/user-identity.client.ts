import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/user.proto"
);

export interface UserIdentityClient {
  /**
   * The user's CURRENT display name ("Firstname Lastname") straight from
   * user-service — the same identity source every other service reads. A deleted
   * account comes back as the shared "Deleted Account" literal (anonymized at
   * the source). `null` when the id is unknown or the lookup failed.
   */
  getDisplayName(userId: string): Promise<string | null>;
}

export function createUserIdentityClient(): UserIdentityClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["user"] as grpc.GrpcObject)[
    "UserService"
  ] as grpc.ServiceClientConstructor;
  const client = new ServiceCtor(
    env.USER_SERVICE_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const snapshotBreaker = makeBreaker(
    "user.bulkGetUserSnapshots",
    async (userId: string) => {
      const res = await makeGrpcCall<
        { userIds: string[] },
        { users?: Array<{ userId: string; displayName: string }> }
      >(client, "bulkGetUserSnapshots", { userIds: [userId] });
      return res.users?.find((u) => u.userId === userId)?.displayName || null;
    }
  );
  // Fail-open: an unresolved name only costs the push its actor name (the copy
  // falls back to the event's own name, then to a localized "Someone"), so it
  // must never throw and abort (and DLQ) the push.
  snapshotBreaker.fallback(() => null);

  return {
    getDisplayName: (userId) => snapshotBreaker.fire(userId),
  };
}

/** Module-singleton (created once, like `communityClient`). */
export const userIdentityClient: UserIdentityClient =
  createUserIdentityClient();
