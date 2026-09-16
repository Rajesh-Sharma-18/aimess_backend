/**
 * The auto-delete CLAIM QUERY — the predicate that decides which messages the
 * sweeper is allowed to delete.
 *
 * Every existing auto-delete test stubs `claimDueAutoDeletes` and asserts on
 * what the service does with the rows it is handed. Nothing exercised the
 * predicate itself, which is how a filter that matched NOTHING shipped and left
 * the sweeper silently idle: no error, no failed attempt, just an empty page on
 * every tick while overdue messages accumulated in the collection.
 *
 * So the delegate below is a filter engine, not a stub, and it models the one
 * MongoDB behaviour the bug turned on: Prisma writes an optional column only
 * when it is given a value, and `{ field: null }` matches a field that is
 * PRESENT AND NULL — never one that is ABSENT. A row that has never failed a
 * delete has no `autoDeleteNextAttemptAt` at all; a row nobody has claimed has
 * no `autoDeleteClaimToken`. Both are the normal case, and both are invisible
 * to a bare null filter.
 */
import {
  claimDueAutoDeletes,
  autoDeleteRetryDelaySec,
  releaseAutoDeleteClaim,
  AUTO_DELETE_CLAIM_LEASE_SEC,
  AUTO_DELETE_RETRY_BASE_SEC,
  AUTO_DELETE_RETRY_MAX_SEC,
  type AutoDeleteClaimDelegate,
} from "../../src/lib/auto-delete-claim.js";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR = 3600_000;

/** A stored document. A key that is ABSENT is absent — never `undefined`. */
type Doc = Record<string, unknown>;

/**
 * Evaluate one leaf filter the way Prisma's MongoDB connector does.
 *
 * The two lines that matter are `isSet` and the `null` case: everything else
 * here is ordinary comparison, and getting those two wrong is the entire bug.
 */
function matchLeaf(doc: Doc, field: string, cond: unknown): boolean {
  const present = Object.prototype.hasOwnProperty.call(doc, field);
  const value = doc[field];

  if (cond === null) return present && value === null;

  if (cond && typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as Record<string, unknown>;
    if ("isSet" in c) return c.isSet ? present : !present;
    if ("not" in c) {
      if (c.not === null) return present && value !== null;
      return value !== c.not;
    }
    if ("in" in c) return (c.in as unknown[]).includes(value);
    if ("increment" in c) return true;
    for (const [op, operand] of Object.entries(c)) {
      if (value == null) return false;
      const a = value instanceof Date ? value.getTime() : Number(value);
      const b = operand instanceof Date ? operand.getTime() : Number(operand);
      if (op === "lte" && !(a <= b)) return false;
      if (op === "lt" && !(a < b)) return false;
      if (op === "gte" && !(a >= b)) return false;
      if (op === "gt" && !(a > b)) return false;
    }
    return true;
  }

  return value === cond;
}

function matchWhere(doc: Doc, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      if (!(cond as Record<string, unknown>[]).every((c) => matchWhere(doc, c)))
        return false;
    } else if (key === "OR") {
      if (!(cond as Record<string, unknown>[]).some((c) => matchWhere(doc, c)))
        return false;
    } else if (key === "NOT") {
      if (matchWhere(doc, cond as Record<string, unknown>)) return false;
    } else if (!matchLeaf(doc, key, cond)) {
      return false;
    }
  }
  return true;
}

/** An in-memory collection with Prisma-shaped findMany/updateMany/update. */
function makeDelegate(docs: Doc[]) {
  const store = docs.map((d) => ({ ...d }));
  const delegate: AutoDeleteClaimDelegate & { rows: Doc[] } = {
    rows: store,
    async findMany(args: Record<string, any>) {
      let out = store.filter((d) => matchWhere(d, args.where ?? {}));
      if (args.orderBy?.autoDeleteAt === "asc") {
        out = [...out].sort(
          (a, b) =>
            (a.autoDeleteAt as Date).getTime() -
            (b.autoDeleteAt as Date).getTime()
        );
      }
      if (args.take) out = out.slice(0, args.take);
      return out as never;
    },
    async updateMany(args: Record<string, any>) {
      let count = 0;
      for (const doc of store) {
        if (!matchWhere(doc, args.where ?? {})) continue;
        for (const [field, value] of Object.entries(args.data ?? {})) {
          if (value && typeof value === "object" && "increment" in value) {
            doc[field] =
              ((doc[field] as number) ?? 0) +
              (value as { increment: number }).increment;
          } else {
            doc[field] = value;
          }
        }
        count += 1;
      }
      return { count };
    },
    async update(args: Record<string, any>) {
      const doc = store.find((d) => d.id === args.where.id);
      if (doc) Object.assign(doc, args.data);
      return doc as never;
    },
  };
  return delegate;
}

