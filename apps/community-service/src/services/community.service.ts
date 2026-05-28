import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";

import { communityRepository } from "../repositories/community.repository.js";
import { communityCache } from "../lib/community-cache.js";
import {
  assertCommunityRole,
  COMMUNITY_ROLE_RANK,
} from "../lib/community-authz.js";
import { paginateByCursor } from "../lib/cursor-pagination.js";
import { normalizeHandle, normalizeName } from "../lib/community-slug.util.js";
import {
  CommunityMemberRole,
  CommunityMemberStatus,
  Prisma,
  type Community,
  type CommunityType,
} from "../generated/prisma/index.js";
import type {
  AddMembersResult,
  CommunityAuditAction,
  CommunityAuditLogData,
  CommunityAuditLogsResult,
  CommunityAvailability,
  CommunityCategoryData,
  CommunityData,
  CommunityListItem,
  CommunityMemberData,
  CommunityMembersResult,
  MyCommunitiesResult,
} from "../types/community.types.js";
import { communityImageService } from "./community-image.service.js";
import { memberAvatarService } from "./member-avatar.service.js";
import { fetchUserSnapshots } from "../lib/user-client.js";
import type {
  CreateCommunityInput,
  UpdateCommunityInput,
} from "../api/validators/community.validator.js";

type CommunityWithCategory = Community & {
  category: { id: string; name: string };
};

