/**
 * `GET /v1/users/:userId/devices` — the Super Admin "Linked Devices" block.
 *
 * The subtle bug this guards is null-vs-zero. proto3 has no null, so
 * auth-service flattens an unknown `sdkInt` and a real `sdkInt: 0` to the same
 * wire value, and the same for `isRooted`, `utcOffsetMinutes` (UTC itself is 0)
 * and the screen fields. The `presentFields` mask restores the difference; if
 * this layer regressed to a falsy check, the panel would print "0" for "we
 * don't know" and "No" for a root check that never ran — both of which an
 * admin would read as fact.
 *
 * Authorization and user isolation are asserted at the HTTP boundary: the
 * endpoint must require an admin bearer, and must page only the `:userId` in
 * the path.
 */
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: { adminListUserDevices: jest.fn() },
}));
jest.mock("../../src/lib/admin-perms-cache.js", () => ({
  getCachedAdminPermissions: jest.fn(async () => [] as string[]),
  invalidateAdminPermissions: jest.fn(async () => undefined),
}));
// Only the admin-row lookup `adminAuth` performs is stubbed; the rest of the
// barrel — including the device repository under test — stays real, so the
// gRPC mapping below runs for real rather than against a stub.
jest.mock("../../src/repositories/index.js", () => ({
  ...jest.requireActual("../../src/repositories/index.js"),
  adminUserRepository: { findById: jest.fn() },
}));

import request from "supertest";

import { app } from "../../src/app.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { authClient } from "../../src/grpc/auth.client.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { userDevicesRepository } from "../../src/repositories/user-devices.repository.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const listDevices = authClient.adminListUserDevices as unknown as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const findById = adminUserRepository.findById as unknown as jest.Mock;
const auth = () => bearer(makeAdminAccessToken());

/** A wire record with every field populated and a full presence mask. */
const wireDevice = (overrides: Record<string, unknown> = {}) => ({
  deviceId: "device-1",
  platform: "WEB",
  deviceType: "DESKTOP",
  deviceName: "Chrome on Windows",
  manufacturer: "",
  brand: "",
  model: "",
  osVersion: "10",
  sdkInt: 0,
  appVersion: "0.1.0",
  appBuild: 0,
  buildType: "release",
  installerPackage: "",
  locale: "en-IN",
  language: "en",
  country: "IN",
  timezone: "Asia/Kolkata",
  utcOffsetMinutes: 0,
  screenWidthPx: 1920,
  screenHeightPx: 1080,
  screenDensityDpi: 160,
  networkType: "UNKNOWN",
  carrier: "",
  isEmulator: false,
  isRooted: false,
  ipAddress: "203.0.113.7",
  countryCode: "IN",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-03T10:00:00.000Z",
  lastSeenAt: "2026-09-03T10:00:00.000Z",
  lastLoginAt: "2026-09-03T10:00:00.000Z",
  activeSessionCount: 1,
  presentFields: [
    "utcOffsetMinutes",
    "screenWidthPx",
    "screenHeightPx",
    "screenDensityDpi",
    "isEmulator",
    "isRooted",
  ],
  ...overrides,
});

describe("userDevicesRepository — null vs zero", () => {
  beforeEach(() => {
    listDevices.mockResolvedValue({ devices: [wireDevice()], total: 1 });
  });

  it("keeps a real zero that the presence mask vouches for", async () => {
    const { data } = await userDevicesRepository.listUserDevices("user-1", {
      page: 1,
      limit: 20,
    });

    // UTC+0 is a genuine offset, not a missing value.
    expect(data[0].utcOffsetMinutes).toBe(0);
  });

  it("keeps a real `false` that the presence mask vouches for", async () => {
    const { data } = await userDevicesRepository.listUserDevices("user-1", {
      page: 1,
      limit: 20,
    });

    expect(data[0].isEmulator).toBe(false);
    expect(data[0].isRooted).toBe(false);
  });

  it("reports an unmasked numeric field as unknown, not as 0", async () => {
    const { data } = await userDevicesRepository.listUserDevices("user-1", {
      page: 1,
      limit: 20,
    });

    // sdkInt / appBuild are absent from presentFields — the web has neither.
    expect(data[0].sdkInt).toBeNull();
    expect(data[0].appBuild).toBeNull();
  });

  it('turns an empty proto string into null so the UI has one "unknown"', async () => {
    const { data } = await userDevicesRepository.listUserDevices("user-1", {
      page: 1,
      limit: 20,
    });

    expect(data[0].manufacturer).toBeNull();
    expect(data[0].carrier).toBeNull();
    expect(data[0].installerPackage).toBeNull();
  });

  // Older auth-service builds send no mask at all. Falling back to "zero means
  // absent" is lossy but never invents a value that was not reported.
  it("falls back safely when the wire carries no presence mask", async () => {
    listDevices.mockResolvedValue({
      devices: [wireDevice({ presentFields: undefined })],
      total: 1,
    });

    const { data } = await userDevicesRepository.listUserDevices("user-1", {
      page: 1,
      limit: 20,
    });

    expect(data[0].utcOffsetMinutes).toBeNull();
    expect(data[0].isRooted).toBeNull();
    expect(data[0].screenWidthPx).toBe(1920);
  });

  it("derives isActive from the live session count", async () => {
    listDevices.mockResolvedValue({
      devices: [
        wireDevice({ deviceId: "live", activeSessionCount: 2 }),
        wireDevice({ deviceId: "signed-out", activeSessionCount: 0 }),
      ],
      total: 2,
    });

    const { data } = await userDevicesRepository.listUserDevices("user-1", {
      page: 1,
      limit: 20,
    });

    expect(data[0].isActive).toBe(true);
    expect(data[1].isActive).toBe(false);
  });

  it("converts page/limit into the offset auth-service expects", async () => {
    await userDevicesRepository.listUserDevices("user-1", {
      page: 3,
      limit: 20,
    });

    expect(listDevices).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 20,
      offset: 40,
    });
  });
});

describe("GET /v1/users/:userId/devices", () => {
  beforeEach(() => {
    configureActiveAdmin(findById);
    // USERS_VIEW only: the block is part of the read-only detail bundle, so an
    // admin scoped to viewing must reach it without holding the ban key.
    grantPermissions(perms, [PERMISSIONS.USERS_VIEW]);
    listDevices.mockResolvedValue({ devices: [wireDevice()], total: 1 });
  });

  it("requires an admin bearer", async () => {
    await request(app).get("/v1/users/user-1/devices").expect(401);
    expect(listDevices).not.toHaveBeenCalled();
  });

  it("returns the paginated envelope every admin table expects", async () => {
    const res = await request(app)
      .get("/v1/users/user-1/devices")
      .set(auth())
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.pagination).toMatchObject({ page: 1, total: 1 });
    expect(res.body.data[0].deviceId).toBe("device-1");
  });

  // The path param is the only thing that decides whose devices come back —
  // there is no query filter an admin could widen.
  it("scopes the read to the :userId in the path", async () => {
    await request(app)
      .get("/v1/users/other-user/devices")
      .set(auth())
      .expect(200);

    expect(listDevices).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "other-user" })
    );
  });

  it("rejects an out-of-range page size instead of pulling the table", async () => {
    await request(app)
      .get("/v1/users/user-1/devices?limit=5000")
      .set(auth())
      .expect(400);
  });

  // No token, no secret, no push registration id — a device row is diagnostics.
  it("exposes no credential material", async () => {
    const res = await request(app)
      .get("/v1/users/user-1/devices")
      .set(auth())
      .expect(200);

    const serialized = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ["fcmtoken", "refreshtoken", "accesstoken", "password"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
