import { z } from "zod";

const optionalDeviceField = z.string().trim().max(100).optional();

export const initiateDeviceLinkSchema = z.object({
  deviceName: optionalDeviceField,
  deviceType: optionalDeviceField,
  os: optionalDeviceField,
  appVersion: optionalDeviceField,
});

export type InitiateDeviceLinkInput = z.infer<typeof initiateDeviceLinkSchema>;

/** Telegram-style: scanning IS logging in — no separate approve step. */
export const scanDeviceLinkSchema = z.object({
  linkToken: z.string().trim().min(1, "Link token is required"),
  appVersion: optionalDeviceField,
  deviceLabel: z.string().trim().max(100).optional(),
});

export type ScanDeviceLinkInput = z.infer<typeof scanDeviceLinkSchema>;
