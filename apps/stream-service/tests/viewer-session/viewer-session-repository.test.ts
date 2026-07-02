/**
 * Suite: LivestreamViewerSessionRepository
 *
 * Pure-unit coverage of the durable viewer-session persistence layer that
 * backs the admin "Livestream User List" (GET /admin/v1/livestreams/:id/users).
 * The Prisma client is a hand-rolled fake — no jest.mock() module interception
 * needed since the repository takes its client via constructor injection.
 *
 * The fake faithfully reproduces a real MongoDB-Prisma quirk that mattered
 * for this suite: an optional field left unset at `create()` time (`leftAt`
 * here) is ABSENT from the document, not explicitly `null` — so a filter of
 * `{ leftAt: null }` never matches it; only `{ leftAt: { isSet: false } }`
 * does (same idiom as `deletedAt: { isSet: false }` elsewhere in this repo).
 * The fake's `matchesLeftAt` below enforces that distinction so a regression
 * back to `{ leftAt: null }` anywhere in the repository fails these tests.
 */
import { LivestreamViewerSessionRepository } from "../../src/repositories/livestream-viewer-session.repository.js";

type FakeSession = {
  id: string;
  livestreamId: string;
  userId: string;
  joinedAt: Date;
  leftAt: Date | null; // null here represents "unset" — see file doc above.
  watchDurationSeconds: number | null;
};

function matchesLeftAt(row: FakeSession, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return false; // `{ leftAt: null }` never matches "unset" — the real bug this suite guards against.
  if (typeof cond === "object" && cond !== null && "isSet" in cond) {
    const isSet = (cond as { isSet: boolean }).isSet;
    return isSet ? row.leftAt !== null : row.leftAt === null;
  }
  return row.leftAt?.getTime() === (cond as Date).getTime();
}

function makeFakePrisma(seed: FakeSession[] = []) {
  const rows = [...seed];
  let nextId = rows.length + 1;

  const livestreamViewerSession = {
    findFirst: jest.fn(async ({ where }: any) => {
      const matches = rows.filter(
        (r) =>
          r.livestreamId === where.livestreamId &&
          r.userId === where.userId &&
          matchesLeftAt(r, where.leftAt)
      );
      matches.sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime());
      return matches[0] ?? null;
    }),
    create: jest.fn(async ({ data }: any) => {
      const row: FakeSession = {
        id: `sess-${nextId++}`,
        livestreamId: data.livestreamId,
        userId: data.userId,
        joinedAt: new Date(),
        leftAt: null,
        watchDurationSeconds: null,
      };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    }),
    findMany: jest.fn(async ({ where, select, distinct }: any) => {
      let matches = rows.filter((r) => r.livestreamId === where.livestreamId);
      if (where.leftAt !== undefined) {
        matches = matches.filter((r) => matchesLeftAt(r, where.leftAt));
      }
      if (where.userId?.in) {
        matches = matches.filter((r) => where.userId.in.includes(r.userId));
      }
      if (distinct?.includes("userId")) {
        const seen = new Set<string>();
        matches = matches.filter((r) => {
          if (seen.has(r.userId)) return false;
          seen.add(r.userId);
          return true;
        });
      }
      if (select) {
        return matches.map((r) => {
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            out[key] = (r as any)[key];
          }
          return out;
        });
      }
      return matches;
    }),
    count: jest.fn(
      async ({ where }: any) =>
        rows.filter((r) => r.livestreamId === where.livestreamId).length
    ),
    groupBy: jest.fn(async ({ where, orderBy, skip, take }: any) => {
      const matches = rows.filter((r) => r.livestreamId === where.livestreamId);
      const byUser = new Map<string, FakeSession[]>();
      for (const r of matches) {
        const arr = byUser.get(r.userId) ?? [];
        arr.push(r);
        byUser.set(r.userId, arr);
      }
      let grouped = [...byUser.entries()].map(([userId, sessions]) => {
        const joinedAts = sessions.map((s) => s.joinedAt.getTime());
        const closedLeftAts = sessions
          .map((s) => s.leftAt)
          .filter((d): d is Date => d !== null);
        const sum = sessions.reduce(
          (acc, s) => acc + (s.watchDurationSeconds ?? 0),
          0
        );
        return {
          userId,
          _min: { joinedAt: new Date(Math.min(...joinedAts)) },
          _max: {
            leftAt:
              closedLeftAts.length > 0
                ? new Date(Math.max(...closedLeftAts.map((d) => d.getTime())))
                : null,
          },
          _sum: { watchDurationSeconds: sum },
        };
      });

      const orderKey = orderBy?._sum ? "sum" : "min";
      const sortDir: "asc" | "desc" =
        orderBy?._sum?.watchDurationSeconds ?? orderBy?._min?.joinedAt ?? "asc";
      grouped.sort((a, b) => {
        const av =
          orderKey === "sum"
            ? a._sum.watchDurationSeconds
            : a._min.joinedAt.getTime();
        const bv =
          orderKey === "sum"
            ? b._sum.watchDurationSeconds
            : b._min.joinedAt.getTime();
        return sortDir === "asc" ? av - bv : bv - av;
      });

      if (typeof skip === "number") grouped = grouped.slice(skip);
      if (typeof take === "number") grouped = grouped.slice(0, take);
      return grouped;
    }),
  };

  return { prisma: { livestreamViewerSession } as any, rows };
}

