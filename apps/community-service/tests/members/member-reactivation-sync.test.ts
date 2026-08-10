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

// Prisma I/O boundary. Reactivation is one interactive-free `$transaction`:
// the member row flips to ACTIVE while the previous cycle's mute + warning rows
// are deleted, so all three either land or none do. The mock resolves the array
// in order, mirroring Prisma's own sequential-array semantics.
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    communityMember: {
      update: jest.fn(),
    },
    communityMemberMute: {
      deleteMany: jest.fn(),
    },
    communityMemberWarning: {
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
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
jest.unmock("../../src/repositories/community.repository.js");

import { publishChatUserEvent, publishCommunityRoomEvent } from "@aimess/redis";

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import {
  publishCommunityMemberMuteSyncedForChatSafe,
  publishCommunityMemberSyncedForChatSafe,
} from "../../src/messaging/publish-community-chat.js";

const prismaMock = prisma as unknown as {
  communityMember: { update: jest.Mock };
  communityMemberMute: { deleteMany: jest.Mock };
  communityMemberWarning: { deleteMany: jest.Mock };
};
const updateMock = prismaMock.communityMember.update;
const deleteMutesMock = prismaMock.communityMemberMute.deleteMany;
const deleteWarningsMock = prismaMock.communityMemberWarning.deleteMany;
const pubSynced = publishCommunityMemberSyncedForChatSafe as jest.Mock;
const pubMuteSynced = publishCommunityMemberMuteSyncedForChatSafe as jest.Mock;
const pubRoomEvent = publishCommunityRoomEvent as jest.Mock;
const pubUserEvent = publishChatUserEvent as jest.Mock;

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
    // Default: the ending cycle carried no mute (the common rejoin).
    deleteMutesMock.mockResolvedValue({ count: 0 });
    deleteWarningsMock.mockResolvedValue({ count: 0 });
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

  // ── Fresh-membership guarantees ────────────────────────────────────────────
  // Reported bug: admin mutes a member, the member is then removed / leaves /
  // is banned, and on rejoining they are STILL muted — the moderation state of a
  // membership cycle outlived the cycle itself. A rejoin must produce a member
  // indistinguishable from someone joining for the first time.

  it("clears the previous cycle's ban metadata (a rejoin is not a banned row)", async () => {
    await communityRepository.reactivateMemberWithSnapshot(CID, USER, snapshot);

    const { data } = updateMock.mock.calls[0][0];
    expect(data.bannedAt).toEqual({ unset: true });
    expect(data.bannedBy).toEqual({ unset: true });
    expect(data.banReason).toEqual({ unset: true });
  });

  it("deletes the previous cycle's mute and warning rows in the SAME write as the ACTIVE flip", async () => {
    await communityRepository.reactivateMemberWithSnapshot(CID, USER, snapshot);

    const where = { communityId: CID, userId: USER };
    expect(deleteMutesMock).toHaveBeenCalledWith({ where });
    expect(deleteWarningsMock).toHaveBeenCalledWith({ where });
    // Atomic with the status flip — never a window where the member reads as
    // ACTIVE while the old mute row still gates them.
    expect(
      (prisma as unknown as { $transaction: jest.Mock }).$transaction
    ).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: a rejoin that cleared a mute tells chat-service AND both socket channels, so the composer re-enables with no reload", async () => {
    deleteMutesMock.mockResolvedValue({ count: 1 });

    await communityRepository.reactivateMemberWithSnapshot(CID, USER, snapshot);

    // 1. Lift the mirrored write-path gate in chat-service.
    expect(pubMuteSynced).toHaveBeenCalledWith({
      communityId: CID,
      userId: USER,
      isMuted: false,
      mutedUntil: null,
    });
    // 2. Real-time fan-out: the roster badge for everyone, and the member's own
    //    channel so EVERY device they're signed in on drops the muted banner.
    expect(pubRoomEvent.mock.calls[0][2]).toBe("community:member:unmuted");
    expect(pubUserEvent.mock.calls[0][1]).toBe(USER);
    expect(pubUserEvent.mock.calls[0][2]).toBe("community:member:unmuted");
    expect(pubUserEvent.mock.calls[0][3]).toMatchObject({
      communityId: CID,
      memberId: USER,
      isMuted: false,
      mutedUntil: null,
    });
  });

  it("stays quiet when the ending cycle had no mute (no unmute spam at the roster)", async () => {
    deleteMutesMock.mockResolvedValue({ count: 0 });

    await communityRepository.reactivateMemberWithSnapshot(CID, USER, snapshot);

    expect(pubMuteSynced).not.toHaveBeenCalled();
    expect(pubRoomEvent).not.toHaveBeenCalled();
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
