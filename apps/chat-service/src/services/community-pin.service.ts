import { BadRequestError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { normalizeMessageType } from "../lib/chat-message.serializer.js";
import {
  assertCommunityMember,
  assertCommunityRoomWritable,
} from "../lib/access-guard.js";
import { resolvePinsMedia } from "../lib/media-resolve.js";
import type { CommunityMessagePinRepository } from "../repositories/community-message-pin.repository.js";
import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CommunityMessagePin } from "../generated/prisma/index.js";
import type { CommunitySystemMessageService } from "./community-system-message.service.js";

/** How many active pins one community room may have at a time. */
const PIN_LIMIT_PER_ROOM = 1;

export class CommunityPinService {
  constructor(
    private readonly pinRepo: CommunityMessagePinRepository,
    private readonly messageRepo: GeneralRoomMessageRepository,
    private readonly roomRepo: GeneralRoomRepository,
    private readonly memberRepo: RoomMemberRepository,
    private readonly systemMessageService?: CommunitySystemMessageService
  ) {}

  async pin(params: {
    roomId: string;
    messageId: string;
    userId: string;
    communityId: string;
  }): Promise<{ pin: CommunityMessagePin; pinnedCount: number }> {
    const { roomId, messageId, userId, communityId } = params;

    // 1. Assert ADMIN or MODERATOR role (throws CHAT_NOT_A_MEMBER / CHAT_INSUFFICIENT_PERMISSIONS)
    await assertCommunityMember(this.memberRepo, roomId, userId, {
      roles: ["admin", "moderator"],
    });

    // 2. Load room and assert writable (not closed / suspended)
    const room = await this.roomRepo.findRoomById(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    assertCommunityRoomWritable(room);

    const communityName: string =
      typeof room.name === "string" && room.name ? room.name : "Community";

    // 3. Enforce single-active-pin limit (service-level; MongoDB partial unique
    //    indexes are not available in Prisma — enforced here instead).
    const activePins = await this.pinRepo.countActivePinsByRoom(roomId);
    if (activePins >= PIN_LIMIT_PER_ROOM) {
      throw new BadRequestError("ACTIVE_PIN_ALREADY_EXISTS");
    }

    // 4. Validate the message to pin
    const msg = await this.messageRepo.findById(messageId);
    if (!msg || msg.roomId !== roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (msg.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (normalizeMessageType(msg.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    // 5. Persist pin record
    const pin = await this.pinRepo.createPin({
      communityId,
      roomId,
      messageId: msg.id,
      pinnedBy: userId,
      pinnedAt: new Date(),
      messageCreatedAt: msg.createdAt,
      senderId: msg.sentBy ?? "",
      senderDisplayName: msg.senderName ?? "",
      senderAvatar: msg.senderAvatar ?? "",
      contentPinned: {
        text: msg.message ?? "",
        urls: [],
        files: [],
      },
    });

    const updated = await this.roomRepo.incPinnedCount(roomId, 1);
    const pinnedCount = updated?.pinnedCount ?? activePins + 1;

    // 6. Create PINNED_MESSAGE system line (best-effort).
    //    "eventAt" is scoped to this pin's ID so a retry doesn't duplicate the line.
    //    communityName drives the text: "{CommunityName} pinned a message".
    const eventAt = `pin:${pin.id}`;
    const sysMessageId = await this.systemMessageService
      ?.postReturnId({
        communityId,
        systemMessageType: "PINNED_MESSAGE",
        metadata: {
          pinnedMessageId: messageId,
          communityName,
          pinId: pin.id,
        },
        triggeredByUserId: userId,
        eventAt,
      })
      .catch((err: unknown) => {
        logger.warn(`CommunityPinService|postReturnId failed: ${String(err)}`);
        return null;
      });

    // 7. Store back-reference (best-effort)
    if (sysMessageId) {
      void this.pinRepo
        .setPinSystemMessageId(pin.id, sysMessageId)
        .catch((err: unknown) => {
          logger.warn(
            `CommunityPinService|setPinSystemMessageId failed: ${String(err)}`
          );
        });
    }

    return { pin, pinnedCount };
  }

  async unpin(params: {
    roomId: string;
    messageId: string;
    userId: string;
  }): Promise<{ pin: CommunityMessagePin | null; pinnedCount: number }> {
    const { roomId, messageId, userId } = params;

    // 1. Assert ADMIN or MODERATOR role
    await assertCommunityMember(this.memberRepo, roomId, userId, {
      roles: ["admin", "moderator"],
    });

    // 2. Find the active pin for this message
    const activePinForMessage =
      await this.pinRepo.findActivePinByMessageId(messageId);
    if (!activePinForMessage || activePinForMessage.roomId !== roomId)
      throw new NotFoundError("CHAT_PIN_NOT_FOUND");

    // 3. Soft-delete: set unpinnedAt (history preserved, no UNPINNED_MESSAGE system msg)
    const unpinnedPin = await this.pinRepo.softDeletePin(
      activePinForMessage.id,
      userId,
      new Date()
    );

    const updated = await this.roomRepo.incPinnedCount(roomId, -1);
    const pinnedCount = updated?.pinnedCount ?? 0;

    // NOTE: No UNPINNED_MESSAGE system message (product requirement).

    return { pin: unpinnedPin, pinnedCount };
  }

  /**
   * Called from deleteForAll / controller deleteMessage when a message is
   * hard-deleted. Marks the active pin as unavailable and returns it so the
   * caller can emit a community:message:pinned update event.
   */
  async handleMessageDeleted(
    messageId: string
  ): Promise<CommunityMessagePin | null> {
    const now = new Date();
    const updated = await this.pinRepo.markPinnedMessageDeleted(messageId, now);
    return updated[0] ?? null;
  }

  async list(
    roomId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<CommunityMessagePin[]> {
    const pins = await this.pinRepo.findPinsByRoom(roomId, params);
    return resolvePinsMedia(pins);
  }

  async countPins(roomId: string): Promise<number> {
    return this.pinRepo.countActivePinsByRoom(roomId);
  }
}
