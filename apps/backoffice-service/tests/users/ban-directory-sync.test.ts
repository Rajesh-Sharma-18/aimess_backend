/**
 * What a ban/unban tells the rest of the estate, so nobody has to hard-reload.
 *
 * The write itself was never the problem: the admin API, the `UserIndex` mirror
 * and user-service's profile status were all correct the instant the button was
 * clicked. What was missing was any signal to the sessions that did NOT click —
 * a second Super Admin's list, the Dashboard cards in another tab, and an
 * ordinary reader whose people-search panel was open. They kept the pre-ban
 * answer until someone pressed Ctrl+F5.
 *
 * `announceUserDirectoryChange` is the one choke point that closes all three:
 *
 *   admin:broadcast        -> /admin `admin:users:changed` -> panel invalidates
 *   broadcast:user-directory -> /notify `user:directory_changed` -> website re-reads
 *   DEL backoffice:dashboard:overview -> the stat cards recount instead of
 *                                        being answered from the 10s snapshot
 *
 * These cases pin that it fires on every status-changing operation, on both
 * channels, and — for bulk — exactly ONCE per request rather than once per
 * target.
 */
const mockUserIndexFindUnique = jest.fn();
const mockUserIndexUpdate = jest.fn();
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    userIndex: {
      findUnique: mockUserIndexFindUnique,
      create: jest.fn(async () => undefined),
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
  revokedSessions: 1,
  errorCode: "",
}));
const mockAdminRestoreAccount = jest.fn(async () => ({
  ok: true,
  status: "ACTIVE",
  errorCode: "",
}));
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: {
    adminGetUser: mockAdminGetUser,
    adminSetAccountStatus: mockAdminSetAccountStatus,
    adminRestoreAccount: mockAdminRestoreAccount,
  },
}));

jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: {
    adminGetProfile: jest.fn(async () => ({
      userId: "1b98aed5-cc15-41d6-95bb-bef47a44f063",
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
jest.mock("../../src/grpc/stream.client.js", () => ({
  streamClient: { forceEndStreamsByCreator: jest.fn(async () => undefined) },
}));
jest.mock("../../src/repositories/moderation-action.repository.js", () => ({
  moderationActionRepository: {
    create: jest.fn(async () => ({ id: "ma-1" })),
    latestBanActionsByTargets: jest.fn(async () => new Map()),
    listForTarget: jest.fn(async () => []),
  },
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => undefined) },
}));
jest.mock("../../src/messaging/publish-admin-user-event.js", () => ({
  publishUserBannedSafe: jest.fn(),
  publishUserSuspendedSafe: jest.fn(),
  publishUserUnbannedSafe: jest.fn(),
}));

const mockPublishAdminBroadcast = jest.fn();
const mockPublishUserDirectoryChanged = jest.fn();
jest.mock("../../src/messaging/publish-admin-broadcast.js", () => ({
  ADMIN_USERS_CHANGED: "admin:users:changed",
  publishAdminBroadcastSafe: mockPublishAdminBroadcast,
  publishUserDirectoryChangedSafe: mockPublishUserDirectoryChanged,
}));

const mockInvalidateOverviewCache = jest.fn(async () => undefined);
jest.mock("../../src/services/dashboard.service.js", () => ({
  invalidateOverviewCache: mockInvalidateOverviewCache,
}));

import { userManagementService } from "../../src/services/user-management.service.js";
import type {
  BanUserInput,
  BulkActivateInput,
  BulkBanInput,
  ReactivateUserInput,
  SuspendUserInput,
  UnbanUserInput,
} from "../../src/api/validators/index.js";
import type { RequestAdmin } from "../../src/types/index.js";

const USER_ID = "1b98aed5-cc15-41d6-95bb-bef47a44f063";
const ACTOR = { id: "admin-1" } as RequestAdmin;
const CTX = { ip: "127.0.0.1", userAgent: "jest" };
const REASON = "Repeated harassment";

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

function mirrorRow(status: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    username: "mind_flayer",
    email: "mind@example.com",
    status,
    joinedAt: new Date("2026-09-11T10:24:51.104Z"),
    lastActiveAt: null,
    bannedAt: status === "ACTIVE" ? null : new Date("2026-09-12T00:00:00.000Z"),
    banReason: status === "ACTIVE" ? null : REASON,
    suspendedUntil: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function authRecord(status: string, deletedAt: string | null = null) {
  return {
    id: USER_ID,
    account: "Mind_Flayer",
    email: "mind@example.com",
    status,
    createdAt: "2026-09-11T10:24:51.104Z",
    lastLoginAt: null,
    deletedAt,
    suspendedAt: null,
    suspendedReason: null,
  };
}

/** The event name the /admin namespace relays, if the bump was published. */
const adminBumpEvents = () =>
  mockPublishAdminBroadcast.mock.calls.map((call) => call[0] as string);

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminGetUser.mockResolvedValue(authRecord("ACTIVE"));
  mockUserIndexFindUnique.mockResolvedValue(mirrorRow("ACTIVE"));
  mockUserIndexUpdate.mockImplementation((async (args: {
    data: Record<string, unknown>;
  }) => ({ ...mirrorRow("ACTIVE"), ...args.data })) as never);
});

describe("ban", () => {
  it("bumps the admin panel, the website and the stat-card cache", async () => {
    await userManagementService.banUser(USER_ID, banInput(), ACTOR, CTX);

    expect(adminBumpEvents()).toEqual(["admin:users:changed"]);
    expect(mockPublishUserDirectoryChanged).toHaveBeenCalledTimes(1);
    expect(mockInvalidateOverviewCache).toHaveBeenCalledTimes(1);
  });

  it("bumps for a time-boxed ban too", async () => {
    // SUSPENDED stays discoverable, so the website's answer does not change —
    // but the admin row, its status filter and the stat cards all do, and an
    // operator watching either must not have to reload to see it.
    await userManagementService.banUser(
      USER_ID,
      banInput({ durationDays: 3 }),
      ACTOR,
      CTX
    );

    expect(adminBumpEvents()).toEqual(["admin:users:changed"]);
    expect(mockInvalidateOverviewCache).toHaveBeenCalledTimes(1);
  });
});

describe("suspend", () => {
  it("bumps", async () => {
    await userManagementService.suspendUser(
      USER_ID,
      {
        reason: REASON,
        durationDays: 7,
        notifyUser: false,
        note: null,
      } as SuspendUserInput,
      ACTOR,
      CTX
    );

    expect(adminBumpEvents()).toEqual(["admin:users:changed"]);
    expect(mockPublishUserDirectoryChanged).toHaveBeenCalledTimes(1);
  });
});

describe("unban", () => {
  it("bumps, so the account becomes visible again everywhere at once", async () => {
    mockUserIndexFindUnique.mockResolvedValue(mirrorRow("BANNED"));
    mockAdminGetUser.mockResolvedValue(authRecord("BANNED"));
    mockAdminSetAccountStatus.mockResolvedValue({
      ok: true,
      status: "ACTIVE",
      revokedSessions: 0,
      errorCode: "",
    });

    await userManagementService.unbanUser(
      USER_ID,
      { banType: "SYSTEM", note: null } as UnbanUserInput,
      ACTOR,
      CTX
    );

    expect(adminBumpEvents()).toEqual(["admin:users:changed"]);
    expect(mockPublishUserDirectoryChanged).toHaveBeenCalledTimes(1);
    expect(mockInvalidateOverviewCache).toHaveBeenCalledTimes(1);
  });

  it("does not bump when the unban is REFUSED", async () => {
    // The row never moved, so nothing downstream is stale. Bumping anyway would
    // make every open session refetch for an operation that changed nothing.
    mockUserIndexFindUnique.mockResolvedValue(mirrorRow("ACTIVE"));
    mockAdminGetUser.mockResolvedValue(authRecord("ACTIVE"));

    await expect(
      userManagementService.unbanUser(
        USER_ID,
        { banType: "SYSTEM", note: null } as UnbanUserInput,
        ACTOR,
        CTX
      )
    ).rejects.toThrow();

    expect(mockPublishAdminBroadcast).not.toHaveBeenCalled();
    expect(mockPublishUserDirectoryChanged).not.toHaveBeenCalled();
    expect(mockInvalidateOverviewCache).not.toHaveBeenCalled();
  });
});

describe("re-activate", () => {
  it("bumps, like the unban it mirrors", async () => {
    mockUserIndexFindUnique.mockResolvedValue(
      mirrorRow("DELETED", { status: "DELETED" })
    );
    mockAdminGetUser.mockResolvedValue(
      authRecord("DELETED", "2026-09-12T00:00:00.000Z")
    );

    await userManagementService.reactivateUser(
      USER_ID,
      { note: undefined } as ReactivateUserInput,
      ACTOR,
      CTX
    );

    expect(adminBumpEvents()).toEqual(["admin:users:changed"]);
    expect(mockPublishUserDirectoryChanged).toHaveBeenCalledTimes(1);
  });
});

describe("bulk", () => {
  const THREE = [USER_ID, "user-2", "user-3"];

  it("bumps ONCE for the whole request, not once per target", async () => {
    // 100 identical payload-free bumps buy exactly one refetch's worth of truth.
    // Per-target publishing is the shape this deliberately does not have.
    mockUserIndexFindUnique.mockImplementation((async (args: {
      where: { userId: string };
    }) => mirrorRow("ACTIVE", { userId: args.where.userId })) as never);
    mockAdminGetUser.mockImplementation((async (id: string) => ({
      ...authRecord("ACTIVE"),
      id,
    })) as never);

    await userManagementService.bulkBan(
      THREE,
      { ...banInput(), userIds: THREE } as BulkBanInput,
      ACTOR,
      CTX
    );

    expect(adminBumpEvents()).toEqual(["admin:users:changed"]);
    expect(mockPublishUserDirectoryChanged).toHaveBeenCalledTimes(1);
    expect(mockInvalidateOverviewCache).toHaveBeenCalledTimes(1);
  });

  it("bumps once on bulk activate as well", async () => {
    mockUserIndexFindUnique.mockImplementation((async (args: {
      where: { userId: string };
    }) => mirrorRow("BANNED", { userId: args.where.userId })) as never);
    mockAdminGetUser.mockImplementation((async (id: string) => ({
      ...authRecord("BANNED"),
      id,
    })) as never);
    mockAdminSetAccountStatus.mockResolvedValue({
      ok: true,
      status: "ACTIVE",
      revokedSessions: 0,
      errorCode: "",
    });

    await userManagementService.bulkActivate(
      THREE,
      { userIds: THREE } as BulkActivateInput,
      ACTOR,
      CTX
    );

    expect(adminBumpEvents()).toEqual(["admin:users:changed"]);
    expect(mockPublishUserDirectoryChanged).toHaveBeenCalledTimes(1);
  });
});
