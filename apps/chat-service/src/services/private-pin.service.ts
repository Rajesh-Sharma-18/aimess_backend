import { BadRequestError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { resolvePinsMedia, type MediaFileLike } from "../lib/media-resolve.js";
import { SystemEvent } from "../types/enums.js";
import type { PrivateMessagePinRepository } from "../repositories/private-message-pin.repository.js";
import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { PrivateSystemMessageService } from "./private-system-message.service.js";
import type { PinnedMessageSummary } from "./community-pin.service.js";
import type { PrivateMessagePin } from "../generated/prisma/index.js";

/**
 * Parity with `CommunityPinService`: only ONE active pin may exist per room at
 * a time. Pinning a second message atomically replaces the first (soft-delete
 * + create in a single transaction) instead of Private's old "up to N
 * simultaneous pins" model. A system message is posted only on pin (never on
 * unpin/replace — the original pin's line is retracted instead), matching
 * Community's documented product requirement.
 */
export class PrivatePinService {
  constructor(
    private readonly pinRepo: PrivateMessagePinRepository,
    private readonly messageRepo: PrivateMessageRepository,
    private readonly roomRepo: PrivateRoomRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly sysMsg: PrivateSystemMessageService
  ) {}

  /** The other participant — private rooms only ever have two. */
  private peerOf(participants: unknown, userId: string): string {
    const list = Array.isArray(participants) ? (participants as string[]) : [];
    return list.find((id) => id !== userId) ?? "";
  }

  async pin(params: {
    roomId: string;
    messageId: string;
    userId: string;
  }): Promise<{
    pin: PrivateMessagePin;
    pinnedCount: number;
    replacedPin?: PrivateMessagePin | null;
    idempotent?: boolean;
  }> {
    const { roomId, messageId, userId } = params;

    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    if (!room.participants?.includes(userId)) {
      throw new BadRequestError("CHAT_NOT_A_PARTICIPANT");
    }

    const msg = await this.messageRepo.findMessageMeta({ roomId, messageId });
    if (!msg) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // Only one pinned message may exist per room. Find the current active pin
    // (if any) instead of hard-blocking on a count cap.
    const currentActivePin = await this.pinRepo.findActivePinByRoom(roomId);

    // Re-pinning the message that's already active is a no-op success.
    if (currentActivePin && currentActivePin.messageId === msg.id) {
      return {
        pin: currentActivePin,
        pinnedCount: room.pinnedCount ?? 1,
        replacedPin: null,
        idempotent: true,
      };
    }

    const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
      [msg.senderId || ""],
      this.cacheRepo
    );
    const senderSnap = (snapshots.get(msg.senderId || "") || {}) as Record<
      string,
      unknown
    >;

    // Switch (or first-pin) atomically: soft-delete the previous active pin
    // (if any) and create the new one in a single transaction.
    const { pin, replacedPin, pinnedCount } = await this.pinRepo.runTransaction(
      async (tx) => {
        let replaced: PrivateMessagePin | null = null;
        if (currentActivePin) {
          replaced = await this.pinRepo.softDeletePin(
            currentActivePin.id,
            userId,
            new Date(),
            tx
          );
          if (!replaced) {
            throw new Error(
              `PrivatePinService|switch: failed to soft-delete previous pin ${currentActivePin.id}`
            );
          }
          await this.roomRepo.incPinnedCount(roomId, -1, tx);
        }

        const created = await this.pinRepo.createPin(
          {
            roomId,
            messageId: msg.id,
            pinnedBy: userId,
            pinnedAt: new Date(),
            messageCreatedAt: msg.createdAt,
            contentPinned: msg.content as object,
            senderId: msg.senderId || "",
            senderDisplayName: (senderSnap.displayName as string) || "",
            senderAvatar: (senderSnap.avatar as string) || "",
          },
          tx
        );
        const updatedRoom = await this.roomRepo.incPinnedCount(roomId, 1, tx);

        return {
          pin: created,
          replacedPin: replaced,
          pinnedCount: updatedRoom?.pinnedCount ?? 1,
        };
      }
    );

    // Switching pins: the previous pin's "pinned a message" system line is
    // now stale — retract it (best-effort), independent of the new line below.
    if (replacedPin?.pinSystemMessageId) {
      await this.sysMsg.retractSystemMessage({
        roomId,
        messageId: replacedPin.pinSystemMessageId,
        actorId: userId,
      });
    }

    const sysMessageId = await this.sysMsg
      .postReturnId({
        roomId,
        actorId: userId,
        peerId: this.peerOf(room.participants, userId),
        systemEvent: SystemEvent.MESSAGE_PINNED,
        systemData: { messageId },
      })
      .catch((err: unknown) => {
        logger.warn(`PrivatePinService|postReturnId failed: ${String(err)}`);
        return null;
      });

    if (sysMessageId) {
      await this.pinRepo
        .setPinSystemMessageId(pin.id, sysMessageId)
        .then(() => {
          pin.pinSystemMessageId = sysMessageId;
        })
        .catch((err: unknown) => {
          logger.warn(
            `PrivatePinService|setPinSystemMessageId failed: ${String(err)}`
          );
        });
    }

    return { pin, pinnedCount, replacedPin, idempotent: false };
  }

  async unpin(params: {
    roomId: string;
    messageId: string;
    userId: string;
  }): Promise<{
    pin: PrivateMessagePin | null;
    pinnedCount: number;
    retractedSystemMessageId?: string | null;
  }> {
    const { roomId, messageId, userId } = params;

    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    // Either participant may unpin — matches Community's "any qualifying
    // role" model (not restricted to whoever originally pinned it).
    if (!room.participants?.includes(userId)) {
      throw new BadRequestError("CHAT_NOT_A_PARTICIPANT");
    }

    const activePinForMessage =
      await this.pinRepo.findActivePinByMessageId(messageId);
    if (!activePinForMessage || activePinForMessage.roomId !== roomId)
      throw new NotFoundError("CHAT_PIN_NOT_FOUND");

    const unpinnedPin = await this.pinRepo.softDeletePin(
      activePinForMessage.id,
      userId,
      new Date()
    );

    const updated = await this.roomRepo.incPinnedCount(roomId, -1);
    const pinnedCount = updated?.pinnedCount ?? 0;

    // No UNPINNED_MESSAGE system message (parity with Community). The original
    // "pinned a message" line must be retracted now so it doesn't linger.
    const retractedSystemMessageId =
      activePinForMessage.pinSystemMessageId ?? null;
    if (retractedSystemMessageId) {
      await this.sysMsg.retractSystemMessage({
        roomId,
        messageId: retractedSystemMessageId,
        actorId: userId,
      });
    }

    return { pin: unpinnedPin, pinnedCount, retractedSystemMessageId };
  }

  /**
   * Called when a participant deletes the conversation (deleteForMe). The
   * active pin belongs to the room, not either user, so it must be cleared
   * regardless of who pinned it — otherwise it resurfaces once the room
   * becomes visible again (e.g. a new message arrives after the delete).
   * Best-effort by design: the caller must not fail the delete over this.
   */
  async clearActivePin(
    roomId: string,
    actorId: string
  ): Promise<PrivateMessagePin | null> {
    const activePin = await this.pinRepo.findActivePinByRoom(roomId);
    if (!activePin) return null;

    const cleared = await this.pinRepo.softDeletePin(
      activePin.id,
      actorId,
      new Date()
    );
    await this.roomRepo.incPinnedCount(roomId, -1);

    if (activePin.pinSystemMessageId) {
      await this.sysMsg
        .retractSystemMessage({
          roomId,
          messageId: activePin.pinSystemMessageId,
          actorId,
        })
        .catch(() => {});
    }

    return cleared;
  }

  /**
   * Called when a message is hard-deleted. Marks the active pin (if any)
   * unavailable and returns it so the caller can emit a pin:updated event.
   */
  async handleMessageDeleted(
    messageId: string
  ): Promise<PrivateMessagePin | null> {
    const updated = await this.pinRepo.markPinnedMessageDeleted(
      messageId,
      new Date()
    );
    return updated[0] ?? null;
  }

  async list(
    roomId: string,
    userId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<Array<PrivateMessagePin & { isAvailable: boolean }>> {
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    if (!room.participants?.includes(userId)) {
      throw new BadRequestError("CHAT_NOT_A_PARTICIPANT");
    }

    const pins = await this.pinRepo.findPinsByRoom(roomId, params);
    const resolved = await resolvePinsMedia(pins);
    const liveIds = await this.messageRepo.findLiveIds(
      roomId,
      resolved.map((p) => p.messageId)
    );
    return resolved.map((pin) => ({
      ...pin,
      isAvailable: liveIds.has(pin.messageId) && !pin.originalMessageDeletedAt,
    }));
  }

  async countPins(roomId: string): Promise<number> {
    return this.pinRepo.countActivePinsByRoom(roomId);
  }

  /**
   * The room's currently active pinned message, in the SAME shape Community
   * embeds as `pinnedMessage` — single-active-pin lookup, not "newest pin".
   * `_userId` is accepted (unused) for call-site compatibility — callers
   * already validate room membership before reaching this point.
   */
  async getActivePinSummary(
    roomId: string,
    _userId?: string
  ): Promise<PinnedMessageSummary | null> {
    const pin = await this.pinRepo.findActivePinByRoom(roomId);
    if (!pin) return null;

    const isAvailable = !pin.originalMessageDeletedAt;
    const live = isAvailable
      ? await this.messageRepo.findById(pin.messageId)
      : null;
    const liveContent = (live?.content ?? {}) as { text?: string };
    const snapshot = (pin.contentPinned ?? {}) as {
      text?: string;
      files?: MediaFileLike[];
    };
    return {
      messageId: pin.messageId,
      roomId: pin.roomId,
      communityId: pin.roomId,
      senderId: pin.senderId,
      senderName: pin.senderDisplayName || "",
      senderHandle: "",
      senderAvatar: pin.senderAvatar || "",
      messageType: (live?.messageType as string) || "TEXT",
      text: liveContent.text ?? snapshot.text ?? "",
      media: Array.isArray(snapshot.files) ? snapshot.files : [],
      createdAt: pin.messageCreatedAt.getTime(),
      pinnedAt: pin.pinnedAt.getTime(),
      pinnedBy: pin.pinnedBy,
      isAvailable: Boolean(live) && isAvailable,
    };
  }
}
