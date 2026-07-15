/**
 * Lifecycle of a QR device-link session stored in Redis. Telegram-style: no
 * confirmation step — a scan IS the login. "SCANNED" is an internal-only,
 * sub-millisecond claim marker between the atomic claim and finalize calls
 * inside `deviceLinkService.login()` (see device-link-store.ts) — it is never
 * returned by any public API. Terminal single-use state is "USED" ("CONSUMED"
 * was the prior name; `getLinkSession` normalizes any pre-existing "CONSUMED"
 * record on read so older in-flight sessions keep working).
 */
export type DeviceLinkState = "PENDING" | "SCANNED" | "USED";

/**
 * Device descriptor captured when the new device (the browser showing the QR)
 * starts a link session. ipAddress/userAgent/countryCode come from THAT
 * browser's own initiate() request — the only point at which its request
 * context is available; login() is called from the scanning mobile device's
 * request, which has different network info entirely.
 */
export type DeviceLinkDeviceInfo = {
  deviceName: string | null;
  deviceType: string | null;
  os: string | null;
  appVersion: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  countryCode: string | null;
};

/** Full record persisted under `aimess:devlink:{linkToken}`. */
export type DeviceLinkRecord = {
  state: DeviceLinkState;
  device: DeviceLinkDeviceInfo;
  createdAt: string;
  expiresAt: string;
  /** Set for the instant between the atomic claim and finalize calls. */
  scannedAt?: string;
  scannedByUserId?: string;
  usedAt?: string;
};

export type InitiateDeviceLinkResult = {
  linkToken: string;
  expiresAt: string;
};

/** Result of the merged scan+login call — the browser's new session, delivered once via `auth:qr:success`. */
export type LoginDeviceLinkResult = {
  linkedAt: string;
  /** Session id of the newly-linked browser device — pass to DELETE /users/linked-devices/{sessionId} to undo the link. */
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
};
