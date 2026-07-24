import { logger } from "@aimess/logger";
import type { SystemFlagRepository } from "../repositories/system-flag.repository.js";

/** Flag key for the platform-wide calling kill-switch. */
export const CALLING_ENABLED_FLAG = "calling.enabled";

/** How long a read is trusted before re-checking the DB. */
const CACHE_TTL_MS = 10_000;

export interface CallingFlagState {
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: Date | null;
}

/**
 * The platform-wide calling kill-switch, read on the hot path of every call
 * initiation.
 *
 * Two properties matter more than freshness:
 *
 *  1. **Fail-open.** If the flag can't be read (DB down, transient error) we
 *     report ENABLED. Taking calling down because a lookup hiccuped would be a
 *     far worse outage than briefly ignoring an admin toggle.
 *  2. **Cheap.** A short in-process TTL cache keeps `initiateCall` from adding
 *     a database round-trip per call. The cost is that a toggle takes up to
 *     CACHE_TTL_MS (and, with multiple chat-service nodes, up to that long on
 *     each node) to take effect — fine for an admin switch.
 *
 * ponytail: per-node cache, no invalidation fan-out. If a flip ever needs to be
 * instant across nodes, publish an invalidation on the existing Redis bus.
 */
export class CallFlagService {
  private cached: { enabled: boolean; at: number } | null = null;

  constructor(private readonly systemFlagRepo: SystemFlagRepository) {}

  /** Hot-path read. Never throws — an unreadable flag resolves to `true`. */
  async isCallingEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_TTL_MS) {
      return this.cached.enabled;
    }
    try {
      const row = await this.systemFlagRepo.findByKey(CALLING_ENABLED_FLAG);
      // Never set → calling is on. Absence of an explicit "off" is not "off".
      const enabled = row?.enabled ?? true;
      this.cached = { enabled, at: now };
      return enabled;
    } catch (error) {
      logger.warn(
        `CallFlagService|isCallingEnabled read failed, failing OPEN: ${String(error)}`
      );
      return true;
    }
  }

  /** Admin read — bypasses the cache so the panel always shows the truth. */
  async getState(): Promise<CallingFlagState> {
    const row = await this.systemFlagRepo.findByKey(CALLING_ENABLED_FLAG);
    return {
      enabled: row?.enabled ?? true,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** Admin write. Updates the local cache immediately on this node. */
  async setEnabled(
    enabled: boolean,
    actorId?: string | null
  ): Promise<CallingFlagState> {
    const row = await this.systemFlagRepo.upsert({
      key: CALLING_ENABLED_FLAG,
      enabled,
      updatedBy: actorId ?? null,
    });
    this.cached = { enabled: row.enabled, at: Date.now() };
    logger.info(
      `CallFlagService|calling ${row.enabled ? "ENABLED" : "DISABLED"} by ${row.updatedBy ?? "unknown"}`
    );
    return {
      enabled: row.enabled,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }
}
