/**
 * Regression: GET /:id/members profile enrichment.
 *
 * The community member list must NEVER replace a valid member's real name with
 * the synthetic "Unknown" placeholder when user-service is unavailable or does
 * not resolve a given id. Each membership document persists a denormalized
 * last-known-good snapshot (snapshotUsername / snapshotDisplayName /
 * snapshotAvatarKey); the live user-service profile is PREFERRED only when it
 * actually resolves, otherwise the stored snapshot stands.
 *
 * This exercises the REAL communityService.listMembers + REAL user-client
 * (lib/user-client.ts → fetchUserSnapshotHits) against a controllable
 * user-service gRPC stub. Only the I/O boundary is mocked (repository, storage,
 * avatar presigner, gRPC client).
 *
 * Root cause this guards against: listMembers used to call fetchUserSnapshots
 * (which back-fills an "Unknown" placeholder for every unresolved id) and then
 * UNCONDITIONALLY overwrote the stored snapshot — so a single user-service
 * hiccup turned every member into "Unknown".
 */

jest.mock("@aimess/storage", () => ({
  MEDIA_PREFIXES: { community: [], userAvatars: [] },
  parseObjectKeyFromStored: jest.fn(() => null),
  toMediaObject: jest.fn(
    async (input: { stored: string | null; contentType?: string | null }) => ({
      fileId: null,
      objectKey: input.stored ?? null,
      fileName: null,
      contentType: input.contentType ?? null,
      size: null,
      downloadUrl: input.stored ? `https://signed/${input.stored}` : null,
      downloadUrlExpiresIn: input.stored ? 900 : null,
      uploadUrl: null,
      uploadUrlExpiresIn: null,
    })
  ),
}));

jest.mock("../../src/services/member-avatar.service.js", () => ({
  memberAvatarService: {
    resolveViewUrl: jest.fn(async (key: string | null | undefined) =>
      key ? { url: `https://signed/${key}`, expiresIn: 900 } : null
    ),
  },
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    listMembers: jest.fn(),
    findActiveMemberMutesByUserIds: jest.fn(),
  },
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { userGrpcClient } from "../../src/grpc/user.client.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const grpc = userGrpcClient as unknown as { bulkGetUserSnapshots: jest.Mock };

// ---------------------------------------------------------------------------
// Fixtures — userId is the AuthUser UUID on BOTH the membership doc and the
// user-service snapshot (no Mongo _id involved in the lookup key).
// ---------------------------------------------------------------------------

const CID = "a".repeat(24);
const CALLER = "11111111-1111-4111-8111-111111111111";
const U1 = "15c8a2c9-e759-413d-878c-842dc3066d94";
const U2 = "33333333-3333-4333-8333-333333333333";
const MONGO_ID = "65f0aabbccddeeff00112233"; // membership doc _id (NOT the lookup key)
const JOINED = new Date("2026-06-01T00:00:00.000Z");

/** A persisted membership row as returned by communityRepository.listMembers. */
const dbMember = (over: Record<string, unknown> = {}) => ({
  id: MONGO_ID,
  userId: U1,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: JOINED,
  snapshotUsername: "rajesh",
  snapshotDisplayName: "Rajesh Sharma",
  snapshotAvatarKey: "avatars/u1.png",
  bannedAt: null,
  bannedBy: null,
  banReason: null,
  ...over,
});

/** A live user-service snapshot record (gRPC bulkGetUserSnapshots element). */
const liveRecord = (over: Record<string, unknown> = {}) => ({
  userId: U1,
  username: "rajesh",
  displayName: "Rajesh Sharma",
  avatarObjectKey: "avatars/u1.png",
  ...over,
});

const list = (status = "ACTIVE", page = 1, limit = 30) =>
  communityService.listMembers(CID, CALLER, { page, limit, status } as never);

beforeEach(() => {
  repo.findById.mockResolvedValue({
    id: CID,
    type: "PUBLIC",
    name: "C",
    status: "ACTIVE",
  });
  repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });
  repo.findActiveMemberMutesByUserIds.mockResolvedValue(new Map());
  // Default: user-service resolves nothing (the at-risk path).
  grpc.bulkGetUserSnapshots.mockResolvedValue([]);
});

