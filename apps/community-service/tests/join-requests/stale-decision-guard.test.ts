/**
 * A decision raised for one attempt must never settle a later one.
 *
 * A join request row is unique per (community, requester) and RECYCLED, so
 * request → cancel → request again keeps the same id. Anything that can outlive
 * the attempt it was raised for — a notification card, a push still sitting in
 * the tray — therefore cannot be trusted to name the right attempt by id alone:
 * an admin tapping Accept on yesterday's card would otherwise admit someone off
 * a request they had cancelled. Those surfaces echo the attempt token they were
 * raised with, and a mismatch is refused with the same error a decision on an
 * already-settled request returns.
 *
 * The in-app requests list reads the live row and sends no token, so it is
 * unaffected — that path must keep working exactly as it did.
 */
jest.mock("../../src/lib/user-client.js", () => ({
  fetchUserSnapshots: jest.fn(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          { userId: id, username: id, displayName: "Mock User", avatarObjectKey: null },
        ])
      )
  ),
  fetchAcceptedFriendIds: jest.fn(async () => new Set<string>()),
}));

jest.mock("@aimess/storage", () => ({
  MEDIA_PREFIXES: { community: [], userAvatars: [] },
  toMediaObject: jest.fn(async () => ({
    url: null,
    downloadUrl: null,
    objectKey: null,
    expiresAt: null,
  })),
}));

jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  publishCommunityRoomEvent: jest.fn(async () => 1),
  publishChatUserEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findJoinRequestById: jest.fn(),
    findMemberByUserId: jest.fn(),
    createMember: jest.fn(),
    reactivateMemberWithSnapshot: jest.fn(),
    settleJoinRequestToMember: jest.fn(),
    settlePendingJoinRequest: jest.fn(),
    updateJoinRequest: jest.fn(),
    countActiveMembers: jest.fn(),
    setMemberCount: jest.fn(),
    updateLastActivity: jest.fn(),
    findActiveMemberIdsByRoles: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

jest.mock("../../src/services/member-avatar.service.js", () => ({
  memberAvatarService: {
    resolveViewUrl: jest.fn(async () => ({ url: null, expiresIn: null })),
  },
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CID = "c".repeat(24);
const RID = "r".repeat(24);
const ADMIN = "22222222-2222-4222-8222-222222222222";
const REQUESTER = "99999999-9999-4999-8999-999999999999";

/** The attempt the card in the admin's list was raised for. */
const RAISED_AT = new Date("2026-09-24T12:00:00.000Z");
const RAISED_LIFECYCLE = `${RID}:${RAISED_AT.getTime()}`;
/** The same row after the requester cancelled and asked again. */
const CURRENT_AT = new Date("2026-09-24T12:30:00.000Z");
const CURRENT_LIFECYCLE = `${RID}:${CURRENT_AT.getTime()}`;

const community = {
  id: CID,
  name: "Request Tester",
  handle: "request-tester",
  avatarUrl: null,
  type: "PRIVATE",
  adminId: ADMIN,
  memberCount: 3,
  moderationStatus: "ACTIVE",
};

const currentAttempt = {
  id: RID,
  communityId: CID,
  userId: REQUESTER,
  status: "PENDING",
  message: null,
  inviteCode: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: RAISED_AT,
  updatedAt: CURRENT_AT,
};

beforeEach(() => {
  repo.findById.mockResolvedValue(community);
  repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
  repo.findJoinRequestById.mockResolvedValue(currentAttempt);
  // Not a member when the decision is taken; the row exists on the re-read the
  // approve path does after writing it. Reset first: jest's `clearMocks` clears
  // recorded calls but NOT a queued one-shot, so a test that never consumed its
  // `null` would leave it to be answered to the NEXT test's post-write read.
  repo.findMemberByUserId.mockReset();
  repo.findMemberByUserId.mockResolvedValueOnce(null).mockResolvedValue({
    userId: REQUESTER,
    role: "MEMBER",
    status: "ACTIVE",
    joinedAt: new Date(),
    snapshotUsername: "requester",
    snapshotDisplayName: "The Requester",
    snapshotAvatarKey: null,
  });
  repo.findActiveMemberIdsByRoles.mockResolvedValue([ADMIN]);
  repo.createAuditLog.mockResolvedValue(undefined);
  repo.countActiveMembers.mockResolvedValue(4);
  repo.setMemberCount.mockResolvedValue(undefined);
  repo.updateLastActivity.mockResolvedValue(undefined);
  repo.createMember.mockResolvedValue({
    userId: REQUESTER,
    role: "MEMBER",
    status: "ACTIVE",
    joinedAt: new Date(),
    snapshotUsername: "requester",
    snapshotDisplayName: "The Requester",
    snapshotAvatarKey: null,
  });
  repo.settleJoinRequestToMember.mockResolvedValue({
    outcome: "ACTIVATED",
    member: { userId: REQUESTER, role: "MEMBER" },
    clearedMutes: 0,
  });
  repo.settlePendingJoinRequest.mockResolvedValue({
    ...currentAttempt,
    status: "REJECTED",
    decidedBy: ADMIN,
    decidedAt: new Date(),
  });
  repo.updateJoinRequest.mockResolvedValue({
    ...currentAttempt,
    status: "APPROVED",
    decidedBy: ADMIN,
    decidedAt: new Date(),
  });
});

describe("approve", () => {
  it("refuses a decision raised for an attempt that has been replaced", async () => {
    await expect(
      communityService.approveJoinRequest(CID, ADMIN, RID, RAISED_LIFECYCLE)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_REQUEST_NOT_PENDING" });

    // The decisive part: nobody was admitted off the stale card.
    expect(repo.settleJoinRequestToMember).not.toHaveBeenCalled();
  });

  it("accepts a decision raised for the attempt that is actually pending", async () => {
    await expect(
      communityService.approveJoinRequest(CID, ADMIN, RID, CURRENT_LIFECYCLE)
    ).resolves.toMatchObject({ request: { requestId: RID } });

    expect(repo.settleJoinRequestToMember).toHaveBeenCalledTimes(1);
  });

  it("leaves the in-app requests list alone — it sends no token", async () => {
    await expect(
      communityService.approveJoinRequest(CID, ADMIN, RID)
    ).resolves.toMatchObject({ request: { requestId: RID } });

    expect(repo.settleJoinRequestToMember).toHaveBeenCalledTimes(1);
  });
});

describe("reject", () => {
  it("refuses a decision raised for an attempt that has been replaced", async () => {
    await expect(
      communityService.rejectJoinRequest(CID, ADMIN, RID, RAISED_LIFECYCLE)
    ).rejects.toMatchObject({ message: "COMMUNITY_JOIN_REQUEST_NOT_PENDING" });

    expect(repo.settlePendingJoinRequest).not.toHaveBeenCalled();
  });

  it("accepts a decision raised for the current attempt", async () => {
    await expect(
      communityService.rejectJoinRequest(CID, ADMIN, RID, CURRENT_LIFECYCLE)
    ).resolves.toMatchObject({ requestId: RID, status: "REJECTED" });

    expect(repo.settlePendingJoinRequest).toHaveBeenCalledTimes(1);
  });

  it("leaves the in-app requests list alone — it sends no token", async () => {
    await expect(
      communityService.rejectJoinRequest(CID, ADMIN, RID)
    ).resolves.toMatchObject({ requestId: RID });

    expect(repo.settlePendingJoinRequest).toHaveBeenCalledTimes(1);
  });
});
