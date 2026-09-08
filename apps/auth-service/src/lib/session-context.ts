import { createHash } from "node:crypto";

import type { Request } from "express";
import { UAParser } from "ua-parser-js";

import { DeviceType } from "../generated/prisma/client.js";
import type { DeviceInfoInput } from "../api/validators/device-info.validator.js";

/**
 * Session metadata for one authentication.
 *
 * Derived on the server from HTTP headers, then OVERLAID with the client's
 * `device` payload where it supplied one (see `applyDeviceInfo`). The header
 * derivation stays as the floor so a client that sends nothing behaves exactly
 * as it did before the payload existed.
 */
export type SessionContext = {
  deviceId: string;
  deviceType: DeviceType;
  deviceName: string | null;
  /** Browser name parsed from the user agent, e.g. "Chrome". */
  browserName: string | null;
  /** OS name parsed from the user agent, e.g. "Windows". */
  osName: string | null;
  osVersion: string | null;
  appVersion: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  countryCode: string | null;
  /**
   * The validated client payload, carried through so the new-session funnel can
   * upsert the device row without re-reading the request. Null when the client
   * sent none.
   */
  device: DeviceInfoInput | null;
};

/**
 * The client's address, as Express resolves it under `trust proxy`.
 *
 * This used to read `X-Forwarded-For` directly and take the LEFTMOST entry,
 * falling back to `X-Real-IP`, and consulted TRUST_PROXY_HOPS not at all. Both
 * headers are attacker-supplied: with one trusted proxy the authoritative entry
 * is the LAST one (the address the proxy itself appended), and the leftmost is
 * whatever the caller typed. That value was the key for this service's
 * login/register/reset and QR limiters and for the OTP issuance throttle, so a
 * fresh random header per request bought an unlimited fresh bucket and defeated
 * all of them; it was also persisted as `Session.ipAddress` and written into
 * audit rows, letting an attacker forge the address shown in "Linked Devices"
 * and in the admin audit log.
 *
 * `req.ip` honours the configured hop count (`app.set("trust proxy", …)` in
 * app.ts), so it picks the correct entry instead of the first one, and returns
 * the socket address when no proxy is trusted.
 */
export function resolveClientIp(req: Request): string {
  return req.ip ?? "unknown";
}

// Placeholders CDNs emit when they can't resolve a country (Cloudflare: XX
// unknown, T1 Tor exit) — treat these the same as "not provided".
const UNKNOWN_COUNTRY_CODES = new Set(["XX", "T1"]);

// Reverse-proxy/CDN headers that carry a resolved ISO 3166-1 alpha-2 country
// code. No GeoIP lookup is performed here — only headers already present on
// the request are read, so this stays null unless the deployment's edge
// (Cloudflare, Vercel, App Engine, etc.) is configured to inject one.
const COUNTRY_HEADER_NAMES = [
  "cf-ipcountry",
  "x-country-code",
  "x-vercel-ip-country",
  "x-appengine-country",
] as const;

function resolveCountryCode(req: Request): string | null {
  for (const header of COUNTRY_HEADER_NAMES) {
    const value = req.headers[header];
    if (typeof value === "string" && value.trim()) {
      const code = value.trim().toUpperCase();
      if (!UNKNOWN_COUNTRY_CODES.has(code)) return code;
    }
  }
  return null;
}

function buildDeviceId(userAgent: string, ip: string): string {
  return createHash("sha256")
    .update(`${userAgent.trim() || "unknown-agent"}|${ip}`)
    .digest("hex");
}

const PLATFORM_HEADER_MAP: Record<string, DeviceType> = {
  android: DeviceType.ANDROID,
  ios: DeviceType.IOS,
  web: DeviceType.WEB,
  windows: DeviceType.DESKTOP,
  macos: DeviceType.DESKTOP,
  linux: DeviceType.DESKTOP,
};

function mapPlatformHeader(platform: string | undefined): DeviceType | null {
  if (!platform) return null;
  return PLATFORM_HEADER_MAP[platform.trim().toLowerCase()] ?? null;
}

