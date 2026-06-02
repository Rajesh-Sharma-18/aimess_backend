import { z } from "zod";

export const registerDeviceSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(["ANDROID", "IOS", "WEB"]),
  deviceId: z.string().min(1).max(256).optional(),
});

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const unregisterDeviceParamsSchema = z.object({
  token: z.string().min(1).max(4096),
});
