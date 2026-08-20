/**
 * Service-layer tests for the PERMANENT community invitation link
 * (`communityService.getOrCreatePermanentInvitationLink`).
 *
 * Contract under test (single source of truth):
 *  - The invitation code lives on the Community row (`invitationCode`).
 *  - It is generated EXACTLY ONCE, on the first call, via the atomic
 *    `setInvitationCodeOnce` guard (updateMany WHERE invitationCode IS NULL).
 *  - Every subsequent call is a pure read — no write, same code, same URL.
 *  - PRIVATE communities only; PUBLIC → COMMUNITY_NOT_PRIVATE.
 *  - The URL scheme is the established Telegram-style `<base>/+<code>` +
 *    `aimess://join?code=<code>` (NOT a per-call regenerated link).
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

/** A community that already has its permanent code persisted. */
const withCode = (over: Record<string, unknown> = {}) => ({
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
  invitationCodeCreatedAt: CREATED_AT,
  createdAt: CREATED_AT,
  ...over,
});

/** A brand-new community with no permanent code yet. */
const withoutCode = (over: Record<string, unknown> = {}) =>
  withCode({ invitationCode: null, invitationCodeCreatedAt: null, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
});

// ---------------------------------------------------------------------------
// Generation: exactly once, on the first call
// ---------------------------------------------------------------------------

describe("getOrCreatePermanentInvitationLink — first-call generation", () => {
  it("generates and persists a code on the first call, then returns it", async () => {
    // First findById → no code; setInvitationCodeOnce wins; re-read → code.
    repo.findById
      .mockResolvedValueOnce(withoutCode())
      .mockResolvedValueOnce(withCode());
    repo.setInvitationCodeOnce.mockResolvedValue({ count: 1 });

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(repo.setInvitationCodeOnce).toHaveBeenCalledTimes(1);
    expect(res.invitationCode).toBe(STORED_CODE);
    expect(res.communityId).toBe(CID);
    expect(res.communityName).toBe("Tech Community");
  });

  it("generates a code with sufficient entropy (>= 20 url-safe chars)", async () => {
    let generated = "";
    // setInvitationCodeOnce captures the candidate and reports a win.
    repo.setInvitationCodeOnce.mockImplementation(
      async (_id: string, code: string) => {
        generated = code;
        return { count: 1 };
      }
    );
    // 1st findById → no code; 2nd findById (post-write re-read) → captured code.
    repo.findById.mockImplementation(async () =>
      generated ? withCode({ invitationCode: generated }) : withoutCode()
    );

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    // base64url, 16 bytes → ~22 chars, no '+' '/' '=' padding.
    expect(generated).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(res.invitationCode).toBe(generated);
  });
});

// ---------------------------------------------------------------------------
// Idempotency: same code forever, no extra writes (single source of truth)
// ---------------------------------------------------------------------------

