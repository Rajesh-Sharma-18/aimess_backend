import { prisma } from "../config/prisma.js";
import type {
  DeviceFormFactor,
  DeviceType,
  NetworkType,
  Prisma,
} from "../generated/prisma/client.js";

/** The columns the Super Admin device screen and the device list read. */
export const userDeviceSelect = {
  id: true,
  deviceId: true,
  platform: true,
  deviceType: true,
  deviceName: true,
  manufacturer: true,
  brand: true,
  model: true,
  osVersion: true,
  sdkInt: true,
  appVersion: true,
  appBuild: true,
  buildType: true,
  installerPackage: true,
  locale: true,
  language: true,
  country: true,
  timezone: true,
  utcOffsetMinutes: true,
  screenWidthPx: true,
  screenHeightPx: true,
  screenDensityDpi: true,
  networkType: true,
  carrier: true,
  isEmulator: true,
  isRooted: true,
  ipAddress: true,
  countryCode: true,
  lastSeenAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type UserDeviceRow = Prisma.UserDeviceGetPayload<{
  select: typeof userDeviceSelect;
}>;

/** Everything a caller can persist about one device, already normalized. */
export type UserDeviceMetadata = {
  platform: DeviceType;
  deviceType: DeviceFormFactor | null;
  deviceName: string | null;
  manufacturer: string | null;
  brand: string | null;
  model: string | null;
  osVersion: string | null;
  sdkInt: number | null;
  appVersion: string | null;
  appBuild: number | null;
  buildType: string | null;
  installerPackage: string | null;
  locale: string | null;
  language: string | null;
  country: string | null;
  timezone: string | null;
  utcOffsetMinutes: number | null;
  screenWidthPx: number | null;
  screenHeightPx: number | null;
  screenDensityDpi: number | null;
  networkType: NetworkType | null;
  carrier: string | null;
  isEmulator: boolean | null;
  isRooted: boolean | null;
  /** Server-derived — never read off the client payload. */
  ipAddress: string | null;
  countryCode: string | null;
  userAgent: string | null;
};

export const userDeviceRepository = {
  /**
   * Record this authentication against the device it came from.
   *
   * Upsert, not insert: `deviceId` is stable per install, so a user signing in
   * from the same browser/phone for the hundredth time must refresh one row —
   * not accumulate a hundred. The composite unique `(userId, deviceId)` is what
   * makes that safe when two accounts share a browser: each gets its own row
   * and neither can read the other's.
   *
   * Every metadata column is overwritten on each login rather than merged. The
   * payload is a full snapshot of the device as it is right now — a phone that
   * upgraded its OS, changed locale or fell off Wi-Fi should report the new
   * value, and treating an omitted field as "keep the old one" would pin stale
   * data forever with no way for a client to clear it.
   */
  upsertOnLogin(params: {
    userId: string;
    deviceId: string;
    metadata: UserDeviceMetadata;
    at?: Date;
  }): Promise<{ id: string }> {
    const now = params.at ?? new Date();
    const data = { ...params.metadata, lastSeenAt: now, lastLoginAt: now };

    return prisma.userDevice.upsert({
      where: {
        userId_deviceId: { userId: params.userId, deviceId: params.deviceId },
      },
      create: { userId: params.userId, deviceId: params.deviceId, ...data },
      update: data,
      select: { id: true },
    });
  },

  /**
   * Devices belonging to ONE user, newest activity first.
   *
   * `userId` is part of the where clause rather than a post-filter, so an admin
   * screen cannot page its way into another account's devices.
   */
  async listByUserId(params: {
    userId: string;
    skip: number;
    take: number;
  }): Promise<{ rows: UserDeviceRow[]; total: number }> {
    const [rows, total] = await Promise.all([
      prisma.userDevice.findMany({
        where: { userId: params.userId },
        select: userDeviceSelect,
        orderBy: { lastSeenAt: "desc" },
        skip: params.skip,
        take: params.take,
      }),
      prisma.userDevice.count({ where: { userId: params.userId } }),
    ]);

    return { rows, total };
  },

  /**
   * Live-session count per deviceId for one user.
   *
   * A device is "signed in right now" when a session keyed on its deviceId is
   * unrevoked and still holds a usable refresh token — the same definition
   * `sessionRepository.listActiveByUserId` uses, so the admin panel and the
   * user's own "Linked devices" screen never disagree about which device is
   * active.
   *
   * Only meaningful for sessions created by a client that sent a `device`
   * payload: without one the session's deviceId is the server's
   * sha256(userAgent|ip) fingerprint and matches no device row, which reads
   * correctly as "no live session on record".
   */
  async countActiveSessionsByDeviceId(
    userId: string
  ): Promise<Map<string, number>> {
    const grouped = await prisma.session.groupBy({
      by: ["deviceId"],
      where: {
        userId,
        revokedAt: null,
        refreshTokens: {
          some: { revokedAt: null, expiresAt: { gt: new Date() } },
        },
      },
      _count: { _all: true },
    });

    return new Map(grouped.map((row) => [row.deviceId, row._count._all]));
  },
};
