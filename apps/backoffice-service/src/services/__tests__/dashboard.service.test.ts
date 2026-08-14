/**
 * Unit tests for {@link dashboardService.getOverview}'s stat-card wiring — the
 * regression guard for the three cards that used to be hardcoded `0` stubs
 * (totalLivestreams / openReports / churnedUsers) and for `bannedUsers`, which
 * used to read auth-service's always-0 `AccountStatus.BANNED` count instead of
 * the `UserIndex` mirror that actually persists bans.
 *
 * Everything is monkey-patched at runtime (the service imports the singletons
 * directly), so this is fully offline: no gRPC, no Postgres, no Redis.
 *
 * Run via `tsx --test src/services/__tests__/dashboard.service.test.ts`.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma } from "../../config/prisma.js";
import { redis } from "../../config/redis.js";
import { authClient } from "../../grpc/auth.client.js";
import { chatClient } from "../../grpc/chat.client.js";
import { communityClient } from "../../grpc/community.client.js";
import { streamClient } from "../../grpc/stream.client.js";
import { dashboardService } from "../dashboard.service.js";

// Redis: always a cache MISS, and swallow the write — otherwise the first case
// would poison every later one through the 10s overview cache.
redis.get = (() => Promise.resolve(null)) as typeof redis.get;
redis.set = (() => Promise.resolve("OK")) as typeof redis.set;

/** The `where` each count was called with, captured for assertion. */
let reportCountWhere: unknown;
let userIndexCountWhere: unknown;

function stubHappyPath(): void {
  reportCountWhere = undefined;
  userIndexCountWhere = undefined;

  prisma.report.count = ((args: { where: unknown }) => {
    reportCountWhere = args.where;
    return Promise.resolve(7);
  }) as typeof prisma.report.count;

  prisma.userIndex.count = ((args: { where: unknown }) => {
    userIndexCountWhere = args.where;
    return Promise.resolve(3);
  }) as typeof prisma.userIndex.count;

  authClient.getUserCounts = (() =>
    Promise.resolve({
      totalUsers: 35,
      newUsersToday: 0,
      // Always 0 in reality — the dashboard must NOT read this field.
      bannedUsers: 0,
    })) as typeof authClient.getUserCounts;

  authClient.getActiveUserCounts = (() =>
    Promise.resolve({
      dailyActive: 15,
      monthlyActive: 30,
    })) as typeof authClient.getActiveUserCounts;

  authClient.getActiveUserSeries = (() =>
    Promise.resolve([
      { bucket: "2026-08-14", dailyActive: 15, monthlyActive: 30, churned: 4 },
    ])) as typeof authClient.getActiveUserSeries;

  communityClient.getCommunityCount = (() =>
    Promise.resolve(13)) as typeof communityClient.getCommunityCount;

  chatClient.getGroupCount = (() =>
    Promise.resolve(7)) as typeof chatClient.getGroupCount;

  streamClient.adminListStreams = (() =>
    Promise.resolve({
      streams: [],
      total: 149,
    })) as typeof streamClient.adminListStreams;
}

describe("dashboardService.getOverview", () => {
  beforeEach(stubHappyPath);

  it("maps every stat card to its own source (no stubbed zeros)", async () => {
    const { stats } = await dashboardService.getOverview();

    assert.deepEqual(stats, {
      totalUsers: 35,
      newUsersToday: 0,
      dailyActiveUsers: 15,
      monthlyActiveUsers: 30,
      totalCommunities: 13,
      totalGroups: 7,
      // The Livestream list's own total — not the LivestreamIndex mirror.
      totalLivestreams: 149,
      openReports: 7,
      // The UserIndex mirror — NOT auth-service's bannedUsers (0 above).
      bannedUsers: 3,
      churnedUsers: 4,
    });
  });

  it("counts livestreams with no filters, so paging can't shrink the total", async () => {
    let seen: Record<string, unknown> | undefined;
    streamClient.adminListStreams = ((args: Record<string, unknown>) => {
      seen = args;
      return Promise.resolve({ streams: [], total: 149 });
    }) as typeof streamClient.adminListStreams;

    await dashboardService.getOverview();

    // Only pagination args — every filter (status/date/community/creator) unset.
    assert.deepEqual(seen, { page: 1, limit: 1 });
  });

  it("counts only non-terminal reports as open", async () => {
    await dashboardService.getOverview();

    const notIn = (reportCountWhere as { status: { notIn: string[] } }).status
      .notIn;
    assert.deepEqual([...notIn].sort(), ["dismissed", "resolved"]);
  });

  it("counts BANNED and SUSPENDED mirror rows as banned", async () => {
    await dashboardService.getOverview();

    const inList = (userIndexCountWhere as { status: { in: string[] } }).status
      .in;
    assert.deepEqual([...inList].sort(), ["BANNED", "SUSPENDED"]);
  });

  it("falls back to 0 per-field when an upstream rejects, never throwing", async () => {
    streamClient.adminListStreams = (() =>
      Promise.reject(
        new Error("stream unavailable")
      )) as typeof streamClient.adminListStreams;
    prisma.report.count = (() =>
      Promise.reject(new Error("db down"))) as typeof prisma.report.count;

    const { stats } = await dashboardService.getOverview();

    assert.equal(stats.totalLivestreams, 0);
    assert.equal(stats.openReports, 0);
    // Unaffected sources still report real numbers.
    assert.equal(stats.bannedUsers, 3);
    assert.equal(stats.totalUsers, 35);
  });
});
