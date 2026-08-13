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
  "../../../../packages/grpc-contracts/proto/messaging.proto"
);

// int64 arrives as a STRING (longs: String) — coerce on read.
interface RawGroupCount {
  total: string | number;
}

// ---- Admin Group Management raw shapes -----------------------------------
// proto-loader keepCase:false → camelCase; longs:String → int64 as string.

/** AdminGroupAdmin (group owner identity). */
export interface RawAdminGroupAdmin {
  userId: string;
  username: string;
  email: string;
  avatarUrl: string;
}

/** AdminGroupRow — int64 created_at/disbanded_at/last_message_at arrive as strings. */
export interface RawAdminGroupRow {
  id: string;
  name: string;
  avatarUrl: string;
  description: string;
  memberCount: number;
  createdAt: string;
  admin: RawAdminGroupAdmin;
  status: string;
  disbandedAt: string;
  lastMessageAt: string;
}

export interface AdminListGroupsReq {
  q: string;
  fromDate: string;
  toDate: string;
  sortField: string;
  sortDir: string;
  page: number;
  limit: number;
  // "" → chat-service keeps its ACTIVE default; "ALL" → no status filter.
  status: string;
}

export interface AdminListGroupsRes {
  groups: RawAdminGroupRow[];
  total: number;
}

export interface AdminGroupDetailRes {
  found: boolean;
  group?: RawAdminGroupRow;
}

/** AdminGroupMemberRow — int64 joined_at/kicked_at/banned_at arrive as strings. */
export interface RawAdminGroupMemberRow {
  userId: string;
  username: string;
  email: string;
  avatarUrl: string;
  role: string;
  joinedAt: string;
  status: string;
  kickedAt: string;
  bannedAt: string;
}

export interface AdminListGroupMembersReq {
  groupId: string;
  q: string;
  role: string;
  page: number;
  limit: number;
  // "" → chat-service keeps its ACTIVE default; "ALL" → no status filter.
  status: string;
}

export interface AdminListGroupMembersRes {
  found: boolean;
  members: RawAdminGroupMemberRow[];
  total: number;
}

// ---- Admin Group Moderation raw shapes -----------------------------------
// AdminGroupMutationResult carries no int64 — no coercion needed. Business
// failures come back as `errorCode`, never as a gRPC error.

export interface AdminDisbandGroupReq {
  groupId: string;
  actorAdminId: string;
}

export interface AdminRemoveGroupMemberReq {
  groupId: string;
  userId: string;
  actorAdminId: string;
  // "" is treated as absent by chat-service (`req.reason || undefined`).
  reason: string;
}

// errorCode: "" | CHAT_GROUP_NOT_FOUND | CHAT_GROUP_ALREADY_DISBANDED | CHAT_NOT_A_MEMBER.
export interface AdminGroupMutationRes {
  ok: boolean;
  found: boolean;
  errorCode: string;
}

// ---- Admin Calling raw shapes --------------------------------------------
// int64 fields arrive as STRINGS (longs: String) — coerce on read.

export interface AdminCallAnalyticsReq {
  fromDate: string;
  toDate: string;
}

export interface RawAdminCallHourBucket {
  hour: number;
  count: string | number;
}

export interface RawAdminCallAnalytics {
  totalCalls: string | number;
  audioCalls: string | number;
  videoCalls: string | number;
  answeredCalls: string | number;
  missedCalls: string | number;
  declinedCalls: string | number;
  missedRate: number;
  avgDurationSec: number;
  medianDurationSec: string | number;
  p90DurationSec: string | number;
  totalDurationSec: string | number;
  peakHours: RawAdminCallHourBucket[];
  connectionSuccessRate: number;
}

/** Number-coerced analytics — what the service/route layer actually consumes. */
export interface AdminCallAnalytics {
  totalCalls: number;
  audioCalls: number;
  videoCalls: number;
  answeredCalls: number;
  missedCalls: number;
  declinedCalls: number;
  missedRate: number;
  avgDurationSec: number;
  /** p50 — the honest "typical call length"; prefer this over the mean. */
  medianDurationSec: number;
  p90DurationSec: number;
  totalDurationSec: number;
  peakHours: Array<{ hour: number; count: number }>;
  connectionSuccessRate: number;
}

export interface RawAdminCallHealth {
  activeCalls: string | number;
  ringingCalls: string | number;
}

export interface AdminCallHealth {
  activeCalls: number;
  ringingCalls: number;
}

export interface RawAdminCallingEnabled {
  enabled: boolean;
  updatedBy: string;
  updatedAt: string | number;
}

export interface AdminCallingEnabled {
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: number | null;
}

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
const ServiceCtor = (proto["messaging"] as grpc.GrpcObject)[
  "MessagingService"
] as grpc.ServiceClientConstructor;
const client = new ServiceCtor(
  env.CHAT_GRPC_URL,
  grpc.credentials.createInsecure()
);

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

export const getGroupCountBreaker: NoArgBreaker<RawGroupCount> =
  makeBreakerNoArgs("chat.getGroupCount", () =>
    call<unknown, RawGroupCount>("getGroupCount", {})
  );

export const adminListGroupsBreaker: Breaker<
  AdminListGroupsReq,
  AdminListGroupsRes
> = makeBreaker("chat.adminListGroups", (req: AdminListGroupsReq) =>
  call<AdminListGroupsReq, AdminListGroupsRes>("adminListGroups", req)
);

export const adminGetGroupBreaker: Breaker<
  { groupId: string },
  AdminGroupDetailRes
> = makeBreaker("chat.adminGetGroup", (req: { groupId: string }) =>
  call<{ groupId: string }, AdminGroupDetailRes>("adminGetGroup", req)
);

