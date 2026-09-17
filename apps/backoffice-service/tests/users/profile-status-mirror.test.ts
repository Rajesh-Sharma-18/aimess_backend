/**
 * What backoffice tells user-service an account's status now is.
 *
 * Bug: `mirrorProfileStatus` took a boolean and sent "SUSPENDED" for anything
 * restricted, so a permanent ban and a three-day suspension arrived at
 * user-service as the same value. People search therefore had no clause it
 * could add that would hide banned users without also hiding suspended ones —
 * and since nothing in user-service ever expires a suspension, that would have
 * made every suspension permanent. The result was that neither was filtered and
 * a banned account stayed discoverable under "Other People".
 *
 * These assertions pin the three-way mapping the fix depends on:
 *
 *   permanent ban                 -> BANNED     (removed from discovery)
 *   ban with durationDays / suspend -> SUSPENDED (still discoverable)
 *   unban / re-activate           -> ACTIVE     (discoverable again)
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
  revokedSessions: 1,
  errorCode: "",
}));
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: {
    adminGetUser: mockAdminGetUser,
    adminSetAccountStatus: mockAdminSetAccountStatus,
  },
}));

const mockAdminSetProfileStatus = jest.fn(async () => undefined);
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: {
    adminGetProfile: jest.fn(async () => ({
      userId: USER_ID,
      username: "mind_flayer",
      firstName: "Mind",
      lastName: "Flayer",
      avatarUrl: null,
    })),
    adminSetProfileStatus: mockAdminSetProfileStatus,
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
jest.mock("../../src/messaging/publish-admin-broadcast.js", () => ({
  ADMIN_USERS_CHANGED: "admin:users:changed",
  publishAdminBroadcastSafe: jest.fn(),
  publishUserDirectoryChangedSafe: jest.fn(),
}));
jest.mock("../../src/services/dashboard.service.js", () => ({
  invalidateOverviewCache: jest.fn(async () => undefined),
}));
jest.mock("../../src/messaging/publish-admin-user-event.js", () => ({
  publishUserBannedSafe: jest.fn(),
  publishUserSuspendedSafe: jest.fn(),
  publishUserUnbannedSafe: jest.fn(),
}));

import { userManagementService } from "../../src/services/user-management.service.js";
import type {
  BanUserInput,
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

/** The `UserIndex` mirror row, at whatever status the scenario needs. */
function mirrorRow(status: string) {
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
  };
}

/** The auth-service record the live-backed repository reads for this user. */
function authRecord(status: string) {
  return {
    id: USER_ID,
    account: "Mind_Flayer",
    email: "mind@example.com",
    status,
    createdAt: "2026-09-11T10:24:51.104Z",
    lastLoginAt: null,
    deletedAt: null,
    suspendedAt: null,
    suspendedReason: null,
  };
}

/** Whatever `mirrorProfileStatus` forwarded, once the fire-and-forget settles. */
async function mirroredStatus(): Promise<string | undefined> {
  // The mirror is intentionally not awaited by the service (best-effort, like
  // the space cascade), so let the microtask queue drain before reading it.
  await Promise.resolve();
  return mockAdminSetProfileStatus.mock.calls.at(-1)?.[1] as string | undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminGetUser.mockResolvedValue(authRecord("ACTIVE"));
  mockUserIndexUpdate.mockImplementation((async (args: {
    data: Record<string, unknown>;
  }) => ({ ...mirrorRow("ACTIVE"), ...args.data })) as never);
});

describe("permanent ban", () => {
  it("mirrors BANNED, which is what removes the user from people search", async () => {
    mockUserIndexFindUnique.mockResolvedValue(mirrorRow("ACTIVE"));

    await userManagementService.banUser(USER_ID, banInput(), ACTOR, CTX);

    expect(await mirroredStatus()).toBe("BANNED");
    expect(mockAdminSetProfileStatus).toHaveBeenCalledWith(USER_ID, "BANNED");
  });
});

describe("time-boxed restriction", () => {
  it("mirrors SUSPENDED for a ban carrying durationDays, not BANNED", async () => {
    // POST /ban with a duration IS a suspension — the account comes back, so it
    // must keep the status that stays discoverable.
    mockUserIndexFindUnique.mockResolvedValue(mirrorRow("ACTIVE"));

    await userManagementService.banUser(
      USER_ID,
      banInput({ durationDays: 3 }),
      ACTOR,
      CTX
    );

    expect(await mirroredStatus()).toBe("SUSPENDED");
  });

  it("mirrors SUSPENDED for POST /suspend", async () => {
    mockUserIndexFindUnique.mockResolvedValue(mirrorRow("ACTIVE"));

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

    expect(await mirroredStatus()).toBe("SUSPENDED");
  });
});

describe("unban / re-activate", () => {
  it("mirrors ACTIVE, so the account becomes searchable again", async () => {
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
      { note: null } as UnbanUserInput,
      ACTOR,
      CTX
    );

    expect(await mirroredStatus()).toBe("ACTIVE");
  });
});
