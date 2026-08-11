/**
 * "Login Detected" 1-hour auto-approval.
 *
 * Covers the three pieces that make the timeout backend-owned rather than a
 * frontend timer:
 *   1. create()  stamps a server-computed deadline on the row (and mirrors it
 *      into payload.data) — so a refresh/restart cannot reset it.
 *   2. recordAction() claims the row atomically, so a tap landing at the same
 *      moment as the sweep produces exactly ONE final state.
 *   3. sweepExpiredLoginNotifications() resolves due rows as "It's Me" through
 *      that same transition, and never touches anything else.
 */
import { NotificationRepository } from "../../src/repositories/notification.repository.js";
import { NotificationService } from "../../src/services/notification.service.js";
import { env } from "../../src/config/env.js";

const publishUserSocketEvent = jest.fn(async () => undefined);
jest.mock("@aimess/redis", () => ({
  publishUserSocketEvent: (...args: unknown[]) =>
    (publishUserSocketEvent as unknown as (...a: unknown[]) => Promise<void>)(
      ...args
    ),
}));

const LOGIN = "auth.security_new_login";

type AnyRec = Record<string, unknown>;

function fakePrisma(overrides: AnyRec = {}) {
  return {
    notification: {
      create: jest.fn(async ({ data }: { data: AnyRec }) => data),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }: { data: AnyRec }) => data),
      updateMany: jest.fn(async () => ({ count: 1 })),
      count: jest.fn(async () => 0),
      ...overrides,
    },
  };
}

function loginRow(over: AnyRec = {}) {
  return {
    id: "n1",
    userId: "u1",
    type: LOGIN,
    payload: { title: "Login Detected", data: { sessionId: "s1" } },
    isDeleted: false,
    loginSessionId: "s1",
    loginResolvedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    version: 1,
    ...over,
  };
}

beforeEach(() => jest.clearAllMocks());

describe("create() — server-owned deadline", () => {
  it("stamps loginExpiresAt = now + LOGIN_DETECTION_TIMEOUT_MS and mirrors it into payload.data", async () => {
    const prisma = fakePrisma();
    const repo = new NotificationRepository(prisma as never);
    const before = Date.now();

    await repo.create({
      userId: "u1",
      actorId: "u1",
      type: LOGIN,
      payload: { title: "Login Detected", data: { sessionId: "s1" } },
    });

    const written = prisma.notification.create.mock.calls[0][0].data as {
      loginExpiresAt: Date;
      loginResolvedAt: Date | null;
      payload: { data: Record<string, string> };
    };
    const expected = before + env.LOGIN_DETECTION_TIMEOUT_MS;
    expect(written.loginExpiresAt.getTime()).toBeGreaterThanOrEqual(expected);
    expect(written.loginExpiresAt.getTime()).toBeLessThan(expected + 5000);
    // Starts PENDING.
    expect(written.loginResolvedAt).toBeNull();
    // Same value on the wire, epoch ms as a string (the data bag is string→string).
    expect(written.payload.data.expiresAt).toBe(
      String(written.loginExpiresAt.getTime())
    );
    // The client-supplied part of the payload survives untouched.
    expect(written.payload.data.sessionId).toBe("s1");
  });

  it("leaves every OTHER notification type without a deadline", async () => {
    const prisma = fakePrisma();
    const repo = new NotificationRepository(prisma as never);

    await repo.create({
      userId: "u1",
      actorId: "u2",
      type: "friend.requested",
      payload: { data: { friendshipId: "f1" } },
    });

    const written = prisma.notification.create.mock.calls[0][0].data as {
      loginExpiresAt: Date | null;
      payload: { data: Record<string, string> };
    };
    expect(written.loginExpiresAt).toBeNull();
    expect(written.payload.data.expiresAt).toBeUndefined();
  });
});

