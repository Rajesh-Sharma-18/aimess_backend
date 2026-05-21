import type { AuthTokens } from "../lib/token.js";

/** Lifecycle of a QR device-link session stored in Redis. */
export type DeviceLinkState = "PENDING" | "APPROVED" | "CONSUMED";

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
  approvedAt?: string;
  approvedDeviceLabel?: string | null;
  tokens?: AuthTokens;
  consumedAt?: string;
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
