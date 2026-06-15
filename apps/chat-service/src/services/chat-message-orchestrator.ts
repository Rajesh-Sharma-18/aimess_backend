import { randomUUID } from "node:crypto";

import { logger } from "@aimess/logger";

import type { Redis, Cluster } from "ioredis";

import { publishCommunityActivitySafe } from "../events/publish-community-activity.js";
import {
  publishConvUpdatedSafe,
  publishCommunityUpdatedSafe,
} from "../events/publish-conv-updated.js";
import {
  publishMessageSentSafe,
  buildPushPreview,
  buildMessagePreview,
} from "../events/publish-message-sent.js";
import {
  buildChatMessageEvent,
  buildCanonicalQuote,
  normalizeMessageType,
} from "../lib/chat-message.serializer.js";
import {
  resolveMediaUrl,
  resolveContentFiles,
  type MediaFileLike,
} from "../lib/media-resolve.js";
import { isIdempotentReplay } from "../lib/idempotency.js";

import type { PrivateMessageService } from "./private-message.service.js";
import type { GroupMessageService } from "./group-message.service.js";
import type { GroupMemberService } from "./group-member.service.js";
import type { CommunityMessageService } from "./community-message.service.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";

/**
 * Structured message content as it travels through the send path: the body text
 * plus optional attachment arrays / structured extras. Mirrors the shape the
 * private/group `*MessageService.sendMessage` persist (and the socket/gRPC
 * senders build), so the orchestrator can both forward it to the service and
 * resolve-on-read its attachment keys for the live broadcast.
 */
export interface OrchestratorContent {
  text: string;
  urls?: string[];
  files?: Array<Record<string, unknown>>;
  location?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  sticker?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SendDirectParams {
  conversationType: "PRIVATE" | "GROUP";
  roomId: string;
  senderId: string;
  /** Required for PRIVATE (the peer); ignored for GROUP. */
  receiverId?: string;
  /** Sender display name; resolved from the user snapshot when omitted. */
  senderName?: string;
  /** Sender avatar object-key/URL; resolved from the user snapshot when omitted. */
  senderAvatar?: string;
  content: OrchestratorContent;
  messageType: string;
  parentMessageId?: string | null;
  /** Idempotency key; defaulted to a fresh UUID when omitted. */
  clientMessageId?: string | null;
  /** Client compose time (epoch ms) — display only; never overwrites serverTs. */
  clientTs?: number | null;
}

export interface SendDirectResult {
  messageId: string;
  /** epoch ms server-authoritative time. */
  sentAt: number;
  /** True when the service collapsed this onto a pre-existing message (replay). */
  alreadySent: boolean;
  sequenceNumber: number;
  /** Canonical wire event — byte-identical to the socket `message:new` payload. */
  message: Record<string, unknown>;
}

export interface SendCommunityParams {
  /** community-service Community.id — used for the broadcast + activity bump. */
  communityId: string;
  /** chat-service GeneralRoom.id — used for the message persist. */
  roomId: string;
  senderId: string;
  /** Sender display name; resolved from the user snapshot when omitted. */
  senderName?: string;
  /** Sender avatar object-key/URL; resolved from the user snapshot when omitted. */
  senderAvatar?: string;
  message: string;
  messageType: string;
  parentMessageId?: string | null;
  /** Idempotency key; defaulted to a fresh UUID when omitted. */
  clientMessageId?: string | null;
  attachments?: Array<Record<string, unknown>>;
}

export interface SendCommunityResult {
  messageId: string;
  roomId: string;
  /** epoch ms server-authoritative time. */
  sentAt: number;
  /** True when the service collapsed this onto a pre-existing message (replay). */
  alreadySent: boolean;
  sequenceNumber: number;
  /** Canonical wire event — byte-identical to the socket `community:message:new`. */
  message: Record<string, unknown>;
}

export interface MarkReadDirectParams {
  conversationType: "PRIVATE" | "GROUP";
  roomId: string;
  readerId: string;
  /** Highest message id the reader has now seen (read high-water mark). */
  upToMessageId: string;
}

export interface MarkReadDirectResult {
  /** The `sequenceNumber` of `upToMessageId` (read_to_seq high-water mark); 0 if missing. */
  readToSeq: number;
}

/**
 * Single owner of message SEND for every conversation kind. Wraps the per-kind
 * CRUD service (`*MessageService.sendMessage`) with the identical post-write
 * side-effects the gRPC handlers perform — Redis `message:new` /
 * `community:message:new` broadcast, inbox/community `*:updated` bump, and the
 * FCM push trigger — so both transports (gRPC today, REST now) route effects
 * through ONE place instead of duplicating them. Effects are fire-and-forget
 * exactly where the gRPC code is: a bump/push/activity failure can never reject
 * the send (the message is already persisted).
 */
export class ChatMessageOrchestrator {
  constructor(
    private readonly privateMessageService: PrivateMessageService,
    private readonly groupMessageService: GroupMessageService,
    private readonly groupMemberService: GroupMemberService,
    private readonly communityMessageService: CommunityMessageService,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly cacheRepo: CacheRepository,
    private readonly redis: Redis | Cluster
  ) {}

