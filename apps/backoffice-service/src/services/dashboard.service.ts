import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";
import {
  authClient,
  getUserCountsBreaker,
  getActiveUserCountsBreaker,
} from "../grpc/auth.client.js";
import type { ActiveUserSeriesBucket } from "../grpc/auth.client.js";
import {
  communityClient,
  getCommunityCountBreaker,
} from "../grpc/community.client.js";
import { chatClient, getGroupCountBreaker } from "../grpc/chat.client.js";

/**
 * Dashboard aggregation — live, read-only gRPC fan-out across services, split
 * into three independently-cached sections: `getOverview` (stat cards),
 * `getCharts(period)` (active-vs-churned series + communities/groups donut),
 * and `getServiceStatus` (health panel). Each method fetches ONLY the upstreams
 * its section needs so the sections can refresh on their own cadence.
 *
 * Resilience contract: one down service must NEVER 500 the dashboard. Every
 * upstream call goes through `Promise.allSettled`; a rejected field falls back
 * to 0. (The grpc-utils breaker fallback THROWS "<name> unavailable", so we
 * cannot rely on a silent fallback — we catch.)
 *
 * `totalLivestreams` and `openReports` have no backoffice gRPC client yet, so
 * they are STATIC stubs (0). `churnedUsers` is likewise a stub (0) — we do not
 * fabricate churn.
 */

const OVERVIEW_CACHE_KEY = "backoffice:dashboard:overview";
const CHARTS_CACHE_PREFIX = "backoffice:dashboard:charts:";
const SERVICE_STATUS_CACHE_KEY = "backoffice:dashboard:service-status";
const CACHE_TTL_SECONDS = 10;

export type DashboardPeriod = "daily" | "weekly" | "monthly";

export interface DashboardStats {
  totalUsers: number;
  newUsersToday: number;
  dailyActiveUsers: number;
  monthlyActiveUsers: number;
  totalCommunities: number;
  totalGroups: number;
  totalLivestreams: number;
  openReports: number;
  bannedUsers: number;
  churnedUsers: number;
}

export interface CommunitiesGroups {
  communities: number;
  groups: number;
  total: number;
}

export interface ActiveVsChurned {
  period: "daily" | "weekly" | "monthly";
  series: Array<{
    bucket: string;
    dailyActive: number;
    monthlyActive: number;
    churned: number;
  }>;
  note: string;
}

type ServiceState = "operational" | "degraded" | "down";

export interface ServiceStatus {
  services: Array<{
    key: string;
    label: string;
    status: ServiceState;
    latencyMs?: number | null;
    breaker?: string | null;
    note?: string;
  }>;
  checkedAt: string;
}

async function readCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    logger.warn(`dashboard cache read failed (${key})`, err);
    return null;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), "EX", CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn(`dashboard cache write failed (${key})`, err);
  }
}

