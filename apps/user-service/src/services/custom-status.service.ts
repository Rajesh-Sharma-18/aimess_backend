import { NotFoundError } from "@aimess/errors";

import type { SetCustomStatusInput } from "../api/validators/profile.validator.js";
import { emitCustomStatusUpdatedSafe } from "../lib/profile-socket.js";
import { SCHEMA_DEFAULT_SCOPE } from "../lib/privacy-scope.js";
import {
  userProfileRepository,
  type CustomStatusColumns,
  type CustomStatusWriteRow,
} from "../repositories/user-profile.repository.js";

export type CustomStatus = {
  emoji: string | null;
  text: string | null;
  startedAt: Date;
  expiresAt: Date;
  updatedAt: Date;
};

export type CustomStatusResult = { customStatus: CustomStatus | null; serverNow: number };

/** Lazy expiry: an expired (not yet swept) row reads as no status. */
export function activeCustomStatus(
  row: CustomStatusColumns | null | undefined,
  now: number = Date.now()
): CustomStatus | null {
  if (!row?.customStatusExpiresAt || row.customStatusExpiresAt.getTime() <= now) {
    return null;
  }
  return {
    emoji: row.customStatusEmoji,
    text: row.customStatusText,
    startedAt: row.customStatusStartedAt ?? row.customStatusExpiresAt,
    expiresAt: row.customStatusExpiresAt,
    updatedAt: row.customStatusUpdatedAt ?? row.customStatusExpiresAt,
  };
}

function publicToWatchers(row: CustomStatusWriteRow): boolean {
  return (row.whoCanViewProfile ?? SCHEMA_DEFAULT_SCOPE.whoCanViewProfile) === "EVERYONE";
}

export const customStatusService = {
  async getOwn(userId: string): Promise<CustomStatusResult> {
    const now = Date.now();
    const row = await userProfileRepository.findCustomStatus(userId);
    return { customStatus: activeCustomStatus(row, now), serverNow: now };
  },

  async set(userId: string, input: SetCustomStatusInput): Promise<CustomStatusResult> {
    const startedAt = new Date();
    const status: CustomStatus = {
      emoji: input.emoji,
      text: input.text,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + input.durationSeconds * 1000),
      updatedAt: startedAt,
    };
    const row = await userProfileRepository.setCustomStatus(userId, status);
    if (!row) throw new NotFoundError("USER_PROFILE_NOT_FOUND");
    emitCustomStatusUpdatedSafe(userId, startedAt, status, publicToWatchers(row));
    return { customStatus: status, serverNow: startedAt.getTime() };
  },

  async clear(userId: string): Promise<CustomStatusResult> {
    const now = new Date();
    const row = await userProfileRepository.clearCustomStatus(userId, now);
    if (row) emitCustomStatusUpdatedSafe(userId, now, null, publicToWatchers(row));
    return { customStatus: null, serverNow: now.getTime() };
  },

  /** Sweeper step: claims up to `limit` expired rows and emits `customStatus: null` for each. */
  async expireDue(limit: number): Promise<number> {
    const now = new Date();
    const rows = await userProfileRepository.claimExpiredCustomStatuses(now, limit);
    for (const row of rows) {
      emitCustomStatusUpdatedSafe(row.userId, now, null, publicToWatchers(row));
    }
    return rows.length;
  },
};
