/**
 * Regression coverage for the Message Search redesign.
 *
 * The original implementation paginated with `skip`, which degrades linearly
 * and shifts under concurrent inserts, so pages duplicated and dropped rows.
 * It now uses a `(createdAt, _id)` keyset cursor and a bounded top-k sort.
 *
 * Matching is a case-insensitive SUBSTRING regex, pinned to one room so the
 * `[roomId, createdAt desc]` compound index serves both the equality and the
 * sort. An earlier revision used `$text`, but the indexes were built with
 * `defaultLanguage: "none"`, so it matched whole tokens only — "test" missed
 * "Testing" and no prefix matched while the user was still typing.
 *
 * This suite exercises the three repositories directly (constructor-injected,
 * so a hand-rolled Prisma stub is enough) to lock in: substring matching with
 * the query escaped, keyset pagination (never `$skip`), the stable sort +
 * tiebreaker, compound `nextCursor`/`hasMore`, the per-user delete filter,
 * community's ObjectId `roomId`, and — for community rooms — that a page
 * shrunk by the in-memory visibility filter is refilled rather than silently
 * returned short.
 */

import { PrivateMessageRepository } from "../../src/repositories/private-message.repository.js";
import { GroupMessageRepository } from "../../src/repositories/group-message.repository.js";
import { GeneralRoomMessageRepository } from "../../src/repositories/general-room-message.repository.js";

const ROOM = "room-1";
const USER = "user-1";
const OTHER = "user-2";

function doc(id: string, text: string, over: Record<string, unknown> = {}) {
  return {
    id,
    roomId: ROOM,
    content: { text, urls: [], files: [] },
    createdAt: new Date(),
    isDeleted: false,
    deletedFor: {},
    ...over,
  };
}

function stage(pipeline: Record<string, unknown>[], key: string) {
  return pipeline.find((s) => s[key] !== undefined)?.[key];
}

