/**
 * Service-layer regression test for `communityService.bulkCreateInvites()`.
 *
 * Bug: a direct community invitation (POST /:id/invites) created the invite row
 * and fired a push notification, but nothing ever landed in the inviter↔invitee
 * 1:1 chat — so the invitee had no invitation card in the conversation, live or
 * in history. The fix reuses the invite-link share pipeline
 * (`community.invite_link_shared` → chat-service `deliverInviteLinkDm`), which
 * persists the SYSTEM/COMMUNITY_INVITE message and drives realtime + unread +
 * push. These tests lock that fan-out and its failure isolation.
 *
 * Only the I/O boundary is mocked (repository, user-client, publishers).
 */

jest.mock("../../src/lib/user-client.js", () => ({
  fetchInviteIneligibility: jest.fn(async () => new Map()),
  INVITE_INELIGIBILITY_CODE: {
    NOT_FOUND: "INVITE_RECIPIENT_NOT_FOUND",
    DELETED: "INVITE_RECIPIENT_DELETED",
    SUSPENDED: "INVITE_RECIPIENT_SUSPENDED",
    BLOCKED: "INVITE_RECIPIENT_BLOCKED",
  },
  fetchUserSnapshots: jest.fn(async () => new Map()),
  fetchUserSnapshotHits: jest.fn(async () => new Map()),
  fetchAcceptedFriendIds: jest.fn(async () => new Set()),
}));

jest.mock("@aimess/storage", () => ({
  MEDIA_PREFIXES: { community: [], userAvatars: [] },
  parseObjectKeyFromStored: jest.fn(() => null),
  toMediaObject: jest.fn(async () => ({
    url: null,
    downloadUrl: null,
    objectKey: null,
    expiresAt: null,
  })),
}));

