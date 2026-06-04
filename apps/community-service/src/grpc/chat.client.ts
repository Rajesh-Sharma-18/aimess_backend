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
  };
}

/** Lazily-created shared chat client (one gRPC channel per process). */
let cached: ChatClient | undefined;
export function getChatClient(): ChatClient {
  cached ??= createChatClient();
  return cached;
}
