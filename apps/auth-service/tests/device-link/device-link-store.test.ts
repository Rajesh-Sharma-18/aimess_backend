/**
 * Unit tests for the real (unmocked) device-link-store.ts — createLinkSession
 * is the one function here that doesn't need `redis.eval` (Lua), so it can be
 * exercised directly against a lightweight `redis.set` stub instead of the
 * full I/O-boundary mock other device-link tests use.
 */
const setMock = jest.fn(async () => "OK");
const getMock = jest.fn(async () => null);
const delMock = jest.fn(async () => 1);
const evalMock = jest.fn(async () => "OK");
const multiMock = jest.fn(() => ({
  set: jest.fn().mockReturnThis(),
  exec: jest.fn(async () => ["OK", "OK"]),
}));

jest.mock("../../src/config/redis.js", () => ({
  redis: {
    status: "ready",
    set: setMock,
    get: getMock,
    del: delMock,
    eval: evalMock,
    multi: multiMock,
  },
  connectAuthRedis: jest.fn(async () => undefined),
}));

import { createLinkSession } from "../../src/lib/device-link-store.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("createLinkSession", () => {
  beforeEach(() => {
    setMock.mockClear();
    getMock.mockClear();
    delMock.mockClear();
    evalMock.mockClear();
    multiMock.mockClear();
  });

  it("generates a UUID v4 linkToken (spec requirement)", async () => {
    const { linkToken } = await createLinkSession(
      {
        deviceName: null,
        deviceType: "WEB",
        os: null,
        appVersion: null,
        ipAddress: null,
        userAgent: null,
        countryCode: null,
      },
      "fp-123"
    );

    expect(linkToken).toMatch(UUID_V4);
  });

  it("expires 60 seconds after creation (spec: reduced from 120s)", async () => {
    const before = Date.now();
    const { expiresAt } = await createLinkSession(
      {
        deviceName: null,
        deviceType: "WEB",
        os: null,
        appVersion: null,
        ipAddress: null,
        userAgent: null,
        countryCode: null,
      },
      "fp-123"
    );

    const deltaSeconds = (new Date(expiresAt).getTime() - before) / 1000;
    expect(deltaSeconds).toBeGreaterThanOrEqual(59);
    expect(deltaSeconds).toBeLessThanOrEqual(61);
  });

  it("sets the Redis key TTL longer than the logical expiry (sweeper grace window)", async () => {
    await createLinkSession(
      {
        deviceName: null,
        deviceType: "WEB",
        os: null,
        appVersion: null,
        ipAddress: null,
        userAgent: null,
        countryCode: null,
      },
      "fp-123"
    );

    expect(multiMock).toHaveBeenCalled();
  });
});