function mapDeviceType(parser: UAParser): DeviceType {
  const os = parser.getOS();
  const device = parser.getDevice();
  const osName = (os.name ?? "").toLowerCase();
  const deviceCategory = (device.type ?? "").toLowerCase();

  if (
    osName.includes("ios") ||
    osName.includes("iphone") ||
    osName.includes("ipad")
  ) {
    return DeviceType.IOS;
  }

  if (osName.includes("android")) {
    return DeviceType.ANDROID;
  }

  if (deviceCategory === "mobile" || deviceCategory === "tablet") {
    return osName.includes("android") ? DeviceType.ANDROID : DeviceType.IOS;
  }

  if (
    osName.includes("windows") ||
    osName.includes("mac") ||
    osName.includes("linux") ||
    osName.includes("ubuntu") ||
    osName.includes("chrome os")
  ) {
    return DeviceType.DESKTOP;
  }

  return DeviceType.WEB;
}

function buildDeviceName(parser: UAParser): string | null {
  const browser = parser.getBrowser();
  const os = parser.getOS();
  const device = parser.getDevice();

  const parts = [device.model, browser.name, os.name].filter(
    (part): part is string => Boolean(part?.trim())
  );

  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Map the client's (platform, form factor) pair onto the single `DeviceType`
 * column sessions have always used.
 *
 * The two are different axes: the contract's `platform` is ANDROID/IOS/WEB and
 * its `deviceType` is PHONE/TABLET/DESKTOP, while `DeviceType` mixes them —
 * ANDROID, IOS, WEB and DESKTOP. Mapping WEB straight through would move every
 * desktop browser out of the DESKTOP bucket that announcement targeting
 * (`AdminListUserIdsByDeviceType`) already segments on, so a web client that
 * reports the DESKTOP form factor keeps landing in DESKTOP.
 */
function mapClientPlatform(device: DeviceInfoInput): DeviceType {
  if (device.platform === "ANDROID") return DeviceType.ANDROID;
  if (device.platform === "IOS") return DeviceType.IOS;
  return device.deviceType === "DESKTOP" ? DeviceType.DESKTOP : DeviceType.WEB;
}

/**
 * Overlay a validated client `device` payload onto the header-derived context.
 *
 * Only fields the client actually supplied win; anything it omitted keeps the
 * server-derived value, so a partial payload never blanks out metadata the
 * user agent could still explain. `ipAddress`, `countryCode` and `userAgent`
 * are NOT overlaid at all — those stay server-derived by contract.
 *
 * `deviceId` is the one that matters most: with a payload the session row keys
 * on the client's real per-install id (the same one push registration uses)
 * instead of the sha256(userAgent|ip) fingerprint, which is what makes a
 * session, a push token and a device record refer to the same device.
 */
export function applyDeviceInfo(
  context: SessionContext,
  device: DeviceInfoInput | null | undefined
): SessionContext {
  if (!device) return context;

  return {
    ...context,
    deviceId: device.deviceId,
    deviceType: mapClientPlatform(device),
    deviceName: device.deviceName ?? context.deviceName,
    osVersion: device.osVersion ?? context.osVersion,
    appVersion: device.appVersion ?? context.appVersion,
    device,
  };
}

export function buildSessionContext(
  req: Request,
  device?: DeviceInfoInput | null
): SessionContext {
  const userAgent =
    typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"]
      : "";
  const ipAddress = resolveClientIp(req);
  const parser = new UAParser(userAgent);
  const os = parser.getOS();
  const browser = parser.getBrowser();

  const appVersionHeader = req.headers["x-app-version"];
  const appVersion =
    typeof appVersionHeader === "string" ? appVersionHeader : null;

  const platformHeader = req.headers["x-platform"];
  const deviceType =
    mapPlatformHeader(
      typeof platformHeader === "string" ? platformHeader : undefined
    ) ?? mapDeviceType(parser);

  const context: SessionContext = {
    deviceId: buildDeviceId(userAgent, ipAddress),
    deviceType,
    deviceName: buildDeviceName(parser),
    browserName: browser.name?.trim() || null,
    osName: os.name?.trim() || null,
    osVersion: os.version ?? null,
    appVersion,
    ipAddress,
    userAgent: userAgent || null,
    countryCode: resolveCountryCode(req),
    device: null,
  };

  return applyDeviceInfo(context, device);
}
