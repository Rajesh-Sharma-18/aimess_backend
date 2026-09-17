/**
 * Super Admin permanent ban — admin_db mirror seeding order.
 *
 * Bug: `UserIndex` (admin_db) holds the moderation status, but the ~40-row dev
 * seed is the only thing that ever populated it, so a real user reached their
 * first ban with no mirror row. `GrpcUserDirectoryRepository.setStatus` filled
 * that gap by re-reading the user LIVE from auth-service — and `banUser` writes
 * auth-service first, so the live read returned the BANNED status this very
 * request had just applied. The row was created already BANNED, the very next
 * statement (`assertTransition("BANNED", "BANNED")`) threw USER_ALREADY_BANNED,
 * and the ban half-landed:
 *
 *   - auth-service BANNED, sessions revoked, Redis ban flag set;
 *   - mirror BANNED but with bannedAt/banReason NULL (the reason was lost);
 *   - NO ModerationAction, NO AuditLog, NO admin.user_banned event, NO space
 *     cascade, NO livestream force-end — every one of them sits after the throw;
 *   - the admin saw "This user is already banned." over a row still rendered
 *     Active, because the panel only refreshed the list on success.
 *
 * Five accounts in the shared dev database carry exactly that signature
 * (status BANNED, bannedAt NULL, zero ModerationAction rows).
 *
 * Fix: `preflightStatus` materializes the mirror from the PRE-mutation read
 * that every mutation already performs, before auth-service is touched.
 */
const mockUserIndexFindUnique = jest.fn();
const mockUserIndexCreate = jest.fn(async () => undefined);
const mockUserIndexUpdate = jest.fn();
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    userIndex: {
      findUnique: mockUserIndexFindUnique,
      create: mockUserIndexCreate,
      update: mockUserIndexUpdate,
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    report: { groupBy: jest.fn(async () => []) },
  },
}));

const mockAdminGetUser = jest.fn();
const mockAdminSetAccountStatus = jest.fn(async () => ({
  ok: true,
  status: "BANNED",
  revokedSessions: 2,
  errorCode: "",
}));
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: {
    adminGetUser: mockAdminGetUser,
    adminSetAccountStatus: mockAdminSetAccountStatus,
  },
}));
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: {
    adminGetProfile: jest.fn(async () => ({
      userId: USER_ID,
      username: "mind_flayer",
      firstName: "Mind",
      lastName: "Flayer",
      avatarUrl: null,
    })),
    adminSetProfileStatus: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: {
    adminApplySystemBan: jest.fn(async () => ({
      closedCommunityIds: [],
      removedCommunityIds: [],
    })),
  },
}));
jest.mock("../../src/grpc/chat.client.js", () => ({
  chatClient: {
    adminApplySystemBan: jest.fn(async () => ({
      closedGroupIds: [],
      removedGroupIds: [],
    })),
  },
}));
const mockForceEndStreams = jest.fn(async () => undefined);
jest.mock("../../src/grpc/stream.client.js", () => ({
  streamClient: { forceEndStreamsByCreator: mockForceEndStreams },
}));

const mockModerationCreate = jest.fn(async () => ({ id: "ma-1" }));
jest.mock("../../src/repositories/moderation-action.repository.js", () => ({
  moderationActionRepository: {
    create: mockModerationCreate,
    latestBanActionsByTargets: jest.fn(async () => new Map()),
    listForTarget: jest.fn(async () => []),
  },
}));

const mockAuditRecord = jest.fn(async () => undefined);
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: mockAuditRecord },
}));

const mockPublishBanned = jest.fn();
jest.mock("../../src/messaging/publish-admin-user-event.js", () => ({
  publishUserBannedSafe: mockPublishBanned,
  publishUserSuspendedSafe: jest.fn(),
  publishUserUnbannedSafe: jest.fn(),
}));

import { ConflictError } from "@aimess/errors";

import { userManagementService } from "../../src/services/user-management.service.js";
import type { BanUserInput } from "../../src/api/validators/index.js";
import type { RequestAdmin } from "../../src/types/index.js";

const USER_ID = "1b98aed5-cc15-41d6-95bb-bef47a44f063";
const ACTOR = { id: "admin-1" } as RequestAdmin;
const CTX = { ip: "127.0.0.1", userAgent: "jest" };
const REASON = "Meri marzi";

const banInput = (overrides: Partial<BanUserInput> = {}): BanUserInput =>
  ({
    banType: "SYSTEM",
    reason: REASON,
    durationDays: null,
    forceLogout: true,
    notifyUser: false,
    note: null,
    reportId: null,
    ...overrides,
  }) as BanUserInput;

/** The auth-service record the live path reads, at whatever status it is at. */
const authRecord = (status: string) => ({
  id: USER_ID,
  account: "Mind_Flayer",
  email: "mind@example.com",
  status,
  createdAt: "2026-09-11T10:24:51.104Z",
  lastLoginAt: null,
  deletedAt: null,
  suspendedAt: null,
  suspendedReason: null,
});