describe("PrivateMessageRepository.searchByText", () => {
  function makeRepo() {
    const findRaw = jest.fn();
    const aggregateRaw = jest.fn();
    const findMany = jest.fn();
    const prisma = { privateMessage: { findRaw, aggregateRaw, findMany } };
    const repo = new PrivateMessageRepository(prisma as never);
    return { repo, findRaw, aggregateRaw, findMany };
  }

  it("matches as a case-insensitive substring, not a whole-token $text query", async () => {
    const { repo, aggregateRaw, findMany } = makeRepo();
    aggregateRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 20,
      userId: USER,
    });

    const pipeline = aggregateRaw.mock.calls[0][0].pipeline;
    expect(pipeline[0].$match["content.text"]).toEqual({
      $regex: "hello",
      $options: "i",
    });
    expect(JSON.stringify(pipeline)).not.toContain("$text");
  });

  it("escapes regex metacharacters so the query is matched literally", async () => {
    const { repo, aggregateRaw, findMany } = makeRepo();
    aggregateRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText({
      roomId: ROOM,
      query: "c++ (v2).*",
      limit: 20,
      userId: USER,
    });

    const match = aggregateRaw.mock.calls[0][0].pipeline[0].$match;
    expect(match["content.text"].$regex).toBe("c\\+\\+ \\(v2\\)\\.\\*");
    expect(new RegExp(match["content.text"].$regex).test("c++ (v2).*")).toBe(
      true
    );
    expect(new RegExp(match["content.text"].$regex).test("cxx v2 zz")).toBe(
      false
    );
  });

  it("sorts newest-first with an _id tiebreaker and bounds the page with top-k", async () => {
    const { repo, aggregateRaw, findMany } = makeRepo();
    aggregateRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 20,
      userId: USER,
    });

    const pipeline = aggregateRaw.mock.calls[0][0].pipeline;
    expect(stage(pipeline, "$sort")).toEqual({ createdAt: -1, _id: -1 });
    expect(stage(pipeline, "$limit")).toBe(21);
  });

  it("continues from the keyset cursor instead of a skip offset", async () => {
    const { repo, aggregateRaw, findMany } = makeRepo();
    aggregateRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 20,
      userId: USER,
      cursor: "1700000000000_507f1f77bcf86cd799439011",
    });

    const pipeline = aggregateRaw.mock.calls[0][0].pipeline;
    expect(JSON.stringify(pipeline)).not.toContain("$skip");
    const keyset = pipeline[1].$match.$or;
    expect(keyset).toHaveLength(2);
    expect(keyset[1]._id).toEqual({ $lt: { $oid: "507f1f77bcf86cd799439011" } });
  });

  it("hands back a compound nextCursor and hasMore only when the page overflows", async () => {
    const { repo, aggregateRaw, findMany } = makeRepo();
    const at = new Date("2024-01-01T00:00:00.000Z");
    aggregateRaw.mockResolvedValue([
      { _id: "m2", createdAt: { $date: at.toISOString() }, score: 2 },
      { _id: "m1", createdAt: { $date: at.toISOString() }, score: 1 },
    ]);
    findMany.mockResolvedValue([doc("m2", "hello"), doc("m1", "hello")]);

    const page = await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 1,
      userId: USER,
    });

    expect(page.messages.map((m) => m.id)).toEqual(["m2"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(`${at.getTime()}_m2`);
  });

  it("reports the last page with hasMore=false and a null cursor", async () => {
    const { repo, aggregateRaw, findMany } = makeRepo();
    const at = new Date("2024-01-01T00:00:00.000Z");
    aggregateRaw.mockResolvedValue([
      { _id: "m1", createdAt: { $date: at.toISOString() }, score: 1 },
    ]);
    findMany.mockResolvedValue([doc("m1", "hello")]);

    const page = await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 20,
      userId: USER,
    });

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("excludes messages the caller deleted-for-me", async () => {
    const { repo, aggregateRaw, findMany } = makeRepo();
    aggregateRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 20,
      userId: USER,
    });

    expect(aggregateRaw.mock.calls[0][0].pipeline[0].$match).toMatchObject({
      isDeleted: false,
      [`deletedFor.${USER}`]: { $exists: false },
    });
  });

  it("countSearchResults excludes deleted-for-me messages, matching searchByText", async () => {
    const { repo, aggregateRaw } = makeRepo();
    aggregateRaw.mockResolvedValue([{ total: 2 }]);

    const total = await repo.countSearchResults(ROOM, "hello", USER);

    expect(total).toBe(2);
    const match = aggregateRaw.mock.calls[0][0].pipeline[0].$match;
    expect(match).toMatchObject({
      isDeleted: false,
      [`deletedFor.${USER}`]: { $exists: false },
    });
  });
});

describe("GroupMessageRepository.searchByText", () => {
  function makeRepo() {
    const findRaw = jest.fn();
    const aggregateRaw = jest.fn();
    const findMany = jest.fn();
    const prisma = { groupMessage: { findRaw, aggregateRaw, findMany } };
    const repo = new GroupMessageRepository(prisma as never);
    return { repo, findRaw, aggregateRaw, findMany };
  }

  it("matches as a substring and paginates by keyset, not skip", async () => {
    const { repo, aggregateRaw, findMany } = makeRepo();
    aggregateRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 20,
      userId: USER,
      cursor: "1700000000000_507f1f77bcf86cd799439011",
    });

    const pipeline = aggregateRaw.mock.calls[0][0].pipeline;
    expect(pipeline[0].$match["content.text"]).toEqual({
      $regex: "hello",
      $options: "i",
    });
    expect(JSON.stringify(pipeline)).not.toContain("$skip");
    expect(JSON.stringify(pipeline)).not.toContain("$text");
  });

  it("excludes messages the caller deleted-for-me (deletedForUserIds)", async () => {
    const { repo, aggregateRaw, findMany } = makeRepo();
    aggregateRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 20,
      userId: USER,
    });

    expect(aggregateRaw.mock.calls[0][0].pipeline[0].$match).toMatchObject({
      isDeleted: false,
      deletedForUserIds: { $ne: USER },
    });
  });

  it("countSearchResults excludes deleted-for-me messages", async () => {
    const { repo, aggregateRaw } = makeRepo();
    aggregateRaw.mockResolvedValue([{ total: 0 }]);

    await repo.countSearchResults(ROOM, "hello", USER);

    const match = aggregateRaw.mock.calls[0][0].pipeline[0].$match;
    expect(match).toMatchObject({
      isDeleted: false,
      deletedForUserIds: { $ne: USER },
    });
  });
});

