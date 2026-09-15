/**
 * Service restart admin API wiring:
 *   GET  /v1/system-health/restarts
 *   POST /v1/system-health/services/:serviceKey/restart
 * Asserts the auth gate (401), that both routes are SUPER_ADMIN-only
 * (`settings.manage` + `systemhealth.read`, 403 otherwise — including for a
 * normal ADMIN who can read System Health), the allowlist on the path (400 for
 * anything else), that the request body is never used, and that errors carry no
 * internals. The orchestration itself is covered by service-restart.service.test.ts.
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
    serviceRestartService: {
      listRestarts: jest.fn(),
      startRestart: jest.fn(),
    },
  };
});

import { ConflictError } from "@aimess/errors";
import request from "supertest";

import { app } from "../../src/app.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { serviceRestartService } from "../../src/services/index.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";
import { bearer, makeAdminAccessToken, TEST_ADMIN_ID } from "../helpers/auth.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = serviceRestartService as unknown as {
  listRestarts: jest.Mock;
  startRestart: jest.Mock;
};

const SUPER_ADMIN = [PERMISSIONS.SYSTEMHEALTH_READ, PERMISSIONS.SETTINGS_MANAGE];
const OPERATION = {
  id: "op-1",
  serviceKey: "media",
  serviceName: "Media Service",
  status: "requested",
  previousStatus: "down",
  requestedAt: 1,
  restartedAt: null,
  completedAt: null,
  finalStatus: null,
  reason: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  configureActiveAdmin(findById);
  grantPermissions(perms, SUPER_ADMIN);
  svc.listRestarts.mockResolvedValue({ enabled: true, services: [] });
  svc.startRestart.mockResolvedValue(OPERATION);
});

const post = (key: string) =>
  request(app).post(`/v1/system-health/services/${key}/restart`);

describe("POST /v1/system-health/services/:serviceKey/restart", () => {
  it("202 for a Super Admin; only the path key reaches the service", async () => {
    const res = await post("media")
      .set(bearer(makeAdminAccessToken()))
      .set("x-request-id", "req-123")
      .send({ command: "docker restart aimess-backoffice-service", serviceKey: "backoffice" });

    expect(res.status).toBe(202);
    expect(res.body.data.operation).toEqual(OPERATION);
    expect(svc.startRestart).toHaveBeenCalledTimes(1);
    expect(svc.startRestart).toHaveBeenCalledWith(
      "media",
      TEST_ADMIN_ID,
      expect.objectContaining({ requestId: "req-123" })
    );
  });

  it("401 without a token", async () => {
    expect((await post("media")).status).toBe(401);
    expect(svc.startRestart).not.toHaveBeenCalled();
  });

  it("403 for an admin who can read System Health but is not Super Admin", async () => {
    grantPermissions(perms, [PERMISSIONS.SYSTEMHEALTH_READ, PERMISSIONS.ADMINS_MANAGE]);
    expect((await post("media").set(bearer(makeAdminAccessToken()))).status).toBe(403);

    grantPermissions(perms, [PERMISSIONS.SETTINGS_MANAGE]);
    expect((await post("media").set(bearer(makeAdminAccessToken()))).status).toBe(403);
    expect(svc.startRestart).not.toHaveBeenCalled();
  });

  it("400 for any key outside the allowlist", async () => {
    for (const key of [
      "backoffice",
      "backoffice-service",
      "api-gateway",
      "calls",
      "aimess-media-service",
      "constructor",
      encodeURIComponent("media; docker rm -f aimess-postgres"),
    ]) {
      const res = await post(key).set(bearer(makeAdminAccessToken()));
      expect(res.status).toBe(400);
    }
    expect(svc.startRestart).not.toHaveBeenCalled();
  });

  it("maps a refusal to its status without leaking internals", async () => {
    svc.startRestart.mockRejectedValue(new ConflictError("ADMIN_SERVICE_RESTART_IN_PROGRESS"));
    const res = await post("media").set(bearer(makeAdminAccessToken()));
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at Object\.|\.ts:/);
  });
});

describe("GET /v1/system-health/restarts", () => {
  it("200 for a Super Admin", async () => {
    const res = await request(app)
      .get("/v1/system-health/restarts")
      .set(bearer(makeAdminAccessToken()));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enabled: true, services: [] });
  });

  it("403 for a read-only System Health admin", async () => {
    grantPermissions(perms, [PERMISSIONS.SYSTEMHEALTH_READ]);
    const res = await request(app)
      .get("/v1/system-health/restarts")
      .set(bearer(makeAdminAccessToken()));
    expect(res.status).toBe(403);
    expect(svc.listRestarts).not.toHaveBeenCalled();
  });
});
