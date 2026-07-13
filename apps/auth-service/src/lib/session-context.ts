import { createHash } from "node:crypto";

import type { Request } from "express";
import { UAParser } from "ua-parser-js";

import { DeviceType } from "../generated/prisma/client.js";

/** Session metadata derived on the server from HTTP headers (no client device fields). */
export type SessionContext = {
  deviceId: string;
  deviceType: DeviceType;
  deviceName: string | null;
  osVersion: string | null;
  appVersion: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

function resolveClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? "unknown";
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

export function buildSessionContext(req: Request): SessionContext {
  const userAgent =
    typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"]
      : "";
  const ipAddress = resolveClientIp(req);
  const parser = new UAParser(userAgent);
  const os = parser.getOS();

  const appVersionHeader = req.headers["x-app-version"];
  const appVersion =
    typeof appVersionHeader === "string" ? appVersionHeader : null;

  const platformHeader = req.headers["x-platform"];
  const deviceType =
    mapPlatformHeader(
      typeof platformHeader === "string" ? platformHeader : undefined
    ) ?? mapDeviceType(parser);

  return {
    deviceId: buildDeviceId(userAgent, ipAddress),
    deviceType,
    deviceName: buildDeviceName(parser),
    osVersion: os.version ?? null,
    appVersion,
    ipAddress,
    userAgent: userAgent || null,
  };
}
