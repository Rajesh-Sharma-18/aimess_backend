/**
 * issueAuthTokens — the single funnel BOTH normal login and QR device-link
 * approval call to create a new device/session row. Verifies it records a
 * "LINKED_DEVICE_CREATED" audit event exactly once per call (spec phase 10),
 * without duplicating that hook at each caller.
 */
const CREATED_AT = new Date("2026-07-14T08:23:57.653Z");

jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    createSessionWithRefreshToken: jest.fn(async () => ({
      id: "new-session-1",
      deviceId: "device-abc",
      deviceName: "Chrome",
      deviceType: "WEB",
      osVersion: null,
      appVersion: null,
      ipAddress: "1.2.3.4",
      countryCode: null,
      lastActiveAt: CREATED_AT,
      createdAt: CREATED_AT,
    })),
  },
}));
jest.mock("../../src/services/audit.service.js", () => ({
  recordAuditEventSafe: jest.fn(),
}));
jest.mock("../../src/messaging/publish-auth-security.js", () => ({
  publishSecurityNewLoginSafe: jest.fn(),
}));

import { issueAuthTokens } from "../../src/lib/token.js";
import { authRepository } from "../../src/repositories/auth.repository.js";
import { redis } from "../../src/config/redis.js";
import { publishSecurityNewLoginSafe } from "../../src/messaging/publish-auth-security.js";
import { recordAuditEventSafe } from "../../src/services/audit.service.js";
import type { SessionContext } from "../../src/lib/session-context.js";

const audit = recordAuditEventSafe as unknown as jest.Mock;
const newLogin = publishSecurityNewLoginSafe as unknown as jest.Mock;
const publish = redis.publish as unknown as jest.Mock;

const SESSION: SessionContext = {
  deviceId: "device-abc",
  deviceType: "WEB" as SessionContext["deviceType"],
  deviceName: "Chrome",
  osVersion: null,
  appVersion: null,
  ipAddress: "1.2.3.4",
  userAgent: "test-agent",
  countryCode: "IN",
};

describe("issueAuthTokens → LINKED_DEVICE_CREATED audit", () => {
  beforeEach(() => {
    audit.mockClear();
    newLogin.mockClear();
    publish.mockClear();
  });

  it("records LINKED_DEVICE_CREATED with the new session id as targetId", async () => {
    const { sessionId } = await issueAuthTokens("user-1", "USER", SESSION);

    expect(sessionId).toBe("new-session-1");
    expect(authRepository.createSessionWithRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: "IN", ipAddress: "1.2.3.4" })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "LINKED_DEVICE_CREATED",
        targetType: "linked_device",
        targetId: "new-session-1",
        userId: "user-1",
      })
    );
  });

  it("publishes the new-login alert with the session id + device metadata", async () => {
    await issueAuthTokens("user-1", "USER", SESSION);

    expect(newLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sessionId: "new-session-1",
        deviceName: "Chrome",
        deviceType: "WEB",
        ipAddress: "1.2.3.4",
      })
    );
  });

  it("suppresses the new-login alert when notifyNewLogin is false (register)", async () => {
    await issueAuthTokens("user-1", "USER", SESSION, undefined, {
      notifyNewLogin: false,
    });

    expect(newLogin).not.toHaveBeenCalled();
  });

  it("emits the persisted session DTO on session-created:<userId> for linked-device sync", async () => {
    await issueAuthTokens("user-1", "USER", SESSION);

    const call = publish.mock.calls.find(
      ([channel]) => channel === "session-created:user-1"
    );
    expect(call).toBeDefined();
    const { session } = JSON.parse(call![1] as string) as {
      session: Record<string, unknown>;
    };
    expect(session).toMatchObject({
      sessionId: "new-session-1",
      deviceId: "device-abc",
      deviceName: "Chrome",
      deviceType: "WEB",
      ipAddress: "1.2.3.4",
      countryCode: null,
      isCurrent: false,
      createdAt: "2026-07-14T08:23:57.653Z",
      lastActiveAt: "2026-07-14T08:23:57.653Z",
    });
  });

  // Even the register path (notifyNewLogin:false) still syncs the device list —
  // suppressing the alert must not suppress the linked-device refresh.
  it("still emits session-created when the new-login alert is suppressed", async () => {
    await issueAuthTokens("user-1", "USER", SESSION, undefined, {
      notifyNewLogin: false,
    });

    expect(
      publish.mock.calls.some(
        ([channel]) => channel === "session-created:user-1"
      )
    ).toBe(true);
  });
});
