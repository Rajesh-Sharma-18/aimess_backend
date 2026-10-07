import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import {
  SYSTEM_MESSAGE_VISIBILITY,
  isEligibleForLastActivity,
  hasPersonalModerationCopy,
  isHiddenSystemMessage,
  isModerationOnlySystemMessage,
  isActorLessSystemMessage,
  isPersonalJoinSessionType,
  sanitizeCommunitySystemMetadata,
  BACKOFFICE_SOURCE,
  buildCommunitySystemFallbackText,
  buildCommunitySystemSelfPreview,
  resolveCommunitySystemSubjectUserId,
  resolvePersonDisplayName,
  type CommunitySystemMessageType,
} from "@aimess/constants";
import {
  normalizeMessageType,
  buildDeletePayload,
} from "../lib/chat-message.serializer.js";
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
 * - isEligibleForLastActivity decides whether the line bumps + becomes the
 *   community-list preview. Excluded: personal/onboarding lines, unpin,
 *   invite-created, and membership/moderation churn (left/removed/banned/…).
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

  /** Like post() but returns the created system message ID (or null on dedup/skip). */
  async postReturnId(
    params: PostCommunitySystemMessageParams
  ): Promise<string | null> {
    return this.postOne(params);
  }

  private async postOne(
    params: PostCommunitySystemMessageParams
  ): Promise<string | null> {
    const { communityId, systemMessageType, metadata, triggeredByUserId } =
      params;

    // Backstop: hidden membership-lifecycle lines (left / removed / joined) are
    // never persisted OR broadcast. community-service's emitMemberSystemMessage
    // already drops them at the source, but a redelivered legacy event could still
    // reach here — skip so it can't flash on a live socket (the read-time filter
    // can't catch a real-time push).
    if (isHiddenSystemMessage(systemMessageType)) {
      logger.debug(
        `CommunitySystemMessageService|skip hidden type=${systemMessageType}`
      );
      return null;
    }

    const visibility =
      SYSTEM_MESSAGE_VISIBILITY[systemMessageType] ?? "COMMUNITY";
    // Single source of truth: membership/moderation churn (left/removed/banned/…)
    // is NOT eligible to bump or become the community-list lastActivity preview.
    const eligibleForLastActivity =
      isEligibleForLastActivity(systemMessageType);

    // A MODERATION subtype has TWO possible copies and the CALLER picks which one
    // it is posting, by passing `visibleToUserId` or not: the target-addressed
    // companion notice ("{admin} added you", "You are muted until …"), or the
    // room-wide AUDIT line that only owner/admin/moderators can read. This is the
    // one place visibility is not fully derived from the subtype, because the
    // subtype alone cannot distinguish two rows that legitimately coexist. The
    // registry still decides WHICH subtypes may have a companion copy, so a caller
    // cannot invent one: a target on ban / unban / unmute is dropped and the row is
    // persisted as the audit copy (the product posts no such bubble — see
    // MODERATION_TYPES_WITH_PERSONAL_COPY).
    const isModerationScope = visibility === "MODERATION";
    if (
      isModerationScope &&
      params.visibleToUserId &&
      !hasPersonalModerationCopy(systemMessageType)
    ) {
      logger.warn(
        `CommunitySystemMessageService|ignoring visibleToUserId on ${systemMessageType} (no personal companion copy) — posting the audit line instead`
      );
    }
    const isPersonal =
      visibility === "PERSONAL" ||
      (isModerationScope &&
        Boolean(params.visibleToUserId) &&
        hasPersonalModerationCopy(systemMessageType));
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

      // A Backoffice line's actor is a Super Admin, not an AIMess user: no name
      // is stored or sent — every reader renders "Administrator" from `source`.
      const actorName =
        metadata.source === BACKOFFICE_SOURCE
          ? ""
          : this.nameOf(snapshots, triggeredByUserId);
      const targetName = this.nameOf(snapshots, targetUserId);

      // actorUserId is the single consistent key across all subtypes so the
      // client can do `metadata.actorUserId === currentUserId` → render "You".
      const enrichedMetadata: Record<string, unknown> = {
        ...metadata,
        actorUserId: triggeredByUserId,
        actorName,
        // Prefer the publisher-provided targetName (DB snapshot) over the
        // re-fetched value, which may be "" when user-service has no profile yet.
        ...(targetUserId
          ? { targetName: (metadata.targetName as string) || targetName }
          : {}),
      };

      // For PERSONAL messages the stored text is always seen by the target user —
      // pass visibleToUserId as the viewer so "You are muted until …" is persisted
      // instead of the third-person form (which would never be read by anyone else).
      const fallbackText = buildCommunitySystemFallbackText(
        systemMessageType,
        enrichedMetadata,
        actorName,
        targetName,
        isPersonal ? (visibleToUserId ?? undefined) : undefined
      );

      // ACTOR-LESS lifecycle types ("Community created", "Community photo
      // updated") must never expose actor identity — a client that localizes
      // from systemMetadata would otherwise render "{name} created the
      // community". Strip actor/target keys from what we PERSIST and BROADCAST
      // (enrichedMetadata is kept locally for the activity/self-preview logic,
      // which is a no-op for these types anyway). actor-bearing types pass
      // through unchanged.
      const wireMetadata = sanitizeCommunitySystemMetadata(
        systemMessageType,
        enrichedMetadata
      );
      // Sender-less in the timeline AND in the stored row for actor-less types,
      // so no surface (including non-wire readers) can fall back to a name.
      const wireSenderName = isActorLessSystemMessage(systemMessageType)
        ? ""
        : actorName;

      // Idempotency: a `community.system_message` event can be REDELIVERED
      // (at-least-once queue; broker redelivers on ack-loss). Each event carries
      // a producer `eventAt`, stable across redeliveries, so derive a
      // deterministic dedup key — one logical event ⇒ one timeline line, no
      // duplicate "Community info was updated" / "X joined" bubbles. Two genuinely
      // distinct events differ in (type, eventAt, target) so both persist.
      //
      // The recipient (`visibleToUserId`) is part of the key for PERSONAL lines so
      // that a single logical event which fans out a personal line to MORE THAN ONE
      // user — e.g. an admin TRANSFER posts "You are now the community admin" to the
      // new admin AND "You are now a member" to the outgoing admin under one shared
      // `eventAt` — keeps both lines instead of the second colliding with the first
      // and being dropped as a "replay". The key only ever grows MORE specific, so a
      // real redelivery (same type+eventAt+recipient) still dedupes correctly.
      const dedupeKey = params.eventAt
        ? `sys:${systemMessageType}:${params.eventAt}${
            targetUserId ? `:${targetUserId}` : ""
          }${isPersonal && visibleToUserId ? `:u:${visibleToUserId}` : ""}`
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
          return null;
        }
      }

      // Stale-join-line cleanup: before inserting a new personal join-session
      // line (COMMUNITY_JOINED / JOIN_REQUEST_APPROVED), hard-delete any prior
      // ones for the same user in this room. This handles a race condition where
      // the member-synced LEFT cleanup (which uses a timestamp bound) ran before
      // the previous join message was flushed to DB — leaving an orphaned message
      // that would appear alongside the new one after the user re-joined.
      if (
        isPersonal &&
        visibleToUserId &&
        isPersonalJoinSessionType(systemMessageType)
      ) {
        await this.messageRepo
          .deletePersonalJoinMessages({
            roomId: communityId,
            userId: visibleToUserId,
          })
          .then((deletedIds) => {
            this.publishPersonalMessageDeletions(
              communityId,
              visibleToUserId,
              deletedIds
            );
          })
          .catch((err: unknown) => {
            logger.warn(
              `CommunitySystemMessageService|stale join-line cleanup failed community=${communityId} user=${visibleToUserId}: ${String(err)}`
            );
          });
      }

      // Single atomic $inc for BOTH counters — halves write-conflict footprint
      // on the shared GeneralRoom doc under bursty concurrent sends.
      // System-message insert bumps the room CHANGE revision too (zero-loss feed).
      const { sequenceNumber: seq, revision } =
        await this.roomRepo.allocateSequenceAndRevision(communityId);

      const message = await this.messageRepo
        .createSystemMessage({
          roomId: communityId,
          systemMessageType,
          metadata: wireMetadata,
          // sentBy is retained internally for audit, but is NEVER surfaced on the
          // wire for SYSTEM messages (toWire strips it). senderName is blanked for
          // actor-less types so even a non-wire reader can't surface a name.
          triggeredByUserId,
          triggeredByName: wireSenderName,
          sequenceNumber: seq,
          revision,
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
      if (!message) {
        return null;
      }

      if (
        isPersonal &&
        visibleToUserId &&
        isPersonalJoinSessionType(systemMessageType)
      ) {
        await this.messageRepo
          .deletePersonalJoinMessages({
            roomId: communityId,
            userId: visibleToUserId,
            keepId: message.id,
          })
          .then((deletedIds) => {
            this.publishPersonalMessageDeletions(
              communityId,
              visibleToUserId,
              deletedIds
            );
          })
          .catch((err: unknown) => {
            logger.warn(
              `CommunitySystemMessageService|post-create join-line cleanup failed community=${communityId} user=${visibleToUserId}: ${String(err)}`
            );
          });
      }

      // Bump the community-list ordering only for subtypes that should reorder
      // the chat list (registry-driven). No unread increment — system messages
      // never badge.
      if (eligibleForLastActivity) {
        this.roomRepo
          .addLastestMessageToRoom(communityId, {
            _id: message.id,
            sentBy: message.sentBy,
            senderName: message.senderName ?? "",
            message: message.message ?? "",
            messageType: message.messageType,
            createdAt: message.createdAt,
            clientMessageId: message.clientMessageId,
            sequenceNumber: message.sequenceNumber,
            revision: message.revision,
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

      // RECIPIENT RESOLUTION — decided BEFORE emission, because a socket push
      // cannot be filtered read-side:
      //  - PERSONAL        → only the affected user's own channel.
      //  - MODERATION-only → one `user:<id>` per CURRENT owner/admin/moderator,
      //    never `community:<id>`: an ordinary member's session must not receive
      //    the payload at all (Network tab / socket inspection would show it).
      //    Fails CLOSED — with no member repository wired, the live push is
      //    skipped rather than risking the room-wide channel; the line is
      //    persisted, so moderators still pick it up from history/sync.
      //  - everything else → the room.
      const moderationOnly = isModerationOnlySystemMessage(systemMessageType);
      const moderatorIds =
        moderationOnly && !isPersonal
          ? await this.resolveModerationRecipients(communityId)
          : [];
      const redisChannels: string[] =
        isPersonal && visibleToUserId
          ? [`user:${visibleToUserId}`]
          : moderationOnly
            ? moderatorIds.map((id) => `user:${id}`)
            : [`community:${communityId}`];

      // SENDER-LESS wire: senderId/senderName/senderAvatar are intentionally
      // empty for SYSTEM messages — the actor is in systemMetadata only.
      const buildFrame = (fallbackText: string) =>
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
            revision,
            systemMessageType,
            isPersonal,
            systemMetadata: wireMetadata,
          },
        });
      const wireFrame = buildFrame(fallbackText);
      // Each moderator gets the line from their own perspective ("You muted X"
      // for the actor), matching what the history read path renders.
      const frameFor = (channel: string) =>
        moderatorIds.length === 0
          ? wireFrame
          : buildFrame(
              buildCommunitySystemFallbackText(
                systemMessageType,
                enrichedMetadata,
                actorName,
                targetName,
                channel.slice("user:".length)
              ) || fallbackText
            );
      for (const channel of redisChannels) {
        this.redis.publish(channel, frameFor(channel)).catch((err: unknown) => {
          logger.warn(
            `CommunitySystemMessageService|redis.publish failed channel=${channel}: ${String(err)}`
          );
        });
      }

      if (eligibleForLastActivity) {
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
          // The canonical pair behind the sentence — community-service re-renders
          // the list row from it in each reader's language (the transcript
          // already did; the row did not).
          systemMessageType,
          systemMetadata: wireMetadata,
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
            // The canonical pair rides along so the gateway re-renders this row
            // in each member's own language rather than fanning out the
            // write-time English (see publish-conv-updated.ts BumpPreview).
            // `wireMetadata`, not `enrichedMetadata`: actor-less types must not
            // leak actor identity onto the wire.
            preview: {
              contentType: "SYSTEM",
              text: fallbackText,
              systemMessageType,
              systemMetadata: wireMetadata,
            },
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

      return message.id;
    } catch (err) {
      logger.warn(
        `CommunitySystemMessageService|postOne failed type=${systemMessageType} communityId=${communityId}: ${String(err)}`
      );
      return null;
    }
  }

  /**
   * Hard-hides a single COMMUNITY-visible system message this service
   * previously posted — currently only the PINNED_MESSAGE line tied to a pin
   * that was since undone (unpinned, or replaced by pinning a different
   * message) — and tells connected clients to remove it. Same `deletedForAll`
   * mechanism and tombstone shape as a normal message hard-delete; just
   * triggered by pin lifecycle instead of a user delete action. Mirrors
   * `publishPersonalMessageDeletions` below for the PERSONAL case. Best-effort:
   * never throws — the pin state change that triggered this must not roll
   * back on a failure here.
   */
  async retractSystemMessage(params: {
    communityId: string;
    messageId: string;
  }): Promise<void> {
    const { communityId, messageId } = params;
    try {
      // Retraction is a tombstone → bump the room CHANGE revision so the changes
      // feed replays the pin-line removal to offline clients.
      const revision = await this.roomRepo.allocateRevision(communityId);
      const hidden = await this.messageRepo.deleteForAll(messageId, {
        revision,
      });
      if (!hidden) return;
      const tombstone = {
        ...buildDeletePayload({
          conversationType: "COMMUNITY",
          messageId,
          roomId: communityId,
          scope: "forEveryone",
          deletedBy: "",
        }),
        revision,
      };
      await this.redis.publish(
        `community:${communityId}`,
        JSON.stringify({ event: "community:message:deleted", data: tombstone })
      );
    } catch (err) {
      logger.warn(
        `CommunitySystemMessageService|retractSystemMessage failed messageId=${messageId}: ${String(err)}`
      );
    }
  }

  /**
   * Retracts every live MEMBER_MUTED line about one member — their personal
   * notice and the moderators' audit line — on unmute, auto-expiry, or a re-mute
   * (`keepEventAt` spares the new mute's own lines). Each removal bumps the room
   * revision so offline clients replay it, and is tombstoned to exactly the
   * users who could see the line. Idempotent and best-effort: never throws.
   */
  async retractMuteLines(params: {
    communityId: string;
    targetUserId: string;
    keepEventAt?: string;
  }): Promise<void> {
    const { communityId, targetUserId, keepEventAt } = params;
    try {
      const lines = await this.messageRepo.findLiveMuteLines({
        roomId: communityId,
        targetUserId,
        keepEventAt,
      });
      if (lines.length === 0) return;
      const moderatorIds = lines.some((l) => !l.visibleToUserId)
        ? await this.resolveModerationRecipients(communityId)
        : [];
      for (const line of lines) {
        const revision = await this.roomRepo.allocateRevision(communityId);
        if (!(await this.messageRepo.retractIfLive(line.id, revision)))
          continue;
        const tombstone = JSON.stringify({
          event: "community:message:deleted",
          data: {
            ...buildDeletePayload({
              conversationType: "COMMUNITY",
              messageId: line.id,
              roomId: communityId,
              scope: "forEveryone",
              deletedBy: "",
            }),
            revision,
          },
        });
        const recipients = line.visibleToUserId
          ? [line.visibleToUserId]
          : moderatorIds;
        for (const userId of recipients) {
          this.redis
            .publish(`user:${userId}`, tombstone)
            .catch((err: unknown) => {
              logger.warn(
                `CommunitySystemMessageService|mute-line tombstone publish failed community=${communityId} user=${userId} message=${line.id}: ${String(err)}`
              );
            });
        }
      }
    } catch (err) {
      logger.warn(
        `CommunitySystemMessageService|retractMuteLines failed community=${communityId} target=${targetUserId}: ${String(err)}`
      );
    }
  }

  /**
   * Recipients for a MODERATION-restricted system line: the community's CURRENT
   * owner/admin/moderators. Returns EMPTY — meaning no live push at all — when
   * no member repository is wired or the lookup fails. That is deliberate: the
   * alternative fallback would be the room-wide `community:<id>` channel, which
   * is exactly the leak this gate exists to prevent. The line is persisted
   * either way, so moderators still receive it via history / sync / catch-up.
   */
  private async resolveModerationRecipients(
    communityId: string
  ): Promise<string[]> {
    try {
      return (await this.memberRepo?.findModeratorUserIds?.(communityId)) ?? [];
    } catch (err) {
      logger.warn(
        `CommunitySystemMessageService|moderation recipient lookup failed community=${communityId}: ${String(err)}`
      );
      return [];
    }
  }

  private nameOf(
    snapshots: Map<string, Record<string, unknown>>,
    userId: string | null
  ): string {
    if (!userId) return "";
    return resolvePersonDisplayName(snapshots.get(userId));
  }

  /**
   * Tell an already-connected client to remove PERSONAL message(s) that were
   * just hard-deleted server-side for one user — stale join-session lines (see
   * deletePersonalJoinMessages). Without this, a client that already rendered
   * the line never learns it was deleted — it stays on screen until a full
   * refetch (reload/reconnect). PERSONAL messages are user-scoped, so this
   * publishes to the `user:<id>` channel (never `community:<id>`), mirroring
   * how the line itself was originally delivered (see the isPersonal branch
   * in postOne above).
   */
  private publishPersonalMessageDeletions(
    communityId: string,
    userId: string,
    deletedIds: string[]
  ): void {
    for (const messageId of deletedIds) {
      const tombstone = buildDeletePayload({
        conversationType: "COMMUNITY",
        messageId,
        roomId: communityId,
        scope: "forEveryone",
        deletedBy: "",
      });
      this.redis
        .publish(
          `user:${userId}`,
          JSON.stringify({
            event: "community:message:deleted",
            data: tombstone,
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CommunitySystemMessageService|join-line delete publish failed community=${communityId} user=${userId} message=${messageId}: ${String(err)}`
          );
        });
    }
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
