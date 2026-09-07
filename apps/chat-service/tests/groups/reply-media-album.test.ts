/**
 * Reply + media in a GROUP room — the group half of
 * `tests/private/reply-media-album.test.ts`.
 *
 * Same defect, same shape: a multi-file send is split one row per file
 * (`lib/split-media-album.ts`) and only row 0 was given the `quoteData` snapshot
 * clients render the quote from, so a multi-photo reply arrived quote-less.
 *
 * Route: POST /api/chat/groups/rooms/:roomId/messages → orchestrator →
 * GroupMessageService.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_1";
const PARENT_ID = "0123456789abcdef01234567";
const SENDER_PEER = "peer_user_1";

const file = (name: string) => ({
  objectKey: `chat-uploads/${TEST_USER_ID}/${name}`,
  mime: "image/jpeg",
  size: 1000,
});

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    roomId: ROOM,
    userId: TEST_USER_ID,
    status: "ACTIVE",
    role: "MEMBER",
  });
  mocks.groupMessageRepo.findByClientMessageId.mockResolvedValue(null);
  mocks.groupMessageRepo.findAlbumBatchByClientMessageId.mockResolvedValue([]);
  mocks.groupMessageRepo.findById.mockResolvedValue({
    id: PARENT_ID,
    roomId: ROOM,
    senderId: SENDER_PEER,
    messageType: "TEXT",
    content: { text: "which one?" },
    isDeleted: false,
  });
  let created = 0;
  mocks.groupMessageRepo.create.mockImplementation(
    async (entity: Record<string, unknown>) => ({
      ...entity,
      id: `gmsg_${++created}`,
      createdAt: new Date(2000 + created),
    })
  );
});

const createdEntities = (): Record<string, unknown>[] =>
  mocks.groupMessageRepo.create.mock.calls.map(
    (c: unknown[]) => c[0] as Record<string, unknown>
  );

describe("group reply + media album", () => {
  it("stamps parentMessageId AND quoteData on EVERY row of a multi-image reply", async () => {
    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({
        messageType: "IMAGE",
        content: { text: "", files: [file("a.jpg"), file("b.jpg")] },
        parentMessageId: PARENT_ID,
        clientMessageId: "cmid-group-album-reply",
      });

    expect(res.status).toBe(201);
    const rows = createdEntities();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.parentMessageId).toBe(PARENT_ID);
      expect(row.quoteData).toMatchObject({
        messageId: PARENT_ID,
        senderId: SENDER_PEER,
      });
    }
  });

  it("carries the reply through a voice send", async () => {
    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({
        messageType: "VOICE",
        content: {
          text: "",
          files: [{ ...file("note.webm"), mime: "audio/webm" }],
        },
        parentMessageId: PARENT_ID,
        clientMessageId: "cmid-group-voice-reply",
      });

    expect(res.status).toBe(201);
    const rows = createdEntities();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parentMessageId).toBe(PARENT_ID);
    expect(rows[0]?.quoteData).toMatchObject({ messageId: PARENT_ID });
  });
});
