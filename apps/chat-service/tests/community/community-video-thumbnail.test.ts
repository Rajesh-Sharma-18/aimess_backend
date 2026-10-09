// Community video poster: thumbnailObjectKey must survive send and come back signed as thumbnailUrl.
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe: jest.fn(),
  buildPushPreview: jest.fn(() => "preview"),
  buildMessagePreview: jest.fn(() => "preview"),
}));

import { redis } from "../../src/config/redis.js";
import {
  createCommunityImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";

const ROOM_ID = "c".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const VIDEO = {
  objectKey: "chat/u1/video.mp4",
  thumbnailObjectKey: "chat/u1/video-poster.jpg",
  mime: "video/mp4",
  name: "video.mp4",
  size: 1000,
};
const row = {
  id: "m".repeat(24),
  roomId: ROOM_ID,
  sentBy: USER_ID,
  senderName: "Alice",
  message: "",
  messageType: "VIDEO",
  attachments: [VIDEO],
  createdAt: new Date("2026-07-06T10:00:00.000Z"),
  sequenceNumber: 7,
};

const expectSignedPoster = (file: Record<string, unknown>) => {
  expect(file.thumbnailObjectKey).toBe(VIDEO.thumbnailObjectKey);
  expect(file.thumbnailUrl).toEqual(
    expect.stringContaining(VIDEO.thumbnailObjectKey)
  );
  expect(file.thumbnailUrl).toMatch(/^https:\/\//);
};

describe("community video thumbnail", () => {
  it("socket send persists thumbnailObjectKey and broadcasts a signed thumbnailUrl", async () => {
    const sendMessage = jest.fn(async () => row);
    const deps = {
      cacheRepo: {},
      userSnapshotService: {
        getUserSnapshotsMap: jest.fn(async () => new Map()),
      },
      communityMessageService: {
        sendMessage,
        getActiveMemberIds: jest.fn(async () => []),
      },
    } as unknown as GrpcDeps;
    const publish = redis.publish as jest.Mock;
    publish.mockClear();

    await new Promise((resolve, reject) =>
      (
        createCommunityImpl(deps).sendCommunityMessage as (
          call: { request: unknown },
          cb: (err: unknown, res?: unknown) => void
        ) => void
      )(
        {
          request: {
            communityId: ROOM_ID,
            roomId: ROOM_ID,
            senderId: USER_ID,
            clientMessageId: "c1",
            message: "",
            contentType: "VIDEO",
            mediaKey: "",
            parentMessageId: "",
            attachmentsJson: JSON.stringify({ files: [VIDEO] }),
          },
        },
        (err, res) => (err ? reject(err) : resolve(res))
      )
    );

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            thumbnailObjectKey: VIDEO.thumbnailObjectKey,
          }),
        ],
      })
    );

    await new Promise((r) => setImmediate(r));
    const frame = publish.mock.calls
      .map(([, json]) => JSON.parse(json as string))
      .find((f) => f.event === "community:message:new");
    expectSignedPoster(frame.data.content.files[0]);
  });

  it("history and room media return thumbnailObjectKey + signed thumbnailUrl", async () => {
    const messageRepo = {
      findByRoomIdWithTime: jest.fn().mockResolvedValue([row]),
      listMedia: jest.fn().mockResolvedValue([row]),
    };
    const service = new CommunityMessageService(
      messageRepo as never,
      {
        findRoomById: jest
          .fn()
          .mockResolvedValue({ id: ROOM_ID, status: "active" }),
      } as never,
      {
        findByRoomAndUser: jest
          .fn()
          .mockResolvedValue({ status: "active", role: "member" }),
        findReadStatusByRoom: jest.fn().mockResolvedValue([]),
      } as never,
      {} as never,
      { getUserSnapshotsMap: jest.fn(async () => new Map()) } as never
    );

    const history = await service.getMessages({
      roomId: ROOM_ID,
      userId: USER_ID,
      limit: 30,
    });
    const media = await service.listMedia({
      roomId: ROOM_ID,
      userId: USER_ID,
      limit: 30,
    });

    for (const wire of [history[0], media[0]]) {
      const files = (wire as unknown as { attachments: unknown[] })
        .attachments as Array<Record<string, unknown>>;
      expectSignedPoster(files[0]);
    }
  });
});