describe("LivestreamViewerSessionRepository.recordJoin", () => {
  it("creates a new OPEN session for a first-time viewer", async () => {
    const { prisma, rows } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    const sessionId = await repo.recordJoin("stream-1", "user-1");

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(sessionId);
    expect(rows[0].leftAt).toBeNull();
  });

  it("is idempotent — a duplicate join while still open reuses the same session (no duplicate row)", async () => {
    const { prisma, rows } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    const first = await repo.recordJoin("stream-1", "user-1");
    const second = await repo.recordJoin("stream-1", "user-1"); // duplicate join / reconnect

    expect(first).toBe(second);
    expect(rows).toHaveLength(1);
  });

  it("a rejoin AFTER a proper leave creates a NEW session (distinct watch session)", async () => {
    const { prisma, rows } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    const first = await repo.recordJoin("stream-1", "user-1");
    await repo.recordLeave("stream-1", "user-1");
    const second = await repo.recordJoin("stream-1", "user-1");

    expect(second).not.toBe(first);
    expect(rows).toHaveLength(2);
  });

  it("does not collide across different streams for the same user", async () => {
    const { prisma, rows } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    await repo.recordJoin("stream-1", "user-1");
    await repo.recordJoin("stream-2", "user-1");

    expect(rows).toHaveLength(2);
  });
});

describe("LivestreamViewerSessionRepository.recordLeave", () => {
  it("closes the open session and computes watchDurationSeconds", async () => {
    const { prisma, rows } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);
    await repo.recordJoin("stream-1", "user-1");
    rows[0].joinedAt = new Date(Date.now() - 5000); // joined 5s ago

    const closed = await repo.recordLeave("stream-1", "user-1");

    expect(closed).toBe(true);
    expect(rows[0].leftAt).not.toBeNull();
    expect(rows[0].watchDurationSeconds).toBeGreaterThanOrEqual(5);
  });

  it("is a safe no-op when there is no open session (duplicate leave)", async () => {
    const { prisma } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);
    await repo.recordJoin("stream-1", "user-1");
    await repo.recordLeave("stream-1", "user-1");

    const secondLeave = await repo.recordLeave("stream-1", "user-1");

    expect(secondLeave).toBe(false);
  });

  it("is a safe no-op for a leave with no matching prior join at all", async () => {
    const { prisma } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    const result = await repo.recordLeave("stream-1", "never-joined");

    expect(result).toBe(false);
  });
});

