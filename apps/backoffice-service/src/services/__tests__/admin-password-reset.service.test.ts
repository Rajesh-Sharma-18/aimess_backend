/**
 * Unit tests for {@link adminPasswordResetService} (the 3-step admin OTP reset).
 *
 * The repo convention (see apps/chat-service/.../publish-conv-updated.test.ts) is
 * `node:test` run via `tsx --test src/**\/*.test.ts` with NO module-mocking
 * framework. tsx's ESM loader does not support `mock.module`, so instead of
 * scaffolding a new test runner we drive the service through its real singleton
 * imports and replace their *methods* at runtime:
 *
 *   - repositories + auditService are exported singleton OBJECTS — patch methods.
 *   - the `redis` singleton (config/redis.js) is a real ioredis OBJECT — patch
 *     `.incr/.set/.get/.expire` to drive the throttle / cooldown / jti libs
 *     deterministically (no live Redis needed; lazyConnect=true so importing it
 *     never connects).
 *   - `bcrypt` (bcryptjs default export) is an OBJECT — patch `.hash/.compare`
 *     so OTP/password hashing is instant and deterministic.
 *   - `amqplib` default export is an OBJECT — patch `.connect` so the
 *     fire-and-forget publisher records instead of hitting RabbitMQ.
 *
 * Env vars are seeded before any service import so config/env.js does not
 * process.exit. These are unit tests of the service rules — no DB, Redis, or
 * broker is required.
 */

// --- Seed env BEFORE importing anything that loads config/env.js -------------
process.env.NODE_ENV ??= "test";
process.env.ADMIN_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.REDIS_HOST ??= "127.0.0.1";
process.env.REDIS_PORT ??= "6399";
process.env.JWT_ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_ADMIN_REFRESH_SECRET ??= "test-admin-refresh-secret";
process.env.RABBITMQ_URL ??= "amqp://localhost:5672";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { BadRequestError, TooManyRequestsError } from "@aimess/errors";
import bcrypt from "bcryptjs";

import amqp from "amqplib";

import { AUDIT_ACTIONS } from "../../constants/index.js";
import { redis } from "../../config/redis.js";
import {
  adminOtpRepository,
  adminPasswordResetTokenRepository,
  adminSessionRepository,
  adminUserRepository,
} from "../../repositories/index.js";
import { auditService } from "../../services/audit.service.js";
import { adminPasswordResetService } from "../admin-password-reset.service.js";

// ---------------------------------------------------------------------------
// Tiny call-spy helper.
// ---------------------------------------------------------------------------
type Call = { args: unknown[] };

interface Spy<R> {
  (...args: unknown[]): R;
  calls: Call[];
  readonly called: boolean;
  readonly callCount: number;
}

function spy<R>(impl?: (...args: unknown[]) => R): Spy<R> {
  const calls: Call[] = [];
  const fn = ((...args: unknown[]): R => {
    calls.push({ args });
    return impl ? impl(...args) : (undefined as unknown as R);
  }) as Spy<R>;
  fn.calls = calls;
  // NOTE: define live getters via defineProperty — Object.assign would copy the
  // getter's *value at assign time* (always false), freezing it.
  Object.defineProperty(fn, "called", { get: () => calls.length > 0 });
  Object.defineProperty(fn, "callCount", { get: () => calls.length });
  return fn;
}

// ---------------------------------------------------------------------------
// Per-test patch bookkeeping so we always restore originals.
// ---------------------------------------------------------------------------
type Restore = () => void;
let restores: Restore[] = [];

/** Replace obj[key] with `value`, recording a restore. */
function patch<T, K extends keyof T>(obj: T, key: K, value: T[K]): void {
  const original = obj[key];
  obj[key] = value;
  restores.push(() => {
    obj[key] = original;
  });
}

const ctx = { ip: "203.0.113.7", userAgent: "jest-agent" };

