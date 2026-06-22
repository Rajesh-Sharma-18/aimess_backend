import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import {
  SYSTEM_MESSAGE_VISIBILITY,
  SYSTEM_MESSAGE_BUMPS_ACTIVITY,
  buildCommunitySystemFallbackText,
  buildCommunitySystemSelfPreview,
  resolveCommunitySystemSubjectUserId,
  resolvePersonDisplayName,
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

      const fallbackText = buildCommunitySystemFallbackText(
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
          triggeredByUserId,
          actorName,
          targetName
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
    return resolvePersonDisplayName(snapshots.get(userId));
  }
}

/**
 * Self-referential community-list personalization for a COMMUNITY-visible system
 * line. Returns the subject member + first-person preview when the subtype names
 * a specific actor or target; null when everyone sees the same text.
 */
function buildSelfActivity(
  type: CommunitySystemMessageType,
  metadata: Record<string, unknown>,
  triggeredByUserId: string,
  actorName: string,
  targetName: string
): { subjectUserId: string; selfPreview: string } | null {
  const subjectUserId = resolveCommunitySystemSubjectUserId(
    type,
    metadata,
    triggeredByUserId
  );
  if (!subjectUserId) return null;
  return {
    subjectUserId,
    selfPreview: buildCommunitySystemSelfPreview(
      type,
      metadata,
      actorName,
      targetName,
      subjectUserId
    ),
  };
}
