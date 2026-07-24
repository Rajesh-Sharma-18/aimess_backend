import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";
import {
  chatClient,
  type AdminCallAnalytics,
  type AdminCallHealth,
} from "../grpc/chat.client.js";

/**
 * Admin call analytics — a read-only view of chat-service's `calls` collection,
 * served over gRPC (backoffice has no direct access to that database).
 *
 * Mirrors `dashboard.service.ts`: short-lived Redis cache, and one down
 * upstream must NEVER 500 the panel — a failed fetch degrades to zeroed stats
 * with `available: false` so the UI can say "unavailable" instead of breaking.
 */

const CACHE_PREFIX = "backoffice:calls:analytics:";
const CACHE_TTL_SECONDS = 30;

export interface CallAnalyticsResponse extends AdminCallAnalytics {
  /** Live call counters, folded in so the panel needs one request, not two. */
  activeCalls: number;
  ringingCalls: number;
  /** False when chat-service was unreachable — figures are placeholders. */
  available: boolean;
  range: { fromDate: string | null; toDate: string | null };
}

const EMPTY: AdminCallAnalytics = {
  totalCalls: 0,
  audioCalls: 0,
  videoCalls: 0,
  answeredCalls: 0,
  missedCalls: 0,
  declinedCalls: 0,
  missedRate: 0,
  avgDurationSec: 0,
  medianDurationSec: 0,
  p90DurationSec: 0,
  totalDurationSec: 0,
  peakHours: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
  connectionSuccessRate: 0,
};

async function readCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    logger.warn(`call analytics cache read failed (${key})`, err);
    return null;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), "EX", CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn(`call analytics cache write failed (${key})`, err);
  }
}

export const callAnalyticsService = {
  async getAnalytics(params: {
    fromDate?: string;
    toDate?: string;
  }): Promise<CallAnalyticsResponse> {
    const fromDate = params.fromDate ?? "";
    const toDate = params.toDate ?? "";
    const cacheKey = `${CACHE_PREFIX}${fromDate}:${toDate}`;

    const cached = await readCache<CallAnalyticsResponse>(cacheKey);
    if (cached) return cached;

    const [analytics, health] = await Promise.allSettled([
      chatClient.adminGetCallAnalytics({ fromDate, toDate }),
      chatClient.adminGetCallHealth(),
    ]);

    if (analytics.status === "rejected") {
      logger.warn("call analytics upstream failed", analytics.reason);
    }

    const stats: AdminCallAnalytics =
      analytics.status === "fulfilled" ? analytics.value : EMPTY;
    const live: AdminCallHealth =
      health.status === "fulfilled"
        ? health.value
        : { activeCalls: 0, ringingCalls: 0 };

    const result: CallAnalyticsResponse = {
      ...stats,
      activeCalls: live.activeCalls,
      ringingCalls: live.ringingCalls,
      available: analytics.status === "fulfilled",
      range: { fromDate: fromDate || null, toDate: toDate || null },
    };

    // Don't cache a failure — the next request should retry the upstream.
    if (result.available) await writeCache(cacheKey, result);
    return result;
  },
};