/** Breaker-derived per-service health. Pure/sync — reads opossum flags only. */
function buildServiceStatus(): ServiceStatus {
  const breakerState = (b: {
    opened: boolean;
    halfOpen: boolean;
  }): { status: ServiceState; breaker: string | null } => {
    if (b.opened) return { status: "down", breaker: "open" };
    if (b.halfOpen) return { status: "degraded", breaker: "half-open" };
    return { status: "operational", breaker: null };
  };

  // auth-service surfaces two breakers; treat the worst as the service state.
  const authStates = [getUserCountsBreaker, getActiveUserCountsBreaker].map(
    breakerState
  );
  const worst: ServiceState = authStates.some((s) => s.status === "down")
    ? "down"
    : authStates.some((s) => s.status === "degraded")
      ? "degraded"
      : "operational";
  const authBreaker =
    authStates.find((s) => s.breaker !== null)?.breaker ?? null;

  const community = breakerState(getCommunityCountBreaker);
  const chat = breakerState(getGroupCountBreaker);

  return {
    services: [
      {
        key: "auth",
        label: "API / Auth Service",
        status: worst,
        breaker: authBreaker,
      },
      {
        key: "chat",
        label: "Chat Service",
        status: chat.status,
        breaker: chat.breaker,
      },
      {
        key: "community",
        label: "Community Service",
        status: community.status,
        breaker: community.breaker,
      },
      // No backoffice gRPC client for these — status genuinely unknown.
      {
        key: "media",
        label: "Media Service",
        status: "degraded",
        breaker: null,
        note: "No health probe wired yet — status unknown.",
      },
      {
        key: "notification",
        label: "Notification Service",
        status: "degraded",
        breaker: null,
        note: "No health probe wired yet — status unknown.",
      },
      {
        key: "livestream",
        label: "Livestream Service",
        status: "degraded",
        breaker: null,
        note: "No health probe wired yet — status unknown.",
      },
    ],
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Map a dashboard `period` to an inclusive [startDate, endDate] UTC date range
 * (YYYY-MM-DD, DAY granularity).
 *   - daily:   the last 15 days ending today      → 15 daily points
 *   - weekly:  the last 8 days ending today        → 8 daily points
 *   - monthly: the 1st → LAST day of the current month → one point per calendar
 *              day of the month (days after today have no data yet and come back
 *              as 0 from the series builder).
 */
function periodToRange(period: DashboardPeriod): {
  startDate: string;
  endDate: string;
} {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const toYmd = (d: Date): string => d.toISOString().slice(0, 10);

  if (period === "daily") {
    const start = new Date(todayUtc.getTime() - 14 * MS_PER_DAY);
    return { startDate: toYmd(start), endDate: toYmd(todayUtc) };
  }
  if (period === "weekly") {
    const start = new Date(todayUtc.getTime() - 7 * MS_PER_DAY);
    return { startDate: toYmd(start), endDate: toYmd(todayUtc) };
  }
  // monthly → 1st through the LAST day of the current month (UTC). Day 0 of the
  // next month resolves to the last day of this one.
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const monthEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
  );
  return { startDate: toYmd(monthStart), endDate: toYmd(monthEnd) };
}

export const dashboardService = {
  /**
   * Stat-card section only. Fetches EXACTLY the upstreams the cards need
   * (auth user counts, auth active counts, community count, group count) — NOT
   * the per-day series. Cached independently (10s) under a period-less key so
   * the cards refresh on their own cadence. One down service never 500s the
   * call — each rejected upstream falls back to 0.
   */
  async getOverview(): Promise<{ stats: DashboardStats }> {
    const cached = await readCache<{ stats: DashboardStats }>(
      OVERVIEW_CACHE_KEY
    );
    if (cached) return cached;

    const [userCounts, activeCounts, communityCount, groupCount] =
      await Promise.allSettled([
        authClient.getUserCounts(),
        authClient.getActiveUserCounts(),
        communityClient.getCommunityCount(),
        chatClient.getGroupCount(),
      ]);

    let totalUsers = 0;
    let newUsersToday = 0;
    let bannedUsers = 0;
    if (userCounts.status === "fulfilled") {
      totalUsers = userCounts.value.totalUsers;
      newUsersToday = userCounts.value.newUsersToday;
      bannedUsers = userCounts.value.bannedUsers;
    }

    let dailyActiveUsers = 0;
    let monthlyActiveUsers = 0;
    if (activeCounts.status === "fulfilled") {
      dailyActiveUsers = activeCounts.value.dailyActive;
      monthlyActiveUsers = activeCounts.value.monthlyActive;
    }

    let totalCommunities = 0;
    if (communityCount.status === "fulfilled") {
      totalCommunities = communityCount.value;
    }

    let totalGroups = 0;
    if (groupCount.status === "fulfilled") {
      totalGroups = groupCount.value;
    }

    const stats: DashboardStats = {
      totalUsers,
      newUsersToday,
      dailyActiveUsers,
      monthlyActiveUsers,
      totalCommunities,
      totalGroups,
      // Static stubs — no live source wired yet.
      totalLivestreams: 0,
      openReports: 0,
      bannedUsers,
      churnedUsers: 0,
    };

    const overview = { stats };
    await writeCache(OVERVIEW_CACHE_KEY, overview);
    return overview;
  },

  /**
   * Chart section: the active-vs-churned per-day series (date range driven by
   * `period`) plus the communities/groups donut. Fetches EXACTLY the upstreams
   * these charts need (community count, group count, period-driven active
   * series) — NOT the user/active/banned counts. Cached per-period (10s). One
   * down service never 500s the call — the series falls back to empty and the
   * donut counts fall back to 0.
   */
  async getCharts(period: DashboardPeriod): Promise<{
    activeVsChurned: ActiveVsChurned;
    communitiesGroups: CommunitiesGroups;
  }> {
    const cacheKey = `${CHARTS_CACHE_PREFIX}${period}`;
    const cached = await readCache<{
      activeVsChurned: ActiveVsChurned;
      communitiesGroups: CommunitiesGroups;
    }>(cacheKey);
    if (cached) return cached;

    const { startDate, endDate } = periodToRange(period);

    const [communityCount, groupCount, activeSeries] = await Promise.allSettled(
      [
        communityClient.getCommunityCount(),
        chatClient.getGroupCount(),
        authClient.getActiveUserSeries(startDate, endDate),
      ]
    );

    // On upstream failure we fall back to 0 counts / an empty series rather
    // than 500 the dashboard.
    let totalCommunities = 0;
    if (communityCount.status === "fulfilled") {
      totalCommunities = communityCount.value;
    }

    let totalGroups = 0;
    if (groupCount.status === "fulfilled") {
      totalGroups = groupCount.value;
    }

    const communitiesGroups: CommunitiesGroups = {
      communities: totalCommunities,
      groups: totalGroups,
      total: totalCommunities + totalGroups,
    };

    // Real per-day series, computed live from auth-service session activity
    // over the `period`-driven UTC range (daily=16d, weekly=7d, monthly=MTD).
    // If the series RPC rejects (auth-service down / breaker open), fall back to
    // an empty series — never 500 the dashboard.
    let series: ActiveUserSeriesBucket[] = [];
    if (activeSeries.status === "fulfilled") {
      series = activeSeries.value;
    }

    const activeVsChurned: ActiveVsChurned = {
      period,
      series,
      note: "Live per-day active/churned series computed from session lastActiveAt over the period range (daily=today+15d, weekly=today+6d, monthly=1st-of-month→today; all UTC, day granularity). dailyActive=distinct users active that day; monthlyActive=distinct users active in the trailing 30d ending that day; churned=users in the prior 30d window who dropped out of the current one (approximate). CAVEAT: lastActiveAt stores only each session's most-recent activity, so older days undercount true history — the most recent days are the most accurate. Superseded later by a snapshot read-model.",
    };

    const charts = { activeVsChurned, communitiesGroups };
    await writeCache(cacheKey, charts);
    return charts;
  },

  /**
   * Service-status panel. Pure/sync opossum-derived health, wrapped with a
   * short-lived cache (10s) for consistency with the other sections.
   */
  async getServiceStatus(): Promise<{ serviceStatus: ServiceStatus }> {
    const cached = await readCache<{ serviceStatus: ServiceStatus }>(
      SERVICE_STATUS_CACHE_KEY
    );
    if (cached) return cached;

    const result = { serviceStatus: buildServiceStatus() };
    await writeCache(SERVICE_STATUS_CACHE_KEY, result);
    return result;
  },
};
