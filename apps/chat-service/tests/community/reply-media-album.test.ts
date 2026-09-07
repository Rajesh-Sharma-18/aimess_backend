/**
 * Reply + media in a COMMUNITY room — the community half of
 * `tests/private/reply-media-album.test.ts`.
 *
 * Same defect, same shape: a multi-file send is split one row per file
 * (`lib/split-media-album.ts`) and only row 0 was given the `quoteData` snapshot
 * clients render the quote from, so a multi-photo reply arrived quote-less.
 *
 * Route: POST /api/chat/community/rooms/:roomId/messages → CommunityMessageService.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const BASE = "/api/chat/community";
const ROOM = "comm_room_1";
const COMMUNITY = "comm_1";
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
  mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({ status: "active" });
  // The harness's `allocateSequenceAndRevisionBlock` default delegates here, so
  // an unstubbed proxy resolves undefined and the send dies inside `drain()`.
  let seq = 0;
  mocks.generalRoomRepo.allocateSequenceAndRevision.mockImplementation(
    async () => ({ sequenceNumber: ++seq, revision: seq })
  );
  mocks.generalRoomMessageRepo.findByClientMessageId.mockResolvedValue(null);
  mocks.generalRoomMessageRepo.findAlbumBatchByClientMessageId.mockResolvedValue(
    []
  );
  mocks.generalRoomMessageRepo.findById.mockResolvedValue({
    id: PARENT_ID,
    roomId: ROOM,
    sentBy: SENDER_PEER,
    senderId: SENDER_PEER,
    messageType: "text",
    message: "which one?",
    isDeleted: false,
  });
  let created = 0;
  mocks.generalRoomMessageRepo.save.mockImplementation(
    async (entity: Record<string, unknown>) => ({
      ...entity,
      id: `cmsg_${++created}`,
      createdAt: new Date(3000 + created),
    })
  );
});

const createdEntities = (): Record<string, unknown>[] =>
  mocks.generalRoomMessageRepo.save.mock.calls.map(
    (c: unknown[]) => c[0] as Record<string, unknown>
  );

describe("community reply + media album", () => {
  it("stamps parentMessageId AND quoteData on EVERY row of a multi-image reply", async () => {
    const res = await request(app)
      .post(`${BASE}/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({
        communityId: COMMUNITY,
        messageType: "image",
        message: "",
        media: { files: [file("a.jpg"), file("b.jpg")] },
        parentMessageId: PARENT_ID,
        clientMessageId: "cmid-community-album-reply",
      });

    expect([200, 201]).toContain(res.status);
    const rows = createdEntities();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.parentMessageId).toBe(PARENT_ID);
      expect(row.quoteData).toMatchObject({ messageId: PARENT_ID });
    }
  });
});
