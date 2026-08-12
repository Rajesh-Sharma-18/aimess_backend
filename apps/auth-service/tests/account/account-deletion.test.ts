/**
 * DELETE /api/auth/account (auth required). Soft-deletes the caller's account.
 * Password confirmation is mandatory only for accounts that have a password;
 * social-only accounts can delete without one. Real bcrypt compare; repository
 * + the user-deleted publisher are mocked.
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
jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  publishSessionRevokedEvent: jest.fn(async () => 0),
}));

import request from "supertest";
import bcrypt from "bcryptjs";

import { publishSessionRevokedEvent } from "@aimess/redis";

import app from "../../src/app.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;
const publishRevoked = publishSessionRevokedEvent as unknown as jest.Mock;

const PASSWORD = "Password123";
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_USER_ID,
    email: "john@example.com",
    emailVerified: true,
    passwordHash,
    status: "ACTIVE",
    deletedAt: null,
    ...overrides,
  };
}

describe("DELETE /api/auth/account", () => {
  beforeEach(() => {
    repo.findByIdForAccountOps.mockResolvedValue(activeUser());
    repo.softDeleteUser.mockResolvedValue({
      deletedAt: new Date("2026-06-11T00:00:00.000Z"),
      revokedSessionIds: ["sess-1", "sess-2"],
    });
  });

  it("deletes a password account with the correct password → 200", async () => {
    const res = await request(app)
      .delete("/api/auth/account")
      .set(bearer(makeAccessToken()))
      .send({ password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deletedAt).toBeDefined();
    expect(repo.softDeleteUser).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it("returns 400 when a password account omits the password", async () => {
    const res = await request(app)
      .delete("/api/auth/account")
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(400);
    expect(repo.softDeleteUser).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong password", async () => {
    const res = await request(app)
      .delete("/api/auth/account")
      .set(bearer(makeAccessToken()))
      .send({ password: "WrongPassword99" });

    expect(res.status).toBe(401);
    expect(repo.softDeleteUser).not.toHaveBeenCalled();
  });

  it("deletes a social-only account WITHOUT a password → 200", async () => {
    repo.findByIdForAccountOps.mockResolvedValue(
      activeUser({ passwordHash: null })
    );

    const res = await request(app)
      .delete("/api/auth/account")
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(200);
    expect(repo.softDeleteUser).toHaveBeenCalledTimes(1);
  });

  it("returns 401 when the account is already deleted / not active (guard throws)", async () => {
    repo.findByIdForAccountOps.mockResolvedValue(
      activeUser({ deletedAt: new Date() })
    );

    const res = await request(app)
      .delete("/api/auth/account")
      .set(bearer(makeAccessToken()))
      .send({ password: PASSWORD });

    expect(res.status).toBe(401);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .delete("/api/auth/account")
      .send({ password: PASSWORD });

    expect(res.status).toBe(401);
    expect(repo.findByIdForAccountOps).not.toHaveBeenCalled();
  });

  it("force-disconnects every revoked session on the live socket layer", async () => {
    const res = await request(app)
      .delete("/api/auth/account")
      .set(bearer(makeAccessToken()))
      .send({ password: PASSWORD });

    expect(res.status).toBe(200);
    expect(publishRevoked).toHaveBeenCalledTimes(2);
    expect(publishRevoked.mock.calls.map((call) => call[2])).toEqual([
      "sess-1",
      "sess-2",
    ]);
  });

  it("publishes nothing to the socket layer when the password is wrong", async () => {
    await request(app)
      .delete("/api/auth/account")
      .set(bearer(makeAccessToken()))
      .send({ password: "WrongPassword99" });

    expect(publishRevoked).not.toHaveBeenCalled();
  });

  it("returns 400 when the password is an empty string", async () => {
    const res = await request(app)
      .delete("/api/auth/account")
      .set(bearer(makeAccessToken()))
      .send({ password: "" });

    // Schema: password is .min(1) when present.
    expect(res.status).toBe(400);
  });
});