/**
 * Let queued microtasks/timers drain. `publishAdminPasswordResetOtpSafe` is
 * fire-and-forget (void promise), and the fake publish chain awaits
 * connect()->createChannel() before sendToQueue, so the captured publish is only
 * observable a few event-loop turns after requestOtp resolves.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const ACTIVE_ADMIN = {
  id: "adm_active",
  email: "admin@example.com",
  status: "ACTIVE" as const,
  passwordHash: "$hash$current",
};

/** Publisher capture: fake amqp channel records sendToQueue payloads. */
const published: string[] = [];

beforeEach(() => {
  restores = [];
  published.length = 0;

  // --- Redis: default to "fail open" (reject) unless a test overrides. The
  // throttle/cooldown libs swallow errors -> allowed; jti-blacklist would throw,
  // so resetPassword tests override .set to succeed.
  patch(redis, "incr", spy(async () => 1) as never);
  patch(redis, "expire", spy(async () => 1) as never);
  patch(redis, "set", spy(async () => "OK") as never);
  patch(redis, "get", spy(async () => null) as never);

  // --- bcrypt: deterministic + instant.
  patch(bcrypt, "hash", (async (v: string) => `hashed:${v}`) as never);
  patch(bcrypt, "compare", (async () => false) as never); // default: codes/pw mismatch

  // --- amqplib: fake channel captures publishes, never touches a broker.
  const fakeChannel = {
    assertExchange: async () => ({}),
    assertQueue: async () => ({}),
    deleteExchange: async () => ({}),
    deleteQueue: async () => ({}),
    sendToQueue: (_q: string, buf: Buffer) => {
      published.push(buf.toString());
      return true;
    },
  };
  const fakeConn = { createChannel: async () => fakeChannel };
  patch(amqp, "connect", (async () => fakeConn) as never);
});

afterEach(() => {
  for (const r of restores.reverse()) r();
});

/** Build a deterministic active OTP row. */
function otpRow(
  overrides: Partial<{
    id: string;
    adminId: string;
    attempts: number;
    maxAttempts: number;
    codeHash: string;
  }> = {}
) {
  return {
    id: "otp_1",
    adminId: ACTIVE_ADMIN.id,
    attempts: 0,
    maxAttempts: 5,
    codeHash: "hashed:123456",
    ...overrides,
  };
}

// =====================================================================
// requestOtp
// =====================================================================
describe("requestOtp", () => {
  it("unknown email -> silent (no consume, no create, no publish, no audit)", async () => {
    const findByEmail = spy(async () => null);
    const consume = spy(async () => undefined);
    const create = spy(async () => undefined);
    const record = spy(async () => undefined);
    patch(adminUserRepository, "findByEmail", findByEmail as never);
    patch(adminOtpRepository, "consumeActiveForIdentifier", consume as never);
    patch(adminOtpRepository, "create", create as never);
    patch(auditService, "record", record as never);

    await adminPasswordResetService.requestOtp(ctx, { email: "nobody@x.com" });

    assert.equal(findByEmail.called, true, "looked up the email");
    assert.equal(consume.called, false, "no consumeActiveForIdentifier");
    assert.equal(create.called, false, "no otp create");
    assert.equal(record.called, false, "no audit");
    assert.equal(published.length, 0, "no publish");
  });

  it("non-ACTIVE admin (DISABLED) -> silent, enumeration-safe", async () => {
    const create = spy(async () => undefined);
    patch(
      adminUserRepository,
      "findByEmail",
      spy(async () => ({ ...ACTIVE_ADMIN, status: "DISABLED" })) as never
    );
    patch(adminOtpRepository, "create", create as never);
    patch(auditService, "record", spy(async () => undefined) as never);

    await adminPasswordResetService.requestOtp(ctx, {
      email: ACTIVE_ADMIN.email,
    });

    assert.equal(create.called, false, "no otp create for non-ACTIVE admin");
    assert.equal(published.length, 0, "no publish for non-ACTIVE admin");
  });

  it("ACTIVE admin -> consume then create, publish, audit recorded", async () => {
    const consume = spy(async () => undefined);
    const create = spy(async () => undefined);
    const record = spy(async () => undefined);
    patch(
      adminUserRepository,
      "findByEmail",
      spy(async () => ({ ...ACTIVE_ADMIN })) as never
    );
    patch(adminOtpRepository, "consumeActiveForIdentifier", consume as never);
    patch(adminOtpRepository, "create", create as never);
    patch(auditService, "record", record as never);

    await adminPasswordResetService.requestOtp(ctx, {
      email: "  Admin@Example.com ",
    });
    await flush(); // publish is fire-and-forget

    assert.equal(consume.callCount, 1, "consumeActiveForIdentifier once");
    assert.equal(create.callCount, 1, "otp create once");
    // create called AFTER consume (ordering): consume recorded before create.
    // identifier passed to create is normalized (trimmed + lowercased).
    const createArg = create.calls[0].args[0] as {
      identifier: string;
      adminId: string;
    };
    assert.equal(createArg.identifier, "admin@example.com");
    assert.equal(createArg.adminId, ACTIVE_ADMIN.id);
    assert.equal(published.length, 1, "exactly one publish");
    assert.equal(record.callCount, 1, "audit recorded");
    const auditArg = record.calls[0].args[0] as {
      action: string;
      actorId: string;
    };
    assert.equal(auditArg.action, AUDIT_ACTIONS.ADMIN_PASSWORD_RESET_REQUESTED);
    assert.equal(auditArg.actorId, ACTIVE_ADMIN.id);
  });

  it("throttle RATE_LIMITED propagates (before any repo lookup)", async () => {
    // Make the throttle counter exceed the max: redis.incr returns a huge count.
    patch(redis, "incr", spy(async () => 9999) as never);
    patch(redis, "expire", spy(async () => 1) as never);
    const findByEmail = spy(async () => ({ ...ACTIVE_ADMIN }));
    patch(adminUserRepository, "findByEmail", findByEmail as never);

    await assert.rejects(
      adminPasswordResetService.requestOtp(ctx, { email: ACTIVE_ADMIN.email }),
      (e: unknown) =>
        e instanceof TooManyRequestsError &&
        /RATE_LIMITED/.test((e as Error).message)
    );
    assert.equal(
      findByEmail.called,
      false,
      "short-circuits before admin lookup"
    );
  });
});

