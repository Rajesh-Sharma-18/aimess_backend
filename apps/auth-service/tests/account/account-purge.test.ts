/**
 * AIM-44 — deleting an account must actually erase the personal data.
 *
 * `DELETE /api/auth/account` marked the row, revoked sessions and recorded a
 * 30-day `scheduledDeletionAt`. Nothing read that date: no purge job existed,
 * so email, phone, password hash, the Google/Apple identities and the whole
 * profile were retained indefinitely. The "Deleted Account" users saw was a
 * read-time projection over live data. A user exercising their right to erasure
 * got a flag.
 *
 * These cover the job that reads it, and the ordering that makes the erasure
 * reliable rather than best-effort.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findAccountsDueForPurge: jest.fn(),
    purgeAccount: jest.fn(),
  },
}));
jest.mock("../../src/messaging/publish-user-purged.js", () => ({
  tryPublishUserPurged: jest.fn(),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  recordAuditEventSafe: jest.fn(),
}));

import {
  anonymizedAccountFields,
  anonymizedLinkedAccountFields,
} from "../../src/lib/account-anonymize.js";
import { runAccountPurgeOnce } from "../../src/jobs/account-purge-sweeper.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { tryPublishUserPurged } from "../../src/messaging/publish-user-purged.js";
import { recordAuditEventSafe } from "../../src/services/audit.service.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;
const publish = tryPublishUserPurged as unknown as jest.Mock;
const audit = recordAuditEventSafe as unknown as jest.Mock;

const USER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  repo.findAccountsDueForPurge.mockResolvedValue([
    { id: USER, scheduledDeletionAt: new Date("2026-08-01T00:00:00.000Z") },
  ]);
  repo.purgeAccount.mockResolvedValue(true);
  publish.mockResolvedValue(true);
});

describe("anonymized values", () => {
  it("removes every identifying field", () => {
    const fields = anonymizedAccountFields(USER);

    expect(fields.email).toBeNull();
    expect(fields.phone).toBeNull();
    // The hash is a credential, and a target for offline cracking against
    // password reuse elsewhere. It must not outlive the account.
    expect(fields.passwordHash).toBeNull();
    expect(fields.dateOfBirth).toBeNull();
    // Push tokens address a physical device; keeping them would let a purged
    // account still receive notifications.
    expect(fields.fcmTokens).toEqual([]);
    expect(fields.emailVerified).toBe(false);
  });

  it("replaces the login handle, which is user-chosen and often a real name", () => {
    const fields = anonymizedAccountFields(USER);

    expect(fields.account).toMatch(/^deleted_[0-9a-f]{16}$/);
    expect(fields.account).not.toContain(USER);
  });

  it("is stable for one user and distinct between users, so unique indexes hold", () => {
    // Stable: a replay writes the same values. Distinct: two purged accounts
    // cannot collide on the unique `account` index.
    expect(anonymizedAccountFields(USER).account).toBe(
      anonymizedAccountFields(USER).account
    );
    expect(anonymizedAccountFields(USER).account).not.toBe(
      anonymizedAccountFields("22222222-2222-4222-8222-222222222222").account
    );
  });

  it("replaces the provider subject, not just the provider email", () => {
    // `providerUserId` is a stable identifier for a real person at Google or
    // Apple, and it is what the by-provider lookup matches on. Leaving it would
    // let that person's next sign-in silently re-attach to the purged account.
    const link = anonymizedLinkedAccountFields(USER, "link-1");

    expect(link.providerUserId).toContain("purged:");
    expect(link.providerUserId).not.toBe("google-sub-123");
    expect(link.email).toBeNull();
    expect(link.displayName).toBeNull();
  });
});

describe("account purge sweeper", () => {
  it("erases an account whose grace period has elapsed", async () => {
    const result = await runAccountPurgeOnce();

    expect(repo.purgeAccount).toHaveBeenCalledWith(USER);
    expect(result.purged).toBe(1);
  });

  it("announces the purge BEFORE erasing", async () => {
    // If the event cannot be published, every other service keeps that user's
    // personal data with nothing to retry. Publishing first means the worst
    // case is a consumer purging a moment early — harmless, since the id it
    // works from does not change.
    const order: string[] = [];
    publish.mockImplementation(async () => {
      order.push("publish");
      return true;
    });
    repo.purgeAccount.mockImplementation(async () => {
      order.push("purge");
      return true;
    });

    await runAccountPurgeOnce();

    expect(order).toEqual(["publish", "purge"]);
  });

  it("does NOT erase when the event could not be published", async () => {
    publish.mockResolvedValue(false);

    const result = await runAccountPurgeOnce();

    expect(repo.purgeAccount).not.toHaveBeenCalled();
    expect(result.purged).toBe(0);
    expect(result.deferred).toBe(1);
  });

  it("leaves the account for the next tick when the erasure throws", async () => {
    // Reporting success on a half-completed erasure is worse than retrying.
    repo.purgeAccount.mockRejectedValue(new Error("database unavailable"));

    const result = await runAccountPurgeOnce();

    expect(result.purged).toBe(0);
    expect(result.deferred).toBe(1);
  });

  it("counts nothing when another replica won the claim", async () => {
    // `purgeAccount` claims atomically, so the loser must not double-count or
    // write a second audit record.
    repo.purgeAccount.mockResolvedValue(false);

    const result = await runAccountPurgeOnce();

    expect(result.purged).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("records the erasure in the audit trail", async () => {
    // The audit row is the only proof left that the erasure happened — the data
    // it refers to is gone.
    await runAccountPurgeOnce();

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ACCOUNT_PURGED", targetId: USER })
    );
  });

  it("does nothing when no account is due", async () => {
    repo.findAccountsDueForPurge.mockResolvedValue([]);

    const result = await runAccountPurgeOnce();

    expect(result).toEqual({ purged: 0, deferred: 0 });
    expect(publish).not.toHaveBeenCalled();
  });
});
