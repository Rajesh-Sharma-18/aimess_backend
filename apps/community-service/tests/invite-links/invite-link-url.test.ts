/**
 * Service-layer tests for PRIVACY-BASED invite/share URL generation.
 *
 * The primary `url`/`appDeepLink` returned by every invite-link surface
 * (create / list / bulk-send / redeem) is driven by the community's privacy via
 * the centralized `resolveCommunityShareLink` helper inside `toInviteLinkData`:
 *
 *   • PUBLIC  → handle-based, deterministic, code-INDEPENDENT
 *               url = <base>/<handle>, deepLink = aimess://resolve?handle=<handle>
 *               linkType = "PUBLIC_HANDLE"
 *   • PRIVATE → invite-code-based (unchanged legacy behavior)
 *               url = <base>/+<code>, deepLink = aimess://join?code=<code>
 *               linkType = "PRIVATE_INVITE"
 *
 * Only the I/O boundary is mocked (repository, user-client, storage, publishers).
 * The per-user Redis rate limit fails open under test (cache not ready).
 */

jest.mock("../../src/lib/user-client.js", () => ({
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
  publishCommunityRoomEvent: jest.fn(async () => 1),
  publishChatUserEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    countActiveInviteLinksByCreator: jest.fn(),
    createInviteLink: jest.fn(),
    createAuditLog: jest.fn(),
    listInviteLinks: jest.fn(),
    findInviteLinkById: jest.fn(),
    findMembersByUserIds: jest.fn(),
  },
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { env } from "../../src/config/env.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const BASE = env.INVITE_LINK_BASE_URL;

const CID = "a".repeat(24);
const LINK_ID = "b".repeat(24);
const CALLER = "99999999-9999-4999-8999-999999999999";
const RECIPIENT = "885ad4e0-e238-4f9a-9773-e215321885b4";
const HANDLE = "tech_community";

const makeCommunity = (
  type: "PUBLIC" | "PRIVATE",
  over: Record<string, unknown> = {}
) => ({
  id: CID,
  name: "Tech Community",
  handle: HANDLE,
  avatarUrl: null,
  coverUrl: null,
  type,
  adminId: "11111111-1111-4111-8111-111111111111",
  memberCount: 5,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
  deletedAt: null,
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: LINK_ID,
  code: "AbCdEf123",
  communityId: CID,
  createdBy: CALLER,
  maxUses: null,
  usedCount: 0,
  autoApprove: false,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date("2026-06-24T00:00:00.000Z"),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
  repo.countActiveInviteLinksByCreator.mockResolvedValue(0);
  // Echo the service-generated code back so determinism tests can vary it.
  repo.createInviteLink.mockImplementation(
    async (data: Record<string, unknown>) =>
      row({
        code: data.code,
        createdBy: data.createdBy,
        communityId: data.communityId,
        maxUses: data.maxUses ?? null,
        autoApprove: data.autoApprove ?? false,
        expiresAt: data.expiresAt ?? null,
      })
  );
});

// ---------------------------------------------------------------------------
// PUBLIC community → handle-based URL
// ---------------------------------------------------------------------------

describe("createInviteLink — PUBLIC community returns a handle-based URL", () => {
  beforeEach(() => repo.findById.mockResolvedValue(makeCommunity("PUBLIC")));

  it("url/appDeepLink/linkType are handle-derived, not code-derived", async () => {
    const link = await communityService.createInviteLink(CID, CALLER, {});

    expect(link.linkType).toBe("PUBLIC_HANDLE");
    expect(link.url).toBe(`${BASE}/${HANDLE}`);
    expect(link.appDeepLink).toBe(`aimess://resolve?handle=${HANDLE}`);
    // The primary share URL must never expose the invite code for a PUBLIC community.
    expect(link.url).not.toContain(link.code);
    expect(link.appDeepLink).not.toContain(link.code);
    // No `+` private-link marker in a public handle URL.
    expect(link.url).not.toContain("/+");
  });

  it("is DETERMINISTIC across repeated calls even when the underlying code differs", async () => {
    const first = await communityService.createInviteLink(CID, CALLER, {});
    const second = await communityService.createInviteLink(CID, CALLER, {});

    // Two distinct invite rows (different codes) …
    expect(first.code).not.toBe(second.code);
    // … but the handle-based share URL is identical.
    expect(first.url).toBe(second.url);
    expect(first.appDeepLink).toBe(second.appDeepLink);
    expect(first.url).toBe(`${BASE}/${HANDLE}`);
  });

  it("still persists an invite row (code/expiry retained for bulk-send & redeem parity)", async () => {
    const link = await communityService.createInviteLink(CID, CALLER, {
      maxUses: 50,
      expiresInMinutes: 60,
    });

    expect(repo.createInviteLink).toHaveBeenCalledTimes(1);
    expect(link.code).toBeTruthy(); // code still issued + returned …
    expect(link.maxUses).toBe(50);
    expect(link.url).toBe(`${BASE}/${HANDLE}`); // … just not in the share URL.
  });
});

describe("createInviteLink — PUBLIC handle validation", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
  ])(
    "a PUBLIC community with a %s handle → COMMUNITY_HANDLE_REQUIRED (no broken URL)",
    async (_label, handle) => {
      repo.findById.mockResolvedValue(makeCommunity("PUBLIC", { handle }));

      await expect(
        communityService.createInviteLink(CID, CALLER, {})
      ).rejects.toThrow("COMMUNITY_HANDLE_REQUIRED");
    }
  );
});

