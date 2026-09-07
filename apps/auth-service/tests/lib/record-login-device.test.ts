/**
 * `recordLoginDeviceSafe` — the device row written by the new-session funnel.
 *
 * Two behaviours worth pinning:
 *
 * 1. Deduplication. The same user on the same install must refresh ONE row on
 *    every sign-in, not accumulate one per login, and the row must be scoped by
 *    `(userId, deviceId)` so two accounts sharing a browser stay separate.
 * 2. It must never be able to fail a login. Tokens are already minted by the
 *    time this runs; a Postgres hiccup here costs an admin-panel row, not the
 *    user's session.
 */
jest.mock("../../src/repositories/user-device.repository.js", () => ({
  userDeviceRepository: { upsertOnLogin: jest.fn() },
}));

import { DeviceType } from "../../src/generated/prisma/client.js";
import { deviceInfoSchema } from "../../src/api/validators/device-info.validator.js";
import { recordLoginDeviceSafe } from "../../src/lib/record-login-device.js";
import {
  applyDeviceInfo,
  type SessionContext,
} from "../../src/lib/session-context.js";
import { userDeviceRepository } from "../../src/repositories/user-device.repository.js";

const upsert = userDeviceRepository.upsertOnLogin as unknown as jest.Mock;

const WEB_DEVICE = {
  deviceId: "3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B",
  platform: "WEB",
  deviceType: "DESKTOP",
  deviceName: "Chrome on Windows",
  osVersion: "10",
  appVersion: "0.1.0",
  locale: "en-IN",
  language: "en",
  country: "IN",
  timezone: "Asia/Kolkata",
  utcOffsetMinutes: 330,
  screenWidthPx: 1920,
  screenHeightPx: 1080,
  screenDensityDpi: 160,
  networkType: "UNKNOWN",
} as const;

const contextWith = (device: unknown | null): SessionContext =>
  applyDeviceInfo(
    {
      deviceId: "sha256-fingerprint",
      deviceType: DeviceType.WEB,
      deviceName: "Chrome · Windows",
      browserName: "Chrome",
      osName: "Windows",
      osVersion: "10",
      appVersion: null,
      ipAddress: "203.0.113.7",
      userAgent: "Mozilla/5.0 …",
      countryCode: "IN",
      device: null,
    },
    device ? deviceInfoSchema.parse(device) : null
  );

beforeEach(() => {
  upsert.mockResolvedValue({ id: "device-row-1" });
});

describe("recordLoginDeviceSafe", () => {
  it("writes nothing when the client sent no device payload", async () => {
    await recordLoginDeviceSafe("user-1", contextWith(null));
    expect(upsert).not.toHaveBeenCalled();
  });

  it("upserts on (userId, clientDeviceId), not on the server fingerprint", async () => {
    await recordLoginDeviceSafe("user-1", contextWith(WEB_DEVICE));

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      userId: "user-1",
      deviceId: WEB_DEVICE.deviceId,
    });
  });

  // Signing in ten times from one browser is one device, not ten. The repo
  // upserts on the composite key, so every call targets the same row.
  it("targets the same row on repeated logins from the same install", async () => {
    await recordLoginDeviceSafe("user-1", contextWith(WEB_DEVICE));
    await recordLoginDeviceSafe("user-1", contextWith(WEB_DEVICE));
    await recordLoginDeviceSafe("user-1", contextWith(WEB_DEVICE));

    const keys = upsert.mock.calls.map(([args]) => `${args.userId}:${args.deviceId}`);
    expect(new Set(keys).size).toBe(1);
  });

  it("keys a different install to a different row", async () => {
    await recordLoginDeviceSafe("user-1", contextWith(WEB_DEVICE));
    await recordLoginDeviceSafe(
      "user-1",
      contextWith({ ...WEB_DEVICE, deviceId: "other-install" })
    );

    expect(upsert.mock.calls[0][0].deviceId).not.toBe(
      upsert.mock.calls[1][0].deviceId
    );
  });

  // A shared browser reports one deviceId for two accounts. The userId is part
  // of the key, so neither can read or overwrite the other's device record.
  it("scopes two users on the same browser to separate rows", async () => {
    await recordLoginDeviceSafe("user-1", contextWith(WEB_DEVICE));
    await recordLoginDeviceSafe("user-2", contextWith(WEB_DEVICE));

    expect(upsert.mock.calls[0][0].userId).toBe("user-1");
    expect(upsert.mock.calls[1][0].userId).toBe("user-2");
    expect(upsert.mock.calls[0][0].deviceId).toBe(
      upsert.mock.calls[1][0].deviceId
    );
  });

  it("stores the server-derived ip / country / user agent, not client values", async () => {
    await recordLoginDeviceSafe("user-1", contextWith(WEB_DEVICE));

    expect(upsert.mock.calls[0][0].metadata).toMatchObject({
      ipAddress: "203.0.113.7",
      countryCode: "IN",
      userAgent: "Mozilla/5.0 …",
    });
  });

  // The whole point of the "Safe" suffix.
  it("swallows a repository failure instead of failing the login", async () => {
    upsert.mockRejectedValue(new Error("connection terminated"));

    await expect(
      recordLoginDeviceSafe("user-1", contextWith(WEB_DEVICE))
    ).resolves.toBeUndefined();
  });
});
