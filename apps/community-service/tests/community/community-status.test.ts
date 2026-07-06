/**
 * Suite: community-status (owner CLOSE / REOPEN lifecycle)
 *
 * Exercises communityService.closeCommunity / reopenCommunity:
 *   - close: status→CLOSED ONLY — members/roles/memberCount are never touched;
 *     realtime `community:closed` to the room AND each active member's user
 *     room, chat-room suspend, push fan-out.
 *   - reopen: ownership (adminId) authz, status→ACTIVE ONLY — no member is
 *     created/reactivated and memberCount is untouched (it was never zeroed);
 *     realtime `community:reopened` to the room AND every active member's user
 *     room (roster is intact), chat-room unsuspend.
 *   - authz: non-admin can't close; non-owner can't reopen.
 *
 * Real communityService with only I/O boundaries mocked (mirrors
 * community-realtime-events.test.ts). The *-Safe RabbitMQ publishers come from
 * the global setup mocks (tests/setup/global-mocks.ts).
 */

jest.mock("@aimess/redis", () => ({
  publishCommunityRoomEvent: jest.fn(async () => 1),
  publishChatUserEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findActiveMemberIds: jest.fn(),
    updateCommunity: jest.fn(),
    // Kept as mocks (never called by close/reopen) so tests can assert they
    // stay untouched — the whole point of this refactor is that member/role
    // data survives a close/reopen cycle unchanged.
    markAllActiveMembersLeft: jest.fn(),
    setMemberCount: jest.fn(),
    reactivateAdminMember: jest.fn(),
    createMember: jest.fn(),
    createAuditLog: jest.fn(),
    findMuteByUserAndCommunity: jest.fn(async () => null),
  },
}));

jest.mock("../../src/lib/user-client.js", () => ({
  fetchUserSnapshots: jest.fn(
    async () =>
      new Map([
        [
          "11111111-1111-4111-8111-111111111111",
          {
            username: "owner",
            displayName: "Owner",
            avatarObjectKey: null,
          },
        ],
      ])
  ),
  fetchAcceptedFriendIds: jest.fn(async () => new Set()),
}));

jest.mock("../../src/services/community-image.service.js", () => ({
  communityImageService: {
    resolveViewUrlForClient: jest.fn(async () => null),
    resolveObjectKeyForCommunity: jest.fn(async () => null),
  },
}));

jest.mock("../../src/services/member-avatar.service.js", () => ({
  memberAvatarService: {
    resolveViewUrl: jest.fn(async () => ({ url: null, expiresIn: null })),
  },
}));

import { ForbiddenError } from "@aimess/errors";
import { publishCommunityRoomEvent, publishChatUserEvent } from "@aimess/redis";

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import {
  publishCommunityClosedSafe,
  publishCommunityReopenedSafe,
} from "../../src/messaging/publish-community.js";
import { publishCommunityStatusChangedForChatSafe } from "../../src/messaging/publish-community-chat.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubRoom = publishCommunityRoomEvent as jest.Mock;
const pubUser = publishChatUserEvent as jest.Mock;
const pubClosed = publishCommunityClosedSafe as jest.Mock;
const pubReopened = publishCommunityReopenedSafe as jest.Mock;
const pubChatStatus = publishCommunityStatusChangedForChatSafe as jest.Mock;

const CID = "c".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111";
const M1 = "22222222-2222-4222-8222-222222222222";
const M2 = "33333333-3333-4333-8333-333333333333";
const NON_ADMIN = "88888888-8888-4888-8888-888888888888";

const activeCommunity = {
  id: CID,
  name: "Test Community",
  handle: "test",
  description: null,
  type: "PUBLIC",
  adminId: ADMIN,
  creatorId: ADMIN,
  memberCount: 3,
  avatarUrl: null,
  coverUrl: null,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  category: { id: "cat", name: "General" },
  lastActivityAt: new Date("2026-06-01T00:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.findMuteByUserAndCommunity.mockResolvedValue(null);
});

