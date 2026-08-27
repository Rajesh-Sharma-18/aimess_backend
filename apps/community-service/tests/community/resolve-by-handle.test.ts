/**
 * Service-layer tests for the Sharing & Deep-Linking backend deltas:
 *   - communityService.getByHandle()        (public deep-link resolver)
 *   - communityService.getPublicCard()       (internal OG-card lookup)
 *   - communityService.createInviteLink()    (request-to-join default flip)
 *
 * Only the I/O boundary is mocked (repository + image resolver); the real
 * service logic — PUBLIC-only gating, ban handling, autoApprove default — runs.
 */

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findByHandleFull: jest.fn(),
    findMembership: jest.fn(),
    findById: jest.fn(),
    countActiveInviteLinksByCreator: jest.fn(async () => 0),
    createInviteLink: jest.fn(),
    findLatestReusableInviteLink: jest.fn(async () => null),
    createAuditLog: jest.fn(),
    // The atomic first-writer guard behind `ensurePermanentInvitationCode`
    // (updateMany WHERE invitationCode IS NULL). It was missing from this
    // mock, so every path that mints a permanent code threw
    // "setInvitationCodeOnce is not a function" instead of exercising the
    // branch under test. `count: 1` = this caller won the race.
    setInvitationCodeOnce: jest.fn(async () => ({ count: 1 })),
  },
}));

jest.mock("../../src/services/community-image.service.js", () => ({
  communityImageService: {
    resolveViewUrlForClient: jest.fn(async () => ({
      url: null,
      expiresIn: null,
    })),
  },
}));

import { BadRequestError, ForbiddenError, NotFoundError } from "@aimess/errors";

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CID = "c".repeat(24);
const CALLER = "99999999-9999-4999-8999-999999999999";

