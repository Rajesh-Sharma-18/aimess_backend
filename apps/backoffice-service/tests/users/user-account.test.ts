jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: { findById: jest.fn() },
}));
jest.mock("../../src/lib/admin-perms-cache.js", () => ({
  getCachedAdminPermissions: jest.fn(async () => [] as string[]),
  invalidateAdminPermissions: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => ({ id: "audit-1" })) },
}));
jest.mock("../../src/messaging/publish-admin-user-notify.js", () => ({
  publishAdminUserNotifySafe: jest.fn(),
}));
jest.mock("../../src/services/user-management.service.js", () => ({
  ...jest.requireActual("../../src/services/user-management.service.js"),
  announceUserDirectoryChange: jest.fn(),
}));
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: {
    adminGetUserIdentity: jest.fn(),
    adminSetUserEmail: jest.fn(),
    adminUnlinkSocial: jest.fn(),
  },
}));
jest.mock("../../src/grpc/user.client.js", () => ({
  userClient: {
    adminGetEditableProfile: jest.fn(),
    adminUpdateProfile: jest.fn(),
  },
}));
const mediaMock = {
  isDownloadable: jest.fn(),
  confirmUpload: jest.fn(),
  generateUserAvatarUploadUrl: jest.fn(),
};
jest.mock("../../src/grpc/media.client.js", () => ({
  getMediaConfirmClient: () => mediaMock,
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { authClient } from "../../src/grpc/auth.client.js";
import { userClient } from "../../src/grpc/user.client.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { publishAdminUserNotifySafe } from "../../src/messaging/publish-admin-user-notify.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { auditService } from "../../src/services/audit.service.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";

const auth = authClient as unknown as Record<string, jest.Mock>;
const user = userClient as unknown as Record<string, jest.Mock>;
const notify = publishAdminUserNotifySafe as jest.Mock;
const record = auditService.record as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;

const USER_ID = "user-123";
const PROFILE = {
  userId: USER_ID,
  username: "jdoe",
  firstName: "John",
  lastName: "Doe",
  bio: "",
  dateOfBirth: "1990-01-01",
  gender: "",
  avatarUrl: "",
};
const IDENTITY = {
  ok: true,
  errorCode: "",
  email: "",
  emailVerified: false,
  hasPassword: false,
  providers: [
    {
      provider: "GOOGLE",
      providerEmail: "john@gmail.com",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};
const headers = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  configureActiveAdmin(adminUserRepository.findById as jest.Mock);
  grantPermissions(perms, [PERMISSIONS.USERS_EDIT]);
  auth.adminGetUserIdentity.mockResolvedValue(IDENTITY);
  user.adminGetEditableProfile.mockResolvedValue({
    ok: true,
    errorCode: "",
    profile: PROFILE,
    changedFields: [],
  });
});

describe("permission gate", () => {
  it("rejects an edit from an admin holding only users.moderate", async () => {
    grantPermissions(perms, [PERMISSIONS.USERS_MODERATE]);
    const res = await request(app)
      .patch(`/v1/users/${USER_ID}`)
      .set(headers())
      .send({ firstName: "Jane" });
    expect(res.status).toBe(403);
    expect(user.adminUpdateProfile).not.toHaveBeenCalled();
  });

  it("rejects an unlink without users.edit", async () => {
    grantPermissions(perms, [PERMISSIONS.USERS_VIEW]);
    const res = await request(app)
      .delete(`/v1/users/${USER_ID}/linked-accounts/google`)
      .set(headers());
    expect(res.status).toBe(403);
    expect(auth.adminUnlinkSocial).not.toHaveBeenCalled();
  });

  it("lets users.edit read the account", async () => {
    const res = await request(app)
      .get(`/v1/users/${USER_ID}/account`)
      .set(headers());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      email: null,
      hasPassword: false,
      linkedAccounts: [{ provider: "GOOGLE", email: "john@gmail.com" }],
    });
  });
});

describe("PATCH /v1/users/:userId", () => {
  it("refuses fields that are not administratively editable", async () => {
    const res = await request(app)
      .patch(`/v1/users/${USER_ID}`)
      .set(headers())
      .send({ status: "ACTIVE" });
    expect(res.status).toBe(400);
  });

  it("refuses an empty body", async () => {
    const res = await request(app)
      .patch(`/v1/users/${USER_ID}`)
      .set(headers())
      .send({});
    expect(res.status).toBe(400);
  });

  it("applies email + profile, audits once and notifies once", async () => {
    auth.adminSetUserEmail.mockResolvedValue({
      ok: true,
      errorCode: "",
      changed: true,
      previousEmail: "",
      email: "john@example.com",
    });
    user.adminUpdateProfile.mockResolvedValue({
      ok: true,
      errorCode: "",
      profile: { ...PROFILE, firstName: "Jane" },
      changedFields: ["firstName"],
    });

    const res = await request(app)
      .patch(`/v1/users/${USER_ID}`)
      .set(headers())
      .send({ email: "John@Example.com", firstName: "Jane" });

    expect(res.status).toBe(200);
    expect(auth.adminSetUserEmail).toHaveBeenCalledWith(
      USER_ID,
      "john@example.com"
    );
    expect(user.adminUpdateProfile).toHaveBeenCalledWith(USER_ID, {
      firstName: "Jane",
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      action: "user.updated_by_admin",
      targetId: USER_ID,
      before: { email: null, firstName: "John" },
      after: { email: "john@example.com", firstName: "Jane" },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      userId: USER_ID,
      type: "admin.user_account_updated",
    });
  });

  it("neither audits nor notifies when nothing actually changed", async () => {
    user.adminUpdateProfile.mockResolvedValue({
      ok: true,
      errorCode: "",
      profile: PROFILE,
      changedFields: [],
    });
    const res = await request(app)
      .patch(`/v1/users/${USER_ID}`)
      .set(headers())
      .send({ firstName: "John" });
    expect(res.status).toBe(200);
    expect(record).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("surfaces a taken username as 409 without notifying", async () => {
    user.adminUpdateProfile.mockResolvedValue({
      ok: false,
      errorCode: "USER_USERNAME_TAKEN",
      profile: null,
      changedFields: [],
    });
    const res = await request(app)
      .patch(`/v1/users/${USER_ID}`)
      .set(headers())
      .send({ username: "taken" });
    expect(res.status).toBe(409);
    expect(notify).not.toHaveBeenCalled();
  });

  it("still records and notifies the email change when the profile write then fails", async () => {
    auth.adminSetUserEmail.mockResolvedValue({
      ok: true,
      errorCode: "",
      changed: true,
      previousEmail: "",
      email: "john@example.com",
    });
    user.adminUpdateProfile.mockResolvedValue({
      ok: false,
      errorCode: "USER_USERNAME_TAKEN",
      profile: null,
      changedFields: [],
    });
    const res = await request(app)
      .patch(`/v1/users/${USER_ID}`)
      .set(headers())
      .send({ email: "john@example.com", username: "taken" });
    expect(res.status).toBe(409);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].after).toEqual({
      email: "john@example.com",
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("admin avatar change", () => {
  const KEY = `avatars/${USER_ID}/new.png`;

  it("mints the upload URL under the target user, not the admin", async () => {
    mediaMock.generateUserAvatarUploadUrl.mockResolvedValue({
      uploadUrl: "https://minio/put",
      objectKey: KEY,
      expiresIn: 300,
      maxBytes: 5242880,
    });
    const res = await request(app)
      .post(`/v1/users/${USER_ID}/avatar/upload-url`)
      .set(headers())
      .send({ contentType: "image/png", contentLength: 1024 });
    expect(res.status).toBe(200);
    expect(mediaMock.generateUserAvatarUploadUrl).toHaveBeenCalledWith(
      USER_ID,
      "image/png",
      1024
    );
    expect(res.body.data).toMatchObject({
      objectKey: KEY,
      headers: { "Content-Type": "image/png" },
    });
  });

  it("refuses a key that belongs to another user before any write", async () => {
    const res = await request(app)
      .patch(`/v1/users/${USER_ID}`)
      .set(headers())
      .send({ avatarObjectKey: "avatars/someone-else/x.png" });
    expect(res.status).toBe(400);
    expect(mediaMock.confirmUpload).not.toHaveBeenCalled();
    expect(user.adminUpdateProfile).not.toHaveBeenCalled();
  });

  it("refuses an image the scanner rejected", async () => {
    mediaMock.isDownloadable.mockResolvedValue(false);
    mediaMock.confirmUpload.mockResolvedValue({
      scanStatus: "REJECTED",
      downloadable: false,
      fileSize: 10,
    });
    const res = await request(app)
      .patch(`/v1/users/${USER_ID}`)
      .set(headers())
      .send({ avatarObjectKey: KEY });
    expect(res.status).toBe(400);
    expect(user.adminUpdateProfile).not.toHaveBeenCalled();
  });

  it("confirms, saves and audits a clean avatar", async () => {
    mediaMock.isDownloadable.mockResolvedValue(false);
    mediaMock.confirmUpload.mockResolvedValue({
      scanStatus: "SKIPPED",
      downloadable: true,
      fileSize: 10,
    });
    user.adminUpdateProfile.mockResolvedValue({
      ok: true,
      errorCode: "",
      profile: { ...PROFILE, avatarUrl: KEY },
      changedFields: ["avatarUrl"],
    });
    const res = await request(app)
      .patch(`/v1/users/${USER_ID}`)
      .set(headers())
      .send({ avatarObjectKey: KEY });
    expect(res.status).toBe(200);
    expect(mediaMock.confirmUpload).toHaveBeenCalledWith(
      KEY,
      USER_ID,
      "USER_AVATAR"
    );
    expect(user.adminUpdateProfile).toHaveBeenCalledWith(USER_ID, {
      avatarObjectKey: KEY,
    });
    expect(record.mock.calls[0][0]).toMatchObject({
      before: { avatar: null },
      after: { avatar: KEY },
    });
  });
});

describe("DELETE /v1/users/:userId/linked-accounts/:provider", () => {
  it("refuses an unknown provider", async () => {
    const res = await request(app)
      .delete(`/v1/users/${USER_ID}/linked-accounts/facebook`)
      .set(headers());
    expect(res.status).toBe(400);
  });

  it("keeps the last sign-in method and does not notify", async () => {
    auth.adminUnlinkSocial.mockResolvedValue({
      ok: false,
      errorCode: "AUTH_LAST_SIGN_IN_METHOD",
      provider: "",
    });
    const res = await request(app)
      .delete(`/v1/users/${USER_ID}/linked-accounts/google`)
      .set(headers());
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("only sign-in method");
    expect(record).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("unlinks, audits and notifies exactly once", async () => {
    auth.adminUnlinkSocial.mockResolvedValue({
      ok: true,
      errorCode: "",
      provider: "GOOGLE",
    });
    const res = await request(app)
      .delete(`/v1/users/${USER_ID}/linked-accounts/google`)
      .set(headers());
    expect(res.status).toBe(200);
    expect(auth.adminUnlinkSocial).toHaveBeenCalledWith(USER_ID, "GOOGLE");
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].action).toBe(
      "user.social_account_unlinked_by_admin"
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