jest.mock("@aimess/redis", () => ({
  // Spread the real module first: a factory that returns only the stubs
  // replaces EVERY other export with undefined, and `createBannedUserGuard`
  // is called at import time by `authenticate-access-token.ts` - so every
  // suite that touches `app.ts` died on "is not a function" before it ran.
  ...jest.requireActual("@aimess/redis"),
  publishCommunityRoomEvent: jest.fn(async () => 1),
  publishChatUserEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findMembersByUserIds: jest.fn(),
    findInvitesByUserIds: jest.fn(),
    createInvite: jest.fn(),
    recycleManyPendingInvites: jest.fn(),
    listInviteLinks: jest.fn(),
    createInviteLink: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

import { communityService } from "../../src/services/community.service.js";
import { fetchInviteIneligibility } from "../../src/lib/user-client.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { publishCommunityInviteLinkSharedForChatSafe } from "../../src/messaging/publish-community-chat.js";
import { publishCommunityInviteSentSafe } from "../../src/messaging/publish-community.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const ineligible = fetchInviteIneligibility as unknown as jest.Mock;
const publishDm =
  publishCommunityInviteLinkSharedForChatSafe as unknown as jest.Mock;
const publishInviteSent =
  publishCommunityInviteSentSafe as unknown as jest.Mock;

const CID = "a".repeat(24);
const LINK_ID = "b".repeat(24);
const CALLER = "99999999-9999-4999-8999-999999999999";
const UID_A = "885ad4e0-e238-4f9a-9773-e215321885b4";
const UID_B = "22222222-2222-4222-8222-222222222222";

const community = {
  id: CID,
  name: "Cool Community",
  handle: "cool_community",
  avatarUrl: null,
  coverUrl: null,
  type: "PRIVATE",
  adminId: "11111111-1111-4111-8111-111111111111",
  memberCount: 5,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
  deletedAt: null,
};

const link = {
  id: LINK_ID,
  code: "abc123",
  communityId: CID,
  createdBy: CALLER,
  maxUses: null,
  usedCount: 0,
  autoApprove: false,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date("2026-06-23T00:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue(community);
  repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
  repo.findMembersByUserIds.mockResolvedValue([]);
  repo.findInvitesByUserIds.mockResolvedValue([]);
  repo.createInvite.mockImplementation(
    async ({ inviteeId }: { inviteeId: string }) => ({
      id: `invite-${inviteeId}`,
      inviteeId,
      communityId: CID,
      inviterId: CALLER,
      status: "PENDING",
    })
  );
  repo.listInviteLinks.mockResolvedValue({ rows: [link], total: 1 });
});

describe("bulkCreateInvites — 1:1 chat invitation card fan-out", () => {
  it("publishes one invite-link-shared DM event per newly invited user", async () => {
    const res = await communityService.bulkCreateInvites(CID, CALLER, [
      UID_A,
      UID_B,
    ]);

    expect(res.invited).toBe(2);
    expect(publishDm).toHaveBeenCalledTimes(2);
    expect(publishDm).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: CID,
        communityName: "Cool Community",
        linkCode: "abc123",
        inviterId: CALLER,
        recipientId: UID_A,
      })
    );
    expect(publishDm).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: UID_B })
    );
  });

  // Recipient-account gate: a MODERATOR inviting a blocked/suspended/deleted
  // account must produce neither an invite row nor a DM card.
  it.each([
    ["BLOCKED", "INVITE_RECIPIENT_BLOCKED"],
    ["SUSPENDED", "INVITE_RECIPIENT_SUSPENDED"],
    ["DELETED", "INVITE_RECIPIENT_DELETED"],
  ])("refuses a %s recipient (no invite row, no DM)", async (reason, code) => {
    ineligible.mockResolvedValueOnce(new Map([[UID_A, reason]]));

    const res = await communityService.bulkCreateInvites(CID, CALLER, [
      UID_A,
      UID_B,
    ]);

    expect(res.invited).toBe(1);
    expect(res.results).toContainEqual({
      userId: UID_A,
      outcome: "FAILED",
      reason: code,
    });
    expect(repo.createInvite).toHaveBeenCalledTimes(1);
    expect(publishDm).toHaveBeenCalledTimes(1);
    expect(publishDm).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: UID_B })
    );
  });

  it("mints a shareable link when the community has none, so the card always has a code", async () => {
    repo.listInviteLinks.mockResolvedValue({ rows: [], total: 0 });
    repo.createInviteLink.mockResolvedValue({ ...link, code: "fresh1" });

    await communityService.bulkCreateInvites(CID, CALLER, [UID_A]);

    expect(repo.createInviteLink).toHaveBeenCalled();
    expect(publishDm).toHaveBeenCalledWith(
      expect.objectContaining({ linkCode: "fresh1", recipientId: UID_A })
    );
  });

  it("stamps the DM event with the same eventAt as invite_sent (redelivery dedupe)", async () => {
    await communityService.bulkCreateInvites(CID, CALLER, [UID_A]);

    const sentAt = publishInviteSent.mock.calls[0]![0].eventAt;
    const dmAt = publishDm.mock.calls[0]![0].eventAt;
    expect(typeof sentAt).toBe("string");
    expect(dmAt).toBe(sentAt);
  });

  it("skips users who are already ACTIVE members — no invite, no DM", async () => {
    repo.findMembersByUserIds.mockResolvedValue([
      { userId: UID_A, status: "ACTIVE", role: "MEMBER" },
    ]);

    const res = await communityService.bulkCreateInvites(CID, CALLER, [UID_A]);

    expect(res.alreadyMembers).toBe(1);
    expect(res.invited).toBe(0);
    expect(publishDm).not.toHaveBeenCalled();
  });

  it("a link-resolution failure does NOT fail the invite itself", async () => {
    repo.listInviteLinks.mockRejectedValue(new Error("db down"));

    const res = await communityService.bulkCreateInvites(CID, CALLER, [UID_A]);

    expect(res.invited).toBe(1);
    expect(publishInviteSent).toHaveBeenCalledTimes(1);
    expect(publishDm).not.toHaveBeenCalled();
  });
});