describe("LivestreamViewerSessionRepository.closeAllOpenForStream", () => {
  it("closes every still-open session for the stream (unexpected disconnect / stream end)", async () => {
    const { prisma, rows } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);
    await repo.recordJoin("stream-1", "user-1");
    await repo.recordJoin("stream-1", "user-2");
    await repo.recordJoin("stream-1", "user-3");
    await repo.recordLeave("stream-1", "user-2"); // user-2 already left cleanly

    const closedCount = await repo.closeAllOpenForStream(
      "stream-1",
      new Date()
    );

    expect(closedCount).toBe(2); // user-1 + user-3 were open
    expect(rows.every((r) => r.leftAt !== null)).toBe(true);
  });

  it("is a no-op when nothing is open", async () => {
    const { prisma } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    const closedCount = await repo.closeAllOpenForStream(
      "stream-1",
      new Date()
    );

    expect(closedCount).toBe(0);
  });

  it("does not touch open sessions on OTHER streams", async () => {
    const { prisma, rows } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);
    await repo.recordJoin("stream-1", "user-1");
    await repo.recordJoin("stream-2", "user-1");

    await repo.closeAllOpenForStream("stream-1", new Date());

    const stream2Row = rows.find((r) => r.livestreamId === "stream-2")!;
    expect(stream2Row.leftAt).toBeNull();
  });
});

