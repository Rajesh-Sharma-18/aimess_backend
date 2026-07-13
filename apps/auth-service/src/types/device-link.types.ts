import type { AuthTokens } from "../lib/token.js";

/**
 * Lifecycle of a QR device-link session stored in Redis. Terminal single-use
 * state is "USED" (spec naming) — "CONSUMED" was the prior name; `getLinkSession`
 * / `consumeTokensAtomic` normalize any pre-existing "CONSUMED" record on read
 * so older in-flight sessions (created before this rename shipped) keep working.
 */
export type DeviceLinkState =
  | "PENDING"
  | "SCANNED"
  | "APPROVED"
  | "REJECTED"
  | "USED";

/** Device descriptor captured when the new device starts a link session. */
export type DeviceLinkDeviceInfo = {
  deviceName: string | null;
  deviceType: string | null;
  os: string | null;
  appVersion: string | null;
};

/** Full record persisted under `aimess:devlink:{linkToken}`. */
export type DeviceLinkRecord = {
  state: DeviceLinkState;
  pollSecretHash: string;
  device: DeviceLinkDeviceInfo;
  createdAt: string;
  expiresAt: string;
  scannedAt?: string;
  scannedByUserId?: string;
  approvedAt?: string;
  approvedDeviceLabel?: string | null;
  rejectedAt?: string;
  tokens?: AuthTokens;
  usedAt?: string;
};

/** Safe subset returned to any authenticated user viewing a pending QR before acting on it. */
export type DeviceLinkPendingDetails = {
  state: DeviceLinkState | "EXPIRED";
  device: DeviceLinkDeviceInfo;
  createdAt: string;
  expiresAt: string;
};

export type ScanDeviceLinkResult = {
  scannedAt: string;
  device: DeviceLinkDeviceInfo;
};

export type RejectDeviceLinkResult = {
  rejectedAt: string;
};

export type InitiateDeviceLinkResult = {
  linkToken: string;
  pollSecret: string;
  expiresAt: string;
};

export type DeviceLinkStatusResult = {
  state: DeviceLinkState | "EXPIRED";
  approvedDeviceLabel: string | null;
  tokens: AuthTokens | null;
};

export type ApproveDeviceLinkResult = {
  linkedAt: string;
  /** Session id of the newly-linked device — used to undo the link (revoke that session). */
  sessionId: string;
};
