/**
 * The `device` payload contract: validation, the overlay onto the session
 * context, and the mapping into a device row.
 *
 * What these guard, in order of how expensive the failure would be:
 *
 * 1. A shipped client that sends no `device` object must still log in. That is
 *    every build older than this change, on three platforms.
 * 2. A payload must never overwrite the SERVER-derived half of the context —
 *    ip, geo-IP country and user agent are excluded from the contract on
 *    purpose, and a client that smuggles one in must be ignored.
 * 3. A web login must stay in the DESKTOP session bucket that announcement
 *    targeting already segments on, even though its platform is "WEB".
 */

import {
  deviceInfoField,
  deviceInfoSchema,
} from "../../src/api/validators/device-info.validator.js";
import { DeviceType } from "../../src/generated/prisma/client.js";
import { toDeviceMetadata } from "../../src/lib/record-login-device.js";
import {
  applyDeviceInfo,
  type SessionContext,
} from "../../src/lib/session-context.js";

/** A complete Android payload, exactly as the mobile contract documents it. */
const ANDROID_PAYLOAD = {
  deviceId: "9774d56d682e549c",
  platform: "ANDROID",
  deviceType: "PHONE",
  deviceName: "samsung SM-S911B",
  manufacturer: "samsung",
  brand: "samsung",
  model: "SM-S911B",
  osVersion: "14",
  sdkInt: 34,
  appVersion: "1.4.2",
  appBuild: 142,
  buildType: "release",
  installerPackage: "com.android.vending",
  locale: "en-IN",
  language: "en",
  country: "IN",
  timezone: "Asia/Kolkata",
  utcOffsetMinutes: 330,
  screenWidthPx: 1080,
  screenHeightPx: 2340,
  screenDensityDpi: 420,
  networkType: "WIFI",
  carrier: "Jio",
  isEmulator: false,
  isRooted: false,
} as const;

/** The web equivalent: same shape, nulls where the browser cannot answer. */
const WEB_PAYLOAD = {
  deviceId: "3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B",
  platform: "WEB",
  deviceType: "DESKTOP",
  deviceName: "Chrome on Windows",
  manufacturer: null,
  brand: null,
  model: null,
  osVersion: "10",
  sdkInt: null,
  appVersion: "0.1.0",
  appBuild: null,
  buildType: "release",
  installerPackage: null,
  locale: "en-IN",
  language: "en",
  country: "IN",
  timezone: "Asia/Kolkata",
  utcOffsetMinutes: 330,
  screenWidthPx: 1920,
  screenHeightPx: 1080,
  screenDensityDpi: 160,
  networkType: "UNKNOWN",
  carrier: null,
  isEmulator: null,
  isRooted: null,
} as const;

/** Header-derived context, as it looks before any client payload is applied. */
const baseContext = (): SessionContext => ({
  deviceId: "sha256-fingerprint-of-ua-and-ip",
  deviceType: DeviceType.WEB,
  deviceName: "Chrome · Windows",
  browserName: "Chrome",
  osName: "Windows",
  osVersion: "10",
  appVersion: null,
  ipAddress: "203.0.113.7",
  userAgent: "Mozilla/5.0 …",
  countryCode: "IN",
  device: null,
});

