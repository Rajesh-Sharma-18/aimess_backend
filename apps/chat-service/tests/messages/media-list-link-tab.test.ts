/**
 * Profile "Link" tab (`GET …/rooms/:roomId/media?type=link`) — AIMESS-480.
 *
 * Group and community had no `link` branch (the fix from 88bfacde was lost in a
 * merge), so the tab matched the literal type "link" / "__none__" and was always
 * empty. Private scanned only the newest limit×5 TEXT rows, so an older link
 * vanished behind newer chatter. All three now run the same regex in Mongo.
 * The REAL repository code runs against the in-memory Mongo emulator.
 */
import { GroupMessageRepository } from "../../src/repositories/group-message.repository.js";
import { PrivateMessageRepository } from "../../src/repositories/private-message.repository.js";
import { GeneralRoomMessageRepository } from "../../src/repositories/general-room-message.repository.js";
import {
  makeTimelinePrisma,
  type EmuDoc,
} from "../helpers/timeline-emulator.js";

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const BASE = Date.UTC(2026, 9, 1, 12, 0, 0);
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const oid = (n: number) => n.toString(16).padStart(24, "0");

/** Walk every page the way the controller does: next cursor = last row's createdAt. */
async function walk(
  list: (
    cursor: string | null
  ) => Promise<Array<{ id: string; createdAt: Date }>>,
  limit: number
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const page = await list(cursor);
    ids.push(...page.map((r) => r.id));
    if (page.length < limit) break;
    cursor = page[page.length - 1].createdAt.toISOString();
  }
  return ids;
}

describe("group Link tab", () => {
  const ROOM = "grp_room_480";
  const doc = (
    n: number,
    minutes: number,
    over: Partial<EmuDoc> = {}
  ): EmuDoc => ({
    _id: oid(n),
    roomId: ROOM,
    createdAt: at(minutes),
    isDeleted: false,
    deletedForUserIds: [],
    senderId: PEER,
    messageType: "TEXT",
    content: { text: `plain ${n}`, urls: [], files: [] },
    ...over,
  });

  function dataset(): EmuDoc[] {
    const docs: EmuDoc[] = [
      doc(1, 0, {
        content: {
          text: "@all Please update the Rexx app https://testflight.apple.com/join/3zqy7QXp",
          urls: [],
        },
      }),
      doc(2, 1, { content: { text: "see www.example.com", urls: [] } }),
      doc(3, 2, {
        content: { text: "preview only", urls: ["https://aimess.app"] },
      }),
      doc(4, 3, { content: { text: "HTTPS://UPPER.example" } }),
      doc(5, 4, {
        content: { text: "mine gone https://a.b" },
        deletedForUserIds: [ME],
      }),
      doc(6, 5, {
        content: { text: "everyone gone https://a.b" },
        isDeleted: true,
      }),
      doc(7, 6, {
        messageType: "IMAGE",
        content: { text: "caption https://a.b", files: [{}] },
      }),
      doc(8, 7, {
        messageType: "SYSTEM",
        content: { text: "joined via https://a.b" },
      }),
      doc(9, 8, {
        roomId: "grp_other",
        content: { text: "other room https://a.b" },
      }),
      doc(10, 9, {
        content: { text: "theirs gone https://a.b" },
        deletedForUserIds: [PEER],
      }),
    ];
    // 300 newer plain messages: far beyond the old limit×5 scan window.
    for (let i = 0; i < 300; i++) docs.push(doc(100 + i, 20 + i));
    return docs;
  }

  it("lists every visible link message newest first, however much plain text follows", async () => {
    const repo = new GroupMessageRepository(
      makeTimelinePrisma("groupMessage", dataset()) as never,
      {} as never
    );
    const rows = await repo.listMedia({
      roomId: ROOM,
      userId: ME,
      type: "link",
      limit: 30,
    });
    expect(rows.map((r) => r.id)).toEqual([
      oid(10),
      oid(4),
      oid(3),
      oid(2),
      oid(1),
    ]);
  });

  it("pages with the createdAt cursor without skipping or repeating", async () => {
    const repo = new GroupMessageRepository(
      makeTimelinePrisma("groupMessage", dataset()) as never,
      {} as never
    );
    const ids = await walk(
      (cursor) =>
        repo.listMedia({
          roomId: ROOM,
          userId: ME,
          type: "link",
          limit: 2,
          cursor,
        }),
      2
    );
    expect(ids).toEqual([oid(10), oid(4), oid(3), oid(2), oid(1)]);
  });

  it("respects the viewer's history window (join cutoff and removed-member ceiling)", async () => {
    const repo = new GroupMessageRepository(
      makeTimelinePrisma("groupMessage", dataset()) as never,
      {} as never
    );
    const rows = await repo.listMedia({
      roomId: ROOM,
      userId: ME,
      type: "link",
      limit: 30,
      cutoff: at(1),
      readCutoffBefore: at(3),
    });
    expect(rows.map((r) => r.id)).toEqual([oid(4), oid(3)]);
  });

  it("an empty room answers an empty page without a second query", async () => {
    const prisma = makeTimelinePrisma("groupMessage", []);
    const repo = new GroupMessageRepository(prisma as never, {} as never);
    expect(
      await repo.listMedia({
        roomId: ROOM,
        userId: ME,
        type: "link",
        limit: 30,
      })
    ).toEqual([]);
    expect(prisma.groupMessage.findMany).not.toHaveBeenCalled();
  });
});

