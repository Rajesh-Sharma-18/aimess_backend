/**
 * buildNewLoginNotification / maskIp — the "New login detected" security alert
 * built from auth.security_new_login and forwarded to the existing pushToUser
 * pipeline. Pure functions, so no RabbitMQ/gRPC needed.
 */
import { AuthEvents } from "@aimess/shared-types";

import {
  buildNewLoginNotification,
  maskIp,
} from "../../src/lib/new-login-notification.js";

describe("maskIp", () => {
  it("keeps the first two IPv4 octets", () => {
    expect(maskIp("203.0.113.42")).toBe("203.0.x.x");
  });

  it("keeps the first IPv6 block", () => {
    expect(maskIp("2001:db8::1")).toBe("2001:xxxx");
  });

  it("returns null for missing/garbage input", () => {
    expect(maskIp(null)).toBeNull();
    expect(maskIp(undefined)).toBeNull();
    expect(maskIp("not-an-ip")).toBeNull();
  });
});

describe("buildNewLoginNotification", () => {
  it("carries sessionId + actionType so the client can drive Terminate", () => {
    const out = buildNewLoginNotification(AuthEvents.SECURITY_NEW_LOGIN, {
      userId: "user-1",
      at: "2026-07-14T10:00:00.000Z",
      sessionId: "sess-9",
      deviceName: "Chrome · Windows",
      deviceType: "WEB",
      ipAddress: "203.0.113.42",
      browser: "Chrome",
      os: "Windows",
      countryCode: "IN",
    });

    expect(out.userId).toBe("user-1");
    expect(out.type).toBe(AuthEvents.SECURITY_NEW_LOGIN);
    // The exemption is the TYPE being on NON_SUPPRESSIBLE_TYPES in
    // push.service, not a per-producer flag — see the gate tests.
    expect(out.bypassSettings).toBeUndefined();
    expect(out.copy("en").title).toBe("Login Detected");
    expect(out.copy("en").body).toBe(
      "New login detected on a chrome from India. If this wasn't you, Terminate Session"
    );
    expect(out.data).toMatchObject({
      actionType: "SESSION_CREATED",
      sessionId: "sess-9",
      deviceName: "Chrome · Windows",
      platform: "WEB",
      browser: "Chrome",
      os: "Windows",
      location: "India",
      ip: "203.0.x.x",
      createdAt: "2026-07-14T10:00:00.000Z",
    });
  });

  it("degrades gracefully when only the base fields are present", () => {
    const out = buildNewLoginNotification(AuthEvents.SECURITY_NEW_LOGIN, {
      userId: "user-2",
      at: "2026-07-14T10:00:00.000Z",
    });

    expect(out.copy("en").body).toBe(
      "New login detected on a new device. If this wasn't you, Terminate Session"
    );
    expect(out.data).toMatchObject({
      actionType: "SESSION_CREATED",
      createdAt: "2026-07-14T10:00:00.000Z",
    });
  });
});
