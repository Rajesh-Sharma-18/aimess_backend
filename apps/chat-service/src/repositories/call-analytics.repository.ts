import type { Prisma, PrismaClient } from "../generated/prisma/index.js";
import { env } from "../config/env.js";
import { CallStatus, CallType } from "../types/enums.js";

/**
 * Read-only aggregates over the `calls` collection, served live to the admin
 * panel over gRPC (backoffice-service has no direct access to this database).
 *
 * Everything the analytics endpoint needs is computed in ONE `aggregateRaw`
 * `$facet` round-trip rather than a query per metric — the facets all scan the
 * same `initiatedAt` range, so re-scanning it six times would be pure waste.
 */

export interface CallHourBucket {
  hour: number;
  count: number;
}

export interface CallAnalytics {
  totalCalls: number;
  audioCalls: number;
  videoCalls: number;
  answeredCalls: number;
  missedCalls: number;
  declinedCalls: number;
  missedRate: number;
  avgDurationSec: number;
  /** p50 — the honest "typical call length"; prefer this over the mean. */
  medianDurationSec: number;
  /** p90 — how long the longer calls actually run. */
  p90DurationSec: number;
  totalDurationSec: number;
  peakHours: CallHourBucket[];
  connectionSuccessRate: number;
}

/** `$facet` returns one single-element array per facet; unwrap defensively. */
interface FacetCount {
  _id?: unknown;
  count?: number;
}
interface FacetDuration {
  count?: number;
  avg?: number | null;
  total?: number | null;
  /** [p50, p90] from `$percentile`. */
  pct?: Array<number | null> | null;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Sum `count` across facet rows whose `_id` matches `match`. */
function sumWhere(rows: FacetCount[], match: (id: unknown) => boolean): number {
  return rows.reduce((acc, r) => (match(r._id) ? acc + num(r.count) : acc), 0);
}

/** Ratio guarded against divide-by-zero, rounded to 4dp. */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

export class CallAnalyticsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Aggregate call stats over an inclusive [from, to] window. Both bounds are
   * optional — omitting them reports over all time.
   */
  async getAnalytics(params: {
    from?: Date | null;
    to?: Date | null;
  }): Promise<CallAnalytics> {
    const range: Record<string, unknown> = {};
    if (params.from) range["$gte"] = { $date: params.from.toISOString() };
    if (params.to) range["$lte"] = { $date: params.to.toISOString() };
    const match = Object.keys(range).length > 0 ? { initiatedAt: range } : {};

    const raw = (await this.prisma.call.aggregateRaw({
      pipeline: [
        { $match: match },
        {
          $facet: {
            // One row per call type → AUDIO/VIDEO split + overall total.
            byType: [{ $group: { _id: "$type", count: { $sum: 1 } } }],
            // One row per status → answered / missed / declined.
            byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
            // Only calls that actually carried media count toward duration.
            //
            // The mean alone is a trap here: a single call left IN_PROGRESS
            // until something finally closed it (crashed client, late LiveKit
            // room_finished) contributes days of "duration" and drags the
            // average orders of magnitude away from reality. Real example from
            // this dataset: median 19s, mean 4680s. So we also emit p50/p90,
            // which is what an admin should actually read.
            duration: [
              { $match: { durationSec: { $gt: 0 } } },
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  avg: { $avg: "$durationSec" },
                  total: { $sum: "$durationSec" },
                  pct: {
                    $percentile: {
                      input: "$durationSec",
                      p: [0.5, 0.9],
                      method: "approximate",
                    },
                  },
                },
              },
            ],
            // Calls that were picked up, regardless of whether media flowed —
            // the denominator for connectionSuccessRate.
            answered: [
              { $match: { answeredAt: { $ne: null } } },
              { $group: { _id: null, count: { $sum: 1 } } },
            ],
            // Picked up AND produced media — the numerator.
            answeredWithMedia: [
              {
                $match: { answeredAt: { $ne: null }, durationSec: { $gt: 0 } },
              },
              { $group: { _id: null, count: { $sum: 1 } } },
            ],
            peakHours: [
              {
                $group: {
                  _id: { $hour: "$initiatedAt" },
                  count: { $sum: 1 },
                },
              },
            ],
          },
        },
      ] as unknown as Prisma.InputJsonValue[],
    })) as unknown as Array<{
      byType?: FacetCount[];
      byStatus?: FacetCount[];
      duration?: FacetDuration[];
      answered?: FacetCount[];
      answeredWithMedia?: FacetCount[];
      peakHours?: FacetCount[];
    }>;

    const f = raw[0] ?? {};
    const byType = f.byType ?? [];
    const byStatus = f.byStatus ?? [];
    const duration = f.duration?.[0] ?? {};

    const totalCalls = byType.reduce((acc, r) => acc + num(r.count), 0);
    const audioCalls = sumWhere(byType, (id) => id === CallType.AUDIO);
    const videoCalls = sumWhere(byType, (id) => id === CallType.VIDEO);

    // "Answered" is derived from answeredAt, not status: a call that was picked
    // up and later ENDED is still an answered call.
    const answeredCalls = num(f.answered?.[0]?.count);
    const answeredWithMedia = num(f.answeredWithMedia?.[0]?.count);
    const missedCalls = sumWhere(byStatus, (id) => id === CallStatus.MISSED);
    const declinedCalls = sumWhere(
      byStatus,
      (id) => id === CallStatus.DECLINED
    );

    // Always emit all 24 buckets so the chart has a stable x-axis.
    const hourCounts = new Map<number, number>();
    for (const r of f.peakHours ?? []) {
      hourCounts.set(num(r._id), num(r.count));
    }
    const peakHours: CallHourBucket[] = Array.from(
      { length: 24 },
      (_, hour) => ({
        hour,
        count: hourCounts.get(hour) ?? 0,
      })
    );

    return {
      totalCalls,
      audioCalls,
      videoCalls,
      answeredCalls,
      missedCalls,
      declinedCalls,
      missedRate: ratio(missedCalls, totalCalls),
      avgDurationSec: Math.round(num(duration.avg) * 10) / 10,
      medianDurationSec: Math.round(num(duration.pct?.[0])),
      p90DurationSec: Math.round(num(duration.pct?.[1])),
      totalDurationSec: num(duration.total),
      peakHours,
      connectionSuccessRate: ratio(answeredWithMedia, answeredCalls),
    };
  }

  /**
   * Live call-service health counters. Deliberately two cheap `count`s — this
   * doubles as the backoffice health-probe ping, so it must stay fast enough to
   * run every few seconds inside a 2s probe budget.
   *
   * "Ringing" is bounded by the same ringing-timeout window the busy gate uses,
   * so abandoned rows awaiting the sweep aren't reported as live activity.
   */
  async getHealth(): Promise<{
    activeCalls: number;
    ringingCalls: number;
  }> {
    const freshCutoff = new Date(
      Date.now() - env.CALL_RINGING_TIMEOUT_SEC * 1000
    );
    const [activeCalls, ringingCalls] = await Promise.all([
      this.prisma.call.count({ where: { status: CallStatus.IN_PROGRESS } }),
      this.prisma.call.count({
        where: {
          status: CallStatus.RINGING,
          initiatedAt: { gte: freshCutoff },
        },
      }),
    ]);
    return { activeCalls, ringingCalls };
  }
}
