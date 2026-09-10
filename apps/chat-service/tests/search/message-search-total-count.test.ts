/**
 * In-chat message search: the result list and the "1 of N results" counter must
 * answer the SAME question.
 *
 * The bug this locks down: searching a freshly joined group for "hi" reported
 * `totalCount: 2` and returned two rows, one of them the room's MEMBER_JOINED
 * line — which reads "You joined the group" and contains no "hi" at all. Two
 * independent faults, both here:
 *
 *  1. SYSTEM rows were searchable per-room. They are room events, not anybody's
 *     message, and the text stored on them is third-person English with a name
 *     baked in ("Asha joined the group") that NO viewer is ever shown — the read
 *     path re-renders the line per viewer and locale. So a member whose NAME
 *     contained the query dragged every lifecycle line they appear in into the
 *     results. The cross-room search in `message-search.repository.ts` already
 *     excluded them; only the three per-room paths did not.
 *  2. `countSearchResults` hand-wrote its own `$match` instead of sharing the
 *     one `searchByText` pages over, so nothing stopped the two from drifting.
 *
 * These run the REAL repositories against the in-memory Mongo emulator, so an
 * assertion here is about rows actually returned and counted, not pipeline shape.
 */

import { GroupMessageRepository } from "../../src/repositories/group-message.repository.js";
import { PrivateMessageRepository } from "../../src/repositories/private-message.repository.js";
import { GeneralRoomMessageRepository } from "../../src/repositories/general-room-message.repository.js";
import {
  makeTimelinePrisma,
  matchDoc,
  type EmuDoc,
} from "../helpers/timeline-emulator.js";

const ROOM = "room-1";
const USER = "user-1";
const T0 = Date.parse("2026-09-10T09:00:00.000Z");

/** 24-hex `_id`s — the cursor codec rejects anything else, so a fixture with
 *  short ids would silently never paginate. */
function oid(n: number): string {
  return String(n).padStart(24, "0");
}

// ── group ───────────────────────────────────────────────────────────────────

type Row = { text: string; systemEvent?: string; deletedForMe?: boolean };

function groupDocs(rows: Row[]): EmuDoc[] {
  return rows.map((r, i) => ({
    _id: oid(i + 1),
    roomId: ROOM,
    createdAt: new Date(T0 + i * 1000),
    content: { text: r.text, urls: [], files: [] },
    messageType: r.systemEvent ? "SYSTEM" : "TEXT",
    ...(r.systemEvent ? { systemEvent: r.systemEvent } : {}),
    isDeleted: false,
    deletedForUserIds: r.deletedForMe ? [USER] : [],
  }));
}

function groupRepo(rows: Row[]) {
  return new GroupMessageRepository(
    makeTimelinePrisma("groupMessage", groupDocs(rows)) as never
  );
}

/** One search plus its counter, the pair the controller answers with. */
async function searchGroup(rows: Row[], query: string, limit = 30) {
  const repo = groupRepo(rows);
  const page = await repo.searchByText({
    roomId: ROOM,
    query,
    limit,
    userId: USER,
  });
  const totalCount = await repo.countSearchResults(ROOM, query, USER);
  return { page, totalCount };
}

