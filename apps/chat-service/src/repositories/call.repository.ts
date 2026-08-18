import {
  TERMINAL_CALL_STATUSES,
  type CallHistoryFilter,
} from "@aimess/constants";

import type { PrismaClient, Call } from "../generated/prisma/index.js";
import { CallStatus } from "../types/enums.js";

/**
 * "This call never connected", as a MongoDB filter.
 *
 * `answeredAt: null` alone is WRONG here and silently matches nothing. A call
 * that is never answered is written without the field at all, and Prisma's
 * MongoDB connector treats an ABSENT field as distinct from an explicit JSON
 * null — `{ answeredAt: null }` only matches the latter. The read path hides
 * this (a missing field hydrates as `null` on the returned object), so the bug
 * shows up only as an inexplicably empty result set: on live data
 * `answeredAt: null` matched 0 rows where `isSet: false` matched 38.
 */
const NEVER_ANSWERED = {
  OR: [{ answeredAt: null }, { answeredAt: { isSet: false } }],
} as const;

export class CallRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    callId: string;
    callerId: string;
    calleeId: string;
    type: string;
    status: string;
    privateRoomId?: string | null;
    groupId?: string | null;
    calleeIds?: string[];
  }): Promise<Call> {
    return this.prisma.call.create({
      data: {
        callId: data.callId,
        callerId: data.callerId,
        calleeId: data.calleeId,
        type: data.type,
        status: data.status,
        privateRoomId: data.privateRoomId ?? null,
        groupId: data.groupId ?? null,
        calleeIds: data.calleeIds ?? [],
      },
    });
  }

  async findByCallId(callId: string): Promise<Call | null> {
    return this.prisma.call.findUnique({ where: { callId } });
  }

  async updateStatus(
    callId: string,
    update: {
      status: string;
      answeredAt?: Date | null;
      endedAt?: Date | null;
      durationSec?: number | null;
      endedBy?: string | null;
    }
  ): Promise<Call> {
    return this.prisma.call.update({
      where: { callId },
      data: update,
    });
  }

  /**
   * Atomically transition a call only while it is still in the expected state.
   * This prevents answer/decline/end/webhook handlers from racing the ringing
   * timeout (or each other) and resurrecting an already-terminal call.
   */
  async claimStatusTransition(
    callId: string,
    expectedStatus: string,
    update: {
      status: string;
      answeredAt?: Date | null;
      endedAt?: Date | null;
      durationSec?: number | null;
      endedBy?: string | null;
    }
  ): Promise<{ won: boolean }> {
    const result = await this.prisma.call.updateMany({
      where: { callId, status: expectedStatus },
      data: update,
    });
    return { won: result.count === 1 };
  }

  /**
   * Sweep helpers for the ringing-timeout worker. Multi-node safe:
   * `claimForMissed` uses an atomic `updateMany` with a `status: RINGING`
   * filter — whichever node's write lands first wins (`count === 1`); the
   * other's filter no longer matches and returns `count === 0`. No locks.
   */
  async findStuckRinging(cutoff: Date, limit: number): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: { status: "RINGING", initiatedAt: { lt: cutoff } },
      take: limit,
    });
  }

  /**
   * IN_PROGRESS rows past the max-duration ceiling, plus rows with a null
   * `answeredAt` (already inconsistent). Both are unreachable by any normal end
   * path once the client is gone, so they must be swept or the participants stay
   * permanently busy.
   * Sweep candidates for calls stranded in IN_PROGRESS: answered longer ago
   * than any plausible call could run. These are rows whose LiveKit room has
   * already closed but whose `room_finished` webhook never landed — without
   * this they stay IN_PROGRESS forever and keep the participants "busy".
   * Keyed on `answeredAt` (when the call actually started), not `initiatedAt`.
   */
  async findStuckInProgress(cutoff: Date, limit: number): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: {
        status: CallStatus.IN_PROGRESS,
        answeredAt: { lt: cutoff },
      },
      take: limit,
    });
  }

  async claimForMissed(callId: string, now: Date): Promise<{ won: boolean }> {
    const result = await this.prisma.call.updateMany({
      where: { callId, status: "RINGING" },
      data: { status: "MISSED", endedAt: now, endedBy: "SYSTEM" },
    });
    return { won: result.count === 1 };
  }

  async findByParticipant(
    userId: string,
    limit: number,
    cursor?: string | null
  ): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: {
        OR: [
          { callerId: userId },
          { calleeId: userId },
          { calleeIds: { has: userId } },
        ],
        ...(cursor ? { initiatedAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { initiatedAt: "desc" },
      take: limit,
    });
  }

  /**
   * One page of SETTLED 1:1 call rows for the Call History list, newest first.
   *
   * Scope, and why each exclusion is here rather than in the service:
   *  - `groupId: null` — group calls have no single peer to key a history row
   *    on, and they are already excluded from every other call-history surface
   *    (a group call is never projected into the Notification Center either).
   *    The raw `GET /api/chat/calls` feed still returns them, unchanged.
   *  - terminal statuses only — a RINGING / IN_PROGRESS row has no outcome yet,
   *    and the list has no way to transition a row it already rendered.
   *
   * `missed` is expressed as "rung me and never connected" — `answeredAt: null`
   * on an inbound settled row. That is ONE predicate covering all four ways a
   * call fails to connect (timed out, caller hung up first, declined, failed),
   * which is exactly what `resolveCallResult` collapses them to. Enumerating the
   * statuses instead would be a second copy of that rule, free to drift from it.
   *
   * Served by the existing `[callerId, initiatedAt desc]` / `[calleeId,
   * initiatedAt desc]` indexes — the participant equality picks the index and
   * `initiatedAt` gives both the cursor bound and the sort, so no new index is
   * required for these predicates.
   */
  async findHistoryPage(params: {
    userId: string;
    filter: CallHistoryFilter;
    before?: Date | null;
    take: number;
  }): Promise<Call[]> {
    const { userId, filter } = params;
    const asCaller = { callerId: userId };
    const asCallee = { calleeId: userId };

    const participant =
      filter === "outgoing"
        ? asCaller
        : filter === "incoming" || filter === "missed"
          ? asCallee
          : { OR: [asCaller, asCallee] };

    // `AND`-wrapped, not spread: the `all` participant clause already owns the
    // top-level `OR`, and a second one would overwrite it.
    const outcome = {
      status: { in: [...TERMINAL_CALL_STATUSES] },
      ...(filter === "missed" ? { AND: [NEVER_ANSWERED] } : {}),
    };

    return this.prisma.call.findMany({
      where: {
        groupId: null,
        ...participant,
        ...outcome,
        ...(params.before ? { initiatedAt: { lt: params.before } } : {}),
      },
      orderBy: { initiatedAt: "desc" },
      take: params.take,
    });
  }

  /**
   * Group busy-gate: is there already a genuinely active (RINGING within the
   * fresh window, or IN_PROGRESS within the live window) call for this group?
   * MVP policy — one call per group at a time, no per-member roster overlap
   * checking (unlike 1:1's full N-way busy/glare handling).
   */
  async findActiveByGroup(
    groupId: string,
    freshCutoff: Date,
    liveCutoff: Date
  ): Promise<Call | null> {
    return this.prisma.call.findFirst({
      where: { groupId, AND: [this.activeWhere(freshCutoff, liveCutoff)] },
    });
  }

  /**
   * "Genuinely active right now" — the shared busy predicate.
   *
   * BOTH states are time-bounded, and both bounds exist for the same reason: a
   * client that dies without signalling must never leave a row that blocks
   * calling forever.
   *  - RINGING  → `initiatedAt >= freshCutoff` (crashed ring, sweep will MISS it)
   *  - IN_PROGRESS → `answeredAt >= liveCutoff` (crashed/force-killed call; only
   *    an explicit `call:end` or the LiveKit `room_finished` webhook ends one
   *    normally, and neither fires if the app died or the webhook is unreachable)
   * An IN_PROGRESS row with a null `answeredAt` is already inconsistent, so it
   * is deliberately excluded here and swept below.
   */
  private activeWhere(freshCutoff: Date, liveCutoff: Date) {
    return {
      OR: [
        { status: CallStatus.IN_PROGRESS, answeredAt: { gte: liveCutoff } },
        { status: CallStatus.RINGING, initiatedAt: { gte: freshCutoff } },
      ],
    };
  }

  /** Every active call touching any of `userIds`. */
  async findActiveByParticipant(
    userIds: string[],
    freshCutoff: Date,
    liveCutoff: Date
  ): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: {
        OR: [{ callerId: { in: userIds } }, { calleeId: { in: userIds } }],
        AND: [this.activeWhere(freshCutoff, liveCutoff)],
      },
    });
  }

  /**
   * Glare backstop: find an active call between exactly this pair (either
   * direction) other than `excludeCallId`. Same freshness rule as
   * `findActiveByParticipant`.
   */
  async findActiveBetween(
    userA: string,
    userB: string,
    excludeCallId: string,
    freshCutoff: Date,
    liveCutoff: Date
  ): Promise<Call | null> {
    return this.prisma.call.findFirst({
      where: {
        callId: { not: excludeCallId },
        OR: [
          { callerId: userA, calleeId: userB },
          { callerId: userB, calleeId: userA },
        ],
        AND: [this.activeWhere(freshCutoff, liveCutoff)],
      },
    });
  }

  /**
   * Every active call between exactly this pair, either direction. Same
   * freshness rule as `findActiveBetween`, which answers the glare question for
   * a single row; this one is for tearing the pair's calls down wholesale
   * (a block, or an unfriend).
   *
   * Must be exhaustive, unlike `findActiveBetween`: glare can legitimately
   * leave one ring alive in each direction at once. GROUP calls can never
   * match — their rows carry `calleeId: ""` and are authorized by membership,
   * not by the pair relationship.
   */
  async findAllActiveBetween(
    userA: string,
    userB: string,
    freshCutoff: Date,
    liveCutoff: Date
  ): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: {
        OR: [
          { callerId: userA, calleeId: userB },
          { callerId: userB, calleeId: userA },
        ],
        AND: [this.activeWhere(freshCutoff, liveCutoff)],
      },
    });
  }

  /**
   * GROUP calls only: atomically drop one rung member from the roster (they
   * declined, or left before answering). Non-atomic read-then-write is an
   * acceptable MVP gap — a lost concurrent decline just leaves that id in the
   * roster one extra read, never duplicates or corrupts it.
   */
  async removeGroupCallee(
    callId: string,
    userId: string
  ): Promise<Call | null> {
    const call = await this.prisma.call.findUnique({ where: { callId } });
    if (!call) return null;
    const calleeIds = call.calleeIds.filter((id) => id !== userId);
    return this.prisma.call.update({ where: { callId }, data: { calleeIds } });
  }

  /**
   * The caller's own outbound rings. Starting a new outgoing call implies the
   * caller abandoned any prior one, so the service cancels these first (both to
   * avoid falsely marking the caller busy on their own zombie call and to stop
   * the old callee's ring immediately).
   *
   * `before` bounds the result to rings that predate the request doing the
   * cleanup. Unbounded, two concurrent initiates from the same caller cancel each
   * other's just-created rows, leaving a call that rings the callee while already
   * ENDED in the DB. Callers hold a per-caller lock as the primary defence; this
   * bound is the backstop for a lost or early-expired lock.
   */
  async findCallerRinging(callerId: string, before: Date): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: {
        callerId,
        status: CallStatus.RINGING,
        initiatedAt: { lt: before },
      },
    });
  }
}
