import { z } from "zod";

const optionalDeviceField = z.string().trim().max(100).optional();

export const initiateDeviceLinkSchema = z.object({
  deviceName: optionalDeviceField,
  deviceType: optionalDeviceField,
  os: optionalDeviceField,
  appVersion: optionalDeviceField,
  /**
   * Opaque per-browser id the client generates once and keeps (localStorage).
   * Used ONLY as the "one active QR per browser" index key — never persisted
   * as device metadata, never trusted for identity. Charset/length constrained
   * so it can be embedded in a Redis key safely.
   */
  clientId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
});

export type InitiateDeviceLinkInput = z.infer<typeof initiateDeviceLinkSchema>;

/** Telegram-style: scanning IS logging in — no separate approve step. */
export const scanDeviceLinkSchema = z.object({
  linkToken: z.string().trim().min(1, "Link token is required"),
  appVersion: optionalDeviceField,
  deviceLabel: z.string().trim().max(100).optional(),
});

export type ScanDeviceLinkInput = z.infer<typeof scanDeviceLinkSchema>;

/** Browser polling for its own QR's outcome — the linkToken is the only credential. */
export const deviceLinkResultSchema = z.object({
  linkToken: z.string().trim().min(1, "Link token is required"),
});

export type DeviceLinkResultInput = z.infer<typeof deviceLinkResultSchema>;
