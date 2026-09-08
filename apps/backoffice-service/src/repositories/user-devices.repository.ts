import {
  authClient,
  type RawAdminUserDeviceRecord,
} from "../grpc/auth.client.js";
import type {
  ListUserDevicesQuery,
  Paginated,
  PaginationMeta,
  UserDeviceRow,
} from "../types/user-management.types.js";

/**
 * Read-through repository for the "Linked Devices" block on the User
 * Management detail screen.
 *
 * The rows are owned by auth-service (its `user_devices` table in auth_db), so
 * this reaches them ONLY over the auth gRPC contract — the same rule every
 * other cross-service read in this service follows. There is no mirror table
 * in admin_db: a device record changes on every login, and a stale mirror of
 * "what phone is this person using" is worse than no answer.
 */
export interface UserDevicesRepository {
  listUserDevices(
    userId: string,
    query: ListUserDevicesQuery
  ): Promise<Paginated<UserDeviceRow>>;
}

/**
 * Restore null-vs-zero, which proto3 cannot carry.
 *
 * `presentFields` lists the numeric/boolean columns auth-service actually had a
 * value for. A field missing from it is UNKNOWN — not `0`, not `false`. Older
 * auth-service builds send no mask at all; in that case fall back to treating a
 * zero/false as absent, which is the pre-existing (lossy) behaviour and still
 * never invents a value that wasn't there.
 */
function nullableNumber(
  raw: RawAdminUserDeviceRecord,
  key: keyof RawAdminUserDeviceRecord,
  value: number
): number | null {
  if (raw.presentFields) return raw.presentFields.includes(key) ? value : null;
  return value === 0 ? null : value;
}

function nullableBoolean(
  raw: RawAdminUserDeviceRecord,
  key: keyof RawAdminUserDeviceRecord,
  value: boolean
): boolean | null {
  if (raw.presentFields) return raw.presentFields.includes(key) ? value : null;
  return value === false ? null : value;
}

/** "" → null, so the UI has one "unknown" to render rather than two. */
const blankToNull = (value: string): string | null => value.trim() || null;

/** ISO string → epoch ms, matching every other date this API emits. */
const isoToEpoch = (value: string): number => {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

function toRow(raw: RawAdminUserDeviceRecord): UserDeviceRow {
  return {
    deviceId: raw.deviceId,
    platform: raw.platform,
    deviceType: blankToNull(raw.deviceType),
    deviceName: blankToNull(raw.deviceName),
    manufacturer: blankToNull(raw.manufacturer),
    brand: blankToNull(raw.brand),
    model: blankToNull(raw.model),
    osVersion: blankToNull(raw.osVersion),
    sdkInt: nullableNumber(raw, "sdkInt", raw.sdkInt),
    appVersion: blankToNull(raw.appVersion),
    appBuild: nullableNumber(raw, "appBuild", raw.appBuild),
    buildType: blankToNull(raw.buildType),
    installerPackage: blankToNull(raw.installerPackage),
    locale: blankToNull(raw.locale),
    language: blankToNull(raw.language),
    country: blankToNull(raw.country),
    timezone: blankToNull(raw.timezone),
    utcOffsetMinutes: nullableNumber(
      raw,
      "utcOffsetMinutes",
      raw.utcOffsetMinutes
    ),
    screenWidthPx: nullableNumber(raw, "screenWidthPx", raw.screenWidthPx),
    screenHeightPx: nullableNumber(raw, "screenHeightPx", raw.screenHeightPx),
    screenDensityDpi: nullableNumber(
      raw,
      "screenDensityDpi",
      raw.screenDensityDpi
    ),
    networkType: blankToNull(raw.networkType),
    carrier: blankToNull(raw.carrier),
    isEmulator: nullableBoolean(raw, "isEmulator", raw.isEmulator),
    isRooted: nullableBoolean(raw, "isRooted", raw.isRooted),
    ipAddress: blankToNull(raw.ipAddress),
    countryCode: blankToNull(raw.countryCode),
    createdAt: isoToEpoch(raw.createdAt),
    updatedAt: isoToEpoch(raw.updatedAt),
    lastSeenAt: isoToEpoch(raw.lastSeenAt),
    lastLoginAt: isoToEpoch(raw.lastLoginAt),
    activeSessionCount: raw.activeSessionCount ?? 0,
    isActive: (raw.activeSessionCount ?? 0) > 0,
  };
}

export class GrpcUserDevicesRepository implements UserDevicesRepository {
  async listUserDevices(
    userId: string,
    query: ListUserDevicesQuery
  ): Promise<Paginated<UserDeviceRow>> {
    const { page, limit } = query;

    const { devices, total } = await authClient.adminListUserDevices({
      userId,
      limit,
      offset: (page - 1) * limit,
    });

    const data = devices.map(toRow);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    const pagination: PaginationMeta = {
      mode: "offset",
      page,
      limit,
      total,
      totalApprox: total,
      totalPages,
      hasNext: (page - 1) * limit + data.length < total,
      hasPrev: page > 1,
      nextCursor: null,
    };

    return { data, pagination };
  }
}

export const userDevicesRepository: UserDevicesRepository =
  new GrpcUserDevicesRepository();
