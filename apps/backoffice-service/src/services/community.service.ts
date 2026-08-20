import { logger } from "@aimess/logger";

import { AUDIT_ACTIONS } from "../constants/index.js";
import { chatClient } from "../grpc/chat.client.js";
import { getAccountStatuses } from "../repositories/user-directory.repository.js";
import {
  communityMembersRepository,
  communityMutesRepository,
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
  CommunityMutedMemberRow,
  ConversationMessagesQuery,
  ConversationMessagesResult,
  ListCommunitiesQuery,
  ListCommunityMembersQuery,
  ListMutedMembersQuery,
  MemberModerationInput,
  MemberModerationResult,
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
  async listCommunities(
    query: ListCommunitiesQuery,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<{
    data: CommunityListItem[];
    pagination: PaginationMeta;
  }> {
    const page = await communityRepository.list(query);

    // Audit the list view with the resolved sort + active filters (mirrors the
    // USER_LIST_VIEWED / GROUP_LIST_VIEWED precedent). `targetId` is null — this
    // is a collection view. Best-effort + non-blocking: a READ must never 500
    // because an audit insert failed, so we fire-and-forget and log-and-continue
    // on error. (Moderation mutations keep the blocking audit model.)
    void auditService
      .record({
        actorId: actor.id,
        action: AUDIT_ACTIONS.COMMUNITY_LIST_VIEWED,
        targetType: "community",
        targetId: null,
        after: {
          sortBy: query.sortBy,
          sortOrder: query.sortOrder,
          page: query.page,
          limit: query.limit,
          filters: {
            search: query.search ?? null,
            type: query.type ?? null,
            category: query.category ?? null,
            status: query.status ?? null,
            createdFrom: query.createdFrom ?? null,
            createdTo: query.createdTo ?? null,
          },
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      .catch((err: unknown) => {
        logger.warn("Failed to record COMMUNITY_LIST_VIEWED audit", { err });
      });

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
  async listCommunityMembers(
    communityId: string,
    query: ListCommunityMembersQuery
  ): Promise<Paginated<CommunityMemberRow>> {
    const result = await communityMembersRepository.listMembers(
      communityId,
      query
    );

    // Stamp each member's ACCOUNT status from the UserIndex mirror so the panel
    // can hide the ban action for a SYSTEM-banned user (unbannable only from the
    // User profile). One indexed query for the whole page.
    if (result.data.length > 0) {
      const statuses = await getAccountStatuses(
        result.data.map((m) => m.userId)
      );
      result.data = result.data.map((m) => ({
        ...m,
        accountStatus: statuses.get(m.userId) ?? "ACTIVE",
      }));
    }

    return result;
  },

  /** List a community's currently-muted members (platform-admin only). */
  listMutedMembers(
    communityId: string,
    query: ListMutedMembersQuery
  ): Promise<Paginated<CommunityMutedMemberRow>> {
    return communityMutesRepository.listMutedMembers(communityId, query);
  },

  /**
   * Community Conversation viewer — paginated, read-only message history.
   * Thin passthrough to chat-service's AdminGetCommunityMessages (trusted
   * platform-admin read, no membership gate — works on PRIVATE communities
   * too), normalized into the shape the admin panel renders. Reuses the same
   * `cursor`/`limit` pagination chat-service already uses for the
   * website/mobile community chat — no separate pagination scheme.
   */
  async getConversationMessages(
    communityId: string,
    query: ConversationMessagesQuery
  ): Promise<ConversationMessagesResult> {
    const res = await chatClient.adminGetCommunityMessages({
      roomId: communityId,
      cursor: query.cursor ?? "",
      limit: query.limit,
    });

    const messages = (res.messages ?? []).map((m) => ({
      messageId: m.messageId,
      senderId: m.senderId,
      senderName: m.senderName || "Unknown",
      senderAvatar: m.senderAvatar || null,
      message: m.message,
      contentType: m.contentType,
      attachments: m.attachmentsJson ? JSON.parse(m.attachmentsJson) : [],
      reactions: m.reactionsJson ? JSON.parse(m.reactionsJson) : [],
      quoteData: m.quoteDataJson ? JSON.parse(m.quoteDataJson) : null,
      sentAt: Number(m.sentAt) || 0,
      systemMessageType: m.systemMessageType || null,
    }));

    return {
      messages,
      nextCursor: res.nextCursor || null,
      hasMore: Boolean(res.hasMore),
      pinnedMessage: res.pinnedMessageJson
        ? JSON.parse(res.pinnedMessageJson)
        : null,
    };
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

  /**
   * Admin Community Conversation viewer — remove a member from THIS community
   * only (they remain active elsewhere). community-service's adminKickMember
   * performs the mutation + realtime broadcast (community:member:removed,
   * reflected live to website/Android/iOS via the existing gateway
   * subscription) but skips its own audit write — this is a
   * backoffice-initiated action, so backoffice-service writes the canonical
   * ModerationAction + AuditLog itself, same convention as closeCommunity.
   */
  async kickCommunityMember(
    communityId: string,
    targetUserId: string,
    input: MemberModerationInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<MemberModerationResult> {
    const ref = buildActor(actor);
    const result = await communityRepository.kickMember(
      communityId,
      targetUserId,
      input.reason,
      ref
    );

    const moderationAction = await moderationActionRepository.create({
      actorId: actor.id,
      type: "remove_community_member",
      targetType: "user",
      targetId: targetUserId,
      // Same default-when-omitted precedent as reopenCommunity's reasonNote.
      reason: input.reason ?? "Removed from community by admin",
      metadata: { communityId },
    });

    const auditLog = await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.COMMUNITY_MEMBER_REMOVED,
      targetType: "user",
      targetId: targetUserId,
      after: {
        communityId,
        status: result.status,
        reason: input.reason ?? null,
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

  /**
   * Admin Community Conversation viewer — ban a member from THIS community
   * only. Same reuse/audit split as {@link kickCommunityMember}.
   */
  async banCommunityMember(
    communityId: string,
    targetUserId: string,
    input: MemberModerationInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<MemberModerationResult> {
    const ref = buildActor(actor);
    const result = await communityRepository.banMember(
      communityId,
      targetUserId,
      input.reason,
      ref
    );

    const moderationAction = await moderationActionRepository.create({
      actorId: actor.id,
      type: "ban_community_member",
      targetType: "user",
      targetId: targetUserId,
      reason: input.reason ?? "Banned from community by admin",
      metadata: { communityId },
    });

    const auditLog = await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.COMMUNITY_MEMBER_BANNED,
      targetType: "user",
      targetId: targetUserId,
      after: {
        communityId,
        status: result.status,
        reason: input.reason ?? null,
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

  async unbanCommunityMember(
    communityId: string,
    targetUserId: string,
    input: MemberModerationInput,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<MemberModerationResult> {
    const ref = buildActor(actor);
    const result = await communityRepository.unbanMember(
      communityId,
      targetUserId,
      ref
    );

    const moderationAction = await moderationActionRepository.create({
      actorId: actor.id,
      type: "unban_community_member",
      targetType: "user",
      targetId: targetUserId,
      reason: input.reason ?? "Community ban lifted by admin",
      metadata: { communityId },
    });

    const auditLog = await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.COMMUNITY_MEMBER_UNBANNED,
      targetType: "user",
      targetId: targetUserId,
      after: {
        communityId,
        status: result.status,
        reason: input.reason ?? null,
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
};

/** Build the repository ActorRef (admin stamp + decision timestamp). */
function buildActor(actor: RequestAdmin): ActorRef {
  return { moderator: toModerator(actor), at: Date.now() };
}
