/**
 * Unit coverage for the shared DB-error predicates + write-conflict retry
 * (src/lib/db-errors). These guard the hot per-room writes (allocateSequence,
 * last-message bump) that bursty concurrent sends contend on: Mongo/WiredTiger
 * raises a transient write-conflict (Prisma P2034 / Mongo code 112) for the
 * losers, and withWriteConflictRetry absorbs it so fast/parallel sends don't
 * fail with a user-visible SERVICE_ERROR.
 */

import {
  isDuplicateKeyError,
  isWriteConflictError,
  withWriteConflictRetry,
} from "../../src/lib/db-errors.js";

describe("isWriteConflictError", () => {
  it("matches Prisma P2034 transient transaction failures", () => {
    expect(
      isWriteConflictError({
        code: "P2034",
        message:
          "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
      })
    ).toBe(true);
  });

  it("matches raw Mongo WriteConflict (numeric code 112 and codeName)", () => {
    expect(isWriteConflictError({ code: 112 })).toBe(true);
    expect(isWriteConflictError({ codeName: "WriteConflict" })).toBe(true);
  });

  it("matches on message text when no code is mapped", () => {
    expect(
      isWriteConflictError({ message: "Please retry your transaction" })
    ).toBe(true);
  });

  it("does not match unrelated errors (incl. duplicate-key)", () => {
    expect(isWriteConflictError(null)).toBe(false);
    expect(isWriteConflictError(new Error("boom"))).toBe(false);
    expect(isWriteConflictError({ code: "P2002" })).toBe(false);
    expect(isWriteConflictError({ code: 11000 })).toBe(false);
  });

  it("is distinct from isDuplicateKeyError", () => {
    expect(isDuplicateKeyError({ code: "P2002" })).toBe(true);
    expect(isWriteConflictError({ code: "P2002" })).toBe(false);
  });
});

describe("withWriteConflictRetry", () => {
  it("returns the result without retrying when op succeeds", async () => {
    const op = jest.fn().mockResolvedValue(7);
    await expect(withWriteConflictRetry(op)).resolves.toBe(7);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries on a write conflict then succeeds", async () => {
    const op = jest
      .fn()
      .mockRejectedValueOnce({ code: "P2034", message: "write conflict" })
      .mockRejectedValueOnce({ code: 112 })
      .mockResolvedValue(42);
    await expect(withWriteConflictRetry(op, 5)).resolves.toBe(42);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("rethrows a non-conflict error immediately without retrying", async () => {
    const op = jest.fn().mockRejectedValue({ code: "P2002" });
    await expect(withWriteConflictRetry(op, 5)).rejects.toMatchObject({
      code: "P2002",
    });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last conflict after exhausting all attempts", async () => {
    const conflict = { code: "P2034", message: "write conflict" };
    const op = jest.fn().mockRejectedValue(conflict);
    await expect(withWriteConflictRetry(op, 3)).rejects.toBe(conflict);
    expect(op).toHaveBeenCalledTimes(3);
  });
});
