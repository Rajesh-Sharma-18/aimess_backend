import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";
import { onlyUuidPeers } from "../lib/peer-id.js";

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
    >("resolvePrivateRooms", args).then((r) => onlyUuidPeers(r.matches ?? []))
);
// A chat-service outage must not fail user search — degrade to "no room known".
resolvePrivateRoomsBreaker.fallback(() => []);

const listPrivateRoomsBreaker = makeBreaker(
  "messaging.listPrivateRooms",
  (args: { viewerId: string; limit: number }) =>
    call<{ viewerId: string; limit: number }, { rooms?: PrivateRoomMatch[] }>(
      "listPrivateRooms",
      args
    ).then((r) => onlyUuidPeers(r.rooms ?? []))
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

const roomParticipantIdsBreaker = makeBreaker(
  "messaging.getRoomParticipantIds",
  (args: { conversationId: string; conversationType: "PRIVATE" | "GROUP" }) =>
    call<typeof args, { userIds?: string[] }>(
      "getRoomParticipantIds",
      args
    ).then((r) => r.userIds ?? [])
);
// Fail OPEN (empty roster = exclude nobody). The list only narrows an "Add
// Members" picker; a chat-service outage must degrade to "shows everyone, the
// add call still rejects duplicates", never to "shows nobody".
roomParticipantIdsBreaker.fallback(() => [] as string[]);

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

  /**
   * Groups the viewer is not an ACTIVE member of but which are still in their
   * conversation list (left/removed without deleting the conversation),
   * excluding `excludeRoomIds`. Never groups the viewer has no relationship
   * with — chat-service derives the candidate set from the viewer's own
   * membership rows.
   */
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

  /**
   * Every ACTIVE member of a GROUP room. Used to subtract the existing roster
   * from the friend picker so an already-added member can't be selected again.
   * Never throws.
   */
  async getGroupMemberIds(roomId: string): Promise<string[]> {
    if (!roomId) return [];
    try {
      return await roomParticipantIdsBreaker.fire({
        conversationId: roomId,
        conversationType: "GROUP",
      });
    } catch (err) {
      logger.warn(`messaging.getRoomParticipantIds failed: ${String(err)}`);
      return [];
    }
  },

  /**
   * Auto-Connect: batch get-or-create private rooms for a user against
   * multiple peers. Returns existing roomId if one exists, creates new one
   * if not (and friendship is ACCEPTED).
   */
  async getOrCreatePrivateRooms(
    userId: string,
    peerUserIds: string[]
  ): Promise<PrivateRoomMatch[]> {
    if (!userId || peerUserIds.length === 0) return [];
    try {
      return await call<
        { userId: string; peerUserIds: string[] },
        { rooms?: PrivateRoomMatch[] }
      >("getOrCreatePrivateRooms", { userId, peerUserIds }).then((r) =>
        onlyUuidPeers(r.rooms ?? [])
      );
    } catch (err) {
      logger.warn(`messaging.getOrCreatePrivateRooms failed: ${String(err)}`);
      return [];
    }
  },
};
