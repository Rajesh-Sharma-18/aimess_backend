/**
 * Unit tests — CommunityMessageService: markMessageRead, getMessageReactions,
 * forwardMessage.
 *
 * All three methods were added in the community-messaging realtime flow sprint.
 * Tests use minimal inline mocks (matching the pattern in community-send-ban-guard.test.ts):
 *   - Real CommunityMessageService, constructor-injected mocked repos.
 *   - Redis is mocked via jest.mock so publish() is a no-op.
 *   - media-resolve is mocked to return an empty URL map (no MinIO/S3 needed).
 *
 * Coverage goals:
 *   markMessageRead     — happy path, membership-not-found throws, redis published
 *   getMessageReactions — happy path, returns grouped reactions, non-member throws
 *   forwardMessage      — happy path, delegates to sendMessage, deleted source throws
 */

// ---------------------------------------------------------------------------
// Mocks — must appear before imports (Jest hoisting)
// ---------------------------------------------------------------------------

// Redis publish — fire-and-forget, swallowed by catch in the service.
jest.mock("../../src/config/redis.js", () => ({
  redis: { publish: jest.fn().mockResolvedValue(1) },
}));

// Media resolve — return empty map so no S3 client is constructed.
jest.mock("../../src/lib/media-resolve.js", () => ({
  resolveMediaUrlMap: jest.fn().mockResolvedValue(new Map()),
  urlFromMap: jest.fn(
    (map: Map<string, string>, key: string) => map.get(key) ?? key
  ),
  applyUrlMapToFiles: jest.fn((files: unknown[]) => files),
  fileMediaKey: jest.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { ForbiddenError, NotFoundError, BadRequestError } from "@aimess/errors";
import { CommunityMessageService } from "../../src/services/community-message.service.js";
import { redis } from "../../src/config/redis.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ROOM_ID = "c".repeat(24);
const COMMUNITY_ID = ROOM_ID; // communityId === roomId for the General Room
const TARGET_ROOM_ID = "d".repeat(24);
const MESSAGE_ID = "m".repeat(24);
const READER_ID = "11111111-1111-4111-8111-111111111111";
const SENDER_ID = "22222222-2222-4222-8222-222222222222";

const redisMock = redis as { publish: jest.Mock };

// ---------------------------------------------------------------------------
// Builder: minimal repos for CommunityMessageService
// ---------------------------------------------------------------------------

function buildService(
  overrides: {
    messageRepo?: Partial<Record<string, jest.Mock>>;
    memberRepo?: Partial<Record<string, jest.Mock>>;
    roomRepo?: Partial<Record<string, jest.Mock>>;
    cacheRepo?: Partial<Record<string, jest.Mock>>;
    userSnapshotService?: Partial<Record<string, jest.Mock>>;
  } = {}
) {
  const messageRepo = {
    findById: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    ...overrides.messageRepo,
  };
  const memberRepo = {
    findByRoomAndUser: jest.fn(),
    advanceReadPointer: jest.fn().mockResolvedValue(undefined),
    findReadStatusByRoom: jest.fn().mockResolvedValue([]),
    findActiveByRoom: jest.fn().mockResolvedValue([]),
    findActiveByUserAndRooms: jest.fn().mockResolvedValue([]),
    bulkAdvanceReadToNow: jest.fn().mockResolvedValue(0),
    ...overrides.memberRepo,
  };
  const roomRepo = {
    findRoomById: jest
      .fn()
      .mockResolvedValue({ id: ROOM_ID, status: "active" }),
    allocateSequence: jest.fn().mockResolvedValue(1),
    addLastestMessageToRoom: jest.fn().mockResolvedValue(undefined),
    findManyByIds: jest.fn().mockResolvedValue([]),
    provisionForCommunity: jest.fn().mockResolvedValue(undefined),
    ...overrides.roomRepo,
  };
  const cacheRepo = {
    getMessageIdempotency: jest.fn().mockResolvedValue(null),
    setMessageIdempotency: jest.fn().mockResolvedValue(undefined),
    getUserSnapshots: jest.fn().mockResolvedValue(new Map()),
    ...overrides.cacheRepo,
  };
  const userSnapshotService = {
    getUserSnapshotsMap: jest.fn().mockResolvedValue(new Map()),
    resolve: jest.fn(),
    ...overrides.userSnapshotService,
  };

  const service = new CommunityMessageService(
    messageRepo as never,
    roomRepo as never,
    memberRepo as never,
    cacheRepo as never,
    userSnapshotService as never
  );

  return {
    service,
    messageRepo,
    memberRepo,
    roomRepo,
    cacheRepo,
    userSnapshotService,
  };
}

// ---------------------------------------------------------------------------
// Suite 1 — markMessageRead
// ---------------------------------------------------------------------------

describe("CommunityMessageService.markMessageRead", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("happy path: returns { ok, communityId, readAt } and publishes two Redis events", async () => {
    const { service, memberRepo } = buildService({
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue({ status: "active" }),
        advanceReadPointer: jest.fn().mockResolvedValue(undefined),
      },
      messageRepo: {
        findById: jest.fn().mockResolvedValue({
          id: MESSAGE_ID,
          roomId: ROOM_ID,
          createdAt: new Date(),
        }),
      },
    });

    const result = await service.markMessageRead({
      communityId: COMMUNITY_ID,
      roomId: ROOM_ID,
      readerId: READER_ID,
      upToMessageId: MESSAGE_ID,
    });

    expect(result.ok).toBe(true);
    expect(result.communityId).toBe(COMMUNITY_ID);
    expect(typeof result.readAt).toBe("number");
    expect(result.readAt).toBeGreaterThan(0);

    // advanceReadPointer called with the right args
    expect(memberRepo.advanceReadPointer).toHaveBeenCalledWith(
      ROOM_ID,
      READER_ID,
      MESSAGE_ID,
      expect.any(Date)
    );

    // Redis publish called twice (community broadcast + own-device sync)
    expect(redisMock.publish).toHaveBeenCalledTimes(2);

    // First publish: community room broadcast with community:message:read
    const communityCall = redisMock.publish.mock.calls.find(
      ([channel]: [string]) => channel === `community:${COMMUNITY_ID}`
    );
    expect(communityCall).toBeDefined();
    const communityPayload = JSON.parse(communityCall![1] as string);
    expect(communityPayload.event).toBe("community:message:read");
    expect(communityPayload.data.readerId).toBe(READER_ID);
    expect(communityPayload.data.communityId).toBe(COMMUNITY_ID);

    // Second publish: own-device sync via user:* channel with community:read_sync
    const userCall = redisMock.publish.mock.calls.find(
      ([channel]: [string]) => channel === `user:${READER_ID}`
    );
    expect(userCall).toBeDefined();
    const userPayload = JSON.parse(userCall![1] as string);
    expect(userPayload.event).toBe("community:read_sync");
    expect(userPayload.data.communityId).toBe(COMMUNITY_ID);
    expect(userPayload.data.upToMessageId).toBe(MESSAGE_ID);
  });

  it("throws ForbiddenError when reader is not an active member", async () => {
    const { service } = buildService({
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue(null),
      },
    });

    await expect(
      service.markMessageRead({
        communityId: COMMUNITY_ID,
        roomId: ROOM_ID,
        readerId: READER_ID,
        upToMessageId: MESSAGE_ID,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("throws ForbiddenError when reader status is 'banned'", async () => {
    const { service } = buildService({
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue({ status: "banned" }),
      },
    });

    await expect(
      service.markMessageRead({
        communityId: COMMUNITY_ID,
        roomId: ROOM_ID,
        readerId: READER_ID,
        upToMessageId: MESSAGE_ID,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("throws NotFoundError when the target message does not exist", async () => {
    const { service } = buildService({
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue({ status: "active" }),
        advanceReadPointer: jest.fn().mockResolvedValue(undefined),
      },
      messageRepo: {
        findById: jest.fn().mockResolvedValue(null),
      },
    });

    await expect(
      service.markMessageRead({
        communityId: COMMUNITY_ID,
        roomId: ROOM_ID,
        readerId: READER_ID,
        upToMessageId: "nonexistent-id",
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does NOT throw when Redis publish fails (fire-and-forget)", async () => {
    redisMock.publish.mockRejectedValue(new Error("Redis down"));

    const { service } = buildService({
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue({ status: "active" }),
        advanceReadPointer: jest.fn().mockResolvedValue(undefined),
      },
      messageRepo: {
        findById: jest.fn().mockResolvedValue({
          id: MESSAGE_ID,
          roomId: ROOM_ID,
          createdAt: new Date(),
        }),
      },
    });

    // Should NOT throw even though Redis is down (publish errors are caught internally).
    await expect(
      service.markMessageRead({
        communityId: COMMUNITY_ID,
        roomId: ROOM_ID,
        readerId: READER_ID,
        upToMessageId: MESSAGE_ID,
      })
    ).resolves.toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — markMessageDelivered
// ---------------------------------------------------------------------------

describe("CommunityMessageService.markMessageDelivered", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("happy path: returns { ok, communityId, deliveredAt } and publishes Redis broadcast", async () => {
    const { service } = buildService({
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue({ status: "active" }),
      },
    });

    const result = await service.markMessageDelivered({
      communityId: COMMUNITY_ID,
      roomId: ROOM_ID,
      recipientId: READER_ID,
      upToMessageId: MESSAGE_ID,
    });

    expect(result.ok).toBe(true);
    expect(result.communityId).toBe(COMMUNITY_ID);
    expect(typeof result.deliveredAt).toBe("number");
    expect(result.deliveredAt).toBeGreaterThan(0);

    // Redis publish called once on the community:<communityId> channel
    expect(redisMock.publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = redisMock.publish.mock.calls[0] as [
      string,
      string,
    ];
    expect(channel).toBe(`community:${COMMUNITY_ID}`);
    const parsed = JSON.parse(payload) as {
      event: string;
      data: Record<string, unknown>;
    };
    expect(parsed.event).toBe("community:message:delivered");
    expect(parsed.data.recipientId).toBe(READER_ID);
    expect(parsed.data.upToMessageId).toBe(MESSAGE_ID);
    expect(parsed.data.communityId).toBe(COMMUNITY_ID);
    expect(typeof parsed.data.deliveredAt).toBe("number");
  });

  it("throws ForbiddenError when recipient is not an active member", async () => {
    const { service } = buildService({
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue(null),
      },
    });

    await expect(
      service.markMessageDelivered({
        communityId: COMMUNITY_ID,
        roomId: ROOM_ID,
        recipientId: READER_ID,
        upToMessageId: MESSAGE_ID,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("throws ForbiddenError when recipient status is 'banned'", async () => {
    const { service } = buildService({
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue({ status: "banned" }),
      },
    });

    await expect(
      service.markMessageDelivered({
        communityId: COMMUNITY_ID,
        roomId: ROOM_ID,
        recipientId: READER_ID,
        upToMessageId: MESSAGE_ID,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Redis must NOT be called on auth failure
    expect(redisMock.publish).not.toHaveBeenCalled();
  });

  it("does NOT throw when Redis publish fails (fire-and-forget)", async () => {
    redisMock.publish.mockRejectedValue(new Error("Redis down"));

    const { service } = buildService({
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue({ status: "active" }),
      },
    });

    await expect(
      service.markMessageDelivered({
        communityId: COMMUNITY_ID,
        roomId: ROOM_ID,
        recipientId: READER_ID,
        upToMessageId: MESSAGE_ID,
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it("broadcast payload includes all required fields for the client delivery indicator", async () => {
    const { service } = buildService({
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue({ status: "active" }),
      },
    });

    await service.markMessageDelivered({
      communityId: COMMUNITY_ID,
      roomId: ROOM_ID,
      recipientId: SENDER_ID,
      upToMessageId: MESSAGE_ID,
    });

    const [, payload] = redisMock.publish.mock.calls[0] as [string, string];
    const parsed = JSON.parse(payload) as {
      event: string;
      data: Record<string, unknown>;
    };
    // All fields required by the FE to render ✓✓ must be present
    expect(parsed.data).toMatchObject({
      communityId: COMMUNITY_ID,
      recipientId: SENDER_ID,
      upToMessageId: MESSAGE_ID,
      deliveredAt: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — getMessageReactions
// ---------------------------------------------------------------------------

describe("CommunityMessageService.getMessageReactions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("happy path: returns grouped reactions for an active member", async () => {
    const storedReactions = {
      "👍": [
        { userId: READER_ID, userName: "Alice", avatar: "" },
        { userId: SENDER_ID, userName: "Bob", avatar: "" },
      ],
      "❤️": [{ userId: READER_ID, userName: "Alice", avatar: "" }],
    };

    const { service } = buildService({
      messageRepo: {
        findById: jest.fn().mockResolvedValue({
          id: MESSAGE_ID,
          roomId: ROOM_ID,
          reactions: storedReactions,
        }),
      },
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue({ status: "active" }),
        advanceReadPointer: jest.fn(),
        findReadStatusByRoom: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await service.getMessageReactions({
      messageId: MESSAGE_ID,
      communityId: COMMUNITY_ID,
      requesterId: READER_ID,
    });

    expect(result.messageId).toBe(MESSAGE_ID);
    expect(result.communityId).toBe(COMMUNITY_ID);
    expect(result.reactions).toHaveLength(2);

    const thumbsUp = result.reactions.find((r) => r.emoji === "👍");
    expect(thumbsUp).toBeDefined();
    expect(thumbsUp!.count).toBe(2);
    expect(thumbsUp!.users).toHaveLength(2);

    const heart = result.reactions.find((r) => r.emoji === "❤️");
    expect(heart).toBeDefined();
    expect(heart!.count).toBe(1);
  });

  it("returns empty reactions array when message has no reactions", async () => {
    const { service } = buildService({
      messageRepo: {
        findById: jest.fn().mockResolvedValue({
          id: MESSAGE_ID,
          roomId: ROOM_ID,
          reactions: {},
        }),
      },
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue({ status: "active" }),
        advanceReadPointer: jest.fn(),
        findReadStatusByRoom: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await service.getMessageReactions({
      messageId: MESSAGE_ID,
      communityId: COMMUNITY_ID,
      requesterId: READER_ID,
    });

    expect(result.reactions).toHaveLength(0);
  });

  it("throws NotFoundError when the message does not exist", async () => {
    const { service } = buildService({
      messageRepo: {
        findById: jest.fn().mockResolvedValue(null),
      },
    });

    await expect(
      service.getMessageReactions({
        messageId: "ghost-id",
        communityId: COMMUNITY_ID,
        requesterId: READER_ID,
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ForbiddenError for a non-member requester", async () => {
    const { service } = buildService({
      messageRepo: {
        findById: jest.fn().mockResolvedValue({
          id: MESSAGE_ID,
          roomId: ROOM_ID,
          reactions: {},
        }),
      },
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue(null),
        advanceReadPointer: jest.fn(),
        findReadStatusByRoom: jest.fn().mockResolvedValue([]),
      },
    });

    await expect(
      service.getMessageReactions({
        messageId: MESSAGE_ID,
        communityId: COMMUNITY_ID,
        requesterId: "outsider-id",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — forwardMessage
// ---------------------------------------------------------------------------

describe("CommunityMessageService.forwardMessage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const sourceMessage = {
    id: MESSAGE_ID,
    roomId: ROOM_ID,
    sentBy: SENDER_ID,
    senderName: "Alice",
    senderAvatar: "",
    message: "forwarded text",
    messageType: "TEXT",
    deletedForAll: false,
    attachments: null,
    createdAt: new Date(1_700_000_000_000),
  };

  const savedMessage = {
    id: "new-" + MESSAGE_ID,
    roomId: TARGET_ROOM_ID,
    sentBy: SENDER_ID,
    message: "forwarded text",
    messageType: "TEXT",
    createdAt: new Date(1_700_000_001_000),
  };

  it("happy path: fetches source, validates membership, delegates to sendMessage", async () => {
    const { service, messageRepo } = buildService({
      messageRepo: {
        findById: jest
          .fn()
          // First call: source message lookup
          .mockResolvedValueOnce(sourceMessage)
          // Second call inside sendMessage: parentMessageId lookup (none here)
          .mockResolvedValue(null),
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(savedMessage),
      },
      memberRepo: {
        // First call: target room membership check
        findByRoomAndUser: jest
          .fn()
          .mockResolvedValue({ status: "active", role: "member" }),
        advanceReadPointer: jest.fn(),
        findReadStatusByRoom: jest.fn().mockResolvedValue([]),
        findActiveByRoom: jest.fn().mockResolvedValue([]),
      },
      roomRepo: {
        findRoomById: jest
          .fn()
          .mockResolvedValue({ id: TARGET_ROOM_ID, status: "active" }),
        allocateSequence: jest.fn().mockResolvedValue(1),
        addLastestMessageToRoom: jest.fn().mockResolvedValue(undefined),
      },
    });

    const result = await service.forwardMessage({
      sourceMessageId: MESSAGE_ID,
      sourceCommunityId: COMMUNITY_ID,
      targetCommunityId: TARGET_ROOM_ID,
      targetRoomId: TARGET_ROOM_ID,
      senderId: SENDER_ID,
      clientMessageId: "fwd-client-001",
    });

    expect(result.messageId).toBe("new-" + MESSAGE_ID);
    expect(result.roomId).toBe(TARGET_ROOM_ID);
    expect(typeof result.sentAt).toBe("number");
    expect(result.sentAt).toBeGreaterThan(0);

    // sendMessage was called (proved by the save being called)
    expect(messageRepo.save).toHaveBeenCalledTimes(1);
    const saveArg = messageRepo.save.mock.calls[0][0];
    expect(saveArg.message).toBe("forwarded text");
    expect(saveArg.roomId).toBe(TARGET_ROOM_ID);
    expect(saveArg.sentBy).toBe(SENDER_ID);
  });

  it("throws NotFoundError when source message does not exist", async () => {
    const { service } = buildService({
      messageRepo: {
        findById: jest.fn().mockResolvedValue(null),
      },
    });

    await expect(
      service.forwardMessage({
        sourceMessageId: "ghost-msg",
        sourceCommunityId: COMMUNITY_ID,
        targetCommunityId: TARGET_ROOM_ID,
        targetRoomId: TARGET_ROOM_ID,
        senderId: SENDER_ID,
        clientMessageId: "fwd-002",
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws BadRequestError when source message is already deleted", async () => {
    const { service } = buildService({
      messageRepo: {
        findById: jest.fn().mockResolvedValue({
          ...sourceMessage,
          deletedForAll: true,
        }),
      },
    });

    await expect(
      service.forwardMessage({
        sourceMessageId: MESSAGE_ID,
        sourceCommunityId: COMMUNITY_ID,
        targetCommunityId: TARGET_ROOM_ID,
        targetRoomId: TARGET_ROOM_ID,
        senderId: SENDER_ID,
        clientMessageId: "fwd-003",
      })
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("throws ForbiddenError when sender is not an active member of target room", async () => {
    const { service } = buildService({
      messageRepo: {
        findById: jest.fn().mockResolvedValue(sourceMessage),
      },
      memberRepo: {
        findByRoomAndUser: jest.fn().mockResolvedValue(null),
        advanceReadPointer: jest.fn(),
        findReadStatusByRoom: jest.fn().mockResolvedValue([]),
      },
    });

    await expect(
      service.forwardMessage({
        sourceMessageId: MESSAGE_ID,
        sourceCommunityId: COMMUNITY_ID,
        targetCommunityId: TARGET_ROOM_ID,
        targetRoomId: TARGET_ROOM_ID,
        senderId: SENDER_ID,
        clientMessageId: "fwd-004",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("carries source attachments into the forwarded message", async () => {
    const attachment = {
      objectKey: "img.jpg",
      name: "img.jpg",
      size: 0,
      mime: "",
    };
    const { service, messageRepo } = buildService({
      messageRepo: {
        findById: jest
          .fn()
          .mockResolvedValueOnce({
            ...sourceMessage,
            attachments: [attachment],
          })
          .mockResolvedValue(null),
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(savedMessage),
      },
      memberRepo: {
        findByRoomAndUser: jest
          .fn()
          .mockResolvedValue({ status: "active", role: "member" }),
        advanceReadPointer: jest.fn(),
        findReadStatusByRoom: jest.fn().mockResolvedValue([]),
        findActiveByRoom: jest.fn().mockResolvedValue([]),
      },
      roomRepo: {
        findRoomById: jest
          .fn()
          .mockResolvedValue({ id: TARGET_ROOM_ID, status: "active" }),
        allocateSequence: jest.fn().mockResolvedValue(1),
        addLastestMessageToRoom: jest.fn().mockResolvedValue(undefined),
      },
    });

    await service.forwardMessage({
      sourceMessageId: MESSAGE_ID,
      sourceCommunityId: COMMUNITY_ID,
      targetCommunityId: TARGET_ROOM_ID,
      targetRoomId: TARGET_ROOM_ID,
      senderId: SENDER_ID,
      clientMessageId: "fwd-005",
    });

    const saveArg = messageRepo.save.mock.calls[0][0];
    expect(saveArg.attachments).toEqual([attachment]);
  });
});
