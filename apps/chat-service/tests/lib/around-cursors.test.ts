/**
 * Unit coverage for the jump-to-message (`?around=`) bidirectional continuation
 * signals (src/lib/around-cursors). These cursors are load-bearing for the
 * offline-first "two islands" stitch: without a usable newerCursor +
 * hasMoreNewer the client can't page DOWN from a mid-thread landing and the
 * jump window never joins the recent tail. The probe is injected so this runs
 * without a database.
 */

import {
  computeSeqAroundCursors,
  computeDateAroundCursors,
  EMPTY_AROUND_CURSORS,
} from "../../src/lib/around-cursors.js";

describe("computeSeqAroundCursors (private/group)", () => {
  const items = [
    { sequenceNumber: 10 },
    { sequenceNumber: 11 },
    { sequenceNumber: 12 },
  ];

  it("returns boundary seqs as cursors and true/true when more exists both ways", async () => {
    const seen: Array<[string, number]> = [];
    const probe = async (direction: "before" | "after", seq: number) => {
      seen.push([direction, seq]);
      return { length: 1 }; // a row exists beyond this edge
    };
    const out = await computeSeqAroundCursors(items, probe);
    expect(out).toEqual({
      hasMoreOlder: true,
      hasMoreNewer: true,
      olderCursor: "10", // first row's seq → before_seq
      newerCursor: "12", // last row's seq → after_seq
    });
    // Probes the correct edges: older beyond 10, newer beyond 12.
    expect(seen).toEqual([
      ["before", 10],
      ["after", 12],
    ]);
  });

  it("reports exhaustion when nothing lies beyond an edge", async () => {
    const probe = async () => ({ length: 0 });
    const out = await computeSeqAroundCursors(items, probe);
    expect(out.hasMoreOlder).toBe(false);
    expect(out.hasMoreNewer).toBe(false);
    // Cursors are still returned — a client may re-probe later.
    expect(out.olderCursor).toBe("10");
    expect(out.newerCursor).toBe("12");
  });

  it("yields empty cursors for an empty window (anchor deleted-for-me)", async () => {
    const probe = jest.fn();
    const out = await computeSeqAroundCursors([], probe);
    expect(out).toEqual(EMPTY_AROUND_CURSORS);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("computeDateAroundCursors (community)", () => {
  const rows = [
    { createdAt: new Date(1000), id: "a" },
    { createdAt: new Date(2000), id: "b" },
    { createdAt: new Date(3000), id: "c" },
  ];

  it("returns compound olderCursor + plain-ms newerCursor", async () => {
    const seen: Array<[string, number, string]> = [];
    const probe = async (
      direction: "before" | "after",
      ts: Date,
      boundaryId: string
    ) => {
      seen.push([direction, ts.getTime(), boundaryId]);
      return { length: direction === "after" ? 0 : 1 };
    };
    const out = await computeDateAroundCursors(rows, probe);
    expect(out).toEqual({
      hasMoreOlder: true,
      hasMoreNewer: false,
      olderCursor: "1000_a", // "<ms>_<id>" → before_ts (compound accepted)
      newerCursor: "3000", // plain epoch-ms → after_ts
    });
    expect(seen).toEqual([
      ["before", 1000, "a"],
      ["after", 3000, "c"],
    ]);
  });

  it("yields empty cursors for an empty window", async () => {
    const out = await computeDateAroundCursors([], async () => ({ length: 0 }));
    expect(out).toEqual(EMPTY_AROUND_CURSORS);
  });
});
