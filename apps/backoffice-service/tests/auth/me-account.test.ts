/**
 * PATCH /v1/me and PATCH /v1/change-password — self-service "My Account".
 * Same controller-envelope style as logout-me.test.ts: `adminAuth` is real
 * (JWT + active-session gate), the service layer is mocked.
 */
jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: { findById: jest.fn() },
}));
jest.mock("../../src/lib/admin-perms-cache.js", () => ({
  getCachedAdminPermissions: jest.fn(async () => [] as string[]),
  invalidateAdminPermissions: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/index.js", () => {
  const actual = jest.requireActual("../../src/services/index.js");
  return {
    __esModule: true,
    ...actual,
    adminAuthService: {
      getMe: jest.fn(),
      updateMe: jest.fn(),
      changePassword: jest.fn(),
    },
  };
});

import request from "supertest";
import { ConflictError, UnauthorizedError } from "@aimess/errors";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { adminAuthService } from "../../src/services/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = adminAuthService as unknown as {
  getMe: jest.Mock;
  updateMe: jest.Mock;
  changePassword: jest.Mock;
};

const profile = {
  id: "admin-1",
  email: "admin@aimess.local",
  name: "Admin One",
  avatar: null,
  role: "ADMIN",
  status: "ACTIVE",
  lastLoginAt: null,
  permissions: [],
};

beforeEach(() => {
  configureActiveAdmin(findById);
  grantPermissions(perms, []);
  svc.updateMe.mockResolvedValue(profile);
  svc.changePassword.mockResolvedValue(undefined);
});

describe("PATCH /v1/me", () => {
  it("returns 200 with the updated profile", async () => {
    const res = await request(app)
      .patch("/v1/me")
      .set(bearer(makeAdminAccessToken()))
      .send({ username: "New Name", email: "new@aimess.local" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe("admin@aimess.local");
    expect(svc.updateMe).toHaveBeenCalledTimes(1);
    expect(svc.updateMe.mock.calls[0][1]).toMatchObject({
      username: "New Name",
      email: "new@aimess.local",
    });
  });

  it("accepts avatarObjectKey (nullable) and forwards it verbatim", async () => {
    await request(app)
      .patch("/v1/me")
      .set(bearer(makeAdminAccessToken()))
      .send({ avatarObjectKey: "avatars/adm_1/x.png" })
      .expect(200);
    expect(svc.updateMe.mock.calls[0][1]).toMatchObject({
      avatarObjectKey: "avatars/adm_1/x.png",
    });

    svc.updateMe.mockClear();
    await request(app)
      .patch("/v1/me")
      .set(bearer(makeAdminAccessToken()))
      .send({ avatarObjectKey: null })
      .expect(200);
    expect(svc.updateMe.mock.calls[0][1]).toMatchObject({
      avatarObjectKey: null,
    });
  });

  it("returns 400 when no field is provided", async () => {
    const res = await request(app)
      .patch("/v1/me")
      .set(bearer(makeAdminAccessToken()))
      .send({});
    expect(res.status).toBe(400);
    expect(svc.updateMe).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid email", async () => {
    const res = await request(app)
      .patch("/v1/me")
      .set(bearer(makeAdminAccessToken()))
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(svc.updateMe).not.toHaveBeenCalled();
  });

  it("returns 409 when the email is already taken", async () => {
    svc.updateMe.mockRejectedValueOnce(new ConflictError("ADMIN_EMAIL_TAKEN"));
    const res = await request(app)
      .patch("/v1/me")
      .set(bearer(makeAdminAccessToken()))
      .send({ email: "taken@aimess.local" });
    expect(res.status).toBe(409);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).patch("/v1/me").send({ username: "x" });
    expect(res.status).toBe(401);
    expect(svc.updateMe).not.toHaveBeenCalled();
  });
});

describe("PATCH /v1/change-password", () => {
  const goodBody = {
    currentPassword: "OldP@ss1",
    newPassword: "NewStr0ng!",
    confirmPassword: "NewStr0ng!",
  };

  it("returns 200 and confirms the change with a valid body", async () => {
    const res = await request(app)
      .patch("/v1/change-password")
      .set(bearer(makeAdminAccessToken()))
      .send(goodBody);
    expect(res.status).toBe(200);
    expect(res.body.data.passwordChanged).toBe(true);
    expect(svc.changePassword).toHaveBeenCalledTimes(1);
    expect(svc.changePassword.mock.calls[0][1]).toEqual({
      currentPassword: "OldP@ss1",
      newPassword: "NewStr0ng!",
    });
  });

  it("returns 400 when confirmPassword does not match", async () => {
    const res = await request(app)
      .patch("/v1/change-password")
      .set(bearer(makeAdminAccessToken()))
      .send({ ...goodBody, confirmPassword: "different" });
    expect(res.status).toBe(400);
    expect(svc.changePassword).not.toHaveBeenCalled();
  });

  it("returns 400 when the new password is same as current", async () => {
    const res = await request(app)
      .patch("/v1/change-password")
      .set(bearer(makeAdminAccessToken()))
      .send({
        currentPassword: "SameP@ss1",
        newPassword: "SameP@ss1",
        confirmPassword: "SameP@ss1",
      });
    expect(res.status).toBe(400);
    expect(svc.changePassword).not.toHaveBeenCalled();
  });

  it("returns 400 when the new password fails the policy", async () => {
    const res = await request(app)
      .patch("/v1/change-password")
      .set(bearer(makeAdminAccessToken()))
      .send({
        currentPassword: "OldP@ss1",
        newPassword: "short",
        confirmPassword: "short",
      });
    expect(res.status).toBe(400);
    expect(svc.changePassword).not.toHaveBeenCalled();
  });

  it("returns 401 when the current password is wrong", async () => {
    svc.changePassword.mockRejectedValueOnce(
      new UnauthorizedError("AUTH_INVALID_CREDENTIALS")
    );
    const res = await request(app)
      .patch("/v1/change-password")
      .set(bearer(makeAdminAccessToken()))
      .send(goodBody);
    expect(res.status).toBe(401);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).patch("/v1/change-password").send(goodBody);
    expect(res.status).toBe(401);
    expect(svc.changePassword).not.toHaveBeenCalled();
  });
});
