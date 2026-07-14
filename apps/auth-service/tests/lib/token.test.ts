/**
 * issueAuthTokens — the single funnel BOTH normal login and QR device-link
 * approval call to create a new device/session row. Verifies it records a
 * "LINKED_DEVICE_CREATED" audit event exactly once per call (spec phase 10),
 * without duplicating that hook at each caller.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    createSessionWithRefreshToken: jest.fn(async () => ({
      id: "new-session-1",
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
import { publishSecurityNewLoginSafe } from "../../src/messaging/publish-auth-security.js";
import { recordAuditEventSafe } from "../../src/services/audit.service.js";
import type { SessionContext } from "../../src/lib/session-context.js";

const audit = recordAuditEventSafe as unknown as jest.Mock;
const newLogin = publishSecurityNewLoginSafe as unknown as jest.Mock;

const SESSION: SessionContext = {
  deviceId: "device-abc",
  deviceType: "WEB" as SessionContext["deviceType"],
  deviceName: "Chrome",
  osVersion: null,
  appVersion: null,
  ipAddress: "1.2.3.4",
  userAgent: "test-agent",
};

describe("issueAuthTokens → LINKED_DEVICE_CREATED audit", () => {
  beforeEach(() => {
    audit.mockClear();
    newLogin.mockClear();
  });

  it("records LINKED_DEVICE_CREATED with the new session id as targetId", async () => {
    const { sessionId } = await issueAuthTokens("user-1", "USER", SESSION);

    expect(sessionId).toBe("new-session-1");
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
});
