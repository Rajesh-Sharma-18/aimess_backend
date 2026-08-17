import { logger } from "@aimess/logger";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";
import type { Redis, Cluster } from "ioredis";

import {
  buildGroupSystemFallbackText,
  isTerminalCallStatus,
  resolveGroupSystemSubjectUserId,
  resolvePersonDisplayName,
} from "@aimess/constants";
import { readCallStatus } from "./call-chat-message.service.js";
import type { SystemEvent } from "../types/enums.js";
import {
  buildChatMessageEvent,
  buildDeletePayload,
} from "../lib/chat-message.serializer.js";
import { publishConvUpdatedSafe } from "../events/publish-conv-updated.js";
import { resolveMediaUrl } from "../lib/media-resolve.js";
import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import { shouldCountInUnread } from "../lib/unread-count.js";
import { systemMessageBumpsActivity } from "../lib/system-message-policy.js";

// Group lifecycle events mirrored into the admin panel's audit log. Everything absent
// here (calls, pins, invites, friendship, auto-delete) is chatter, not moderation signal.
export const ADMIN_ACTIVITY_BY_SYSTEM_EVENT: Partial<
  Record<SystemEvent, string>
> = {
  GROUP_CREATED: USER_AUDIT_ACTIONS.GROUP_CREATED,
  MEMBER_ADDED: USER_AUDIT_ACTIONS.GROUP_MEMBER_ADDED,
  MEMBER_JOINED: USER_AUDIT_ACTIONS.GROUP_MEMBER_ADDED,
  MEMBER_LEFT: USER_AUDIT_ACTIONS.GROUP_MEMBER_LEFT,
  MEMBER_REMOVED: USER_AUDIT_ACTIONS.GROUP_MEMBER_REMOVED,
  MEMBER_BANNED: USER_AUDIT_ACTIONS.GROUP_MEMBER_BANNED,
  MEMBER_UNBANNED: USER_AUDIT_ACTIONS.GROUP_MEMBER_UNBANNED,
  ROOM_RENAMED: USER_AUDIT_ACTIONS.GROUP_UPDATED,
  AVATAR_CHANGED: USER_AUDIT_ACTIONS.GROUP_UPDATED,
  DESCRIPTION_CHANGED: USER_AUDIT_ACTIONS.GROUP_UPDATED,
  // Disappearing-messages timer: a setting change that hides message history from
  // moderation, so it belongs in the trail even though the rest of chat chatter does not.
  AUTO_DELETE_UPDATED: USER_AUDIT_ACTIONS.GROUP_UPDATED,
  ROLE_CHANGED: USER_AUDIT_ACTIONS.GROUP_ROLE_CHANGED,
  ADMIN_ASSIGNED: USER_AUDIT_ACTIONS.GROUP_ROLE_CHANGED,
  ADMIN_REMOVED: USER_AUDIT_ACTIONS.GROUP_ROLE_CHANGED,
  OWNERSHIP_TRANSFERRED: USER_AUDIT_ACTIONS.GROUP_ROLE_CHANGED,
};

/**
 * ROLE_CHANGED covers moderator grants, admin hand-offs and plain demotions
 * alike. Moderator grants/removals are their own mandatory audit category, so
 * the `newRole`/`oldRole` the caller already puts in `systemData` splits them
 * out; everything else stays the generic role change.
 */
function refineGroupAuditAction(
  systemEvent: SystemEvent,
  systemData: Record<string, unknown>
): string | undefined {
  const mirrored = ADMIN_ACTIVITY_BY_SYSTEM_EVENT[systemEvent];
  if (mirrored !== USER_AUDIT_ACTIONS.GROUP_ROLE_CHANGED) return mirrored;

  const newRole = String(systemData.newRole ?? "").toUpperCase();
  const oldRole = String(systemData.oldRole ?? "").toUpperCase();
  if (newRole === "MODERATOR")
    return USER_AUDIT_ACTIONS.GROUP_MODERATOR_PROMOTED;
  if (oldRole === "MODERATOR")
    return USER_AUDIT_ACTIONS.GROUP_MODERATOR_DEMOTED;
  return mirrored;
}

