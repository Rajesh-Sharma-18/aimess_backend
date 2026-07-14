/**
 * `isSessionActiveForRequest` — the Redis-backed session-revocation check
 * wired into notifications-service's `/v1/devices` auth middleware so a
 * session terminated via DELETE /auth/sessions/{sessionId} is rejected on its
 * next request here too, not just at auth-service.
 */
jest.mock("../../src/config/redis.js", () => ({
  redis: { get: jest.fn(), status: "ready" },
}));

import { redis } from "../../src/config/redis.js";
import { isSessionActiveForRequest } from "../../src/lib/session-active-cache.js";

const mockGet = redis.get as jest.Mock;

describe("isSessionActiveForRequest (notifications-service)", () => {
  beforeEach(() => {
    mockGet.mockReset();
    redis.status = "ready";
  });

  it("fails open (active) when Redis is not connected", async () => {
    redis.status = "connecting";
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("returns false for a revoked session (cache value '0')", async () => {
    mockGet.mockResolvedValue("0");
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(false);
  });

  it("returns true for an active session (cache value '1')", async () => {
    mockGet.mockResolvedValue("1");
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
  });

  it("fails open (active) on a cache miss (legacy session, key never written)", async () => {
    mockGet.mockResolvedValue(null);
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
  });

  it("fails open (active) when Redis errors", async () => {
    mockGet.mockRejectedValue(new Error("connection reset"));
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
  });
});
