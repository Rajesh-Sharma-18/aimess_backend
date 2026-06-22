import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import {
  SYSTEM_MESSAGE_VISIBILITY,
  SYSTEM_MESSAGE_BUMPS_ACTIVITY,
  type CommunitySystemMessageType,
} from "@aimess/constants";
import { normalizeMessageType } from "../lib/chat-message.serializer.js";
import { isDuplicateKeyError } from "../lib/db-errors.js";
import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import { publishCommunityActivitySafe } from "../events/publish-community-activity.js";
import { publishCommunityUpdatedSafe } from "../events/publish-conv-updated.js";

export interface PostCommunitySystemMessageParams {
  communityId: string;
  systemMessageType: CommunitySystemMessageType;
  metadata: Record<string, unknown>;
  /** The user who triggered the event (the actor). Recorded in metadata only. */
  triggeredByUserId: string;
  /**
   * For PERSONAL subtypes (COMMUNITY_JOINED, JOIN_REQUEST_*), the userId who
   * should see the message. Required for PERSONAL subtypes; ignored otherwise.
   * Visibility itself is derived from SYSTEM_MESSAGE_VISIBILITY, not passed.
   */
  visibleToUserId?: string;
  /**
   * ISO timestamp stamped by the producer when the originating event occurred.
   * Stable across RabbitMQ redeliveries, so it anchors the idempotency key that
   * prevents a redelivered event from posting a duplicate system line. Omit for
   * direct/local posts (pin/unpin) that don't flow through the redelivery-prone
   * `community.system_message` queue.
   */
  eventAt?: string;
}

/**
 * Posts SYSTEM messages for community lifecycle events (Telegram-style).
 *
 * Behaviour is driven entirely by the central registry in @aimess/constants:
 * - SYSTEM_MESSAGE_VISIBILITY decides PERSONAL (→ user:<id> channel, persisted
 *   with visibleToUserId) vs COMMUNITY (→ community:<id> room).
 * - SYSTEM_MESSAGE_BUMPS_ACTIVITY decides whether the community-list preview is
 *   bumped (most do; unpin / invite-created / personal lines do not).
 *
 * The text is a DETERMINISTIC template (buildFallbackText) — never a dynamically
 * composed sentence. The client renders localized text from systemMessageType +
 * systemMetadata; the stored text is the English fallback. SYSTEM messages are
 * SENDER-LESS: the wire carries no senderId/senderName/senderAvatar — the actor
 * lives in systemMetadata.actorUserId/actorName only.
 *
 * Posts are best-effort: failures are logged, never thrown.
 */
export class CommunitySystemMessageService {
  constructor(
    private readonly messageRepo: GeneralRoomMessageRepository,
    private readonly roomRepo: GeneralRoomRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly redis: Redis | Cluster,
    /**
     * Optional — when provided, COMMUNITY-visible system lines that bump activity
     * ALSO fan out a sender-less `community:updated` socket bump so the community
     * LIST reorders + shows the new line in real time (parity with the normal
     * send path in service-impl.ts / chat-message-orchestrator.ts). Optional so
     * the 5-arg test construction sites keep working untouched; production wires
     * it in server.ts and the room-sync consumer.
     */
    private readonly memberRepo?: RoomMemberRepository
  ) {}

  async post(params: PostCommunitySystemMessageParams): Promise<void> {
    await this.postOne(params);
  }

