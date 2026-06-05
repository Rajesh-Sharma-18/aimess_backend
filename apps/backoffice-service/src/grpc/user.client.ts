import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall, type Breaker } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/user.proto"
);

/** A clean TS record for one admin profile (camelCase; "" → kept as-is). */
export interface AdminProfileRecord {
  userId: string;
  username: string;
  avatarUrl: string;
  firstName: string;
  lastName: string;
  createdAt: string;
}

interface RawAdminProfilesResponse {
  profiles: AdminProfileRecord[];
}

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
  env.USER_GRPC_URL,
  grpc.credentials.createInsecure()
);

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

/**
 * Treat gRPC NOT_FOUND as a non-failure for the breaker: opossum then re-throws
 * the ORIGINAL ServiceError (preserving `.code`) instead of invoking the
 * makeBreaker fallback, which would mask it as a generic "<name> unavailable"
 * Error. Without this, a missing profile surfaces as a 5xx instead of degrading
 * to null. NOT_FOUND is also excluded from the circuit's failure stats — a
 * genuine outage still trips the breaker.
 */
const notFoundIsBenign = {
  errorFilter: (err: unknown) =>
    (err as grpc.ServiceError)?.code === grpc.status.NOT_FOUND,
};

// Admin Panel: batch profile enrichment + single-profile fetch from user-service.
export const adminGetProfilesByIdsBreaker: Breaker<
  { userIds: string[] },
  RawAdminProfilesResponse
> = makeBreaker("user.adminGetProfilesByIds", (args: { userIds: string[] }) =>
  call<{ userIds: string[] }, RawAdminProfilesResponse>(
    "adminGetProfilesByIds",
    args
  )
);

export const adminGetProfileBreaker: Breaker<
  { userId: string },
  AdminProfileRecord
> = makeBreaker(
  "user.adminGetProfile",
  (args: { userId: string }) =>
    call<{ userId: string }, AdminProfileRecord>("adminGetProfile", args),
  notFoundIsBenign
);

export const userClient = {
  // Empty input → no gRPC call (avoids a needless round-trip).
  async adminGetProfilesByIds(
    userIds: string[]
  ): Promise<AdminProfileRecord[]> {
    if (userIds.length === 0) return [];
    const r = await adminGetProfilesByIdsBreaker.fire({ userIds });
    return r.profiles ?? [];
  },
  // NOT_FOUND rejects the breaker; caught here and mapped to null.
  async adminGetProfile(userId: string): Promise<AdminProfileRecord | null> {
    try {
      return await adminGetProfileBreaker.fire({ userId });
    } catch (err) {
      if ((err as grpc.ServiceError)?.code === grpc.status.NOT_FOUND) {
        return null;
      }
      throw err;
    }
  },
};
