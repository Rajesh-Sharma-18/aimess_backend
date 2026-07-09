import * as grpc from "@grpc/grpc-js";
import { logger } from "@aimess/logger";
import { isAppError } from "@aimess/errors";

import {
  CommunityMemberRole,
  CommunityMemberStatus,
  CommunityModerationStatus,
  CommunityType,
} from "../generated/prisma/index.js";
import { communityRepository } from "../repositories/community.repository.js";
import { communityService } from "../services/community.service.js";
import { communityImageService } from "../services/community-image.service.js";
import { memberAvatarService } from "../services/member-avatar.service.js";
import { communityAccessPolicy } from "../lib/community-access-policy.js";
import { getChatClient } from "./chat.client.js";

/** Resolve the admin moderation "status" string of a community row, treating an
 * unset moderationStatus (legacy rows) as ACTIVE. SUSPENDED → "CLOSED". */
function moderationStatusToWire(
  status: CommunityModerationStatus | null | undefined
): "ACTIVE" | "CLOSED" {
  return status === CommunityModerationStatus.SUSPENDED ? "CLOSED" : "ACTIVE";
}

/** Clamp a 1-based page (default 1). */
function coercePage(page: unknown): number {
  const n = Number(page);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Clamp a page size to 1..100 (default 20). */
function coerceLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(Math.floor(n), 100);
}

