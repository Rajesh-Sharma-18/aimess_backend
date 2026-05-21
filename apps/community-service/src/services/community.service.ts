import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";

import { communityRepository } from "../repositories/community.repository.js";
import { communityCache } from "../lib/community-cache.js";
import { normalizeHandle, normalizeName } from "../lib/community-slug.util.js";
import {
  CommunityMemberRole,
  CommunityMemberStatus,
  Prisma,
  type Community,
  type CommunityType,
} from "../generated/prisma/index.js";
import type {
  CommunityAvailability,
  CommunityCategoryData,
  CommunityData,
  CommunityListItem,
  MyCommunitiesResult,
} from "../types/community.types.js";
import { communityImageService } from "./community-image.service.js";
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
      await communityRepository.createMember({
        communityId: community.id,
        userId: creatorId,
        role: CommunityMemberRole.ADMIN,
        status: CommunityMemberStatus.ACTIVE,
      });

      let insertedMembers = 0;
      if (memberIds.length > 0) {
        const result = await communityRepository.createManyMembers(
          community.id,
          memberIds
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
    if (
      !membership ||
      membership.status !== CommunityMemberStatus.ACTIVE ||
      membership.role !== CommunityMemberRole.ADMIN
    ) {
      throw new ForbiddenError("COMMUNITY_FORBIDDEN");
    }

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

    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

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
};