describe("private Link tab", () => {
  const ROOM = "dm_room_480";
  const doc = (
    n: number,
    minutes: number,
    over: Partial<EmuDoc> = {}
  ): EmuDoc => ({
    _id: oid(n),
    roomId: ROOM,
    createdAt: at(minutes),
    isDeleted: false,
    deletedFor: {},
    senderId: PEER,
    messageType: "TEXT",
    content: { text: `plain ${n}`, urls: [], files: [] },
    ...over,
  });

  it("finds a link older than the newest limit×5 TEXT rows, honours delete-for-me and the clear cutoff", async () => {
    const docs: EmuDoc[] = [
      doc(1, 0, { content: { text: "before clear https://old.example" } }),
      doc(2, 2, {
        content: { text: "kept https://testflight.apple.com/join/x" },
      }),
      doc(3, 3, {
        content: { text: "hidden https://a.b" },
        deletedFor: { [ME]: BASE },
      }),
      doc(4, 4, {
        content: { text: "card only", urls: [{ url: "https://aimess.app" }] },
      }),
    ];
    for (let i = 0; i < 300; i++) docs.push(doc(100 + i, 20 + i));
    const repo = new PrivateMessageRepository(
      makeTimelinePrisma("privateMessage", docs) as never,
      {} as never
    );
    const rows = await repo.listMedia({
      roomId: ROOM,
      userId: ME,
      type: "link",
      limit: 30,
      cutoff: at(1),
    });
    expect(rows.map((r) => r.id)).toEqual([oid(4), oid(2)]);
  });
});

describe("community Link tab", () => {
  const ROOM = oid(4800);
  const doc = (
    n: number,
    minutes: number,
    over: Partial<EmuDoc> = {}
  ): EmuDoc => ({
    _id: oid(n),
    roomId: ROOM,
    createdAt: at(minutes),
    deletedForAll: false,
    deletedBy: [],
    sentBy: PEER,
    messageType: "TEXT",
    message: `plain ${n}`,
    ...over,
  });

  function dataset(): EmuDoc[] {
    const docs: EmuDoc[] = [
      doc(1, 0, { message: "join https://testflight.apple.com/join/3zqy7QXp" }),
      doc(2, 1, { messageType: "text", message: "legacy row www.example.com" }),
      doc(3, 2, { message: "mine gone https://a.b", deletedBy: [ME] }),
      doc(4, 3, { message: "everyone gone https://a.b", deletedForAll: true }),
      doc(5, 4, {
        message: "for someone else https://a.b",
        visibleToUserId: PEER,
      }),
      doc(6, 5, { messageType: "IMAGE", message: "caption https://a.b" }),
      doc(7, 6, { message: "other room https://a.b", roomId: oid(9999) }),
      doc(8, 7, { message: "no link here" }),
    ];
    for (let i = 0; i < 300; i++) docs.push(doc(100 + i, 20 + i));
    return docs;
  }

  it("lists the viewer's link messages (both TEXT spellings) newest first", async () => {
    const repo = new GeneralRoomMessageRepository(
      makeTimelinePrisma("generalRoomMessage", dataset()) as never
    );
    const rows = await repo.listMedia({
      roomId: ROOM,
      userId: ME,
      type: "link",
      limit: 30,
    });
    expect(rows.map((r) => r.id)).toEqual([oid(2), oid(1)]);
  });

  it("a banned viewer's read cutoff caps the list", async () => {
    const repo = new GeneralRoomMessageRepository(
      makeTimelinePrisma("generalRoomMessage", dataset()) as never
    );
    const rows = await repo.listMedia({
      roomId: ROOM,
      userId: ME,
      type: "link",
      limit: 30,
      readCutoff: at(0),
    });
    expect(rows.map((r) => r.id)).toEqual([oid(1)]);
  });

  it("pages with the createdAt cursor", async () => {
    const repo = new GeneralRoomMessageRepository(
      makeTimelinePrisma("generalRoomMessage", dataset()) as never
    );
    const ids = await walk(
      (cursor) =>
        repo.listMedia({
          roomId: ROOM,
          userId: ME,
          type: "link",
          limit: 1,
          cursor,
        }),
      1
    );
    expect(ids).toEqual([oid(2), oid(1)]);
  });
});
