/**
 * The Redis ban flag and the status row must never disagree in the direction
 * that leaves a user blocked with no way back.
 *
 * `aimess:user:banned:<id>` is written with NO TTL — permanent until an
 * explicit DEL — and every service guard reads it, including community-service
 * and stream-service, which consult nothing else. So the write order decides
 * what a partial failure means:
 *
 *   apply — flag first, then the row. A Redis failure must not report a
 *           successful ban, because the flag is the only block those two
 *           services have.
 *   lift  — flag first as well, but for the mirror reason: a DEL that failed
 *           after the row already said ACTIVE left a user unbanned in the
 *           database and blocked everywhere forever, and a second `lift` sees
 *           an already-ACTIVE row and cannot repair it. Clearing first makes
 *           the failure "still banned, lift again".
 *
 * The gate itself reads the flag on every request with no cache of its own, so
 * a successful lift is visible immediately — see the gateway's
 * tests/middleware/chat-ban-gate.test.ts for that half.
 */
const order: string[] = [];

jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  markUserBanned: jest.fn(async () => {
    order.push("markUserBanned");
  }),
  clearUserBanned: jest.fn(async () => {
    order.push("clearUserBanned");
  }),
  publishSessionRevokedEvent: jest.fn(async () => undefined),
  publishUserBanEvent: jest.fn(async () => undefined),
}));
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    authUser: {
      findUnique: jest.fn(),
      update: jest.fn(async () => {
        order.push("statusRow");
        return {};
      }),
    },
  },
}));
jest.mock("../../src/repositories/session.repository.js", () => ({
  sessionRepository: {
    listActiveSessionIds: jest.fn(async () => []),
    revokeAllForUser: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/lib/session-active-cache.js", () => ({
  markSessionsRevoked: jest.fn(async () => undefined),
}));
jest.mock("../../src/messaging/publish-session-revoked.js", () => ({
  publishAllSessionsRevokedSafe: jest.fn(),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  authAuditService: { record: jest.fn(async () => undefined) },
}));

import { clearUserBanned, markUserBanned } from "@aimess/redis";

import { prisma } from "../../src/config/prisma.js";
import { accountBanService } from "../../src/services/account-ban.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const authUser = (prisma as unknown as { authUser: Record<string, jest.Mock> })
  .authUser;
const markBanned = markUserBanned as unknown as jest.Mock;
const clearBanned = clearUserBanned as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  authUser.update.mockImplementation(async () => {
    order.push("statusRow");
    return {};
  });
});

describe("accountBanService.apply", () => {
  beforeEach(() => {
    authUser.findUnique.mockResolvedValue({
      id: USER_ID,
      status: "ACTIVE",
      deletedAt: null,
    });
  });

  it("sets the flag before the status row", async () => {
    await accountBanService.apply({ userId: USER_ID });

    expect(order.slice(0, 2)).toEqual(["markUserBanned", "statusRow"]);
  });

  it("does not report a successful ban when Redis is unreachable", async () => {
    markBanned.mockRejectedValueOnce(new Error("redis down"));

    await expect(accountBanService.apply({ userId: USER_ID })).rejects.toThrow(
      "redis down"
    );
    expect(authUser.update).not.toHaveBeenCalled();
  });
});

describe("accountBanService.lift", () => {
  beforeEach(() => {
    authUser.findUnique.mockResolvedValue({
      id: USER_ID,
      status: "BANNED",
      deletedAt: null,
    });
  });

  it("clears the flag before the status row", async () => {
    await accountBanService.lift({ userId: USER_ID });

    expect(order.slice(0, 2)).toEqual(["clearUserBanned", "statusRow"]);
  });

  it("leaves the account BANNED when the flag cannot be cleared", async () => {
    // The stale-key regression. The old order committed ACTIVE first, so this
    // failure produced a user who was unbanned in the database and refused by
    // every guard, with no retry able to fix it.
    clearBanned.mockRejectedValueOnce(new Error("redis down"));

    await expect(accountBanService.lift({ userId: USER_ID })).rejects.toThrow(
      "redis down"
    );
    expect(authUser.update).not.toHaveBeenCalled();
  });

  it("is repeatable, so a failed lift can simply be retried", async () => {
    clearBanned.mockRejectedValueOnce(new Error("redis down"));
    await expect(accountBanService.lift({ userId: USER_ID })).rejects.toThrow();

    const result = await accountBanService.lift({ userId: USER_ID });

    expect(clearBanned).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ACTIVE");
  });

  it("refuses to reinstate a deleted account", async () => {
    authUser.findUnique.mockResolvedValue({
      id: USER_ID,
      status: "BANNED",
      deletedAt: new Date(),
    });

    await expect(accountBanService.lift({ userId: USER_ID })).rejects.toThrow();
    expect(clearBanned).not.toHaveBeenCalled();
  });
});