describe("deviceInfoSchema", () => {
  it("accepts the full Android payload from the mobile contract", () => {
    const parsed = deviceInfoSchema.parse(ANDROID_PAYLOAD);
    expect(parsed.deviceId).toBe("9774d56d682e549c");
    expect(parsed.platform).toBe("ANDROID");
    expect(parsed.sdkInt).toBe(34);
    expect(parsed.isRooted).toBe(false);
  });

  it("accepts the web payload, nulls and DESKTOP form factor included", () => {
    const parsed = deviceInfoSchema.parse(WEB_PAYLOAD);
    expect(parsed.platform).toBe("WEB");
    expect(parsed.deviceType).toBe("DESKTOP");
    expect(parsed.sdkInt).toBeNull();
    expect(parsed.carrier).toBeNull();
  });

  it("accepts a bare payload — only deviceId and platform are required", () => {
    const parsed = deviceInfoSchema.parse({
      deviceId: "abc",
      platform: "IOS",
    });
    expect(parsed.deviceName).toBeUndefined();
  });

  // Older clients. Both shapes must reach the login handler, not a 400.
  it.each([
    ["omitted", undefined],
    ["explicitly null", null],
  ])("treats a %s device object as valid", (_label, value) => {
    expect(deviceInfoField.safeParse(value).success).toBe(true);
  });

  it("rejects an unknown platform rather than storing it", () => {
    const result = deviceInfoSchema.safeParse({
      ...ANDROID_PAYLOAD,
      platform: "SMARTFRIDGE",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown networkType", () => {
    const result = deviceInfoSchema.safeParse({
      ...ANDROID_PAYLOAD,
      networkType: "5G",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload with no deviceId — there would be nothing to dedupe on", () => {
    const { deviceId: _omitted, ...rest } = ANDROID_PAYLOAD;
    expect(deviceInfoSchema.safeParse(rest).success).toBe(false);
  });

  // The client is not the authority on where the request came from; the server
  // derives both from the connection. Zod strips unknown keys, so a client that
  // sends them simply loses them.
  it("strips a client-supplied ipAddress / countryCode", () => {
    const parsed = deviceInfoSchema.parse({
      ...ANDROID_PAYLOAD,
      ipAddress: "10.0.0.1",
      countryCode: "ZZ",
    }) as Record<string, unknown>;
    expect(parsed.ipAddress).toBeUndefined();
    expect(parsed.countryCode).toBeUndefined();
  });

  it("normalizes a whitespace-only string to absent, not to an empty label", () => {
    const parsed = deviceInfoSchema.parse({
      deviceId: "abc",
      platform: "WEB",
      deviceName: "   ",
    });
    expect(parsed.deviceName).toBeUndefined();
  });
});

describe("applyDeviceInfo", () => {
  it("leaves the header-derived context untouched when no payload is sent", () => {
    const context = baseContext();
    expect(applyDeviceInfo(context, null)).toEqual(context);
    expect(applyDeviceInfo(context, undefined).deviceId).toBe(
      "sha256-fingerprint-of-ua-and-ip"
    );
  });

  it("keys the session on the client's real device id, not the fingerprint", () => {
    const result = applyDeviceInfo(
      baseContext(),
      deviceInfoSchema.parse(ANDROID_PAYLOAD)
    );
    expect(result.deviceId).toBe("9774d56d682e549c");
    expect(result.deviceType).toBe(DeviceType.ANDROID);
    expect(result.deviceName).toBe("samsung SM-S911B");
    expect(result.appVersion).toBe("1.4.2");
  });

  // Announcement targeting segments on Session.deviceType, and DESKTOP is one
  // of its buckets. Mapping platform "WEB" straight through would empty it.
  it("keeps a desktop browser in the DESKTOP bucket", () => {
    const result = applyDeviceInfo(
      baseContext(),
      deviceInfoSchema.parse(WEB_PAYLOAD)
    );
    expect(result.deviceType).toBe(DeviceType.DESKTOP);
  });

  it("maps a phone-shaped web client to WEB, not DESKTOP", () => {
    const result = applyDeviceInfo(
      baseContext(),
      deviceInfoSchema.parse({ ...WEB_PAYLOAD, deviceType: "PHONE" })
    );
    expect(result.deviceType).toBe(DeviceType.WEB);
  });

  it("never lets the payload move ip, country or user agent", () => {
    const result = applyDeviceInfo(
      baseContext(),
      deviceInfoSchema.parse(ANDROID_PAYLOAD)
    );
    expect(result.ipAddress).toBe("203.0.113.7");
    expect(result.countryCode).toBe("IN");
    expect(result.userAgent).toBe("Mozilla/5.0 …");
  });

  it("keeps the server-derived value for a field the client omitted", () => {
    const result = applyDeviceInfo(
      baseContext(),
      deviceInfoSchema.parse({ deviceId: "abc", platform: "WEB" })
    );
    expect(result.deviceName).toBe("Chrome · Windows");
    expect(result.osVersion).toBe("10");
  });
});

describe("toDeviceMetadata", () => {
  it("returns null when the session carries no payload — no row is written", () => {
    expect(toDeviceMetadata(baseContext())).toBeNull();
  });

  it("carries every contract field onto the device row", () => {
    const context = applyDeviceInfo(
      baseContext(),
      deviceInfoSchema.parse(ANDROID_PAYLOAD)
    );
    const metadata = toDeviceMetadata(context)!;

    expect(metadata).toMatchObject({
      platform: DeviceType.ANDROID,
      deviceType: "PHONE",
      manufacturer: "samsung",
      model: "SM-S911B",
      sdkInt: 34,
      appBuild: 142,
      buildType: "release",
      installerPackage: "com.android.vending",
      language: "en",
      country: "IN",
      utcOffsetMinutes: 330,
      screenDensityDpi: 420,
      networkType: "WIFI",
      carrier: "Jio",
      isEmulator: false,
      isRooted: false,
    });
  });

  // The session row folds (WEB, DESKTOP) into DESKTOP because announcement
  // targeting segments on that single column. The device row must NOT inherit
  // that fold: it has its own `deviceType`, so collapsing both to DESKTOP would
  // record "DESKTOP / DESKTOP" and lose the fact that this was a browser.
  it("records the literal platform, not the session's folded bucket", () => {
    const context = applyDeviceInfo(
      baseContext(),
      deviceInfoSchema.parse(WEB_PAYLOAD)
    );

    expect(context.deviceType).toBe(DeviceType.DESKTOP);
    expect(toDeviceMetadata(context)!).toMatchObject({
      platform: DeviceType.WEB,
      deviceType: "DESKTOP",
    });
  });

  it("takes ip / country / user agent from the SERVER half of the context", () => {
    const context = applyDeviceInfo(
      baseContext(),
      deviceInfoSchema.parse(WEB_PAYLOAD)
    );
    const metadata = toDeviceMetadata(context)!;

    expect(metadata.ipAddress).toBe("203.0.113.7");
    expect(metadata.countryCode).toBe("IN");
    expect(metadata.userAgent).toBe("Mozilla/5.0 …");
  });

  // Null is the honest answer for a check the web never ran. Coercing it to
  // `false` would show an admin a root check that appears to have passed.
  it("preserves null for a flag the client did not report", () => {
    const context = applyDeviceInfo(
      baseContext(),
      deviceInfoSchema.parse(WEB_PAYLOAD)
    );
    const metadata = toDeviceMetadata(context)!;

    expect(metadata.isEmulator).toBeNull();
    expect(metadata.isRooted).toBeNull();
    expect(metadata.sdkInt).toBeNull();
    expect(metadata.appBuild).toBeNull();
  });
});