  /**
   * Send a PRIVATE or GROUP message and run its effects. Authorization
   * (friendship gate for private, active-membership for group) and idempotency
   * (clientMessageId + unique index) are enforced INSIDE the called service —
   * not duplicated here.
   */
  async sendDirect(params: SendDirectParams): Promise<SendDirectResult> {
    const conversationType: "PRIVATE" | "GROUP" =
      params.conversationType === "GROUP" ? "GROUP" : "PRIVATE";
    const clientMessageId = params.clientMessageId || randomUUID();
    const clientTs = params.clientTs ?? 0;

    // Resolve the sender's display identity once (used by the broadcast + push)
    // when the caller did not supply it — keeps identity resolution in one place.
    const { senderName, senderAvatar } = await this.resolveSenderIdentity(
      params.senderId,
      params.senderName,
      params.senderAvatar
    );

    let msg: {
      id: string;
      messageType: string;
      content: unknown;
      createdAt: unknown;
      sequenceNumber: number;
      senderRole?: string;
    };

    if (conversationType === "GROUP") {
      msg = await this.groupMessageService.sendMessage({
        roomId: params.roomId,
        senderId: params.senderId,
        senderName,
        senderAvatar,
        content: params.content,
        messageType: params.messageType || "TEXT",
        parentMessageId: params.parentMessageId ?? null,
        clientMessageId,
        clientTs,
      });
    } else {
      msg = await this.privateMessageService.sendMessage({
        roomId: params.roomId,
        senderId: params.senderId,
        receiverId: params.receiverId ?? "",
        content: params.content,
        messageType: params.messageType || "TEXT",
        parentMessageId: params.parentMessageId ?? null,
        clientMessageId,
        clientTs,
      });
    }

    const serverTs =
      msg.createdAt instanceof Date ? msg.createdAt.getTime() : Date.now();
    const full = msg as Record<string, unknown>;

    // Detect an idempotency replay via the authoritative marker the service set
    // when it returned a PRE-EXISTING row for a repeated clientMessageId (a
    // pre-send dedup hit or a duplicate-key collapse). Mirrors the gRPC
    // sendMessage handler — the time-window heuristic was unreliable. On a replay
    // the row's FIRST send already broadcast/bumped/pushed, so all three live
    // effects must be suppressed (re-running them duplicates the bubble + bump).
    const alreadySent = isIdempotentReplay(msg);

    // Resolve-on-read: raw avatar/attachment object-keys → presigned URLs for the
    // returned/broadcast wire object only (the stored snapshot keeps raw keys).
    // Built UNCONDITIONALLY — the controller returns this canonical wire event
    // even on a replay (the client still gets the message it sent).
    const [bcastAvatar, bcastContent] = await Promise.all([
      resolveMediaUrl(senderAvatar || ""),
      this.resolveBroadcastContent(msg.content ?? null),
    ]);
    const wireEvent = buildChatMessageEvent({
      id: msg.id,
      clientMessageId,
      roomId: params.roomId,
      conversationType,
      senderId: params.senderId,
      senderName,
      senderAvatar: bcastAvatar,
      senderRole: msg.senderRole,
      receiverId: params.receiverId,
      messageType: msg.messageType,
      content: bcastContent ?? null,
      parentMessageId: (full.parentMessageId as string) || "",
      quoteData: full.quoteData ?? null,
      reactions: [],
      clientTs,
      serverTs,
      sequenceNumber: msg.sequenceNumber,
    });

    if (!alreadySent) {
      // ── 1. Live broadcast: message:new on conv:<roomId> ──────────────────
      await this.redis.publish(
        `conv:${params.roomId}`,
        JSON.stringify({ event: "message:new", data: wireEvent })
      );

      // ── 2. Bump-to-top: conv:updated fan-out (fire-and-forget) ───────────
      const bumpBase = {
        redis: this.redis,
        type: conversationType,
        roomId: params.roomId,
        senderId: params.senderId,
        lastMessageId: msg.id,
        lastMessageAt: serverTs,
        preview: {
          contentType: normalizeMessageType(msg.messageType),
          text: buildMessagePreview(msg.messageType, msg.content),
        },
      };
      if (conversationType === "GROUP") {
        publishConvUpdatedSafe({
          ...bumpBase,
          fetchRecipients: () =>
            this.groupMessageService.getActiveMemberIds(params.roomId),
        });
      } else {
        publishConvUpdatedSafe({
          ...bumpBase,
          recipientIds: [params.senderId, params.receiverId ?? ""],
        });
      }

      // ── 3. FCM/APNs push (fire-and-forget) ───────────────────────────────
      const pushText =
        ((msg.content as Record<string, unknown>)?.text as string) ?? "";
      const pushBase = {
        conversationId: params.roomId,
        conversationType,
        messageId: msg.id,
        clientMessageId,
        senderId: params.senderId,
        senderName: senderName || "",
        senderAvatar: senderAvatar || "",
        preview: buildPushPreview(msg.messageType, pushText),
        messageType: msg.messageType,
        sentAt: serverTs,
      };
      if (conversationType === "GROUP") {
        publishMessageSentSafe({
          ...pushBase,
          fetchRecipients: () =>
            this.groupMessageService.getActiveMemberIds(params.roomId),
        });
      } else {
        publishMessageSentSafe({
          ...pushBase,
          recipientIds: [params.receiverId ?? ""],
        });
      }
    }

    return {
      messageId: msg.id,
      sentAt: serverTs,
      alreadySent,
      sequenceNumber: msg.sequenceNumber,
      message: wireEvent,
    };
  }