function isUniqueConstraintError(
  error: unknown
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** Map a P2002 to the right conflict (name vs handle) using the meta target. */
function uniqueViolationToConflict(
  error: Prisma.PrismaClientKnownRequestError
): ConflictError {
  const target = error.meta?.target;
  const text = Array.isArray(target)
    ? target.join(",")
    : typeof target === "string"
      ? target
      : "";
  if (text.toLowerCase().includes("handle")) {
    return new ConflictError("COMMUNITY_HANDLE_TAKEN");
  }
  return new ConflictError("COMMUNITY_NAME_TAKEN");
}

async function toCommunityData(
  community: CommunityWithCategory,
  myRole: CommunityMemberRole | null
): Promise<CommunityData> {
  const avatarView = await communityImageService.resolveViewUrlForClient(
    community.avatarUrl
  );

  return {
    id: community.id,
    name: community.name,
    handle: community.handle,
    description: community.description,
    type: community.type,
    category: { id: community.category.id, name: community.category.name },
    creatorId: community.creatorId,
    adminId: community.adminId,
    memberCount: community.memberCount,
    avatarUrl: avatarView?.url ?? null,
    avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
    coverUrl: null,
    coverUrlExpiresIn: null,
    myRole,
    createdAt: community.createdAt.toISOString(),
    updatedAt: community.updatedAt.toISOString(),
  };
}

/** Map a community member row to the API DTO (joinedAt → ISO string). */
async function toMemberData(member: {
  userId: string;
  role: CommunityMemberRole;
  status: CommunityMemberStatus;
  joinedAt: Date;
  snapshotUsername: string;
  snapshotDisplayName: string;
  snapshotAvatarKey: string | null;
}): Promise<CommunityMemberData> {
  const avatarView = await memberAvatarService.resolveViewUrl(
    member.snapshotAvatarKey
  );

  return {
    userId: member.userId,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt.toISOString(),
    snapshotUsername: member.snapshotUsername,
    snapshotDisplayName: member.snapshotDisplayName,
    snapshotAvatarUrl: avatarView?.url ?? null,
    snapshotAvatarUrlExpiresIn: avatarView?.expiresIn ?? null,
  };
}

/** Map an audit-log row to the API DTO (createdAt → ISO string). */
function toAuditLogData(log: {
  id: string;
  communityId: string;
  actorId: string;
  action: string;
  targetUserId: string | null;
  reason: string | null;
  metadata: unknown;
  createdAt: Date;
}): CommunityAuditLogData {
  return {
    id: log.id,
    communityId: log.communityId,
    actorId: log.actorId,
    action: log.action as CommunityAuditAction,
    targetUserId: log.targetUserId,
    reason: log.reason,
    metadata: log.metadata ?? null,
    createdAt: log.createdAt.toISOString(),
  };
}

export const communityService = {
  async listCategories(): Promise<CommunityCategoryData[]> {
    return communityRepository.listActiveCategories();
  },

  async checkNameAvailability(
    name: string,
    excludeId?: string
  ): Promise<CommunityAvailability> {
    const canonical = normalizeName(name);

    const cached = await communityCache.getNameAvailability(
      canonical,
      excludeId
    );
    if (cached !== null) {
      return { name: canonical, available: cached.available };
    }

    const existing = await communityRepository.findByName(canonical);
    const available = !existing || existing.id === excludeId;

    await communityCache.setNameAvailability(canonical, excludeId, available);
    return { name: canonical, available };
  },

  async checkHandleAvailability(
    handle: string,
    excludeId?: string
  ): Promise<CommunityAvailability> {
    const canonical = normalizeHandle(handle);

    const cached = await communityCache.getHandleAvailability(
      canonical,
      excludeId
    );
    if (cached !== null) {
      return { handle: canonical, available: cached.available };
    }

    const existing = await communityRepository.findByHandle(canonical);
    const available = !existing || existing.id === excludeId;

    await communityCache.setHandleAvailability(canonical, excludeId, available);
    return { handle: canonical, available };
  },

  async getById(id: string, callerId: string): Promise<CommunityData> {
    const community = await communityRepository.findById(id);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(id, callerId);
    // Only an ACTIVE membership confers a role; BANNED/LEFT members are treated
    // as non-members (myRole = null).
    const myRole =
      membership && membership.status === CommunityMemberStatus.ACTIVE
        ? membership.role
        : null;
    return toCommunityData(community, myRole);
  },

  async create(
    creatorId: string,
    input: CreateCommunityInput
  ): Promise<CommunityData> {
    const name = normalizeName(input.name);
    const handle = normalizeHandle(input.handle);

    // Category must exist and be active.
    const category = await communityRepository.findActiveCategoryById(
      input.categoryId
    );
    if (!category) {
      throw new BadRequestError("COMMUNITY_CATEGORY_INVALID");
    }

    // Validate the optional avatar key (ownership + HEAD) before any write.
    const avatarUrl = input.avatarObjectKey
      ? await communityImageService.resolveObjectKeyForCommunity(
          creatorId,
          input.avatarObjectKey
        )
      : null;

    // Member list excludes the creator (added as ADMIN below).
    const memberIds = input.memberIds.filter((id) => id !== creatorId);

    // NO $transaction: local Mongo is a standalone node (no replica set), so
    // Prisma interactive transactions fail at runtime. Use sequential writes +
    // createMany, with best-effort compensating cleanup if a later step fails.
    let community: CommunityWithCategory;
    try {
      community = await communityRepository.createCommunity({
        name,
        handle,
        description: input.description ?? null,
        type: input.type as CommunityType,
        categoryId: input.categoryId,
        creatorId,
        adminId: creatorId,
        avatarUrl,
        coverUrl: null,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw uniqueViolationToConflict(error);
      }
      throw error;
    }

    try {
      const allMemberIds = [creatorId, ...memberIds];
      const snapshotMap = await fetchUserSnapshots(allMemberIds);
      const creatorSnap = snapshotMap.get(creatorId)!;

      await communityRepository.createMember({
        communityId: community.id,
        userId: creatorId,
        role: CommunityMemberRole.ADMIN,
        status: CommunityMemberStatus.ACTIVE,
        snapshotUsername: creatorSnap.username,
        snapshotDisplayName: creatorSnap.displayName,
        snapshotAvatarKey: creatorSnap.avatarObjectKey,
      });

      let insertedMembers = 0;
      if (memberIds.length > 0) {
        const memberObjects = memberIds.map((userId) => {
          const snap = snapshotMap.get(userId)!;
          return {
            userId,
            role: CommunityMemberRole.MEMBER,
            status: CommunityMemberStatus.ACTIVE,
            snapshotUsername: snap.username,
            snapshotDisplayName: snap.displayName,
            snapshotAvatarKey: snap.avatarObjectKey,
          };
        });
        const result = await communityRepository.createManyMembers(
          community.id,
          memberObjects
        );
        insertedMembers = result.count;
      }

      const memberCount = 1 + insertedMembers;
      if (memberCount !== community.memberCount) {
        await communityRepository.setMemberCount(community.id, memberCount);
        community.memberCount = memberCount;
      }
    } catch (error) {
      // Compensating cleanup — roll back the partial create by hand.
      await this.cleanupFailedCreate(community.id);
      throw error;
    }

    await communityCache.invalidateNameAvailability(name);
    await communityCache.invalidateHandleAvailability(handle);

    return toCommunityData(community, CommunityMemberRole.ADMIN);
  },

  /** Best-effort rollback of a community whose member writes failed. */
  async cleanupFailedCreate(communityId: string): Promise<void> {
    try {
      await communityRepository.deleteMembersForCommunity(communityId);
      await communityRepository.deleteCommunityHard(communityId);
    } catch (cleanupError) {
      logger.error(
        `Failed to clean up partial community ${communityId} after create error`
      );
      logger.error(cleanupError);
    }
  },

  /**
   * Append a moderation audit entry. Fire-safe: an audit-write failure is logged
   * but never propagated, so it can never fail the moderation action itself.
   */
  async recordAudit(entry: {
    communityId: string;
    actorId: string;
    action: CommunityAuditAction;
    targetUserId?: string;
    reason?: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    try {
      await communityRepository.createAuditLog(entry);
    } catch (auditError) {
      logger.error(
        `Failed to record audit log: community=${entry.communityId} action=${entry.action} actor=${entry.actorId}`
      );
      logger.error(auditError);
    }
  },

  async update(
    communityId: string,
    callerId: string,
    input: UpdateCommunityInput
  ): Promise<CommunityData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.ADMIN);

    const data: Prisma.CommunityUpdateInput = {};
    let nextName: string | undefined;
    let nextHandle: string | undefined;
    const previousName = community.name;
    const previousHandle = community.handle;

    if (input.name !== undefined) {
      nextName = normalizeName(input.name);
      const { available } = await this.checkNameAvailability(
        nextName,
        communityId
      );
      if (!available) {
        throw new ConflictError("COMMUNITY_NAME_TAKEN");
      }
      data.name = nextName;
    }

    if (input.handle !== undefined) {
      nextHandle = normalizeHandle(input.handle);
      const { available } = await this.checkHandleAvailability(
        nextHandle,
        communityId
      );
      if (!available) {
        throw new ConflictError("COMMUNITY_HANDLE_TAKEN");
      }
      data.handle = nextHandle;
    }

    if (input.type !== undefined) {
      data.type = input.type as CommunityType;
    }

    if (input.categoryId !== undefined) {
      const category = await communityRepository.findActiveCategoryById(
        input.categoryId
      );
      if (!category) {
        throw new BadRequestError("COMMUNITY_CATEGORY_INVALID");
      }
      data.category = { connect: { id: input.categoryId } };
    }

    if (input.description !== undefined) {
      data.description = input.description;
    }

    if (input.avatarObjectKey !== undefined) {
      data.avatarUrl =
        input.avatarObjectKey === null
          ? null
          : await communityImageService.resolveObjectKeyForCommunity(
              callerId,
              input.avatarObjectKey
            );
    }

    let updated: CommunityWithCategory;
    try {
      updated = await communityRepository.updateCommunity(communityId, data);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw uniqueViolationToConflict(error);
      }
      throw error;
    }

    if (nextName && nextName !== previousName) {
      await communityCache.invalidateNameAvailability(previousName);
      await communityCache.invalidateNameAvailability(nextName);
    }
    if (nextHandle && nextHandle !== previousHandle) {
      await communityCache.invalidateHandleAvailability(previousHandle);
      await communityCache.invalidateHandleAvailability(nextHandle);
    }

    return toCommunityData(updated, membership.role);
  },

  async listMine(
    userId: string,
    params: { limit: number; cursor?: string }
  ): Promise<MyCommunitiesResult> {
    const rows = await communityRepository.listMyMemberships({
      userId,
      limit: params.limit,
      cursor: params.cursor,
    });

    const { page, nextCursor } = paginateByCursor(rows, params.limit);

    const communities: CommunityListItem[] = await Promise.all(
      page.map(async (row) => {
        const avatarView = await communityImageService.resolveViewUrlForClient(
          row.community.avatarUrl
        );
        return {
          id: row.community.id,
          name: row.community.name,
          handle: row.community.handle,
          type: row.community.type,
          memberCount: row.community.memberCount,
          avatarUrl: avatarView?.url ?? null,
          avatarUrlExpiresIn: avatarView?.expiresIn ?? null,
          myRole: row.role,
        };
      })
    );

    return { communities, nextCursor };
  },

  async listMembers(
    communityId: string,
    callerId: string,
    params: { limit: number; cursor?: string; status?: CommunityMemberStatus }
  ): Promise<CommunityMembersResult> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Any ACTIVE member (regardless of role) may view the roster.
    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MEMBER);

    const status = params.status ?? CommunityMemberStatus.ACTIVE;
    const rows = await communityRepository.listMembers({
      communityId,
      status,
      limit: params.limit,
      cursor: params.cursor,
    });

    const { page, nextCursor } = paginateByCursor(rows, params.limit);

    const members: CommunityMemberData[] = await Promise.all(
      page.map(toMemberData)
    );

    return { members, nextCursor };
  },

  async updateMemberRole(
    communityId: string,
    callerId: string,
    targetUserId: string,
    role: CommunityMemberRole
  ): Promise<CommunityMemberData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Only an ACTIVE admin may change member roles.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.ADMIN);

    if (callerId === targetUserId) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_SELF");
    }

    const target = await communityRepository.findMemberByUserId(
      communityId,
      targetUserId
    );
    if (!target || target.status !== CommunityMemberStatus.ACTIVE) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    // The community admin's role is immutable here.
    if (
      community.adminId === targetUserId ||
      target.role === CommunityMemberRole.ADMIN
    ) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN");
    }

    // Idempotent: setting the role it already has is a no-op.
    if (target.role === role) {
      return toMemberData(target);
    }

    // Single-document update — no $transaction (standalone Mongo).
    const updated = await communityRepository.updateMemberRole(
      communityId,
      targetUserId,
      role
    );

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action:
        role === CommunityMemberRole.MODERATOR
          ? "MEMBER_PROMOTED"
          : "MEMBER_DEMOTED",
      targetUserId,
      metadata: { role },
    });

    return toMemberData(updated);
  },

  async kickMember(
    communityId: string,
    callerId: string,
    targetUserId: string,
    reason?: string
  ): Promise<CommunityMemberData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // A MODERATOR or ADMIN may kick members.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.MODERATOR);

    if (callerId === targetUserId) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_SELF");
    }

    const target = await communityRepository.findMemberByUserId(
      communityId,
      targetUserId
    );
    if (!target || target.status !== CommunityMemberStatus.ACTIVE) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    // The community admin can never be kicked.
    if (
      community.adminId === targetUserId ||
      target.role === CommunityMemberRole.ADMIN
    ) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN");
    }

    // Strict rank rule: the caller must outrank the target, so a MODERATOR
    // cannot kick a peer MODERATOR (only ADMIN can).
    if (
      COMMUNITY_ROLE_RANK[callerMembership.role] <=
      COMMUNITY_ROLE_RANK[target.role]
    ) {
      throw new ForbiddenError("COMMUNITY_FORBIDDEN");
    }

    // Single-document update + recompute of memberCount — no $transaction
    // (standalone Mongo). Recounting ACTIVE members is robust against drift.
    const updated = await communityRepository.updateMemberStatus(
      communityId,
      targetUserId,
      CommunityMemberStatus.LEFT
    );

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_KICKED",
      targetUserId,
      reason,
    });

    // `reason` is operator-supplied, not PII.
    logger.info(
      `Community member kicked: community=${communityId} by=${callerId} target=${targetUserId} reason=${reason ?? "(none)"}`
    );

    return toMemberData(updated);
  },

  async banMember(
    communityId: string,
    callerId: string,
    targetUserId: string,
    reason?: string
  ): Promise<CommunityMemberData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Only an ACTIVE admin may ban members.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.ADMIN);

    if (callerId === targetUserId) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_SELF");
    }

    const target = await communityRepository.findMemberByUserId(
      communityId,
      targetUserId
    );
    if (!target) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    // The community admin can never be banned.
    if (
      community.adminId === targetUserId ||
      target.role === CommunityMemberRole.ADMIN
    ) {
      throw new BadRequestError("COMMUNITY_MEMBER_CANNOT_MODIFY_ADMIN");
    }

    // Idempotent: an already-banned member is returned unchanged (no write).
    if (target.status === CommunityMemberStatus.BANNED) {
      return toMemberData(target);
    }

    // Single-document update + recompute of memberCount — no $transaction
    // (standalone Mongo). Recounting ACTIVE members is robust against drift.
    const updated = await communityRepository.updateMemberStatus(
      communityId,
      targetUserId,
      CommunityMemberStatus.BANNED
    );

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_BANNED",
      targetUserId,
      reason,
    });

    // `reason` is operator-supplied, not PII.
    logger.info(
      `Community member banned: community=${communityId} by=${callerId} target=${targetUserId} reason=${reason ?? "(none)"}`
    );

    return toMemberData(updated);
  },

  async addMembers(
    communityId: string,
    callerId: string,
    userIds: string[]
  ): Promise<AddMembersResult> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // A MODERATOR or ADMIN may add members.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.MODERATOR);

    // One read of all existing rows for the requested ids (incl. joinedAt),
    // then partition by status: ACTIVE → skip, BANNED → skip, LEFT →
    // reactivate, none → create.
    const existing = await communityRepository.findMembersByUserIds(
      communityId,
      userIds
    );
    const existingByUserId = new Map(
      existing.map((member) => [member.userId, member])
    );

    const skipped: AddMembersResult["skipped"] = [];
    // Reactivated members keep their existing row (incl. joinedAt) in hand, so
    // we can build their DTO without a re-read after the bulk update.
    const toReactivate: { userId: string; joinedAt: Date }[] = [];
    const toCreate: string[] = [];

    for (const userId of userIds) {
      const member = existingByUserId.get(userId);
      if (!member) {
        toCreate.push(userId);
      } else if (member.status === CommunityMemberStatus.ACTIVE) {
        skipped.push({ userId, reason: "ALREADY_MEMBER" });
      } else if (member.status === CommunityMemberStatus.BANNED) {
        skipped.push({ userId, reason: "BANNED" });
      } else {
        // LEFT (or any other inactive non-banned state) → reactivate.
        toReactivate.push({ userId, joinedAt: member.joinedAt });
      }
    }

    // Sequential single-collection writes — no $transaction (standalone Mongo).
    let added: CommunityMemberData[] = [];

    if (toReactivate.length > 0 || toCreate.length > 0) {
      const snapshotIds = [...toReactivate.map((m) => m.userId), ...toCreate];
      const snapshotMap = await fetchUserSnapshots(snapshotIds);

      if (toReactivate.length > 0) {
        for (const m of toReactivate) {
          const snap = snapshotMap.get(m.userId)!;
          await communityRepository.reactivateMemberWithSnapshot(
            communityId,
            m.userId,
            {
              snapshotUsername: snap.username,
              snapshotDisplayName: snap.displayName,
              snapshotAvatarKey: snap.avatarObjectKey,
            }
          );
        }
      }

      if (toCreate.length > 0) {
        const memberObjects = toCreate.map((userId) => {
          const snap = snapshotMap.get(userId)!;
          return {
            userId,
            role: CommunityMemberRole.MEMBER,
            status: CommunityMemberStatus.ACTIVE,
            snapshotUsername: snap.username,
            snapshotDisplayName: snap.displayName,
            snapshotAvatarKey: snap.avatarObjectKey,
          };
        });
        await communityRepository.createManyMembers(communityId, memberObjects);
      }

      const count = await communityRepository.countActiveMembers(communityId);
      await communityRepository.setMemberCount(communityId, count);

      const reactivated: CommunityMemberData[] = await Promise.all(
        toReactivate.map((m) => {
          const snap = snapshotMap.get(m.userId)!;
          return toMemberData({
            userId: m.userId,
            role: CommunityMemberRole.MEMBER,
            status: CommunityMemberStatus.ACTIVE,
            joinedAt: m.joinedAt,
            snapshotUsername: snap.username,
            snapshotDisplayName: snap.displayName,
            snapshotAvatarKey: snap.avatarObjectKey,
          });
        })
      );

      let created: CommunityMemberData[] = [];
      if (toCreate.length > 0) {
        const rows = await communityRepository.findMembersByUserIds(
          communityId,
          toCreate
        );
        created = await Promise.all(rows.map(toMemberData));
      }

      added = [...reactivated, ...created];
    }

    return { added, skipped };
  },

  async leaveCommunity(
    communityId: string,
    callerId: string
  ): Promise<CommunityMemberData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    const membership = await communityRepository.findMemberByUserId(
      communityId,
      callerId
    );
    if (!membership || membership.status !== CommunityMemberStatus.ACTIVE) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    const isAdmin =
      community.adminId === callerId ||
      membership.role === CommunityMemberRole.ADMIN;

    if (isAdmin) {
      // Admin leaving → auto-handover to the longest-tenured active moderator.
      const successor =
        await communityRepository.findOldestActiveModerator(communityId);

      // No moderator to hand over to — the admin cannot leave.
      if (!successor) {
        throw new BadRequestError("COMMUNITY_ADMIN_CANNOT_LEAVE");
      }

      // No $transaction (standalone Mongo), so ORDER MATTERS — the community
      // must always have a valid admin. Promote + transfer ownership first,
      // then demote the leaving admin and mark them LEFT.
      // 1. Promote the successor moderator to ADMIN.
      await communityRepository.updateMemberRole(
        communityId,
        successor.userId,
        CommunityMemberRole.ADMIN
      );
      // 2. Transfer community ownership.
      await communityRepository.setCommunityAdmin(
        communityId,
        successor.userId
      );
      // 3. Demote the leaving admin's row, then mark it LEFT.
      await communityRepository.updateMemberRole(
        communityId,
        callerId,
        CommunityMemberRole.MEMBER
      );
      const updated = await communityRepository.updateMemberStatus(
        communityId,
        callerId,
        CommunityMemberStatus.LEFT
      );
      // 4. Recompute memberCount (robust against drift).
      const count = await communityRepository.countActiveMembers(communityId);
      await communityRepository.setMemberCount(communityId, count);

      // 5. Audit the handover.
      await this.recordAudit({
        communityId,
        actorId: callerId,
        action: "ADMIN_TRANSFERRED",
        targetUserId: successor.userId,
        metadata: { reason: "admin_left_auto_handover" },
      });

      // 6. Structured log of the handover.
      logger.info(
        `Community admin auto-handover on leave: community=${communityId} from=${callerId} to=${successor.userId}`
      );

      // 7. Unchanged response contract — the leaving member DTO (status LEFT).
      return toMemberData(updated);
    }

    // Non-admin leave: status → LEFT + recompute. Single-document update +
    // recompute of memberCount — no $transaction.
    const updated = await communityRepository.updateMemberStatus(
      communityId,
      callerId,
      CommunityMemberStatus.LEFT
    );

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    return toMemberData(updated);
  },

  async unbanMember(
    communityId: string,
    callerId: string,
    targetUserId: string
  ): Promise<CommunityMemberData> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Only an ACTIVE admin may unban members.
    const callerMembership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(callerMembership, CommunityMemberRole.ADMIN);

    const target = await communityRepository.findMemberByUserId(
      communityId,
      targetUserId
    );
    if (!target) {
      throw new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND");
    }

    if (target.status !== CommunityMemberStatus.BANNED) {
      throw new BadRequestError("COMMUNITY_MEMBER_NOT_BANNED");
    }

    // Unban lifts the ban to LEFT — the user is not auto-re-added; an admin or
    // moderator must add them back (or they re-join) to become ACTIVE again.
    // Single-document update + recompute of memberCount — no $transaction.
    const updated = await communityRepository.updateMemberStatus(
      communityId,
      targetUserId,
      CommunityMemberStatus.LEFT
    );

    const count = await communityRepository.countActiveMembers(communityId);
    await communityRepository.setMemberCount(communityId, count);

    await this.recordAudit({
      communityId,
      actorId: callerId,
      action: "MEMBER_UNBANNED",
      targetUserId,
    });

    return toMemberData(updated);
  },

  async listAuditLogs(
    communityId: string,
    callerId: string,
    params: { limit: number; cursor?: string }
  ): Promise<CommunityAuditLogsResult> {
    const community = await communityRepository.findById(communityId);
    if (!community) {
      throw new NotFoundError("COMMUNITY_NOT_FOUND");
    }

    // Admins and moderators may view the moderation audit trail.
    const membership = await communityRepository.findMembership(
      communityId,
      callerId
    );
    assertCommunityRole(membership, CommunityMemberRole.MODERATOR);

    const rows = await communityRepository.listAuditLogs({
      communityId,
      limit: params.limit,
      cursor: params.cursor,
    });

    const { page, nextCursor } = paginateByCursor(rows, params.limit);

    const logs: CommunityAuditLogData[] = page.map(toAuditLogData);

    return { logs, nextCursor };
  },
};
