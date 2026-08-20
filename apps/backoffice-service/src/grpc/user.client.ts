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

export const adminSearchProfileIdsBreaker: Breaker<
  { search: string },
  { userIds: string[] }
> = makeBreaker("user.adminSearchProfileIds", (args: { search: string }) =>
  call<{ search: string }, { userIds: string[] }>("adminSearchProfileIds", args)
);

interface AdminDisconnectAllFriendshipsResponse {
  friendshipsDisconnected: number;
  usersAffected: number;
}

// Platform-wide unfriend sweep — rare, admin-triggered, and potentially
// draining a very large table in batches server-side, so it gets its own
// generous timeout instead of the default 2s BREAKER_OPTS (which would trip
// on every real invocation, not just genuine outages).
export const adminDisconnectAllFriendshipsBreaker: Breaker<
  { confirm: boolean },
  AdminDisconnectAllFriendshipsResponse
> = makeBreaker(
  "user.adminDisconnectAllFriendships",
  (args: { confirm: boolean }) =>
    call<{ confirm: boolean }, AdminDisconnectAllFriendshipsResponse>(
      "adminDisconnectAllFriendships",
      args
    ),
  { timeout: 10 * 60 * 1000 }
);

interface AdminSetProfileStatusResponse {
  ok: boolean;
  status: string;
  errorCode: string;
}

export const adminSetProfileStatusBreaker: Breaker<
  { userId: string; status: string },
  AdminSetProfileStatusResponse
> = makeBreaker(
  "user.adminSetProfileStatus",
  (args: { userId: string; status: string }) =>
    call<{ userId: string; status: string }, AdminSetProfileStatusResponse>(
      "adminSetProfileStatus",
      args
    )
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
  // Admin Reports search: userIds matching name/username. Empty term → no call.
  async adminSearchProfileIds(search: string): Promise<string[]> {
    if (!search.trim()) return [];
    const r = await adminSearchProfileIdsBreaker.fire({ search });
    return r.userIds ?? [];
  },
  // Platform-wide unfriend sweep. `confirm` must be true — see the .proto doc;
  // the real access control is the SUPER_ADMIN route calling this, not this flag.
  async adminDisconnectAllFriendships(
    confirm: boolean
  ): Promise<AdminDisconnectAllFriendshipsResponse> {
    return adminDisconnectAllFriendshipsBreaker.fire({ confirm });
  },
  /**
   * Mirror an account ban/suspend/reinstate onto the user-service profile so
   * every service that reads BulkGetUserSnapshots (invites, group adds, DM
   * invite cards) can refuse a banned recipient. Best-effort by design — same
   * rule as the space cascade: the ban itself already landed in auth-service.
   */
  async adminSetProfileStatus(
    userId: string,
    status: "ACTIVE" | "SUSPENDED"
  ): Promise<void> {
    await adminSetProfileStatusBreaker.fire({ userId, status });
  },
};
