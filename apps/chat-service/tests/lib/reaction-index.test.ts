/**
 * Reaction-details pagination — the contract that keeps the popup bounded.
 *
 * The point of these is scale without the scale: a message with a million
 * reactions is asserted by making the INDEX report a million while the page
 * stays at `limit`, then checking that nothing downstream — the response, the
 * snapshot fan-out, the avatar presign batch — grew with the total. Building a
 * million rows would prove the same thing far more slowly.
 */
import {
  MessageReactionRepository,
  clampReactionLimit,
  REACTION_PAGE_MAX_LIMIT,
  REACTION_PAGE_DEFAULT_LIMIT,
} from "../../src/repositories/message-reaction.repository.js";
import {
  buildReactionDetailsPage,
  ensureReactionIndex,
  readReactionDetailsSlice,
} from "../../src/lib/reaction-index.js";

type Row = {
  userId: string;
  emoji: string;
  createdAt: Date;
  messageId: string;
  mediaIndex: number | null;
};

const BASE = new Date("2026-01-01T00:00:00.000Z");
const at = (offset: number) => new Date(BASE.getTime() + offset);

/** Reactors r0..rN-1, one millisecond apart, cycling through `emojis`. */
const reactors = (count: number, emojis = ["👍"]): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    userId: `u${i}`,
    emoji: emojis[i % emojis.length],
    createdAt: at(i),
    messageId: "m1",
    mediaIndex: null,
  }));

/**
 * In-memory stand-in for the `messageReaction` delegate. Honours the subset of
 * the query surface the repository actually uses, and records every call so the
 * tests can assert on the SHAPE of the query, not only its result — an offset
 * page would return the right rows here too.
 */
const fakePrisma = (rows: Row[]) => {
  const calls: { findMany: unknown[]; groupBy: unknown[] } = {
    findMany: [],
    groupBy: [],
  };
  const store = [...rows];
  return {
    calls,
    store,
    client: {
      messageReaction: {
        findMany: jest.fn(async (args: Record<string, any>) => {
          calls.findMany.push(args);
          const where = args.where ?? {};
          let out = store.filter((r) => !where.emoji || r.emoji === where.emoji);
          if (where.OR) {
            // The keyset is (createdAt, userId, messageId, mediaIndex); the fake
            // compares the same tuple so a cursor bug cannot pass here.
            const gt = where.OR[0].createdAt as { gt: Date };
            const tie = where.OR[1];
            out = out.filter(
              (r) =>
                r.createdAt.getTime() > gt.gt.getTime() ||
                (r.createdAt.getTime() === tie.createdAt.getTime() &&
                  r.userId > tie.userId.gt)
            );
          }
          out.sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.userId.localeCompare(b.userId) ||
              a.messageId.localeCompare(b.messageId) ||
              (a.mediaIndex ?? -1) - (b.mediaIndex ?? -1)
          );
          return out.slice(0, args.take);
        }),
        groupBy: jest.fn(async (args: Record<string, any>) => {
          calls.groupBy.push(args);
          const byEmoji = new Map<string, number>();
          for (const r of store)
            byEmoji.set(r.emoji, (byEmoji.get(r.emoji) ?? 0) + 1);
          return [...byEmoji].map(([emoji, count]) => ({
            emoji,
            _count: { _all: count },
          }));
        }),
        findFirst: jest.fn(async (args: Record<string, any>) => {
          const where = args.where ?? {};
          const hit = store.find(
            (r) =>
              r.userId === where.userId &&
              (r.mediaIndex ?? null) === (where.mediaIndex ?? null)
          );
          return hit ? { emoji: hit.emoji } : null;
        }),
        // The compound unique key contains a nullable column, so the repository
        // writes with updateMany-then-create rather than upsert; the fake mirrors
        // that, including leaving `createdAt` alone on an update.
        updateMany: jest.fn(async (args: Record<string, any>) => {
          const where = args.where ?? {};
          const hits = store.filter(
            (r) =>
              r.userId === where.userId &&
              (r.mediaIndex ?? null) === (where.mediaIndex ?? null)
          );
          for (const hit of hits) hit.emoji = args.data.emoji;
          return { count: hits.length };
        }),
        create: jest.fn(async (args: Record<string, any>) => {
          store.push({
            userId: args.data.userId,
            emoji: args.data.emoji,
            createdAt: at(store.length),
            messageId: args.data.messageId ?? "m1",
            mediaIndex: args.data.mediaIndex ?? null,
          });
          return {};
        }),
        deleteMany: jest.fn(async (args: Record<string, any>) => {
          // Honours every key it is given, so a message-scoped delete cannot
          // quietly behave like a user-scoped one (or vice versa).
          const where = args.where ?? {};
          let count = 0;
          for (let i = store.length - 1; i >= 0; i -= 1) {
            const row: Record<string, unknown> = { messageId: "m1", ...store[i] };
            // conversationType is always paired with messageId by the caller;
            // scoping by message is the property these tests care about.
            const keys = Object.entries(where).filter(
              ([k]) => k !== "conversationType"
            );
            if (keys.every(([k, v]) => row[k] === v)) {
              store.splice(i, 1);
              count += 1;
            }
          }
          return { count };
        }),
        createMany: jest.fn(async (args: Record<string, any>) => {
          store.push(...args.data);
          return { count: args.data.length };
        }),
      },
    } as any,
  };
};