export interface PostSystemMessageParams {
  roomId: string;
  /** User who triggered the event (null for a pure-system event). */
  actorId: string | null;
  systemEvent: SystemEvent;
  /** Event-specific fields (e.g. targetUserId, newRole, newName). */
  systemData?: Record<string, unknown>;
  /**
   * Suppress the admin-panel audit mirror. Set only by platform-admin paths,
   * where backoffice-service already recorded the canonical row against the
   * acting admin — without this one action would land twice.
   */
  skipAdminActivity?: boolean;
  /**
   * Stored/broadcast message kind. Defaults to "SYSTEM" — the only reason to
   * override is a lifecycle row the client renders as a dedicated card rather
   * than a grey system line, i.e. CALL_ENDED rows which are persisted as
   * VOICE_CALL / VIDEO_CALL. Unread accounting and sender-less rendering still
   * follow `systemEvent`, not this field (see `shouldCountInUnread`).
   */
  messageType?: string;
  /**
   * Extra keys merged into the stored `content` alongside the derived
   * `{ text, urls, files }` — e.g. the `call` sub-object a CALL_ENDED row
   * carries so clients render the call card from structured metadata instead of
   * parsing the text. Private DM call rows carry the identical sub-object.
   */
  contentExtra?: Record<string, unknown>;
  /**
   * Idempotency / upsert key. Only set by lifecycle rows that must stay a
   * SINGLE row across many state changes — today just call rows, which use
   * `call:<callId>` for the whole RINGING → … → ENDED sequence.
   */
  clientMessageId?: string | null;
  /**
   * When set, the real-time `message:new` fan-out to `conv:<roomId>` skips this
   * user's own sockets (the gateway honors an envelope-level `excludeUserId`).
   * Used by ban/kick so the removed member never receives the room line
   * announcing their own removal, while every other member still does. The row
   * is still persisted for the remaining members' history.
   */
  excludeUserId?: string | null;
}

/**
 * Posts SYSTEM messages for group lifecycle events ("X created the group",
 * "X added Y", "X left", role/rename/avatar changes, …).
 *
 * Each post: persists a GroupMessage with a `systemEvent`
 * code + structured `systemData` (clients localize from these) plus an English
 * `content.text` fallback for previews; bumps the room's `lastMessageAt` +
 * `lastMessagePreview` so the group surfaces and sorts in the unified inbox; and
 * fans out over Redis `conv:<roomId>` as `message:new` (same shape as a real
 * send). The stored kind is "SYSTEM" unless the caller overrides it (CALL_ENDED
 * rows persist as VOICE_CALL / VIDEO_CALL — see `PostSystemMessageParams`).
 * It does NOT increment unread counts — lifecycle chatter shouldn't raise
 * badges. The whole operation is best-effort: failures are logged, never thrown,
 * so a lifecycle action never fails because its system message did.
 */
export class GroupSystemMessageService {
  constructor(
    private readonly messageRepo: GroupMessageRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly redis: Redis | Cluster
  ) {}

  async post(params: PostSystemMessageParams): Promise<void> {
    await this.postOne(params);
  }

  /** Like post() but returns the created system message ID (or null on failure) — used by the pin flow to store a retractable back-reference. */
  async postReturnId(params: PostSystemMessageParams): Promise<string | null> {
    return this.postOne(params);
  }

