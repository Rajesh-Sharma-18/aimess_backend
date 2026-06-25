/**
 * CommunityMessageService.getModerationSnapshot — the moderation read backing
 * the report card. Reads the RAW message row (no URL resolution → RAW object
 * keys), normalizes the content type to UPPER, and enforces an IDOR scope on
 * roomId. Powers the new GetCommunityMessageById gRPC consumed by
 * community-service createReport.
 */
import { CommunityMessageService } from "../../src/services/community-message.service.js";

const ROOM = "c".repeat(24);
const MSG = "a".repeat(24);

function makeService(findById: jest.Mock): CommunityMessageService {
  const messageRepo = { findById } as never;
  return new CommunityMessageService(
    messageRepo,
    {} as never, // roomRepo
    {} as never, // memberRepo
    {} as never, // cacheRepo
    {} as never // userSnapshotService
  );
}

describe("CommunityMessageService.getModerationSnapshot", () => {
  it("returns text + RAW media object keys + UPPER contentType + postedAt", async () => {
    const svc = makeService(
      jest.fn(async () => ({
        id: MSG,
        roomId: ROOM,
        sentBy: "u1",
        message: "spam text",
        messageType: "image", // stored lowercase → normalized UPPER
        deletedForAll: false,
        attachments: [
          {
            objectKey: "community-chat/x.jpg",
            contentType: "image/jpeg",
            fileName: "x.jpg",
            size: 99,
            url: "https://signed/should-be-ignored", // resolved URL must NOT leak
          },
        ],
        createdAt: new Date("2026-02-02T10:00:00.000Z"),
      }))
    );

    const snap = await svc.getModerationSnapshot({
      roomId: ROOM,
      messageId: MSG,
    });

    expect(snap.found).toBe(true);
    expect(snap.message).toBe("spam text");
    expect(snap.contentType).toBe("IMAGE");
    expect(snap.sentAt).toBe(Date.parse("2026-02-02T10:00:00.000Z"));
    expect(snap.senderId).toBe("u1");
    expect(snap.media).toEqual([
      {
        objectKey: "community-chat/x.jpg",
        contentType: "image/jpeg",
        fileName: "x.jpg",
        size: 99,
      },
    ]);
  });

  it("found:false for a cross-room id (IDOR guard)", async () => {
    const svc = makeService(
      jest.fn(async () => ({
        id: MSG,
        roomId: "d".repeat(24),
        deletedForAll: false,
        attachments: [],
        createdAt: new Date(),
      }))
    );
    const snap = await svc.getModerationSnapshot({
      roomId: ROOM,
      messageId: MSG,
    });
    expect(snap.found).toBe(false);
  });

  it("found:false for a deleted-for-all message", async () => {
    const svc = makeService(
      jest.fn(async () => ({
        id: MSG,
        roomId: ROOM,
        deletedForAll: true,
        attachments: [],
        createdAt: new Date(),
      }))
    );
    const snap = await svc.getModerationSnapshot({
      roomId: ROOM,
      messageId: MSG,
    });
    expect(snap.found).toBe(false);
  });

  it("found:false when the message does not exist", async () => {
    const svc = makeService(jest.fn(async () => null));
    const snap = await svc.getModerationSnapshot({
      roomId: ROOM,
      messageId: MSG,
    });
    expect(snap.found).toBe(false);
    expect(snap.media).toEqual([]);
  });
});
