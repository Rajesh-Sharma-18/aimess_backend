/**
 * authRepository.createSessionWithRefreshToken — regression for the
 * GET /auth/sessions "disappearing session" bug.
 *
 * `deviceId` is a server-computed userAgent+ip fingerprint (session-context.ts),
 * not a real per-installation id, so two independent logins (different browser
 * profiles/incognito windows, or two devices behind the same NAT) can share a
 * deviceId. This function used to `session.deleteMany({ userId, deviceId })`
 * before every `session.create`, which silently hard-deleted the OTHER still-
 * active login's session row on any such collision — it vanished from
 * `GET /auth/sessions` while its JWT/Redis-cached session stayed valid until
 * natural expiry (looked "still logged in" to that device).
 *
 * Fix: never delete/overwrite by (userId, deviceId); every login just inserts
 * its own row (the DB unique constraint on that pair was dropped to allow it).
 */
const mockDeleteMany = jest.fn(async () => ({ count: 0 }));
const mockCreate = jest.fn(async () => ({
  id: "new-session-id",
  deviceId: "fingerprint-shared-by-both-logins",
  deviceName: null,
  deviceType: "WEB",
  osVersion: null,
  appVersion: null,
  ipAddress: "1.2.3.4",
  countryCode: null,
  lastActiveAt: new Date(),
  createdAt: new Date(),
}));
const mockRefreshTokenCreate = jest.fn(async () => ({ id: "rt-1" }));

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
      cb({
        session: { deleteMany: mockDeleteMany, create: mockCreate },
        refreshToken: { create: mockRefreshTokenCreate },
      })
    ),
    session: { deleteMany: mockDeleteMany, create: mockCreate },
    refreshToken: { create: mockRefreshTokenCreate },
  },
}));

import { authRepository } from "../../src/repositories/auth.repository.js";

function loginParams(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: "user-1",
    deviceId: "fingerprint-shared-by-both-logins",
    deviceType: "WEB" as const,
    refreshTokenHash: "hash-1",
    refreshExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("authRepository.createSessionWithRefreshToken — no overwrite-by-deviceId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("never deletes an existing session for the same (userId, deviceId)", async () => {
    await authRepository.createSessionWithRefreshToken(loginParams());

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("creates an independent row for every login even when two colliding logins share a deviceId", async () => {
    await authRepository.createSessionWithRefreshToken(
      loginParams({ refreshTokenHash: "hash-browser-profile-a" })
    );
    await authRepository.createSessionWithRefreshToken(
      loginParams({ refreshTokenHash: "hash-browser-profile-b" })
    );

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