describe("LivestreamViewerSessionRepository.listByStream — per-user aggregation (dedup)", () => {
  it("REGRESSION: a first-time single-session join returns exactly one row", async () => {
    const { prisma } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);
    await repo.recordJoin("stream-1", "user-1");

    const { rows, total } = await repo.listByStream("stream-1", {
      skip: 0,
      take: 20,
      sortField: "joinedAt",
      sortDir: "asc",
    });

    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("user-1");
  });

  it("REGRESSION: leave + rejoin still returns exactly ONE row for that user, aggregating both sessions", async () => {
    const { prisma, rows: raw } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    await repo.recordJoin("stream-1", "user-1");
    raw[0].joinedAt = new Date("2026-01-01T00:00:00Z");
    await repo.recordLeave("stream-1", "user-1");
    raw[0].leftAt = new Date("2026-01-01T00:05:00Z");
    raw[0].watchDurationSeconds = 300;

    await repo.recordJoin("stream-1", "user-1"); // rejoin — new underlying row
    raw[1].joinedAt = new Date("2026-01-01T00:10:00Z");
    await repo.recordLeave("stream-1", "user-1");
    raw[1].leftAt = new Date("2026-01-01T00:12:00Z");
    raw[1].watchDurationSeconds = 120;

    expect(raw).toHaveLength(2); // two underlying sessions...

    const { rows, total } = await repo.listByStream("stream-1", {
      skip: 0,
      take: 20,
      sortField: "joinedAt",
      sortDir: "asc",
    });

    expect(total).toBe(1); // ...but ONE aggregated user row
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("user-1");
    // earliest joinedAt
    expect(rows[0].joinedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // latest leftAt
    expect(rows[0].leftAt?.toISOString()).toBe("2026-01-01T00:12:00.000Z");
    // total watchDurationSeconds across both sessions
    expect(rows[0].watchDurationSeconds).toBe(420);
  });

  it("REGRESSION: multiple reconnects (4+ sessions) still collapse to one row per user", async () => {
    const { prisma, rows: raw } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    for (let i = 0; i < 5; i++) {
      await repo.recordJoin("stream-1", "user-1");
      const last = raw[raw.length - 1];
      last.watchDurationSeconds = 10; // pretend each session watched 10s
      last.leftAt = new Date();
      await repo.recordLeave("stream-1", "user-1");
    }
    expect(raw).toHaveLength(5);

    const { rows, total } = await repo.listByStream("stream-1", {
      skip: 0,
      take: 20,
      sortField: "joinedAt",
      sortDir: "asc",
    });

    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].watchDurationSeconds).toBe(50); // 5 sessions * 10s
  });

  it("REGRESSION: a currently-open session (still watching) reports leftAt=null in the aggregated row, even with prior closed sessions", async () => {
    const { prisma, rows: raw } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    await repo.recordJoin("stream-1", "user-1");
    raw[0].leftAt = new Date("2026-01-01T00:05:00Z");
    raw[0].watchDurationSeconds = 300;
    await repo.recordLeave("stream-1", "user-1");

    await repo.recordJoin("stream-1", "user-1"); // still open — currently watching

    const { rows } = await repo.listByStream("stream-1", {
      skip: 0,
      take: 20,
      sortField: "joinedAt",
      sortDir: "asc",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].leftAt).toBeNull();
    expect(rows[0].openSessionJoinedAt).not.toBeNull();
    // Sum only counts the CLOSED session; the open one has no stored duration yet.
    expect(rows[0].watchDurationSeconds).toBe(300);
  });

  it("concurrent viewers: each unique user gets exactly one row, unaffected by others' session counts", async () => {
    const { prisma } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    await repo.recordJoin("stream-1", "user-1");
    await repo.recordLeave("stream-1", "user-1");
    await repo.recordJoin("stream-1", "user-1"); // user-1: 2 sessions total (1 closed, 1 open)

    await repo.recordJoin("stream-1", "user-2"); // user-2: 1 open session
    await repo.recordJoin("stream-1", "user-3");
    await repo.recordLeave("stream-1", "user-3"); // user-3: 1 closed session

    const { rows, total } = await repo.listByStream("stream-1", {
      skip: 0,
      take: 20,
      sortField: "joinedAt",
      sortDir: "asc",
    });

    expect(total).toBe(3);
    const userIds = rows.map((r) => r.userId);
    expect(new Set(userIds).size).toBe(3);
    expect(userIds.sort()).toEqual(["user-1", "user-2", "user-3"]);
  });

  it("stream ends (bulk close) — viewer list still shows one row per user, all with a non-null leftAt", async () => {
    const { prisma } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    await repo.recordJoin("stream-1", "user-1");
    await repo.recordJoin("stream-1", "user-2");
    await repo.recordLeave("stream-1", "user-2");

    await repo.closeAllOpenForStream("stream-1", new Date());

    const { rows, total } = await repo.listByStream("stream-1", {
      skip: 0,
      take: 20,
      sortField: "joinedAt",
      sortDir: "asc",
    });

    expect(total).toBe(2);
    expect(rows.every((r) => r.leftAt !== null)).toBe(true);
    expect(rows.every((r) => r.openSessionJoinedAt === null)).toBe(true);
  });

  it("REGRESSION: pagination over many unique viewers returns no duplicates and no gaps across pages", async () => {
    const { prisma } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    for (let i = 0; i < 25; i++) {
      await repo.recordJoin("stream-1", `user-${String(i).padStart(2, "0")}`);
      await repo.recordLeave("stream-1", `user-${String(i).padStart(2, "0")}`);
    }

    const page1 = await repo.listByStream("stream-1", {
      skip: 0,
      take: 10,
      sortField: "joinedAt",
      sortDir: "asc",
    });
    const page2 = await repo.listByStream("stream-1", {
      skip: 10,
      take: 10,
      sortField: "joinedAt",
      sortDir: "asc",
    });
    const page3 = await repo.listByStream("stream-1", {
      skip: 20,
      take: 10,
      sortField: "joinedAt",
      sortDir: "asc",
    });

    expect(page1.total).toBe(25);
    expect(page1.rows).toHaveLength(10);
    expect(page2.rows).toHaveLength(10);
    expect(page3.rows).toHaveLength(5);

    const allIds = [...page1.rows, ...page2.rows, ...page3.rows].map(
      (r) => r.userId
    );
    expect(new Set(allIds).size).toBe(25); // no cross-page duplicates
  });

  it("sorts by total watchDurationSeconds across all of a user's sessions, not any single session", async () => {
    const { prisma, rows: raw } = makeFakePrisma();
    const repo = new LivestreamViewerSessionRepository(prisma);

    // user-1: two short sessions summing to 50s total.
    await repo.recordJoin("stream-1", "user-1");
    raw[0].watchDurationSeconds = 20;
    raw[0].leftAt = new Date();
    await repo.recordLeave("stream-1", "user-1");
    await repo.recordJoin("stream-1", "user-1");
    raw[1].watchDurationSeconds = 30;
    raw[1].leftAt = new Date();
    await repo.recordLeave("stream-1", "user-1");

    // user-2: one long session of 40s — longer than any SINGLE user-1
    // session, but shorter than user-1's aggregated total.
    await repo.recordJoin("stream-1", "user-2");
    raw[2].watchDurationSeconds = 40;
    raw[2].leftAt = new Date();
    await repo.recordLeave("stream-1", "user-2");

    const { rows } = await repo.listByStream("stream-1", {
      skip: 0,
      take: 20,
      sortField: "watchDurationSeconds",
      sortDir: "desc",
    });

    expect(rows.map((r) => r.userId)).toEqual(["user-1", "user-2"]);
    expect(rows[0].watchDurationSeconds).toBe(50);
  });
});
