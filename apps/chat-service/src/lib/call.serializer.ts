import type { Call } from "../generated/prisma/index.js";

/**
 * Client-facing shape of a call, for `GET /calls` and `GET /calls/:callId`.
 *
 * Both endpoints used to hand back the Prisma row verbatim, which shipped all
 * sixteen stored columns to whoever asked. Three of them should never have left
 * the service:
 *
 *  - `id`, the raw Mongo ObjectId, an internal handle with no client meaning.
 *  - `calleeIds`, a group call's full ring roster. A member who was rung could
 *    read the user id of everyone else rung, including people who declined and
 *    were dropped from the live roster — a membership disclosure the group UI
 *    does not otherwise grant.
 *  - `endedBy`, which carries either a user id or one of the `SYSTEM_*`
 *    sentinels. `SYSTEM_FRIENDSHIP` in particular tells a client that the
 *    SERVER ended the call because the relationship did, which distinguishes a
 *    block-driven teardown from an ordinary hangup. Blocking is deliberately
 *    silent everywhere else — friendship.consumer.ts posts no system message
 *    precisely so the blocked party is never told — and this leaked it.
 *
 * `groupId`, `createdAt` and `updatedAt` are dropped as well: nothing consumes
 * them and every field kept is a field that has to stay compatible.
 *
 * Dates stay as `Date` here. `ApiResponse.toJSON` deep-converts every Date to
 * epoch ms on the way out, so the wire format of the surviving fields is
 * byte-identical to what clients already parse.
 */
export interface CallDTO {
  callId: string;
  type: string;
  status: string;
  callerId: string;
  calleeId: string;
  privateRoomId: string | null;
  initiatedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSec: number | null;
  /**
   * Who ended the call, coarsened to the only distinction a client needs.
   * `null` while the call is still live — a RINGING or IN_PROGRESS row has no
   * `endedBy` yet.
   */
  endedReason: "USER" | "SYSTEM" | null;
}

/**
 * `SYSTEM` for every server-driven settle, `USER` for a participant hanging up.
 *
 * Matched by PREFIX rather than against a list of the known sentinels, because
 * there are four of them and they do not share a suffix: `SYSTEM_FRIENDSHIP`,
 * `SYSTEM_LIVEKIT`, `SYSTEM_TIMEOUT`, and a bare `SYSTEM` written by
 * `claimForMissed`. An equality list that forgot the bare one would fall
 * through and emit it as if it were a user id, which is the exact leak this
 * exists to close — so the safe direction is to over-match `SYSTEM`, never to
 * under-match it.
 */
function endedReasonOf(endedBy: string | null | undefined): CallDTO["endedReason"] {
  if (endedBy == null || endedBy === "") return null;
  return endedBy.startsWith("SYSTEM") ? "SYSTEM" : "USER";
}

/**
 * Map one stored call to its client shape.
 *
 * Deliberately tolerant of a partial row: it reads only the fields the DTO
 * exposes and never dereferences one, so a caller holding an incomplete `Call`
 * (a projection, a legacy document written before a column existed, a test
 * fixture) gets nulls rather than a thrown TypeError turning a 200 into a 500.
 */
export function toCallDTO(call: Call): CallDTO {
  return {
    callId: call.callId,
    type: call.type,
    status: call.status,
    callerId: call.callerId,
    calleeId: call.calleeId,
    privateRoomId: call.privateRoomId ?? null,
    initiatedAt: call.initiatedAt ?? null,
    answeredAt: call.answeredAt ?? null,
    endedAt: call.endedAt ?? null,
    durationSec: call.durationSec ?? null,
    endedReason: endedReasonOf(call.endedBy),
  };
}
