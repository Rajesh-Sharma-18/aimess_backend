/**
 * `CommunityMessageService.sendMessage` — attachment/content-type guards, on
 * the same WRITE chokepoint as community-send-mute-guard.test.ts (gRPC
 * service-impl, REST orchestrator, and gateway socket → gRPC all funnel
 * through this one method, so these guards apply on every send surface).
 *
 * Covers the community-specific fix: an unsupported/unrecognized messageType
 * is rejected here too, mirroring the REST validator's
 * `.refine(isCommunityContentType)` — the gRPC/socket send path never ran
 * that Zod check, so a bogus type previously fell through to the DB write.
 */
import { BadRequestError } from "@aimess/errors";

import { CommunityMessageService } from "../../src/services/community-message.service.js";

const ROOM_ID = "c".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const MB = 1024 * 1024;

function buildService() {
  const messageRepo = { create: jest.fn(), findOne: jest.fn() };
  const roomRepo = {
    findRoomById: jest
      .fn()
      .mockResolvedValue({ id: ROOM_ID, status: "active" }),
  };
  const memberRepo = {
    findByRoomAndUser: jest.fn().mockResolvedValue({
      roomId: ROOM_ID,
      userId: USER_ID,
      status: "active",
      role: "member",
      isMuted: false,
      mutedUntil: null,
    }),
  };
  const cacheRepo = {
    getMessageIdempotency: jest.fn(),
    setMessageIdempotency: jest.fn(),
  };
  const userSnapshotService = { resolve: jest.fn() };

  return new CommunityMessageService(
    messageRepo as never,
    roomRepo as never,
    memberRepo as never,
    cacheRepo as never,
    userSnapshotService as never
  );
}

const baseParams = {
  roomId: ROOM_ID,
  sentBy: USER_ID,
  senderName: "John",
  senderAvatar: "",
  message: "hello",
};

describe("CommunityMessageService.sendMessage — content-type + media-limit guards", () => {
  it("rejects an unrecognized messageType as CHAT_UNSUPPORTED_CONTENT_TYPE", async () => {
    const service = buildService();
    await expect(
      service.sendMessage({ ...baseParams, messageType: "NOT_A_REAL_TYPE" })
    ).rejects.toMatchObject({
      messageKey: "CHAT_UNSUPPORTED_CONTENT_TYPE",
    });
    expect(service).toBeDefined();
  });

  it("rejects an audio attachment over 25 MB as CHAT_AUDIO_TOO_LARGE", async () => {
    const service = buildService();
    await expect(
      service.sendMessage({
        ...baseParams,
        messageType: "audio",
        attachments: [{ size: 30 * MB, mime: "audio/mpeg" }],
      })
    ).rejects.toMatchObject({ messageKey: "CHAT_AUDIO_TOO_LARGE" });
  });

  it("rejects a document attachment over 25 MB as CHAT_DOCUMENT_TOO_LARGE", async () => {
    const service = buildService();
    await expect(
      service.sendMessage({
        ...baseParams,
        messageType: "document",
        attachments: [{ size: 30 * MB, mime: "application/pdf" }],
      })
    ).rejects.toMatchObject({ messageKey: "CHAT_DOCUMENT_TOO_LARGE" });
  });

  it("does not reject a 40 MB video attached under the generic document type (validated by its real VIDEO cap)", async () => {
    const service = buildService();
    // 40 MB is over the 25 MB document cap but well under the 100 MB video
    // cap — proves validation is keyed by the file's detected type, not the
    // generic bucket it arrived in via a file picker. Downstream persistence
    // isn't fully mocked, so we only assert the media-limit guard itself
    // didn't fire with the (wrong) document code.
    const err: { messageKey?: string } | undefined = await service
      .sendMessage({
        ...baseParams,
        messageType: "document",
        attachments: [{ size: 40 * MB, mime: "video/mp4" }],
      })
      .then(() => undefined)
      .catch((e: unknown) => e as { messageKey?: string });
    expect(err?.messageKey).not.toBe("CHAT_DOCUMENT_TOO_LARGE");
  });

  it("still passes text-only sends through unaffected", async () => {
    const service = buildService();
    await service
      .sendMessage({ ...baseParams, messageType: "text" })
      .catch((err: unknown) => {
        expect(err).not.toBeInstanceOf(BadRequestError);
      });
  });
});