describe("getOrCreatePermanentInvitationLink — idempotent reads", () => {
  it("returns the existing code WITHOUT any write on subsequent calls", async () => {
    repo.findById.mockResolvedValue(withCode());

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(res.invitationCode).toBe(STORED_CODE);
    // The fast path must never touch the DB for writes.
    expect(repo.setInvitationCodeOnce).not.toHaveBeenCalled();
  });

  it("100 consecutive calls all return the SAME code and write zero times", async () => {
    repo.findById.mockResolvedValue(withCode());

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        communityService.getOrCreatePermanentInvitationLink(CID, CALLER)
      )
    );

    const codes = new Set(results.map((r) => r.invitationCode));
    expect(codes.size).toBe(1);
    expect([...codes][0]).toBe(STORED_CODE);
    expect(repo.setInvitationCodeOnce).not.toHaveBeenCalled();
  });

  it("the invitation URL is the established aimess.me/+<code> scheme", async () => {
    repo.findById.mockResolvedValue(withCode());

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(res.invitationLink).toBe(`${BASE}/+${STORED_CODE}`);
    expect(res.appDeepLink).toBe(`aimess://join?code=${STORED_CODE}`);
  });

  it("returns createdAt as epoch milliseconds", async () => {
    repo.findById.mockResolvedValue(withCode());

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(res.createdAt).toBe(CREATED_AT.getTime());
    expect(Number.isInteger(res.createdAt)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stability across community lifecycle (rename / avatar / close-open)
// ---------------------------------------------------------------------------

describe("getOrCreatePermanentInvitationLink — code is stable across mutations", () => {
  it("a renamed community still returns the original code (no regeneration)", async () => {
    // Simulate the community AFTER a rename — same stored code, new name.
    repo.findById.mockResolvedValue(withCode({ name: "Renamed Community" }));

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(res.invitationCode).toBe(STORED_CODE);
    expect(res.communityName).toBe("Renamed Community");
    expect(repo.setInvitationCodeOnce).not.toHaveBeenCalled();
  });

  it("a CLOSED-then-reopened community still returns the original code", async () => {
    repo.findById.mockResolvedValue(withCode({ status: "ACTIVE" }));

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(res.invitationCode).toBe(STORED_CODE);
    expect(repo.setInvitationCodeOnce).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Concurrency: only one code wins the race
// ---------------------------------------------------------------------------

describe("getOrCreatePermanentInvitationLink — concurrent first-write race", () => {
  it("a loser of the atomic guard re-reads and returns the winner's code", async () => {
    // 1st findById: no code yet (both callers saw null).
    // setInvitationCodeOnce: returns 0 — another caller already wrote.
    // 2nd findById (re-read): the winner's code is now present.
    repo.findById
      .mockResolvedValueOnce(withoutCode())
      .mockResolvedValueOnce(withCode({ invitationCode: "winner_code_xyz" }));
    repo.setInvitationCodeOnce.mockResolvedValue({ count: 0 });

    const res = await communityService.getOrCreatePermanentInvitationLink(
      CID,
      CALLER
    );

    expect(res.invitationCode).toBe("winner_code_xyz");
    // We attempted the write once, lost, and did NOT loop-write again.
    expect(repo.setInvitationCodeOnce).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Authorization & privacy guards
// ---------------------------------------------------------------------------

describe("getOrCreatePermanentInvitationLink — guards", () => {
  it("rejects a PUBLIC community with COMMUNITY_NOT_PRIVATE", async () => {
    repo.findById.mockResolvedValue(withCode({ type: "PUBLIC" }));

    await expect(
      communityService.getOrCreatePermanentInvitationLink(CID, CALLER)
    ).rejects.toThrow("COMMUNITY_NOT_PRIVATE");
    expect(repo.setInvitationCodeOnce).not.toHaveBeenCalled();
  });

  it("rejects a missing community with COMMUNITY_NOT_FOUND", async () => {
    repo.findById.mockResolvedValue(null);

    await expect(
      communityService.getOrCreatePermanentInvitationLink(CID, CALLER)
    ).rejects.toThrow("COMMUNITY_NOT_FOUND");
  });

  it("rejects a non-member caller", async () => {
    repo.findById.mockResolvedValue(withCode());
    repo.findMembership.mockResolvedValue(null);

    await expect(
      communityService.getOrCreatePermanentInvitationLink(CID, CALLER)
    ).rejects.toThrow();
    expect(repo.setInvitationCodeOnce).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: redeem accepts the permanent code
// ---------------------------------------------------------------------------

describe("redeemInviteLink — permanent-code fallback", () => {
  it("consults the permanent-code table when no invite-link row exists, and is idempotent for an existing member", async () => {
    // No CommunityInviteLink row for this code → fall through to the community.
    repo.findInviteLinkByCode.mockResolvedValue(null);
    repo.findCommunityByInvitationCode.mockResolvedValue(withCode());
    // Caller is ALREADY an active member → idempotent early-return (no join request,
    // no usage burn), which keeps this test off the createJoinRequest machinery.
    repo.findMemberByUserId.mockResolvedValue({
      id: "m".repeat(24),
      communityId: CID,
      userId: CALLER,
      role: "MEMBER",
      status: "ACTIVE",
      snapshotUsername: "alice",
      snapshotDisplayName: "Alice",
      snapshotAvatarKey: null,
      joinedAt: CREATED_AT,
    });

    const res = await communityService.redeemInviteLink(STORED_CODE, CALLER);

    expect(repo.findCommunityByInvitationCode).toHaveBeenCalledWith(
      STORED_CODE
    );
    expect(res.link.code).toBe(STORED_CODE);
    expect(res.link.linkType).toBe("PRIVATE_INVITE");
    expect(res.member?.userId).toBe(CALLER);
  });

  it("throws COMMUNITY_INVITE_LINK_NOT_FOUND when neither a link row nor a permanent code matches", async () => {
    repo.findInviteLinkByCode.mockResolvedValue(null);
    repo.findCommunityByInvitationCode.mockResolvedValue(null);

    await expect(
      communityService.redeemInviteLink("totally-unknown-code", CALLER)
    ).rejects.toThrow("COMMUNITY_INVITE_LINK_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Hybrid POST /:id/invite-links — bare call = permanent SSOT, params = temp link
// ---------------------------------------------------------------------------

describe("createInviteLink — bare PRIVATE call returns the PERMANENT link (SSOT)", () => {
  it("a bare {} call mints the permanent code and shapes it as CommunityInviteLinkData", async () => {
    repo.findById
      .mockResolvedValueOnce(withoutCode()) // initial load: no code yet
      .mockResolvedValueOnce(withCode()); // post-write re-read: code present
    repo.setInvitationCodeOnce.mockResolvedValue({ count: 1 });

    const link = await communityService.createInviteLink(CID, CALLER, {});

    expect(link.code).toBe(STORED_CODE);
    expect(link.linkType).toBe("PRIVATE_INVITE");
    expect(link.url).toBe(`${BASE}/+${STORED_CODE}`);
    expect(link.appDeepLink).toBe(`aimess://join?code=${STORED_CODE}`);
    // Permanent links use communityId as linkId (no real CommunityInviteLink row).
    expect(link.linkId).toBe(CID);
    expect(link.isPermanent).toBe(true);
    // Permanent links are unlimited, never-expiring, never-revoked, request-to-join.
    expect(link.maxUses).toBeNull();
    expect(link.expiresAt).toBeNull();
    expect(link.revokedAt).toBeNull();
    expect(link.autoApprove).toBe(false);
    expect(link.isActive).toBe(true);
  });

  it("repeated bare calls return the SAME code and create NO invite-link rows", async () => {
    repo.findById.mockResolvedValue(withCode()); // code already present every read

    const first = await communityService.createInviteLink(CID, CALLER, {});
    const second = await communityService.createInviteLink(CID, CALLER, {});
    const third = await communityService.createInviteLink(CID, CALLER, {});

    expect(first.code).toBe(STORED_CODE);
    expect(second.code).toBe(STORED_CODE);
    expect(third.code).toBe(STORED_CODE);
    // The legacy multi-link create path is never touched on the bare/default call.
    expect(repo.createInviteLink).not.toHaveBeenCalled();
    expect(repo.setInvitationCodeOnce).not.toHaveBeenCalled();
  });

  it("the bare call does NOT consume the per-member active-link cap", async () => {
    repo.findById.mockResolvedValue(withCode());

    await communityService.createInviteLink(CID, CALLER, {});

    // Rate-limit / cap guards live AFTER the SSOT short-circuit — never reached.
    expect(repo.countActiveInviteLinksByCreator).not.toHaveBeenCalled();
  });
});

describe("createInviteLink — parameterized call still creates a TEMPORARY link", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(withCode());
    repo.countActiveInviteLinksByCreator.mockResolvedValue(0);
    repo.createInviteLink.mockImplementation(
      async (data: Record<string, unknown>) => ({
        id: "f".repeat(24),
        code: data.code,
        communityId: data.communityId,
        createdBy: data.createdBy,
        maxUses: data.maxUses ?? null,
        usedCount: 0,
        autoApprove: data.autoApprove ?? false,
        expiresAt: data.expiresAt ?? null,
        revokedAt: null,
        createdAt: CREATED_AT,
      })
    );
  });

  it("maxUses present → creates a fresh row (NOT the permanent code)", async () => {
    const link = await communityService.createInviteLink(CID, CALLER, {
      maxUses: 5,
    });

    expect(repo.createInviteLink).toHaveBeenCalledTimes(1);
    expect(repo.setInvitationCodeOnce).not.toHaveBeenCalled();
    expect(link.maxUses).toBe(5);
    // A real row id — not the permanent link.
    expect(link.isPermanent).toBe(false);
    // The temporary link's code is freshly generated, not the stored permanent one.
    expect(link.code).not.toBe(STORED_CODE);
  });

  it("expiresInMinutes present → creates an expiring row", async () => {
    const link = await communityService.createInviteLink(CID, CALLER, {
      expiresInMinutes: 60,
    });

    expect(repo.createInviteLink).toHaveBeenCalledTimes(1);
    expect(link.expiresAt).not.toBeNull();
    expect(link.isPermanent).toBe(false);
  });
});