  /**
   * Send a COMMUNITY message and run its effects: `community:message:new`
   * broadcast on community:<communityId>, the community-activity denormalization
   * for GET /communities/mine, and the `community:updated` bump fan-out. Active
   * membership + suspended-room guards are enforced INSIDE the service.
   */
  async sendCommunity(
    params: SendCommunityParams
  ): Promise<SendCommunityResult> {
    const clientMessageId = params.clientMessageId || randomUUID();

    const { senderName, senderAvatar } = await this.resolveSenderIdentity(
      params.senderId,
      params.senderName,
      params.senderAvatar
    );

    const saved = await this.communityMessageService.sendMessage({
      roomId: params.roomId,
      sentBy: params.senderId,
      senderName,
      senderAvatar,
      message: params.message || "",
      messageType: (params.messageType || "TEXT").toUpperCase(),
      parentMessageId: params.parentMessageId ?? null,
      clientMessageId,
      attachments: params.attachments,
    });

    const sentAt =
      saved.createdAt instanceof Date ? saved.createdAt.getTime() : Date.now();

    // Idempotency replay: the service tagged the returned row when a repeated
    // clientMessageId collapsed onto a pre-existing message. Suppress all live
    // effects (broadcast, activity denormalization, bump) on a replay — the
    // row's FIRST send already ran them. Same marker the private/group path uses.
    const alreadySent = isIdempotentReplay(saved);

    // Resolve-on-read for the live push: sender avatar + attachment keys → full
    // presigned URLs (the stored snapshot keeps the raw keys).
    const files = Array.isArray(params.attachments) ? params.attachments : [];
    const location = this.firstAttachmentOfType(params.attachments, "location");
    const contact = this.firstAttachmentOfType(params.attachments, "contact");
    const sticker = this.firstAttachmentOfType(params.attachments, "sticker");
    const [bcastSenderAvatar, bcastFiles] = await Promise.all([
      resolveMediaUrl(senderAvatar || ""),
      resolveContentFiles(files as MediaFileLike[]),
    ]);

    const wireEvent: Record<string, unknown> = {
      // V2 canonical fields (mirror grpc sendCommunityMessage).
      id: saved.id,
      messageId: saved.id,
      communityId: params.communityId,
      roomId: saved.roomId,
      senderId: saved.sentBy,
      senderName,
      senderAvatar: bcastSenderAvatar,
      parentMessageId: saved.parentMessageId ?? "",
      quoteData: buildCanonicalQuote(saved.quoteData),
      content: {
        text: saved.message ?? "",
        files: bcastFiles,
        ...(location ? { location } : {}),
        ...(contact ? { contact } : {}),
        ...(sticker ? { sticker } : {}),
      },
      reactions: [],
      message: saved.message ?? "",
      contentType: normalizeMessageType(saved.messageType),
      clientMessageId,
      serverTs: sentAt,
      sentAt,
      // The community gRPC handler predates per-room sequencing; the field now
      // exists, so include it for parity with private/group broadcasts.
      sequenceNumber: saved.sequenceNumber,
    };

    if (!alreadySent) {
      await this.redis.publish(
        `community:${params.communityId}`,
        JSON.stringify({ event: "community:message:new", data: wireEvent })
      );

      // Denormalize activity to community-service (orders GET /communities/mine).
      // Keyed by communityId (Community.id), NOT roomId (GeneralRoom.id).
      if (params.communityId) {
        const messageText = saved.message ?? "";
        publishCommunityActivitySafe({
          communityId: params.communityId,
          lastMessageAt:
            saved.createdAt instanceof Date
              ? saved.createdAt.toISOString()
              : new Date(sentAt).toISOString(),
          lastMessageId: saved.id,
          senderUserId: params.senderId,
          senderUsername: senderName,
          messagePreview:
            messageText.length > 80 ? messageText.slice(0, 80) : messageText,
        });
      }

      // Bump-to-top: community:updated fan-out (fire-and-forget).
      publishCommunityUpdatedSafe({
        redis: this.redis,
        communityId: params.communityId,
        roomId: saved.roomId,
        fetchMembers: () =>
          this.communityMessageService.getActiveMemberIds(params.roomId),
        senderId: params.senderId,
        lastMessageId: saved.id,
        lastMessageAt: sentAt,
        preview: {
          contentType: normalizeMessageType(saved.messageType),
          text: buildMessagePreview(saved.messageType, {
            text: saved.message ?? "",
            files,
            ...(location ? { location } : {}),
            ...(contact ? { contact } : {}),
          }),
        },
      });
    }

    return {
      messageId: saved.id,
      roomId: saved.roomId,
      sentAt,
      alreadySent,
      sequenceNumber: saved.sequenceNumber,
      message: wireEvent,
    };
  }

