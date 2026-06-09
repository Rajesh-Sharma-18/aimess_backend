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

/** AdminGroupRow — int64 created_at arrives as a string. */
export interface RawAdminGroupRow {
  id: string;
  name: string;
  avatarUrl: string;
  description: string;
  memberCount: number;
  createdAt: string;
  admin: RawAdminGroupAdmin;
}

export interface AdminListGroupsReq {
  q: string;
  fromDate: string;
  toDate: string;
  sortField: string;
  sortDir: string;
  page: number;
  limit: number;
}

export interface AdminListGroupsRes {
  groups: RawAdminGroupRow[];
  total: number;
}

export interface AdminGroupDetailRes {
  found: boolean;
  group?: RawAdminGroupRow;
}

/** AdminGroupMemberRow — int64 joined_at arrives as a string. */
export interface RawAdminGroupMemberRow {
  userId: string;
  username: string;
  email: string;
  avatarUrl: string;
  role: string;
  joinedAt: string;
}

export interface AdminListGroupMembersReq {
  groupId: string;
  q: string;
  role: string;
  page: number;
  limit: number;
}

export interface AdminListGroupMembersRes {
  found: boolean;
  members: RawAdminGroupMemberRow[];
  total: number;
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
};