describe("group in-chat search — totalCount matches the results", () => {
  // The exact reproduction from the report.
  it("does not count the MEMBER_JOINED line as a hit for 'hi'", async () => {
    const { page, totalCount } = await searchGroup(
      [
        { text: "Hi" },
        { text: "Asha joined the group", systemEvent: "MEMBER_JOINED" },
      ],
      "hi"
    );

    expect(page.messages.map((m) => m.id)).toEqual([oid(1)]);
    expect(totalCount).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  // The mechanism behind the phantom hit: the query matched the NAME stored on a
  // lifecycle line, in text the viewer is never shown.
  it("does not match a system line because a member's name contains the query", async () => {
    const { page, totalCount } = await searchGroup(
      [
        { text: "Hi" },
        {
          text: "Abhishek joined the group",
          systemEvent: "MEMBER_JOINED",
        },
        { text: "Abhishek was added by Asha", systemEvent: "MEMBER_ADDED" },
      ],
      "hi"
    );

    expect(page.messages.map((m) => m.id)).toEqual([oid(1)]);
    expect(totalCount).toBe(1);
  });

  it("counts every genuine match, newest first", async () => {
    const { page, totalCount } = await searchGroup(
      [
        { text: "hi" },
        { text: "Hi there" },
        { text: "saying hi again" },
        { text: "unrelated" },
      ],
      "hi"
    );

    expect(page.messages.map((m) => m.content)).toEqual([
      expect.objectContaining({ text: "saying hi again" }),
      expect.objectContaining({ text: "Hi there" }),
      expect.objectContaining({ text: "hi" }),
    ]);
    expect(totalCount).toBe(3);
  });

  it("is case-insensitive — 'HI' finds what 'hi' finds", async () => {
    const rows: Row[] = [
      { text: "hi" },
      { text: "Hi there" },
      { text: "nope" },
    ];
    const lower = await searchGroup(rows, "hi");
    const upper = await searchGroup(rows, "HI");

    expect(upper.page.messages.map((m) => m.id)).toEqual(
      lower.page.messages.map((m) => m.id)
    );
    expect(upper.totalCount).toBe(lower.totalCount);
    expect(upper.totalCount).toBe(2);
  });

  it("reports an empty result set as 0, not as the room's message count", async () => {
    const { page, totalCount } = await searchGroup(
      [
        { text: "hi" },
        { text: "Asha joined the group", systemEvent: "MEMBER_JOINED" },
      ],
      "nonexistentkeyword"
    );

    expect(page.messages).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(totalCount).toBe(0);
  });

  it("excludes a message the caller deleted for themselves from both halves", async () => {
    const { page, totalCount } = await searchGroup(
      [{ text: "hi one" }, { text: "hi two", deletedForMe: true }],
      "hi"
    );

    expect(page.messages.map((m) => m.id)).toEqual([oid(1)]);
    expect(totalCount).toBe(1);
  });

  it("hides a delete-for-everyone row from both halves", async () => {
    const docs = groupDocs([{ text: "hi one" }, { text: "hi two" }]);
    docs[1]!.isDeleted = true;
    const repo = new GroupMessageRepository(
      makeTimelinePrisma("groupMessage", docs) as never
    );

    const page = await repo.searchByText({
      roomId: ROOM,
      query: "hi",
      limit: 30,
      userId: USER,
    });
    expect(page.messages.map((m) => m.id)).toEqual([oid(1)]);
    expect(await repo.countSearchResults(ROOM, "hi", USER)).toBe(1);
  });

  it("holds the total steady across pages and never pages past the matches", async () => {
    // 35 matches + system noise the counter must ignore on every page.
    const rows: Row[] = [];
    for (let i = 0; i < 35; i += 1) rows.push({ text: `hi ${i}` });
    rows.push({ text: "Asha joined the group", systemEvent: "MEMBER_JOINED" });
    const repo = groupRepo(rows);

    const total = await repo.countSearchResults(ROOM, "hi", USER);
    expect(total).toBe(35);

    const first = await repo.searchByText({
      roomId: ROOM,
      query: "hi",
      limit: 30,
      userId: USER,
    });
    expect(first.messages).toHaveLength(30);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await repo.searchByText({
      roomId: ROOM,
      query: "hi",
      limit: 30,
      userId: USER,
      cursor: first.nextCursor,
    });
    expect(second.messages).toHaveLength(5);
    expect(second.hasMore).toBe(false);

    // Every match reachable exactly once, and the total still describes the
    // whole set rather than the page in hand.
    const seen = [...first.messages, ...second.messages].map((m) => m.id);
    expect(new Set(seen).size).toBe(35);
    expect(await repo.countSearchResults(ROOM, "hi", USER)).toBe(total);
  });

  it("keeps a cutoff (cleared chat / join time) on both halves", async () => {
    const repo = groupRepo([{ text: "hi before" }, { text: "hi after" }]);
    const cutoff = new Date(T0 + 500); // between the two rows

    const page = await repo.searchByText({
      roomId: ROOM,
      query: "hi",
      limit: 30,
      userId: USER,
      cutoff,
    });
    expect(page.messages.map((m) => m.id)).toEqual([oid(2)]);
    expect(await repo.countSearchResults(ROOM, "hi", USER, cutoff)).toBe(1);
  });
});

// ── private ─────────────────────────────────────────────────────────────────

function privateDocs(rows: Row[]): EmuDoc[] {
  return rows.map((r, i) => ({
    _id: oid(i + 1),
    roomId: ROOM,
    createdAt: new Date(T0 + i * 1000),
    content: { text: r.text, urls: [], files: [] },
    messageType: r.systemEvent ? "SYSTEM" : "TEXT",
    ...(r.systemEvent ? { systemEvent: r.systemEvent } : {}),
    isDeleted: false,
    deletedFor: r.deletedForMe ? { [USER]: new Date() } : {},
  }));
}

describe("private in-chat search — totalCount matches the results", () => {
  function repoFor(rows: Row[]) {
    return new PrivateMessageRepository(
      makeTimelinePrisma("privateMessage", privateDocs(rows)) as never
    );
  }

  it("leaves DM system lines (call rows, lifecycle) out of results and total", async () => {
    const repo = repoFor([
      { text: "Hi" },
      { text: "Missed voice call", systemEvent: "CALL_ENDED" },
      {
        text: "Chinmay turned on disappearing messages",
        systemEvent: "AUTO_DELETE_UPDATED",
      },
    ]);

    const page = await repo.searchByText({
      roomId: ROOM,
      query: "hi",
      limit: 30,
      userId: USER,
    });
    expect(page.messages.map((m) => m.id)).toEqual([oid(1)]);
    expect(await repo.countSearchResults(ROOM, "hi", USER)).toBe(1);
  });

  it("counts matches, not the room", async () => {
    const repo = repoFor([
      { text: "hi" },
      { text: "Hi there" },
      { text: "unrelated" },
      { text: "hidden for me", deletedForMe: true },
    ]);

    const page = await repo.searchByText({
      roomId: ROOM,
      query: "hi",
      limit: 30,
      userId: USER,
    });
    expect(page.messages).toHaveLength(2);
    expect(await repo.countSearchResults(ROOM, "hi", USER)).toBe(2);
  });
});

// ── community ───────────────────────────────────────────────────────────────

type CommunityRow = { message: string; systemMessageType?: string };

function communityDocs(rows: CommunityRow[]): EmuDoc[] {
  return rows.map((r, i) => ({
    _id: oid(i + 1),
    roomId: ROOM,
    createdAt: new Date(T0 + i * 1000),
    message: r.message,
    deletedForAll: false,
    deletedBy: [],
    visibleToUserId: null,
    systemMessageType: r.systemMessageType ?? null,
    systemMetadata: null,
    sentBy: "someone",
  }));
}

/**
 * Community counts through Prisma's `findMany` rather than `aggregateRaw` (it
 * needs whole rows for the in-memory visibility filter), so the emulator's
 * raw-pipeline `findMany` cannot serve it alone. This adds the handful of Prisma
 * `where` operators the count actually emits.
 */
function communityPrisma(docs: EmuDoc[]) {
  const raw = makeTimelinePrisma("generalRoomMessage", docs).generalRoomMessage;
  const findMany = jest.fn(async (args: Record<string, unknown>) => {
    const where = (args.where ?? {}) as Record<string, never>;
    if ((where as { id?: { in?: string[] } }).id?.in) {
      return raw.findMany(args as never);
    }
    return docs
      .filter((d) =>
        Object.entries(where).every(([key, cond]) => {
          const c = cond as { contains?: string; lte?: Date } | null;
          if (key === "message" && c?.contains !== undefined) {
            return String(d.message ?? "")
              .toLowerCase()
              .includes(c.contains.toLowerCase());
          }
          if (key === "createdAt" && c?.lte !== undefined) {
            return (d.createdAt as Date) <= c.lte;
          }
          return matchDoc(d, { [key]: cond });
        })
      )
      .map((d) => ({ ...d, id: d._id }));
  });
  return { generalRoomMessage: { ...raw, findMany } };
}

describe("community in-chat search — totalCount matches the results", () => {
  it("leaves community system lines out of results and total", async () => {
    const repo = new GeneralRoomMessageRepository(
      communityPrisma(
        communityDocs([
          { message: "Hi" },
          {
            message: "Abhishek joined the community",
            systemMessageType: "COMMUNITY_JOINED",
          },
          { message: "unrelated" },
        ])
      ) as never
    );

    const page = await repo.searchByText({
      roomId: ROOM,
      query: "hi",
      limit: 30,
      userId: USER,
    });
    expect(page.messages.map((m) => m.id)).toEqual([oid(1)]);
    expect(await repo.countSearchResults(ROOM, "hi", USER)).toBe(1);
  });

  it("counts every genuine match and nothing else", async () => {
    const repo = new GeneralRoomMessageRepository(
      communityPrisma(
        communityDocs([
          { message: "hi" },
          { message: "Hi there" },
          { message: "saying hi again" },
          { message: "unrelated" },
          {
            message: "Asha joined the community",
            systemMessageType: "COMMUNITY_JOINED",
          },
        ])
      ) as never
    );

    const page = await repo.searchByText({
      roomId: ROOM,
      query: "hi",
      limit: 30,
      userId: USER,
    });
    expect(page.messages).toHaveLength(3);
    expect(await repo.countSearchResults(ROOM, "hi", USER)).toBe(3);
    expect(
      await repo.countSearchResults(ROOM, "nonexistentkeyword", USER)
    ).toBe(0);
  });
});
