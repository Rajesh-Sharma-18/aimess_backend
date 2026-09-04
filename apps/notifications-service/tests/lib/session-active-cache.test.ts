/**
 * Push gate: a device token whose session is no longer live must not be pushed.
 *
 * The regression this covers is a signed-out phone that kept ringing. The Redis
 * marker expires with the refresh token (7 days) while the token row survives up
 * to the sweeper TTL (60 days), so a cache MISS was the common case for exactly
 * the devices that must not be rung — and the old gate read a miss as "active".
 */
const redisMock = {
  status: "ready",
  get: jest.fn(async () => null as string | null),
};
jest.mock("../../src/config/redis.js", () => ({ redis: redisMock }));

const isSessionActive = jest.fn(async () => false);
jest.mock("../../src/grpc/auth-session.client.js", () => ({
  createAuthSessionClient: () => ({ isSessionActive }),
}));

import { isSessionActiveForRequest } from "../../src/lib/session-active-cache.js";

describe("isSessionActiveForRequest", () => {
  beforeEach(() => {
    redisMock.status = "ready";
    redisMock.get.mockResolvedValue(null);
    isSessionActive.mockResolvedValue(false);
  });

  it("trusts the cached active marker without calling auth-service", async () => {
    redisMock.get.mockResolvedValue("1");
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
    expect(isSessionActive).not.toHaveBeenCalled();
  });

  it("trusts the cached revoked marker without calling auth-service", async () => {
    redisMock.get.mockResolvedValue("0");
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(false);
    expect(isSessionActive).not.toHaveBeenCalled();
  });

  it("asks auth-service on a cache miss and refuses a dead session", async () => {
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(false);
    expect(isSessionActive).toHaveBeenCalledWith("s1");
  });

  it("allows a session auth-service still holds", async () => {
    isSessionActive.mockResolvedValue(true);
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
  });

  it("fails open when the oracle itself is unreachable", async () => {
    isSessionActive.mockRejectedValue(new Error("UNAVAILABLE"));
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
  });

  it("falls back to auth-service when Redis is down", async () => {
    redisMock.status = "connecting";
    isSessionActive.mockResolvedValue(true);
    await expect(isSessionActiveForRequest("s1")).resolves.toBe(true);
    expect(redisMock.get).not.toHaveBeenCalled();
  });
});
