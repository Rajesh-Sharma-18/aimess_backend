/**
 * Service-layer tests for `communityService.bulkSendInviteLink()`.
 *
 * Root-cause regression: recipients are platform UUIDs (AuthUser.id). The DTO
 * once validated them against the Mongo ObjectId regex, so a real userId failed
 * with "One or more user IDs are invalid" before the service ran. These tests
 * exercise the service directly (DTO is covered in invite-links.test.ts) and lock
 * the new per-recipient validation: existence (user-service), already-member and
 * banned are reported precisely as failures while valid recipients still get the
 * invite event — one bad id never hides the good ones.
 *
 * Only the I/O boundary is mocked (repository, user-client, storage, publishers).
 */

jest.mock("../../src/lib/user-client.js", () => ({
  fetchInviteIneligibility: jest.fn(),
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
    findInviteLinkById: jest.fn(),
    listInviteLinks: jest.fn(),
    createInviteLink: jest.fn(),
    findMembersByUserIds: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import {
  fetchInviteIneligibility,
  fetchUserSnapshotHits,
} from "../../src/lib/user-client.js";
import { publishCommunityInviteLinkSharedForChatSafe } from "../../src/messaging/publish-community-chat.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const ineligible = fetchInviteIneligibility as unknown as jest.Mock;
const snapshotHits = fetchUserSnapshotHits as unknown as jest.Mock;
const publishInvite =
  publishCommunityInviteLinkSharedForChatSafe as unknown as jest.Mock;

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

const link = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

const member = (userId: string, status: string) => ({
  userId,
  role: "MEMBER",
  status,
  joinedAt: new Date("2026-06-01T00:00:00.000Z"),
  snapshotUsername: "u",
  snapshotDisplayName: "U",
  snapshotAvatarKey: null,
  bannedAt: status === "BANNED" ? new Date() : null,
  bannedBy: null,
  banReason: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue(community);
  repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
  repo.findInviteLinkById.mockResolvedValue(link());
  repo.findMembersByUserIds.mockResolvedValue([]);
  // Default: every queried recipient is eligible (overridden per negative test).
  ineligible.mockResolvedValue(new Map());
  // Default: inviter snapshot resolves (overridden per enrichment test).
  snapshotHits.mockResolvedValue(new Map());
});

describe("bulkSendInviteLink — recipient validation + fan-out", () => {
  // --- Positive ---

  it("one valid UUID user → sent=1, one invite event", async () => {
    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    expect(res.summary).toEqual({
      requested: 1,
      sent: 1,
      failed: 0,
      skipped: 0,
    });
    expect(res.sentUserIds).toEqual([UID_A]);
    expect(res.failures).toEqual([]);
    expect(publishInvite).toHaveBeenCalledTimes(1);
    expect(publishInvite).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: UID_A, communityId: CID })
    );
  });

  it("multiple valid UUID users → all sent", async () => {
    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A, UID_B],
      linkId: LINK_ID,
    });

    expect(res.summary).toMatchObject({ requested: 2, sent: 2, failed: 0 });
    expect(new Set(res.sentUserIds)).toEqual(new Set([UID_A, UID_B]));
    expect(publishInvite).toHaveBeenCalledTimes(2);
  });

  it("duplicate userIds are deduped (one event per unique recipient)", async () => {
    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A, UID_A, UID_A],
      linkId: LINK_ID,
    });

    expect(res.summary).toMatchObject({ requested: 1, sent: 1 });
    expect(publishInvite).toHaveBeenCalledTimes(1);
  });

  // --- Negative (per-user) ---

  it("nonexistent user → USER_NOT_FOUND failure, NO event", async () => {
    ineligible.mockResolvedValue(new Map([[UID_A, "NOT_FOUND"]]));

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    expect(res.summary).toMatchObject({ sent: 0, failed: 1 });
    expect(res.sentUserIds).toEqual([]);
    expect(res.failures).toEqual([
      {
        userId: UID_A,
        code: "INVITE_RECIPIENT_NOT_FOUND",
        message: expect.any(String),
      },
    ]);
    expect(publishInvite).not.toHaveBeenCalled();
  });

  it("already-member recipient → ALREADY_MEMBER failure, NO event", async () => {
    repo.findMembersByUserIds.mockResolvedValue([member(UID_A, "ACTIVE")]);

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    expect(res.failures).toEqual([
      { userId: UID_A, code: "ALREADY_MEMBER", message: expect.any(String) },
    ]);
    expect(publishInvite).not.toHaveBeenCalled();
  });

  it("banned recipient → USER_BANNED failure, NO event", async () => {
    repo.findMembersByUserIds.mockResolvedValue([member(UID_A, "BANNED")]);

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    expect(res.failures).toEqual([
      { userId: UID_A, code: "USER_BANNED", message: expect.any(String) },
    ]);
    expect(publishInvite).not.toHaveBeenCalled();
  });

  it("a previously-LEFT member may still be re-invited", async () => {
    repo.findMembersByUserIds.mockResolvedValue([member(UID_A, "LEFT")]);

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    expect(res.summary).toMatchObject({ sent: 1, failed: 0 });
    expect(publishInvite).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["BLOCKED", "INVITE_RECIPIENT_BLOCKED"],
    ["SUSPENDED", "INVITE_RECIPIENT_SUSPENDED"],
    ["DELETED", "INVITE_RECIPIENT_DELETED"],
  ])("%s recipient -> %s failure, NO event", async (reason, code) => {
    ineligible.mockResolvedValue(new Map([[UID_A, reason]]));

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    expect(res.summary).toMatchObject({ sent: 0, failed: 1 });
    expect(res.failures).toEqual([
      { userId: UID_A, code, message: expect.any(String) },
    ]);
    expect(publishInvite).not.toHaveBeenCalled();
  });

  // --- Mixed bulk ---

  it("one valid + one nonexistent → sent=1, failed=1, event only for the valid one", async () => {
    ineligible.mockResolvedValue(new Map([[UID_B, "NOT_FOUND"]]));

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A, UID_B],
      linkId: LINK_ID,
    });

    expect(res.summary).toMatchObject({ requested: 2, sent: 1, failed: 1 });
    expect(res.sentUserIds).toEqual([UID_A]);
    expect(res.failures).toEqual([
      {
        userId: UID_B,
        code: "INVITE_RECIPIENT_NOT_FOUND",
        message: expect.any(String),
      },
    ]);
    expect(publishInvite).toHaveBeenCalledTimes(1);
    expect(publishInvite).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: UID_A })
    );
  });

  it("one valid + one already-member → sent=1, failed=1", async () => {
    repo.findMembersByUserIds.mockResolvedValue([member(UID_B, "ACTIVE")]);

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A, UID_B],
      linkId: LINK_ID,
    });

    expect(res.summary).toMatchObject({ sent: 1, failed: 1 });
    expect(res.sentUserIds).toEqual([UID_A]);
    expect(res.failures[0]).toMatchObject({
      userId: UID_B,
      code: "ALREADY_MEMBER",
    });
  });

  it("the caller themselves is skipped, not failed", async () => {
    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [CALLER, UID_A],
      linkId: LINK_ID,
    });

    expect(res.summary).toEqual({
      requested: 2,
      sent: 1,
      failed: 0,
      skipped: 1,
    });
    expect(res.sentUserIds).toEqual([UID_A]);
  });

  it("user-service UNAVAILABLE → fail open, valid sends still go out", async () => {
    // The gate swallows transport errors and returns an empty map (fail open).
    ineligible.mockResolvedValue(new Map());

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A, UID_B],
      linkId: LINK_ID,
    });

    expect(res.summary).toMatchObject({ sent: 2, failed: 0 });
    expect(publishInvite).toHaveBeenCalledTimes(2);
  });

  // --- Link / authorization state (separate from user-id validation) ---

  it("linkId from another community → COMMUNITY_INVITE_LINK_NOT_FOUND", async () => {
    repo.findInviteLinkById.mockResolvedValue(
      link({ communityId: "z".repeat(24) })
    );

    await expect(
      communityService.bulkSendInviteLink(CID, CALLER, {
        userIds: [UID_A],
        linkId: LINK_ID,
      })
    ).rejects.toThrow("COMMUNITY_INVITE_LINK_NOT_FOUND");
    expect(publishInvite).not.toHaveBeenCalled();
  });

  it("revoked/inactive link → COMMUNITY_INVITE_LINK_INACTIVE", async () => {
    repo.findInviteLinkById.mockResolvedValue(link({ revokedAt: new Date() }));

    await expect(
      communityService.bulkSendInviteLink(CID, CALLER, {
        userIds: [UID_A],
        linkId: LINK_ID,
      })
    ).rejects.toThrow("COMMUNITY_INVITE_LINK_INACTIVE");
    expect(publishInvite).not.toHaveBeenCalled();
  });

  it("permanent link sentinel (linkId === communityId) → synthesizes row from invitationCode, DM sent", async () => {
    // Regression: PRIVATE community invite links return linkId === communityId.
    // findInviteLinkById returns null (no DB row for permanent links), but the
    // service must fall back to the community's invitationCode rather than throw.
    const PERM_CODE = "perm_abc123";
    repo.findById.mockResolvedValue({
      ...community,
      invitationCode: PERM_CODE,
      invitationCodeCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    repo.findInviteLinkById.mockResolvedValue(null);

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: CID, // permanent link sentinel: linkId === communityId
    });

    expect(res.summary).toMatchObject({ sent: 1, failed: 0 });
    expect(res.sentUserIds).toEqual([UID_A]);
    expect(publishInvite).toHaveBeenCalledTimes(1);
    expect(publishInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        linkCode: PERM_CODE,
        communityId: CID,
        recipientId: UID_A,
        isPermanent: true,
      })
    );
  });

  it("permanent link sentinel but community has no invitationCode → COMMUNITY_INVITE_LINK_NOT_FOUND", async () => {
    repo.findInviteLinkById.mockResolvedValue(null);
    // community fixture has no invitationCode (default beforeEach mock)

    await expect(
      communityService.bulkSendInviteLink(CID, CALLER, {
        userIds: [UID_A],
        linkId: CID,
      })
    ).rejects.toThrow("COMMUNITY_INVITE_LINK_NOT_FOUND");
    expect(publishInvite).not.toHaveBeenCalled();
  });

  // --- Authorization: any ACTIVE member (role-agnostic, state-based) ---

  it("a regular ACTIVE MEMBER can bulk-send (no longer MODERATOR-gated)", async () => {
    repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    expect(res.summary).toMatchObject({ sent: 1, failed: 0 });
    expect(publishInvite).toHaveBeenCalledTimes(1);
  });

  it("an ACTIVE MODERATOR can bulk-send", async () => {
    repo.findMembership.mockResolvedValue({
      role: "MODERATOR",
      status: "ACTIVE",
    });

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });
    expect(res.summary).toMatchObject({ sent: 1 });
  });

  it("an ACTIVE ADMIN can bulk-send", async () => {
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });
    expect(res.summary).toMatchObject({ sent: 1 });
  });

  it("a NON-MEMBER (no membership row) is forbidden, nothing sent", async () => {
    repo.findMembership.mockResolvedValue(null);

    await expect(
      communityService.bulkSendInviteLink(CID, CALLER, {
        userIds: [UID_A],
        linkId: LINK_ID,
      })
    ).rejects.toThrow("COMMUNITY_FORBIDDEN");
    expect(publishInvite).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "BANNED", "LEFT"])(
    "a %s (non-ACTIVE) member is forbidden, nothing sent",
    async (status) => {
      repo.findMembership.mockResolvedValue({ role: "MEMBER", status });

      await expect(
        communityService.bulkSendInviteLink(CID, CALLER, {
          userIds: [UID_A],
          linkId: LINK_ID,
        })
      ).rejects.toThrow("COMMUNITY_FORBIDDEN");
      expect(publishInvite).not.toHaveBeenCalled();
    }
  );

  // --- Personal-chat enrichment: the DM event carries the invitation card data ---

  it("the invite event carries the enriched card payload (url, memberCount, avatar, inviter)", async () => {
    snapshotHits.mockResolvedValue(
      new Map([
        [
          CALLER,
          {
            userId: CALLER,
            username: "john",
            displayName: "John",
            avatarObjectKey: "avatars/john.jpg",
          },
        ],
      ])
    );

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    // Inviter identity is resolved ONCE (no N+1) — single batch lookup.
    expect(snapshotHits).toHaveBeenCalledTimes(1);
    expect(snapshotHits).toHaveBeenCalledWith([CALLER]);

    expect(publishInvite).toHaveBeenCalledTimes(1);
    expect(publishInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        // existing fields — UNCHANGED
        communityId: CID,
        communityName: "Cool Community",
        linkCode: "abc123",
        inviterId: CALLER,
        recipientId: UID_A,
        eventAt: expect.any(String),
        // additive enrichment
        communityAvatarUrl: null, // fixture community.avatarUrl is null
        memberCount: 5,
        inviteUrl: res.link.url,
        inviteDeepLink: res.link.appDeepLink,
        isPermanent: true, // link() has maxUses:null + expiresAt:null
        inviterName: "John",
        inviterAvatarUrl: "avatars/john.jpg",
      })
    );
  });

  it("isPermanent=false when the link has a use cap or an expiry", async () => {
    repo.findInviteLinkById.mockResolvedValue(link({ maxUses: 10 }));

    await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    expect(publishInvite).toHaveBeenCalledWith(
      expect.objectContaining({ isPermanent: false })
    );
  });

  it("a missing inviter snapshot degrades gracefully (name/avatar omitted, still sent)", async () => {
    snapshotHits.mockResolvedValue(new Map()); // user-service hiccup → no hit

    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    expect(res.summary).toMatchObject({ sent: 1, failed: 0 });
    expect(publishInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: UID_A,
        inviterName: undefined,
        inviterAvatarUrl: null,
      })
    );
  });

  it("existing request/response contract is unchanged (back-compat shape intact)", async () => {
    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A],
      linkId: LINK_ID,
    });

    expect(res).toEqual(
      expect.objectContaining({
        link: expect.objectContaining({
          linkId: LINK_ID,
          code: "abc123",
          url: expect.any(String),
        }),
        summary: { requested: 1, sent: 1, failed: 0, skipped: 0 },
        sentUserIds: [UID_A],
        failures: [],
        // original { queued, skipped } aliases still present
        queued: 1,
        skipped: 0,
      })
    );
  });

  // --- Audit: every bulk-send is recorded (member-accessible → must be traceable) ---

  it("records an INVITE_LINK_BULK_SENT audit entry with per-recipient counts", async () => {
    repo.findMembersByUserIds.mockResolvedValue([member(UID_B, "ACTIVE")]);

    await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [UID_A, UID_B, CALLER],
      linkId: LINK_ID,
    });

    expect(repo.createAuditLog).toHaveBeenCalledTimes(1);
    expect(repo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: CID,
        actorId: CALLER,
        action: "INVITE_LINK_BULK_SENT",
        metadata: expect.objectContaining({
          linkId: LINK_ID,
          requested: 3, // UID_A + UID_B + CALLER (unique count, pre-self-skip)
          sent: 1, // UID_A
          failed: 1, // UID_B (already a member)
          skipped: 1, // CALLER (self)
        }),
      })
    );
  });
});
