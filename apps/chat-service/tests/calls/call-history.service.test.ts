/**
 * Call History aggregation — the WhatsApp-style Calls list.
 *
 * Two things are being pinned here, and they are the two the UI cannot recover
 * from if they are wrong:
 *  1. the normalization (direction/result) is derived from the CALL RECORD and
 *     the viewer, never from a label, so the same row reads oppositely to the
 *     two participants;
 *  2. only CONSECUTIVE identical attempts collapse, and a group is never split
 *     across a page boundary.
 */
import {
  resolveCallDirection,
  resolveCallResult,
  resolveCallTimelineStatus,
  matchesCallHistoryFilter,
  type CallHistoryFilter,
} from "@aimess/constants";

import {
  CallHistoryService,
  type CallHistoryContact,
} from "../../src/services/call-history.service.js";

const ME = "me";
const MOHIT = "mohit";
const RAJESH = "rajesh";

let clock = Date.parse("2026-08-18T10:00:00.000Z");

/**
 * Build a call row. `at` counts DOWN so rows created earlier in a fixture are
 * newer, matching the newest-first order the repository returns.
 */
function call(params: {
  callId: string;
  from: string;
  to: string;
  status: string;
  type?: string;
  answered?: boolean;
  /** Ring length in seconds — only read for a CANCELLED (unanswered ENDED) row. */
  ringSec?: number;
  at?: number;
}): Record<string, unknown> {
  const initiatedAt = new Date(params.at ?? (clock -= 60_000));
  const ringSec = params.ringSec ?? 30;
  return {
    callId: params.callId,
    callerId: params.from,
    calleeId: params.to,
    type: params.type ?? "AUDIO",
    status: params.status,
    privateRoomId: "room-1",
    groupId: null,
    calleeIds: [],
    initiatedAt,
    answeredAt: params.answered ? new Date(initiatedAt.getTime() + 2000) : null,
    endedAt: new Date(initiatedAt.getTime() + ringSec * 1000),
    durationSec: params.answered ? 42 : 0,
    endedBy: null,
  };
}

/**
 * Stub repository that applies the same coarse selection the real Prisma query
 * does (participant + terminal status + `lt` cursor + newest-first), so the
 * pagination assertions below exercise the real cursor contract.
 */
function repoOf(rows: Record<string, unknown>[]) {
  const sorted = [...rows].sort(
    (a, b) =>
      (b.initiatedAt as Date).getTime() - (a.initiatedAt as Date).getTime()
  );
  return {
    findHistoryPage: jest.fn(
      async (params: {
        userId: string;
        filter: CallHistoryFilter;
        before?: Date | null;
        take: number;
      }) => {
        const matches = sorted.filter((row) => {
          if (params.before && (row.initiatedAt as Date) >= params.before) {
            return false;
          }
          const isCaller = row.callerId === params.userId;
          const isCallee = row.calleeId === params.userId;
          if (params.filter === "outgoing" && !isCaller) return false;
          if (
            (params.filter === "incoming" || params.filter === "missed") &&
            !isCallee
          ) {
            return false;
          }
          if (!isCaller && !isCallee) return false;
          if (
            !["ENDED", "MISSED", "DECLINED", "FAILED"].includes(
              row.status as string
            )
          ) {
            return false;
          }
          // Missed == inbound and never connected, whichever way it ended.
          return params.filter === "missed" ? row.answeredAt === null : true;
        });
        return matches.slice(0, params.take);
      }
    ),
  };
}

const contacts = async (ids: string[]) =>
  new Map<string, CallHistoryContact>(
    ids.map((id) => [
      id,
      { id, name: `name:${id}`, avatarUrl: `avatar:${id}`, isDeleted: false },
    ])
  );

const serviceOf = (rows: Record<string, unknown>[]) =>
  new CallHistoryService(repoOf(rows) as never, contacts as never);

beforeEach(() => {
  clock = Date.parse("2026-08-18T10:00:00.000Z");
});

describe("call history normalization", () => {
  it("derives direction from the record's participants, not from any label", () => {
    const row = call({ callId: "c1", from: MOHIT, to: ME, status: "MISSED" });
    expect(resolveCallDirection(row as never, ME)).toBe("INCOMING");
    expect(resolveCallDirection(row as never, MOHIT)).toBe("OUTGOING");
  });

  it("reads an unanswered ENDED row as CANCELLED without changing the DB status", () => {
    const cancelled = call({
      callId: "c1",
      from: ME,
      to: MOHIT,
      status: "ENDED",
    });
    const answered = call({
      callId: "c2",
      from: ME,
      to: MOHIT,
      status: "ENDED",
      answered: true,
    });
    expect(resolveCallTimelineStatus(cancelled as never)).toBe("CANCELLED");
    expect(resolveCallTimelineStatus(answered as never)).toBe("ENDED");
    expect(cancelled.status).toBe("ENDED");
  });

  it("collapses every non-connected outcome to one viewer-relative pair", () => {
    // Which side hung up first is lifecycle bookkeeping, not something either
    // participant experienced: the callee missed it, the caller got no answer.
    for (const status of [
      "MISSED",
      "CANCELLED",
      "DECLINED",
      "FAILED",
    ] as const) {
      expect(resolveCallResult(status, "INCOMING")).toBe("MISSED");
      expect(resolveCallResult(status, "OUTGOING")).toBe("NO_ANSWER");
    }
    expect(resolveCallResult("ENDED", "INCOMING")).toBe("ANSWERED");
    expect(resolveCallResult("ENDED", "OUTGOING")).toBe("ANSWERED");
  });

  it("keeps the Missed tab to calls the viewer was rung by", () => {
    expect(matchesCallHistoryFilter("missed", "INCOMING", "MISSED")).toBe(true);
    // The viewer's OWN unanswered outgoing calls are not missed calls.
    expect(matchesCallHistoryFilter("missed", "OUTGOING", "NO_ANSWER")).toBe(
      false
    );
    expect(matchesCallHistoryFilter("missed", "INCOMING", "ANSWERED")).toBe(
      false
    );
  });
});

