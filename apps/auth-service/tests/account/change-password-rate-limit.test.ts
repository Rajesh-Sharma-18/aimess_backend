/**
 * AUDIT-107 — POST /api/auth/change-password had authentication and a body
 * validator, but no rate limit.
 *
 * The handler verifies `currentPassword` before accepting the new one, so an
 * unthrottled endpoint is a password oracle running at request speed: anyone
 * holding a stolen access token can guess until they hit the real password, and
 * a successful change then signs every OTHER device out — the legitimate owner
 * loses the account outright. The limiter is keyed by userId and sits AFTER
 * authentication, the same shape DELETE /api/auth/account uses.
 *
 * Same lazy-import dance as account-deletion-rate-limit.test.ts: the ceiling is
 * read from env at import time, so the app is required only after the override,
 * and the override is undone so a leaked ceiling can't 429 a sibling spec.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByIdForAccountOps: jest.fn(),
    updatePasswordHash: jest.fn(),
    revokeSessionsAfterPasswordChange: jest.fn(),
  },
}));
jest.mock("../../src/repositories/session.repository.js", () => ({
  sessionRepository: { listActiveSessionIds: jest.fn(async () => []) },
}));

import request from "supertest";
import bcrypt from "bcryptjs";

import { authRepository } from "../../src/repositories/auth.repository.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;
const LIMIT = 2;

let app: import("express").Express;
let passwordHash: string;
const sharedLimit = process.env.CHANGE_PASSWORD_RATE_LIMIT_MAX;

beforeAll(async () => {
  process.env.CHANGE_PASSWORD_RATE_LIMIT_MAX = String(LIMIT);
  app = (await import("../../src/app.js")).default;
  passwordHash = await bcrypt.hash("Password123", 4);
});

afterAll(() => {
  process.env.CHANGE_PASSWORD_RATE_LIMIT_MAX = sharedLimit;
});

describe("POST /api/auth/change-password rate limit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repo.findByIdForAccountOps.mockResolvedValue({
      id: TEST_USER_ID,
      email: "john@example.com",
      emailVerified: true,
      passwordHash,
      status: "ACTIVE",
      deletedAt: null,
    });
  });

  it("429s once the per-user hourly ceiling is exhausted, and never changes the password", async () => {
    const token = makeAccessToken();
    const wrongGuess = {
      currentPassword: "WrongPassword99",
      newPassword: "BrandNewPass123",
    };

    for (let attempt = 0; attempt < LIMIT; attempt++) {
      const res = await request(app)
        .post("/api/auth/change-password")
        .set(bearer(token))
        .send(wrongGuess);
      // A wrong current password is rejected — that rejection is exactly the
      // oracle the limiter has to cap.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(429);
    }

    const blocked = await request(app)
      .post("/api/auth/change-password")
      .set(bearer(token))
      .send(wrongGuess);

    expect(blocked.status).toBe(429);
    expect(repo.updatePasswordHash).not.toHaveBeenCalled();
  });
});
