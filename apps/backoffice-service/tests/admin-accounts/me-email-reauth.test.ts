/**
 * PATCH /v1/me email re-authentication. Repointing the login email is an
 * account takeover (email -> public forgot-password -> reset), so it now costs
 * the same `currentPassword` proof as PATCH /v1/change-password and revokes the
 * admin's other sessions. Name-only updates must stay password-free.
 */
jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: {
    findById: jest.fn(),
    findByEmail: jest.fn(async () => null),
    updateProfile: jest.fn(),
  },
  adminSessionRepository: {
    listActiveByAdmin: jest.fn(async () => []),
    revoke: jest.fn(async () => undefined),
  },
  rbacRepository: {
    getPermissionKeysForAdmin: jest.fn(async () => [] as string[]),
  },
}));
jest.mock("../../src/lib/password.js", () => ({
  verifyPassword: jest.fn(async () => true),
  hashPassword: jest.fn(async () => "hashed-password"),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => undefined) },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import {
  adminSessionRepository,
  adminUserRepository,
} from "../../src/repositories/index.js";
import { verifyPassword } from "../../src/lib/password.js";
import { markAdminSessionsRevoked } from "../../src/lib/admin-session-cache.js";
import {
  bearer,
  makeAdminAccessToken,
  TEST_ADMIN_ID,
  TEST_ADMIN_SESSION_ID,
} from "../helpers/auth.js";

const repo = adminUserRepository as unknown as Record<string, jest.Mock>;
const sessionRepo = adminSessionRepository as unknown as Record<
  string,
  jest.Mock
>;
const compare = verifyPassword as jest.Mock;

const CURRENT_EMAIL = "admin@aimess.local";
const NEW_EMAIL = "attacker@evil.local";
const OTHER_SESSION_ID = "66666666-6666-4666-8666-666666666666";

const auth = () => bearer(makeAdminAccessToken());

function adminRow(over: Record<string, unknown> = {}) {
  return {
    id: TEST_ADMIN_ID,
    email: CURRENT_EMAIL,
    name: "Admin One",
    avatarUrl: null,
    language: null,
    passwordHash: "stored-hash",
    status: "ACTIVE",
    lastLoginAt: null,
    role: { key: "ADMIN", name: "Admin" },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue(adminRow());
  repo.findByEmail.mockResolvedValue(null);
  repo.updateProfile.mockImplementation(
    async (_id: string, patch: Record<string, unknown>) =>
      adminRow({
        email: (patch.email as string) ?? CURRENT_EMAIL,
        name: (patch.name as string) ?? "Admin One",
      })
  );
  compare.mockResolvedValue(true);
  sessionRepo.listActiveByAdmin.mockResolvedValue([
    { id: TEST_ADMIN_SESSION_ID },
    { id: OTHER_SESSION_ID },
  ]);
});

describe("PATCH /v1/me", () => {
  it("rejects an email change submitted without currentPassword", async () => {
    const res = await request(app)
      .patch("/v1/me")
      .set(auth())
      .send({ email: NEW_EMAIL });

    expect(res.status).toBe(400);
    expect(repo.updateProfile).not.toHaveBeenCalled();
    expect(sessionRepo.revoke).not.toHaveBeenCalled();
  });

  it("rejects an email change when currentPassword is wrong", async () => {
    compare.mockResolvedValue(false);

    const res = await request(app)
      .patch("/v1/me")
      .set(auth())
      .send({ email: NEW_EMAIL, currentPassword: "not-my-password" });

    expect(res.status).toBe(400);
    expect(repo.updateProfile).not.toHaveBeenCalled();
  });

  it("changes the email with a correct currentPassword and revokes the other sessions", async () => {
    const res = await request(app)
      .patch("/v1/me")
      .set(auth())
      .send({ email: NEW_EMAIL, currentPassword: "Str0ng!Pass" });

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(NEW_EMAIL);
    expect(compare).toHaveBeenCalledWith("Str0ng!Pass", "stored-hash");
    // The caller's own session survives; every other one is revoked.
    expect(sessionRepo.revoke).toHaveBeenCalledTimes(1);
    expect(sessionRepo.revoke).toHaveBeenCalledWith(OTHER_SESSION_ID);
    expect(markAdminSessionsRevoked).toHaveBeenCalledWith([OTHER_SESSION_ID]);
  });

  it("still updates the username with no password and leaves sessions alone", async () => {
    const res = await request(app)
      .patch("/v1/me")
      .set(auth())
      .send({ username: "Renamed Admin" });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Renamed Admin");
    expect(compare).not.toHaveBeenCalled();
    expect(sessionRepo.revoke).not.toHaveBeenCalled();
  });
});
