import { logger } from "@aimess/logger";

import type {
  DeviceFormFactor,
  DeviceType,
  NetworkType,
} from "../generated/prisma/client.js";
import {
  userDeviceRepository,
  type UserDeviceMetadata,
} from "../repositories/user-device.repository.js";
import type { SessionContext } from "./session-context.js";

/**
 * Zod → Prisma enum. A cast, not a lookup.
 *
 * `deviceFormFactorEnum` / `networkTypeEnum` in the validator enumerate exactly
 * the members of the Prisma enums they mirror, and nothing reaches here that
 * has not been through them — so the two string unions are the same set and the
 * cast asserts a fact the type system already knows.
 *
 * It deliberately does NOT re-check membership against the generated enum
 * OBJECT. That reads as a free safety net but is not one: the two lists are
 * declared side by side, and a mismatch introduced by editing one is a schema
 * change that would fail Prisma's own validation long before a login runs.
 * TypeScript is the guard here; a runtime `in` check only added a way to
 * silently write null.
 */
const asEnum = <T extends string>(value: string | null | undefined): T | null =>
  value ? (value as T) : null;

/**
 * The device record for this authentication, or null when the client sent no
 * `device` object.
 *
 * `platform` is the client's LITERAL platform (ANDROID | IOS | WEB), not the
 * session row's `deviceType`. The two deliberately differ for a desktop
 * browser: the session folds (WEB, DESKTOP) down to DESKTOP because
 * announcement targeting segments on that one column, but a device record has
 * a separate `deviceType` column for the form factor — so reusing the folded
 * value here stored "DESKTOP / DESKTOP" and threw away the fact that the login
 * came from a browser at all.
 *
 * IP, geo-IP country and user agent are taken from the SERVER-derived half of
 * the context and are never accepted from the payload: the mobile contract
 * excludes them for exactly that reason.
 */
export function toDeviceMetadata(
  session: SessionContext
): UserDeviceMetadata | null {
  const device = session.device;
  if (!device) return null;

  return {
    platform: asEnum<DeviceType>(device.platform)!,
    deviceType: asEnum<DeviceFormFactor>(device.deviceType),
    deviceName: device.deviceName ?? session.deviceName,
    manufacturer: device.manufacturer ?? null,
    brand: device.brand ?? null,
    model: device.model ?? null,
    osVersion: device.osVersion ?? session.osVersion,
    sdkInt: device.sdkInt ?? null,
    appVersion: device.appVersion ?? session.appVersion,
    appBuild: device.appBuild ?? null,
    buildType: device.buildType ?? null,
    installerPackage: device.installerPackage ?? null,
    locale: device.locale ?? null,
    language: device.language ?? null,
    country: device.country ?? null,
    timezone: device.timezone ?? null,
    utcOffsetMinutes: device.utcOffsetMinutes ?? null,
    screenWidthPx: device.screenWidthPx ?? null,
    screenHeightPx: device.screenHeightPx ?? null,
    screenDensityDpi: device.screenDensityDpi ?? null,
    networkType: asEnum<NetworkType>(device.networkType),
    carrier: device.carrier ?? null,
    isEmulator: device.isEmulator ?? null,
    isRooted: device.isRooted ?? null,
    ipAddress: session.ipAddress,
    countryCode: session.countryCode,
    userAgent: session.userAgent,
  };
}

/**
 * Persist / refresh the device row for a session that has just been created.
 *
 * Deliberately non-blocking and fully swallowed. A device record is diagnostic
 * and administrative data; the tokens have already been minted and returned by
 * the time this runs, so a Postgres hiccup here must cost the user a row in an
 * admin table — never their login.
 */
export async function recordLoginDeviceSafe(
  userId: string,
  session: SessionContext
): Promise<void> {
  const metadata = toDeviceMetadata(session);
  if (!metadata) return;

  try {
    await userDeviceRepository.upsertOnLogin({
      userId,
      deviceId: session.deviceId,
      metadata,
    });
  } catch (error) {
    logger.error("Failed to record login device");
    logger.error(error);
  }
}
