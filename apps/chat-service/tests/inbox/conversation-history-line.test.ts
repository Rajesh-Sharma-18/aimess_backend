/**
 * Clear / Delete Conversation leave a "You cleared/deleted the conversation"
 * SYSTEM line in the caller's own transcript — and nowhere else.
 *
 * The action is local to the caller, so the line is persisted already hidden
 * from the peer (private `deletedFor`) / every other member (group
 * `deletedForUserIds`), stamped strictly after the caller's new history cutoff
 * (or their own cutoff filter would hide it), never bumps the shared room
 * snapshot, and is pushed on the caller's `user:` channel only — never on the
 * `conv:` room every participant has joined.
 *
 * Private Delete is the exception: it hides the row from the caller's list
 * until a newer message arrives, so it writes no line and emits `conv:deleted`
 * to the caller only. Group Delete keeps the row like clear.
 */
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));

import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { publishConvUpdatedSafe } from "../../src/events/publish-conv-updated.js";
import {
  buildGroupSystemFallbackText,
  buildPrivateSystemFallbackText,
} from "@aimess/constants";

const bump = publishConvUpdatedSafe as jest.Mock;

const ROOM = "prv_1";
const GROUP = "grp_1";
const PEER = "peer-1";
const CUTOFF = new Date("2026-09-29T10:00:00.000Z");

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  jest.clearAllMocks();
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

function published(): Array<[string, { event: string; data: any }]> {
  return (mocks.redis.publish as jest.Mock).mock.calls.map(
    ([channel, payload]: [string, string]) => [channel, JSON.parse(payload)]
  );
}

function stubPrivateRoom() {
  mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER],
  });
  mocks.privateRoomRepo.setClearFor.mockResolvedValue(CUTOFF);
  mocks.privateRoomRepo.setDeletedFor.mockResolvedValue(CUTOFF);
  mocks.privateMessageRepo.createMessage.mockImplementation(async (d: any) => ({
    id: "sys-1",
    ...d,
  }));
  mocks.privateMessageRepo.hasClearableAfter.mockResolvedValue(true);
}

describe.each([
  [
    "clear",
    "post",
    `/api/chat/private/rooms/${ROOM}/clear`,
    "CONVERSATION_CLEARED",
  ],
] as const)("private %s", (_name, method, url, systemEvent) => {
  it("writes a self-only line after the cutoff and keeps the row", async () => {
    stubPrivateRoom();

    const res = await request(app)[method](url).set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);

    expect(mocks.privateMessageRepo.createMessage).toHaveBeenCalledTimes(1);
    const row = mocks.privateMessageRepo.createMessage.mock.calls[0][0];
    expect(row).toMatchObject({ messageType: "SYSTEM", systemEvent });
    expect(Object.keys(row.deletedFor)).toEqual([PEER]);
    expect(row.createdAt.getTime()).toBeGreaterThan(CUTOFF.getTime());
    // Never the room's last message — for the peer it does not exist.
    expect(mocks.privateRoomRepo.updateRoomOnNewMessage).not.toHaveBeenCalled();

    const events = published();
    const lines = events.filter(([, e]) => e.event === "message:new");
    expect(lines.map(([c]) => c)).toEqual([`user:${TEST_USER_ID}`]);
    expect(events.some(([c]) => c === `user:${PEER}`)).toBe(false);
    expect(events.some(([, e]) => e.event === "conv:deleted")).toBe(false);
    const cleared = events.filter(
      ([c, e]) => c === `user:${TEST_USER_ID}` && e.event === "conv:cleared"
    );
    expect(cleared).toHaveLength(1);
    // The open transcript keeps only rows after this — the line survives any echo order.
    expect(cleared[0][1].data.clearedAt).toBe(CUTOFF.getTime());

    // The only list bump is the caller's own row, repainted with the line.
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientIds: [TEST_USER_ID],
        countInUnread: false,
        preview: expect.objectContaining({
          contentType: "SYSTEM",
          systemEvent,
        }),
      })
    );
  });
});

describe("private delete", () => {
  it("hides the row for the caller only — no line, conv:deleted to the caller", async () => {
    stubPrivateRoom();

    const res = await request(app)
      .delete(`/api/chat/private/rooms/${ROOM}`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);

    expect(mocks.privateRoomRepo.setDeletedFor).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID
    );
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
    expect(mocks.privateRoomRepo.updateRoomOnNewMessage).not.toHaveBeenCalled();
    expect(bump).not.toHaveBeenCalled();

    const events = published();
    expect(events.some(([c]) => c === `user:${PEER}`)).toBe(false);
    expect(events.some(([, e]) => e.event === "conv:cleared")).toBe(false);
    const deleted = events.filter(([, e]) => e.event === "conv:deleted");
    expect(deleted).toEqual([
      [
        `user:${TEST_USER_ID}`,
        {
          event: "conv:deleted",
          data: { roomId: ROOM, deletedBy: TEST_USER_ID, type: "PRIVATE" },
        },
      ],
    ]);
  });
});

describe.each([
  [
    "clear",
    "post",
    `/api/chat/groups/rooms/${GROUP}/clear`,
    "CONVERSATION_CLEARED",
  ],
  [
    "delete",
    "delete",
    `/api/chat/groups/rooms/${GROUP}`,
    "CONVERSATION_DELETED",
  ],
] as const)("group %s", (_name, method, url, systemEvent) => {
  it("hides the line from every other member and keeps membership", async () => {
    const member = { roomId: GROUP, userId: TEST_USER_ID, status: "ACTIVE" };
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(member);
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(member);
    mocks.groupMemberRepo.setClearChatAt.mockResolvedValue(CUTOFF);
    mocks.groupMemberRepo.setClearedAt.mockResolvedValue(CUTOFF);
    mocks.groupMemberRepo.findAllUserIds.mockResolvedValue([
      TEST_USER_ID,
      "m2",
      "m3",
    ]);
    mocks.groupMessageRepo.hasClearableAfter.mockResolvedValue(true);
    mocks.groupMessageRepo.create.mockImplementation(async (d: any) => ({
      id: "sys-g",
      createdAt: d.createdAt,
      ...d,
    }));

    const res = await request(app)[method](url).set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);

    const row = mocks.groupMessageRepo.create.mock.calls[0][0];
    expect(row).toMatchObject({ messageType: "SYSTEM", systemEvent });
    expect(row.deletedForUserIds).toEqual(["m2", "m3"]);
    expect(row.createdAt.getTime()).toBeGreaterThan(CUTOFF.getTime());
    expect(mocks.groupRoomRepo.updateLastMessage).not.toHaveBeenCalled();
    expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();

    const events = published();
    expect(
      events.filter(([, e]) => e.event === "message:new").map(([c]) => c)
    ).toEqual([`user:${TEST_USER_ID}`]);
    expect(events.some(([c]) => c.startsWith("conv:"))).toBe(false);
    expect(events.some(([, e]) => e.event === "conv:deleted")).toBe(false);
  });
});

describe("history line text", () => {
  it.each([
    ["CONVERSATION_CLEARED", "en", "You cleared the conversation"],
    ["CONVERSATION_DELETED", "en", "You deleted the conversation"],
    ["CONVERSATION_CLEARED", "vi", "Bạn đã xóa nội dung cuộc trò chuyện"],
    ["CONVERSATION_DELETED", "th", "คุณลบการสนทนาแล้ว"],
  ] as const)("%s in %s", (event, locale, text) => {
    expect(buildPrivateSystemFallbackText(event, {}, null, locale)).toBe(text);
    expect(buildGroupSystemFallbackText(event, {}, null, locale)).toBe(text);
  });
});
