/**
 * Repository-level regression: `reactivateMemberWithSnapshot` MUST publish
 * `community.member.synced` to chat-service's sync queue, exactly like its
 * sibling member-mutation methods (createMember / createManyMembers /
 * updateMemberStatus / updateMemberRole).
 *
 * The bug: when a previously-LEFT member is re-added (approveJoinRequest /
 * acceptInvite / redeemInviteLink autoApprove / addMembers), this method flipped
 * the community-service row back to ACTIVE but never told chat-service, so the
 * member's RoomMember row stayed stale and they couldn't send/receive in the
 * community general room despite being ACTIVE again.
 *
 * Unlike the HTTP/service suites, this exercises the REAL repository method with
 * only the I/O boundary mocked (Prisma + the RabbitMQ `*-Safe` publisher) so we
 * can assert the publish side-effect that lives inside the repository.
 */

// Prisma I/O boundary — only `communityMember.update` is touched here.
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    communityMember: {
      update: jest.fn(),
    },
  },
}));

// Generated Prisma client is a heavy CJS bundle (requires runtime/library.js);
// the repo only needs the string enums, which echo their own member name.
jest.mock("../../src/generated/prisma/index.js", () => {
  const echo = () =>
    new Proxy(
      {},
      { get: (_t, key) => (typeof key === "string" ? key : undefined) }
    );
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "__esModule") return true;
        return echo();
      },
    }
  );
});

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { publishCommunityMemberSyncedForChatSafe } from "../../src/messaging/publish-community-chat.js";

const updateMock = (
  prisma as unknown as { communityMember: { update: jest.Mock } }
).communityMember.update;
const pubSynced = publishCommunityMemberSyncedForChatSafe as jest.Mock;

const CID = "c".repeat(24);
const USER = "99999999-9999-4999-8999-999999999999";

const snapshot = {
  snapshotUsername: "rejoiner",
  snapshotDisplayName: "Re Joiner",
  snapshotAvatarKey: null,
};

const reactivatedRow = {
  id: "m".repeat(24),
  userId: USER,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date("2026-06-16T00:00:00.000Z"),
  ...snapshot,
  bannedAt: null,
  bannedBy: null,
  banReason: null,
};

describe("communityRepository.reactivateMemberWithSnapshot", () => {
  beforeEach(() => {
    updateMock.mockResolvedValue(reactivatedRow);
  });

  it("flips the row back to ACTIVE/MEMBER, writes the fresh snapshot, and returns it", async () => {
    const row = await communityRepository.reactivateMemberWithSnapshot(
      CID,
      USER,
      snapshot
    );

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0];
    expect(arg.where).toEqual({
      communityId_userId: { communityId: CID, userId: USER },
    });
    expect(arg.data).toMatchObject({
      status: "ACTIVE",
      role: "MEMBER",
      ...snapshot,
    });
    expect(row).toBe(reactivatedRow);
  });

  it("advances joinedAt to NOW on rejoin so the member list shows the latest join time", async () => {
    const before = Date.now();
    await communityRepository.reactivateMemberWithSnapshot(CID, USER, snapshot);
    const after = Date.now();

    const arg = updateMock.mock.calls[0][0];
    expect(arg.data.joinedAt).toBeInstanceOf(Date);
    const joinedMs = (arg.data.joinedAt as Date).getTime();
    // Stamped at reactivation time, not the original (stale) join time.
    expect(joinedMs).toBeGreaterThanOrEqual(before);
    expect(joinedMs).toBeLessThanOrEqual(after);
  });

  it("publishes community.member.synced so chat-service re-adds the RoomMember (the regression fix)", async () => {
    await communityRepository.reactivateMemberWithSnapshot(CID, USER, snapshot);

    expect(pubSynced).toHaveBeenCalledTimes(1);
    // Same payload shape the sibling mutation methods emit (status + role).
    expect(pubSynced).toHaveBeenCalledWith({
      communityId: CID,
      userId: USER,
      status: "ACTIVE",
      role: "MEMBER",
    });
  });

  it("does NOT publish when the DB write fails (event fires only after the row is persisted)", async () => {
    updateMock.mockReset();
    updateMock.mockRejectedValueOnce(new Error("write failed"));

    await expect(
      communityRepository.reactivateMemberWithSnapshot(CID, USER, snapshot)
    ).rejects.toThrow("write failed");

    expect(pubSynced).not.toHaveBeenCalled();
  });
});
