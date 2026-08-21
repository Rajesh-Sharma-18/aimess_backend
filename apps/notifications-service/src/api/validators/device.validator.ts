import { z } from "zod";

export const registerDeviceSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(["ANDROID", "IOS", "WEB"]),
  // "VOIP" registers an iOS PushKit token used only for call-ringing pushes
  // over APNs — distinct from the regular FCM/APNs token on the same device.
  tokenType: z.enum(["FCM", "VOIP"]).default("FCM"),
  deviceId: z.string().min(1).max(256).optional(),
  // Push-tray language for THIS device. Free-form on purpose: a language tag
  // legitimately arrives with a region subtag ("th-TH"), and an unsupported
  // one must be IGNORED rather than rejected — a 400 would fail the whole
  // registration and leave the device with no push at all. The controller
  // narrows it via `parseSupportedLocale`, which returns null for anything
  // this build does not carry.
  lang: z.string().min(2).max(16).optional(),
});

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const unregisterDeviceParamsSchema = z.object({
  token: z.string().min(1).max(4096),
});

export type UnregisterDeviceParams = z.infer<
  typeof unregisterDeviceParamsSchema
>;