/**
 * Simulate a user the mirror has never seen: `findUnique` returns null until
 * something creates the row, then returns whatever was created/updated. This is
 * what makes the ordering observable — if the row is created from a live read
 * taken after the auth write, it is born BANNED.
 */
function mirrorlessUser(): { row: Record<string, unknown> | null } {
  const state: { row: Record<string, unknown> | null } = { row: null };

  mockUserIndexFindUnique.mockImplementation(async () => state.row);
  mockUserIndexCreate.mockImplementation((async (args: {
    data: Record<string, unknown>;
  }) => {
    state.row = {
      bannedAt: null,
      banReason: null,
      suspendedUntil: null,
      lastActiveAt: null,
      updatedAt: new Date(),
      ...args.data,
    };
    return state.row;
  }) as never);
  mockUserIndexUpdate.mockImplementation((async (args: {
    data: Record<string, unknown>;
  }) => {
    state.row = { ...(state.row ?? {}), ...args.data };
    return state.row;
  }) as never);

  return state;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("banUser — a user with no admin_db mirror row", () => {
  it("bans successfully instead of 409-ing on a row it created itself", async () => {
    const mirror = mirrorlessUser();
    // auth-service reports the user's REAL status until the ban is applied,
    // then reports BANNED — exactly as the live service does.
    mockAdminGetUser.mockImplementation(async () =>
      authRecord(
        mockAdminSetAccountStatus.mock.calls.length > 0 ? "BANNED" : "ACTIVE"
      )
    );

    const result = await userManagementService.banUser(
      USER_ID,
      banInput(),
      ACTOR,
      CTX
    );

    expect(result.status).toBe("BANNED");
    expect(mirror.row).toMatchObject({ status: "BANNED" });
  });

  it("seeds the mirror BEFORE auth-service is told to ban", async () => {
    mirrorlessUser();
    mockAdminGetUser.mockImplementation(async () =>
      authRecord(
        mockAdminSetAccountStatus.mock.calls.length > 0 ? "BANNED" : "ACTIVE"
      )
    );

    await userManagementService.banUser(USER_ID, banInput(), ACTOR, CTX);

    expect(mockUserIndexCreate).toHaveBeenCalledTimes(1);
    // The seeded row carries the PRE-ban status. Seeded after the auth write it
    // would read BANNED, and the transition guard would reject the ban.
    expect(mockUserIndexCreate.mock.calls[0][0]).toMatchObject({
      data: { status: "ACTIVE" },
    });
    expect(
      mockUserIndexCreate.mock.invocationCallOrder[0]
    ).toBeLessThan(mockAdminSetAccountStatus.mock.invocationCallOrder[0]);
  });

  it("preserves the ban reason and timestamp on the mirror row", async () => {
    const mirror = mirrorlessUser();
    mockAdminGetUser.mockImplementation(async () =>
      authRecord(
        mockAdminSetAccountStatus.mock.calls.length > 0 ? "BANNED" : "ACTIVE"
      )
    );

    await userManagementService.banUser(USER_ID, banInput(), ACTOR, CTX);

    expect(mirror.row).toMatchObject({ banReason: REASON });
    expect(mirror.row?.bannedAt).toBeInstanceOf(Date);
  });

  it("records the moderation action, audit log and ban event", async () => {
    mirrorlessUser();
    mockAdminGetUser.mockImplementation(async () =>
      authRecord(
        mockAdminSetAccountStatus.mock.calls.length > 0 ? "BANNED" : "ACTIVE"
      )
    );

    await userManagementService.banUser(USER_ID, banInput(), ACTOR, CTX);

    expect(mockModerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ban_user",
        targetId: USER_ID,
        reason: REASON,
      })
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: USER_ID })
    );
    expect(mockPublishBanned).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, permanent: true })
    );
  });
});

describe("banUser — a user who really is already banned", () => {
  it("still 409s, and does NOT re-run the ban side effects", async () => {
    // Mirror already BANNED — the genuine conflict the error exists for.
    mockUserIndexFindUnique.mockResolvedValue({
      userId: USER_ID,
      username: "mind_flayer",
      email: "mind@example.com",
      status: "BANNED",
      joinedAt: new Date("2026-09-11T10:24:51.104Z"),
      lastActiveAt: null,
      bannedAt: new Date("2026-09-12T00:00:00.000Z"),
      banReason: REASON,
      suspendedUntil: null,
      updatedAt: new Date(),
    });
    mockAdminGetUser.mockResolvedValue(authRecord("BANNED"));

    await expect(
      userManagementService.banUser(USER_ID, banInput(), ACTOR, CTX)
    ).rejects.toThrow(ConflictError);

    // The whole point of failing first: nothing downstream may run twice.
    expect(mockAdminSetAccountStatus).not.toHaveBeenCalled();
    expect(mockUserIndexUpdate).not.toHaveBeenCalled();
    expect(mockModerationCreate).not.toHaveBeenCalled();
    expect(mockForceEndStreams).not.toHaveBeenCalled();
    expect(mockPublishBanned).not.toHaveBeenCalled();
  });
});