  private async postOne(
    params: PostSystemMessageParams
  ): Promise<string | null> {
    const { roomId, actorId, systemEvent } = params;
    const messageType = params.messageType ?? "SYSTEM";
    const inData = params.systemData ?? {};
    const targetUserId =
      typeof inData.targetUserId === "string" ? inData.targetUserId : null;
    // Batch lifecycle rows (one add-member operation ⇒ one MEMBER_ADDED line)
    // carry every affected member here instead of a single `targetUserId`.
    const targetUserIds = Array.isArray(inData.targetUserIds)
      ? inData.targetUserIds.map((id) => String(id)).filter(Boolean)
      : [];

    // Every group lifecycle event funnels through here, so the admin-panel mirror
    // lives here too rather than at each service call site. `skipAdminActivity`
    // is set by the platform-admin paths, where backoffice-service already wrote
    // the canonical row with the acting admin's identity on it.
    const mirrored = params.skipAdminActivity
      ? undefined
      : refineGroupAuditAction(systemEvent, inData);
    if (mirrored) {
      // A membership/role event is about the PERSON; a room-level event is about
      // the room. The other id stays in the metadata either way.
      const targetsUser = Boolean(targetUserId);
      publishAdminActivitySafe({
        actorId,
        action: mirrored,
        targetType: targetsUser ? "user" : "group",
        targetId: targetsUser ? targetUserId : roomId,
        after: {
          systemEvent,
          roomId,
          targetUserIds: targetUserId ? [targetUserId] : targetUserIds,
        },
      });
    }

    try {
      const ids = [actorId, targetUserId, ...targetUserIds].filter(
        (id): id is string => Boolean(id)
      );
      const snapshots = ids.length
        ? await this.userSnapshotService.getUserSnapshotsMap(
            ids,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

      const actorName = this.nameOf(snapshots, actorId);
      const targetName = this.nameOf(snapshots, targetUserId);
      const actorAvatar = actorId
        ? ((snapshots.get(actorId)?.avatar as string) ?? "")
        : "";

      const targetNames = targetUserIds.map((id) => this.nameOf(snapshots, id));

      // Resolved names are folded into systemData so clients can render without
      // a second lookup, while keeping the raw ids for navigation.
      const systemData: Record<string, unknown> = {
        ...inData,
        actorId,
        actorName,
        ...(targetUserId ? { targetUserId, targetName } : {}),
        ...(targetUserIds.length ? { targetUserIds, targetNames } : {}),
      };

      const text = buildGroupSystemFallbackText(systemEvent, systemData);

      // Allocate the per-room monotonic sequence (same as a real send) so
      // lifecycle/system messages flow through chat:catchup (seq > sinceSeq)
      // on reconnect instead of defaulting to 0 — which both excluded them
      // from gap-fill and broke the monotonic guarantee (many rows at seq 0).
      const seq = await this.roomRepo.allocateSequence(roomId);

      const content: Record<string, unknown> = {
        text,
        urls: [],
        files: [],
        ...(params.contentExtra ?? {}),
      };

      const message = await this.messageRepo.create({
        roomId,
        senderId: actorId,
        senderName: actorName,
        senderAvatar: actorAvatar,
        messageType,
        systemEvent,
        systemData,
        content,
        sequenceNumber: seq,
        clientMessageId: params.clientMessageId ?? null,
      });

      // Bump inbox order/preview (no unread increment) — gated per-subtype so
      // membership churn (join/left/removed) can't reorder the list, matching
      // Community's SYSTEM_MESSAGE_BUMPS_ACTIVITY.
      if (systemMessageBumpsActivity(systemEvent)) {
        await this.roomRepo.updateLastMessage(roomId, {
          _id: message.id,
          senderId: message.senderId ?? null,
          senderName: message.senderName,
          messageType: message.messageType,
          content: { text },
          createdAt: message.createdAt,
          clientMessageId: message.clientMessageId,
          sequenceNumber: message.sequenceNumber,
          revision: message.revision,
          // Persisted next to the baked English so a REST inbox read can
          // re-render this preview in the reader's language.
          systemEvent,
          systemData,
        });
      }

      if (
        shouldCountInUnread({
          messageType: message.messageType,
          systemEvent,
          explicit: (message as unknown as { countInUnread?: boolean | null })
            .countInUnread,
        })
      ) {
        this.memberRepo
          .incUnreadForRoom(roomId, actorId ?? "", 1)
          .catch((err: unknown) => {
            logger.warn(
              `GroupSystemMessageService|incUnreadForRoom failed room=${roomId}: ${String(err)}`
            );
          });
      }

      // Real-time fan-out (best-effort) — same channel/event AND canonical
      // ChatMessage shape as a real send (§1/§9), with the SYSTEM extras.
      const sysServerTs =
        message.createdAt instanceof Date
          ? message.createdAt.getTime()
          : Date.now();
      // Resolve the actor avatar key → download URL on the SERIALIZE-OUT
      // boundary only; the persisted senderAvatar above keeps the raw key.
      const actorAvatarUrl = await resolveMediaUrl(actorAvatar);

      // Inbox bump for every member — `message:new` above only reaches sockets
      // already joined to `conv:<roomId>`, which excludes anyone sitting on the
      // chats list. Community's system service does the same (§community-system
      // -message.service.ts publishCommunityUpdatedSafe). Gated the same as the
      // DB write above — a non-bumping event (member left/removed, unpin, …)
      // must not reorder the recipient's inbox either.
      if (systemMessageBumpsActivity(systemEvent)) {
        // The subject member's own list row should read "You were added" /
        // "Alex promoted you to admin" rather than the shared third-person
        // line — mirrors Community's subjectUserId/selfPreview personalization.
        const subjectUserId = resolveGroupSystemSubjectUserId(
          systemEvent,
          systemData
        );
        const selfPreview = subjectUserId
          ? buildGroupSystemFallbackText(systemEvent, systemData, subjectUserId)
          : undefined;

        publishConvUpdatedSafe({
          redis: this.redis,
          type: "GROUP",
          roomId,
          fetchRecipients: async () =>
            (
              await this.memberRepo.findActiveMembers(roomId, { limit: 500 })
            ).map((m) => m.userId),
          senderId: "",
          lastMessageId: message.id,
          lastMessageAt: sysServerTs,
          // `text` is the write-time English; the canonical pair travels with it
          // so the gateway can re-render the row in each recipient's language
          // (see publish-conv-updated.ts BumpPreview).
          preview: { contentType: messageType, text, systemEvent, systemData },
          countInUnread: false,
          ...(subjectUserId && selfPreview
            ? { subjectUserId, selfPreview }
            : {}),
        });
      }

      this.redis
        .publish(
          `conv:${roomId}`,
          JSON.stringify({
            event: "message:new",
            ...(params.excludeUserId
              ? { excludeUserId: params.excludeUserId }
              : {}),
            data: buildChatMessageEvent({
              id: message.id,
              roomId,
              conversationType: "GROUP",
              senderId: actorId ?? "",
              senderName: actorName,
              senderAvatar: actorAvatarUrl,
              messageType,
              content: message.content ?? content,
              reactions: [],
              serverTs: sysServerTs,
              sequenceNumber: seq,
              systemEvent,
              systemData,
              countInUnread: (
                message as unknown as {
                  countInUnread?: boolean | null;
                }
              ).countInUnread,
            }),
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `GroupSystemMessageService|publish failed room=${roomId}: ${String(err)}`
          );
        });
      return message.id;
    } catch (err) {
      logger.warn(
        `GroupSystemMessageService|post failed event=${systemEvent} room=${roomId}: ${String(err)}`
      );
      return null;
    }
  }

  /**
   * GROUP twin of `CallChatMessageService.post` — ONE CALL === ONE ROW.
   *
   * The row is written when the group call starts ringing and then transitions
   * IN PLACE (same message id, same `createdAt`, same `callId`) as the call is
   * answered, declined or ends, so members see a live card instead of a pile of
   * one-per-state rows. Insert broadcasts `message:new`, every later state
   * broadcasts `message:edited`; both carry the full canonical ChatMessage, so
   * a client applies either by replacing the row with that id. The bumped room
   * revision is what replays the final state through `/changes` to members who
   * were offline for the whole call.
   *
   * Best-effort like every other method here: a failure here must never roll
   * back the authoritative call transition that triggered it.
   */
  async postOrUpdateCall(
    params: PostSystemMessageParams & { callId: string }
  ): Promise<void> {
    const clientMessageId = `call:${params.callId}`;
    const { roomId } = params;
    try {
      const existing = await this.messageRepo.findByClientMessageId(
        roomId,
        clientMessageId
      );
      if (!existing) {
        await this.postOne({ ...params, clientMessageId });
        return;
      }

      // Terminal is terminal — a late duplicate (retry, racing sweep, LiveKit
      // webhook after the user's own hangup) must not rewrite an ended card.
      const status = String(
        (params.systemData?.status as string) ?? ""
      ).toUpperCase();
      const current = readCallStatus(existing.content);
      if (isTerminalCallStatus(current) || current === status) return;

      const messageType = params.messageType ?? "SYSTEM";
      const systemData: Record<string, unknown> = {
        ...(params.systemData ?? {}),
        actorId: params.actorId,
        actorName: "",
      };
      const text = buildGroupSystemFallbackText(params.systemEvent, systemData);
      const content: Record<string, unknown> = {
        text,
        urls: [],
        files: [],
        ...(params.contentExtra ?? {}),
      };

      const message = await this.messageRepo.updateCallState({
        messageId: existing.id,
        roomId,
        content,
        messageType,
        systemEvent: params.systemEvent,
        systemData,
        // Lifecycle rows never raise a group badge (matches postOne, where a
        // `systemEvent`-bearing row is excluded by `shouldCountInUnread`).
        countInUnread: false,
      });

      // The card keeps the timestamp it rang at — see CallChatMessageService.
      const serverTs =
        existing.createdAt instanceof Date
          ? existing.createdAt.getTime()
          : Date.now();

      await this.redis
        .publish(
          `conv:${roomId}`,
          JSON.stringify({
            event: "message:edited",
            data: buildChatMessageEvent({
              id: message.id,
              clientMessageId,
              roomId,
              conversationType: "GROUP",
              senderId: "",
              senderName: "",
              senderAvatar: "",
              messageType,
              content: message.content ?? content,
              reactions: [],
              serverTs,
              sequenceNumber: existing.sequenceNumber ?? 0,
              systemEvent: params.systemEvent,
              systemData,
              countInUnread: false,
            }),
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `GroupSystemMessageService|call publish failed room=${roomId}: ${String(err)}`
          );
        });

      // Refresh the inbox preview only while the call row is still the room's
      // last message — otherwise a message sent mid-call would get rewound.
      const room = await this.roomRepo.findByRoomId(roomId).catch(() => null);
      if (
        systemMessageBumpsActivity(params.systemEvent) &&
        (room as { lastMessageId?: string } | null)?.lastMessageId ===
          existing.id
      ) {
        await this.roomRepo
          .updateLastMessage(roomId, {
            _id: message.id,
            senderId: null,
            senderName: "",
            messageType,
            content: { text },
            createdAt: existing.createdAt,
            clientMessageId: message.clientMessageId,
            sequenceNumber: message.sequenceNumber,
            revision: message.revision,
            systemEvent: params.systemEvent,
            systemData,
          })
          .catch((err: unknown) => {
            logger.warn(
              `GroupSystemMessageService|call lastMessage failed room=${roomId}: ${String(err)}`
            );
          });

        publishConvUpdatedSafe({
          redis: this.redis,
          type: "GROUP",
          roomId,
          fetchRecipients: async () =>
            (
              await this.memberRepo.findActiveMembers(roomId, { limit: 500 })
            ).map((m) => m.userId),
          senderId: "",
          lastMessageId: message.id,
          lastMessageAt: serverTs,
          preview: {
            contentType: messageType,
            text,
            systemEvent: params.systemEvent,
            systemData,
          },
          countInUnread: false,
        });
      }
    } catch (err) {
      logger.warn(
        `GroupSystemMessageService|postOrUpdateCall failed callId=${params.callId} room=${roomId}: ${String(err)}`
      );
    }
  }

  /**
   * Hard-hides a system message this service previously posted — currently
   * only the MESSAGE_PINNED line tied to a pin that was since undone (unpinned,
   * or replaced by pinning a different message). Same tombstone mechanism as a
   * normal message delete-for-everyone; just triggered by pin lifecycle instead
   * of a user delete action. Mirrors `CommunitySystemMessageService.retractSystemMessage`.
   * Best-effort: never throws — the pin state change that triggered this must
   * not roll back on a failure here.
   */
  async retractSystemMessage(params: {
    roomId: string;
    messageId: string;
    actorId: string;
  }): Promise<void> {
    const { roomId, messageId, actorId } = params;
    try {
      const deleted = await this.messageRepo.deleteForEveryone(
        messageId,
        roomId,
        actorId,
        "ADMIN_DELETE"
      );
      if (!deleted) return;
      const tombstone = buildDeletePayload({
        conversationType: "GROUP",
        messageId: deleted.id,
        roomId: deleted.roomId,
        scope: "forEveryone",
        deletedBy: actorId,
        sequenceNumber: deleted.sequenceNumber,
        deletedType: "ADMIN_DELETE",
      });
      await this.redis.publish(
        `conv:${roomId}`,
        JSON.stringify({ event: "message:delete", data: tombstone })
      );
    } catch (err) {
      logger.warn(
        `GroupSystemMessageService|retractSystemMessage failed messageId=${messageId}: ${String(err)}`
      );
    }
  }

  private nameOf(
    snapshots: Map<string, Record<string, unknown>>,
    userId: string | null
  ): string {
    if (!userId) return "";
    return resolvePersonDisplayName(snapshots.get(userId));
  }
}
