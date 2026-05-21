import { z } from "zod";

const optionalDeviceField = z.string().trim().max(100).optional();

export const initiateDeviceLinkSchema = z.object({
  deviceName: optionalDeviceField,
  deviceType: optionalDeviceField,
  os: optionalDeviceField,
  appVersion: optionalDeviceField,
});

export type InitiateDeviceLinkInput = z.infer<typeof initiateDeviceLinkSchema>;

export const deviceLinkStatusQuerySchema = z.object({
  linkToken: z.string().trim().min(1),
  pollSecret: z.string().trim().min(1),
});

export type DeviceLinkStatusQuery = z.infer<typeof deviceLinkStatusQuerySchema>;

export const approveDeviceLinkSchema = z.object({
  linkToken: z.string().trim().min(1),
  deviceLabel: z.string().trim().max(100).optional(),
});

export type ApproveDeviceLinkInput = z.infer<typeof approveDeviceLinkSchema>;
