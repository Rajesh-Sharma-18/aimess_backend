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
  /** true => sender-less SYSTEM line; false => "username: message" member line. */
  isSystem?: boolean;
  /** sender userId for the member-message shape ("" for SYSTEM / unknown). */
  userId?: string;
}

export interface CommunityChatSummary {
  communityId: string;
  unreadMessageCount: number;
  /** false => lastMessageActivity must be rendered as null. */
  hasLastMessage: boolean;
  /**
   * True => the viewer hid the community-wide shared last; `lastMessage` (or its
   * absence) is AUTHORITATIVE and must be used directly — clearing the column
   * preview when there is no lastMessage — rather than overlaid only-when-newer.
   */
  perUserResolved?: boolean;
  lastMessage?: CommunityChatLastMessage;
  /**
   * The viewer's latest PERSONAL line (e.g. "You joined the community"), visible
   * only to this user. Overlaid onto /communities/mine lastActivity for the
   * joiner when newer than the community-wide activity. Sender-less (username "").
   */
  personalLastMessage?: CommunityChatLastMessage;
}

/** Wire shape of one community message DTO (camelCase — keepCase:false). */
export interface CommunityMessageDtoWire {
  messageId: string;
  roomId: string;
  senderId: string;
  message: string;
  contentType: string;
  mediaKey: string;
  /** epoch ms */
  sentAt: number;
  systemMessageType: string;
  systemMetadata: string;
  isPersonal: boolean;
  senderName: string;
  /** pre-resolved presigned URL (already resolved by chat-service's toWire). */
  senderAvatar: string;
  /** JSON-encoded attachment array (URLs already resolved). */
  attachmentsJson: string;
  /** JSON-encoded reaction summary array. */
  reactionsJson: string;
  /** JSON-encoded quoted-message snapshot, "" if none. */
  quoteDataJson: string;
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
  /**
   * Moderation snapshot of one community message (for report cards). Returns RAW
   * object keys — the caller resolves them to presigned URLs on read. `null` on
   * any failure (chat-service down / breaker open); `found:false` when the
   * message is missing / cross-room / deleted-for-all. Best-effort — never throws.
   */
  getCommunityMessageById(params: {
    communityId: string;
    messageId: string;
  }): Promise<{
    found: boolean;
    message: string;
    contentType: string;
    /** epoch ms */
    postedAt: number;
    senderId: string;
    media: {
      objectKey: string;
      contentType: string;
      fileName: string;
      size: number;
    }[];
  } | null>;
  /**
   * Persist a community message. The message store (Mongo GeneralRoomMessage)
   * lives in chat-service, so community-service forwards the send verbatim and
   * relays chat-service's real `{ messageId, roomId, sentAt }` — the same values
   * the gateway echoes back in the `community:message:send` ack. Business
   * rejections (muted / banned / not-a-member / content-too-large / unsupported
   * type) and infra failures propagate as the ORIGINAL gRPC error (code +
   * details) so the caller can map them; this never fabricates a success.
   */
  sendCommunityMessage(params: {
    communityId: string;
    roomId: string;
    senderId: string;
    clientMessageId: string;
    message: string;
    contentType: string;
    mediaKey: string;
    parentMessageId: string;
    attachmentsJson: string;
  }): Promise<{ messageId: string; roomId: string; sentAt: number }>;
  /**
   * Cursor-paged community message history (the socket `community:messages:fetch`
   * entry point). The message store lives in chat-service, so community-service
   * forwards the read verbatim and relays chat-service's REAL page — never a
   * fabricated empty page. Errors (business or infra) propagate as the ORIGINAL
   * gRPC error so the caller can map them; an empty result here always means
   * "genuinely no more messages", never "read failed".
   */
  getCommunityMessages(params: {
    roomId: string;
    requesterId: string;
    cursor: string;
    limit: number;
  }): Promise<{
    messages: CommunityMessageDtoWire[];
    nextCursor: string;
    hasMore: boolean;
    pinnedMessageJson: string;
  }>;
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

  const messageByIdBreaker = makeBreaker(
    "chat.getCommunityMessageById",
    (p: { communityId: string; messageId: string }) =>
      makeGrpcCall<
        unknown,
        {
          found?: boolean;
          message?: string;
          contentType?: string;
          // int64 decoded as STRING (longs:"String").
          sentAt?: string | number;
          senderId?: string;
          media?: {
            objectKey?: string;
            contentType?: string;
            fileName?: string;
            size?: string | number;
          }[];
        }
      >(client, "getCommunityMessageById", {
        roomId: p.communityId,
        messageId: p.messageId,
      })
  );
  // Best-effort: a failed lookup degrades to "no content" — the report is still
  // filed; the moderator card just omits the reported-content section.
  messageByIdBreaker.fallback(() => ({ found: false }));

