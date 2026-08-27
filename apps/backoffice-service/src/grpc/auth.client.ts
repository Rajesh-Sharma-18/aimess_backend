import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  makeBreaker,
  makeBreakerNoArgs,
  makeGrpcCall,
  type Breaker,
  type NoArgBreaker,
} from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/auth.proto"
);

export interface UserCounts {
  totalUsers: number;
  newUsersToday: number;
  bannedUsers: number;
}

/** Normalized admin status mirrored from auth-service AuthUser. */
export type AdminUserStatus = "ACTIVE" | "SUSPENDED" | "BANNED" | "DELETED";

/** A clean TS record for one admin user (camelCase; "" → kept as-is). */
export interface AdminUserRecord {
  id: string;
  account: string;
  email: string;
  status: AdminUserStatus;
  createdAt: string;
  suspendedAt: string;
  suspendedReason: string;
  deletedAt: string;
  lastLoginAt: string;
}

/** Request mirror of auth.proto AdminListUsersRequest (camelCase at runtime). */
export interface AdminListUsersRequest {
  search?: string;
  status?: string[];
  createdAfter?: string;
  createdBefore?: string;
  sortField?: string;
  sortDir?: string;
  limit?: number;
  offset?: number;
  userIds?: string[];
  excludeUserIds?: string[];
}
export interface ActiveUserCounts {
  dailyActive: number;
  monthlyActive: number;
}
export interface ActiveUserSeriesBucket {
  bucket: string;
  dailyActive: number;
  monthlyActive: number;
  churned: number;
}

// proto-loader maps int64 (longs: String) to STRINGS; coerce to numbers.
interface RawUserCounts {
  totalUsers: string | number;
  newUsersToday: string | number;
  bannedUsers: string | number;
}
interface RawActiveUserCounts {
  dailyActive: string | number;
  monthlyActive: string | number;
}
interface RawActiveUserSeriesBucket {
  date: string;
  dailyActive: string | number;
  monthlyActive: string | number;
  churned: string | number;
}
interface RawActiveUserSeries {
  buckets: RawActiveUserSeriesBucket[];
}

// int64 `total` arrives as a STRING (longs: String) — coerce on read.
interface RawAdminListUsersResponse {
  users: AdminUserRecord[];
  total: string | number;
}

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
const ServiceCtor = (proto["auth"] as grpc.GrpcObject)[
  "AuthService"
] as grpc.ServiceClientConstructor;
const client = new ServiceCtor(
  env.AUTH_GRPC_URL,
  grpc.credentials.createInsecure()
);

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

// Breakers exposed so service-status can read their open/halfOpen state.
export const getUserCountsBreaker: NoArgBreaker<RawUserCounts> =
  makeBreakerNoArgs("auth.getUserCounts", () =>
    call<unknown, RawUserCounts>("getUserCounts", {})
  );
export const getActiveUserCountsBreaker: NoArgBreaker<RawActiveUserCounts> =
  makeBreakerNoArgs("auth.getActiveUserCounts", () =>
    call<unknown, RawActiveUserCounts>("getActiveUserCounts", {
      dauWindowHours: 24,
      mauWindowDays: 30,
    })
  );

// Single-arg breaker: per-day active/churned series over a UTC date range.
export const getActiveUserSeriesBreaker: Breaker<
  { startDate: string; endDate: string },
  RawActiveUserSeries
> = makeBreaker(
  "auth.getActiveUserSeries",
  (args: { startDate: string; endDate: string }) =>
    call<{ startDate: string; endDate: string }, RawActiveUserSeries>(
      "getActiveUserSeries",
      args
    )
);

// Admin Panel: live user list + single-user fetch from auth-service.
export const adminListUsersBreaker: Breaker<
  AdminListUsersRequest,
  RawAdminListUsersResponse
> = makeBreaker("auth.adminListUsers", (args: AdminListUsersRequest) =>
  call<AdminListUsersRequest, RawAdminListUsersResponse>("adminListUsers", args)
);

// Announcements: users holding a live session on the targeted device type(s).
export const adminListUserIdsByDeviceTypeBreaker: Breaker<
  { deviceTypes: string[]; limit: number; offset: number },
  { userIds?: string[]; total?: string | number }
> = makeBreaker(
  "auth.adminListUserIdsByDeviceType",
  (args: { deviceTypes: string[]; limit: number; offset: number }) =>
    call<
      { deviceTypes: string[]; limit: number; offset: number },
      { userIds?: string[]; total?: string | number }
    >("adminListUserIdsByDeviceType", args)
);

// Treat gRPC NOT_FOUND as benign so opossum re-throws the original ServiceError
// (with `.code`) instead of masking it via the makeBreaker fallback — lets the
// repo map a missing user to null (→ 404) rather than a generic 5xx. A real
// outage still trips the breaker.
export const adminGetUserBreaker: Breaker<{ userId: string }, AdminUserRecord> =
  makeBreaker(
    "auth.adminGetUser",
    (args: { userId: string }) =>
      call<{ userId: string }, AdminUserRecord>("adminGetUser", args),
    {
      errorFilter: (err: unknown) =>
        (err as grpc.ServiceError)?.code === grpc.status.NOT_FOUND,
    }
  );