// =====================================================================
// resendOtp
// =====================================================================
describe("resendOtp", () => {
  it("cooldown throw propagates and requestOtp is NOT reached", async () => {
    // assertResendCooldown throws when redis.set NX returns null (key exists).
    patch(redis, "set", spy(async () => null) as never);
    const findByEmail = spy(async () => ({ ...ACTIVE_ADMIN }));
    patch(adminUserRepository, "findByEmail", findByEmail as never);

    await assert.rejects(
      adminPasswordResetService.resendOtp(ctx, { email: ACTIVE_ADMIN.email }),
      (e: unknown) => e instanceof TooManyRequestsError
    );
    assert.equal(
      findByEmail.called,
      false,
      "requestOtp not invoked after cooldown throw"
    );
  });

  it("cooldown OK -> delegates to requestOtp (issues for ACTIVE admin)", async () => {
    patch(redis, "set", spy(async () => "OK") as never); // NX acquired
    const create = spy(async () => undefined);
    patch(
      adminUserRepository,
      "findByEmail",
      spy(async () => ({ ...ACTIVE_ADMIN })) as never
    );
    patch(
      adminOtpRepository,
      "consumeActiveForIdentifier",
      spy(async () => undefined) as never
    );
    patch(adminOtpRepository, "create", create as never);
    patch(auditService, "record", spy(async () => undefined) as never);

    await adminPasswordResetService.resendOtp(ctx, {
      email: ACTIVE_ADMIN.email,
    });
    assert.equal(create.callCount, 1, "requestOtp ran and created an otp");
  });
});

