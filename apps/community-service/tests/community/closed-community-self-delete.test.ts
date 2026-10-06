/**
 * Suite: Delete Conversation on a CLOSED community.
 *
 * A community closed by its owner or suspended by Super Admin keeps every
 * membership ACTIVE, so it stays in each member's list. Removing it from
 * there — `POST /communities/leave/bulk` (the list row), `DELETE /communities`
 * and `DELETE /communities/:id/me` — is a per-user dismiss for every role,
 * the admin included: no Admin-transfer rule, no leave, no change to the
 * community or anyone else. An open community keeps the old rules.
 */

jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  publishCommunityRoomEvent: jest.fn(async () => 1),
  publishChatUserEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMemberByUserId: jest.fn(),
    findCommunitiesByIds: jest.fn(),
    findActiveMembershipsWithRoleByCommunityIds: jest.fn(),
    setMemberDismissed: jest.fn(),
    updateMemberStatus: jest.fn(),
    markActiveMemberLeft: jest.fn(),
    countActiveMembers: jest.fn(),
    setMemberCount: jest.fn(),
    createAuditLog: jest.fn(),
    deleteCommunityHard: jest.fn(),
  },
}));

import { publishChatUserEvent } from "@aimess/redis";
import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { getChatClient } from "../../src/grpc/chat.client.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubUserEvent = publishChatUserEvent as jest.Mock;

const CID = "c".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111";

const suspended = {
  id: CID,
  status: "ACTIVE",
  moderationStatus: "SUSPENDED",
};
const ownerClosed = { id: CID, status: "CLOSED", moderationStatus: "ACTIVE" };
const open = { id: CID, status: "ACTIVE", moderationStatus: "ACTIVE" };

const member = (role: "ADMIN" | "MODERATOR" | "MEMBER", extra = {}) => ({
  userId: ADMIN,
  role,
  status: "ACTIVE",
  dismissedAt: null,
  unbannedAt: null,
  ...extra,
});

function expectNoMembershipChange() {
  expect(repo.updateMemberStatus).not.toHaveBeenCalled();
  expect(repo.markActiveMemberLeft).not.toHaveBeenCalled();
  expect(repo.setMemberCount).not.toHaveBeenCalled();
  expect(repo.createAuditLog).not.toHaveBeenCalled();
  expect(repo.deleteCommunityHard).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  repo.findCommunitiesByIds.mockResolvedValue([{ id: CID }]);
  repo.setMemberDismissed.mockResolvedValue({ id: "m1" });
});

describe.each([
  ["Super Admin suspended", suspended],
  ["owner closed", ownerClosed],
])("%s community", (_label, closed) => {
  it.each(["ADMIN", "MODERATOR", "MEMBER"] as const)(
    "list row delete as former %s → dismissed for the caller only",
    async (role) => {
      repo.findById.mockResolvedValue(closed);
      repo.findActiveMembershipsWithRoleByCommunityIds.mockResolvedValue([
        { communityId: CID, ...member(role) },
      ]);
      repo.findMemberByUserId.mockResolvedValue(member(role));

      const result = await communityService.bulkLeaveCommunities(ADMIN, [
        CID,
      ]);

      expect(result.results).toEqual([{ communityId: CID, status: "LEFT" }]);
      expect(repo.setMemberDismissed).toHaveBeenCalledWith(CID, ADMIN);
      expectNoMembershipChange();
      // The caller's other devices drop the row; nobody else is told anything.
      expect(pubUserEvent).toHaveBeenCalledTimes(1);
      expect(pubUserEvent).toHaveBeenCalledWith(
        expect.anything(),
        ADMIN,
        "community:membership:removed",
        expect.objectContaining({ communityId: CID, reason: "dismissed" })
      );
      expect(getChatClient().bulkMarkCommunityRead).toHaveBeenCalledWith({
        userId: ADMIN,
        communityIds: [CID],
      });
    }
  );

  it("DELETE /:id/me as former admin → success, dismissed", async () => {
    repo.findById.mockResolvedValue(closed);
    repo.findMemberByUserId.mockResolvedValue(member("ADMIN"));

    await expect(
      communityService.deleteCommunityForSelf(CID, ADMIN)
    ).resolves.toBeUndefined();
    expect(repo.setMemberDismissed).toHaveBeenCalledWith(CID, ADMIN);
    expectNoMembershipChange();
  });

  it("repeat delete → idempotent success, nothing written", async () => {
    repo.findById.mockResolvedValue(closed);
    repo.findActiveMembershipsWithRoleByCommunityIds.mockResolvedValue([
      { communityId: CID, ...member("ADMIN") },
    ]);
    repo.findMemberByUserId.mockResolvedValue(
      member("ADMIN", { dismissedAt: new Date() })
    );

    const result = await communityService.bulkLeaveCommunities(ADMIN, [CID]);

    expect(result.results).toEqual([{ communityId: CID, status: "LEFT" }]);
    expect(repo.setMemberDismissed).not.toHaveBeenCalled();
    expect(pubUserEvent).not.toHaveBeenCalled();
    expectNoMembershipChange();
  });

  it("unrelated user → refused, nothing written", async () => {
    repo.findById.mockResolvedValue(closed);
    repo.findActiveMembershipsWithRoleByCommunityIds.mockResolvedValue([]);
    repo.findMemberByUserId.mockResolvedValue(null);

    const result = await communityService.bulkLeaveCommunities(ADMIN, [CID]);

    expect(result.results).toEqual([
      { communityId: CID, status: "FAILED", errorCode: "NOT_MEMBER" },
    ]);
    expect(repo.setMemberDismissed).not.toHaveBeenCalled();
    expectNoMembershipChange();
  });
});

describe("open community (regression)", () => {
  it("admin with other members is still refused", async () => {
    repo.findById.mockResolvedValue(open);
    repo.findMemberByUserId.mockResolvedValue(member("ADMIN"));

    await expect(
      communityService.deleteCommunityForSelf(CID, ADMIN)
    ).rejects.toMatchObject({ messageKey: "COMMUNITY_OWNER_CANNOT_DELETE" });
    expect(repo.setMemberDismissed).not.toHaveBeenCalled();
  });
});
