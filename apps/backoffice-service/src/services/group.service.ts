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

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.GROUP_LIST_VIEWED,
      targetType: "group",
      targetId: null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
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

    // Only audit a successful detail view.
    if (group) {
      await auditService.record({
        actorId: actor.id,
        action: AUDIT_ACTIONS.GROUP_VIEWED,
        targetType: "group",
        targetId: groupId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
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

    // Only audit when the group exists.
    if (result.found) {
      await auditService.record({
        actorId: actor.id,
        action: AUDIT_ACTIONS.GROUP_MEMBERS_VIEWED,
        targetType: "group",
        targetId: groupId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return result;
  },
};
