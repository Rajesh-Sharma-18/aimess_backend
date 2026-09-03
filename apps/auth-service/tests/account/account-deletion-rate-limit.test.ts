/**
 * DELETE /api/auth/account is deliberately NOT rate limited (the per-user
 * 5/hour limiter was removed on 2026-08-12 — see the comment in
 * api/routes/account-deletion.routes.ts).
 *
 * This spec is the guard on that decision: it fails loudly if a limiter is ever
 * re-introduced silently, and documents the security trade being accepted. If
 * you are re-adding one on purpose, rewrite this file rather than deleting it.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByIdForAccountOps: jest.fn(),
    softDeleteUser: jest.fn(),
  },
}));
jest.mock("../../src/messaging/publish-user-deleted.js", () => ({
  publishUserDeletedSafe: jest.fn(),
}));

import request from "supertest";
import bcrypt from "bcryptjs";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;

/** Comfortably more than any limiter this endpoint has ever had (the old one was 5). */
const ATTEMPTS = 12;

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await bcrypt.hash("Correct-Horse-Battery-7", 4);
});

describe("DELETE /api/auth/account is not throttled", () => {
  beforeEach(() => {
    repo.findByIdForAccountOps.mockResolvedValue({
      id: TEST_USER_ID,
      email: "john@example.com",
      emailVerified: true,
      passwordHash,
      status: "ACTIVE",
      deletedAt: null,
    });
  });

  it("never 429s, however many wrong passwords are submitted", async () => {
    const token = makeAccessToken();

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const res = await request(app)
        .delete("/api/auth/account")
        .set(bearer(token))
        .send({ password: "WrongPassword99" });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("The password you entered is incorrect.");
    }

    expect(repo.softDeleteUser).not.toHaveBeenCalled();
  });

  it("emits no RateLimit headers at all", async () => {
    const res = await request(app)
      .delete("/api/auth/account")
      .set(bearer(makeAccessToken()))
      .send({ password: "WrongPassword99" });

    expect(res.headers["ratelimit"]).toBeUndefined();
    expect(res.headers["ratelimit-policy"]).toBeUndefined();
    expect(res.headers["retry-after"]).toBeUndefined();
  });

  it("still deletes on the correct password after many failures", async () => {
    const token = makeAccessToken();
    repo.softDeleteUser.mockResolvedValue({
      deletedAt: new Date("2026-08-12T00:00:00.000Z"),
      revokedSessionIds: [],
    });

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      await request(app)
        .delete("/api/auth/account")
        .set(bearer(token))
        .send({ password: "WrongPassword99" });
    }

    const res = await request(app)
      .delete("/api/auth/account")
      .set(bearer(token))
      .send({ password: "Correct-Horse-Battery-7" });

    expect(res.status).toBe(200);
    expect(repo.softDeleteUser).toHaveBeenCalledTimes(1);
  });
});
