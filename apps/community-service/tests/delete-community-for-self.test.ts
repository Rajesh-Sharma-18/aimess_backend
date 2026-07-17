/**
 * deleteCommunityForSelf — remove a community from the CALLER's own account
 * only, reusing the same removeActiveMember core as leaveCommunity/banMember.
 *
 * Scenarios:
 *  1. Active member  → removed via the shared leave workflow; other members
 *     untouched (no repo call touches any other userId).
 *  2. Banned member  → restricted-access model: the community was still
 *     visible (read-only) in "my communities", so this call actually
 *     dismisses it (lifts to LEFT, clears the ban marker).
 *  2b. Kicked member (LEFT + removedAt set, not yet dismissed) → same
 *     dismissal, clearing just the removedAt/removedBy/removedReason marker.
 *  3. Admin/owner    → rejected with COMMUNITY_OWNER_CANNOT_DELETE, no writes.
 *  4. Validation     → community not found / never a member → 404-mapped errors.
 *  5. Regression     → leaveCommunity's own admin-restriction error uses the
 *     real MessageKey (COMMUNITY_ADMIN_CANNOT_LEAVE, not a typo'd string).
 */

import { BadRequestError, NotFoundError } from "@aimess/errors";

import { communityService } from "../src/services/community.service.js";
import { publishCommunityRoomEvent, publishChatUserEvent } from "@aimess/redis";
import { communityRepository } from "../src/repositories/community.repository.js";

const repo = communityRepository as Record<string, jest.Mock>;
const publishRoomEvent = publishCommunityRoomEvent as jest.Mock;
const publishUserEvent = publishChatUserEvent as jest.Mock;

const COMMUNITY_ID = "comm-test-1";
const CALLER_ID = "member-user-1";

const mockCommunity = {
  id: COMMUNITY_ID,
  name: "Test Community",
  handle: "test-community",
  type: "PUBLIC",
  status: "ACTIVE",
  moderationStatus: "ACTIVE",
  adminId: "someone-else",
  memberCount: 10,
  deletedAt: null,
  category: { id: "cat-1", name: "General" },
};

const mockActiveMembership = {
  id: "member-row-1",
  userId: CALLER_ID,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date(),
  snapshotUsername: "caller",
  snapshotDisplayName: "Caller",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("deleteCommunityForSelf — active member", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(mockCommunity);
    repo.findMemberByUserId.mockResolvedValue(mockActiveMembership);
    repo.updateMemberStatus.mockResolvedValue({
      ...mockActiveMembership,
      status: "LEFT",
    });
    repo.countActiveMembers.mockResolvedValue(9);
    repo.setMemberCount.mockResolvedValue(undefined);
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("resolves without throwing", async () => {
    await expect(
      communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID)
    ).resolves.toBeUndefined();
  });

  it("flips the caller's own membership to LEFT — no other userId is touched", async () => {
    await communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID);

    expect(repo.updateMemberStatus).toHaveBeenCalledTimes(1);
    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      COMMUNITY_ID,
      CALLER_ID,
      "LEFT"
    );
  });

  it("publishes the same removal events leaveCommunity uses (roster + personal channel)", async () => {
    await communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID);

    expect(publishRoomEvent).toHaveBeenCalledWith(
      expect.anything(),
      COMMUNITY_ID,
      "community:member:removed",
      expect.objectContaining({ communityId: COMMUNITY_ID, userId: CALLER_ID })
    );
    expect(publishUserEvent).toHaveBeenCalledWith(
      expect.anything(),
      CALLER_ID,
      "community:membership:removed",
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        membershipStatus: "REMOVED",
      })
    );
  });
});

describe("deleteCommunityForSelf — banned member (restricted-access model: community was still in their list, this dismisses it)", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(mockCommunity);
    repo.findMemberByUserId.mockResolvedValue({
      ...mockActiveMembership,
      status: "BANNED",
    });
    repo.updateMemberStatus.mockResolvedValue({
      ...mockActiveMembership,
      status: "LEFT",
    });
  });

  it("resolves without throwing", async () => {
    await expect(
      communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID)
    ).resolves.toBeUndefined();
  });

  it("lifts the row to LEFT, clearing the ban marker, and publishes the personal removal event so it drops from the caller's list", async () => {
    await communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID);

    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      COMMUNITY_ID,
      CALLER_ID,
      "LEFT",
      { bannedAt: null, bannedBy: null, banReason: null }
    );
    expect(publishUserEvent).toHaveBeenCalledWith(
      expect.anything(),
      CALLER_ID,
      "community:membership:removed",
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        membershipStatus: "REMOVED",
      })
    );
  });
});

