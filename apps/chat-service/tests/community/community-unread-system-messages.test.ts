/**
 * Unread counts must ignore SYSTEM messages entirely (livestream start/end,
 * community metadata updates, etc.) — only user-generated chat messages may
 * raise a room's unread count. System messages still persist and remain
 * visible in chat history; this only affects the unread-count queries.
 *
 * Uses a tiny local aggregateRaw emulator (not tests/helpers/timeline-emulator,
 * which doesn't implement `$nin` — the operator countUnreadAfter's HIDDEN-type
 * exclusion depends on) covering exactly the operators countUnreadAfter emits:
 * plain equality, `$ne` (scalar/array), `$nin`, `$oid`, `$date`, and `$gt` on
 * createdAt.
 */
import { GeneralRoomMessageRepository } from "../../src/repositories/general-room-message.repository.js";

type Doc = {
  _id: string;
  roomId: string;
  createdAt: Date;
  deletedForAll: boolean;
  deletedBy: string[];
  sentBy: string;
  visibleToUserId: string | null;
  messageType: string;
  systemMessageType?: string | null;
};

function baseDoc(overrides: Partial<Doc> & { _id: string }): Doc {
  return {
    roomId: ROOM_ID,
    createdAt: new Date("2026-07-01T12:00:00.000Z"),
    deletedForAll: false,
    deletedBy: [],
    sentBy: SENDER_ID,
    visibleToUserId: null,
    messageType: "text",
    ...overrides,
  };
}

const ROOM_ID = "a".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SENDER_ID = "22222222-2222-4222-8222-222222222222";

function matchField(doc: Doc, key: string, cond: unknown): boolean {
  const value = (doc as Record<string, unknown>)[key];
  if (cond === null || typeof cond !== "object") return value === cond;
  const c = cond as Record<string, unknown>;
  if ("$oid" in c) return value === (c as { $oid: string }).$oid;
  if ("$date" in c) {
    const t = new Date((c as { $date: string }).$date).getTime();
    return value instanceof Date && value.getTime() === t;
  }
  if ("$ne" in c) {
    return Array.isArray(value) ? !value.includes(c.$ne) : value !== c.$ne;
  }
  if ("$nin" in c) {
    return !(c.$nin as unknown[]).includes(value as never);
  }
  if ("$gt" in c) {
    const against = c.$gt as { $date: string };
    const t = new Date(against.$date).getTime();
    return value instanceof Date && value.getTime() > t;
  }
  return false;
}

function matchDoc(doc: Doc, match: Record<string, unknown>): boolean {
  return Object.entries(match).every(([k, v]) => matchField(doc, k, v));
}

function makeRepo(docs: Doc[]): GeneralRoomMessageRepository {
  const aggregateRaw = jest.fn(async ({ pipeline }: { pipeline: any[] }) => {
    const match = pipeline.find((s) => "$match" in s)?.$match ?? {};
    const rows = docs.filter((d) => matchDoc(d, match));
    if (pipeline.find((s) => "$count" in s)) {
      return rows.length ? [{ total: rows.length }] : [];
    }
    return rows;
  });
  const prisma = { generalRoomMessage: { aggregateRaw } };
  return new GeneralRoomMessageRepository(prisma as never);
}

describe("countUnreadAfter excludes SYSTEM messages", () => {
  const afterDate = new Date("2026-07-01T00:00:00.000Z");

  it("counts a normal user-sent message", async () => {
    const repo = makeRepo([
      baseDoc({ _id: "1".repeat(24), messageType: "text" }),
    ]);
    const count = await repo.countUnreadAfter({
      roomId: ROOM_ID,
      userId: USER_ID,
      afterDate,
    });
    expect(count).toBe(1);
  });

  it("does NOT count a community-wide LIVE_STREAM_STARTED system message", async () => {
    const repo = makeRepo([
      baseDoc({
        _id: "2".repeat(24),
        messageType: "SYSTEM",
        systemMessageType: "LIVE_STREAM_STARTED",
      }),
    ]);
    const count = await repo.countUnreadAfter({
      roomId: ROOM_ID,
      userId: USER_ID,
      afterDate,
    });
    expect(count).toBe(0);
  });

  it("does NOT count a LIVE_STREAM_ENDED or COMMUNITY_NAME_UPDATED system message", async () => {
    const repo = makeRepo([
      baseDoc({
        _id: "3".repeat(24),
        messageType: "SYSTEM",
        systemMessageType: "LIVE_STREAM_ENDED",
      }),
      baseDoc({
        _id: "4".repeat(24),
        messageType: "SYSTEM",
        systemMessageType: "COMMUNITY_NAME_UPDATED",
      }),
    ]);
    const count = await repo.countUnreadAfter({
      roomId: ROOM_ID,
      userId: USER_ID,
      afterDate,
    });
    expect(count).toBe(0);
  });

  it("still excludes legacy HIDDEN system types (regression)", async () => {
    const repo = makeRepo([
      baseDoc({
        _id: "5".repeat(24),
        messageType: "SYSTEM",
        systemMessageType: "MEMBER_JOINED",
      }),
    ]);
    const count = await repo.countUnreadAfter({
      roomId: ROOM_ID,
      userId: USER_ID,
      afterDate,
    });
    expect(count).toBe(0);
  });

  it("counts only the user messages in a mixed batch", async () => {
    const repo = makeRepo([
      baseDoc({ _id: "6".repeat(24), messageType: "text" }),
      baseDoc({ _id: "7".repeat(24), messageType: "image" }),
      baseDoc({
        _id: "8".repeat(24),
        messageType: "SYSTEM",
        systemMessageType: "LIVE_STREAM_STARTED",
      }),
    ]);
    const count = await repo.countUnreadAfter({
      roomId: ROOM_ID,
      userId: USER_ID,
      afterDate,
    });
    expect(count).toBe(2);
  });
});
