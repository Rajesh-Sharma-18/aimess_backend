import type {
  NotificationNavigation,
  SecurityNewLoginPayload,
} from "@aimess/shared-types";

import type { PushInput } from "../services/push.service.js";
import { authCopy } from "./notification-copy.js";

/**
 * Mask a client IP for display: keep the network-ish prefix, hide the host.
 * IPv4 keeps the first two octets ("203.0.x.x"); IPv6 keeps the first block.
 * Returns null for missing/garbage input so the field is simply omitted.
 */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (trimmed.includes(".")) {
    const octets = trimmed.split(".");
    if (octets.length === 4) return `${octets[0]}.${octets[1]}.x.x`;
  }
  if (trimmed.includes(":")) {
    const first = trimmed.split(":")[0];
    if (first) return `${first}:xxxx`;
  }
  return null;
}

/**
 * Resolve a country code (e.g. "IN") to a display name (e.g. "India") using the
 * JS-native Intl API — no GeoIP dependency. Returns null for missing/malformed
 * input so the location clause is simply omitted (no city-level precision is
 * available without a GeoIP lookup, which is out of scope for now).
 */
function resolveLocation(
  countryCode: string | null | undefined
): string | null {
  if (!countryCode) return null;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(
      countryCode.toUpperCase()
    );
    return name && name !== countryCode.toUpperCase() ? name : null;
  } catch {
    return null;
  }
}

/**
 * Build the "New login detected" notification from the auth.security_new_login
 * event. Pure — the consumer just forwards the result to pushToUser, so the
 * whole payload shape is unit-testable without RabbitMQ or gRPC.
 *
 * `data` is the existing string→string context bag the client already receives
 * on every notification; the frontend reads `sessionId` to drive the existing
 * "Terminate Session" flow and `actionType` to recognise this alert.
 */
export function buildNewLoginNotification(
  eventType: string,
  p: SecurityNewLoginPayload
): PushInput {
  const data: Record<string, string> = { actionType: "SESSION_CREATED" };
  if (p.sessionId) {
    data.sessionId = p.sessionId;
    // Tells the /notify relay to skip this session's own socket — the newly
    // logged-in device must not receive its own "Login Detected" alert.
    data.excludeSessionId = p.sessionId;
  }
  if (p.deviceName) data.deviceName = p.deviceName;
  if (p.deviceType) data.platform = p.deviceType;
  if (p.browser) data.browser = p.browser;
  if (p.os) data.os = p.os;
  const location = resolveLocation(p.countryCode);
  if (location) data.location = location;
  const maskedIp = maskIp(p.ipAddress);
  if (maskedIp) data.ip = maskedIp;
  if (p.at) data.createdAt = p.at;
  data.navigation = JSON.stringify({
    screen: "LINKED_DEVICES",
    ...(p.sessionId ? { sessionId: p.sessionId } : {}),
  } satisfies NotificationNavigation);

  return {
    userId: p.userId,
    category: "systemEnabled",
    type: eventType,
    // Security alert — exempt from settings/quiet hours via
    // NON_SUPPRESSIBLE_TYPES in push.service.ts, not a flag here.
    copy: authCopy.newLogin(p.browser, location),
    data,
  };
}