describe("closeCommunity", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue({ ...activeCommunity });
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findActiveMemberIds.mockResolvedValue([ADMIN, M1, M2]);
    repo.updateCommunity.mockResolvedValue({
      ...activeCommunity,
      status: "CLOSED",
    });
    repo.markAllActiveMembersLeft.mockResolvedValue({ count: 3 });
    repo.setMemberCount.mockResolvedValue({});
    repo.createAuditLog.mockResolvedValue({});
  });

  it("sets status=CLOSED via a pure status flip — members/roles/memberCount are untouched", async () => {
    await communityService.closeCommunity(CID, ADMIN, "season over");

    expect(repo.updateCommunity).toHaveBeenCalledWith(
      CID,
      expect.objectContaining({ status: "CLOSED", statusClosedBy: ADMIN })
    );
    expect(repo.markAllActiveMembersLeft).not.toHaveBeenCalled();
    expect(repo.setMemberCount).not.toHaveBeenCalled();
  });

  it("broadcasts community:closed to the room AND to each active member's user room", async () => {
    await communityService.closeCommunity(CID, ADMIN, "season over");

    expect(pubRoom).toHaveBeenCalledWith(
      expect.anything(),
      CID,
      "community:closed",
      expect.objectContaining({
        communityId: CID,
        status: "CLOSED",
        reason: "season over",
      })
    );
    // One user-room emit per active member (ADMIN, M1, M2) — nobody evicted.
    const userTargets = pubUser.mock.calls
      .filter((c) => c[2] === "community:closed")
      .map((c) => c[1]);
    expect(userTargets.sort()).toEqual([ADMIN, M1, M2].sort());
  });

  it("suspends the chat room and pushes to every active member", async () => {
    await communityService.closeCommunity(CID, ADMIN, null);

    expect(pubChatStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: CID,
        communityStatus: "SUSPENDED",
      })
    );
    expect(pubClosed).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: CID, memberIds: [ADMIN, M1, M2] })
    );
  });

  it("is idempotent — re-closing an already CLOSED community is a no-op", async () => {
    repo.findById.mockResolvedValue({ ...activeCommunity, status: "CLOSED" });

    await communityService.closeCommunity(CID, ADMIN, null);

    expect(repo.updateCommunity).not.toHaveBeenCalled();
    expect(pubRoom).not.toHaveBeenCalled();
  });

  it("rejects a non-admin caller", async () => {
    repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });

    await expect(
      communityService.closeCommunity(CID, NON_ADMIN, null)
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.updateCommunity).not.toHaveBeenCalled();
  });
});

describe("reopenCommunity", () => {
  // memberCount stays at its pre-close value (3) — it was never zeroed, since
  // nobody was evicted on close.
  const closedCommunity = {
    ...activeCommunity,
    status: "CLOSED",
  };

  beforeEach(() => {
    repo.findById.mockResolvedValue({ ...closedCommunity });
    repo.findActiveMemberIds.mockResolvedValue([ADMIN, M1, M2]);
    repo.updateCommunity.mockResolvedValue({
      ...activeCommunity,
      status: "ACTIVE",
    });
    repo.createAuditLog.mockResolvedValue({});
  });

  it("sets status=ACTIVE via a pure status flip — no member is created/reactivated", async () => {
    const result = await communityService.reopenCommunity(CID, ADMIN);

    expect(repo.updateCommunity).toHaveBeenCalledWith(
      CID,
      expect.objectContaining({ status: "ACTIVE", statusClosedAt: null })
    );
    expect(repo.reactivateAdminMember).not.toHaveBeenCalled();
    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.setMemberCount).not.toHaveBeenCalled();
    expect(result.status).toBe("ACTIVE");
  });

  it("broadcasts community:reopened and unsuspends the chat room", async () => {
    await communityService.reopenCommunity(CID, ADMIN);

    expect(pubRoom).toHaveBeenCalledWith(
      expect.anything(),
      CID,
      "community:reopened",
      expect.objectContaining({ communityId: CID, status: "ACTIVE" })
    );
    expect(pubChatStatus).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: CID, communityStatus: "ACTIVE" })
    );
  });

  it("fans out community:reopened to every active member's user:<id> channel (roster is intact)", async () => {
    await communityService.reopenCommunity(CID, ADMIN);

    // Nobody was evicted on close, so every member — not just the owner —
    // gets the reopen notification.
    const userTargets = pubUser.mock.calls
      .filter((c) => c[2] === "community:reopened")
      .map((c) => c[1]);
    expect(userTargets.sort()).toEqual([ADMIN, M1, M2].sort());
  });

  it("pushes reopened notification to the full active roster", async () => {
    await communityService.reopenCommunity(CID, ADMIN);

    expect(pubReopened).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: CID,
        memberIds: [ADMIN, M1, M2],
      })
    );
  });

  it("authorizes by adminId, NOT active membership — rejects a non-owner", async () => {
    await expect(
      communityService.reopenCommunity(CID, NON_ADMIN)
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.updateCommunity).not.toHaveBeenCalled();
  });

  it("is idempotent — reopening an already-open community does not re-write", async () => {
    repo.findById.mockResolvedValue({ ...activeCommunity, status: "ACTIVE" });
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });

    const result = await communityService.reopenCommunity(CID, ADMIN);

    expect(repo.updateCommunity).not.toHaveBeenCalled();
    expect(result.status).toBe("ACTIVE");
  });
});
