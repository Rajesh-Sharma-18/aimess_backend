/**
 * Send-time attachment verification gate.
 *
 * Covers the three properties `assertAttachmentsVerified` establishes — the
 * object passed the security pipeline, the sender uploaded it, and it was filed
 * under the room being posted to — plus the fail-closed behaviour on a
 * media-service outage.
 */

import { getMediaVerifyClient } from "../../src/grpc/media.client.js";
import { assertAttachmentsVerified } from "../../src/lib/attachment-guard.js";

const ROOM = "room-1";
const SENDER = "user-1";
const KEY = "chat-uploads/user-1/abc.png";

type Verdict = {
  objectKey: string;
  scanStatus: string;
  downloadable: boolean;
  ownerId: string;
  resourceId: string;
  contentType: string;
  size: number;
};

const client = getMediaVerifyClient();
const mockedCheck = jest.mocked(client.checkMediaStatus);

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  objectKey: KEY,
  scanStatus: "CLEAN",
  downloadable: true,
  ownerId: SENDER,
  resourceId: ROOM,
  contentType: "image/png",
  size: 100,
  ...over,
});

const respond = (...entries: Verdict[]): void => {
  mockedCheck.mockResolvedValue(new Map(entries.map((e) => [e.objectKey, e])));
};

const guard = (files: Array<Record<string, unknown>>) =>
  assertAttachmentsVerified({ resourceId: ROOM, senderId: SENDER, files });

beforeEach(() => {
  mockedCheck.mockReset();
  respond(verdict());
});

describe("assertAttachmentsVerified — happy path", () => {
  it("accepts a verified attachment owned by the sender and scoped to the room", async () => {
    await expect(guard([{ objectKey: KEY }])).resolves.toBeUndefined();
  });

  it("makes no round trip when there are no attachments", async () => {
    await expect(guard([])).resolves.toBeUndefined();
    await expect(
      assertAttachmentsVerified({
        resourceId: ROOM,
        senderId: SENDER,
        files: undefined,
      })
    ).resolves.toBeUndefined();
    expect(mockedCheck).not.toHaveBeenCalled();
  });

  it("passes external provider URLs straight through (Giphy/Tenor)", async () => {
    await expect(
      guard([{ url: "https://media.giphy.com/media/abc/giphy.gif" }])
    ).resolves.toBeUndefined();
    expect(mockedCheck).not.toHaveBeenCalled();
  });

  it("checks a video's poster frame as well as the video itself", async () => {
    const thumb = "chat-uploads/user-1/poster.jpg";
    respond(verdict(), verdict({ objectKey: thumb }));

    await guard([{ objectKey: KEY, thumbnailObjectKey: thumb }]);

    expect(mockedCheck).toHaveBeenCalledWith(
      expect.arrayContaining([KEY, thumb])
    );
  });

  it("de-duplicates repeated keys into a single batched lookup", async () => {
    await guard([{ objectKey: KEY }, { objectKey: KEY }]);
    expect(mockedCheck).toHaveBeenCalledWith([KEY]);
  });
});

describe("assertAttachmentsVerified — rejections", () => {
  it("rejects an object media-service has never seen (never confirmed)", async () => {
    mockedCheck.mockResolvedValue(new Map());
    await expect(guard([{ objectKey: KEY }])).rejects.toMatchObject({
      messageKey: "MEDIA_NOT_VERIFIED",
      statusCode: 400,
    });
  });

  it("rejects an object whose scan is still pending", async () => {
    respond(verdict({ scanStatus: "PENDING", downloadable: false }));
    await expect(guard([{ objectKey: KEY }])).rejects.toMatchObject({
      messageKey: "MEDIA_NOT_VERIFIED",
    });
  });

  it("rejects malware with a distinct code", async () => {
    respond(verdict({ scanStatus: "INFECTED", downloadable: false }));
    await expect(guard([{ objectKey: KEY }])).rejects.toMatchObject({
      messageKey: "MEDIA_MALWARE_DETECTED",
    });
  });

  it("rejects a structurally-rejected object with a distinct code", async () => {
    respond(verdict({ scanStatus: "REJECTED", downloadable: false }));
    await expect(guard([{ objectKey: KEY }])).rejects.toMatchObject({
      messageKey: "MEDIA_SECURITY_VALIDATION_FAILED",
    });
  });

  it("rejects an object uploaded by someone else", async () => {
    respond(verdict({ ownerId: "someone-else" }));
    await expect(guard([{ objectKey: KEY }])).rejects.toMatchObject({
      messageKey: "CHAT_MEDIA_FORBIDDEN",
    });
  });

  it("rejects an object filed under a different room", async () => {
    // Re-posting an attachment uploaded for room A into room B would hand it to
    // an entirely different audience.
    respond(verdict({ resourceId: "some-other-room" }));
    await expect(guard([{ objectKey: KEY }])).rejects.toMatchObject({
      messageKey: "CHAT_MEDIA_FORBIDDEN",
    });
  });

  it("allows an object with no recorded resourceId (avatars have none)", async () => {
    respond(verdict({ resourceId: "" }));
    await expect(guard([{ objectKey: KEY }])).resolves.toBeUndefined();
  });

  it("rejects the whole message when ANY attachment fails", async () => {
    const bad = "chat-uploads/user-1/bad.png";
    respond(
      verdict(),
      verdict({ objectKey: bad, downloadable: false, scanStatus: "REJECTED" })
    );

    await expect(
      guard([{ objectKey: KEY }, { objectKey: bad }])
    ).rejects.toMatchObject({ messageKey: "MEDIA_SECURITY_VALIDATION_FAILED" });
  });
});

describe("assertAttachmentsVerified — fail closed", () => {
  it("refuses the send with a retryable 503 when media-service is unreachable", async () => {
    // An inconclusive answer means "we do not know whether this file is safe",
    // which must not resolve to "send it anyway".
    mockedCheck.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));

    await expect(guard([{ objectKey: KEY }])).rejects.toMatchObject({
      messageKey: "MEDIA_REGISTRY_UNAVAILABLE",
      statusCode: 503,
    });
  });
});