export const adminListGroupMembersBreaker: Breaker<
  AdminListGroupMembersReq,
  AdminListGroupMembersRes
> = makeBreaker("chat.adminListGroupMembers", (req: AdminListGroupMembersReq) =>
  call<AdminListGroupMembersReq, AdminListGroupMembersRes>(
    "adminListGroupMembers",
    req
  )
);

export const adminDisbandGroupBreaker: Breaker<
  AdminDisbandGroupReq,
  AdminGroupMutationRes
> = makeBreaker("chat.adminDisbandGroup", (req: AdminDisbandGroupReq) =>
  call<AdminDisbandGroupReq, AdminGroupMutationRes>("adminDisbandGroup", req)
);

export const adminRemoveGroupMemberBreaker: Breaker<
  AdminRemoveGroupMemberReq,
  AdminGroupMutationRes
> = makeBreaker(
  "chat.adminRemoveGroupMember",
  (req: AdminRemoveGroupMemberReq) =>
    call<AdminRemoveGroupMemberReq, AdminGroupMutationRes>(
      "adminRemoveGroupMember",
      req
    )
);

export const adminGetCallAnalyticsBreaker: Breaker<
  AdminCallAnalyticsReq,
  RawAdminCallAnalytics
> = makeBreaker("chat.adminGetCallAnalytics", (req: AdminCallAnalyticsReq) =>
  call<AdminCallAnalyticsReq, RawAdminCallAnalytics>(
    "adminGetCallAnalytics",
    req
  )
);

export const adminGetCallHealthBreaker: NoArgBreaker<RawAdminCallHealth> =
  makeBreakerNoArgs("chat.adminGetCallHealth", () =>
    call<unknown, RawAdminCallHealth>("adminGetCallHealth", {})
  );

export const adminGetCallingEnabledBreaker: NoArgBreaker<RawAdminCallingEnabled> =
  makeBreakerNoArgs("chat.adminGetCallingEnabled", () =>
    call<unknown, RawAdminCallingEnabled>("adminGetCallingEnabled", {})
  );

export const adminSetCallingEnabledBreaker: Breaker<
  { enabled: boolean; actorId: string },
  RawAdminCallingEnabled
> = makeBreaker(
  "chat.adminSetCallingEnabled",
  (req: { enabled: boolean; actorId: string }) =>
    call<{ enabled: boolean; actorId: string }, RawAdminCallingEnabled>(
      "adminSetCallingEnabled",
      req
    )
);

/** int64-as-string → number. */
const int = (v: string | number | undefined): number => Number(v ?? 0) || 0;

function toCallingEnabled(r: RawAdminCallingEnabled): AdminCallingEnabled {
  const updatedAt = int(r.updatedAt);
  return {
    enabled: Boolean(r.enabled),
    updatedBy: r.updatedBy || null,
    // chat-service sends 0 when the flag has never been set.
    updatedAt: updatedAt > 0 ? updatedAt : null,
  };
}

export const chatClient = {
  async getGroupCount(): Promise<number> {
    const r = await getGroupCountBreaker.fire();
    return Number(r.total);
  },
  adminListGroups(req: AdminListGroupsReq): Promise<AdminListGroupsRes> {
    return adminListGroupsBreaker.fire(req);
  },
  adminGetGroup(groupId: string): Promise<AdminGroupDetailRes> {
    return adminGetGroupBreaker.fire({ groupId });
  },
  adminListGroupMembers(
    req: AdminListGroupMembersReq
  ): Promise<AdminListGroupMembersRes> {
    return adminListGroupMembersBreaker.fire(req);
  },
  adminDisbandGroup(req: AdminDisbandGroupReq): Promise<AdminGroupMutationRes> {
    return adminDisbandGroupBreaker.fire(req);
  },
  adminRemoveGroupMember(
    req: AdminRemoveGroupMemberReq
  ): Promise<AdminGroupMutationRes> {
    return adminRemoveGroupMemberBreaker.fire(req);
  },

  async adminGetCallAnalytics(
    req: AdminCallAnalyticsReq
  ): Promise<AdminCallAnalytics> {
    const r = await adminGetCallAnalyticsBreaker.fire(req);
    return {
      totalCalls: int(r.totalCalls),
      audioCalls: int(r.audioCalls),
      videoCalls: int(r.videoCalls),
      answeredCalls: int(r.answeredCalls),
      missedCalls: int(r.missedCalls),
      declinedCalls: int(r.declinedCalls),
      missedRate: Number(r.missedRate) || 0,
      avgDurationSec: Number(r.avgDurationSec) || 0,
      medianDurationSec: int(r.medianDurationSec),
      p90DurationSec: int(r.p90DurationSec),
      totalDurationSec: int(r.totalDurationSec),
      peakHours: (r.peakHours ?? []).map((b) => ({
        hour: Number(b.hour) || 0,
        count: int(b.count),
      })),
      connectionSuccessRate: Number(r.connectionSuccessRate) || 0,
    };
  },

  async adminGetCallHealth(): Promise<AdminCallHealth> {
    const r = await adminGetCallHealthBreaker.fire();
    return {
      activeCalls: int(r.activeCalls),
      ringingCalls: int(r.ringingCalls),
    };
  },

  async adminGetCallingEnabled(): Promise<AdminCallingEnabled> {
    return toCallingEnabled(await adminGetCallingEnabledBreaker.fire());
  },

  async adminSetCallingEnabled(
    enabled: boolean,
    actorId: string
  ): Promise<AdminCallingEnabled> {
    return toCallingEnabled(
      await adminSetCallingEnabledBreaker.fire({ enabled, actorId })
    );
  },
};
