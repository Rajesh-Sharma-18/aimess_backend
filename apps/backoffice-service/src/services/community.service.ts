import { AUDIT_ACTIONS } from "../constants/index.js";
import {
  communityMembersRepository,
  communityRepository,
  moderationActionRepository,
} from "../repositories/index.js";
import type { ActorRef } from "../repositories/community.repository.js";
import type { RequestAdmin } from "../types/index.js";
import type {
  BulkResult,
  CloseInput,
  CloseResult,
  CommunityDetail,
  CommunityListItem,
  CommunityMemberRow,
  ListCommunitiesQuery,
  ListCommunityMembersQuery,
  ModerationActor,
  Paginated,
  PaginationMeta,
  ReopenInput,
  ReopenResult,
} from "../types/community.types.js";
import { auditService } from "./audit.service.js";

/** Audit/request context derived from `getRequestContext(req)`. */
type RequestCtx = { ip: string; userAgent: string | null };

/** Map req.admin → the actor stamp recorded on a moderation entry. */
function toModerator(actor: RequestAdmin): ModerationActor {
  // TODO Phase 2: RequestAdmin has no display name; stamp real name once token carries it.
  return { adminId: actor.id, name: actor.id };
}

export const communityService = {
  /** List communities; controller attaches the response `meta` envelope. */
  async listCommunities(query: ListCommunitiesQuery): Promise<{
    data: CommunityListItem[];
    pagination: PaginationMeta;
  }> {
    const page = await communityRepository.list(query);
    return {
      data: page.data,
      pagination: page.pagination,
    };
  },

  /** Fetch one community; null is translated to 404 by the controller. */
  getCommunity(communityId: string): Promise<CommunityDetail | null> {
    return communityRepository.getById(communityId);
  },

  /** List a community's members (the "Community User List" grid). */
  listCommunityMembers(
    communityId: string,
    query: ListCommunityMembersQuery
  ): Promise<Paginated<CommunityMemberRow>> {
    return communityMembersRepository.listMembers(communityId, query);
  },

  async closeCommunity(
    communityId: string,
    input: CloseInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<CloseResult> {
    const ref = buildActor(actor);
    const before = await communityRepository.getById(communityId);
    const result = await communityRepository.close(communityId, input, ref);

    const moderationAction = await moderationActionRepository.create({
      actorId: actor.id,
      type: "suspend_community",
      targetType: "community",
      targetId: communityId,
      reason: input.reasonNote ?? input.reasonCode,
      metadata: {
        reasonCode: input.reasonCode,
        notifyOwner: input.notifyOwner ?? true,
      },
    });

    const auditLog = await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.COMMUNITY_CLOSED,
      targetType: "community",
      targetId: communityId,
      before: { status: before?.community.status ?? null },
      after: {
        status: result.status,
        reasonCode: result.reasonCode,
        reasonNote: input.reasonNote ?? null,
        notifyOwner: input.notifyOwner ?? true,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return {
      ...result,
      moderationActionId: moderationAction.id,
      auditLogId: auditLog.id,
    };
  },

  async reopenCommunity(
    communityId: string,
    input: ReopenInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<ReopenResult> {
    const ref = buildActor(actor);
    const before = await communityRepository.getById(communityId);
    const result = await communityRepository.reopen(communityId, input, ref);

    const moderationAction = await moderationActionRepository.create({
      actorId: actor.id,
      type: "reopen_community",
      targetType: "community",
      targetId: communityId,
      reason: input.reasonNote ?? "Community reopened by admin",
      metadata: { notifyOwner: input.notifyOwner ?? true },
    });

    const auditLog = await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.COMMUNITY_REOPENED,
      targetType: "community",
      targetId: communityId,
      before: { status: before?.community.status ?? null },
      after: {
        status: result.status,
        reasonNote: input.reasonNote ?? null,
        notifyOwner: input.notifyOwner ?? true,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return {
      ...result,
      moderationActionId: moderationAction.id,
      auditLogId: auditLog.id,
    };
  },

  async bulkClose(
    communityIds: string[],
    input: CloseInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<BulkResult> {
    const ref = buildActor(actor);
    const result = await communityRepository.bulkClose(
      communityIds,
      input,
      ref
    );

    // Per the design, write one ModerationAction + AuditLog per SUCCEEDED item.
    for (const item of result.results) {
      if (!item.ok) continue;
      await moderationActionRepository.create({
        actorId: actor.id,
        type: "suspend_community",
        targetType: "community",
        targetId: item.communityId,
        reason: input.reasonNote ?? input.reasonCode,
        metadata: {
          reasonCode: input.reasonCode,
          notifyOwner: input.notifyOwner ?? true,
          bulk: true,
        },
      });
      await auditService.record({
        actorId: actor.id,
        action: AUDIT_ACTIONS.COMMUNITY_BULK_CLOSED,
        targetType: "community",
        targetId: item.communityId,
        // A succeeded bulk-close item was necessarily ACTIVE before the action
        // (the repo rejects non-ACTIVE rows), mirroring the single-item before.
        before: { status: "ACTIVE" },
        after: {
          status: item.status,
          reasonCode: input.reasonCode,
          reasonNote: input.reasonNote ?? null,
          notifyOwner: input.notifyOwner ?? true,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return result;
  },

  async bulkReopen(
    communityIds: string[],
    input: ReopenInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<BulkResult> {
    const ref = buildActor(actor);
    const result = await communityRepository.bulkReopen(
      communityIds,
      input,
      ref
    );

    // Per the design, write one ModerationAction + AuditLog per SUCCEEDED item.
    for (const item of result.results) {
      if (!item.ok) continue;
      await moderationActionRepository.create({
        actorId: actor.id,
        type: "reopen_community",
        targetType: "community",
        targetId: item.communityId,
        reason: input.reasonNote ?? "Community reopened by admin",
        metadata: { notifyOwner: input.notifyOwner ?? true, bulk: true },
      });
      await auditService.record({
        actorId: actor.id,
        action: AUDIT_ACTIONS.COMMUNITY_BULK_REOPENED,
        targetType: "community",
        targetId: item.communityId,
        // A succeeded bulk-reopen item was necessarily CLOSED before the action
        // (the repo rejects non-CLOSED rows), mirroring the single-item before.
        before: { status: "CLOSED" },
        after: {
          status: item.status,
          reasonNote: input.reasonNote ?? null,
          notifyOwner: input.notifyOwner ?? true,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return result;
  },
};

/** Build the repository ActorRef (admin stamp + decision timestamp). */
function buildActor(actor: RequestAdmin): ActorRef {
  return { moderator: toModerator(actor), at: new Date().toISOString() };
}