  /**
   * Mark a PRIVATE or GROUP conversation read up to `upToMessageId` and run the
   * identical post-write effects the gRPC `markMessagesRead` handler performs:
   *   1. advance the reader's read high-water mark (private room read pointer or
   *      group-member read pointer);
   *   2. resolve the `read_to_seq` from the message's per-room sequenceNumber;
   *   3. broadcast `message:read` to conv:<roomId> (the other participant(s));
   *   4. fan out `read_sync` to user:<readerId> so the reader's OTHER devices
   *      clear their unread badge (fire-and-forget).
   * Mirrors the gRPC handler exactly so the REST and gRPC read paths produce the
   * SAME side-effects through ONE code path. (Community read is coarser and has
   * no socket broadcast today, so it intentionally does NOT route through here —
   * the community controller calls communityMessageService.bulkMarkRead directly.)
   */
  async markReadDirect(
    params: MarkReadDirectParams
  ): Promise<MarkReadDirectResult> {
    const conversationType: "PRIVATE" | "GROUP" =
      params.conversationType === "GROUP" ? "GROUP" : "PRIVATE";

    // Assigned in both branches below before it's read — no initializer needed.
    let readToSeq: number;
    if (conversationType === "GROUP") {
      await this.groupMemberService.markRead({
        roomId: params.roomId,
        userId: params.readerId,
        lastMessageId: params.upToMessageId,
      });
      readToSeq = await this.groupMessageService
        .getMessageSequence(params.upToMessageId)
        .catch(() => 0);
    } else {
      await this.privateMessageService.markRead({
        roomId: params.roomId,
        userId: params.readerId,
        lastMessageId: params.upToMessageId,
      });
      readToSeq = await this.privateMessageService
        .getMessageSequence(params.upToMessageId)
        .catch(() => 0);
    }

    // Read receipt to the conversation room (the other participant(s)).
    await this.redis.publish(
      `conv:${params.roomId}`,
      JSON.stringify({
        event: "message:read",
        data: {
          conversationId: params.roomId,
          readerId: params.readerId,
          upToMessageId: params.upToMessageId,
        },
      })
    );

    // read_sync to the reader's OWN other devices so their unread badge clears
    // too. Published to user:<readerId> (every device of that user joins this
    // room on connect). Fire-and-forget — never blocks/rejects the read.
    void this.redis
      .publish(
        `user:${params.readerId}`,
        JSON.stringify({
          event: "read_sync",
          data: {
            conversationId: params.roomId,
            readerId: params.readerId,
            read_to_seq: readToSeq,
            unreadCount: 0,
            conversationType,
          },
        })
      )
      .catch((e: unknown) =>
        logger.warn(`read_sync publish failed: ${String(e)}`)
      );

    return { readToSeq };
  }

