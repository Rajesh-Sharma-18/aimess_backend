import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/messaging.proto"
);

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

export type PrivateRoomMatch = { peerUserId: string; roomId: string };

const resolvePrivateRoomsBreaker = makeBreaker(
  "messaging.resolvePrivateRooms",
  (args: { viewerId: string; peerUserIds: string[] }) =>
    call<
      { viewerId: string; peerUserIds: string[] },
      { matches?: PrivateRoomMatch[] }
    >("resolvePrivateRooms", args).then((r) => r.matches ?? [])
);
// A chat-service outage must not fail user search — degrade to "no room known".
resolvePrivateRoomsBreaker.fallback(() => []);

const listPrivateRoomsBreaker = makeBreaker(
  "messaging.listPrivateRooms",
  (args: { viewerId: string; limit: number }) =>
    call<{ viewerId: string; limit: number }, { rooms?: PrivateRoomMatch[] }>(
      "listPrivateRooms",
      args
    ).then((r) => r.rooms ?? [])
);
listPrivateRoomsBreaker.fallback(() => []);

export type GroupSummary = {
  roomId: string;
  name: string;
  avatar: string;
  description: string;
  memberCount: number;
  isActiveMember: boolean;
  lastMessageAt: number;
  createdAt: number;
};

const searchUserGroupsBreaker = makeBreaker(
  "messaging.searchUserGroups",
  (args: {
    viewerId: string;
    q?: string;
    mode: "ACTIVE" | "OTHER" | "BY_IDS";
    roomIds?: string[];
    limit: number;
  }) =>
    call<typeof args, { groups?: GroupSummary[] }>("searchUserGroups", {
      viewerId: args.viewerId,
      q: args.q ?? "",
      mode: args.mode,
      roomIds: args.roomIds ?? [],
      limit: args.limit,
    }).then((r) =>
      (r.groups ?? []).map((g) => ({
        ...g,
        memberCount: Number(g.memberCount ?? 0),
        lastMessageAt: Number(g.lastMessageAt ?? 0),
        createdAt: Number(g.createdAt ?? 0),
      }))
    )
);
searchUserGroupsBreaker.fallback(() => []);

export const messagingGrpcClient = {
  /**
   * Batch-resolves existing PrivateRoom ids for `viewerId` against many
   * candidate peer userIds in one call — never throws; a chat-service outage
   * degrades User Search to "no room known" instead of failing it.
   */
  async resolvePrivateRooms(
    viewerId: string,
    peerUserIds: string[]
  ): Promise<PrivateRoomMatch[]> {
    if (!viewerId || peerUserIds.length === 0) return [];
    try {
      return await resolvePrivateRoomsBreaker.fire({ viewerId, peerUserIds });
    } catch (err) {
      logger.warn(`messaging.resolvePrivateRooms failed: ${String(err)}`);
      return [];
    }
  },

  /**
   * Capped list of {peerUserId, roomId} for every private room `viewerId`
   * participates in — used to classify search-matched users into "has a
   * room" (Chat) vs "doesn't" (Other) via a single Postgres id-set filter
   * instead of a per-candidate round trip.
   */
  async listPrivateRoomPeers(
    viewerId: string,
    limit: number
  ): Promise<PrivateRoomMatch[]> {
    try {
      return await listPrivateRoomsBreaker.fire({ viewerId, limit });
    } catch (err) {
      logger.warn(`messaging.listPrivateRooms failed: ${String(err)}`);
      return [];
    }
  },

  /** Groups the viewer actively belongs to, optionally filtered by name. */
  async listActiveGroups(
    viewerId: string,
    q: string | undefined,
    limit: number
  ): Promise<GroupSummary[]> {
    try {
      return await searchUserGroupsBreaker.fire({
        viewerId,
        q,
        mode: "ACTIVE",
        limit,
      });
    } catch (err) {
      logger.warn(`messaging.searchUserGroups(ACTIVE) failed: ${String(err)}`);
      return [];
    }
  },

  /** Groups the viewer does NOT belong to, excluding `excludeRoomIds`. */
  async listOtherGroups(
    viewerId: string,
    q: string | undefined,
    excludeRoomIds: string[],
    limit: number
  ): Promise<GroupSummary[]> {
    try {
      return await searchUserGroupsBreaker.fire({
        viewerId,
        q,
        mode: "OTHER",
        roomIds: excludeRoomIds,
        limit,
      });
    } catch (err) {
      logger.warn(`messaging.searchUserGroups(OTHER) failed: ${String(err)}`);
      return [];
    }
  },

  /** Resolve specific group roomIds (e.g. Recent group targets). */
  async getGroupsByIds(
    viewerId: string,
    roomIds: string[]
  ): Promise<GroupSummary[]> {
    if (roomIds.length === 0) return [];
    try {
      return await searchUserGroupsBreaker.fire({
        viewerId,
        mode: "BY_IDS",
        roomIds,
        limit: roomIds.length,
      });
    } catch (err) {
      logger.warn(`messaging.searchUserGroups(BY_IDS) failed: ${String(err)}`);
      return [];
    }
  },
};
