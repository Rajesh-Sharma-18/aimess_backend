import { BadRequestError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import {
  assertGroupMemberNotMuted,
  assertGroupWritable,
} from "../lib/access-guard.js";
import {
  resolvePinsMedia,
  resolveContentFiles,
  resolveMediaUrl,
  type MediaFileLike,
} from "../lib/media-resolve.js";
import { getGroupVisibilityCutoff } from "../lib/deletion-cutoff.js";
import { isHiddenForUser } from "../lib/message-hidden-for-user.js";
import { SystemEvent } from "../types/enums.js";
import type { GroupMessagePinRepository } from "../repositories/group-message-pin.repository.js";
import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import {
  resolveDisplayName,
  type UserSnapshotService,
} from "./user-snapshot.service.js";
import type { GroupSystemMessageService } from "./group-system-message.service.js";
import type { PinnedMessageSummary } from "./community-pin.service.js";
import type { GroupMessagePin } from "../generated/prisma/index.js";

const PIN_ROLES = ["ADMIN", "MODERATOR"];

/**
 * Parity with `CommunityPinService`: only ONE active pin may exist per room at
 * a time. Pinning a second message atomically replaces the first (soft-delete
 * + create in a single transaction) instead of Group's old "up to N
 * simultaneous pins" model. A system message is posted only on pin (never on
 * unpin/replace — the original pin's line is retracted instead), matching
 * Community's documented product requirement.
 */
export class GroupPinService {
  constructor(
    private readonly pinRepo: GroupMessagePinRepository,
    private readonly messageRepo: GroupMessageRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly sysMsg: GroupSystemMessageService
  ) {}

  async pin(params: {
    roomId: string;
    messageId: string;
    userId: string;
  }): Promise<{
    pin: GroupMessagePin;
    pinnedCount: number;
    replacedPin?: GroupMessagePin | null;
    idempotent?: boolean;
  }> {
    const { roomId, messageId, userId } = params;

    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!PIN_ROLES.includes(member.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }
    // A muted moderator/admin cannot pin — pinning writes into the room
    // (it posts a MESSAGE_PINNED system line). Mirrors CommunityPinService.
    assertGroupMemberNotMuted(member);
    await assertGroupWritable(this.roomRepo, roomId);

    const msg = await this.messageRepo.findById(messageId);
    if (!msg || msg.roomId !== roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const currentActivePin = await this.pinRepo.findActivePinByRoom(roomId);

    if (currentActivePin && currentActivePin.messageId === msg.id) {
      const room = await this.roomRepo.findByRoomId(roomId);
      return {
        pin: currentActivePin,
        pinnedCount: room?.pinnedCount ?? 1,
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

    const { pin, replacedPin, pinnedCount } = await this.pinRepo.runTransaction(
      async (tx) => {
        let replaced: GroupMessagePin | null = null;
        if (currentActivePin) {
          replaced = await this.pinRepo.softDeletePin(
            currentActivePin.id,
            userId,
            new Date(),
            tx
          );
          if (!replaced) {
            throw new Error(
              `GroupPinService|switch: failed to soft-delete previous pin ${currentActivePin.id}`
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
            senderId: msg.senderId || "",
            senderDisplayName: resolveDisplayName(senderSnap),
            senderAvatar: (senderSnap.avatar as string) || "",
            contentPinned: msg.content as object,
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
        systemEvent: SystemEvent.MESSAGE_PINNED,
        systemData: { messageId },
      })
      .catch((err: unknown) => {
        logger.warn(`GroupPinService|postReturnId failed: ${String(err)}`);
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
            `GroupPinService|setPinSystemMessageId failed: ${String(err)}`
          );
        });
    }

    // §3: a pin/unpin is a server-side mutation of the message, so bump its
    // CHANGE cursor — otherwise the pin never reaches an offline client via
    // /changes and the client's monotonic merge has no way to order it.
    await this.bumpRevisions(roomId, [msg.id, replacedPin?.messageId]);

    return { pin, pinnedCount, replacedPin, idempotent: false };
  }

  /** Best-effort `revision` bump for messages whose PIN state just changed. */
  private async bumpRevisions(
    roomId: string,
    messageIds: Array<string | null | undefined>
  ): Promise<void> {
    for (const id of new Set(messageIds.filter(Boolean) as string[])) {
      await this.messageRepo.touchRevision(roomId, id).catch((err: unknown) => {
        logger.warn(
          `GroupPinService|touchRevision failed message=${id}: ${String(err)}`
        );
      });
    }
  }

  async unpin(params: {
    roomId: string;
    messageId: string;
    userId: string;
  }): Promise<{
    pin: GroupMessagePin | null;
    pinnedCount: number;
    retractedSystemMessageId?: string | null;
  }> {
    const { roomId, messageId, userId } = params;

    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!PIN_ROLES.includes(member.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }
    assertGroupMemberNotMuted(member);
    await assertGroupWritable(this.roomRepo, roomId);

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

    const retractedSystemMessageId =
      activePinForMessage.pinSystemMessageId ?? null;
    if (retractedSystemMessageId) {
      await this.sysMsg.retractSystemMessage({
        roomId,
        messageId: retractedSystemMessageId,
        actorId: userId,
      });
    }

    await this.bumpRevisions(roomId, [messageId]);

    return { pin: unpinnedPin, pinnedCount, retractedSystemMessageId };
  }

  /**
   * Called when a message is hard-deleted. Marks the active pin (if any)
   * unavailable and returns it so the caller can emit a pin:updated event.
   */
  async handleMessageDeleted(
    messageId: string
  ): Promise<GroupMessagePin | null> {
    const updated = await this.pinRepo.markPinnedMessageDeleted(
      messageId,
      new Date()
    );
    return updated[0] ?? null;
  }

  /**
   * Delete-for-everyone hook: the pinned message no longer exists for anyone,
   * so the pin must not survive for anyone either — soft-delete it, drop the
   * room's pinnedCount and retract its "pinned a message" system line. Merely
   * flagging it unavailable (handleMessageDeleted) left a dead banner pinned
   * for every member. Idempotent: null when the message has no active pin
   * (never pinned, or already unpinned), so a repeat delete is a clean no-op.
   * Carries no role check — the caller's delete was already authorized, and an
   * ADMIN_DELETE by a moderator must clear the pin even though `unpin` would
   * refuse a non-PIN_ROLES actor.
   */
  async unpinDeletedMessage(
    messageId: string,
    actorId: string
  ): Promise<{ roomId: string; pinnedCount: number } | null> {
    const activePin = await this.pinRepo.findActivePinByMessageId(messageId);
    if (!activePin) return null;

    const now = new Date();
    // Keep the historical marker (WHY the pin ended) next to the soft-delete.
    await this.pinRepo.markPinnedMessageDeleted(messageId, now);
    await this.pinRepo.softDeletePin(activePin.id, actorId, now);
    const updated = await this.roomRepo.incPinnedCount(activePin.roomId, -1);

    if (activePin.pinSystemMessageId) {
      await this.sysMsg
        .retractSystemMessage({
          roomId: activePin.roomId,
          messageId: activePin.pinSystemMessageId,
          actorId,
        })
        .catch((err: unknown) => {
          logger.warn(
            `GroupPinService|unpinDeletedMessage retract failed: ${String(err)}`
          );
        });
    }

    return { roomId: activePin.roomId, pinnedCount: updated?.pinnedCount ?? 0 };
  }

  /** roomId of this message's ACTIVE pin, or null — the delete-for-me hook's
   *  cheap "is this the pinned one?" probe. */
  async findActivePinRoomId(messageId: string): Promise<string | null> {
    const pin = await this.pinRepo.findActivePinByMessageId(messageId);
    return pin?.roomId ?? null;
  }

  async list(
    roomId: string,
    userId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<Array<GroupMessagePin & { isAvailable: boolean }>> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    const pins = await this.pinRepo.findPinsByRoom(roomId, params);
    const resolved = await resolvePinsMedia(pins);
    const messageIds = resolved.map((p) => p.messageId);
    const [liveIds, hiddenIds] = await Promise.all([
      this.messageRepo.findLiveIds(roomId, messageIds),
      this.messageRepo.findHiddenIdsForUser(roomId, messageIds, userId),
    ]);
    // A message this member deleted FOR THEMSELVES is gone from their pins
    // too — the pin row stays, so every other member is unaffected.
    return resolved
      .filter((pin) => !hiddenIds.has(pin.messageId))
      .map((pin) => ({
        ...pin,
        isAvailable:
          liveIds.has(pin.messageId) && !pin.originalMessageDeletedAt,
      }));
  }

  async countPins(roomId: string): Promise<number> {
    return this.pinRepo.countActivePinsByRoom(roomId);
  }

  /**
   * The room's currently active pinned message, in the SAME shape Community
   * embeds as `pinnedMessage` — single-active-pin lookup, not "newest pin".
   * When `userId` is given, a pin created before that member's own Clear Chat
   * cutoff (`getGroupVisibilityCutoff`) is hidden from them ONLY — the pin
   * row itself is untouched, so every other member keeps seeing it.
   */
  async getActivePinSummary(
    roomId: string,
    userId?: string
  ): Promise<PinnedMessageSummary | null> {
    const pin = await this.pinRepo.findActivePinByRoom(roomId);
    if (!pin) return null;

    if (userId) {
      const member = await this.memberRepo.findActiveByRoomAndUser(
        roomId,
        userId
      );
      const cutoff = getGroupVisibilityCutoff(member);
      if (cutoff && pin.pinnedAt <= cutoff) return null;
    }

    const isAvailable = !pin.originalMessageDeletedAt;
    const live = isAvailable
      ? await this.messageRepo.findById(pin.messageId)
      : null;
    // Delete-for-me is per-user: the message is hidden from THIS viewer only,
    // so their pin banner goes with it while every other member keeps theirs.
    // Read-time, so a reconnect/cold load resolves to the same state.
    if (userId && isHiddenForUser(live, userId)) return null;
    const liveContent = (live?.content ?? {}) as { text?: string };
    const snapshot = (pin.contentPinned ?? {}) as {
      text?: string;
      files?: MediaFileLike[];
      sticker?: MediaFileLike;
    };
    // A sticker/GIF lives at `content.sticker`, outside `files[]` — without it the
    // banner has no thumbnail for the one type that is nothing BUT a thumbnail.
    const snapshotFiles = Array.isArray(snapshot.files) ? snapshot.files : [];
    const pinnedFiles =
      snapshotFiles.length > 0
        ? snapshotFiles
        : snapshot.sticker && typeof snapshot.sticker === "object"
          ? [snapshot.sticker]
          : [];
    // Resolve-on-read: the snapshot keeps raw object keys, but the banner renders
    // the thumbnail straight from this summary (the pinned message is usually
    // outside the loaded page), so it must receive full URLs — same boundary the
    // pin LIST already crosses via resolvePinsMedia.
    const [media, senderAvatar] = await Promise.all([
      resolveContentFiles(pinnedFiles),
      resolveMediaUrl(pin.senderAvatar),
    ]);
    return {
      messageId: pin.messageId,
      roomId: pin.roomId,
      communityId: pin.roomId,
      senderId: pin.senderId,
      senderName: pin.senderDisplayName || "",
      senderHandle: "",
      senderAvatar,
      messageType: (live?.messageType as string) || "TEXT",
      text: liveContent.text ?? snapshot.text ?? "",
      media,
      createdAt: pin.messageCreatedAt.getTime(),
      pinnedAt: pin.pinnedAt.getTime(),
      pinnedBy: pin.pinnedBy,
      isAvailable: Boolean(live) && isAvailable,
    };
  }
}
