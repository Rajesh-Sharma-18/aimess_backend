/**
 * Tiny in-memory MongoDB emulator for the chat timeline keyset queries.
 *
 * It implements ONLY the `aggregateRaw` / `findMany` operators the message
 * repositories emit for `findByRoomIdTimeline` + `countTimeline`, so the REAL
 * repository code can be exercised against an in-memory dataset and a full
 * history traversal can be proven (every message reachable exactly once).
 *
 * Supported $match operators: plain equality (roomId/isDeleted), equality to
 * `null` (which, as in real Mongo, also matches a MISSING field — that is what
 * lets `systemEvent: null` exclude system rows without a migration), `$ne` (array
 * membership for deletedForUserIds, or scalar), `$regex`/`$options` (the
 * case-insensitive substring match message search runs on), dotted
 * `deletedFor.<user>` with `$exists:false` (per-user delete-for-me MAP),
 * `createdAt` range ($lt/$lte/$gt/$gte with {$date}) and equality ({$date}),
 * `_id` range ($lt/$gt with {$oid}), and `$or`. Pipeline stages: $match,
 * $sort {createdAt,_id}, $limit, $count, and $project (only its `createdAt` key
 * is honoured — search reads the field back to build its keyset cursor).
 */

export type EmuDoc = {
  _id: string;
  roomId: string;
  createdAt: Date;
  [k: string]: unknown;
};

function getPath(doc: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, k) =>
        acc && typeof acc === "object"
          ? (acc as Record<string, unknown>)[k]
          : undefined,
      doc
    );
}

function dateMs(v: { $date: string }): number {
  return new Date(v.$date).getTime();
}

function matchField(doc: EmuDoc, key: string, cond: unknown): boolean {
  if (key === "$or") {
    return (cond as Array<Record<string, unknown>>).some((sub) =>
      matchDoc(doc, sub)
    );
  }

  const value = key.includes(".")
    ? getPath(doc, key)
    : (doc as Record<string, unknown>)[key];

  // Plain scalar equality. Mongo treats a MISSING field as equal to null, and
  // message search leans on that: `systemEvent: null` must also exclude rows
  // written before the column existed.
  if (cond === null) return value === null || value === undefined;
  if (typeof cond !== "object") return value === cond;

  const c = cond as Record<string, unknown>;

  // Extended-JSON value literals used as equality (createdAt == <date>).
  if ("$date" in c) {
    return value instanceof Date && value.getTime() === dateMs(c as never);
  }
  if ("$oid" in c) return value === (c as { $oid: string }).$oid;

  // Operator object.
  if ("$regex" in c) {
    return new RegExp(
      c.$regex as string,
      (c.$options as string | undefined) ?? ""
    ).test(String(value ?? ""));
  }
  if ("$exists" in c) {
    const exists = value !== undefined;
    return exists === (c.$exists as boolean);
  }
  if ("$ne" in c) {
    return Array.isArray(value) ? !value.includes(c.$ne) : value !== c.$ne;
  }
  // Range operators against createdAt (date) or _id (oid string).
  const cmp = (op: string, against: unknown): boolean => {
    if (
      against &&
      typeof against === "object" &&
      "$date" in (against as object)
    ) {
      const t = value instanceof Date ? value.getTime() : Number(value);
      const r = dateMs(against as { $date: string });
      if (op === "$lt") return t < r;
      if (op === "$lte") return t <= r;
      if (op === "$gt") return t > r;
      if (op === "$gte") return t >= r;
    }
    if (
      against &&
      typeof against === "object" &&
      "$oid" in (against as object)
    ) {
      const r = (against as { $oid: string }).$oid;
      if (op === "$lt") return String(value) < r;
      if (op === "$gt") return String(value) > r;
    }
    return false;
  };
  return Object.entries(c).every(([op, against]) => cmp(op, against));
}

export function matchDoc(doc: EmuDoc, match: Record<string, unknown>): boolean {
  return Object.entries(match).every(([k, v]) => matchField(doc, k, v));
}

/**
 * Build a fake PrismaClient exposing `<model>.aggregateRaw` and `<model>.findMany`
 * over an in-memory `docs` array. `model` must be the Prisma model accessor the
 * repo uses (e.g. "groupMessage", "privateMessage", "generalRoomMessage").
 */
