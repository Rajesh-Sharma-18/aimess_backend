/**
 * buildSessionContext — deviceType resolution.
 * X-Platform header takes priority (case-insensitive); falls back to
 * User-Agent parsing when the header is missing/unrecognized.
 */
import type { Request } from "express";

import { buildSessionContext } from "../../src/lib/session-context.js";
import { DeviceType } from "../../src/generated/prisma/client.js";

function fakeReq(headers: Record<string, string>): Request {
  return {
    headers,
    ip: "127.0.0.1",
  } as unknown as Request;
}

const OKHTTP_UA = "okhttp/4.9.3";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

describe("buildSessionContext deviceType resolution", () => {
  it("uses X-Platform: android even with a generic User-Agent", () => {
    const ctx = buildSessionContext(
      fakeReq({ "x-platform": "android", "user-agent": OKHTTP_UA })
    );
    expect(ctx.deviceType).toBe(DeviceType.ANDROID);
  });

  it("uses X-Platform: ios", () => {
    const ctx = buildSessionContext(
      fakeReq({ "x-platform": "ios", "user-agent": OKHTTP_UA })
    );
    expect(ctx.deviceType).toBe(DeviceType.IOS);
  });

  it("uses X-Platform: web", () => {
    const ctx = buildSessionContext(
      fakeReq({ "x-platform": "web", "user-agent": CHROME_UA })
    );
    expect(ctx.deviceType).toBe(DeviceType.WEB);
  });

  it("uses X-Platform: windows -> DESKTOP", () => {
    const ctx = buildSessionContext(fakeReq({ "x-platform": "windows" }));
    expect(ctx.deviceType).toBe(DeviceType.DESKTOP);
  });

  it("uses X-Platform: macos -> DESKTOP", () => {
    const ctx = buildSessionContext(fakeReq({ "x-platform": "macos" }));
    expect(ctx.deviceType).toBe(DeviceType.DESKTOP);
  });

  it("uses X-Platform: linux -> DESKTOP", () => {
    const ctx = buildSessionContext(fakeReq({ "x-platform": "linux" }));
    expect(ctx.deviceType).toBe(DeviceType.DESKTOP);
  });

  it("handles X-Platform case-insensitively", () => {
    const ctx = buildSessionContext(fakeReq({ "x-platform": "ANDROID" }));
    expect(ctx.deviceType).toBe(DeviceType.ANDROID);
  });

  it("falls back to User-Agent parsing when X-Platform is missing", () => {
    const ctx = buildSessionContext(fakeReq({ "user-agent": IPHONE_UA }));
    expect(ctx.deviceType).toBe(DeviceType.IOS);
  });

  it("falls back to User-Agent parsing when X-Platform is invalid", () => {
    const ctx = buildSessionContext(
      fakeReq({ "x-platform": "bogus-value", "user-agent": ANDROID_UA })
    );
    expect(ctx.deviceType).toBe(DeviceType.ANDROID);
  });

  it("falls back to WEB when both User-Agent and X-Platform are unavailable/invalid", () => {
    const ctx = buildSessionContext(fakeReq({}));
    expect(ctx.deviceType).toBe(DeviceType.WEB);
  });

  it("regression: existing browser login via User-Agent only still resolves WEB/DESKTOP correctly", () => {
    const ctx = buildSessionContext(fakeReq({ "user-agent": CHROME_UA }));
    expect(ctx.deviceType).toBe(DeviceType.DESKTOP);
  });
});
