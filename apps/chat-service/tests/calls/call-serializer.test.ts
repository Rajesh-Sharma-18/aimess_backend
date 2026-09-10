/**
 * `toCallDTO` — what `GET /calls` and `GET /calls/:callId` are allowed to say.
 *
 * Both endpoints used to return the Prisma row verbatim, i.e. all sixteen
 * stored columns. Three of them should never have left the service, and the
 * third is the one that matters:
 *
 *   - `id`, the raw Mongo ObjectId.
 *   - `calleeIds`, a GROUP call's whole ring roster — a member who was rung
 *     could read the user id of everyone else rung, declines included.
 *   - `endedBy`, holding either a user id or an internal sentinel.
 *     `SYSTEM_FRIENDSHIP` told a client the SERVER ended the call because the
 *     relationship did, which separates a block-driven teardown from an
 *     ordinary hangup. Blocking is silent on every other surface by design.
 *
 * The `endedReason` cases below are the load-bearing half: they are what stops
 * a future edit from reintroducing the leak by matching sentinels with an
 * equality list.
 */
import { toCallDTO } from "../../src/lib/call.serializer.js";
import type { Call } from "../../src/generated/prisma/index.js";

const INITIATED = new Date(1_700_000_000_000);

/** A complete row, as Prisma would hand one back. */
function row(over: Partial<Call> = {}): Call {
  return {
    id: "68c0ffee0000000000000001",
    callId: "call-1",
    callerId: "u1",
    calleeId: "u2",
    type: "AUDIO",
    status: "ENDED",
    privateRoomId: "room-1",
    groupId: null,
    calleeIds: [],
    initiatedAt: INITIATED,
    answeredAt: new Date(INITIATED.getTime() + 5_000),
    endedAt: new Date(INITIATED.getTime() + 65_000),
    durationSec: 60,
    endedBy: "u1",
    createdAt: INITIATED,
    updatedAt: INITIATED,
    ...over,
  } as Call;
}

describe("toCallDTO — withheld fields", () => {
  it("never emits the internal columns, whatever the row holds", async () => {
    const dto = toCallDTO(
      row({
        groupId: "g1",
        calleeIds: ["u2", "u3", "u4"],
        endedBy: "SYSTEM_FRIENDSHIP",
      })
    );

    for (const leaked of [
      "id",
      "groupId",
      "calleeIds",
      "createdAt",
      "updatedAt",
      "endedBy",
    ]) {
      expect(dto).not.toHaveProperty(leaked);
    }
    // Asserted on the serialized form too — a field can only leak if it is
    // reachable from the JSON the route actually writes.
    expect(JSON.stringify(dto)).not.toContain("SYSTEM_FRIENDSHIP");
    expect(JSON.stringify(dto)).not.toContain("u3");
  });

  it("keeps the fields a client legitimately reads", () => {
    const dto = toCallDTO(row());

    expect(dto).toEqual({
      callId: "call-1",
      type: "AUDIO",
      status: "ENDED",
      callerId: "u1",
      calleeId: "u2",
      privateRoomId: "room-1",
      initiatedAt: INITIATED,
      answeredAt: new Date(INITIATED.getTime() + 5_000),
      endedAt: new Date(INITIATED.getTime() + 65_000),
      durationSec: 60,
      endedReason: "USER",
    });
  });
});

describe("toCallDTO — endedReason", () => {
  // Every value this codebase actually writes to `endedBy`. Note the bare
  // "SYSTEM" from claimForMissed: an equality check against only the three
  // SYSTEM_* sentinels would miss it and emit it as though it were a user id,
  // which is precisely the leak being closed. Prefix matching over-matches
  // toward SYSTEM, which is the safe direction.
  it.each([
    ["SYSTEM", "SYSTEM"],
    ["SYSTEM_FRIENDSHIP", "SYSTEM"],
    ["SYSTEM_LIVEKIT", "SYSTEM"],
    ["SYSTEM_TIMEOUT", "SYSTEM"],
    ["68c0ffee0000000000000009", "USER"],
    ["u1", "USER"],
  ])("maps endedBy %s to %s", (endedBy, expected) => {
    expect(toCallDTO(row({ endedBy })).endedReason).toBe(expected);
  });

  it("is null while the call is still live", () => {
    expect(
      toCallDTO(row({ status: "RINGING", endedBy: null })).endedReason
    ).toBeNull();
    expect(toCallDTO(row({ endedBy: "" })).endedReason).toBeNull();
  });
});

describe("toCallDTO — partial rows", () => {
  it("survives a row missing the optional columns", () => {
    // The REST tests in calls.test.ts feed exactly this: hand-built fixtures
    // carrying only { callId, callerId, calleeId, status, initiatedAt }. A
    // mapper that dereferenced `calleeIds.length` or `createdAt.getTime()`
    // would throw here and turn a 200 into a 500.
    const partial = {
      callId: "c1",
      callerId: "u1",
      calleeId: "u2",
      status: "RINGING",
      initiatedAt: INITIATED,
    } as unknown as Call;

    expect(() => toCallDTO(partial)).not.toThrow();
    const dto = toCallDTO(partial);
    expect(dto.callId).toBe("c1");
    expect(dto.answeredAt).toBeNull();
    expect(dto.endedAt).toBeNull();
    expect(dto.durationSec).toBeNull();
    expect(dto.privateRoomId).toBeNull();
    expect(dto.endedReason).toBeNull();
  });
});
