import { logger } from "@aimess/logger";

import { AUDIT_ACTIONS } from "../constants/index.js";
import { groupRepository } from "../repositories/index.js";
import type { RequestAdmin } from "../types/index.js";
import type {
  GroupItem,
  GroupMemberItem,
  GroupPagination,
  ListGroupMembersQuery,
  ListGroupsQuery,
} from "../types/group.types.js";
import { auditService } from "./audit.service.js";

/** Audit/request context derived from `getRequestContext(req)`. */
type RequestCtx = { ip: string; userAgent: string | null };

/**
 * Group Management read service. Groups live in chat-service; this orchestrates
 * the gRPC-backed repository and records a read-audit trail in admin_db.
 */
export const groupService = {
  /** List groups; controller attaches the response envelope. */
  async listGroups(
    query: ListGroupsQuery,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<{ items: GroupItem[]; pagination: GroupPagination }> {
    const result = await groupRepository.list(query);

    // Best-effort + non-blocking: a READ must never 500 because an audit insert
    // failed, so we fire-and-forget and log-and-continue on error. (Mutation
    // paths deliberately keep the blocking model — an unaudited action is not OK.)
    void auditService
      .record({
        actorId: actor.id,
        action: AUDIT_ACTIONS.GROUP_LIST_VIEWED,
        targetType: "group",
        targetId: null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      .catch((err: unknown) => {
        logger.warn("Failed to record GROUP_LIST_VIEWED audit", { err });
      });

    return result;
  },

  /** Fetch one group; null is translated to 404 by the controller. */
  async getGroup(
    groupId: string,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<GroupItem | null> {
    const group = await groupRepository.getById(groupId);

    // Only audit a successful detail view. Best-effort + non-blocking: a READ
    // must never 500 because an audit insert failed, so we fire-and-forget and
    // log-and-continue on error. (Mutation paths keep the blocking model.)
    if (group) {
      void auditService
        .record({
          actorId: actor.id,
          action: AUDIT_ACTIONS.GROUP_VIEWED,
          targetType: "group",
          targetId: groupId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        })
        .catch((err: unknown) => {
          logger.warn("Failed to record GROUP_VIEWED audit", { err });
        });
    }

    return group;
  },

  /** List a group's members; `found:false` is translated to 404 by the controller. */
  async listGroupMembers(
    groupId: string,
    query: ListGroupMembersQuery,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<{
    found: boolean;
    items: GroupMemberItem[];
    pagination: GroupPagination;
  }> {
    const result = await groupRepository.listMembers(groupId, query);

    // Only audit when the group exists. Best-effort + non-blocking: a READ must
    // never 500 because an audit insert failed, so we fire-and-forget and
    // log-and-continue on error. (Mutation paths keep the blocking model.)
    if (result.found) {
      void auditService
        .record({
          actorId: actor.id,
          action: AUDIT_ACTIONS.GROUP_MEMBERS_VIEWED,
          targetType: "group",
          targetId: groupId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        })
        .catch((err: unknown) => {
          logger.warn("Failed to record GROUP_MEMBERS_VIEWED audit", { err });
        });
    }

    return result;
  },

  // Disband a group platform-side. The repository throws NotFound/Conflict on
  // every chat-service business failure, so reaching the audit means it landed.
  // `reason` is backoffice-only bookkeeping — the proto carries no reason field
  // for disband, so it is recorded in the audit trail and nowhere else.
  async disbandGroup(
    groupId: string,
    reason: string | undefined,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<{ groupId: string; status: string; auditLogId: string }> {
    // Light pre-read for the audit `before` snapshot; groups are gRPC-backed so
    // there is no local row to diff against.
    const before = await groupRepository.getById(groupId);
    await groupRepository.disband(groupId, actor.id);

    // Blocking, unlike the reads above — an unaudited moderation action is not OK.
    const auditLog = await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.GROUP_DISBANDED,
      targetType: "group",
      targetId: groupId,
      before: { status: before?.status ?? null },
      after: { status: "DISBANDED", reason: reason ?? null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { groupId, status: "DISBANDED", auditLogId: auditLog.id };
  },

  // Remove one member from a group platform-side. `reason` IS forwarded here —
  // chat-service persists it as GroupMember.kickReason.
  async removeGroupMember(
    groupId: string,
    userId: string,
    reason: string | undefined,
    actor: RequestAdmin,
    ctx: RequestCtx
  ): Promise<{ groupId: string; userId: string; auditLogId: string }> {
    await groupRepository.removeMember(groupId, userId, actor.id, reason);

    // Blocking, unlike the reads above — an unaudited moderation action is not OK.
    const auditLog = await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.GROUP_MEMBER_REMOVED,
      targetType: "group",
      targetId: groupId,
      after: { userId, reason: reason ?? null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { groupId, userId, auditLogId: auditLog.id };
  },
};
