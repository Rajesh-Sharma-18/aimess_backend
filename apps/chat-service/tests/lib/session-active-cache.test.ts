/**
 * `isSessionActiveForRequest` — the Redis-backed session-revocation check
 * wired into chat-service's `authenticate` middleware so a session terminated
 * via DELETE /auth/sessions/{sessionId} is rejected on its next chat-service
 * request too, not just at auth-service.
 */
jest.mock("../../src/config/redis.js", () => ({
  redis: { get: jest.fn() },
  isChatCacheReady: jest.fn(),
}));

import { redis, isChatCacheReady } from "../../src/config/redis.js";
import { isSessionActiveForRequest } from "../../src/lib/session-active-cache.js";

const mockGet = redis.get as jest.Mock;
const mockReady = isChatCacheReady as jest.Mock;

describe("isSessionActiveForRequest (chat-service)", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockReady.mockReset();
  });

  it("fails open (active) when the cache is not ready", async () => {
    mockReady.mockReturnValue(false);
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("returns false for a revoked session (cache value '0')", async () => {
    mockReady.mockReturnValue(true);
    mockGet.mockResolvedValue("0");
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(false);
  });

  it("returns true for an active session (cache value '1')", async () => {
    mockReady.mockReturnValue(true);
    mockGet.mockResolvedValue("1");
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
  });

  it("fails open (active) on a cache miss (legacy session, key never written)", async () => {
    mockReady.mockReturnValue(true);
    mockGet.mockResolvedValue(null);
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
  });

  it("fails open (active) when Redis errors", async () => {
    mockReady.mockReturnValue(true);
    mockGet.mockRejectedValue(new Error("connection reset"));
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
  });
});