  const sendMessageBreaker = makeBreaker(
    "chat.sendCommunityMessage",
    (p: {
      communityId: string;
      roomId: string;
      senderId: string;
      clientMessageId: string;
      message: string;
      contentType: string;
      mediaKey: string;
      parentMessageId: string;
      attachmentsJson: string;
    }) =>
      makeGrpcCall<
        unknown,
        // int64 `sentAt` decoded as STRING (longs: "String").
        { messageId?: string; roomId?: string; sentAt?: string | number }
      >(client, "sendCommunityMessage", p)
  );
  // NO fallback on purpose: a send must fail LOUDLY so the caller acks a
  // retryable SERVICE_ERROR — never a fake empty-but-successful ack (the exact
  // bug this replaces). makeBreaker's default fallback rethrows on open circuit,
  // and business-error statuses pass through untouched (errorFilter).

  const getMessagesBreaker = makeBreaker(
    "chat.getCommunityMessages",
    (p: {
      roomId: string;
      requesterId: string;
      cursor: string;
      limit: number;
    }) =>
      makeGrpcCall<
        unknown,
        {
          messages?: Array<
            Omit<CommunityMessageDtoWire, "sentAt"> & {
              // int64 decoded as STRING (longs: "String").
              sentAt?: string | number;
            }
          >;
          nextCursor?: string;
          hasMore?: boolean;
          pinnedMessageJson?: string;
        }
      >(client, "getCommunityMessages", p)
  );
  // NO fallback on purpose (mirrors sendCommunityMessage): a failed fetch must
  // fail LOUDLY (ackError) rather than silently return an empty page that the
  // FE would read as "this community has no history".

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
          perUserResolved: Boolean(s.perUserResolved),
          lastMessage:
            s.hasLastMessage && s.lastMessage
              ? {
                  username: s.lastMessage.username ?? "",
                  message: s.lastMessage.message ?? "",
                  dateTime: Number(s.lastMessage.dateTime ?? 0),
                  isSystem: Boolean(s.lastMessage.isSystem),
                  userId: s.lastMessage.userId ?? "",
                }
              : undefined,
          // proto-loader null-fills sub-messages; a real personal line always
          // carries a non-empty message, so treat empty/zero as absent.
          personalLastMessage:
            s.personalLastMessage && s.personalLastMessage.message
              ? {
                  username: "",
                  message: s.personalLastMessage.message,
                  dateTime: Number(s.personalLastMessage.dateTime ?? 0),
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

    getCommunityMessageById: async (params) => {
      try {
        const res = await messageByIdBreaker.fire(params);
        if (!res.found) {
          return {
            found: false,
            message: "",
            contentType: "",
            postedAt: 0,
            senderId: "",
            media: [],
          };
        }
        return {
          found: true,
          message: res.message ?? "",
          contentType: res.contentType ?? "",
          postedAt: Number(res.sentAt ?? 0),
          senderId: res.senderId ?? "",
          media: (res.media ?? [])
            .map((m) => ({
              objectKey: m.objectKey ?? "",
              contentType: m.contentType ?? "",
              fileName: m.fileName ?? "",
              size: Number(m.size ?? 0),
            }))
            .filter((m) => m.objectKey),
        };
      } catch (err) {
        logger.warn(
          `chat.getCommunityMessageById failed; degrading to no content: ${String(err)}`
        );
        return null;
      }
    },

    sendCommunityMessage: async (params) => {
      // Forward verbatim; relay the ACTUAL persisted identity. Errors (business
      // or infra) propagate unchanged so the gateway maps them correctly.
      const res = await sendMessageBreaker.fire(params);
      return {
        messageId: res.messageId ?? "",
        roomId: res.roomId ?? "",
        sentAt: Number(res.sentAt ?? 0),
      };
    },

    getCommunityMessages: async (params) => {
      // Forward verbatim; relay the ACTUAL persisted page. Errors propagate
      // unchanged so the caller can distinguish "empty history" from "read failed".
      const res = await getMessagesBreaker.fire(params);
      return {
        messages: (res.messages ?? []).map((m) => ({
          messageId: m.messageId ?? "",
          roomId: m.roomId ?? "",
          senderId: m.senderId ?? "",
          message: m.message ?? "",
          contentType: m.contentType ?? "",
          mediaKey: m.mediaKey ?? "",
          sentAt: Number(m.sentAt ?? 0),
          systemMessageType: m.systemMessageType ?? "",
          systemMetadata: m.systemMetadata ?? "",
          isPersonal: Boolean(m.isPersonal),
          senderName: m.senderName ?? "",
          senderAvatar: m.senderAvatar ?? "",
          attachmentsJson: m.attachmentsJson ?? "",
          reactionsJson: m.reactionsJson ?? "",
          quoteDataJson: m.quoteDataJson ?? "",
        })),
        nextCursor: res.nextCursor ?? "",
        hasMore: Boolean(res.hasMore),
        pinnedMessageJson: res.pinnedMessageJson ?? "",
      };
    },
  };
}

/** Lazily-created shared chat client (one gRPC channel per process). */
let cached: ChatClient | undefined;
export function getChatClient(): ChatClient {
  cached ??= createChatClient();
  return cached;
}
