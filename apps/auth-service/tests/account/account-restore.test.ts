/**
 * Super Admin "Re-Activate" — accountRestoreService.restore.
 *
 * The property under test is RE-DRIVABILITY, and it is the whole reason the
 * feature can claim to be reliable. `restoreUser` commits before
 * `publishUserRestored` is awaited, so a broker failure in between leaves an
 * account that can log in while user-service still has the profile deleted. If
 * a second call rejected that already-ACTIVE account, the half-restored state
 * would be permanent — nothing else in the monorepo publishes `user.restored`.
 *
 * So an already-ACTIVE account is a re-drive: republish, do not rewrite, do not
 * touch the ban flag. A BANNED or SUSPENDED account is still refused, because
 * reactivation must never become a backdoor unban.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    restoreUser: jest.fn(),
  },
}));
jest.mock("../../src/messaging/publish-user-restored.js", () => ({
  publishUserRestored: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  authAuditService: { record: jest.fn(async () => undefined) },
}));
jest.mock("../../src/config/prisma.js", () => ({
  prisma: { authUser: { findUnique: jest.fn() } },
}));
jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  clearUserBanned: jest.fn(async () => undefined),
}));

import { clearUserBanned } from "@aimess/redis";

import { prisma } from "../../src/config/prisma.js";
import { publishUserRestored } from "../../src/messaging/publish-user-restored.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { accountRestoreService } from "../../src/services/account-restore.service.js";
import { authAuditService } from "../../src/services/audit.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RESTORED_AT = new Date("2026-08-27T09:30:00.000Z");

const findUnique = (
  prisma as unknown as {
    authUser: { findUnique: jest.Mock };
  }
).authUser.findUnique;
const repo = authRepository as unknown as { restoreUser: jest.Mock };
const publish = publishUserRestored as unknown as jest.Mock;
const audit = (authAuditService as unknown as { record: jest.Mock }).record;
const clearBan = clearUserBanned as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  repo.restoreUser.mockResolvedValue({ restoredAt: RESTORED_AT });
});

describe("accountRestoreService.restore", () => {
  it("restores a soft-deleted account and publishes user.restored", async () => {
    findUnique.mockResolvedValue({
      id: USER_ID,
      status: "PENDING_DELETION",
      deletedAt: new Date("2026-08-13T10:00:00.000Z"),
    });

    const result = await accountRestoreService.restore({
      userId: USER_ID,
      actorAdminId: "admin-1",
    });

    expect(repo.restoreUser).toHaveBeenCalledWith(USER_ID);
    expect(clearBan).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith({
      userId: USER_ID,
      restoredAt: RESTORED_AT.toISOString(),
      actorAdminId: "admin-1",
    });
    expect(result.status).toBe("ACTIVE");
  });

  it("writes the audit row BEFORE publishing, so a failed publish still leaves a trail", async () => {
    findUnique.mockResolvedValue({
      id: USER_ID,
      status: "PENDING_DELETION",
      deletedAt: new Date("2026-08-13T10:00:00.000Z"),
    });
    publish.mockRejectedValueOnce(new Error("broker down"));

    await expect(
      accountRestoreService.restore({ userId: USER_ID })
    ).rejects.toThrow("broker down");

    // restoreUser already committed, so the trail must record it regardless.
    expect(repo.restoreUser).toHaveBeenCalledWith(USER_ID);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0].event).toBe("ACCOUNT_RESTORED");
  });

  // The regression that makes a partial restore recoverable.
  it("re-drives an already-ACTIVE account: republishes without rewriting", async () => {
    findUnique.mockResolvedValue({
      id: USER_ID,
      status: "ACTIVE",
      deletedAt: null,
    });

    const result = await accountRestoreService.restore({ userId: USER_ID });

    expect(repo.restoreUser).not.toHaveBeenCalled();
    // Not a backdoor unban — the ban flag is only cleared on a real restore.
    expect(clearBan).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0].metadata.redrive).toBe(true);
    expect(result.status).toBe("ACTIVE");
  });

  it.each(["BANNED", "SUSPENDED"])(
    "refuses a %s account so reactivation cannot launder a moderation decision",
    async (status) => {
      findUnique.mockResolvedValue({ id: USER_ID, status, deletedAt: null });

      await expect(
        accountRestoreService.restore({ userId: USER_ID })
      ).rejects.toThrow("USER_NOT_DELETED");

      expect(repo.restoreUser).not.toHaveBeenCalled();
      expect(clearBan).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    }
  );

  it("404s an unknown user", async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      accountRestoreService.restore({ userId: USER_ID })
    ).rejects.toThrow("USER_NOT_FOUND");
  });
});
