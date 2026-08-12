/**
 * DELETE /api/auth/account is irreversible and password-gated, so a stolen
 * session must not be able to brute-force the password through it. The limiter
 * is keyed by userId and sits AFTER authentication.
 *
 * The limiter's ceiling is read from env at import time, so this spec lowers it
 * and requires the app lazily (a top-level `import` would hoist above the
 * assignment and capture the shared 100 from tests/setup/env.ts). The override
 * is undone afterwards: Jest reuses one process for several spec files, and a
 * leaked ceiling of 2 would 429 the sibling account-deletion spec.
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

import { authRepository } from "../../src/repositories/auth.repository.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;
const LIMIT = 2;

let app: import("express").Express;
let passwordHash: string;
const sharedLimit = process.env.DELETE_ACCOUNT_RATE_LIMIT_MAX;

beforeAll(async () => {
  process.env.DELETE_ACCOUNT_RATE_LIMIT_MAX = String(LIMIT);
  // No resetModules: this spec never imports the app at top level, so its
  // module registry is still empty and the first load already picks up the
  // ceiling above. Resetting would re-evaluate every transitive module
  // (Redis/AMQP clients included) and blow the hook timeout.
  app = (await import("../../src/app.js")).default;
  passwordHash = await bcrypt.hash("Password123", 4);
});

afterAll(() => {
  process.env.DELETE_ACCOUNT_RATE_LIMIT_MAX = sharedLimit;
});

describe("DELETE /api/auth/account rate limit", () => {
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

  it("429s once the per-user hourly ceiling is exhausted", async () => {
    const token = makeAccessToken();

    for (let attempt = 0; attempt < LIMIT; attempt++) {
      const res = await request(app)
        .delete("/api/auth/account")
        .set(bearer(token))
        .send({ password: "WrongPassword99" });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app)
      .delete("/api/auth/account")
      .set(bearer(token))
      .send({ password: "WrongPassword99" });

    expect(blocked.status).toBe(429);
    expect(repo.softDeleteUser).not.toHaveBeenCalled();
  });
});
