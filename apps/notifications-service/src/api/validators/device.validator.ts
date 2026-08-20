import { z } from "zod";

export const registerDeviceSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(["ANDROID", "IOS", "WEB"]),
  // "VOIP" registers an iOS PushKit token used only for call-ringing pushes
  // over APNs — distinct from the regular FCM/APNs token on the same device.
  tokenType: z.enum(["FCM", "VOIP"]).default("FCM"),
  deviceId: z.string().min(1).max(256).optional(),
});

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const unregisterDeviceParamsSchema = z.object({
  token: z.string().min(1).max(4096),
});

export type UnregisterDeviceParams = z.infer<
  typeof unregisterDeviceParamsSchema
>;
