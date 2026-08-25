import { prisma } from "../config/prisma.js";
import { AccountStatus } from "../generated/prisma/client.js";

/**
 * Read-only aggregates for the admin dashboard (served live over gRPC).
 *
 * Active-user counts derive from `Session.lastActiveAt`: a user is "active"
 * within a window if they hold a non-revoked session that was active inside it.
 * We count DISTINCT userId so multiple devices don't double-count.
 */
export const adminStatsRepository = {
  /** Total / new-today / banned user counts in a single round-trip. */
  async getUserCounts(): Promise<{
    totalUsers: number;
    newUsersToday: number;
    bannedUsers: number;
  }> {
    // Start of the current UTC day — drives "new users today".
    const now = new Date();
    const startOfUtcDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );

    const [totalUsers, newUsersToday, bannedUsers] = await Promise.all([
      // Every row in the table — active, banned, suspended, deleted included.
      prisma.authUser.count(),
      prisma.authUser.count({ where: { createdAt: { gte: startOfUtcDay } } }),
      prisma.authUser.count({ where: { status: AccountStatus.BANNED } }),
    ]);

    return { totalUsers, newUsersToday, bannedUsers };
  },

  /**
   * Distinct active users (DAU/MAU) by session activity. A user counts if they
   * hold a session with `lastActiveAt >= cutoff AND revokedAt IS NULL`.
   * `groupBy(['userId'])` over the filtered set yields the distinct count.
   */
  async getActiveUserCounts(params: {
    dauWindowHours: number;
    mauWindowDays: number;
  }): Promise<{ dailyActive: number; monthlyActive: number }> {
    const now = Date.now();
    const dauCutoff = new Date(now - params.dauWindowHours * 60 * 60 * 1000);
    const mauCutoff = new Date(
      now - params.mauWindowDays * 24 * 60 * 60 * 1000
    );

    const [dauRows, mauRows] = await Promise.all([
      prisma.session.groupBy({
        by: ["userId"],
        where: { lastActiveAt: { gte: dauCutoff }, revokedAt: null },
      }),
      prisma.session.groupBy({
        by: ["userId"],
        where: { lastActiveAt: { gte: mauCutoff }, revokedAt: null },
      }),
    ]);

    return { dailyActive: dauRows.length, monthlyActive: mauRows.length };
  },

  /**
   * Per-day active/churned series across an inclusive [startDate, endDate] UTC
   * range (DAY granularity). Computed live from `Session.lastActiveAt` — the
   * ONLY activity signal we have (there is no historical activity store).
   *
   * Strategy: ONE query loads every (userId, lastActiveAt) whose timestamp
   * falls in [startDate 00:00 UTC − 60d, endDate 00:00 UTC + 1d), then we bucket
   * in memory per day D (UTC):
   *   - dailyActive(D)   = distinct userId with lastActiveAt ∈ [D, D+1)
   *   - monthlyActive(D) = distinct userId with lastActiveAt ∈ [D+1−30d, D+1)
   *   - churned(D)       = distinct userId active in the PRIOR trailing-30d
   *                        window [D+1−60d, D+1−30d) but NOT in the current
   *                        window [D+1−30d, D+1) — lost monthly-active users.
   *
   * We deliberately IGNORE `revokedAt` here: a session active last week then
   * logged out STILL counts as activity last week.
   *
   * CAVEAT: `lastActiveAt` keeps only each session's MOST-RECENT activity, so
   * older daily points undercount true history; the most recent days are the
   * most accurate. This live series is superseded later by a snapshot
   * read-model. The load is bounded to the last ~(rangeDays + 60) days.
   */
  async getActiveUserSeries(
    startDate: string,
    endDate: string
  ): Promise<
    Array<{
      date: string;
      dailyActive: number;
      monthlyActive: number;
      churned: number;
    }>
  > {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    // Parse YYYY-MM-DD as a UTC midnight Date.
    const utcMidnight = (ymd: string): Date => {
      const [y, m, d] = ymd.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d));
    };
    const toYmd = (d: Date): string => d.toISOString().slice(0, 10);

    const startDay = utcMidnight(startDate);
    const endDay = utcMidnight(endDate);

    // Today (UTC midnight). Days AFTER today have no data yet — we emit a bucket
    // of zeros for them (e.g. the remaining days of the current month) rather
    // than letting trailing-window metrics bleed real activity into the future.
    const nowDate = new Date();
    const todayMs = Date.UTC(
      nowDate.getUTCFullYear(),
      nowDate.getUTCMonth(),
      nowDate.getUTCDate()
    );

    // Lower bound: start − 60d (earliest window any bucket reads). Upper bound:
    // endDate + 1 day (exclusive, covers the last day's [D, D+1) windows).
    const lowerBound = new Date(startDay.getTime() - 60 * MS_PER_DAY);
    const upperBound = new Date(endDay.getTime() + MS_PER_DAY);

    // ONE round-trip. At scale this moves to a daily snapshot read-model.
    const rows = await prisma.session.findMany({
      select: { userId: true, lastActiveAt: true },
      // gte/lt already exclude NULL lastActiveAt rows (NULL fails comparison).
      where: {
        lastActiveAt: { gte: lowerBound, lt: upperBound },
      },
    });

    // Materialize as [userId, ms] pairs once for fast in-memory windowing.
    const activity = rows
      .filter((r) => r.lastActiveAt != null)
      .map((r) => ({
        userId: r.userId,
        t: (r.lastActiveAt as Date).getTime(),
      }));

    const distinctInWindow = (lo: number, hi: number): Set<string> => {
      const set = new Set<string>();
      for (const a of activity) {
        if (a.t >= lo && a.t < hi) set.add(a.userId);
      }
      return set;
    };

    const series: Array<{
      date: string;
      dailyActive: number;
      monthlyActive: number;
      churned: number;
    }> = [];

    for (
      let day = startDay.getTime();
      day <= endDay.getTime();
      day += MS_PER_DAY
    ) {
      // Future day → no data exists; emit zeros for that calendar day.
      if (day > todayMs) {
        series.push({
          date: toYmd(new Date(day)),
          dailyActive: 0,
          monthlyActive: 0,
          churned: 0,
        });
        continue;
      }

      const dStart = day;
      const dEnd = day + MS_PER_DAY; // [D, D+1)

      const monthStart = dEnd - 30 * MS_PER_DAY; // [D+1−30d, D+1)
      const priorStart = dEnd - 60 * MS_PER_DAY; // [D+1−60d, D+1−30d)

      const dailySet = distinctInWindow(dStart, dEnd);
      const monthlySet = distinctInWindow(monthStart, dEnd);
      const priorSet = distinctInWindow(priorStart, monthStart);

      // churned = in prior window but NOT in current monthly window.
      let churned = 0;
      for (const u of priorSet) {
        if (!monthlySet.has(u)) churned += 1;
      }

      series.push({
        date: toYmd(new Date(day)),
        dailyActive: dailySet.size,
        monthlyActive: monthlySet.size,
        churned,
      });
    }

    return series;
  },
};