  private async postOne(
    params: PostCommunitySystemMessageParams
  ): Promise<void> {
    const { communityId, systemMessageType, metadata, triggeredByUserId } =
      params;

    const visibility =
      SYSTEM_MESSAGE_VISIBILITY[systemMessageType] ?? "COMMUNITY";
    const bumpsActivity =
      SYSTEM_MESSAGE_BUMPS_ACTIVITY[systemMessageType] ?? false;
    const isPersonal = visibility === "PERSONAL";
    const visibleToUserId = isPersonal
      ? (params.visibleToUserId ?? null)
      : null;

    try {
      const targetUserId =
        typeof metadata.targetUserId === "string"
          ? metadata.targetUserId
          : null;
      const ids = [triggeredByUserId, targetUserId].filter((id): id is string =>
        Boolean(id)
      );
      const snapshots = ids.length
        ? await this.userSnapshotService.getUserSnapshotsMap(
            ids,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

      const actorName = this.nameOf(snapshots, triggeredByUserId);
      const targetName = this.nameOf(snapshots, targetUserId);

      // actorUserId is the single consistent key across all subtypes so the
      // client can do `metadata.actorUserId === currentUserId` → render "You".
      const enrichedMetadata: Record<string, unknown> = {
        ...metadata,
        actorUserId: triggeredByUserId,
        actorName,
        ...(targetUserId ? { targetName } : {}),
      };

      const fallbackText = buildFallbackText(
        systemMessageType,
        enrichedMetadata,
        actorName,
        targetName
      );

      // Idempotency: a `community.system_message` event can be REDELIVERED
      // (at-least-once queue; broker redelivers on ack-loss). Each event carries
      // a producer `eventAt`, stable across redeliveries, so derive a
      // deterministic dedup key — one logical event ⇒ one timeline line, no
      // duplicate "Community info was updated" / "X joined" bubbles. Two genuinely
      // distinct events differ in (type, eventAt, target) so both persist.
      const dedupeKey = params.eventAt
        ? `sys:${systemMessageType}:${params.eventAt}${
            targetUserId ? `:${targetUserId}` : ""
          }`
        : null;

      // Cheap pre-check skips the sequence allocation + bump + publish on a
      // redelivery (sequential case); the unique-index insert below is the race
      // backstop for concurrent redeliveries.
      if (dedupeKey) {
        const existing = await this.messageRepo.findOne({
          roomId: communityId,
          clientMessageId: dedupeKey,
        });
        if (existing) {
          logger.debug(
            `CommunitySystemMessageService|skip duplicate (replay) type=${systemMessageType} key=${dedupeKey}`
          );
          return;
        }
      }

      const seq = await this.roomRepo.allocateSequence(communityId);

      const message = await this.messageRepo
        .createSystemMessage({
          roomId: communityId,
          systemMessageType,
          metadata: enrichedMetadata,
          // sentBy is retained internally for audit, but is NEVER surfaced on the
          // wire for SYSTEM messages (toWire strips it).
          triggeredByUserId,
          triggeredByName: actorName,
          sequenceNumber: seq,
          fallbackText,
          visibleToUserId,
          clientMessageId: dedupeKey,
        })
        .catch((err: unknown) => {
          // Concurrent redelivery lost the unique-index race — already persisted
          // by the winning delivery. Treat as an idempotent no-op.
          if (dedupeKey && isDuplicateKeyError(err)) return null;
          throw err;
        });

      // Duplicate replay — the line (and its bump/publish) already happened on
      // the first delivery; do nothing further.
      if (!message) return;

      // Bump the community-list ordering only for subtypes that should reorder
      // the chat list (registry-driven). No unread increment — system messages
      // never badge.
      if (bumpsActivity) {
        this.roomRepo
          .addLastestMessageToRoom(communityId, {
            _id: message.id,
            sentBy: message.sentBy,
            senderName: message.senderName ?? "",
            message: message.message ?? "",
            messageType: message.messageType,
            createdAt: message.createdAt,
          })
          .catch((err: unknown) => {
            logger.warn(
              `CommunitySystemMessageService|addLastestMessageToRoom failed: ${String(err)}`
            );
          });
      }

      const serverTs =
        message.createdAt instanceof Date
          ? message.createdAt.getTime()
          : Date.now();

      // PERSONAL → only the affected user's channel; COMMUNITY → the room.
      const redisChannel =
        isPersonal && visibleToUserId
          ? `user:${visibleToUserId}`
          : `community:${communityId}`;

      // SENDER-LESS wire: senderId/senderName/senderAvatar are intentionally
      // empty for SYSTEM messages — the actor is in systemMetadata only.
      this.redis
        .publish(
          redisChannel,
          JSON.stringify({
            event: "community:message:new",
            data: {
              id: message.id,
              messageId: message.id,
              communityId,
              roomId: communityId,
              senderId: "",
              senderName: "",
              senderAvatar: "",
              parentMessageId: "",
              quoteData: null,
              content: { text: fallbackText, files: [] },
              reactions: [],
              message: fallbackText,
              contentType: normalizeMessageType("SYSTEM"),
              clientMessageId: "",
              serverTs,
              sentAt: serverTs,
              sequenceNumber: seq,
              systemMessageType,
              isPersonal,
              systemMetadata: enrichedMetadata,
            },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CommunitySystemMessageService|redis.publish failed channel=${redisChannel}: ${String(err)}`
          );
        });

      if (bumpsActivity) {
        // Self-referential lines (role change / join) carry the subject + a
        // first-person "You …" preview so the community list can personalize for
        // that one member; null for community-wide lines (everyone sees the same).
        const selfActivity = buildSelfActivity(
          systemMessageType,
          enrichedMetadata,
          triggeredByUserId
        );
        const clip = (s: string) => (s.length > 80 ? s.slice(0, 80) : s);

        publishCommunityActivitySafe({
          communityId,
          lastMessageAt:
            message.createdAt instanceof Date
              ? message.createdAt.toISOString()
              : new Date(serverTs).toISOString(),
          lastMessageId: message.id,
          // For a self-referential line, store the SUBJECT as lastActivityUserId so
          // the list can match `viewer === subject` and swap in the self-preview.
          // (For community-wide lines this is the actor; username stays null either
          // way since buildLastActivity nulls it for system types.)
          senderUserId: selfActivity?.subjectUserId ?? triggeredByUserId,
          // SYSTEM lines are sender-less in the community list — community-service's
          // buildLastActivity forces username:null for type:"system" anyway, so we
          // don't ship the actor name into the lastActivityUsername column.
          senderUsername: "",
          messagePreview: clip(fallbackText),
          type: "system",
          ...(selfActivity
            ? {
                subjectUserId: selfActivity.subjectUserId,
                selfPreview: clip(selfActivity.selfPreview),
              }
            : {}),
        });

        // Real-time community-LIST bump: the REST `/communities/mine` list is fed
        // by the `community.activity` event above, but the LIVE list is driven by
        // the `community:updated` socket event — which the normal send path emits
        // (service-impl.ts / chat-message-orchestrator.ts) and which the system
        // path historically did NOT. Without it, a role change / community-info
        // update updated the room but left the live list showing the previous
        // (sender-prefixed) message until a manual refetch. Emit a sender-less
        // bump here so the live list reorders + shows the standalone system line,
        // byte-identical to the room. SYSTEM contentType makes publishCommunityUpdated
        // blank the senderName, so the list never renders "<actor>: <system text>".
        if (!isPersonal && this.memberRepo) {
          const memberRepo = this.memberRepo;
          publishCommunityUpdatedSafe({
            redis: this.redis,
            communityId,
            // GeneralRoom id === communityId (same value community:message:new uses).
            roomId: communityId,
            fetchMembers: () =>
              memberRepo
                .findActiveByRoom(communityId)
                .then((members) => members.map((m) => m.userId)),
            senderId: triggeredByUserId,
            // Blanked downstream for SYSTEM previews anyway; pass "" so no actor
            // name is carried on a sender-less bump (parity with the activity event).
            senderName: "",
            lastMessageId: message.id,
            lastMessageAt: serverTs,
            preview: { contentType: "SYSTEM", text: fallbackText },
            // Live-list parity with the REST personalization: the one subject
            // member receives the "You …" preview, everyone else the third-person.
            ...(selfActivity
              ? {
                  subjectUserId: selfActivity.subjectUserId,
                  selfPreview: selfActivity.selfPreview,
                }
              : {}),
          });
        }
      }
    } catch (err) {
      logger.warn(
        `CommunitySystemMessageService|postOne failed type=${systemMessageType} communityId=${communityId}: ${String(err)}`
      );
    }
  }

  private nameOf(
    snapshots: Map<string, Record<string, unknown>>,
    userId: string | null
  ): string {
    if (!userId) return "";
    const snap = snapshots.get(userId);
    if (!snap) return "";
    return (snap.displayName as string) || (snap.username as string) || "";
  }
}

/** "MODERATOR" → "moderator", "ADMIN" → "admin". */
function roleArticleForm(role: string): string {
  const r = role.toUpperCase();
  if (r === "ADMIN") return "an admin";
  if (r === "MODERATOR") return "a moderator";
  return "a member";
}

/**
 * Deterministic English fallback text per subtype (Telegram phrasing). The
 * client renders its own localized string from systemMessageType + metadata;
 * this is the stored fallback + the community-list preview. NEVER compose a
 * sentence outside this function.
 */
function buildFallbackText(
  type: CommunitySystemMessageType,
  metadata: Record<string, unknown>,
  actorName: string,
  targetName: string
): string {
  const actor = actorName || "Someone";
  const target =
    (metadata.targetName as string) || targetName || actorName || "A member";

  switch (type) {
    case "COMMUNITY_CREATED":
      return "Community created";
    case "COMMUNITY_NAME_UPDATED":
      return "Community name updated";
    case "COMMUNITY_DESCRIPTION_UPDATED":
      return "Community description updated";
    case "COMMUNITY_AVATAR_UPDATED":
      return "Community photo updated";
    case "COMMUNITY_BANNER_UPDATED":
      return "Community banner updated";
    case "COMMUNITY_UPDATED":
      // Single non-name/avatar/description field OR multiple simultaneous fields.
      return "Community details updated";

    case "ROLE_CHANGED":
    case "MEMBER_ROLE_CHANGED": {
      const newRole = ((metadata.newRole as string) || "").toUpperCase();
      const oldRole = ((metadata.oldRole as string) || "").toUpperCase();
      if (
        newRole === "MEMBER" &&
        (oldRole === "ADMIN" || oldRole === "MODERATOR")
      ) {
        return `${target} is now a member`;
      }
      return `${target} is now ${roleArticleForm(newRole)}`;
    }

    case "ROLE_CHANGED_SELF": {
      const newRole = ((metadata.newRole as string) || "").toUpperCase();
      const oldRole = ((metadata.oldRole as string) || "").toUpperCase();
      if (
        newRole === "MEMBER" &&
        (oldRole === "ADMIN" || oldRole === "MODERATOR")
      ) {
        return "You are now a member";
      }
      return `You are now ${roleArticleForm(newRole)}`;
    }

    case "MEMBER_JOINED":
      return `${target} joined the community`;
    case "MEMBER_LEFT":
      return `${target} left the community`;
    case "MEMBER_REMOVED":
      return `${target} was removed`;
    case "MEMBER_BANNED":
      return `${target} was banned`;
    case "MEMBER_UNBANNED":
      return `${target} was unbanned`;
    case "MEMBER_MUTED":
      return `${target} was muted`;
    case "MEMBER_UNMUTED":
      return `${target} was unmuted`;

    case "PINNED_MESSAGE":
      return `${actor} pinned a message`;
    case "UNPINNED_MESSAGE":
      return `${actor} unpinned a message`;
    case "COMMUNITY_INVITE_CREATED":
      return `${actor} created an invite link`;

    case "COMMUNITY_JOINED":
      return "You joined the community";
    case "JOIN_REQUEST_APPROVED":
      return "Your request to join was approved";
    case "JOIN_REQUEST_REJECTED":
      return "Your request to join was declined";

    default:
      return "Community details updated";
  }
}

/**
 * Self-referential community-list personalization for a COMMUNITY-visible system
 * line. Most lifecycle lines read identically to everyone, but a few are ABOUT a
 * specific member — a role change ("Jim is now a moderator") or a join ("Jim
 * joined the community"). For those, the community list should show that one
 * member the first-person form ("You are now a moderator" / "You joined the
 * community") while everyone else sees the third-person line.
 *
 * Returns the `subjectUserId` (whom the line is about) and the `selfPreview`
 * (the "You …" text, produced by the same {@link buildFallbackText} source of
 * truth so community-service never composes its own copy), or `null` when the
 * subtype is not self-referential. Used to enrich both the `community.activity`
 * REST denormalization and the `community:updated` live bump.
 */
function buildSelfActivity(
  type: CommunitySystemMessageType,
  metadata: Record<string, unknown>,
  triggeredByUserId: string
): { subjectUserId: string; selfPreview: string } | null {
  switch (type) {
    case "ROLE_CHANGED":
    case "MEMBER_ROLE_CHANGED": {
      const subjectUserId =
        typeof metadata.targetUserId === "string" ? metadata.targetUserId : "";
      if (!subjectUserId) return null;
      return {
        subjectUserId,
        selfPreview: buildFallbackText("ROLE_CHANGED_SELF", metadata, "", ""),
      };
    }
    case "MEMBER_JOINED":
      // The joiner IS the actor for a join, so the actor id is the subject.
      if (!triggeredByUserId) return null;
      return {
        subjectUserId: triggeredByUserId,
        selfPreview: buildFallbackText("COMMUNITY_JOINED", metadata, "", ""),
      };
    default:
      return null;
  }
}
