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
    customCredentialService: {
      list: jest.fn(),
      reveal: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    },
  };
});

import { ConflictError, NotFoundError } from "@aimess/errors";
import request from "supertest";

import { app } from "../../src/app.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { customCredentialService } from "../../src/services/index.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = customCredentialService as unknown as Record<string, jest.Mock>;

const ID = "3f2b6c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
const VIEW = {
  id: ID,
  name: "GIPHY_API_KEY",
  platform: "WEB",
  maskedValue: "••••1234",
  createdAt: 1_000,
  updatedAt: 1_000,
};
const BODY = { name: "GIPHY_API_KEY", platform: "WEB", value: "abcdefgh1234" };

const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  jest.clearAllMocks();
  configureActiveAdmin(findById);
  grantPermissions(perms, [PERMISSIONS.SETTINGS_MANAGE]);
  svc.list.mockResolvedValue([VIEW]);
  svc.create.mockResolvedValue(VIEW);
  svc.update.mockResolvedValue(VIEW);
  svc.remove.mockResolvedValue(undefined);
});

const ROUTES = [
  ["get", "/v1/custom-credentials", undefined],
  ["get", `/v1/custom-credentials/${ID}`, undefined],
  ["post", "/v1/custom-credentials", BODY],
  ["patch", `/v1/custom-credentials/${ID}`, { value: "abcdefgh1234" }],
  ["delete", `/v1/custom-credentials/${ID}`, undefined],
] as const;

describe("access control", () => {
  it.each(ROUTES)("%s %s needs a bearer token", async (method, path, body) => {
    const res = await request(app)[method](path).send(body);
    expect(res.status).toBe(401);
  });

  it.each(ROUTES)("%s %s needs settings.manage", async (method, path, body) => {
    grantPermissions(perms, [
      PERMISSIONS.SYSTEMHEALTH_READ,
      PERMISSIONS.ADMINS_MANAGE,
    ]);
    const res = await request(app)[method](path).set(auth()).send(body);
    expect(res.status).toBe(403);
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("GET /v1/custom-credentials", () => {
  it("returns the masked list", async () => {
    const res = await request(app).get("/v1/custom-credentials").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([VIEW]);
  });
});

describe("GET /v1/custom-credentials/:credentialId", () => {
  it("returns the credential with its value", async () => {
    svc.reveal.mockResolvedValue({ ...VIEW, value: "abcdefgh1234" });
    const res = await request(app)
      .get(`/v1/custom-credentials/${ID}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.value).toBe("abcdefgh1234");
    expect(svc.reveal).toHaveBeenCalledWith(
      ID,
      expect.any(String),
      expect.any(Object)
    );
  });

  it("rejects a non-uuid id", async () => {
    const res = await request(app)
      .get("/v1/custom-credentials/not-a-uuid")
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.reveal).not.toHaveBeenCalled();
  });
});

describe("POST /v1/custom-credentials", () => {
  it("creates a credential", async () => {
    const res = await request(app)
      .post("/v1/custom-credentials")
      .set(auth())
      .send({ ...BODY, value: "  abcdefgh1234  " });

    expect(res.status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(
      BODY,
      expect.any(String),
      expect.objectContaining({ ip: expect.any(String) })
    );
  });

  it.each([
    ["a missing value", { name: "GIPHY_API_KEY", platform: "WEB" }],
    ["a missing platform", { name: "GIPHY_API_KEY", value: "abcdefgh1234" }],
    ["an unknown platform", { ...BODY, platform: "DESKTOP" }],
    ["a lowercase name", { ...BODY, name: "giphy_api_key" }],
    ["a name with spaces", { ...BODY, name: "GIPHY KEY" }],
    ["a short value", { ...BODY, value: "abc" }],
    ["a value with whitespace", { ...BODY, value: "abcd efgh 1234" }],
    ["an unexpected field", { ...BODY, enabled: true }],
  ])("rejects %s", async (_label, body) => {
    const res = await request(app)
      .post("/v1/custom-credentials")
      .set(auth())
      .send(body);
    expect(res.status).toBe(400);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("answers 409 when the name already exists for that platform", async () => {
    svc.create.mockRejectedValue(new ConflictError("CUSTOM_CREDENTIAL_EXISTS"));
    const res = await request(app)
      .post("/v1/custom-credentials")
      .set(auth())
      .send(BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CUSTOM_CREDENTIAL_EXISTS");
  });
});

describe("PATCH /v1/custom-credentials/:credentialId", () => {
  it("updates any subset of fields", async () => {
    const res = await request(app)
      .patch(`/v1/custom-credentials/${ID}`)
      .set(auth())
      .send({ platform: "IOS" });
    expect(res.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith(
      ID,
      { platform: "IOS" },
      expect.any(String),
      expect.any(Object)
    );
  });

  it.each([
    ["no changes", ID, {}],
    ["an unexpected password field", ID, { platform: "IOS", password: "x" }],
    ["a non-uuid id", "not-a-uuid", { platform: "IOS" }],
  ])("rejects %s", async (_label, id, body) => {
    const res = await request(app)
      .patch(`/v1/custom-credentials/${id}`)
      .set(auth())
      .send(body);
    expect(res.status).toBe(400);
    expect(svc.update).not.toHaveBeenCalled();
  });

  it("404s on an unknown credential", async () => {
    svc.update.mockRejectedValue(
      new NotFoundError("CUSTOM_CREDENTIAL_NOT_FOUND")
    );
    const res = await request(app)
      .patch(`/v1/custom-credentials/${ID}`)
      .set(auth())
      .send({ platform: "IOS" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/custom-credentials/:credentialId", () => {
  it("deletes the credential", async () => {
    const res = await request(app)
      .delete(`/v1/custom-credentials/${ID}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.remove).toHaveBeenCalledWith(
      ID,
      expect.any(String),
      expect.any(Object)
    );
  });

  it("404s on an unknown credential", async () => {
    svc.remove.mockRejectedValue(
      new NotFoundError("CUSTOM_CREDENTIAL_NOT_FOUND")
    );
    const res = await request(app)
      .delete(`/v1/custom-credentials/${ID}`)
      .set(auth());
    expect(res.status).toBe(404);
  });
});