describe("GeneralRoomMessageRepository.searchByText (community)", () => {
  function makeRepo() {
    const findMany = jest.fn();
    const aggregateRaw = jest.fn();
    const prisma = { generalRoomMessage: { findMany, aggregateRaw } };
    const repo = new GeneralRoomMessageRepository(prisma as never);
    return { repo, findMany, aggregateRaw };
  }

  function rawDoc(id: string, ms: number) {
    return {
      _id: id,
      createdAt: { $date: new Date(ms).toISOString() },
      score: 1,
    };
  }

  it("matches roomId as an ObjectId, not a plain string", async () => {
    // `GeneralRoomMessage.roomId` is `@db.ObjectId`, so aggregateRaw must
    // compare it as `{ $oid }` — a plain string silently matched nothing and
    // made every community message search return an empty page. Private/group
    // pass a plain string because their `roomId` is a plain String column.
    const { repo, findMany, aggregateRaw } = makeRepo();
    aggregateRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 20,
      userId: USER,
    });

    const match = aggregateRaw.mock.calls[0][0].pipeline[0].$match;
    expect(match.roomId).toEqual({ $oid: ROOM });
  });

  it("refills a page that the in-memory visibility filter shrinks", async () => {
    const { repo, findMany, aggregateRaw } = makeRepo();
    const t0 = Date.parse("2024-01-01T00:00:00.000Z");
    aggregateRaw
      .mockResolvedValueOnce([
        rawDoc("m5", t0 + 5),
        rawDoc("m4", t0 + 4),
        rawDoc("m3", t0 + 3),
      ])
      .mockResolvedValueOnce([rawDoc("m2", t0 + 2), rawDoc("m1", t0 + 1)]);
    findMany
      .mockResolvedValueOnce([
        doc("m5", "hello 5", {
          deletedBy: [USER],
          createdAt: new Date(t0 + 5),
        }),
        doc("m4", "hello 4", {
          deletedBy: [USER],
          createdAt: new Date(t0 + 4),
        }),
      ])
      .mockResolvedValueOnce([
        doc("m2", "hello 2", { deletedBy: [], createdAt: new Date(t0 + 2) }),
        doc("m1", "hello 1", { deletedBy: [], createdAt: new Date(t0 + 1) }),
      ]);

    const page = await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 2,
      userId: USER,
    });

    expect(page.messages.map((m) => m.id)).toEqual(["m2", "m1"]);
    expect(aggregateRaw).toHaveBeenCalledTimes(2);
  });

  it("countSearchResults matches the same visibility filter as searchByText", async () => {
    const { repo, findMany } = makeRepo();
    findMany.mockResolvedValue([
      doc("m3", "hello 3", { deletedBy: [] }),
      doc("m2", "hello 2", { deletedBy: [USER] }),
      doc("m1", "hello 1", { deletedBy: [] }),
    ]);

    const total = await repo.countSearchResults(ROOM, "hello", USER);

    expect(total).toBe(2);
  });

  it("hides PERSONAL system messages targeted at another user from both search and count", async () => {
    const { repo, findMany, aggregateRaw } = makeRepo();
    const rows = [
      doc("m2", "hello", { visibleToUserId: OTHER }),
      doc("m1", "hello", { visibleToUserId: null }),
    ];
    aggregateRaw.mockResolvedValue([rawDoc("m2", 2), rawDoc("m1", 1)]);
    findMany.mockResolvedValue(rows);
    const results = await repo.searchByText({
      roomId: ROOM,
      query: "hello",
      limit: 20,
      userId: USER,
    });
    findMany.mockResolvedValue(rows);
    const total = await repo.countSearchResults(ROOM, "hello", USER);

    expect(results.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(total).toBe(1);
  });
});
