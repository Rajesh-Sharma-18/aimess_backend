import type { DeviceType } from "../generated/prisma/client.js";
import type { ActiveSessionItem } from "../types/session.types.js";

/**
 * The Session columns needed to render a linked-device / session-list row.
 * Any Prisma `select` that covers these fields satisfies it, so the same
 * serializer feeds both `GET /auth/sessions` and the realtime
 * `session:list_updated` socket event.
 */
export type SerializableSession = {
  id: string;
  deviceId: string;
  deviceName: string | null;
  deviceType: DeviceType;
  osVersion: string | null;
  appVersion: string | null;
  ipAddress: string | null;
  countryCode: string | null;
  lastActiveAt: Date;
  createdAt: Date;
};

/**
 * Single source of truth for the session DTO shape. `currentSessionId` is the
 * requesting/receiving device's own session id; a row is `isCurrent` only when
 * it matches. In the realtime "created" broadcast no single recipient is the
 * new device, so callers pass no id (isCurrent=false) and each device decides
 * "is this me?" by matching `sessionId` locally.
 */
export function toActiveSessionItem(
  row: SerializableSession,
  currentSessionId?: string
): ActiveSessionItem {
  return {
    sessionId: row.id,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    deviceType: row.deviceType,
    osVersion: row.osVersion,
    appVersion: row.appVersion,
    ipAddress: row.ipAddress,
    countryCode: row.countryCode,
    lastActiveAt: row.lastActiveAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    isCurrent: row.id === currentSessionId,
  };
}
