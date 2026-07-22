/**
 * Lifecycle of a QR device-link session stored in Redis. Telegram-style: no
 * confirmation step — a scan IS the login. "SCANNED" is an internal-only,
 * sub-millisecond claim marker between the atomic claim and finalize calls
 * inside `deviceLinkService.login()` (see device-link-store.ts) — it is never
 * returned by any public API. Terminal single-use state is "USED" ("CONSUMED"
 * was the prior name; `getLinkSession` normalizes any pre-existing "CONSUMED"
 * record on read so older in-flight sessions keep working).
 *
 * "CANCELLED" is a terminal state applied when the same device generates a new
 * QR before the old one is scanned (WhatsApp-like session replacement). The
 * cancelled session is immediately made un-claimable, its waiting browser tab
 * receives an `auth:qr:cancelled` event, and it is excluded from the sweeper's
 * expiry-publish flow so no duplicate `auth:qr:expired` is emitted for it.
 */
export type DeviceLinkState = "PENDING" | "SCANNED" | "USED" | "CANCELLED";

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
  /** Set when this session is superseded by a new QR from the same device. */
  cancelledAt?: string;
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