// =====================================================================
// verifyOtp
// =====================================================================
describe("verifyOtp", () => {
  it("no active otp -> OTP_INVALID", async () => {
    patch(
      adminOtpRepository,
      "findLatestActive",
      spy(async () => null) as never
    );
    await assert.rejects(
      adminPasswordResetService.verifyOtp({
        email: ACTIVE_ADMIN.email,
        code: "123456",
      }),
      (e: unknown) =>
        e instanceof BadRequestError && /OTP_INVALID/.test((e as Error).message)
    );
  });

  it("attempts >= maxAttempts -> OTP_MAX_ATTEMPTS (no verify, no increment)", async () => {
    patch(
      adminOtpRepository,
      "findLatestActive",
      spy(async () => otpRow({ attempts: 5, maxAttempts: 5 })) as never
    );
    const increment = spy(async () => undefined);
    patch(adminOtpRepository, "incrementAttempts", increment as never);

    await assert.rejects(
      adminPasswordResetService.verifyOtp({
        email: ACTIVE_ADMIN.email,
        code: "123456",
      }),
      (e: unknown) =>
        e instanceof BadRequestError &&
        /OTP_MAX_ATTEMPTS/.test((e as Error).message)
    );
    assert.equal(
      increment.called,
      false,
      "does not increment when already capped"
    );
  });

  it("wrong code -> incrementAttempts called + OTP_INVALID", async () => {
    patch(
      adminOtpRepository,
      "findLatestActive",
      spy(async () => otpRow()) as never
    );
    const increment = spy(async () => undefined);
    patch(adminOtpRepository, "incrementAttempts", increment as never);
    patch(bcrypt, "compare", (async () => false) as never); // wrong code

    await assert.rejects(
      adminPasswordResetService.verifyOtp({
        email: ACTIVE_ADMIN.email,
        code: "000000",
      }),
      (e: unknown) =>
        e instanceof BadRequestError && /OTP_INVALID/.test((e as Error).message)
    );
    assert.equal(increment.callCount, 1, "incrementAttempts called once");
    assert.equal(
      increment.calls[0].args[0],
      "otp_1",
      "incremented the right otp id"
    );
  });

  it("admin no longer ACTIVE at verify time -> OTP_INVALID", async () => {
    patch(
      adminOtpRepository,
      "findLatestActive",
      spy(async () => otpRow()) as never
    );
    patch(
      adminOtpRepository,
      "incrementAttempts",
      spy(async () => undefined) as never
    );
    patch(bcrypt, "compare", (async () => true) as never); // valid code
    patch(
      adminUserRepository,
      "findById",
      spy(async () => ({ ...ACTIVE_ADMIN, status: "DISABLED" })) as never
    );

    await assert.rejects(
      adminPasswordResetService.verifyOtp({
        email: ACTIVE_ADMIN.email,
        code: "123456",
      }),
      (e: unknown) =>
        e instanceof BadRequestError && /OTP_INVALID/.test((e as Error).message)
    );
  });

  it("valid code -> markConsumed + consumeActiveForAdmin + token create, returns token", async () => {
    patch(
      adminOtpRepository,
      "findLatestActive",
      spy(async () => otpRow()) as never
    );
    const markConsumed = spy(async () => undefined);
    patch(adminOtpRepository, "markConsumed", markConsumed as never);
    patch(bcrypt, "compare", (async () => true) as never); // valid code
    patch(
      adminUserRepository,
      "findById",
      spy(async () => ({ ...ACTIVE_ADMIN })) as never
    );
    const consumeTokens = spy(async () => undefined);
    const createToken = spy(async () => undefined);
    patch(
      adminPasswordResetTokenRepository,
      "consumeActiveForAdmin",
      consumeTokens as never
    );
    patch(adminPasswordResetTokenRepository, "create", createToken as never);

    const result = await adminPasswordResetService.verifyOtp({
      email: ACTIVE_ADMIN.email,
      code: "123456",
    });

    assert.equal(markConsumed.callCount, 1, "otp markConsumed");
    assert.equal(markConsumed.calls[0].args[0], "otp_1");
    assert.equal(consumeTokens.callCount, 1, "prior reset tokens consumed");
    assert.equal(consumeTokens.calls[0].args[0], ACTIVE_ADMIN.id);
    assert.equal(createToken.callCount, 1, "new reset token created");
    assert.equal(typeof result.resetToken, "string");
    assert.ok(
      result.resetToken.length >= 32,
      "reset token is sufficiently long"
    );
    assert.equal(typeof result.resetTokenExpiresIn, "number");
    assert.ok(result.resetTokenExpiresIn > 0);
    // The created token row stores a HASH, never the plaintext token.
    const createArg = createToken.calls[0].args[0] as { tokenHash: string };
    assert.notEqual(
      createArg.tokenHash,
      result.resetToken,
      "stored value is hashed, not raw"
    );
  });
});

