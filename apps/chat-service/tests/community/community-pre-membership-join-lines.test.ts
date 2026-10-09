// Join/add lines posted before the viewer's current join line stay hidden; the rest of community history does not.
import { GeneralRoomMessageRepository } from "../../src/repositories/general-room-message.repository.js";
import {
  makeTimelinePrisma,
  type EmuDoc,
} from "../helpers/timeline-emulator.js";

const ROOM = "c".repeat(24);
const VIEWER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BASE_MS = 1_700_000_000_000;

function row(
  n: number,
  over: { systemMessageType?: string; visibleToUserId?: string } = {}
): EmuDoc {
  return {
    _id: String(n).padStart(24, "0"),
    roomId: ROOM,
    createdAt: new Date(BASE_MS + n * 1000),
    updatedAt: new Date(BASE_MS + n * 1000),
    sequenceNumber: n,
    revision: n,
    deletedForAll: false,
    deletedBy: [] as string[],
    systemMessageType: over.systemMessageType ?? null,
    visibleToUserId: over.visibleToUserId ?? null,
    messageType: over.systemMessageType ? "SYSTEM" : "TEXT",
    message: "text",
  };
}

const PRE_JOIN_HISTORY = [
  row(1),
  row(2, { systemMessageType: "MEMBER_ADDED" }), // someone else added, before the viewer joined
  row(3, { systemMessageType: "MEMBER_ADDED" }), // the viewer's add in an earlier cycle
  row(4, { systemMessageType: "ROLE_CHANGED" }),
];
const CURRENT_SESSION = [
  row(5, { systemMessageType: "MEMBER_ADDED", visibleToUserId: VIEWER }),
  row(6, { systemMessageType: "MEMBER_ADDED" }),
  row(7),
  row(8, { systemMessageType: "MEMBER_ADDED" }),
];
const ROOM_ROWS = [...PRE_JOIN_HISTORY, ...CURRENT_SESSION];

/** Everything but the two pre-membership add lines (2, 3). */
const ADMIN_VISIBLE = ["1", "4", "5", "6", "7", "8"];

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => String(Number(r.id))).sort();
}

function repoOver(rows: EmuDoc[]) {
  const prisma = makeTimelinePrisma("generalRoomMessage", rows) as {
    generalRoomMessage: {
      findMany: (args: { where: Record<string, unknown> }) => Promise<unknown>;
    };
  };
  // The in-memory read paths (sync / changes feed) fetch the whole room, then filter.
  const byIds = prisma.generalRoomMessage.findMany;
  prisma.generalRoomMessage.findMany = jest.fn(async (args) =>
    args.where.id ? byIds(args) : rows.map((d) => ({ ...d, id: d._id }))
  );
  return new GeneralRoomMessageRepository(prisma as never);
}

const viewer = {
  roomId: ROOM,
  userId: VIEWER,
  viewerIsActiveMember: true,
  viewerRole: "admin",
};

describe("pre-membership join/add lines are withheld on every read path", () => {
  it("history page (timestamp axis)", async () => {
    const { messages } = await repoOver(ROOM_ROWS).findByRoomIdTimeline({
      ...viewer,
      direction: "before",
      ts: new Date(BASE_MS + 999_000),
      inclusive: true,
      limit: 30,
    });
    expect(ids(messages)).toEqual(ADMIN_VISIBLE);
  });

  it("count matches what pagination can reach", async () => {
    expect(await repoOver(ROOM_ROWS).countTimeline(viewer)).toBe(
      ADMIN_VISIBLE.length
    );
  });

  it("history page (sequence axis)", async () => {
    const { messages } = await repoOver(ROOM_ROWS).findByRoomIdSeq({
      ...viewer,
      direction: "before",
      seq: null,
      limit: 30,
    });
    expect(ids(messages)).toEqual(ADMIN_VISIBLE);
  });

  it("jump-to-message window around a pre-join anchor", async () => {
    const messages = await repoOver(ROOM_ROWS).findAroundSeq({
      ...viewer,
      anchorSeq: 2,
      limit: 30,
    });
    expect(ids(messages)).toEqual(ADMIN_VISIBLE);
  });

  it("reconnect catch-up (since id)", async () => {
    const { messages } = await repoOver(ROOM_ROWS).findSinceId({
      roomId: ROOM,
      userId: VIEWER,
      sinceId: "",
      limit: 30,
      viewerRole: "admin",
    });
    expect(ids(messages)).toEqual(ADMIN_VISIBLE);
  });

  it("changes feed (in-memory filter)", async () => {
    const { messages } = await repoOver(ROOM_ROWS).findByRoomIdRevisionSince({
      ...viewer,
      sinceRevision: 0,
      limit: 30,
    });
    expect(ids(messages)).toEqual(ADMIN_VISIBLE);
  });

  it("incremental sync (in-memory filter)", async () => {
    const { messages } = await repoOver(ROOM_ROWS).findUpdatedAtSince({
      ...viewer,
      fromTs: new Date(0),
      limit: 30,
    });
    expect(ids(messages)).toEqual(ADMIN_VISIBLE);
  });
});

describe("what the boundary must NOT touch", () => {
  it("keeps pre-join chat and unrelated system lines", async () => {
    const { messages } = await repoOver(ROOM_ROWS).findByRoomIdSeq({
      ...viewer,
      direction: "before",
      seq: null,
      limit: 30,
    });
    expect(ids(messages)).toEqual(expect.arrayContaining(["1", "4"]));
  });

  it("applies no boundary without a current join line (creator / legacy member)", async () => {
    const withoutJoinLine = ROOM_ROWS.filter((r) => r._id !== row(5)._id);
    const { messages } = await repoOver(withoutJoinLine).findByRoomIdSeq({
      ...viewer,
      direction: "before",
      seq: null,
      limit: 30,
    });
    expect(ids(messages)).toEqual(["1", "2", "3", "4", "6", "7", "8"]);
  });

  it("leaves another member's personal join line hidden from the viewer", async () => {
    const rows = [
      ...ROOM_ROWS,
      row(9, { systemMessageType: "COMMUNITY_JOINED", visibleToUserId: OTHER }),
    ];
    const { messages } = await repoOver(rows).findByRoomIdSeq({
      ...viewer,
      direction: "before",
      seq: null,
      limit: 30,
    });
    expect(ids(messages)).toEqual(ADMIN_VISIBLE);
  });

  it("a plain member still sees only their own current join line", async () => {
    const { messages } = await repoOver(ROOM_ROWS).findByRoomIdSeq({
      ...viewer,
      viewerRole: "member",
      direction: "before",
      seq: null,
      limit: 30,
    });
    expect(ids(messages)).toEqual(["1", "4", "5", "7"]);
  });
});
