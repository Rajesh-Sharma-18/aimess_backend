/**
 * Regression coverage for the Message Search fix.
 *
 * Root cause: `page` was parsed in every search controller but never turned
 * into a DB skip/offset — `searchByText` always returned the same first
 * `limit` window regardless of page, so any match beyond page 1 was
 * unreachable (and page 2+ silently duplicated page 1). A secondary bug: the
 * private/group repos never excluded messages the requesting user had
 * "deleted for me" (`deletedFor` / `deletedForUserIds`), while every other
 * read path for those rooms does — so search could resurrect messages the
 * user can no longer see anywhere else. This suite exercises the three
 * repositories directly (constructor-injected, so a hand-rolled Prisma stub
 * is enough) to lock in: skip/limit wiring, the per-user delete filter,
 * regex escaping of special characters, case-insensitivity, and — for
 * community rooms — that the in-memory-filtered pagination window and the
 * `countSearchResults` total both match what `searchByText` actually returns.
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

describe("PrivateMessageRepository.searchByText / countSearchResults", () => {
  function makeRepo() {
    const findRaw = jest.fn();
    const aggregateRaw = jest.fn();
    const findMany = jest.fn();
    const prisma = { privateMessage: { findRaw, aggregateRaw, findMany } };
    const repo = new PrivateMessageRepository(prisma as never);
    return { repo, findRaw, aggregateRaw, findMany };
  }

  it("forwards skip/limit so page > 1 does not repeat page 1", async () => {
    const { repo, findRaw, findMany } = makeRepo();
    findRaw.mockResolvedValue([{ _id: "m1" }]);
    findMany.mockResolvedValue([doc("m1", "hello")]);

    await repo.searchByText(ROOM, "hello", 20, USER, 20);

    expect(findRaw.mock.calls[0][0].options).toMatchObject({
      skip: 20,
      limit: 20,
    });
  });

  it("excludes messages the caller deleted-for-me", async () => {
    const { repo, findRaw, findMany } = makeRepo();
    findRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText(ROOM, "hello", 20, USER);

    expect(findRaw.mock.calls[0][0].filter).toMatchObject({
      isDeleted: false,
      [`deletedFor.${USER}`]: { $exists: false },
    });
  });

  it("escapes regex special characters in the query", async () => {
    const { repo, findRaw, findMany } = makeRepo();
    findRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText(ROOM, "c++ (v2.0)?", 20, USER);

    const sentRegex = findRaw.mock.calls[0][0].filter["content.text"].$regex;
    expect(sentRegex).toBe("c\\+\\+ \\(v2\\.0\\)\\?");
    expect(findRaw.mock.calls[0][0].filter["content.text"].$options).toBe("i");
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

describe("GroupMessageRepository.searchByText / countSearchResults", () => {
  function makeRepo() {
    const findRaw = jest.fn();
    const aggregateRaw = jest.fn();
    const findMany = jest.fn();
    const prisma = { groupMessage: { findRaw, aggregateRaw, findMany } };
    const repo = new GroupMessageRepository(prisma as never);
    return { repo, findRaw, aggregateRaw, findMany };
  }

  it("forwards skip/limit for pagination", async () => {
    const { repo, findRaw, findMany } = makeRepo();
    findRaw.mockResolvedValue([{ _id: "m1" }]);
    findMany.mockResolvedValue([doc("m1", "hello")]);

    await repo.searchByText(ROOM, "hello", 20, USER, 20);

    expect(findRaw.mock.calls[0][0].options).toMatchObject({
      skip: 20,
      limit: 20,
    });
  });

  it("excludes messages the caller deleted-for-me (deletedForUserIds)", async () => {
    const { repo, findRaw, findMany } = makeRepo();
    findRaw.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await repo.searchByText(ROOM, "hello", 20, USER);

    expect(findRaw.mock.calls[0][0].filter).toMatchObject({
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

describe("GeneralRoomMessageRepository.searchByText / countSearchResults (community)", () => {
  function makeRepo() {
    const findMany = jest.fn();
    const prisma = { generalRoomMessage: { findMany } };
    const repo = new GeneralRoomMessageRepository(prisma as never);
    return { repo, findMany };
  }

  it("returns the correct page after in-memory filtering (not just the first `limit`)", async () => {
    const { repo, findMany } = makeRepo();
    // 5 matches total; user 1 deleted-for-me the 2nd match — 4 visible.
    findMany.mockResolvedValue([
      doc("m5", "hello 5", { deletedBy: [] }),
      doc("m4", "hello 4", { deletedBy: [] }),
      doc("m3", "hello 3", { deletedBy: [USER] }), // hidden for USER
      doc("m2", "hello 2", { deletedBy: [] }),
      doc("m1", "hello 1", { deletedBy: [] }),
    ]);

    const page1 = await repo.searchByText(ROOM, "hello", 2, USER, true, 0);
    const page2 = await repo.searchByText(ROOM, "hello", 2, USER, true, 2);

    expect(page1.map((m) => m.id)).toEqual(["m5", "m4"]);
    // Page 2 must continue past the visible survivors of page 1 — not repeat
    // them, and not include the row USER deleted-for-me.
    expect(page2.map((m) => m.id)).toEqual(["m2", "m1"]);
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
    const { repo, findMany } = makeRepo();
    const rows = [
      doc("m2", "hello", { visibleToUserId: OTHER }),
      doc("m1", "hello", { visibleToUserId: null }),
    ];
    findMany.mockResolvedValue(rows);
    const results = await repo.searchByText(ROOM, "hello", 20, USER);
    findMany.mockResolvedValue(rows);
    const total = await repo.countSearchResults(ROOM, "hello", USER);

    expect(results.map((m) => m.id)).toEqual(["m1"]);
    expect(total).toBe(1);
  });
});
