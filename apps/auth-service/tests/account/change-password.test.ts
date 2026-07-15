/**
 * POST /api/auth/change-password (auth required). Real bcrypt compare against a
 * mocked stored hash; the account-guard repository + the write repos are mocked
 * so each branch (no password set, wrong current, same-as-new, success) runs.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByIdForAccountOps: jest.fn(),
    updatePasswordHash: jest.fn(async () => undefined),
    revokeSessionsAfterPasswordChange: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/repositories/session.repository.js", () => ({
  sessionRepository: {
    listActiveSessionIds: jest.fn(async () => []),
  },
}));

import request from "supertest";
import bcrypt from "bcryptjs";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;

const CURRENT = "CurrentPass123";
let currentHash: string;

beforeAll(async () => {
  currentHash = await bcrypt.hash(CURRENT, 4);
});

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_USER_ID,
    email: "john@example.com",
    emailVerified: true,
    passwordHash: currentHash,
    status: "ACTIVE",
    deletedAt: null,
    ...overrides,
  };
}

describe("POST /api/auth/change-password", () => {
  beforeEach(() => {
    repo.findByIdForAccountOps.mockResolvedValue(activeUser());
  });

  it("changes the password with the correct current password → 200", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .set(bearer(makeAccessToken()))
      .send({ currentPassword: CURRENT, newPassword: "BrandNewPass456" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(repo.updatePasswordHash).toHaveBeenCalledTimes(1);
    expect(repo.revokeSessionsAfterPasswordChange).toHaveBeenCalledWith(
      TEST_USER_ID
    );
  });

  it("returns 400 for an incorrect current password", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .set(bearer(makeAccessToken()))
      .send({
        currentPassword: "WrongCurrent99",
        newPassword: "BrandNewPass456",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Current password is incorrect.");
    expect(repo.updatePasswordHash).not.toHaveBeenCalled();
  });

  it("returns 400 when the new password equals the current one", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .set(bearer(makeAccessToken()))
      .send({ currentPassword: CURRENT, newPassword: CURRENT });

    expect(res.status).toBe(400);
    expect(repo.updatePasswordHash).not.toHaveBeenCalled();
  });

  it("returns 400 when the account has no password set (social-only)", async () => {
    repo.findByIdForAccountOps.mockResolvedValue(
      activeUser({ passwordHash: null })
    );

    const res = await request(app)
      .post("/api/auth/change-password")
      .set(bearer(makeAccessToken()))
      .send({ currentPassword: CURRENT, newPassword: "BrandNewPass456" });

    expect(res.status).toBe(400);
  });

  it("returns 401 when the account is not active (guard throws)", async () => {
    repo.findByIdForAccountOps.mockResolvedValue(
      activeUser({ status: "SUSPENDED" })
    );

    const res = await request(app)
      .post("/api/auth/change-password")
      .set(bearer(makeAccessToken()))
      .send({ currentPassword: CURRENT, newPassword: "BrandNewPass456" });

    expect(res.status).toBe(401);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: CURRENT, newPassword: "BrandNewPass456" });

    expect(res.status).toBe(401);
    expect(repo.findByIdForAccountOps).not.toHaveBeenCalled();
  });

  it.each([
    [
      "new password too short",
      { currentPassword: CURRENT, newPassword: "short" },
    ],
    ["missing newPassword", { currentPassword: CURRENT }],
    ["missing currentPassword", { newPassword: "BrandNewPass456" }],
    [
      "new password too long (>128)",
      { currentPassword: CURRENT, newPassword: "a".repeat(129) },
    ],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .set(bearer(makeAccessToken()))
      .send(body);

    expect(res.status).toBe(400);
  });
});
