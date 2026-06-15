import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);

export interface CommunityChatLastMessage {
  username: string;
  message: string;
  /** epoch ms */
  dateTime: number;
}

export interface CommunityChatSummary {
  communityId: string;
  unreadMessageCount: number;
  /** false => lastMessageActivity must be rendered as null. */
  hasLastMessage: boolean;
  lastMessage?: CommunityChatLastMessage;
}

export interface ChatClient {
  getCommunityChatSummaries(params: {
    userId: string;
    communityIds: string[];
  }): Promise<CommunityChatSummary[]>;
  bulkMarkCommunityRead(params: {
    userId: string;
    communityIds: string[];
  }): Promise<number>;
  /**
   * Synchronously provision the community's chat room in chat-service. Called at
   * community-creation time so a member's first message can't race ahead of the
   * async `community.created` event. Resolves true on success; throws if
   * chat-service is unreachable / the breaker is open (caller decides handling).
   */
  ensureCommunityRoom(params: {
    communityId: string;
    name: string;
    ownerId: string;
    avatarUrl: string | null;
  }): Promise<boolean>;
}

export function createChatClient(): ChatClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["community"] as grpc.GrpcObject)[
    "CommunityService"
  ] as grpc.ServiceClientConstructor;
  const client = new ServiceCtor(
    env.CHAT_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const summariesBreaker = makeBreaker(
    "chat.getCommunityChatSummaries",
    (p: { userId: string; communityIds: string[] }) =>
      makeGrpcCall<unknown, { summaries?: CommunityChatSummary[] }>(
        client,
        "getCommunityChatSummaries",
        { userId: p.userId, communityIds: p.communityIds }
      )
  );
  // Graceful degradation: chat-service down / breaker open / empty input → no
  // enrichment (every item falls back to 0 unread + null lastMessageActivity).
  summariesBreaker.fallback(() => ({ summaries: [] }));

  const bulkMarkBreaker = makeBreaker(
    "chat.bulkMarkCommunityRead",
    (p: { userId: string; communityIds: string[] }) =>
      makeGrpcCall<unknown, { updatedCount?: number }>(
        client,
        "bulkMarkCommunityRead",
        { userId: p.userId, communityIds: p.communityIds }
      )
  );
  bulkMarkBreaker.fallback(() => ({ updatedCount: 0 }));

  const ensureRoomBreaker = makeBreaker(
    "chat.ensureCommunityRoom",
    (p: {
      communityId: string;
      name: string;
      ownerId: string;
      avatarUrl: string | null;
    }) =>
      makeGrpcCall<unknown, { ok?: boolean; communityId?: string }>(
        client,
        "ensureCommunityRoom",
        {
          communityId: p.communityId,
          name: p.name,
          ownerId: p.ownerId,
          avatarUrl: p.avatarUrl ?? "",
        }
      )
  );
  // No fallback: the caller awaits this to guarantee the room exists, and on
  // failure logs + relies on the async community.created backstop — a silent
  // success fallback would re-open the send-before-provision race.

  return {
    getCommunityChatSummaries: async (params) => {
      if (!params.communityIds.length) return [];
      try {
        const res = await summariesBreaker.fire(params);
        // proto-loader decodes int64 (`dateTime`) as a STRING (longs: "String")
        // and may null-fill the `lastMessage` sub-message — normalize here so
        // callers get the contract types (numeric epoch-ms, optional lastMessage).
        return (res.summaries ?? []).map((s) => ({
          communityId: s.communityId,
          unreadMessageCount: Number(s.unreadMessageCount ?? 0),
          hasLastMessage: Boolean(s.hasLastMessage),
          lastMessage:
            s.hasLastMessage && s.lastMessage
              ? {
                  username: s.lastMessage.username ?? "",
                  message: s.lastMessage.message ?? "",
                  dateTime: Number(s.lastMessage.dateTime ?? 0),
                }
              : undefined,
        }));
      } catch (err) {
        logger.warn(
          `chat.getCommunityChatSummaries failed; degrading to no chat activity: ${String(err)}`
        );
        return [];
      }
    },

    bulkMarkCommunityRead: async (params) => {
      if (!params.communityIds.length) return 0;
      try {
        const res = await bulkMarkBreaker.fire(params);
        return Number(res.updatedCount ?? 0);
      } catch (err) {
        logger.warn(
          `chat.bulkMarkCommunityRead failed; degrading to no-op: ${String(err)}`
        );
        return 0;
      }
    },

    ensureCommunityRoom: async (params) => {
      const res = await ensureRoomBreaker.fire(params);
      return Boolean(res.ok);
    },
  };
}

/** Lazily-created shared chat client (one gRPC channel per process). */
let cached: ChatClient | undefined;
export function getChatClient(): ChatClient {
  cached ??= createChatClient();
  return cached;
}
