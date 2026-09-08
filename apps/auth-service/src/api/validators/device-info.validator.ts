import { z } from "zod";

/**
 * The `device` object every client may attach to login / register / social
 * login.
 *
 * OPTIONAL end to end, by contract. Android already ships it; iOS and the web
 * are catching up, and every build older than those sends nothing at all. A
 * required field here would answer VALIDATION_FAILED to a shipped app that has
 * a correct password — so the whole object is `.nullish()` at the call sites
 * and every field inside it is optional as well.
 *
 * The client never gets to state its own IP or geo-IP country: both are
 * derived server-side from the request (see `session-context.ts`). Anything
 * needing a restricted permission — IMEI, MAC, phone number, advertising id,
 * GPS, installed apps, contacts, Wi-Fi SSID — is deliberately absent and must
 * stay absent; adding one changes what the app has to declare on the store
 * listing, which is not a backend decision.
 *
 * Unknown keys are STRIPPED (zod's default), not rejected: a newer client that
 * learns to report one more field must not start failing to log in against an
 * older server.
 */

/** Platform. `DESKTOP` is deliberately absent — that is a form factor, below. */
export const devicePlatformEnum = z.enum(["ANDROID", "IOS", "WEB"]);

/**
 * Form factor. `DESKTOP` is web-only: Android and iOS report PHONE or TABLET
 * exclusively, so accepting a third value here takes nothing away from them.
 */
export const deviceFormFactorEnum = z.enum(["PHONE", "TABLET", "DESKTOP"]);

export const networkTypeEnum = z.enum([
  "WIFI",
  "CELLULAR",
  "ETHERNET",
  "VPN",
  "OTHER",
  "NONE",
  "UNKNOWN",
]);

/**
 * A short free-text device attribute.
 *
 * Bounded and trimmed because every one of these is client-controlled text
 * that ends up rendered in "Linked devices" and in the Super Admin panel. An
 * empty string after trimming becomes `undefined` rather than being stored as
 * `""`, so "the client sent nothing" and "the client sent whitespace" persist
 * identically instead of producing two flavours of blank in the UI.
 */
const shortText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional()
    .nullable();

/** A non-negative integer attribute (SDK level, build number, pixels, DPI). */
const nonNegativeInt = (max: number) =>
  z.number().int().min(0).max(max).optional().nullable();

export const deviceInfoSchema = z.object({
  /**
   * Stable per-install identifier — ANDROID_ID / a persisted UUID / the web's
   * `aimess:device-id`. It is the row key for the device record AND the value
   * the same client sends to `POST /api/v1/devices`, which is what lets one
   * device have a single identity across sessions, push tokens and the admin
   * device list.
   */
  deviceId: z.string().trim().min(1).max(256),
  platform: devicePlatformEnum,
  deviceType: deviceFormFactorEnum.optional().nullable(),
  deviceName: shortText(120),
  manufacturer: shortText(80),
  brand: shortText(80),
  model: shortText(120),
  osVersion: shortText(40),
  sdkInt: nonNegativeInt(1_000),
  appVersion: shortText(40),
  appBuild: nonNegativeInt(2_147_483_647),
  buildType: shortText(20),
  installerPackage: shortText(160),
  locale: shortText(35),
  language: shortText(16),
  country: shortText(8),
  timezone: shortText(64),
  // Real zones run -12:00 … +14:00, and DST pushes the extremes; the bound is
  // just a sanity clamp on a client-supplied number.
  utcOffsetMinutes: z.number().int().min(-900).max(900).optional().nullable(),
  screenWidthPx: nonNegativeInt(100_000),
  screenHeightPx: nonNegativeInt(100_000),
  screenDensityDpi: nonNegativeInt(10_000),
  networkType: networkTypeEnum.optional().nullable(),
  carrier: shortText(80),
  isEmulator: z.boolean().optional().nullable(),
  isRooted: z.boolean().optional().nullable(),
});

export type DeviceInfoInput = z.infer<typeof deviceInfoSchema>;

/**
 * The field as it is mounted on an auth request body.
 *
 * `.nullish()` rather than `.optional()`: a client that has no device info to
 * report may send an explicit `"device": null`, and that must parse, not 400.
 */
export const deviceInfoField = deviceInfoSchema.nullish();
