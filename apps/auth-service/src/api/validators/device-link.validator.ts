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
  linkToken: z.string().trim().min(1, "Link token is required"),
  pollSecret: z.string().trim().min(1, "Poll secret is required"),
});

export type DeviceLinkStatusQuery = z.infer<typeof deviceLinkStatusQuerySchema>;

export const approveDeviceLinkSchema = z.object({
  linkToken: z.string().trim().min(1, "Link token is required"),
  deviceLabel: z.string().trim().max(100).optional(),
});

export type ApproveDeviceLinkInput = z.infer<typeof approveDeviceLinkSchema>;

export const scanDeviceLinkSchema = z.object({
  linkToken: z.string().trim().min(1, "Link token is required"),
});

export type ScanDeviceLinkInput = z.infer<typeof scanDeviceLinkSchema>;

export const rejectDeviceLinkSchema = z.object({
  linkToken: z.string().trim().min(1, "Link token is required"),
});

export type RejectDeviceLinkInput = z.infer<typeof rejectDeviceLinkSchema>;

export const linkTokenParamsSchema = z.object({
  linkToken: z.string().trim().min(1, "Link token is required"),
});

export type LinkTokenParams = z.infer<typeof linkTokenParamsSchema>;