  /**
   * Resolve a sender's display name + avatar from the user snapshot when the
   * caller did not already supply them. The snapshot keeps the RAW avatar object
   * key — callers/broadcasts resolve it to a download URL at the read boundary.
   * Best-effort: a snapshot miss yields empty strings (never throws).
   */
  private async resolveSenderIdentity(
    senderId: string,
    senderName?: string,
    senderAvatar?: string
  ): Promise<{ senderName: string; senderAvatar: string }> {
    if (senderName !== undefined && senderAvatar !== undefined) {
      return { senderName, senderAvatar };
    }
    const snaps = await this.userSnapshotService.getUserSnapshotsMap(
      [senderId],
      this.cacheRepo
    );
    const snap = snaps.get(senderId);
    return {
      senderName: senderName ?? ((snap?.displayName as string) || ""),
      senderAvatar: senderAvatar ?? ((snap?.avatar as string) || ""),
    };
  }

  /**
   * Resolve attachment object-keys inside a message `content` blob to full,
   * presigned download URLs for a realtime broadcast. Resolve-on-read at the
   * publish boundary — the stored content keeps the raw object keys (presigned
   * URLs expire, so a resolved URL must never be persisted). Mirrors the gRPC
   * service-impl helper of the same name.
   */
  private async resolveBroadcastContent(content: unknown): Promise<unknown> {
    if (!content || typeof content !== "object") return content;
    const c = content as Record<string, unknown>;
    if (Array.isArray(c.files) && c.files.length > 0) {
      try {
        return {
          ...c,
          files: await resolveContentFiles(c.files as MediaFileLike[]),
        };
      } catch (err) {
        logger.warn(
          `ChatMessageOrchestrator|resolveBroadcastContent failed: ${String(err)}`
        );
        return content;
      }
    }
    return content;
  }

  /**
   * Pick the first attachment of a given structured `type` (location / contact /
   * sticker) from a community attachments array, returning it without the `type`
   * discriminator so the broadcast/preview shape matches the gRPC handler's
   * `parsed.location` / `parsed.contact` / `parsed.sticker` blobs.
   */
  private firstAttachmentOfType(
    attachments: Array<Record<string, unknown>> | undefined,
    type: string
  ): Record<string, unknown> | undefined {
    if (!Array.isArray(attachments)) return undefined;
    const hit = attachments.find(
      (a) => a && (a as { type?: string }).type === type
    );
    if (!hit) return undefined;
    const { type: _omit, ...rest } = hit as { type?: string } & Record<
      string,
      unknown
    >;
    void _omit;
    return rest;
  }
}