export function makeTimelinePrisma(model: string, docs: EmuDoc[]) {
  const aggregateRaw = jest.fn(async ({ pipeline }: { pipeline: any[] }) => {
    // EVERY $match stage, not just the first: search emits the keyset bound as
    // its own stage so a caller-supplied `createdAt` cutoff in the base match is
    // not silently overwritten. Honouring only the first would page from the top
    // forever.
    const matches = pipeline
      .filter((s) => "$match" in s)
      .map((s) => s.$match as Record<string, unknown>);
    let rows = docs.filter((d) => matches.every((m) => matchDoc(d, m)));

    if (pipeline.find((s) => "$count" in s)) {
      return rows.length ? [{ total: rows.length }] : [];
    }

    const sort = pipeline.find((s) => "$sort" in s)?.$sort as
      | Record<string, number>
      | undefined;
    if (sort) {
      const entries = Object.entries(sort);
      rows = [...rows].sort((a, b) => {
        for (const [k, dir] of entries) {
          const av = k === "_id" ? a._id : (a[k] as Date).getTime();
          const bv = k === "_id" ? b._id : (b[k] as Date).getTime();
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
        }
        return 0;
      });
    }
    const limit = pipeline.find((s) => "$limit" in s)?.$limit as
      | number
      | undefined;
    if (limit != null) rows = rows.slice(0, limit);
    // Search projects createdAt and reads it back to build "<ms>_<id>"; the
    // timeline pipelines project neither, so they still see just the _id.
    const project = pipeline.find((s) => "$project" in s)?.$project as
      | Record<string, unknown>
      | undefined;
    return rows.map((d) =>
      project?.createdAt
        ? {
            _id: { $oid: d._id },
            createdAt: { $date: d.createdAt.toISOString() },
          }
        : { _id: { $oid: d._id } }
    );
  });

  const findMany = jest.fn(
    async ({ where }: { where: { id: { in: string[] } } }) => {
      const want = new Set(where.id.in);
      return docs
        .filter((d) => want.has(d._id))
        .map((d) => ({ ...d, id: d._id }));
    }
  );

  return { [model]: { aggregateRaw, findMany } };
}

/**
 * Walk a room's whole history newest→oldest via repeated `findByRoomIdTimeline`
 * calls, reconstructing and re-parsing the compound `"<ms>_<id>"` cursor exactly
 * as the service emits it and the controller parses it. Returns the collected
 * docs in retrieval order.
 */
export async function traverseHistory(
  repo: {
    findByRoomIdTimeline: (p: {
      userId: string;
      roomId: string;
      direction: "before" | "after";
      ts: Date;
      boundaryId?: string | null;
      inclusive?: boolean;
      limit: number;
    }) => Promise<{
      messages: Array<{ id: string; createdAt: Date }>;
      hasMore: boolean;
    }>;
  },
  args: { roomId: string; userId: string; limit: number }
): Promise<Array<{ id: string; createdAt: Date }>> {
  const collected: Array<{ id: string; createdAt: Date }> = [];
  let cursor: { ms: number; id: string } | null = null;
  let guard = 0;
  for (;;) {
    const { messages, hasMore } = await repo.findByRoomIdTimeline({
      userId: args.userId,
      roomId: args.roomId,
      direction: "before",
      ts: cursor ? new Date(cursor.ms) : new Date(9_000_000_000_000),
      boundaryId: cursor ? cursor.id : null,
      inclusive: cursor == null,
      limit: args.limit,
    });
    collected.push(...messages);
    if (!hasMore || messages.length === 0) break;
    const tail = messages[messages.length - 1]!;
    const nextCursor = `${tail.createdAt.getTime()}_${tail.id}`;
    const sep = nextCursor.indexOf("_");
    cursor = {
      ms: Number(nextCursor.slice(0, sep)),
      id: nextCursor.slice(sep + 1),
    };
    if (++guard > 10_000) throw new Error("runaway pagination");
  }
  return collected;
}

/**
 * Same as {@link traverseHistory} but the client echoes ONLY the bare millisecond
 * (`before_ts=<ms>` — it drops the `_id` tiebreaker, exactly as the bug report
 * does). With the snap-to-millisecond hardening this must STILL reach every
 * message without duplicates.
 */
export async function traverseHistoryBareMs(
  repo: {
    findByRoomIdTimeline: (p: {
      userId: string;
      roomId: string;
      direction: "before" | "after";
      ts: Date;
      boundaryId?: string | null;
      inclusive?: boolean;
      limit: number;
    }) => Promise<{
      messages: Array<{ id: string; createdAt: Date }>;
      hasMore: boolean;
    }>;
  },
  args: { roomId: string; userId: string; limit: number }
): Promise<Array<{ id: string; createdAt: Date }>> {
  const collected: Array<{ id: string; createdAt: Date }> = [];
  let ms: number | null = null;
  let guard = 0;
  for (;;) {
    const { messages, hasMore } = await repo.findByRoomIdTimeline({
      userId: args.userId,
      roomId: args.roomId,
      direction: "before",
      ts: ms != null ? new Date(ms) : new Date(9_000_000_000_000),
      boundaryId: null, // bare ms — NO _id tiebreaker
      inclusive: ms == null,
      limit: args.limit,
    });
    collected.push(...messages);
    if (!hasMore || messages.length === 0) break;
    ms = messages[messages.length - 1]!.createdAt.getTime(); // drop the _id
    if (++guard > 10_000) throw new Error("runaway pagination");
  }
  return collected;
}
