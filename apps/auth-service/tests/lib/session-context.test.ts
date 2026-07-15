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

describe("buildSessionContext countryCode resolution", () => {
  it("reads cf-ipcountry when present", () => {
    const ctx = buildSessionContext(fakeReq({ "cf-ipcountry": "in" }));
    expect(ctx.countryCode).toBe("IN");
  });

  it("falls back to x-country-code when cf-ipcountry is absent", () => {
    const ctx = buildSessionContext(fakeReq({ "x-country-code": "us" }));
    expect(ctx.countryCode).toBe("US");
  });

  it("treats Cloudflare's unknown-country placeholder (XX) as null", () => {
    const ctx = buildSessionContext(fakeReq({ "cf-ipcountry": "XX" }));
    expect(ctx.countryCode).toBeNull();
  });

  it("treats Cloudflare's Tor placeholder (T1) as null", () => {
    const ctx = buildSessionContext(fakeReq({ "cf-ipcountry": "T1" }));
    expect(ctx.countryCode).toBeNull();
  });

  it("is null when no country header is present — never fabricated", () => {
    const ctx = buildSessionContext(fakeReq({}));
    expect(ctx.countryCode).toBeNull();
  });
});

describe("buildSessionContext full device detection per platform", () => {
  it("Android login: X-Platform + X-App-Version populate deviceType/appVersion", () => {
    const ctx = buildSessionContext(
      fakeReq({
        "x-platform": "android",
        "x-app-version": "2.4.1",
        "user-agent": ANDROID_UA,
      })
    );
    expect(ctx.deviceType).toBe(DeviceType.ANDROID);
    expect(ctx.appVersion).toBe("2.4.1");
    // Browser-shaped Android UA (e.g. WebView) parses cleanly via ua-parser-js.
    expect(ctx.osVersion).toBe("14");
  });

  it("iOS login: X-Platform + X-App-Version populate deviceType/appVersion", () => {
    const ctx = buildSessionContext(
      fakeReq({
        "x-platform": "ios",
        "x-app-version": "3.0.0",
        "user-agent": IPHONE_UA,
      })
    );
    expect(ctx.deviceType).toBe(DeviceType.IOS);
    expect(ctx.appVersion).toBe("3.0.0");
    expect(ctx.osVersion).toBe("17.0");
  });

  it("Web login: Chrome UA resolves deviceName/deviceType/osVersion without X-Platform", () => {
    const ctx = buildSessionContext(fakeReq({ "user-agent": CHROME_UA }));
    expect(ctx.deviceType).toBe(DeviceType.DESKTOP);
    expect(ctx.deviceName).toContain("Chrome");
    // Web has no app version to send — null is correct, not a bug.
    expect(ctx.appVersion).toBeNull();
  });

  it("a bare non-browser native UA (e.g. raw OkHttp) legitimately yields null deviceName/osVersion — X-Platform still saves deviceType", () => {
    // ua-parser-js only understands browser-shaped UAs; a bare HTTP client UA
    // carries no OS/device tokens for it to extract. This is a genuine "the
    // client didn't send parseable info" case, not a backend bug — nothing
    // here may be fabricated to fill the gap.
    const ctx = buildSessionContext(
      fakeReq({ "x-platform": "android", "user-agent": OKHTTP_UA })
    );
    expect(ctx.deviceType).toBe(DeviceType.ANDROID);
    expect(ctx.deviceName).toBeNull();
    expect(ctx.osVersion).toBeNull();
  });
});

describe("buildSessionContext ipAddress resolution priority", () => {
  it("prefers X-Forwarded-For over everything else", () => {
    const ctx = buildSessionContext(
      fakeReq({
        "x-forwarded-for": "198.51.100.1, 10.0.0.1",
        "x-real-ip": "198.51.100.2",
      })
    );
    expect(ctx.ipAddress).toBe("198.51.100.1");
  });

  it("falls back to X-Real-IP when X-Forwarded-For is absent", () => {
    const ctx = buildSessionContext(fakeReq({ "x-real-ip": "198.51.100.2" }));
    expect(ctx.ipAddress).toBe("198.51.100.2");
  });

  it("falls back to req.ip when neither proxy header is present", () => {
    const ctx = buildSessionContext(fakeReq({}));
    expect(ctx.ipAddress).toBe("127.0.0.1");
  });
});