/**
 * A message as the send path actually writes it: `autoDeleteAt` stamped, and
 * NO claim/backoff columns, because nothing has ever claimed or failed it.
 */
const pristine = (id: string, autoDeleteAt: Date | null): Doc => ({
  id,
  roomId: "grp_test",
  senderId: "sender-1",
  isDeleted: false,
  autoDeleteAt,
  autoDeleteAttempts: 0,
});

const claim = (delegate: AutoDeleteClaimDelegate, over: Partial<{ now: Date; limit: number; token: string }> = {}) =>
  claimDueAutoDeletes(delegate, {
    now: over.now ?? NOW,
    limit: over.limit ?? 50,
    token: over.token ?? "worker-a",
  });

describe("claimDueAutoDeletes — the 24-hour boundary", () => {
  it("does not claim a message whose deadline is still in the future", async () => {
    const delegate = makeDelegate([pristine("m1", ahead(1))]);
    expect(await claim(delegate)).toEqual([]);
  });

  it("claims a message exactly at its deadline", async () => {
    const delegate = makeDelegate([pristine("m1", NOW)]);
    expect((await claim(delegate)).map((r) => r.id)).toEqual(["m1"]);
  });

  it("claims a message past its deadline", async () => {
    const delegate = makeDelegate([pristine("m1", ago(HOUR))]);
    expect((await claim(delegate)).map((r) => r.id)).toEqual(["m1"]);
  });

  it("claims a never-claimed message — the columns are ABSENT, not null", async () => {
    const doc = pristine("m1", ago(24 * HOUR));
    expect("autoDeleteNextAttemptAt" in doc).toBe(false);
    expect("autoDeleteClaimToken" in doc).toBe(false);

    const delegate = makeDelegate([doc]);
    expect((await claim(delegate)).map((r) => r.id)).toEqual(["m1"]);
  });

  it("claims a 24-hour backlog that built up while nothing swept it", async () => {
    const delegate = makeDelegate(
      Array.from({ length: 30 }, (_, i) =>
        pristine(`m${i}`, ago((i + 1) * HOUR))
      )
    );
    expect(await claim(delegate)).toHaveLength(30);
  });
});

describe("claimDueAutoDeletes — messages with no timer", () => {
  it("never claims a message whose autoDeleteAt is null", async () => {
    const delegate = makeDelegate([pristine("m1", null)]);
    expect(await claim(delegate)).toEqual([]);
  });

  it("never claims a message with no autoDeleteAt field at all", async () => {
    const delegate = makeDelegate([
      { id: "m1", roomId: "grp_test", senderId: "s", isDeleted: false },
    ]);
    expect(await claim(delegate)).toEqual([]);
  });

  it("never claims an already-deleted message", async () => {
    const delegate = makeDelegate([
      { ...pristine("m1", ago(HOUR)), isDeleted: true },
    ]);
    expect(await claim(delegate)).toEqual([]);
  });
});

describe("claimDueAutoDeletes — backoff after a failed delete", () => {
  it("holds a row back while its retry window is open", async () => {
    const delegate = makeDelegate([
      { ...pristine("m1", ago(HOUR)), autoDeleteNextAttemptAt: ahead(HOUR) },
    ]);
    expect(await claim(delegate)).toEqual([]);
  });

  it("re-offers it once the retry window has elapsed", async () => {
    const delegate = makeDelegate([
      { ...pristine("m1", ago(2 * HOUR)), autoDeleteNextAttemptAt: ago(1) },
    ]);
    expect((await claim(delegate)).map((r) => r.id)).toEqual(["m1"]);
  });

  it("re-offers a row whose release wrote an explicit null token", async () => {
    const delegate = makeDelegate([pristine("m1", ago(HOUR))]);
    await releaseAutoDeleteClaim(delegate, {
      id: "m1",
      attempts: 1,
      error: "boom",
      now: ago(10 * HOUR),
    });
    expect(delegate.rows[0].autoDeleteClaimToken).toBeNull();
    expect((await claim(delegate)).map((r) => r.id)).toEqual(["m1"]);
  });
});