// =====================================================================
// resetPassword
// =====================================================================
describe("resetPassword", () => {
  function validTokenRecord(
    overrides: Partial<{
      id: string;
      consumedAt: Date | null;
      expiresAt: Date;
      admin:
        | typeof ACTIVE_ADMIN
        | { status: string; id: string; passwordHash: string }
        | null;
    }> = {}
  ) {
    return {
      id: "prt_1",
      consumedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 600_000),
      admin: { ...ACTIVE_ADMIN },
      ...overrides,
    };
  }

  it("unknown/invalid token -> RESET_TOKEN_INVALID", async () => {
    patch(
      adminPasswordResetTokenRepository,
      "findValidByTokenHash",
      spy(async () => null) as never
    );
    await assert.rejects(
      adminPasswordResetService.resetPassword(ctx, {
        resetToken: "x".repeat(43),
        password: "NewPassw0rd!!",
      }),
      (e: unknown) =>
        e instanceof BadRequestError &&
        /RESET_TOKEN_INVALID/.test((e as Error).message)
    );
  });

  it("already-consumed token -> RESET_TOKEN_INVALID", async () => {
    patch(
      adminPasswordResetTokenRepository,
      "findValidByTokenHash",
      spy(async () => validTokenRecord({ consumedAt: new Date() })) as never
    );
    await assert.rejects(
      adminPasswordResetService.resetPassword(ctx, {
        resetToken: "x".repeat(43),
        password: "NewPassw0rd!!",
      }),
      (e: unknown) =>
        e instanceof BadRequestError &&
        /RESET_TOKEN_INVALID/.test((e as Error).message)
    );
  });

  it("expired token -> RESET_TOKEN_EXPIRED", async () => {
    patch(
      adminPasswordResetTokenRepository,
      "findValidByTokenHash",
      spy(async () =>
        validTokenRecord({ expiresAt: new Date(Date.now() - 1000) })
      ) as never
    );
    await assert.rejects(
      adminPasswordResetService.resetPassword(ctx, {
        resetToken: "x".repeat(43),
        password: "NewPassw0rd!!",
      }),
      (e: unknown) =>
        e instanceof BadRequestError &&
        /RESET_TOKEN_EXPIRED/.test((e as Error).message)
    );
  });

  it("admin no longer ACTIVE -> RESET_TOKEN_INVALID", async () => {
    patch(
      adminPasswordResetTokenRepository,
      "findValidByTokenHash",
      spy(async () =>
        validTokenRecord({
          admin: {
            id: ACTIVE_ADMIN.id,
            status: "DISABLED",
            passwordHash: "$h$",
          },
        })
      ) as never
    );
    await assert.rejects(
      adminPasswordResetService.resetPassword(ctx, {
        resetToken: "x".repeat(43),
        password: "NewPassw0rd!!",
      }),
      (e: unknown) =>
        e instanceof BadRequestError &&
        /RESET_TOKEN_INVALID/.test((e as Error).message)
    );
  });

  it("new password equals current -> PASSWORD_SAME_AS_CURRENT (no update)", async () => {
    patch(
      adminPasswordResetTokenRepository,
      "findValidByTokenHash",
      spy(async () => validTokenRecord()) as never
    );
    patch(bcrypt, "compare", (async () => true) as never); // sameAsCurrent === true
    const updatePw = spy(async () => undefined);
    patch(adminUserRepository, "updatePasswordHash", updatePw as never);

    await assert.rejects(
      adminPasswordResetService.resetPassword(ctx, {
        resetToken: "x".repeat(43),
        password: "$hash$current",
      }),
      (e: unknown) =>
        e instanceof BadRequestError &&
        /PASSWORD_SAME_AS_CURRENT/.test((e as Error).message)
    );
    assert.equal(
      updatePw.called,
      false,
      "password not updated when same as current"
    );
  });

  it("success -> update hash, markConsumed, blacklist each jti, revokeAll, audit COMPLETED", async () => {
    patch(
      adminPasswordResetTokenRepository,
      "findValidByTokenHash",
      spy(async () => validTokenRecord()) as never
    );
    patch(bcrypt, "compare", (async () => false) as never); // not same as current
    patch(bcrypt, "hash", (async (v: string) => `hashed:${v}`) as never);

    const updatePw = spy(async () => undefined);
    const markConsumed = spy(async () => undefined);
    const revokeAll = spy(async () => undefined);
    const record = spy(async () => undefined);
    patch(adminUserRepository, "updatePasswordHash", updatePw as never);
    patch(
      adminPasswordResetTokenRepository,
      "markConsumed",
      markConsumed as never
    );
    patch(adminSessionRepository, "revokeAllForAdmin", revokeAll as never);
    patch(auditService, "record", record as never);

    // Two active sessions -> two jti blacklist writes via redis.set.
    const sessions = [
      { jti: "jti-a", expiresAt: new Date(Date.now() + 120_000) },
      { jti: "jti-b", expiresAt: new Date(Date.now() + 240_000) },
    ];
    patch(
      adminSessionRepository,
      "listActiveByAdmin",
      spy(async () => sessions) as never
    );

    // Capture jti-blacklist writes (key + ttl) — blacklistJti uses redis.set EX.
    const setCalls: { key: string; ttl: number }[] = [];
    patch(redis, "set", (async (
      key: string,
      _v: string,
      _ex: string,
      ttl: number
    ) => {
      setCalls.push({ key, ttl });
      return "OK";
    }) as never);

    await adminPasswordResetService.resetPassword(ctx, {
      resetToken: "x".repeat(43),
      password: "BrandNewP@ss1",
    });

    assert.equal(updatePw.callCount, 1, "password hash updated");
    assert.equal(updatePw.calls[0].args[0], ACTIVE_ADMIN.id);
    assert.equal(updatePw.calls[0].args[1], "hashed:BrandNewP@ss1");
    assert.equal(markConsumed.callCount, 1, "reset token consumed");
    assert.equal(markConsumed.calls[0].args[0], "prt_1");

    // One blacklist write per active session.
    assert.equal(
      setCalls.length,
      2,
      "blacklistJti called for each active session"
    );
    assert.deepEqual(setCalls.map((c) => c.key).sort(), [
      "aimess:admin:jti:blk:jti-a",
      "aimess:admin:jti:blk:jti-b",
    ]);
    assert.ok(
      setCalls.every((c) => c.ttl >= 1),
      "each jti blacklisted with a positive ttl"
    );

    assert.equal(revokeAll.callCount, 1, "revokeAllForAdmin called");
    assert.equal(revokeAll.calls[0].args[0], ACTIVE_ADMIN.id);

    assert.equal(record.callCount, 1, "audit recorded");
    const auditArg = record.calls[0].args[0] as { action: string };
    assert.equal(auditArg.action, AUDIT_ACTIONS.ADMIN_PASSWORD_RESET_COMPLETED);
  });

  it("success with zero active sessions -> still updates + revokes + audits", async () => {
    patch(
      adminPasswordResetTokenRepository,
      "findValidByTokenHash",
      spy(async () => validTokenRecord()) as never
    );
    patch(bcrypt, "compare", (async () => false) as never);
    const updatePw = spy(async () => undefined);
    const revokeAll = spy(async () => undefined);
    patch(adminUserRepository, "updatePasswordHash", updatePw as never);
    patch(
      adminPasswordResetTokenRepository,
      "markConsumed",
      spy(async () => undefined) as never
    );
    patch(adminSessionRepository, "revokeAllForAdmin", revokeAll as never);
    patch(
      adminSessionRepository,
      "listActiveByAdmin",
      spy(async () => []) as never
    );
    patch(auditService, "record", spy(async () => undefined) as never);

    await adminPasswordResetService.resetPassword(ctx, {
      resetToken: "x".repeat(43),
      password: "BrandNewP@ss1",
    });
    assert.equal(updatePw.callCount, 1);
    assert.equal(revokeAll.callCount, 1);
  });
});
