/**
 * AIM-05 — `addMembers` must not insert a stranger into a community.
 *
 * The friend check had been commented out while every surrounding comment, and
 * the `NOT_FRIEND` value in the published `AddMembersResult` contract, still
 * described it as active. With it dead, a user could create a community
 * (becoming ADMIN, which satisfies the MODERATOR guard), harvest ids from
 * discovery or search, and POST up to 100 arbitrary ids: victims landed as
 * ACTIVE members, got a notification, saw the community in their sidebar, and
 * became reachable by broadcast — the exact contact the DM friend gate exists
 * to prevent.
 *
 * Pattern matches the sibling membership suites: the real `communityService`
 * with only the I/O boundary mocked by `tests/setup/global-mocks.ts`.
 */

import { communityRepository } from "../../src/repositories/community.repository.js";
import { communityService } from "../../src/services/community.service.js";
import {
  fetchAcceptedFriendIds,
  fetchUserSnapshots,
} from "../../src/lib/user-client.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const friendIds = fetchAcceptedFriendIds as unknown as jest.Mock;
const snapshots = fetchUserSnapshots as unknown as jest.Mock;

const CID = "c".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111";
const FRIEND = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";

const community = {
  id: CID,
  name: "Cool Community",
  handle: "cool-community",
  avatarUrl: null,
  type: "PUBLIC",
  adminId: ADMIN,
  memberCount: 5,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
};

const adminMembership = {
  userId: ADMIN,
  communityId: CID,
  role: "ADMIN",
  status: "ACTIVE",
  joinedAt: new Date(),
};

beforeEach(() => {
  repo.findById.mockResolvedValue(community);
  repo.findMembership.mockResolvedValue(adminMembership);
  repo.findMembersByUserIds.mockResolvedValue([]);
  repo.countActiveMembers.mockResolvedValue(5);
  repo.createManyMembers.mockResolvedValue({ count: 1 });
  repo.createMember.mockImplementation(
    async (input: Record<string, unknown>) => ({
      ...input,
      status: "ACTIVE",
      role: "MEMBER",
      joinedAt: new Date(),
    })
  );
  snapshots.mockResolvedValue(
    new Map([
      [
        FRIEND,
        { username: "friend", displayName: "Friend", avatarObjectKey: null },
      ],
      [
        STRANGER,
        {
          username: "stranger",
          displayName: "Stranger",
          avatarObjectKey: null,
        },
      ],
    ])
  );
});

describe("addMembers friend gate", () => {
  it("adds a friend and skips a stranger in the same call", async () => {
    friendIds.mockResolvedValue(new Set([FRIEND]));
    // `addMembers` reads the roster twice: once to partition the requested ids
    // (nothing exists yet), then again over the ids it just created to build
    // the response rows.
    repo.findMembersByUserIds.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        userId: FRIEND,
        communityId: CID,
        role: "MEMBER",
        status: "ACTIVE",
        joinedAt: new Date("2026-09-02T00:00:00.000Z"),
        snapshotUsername: "friend",
        snapshotDisplayName: "Friend",
        snapshotAvatarKey: null,
      },
    ]);

    const result = await communityService.addMembers(CID, ADMIN, [
      FRIEND,
      STRANGER,
    ]);

    expect(result.skipped).toContainEqual({
      userId: STRANGER,
      reason: "NOT_FRIEND",
    });
    expect(result.added.map((m) => m.userId)).toEqual([FRIEND]);
    // The stranger reached no write path at all.
    expect(repo.createMember).toHaveBeenCalledTimes(1);
    expect(repo.createMember).toHaveBeenCalledWith(
      expect.objectContaining({ userId: FRIEND }),
      ADMIN
    );
  });

  it("checks friendship against the caller, for the ids being added", async () => {
    friendIds.mockResolvedValue(new Set([FRIEND]));

    await communityService.addMembers(CID, ADMIN, [FRIEND, STRANGER]);

    expect(friendIds).toHaveBeenCalledWith(ADMIN, [FRIEND, STRANGER]);
  });

  it("writes no membership row for a stranger", async () => {
    friendIds.mockResolvedValue(new Set());

    const result = await communityService.addMembers(CID, ADMIN, [STRANGER]);

    expect(result.added).toEqual([]);
    expect(repo.createMember).not.toHaveBeenCalled();
    expect(repo.createManyMembers).not.toHaveBeenCalled();
    expect(repo.reactivateMemberWithSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed when user-service is unreachable", async () => {
    // `fetchAcceptedFriendIds` swallows a gRPC failure and returns an empty
    // set, so an outage must skip every candidate rather than admit them all.
    friendIds.mockResolvedValue(new Set());

    const result = await communityService.addMembers(CID, ADMIN, [
      FRIEND,
      STRANGER,
    ]);

    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([
      { userId: FRIEND, reason: "NOT_FRIEND" },
      { userId: STRANGER, reason: "NOT_FRIEND" },
    ]);
  });

  it("classifies the caller as ALREADY_MEMBER, not NOT_FRIEND", async () => {
    // A user is not their own friend, so the caller has to be classified before
    // the gate runs or adding yourself would report a nonsensical reason.
    friendIds.mockResolvedValue(new Set([FRIEND]));

    const result = await communityService.addMembers(CID, ADMIN, [
      ADMIN,
      FRIEND,
    ]);

    expect(result.skipped).toContainEqual({
      userId: ADMIN,
      reason: "ALREADY_MEMBER",
    });
  });
});