const repoFor = (rows: Row[]) => {
  const fake = fakePrisma(rows);
  return { fake, repo: new MessageReactionRepository(fake.client) };
};

const PAGE_ARGS = {
  messageIds: ["m1"],
  conversationType: "COMMUNITY" as const,
};

describe("clampReactionLimit", () => {
  it("defaults when the caller asks for nothing", () => {
    expect(clampReactionLimit(undefined)).toBe(REACTION_PAGE_DEFAULT_LIMIT);
    expect(clampReactionLimit(0)).toBe(REACTION_PAGE_DEFAULT_LIMIT);
    expect(clampReactionLimit(-5)).toBe(REACTION_PAGE_DEFAULT_LIMIT);
  });

  it("caps a caller trying to page the whole message in one request", () => {
    expect(clampReactionLimit(10)).toBe(10);
    expect(clampReactionLimit(1_000_000)).toBe(REACTION_PAGE_MAX_LIMIT);
  });
});

describe("MessageReactionRepository.page", () => {
  it("returns a bounded first page and a cursor when more remain", async () => {
    const { repo } = repoFor(reactors(100));
    const page = await repo.page({ ...PAGE_ARGS, limit: 10 });

    expect(page.rows).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    // messageId and mediaIndex joined the tuple so a page can span a whole album
    // without two same-millisecond rows becoming ambiguous.
    expect(page.nextCursor).toBe(`${at(9).getTime()}|u9|m1|-1`);
  });

  it("asks for exactly one row past the page instead of a second count query", async () => {
    const { fake, repo } = repoFor(reactors(100));
    await repo.page({ ...PAGE_ARGS, limit: 10 });

    const args = fake.calls.findMany[0] as Record<string, any>;
    expect(args.take).toBe(11);
    expect(args.orderBy).toEqual([
      { createdAt: "asc" },
      { userId: "asc" },
      { messageId: "asc" },
      { mediaIndex: "asc" },
    ]);
  });

  it("resumes from the cursor without re-walking earlier pages", async () => {
    const { fake, repo } = repoFor(reactors(100));
    const first = await repo.page({ ...PAGE_ARGS, limit: 10 });
    const second = await repo.page({
      ...PAGE_ARGS,
      limit: 10,
      cursor: first.nextCursor,
    });

    expect(second.rows[0].userId).toBe("u10");
    expect(second.rows.map((r) => r.userId)).not.toContain("u9");
    // Keyset, not offset: the query carries a WHERE, never a skip.
    const args = fake.calls.findMany[1] as Record<string, any>;
    expect(args.skip).toBeUndefined();
    expect(args.where.OR).toBeDefined();
  });

  it("closes the page when the last row is reached", async () => {
    const { repo } = repoFor(reactors(10));
    const page = await repo.page({ ...PAGE_ARGS, limit: 10 });

    expect(page.rows).toHaveLength(10);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("is empty and terminal for a message nobody reacted to", async () => {
    const { repo } = repoFor([]);
    const page = await repo.page({ ...PAGE_ARGS, limit: 10 });

    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("never mixes filters: an emoji page contains only that emoji", async () => {
    const { repo } = repoFor(reactors(60, ["❤️", "👍", "😂"]));
    const page = await repo.page({ ...PAGE_ARGS, emoji: "👍", limit: 10 });

    expect(page.rows).toHaveLength(10);
    expect(page.rows.every((r) => r.emoji === "👍")).toBe(true);
  });

  it("clamps a caller asking for more than the page ceiling", async () => {
    const { fake, repo } = repoFor(reactors(500));
    const page = await repo.page({ ...PAGE_ARGS, limit: 10_000 });

    expect(page.rows).toHaveLength(REACTION_PAGE_MAX_LIMIT);
    expect((fake.calls.findMany[0] as Record<string, any>).take).toBe(
      REACTION_PAGE_MAX_LIMIT + 1
    );
  });

  it("walks a large reaction set page by page without skipping or repeating", async () => {
    const { repo } = repoFor(reactors(137));
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof repo.page>> = await repo.page({
        ...PAGE_ARGS,
        limit: 25,
        cursor,
      });
      seen.push(...page.rows.map((r) => r.userId));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
      if ((guard += 1) > 20) throw new Error("pagination did not terminate");
    }

    expect(seen).toHaveLength(137);
    expect(new Set(seen).size).toBe(137);
  });
});

describe("MessageReactionRepository.countsFor", () => {
  it("aggregates with a grouped query, highest count first", async () => {
    const { fake, repo } = repoFor([
      ...reactors(5, ["❤️"]),
      ...reactors(3, ["👍"]).map((r) => ({ ...r, userId: `a${r.userId}` })),
    ]);
    const counts = await repo.countsFor(["m1"], "COMMUNITY");

    expect(counts.total).toBe(8);
    expect(counts.byEmoji[0]).toEqual({ emoji: "❤️", count: 5 });
    expect(fake.calls.groupBy).toHaveLength(1);
  });
});

describe("readReactionDetailsSlice + buildReactionDetailsPage", () => {
  /** One page's worth of work, whatever the message's real total is. */
  const runSlice = async (total: number, limit: number) => {
    const { repo } = repoFor(reactors(total));
    const slice = await readReactionDetailsSlice(repo, {
      ...PAGE_ARGS,
      requesterId: "u3",
      limit,
    });
    const loadSnapshots = jest.fn(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [id, { displayName: `Name ${id}`, avatar: `k/${id}` }])
        )
    );
    const resolveAvatars = jest.fn(
      async (keys: string[]) =>
        new Map(keys.map((k) => [k, `https://media.test/${k}`]))
    );
    const page = await buildReactionDetailsPage({
      slice,
      loadSnapshots,
      resolveAvatars,
      resolveName: (snap) => (snap?.displayName as string) ?? "",
      urlFor: (map, key) => map.get(key) ?? "",
    });
    return { page, loadSnapshots, resolveAvatars };
  };

  it.each([1, 7, 100, 10_000, 1_000_000])(
    "reports the true total of %i while loading one page",
    async (total) => {
      const { page, loadSnapshots, resolveAvatars } = await runSlice(total, 25);

      expect(page.total).toBe(total);
      expect(page.users.length).toBeLessThanOrEqual(25);
      // The two fan-outs that would otherwise scale with the message: both see
      // the page only.
      expect(loadSnapshots.mock.calls[0]?.[0].length ?? 0).toBeLessThanOrEqual(
        25
      );
      expect(resolveAvatars.mock.calls[0][0].length).toBeLessThanOrEqual(25);
    },
    20_000
  );

  it("does not derive the header count from the loaded page", async () => {
    const { page } = await runSlice(10_000, 25);

    expect(page.users).toHaveLength(25);
    expect(page.total).toBe(10_000);
    expect(page.counts.reduce((n, c) => n + c.count, 0)).toBe(10_000);
    expect(page.hasMore).toBe(true);
  });

  it("names the caller's own reaction so the popup can offer to remove it", async () => {
    const { page } = await runSlice(50, 25);
    expect(page.selfEmoji).toBe("👍");
  });

  it("resolves avatars to URLs rather than raw object keys", async () => {
    const { page } = await runSlice(5, 25);
    expect(page.users[0].avatar).toBe("https://media.test/k/u0");
    expect(page.users[0].displayName).toBe("Name u0");
  });
});

describe("ensureReactionIndex", () => {
  const source = (indexedAt: Date | null) => ({
    id: "m1",
    roomId: "r1",
    reactions: {
      "❤️": [{ userId: "a" }, { userId: "b" }],
      "👍": [{ userId: "c" }],
    },
    createdAt: BASE,
    reactionsIndexedAt: indexedAt,
  });

  it("materializes a legacy row's stored map on first read, then stamps it", async () => {
    const { fake, repo } = repoFor([]);
    const stamp = jest.fn(async () => ({}));
    await ensureReactionIndex(repo, "PRIVATE", source(null), stamp);

    expect(fake.store.map((r) => r.userId).sort()).toEqual(["a", "b", "c"]);
    expect(stamp).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a row already indexed", async () => {
    const { fake, repo } = repoFor([]);
    const stamp = jest.fn(async () => ({}));
    await ensureReactionIndex(repo, "PRIVATE", source(BASE), stamp);

    expect(fake.store).toHaveLength(0);
    expect(stamp).not.toHaveBeenCalled();
  });

  it("leaves the read path alive when the projection cannot be built", async () => {
    const { fake, repo } = repoFor([]);
    fake.client.messageReaction.createMany.mockRejectedValueOnce(
      new Error("mongo down")
    );
    const stamp = jest.fn(async () => ({}));

    await expect(
      ensureReactionIndex(repo, "PRIVATE", source(null), stamp)
    ).resolves.toBeUndefined();
    // Not stamped, so the next read retries instead of caching the failure.
    expect(stamp).not.toHaveBeenCalled();
  });
});

describe("MessageReactionRepository.applyReactorChange", () => {
  it("replaces a user's emoji in place rather than adding a second row", async () => {
    const { fake, repo } = repoFor(reactors(3, ["👍"]));
    await repo.applyReactorChange({
      messageId: "m1",
      conversationType: "GROUP",
      roomId: "r1",
      userId: "u1",
      emoji: "❤️",
    });

    expect(fake.store).toHaveLength(3);
    expect(fake.store.find((r) => r.userId === "u1")?.emoji).toBe("❤️");
  });

  it("removes only the one reactor on a null emoji", async () => {
    const { fake, repo } = repoFor(reactors(3, ["👍"]));
    await repo.applyReactorChange({
      messageId: "m1",
      conversationType: "GROUP",
      roomId: "r1",
      userId: "u1",
      emoji: null,
    });

    expect(fake.store.map((r) => r.userId)).toEqual(["u0", "u2"]);
  });
});

/**
 * The count-inflation bug, as it actually happened.
 *
 * The write path populates the projection for any message that gets a reaction,
 * including one whose index has never been built. `materializeFromStoredMap`
 * then inserted the whole stored map on top of those rows, giving a second row
 * to every reactor who had arrived first. The popup read its counts off the
 * projection, so a message with seven real reactions reported ten — the exact
 * numbers in the report: `10 reactions`, with 🔥 😂 👏 each doubled to 2.
 */
describe("materializeFromStoredMap — no double counting", () => {
  /** The reported message: seven reactors, ❤️ twice, five other emoji once. */
  const storedMap = {
    "❤️": [{ userId: "u-self" }, { userId: "u-smiley" }],
    "👍": [{ userId: "u-tom" }],
    "👎": [{ userId: "u-kristi" }],
    "🔥": [{ userId: "u-iron" }],
    "😂": [{ userId: "u-spider" }],
    "👏": [{ userId: "u-clap" }],
  };

  const source = {
    id: "m1",
    roomId: "r1",
    reactions: storedMap,
    createdAt: BASE,
    reactionsIndexedAt: null,
  };

  const materialize = async (repo: MessageReactionRepository) =>
    ensureReactionIndex(repo, "COMMUNITY", source, async () => ({}));

  const totals = async (repo: MessageReactionRepository) =>
    repo.countsFor(["m1"], "COMMUNITY");

  it("counts each reactor once when the index starts empty", async () => {
    const { repo } = repoFor([]);
    await materialize(repo);

    const counts = await totals(repo);
    expect(counts.total).toBe(7);
    expect(Object.fromEntries(counts.byEmoji.map((c) => [c.emoji, c.count]))).toEqual({
      "❤️": 2,
      "👍": 1,
      "👎": 1,
      "🔥": 1,
      "😂": 1,
      "👏": 1,
    });
  });

  it("counts each reactor once when the write path got there first", async () => {
    const { fake, repo } = repoFor([]);
    // 🔥 😂 👏 reacted before the index was ever built — one row each, written
    // by applyReactorChange, exactly as in the reported message.
    for (const [userId, emoji] of [
      ["u-iron", "🔥"],
      ["u-spider", "😂"],
      ["u-clap", "👏"],
    ] as const) {
      await repo.applyReactorChange({
        messageId: "m1",
        conversationType: "COMMUNITY",
        roomId: "r1",
        userId,
        emoji,
      });
    }
    expect(fake.store).toHaveLength(3);

    await materialize(repo);

    const counts = await totals(repo);
    expect(counts.total).toBe(7);
    expect(counts.byEmoji.find((c) => c.emoji === "🔥")?.count).toBe(1);
    expect(counts.byEmoji.find((c) => c.emoji === "😂")?.count).toBe(1);
    expect(counts.byEmoji.find((c) => c.emoji === "👏")?.count).toBe(1);
  });

  it("gives every reactor exactly one row", async () => {
    const { fake, repo } = repoFor([]);
    await repo.applyReactorChange({
      messageId: "m1",
      conversationType: "COMMUNITY",
      roomId: "r1",
      userId: "u-iron",
      emoji: "🔥",
    });
    await materialize(repo);

    const ids = fake.store.map((r) => r.userId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is idempotent — rebuilding twice changes nothing", async () => {
    const { repo } = repoFor([]);
    await materialize(repo);
    const first = await totals(repo);
    await materialize(repo);

    expect(await totals(repo)).toEqual(first);
  });

  it("drops a reactor the stored map no longer has", async () => {
    const { fake, repo } = repoFor([]);
    await repo.applyReactorChange({
      messageId: "m1",
      conversationType: "COMMUNITY",
      roomId: "r1",
      userId: "u-ghost",
      emoji: "👻",
    });
    await materialize(repo);

    expect(fake.store.some((r) => r.userId === "u-ghost")).toBe(false);
    expect((await totals(repo)).total).toBe(7);
  });

  it("keeps the header total equal to the sum of the filter chips", async () => {
    const { repo } = repoFor([]);
    await repo.applyReactorChange({
      messageId: "m1",
      conversationType: "COMMUNITY",
      roomId: "r1",
      userId: "u-iron",
      emoji: "🔥",
    });
    await materialize(repo);

    const counts = await totals(repo);
    expect(counts.total).toBe(counts.byEmoji.reduce((n, c) => n + c.count, 0));
  });

  it("matches the message's own reaction summary reactor-for-reactor", async () => {
    const { repo } = repoFor([]);
    await materialize(repo);

    const counts = await totals(repo);
    const fromMap = Object.entries(storedMap).map(([emoji, list]) => ({
      emoji,
      count: list.length,
    }));
    expect(counts.total).toBe(fromMap.reduce((n, c) => n + c.count, 0));
    for (const { emoji, count } of fromMap) {
      expect(counts.byEmoji.find((c) => c.emoji === emoji)?.count).toBe(count);
    }
  });
});