describe("consecutive grouping", () => {
  it("collapses a run of identical attempts into one row with attemptCount", async () => {
    const rows = [
      call({ callId: "a", from: MOHIT, to: ME, status: "MISSED" }),
      call({ callId: "b", from: MOHIT, to: ME, status: "MISSED" }),
      call({ callId: "c", from: MOHIT, to: ME, status: "MISSED" }),
    ];
    const page = await serviceOf(rows).getHistory({
      userId: ME,
      filter: "all",
      limit: 20,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.attemptCount).toBe(3);
    // Newest row wins the id and the displayed timestamp.
    expect(page.items[0]!.latestCallId).toBe("a");
    expect(page.items[0]!.oldestCallId).toBe("c");
    expect(page.items[0]!.lastCallAt).toBeGreaterThan(
      page.items[0]!.firstCallAt
    );
  });

  it("does not merge a run interrupted by another contact", async () => {
    const rows = [
      call({ callId: "a", from: MOHIT, to: ME, status: "MISSED" }),
      call({
        callId: "b",
        from: ME,
        to: RAJESH,
        status: "ENDED",
        answered: true,
      }),
      call({ callId: "c", from: MOHIT, to: ME, status: "MISSED" }),
      call({ callId: "d", from: MOHIT, to: ME, status: "MISSED" }),
    ];
    const page = await serviceOf(rows).getHistory({
      userId: ME,
      filter: "all",
      limit: 20,
    });
    expect(page.items.map((i) => [i.contact.id, i.attemptCount])).toEqual([
      [MOHIT, 1],
      [RAJESH, 1],
      [MOHIT, 2],
    ]);
  });

  it("never merges across direction, call type or outcome", async () => {
    const rows = [
      call({ callId: "a", from: MOHIT, to: ME, status: "MISSED" }),
      call({ callId: "b", from: ME, to: MOHIT, status: "MISSED" }),
      call({
        callId: "c",
        from: ME,
        to: MOHIT,
        status: "MISSED",
        type: "VIDEO",
      }),
      call({
        callId: "d",
        from: ME,
        to: MOHIT,
        status: "ENDED",
        type: "VIDEO",
        answered: true,
      }),
    ];
    const page = await serviceOf(rows).getHistory({
      userId: ME,
      filter: "all",
      limit: 20,
    });
    expect(page.items).toHaveLength(4);
    expect(page.items.map((i) => i.attemptCount)).toEqual([1, 1, 1, 1]);
    expect(page.items.map((i) => i.direction)).toEqual([
      "INCOMING",
      "OUTGOING",
      "OUTGOING",
      "OUTGOING",
    ]);
    expect(page.items.map((i) => i.result)).toEqual([
      "MISSED",
      "NO_ANSWER",
      "NO_ANSWER",
      "ANSWERED",
    ]);
    expect(page.items.map((i) => i.callType)).toEqual([
      "AUDIO",
      "AUDIO",
      "VIDEO",
      "VIDEO",
    ]);
  });

  it("resolves the peer, not the caller, as the grouping contact", async () => {
    const rows = [
      call({
        callId: "a",
        from: ME,
        to: MOHIT,
        status: "ENDED",
        answered: true,
      }),
    ];
    const page = await serviceOf(rows).getHistory({
      userId: ME,
      filter: "all",
      limit: 20,
    });
    expect(page.items[0]!.contact).toEqual({
      id: MOHIT,
      name: "name:mohit",
      avatarUrl: "avatar:mohit",
      isDeleted: false,
    });
  });
});

describe("filters", () => {
  const rows = () => [
    call({ callId: "in-missed", from: MOHIT, to: ME, status: "MISSED" }),
    call({
      callId: "in-answered",
      from: MOHIT,
      to: ME,
      status: "ENDED",
      answered: true,
    }),
    call({ callId: "in-declined", from: MOHIT, to: ME, status: "DECLINED" }),
    call({ callId: "out-noanswer", from: ME, to: MOHIT, status: "MISSED" }),
    call({ callId: "out-cancelled", from: ME, to: MOHIT, status: "ENDED" }),
  ];

  it("all keeps every settled outcome", async () => {
    const page = await serviceOf(rows()).getHistory({
      userId: ME,
      filter: "all",
      limit: 20,
    });
    // in-missed and in-declined both read as MISSED/INCOMING/AUDIO, but
    // in-answered sits between them, so they stay two separate rows.
    expect(page.items.map((i) => i.latestCallId)).toEqual([
      "in-missed",
      "in-answered",
      "in-declined",
      "out-noanswer",
    ]);
    expect(page.items.map((i) => i.attemptCount)).toEqual([1, 1, 1, 2]);
  });

  it("incoming keeps only calls where I am the callee", async () => {
    const page = await serviceOf(rows()).getHistory({
      userId: ME,
      filter: "incoming",
      limit: 20,
    });
    expect(page.items.every((i) => i.direction === "INCOMING")).toBe(true);
    expect(page.items).toHaveLength(3);
  });

  it("outgoing keeps only calls where I am the caller", async () => {
    const page = await serviceOf(rows()).getHistory({
      userId: ME,
      filter: "outgoing",
      limit: 20,
    });
    // Both outgoing rows are NO_ANSWER to the caller and adjacent, so they are
    // ONE row of two attempts: the caller experienced the same thing twice.
    expect(page.items.map((i) => i.latestCallId)).toEqual(["out-noanswer"]);
    expect(page.items[0]!.attemptCount).toBe(2);
  });

  it("missed excludes answered calls and the viewer's own no-answers", async () => {
    const page = await serviceOf(rows()).getHistory({
      userId: ME,
      filter: "missed",
      limit: 20,
    });
    // in-missed and in-declined are both "rang me, never connected", and with
    // in-answered filtered out they are now adjacent, so they collapse.
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.latestCallId).toBe("in-missed");
    expect(page.items[0]!.attemptCount).toBe(2);
    expect(page.items[0]!.result).toBe("MISSED");
  });

  it("counts an inbound ring the caller abandoned as missed", async () => {
    // Stored ENDED with a null answeredAt: the caller hung up mid-ring. From
    // the callee's seat that is indistinguishable from a timeout.
    const rows = [
      call({ callId: "a", from: MOHIT, to: ME, status: "ENDED", ringSec: 2 }),
    ];
    const page = await serviceOf(rows).getHistory({
      userId: ME,
      filter: "missed",
      limit: 20,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.result).toBe("MISSED");
  });

  it("never puts an answered call in the Missed tab", async () => {
    const rows = [
      call({
        callId: "a",
        from: MOHIT,
        to: ME,
        status: "ENDED",
        answered: true,
      }),
    ];
    const page = await serviceOf(rows).getHistory({
      userId: ME,
      filter: "missed",
      limit: 20,
    });
    expect(page.items).toHaveLength(0);
  });
});

describe("pagination", () => {
  it("never splits a group across a page boundary", async () => {
    const rows = [
      call({ callId: "a1", from: MOHIT, to: ME, status: "MISSED" }),
      call({ callId: "a2", from: MOHIT, to: ME, status: "MISSED" }),
      call({
        callId: "b1",
        from: ME,
        to: RAJESH,
        status: "ENDED",
        answered: true,
      }),
      call({
        callId: "b2",
        from: ME,
        to: RAJESH,
        status: "ENDED",
        answered: true,
      }),
      call({ callId: "c1", from: MOHIT, to: ME, status: "DECLINED" }),
    ];
    const service = serviceOf(rows);

    const first = await service.getHistory({
      userId: ME,
      filter: "all",
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.attemptCount).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.getHistory({
      userId: ME,
      filter: "all",
      limit: 1,
      cursor: first.nextCursor,
    });
    // The Rajesh run is whole on page 2, not two halves either side of the edge.
    expect(second.items[0]!.contact.id).toBe(RAJESH);
    expect(second.items[0]!.attemptCount).toBe(2);

    const third = await service.getHistory({
      userId: ME,
      filter: "all",
      limit: 1,
      cursor: second.nextCursor,
    });
    expect(third.items[0]!.latestCallId).toBe("c1");
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
  });

  it("reports the end of history without a cursor", async () => {
    const page = await serviceOf([]).getHistory({
      userId: ME,
      filter: "all",
      limit: 20,
    });
    expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it("rejects an unparseable cursor instead of silently returning nothing", async () => {
    await expect(
      serviceOf([]).getHistory({
        userId: ME,
        filter: "all",
        limit: 20,
        cursor: "not-a-date",
      })
    ).rejects.toThrow();
  });

  it("survives an identity lookup outage", async () => {
    const service = new CallHistoryService(
      repoOf([
        call({ callId: "a", from: MOHIT, to: ME, status: "MISSED" }),
      ]) as never,
      (async () => {
        throw new Error("grpc down");
      }) as never
    );
    const page = await service.getHistory({
      userId: ME,
      filter: "all",
      limit: 20,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.contact.id).toBe(MOHIT);
  });
});