describe("claimDueAutoDeletes — leases", () => {
  it("leaves a row another worker is holding alone", async () => {
    const delegate = makeDelegate([
      {
        ...pristine("m1", ago(HOUR)),
        autoDeleteClaimToken: "worker-b",
        autoDeleteClaimedAt: ago(1000),
      },
    ]);
    expect(await claim(delegate)).toEqual([]);
  });

  it("reclaims a row whose holder died and let the lease run out", async () => {
    const delegate = makeDelegate([
      {
        ...pristine("m1", ago(HOUR)),
        autoDeleteClaimToken: "worker-b",
        autoDeleteClaimedAt: ago(AUTO_DELETE_CLAIM_LEASE_SEC * 1000 + 1000),
      },
    ]);
    expect((await claim(delegate)).map((r) => r.id)).toEqual(["m1"]);
  });

  it("gives a row to exactly one of two workers racing for it", async () => {
    const delegate = makeDelegate([pristine("m1", ago(HOUR))]);
    const [a, b] = await Promise.all([
      claim(delegate, { token: "worker-a" }),
      claim(delegate, { token: "worker-b" }),
    ]);
    expect(a.length + b.length).toBe(1);
  });

  it("returns only the rows carrying THIS worker's token", async () => {
    const delegate = makeDelegate([
      pristine("m1", ago(HOUR)),
      {
        ...pristine("m2", ago(HOUR)),
        autoDeleteClaimToken: "worker-b",
        autoDeleteClaimedAt: ago(1000),
      },
    ]);
    expect((await claim(delegate, { token: "worker-a" })).map((r) => r.id)).toEqual([
      "m1",
    ]);
  });
});

describe("claimDueAutoDeletes — batching", () => {
  it("drains oldest deadline first so a backlog does not starve", async () => {
    const delegate = makeDelegate([
      pristine("new", ago(HOUR)),
      pristine("old", ago(100 * HOUR)),
      pristine("mid", ago(10 * HOUR)),
    ]);
    const ids = (await claim(delegate, { limit: 2 })).map((r) => r.id);
    expect(ids).toContain("old");
    expect(ids).toContain("mid");
    expect(ids).not.toContain("new");
  });

  it("honours the batch limit", async () => {
    const delegate = makeDelegate(
      Array.from({ length: 10 }, (_, i) => pristine(`m${i}`, ago(HOUR)))
    );
    expect(await claim(delegate, { limit: 3 })).toHaveLength(3);
  });

  it("counts the attempt it just made", async () => {
    const delegate = makeDelegate([pristine("m1", ago(HOUR))]);
    const [row] = await claim(delegate);
    expect(row.attempts).toBe(1);
    expect(delegate.rows[0].autoDeleteAttempts).toBe(1);
  });

  it("makes no write at all when nothing is due", async () => {
    const delegate = makeDelegate([pristine("m1", ahead(HOUR))]);
    const spy = jest.spyOn(delegate, "updateMany");
    await claim(delegate);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("autoDeleteRetryDelaySec", () => {
  it("backs off exponentially from the base delay", () => {
    expect(autoDeleteRetryDelaySec(1)).toBe(AUTO_DELETE_RETRY_BASE_SEC);
    expect(autoDeleteRetryDelaySec(2)).toBe(AUTO_DELETE_RETRY_BASE_SEC * 2);
    expect(autoDeleteRetryDelaySec(3)).toBe(AUTO_DELETE_RETRY_BASE_SEC * 4);
  });

  it("caps so a hopeless row is retried hourly, not never", () => {
    expect(autoDeleteRetryDelaySec(99)).toBe(AUTO_DELETE_RETRY_MAX_SEC);
  });
});
