import { logger } from "@aimess/logger";
import {
  BadRequestError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";

import {
  CHAT_EDIT_WINDOW_MS,
  CHAT_TEXT_MAX_CHARS,
  assertAttachmentsValid,
} from "../constants/media-limits.js";

import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { GeneralRoomMessage } from "../generated/prisma/index.js";
import { communityMessagePreview } from "../utils/community-message-preview.js";

/** Per-community chat summary for the GET /communities/mine enrichment. */
export interface CommunityChatSummary {
  communityId: string;
  unreadMessageCount: number;
  /** false => the caller should render lastMessageActivity as null. */
  hasLastMessage: boolean;
  lastMessage?: {
    username: string;
    message: string;
    /** epoch ms */
    dateTime: number;
  };
}

/** Denormalized last-message JSON stored on a GeneralRoom. */
interface RoomLastMessageJson {
  content?: string;
  senderId?: string;
  senderName?: string;
  messageType?: string;
  createdAt?: string | Date;
}

export class CommunityMessageService {
  constructor(
    private readonly messageRepo: GeneralRoomMessageRepository,
    private readonly roomRepo: GeneralRoomRepository,
    private readonly memberRepo: RoomMemberRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService
  ) {}

  async sendMessage(params: {
    roomId: string;
    sentBy: string;
    senderName: string;
    senderAvatar: string;
    message: string;
    messageType: string;
    parentMessageId?: string | null;
    clientMessageId?: string | null;
    attachments?: Array<Record<string, unknown>>;
  }): Promise<GeneralRoomMessage> {
    // Defensive caps (the gRPC/socket send path doesn't run the Zod validators).
    if ((params.message?.length ?? 0) > CHAT_TEXT_MAX_CHARS) {
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    }
    assertAttachmentsValid(params.messageType, params.attachments);

    // Check idempotency
    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.sentBy}:${params.clientMessageId}`;
      const cachedId = await this.cacheRepo.getMessageIdempotency(idemKey);
      if (cachedId) {
        const cached = await this.messageRepo.findById(cachedId);
        if (cached) return cached;
      }
      const existing = await this.messageRepo.findOne({
        roomId: params.roomId,
        sentBy: params.sentBy,
        clientMessageId: params.clientMessageId,
      });
      if (existing) {
        this.cacheRepo
          .setMessageIdempotency(idemKey, existing.id)
          .catch(() => {});
        return existing;
      }
    }

    const entity: Record<string, unknown> = {
      roomId: params.roomId,
      sentBy: params.sentBy,
      senderName: params.senderName,
      senderAvatar: params.senderAvatar,
      message: params.message || "",
      messageType: params.messageType || "text",
      parentMessageId: params.parentMessageId || null,
      clientMessageId: params.clientMessageId || null,
    };

    if (params.attachments?.length) {
      entity.attachments = params.attachments;
    }

    // If reply, attach quote data
    if (params.parentMessageId) {
      const originalMsg = await this.messageRepo.findById(
        params.parentMessageId
      );
      if (originalMsg) {
        entity.quoteData = {
          message: originalMsg.message,
          senderName: originalMsg.senderName,
        };
      }
    }

    let message: GeneralRoomMessage;
    try {
      message = await this.messageRepo.save(
        entity as Parameters<typeof this.messageRepo.save>[0]
      );
    } catch (err) {
      // P2002 = unique constraint violation from the sparse idempotency index
      const pe = err as { code?: string };
      if (pe?.code === "P2002" && params.clientMessageId) {
        const dup = await this.messageRepo.findOne({
          roomId: params.roomId,
          sentBy: params.sentBy,
          clientMessageId: params.clientMessageId,
        });
        if (dup) return dup;
      }
      throw err;
    }

    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.sentBy}:${params.clientMessageId}`;
      this.cacheRepo.setMessageIdempotency(idemKey, message.id).catch(() => {});
    }

    // Update room last message
    this.roomRepo
      .addLastestMessageToRoom(params.roomId, {
        _id: message.id,
        sentBy: message.sentBy,
        senderName: message.senderName || "",
        message: message.message || "",
        messageType: message.messageType,
        createdAt: message.createdAt,
      })
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|addLastestMessageToRoom failed: ${String(err)}`
        );
      });
    return message;
  }

  /**
   * Active member userIds for a community room — the recipient list for the
   * community list "bump-to-top" (`community:updated`) fan-out.
   */
  async getActiveMemberIds(roomId: string): Promise<string[]> {
    const members = await this.memberRepo.findActiveByRoom(roomId);
    return members.map((m) => m.userId);
  }

  /**
   * Bulk community-chat summaries for GET /communities/mine. For each requested
   * communityId (roomId === communityId): unread count + last-message preview,
   * but ONLY for communities the user is an ACTIVE member of (member-only
   * previews). Non-member communities get `unreadMessageCount: 0` +
   * `hasLastMessage: false`. Single bulk query per concern — no N+1.
   */
  async getChatSummaries(params: {
    userId: string;
    communityIds: string[];
  }): Promise<CommunityChatSummary[]> {
    const ids = [...new Set(params.communityIds.filter(Boolean))];
    if (!ids.length) return [];

    // 1. Active membership rows → member roomIds + per-room read threshold.
    const members = await this.memberRepo.findActiveByUserAndRooms(
      params.userId,
      ids
    );
    const readMap = new Map<string, Date | null>(
      members.map((m) => [m.roomId, m.lastReadAt])
    );
    const memberRoomIds = members.map((m) => m.roomId);

    // 2/3. In parallel: member rooms (lastMessage JSON) + bulk unread counts.
    const [rooms, unreadMap] = await Promise.all([
      this.roomRepo.findManyByIds(memberRoomIds),
      memberRoomIds.length
        ? this.messageRepo.countUnreadBulk({
            userId: params.userId,
            thresholds: memberRoomIds.map((roomId) => ({
              roomId,
              afterDate: readMap.get(roomId) ?? new Date(0),
            })),
          })
        : Promise.resolve<Record<string, number>>({}),
    ]);
    const roomById = new Map(rooms.map((r) => [r.id, r]));

    // 4. Build a summary for EVERY requested community.
    return ids.map((communityId) => {
      if (!readMap.has(communityId)) {
        // Not an active member → no preview, zero unread (member-only previews).
        return {
          communityId,
          unreadMessageCount: 0,
          hasLastMessage: false,
        };
      }

      const room = roomById.get(communityId);
      const last = (room?.lastMessage ?? null) as RoomLastMessageJson | null;
      const unreadMessageCount = unreadMap[communityId] ?? 0;

      if (!last || !last.createdAt) {
        return { communityId, unreadMessageCount, hasLastMessage: false };
      }

      const createdAt =
        last.createdAt instanceof Date
          ? last.createdAt
          : new Date(last.createdAt);

      return {
        communityId,
        unreadMessageCount,
        hasLastMessage: true,
        lastMessage: {
          username: last.senderName ?? "",
          message: communityMessagePreview({
            messageType: last.messageType,
            content: last.content,
          }),
          dateTime: Number.isNaN(createdAt.getTime()) ? 0 : createdAt.getTime(),
        },
      };
    });
  }

  async getMessages(params: {
    roomId: string;
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<GeneralRoomMessage[]> {
    const beforeTimestamp = params.cursor || new Date().toISOString();
    return this.messageRepo.findByRoomIdWithTime(
      params.roomId,
      beforeTimestamp,
      "older",
      params.limit,
      params.userId
    );
  }

  /**
   * Paginated conversation page for a community room + mark-as-read side effect.
   * Enforces active membership first (same check as listMedia), fetches the
   * offset page (createdAt < timestamp, newest first), then advances the
   * caller's read pointer to the newest returned message (forward-only).
   */
  async getConversation(params: {
    roomId: string;
    userId: string;
    pageNumber: number;
    limit: number;
    timestamp?: number;
  }): Promise<{ messages: GeneralRoomMessage[]; total: number }> {
    // Enforce active membership first (banned/left members can't read).
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");

    const beforeMs = params.timestamp ?? Date.now();
    const skip = (params.pageNumber - 1) * params.limit;

    const [messages, total] = await Promise.all([
      this.messageRepo.listConversationMessages({
        roomId: params.roomId,
        userId: params.userId,
        beforeMs,
        skip,
        take: params.limit,
      }),
      // Count must match the page's filter (createdAt < beforeMs + per-user
      // deletion exclusion), not the boundary-less countByRoom.
      this.messageRepo.countConversation({
        roomId: params.roomId,
        userId: params.userId,
        beforeMs,
      }),
    ]);

    // Mark-as-read: advance to the newest message in the page (index 0, since
    // the page is createdAt DESC). Forward-only; skip when the page is empty.
    const newest = messages[0];
    if (newest) {
      await this.memberRepo
        .advanceReadPointer(
          params.roomId,
          params.userId,
          newest.id,
          newest.createdAt
        )
        .catch((err: unknown) => {
          logger.warn(
            `CommunityMessageService|getConversation|advanceReadPointer failed: ${String(err)}`
          );
        });
    }

    return { messages, total };
  }

  async searchMessages(params: {
    roomId: string;
    userId: string;
    query: string;
    limit: number;
  }): Promise<GeneralRoomMessage[]> {
    return this.messageRepo.searchByText(
      params.roomId,
      params.query,
      params.limit,
      params.userId
    );
  }

  async countMessages(roomId: string): Promise<number> {
    return this.messageRepo.countByRoom(roomId);
  }

  async countSearchResults(roomId: string, query: string): Promise<number> {
    return this.messageRepo.countSearchResults(roomId, query);
  }

  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<GeneralRoomMessage[]> {
    // Enforce active membership first (banned/left members can't list media).
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");

    return this.messageRepo.listMedia({
      roomId: params.roomId,
      userId: params.userId,
      type: params.type,
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  async editMessage(params: {
    messageId: string;
    userId: string;
    content: { text: string };
  }): Promise<GeneralRoomMessage> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (message.sentBy !== params.userId)
      throw new BadRequestError("CHAT_EDIT_OWN_MESSAGES_ONLY");
    if (message.messageType !== "text")
      throw new BadRequestError("CHAT_EDIT_TEXT_ONLY");
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS)
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    if (Date.now() - message.createdAt.getTime() > CHAT_EDIT_WINDOW_MS)
      throw new GoneError("CHAT_EDIT_WINDOW_EXPIRED");
    return this.messageRepo.editMessage(params.messageId, params.content.text);
  }

  async react(
    messageId: string,
    reactions: Record<string, unknown[]>
  ): Promise<GeneralRoomMessage | null> {
    return this.messageRepo.updateById("", messageId, reactions);
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    await this.messageRepo.deleteForUser(messageId, userId);
    return this.messageRepo.findById(messageId);
  }

  async deleteForAll(
    messageId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // Sender can always delete their own message for everyone.
    // Others need admin or moderator role.
    if (message.sentBy !== userId) {
      const member = await this.memberRepo.findByRoomAndUser(
        message.roomId,
        userId
      );
      if (!member || !["admin", "moderator"].includes(member.role)) {
        throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
      }
    }

    return this.messageRepo.deleteForAll(messageId);
  }

  async report(params: {
    messageId: string;
    reporterId: string;
    reportReason: string;
  }): Promise<GeneralRoomMessage | null> {
    return this.messageRepo.addReport(params.messageId, {
      userReportId: params.reporterId,
      userReportReason: params.reportReason,
    });
  }
}