/** ISO date (YYYY-MM-DD) → start-of-day UTC Date; empty/invalid → undefined. */
function dateFromBound(s: unknown): Date | undefined {
  if (typeof s !== "string" || s.trim() === "") return undefined;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** ISO date (YYYY-MM-DD) → end-of-day UTC Date; empty/invalid → undefined. */
function dateToBound(s: unknown): Date | undefined {
  if (typeof s !== "string" || s.trim() === "") return undefined;
  const d = new Date(`${s}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export const communityImpl: grpc.UntypedServiceImplementation = {
  // Community message persistence lives in chat-service (Mongo GeneralRoomMessage
  // store + broadcast + push). This RPC is the gateway's `community:message:send`
  // entry point, so forward the send verbatim and relay chat-service's REAL
  // { messageId, roomId, sentAt } — previously a stub returned empties, producing
  // the blank send ack. Business rejections and infra failures are re-emitted
  // with the ORIGINAL gRPC code + details so the gateway's ack-error mapping
  // (muted / banned / not-a-member / too-large …) still works; never a fake
  // empty success.
  sendCommunityMessage: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        communityId?: string;
        roomId?: string;
        senderId?: string;
        clientMessageId?: string;
        message?: string;
        contentType?: string;
        mediaKey?: string;
        parentMessageId?: string;
        attachmentsJson?: string;
      };
      try {
        const res = await getChatClient().sendCommunityMessage({
          communityId: req.communityId ?? "",
          roomId: req.roomId ?? "",
          senderId: req.senderId ?? "",
          clientMessageId: req.clientMessageId ?? "",
          message: req.message ?? "",
          contentType: req.contentType ?? "",
          mediaKey: req.mediaKey ?? "",
          parentMessageId: req.parentMessageId ?? "",
          attachmentsJson: req.attachmentsJson ?? "",
        });
        callback(null, {
          messageId: res.messageId,
          roomId: res.roomId,
          sentAt: res.sentAt,
        });
      } catch (err) {
        // Preserve chat-service's mapped gRPC status (INVALID_ARGUMENT,
        // FAILED_PRECONDITION, PERMISSION_DENIED, …) + its messageKey in
        // `details` so the gateway surfaces the specific reason. Only truly
        // unmapped/infra failures collapse to UNAVAILABLE.
        const e = err as {
          code?: number;
          details?: string;
          message?: string;
        };
        if (typeof e?.code === "number") {
          callback({
            code: e.code,
            details: e.details ?? e.message ?? "",
            message: e.message ?? e.details ?? "",
          } as grpc.ServiceError);
          return;
        }
        logger.error("sendCommunityMessage gRPC forward failed", err);
        callback({
          code: grpc.status.UNAVAILABLE,
          message: "sendCommunityMessage failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Community message deletion ("forMe" | "forEveryone") — the gateway's
  // `community:message:delete` entry point. Delete + lastActivity
  // recalculation live in chat-service, so forward the delete verbatim and
  // relay chat-service's REAL result. Business rejections and infra failures
  // are re-emitted with the ORIGINAL gRPC code + details, matching
  // sendCommunityMessage, so the gateway's ack-error mapping still works.
  deleteCommunityMessage: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        messageId?: string;
        communityId?: string;
        userId?: string;
        deleteType?: string;
      };
      try {
        const res = await getChatClient().deleteCommunityMessage({
          messageId: req.messageId ?? "",
          communityId: req.communityId ?? "",
          userId: req.userId ?? "",
          deleteType: req.deleteType ?? "",
        });
        callback(null, {
          messageId: res.messageId,
          communityId: res.communityId,
          roomId: res.roomId,
          deleteType: res.deleteType,
        });
      } catch (err) {
        const e = err as {
          code?: number;
          details?: string;
          message?: string;
        };
        if (typeof e?.code === "number") {
          callback({
            code: e.code,
            details: e.details ?? e.message ?? "",
            message: e.message ?? e.details ?? "",
          } as grpc.ServiceError);
          return;
        }
        logger.error("deleteCommunityMessage gRPC forward failed", err);
        callback({
          code: grpc.status.UNAVAILABLE,
          message: "deleteCommunityMessage failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Cursor-paged community message history — the gateway's socket
  // `community:messages:fetch` entry point. Message storage lives in
  // chat-service, so forward the read verbatim and relay chat-service's REAL
  // page (previously a stub always returned an empty page here). Errors
  // propagate with the ORIGINAL gRPC code + details, matching
  // sendCommunityMessage, so the gateway's existing `.catch` → ackError path
  // still distinguishes a genuine read failure from "no more messages".
  getCommunityMessages: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        roomId?: string;
        requesterId?: string;
        cursor?: string;
        limit?: number;
      };
      try {
        const res = await getChatClient().getCommunityMessages({
          roomId: req.roomId ?? "",
          requesterId: req.requesterId ?? "",
          cursor: req.cursor ?? "",
          limit: req.limit ?? 0,
        });
        callback(null, {
          messages: res.messages,
          nextCursor: res.nextCursor,
          hasMore: res.hasMore,
          pinnedMessageJson: res.pinnedMessageJson,
        });
      } catch (err) {
        const e = err as {
          code?: number;
          details?: string;
          message?: string;
        };
        if (typeof e?.code === "number") {
          callback({
            code: e.code,
            details: e.details ?? e.message ?? "",
            message: e.message ?? e.details ?? "",
          } as grpc.ServiceError);
          return;
        }
        logger.error("getCommunityMessages gRPC forward failed", err);
        callback({
          code: grpc.status.UNAVAILABLE,
          message: "getCommunityMessages failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Reconciliation pull: chat-service lists communities (+ members) on boot to
  // provision any missing chat rooms / sync RoomMember rows. Cursor on community id.
  listCommunities: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { afterId?: string; limit?: number };
        const limit =
          req.limit && req.limit > 0 ? Math.min(req.limit, 200) : 100;
        // Over-fetch one for an exact hasMore.
        const rows = await communityRepository.listForReconciliation({
          afterId: req.afterId || null,
          limit: limit + 1,
        });
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        callback(null, {
          communities: page.map((c) => ({
            id: c.id,
            name: c.name,
            adminId: c.adminId,
            avatarUrl: c.avatarUrl ?? "",
            deleted: c.deletedAt != null,
            communityType: String(c.type),
            members: c.members.map((m) => ({
              userId: m.userId,
              status: String(m.status),
              role: String(m.role),
              joinedAt: m.joinedAt instanceof Date ? m.joinedAt.getTime() : 0,
            })),
          })),
          nextAfterId: hasMore && last ? last.id : "",
          hasMore,
        });
      } catch (err) {
        logger.error("listCommunities gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "listCommunities failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Membership oracle for the gateway socket ban gate. Returns the caller's
  // membership status so the /community namespace can reject BANNED users at
  // community:join. Read-only single-row lookup; never throws on "no row".
  checkCommunityMembership: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          communityId?: string;
          userId?: string;
        };
        if (!req.communityId || !req.userId) {
          callback(null, {
            isMember: false,
            isBanned: false,
            status: "",
            role: "",
            isCommunityClosed: false,
          });
          return;
        }
        const [membership, community] = await Promise.all([
          communityRepository.findMembership(req.communityId, req.userId),
          communityRepository.findById(req.communityId),
        ]);
        const status = membership ? String(membership.status) : "";
        callback(null, {
          isMember: status === "ACTIVE",
          isBanned: status === "BANNED",
          status,
          role: membership ? String(membership.role) : "",
          isCommunityClosed:
            !community || communityAccessPolicy.isEffectivelyClosed(community),
        });
      } catch (err) {
        logger.error("checkCommunityMembership gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "checkCommunityMembership failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Moderation-mute oracle for notifications-service's eligibility gate. Returns
  // whether the user has an effective (non-expired) moderation mute in the
  // community. Read-only single-row lookup; never throws on "no row".
  checkCommunityMute: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          communityId?: string;
          userId?: string;
        };
        if (!req.communityId || !req.userId) {
          callback(null, { isMuted: false, mutedUntil: 0 });
          return;
        }
        const row = await communityRepository.findActiveMemberMute(
          req.communityId,
          req.userId
        );
        callback(null, {
          isMuted: row != null,
          mutedUntil:
            row?.mutedUntil instanceof Date ? row.mutedUntil.getTime() : 0,
        });
      } catch (err) {
        logger.error("checkCommunityMute gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "checkCommunityMute failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Admin dashboard: count of active (non-soft-deleted) communities.
  getCommunityCount: (
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const total = await communityRepository.countActiveCommunities();
        callback(null, { total });
      } catch (err) {
        logger.error("getCommunityCount gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "getCommunityCount failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Membership gate for stream-service ("who can go live"): is_member is true
  // ONLY for an ACTIVE member. role/status are the raw membership enum strings
  // ("" when there is no membership row). is_community_closed additionally lets
  // stream-service block go-live/commenting when the community itself is
  // owner-CLOSED or platform-SUSPENDED, even for a valid ACTIVE member.
  // Fail-safe: any error → not-a-member (never throw to the gRPC layer, so a
  // transient DB blip can't grant access).
  validateMembership: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { communityId?: string; userId?: string };
        const communityId = (req.communityId ?? "").trim();
        const userId = (req.userId ?? "").trim();

        if (!communityId || !userId) {
          callback(null, {
            isMember: false,
            role: "",
            status: "",
            isCommunityClosed: false,
          });
          return;
        }

        const [row, community] = await Promise.all([
          communityRepository.findMembership(communityId, userId),
          communityRepository.findById(communityId),
        ]);
        callback(null, {
          isMember: row?.status === CommunityMemberStatus.ACTIVE,
          role: row?.role ?? "",
          status: row?.status ?? "",
          isCommunityClosed:
            !community || communityAccessPolicy.isEffectivelyClosed(community),
        });
      } catch (err) {
        logger.error("validateMembership gRPC handler failed", err);
        callback(null, { isMember: false, role: "", status: "" });
      }
    })();
  },

  /**
   * Synchronous companion to the async `community.activity.queue`
   * "reaction_added"/"reaction_removed" event — see the proto doc. Delegates
   * to the SAME repository methods `community-activity.consumer.ts` calls, so
   * there is exactly one implementation of "how a reaction updates the
   * overlay"; this RPC and the queue consumer are just two callers of it.
   * Fail-soft: any error still returns ok:false rather than throwing, since
   * the async queue publish (already sent by the caller beforehand) remains
   * the backstop — a failure here must never fail the reaction itself.
   */
  updateReactionActivity: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          communityId?: string;
          added?: boolean;
          messageId?: string;
          emoji?: string;
          actorId?: string;
          actorPreview?: string;
          targetId?: string;
          targetPreview?: string;
          reactedAt?: number | string;
        };
        const communityId = (req.communityId ?? "").trim();
        const messageId = (req.messageId ?? "").trim();
        const emoji = req.emoji ?? "";
        const actorId = (req.actorId ?? "").trim();
        if (!communityId || !messageId || !emoji || !actorId) {
          callback(null, { ok: false });
          return;
        }

        if (req.added) {
          await communityRepository.setReactionActivity(communityId, {
            messageId,
            emoji,
            actorId,
            actorPreview: req.actorPreview ?? "",
            targetId: req.targetId ? req.targetId : null,
            targetPreview: req.targetPreview ? req.targetPreview : null,
            reactedAt: new Date(Number(req.reactedAt) || Date.now()),
          });
        } else {
          await communityRepository.clearReactionActivityIfCurrent(
            communityId,
            { messageId, emoji, actorId }
          );
        }
        callback(null, { ok: true });
      } catch (err) {
        logger.error("updateReactionActivity gRPC handler failed", err);
        callback(null, { ok: false });
      }
    })();
  },

  /**
   * Synchronous companion to the async `community.activity.queue` "message"
   * event for the CANONICAL lastActivity bump (send/edit/delete-for-everyone),
   * and the sole path for the delete-for-me personal self-hide overlay (which
   * the queue never carries — see the proto doc). Delegates to the SAME
   * repository methods the queue consumer calls
   * (`updateLastActivity`/`setSelfLastActivityOverride`), so there is exactly
   * one implementation of each. Fail-soft: any error still returns ok:false
   * rather than throwing — the async queue publish (already sent by the
   * caller beforehand, canonical mode only) remains the backstop.
   */
  updateMessageActivity: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          communityId?: string;
          lastMessageAt?: number | string;
          lastMessageId?: string;
          senderUserId?: string;
          senderUsername?: string;
          messagePreview?: string;
          activityType?: string;
          selfUserId?: string;
          selfPreview?: string;
        };
        const communityId = (req.communityId ?? "").trim();
        if (!communityId) {
          callback(null, { ok: false });
          return;
        }

        const selfUserId = (req.selfUserId ?? "").trim();
        if (selfUserId) {
          await communityRepository.setSelfLastActivityOverride(communityId, {
            userId: selfUserId,
            preview: req.selfPreview ?? "",
          });
        } else {
          const at = new Date(Number(req.lastMessageAt) || Date.now());
          await communityRepository.updateLastActivity(
            communityId,
            at,
            req.activityType ?? "message",
            req.messagePreview ?? "",
            req.senderUsername ?? null,
            req.senderUserId ?? null
          );
        }
        callback(null, { ok: true });
      } catch (err) {
        logger.error("updateMessageActivity gRPC handler failed", err);
        callback(null, { ok: false });
      }
    })();
  },

  // ---- Backoffice (admin panel) Community Management ----
  // Read-through list for the admin Community Management screen. Offset paginated.
  adminListCommunities: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          search?: string;
          type?: string;
          category?: string;
          status?: string;
          createdFrom?: string;
          createdTo?: string;
          sortField?: string;
          sortDir?: string;
          page?: number;
          limit?: number;
        };

        const type =
          req.type === "PUBLIC"
            ? CommunityType.PUBLIC
            : req.type === "PRIVATE"
              ? CommunityType.PRIVATE
              : undefined;
        const status =
          req.status === "ACTIVE"
            ? "ACTIVE"
            : req.status === "CLOSED"
              ? "CLOSED"
              : undefined;

        const { rows, total } = await communityRepository.adminListCommunities({
          search: req.search?.trim() || undefined,
          type,
          category: req.category?.trim() || undefined,
          status,
          createdFrom: dateFromBound(req.createdFrom),
          createdTo: dateToBound(req.createdTo),
          sortField: req.sortField || "createdAt",
          sortDir: req.sortDir === "asc" ? "asc" : "desc",
          page: coercePage(req.page),
          limit: coerceLimit(req.limit),
        });

        // Resolve each admin's snapshot avatar key → presigned download URL
        // (shared avatars bucket), mirroring adminListCommunityMembers. Raw keys
        // must never leak to the wire.
        const communities = await Promise.all(
          rows.map(async (r) => {
            // Admin's snapshot avatar (shared avatars bucket) and the
            // community's own avatar + cover (community bucket) are resolved
            // with their respective services — same helpers used by the other
            // admin RPCs. All in one Promise.all per row (no N+1).
            const [adminAvatarView, communityAvatarView, communityCoverView] =
              await Promise.all([
                memberAvatarService.resolveViewUrl(r.adminAvatar),
                communityImageService.resolveViewUrlForClient(r.avatarUrl),
                communityImageService.resolveViewUrlForClient(r.coverUrl),
              ]);
            return {
              communityId: r.id,
              name: r.name,
              handle: r.handle,
              adminId: r.adminId,
              adminName: r.adminName,
              adminUsername: r.adminUsername,
              adminAvatarUrl: adminAvatarView?.url ?? "",
              type: String(r.type),
              categoryId: r.categoryId,
              categoryName: r.category?.name ?? "",
              categorySlug: r.category?.slug ?? "",
              status: moderationStatusToWire(r.moderationStatus),
              memberCount: r.memberCount,
              livestreamCount: 0, // STUB until stream-service is wired
              createdAt:
                r.createdAt instanceof Date ? r.createdAt.getTime() : 0,
              communityAvatarUrl: communityAvatarView?.url ?? "",
              communityCoverUrl: communityCoverView?.url ?? "",
            };
          })
        );

        callback(null, {
          communities,
          total,
        });
      } catch (err) {
        logger.error("adminListCommunities gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminListCommunities failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Batch community enrichment for the backoffice Livestream Management list.
  // Returns name + presigned avatar + category + memberCount per id. Unknown or
  // malformed ids are silently omitted (caller treats them as "unknown community").
  adminGetCommunitiesByIds: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { communityIds?: string[] };
        const ids = Array.isArray(req.communityIds)
          ? req.communityIds.filter((id) => /^[0-9a-f]{24}$/i.test(id))
          : [];
        const rows = await communityRepository.adminGetCommunitiesByIds(ids);
        const communities = await Promise.all(
          rows.map(async (r) => {
            const avatarView =
              await communityImageService.resolveViewUrlForClient(r.avatarUrl);
            return {
              communityId: r.id,
              name: r.name,
              avatarUrl: avatarView?.url ?? "",
              categoryId: r.categoryId,
              categoryName: r.category?.name ?? r.categoryName ?? "",
              categorySlug: r.category?.slug ?? "",
              memberCount: r.memberCount,
            };
          })
        );
        callback(null, { communities });
      } catch (err) {
        logger.error("adminGetCommunitiesByIds gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminGetCommunitiesByIds failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Admin Reports search: community ids matching a name search term (capped).
  adminSearchCommunityIds: (
    call: grpc.ServerUnaryCall<{ search?: string }, unknown>,
    callback: grpc.sendUnaryData<{ communityIds: string[] }>
  ) => {
    void (async () => {
      try {
        const search = call.request.search ?? "";
        const communityIds =
          await communityRepository.adminSearchCommunityIds(search);
        callback(null, { communityIds });
      } catch (err) {
        logger.error("adminSearchCommunityIds gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminSearchCommunityIds failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Batch role lookup for the backoffice Livestream Viewer List "type" column.
  // Users not currently a member of the community are simply omitted — the
  // caller defaults them to MEMBER.
  adminGetMemberRoles: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          communityId?: string;
          userIds?: string[];
        };
        const userIds = Array.isArray(req.userIds) ? req.userIds : [];
        const rows = await communityRepository.getMemberRolesByUserIds(
          (req.communityId || "").trim(),
          userIds
        );
        callback(null, {
          roles: rows.map((r) => ({
            userId: r.userId,
            role: String(r.role),
          })),
        });
      } catch (err) {
        logger.error("adminGetMemberRoles gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminGetMemberRoles failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Admin Community Management detail. `found:false` + empty community when missing.
  adminGetCommunity: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { communityId?: string };
        const communityId = (req.communityId || "").trim();
        const detail = communityId
          ? await communityRepository.adminGetCommunityDetail(communityId)
          : null;

        if (!detail) {
          callback(null, {
            found: false,
            community: {
              communityId: "",
              name: "",
              handle: "",
              adminId: "",
              adminName: "",
              adminUsername: "",
              adminAvatarUrl: "",
              type: "",
              categoryId: "",
              categoryName: "",
              categorySlug: "",
              status: "",
              memberCount: 0,
              livestreamCount: 0,
              createdAt: 0,
            },
            description: "",
            coverUrl: "",
            lastActivityAt: 0,
            membersTotal: 0,
            membersActive: 0,
            membersPending: 0,
            membersBanned: 0,
            membersModerators: 0,
            membersJoinedLast7d: 0,
            openReports: 0,
            activeInviteLinks: 0,
            joinPolicy: "",
            ownerEmail: "",
            ownerAccountStatus: "",
          });
          return;
        }

        const c = detail.community;
        // Resolve raw stored keys → presigned download URLs (resolve-on-read):
        // admin avatar from the shared avatars bucket (like the member list),
        // community's own avatar + cover from the private community bucket
        // (mirrors adminListCommunities so list and detail agree on shape).
        const [adminAvatarView, communityAvatarView, coverView] =
          await Promise.all([
            memberAvatarService.resolveViewUrl(detail.adminAvatar),
            communityImageService.resolveViewUrlForClient(c.avatarUrl),
            communityImageService.resolveViewUrlForClient(c.coverUrl),
          ]);
        callback(null, {
          found: true,
          community: {
            communityId: c.id,
            name: c.name,
            handle: c.handle,
            adminId: c.adminId,
            adminName: detail.adminName,
            adminUsername: detail.adminUsername,
            adminAvatarUrl: adminAvatarView?.url ?? "",
            type: String(c.type),
            categoryId: c.categoryId,
            categoryName: c.category?.name ?? "",
            categorySlug: c.category?.slug ?? "",
            status: moderationStatusToWire(c.moderationStatus),
            memberCount: c.memberCount,
            livestreamCount: 0, // STUB until stream-service is wired
            createdAt: c.createdAt instanceof Date ? c.createdAt.getTime() : 0,
            communityAvatarUrl: communityAvatarView?.url ?? "",
          },
          description: c.description ?? "",
          coverUrl: coverView?.url ?? "",
          lastActivityAt:
            c.lastActivityAt instanceof Date ? c.lastActivityAt.getTime() : 0,
          membersTotal: detail.membersTotal,
          membersActive: detail.membersActive,
          membersPending: detail.membersPending,
          membersBanned: detail.membersBanned,
          membersModerators: detail.membersModerators,
          membersJoinedLast7d: detail.membersJoinedLast7d,
          openReports: detail.openReports,
          activeInviteLinks: detail.activeInviteLinks,
          joinPolicy: c.type === CommunityType.PRIVATE ? "REQUEST" : "OPEN",
          // Best-effort until enriched cross-service (see proto comment).
          ownerEmail: "",
          ownerAccountStatus: "ACTIVE",
        });
      } catch (err) {
        logger.error("adminGetCommunity gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminGetCommunity failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Admin Community Member List — offset paginated, searchable (username/userId),
  // role-filterable. Rows are fully denormalized snapshots; each member's avatar
  // is presigned from its snapshotAvatarKey via the member-avatar service (shared
  // avatars bucket) — "" when no key/presign.
  adminListCommunityMembers: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          communityId?: string;
          search?: string;
          role?: string;
          page?: number;
          limit?: number;
          excludeUserId?: string;
          sortField?: string;
          sortDir?: string;
        };

        const role =
          req.role === "ADMIN"
            ? CommunityMemberRole.ADMIN
            : req.role === "MODERATOR"
              ? CommunityMemberRole.MODERATOR
              : req.role === "MEMBER"
                ? CommunityMemberRole.MEMBER
                : undefined;

        const sortField =
          req.sortField === "username" ||
          req.sortField === "handle" ||
          req.sortField === "joinedAt"
            ? req.sortField
            : undefined;

        const { rows, total } =
          await communityRepository.adminListCommunityMembers({
            communityId: (req.communityId || "").trim(),
            search: req.search?.trim() || undefined,
            role,
            excludeUserId: req.excludeUserId?.trim() || undefined,
            sortField,
            sortDir: req.sortDir === "desc" ? "desc" : "asc",
            page: coercePage(req.page),
            limit: coerceLimit(req.limit),
          });

        const members = await Promise.all(
          rows.map(async (m) => {
            const avatarView = await memberAvatarService.resolveViewUrl(
              m.snapshotAvatarKey
            );
            return {
              userId: m.userId,
              username: m.snapshotDisplayName || m.snapshotUsername,
              handle: m.snapshotUsername,
              avatarUrl: avatarView?.url ?? "",
              role: String(m.role),
              status: String(m.status),
              joinedAt:
                m.joinedAt instanceof Date ? m.joinedAt.toISOString() : "",
            };
          })
        );

        callback(null, { members, total });
      } catch (err) {
        logger.error("adminListCommunityMembers gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminListCommunityMembers failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Admin Muted-Member List — currently-muted members of a community (lazy
  // expiration: mutedUntil null OR in the future), newest mute first. Unlike the
  // REST `/muted-members` endpoint this has NO community-membership/role check —
  // the caller is a trusted backoffice platform admin, not a community member.
  adminListMutedMembers: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          communityId?: string;
          page?: number;
          limit?: number;
        };

        const { rows, total } = await communityRepository.listMutedMembers({
          communityId: (req.communityId || "").trim(),
          now: new Date(),
          page: coercePage(req.page),
          limit: coerceLimit(req.limit),
        });

        let members: {
          userId: string;
          username: string;
          handle: string;
          avatarUrl: string;
          mutedBy: string;
          reason: string;
          mutedAt: number;
          mutedUntil: number;
        }[] = [];
        if (rows.length > 0) {
          const userIds = rows.map((r) => r.userId);
          const memberRows = await communityRepository.findMembersByUserIds(
            (req.communityId || "").trim(),
            userIds
          );
          const memberMap = new Map(memberRows.map((m) => [m.userId, m]));

          members = await Promise.all(
            rows.map(async (row) => {
              const member = memberMap.get(row.userId);
              const avatarView = await memberAvatarService.resolveViewUrl(
                member?.snapshotAvatarKey ?? null
              );
              return {
                userId: row.userId,
                username:
                  member?.snapshotDisplayName || member?.snapshotUsername || "",
                handle: member?.snapshotUsername ?? "",
                avatarUrl: avatarView?.url ?? "",
                mutedBy: row.mutedBy,
                reason: row.reason ?? "",
                mutedAt: row.createdAt.getTime(),
                mutedUntil: row.mutedUntil ? row.mutedUntil.getTime() : 0,
              };
            })
          );
        }

        callback(null, { members, total });
      } catch (err) {
        logger.error("adminListMutedMembers gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminListMutedMembers failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Admin User Management → Communities reverse lookup: communities the user is an
  // ACTIVE member of. Offset paginated, searchable by community name/id, sortable.
  // Each row's avatar is the community avatar presigned via the community-image
  // service (private community bucket) — "" when no key/presign.
  adminListUserCommunities: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          userId?: string;
          search?: string;
          sortField?: string;
          sortDir?: string;
          page?: number;
          limit?: number;
        };

        const userId = (req.userId || "").trim();
        if (!userId) {
          callback(null, { communities: [], total: 0 });
          return;
        }

        const sortField =
          req.sortField === "name" ||
          req.sortField === "memberCount" ||
          req.sortField === "createdAt"
            ? req.sortField
            : undefined;

        const { rows, total } =
          await communityRepository.adminListUserCommunities({
            userId,
            search: req.search?.trim() || undefined,
            sortField,
            sortDir: req.sortDir === "asc" ? "asc" : "desc",
            page: coercePage(req.page),
            limit: coerceLimit(req.limit),
          });

        const communities = await Promise.all(
          rows.map(async (r) => {
            const avatarView =
              await communityImageService.resolveViewUrlForClient(r.avatarUrl);
            return {
              communityId: r.id,
              name: r.name,
              avatarUrl: avatarView?.url ?? "",
              categoryId: r.categoryId,
              categoryName: r.categoryName ?? "",
              description: r.description ?? "",
              memberCount: r.memberCount,
              role: String(r.role),
              joinedAt:
                r.joinedAt instanceof Date ? r.joinedAt.toISOString() : "",
              createdAt:
                r.createdAt instanceof Date ? r.createdAt.getTime() : 0,
            };
          })
        );

        callback(null, { communities, total });
      } catch (err) {
        logger.error("adminListUserCommunities gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminListUserCommunities failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Admin close/reopen. Business failures (not-found / already-closed / not-closed)
  // are returned in the payload `errorCode` (NOT thrown) so the caller maps them
  // to HTTP 404/409 cleanly. Only infra errors throw gRPC INTERNAL.
  adminSetModerationStatus: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          communityId?: string;
          status?: string;
          reasonCode?: string;
          actorAdminId?: string;
        };
        const communityId = (req.communityId || "").trim();
        const target =
          req.status === "SUSPENDED"
            ? CommunityModerationStatus.SUSPENDED
            : CommunityModerationStatus.ACTIVE;

        if (!communityId) {
          callback(null, {
            ok: false,
            status: "ACTIVE",
            closedAt: 0,
            errorCode: "COMMUNITY_NOT_FOUND",
          });
          return;
        }

        const result = await communityService.adminSetModerationStatus(
          communityId,
          target,
          req.reasonCode?.trim() || null,
          req.actorAdminId?.trim() || null
        );
        callback(null, {
          ok: result.ok,
          status: result.status,
          closedAt: result.closedAt,
          errorCode: result.errorCode,
        });
      } catch (err) {
        logger.error("adminSetModerationStatus gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminSetModerationStatus failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // ---- Backoffice Category Management (4 handlers) ----
  // Thin gRPC wrappers around communityService's existing category CRUD —
  // zero duplicated business logic. Business errors are returned via
  // `errorCode` (not thrown), matching adminSetModerationStatus above.

  adminListCategories: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          search?: string;
          status?: string;
          page?: number;
          limit?: number;
          sortField?: string;
          sortDir?: string;
        };
        const status =
          req.status === "visible" || req.status === "hidden"
            ? req.status
            : undefined;
        const sortField =
          req.sortField === "name" ||
          req.sortField === "order" ||
          req.sortField === "createdAt" ||
          req.sortField === "communityCount"
            ? req.sortField
            : undefined;
        const sortDir = req.sortDir === "desc" ? "desc" : undefined;

        const result = await communityService.listCategoriesAdmin({
          search: req.search?.trim() || undefined,
          status,
          page: coercePage(req.page),
          limit: coerceLimit(req.limit),
          sortField,
          sortDir,
        });

        callback(null, {
          categories: result.categories.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
            visible: c.visible,
            order: c.order,
            createdAt: new Date(c.createdAt).getTime(),
            updatedAt: new Date(c.updatedAt).getTime(),
            communityCount: c.communityCount,
          })),
          total: result.pagination.total,
        });
      } catch (err) {
        logger.error("adminListCategories gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminListCategories failed",
        } as grpc.ServiceError);
      }
    })();
  },

  adminCreateCategory: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { name?: string };
        const category = await communityService.createCategory({
          name: (req.name ?? "").trim(),
        });
        callback(null, {
          ok: true,
          category: {
            id: category.id,
            name: category.name,
            slug: category.slug,
            visible: category.visible,
            order: category.order,
            createdAt: new Date(category.createdAt).getTime(),
            updatedAt: new Date(category.updatedAt).getTime(),
            communityCount: category.communityCount,
          },
          errorCode: "",
        });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            category: undefined,
            errorCode: err.messageKey,
          });
          return;
        }
        logger.error("adminCreateCategory gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminCreateCategory failed",
        } as grpc.ServiceError);
      }
    })();
  },

  adminUpdateCategory: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as {
          categoryId?: string;
          name?: string;
          hasName?: boolean;
          visible?: boolean;
          hasVisible?: boolean;
        };
        const category = await communityService.updateCategory(
          (req.categoryId ?? "").trim(),
          {
            ...(req.hasName ? { name: (req.name ?? "").trim() } : {}),
            ...(req.hasVisible ? { visible: !!req.visible } : {}),
          }
        );
        callback(null, {
          ok: true,
          category: {
            id: category.id,
            name: category.name,
            slug: category.slug,
            visible: category.visible,
            order: category.order,
            createdAt: new Date(category.createdAt).getTime(),
            updatedAt: new Date(category.updatedAt).getTime(),
            communityCount: category.communityCount,
          },
          errorCode: "",
        });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            category: undefined,
            errorCode: err.messageKey,
          });
          return;
        }
        logger.error("adminUpdateCategory gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminUpdateCategory failed",
        } as grpc.ServiceError);
      }
    })();
  },

  adminDeleteCategory: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      try {
        const req = call.request as { categoryId?: string };
        const result = await communityService.deleteCategory(
          (req.categoryId ?? "").trim()
        );
        callback(null, {
          ok: true,
          softDeleted: result.softDeleted,
          errorCode: "",
        });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            softDeleted: false,
            errorCode: err.messageKey,
          });
          return;
        }
        logger.error("adminDeleteCategory gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "adminDeleteCategory failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // ---- Member moderation (7 handlers called by gateway socket events) ----
  // Business errors are returned in `errorCode` (not as gRPC exceptions) so
  // the gateway can map them to appropriate ack error codes. Only infra
  // failures throw gRPC INTERNAL.

  kickMember: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        communityId?: string;
        actorId?: string;
        targetUserId?: string;
        reason?: string;
      };
      const communityId = (req.communityId ?? "").trim();
      const actorId = (req.actorId ?? "").trim();
      const targetUserId = (req.targetUserId ?? "").trim();
      try {
        await communityService.kickMember(
          communityId,
          actorId,
          targetUserId,
          req.reason || undefined
        );
        callback(null, { ok: true, communityId, targetUserId, errorCode: "" });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            communityId,
            targetUserId,
            errorCode: err.message,
          });
        } else {
          logger.error("kickMember gRPC handler failed", err);
          callback({
            code: grpc.status.INTERNAL,
            message: "kickMember failed",
          } as grpc.ServiceError);
        }
      }
    })();
  },

  banMember: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        communityId?: string;
        actorId?: string;
        targetUserId?: string;
        reason?: string;
      };
      const communityId = (req.communityId ?? "").trim();
      const actorId = (req.actorId ?? "").trim();
      const targetUserId = (req.targetUserId ?? "").trim();
      try {
        await communityService.banMember(
          communityId,
          actorId,
          targetUserId,
          req.reason || undefined
        );
        callback(null, { ok: true, communityId, targetUserId, errorCode: "" });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            communityId,
            targetUserId,
            errorCode: err.message,
          });
        } else {
          logger.error("banMember gRPC handler failed", err);
          callback({
            code: grpc.status.INTERNAL,
            message: "banMember failed",
          } as grpc.ServiceError);
        }
      }
    })();
  },

  unbanMember: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        communityId?: string;
        actorId?: string;
        targetUserId?: string;
      };
      const communityId = (req.communityId ?? "").trim();
      const actorId = (req.actorId ?? "").trim();
      const targetUserId = (req.targetUserId ?? "").trim();
      try {
        await communityService.unbanMember(communityId, actorId, targetUserId);
        callback(null, { ok: true, communityId, targetUserId, errorCode: "" });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            communityId,
            targetUserId,
            errorCode: err.message,
          });
        } else {
          logger.error("unbanMember gRPC handler failed", err);
          callback({
            code: grpc.status.INTERNAL,
            message: "unbanMember failed",
          } as grpc.ServiceError);
        }
      }
    })();
  },

  // Single write path for community moderation mute — called from the
  // community UI/socket AND from stream-service's livestream "mute" action, so
  // both entry points share one mute record.
  muteMember: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        communityId?: string;
        actorId?: string;
        targetUserId?: string;
        durationMinutes?: number;
        reason?: string;
      };
      const communityId = (req.communityId ?? "").trim();
      const actorId = (req.actorId ?? "").trim();
      const targetUserId = (req.targetUserId ?? "").trim();
      const durationMinutes =
        req.durationMinutes && req.durationMinutes > 0
          ? Number(req.durationMinutes)
          : null;
      try {
        const result = await communityService.muteMember(
          communityId,
          actorId,
          targetUserId,
          durationMinutes,
          req.reason || undefined
        );
        callback(null, {
          ok: true,
          communityId,
          targetUserId,
          errorCode: "",
          mutedUntil: result.mutedUntil
            ? new Date(result.mutedUntil).getTime()
            : 0,
        });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            communityId,
            targetUserId,
            errorCode: err.message,
            mutedUntil: 0,
          });
        } else {
          logger.error("muteMember gRPC handler failed", err);
          callback({
            code: grpc.status.INTERNAL,
            message: "muteMember failed",
          } as grpc.ServiceError);
        }
      }
    })();
  },

  unmuteMember: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        communityId?: string;
        actorId?: string;
        targetUserId?: string;
      };
      const communityId = (req.communityId ?? "").trim();
      const actorId = (req.actorId ?? "").trim();
      const targetUserId = (req.targetUserId ?? "").trim();
      try {
        await communityService.unmuteMember(communityId, actorId, targetUserId);
        callback(null, { ok: true, communityId, targetUserId, errorCode: "" });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            communityId,
            targetUserId,
            errorCode: err.message,
          });
        } else {
          logger.error("unmuteMember gRPC handler failed", err);
          callback({
            code: grpc.status.INTERNAL,
            message: "unmuteMember failed",
          } as grpc.ServiceError);
        }
      }
    })();
  },

  transferAdmin: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        communityId?: string;
        actorId?: string;
        newAdminId?: string;
      };
      const communityId = (req.communityId ?? "").trim();
      const actorId = (req.actorId ?? "").trim();
      const newAdminId = (req.newAdminId ?? "").trim();
      try {
        await communityService.transferAdmin(communityId, actorId, newAdminId);
        callback(null, {
          ok: true,
          communityId,
          targetUserId: newAdminId,
          errorCode: "",
        });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            communityId,
            targetUserId: newAdminId,
            errorCode: err.message,
          });
        } else {
          logger.error("transferAdmin gRPC handler failed", err);
          callback({
            code: grpc.status.INTERNAL,
            message: "transferAdmin failed",
          } as grpc.ServiceError);
        }
      }
    })();
  },

  changeMemberRole: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        communityId?: string;
        actorId?: string;
        targetUserId?: string;
        newRole?: string;
      };
      const communityId = (req.communityId ?? "").trim();
      const actorId = (req.actorId ?? "").trim();
      const targetUserId = (req.targetUserId ?? "").trim();
      const role =
        req.newRole === "MODERATOR"
          ? CommunityMemberRole.MODERATOR
          : CommunityMemberRole.MEMBER;
      try {
        await communityService.updateMemberRole(
          communityId,
          actorId,
          targetUserId,
          role
        );
        callback(null, { ok: true, communityId, targetUserId, errorCode: "" });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            communityId,
            targetUserId,
            errorCode: err.message,
          });
        } else {
          logger.error("changeMemberRole gRPC handler failed", err);
          callback({
            code: grpc.status.INTERNAL,
            message: "changeMemberRole failed",
          } as grpc.ServiceError);
        }
      }
    })();
  },

  createReport: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        communityId?: string;
        reporterId?: string;
        reason?: string;
        targetMessageId?: string;
      };
      const communityId = (req.communityId ?? "").trim();
      const reporterId = (req.reporterId ?? "").trim();
      const reason = (req.reason ?? "").trim();
      // The proto carries targetMessageId (the message being reported).
      // The current service model stores the target entity under targetUserId.
      const targetUserId = (req.targetMessageId ?? "").trim() || undefined;
      try {
        const report = await communityService.createReport(
          communityId,
          reporterId,
          { targetUserId, reason }
        );
        callback(null, { reportId: report.reportId, ok: true });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, { reportId: "", ok: false });
        } else {
          logger.error("createReport gRPC handler failed", err);
          callback({
            code: grpc.status.INTERNAL,
            message: "createReport failed",
          } as grpc.ServiceError);
        }
      }
    })();
  },

  // Lightweight membership scan for the gateway socket layer: returns all
  // community IDs where userId is an ACTIVE member. Used on socket connect to
  // auto-join community:<id> rooms without a per-community client:join emit.
  getUserActiveCommunityIds: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as { userId?: string };
      const userId = (req.userId ?? "").trim();
      if (!userId) {
        callback(null, { communityIds: [] });
        return;
      }
      try {
        const memberships =
          await communityRepository.findUserMemberships(userId);
        callback(null, {
          communityIds: memberships.map((m) => m.communityId),
        });
      } catch (err) {
        logger.error("getUserActiveCommunityIds gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "getUserActiveCommunityIds failed",
        } as grpc.ServiceError);
      }
    })();
  },

  // Room-independent typing indicator fan-out (gateway /community namespace):
  // returns every ACTIVE member's userId for a community so the gateway can
  // both validate the sender (member of the returned list) and resolve direct
  // recipients — a single query, no cross-community joins needed. Reuses the
  // SAME repository method as deleteCommunity's "notify everyone" roster and
  // the stream-lifecycle consumers — no new business logic.
  getCommunityActiveMemberIds: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as { communityId?: string };
      const communityId = (req.communityId ?? "").trim();
      if (!communityId) {
        callback(null, { userIds: [] });
        return;
      }
      try {
        const userIds =
          await communityRepository.findActiveMemberIds(communityId);
        callback(null, { userIds });
      } catch (err) {
        logger.error("getCommunityActiveMemberIds gRPC handler failed", err);
        callback({
          code: grpc.status.INTERNAL,
          message: "getCommunityActiveMemberIds failed",
        } as grpc.ServiceError);
      }
    })();
  },

  deleteCommunity: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) => {
    void (async () => {
      const req = call.request as {
        communityId?: string;
        actorId?: string;
        reason?: string;
      };
      const communityId = (req.communityId ?? "").trim();
      const actorId = (req.actorId ?? "").trim();
      try {
        await communityService.deleteCommunity(communityId, actorId);
        callback(null, {
          ok: true,
          communityId,
          targetUserId: actorId,
          errorCode: "",
        });
      } catch (err) {
        if (isAppError(err)) {
          callback(null, {
            ok: false,
            communityId,
            targetUserId: "",
            errorCode: err.message,
          });
        } else {
          logger.error("deleteCommunity gRPC handler failed", err);
          callback({
            code: grpc.status.INTERNAL,
            message: "deleteCommunity failed",
          } as grpc.ServiceError);
        }
      }
    })();
  },
};
