import { BadRequestError, NotFoundError } from "@aimess/errors";

import { env } from "../config/env.js";
import { resolvePinsMedia } from "../lib/media-resolve.js";
import { SystemEvent } from "../types/enums.js";
import type { PrivateMessagePinRepository } from "../repositories/private-message-pin.repository.js";
import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { PrivateSystemMessageService } from "./private-system-message.service.js";
import type { PrivateMessagePin } from "../generated/prisma/index.js";

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
  }): Promise<{ pin: PrivateMessagePin; pinnedCount: number }> {
    const { roomId, messageId, userId } = params;

    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    // Only a participant of this DM may pin into it — mirrors the same check
    // `unpin` already has below. Without this, any authenticated caller who
    // learns a valid roomId/messageId could pin into a conversation they're
    // not part of.
    if (!room.participants?.includes(userId)) {
      throw new BadRequestError("CHAT_NOT_A_PARTICIPANT");
    }

    const totalPins = await this.pinRepo.countPinsByRoom(roomId);
    if (totalPins >= env.PIN_LIMIT_PER_ROOM) {
      throw new BadRequestError("CHAT_PIN_LIMIT_REACHED");
    }

    const msg = await this.messageRepo.findMessageMeta({ roomId, messageId });
    if (!msg) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
      [msg.senderId || ""],
      this.cacheRepo
    );
    const senderSnap = (snapshots.get(msg.senderId || "") || {}) as Record<
      string,
      unknown
    >;

    const createdPin = await this.pinRepo.createPin({
      roomId,
      messageId: msg.id,
      pinnedBy: userId,
      pinnedAt: new Date(),
      messageCreatedAt: msg.createdAt,
      contentPinned: msg.content as object,
      senderId: msg.senderId || "",
      senderDisplayName: (senderSnap.displayName as string) || "",
      senderAvatar: (senderSnap.avatar as string) || "",
    });

    const updatedRoom = await this.roomRepo.incPinnedCount(roomId, 1);
    const pinnedCount = updatedRoom?.pinnedCount || 0;

    await this.sysMsg.post({
      roomId,
      actorId: userId,
      peerId: this.peerOf(room.participants, userId),
      systemEvent: SystemEvent.MESSAGE_PINNED,
      systemData: { messageId },
    });

    return { pin: createdPin, pinnedCount };
  }

  async unpin(params: {
    roomId: string;
    messageId: string;
    userId: string;
  }): Promise<{ pinnedCount: number }> {
    const { roomId, messageId, userId } = params;

    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    const isParticipant = room.participants?.includes(userId);
    if (!isParticipant) throw new BadRequestError("CHAT_NOT_A_PARTICIPANT");

    const delRes = await this.pinRepo.deletePin({
      roomId,
      messageId,
      pinnedBy: userId,
    });
    if (!delRes.deletedCount) {
      throw new BadRequestError("CHAT_UNPIN_OWN_ONLY");
    }

    const updatedRoom = await this.roomRepo.incPinnedCount(roomId, -1);

    await this.sysMsg.post({
      roomId,
      actorId: userId,
      peerId: this.peerOf(room.participants, userId),
      systemEvent: SystemEvent.MESSAGE_UNPINNED,
      systemData: { messageId },
    });

    return { pinnedCount: updatedRoom?.pinnedCount || 0 };
  }

  async list(
    roomId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<Array<PrivateMessagePin & { isAvailable: boolean }>> {
    const pins = await this.pinRepo.findPinsByRoom(roomId, params);
    // Resolve the pinned snapshot's sender avatar + attachment keys on read so
    // the pinned-banner FE never receives a raw object key (URLs not persisted).
    const resolved = await resolvePinsMedia(pins);
    // Stamp `isAvailable`: whether the underlying message still exists (not
    // deleted-for-everyone), so the banner can render a "pinned-but-deleted"
    // state and the client can skip navigation. Parity with community's
    // embedded `pinnedMessage.isAvailable`. Additive — old clients ignore it.
    const liveIds = await this.messageRepo.findLiveIds(
      roomId,
      resolved.map((p) => p.messageId)
    );
    return resolved.map((pin) => ({
      ...pin,
      isAvailable: liveIds.has(pin.messageId),
    }));
  }

  async countPins(roomId: string): Promise<number> {
    return this.pinRepo.countPinsByRoom(roomId);
  }
}