describe("recordAction() — one winner at the deadline", () => {
  it("claims a PENDING login row on loginResolvedAt:null before writing", async () => {
    const prisma = fakePrisma({
      findFirst: jest.fn(async () => loginRow()),
    });
    const repo = new NotificationRepository(prisma as never);

    const out = await repo.recordAction(
      "n1",
      "u1",
      "Session terminated.",
      "TERMINATED"
    );

    expect(out).not.toBeNull();
    expect(prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "n1",
          userId: "u1",
          // Unresolved = null OR absent (rows predating the column).
          OR: [
            { loginResolvedAt: null },
            { loginResolvedAt: { isSet: false } },
          ],
        }),
      })
    );
    const patch = prisma.notification.update.mock.calls[0][0].data as {
      payload: { data: Record<string, string>; body: string };
    };
    expect(patch.payload.data.actionTaken).toBe("TERMINATED");
  });

  it("returns null (and writes nothing) when the row was already resolved", async () => {
    const prisma = fakePrisma({
      findFirst: jest.fn(async () => loginRow()),
      updateMany: jest.fn(async () => ({ count: 0 })), // lost the claim
    });
    const repo = new NotificationRepository(prisma as never);

    const out = await repo.recordAction("n1", "u1", "This was you.", "TRUSTED");

    expect(out).toBeNull();
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it("does NOT gate non-login notifications on the login claim", async () => {
    const prisma = fakePrisma({
      findFirst: jest.fn(async () => loginRow({ type: "friend.requested" })),
    });
    const repo = new NotificationRepository(prisma as never);

    await repo.recordAction("n1", "u1", "body", "ACCEPTED");

    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    expect(prisma.notification.update).toHaveBeenCalled();
  });
});

describe("findExpiredPendingLogins()", () => {
  it("asks only for past-due, unresolved, login rows that actually have a deadline", async () => {
    const prisma = fakePrisma();
    const repo = new NotificationRepository(prisma as never);
    const now = new Date(10_000);

    await repo.findExpiredPendingLogins(now, 50);

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: LOGIN,
          isDeleted: false,
          OR: [
            { loginResolvedAt: null },
            { loginResolvedAt: { isSet: false } },
          ],
          // `not: null` keeps rows predating the column out — on Mongo a bare
          // `lte` matches an absent field.
          loginExpiresAt: { not: null, lte: now },
        },
        take: 50,
      })
    );
  });
});

describe("sweepExpiredLoginNotifications()", () => {
  function serviceWith(repo: AnyRec) {
    return new NotificationService(repo as never, {} as never);
  }

  it("auto-approves a due alert as 'It's Me' and broadcasts the resolved state", async () => {
    const repo = {
      findExpiredPendingLogins: jest.fn(async () => [loginRow()]),
      recordAction: jest.fn(async () =>
        loginRow({ loginResolvedAt: new Date() })
      ),
    };

    const resolved = await serviceWith(repo).sweepExpiredLoginNotifications(
      new Date(),
      100
    );

    expect(resolved).toBe(1);
    // Same action string the manual "It's Me" button records — never TERMINATED.
    expect(repo.recordAction).toHaveBeenCalledWith(
      "n1",
      "u1",
      "This was you.",
      "TRUSTED"
    );
    const [, , event, payload] = publishUserSocketEvent.mock
      .calls[0] as unknown as [unknown, string, string, AnyRec];
    expect(event).toBe("notification:updated");
    expect(payload).toMatchObject({
      notificationId: "n1",
      isRead: true,
      data: { actionTaken: "TRUSTED", sessionId: "s1" },
    });
  });

  it("counts nothing and broadcasts nothing when the claim was lost (already actioned)", async () => {
    const repo = {
      findExpiredPendingLogins: jest.fn(async () => [loginRow()]),
      recordAction: jest.fn(async () => null),
    };

    const resolved = await serviceWith(repo).sweepExpiredLoginNotifications(
      new Date(),
      100
    );

    expect(resolved).toBe(0);
    expect(publishUserSocketEvent).not.toHaveBeenCalled();
  });
});