const publicCommunity = {
  id: CID,
  name: "Backend Devs",
  handle: "backend_devs",
  description: "All things backend",
  type: "PUBLIC",
  adminId: CALLER,
  memberCount: 42,
  avatarUrl: null,
  coverUrl: null,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
  // A real row always carries these. Without `createdAt` the permanent-link
  // projection (`invitationCodeCreatedAt ?? createdAt`) called `.toISOString()`
  // on undefined; with the code already minted, the invite path takes its fast
  // path instead of re-running the first-writer race against a stubbed re-read.
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  invitationCode: "permanentcode123456789012",
  invitationCodeCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getByHandle", () => {
  it("returns a PublicCommunityResponse for a public handle (non-member)", async () => {
    repo.findByHandleFull.mockResolvedValue(publicCommunity);
    repo.findMembership.mockResolvedValue(null);

    const res = await communityService.getByHandle("backend_devs", CALLER);

    expect(res.type).toBe("PUBLIC");
    expect(res.communityId).toBe(CID);
    expect(res.isJoined).toBe(false);
    expect(res.role).toBeNull();
    expect(res.isBanned).toBe(false);
  });

  it("returns server-built canonical shareUrl + appDeepLink (public form, no + marker)", async () => {
    repo.findByHandleFull.mockResolvedValue(publicCommunity);
    repo.findMembership.mockResolvedValue(null);

    const res = await communityService.getByHandle("backend_devs", CALLER);

    // Deep link is env-independent → assert exactly.
    expect(res.appDeepLink).toBe("aimess://resolve?handle=backend_devs");
    // Share URL = <INVITE_LINK_BASE_URL>/<handle>; the base can vary by env, but
    // the PUBLIC form carries NO "+" marker (that prefix is the PRIVATE code case)
    // and always ends in the bare handle.
    expect(res.shareUrl).toMatch(/(^|\/)backend_devs$/);
    expect(res.shareUrl).not.toContain("+");
  });

  it("reports isJoined + role for an active member", async () => {
    repo.findByHandleFull.mockResolvedValue(publicCommunity);
    repo.findMembership.mockResolvedValue({
      status: "ACTIVE",
      role: "MODERATOR",
    });

    const res = await communityService.getByHandle("backend_devs", CALLER);
    expect(res.isJoined).toBe(true);
    expect(res.role).toBe("MODERATOR");
  });

  it("404s a PRIVATE community (never revealed by handle)", async () => {
    repo.findByHandleFull.mockResolvedValue({
      ...publicCommunity,
      type: "PRIVATE",
    });
    await expect(
      communityService.getByHandle("backend_devs", CALLER)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s a suspended community", async () => {
    repo.findByHandleFull.mockResolvedValue({
      ...publicCommunity,
      moderationStatus: "SUSPENDED",
    });
    await expect(
      communityService.getByHandle("backend_devs", CALLER)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s an owner-CLOSED community (no join CTA for an unjoinable community)", async () => {
    repo.findByHandleFull.mockResolvedValue({
      ...publicCommunity,
      status: "CLOSED",
    });
    await expect(
      communityService.getByHandle("backend_devs", CALLER)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s a missing handle", async () => {
    repo.findByHandleFull.mockResolvedValue(null);
    await expect(
      communityService.getByHandle("backend_devs", CALLER)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("403s a banned caller", async () => {
    repo.findByHandleFull.mockResolvedValue(publicCommunity);
    repo.findMembership.mockResolvedValue({ status: "BANNED", role: "MEMBER" });
    await expect(
      communityService.getByHandle("backend_devs", CALLER)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("400s a malformed handle without a DB hit", async () => {
    await expect(
      communityService.getByHandle("ab", CALLER)
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(repo.findByHandleFull).not.toHaveBeenCalled();
  });
});

describe("getPublicCard", () => {
  it("returns minimal metadata for a public community", async () => {
    repo.findByHandleFull.mockResolvedValue(publicCommunity);
    const card = await communityService.getPublicCard("backend_devs");
    expect(card).toEqual({
      communityId: CID,
      name: "Backend Devs",
      description: "All things backend",
      avatarUrl: null,
      bannerUrl: null,
      memberCount: 42,
    });
  });

  it("404s a private community", async () => {
    repo.findByHandleFull.mockResolvedValue({
      ...publicCommunity,
      type: "PRIVATE",
    });
    await expect(
      communityService.getPublicCard("backend_devs")
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("createInviteLink — request-to-join default", () => {
  const linkRow = {
    id: "l".repeat(24),
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

  // The assertion moved, the intent did not: a bare call must never silently
  // auto-approve. A parameterless call on a PRIVATE community returns that
  // community's live (1-hour) invite link — reused when one is still valid,
  // minted as a plain request-to-join link otherwise. The legacy row-creating
  // path is still asserted by the explicit-autoApprove case below.
  it("defaults autoApprove=false for a PRIVATE community when not specified", async () => {
    repo.findById.mockResolvedValue({ ...publicCommunity, type: "PRIVATE" });
    repo.findMembership.mockResolvedValue({ status: "ACTIVE", role: "ADMIN" });
    repo.findLatestReusableInviteLink.mockResolvedValue({
      ...linkRow,
      autoApprove: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const link = await communityService.createInviteLink(CID, CALLER, {});

    expect(link.autoApprove).toBe(false);
    // Idempotent by construction: a bare call consumes no link quota.
    expect(repo.createInviteLink).not.toHaveBeenCalled();
  });

  it("respects an explicit autoApprove=true", async () => {
    repo.findById.mockResolvedValue({ ...publicCommunity, type: "PRIVATE" });
    repo.findMembership.mockResolvedValue({ status: "ACTIVE", role: "ADMIN" });
    repo.createInviteLink.mockResolvedValue({ ...linkRow, autoApprove: true });

    await communityService.createInviteLink(CID, CALLER, { autoApprove: true });

    expect(repo.createInviteLink).toHaveBeenCalledWith(
      expect.objectContaining({ autoApprove: true })
    );
  });
});
