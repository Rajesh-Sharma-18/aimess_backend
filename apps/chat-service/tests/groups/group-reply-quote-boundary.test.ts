/**
 * The reply QUOTE is a snapshot: the parent's sender and text are copied onto
 * the new message, persisted, and broadcast to the whole room. So the parent has
 * to be a message the SENDER may read — and `parentMessageId` is a client-chosen
 * id that nothing checked.
 *
 * Two ways that was abusable by an ordinary member with a normal session:
 *   - an id from ANOTHER group they are not in, whose content came back in the
 *     quote of a message everyone here then sees;
 *   - an id from before they joined THIS group, i.e. exactly the history the
 *     timeline, search, pins and media list already refuse them.
 *
 * Route: POST /api/chat/groups/rooms/:roomId/messages → orchestrator →
 * GroupMessageService.sendMessage.
 *
 *   npx jest group-reply-quote-boundary
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";
const OTHER_ROOM = "grp_room_2";
const PARENT_ID = "0123456789abcdef01234567";
const PEER = "peer_user_1";

const JOINED_AT = new Date("2026-01-10T10:00:00.000Z");
const BEFORE_JOIN = new Date("2026-01-10T09:00:00.000Z");
const AFTER_JOIN = new Date("2026-01-10T11:00:00.000Z");

const parent = (over: Record<string, unknown> = {}) => ({
  id: PARENT_ID,
  roomId: ROOM,
  senderId: PEER,
  senderName: "Old Member",
  messageType: "TEXT",
  content: { text: "history the new member may not read" },
  isDeleted: false,
  createdAt: AFTER_JOIN,
  ...over,
});

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    roomId: ROOM,
    userId: TEST_USER_ID,
    status: "ACTIVE",
    role: "MEMBER",
    joinedAt: JOINED_AT,
    clearedAt: null,
    clearChatAt: null,
  });
  mocks.groupMessageRepo.findByClientMessageId.mockResolvedValue(null);
  mocks.groupMessageRepo.findAlbumBatchByClientMessageId.mockResolvedValue([]);
  let created = 0;
  mocks.groupMessageRepo.create.mockImplementation(
    async (entity: Record<string, unknown>) => ({
      ...entity,
      id: `gmsg_${++created}`,
      createdAt: new Date(2000 + created),
    })
  );
});

const reply = (clientMessageId: string) =>
  request(app)
    .post(`/api/chat/groups/rooms/${ROOM}/messages`)
    .set(bearer(makeAccessToken()))
    .send({
      messageType: "TEXT",
      content: { text: "what did you mean?" },
      parentMessageId: PARENT_ID,
      clientMessageId,
    });

const created = (): Record<string, unknown>[] =>
  mocks.groupMessageRepo.create.mock.calls.map(
    (c: unknown[]) => c[0] as Record<string, unknown>
  );

describe("reply quote: only a parent the sender may read is snapshotted", () => {
  it("quotes a parent inside the sender's own history", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue(parent());

    const res = await reply("cmid-ok");

    expect(res.status).toBe(201);
    expect(created()[0]?.parentMessageId).toBe(PARENT_ID);
    expect(created()[0]?.quoteData).toMatchObject({ messageId: PARENT_ID });
  });

  // The send still succeeds — the reply is a legitimate message, it just has
  // nothing to quote. Failing it would leak the parent's existence instead.
  it("drops the quote AND the reference for a pre-join parent", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue(
      parent({ createdAt: BEFORE_JOIN })
    );

    const res = await reply("cmid-pre-join");

    expect(res.status).toBe(201);
    const row = created()[0] ?? {};
    expect(row.quoteData).toBeUndefined();
    expect(row.parentMessageId).toBeNull();
    // Nothing of the parent reached the persisted row, so nothing reaches the
    // broadcast either.
    expect(JSON.stringify(row)).not.toContain(
      "history the new member may not read"
    );
    expect(JSON.stringify(row)).not.toContain("Old Member");
  });

  it("drops the quote AND the reference for a parent in another room", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue(
      parent({ roomId: OTHER_ROOM })
    );

    const res = await reply("cmid-foreign-room");

    expect(res.status).toBe(201);
    const row = created()[0] ?? {};
    expect(row.quoteData).toBeUndefined();
    expect(row.parentMessageId).toBeNull();
    expect(JSON.stringify(row)).not.toContain(
      "history the new member may not read"
    );
  });
});
