/**
 * Service-layer tests for the community's shareable invitation link
 * (`communityService.getOrCreatePermanentInvitationLink`, kept under its
 * original endpoint name).
 *
 * Contract under test:
 *  - A minted link carries NO expiry: it lives until an admin revokes it, the
 *    same rule a group link follows.
 *  - Repeated calls reuse the caller's live link — no new row, no rate-limit /
 *    cap consumption.
 *  - PRIVATE communities only; PUBLIC → COMMUNITY_NOT_PRIVATE.
 *  - The URL scheme is the established Telegram-style `<base>/+<code>` +
 *    `aimess://join?code=<code>`.
 *  - LEGACY permanent codes on the Community row still resolve, and no clock
 *    kills them either — nothing mints them any more, and nothing revokes them.
 *
 * Only the I/O boundary is mocked (repository, user-client, storage, publishers).
 * The per-user Redis rate limit fails open under test (cache not ready).
 */

jest.mock("../../src/lib/user-client.js", () => ({
  fetchInviteIneligibility: jest.fn(async () => new Map()),
  INVITE_INELIGIBILITY_CODE: {
    NOT_FOUND: "INVITE_RECIPIENT_NOT_FOUND",
    DELETED: "INVITE_RECIPIENT_DELETED",
    SUSPENDED: "INVITE_RECIPIENT_SUSPENDED",
    BLOCKED: "INVITE_RECIPIENT_BLOCKED",
  },
  fetchExistingUserIds: jest.fn(async () => null),
  fetchUserSnapshots: jest.fn(async () => new Map()),
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
    setInvitationCodeOnce: jest.fn(),
    findLatestReusableInviteLink: jest.fn(),
    findInviteLinkByCode: jest.fn(),
    findCommunityByInvitationCode: jest.fn(),
    findMemberByUserId: jest.fn(),
    findJoinRequestByCommunityAndUser: jest.fn(),
    countActiveInviteLinksByCreator: jest.fn(),
    createInviteLink: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { env } from "../../src/config/env.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const BASE = env.INVITE_LINK_BASE_URL;

const CID = "a".repeat(24);
const CALLER = "99999999-9999-4999-8999-999999999999";
const STORED_CODE = "AbCdEf123456GhIjKl7890";
const CREATED_AT = new Date("2026-06-26T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

/** A PRIVATE community whose LEGACY permanent code was minted just now. */
const community = (over: Record<string, unknown> = {}) => ({
  id: CID,
  name: "Tech Community",
  handle: "tech_community",
  description: null,
  avatarUrl: null,
  coverUrl: null,
  type: "PRIVATE",
  adminId: "11111111-1111-4111-8111-111111111111",
  memberCount: 5,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
  deletedAt: null,
  invitationCode: STORED_CODE,
  invitationCodeCreatedAt: new Date(),
  createdAt: CREATED_AT,
  ...over,
});

/** An invite-link row: no expiry, exactly as every mint path writes one. */
const linkRow = (over: Record<string, unknown> = {}) => {
  const createdAt = (over.createdAt as Date) ?? new Date();
  return {
    id: "f".repeat(24),
    code: STORED_CODE,
    communityId: CID,
    createdBy: CALLER,
    maxUses: null,
    usedCount: 0,
    autoApprove: false,
    expiresAt: null,
    revokedAt: null,
    ...over,
    createdAt,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
  repo.findLatestReusableInviteLink.mockResolvedValue(null);
  repo.createInviteLink.mockImplementation(
    async (data: Record<string, unknown>) =>
      // Mongo stamps `createdAt` itself.
      linkRow({ ...data, createdAt: new Date() })
  );
});

// ---------------------------------------------------------------------------
// Minting: a fresh link with no expiry
// ---------------------------------------------------------------------------

describe("getOrCreatePermanentInvitationLink — minting", () => {
  it("mints a link with no expiry when none is live", async () => {
    repo.findById.mockResolvedValue(community());

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(repo.createInviteLink).toHaveBeenCalledTimes(1);
    expect(repo.createInviteLink.mock.calls[0][0].expiresAt).toBeNull();
    expect(res.expiresAt).toBeNull();
  });

  it("mints a code with sufficient entropy (>= 20 url-safe chars)", async () => {
    repo.findById.mockResolvedValue(community());

    await communityService.getOrCreatePermanentInvitationLink(CID, CALLER);

    expect(repo.createInviteLink.mock.calls[0][0].code).toMatch(
      /^[A-Za-z0-9_-]{20,}$/
    );
  });

  it("never mints a limited-use or auto-approve link", async () => {
    repo.findById.mockResolvedValue(community());

    await communityService.getOrCreatePermanentInvitationLink(CID, CALLER);

    const written = repo.createInviteLink.mock.calls[0][0];
    expect(written.maxUses).toBeNull();
    expect(written.autoApprove).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reuse inside the 1-hour window, rollover after it
// ---------------------------------------------------------------------------

describe("getOrCreatePermanentInvitationLink — reuse within the window", () => {
  it("returns the live link WITHOUT minting a new one", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findLatestReusableInviteLink.mockResolvedValue(linkRow());

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(res.invitationCode).toBe(STORED_CODE);
    expect(repo.createInviteLink).not.toHaveBeenCalled();
  });

  it("100 consecutive calls all return the SAME code and never mint", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findLatestReusableInviteLink.mockResolvedValue(linkRow());

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        communityService.getOrCreatePermanentInvitationLink(CID, CALLER)
      )
    );

    expect(new Set(results.map((r) => r.invitationCode)).size).toBe(1);
    expect(repo.createInviteLink).not.toHaveBeenCalled();
  });

  it("mints a NEW code once the previous link has expired", async () => {
    repo.findById.mockResolvedValue(community());
    // The repository filters expired rows out, so an expired link reads as null.
    repo.findLatestReusableInviteLink.mockResolvedValue(null);

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(repo.createInviteLink).toHaveBeenCalledTimes(1);
    expect(res.invitationCode).toBe(
      repo.createInviteLink.mock.calls[0][0].code
    );
  });

  it("the invitation URL is the established aimess.me/+<code> scheme", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findLatestReusableInviteLink.mockResolvedValue(linkRow());

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(res.invitationLink).toBe(`${BASE}/+${STORED_CODE}`);
    expect(res.appDeepLink).toBe(`aimess://join?code=${STORED_CODE}`);
  });

  it("returns createdAt / expiresAt as epoch milliseconds", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findLatestReusableInviteLink.mockResolvedValue(
      linkRow({ createdAt: CREATED_AT })
    );

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(res.createdAt).toBe(CREATED_AT.getTime());
    expect(res.expiresAt).toBeNull();
    expect(Number.isInteger(res.createdAt)).toBe(true);
  });

  it("a renamed community still returns the live link (no regeneration)", async () => {
    repo.findById.mockResolvedValue(community({ name: "Renamed Community" }));
    repo.findLatestReusableInviteLink.mockResolvedValue(linkRow());

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(res.invitationCode).toBe(STORED_CODE);
    expect(res.communityName).toBe("Renamed Community");
    expect(repo.createInviteLink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Authorization & privacy guards
// ---------------------------------------------------------------------------

describe("getOrCreatePermanentInvitationLink — guards", () => {
  it("rejects a PUBLIC community with COMMUNITY_NOT_PRIVATE", async () => {
    repo.findById.mockResolvedValue(community({ type: "PUBLIC" }));

    await expect(
      communityService.getOrCreatePermanentInvitationLink(CID, CALLER)
    ).rejects.toThrow("COMMUNITY_NOT_PRIVATE");
    expect(repo.createInviteLink).not.toHaveBeenCalled();
  });

  it("rejects a missing community with COMMUNITY_NOT_FOUND", async () => {
    repo.findById.mockResolvedValue(null);

    await expect(
      communityService.getOrCreatePermanentInvitationLink(CID, CALLER)
    ).rejects.toThrow("COMMUNITY_NOT_FOUND");
  });

  it("rejects a non-member caller", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findMembership.mockResolvedValue(null);

    await expect(
      communityService.getOrCreatePermanentInvitationLink(CID, CALLER)
    ).rejects.toThrow();
    expect(repo.createInviteLink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: redeem accepts a LEGACY permanent code, but only
// inside its own 1-hour window.
// ---------------------------------------------------------------------------

describe("redeemInviteLink — legacy permanent-code fallback", () => {
  const member = {
    id: "m".repeat(24),
    communityId: CID,
    userId: CALLER,
    role: "MEMBER",
    status: "ACTIVE",
    snapshotUsername: "alice",
    snapshotDisplayName: "Alice",
    snapshotAvatarKey: null,
    joinedAt: CREATED_AT,
  };

  it("consults the permanent-code table when no invite-link row exists, and is idempotent for an existing member", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(null);
    repo.findCommunityByInvitationCode.mockResolvedValue(community());
    repo.findMemberByUserId.mockResolvedValue(member);

    const res = await communityService.redeemInviteLink(STORED_CODE, CALLER);

    expect(repo.findCommunityByInvitationCode).toHaveBeenCalledWith(
      STORED_CODE
    );
    expect(res.link.code).toBe(STORED_CODE);
    expect(res.link.linkType).toBe("PRIVATE_INVITE");
    expect(res.member?.userId).toBe(CALLER);
  });

  it("still honours an ancient permanent code — age alone never kills a link", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(null);
    repo.findCommunityByInvitationCode.mockResolvedValue(
      community({
        invitationCodeCreatedAt: new Date(Date.now() - 30 * 24 * HOUR_MS),
      })
    );
    repo.findMemberByUserId.mockResolvedValue(null);

    // Age is the only thing under test: whatever the join path does next, it
    // must not be refused as an expired link.
    await expect(
      communityService.redeemInviteLink(STORED_CODE, CALLER)
    ).rejects.not.toThrow("COMMUNITY_INVITE_LINK_EXPIRED");
  });

  it("an ACTIVE member re-tapping an ancient permanent code is still idempotent", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(null);
    repo.findCommunityByInvitationCode.mockResolvedValue(
      community({
        invitationCodeCreatedAt: new Date(Date.now() - 30 * 24 * HOUR_MS),
      })
    );
    repo.findMemberByUserId.mockResolvedValue(member);

    const res = await communityService.redeemInviteLink(STORED_CODE, CALLER);
    expect(res.member).toBeDefined();
  });

  it("throws COMMUNITY_INVITE_LINK_NOT_FOUND when neither a link row nor a permanent code matches", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(null);
    repo.findCommunityByInvitationCode.mockResolvedValue(null);

    await expect(
      communityService.redeemInviteLink("totally-unknown-code", CALLER)
    ).rejects.toThrow("COMMUNITY_INVITE_LINK_NOT_FOUND");
  });

  // A link lives until it is revoked. Rows stamped with an expiry by an older
  // build must therefore still redeem — the clock is not a reason any more.
  it("redeems a row carrying a past expiresAt stamped by an older build", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(
      linkRow({
        createdAt: new Date(Date.now() - 2 * HOUR_MS),
        expiresAt: new Date(Date.now() - HOUR_MS),
      })
    );

    const res = await communityService.redeemInviteLink(STORED_CODE, CALLER);
    expect(res.member ?? res.request).toBeDefined();
  });

  it("still refuses a REVOKED invite-link row", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(
      linkRow({ revokedAt: new Date(Date.now() - 60_000) })
    );

    await expect(
      communityService.redeemInviteLink(STORED_CODE, CALLER)
    ).rejects.toThrow("COMMUNITY_INVITE_LINK_REVOKED_ERROR");
  });
});

// ---------------------------------------------------------------------------
// POST /:id/invite-links — bare call = the community's live link, params = custom
// ---------------------------------------------------------------------------

describe("createInviteLink — bare PRIVATE call returns the live link", () => {
  it("a bare {} call mints a never-expiring link shaped as CommunityInviteLinkData", async () => {
    repo.findById.mockResolvedValue(community());

    const link = await communityService.createInviteLink(CID, CALLER, {});

    expect(link.linkType).toBe("PRIVATE_INVITE");
    expect(link.url).toBe(`${BASE}/+${link.code}`);
    expect(link.appDeepLink).toBe(`aimess://join?code=${link.code}`);
    expect(link.maxUses).toBeNull();
    expect(link.revokedAt).toBeNull();
    expect(link.autoApprove).toBe(false);
    expect(link.isActive).toBe(true);
    expect(link.expiresAt).toBeNull();
  });

  it("repeated bare calls return the SAME code and create NO extra rows", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findLatestReusableInviteLink.mockResolvedValue(linkRow());

    const first = await communityService.createInviteLink(CID, CALLER, {});
    const second = await communityService.createInviteLink(CID, CALLER, {});
    const third = await communityService.createInviteLink(CID, CALLER, {});

    expect(first.code).toBe(STORED_CODE);
    expect(second.code).toBe(STORED_CODE);
    expect(third.code).toBe(STORED_CODE);
    expect(repo.createInviteLink).not.toHaveBeenCalled();
  });

  it("the bare call does NOT consume the per-member active-link cap", async () => {
    repo.findById.mockResolvedValue(community());
    repo.findLatestReusableInviteLink.mockResolvedValue(linkRow());

    await communityService.createInviteLink(CID, CALLER, {});

    expect(repo.countActiveInviteLinksByCreator).not.toHaveBeenCalled();
  });
});

describe("createInviteLink — parameterized call still creates a CUSTOM link", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(community());
    repo.countActiveInviteLinksByCreator.mockResolvedValue(0);
  });

  it("maxUses present → creates a fresh row", async () => {
    const link = await communityService.createInviteLink(CID, CALLER, {
      maxUses: 5,
    });

    expect(repo.createInviteLink).toHaveBeenCalledTimes(1);
    expect(link.maxUses).toBe(5);
    expect(link.isPermanent).toBe(false);
  });

  it("writes no expiry at all — a link dies only when it is revoked", async () => {
    await communityService.createInviteLink(CID, CALLER, { maxUses: 5 });

    const written = repo.createInviteLink.mock.calls[0][0];
    expect(written.expiresAt).toBeNull();
  });
});