describe("listInviteLinks — PUBLIC rows are handle-based and code-free in the URL", () => {
  beforeEach(() => repo.findById.mockResolvedValue(makeCommunity("PUBLIC")));

  it("every listed row maps to the same handle-based URL", async () => {
    repo.listInviteLinks.mockResolvedValue({
      rows: [
        row({ code: "code_one" }),
        row({ id: "c".repeat(24), code: "code_two" }),
      ],
      total: 2,
    });

    const res = await communityService.listInviteLinks(CID, CALLER, {
      page: 1,
      limit: 20,
    });

    for (const item of res.data) {
      expect(item.linkType).toBe("PUBLIC_HANDLE");
      expect(item.url).toBe(`${BASE}/${HANDLE}`);
      expect(item.url).not.toContain(item.code);
    }
  });
});

describe("bulkSendInviteLink — PUBLIC returned link is handle-based", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(makeCommunity("PUBLIC"));
    repo.findInviteLinkById.mockResolvedValue(row());
    repo.findMembersByUserIds.mockResolvedValue([]);
  });

  it("link.url/linkType reflect the public handle, not the invite code", async () => {
    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [RECIPIENT],
      linkId: LINK_ID,
    });

    expect(res.link.linkType).toBe("PUBLIC_HANDLE");
    expect(res.link.url).toBe(`${BASE}/${HANDLE}`);
    expect(res.link.url).not.toContain(res.link.code);
  });
});

// ---------------------------------------------------------------------------
// PRIVATE community → invite-code URL (legacy behavior preserved)
// ---------------------------------------------------------------------------

describe("createInviteLink — PRIVATE community keeps the invite-code URL", () => {
  beforeEach(() => repo.findById.mockResolvedValue(makeCommunity("PRIVATE")));

  it("url/appDeepLink/linkType are code-derived with the `+` private marker", async () => {
    const link = await communityService.createInviteLink(CID, CALLER, {});

    expect(link.linkType).toBe("PRIVATE_INVITE");
    expect(link.url).toBe(`${BASE}/+${link.code}`);
    expect(link.appDeepLink).toBe(`aimess://join?code=${link.code}`);
    expect(link.url).toContain(link.code);
  });

  it("a PRIVATE community does NOT require a handle to build the URL", async () => {
    repo.findById.mockResolvedValue(makeCommunity("PRIVATE", { handle: "" }));

    const link = await communityService.createInviteLink(CID, CALLER, {});
    expect(link.linkType).toBe("PRIVATE_INVITE");
    expect(link.url).toBe(`${BASE}/+${link.code}`);
  });
});

describe("bulkSendInviteLink — PRIVATE returned link keeps the code URL", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(makeCommunity("PRIVATE"));
    repo.findInviteLinkById.mockResolvedValue(row({ code: "secret_code" }));
    repo.findMembersByUserIds.mockResolvedValue([]);
  });

  it("link.url/linkType carry the invite code", async () => {
    const res = await communityService.bulkSendInviteLink(CID, CALLER, {
      userIds: [RECIPIENT],
      linkId: LINK_ID,
    });

    expect(res.link.linkType).toBe("PRIVATE_INVITE");
    expect(res.link.url).toBe(`${BASE}/+secret_code`);
    expect(res.link.appDeepLink).toBe("aimess://join?code=secret_code");
  });
});
