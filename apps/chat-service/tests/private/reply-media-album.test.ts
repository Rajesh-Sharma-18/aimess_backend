/**
 * Reply + media: the quote snapshot must survive album splitting.
 *
 * A multi-file send is persisted as one row PER FILE (`lib/split-media-album.ts`).
 * `parentMessageId` was already stamped on every row — they are all replies to the
 * same message — but `quoteData`, the denormalized snapshot every client actually
 * RENDERS the quote from, was written only to row 0. Clients build a media collage
 * out of the batch and read the quote off its newest member, so a multi-photo reply
 * arrived with no quote at all; the `quoteData.preview` / `quoteData.isDeleted`
 * refresh sweeps (`lib/quote-refresh.ts`) also match on `parentMessageId`, so the
 * siblings were being $set into a half-built `quoteData` object later on.
 *
 * Route: POST /rooms/:roomId/messages → orchestrator → PrivateMessageService.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "prv_room_1";
const PEER = "peer_user_1";
// A reply parent id has to be a real 24-hex ObjectId — `resolveParentMessageId`
// drops anything else before it can reach the DB.
const PARENT_ID = "0123456789abcdef01234567";

const file = (name: string) => ({
  objectKey: `chat-uploads/${TEST_USER_ID}/${name}`,
  mime: "image/jpeg",
  size: 1000,
});

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
  mocks.privateMessageRepo.findByClientMessageId.mockResolvedValue(null);
  mocks.privateMessageRepo.findAlbumBatchByClientMessageId.mockResolvedValue([]);
  let created = 0;
  mocks.privateMessageRepo.createMessage.mockImplementation(
    async (entity: Record<string, unknown>) => ({
      ...entity,
      id: `msg_${++created}`,
      createdAt: new Date(1000 + created),
    })
  );
});

const send = (body: Record<string, unknown>) =>
  request(app)
    .post(`/api/chat/private/rooms/${ROOM}/messages`)
    .set(bearer(makeAccessToken()))
    .send({ receiverId: PEER, ...body });

const createdEntities = (): Record<string, unknown>[] =>
  mocks.privateMessageRepo.createMessage.mock.calls.map(
    (c: unknown[]) => c[0] as Record<string, unknown>
  );

describe("reply + media album", () => {
  it("stamps parentMessageId AND quoteData on EVERY row of a multi-image reply", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: PARENT_ID,
      senderId: PEER,
      messageType: "TEXT",
      content: { text: "which one?" },
      isDeleted: false,
    });

    const res = await send({
      messageType: "IMAGE",
      content: { text: "", files: [file("a.jpg"), file("b.jpg"), file("c.jpg")] },
      parentMessageId: PARENT_ID,
      clientMessageId: "cmid-album-reply",
    });

    expect(res.status).toBe(201);
    const rows = createdEntities();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.parentMessageId).toBe(PARENT_ID);
      // The RENDERED quote, not just the pointer — this is what row 1..n lacked.
      expect(row.quoteData).toMatchObject({
        messageId: PARENT_ID,
        senderId: PEER,
        isDeleted: false,
      });
    }
  });

  it("carries the reply through a single-file media send", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: PARENT_ID,
      senderId: PEER,
      messageType: "TEXT",
      content: { text: "look at this" },
      isDeleted: false,
    });

    const res = await send({
      messageType: "DOCUMENT",
      content: { text: "", files: [{ ...file("spec.pdf"), mime: "application/pdf" }] },
      parentMessageId: PARENT_ID,
      clientMessageId: "cmid-doc-reply",
    });

    expect(res.status).toBe(201);
    const rows = createdEntities();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parentMessageId).toBe(PARENT_ID);
    expect(rows[0]?.quoteData).toMatchObject({ messageId: PARENT_ID });
  });

  it("replies to a MEDIA parent as readily as to a text one (cross-type)", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: PARENT_ID,
      senderId: PEER,
      messageType: "IMAGE",
      clientMessageId: "their-album",
      content: { files: [{ objectKey: "theirs/1.jpg" }] },
      isDeleted: false,
    });
    // The parent is one row of a 3-photo album — the quote must count the whole
    // batch, not the single file this row happens to hold.
    mocks.privateMessageRepo.findAlbumBatchByClientMessageId.mockResolvedValue([
      { id: "p1" },
      { id: "p2" },
      { id: "p3" },
    ]);

    const res = await send({
      messageType: "TEXT",
      content: { text: "the second one" },
      parentMessageId: PARENT_ID,
      clientMessageId: "cmid-text-reply-to-album",
    });

    expect(res.status).toBe(201);
    const rows = createdEntities();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quoteData).toMatchObject({
      messageId: PARENT_ID,
      attachmentCount: 3,
    });
  });

  it("leaves quoteData off a media send that is not a reply", async () => {
    const res = await send({
      messageType: "IMAGE",
      content: { text: "", files: [file("a.jpg"), file("b.jpg")] },
      clientMessageId: "cmid-album-plain",
    });

    expect(res.status).toBe(201);
    const rows = createdEntities();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.parentMessageId).toBeNull();
      expect(row.quoteData).toBeUndefined();
    }
    expect(mocks.privateMessageRepo.findById).not.toHaveBeenCalled();
  });
});
