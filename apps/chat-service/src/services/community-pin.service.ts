import { BadRequestError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { normalizeMessageType } from "../lib/chat-message.serializer.js";
import {
  assertCommunityMember,
  assertCommunityMemberNotMuted,
  assertCommunityReadAccess,
  assertCommunityRoomWritable,
} from "../lib/access-guard.js";
import {
  resolvePinsMedia,
  resolveContentFiles,
  resolveMediaUrl,
  type MediaFileLike,
} from "../lib/media-resolve.js";
import { isHiddenForUser } from "../lib/message-hidden-for-user.js";
import type { CommunityMessagePinRepository } from "../repositories/community-message-pin.repository.js";
import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { CommunityMessagePin } from "../generated/prisma/index.js";
import type { CommunitySystemMessageService } from "./community-system-message.service.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";

/**
 * FE-header-ready snapshot of a room's currently pinned message. Reuses the
 * SAME `CommunityMessagePin` persistence as pin/unpin — no separate pin store.
 * `null` when the room has no active pin. When the pinned message still
 * exists, content/media/sender fields reflect the LIVE message row (so an
 * edit after pinning is visible); when it was hard-deleted, fields fall back
 * to the pin's own frozen snapshot and `isAvailable` is `false` — mirroring
 * the existing pin-banner "Message doesn't exist" behavior.
 */
export interface PinnedMessageSummary {
  messageId: string;
  roomId: string;
  communityId: string;
  senderId: string;
  senderName: string;
  senderHandle: string;
  senderAvatar: string;
  messageType: string;
  text: string;
  media: MediaFileLike[];
  createdAt: number;
  pinnedAt: number;
  pinnedBy: string;
  isAvailable: boolean;
}

export class CommunityPinService {
  constructor(
    private readonly pinRepo: CommunityMessagePinRepository,
    private readonly messageRepo: GeneralRoomMessageRepository,
    private readonly roomRepo: GeneralRoomRepository,
    private readonly memberRepo: RoomMemberRepository,
    private readonly systemMessageService?: CommunitySystemMessageService,
    /**
     * Optional — enables `senderHandle` resolution on `getActivePinSummary`.
     * Optional so existing 4/5-arg construction sites (tests) keep working
     * untouched; production wires both in server.ts.
     */
    private readonly userSnapshotService?: UserSnapshotService,
    private readonly cacheRepo?: CacheRepository
  ) {}

  async pin(params: {
    roomId: string;
    messageId: string;
    userId: string;
    communityId: string;
  }): Promise<{
    pin: CommunityMessagePin;
    pinnedCount: number;
    /** Set when pinning this message replaced a different message's active pin — the caller uses it to also emit the existing UNPIN realtime event. */
    replacedPin?: CommunityMessagePin | null;
    /** True when the requested message was already the room's active pin — no DB write occurred. */
    idempotent?: boolean;
  }> {
    const { roomId, messageId, userId, communityId } = params;

    // 1. Assert ADMIN or MODERATOR role (throws CHAT_NOT_A_MEMBER / CHAT_INSUFFICIENT_PERMISSIONS).
    //    Role is checked LIVE against community-service (source of truth) —
    //    see assertCommunityRole in access-guard.ts.
    const pinner = await assertCommunityMember(
      this.memberRepo,
      roomId,
      userId,
      {
        roles: ["admin", "moderator"],
        communityId,
      }
    );
    // A muted moderator is fully silenced — pinning posts a system action too.
    assertCommunityMemberNotMuted(pinner);

    // 2. Load room and assert writable (not closed / suspended)
    const room = await this.roomRepo.findRoomById(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    assertCommunityRoomWritable(room);

    const communityName: string =
      typeof room.name === "string" && room.name ? room.name : "Community";

    // 3. Validate the message to pin
    const msg = await this.messageRepo.findById(messageId);
    if (!msg || msg.roomId !== roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (msg.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (normalizeMessageType(msg.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    // 4. Only one pinned message may exist per community/room. Find the
    //    current active pin (if any) instead of hard-blocking on it.
    const currentActivePin = await this.pinRepo.findActivePinByRoom(roomId);

    // 4a. Re-pinning the message that's already active is a no-op success —
    //     nothing to switch, no new record, no realtime event needed.
    if (currentActivePin && currentActivePin.messageId === msg.id) {
      return {
        pin: currentActivePin,
        pinnedCount: room.pinnedCount ?? 1,
        replacedPin: null,
        idempotent: true,
      };
    }

    // 4b/5. Switch (or first-pin) atomically: soft-delete the previous active
    //    pin (if any) and create the new one in a single transaction so the
    //    one-active-pin-per-room invariant is never observably violated and
    //    no duplicate active pin can be created under concurrent requests.
    const { pin, replacedPin, pinnedCount } = await this.pinRepo.runTransaction(
      async (tx) => {
        let replaced: CommunityMessagePin | null = null;
        if (currentActivePin) {
          replaced = await this.pinRepo.softDeletePin(
            currentActivePin.id,
            userId,
            new Date(),
            tx
          );
          if (!replaced) {
            throw new Error(
              `CommunityPinService|switch: failed to soft-delete previous pin ${currentActivePin.id}`
            );
          }
          await this.roomRepo.incPinnedCount(roomId, -1, tx);
        }

        const created = await this.pinRepo.createPin(
          {
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

    // 5b. Switching pins: the previous active pin's "pinned a message" system
    //    line is now stale — retract it (best-effort) same as an explicit
    //    unpin would. Independent of the new pin's own system line below.
    if (replacedPin?.pinSystemMessageId) {
      await this.systemMessageService?.retractSystemMessage({
        communityId,
        messageId: replacedPin.pinSystemMessageId,
      });
    }

    // 6. Create PINNED_MESSAGE system line (best-effort, outside the
    //    transaction — a failure here must not roll back the pin switch).
    //    "eventAt" is scoped to this pin's ID so a retry doesn't duplicate the line.
    //    The text is "{pinner} pinned a message" — the ACTOR is the user, resolved
    //    from `triggeredByUserId` by CommunitySystemMessageService (which stamps
    //    metadata.actorUserId/actorName). `communityName` is kept in metadata for
    //    clients that show community context; it is NOT the actor.
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

    // 7. Store back-reference (best-effort, but AWAITED — not fire-and-forget —
    //    so a rapid subsequent unpin/re-pin always sees this pin's
    //    pinSystemMessageId already persisted; a detached write here would
    //    race a fast unpin and silently skip the system-line retraction).
    //    Reflect it on the in-memory `pin` immediately too, so the response
    //    of THIS call is correct without waiting on a re-read.
    if (sysMessageId) {
      await this.pinRepo
        .setPinSystemMessageId(pin.id, sysMessageId)
        .then(() => {
          pin.pinSystemMessageId = sysMessageId;
        })
        .catch((err: unknown) => {
          logger.warn(
            `CommunityPinService|setPinSystemMessageId failed: ${String(err)}`
          );
        });
    }

    // §3: a pin/unpin is a server-side mutation of the message, so bump its
    // CHANGE cursor — otherwise the pin never reaches an offline client via
    // /changes and the client's monotonic merge has no way to order it.
    await this.bumpRevisions(roomId, [messageId, replacedPin?.messageId]);

    return { pin, pinnedCount, replacedPin, idempotent: false };
  }

  /** Best-effort `revision` bump for messages whose PIN state just changed. */
  private async bumpRevisions(
    roomId: string,
    messageIds: Array<string | null | undefined>
  ): Promise<void> {
    for (const id of new Set(messageIds.filter(Boolean) as string[])) {
      try {
        const revision = await this.roomRepo.allocateRevision(roomId);
        await this.messageRepo.setRevision(id, revision);
      } catch (err: unknown) {
        logger.warn(
          `CommunityPinService|setRevision failed message=${id}: ${String(err)}`
        );
      }
    }
  }

  async unpin(params: {
    roomId: string;
    messageId: string;
    userId: string;
  }): Promise<{
    pin: CommunityMessagePin | null;
    pinnedCount: number;
    /** Set when this unpin retracted a "pinned a message" system line — the caller uses it to recalculate lastActivity if that line was the room's last message. */
    retractedSystemMessageId?: string | null;
  }> {
    const { roomId, messageId, userId } = params;

    // 1. Assert ADMIN or MODERATOR role, checked LIVE against community-service.
    //    No separate communityId param here — roomId === communityId for
    //    community general rooms, and assertCommunityMember's opts.communityId
    //    defaults to roomId when omitted.
    const unpinner = await assertCommunityMember(
      this.memberRepo,
      roomId,
      userId,
      { roles: ["admin", "moderator"] }
    );
    assertCommunityMemberNotMuted(unpinner);

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

    // NOTE: No UNPINNED_MESSAGE system message (product requirement). But the
    // ORIGINAL "{actor} pinned a message" line from the pin() call must be
    // retracted now — otherwise it lingers in history after the pin itself
    // is gone. Best-effort, same mechanism as a normal message hard-delete.
    const retractedSystemMessageId =
      activePinForMessage.pinSystemMessageId ?? null;
    if (retractedSystemMessageId) {
      await this.systemMessageService?.retractSystemMessage({
        communityId: activePinForMessage.communityId || roomId,
        messageId: retractedSystemMessageId,
      });
    }

    await this.bumpRevisions(roomId, [messageId]);

    return { pin: unpinnedPin, pinnedCount, retractedSystemMessageId };
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

  /**
   * Delete-for-everyone hook: the pinned message no longer exists for anyone,
   * so the pin must not survive for anyone either — soft-delete it, drop the
   * room's pinnedCount and retract its "pinned a message" system line. Merely
   * flagging it unavailable (handleMessageDeleted) left a dead banner pinned
   * for every member. Idempotent: null when the message has no active pin
   * (never pinned, or already unpinned), so a repeat delete is a clean no-op.
   * Carries no role check — the caller's delete was already authorized, and an
   * ADMIN_DELETE by a moderator must clear the pin regardless.
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
      await this.systemMessageService
        ?.retractSystemMessage({
          communityId: activePin.communityId || activePin.roomId,
          messageId: activePin.pinSystemMessageId,
        })
        .catch((err: unknown) => {
          logger.warn(
            `CommunityPinService|unpinDeletedMessage retract failed: ${String(err)}`
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
  ): Promise<CommunityMessagePin[]> {
    // Same read-cutoff guard as message history — a banned member keeps read
    // access to pins created before their ban, a non-member of a PRIVATE
    // community gets denied outright. See assertCommunityReadAccess doc.
    const { bannedAtCutoff } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      roomId,
      userId,
      { allowBannedReadCutoff: true }
    );
    const pins = await this.pinRepo.findPinsByRoom(roomId, params);
    const visible = bannedAtCutoff
      ? pins.filter((p) => p.pinnedAt <= bannedAtCutoff)
      : pins;
    // A message this member deleted FOR THEMSELVES is gone from their pins
    // too — the pin row stays, so every other member is unaffected.
    const hiddenIds = await this.messageRepo.findHiddenIdsForUser(
      roomId,
      visible.map((p) => p.messageId),
      userId
    );
    return resolvePinsMedia(visible.filter((p) => !hiddenIds.has(p.messageId)));
  }

  async countPins(roomId: string): Promise<number> {
    return this.pinRepo.countActivePinsByRoom(roomId);
  }

  /**
   * The room's currently active pinned message, FE-header-ready — for
   * embedding as a top-level `pinnedMessage` field on the Community Messages
   * API response (REST `GET /rooms/:roomId/messages` and the gRPC/socket
   * `community:messages:fetch` equivalent). `null` when no message is pinned.
   *
   * Fixed query cost regardless of page size: 1 query to find the active pin
   * (`findActivePinByRoom`, indexed on `[roomId, unpinnedAt]`), and — only if
   * a pin exists — 1 query to load the live message row, plus one batched
   * (Redis-cached) user-snapshot lookup for `senderHandle`. Never scales with
   * the number of messages in the requested page (no N+1).
   */
  async getActivePinSummary(
    roomId: string,
    userId?: string
  ): Promise<PinnedMessageSummary | null> {
    const pin = await this.pinRepo.findActivePinByRoom(roomId);
    if (!pin) return null;

    const message = await this.messageRepo.findById(pin.messageId);
    // Delete-for-me is per-user: the message is hidden from THIS viewer only,
    // so their pin banner goes with it while every other member keeps theirs.
    // Read-time, so a reconnect/cold load resolves to the same state.
    if (userId && isHiddenForUser(message, userId)) return null;
    const isAvailable = Boolean(
      message && !message.deletedForAll && !pin.originalMessageDeletedAt
    );

    if (!isAvailable) {
      // Original message hard-deleted (or no longer resolvable) — fall back
      // to the pin's own frozen snapshot, same source the pin-list/banner
      // already uses. Mirrors the documented "Message doesn't exist" state.
      const snapshotContent = (pin.contentPinned ?? {}) as {
        text?: string;
      };
      return {
        messageId: pin.messageId,
        roomId: pin.roomId,
        communityId: pin.communityId || pin.roomId,
        senderId: pin.senderId,
        senderName: pin.senderDisplayName || "",
        senderHandle: "",
        senderAvatar: await resolveMediaUrl(pin.senderAvatar),
        messageType: "TEXT",
        text: snapshotContent.text ?? "",
        media: [],
        createdAt: pin.messageCreatedAt.getTime(),
        pinnedAt: pin.pinnedAt.getTime(),
        pinnedBy: pin.pinnedBy,
        isAvailable: false,
      };
    }

    const attachments = Array.isArray(message!.attachments)
      ? (message!.attachments as MediaFileLike[])
      : [];
    const [media, senderAvatar] = await Promise.all([
      resolveContentFiles(attachments),
      resolveMediaUrl(message!.senderAvatar || pin.senderAvatar),
    ]);

    let senderHandle = "";
    if (this.userSnapshotService && this.cacheRepo) {
      const snaps = await this.userSnapshotService.getUserSnapshotsMap(
        [message!.sentBy],
        this.cacheRepo
      );
      senderHandle = (snaps.get(message!.sentBy)?.memberId as string) || "";
    }

    return {
      messageId: message!.id,
      roomId: pin.roomId,
      communityId: pin.communityId || pin.roomId,
      senderId: message!.sentBy,
      senderName: message!.senderName || pin.senderDisplayName || "",
      senderHandle,
      senderAvatar,
      messageType: normalizeMessageType(message!.messageType),
      text: message!.message || "",
      media,
      createdAt: message!.createdAt.getTime(),
      pinnedAt: pin.pinnedAt.getTime(),
      pinnedBy: pin.pinnedBy,
      isAvailable: true,
    };
  }
}