describe("listMembers — live profile enrichment (happy path)", () => {
  it("prefers the fresh live profile when user-service resolves it", async () => {
    repo.listMembers.mockResolvedValue({ rows: [dbMember()], total: 1 });
    grpc.bulkGetUserSnapshots.mockResolvedValue([
      liveRecord({
        displayName: "Rajesh LIVE",
        username: "rajesh_live",
        avatarObjectKey: "avatars/live.png",
      }),
    ]);

    const res = await list();
    const m = res.data[0];

    expect(m.userId).toBe(U1);
    expect(m.snapshotDisplayName).toBe("Rajesh LIVE");
    expect(m.snapshotUsername).toBe("rajesh_live");
    expect(m.snapshotAvatarUrl).toBe("https://signed/avatars/live.png");
    expect(m.snapshotAvatarUrl).toMatch(/^https:\/\//); // full URL, not a raw key
    expect(m.role).toBe("MEMBER");
    expect(m.status).toBe("ACTIVE");
    expect(m.joinedAt).toBe(JOINED.toISOString());
    expect(m.profileUnavailable).toBe(false);
  });

  it("enriches multiple members and preserves membership ordering", async () => {
    repo.listMembers.mockResolvedValue({
      rows: [
        dbMember({
          userId: U1,
          snapshotDisplayName: "Stored One",
          snapshotUsername: "one",
        }),
        dbMember({
          userId: U2,
          snapshotDisplayName: "Stored Two",
          snapshotUsername: "two",
          snapshotAvatarKey: null,
        }),
      ],
      total: 2,
    });
    // Only U2 resolves live; U1 must fall back to its stored snapshot.
    grpc.bulkGetUserSnapshots.mockResolvedValue([
      liveRecord({
        userId: U2,
        displayName: "Live Two",
        username: "two_live",
        avatarObjectKey: null,
      }),
    ]);

    const res = await list();

    expect(res.data.map((m) => m.userId)).toEqual([U1, U2]); // order preserved
    expect(res.data[0].snapshotDisplayName).toBe("Stored One");
    expect(res.data[1].snapshotDisplayName).toBe("Live Two");
    expect(res.data.every((m) => m.profileUnavailable === false)).toBe(true);
  });

  it("forwards status + pagination to the repository and returns pagination meta", async () => {
    repo.listMembers.mockResolvedValue({ rows: [dbMember()], total: 45 });

    const res = await list("ACTIVE", 2, 10);

    expect(repo.listMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: CID,
        callerId: CALLER,
        status: "ACTIVE",
        page: 2,
        limit: 10,
      })
    );
    expect(res.pagination.currentPage).toBe(2);
    expect(res.pagination.totalData).toBe(45);
    expect(res.pagination.limit).toBe(10);
  });
});

describe("listMembers — REGRESSION: never clobber a valid member with 'Unknown'", () => {
  it("user-service UNAVAILABLE (gRPC throws) → keeps the stored snapshot, not 'Unknown'", async () => {
    repo.listMembers.mockResolvedValue({ rows: [dbMember()], total: 1 });
    grpc.bulkGetUserSnapshots.mockRejectedValue(new Error("gRPC unavailable"));

    const res = await list();
    const m = res.data[0];

    expect(m.snapshotDisplayName).toBe("Rajesh Sharma"); // stored last-known-good
    expect(m.snapshotDisplayName).not.toBe("Unknown");
    expect(m.snapshotUsername).toBe("rajesh");
    expect(m.snapshotUsername).not.toBe(U1); // FALLBACK used userId as username
    expect(m.snapshotAvatarUrl).toBe("https://signed/avatars/u1.png");
    expect(m.profileUnavailable).toBe(false);
  });

  it("user-service returns NO rows for valid ids → keeps the stored snapshot", async () => {
    repo.listMembers.mockResolvedValue({ rows: [dbMember()], total: 1 });
    grpc.bulkGetUserSnapshots.mockResolvedValue([]);

    const res = await list();
    const m = res.data[0];

    expect(m.snapshotDisplayName).toBe("Rajesh Sharma");
    expect(m.snapshotDisplayName).not.toBe("Unknown");
    expect(m.profileUnavailable).toBe(false);
  });
});

describe("listMembers — identifier regression (UUID, not Mongo _id)", () => {
  it("looks profiles up by the membership UUID, never the Mongo _id", async () => {
    repo.listMembers.mockResolvedValue({ rows: [dbMember()], total: 1 });
    grpc.bulkGetUserSnapshots.mockResolvedValue([
      liveRecord({ displayName: "By UUID" }),
    ]);

    const res = await list();

    expect(grpc.bulkGetUserSnapshots).toHaveBeenCalledWith([U1]);
    expect(grpc.bulkGetUserSnapshots).not.toHaveBeenCalledWith([MONGO_ID]);
    expect(res.data[0].snapshotDisplayName).toBe("By UUID");
  });

  it("a live record keyed by the Mongo _id does NOT match (falls back to stored)", async () => {
    repo.listMembers.mockResolvedValue({ rows: [dbMember()], total: 1 });
    // Miskeyed by the doc _id — must not be matched to the row (keyed on userId).
    grpc.bulkGetUserSnapshots.mockResolvedValue([
      liveRecord({ userId: MONGO_ID, displayName: "WrongKey" }),
    ]);

    const res = await list();

    expect(res.data[0].snapshotDisplayName).toBe("Rajesh Sharma"); // stored
    expect(res.data[0].snapshotDisplayName).not.toBe("WrongKey");
  });
});

describe("listMembers — genuinely missing/deleted profile", () => {
  it("flags profileUnavailable only when there is no live hit AND no stored name", async () => {
    repo.listMembers.mockResolvedValue({
      rows: [
        dbMember({
          userId: U1,
          snapshotDisplayName: "Good",
          snapshotUsername: "good",
        }),
        dbMember({
          userId: U2,
          snapshotDisplayName: "",
          snapshotUsername: "",
          snapshotAvatarKey: null,
        }),
      ],
      total: 2,
    });
    grpc.bulkGetUserSnapshots.mockResolvedValue([]); // nothing resolves live

    const res = await list();

    // One bad profile must NOT break the rest of the list.
    expect(res.data).toHaveLength(2);
    expect(res.data[0].profileUnavailable).toBe(false);
    expect(res.data[0].snapshotDisplayName).toBe("Good");
    expect(res.data[1].profileUnavailable).toBe(true);
  });
});
