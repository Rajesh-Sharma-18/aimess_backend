import { BadRequestError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { publishChatUserEvent } from "@aimess/redis";

import { listRowIdentity } from "../lib/list-row-identity.js";
import { getAccountChatSettings } from "../lib/account-chat-settings.js";
import { publishConvUpdatedSafe } from "../events/publish-conv-updated.js";
import { normalizeMessageType } from "../lib/chat-message.serializer.js";
import { convertMessageToPreview } from "./message-preview.service.js";
import { generateRoomId } from "../lib/room-id.js";
import { SystemEvent } from "../types/enums.js";
import {
  resolveMediaUrl,
  resolveMediaUrlMap,
  urlFromMap,
} from "../lib/media-resolve.js";
import {
  resolveVisibleLastBulk,
  type VisibilitySource,
  type VisibleLast,
} from "./last-visible-resolver.js";
import { groupVisibilitySource } from "./last-visible-adapters.js";
import {
  assertGroupReadAccess,
  groupReadCutoff,
  isGroupMemberMuted,
} from "../lib/access-guard.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupInviteLinkRepository } from "../repositories/group-invite-link.repository.js";
import type { GroupSystemMessageService } from "./group-system-message.service.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import { resolveDisplayName } from "./user-snapshot.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { GroupRoom, GroupMember } from "../generated/prisma/index.js";

export type GroupRoomMembership = GroupRoom & {
  /** True when the logged-in caller is an active member of this group. */
  isJoined: boolean;
  /**
   * Per-viewer effective last activity (see {@link GroupConversationLastActivity}).
   * Optional here so the non-list producers of this type keep compiling; the two
   * list builders always populate it.
   */
  lastActivity?: GroupConversationLastActivity;
  /** Epoch-ms mirror of `lastActivity.dateTime`. */
  lastActivityAt?: number;
  /**
   * True when an admin/moderator silenced the CALLER — they can still read
   * everything but cannot send/react/edit/pin. Distinct from `isMuted`, which
   * is the caller's own NOTIFICATION mute. Same names community's detail
   * payload uses. Optional so the list endpoints that don't resolve it keep
   * compiling unchanged.
   */
  isMemberMuted?: boolean;
  /** ISO-8601 expiry; null = indefinite when `isMemberMuted`, or not muted. */
  memberMutedUntil?: string | null;
  /** Epoch-ms mirror of `memberMutedUntil` (§6). null = not muted / indefinite. */
  memberMutedUntilMs?: number | null;
  /**
   * The caller's raw `GroupMember.status` — `"ACTIVE" | "LEFT" | "KICKED"`, or
   * null for an internal/unauthenticated read. This is what lets a client
   * distinguish ACTIVE / left / removed-by-an-admin WITHOUT inferring it from
   * `isJoined === false`, so a hard reload or a cold open restores the correct
   * read-only bar instead of only reacting to the `group:removed` socket event.
   * (BANNED never reaches a client here — the read guard rejects it.)
   */
  membershipStatus?: string | null;
};

/**
 * Post-fetch "delete conversation" visibility gate — mirrors
 * PrivateRoomRepository's `isVisibleAfterDeleteForMe`. A member who cleared
 * their group history stays ACTIVE (unlike Leave), so the room only reappears
 * in their list once a message newer than the clear lands.
 */
function isVisibleAfterClear(
  room: { lastMessageAt: Date | null },
  clearedAt: Date | null | undefined
): boolean {
  if (!clearedAt) return true;
  const lastMs = room.lastMessageAt ? room.lastMessageAt.getTime() : 0;
  return lastMs > clearedAt.getTime();
}

/**
 * Normalized per-viewer last-activity DTO for a GROUP row — the same shape
 * `PrivateConversationLastActivity` / `CommunityLastActivity` already expose, so
 * every list surface finally answers "what happened last, and when, FOR ME" in
 * one field with one meaning.
 *
 * Why it exists: `GroupRoom.lastMessageAt` is the SHARED snapshot and is what
 * the list query paginates on, so it cannot be rewritten per viewer without
 * breaking the cursor. But after a delete-for-me / clear-chat / ex-member cutoff
 * the group list already swaps in a per-viewer `lastMessagePreview` — with no
 * matching timestamp, which left a client sorting on `lastMessageAt` holding the
 * timestamp of a message it is no longer being shown. `dateTime` here IS that
 * missing per-viewer timestamp (0 when nothing visible remains), and it is the
 * field a list should sort on.
 */
export interface GroupConversationLastActivity {
  type: "message";
  userId: string | null;
  username: string;
  preview: string;
  /** epoch ms; 0 = this viewer has no visible message left in the room. */
  dateTime: number;
  messageId: string;
  clientMessageId: string | null;
  seq: number;
  revision: number;
  /** UPPER-CASE canonical content type (TEXT/IMAGE/…/SYSTEM); "" when empty. */
  contentType: string;
}

const EMPTY_GROUP_LAST_ACTIVITY: GroupConversationLastActivity = {
  type: "message",
  userId: null,
  username: "",
  preview: "",
  dateTime: 0,
  messageId: "",
  clientMessageId: null,
  seq: 0,
  revision: 0,
  contentType: "",
};

/**
 * Build the per-viewer `lastActivity` from whatever `lastMessagePreview` the
 * per-user passes (delete-for-me override / clear-chat cap / ex-member cap) left
 * on the row.
 *
 * `fallbackAt` is used ONLY when the preview is absent because the stored row
 * never had one (a legacy row written before `lastMessagePreview` existed) —
 * pass the shared `lastMessageAt` there. When one of the per-user passes REMOVED
 * the preview, callers pass 0: that is the viewer having nothing visible left,
 * and it must not silently inherit the shared timestamp (the exact bug that kept
 * a cleared chat pinned to the top of the list).
 */
export function buildGroupLastActivity(
  lastMessagePreview: unknown,
  fallbackAt: number
): GroupConversationLastActivity {
  const lp = lastMessagePreview as Record<string, unknown> | null;
  if (!lp) return { ...EMPTY_GROUP_LAST_ACTIVITY, dateTime: fallbackAt };
  const contentType = normalizeMessageType(
    (lp.messageType as string) ?? "TEXT"
  );
  const createdAt = lp.createdAt
    ? new Date(lp.createdAt as string | Date).getTime()
    : 0;
  return {
    type: "message",
    userId: (lp.senderId as string) || null,
    username: (lp.senderName as string) || "",
    preview: convertMessageToPreview(contentType, { text: lp.text ?? "" }),
    dateTime: createdAt,
    messageId: (lp.messageId as string) || "",
    clientMessageId: (lp.clientMessageId as string) ?? null,
    seq: (lp.seq as number) ?? 0,
    revision: (lp.revision as number) ?? 0,
    contentType,
  };
}

export type EnrichedGroupRoom = GroupRoomMembership & {
  isMuted: boolean;
  /**
   * Per-viewer effective last activity + its epoch-ms timestamp. Mirrors the
   * private/community list rows. `lastMessageAt` above stays the SHARED snapshot
   * (the pagination cursor); this is the value a list must render and sort on.
   */
  lastActivity: GroupConversationLastActivity;
  lastActivityAt: number;
  unreadCount: number;
  role: string;
  /** True when the caller voluntarily left this group — kept in the inbox
   *  read-only (history intact, `isJoined: false`), WhatsApp-style. */
  hasLeft: boolean;
  /** True when an admin/moderator REMOVED the caller (kicked). Same read-only
   *  treatment as {@link hasLeft} — the row stays, history stays, every write
   *  is denied — only the notice wording and the absence of a rejoin differ. */
  isRemoved: boolean;
  /**
   * Telegram-style tick for the last message, but ONLY meaningful when the
   * CALLER sent it (null otherwise). Three tiers, matching Telegram/WhatsApp:
   *  - SENT: no other active member has been marked delivered yet.
   *  - DELIVERED: at least one other active member is in the message's
   *    `deliveredTo` (populated at send-time from live presence, and topped
   *    up by the presence-connect backfill).
   *  - READ: every other active member's `lastReadMessageId` cursor has caught
   *    up to the last message's sequenceNumber.
   */
  lastMessageReadStatus: "SENT" | "DELIVERED" | "READ" | null;
};

export class GroupRoomService {
  constructor(
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly inviteLinkRepo: GroupInviteLinkRepository,
    private readonly sysMsg: GroupSystemMessageService,
    private readonly redis: Redis | Cluster,
    private readonly messageRepo: GroupMessageRepository,
    private readonly userSnapshotService?: UserSnapshotService,
    private readonly cacheRepo?: CacheRepository
  ) {}

  /**
   * Overwrite each row's `lastMessagePreview.senderName` with the live snapshot's
   * display name. Old rows persisted before the sender-name resolution fix carry
   * an empty `senderName` frozen in the JSON, which strands the sidebar without
   * a preview prefix — resolving at read time makes those self-heal without a
   * data migration. Silently returns rooms untouched when the snapshot service
   * hasn't been wired (test harnesses).
   */
  private async enrichLastMessageSenderNames<
    T extends {
      roomId: string;
      lastMessagePreview: unknown;
    },
  >(rooms: T[]): Promise<T[]> {
    if (!rooms.length || !this.userSnapshotService || !this.cacheRepo)
      return rooms;
    const senderIds = new Set<string>();
    for (const r of rooms) {
      const lp = r.lastMessagePreview as Record<string, unknown> | null;
      const senderId = (lp?.senderId as string) || "";
      if (senderId) senderIds.add(senderId);
    }
    if (!senderIds.size) return rooms;
    const snaps = await this.userSnapshotService.getUserSnapshotsMap(
      [...senderIds],
      this.cacheRepo
    );
    return rooms.map((r) => {
      const lp = r.lastMessagePreview as Record<string, unknown> | null;
      if (!lp) return r;
      const senderId = (lp.senderId as string) || "";
      const live = senderId ? resolveDisplayName(snaps.get(senderId)) : "";
      const liveName = live && live !== "Unknown User" ? live : "";
      // Prefer the live name whenever we have one — this is the whole point of
      // resolve-on-read (stored value may be empty or stale after a rename).
      // Falls back to the stored senderName only when the snapshot lookup missed.
      const nextSenderName = liveName || (lp.senderName as string) || "";
      return {
        ...r,
        lastMessagePreview: { ...lp, senderName: nextSenderName },
      } as T;
    });
  }

  /**
   * Adapter that exposes the group-message deletion shape (deletedForUserIds
   * ARRAY) to the shared LastVisibleResolver. Normalizes a GroupMessage into the
   * room-type-agnostic `VisibleLast`.
   */
  private visibilitySource(): VisibilitySource {
    return groupVisibilitySource(this.messageRepo);
  }

  /**
   * Per-user list-preview pass shared by getInboxGroups and getUserGroups: for
   * each room whose shared lastMessageId is hidden from the viewer (globally
   * deleted OR personally hidden), substitute the viewer's previous-visible
   * message into `lastMessagePreview`. Rooms whose shared last is visible (the
   * common case) are returned untouched. Ordering (lastMessageAt) is left as the
   * shared snapshot dictates — display-only per-user correction, no re-sort.
   */
  private async applyPerUserPreview<T extends GroupRoom>(
    rooms: T[],
    userId: string
  ): Promise<T[]> {
    if (!rooms.length) return rooms;
    const overrides = await resolveVisibleLastBulk(
      this.visibilitySource(),
      rooms.map((r) => ({
        roomId: r.roomId,
        sharedLastMessageId: r.lastMessageId,
      })),
      userId
    );
    const withDeleteOverlay = !overrides.size
      ? rooms
      : rooms.map((room) => {
          if (!overrides.has(room.roomId)) return room;
          const prev: VisibleLast | null = overrides.get(room.roomId) ?? null;
          const content = (prev?.content ?? null) as { text?: string } | null;
          return {
            ...room,
            // Preserve the GroupRoom.lastMessagePreview JSON shape so the wire
            // response is unchanged; only the per-viewer content differs.
            lastMessagePreview: prev
              ? {
                  text: content?.text ?? "",
                  senderId: prev.senderId,
                  senderName: prev.senderName,
                  messageType: prev.messageType,
                  createdAt: prev.createdAt,
                  ...listRowIdentity({ ...prev, id: prev.messageId }),
                }
              : null,
          } as T;
        });
    return this.applyReactionOverlay(withDeleteOverlay, userId);
  }

  /**
   * An ex-member's inbox row must not preview a message posted after they
   * stopped being a member — same "no content past the cutoff" rule
   * `assertGroupReadAccess`/`readCutoffBefore` already enforce when they open
   * the room's actual history; without this, the shared
   * `GroupRoom.lastMessagePreview` (which ISN'T per-viewer) would keep showing
   * whatever the group's real last message is, effectively "receiving" its text
   * via the sidebar even though the timeline itself correctly stops at the
   * cutoff. Covers both ways a membership ends read-only — voluntary `LEFT`
   * (`leftAt`) and admin removal `KICKED` (`kickedAt`), resolved by the shared
   * `groupReadCutoff`; ACTIVE members and any row without a real membership
   * pass through untouched.
   */
  private async applyLeftMemberPreviewCap<T extends GroupRoom>(
    rooms: T[],
    membershipByRoom: Map<
      string,
      { status: string; leftAt: Date | null; kickedAt?: Date | null }
    >,
    userId: string
  ): Promise<T[]> {
    if (!rooms.length) return rooms;
    const stale = rooms.filter((room) => {
      const cutoff = groupReadCutoff(membershipByRoom.get(room.roomId));
      return (
        cutoff != null &&
        room.lastMessageAt != null &&
        room.lastMessageAt.getTime() > cutoff.getTime()
      );
    });
    if (!stale.length) return rooms;

    const capped = new Map<string, T>();
    await Promise.all(
      stale.map(async (room) => {
        const leftAt = groupReadCutoff(membershipByRoom.get(room.roomId));
        if (!leftAt) return;
        const [prev] = await this.messageRepo.findByRoomIdWithTime(
          room.roomId,
          leftAt.toISOString(),
          1,
          userId
        );
        capped.set(room.roomId, {
          ...room,
          lastMessagePreview: prev
            ? {
                text: (prev.content as { text?: string } | null)?.text ?? "",
                senderId: prev.senderId ?? "",
                senderName: prev.senderName ?? "",
                messageType: prev.messageType,
                createdAt: prev.createdAt,
                ...listRowIdentity(prev),
              }
            : null,
        } as T);
      })
    );
    if (!capped.size) return rooms;
    return rooms.map((room) => capped.get(room.roomId) ?? room);
  }

  /**
   * Per-viewer effective activity for a page, keyed by roomId.
   *
   * `raw` is the untouched repository page and `rooms` the same page after the
   * per-user passes. A row whose preview those passes REMOVED has nothing
   * visible left for this viewer → dateTime 0 (it drops down the list). A row
   * that simply never had a stored preview is a legacy row → keep the shared
   * `lastMessageAt` so it does not sink for everyone.
   */
  private lastActivityByRoom<T extends GroupRoom>(
    raw: T[],
    rooms: T[]
  ): Map<string, GroupConversationLastActivity> {
    const rawHadPreview = new Set(
      raw.filter((r) => r.lastMessagePreview).map((r) => r.roomId)
    );
    return new Map(
      rooms.map((r) => [
        r.roomId,
        buildGroupLastActivity(
          r.lastMessagePreview,
          rawHadPreview.has(r.roomId) ? 0 : (r.lastMessageAt?.getTime() ?? 0)
        ),
      ])
    );
  }

  private applyClearChatPreviewCap<T extends GroupRoom>(
    rooms: T[],
    membershipByRoom: Map<string, { clearChatAt?: Date | null }>
  ): T[] {
    return rooms.map((room) => {
      const clearChatAt = membershipByRoom.get(room.roomId)?.clearChatAt;
      if (
        !clearChatAt ||
        !room.lastMessageAt ||
        room.lastMessageAt.getTime() > clearChatAt.getTime()
      ) {
        return room;
      }
      return { ...room, lastMessagePreview: null } as T;
    });
  }

  /**
   * Batch-resolves the "did every other active member read the caller's last
   * message" tick for a page of rooms — one shared query pass instead of N+1.
   * Rows whose last message wasn't sent by `userId` are left unset (null tick).
   */
  private async computeLastMessageReadStatuses(
    rooms: Array<{
      roomId: string;
      lastMessageId: string | null;
      lastMessagePreview: unknown;
    }>,
    userId: string
  ): Promise<Map<string, "SENT" | "DELIVERED" | "READ">> {
    const result = new Map<string, "SENT" | "DELIVERED" | "READ">();
    const ownRoomIds: string[] = [];
    const lastMessageIdByRoom = new Map<string, string>();
    for (const room of rooms) {
      const preview = room.lastMessagePreview as {
        senderId?: string;
        messageType?: string;
      } | null;
      const senderId = preview?.senderId;
      // SYSTEM lines (member joined/left/removed, group updated, ...) name the
      // acting user as sender but are not user-sent messages — no tick for them.
      if (
        senderId !== userId ||
        !room.lastMessageId ||
        String(preview?.messageType ?? "").toUpperCase() === "SYSTEM"
      )
        continue;
      ownRoomIds.push(room.roomId);
      lastMessageIdByRoom.set(room.roomId, room.lastMessageId);
    }
    if (!ownRoomIds.length) return result;

    const activeMembersByRoom = new Map(
      await Promise.all(
        ownRoomIds.map(
          async (roomId) =>
            [roomId, await this.memberRepo.findActiveMembers(roomId)] as const
        )
      )
    );

    // Settings → Chat → Read Receipt, applied to the group LIST tick the same
    // way PrivateRoomService.enrichConversations applies it — otherwise the
    // blue tick the socket withheld reappears on the next refresh and the
    // switch looks broken. Reciprocal, WhatsApp-style: the VIEWER must allow
    // receipts to see one, and a member who disabled them gives none, so they
    // never count towards "everyone has read it". Cached per user (60s TTL), so
    // this is one lookup per distinct member on the page, not one per room.
    const viewerSeesReceipts = (await getAccountChatSettings(userId))
      .readReceipts;
    const otherMemberIds = new Set<string>();
    for (const roomId of ownRoomIds) {
      for (const member of activeMembersByRoom.get(roomId) ?? []) {
        if (member.userId !== userId) otherMemberIds.add(member.userId);
      }
    }
    const memberGivesReceipts = new Map(
      await Promise.all(
        [...otherMemberIds].map(
          async (id) =>
            [id, (await getAccountChatSettings(id)).readReceipts] as const
        )
      )
    );

    const idsToResolve = new Set<string>();
    for (const roomId of ownRoomIds) {
      idsToResolve.add(lastMessageIdByRoom.get(roomId) as string);
      for (const member of activeMembersByRoom.get(roomId) ?? []) {
        if (member.userId !== userId && member.lastReadMessageId)
          idsToResolve.add(member.lastReadMessageId);
      }
    }
    const resolvedMessages = idsToResolve.size
      ? await this.messageRepo.findManyByIds([...idsToResolve])
      : [];
    const seqById = new Map(
      resolvedMessages.map((m) => [
        m.id,
        (m as { sequenceNumber?: number }).sequenceNumber ?? 0,
      ])
    );

    // Also pull the full last-message docs (already in resolvedMessages) so
    // we can read `deliveredTo` for the DELIVERED tier without a second query.
    const lastMessageById = new Map(resolvedMessages.map((m) => [m.id, m]));

    for (const roomId of ownRoomIds) {
      const lastMessageId = lastMessageIdByRoom.get(roomId) as string;
      const lastSeq = seqById.get(lastMessageId) ?? 0;
      const others = (activeMembersByRoom.get(roomId) ?? []).filter(
        (m) => m.userId !== userId
      );
      const allRead =
        viewerSeesReceipts &&
        others.length > 0 &&
        lastSeq > 0 &&
        others.every(
          (m) =>
            memberGivesReceipts.get(m.userId) !== false &&
            (m.lastReadMessageId
              ? (seqById.get(m.lastReadMessageId) ?? 0)
              : 0) >= lastSeq
        );
      if (allRead) {
        result.set(roomId, "READ");
        continue;
      }
      const lastMsg = lastMessageById.get(lastMessageId) as
        | { deliveredTo?: unknown }
        | undefined;
      const deliveredTo = Array.isArray(lastMsg?.deliveredTo)
        ? (lastMsg.deliveredTo as string[])
        : [];
      const otherIds = new Set(others.map((m) => m.userId));
      const anyDelivered = deliveredTo.some((id) => otherIds.has(id));
      result.set(roomId, anyDelivered ? "DELIVERED" : "SENT");
    }
    return result;
  }

  /**
   * Reaction OVERLAY read-time gate — see PrivateRoomService.enrichConversations
   * for the full rationale (identical semantics). Visible ONLY to its own actor
   * and (if different) the reacted-to message's owner, and ONLY while strictly
   * newer than the canonical lastMessageAt; every other member keeps the real
   * last message. Overwrites `lastMessagePreview` only — never lastMessageAt
   * (display-only, matches the delete-for-me overlay above).
   */
  private applyReactionOverlay<T extends GroupRoom>(
    rooms: T[],
    userId: string
  ): T[] {
    return rooms.map((room) => {
      const lastAt = room.lastMessageAt?.getTime() ?? 0;
      if (
        !room.reactionActivityAt ||
        room.reactionActivityAt.getTime() <= lastAt
      )
        return room;
      const isActor = room.reactionActivityActorId === userId;
      const isTarget = room.reactionActivityTargetId === userId;
      if (!isActor && !isTarget) return room;
      return {
        ...room,
        lastMessagePreview: {
          text: isActor
            ? (room.reactionActivityActorPreview ?? "")
            : (room.reactionActivityTargetPreview ?? ""),
          senderId: "",
          senderName: "",
          messageType: "SYSTEM",
          createdAt: room.reactionActivityAt,
        },
      } as T;
    });
  }

  async createGroup(params: {
    name: string;
    description?: string;
    avatar?: string;
    createdBy: string;
    memberLimit?: number;
  }): Promise<{ room: GroupRoom; member: GroupMember }> {
    const roomId = generateRoomId("grp");

    const room = await this.roomRepo.create({
      roomId,
      type: "GROUP",
      name: params.name,
      description: params.description || "",
      avatar: params.avatar || "",
      createdBy: params.createdBy,
      memberLimit: params.memberLimit || 256,
      memberCount: 1,
    });

    const member = await this.memberRepo.create({
      roomId,
      userId: params.createdBy,
      role: "ADMIN",
      status: "ACTIVE",
      joinedAt: new Date(),
    });

    // System message → sets lastMessageAt so the brand-new (message-less) group
    // appears and sorts in the unified inbox immediately.
    await this.sysMsg.post({
      roomId,
      actorId: params.createdBy,
      systemEvent: SystemEvent.GROUP_CREATED,
      systemData: { groupName: params.name },
    });

    logger.info(
      `GroupRoomService|createGroup|room=${roomId}, owner=${params.createdBy}`
    );

    // Re-read so the response reflects the lastMessageAt/preview the system
    // message just set (the `room` above predates that write). Falls back to the
    // original row if the post/read was a no-op.
    const fresh = await this.roomRepo.findActiveByRoomId(roomId);
    const finalRoom = fresh ?? room;
    if (!finalRoom) {
      throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    }

    // Resolve the logo object-key → download URL at the wire boundary (never
    // persist the URL — same contract as getRoom / getInboxGroups /
    // group:meta:updated). Raw keys must never reach the creator's inbox cache
    // or the create response, or the FE <img> falls back to the default avatar.
    const resolvedAvatar = await resolveMediaUrl(finalRoom.avatar ?? "");

    // Creator isn't in `conv:<roomId>` yet (joined only via explicit client
    // `conv:join`), so push the new group to their personal `user:<id>` channel
    // — same `group:added` shape group-member.service.ts uses for later adds,
    // so the existing frontend listener upserts it into the inbox with no
    // client-side change. Fire-and-forget: a publish failure must never fail
    // creation (mirrors PrivateRoomService's conv:created).
    publishChatUserEvent(this.redis, params.createdBy, "group:added", {
      type: "GROUP",
      roomId: finalRoom.roomId,
      lastMessageAt: finalRoom.lastMessageAt,
      lastMessageId: finalRoom.lastMessageId,
      lastMessage: finalRoom.lastMessagePreview ?? null,
      unreadCount: 0,
      isMuted: false,
      pinnedCount: finalRoom.pinnedCount,
      peer: null,
      name: finalRoom.name,
      avatar: resolvedAvatar,
      description: finalRoom.description,
      memberCount: finalRoom.memberCount,
      role: member.role,
      isJoined: true,
      addedAt: member.joinedAt,
    }).catch((err: unknown) => {
      logger.warn(
        `GroupRoomService|createGroup|group:added publish failed room=${roomId} user=${params.createdBy}: ${String(err)}`
      );
    });

    return {
      room: { ...finalRoom, avatar: resolvedAvatar },
      member,
    };
  }

  async getRoom(roomId: string, userId?: string): Promise<GroupRoomMembership> {
    const found = await this.roomRepo.findActiveByRoomId(roomId);
    if (!found) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    // Same read rule as the timeline and the roster: ACTIVE members, plus
    // voluntary leavers (who keep the frozen row in their inbox and must still
    // be able to open it). Kicked/banned/never-members are rejected — this
    // endpoint previously had NO gate at all, so anyone holding a roomId could
    // read the group's name, settings, member count AND the live
    // `lastMessagePreview` text, which defeated the leave/kick read cutoff
    // enforced everywhere else. Unauthenticated internal callers (no userId)
    // are unchanged.
    let membership: GroupMember | null = null;
    if (userId) {
      ({ member: membership } = await assertGroupReadAccess(
        this.memberRepo,
        roomId,
        userId
      ));
    }
    const isJoined = membership?.status === "ACTIVE";
    // An ex-member's detail preview is capped at their leave/removal instant
    // exactly like their inbox row (`applyLeftMemberPreviewCap`), so the
    // sidebar and the detail payload can never disagree about what they are
    // allowed to see.
    const [room] =
      userId && membership && groupReadCutoff(membership)
        ? await this.applyLeftMemberPreviewCap(
            [found],
            new Map([
              [
                roomId,
                {
                  status: membership.status,
                  leftAt: membership.leftAt,
                  kickedAt: membership.kickedAt,
                },
              ],
            ]),
            userId
          )
        : [found];
    // Resolve the room logo object key → download URL on read (never persisted).
    const avatar = await resolveMediaUrl(room.avatar);
    // Caller's OWN moderation-mute state, so a client that reconnects (or opens
    // the group cold) restores the disabled composer without waiting for a
    // `group:member:muted` socket event it may have missed while offline —
    // Scenario 4. Named exactly like community's detail payload
    // (`isMemberMuted`/`memberMutedUntil`); distinct from `isMuted`, which is
    // the caller's own NOTIFICATION mute.
    const isMemberMuted = isGroupMemberMuted(membership);
    return {
      ...room,
      avatar,
      isJoined,
      membershipStatus: membership?.status ?? null,
      isMemberMuted,
      memberMutedUntil:
        isMemberMuted && membership?.moderationMutedUntil
          ? membership.moderationMutedUntil.toISOString()
          : null,
      // Epoch-ms mirror (§6). ISO string above kept for existing clients.
      memberMutedUntilMs:
        isMemberMuted && membership?.moderationMutedUntil
          ? membership.moderationMutedUntil.getTime()
          : null,
    };
  }

  async updateRoom(
    roomId: string,
    userId: string,
    data: {
      name?: string;
      description?: string;
      avatar?: string;
      memberLimit?: number;
    }
  ): Promise<GroupRoom> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (member.role !== "ADMIN") {
      throw new BadRequestError("CHAT_ONLY_OWNER_ADMIN_UPDATE");
    }

    // Snapshot the pre-update values so we only post system messages for fields
    // that actually changed (a client may re-send unchanged values).
    const room = await this.roomRepo.findActiveByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    const updated = await this.roomRepo.updateRoom(roomId, data);
    if (!updated) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    // One system message per changed presentational field (memberLimit is silent).
    if (data.name != null && data.name !== room.name) {
      await this.sysMsg.post({
        roomId,
        actorId: userId,
        systemEvent: SystemEvent.ROOM_RENAMED,
        systemData: { newName: data.name },
      });
    }
    if (data.avatar != null && data.avatar !== room.avatar) {
      await this.sysMsg.post({
        roomId,
        actorId: userId,
        systemEvent: SystemEvent.AVATAR_CHANGED,
      });
    }
    if (data.description != null && data.description !== room.description) {
      await this.sysMsg.post({
        roomId,
        actorId: userId,
        systemEvent: SystemEvent.DESCRIPTION_CHANGED,
      });
    }

    // Real-time meta fan-out so every member's inbox row + open group header
    // updates without a refresh (parity with community:meta:updated). Fires only
    // when a presentational field changed. Resolves the avatar object-key to a
    // presigned URL at the publish boundary — raw keys must never leak on the wire.
    const nameChanged = data.name != null && data.name !== room.name;
    const avatarChanged = data.avatar != null && data.avatar !== room.avatar;
    const descriptionChanged =
      data.description != null && data.description !== room.description;
    if (nameChanged || avatarChanged || descriptionChanged) {
      void (async () => {
        try {
          const members = await this.memberRepo.findActiveMembers(roomId);
          if (!members.length) return;
          const resolvedAvatar = await resolveMediaUrl(updated.avatar ?? "");
          const payload = {
            type: "GROUP" as const,
            roomId,
            name: updated.name,
            avatar: resolvedAvatar,
            description: updated.description,
            memberCount: updated.memberCount,
            updatedBy: userId,
            updatedAt: Date.now(),
          };
          const pipeline = this.redis.pipeline();
          for (const m of members) {
            pipeline.publish(
              `user:${m.userId}`,
              JSON.stringify({ event: "group:meta:updated", data: payload })
            );
          }
          await pipeline.exec();
        } catch (err) {
          logger.warn(
            `GroupRoomService|updateRoom|group:meta:updated publish failed room=${roomId}: ${String(err)}`
          );
        }
      })();
    }

    // Resolve-on-read for the HTTP response (DB still holds the raw object key).
    const resolvedAvatar = await resolveMediaUrl(updated.avatar ?? "");
    return { ...updated, avatar: resolvedAvatar };
  }

  async disbandGroup(roomId: string, userId: string): Promise<GroupRoom> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (member.role !== "ADMIN") {
      throw new BadRequestError("CHAT_ONLY_OWNER_DISBAND");
    }

    const disbanded = await this.roomRepo.disband(roomId, userId);
    if (!disbanded) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    // Revoke all active invite links
    await this.inviteLinkRepo.revokeAllForRoom(roomId, userId);

    return disbanded;
  }

  /**
   * "Delete Conversation" for a group: clears the caller's own history view
   * (mirrors PrivateRoomService.deleteForMe) WITHOUT leaving the group — the
   * member stays ACTIVE, keeps receiving new messages, and the room reappears
   * in their inbox the moment one arrives, showing only messages sent after
   * this cutoff. Distinct from Leave, which removes membership entirely.
   *
   * Allowed for LEFT/KICKED members too, not just ACTIVE ones: their read-only
   * row is still in their conversation list, so "Delete Conversation" has to be
   * able to remove it — and once it is gone the group also stops being
   * searchable for them (see the gRPC `searchUserGroups` visibility rule).
   * BANNED is excluded, matching the inbox, which never lists it.
   */
  async clearConversation(roomId: string, userId: string): Promise<void> {
    const member = await this.memberRepo.findByRoomAndUser(roomId, userId);
    if (!member || !["ACTIVE", "LEFT", "KICKED"].includes(member.status)) {
      throw new NotFoundError("CHAT_NOT_A_MEMBER");
    }
    await this.memberRepo.setClearedAt(roomId, userId);

    // Notify the user's other devices the conversation was cleared from their view.
    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:deleted",
          data: { roomId, deletedBy: userId, type: "GROUP" },
        })
      )
      .catch(() => {});
  }

  async clearChat(roomId: string, userId: string): Promise<void> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    await this.memberRepo.setClearChatAt(roomId, userId);

    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:cleared",
          data: { roomId, clearedBy: userId, type: "GROUP" },
        })
      )
      .catch(() => {});

    // Same reasoning as PrivateRoomService.clearChat: the row stays but is now
    // empty for THIS member only, so its effective lastActivity is 0 and the
    // list must re-sort without a reload. Self-only — every other member keeps
    // the shared preview.
    publishConvUpdatedSafe({
      redis: this.redis,
      type: "GROUP",
      roomId,
      recipientIds: [userId],
      senderId: "",
      lastMessageId: "",
      lastMessageAt: 0,
      preview: { contentType: "", text: "", createdAt: 0 },
      // An emptied row is not a new message — must never raise an unread badge.
      countInUnread: false,
    });
  }

  async getUserGroups(
    userId: string,
    params: { limit: number; cursor?: string | null; q?: string }
  ): Promise<GroupRoomMembership[]> {
    const memberships = await this.memberRepo.getActiveMemberships(userId);
    if (!memberships.length) return [];
    const clearedByRoom = new Map(
      memberships.map((m) => [m.roomId, m.clearedAt])
    );
    const roomIds = [...clearedByRoom.keys()];
    const rawRooms = (
      await this.roomRepo.getUserGroups(userId, roomIds, params)
    ).filter((r) => isVisibleAfterClear(r, clearedByRoom.get(r.roomId)));
    const membershipByRoom = new Map(memberships.map((m) => [m.roomId, m]));
    // Per-user visibility: swap in the viewer's previous-visible preview for any
    // room whose shared last message they have hidden (delete-for-me / global).
    const rooms = await this.enrichLastMessageSenderNames(
      this.applyClearChatPreviewCap(
        await this.applyPerUserPreview(rawRooms, userId),
        membershipByRoom
      )
    );
    // Resolve every room logo on this page ONCE (deduped) → download URLs.
    const avatarUrls = await resolveMediaUrlMap(rooms.map((r) => r.avatar));
    const activityByRoom = this.lastActivityByRoom(rawRooms, rooms);
    // Every row here is a group the caller is an ACTIVE member of.
    return rooms.map((room) => {
      const lastActivity =
        activityByRoom.get(room.roomId) ?? EMPTY_GROUP_LAST_ACTIVITY;
      return {
        ...room,
        avatar: urlFromMap(avatarUrls, room.avatar),
        isJoined: true,
        lastActivity,
        lastActivityAt: lastActivity.dateTime,
      };
    });
  }

  async countUserGroups(userId: string, q?: string): Promise<number> {
    // Matches getInboxGroups' membership source (ACTIVE + LEFT) so this total
    // stays consistent with what the inbox page actually returns.
    const memberships =
      await this.memberRepo.getActiveOrLeftMemberships(userId);
    if (!memberships.length) return 0;
    const clearedByRoom = new Map(
      memberships.map((m) => [m.roomId, m.clearedAt])
    );
    const rows = await this.roomRepo.findLastMessageAtForRooms(
      [...clearedByRoom.keys()],
      q
    );
    return rows.filter((r) =>
      isVisibleAfterClear(r, clearedByRoom.get(r.roomId))
    ).length;
  }

  /**
   * Total unread group messages across every group the user's an active
   * member of — for the Chats nav badge. Same membership lookup + visibility
   * filter as countUserGroups, summing each membership's already-maintained
   * `unreadCount` instead of counting rooms.
   */
  async sumUnreadForUser(userId: string): Promise<number> {
    const memberships = await this.memberRepo.getActiveMemberships(userId);
    if (!memberships.length) return 0;
    const clearedByRoom = new Map(
      memberships.map((m) => [m.roomId, m.clearedAt])
    );
    const unreadByRoom = new Map(
      memberships.map((m) => [m.roomId, m.unreadCount])
    );
    const rows = await this.roomRepo.findLastMessageAtForRooms([
      ...clearedByRoom.keys(),
    ]);
    return rows
      .filter((r) => isVisibleAfterClear(r, clearedByRoom.get(r.roomId)))
      .reduce((sum, r) => sum + (unreadByRoom.get(r.roomId) ?? 0), 0);
  }

  async archiveRoom(roomId: string, userId: string): Promise<GroupRoom> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const room = await this.roomRepo.findActiveByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    const updated = await this.roomRepo.setArchived(roomId, userId);
    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:archived",
          data: { roomId, type: "GROUP", archivedAt: Date.now() },
        })
      )
      .catch(() => {});
    return updated ?? room;
  }

  async unarchiveRoom(roomId: string, userId: string): Promise<GroupRoom> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const room = await this.roomRepo.findActiveByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    const updated = await this.roomRepo.setUnarchived(roomId, userId);
    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:unarchived",
          data: { roomId, type: "GROUP" },
        })
      )
      .catch(() => {});
    return updated ?? room;
  }

  /**
   * Timestamp-bounded group fetch for the unified inbox, enriched with the
   * viewer's per-room unread count, mute state, and role.
   */
  async getInboxGroups(params: {
    userId: string;
    direction: "before" | "after";
    ts: Date;
    /** V2 compound-cursor tiebreaker; omitted on V1 (inclusive bare-ts bound). */
    boundaryId?: string | null;
    inclusive?: boolean;
    limit: number;
  }): Promise<EnrichedGroupRoom[]> {
    const memberships = await this.memberRepo.getActiveOrLeftMemberships(
      params.userId
    );
    if (!memberships.length) return [];

    const membershipByRoom = new Map(memberships.map((m) => [m.roomId, m]));
    const roomIds = memberships.map((m) => m.roomId);

    const rawRooms = (
      await this.roomRepo.getInboxGroups({
        roomIds,
        direction: params.direction,
        ts: params.ts,
        boundaryId: params.boundaryId,
        inclusive: params.inclusive,
        limit: params.limit,
      })
    ).filter((r) =>
      isVisibleAfterClear(r, membershipByRoom.get(r.roomId)?.clearedAt)
    );
    // Per-user visibility: swap in the viewer's previous-visible preview for any
    // room whose shared last message they have hidden (delete-for-me / global).
    const rooms = await this.enrichLastMessageSenderNames(
      await this.applyLeftMemberPreviewCap(
        this.applyClearChatPreviewCap(
          await this.applyPerUserPreview(rawRooms, params.userId),
          membershipByRoom
        ),
        membershipByRoom,
        params.userId
      )
    );

    // Resolve every room logo on this page ONCE (deduped) → download URLs, so
    // the unified inbox renders a usable avatar instead of a raw object key.
    const avatarUrls = await resolveMediaUrlMap(rooms.map((r) => r.avatar));
    const readStatusByRoom = await this.computeLastMessageReadStatuses(
      rooms,
      params.userId
    );
    const activityByRoom = this.lastActivityByRoom(rawRooms, rooms);

    const now = Date.now();
    return rooms.map((room) => {
      const membership = membershipByRoom.get(room.roomId);
      const settings = (membership?.notificationSettings ?? {}) as {
        mute?: boolean;
        muteUntil?: string | null;
      };
      // Same rule as the push oracle (`checkGroupMute`) and as PRIVATE rooms:
      // muted with no expiry = indefinite, expiry in the future = still muted,
      // expiry in the past = lapsed. The old `mute === true || …` reported a
      // timed mute as muted FOREVER (setMuted always writes `mute: true`), so
      // the list bell contradicted the pushes the user was already getting.
      const isMuted =
        settings.mute === true &&
        (settings.muteUntil == null ||
          new Date(settings.muteUntil).getTime() > now);
      const isJoined = membership?.status === "ACTIVE";
      const hasLeft = membership?.status === "LEFT";
      const isRemoved = membership?.status === "KICKED";
      const isMemberMuted = isGroupMemberMuted(membership);
      // Per-viewer effective activity, read off the SAME preview the per-user
      // passes above produced (delete-for-me override / clear-chat cap /
      // ex-member cap), so preview and timestamp can never disagree.
      const lastActivity =
        activityByRoom.get(room.roomId) ?? EMPTY_GROUP_LAST_ACTIVITY;
      return {
        ...room,
        lastActivity,
        lastActivityAt: lastActivity.dateTime,
        avatar: urlFromMap(avatarUrls, room.avatar),
        membershipStatus: membership?.status ?? null,
        isRemoved,
        isMuted,
        isMemberMuted,
        memberMutedUntil:
          isMemberMuted && membership?.moderationMutedUntil
            ? membership.moderationMutedUntil.toISOString()
            : null,
        // Epoch-ms mirror (§6). ISO string above kept for existing clients.
        memberMutedUntilMs:
          isMemberMuted && membership?.moderationMutedUntil
            ? membership.moderationMutedUntil.getTime()
            : null,
        // A left member accrues no unread — their cursor is frozen at leftAt.
        unreadCount: isJoined ? (membership?.unreadCount ?? 0) : 0,
        role: membership?.role ?? "MEMBER",
        isJoined,
        hasLeft,
        lastMessageReadStatus: readStatusByRoom.get(room.roomId) ?? null,
      };
    });
  }
}
