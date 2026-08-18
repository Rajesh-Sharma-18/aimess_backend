/**
 * `deviceLinkService.result` — the HTTP pull path that makes a completed scan
 * reachable without a live socket. Redis pub/sub buffers nothing, so the
 * `auth:qr:success` push (the only copy of the new session's tokens) is lost
 * whenever the browser's /auth socket is mid-handshake, blocked, backgrounded,
 * or already torn down by a QR rotation — the phone reports success and the
 * browser waits forever. This collects the same one-shot envelope over HTTP.
 */
const takeQrLinkResultMock = jest.fn();
const getLinkSessionMock = jest.fn();

jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  publishQrLinkEvent: jest.fn(async () => 1),
  publishQrLinkSuccess: jest.fn(async () => undefined),
  takeQrLinkResult: takeQrLinkResultMock,
}));
jest.mock("../../src/config/redis.js", () => ({
  redis: { status: "ready" },
  connectAuthRedis: jest.fn(async () => undefined),
}));
jest.mock("../../src/lib/device-link-store.js", () => ({
  claimLinkSessionAtomic: jest.fn(),
  createLinkSession: jest.fn(),
  finalizeLoginAtomic: jest.fn(),
  getLinkSession: getLinkSessionMock,
}));
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: { findRoleByUserId: jest.fn() },
}));
jest.mock("../../src/lib/token.js", () => ({ issueAuthTokens: jest.fn() }));
jest.mock("../../src/services/audit.service.js", () => ({
  recordAuditEventSafe: jest.fn(),
}));

import { deviceLinkService } from "../../src/services/device-link.service.js";

const SESSION = {
  linkToken: "token-a",
  accessToken: "access",
  refreshToken: "refresh",
  deviceId: "session-1",
  user: { userId: "user-1", role: "USER" },
};

const record = (over: Record<string, unknown> = {}) => ({
  state: "PENDING",
  device: {},
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

describe("deviceLinkService.result", () => {
  beforeEach(() => {
    takeQrLinkResultMock.mockReset();
    getLinkSessionMock.mockReset();
  });

  it("hands over the parked session when the push was missed", async () => {
    takeQrLinkResultMock.mockResolvedValue({
      event: "auth:qr:success",
      data: SESSION,
    });

    await expect(
      deviceLinkService.result({ linkToken: "token-a" })
    ).resolves.toEqual({ status: "SUCCESS", session: SESSION });
    expect(getLinkSessionMock).not.toHaveBeenCalled();
  });

  it("reports CONSUMED — never a second copy of the tokens — once collected", async () => {
    takeQrLinkResultMock.mockResolvedValue(null);
    getLinkSessionMock.mockResolvedValue(record({ state: "USED" }));

    await expect(
      deviceLinkService.result({ linkToken: "token-a" })
    ).resolves.toEqual({ status: "CONSUMED", session: null });
  });

  it("stays PENDING while the QR is live and unscanned", async () => {
    takeQrLinkResultMock.mockResolvedValue(null);
    getLinkSessionMock.mockResolvedValue(record());

    await expect(
      deviceLinkService.result({ linkToken: "token-a" })
    ).resolves.toEqual({ status: "PENDING", session: null });
  });

  it("reports EXPIRED past the deadline even before the sweeper flips the record", async () => {
    takeQrLinkResultMock.mockResolvedValue(null);
    getLinkSessionMock.mockResolvedValue(
      record({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
    );

    await expect(
      deviceLinkService.result({ linkToken: "token-a" })
    ).resolves.toEqual({ status: "EXPIRED", session: null });
  });

  it("reports CANCELLED for a session superseded by a newer QR", async () => {
    takeQrLinkResultMock.mockResolvedValue(null);
    getLinkSessionMock.mockResolvedValue(record({ state: "CANCELLED" }));

    await expect(
      deviceLinkService.result({ linkToken: "token-a" })
    ).resolves.toEqual({ status: "CANCELLED", session: null });
  });

  it("reports NOT_FOUND for an unknown token", async () => {
    takeQrLinkResultMock.mockResolvedValue(null);
    getLinkSessionMock.mockResolvedValue(null);

    await expect(
      deviceLinkService.result({ linkToken: "nope" })
    ).resolves.toEqual({ status: "NOT_FOUND", session: null });
  });
});