export interface AdminSetAccountStatusResult {
  ok: boolean;
  status: string;
  revokedSessions: number;
  errorCode: string;
}

// int32 revokedSessions arrives as a number; the rest are strings.
interface RawAdminSetAccountStatusResponse {
  ok: boolean;
  status: string;
  revokedSessions: string | number;
  errorCode: string;
}

// NOT wrapped in makeBreaker's fallback-on-failure behaviour by accident: this
// is the one call whose failure must propagate. A permanent ban that did not
// reach auth-service has not happened — the account can still log in — so the
// caller aborts rather than writing a mirror row for a ban that is not real.
// makeBreaker still gives us the circuit + timeout; the wrapper below rethrows.
export const adminSetAccountStatusBreaker: Breaker<
  {
    userId: string;
    status: string;
    reason: string;
    actorAdminId: string;
  },
  RawAdminSetAccountStatusResponse
> = makeBreaker(
  "auth.adminSetAccountStatus",
  (args: {
    userId: string;
    status: string;
    reason: string;
    actorAdminId: string;
  }) =>
    call<typeof args, RawAdminSetAccountStatusResponse>(
      "adminSetAccountStatus",
      args
    )
);

export interface AdminRestoreAccountResult {
  ok: boolean;
  status: string;
  restoredAt: string;
  errorCode: string;
}

interface RawAdminRestoreAccountResponse {
  ok: boolean;
  status: string;
  restoredAt: string;
  errorCode: string;
}

// Same rule as adminSetAccountStatusBreaker: no fallback-on-failure. A restore
// that did not reach auth-service has not happened, so the caller must abort
// rather than mark the user reactivated in the mirror.
export const adminRestoreAccountBreaker: Breaker<
  { userId: string; actorAdminId: string },
  RawAdminRestoreAccountResponse
> = makeBreaker(
  "auth.adminRestoreAccount",
  (args: { userId: string; actorAdminId: string }) =>
    call<typeof args, RawAdminRestoreAccountResponse>(
      "adminRestoreAccount",
      args
    )
);

export const authClient = {
  async getUserCounts(): Promise<UserCounts> {
    const r = await getUserCountsBreaker.fire();
    return {
      totalUsers: Number(r.totalUsers),
      newUsersToday: Number(r.newUsersToday),
      bannedUsers: Number(r.bannedUsers),
    };
  },
  async getActiveUserCounts(): Promise<ActiveUserCounts> {
    const r = await getActiveUserCountsBreaker.fire();
    return {
      dailyActive: Number(r.dailyActive),
      monthlyActive: Number(r.monthlyActive),
    };
  },
  // int64 fields arrive as strings (longs:String) — coerce each via Number().
  async getActiveUserSeries(
    startDate: string,
    endDate: string
  ): Promise<ActiveUserSeriesBucket[]> {
    const r = await getActiveUserSeriesBreaker.fire({ startDate, endDate });
    return (r.buckets ?? []).map((b) => ({
      bucket: b.date,
      dailyActive: Number(b.dailyActive),
      monthlyActive: Number(b.monthlyActive),
      churned: Number(b.churned),
    }));
  },
  // int64 `total` arrives as a string (longs:String) — coerce via Number().
  async adminListUsers(
    req: AdminListUsersRequest
  ): Promise<{ users: AdminUserRecord[]; total: number }> {
    const r = await adminListUsersBreaker.fire(req);
    return { users: r.users ?? [], total: Number(r.total) };
  },
  /**
   * Users with at least one live (non-revoked) session on the given device
   * types. Empty `deviceTypes` means every type. Used to resolve the audience
   * of a device-targeted announcement.
   */
  async adminListUserIdsByDeviceType(args: {
    deviceTypes: string[];
    limit: number;
    offset: number;
  }): Promise<{ userIds: string[]; total: number }> {
    const r = await adminListUserIdsByDeviceTypeBreaker.fire(args);
    return { userIds: r.userIds ?? [], total: Number(r.total ?? 0) };
  },
  // NOT_FOUND rejects the breaker; the repo layer catches and maps to null.
  async adminGetUser(userId: string): Promise<AdminUserRecord> {
    return adminGetUserBreaker.fire({ userId });
  },
  // Permanently ban / reinstate an account. Throws on transport failure by
  // design — see the breaker comment above.
  async adminSetAccountStatus(args: {
    userId: string;
    status: "BANNED" | "ACTIVE";
    reason?: string | null;
    actorAdminId: string;
  }): Promise<AdminSetAccountStatusResult> {
    const r = await adminSetAccountStatusBreaker.fire({
      userId: args.userId,
      status: args.status,
      reason: args.reason ?? "",
      actorAdminId: args.actorAdminId,
    });
    return {
      ok: r.ok,
      status: r.status,
      revokedSessions: Number(r.revokedSessions),
      errorCode: r.errorCode,
    };
  },
  async adminRestoreAccount(args: {
    userId: string;
    actorAdminId: string;
  }): Promise<AdminRestoreAccountResult> {
    const r = await adminRestoreAccountBreaker.fire(args);
    return {
      ok: r.ok,
      status: r.status,
      restoredAt: r.restoredAt,
      errorCode: r.errorCode,
    };
  },
};