describe("deleteCommunityForSelf — kicked member, not yet dismissed (LEFT + removedAt set)", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(mockCommunity);
    repo.findMemberByUserId.mockResolvedValue({
      ...mockActiveMembership,
      status: "LEFT",
      removedAt: new Date(),
    });
    repo.updateMemberStatus.mockResolvedValue({
      ...mockActiveMembership,
      status: "LEFT",
    });
  });

  it("clears the removedAt marker (self-dismiss) and publishes the personal removal event", async () => {
    await communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID);

    expect(repo.updateMemberStatus).toHaveBeenCalledWith(
      COMMUNITY_ID,
      CALLER_ID,
      "LEFT",
      undefined,
      undefined,
      { removedAt: null, removedBy: null, removedReason: null }
    );
    expect(publishUserEvent).toHaveBeenCalledWith(
      expect.anything(),
      CALLER_ID,
      "community:membership:removed",
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        membershipStatus: "REMOVED",
      })
    );
  });
});

describe("deleteCommunityForSelf — already left (genuine voluntary leave, idempotent re-delete)", () => {
  it("resolves without throwing and performs no mutation", async () => {
    repo.findById.mockResolvedValue(mockCommunity);
    repo.findMemberByUserId.mockResolvedValue({
      ...mockActiveMembership,
      status: "LEFT",
      removedAt: null,
    });

    await expect(
      communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID)
    ).resolves.toBeUndefined();
    expect(repo.updateMemberStatus).not.toHaveBeenCalled();
  });
});

describe("deleteCommunityForSelf — community admin/owner", () => {
  it("rejects with COMMUNITY_OWNER_CANNOT_DELETE and performs no mutation", async () => {
    repo.findById.mockResolvedValue(mockCommunity);
    repo.findMemberByUserId.mockResolvedValue({
      ...mockActiveMembership,
      role: "ADMIN",
    });

    await expect(
      communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID)
    ).rejects.toMatchObject({
      messageKey: "COMMUNITY_OWNER_CANNOT_DELETE",
    });
    expect(repo.updateMemberStatus).not.toHaveBeenCalled();
  });

  it("throws a BadRequestError instance", async () => {
    repo.findById.mockResolvedValue(mockCommunity);
    repo.findMemberByUserId.mockResolvedValue({
      ...mockActiveMembership,
      role: "ADMIN",
    });

    await expect(
      communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID)
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("deleteCommunityForSelf — validation", () => {
  it("community not found → NotFoundError(COMMUNITY_NOT_FOUND)", async () => {
    repo.findById.mockResolvedValue(null);
    repo.findMemberByUserId.mockResolvedValue(null);

    await expect(
      communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID)
    ).rejects.toMatchObject({ messageKey: "COMMUNITY_NOT_FOUND" });
  });

  it("caller was never a member → NotFoundError(COMMUNITY_MEMBER_NOT_FOUND)", async () => {
    repo.findById.mockResolvedValue(mockCommunity);
    repo.findMemberByUserId.mockResolvedValue(null);

    await expect(
      communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID)
    ).rejects.toMatchObject({ messageKey: "COMMUNITY_MEMBER_NOT_FOUND" });
    expect(repo.updateMemberStatus).not.toHaveBeenCalled();
  });

  it("throws a NotFoundError instance for a missing community", async () => {
    repo.findById.mockResolvedValue(null);

    await expect(
      communityService.deleteCommunityForSelf(COMMUNITY_ID, CALLER_ID)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("regression — leaveCommunity admin-restriction error", () => {
  it("throws BadRequestError with the real MessageKey (COMMUNITY_ADMIN_CANNOT_LEAVE)", async () => {
    repo.findById.mockResolvedValue({
      ...mockCommunity,
      adminId: CALLER_ID,
      memberCount: 5,
    });
    repo.findMemberByUserId.mockResolvedValue({
      ...mockActiveMembership,
      role: "ADMIN",
    });

    await expect(
      communityService.leaveCommunity(COMMUNITY_ID, CALLER_ID)
    ).rejects.toMatchObject({ messageKey: "COMMUNITY_ADMIN_CANNOT_LEAVE" });
  });
});
