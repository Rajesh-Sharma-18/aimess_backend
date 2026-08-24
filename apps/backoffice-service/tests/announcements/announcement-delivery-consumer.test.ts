/**
 * handleAnnouncementDeliverMessage unit tests — calls the handler directly
 * (no real amqp connection or timers). Covers all-users single page, community
 * multi-page pagination, empty audience, duplicate-execution prevention (Redis
 * NX lock), and failed-job retry (attempt counter → FAILED after max).
 */
jest.mock("../../src/config/redis.js", () => ({
  redis: { set: jest.fn(), incr: jest.fn(), expire: jest.fn() },
}));
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: { adminListUsers: jest.fn() },
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: { adminListCommunityMembers: jest.fn() },
}));
jest.mock("../../src/repositories/announcement.repository.js", () => ({
  announcementRepository: {
    getStatus: jest.fn(async () => "PROCESSING"),
    incrementRecipientCount: jest.fn(async () => undefined),
    markSent: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => undefined) },
}));
jest.mock("../../src/messaging/publish-announcement-delivery.js", () => ({
  ANNOUNCEMENT_DELIVERY_QUEUE: "announcement.delivery.queue",
  publishAnnouncementDeliveryCursor: jest.fn(async () => undefined),
}));
jest.mock(
  "../../src/messaging/publish-notification-announcement-batch.js",
  () => ({
    publishNotificationAnnouncementBatch: jest.fn(async () => undefined),
  })
);

import { redis } from "../../src/config/redis.js";
import { authClient } from "../../src/grpc/auth.client.js";
import { communityClient } from "../../src/grpc/community.client.js";
import { announcementRepository } from "../../src/repositories/announcement.repository.js";
import { handleAnnouncementDeliverMessage } from "../../src/messaging/consume-announcement-delivery.js";
import { publishAnnouncementDeliveryCursor } from "../../src/messaging/publish-announcement-delivery.js";
import { publishNotificationAnnouncementBatch } from "../../src/messaging/publish-notification-announcement-batch.js";

const redisMock = redis as unknown as Record<string, jest.Mock>;
const auth = authClient as unknown as Record<string, jest.Mock>;
const community = communityClient as unknown as Record<string, jest.Mock>;
const repo = announcementRepository as unknown as Record<string, jest.Mock>;
const publishCursor = publishAnnouncementDeliveryCursor as jest.Mock;
const publishBatch = publishNotificationAnnouncementBatch as jest.Mock;

const AID = "3f2b6c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
const COMMUNITY_ID = "8b1e2c3d-4f5a-4b6c-9d0e-1f2a3b4c5d6e";

function baseMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    announcementId: AID,
    title: "Title",
    description: "Body",
    target: "ALL" as const,
    kind: "ANNOUNCEMENT" as const,
    deviceType: "ALL" as const,
    communityId: null,
    cursor: 0,
    limit: 100,
    batchId: `ann:${AID}:cursor:0`,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  redisMock.set.mockResolvedValue("OK");
  repo.getStatus.mockResolvedValue("PROCESSING");
});

describe("handleAnnouncementDeliverMessage", () => {
  it("all-users, single (short) page: publishes one batch, increments count, marks SENT, no re-publish", async () => {
    auth.adminListUsers.mockResolvedValue({
      users: [{ id: "u1" }, { id: "u2" }, { id: "u3" }],
      total: 3,
    });

    await handleAnnouncementDeliverMessage(baseMessage());

    expect(publishBatch).toHaveBeenCalledTimes(1);
    expect(publishBatch.mock.calls[0][0].userIds).toEqual(["u1", "u2", "u3"]);
    expect(repo.incrementRecipientCount).toHaveBeenCalledWith(AID, 3);
    expect(repo.markSent).toHaveBeenCalledWith(AID);
    expect(publishCursor).not.toHaveBeenCalled();
  });

  it("community, multi-page: re-publishes the next cursor on a full page, then marks SENT on the short page", async () => {
    community.adminListCommunityMembers.mockResolvedValueOnce({
      members: Array.from({ length: 100 }, (_, i) => ({ userId: `m${i}` })),
      total: 130,
    });

    await handleAnnouncementDeliverMessage(
      baseMessage({
        target: "COMMUNITY",
        communityId: COMMUNITY_ID,
        limit: 100,
      })
    );

    expect(publishCursor).toHaveBeenCalledTimes(1);
    expect(publishCursor.mock.calls[0][0]).toMatchObject({ cursor: 100 });
    expect(repo.markSent).not.toHaveBeenCalled();

    jest.clearAllMocks();
    redisMock.set.mockResolvedValue("OK");
    community.adminListCommunityMembers.mockResolvedValueOnce({
      members: Array.from({ length: 30 }, (_, i) => ({
        userId: `m${100 + i}`,
      })),
      total: 130,
    });

    await handleAnnouncementDeliverMessage(
      baseMessage({
        target: "COMMUNITY",
        communityId: COMMUNITY_ID,
        cursor: 100,
        limit: 100,
        batchId: `ann:${AID}:cursor:100`,
      })
    );

    expect(repo.markSent).toHaveBeenCalledWith(AID);
    expect(publishCursor).not.toHaveBeenCalled();
  });

  it("empty audience: marks SENT with recipientCount=0, no batch published, no cursor re-publish", async () => {
    auth.adminListUsers.mockResolvedValue({ users: [], total: 0 });

    await handleAnnouncementDeliverMessage(baseMessage());

    expect(repo.markSent).toHaveBeenCalledWith(AID);
    expect(publishBatch).not.toHaveBeenCalled();
    expect(publishCursor).not.toHaveBeenCalled();
    expect(repo.incrementRecipientCount).not.toHaveBeenCalled();
  });

  it("duplicate execution prevention: second call with the same batchId short-circuits before any gRPC/DB call", async () => {
    redisMock.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    auth.adminListUsers.mockResolvedValue({ users: [{ id: "u1" }], total: 1 });

    await handleAnnouncementDeliverMessage(baseMessage());
    await handleAnnouncementDeliverMessage(baseMessage());

    expect(auth.adminListUsers).toHaveBeenCalledTimes(1);
    expect(publishBatch).toHaveBeenCalledTimes(1);
  });

  it("failed job retry: below max attempts rethrows (nack/DLX path); at max attempts marks FAILED", async () => {
    auth.adminListUsers.mockRejectedValue(new Error("gRPC outage"));

    redisMock.incr.mockResolvedValueOnce(1);
    await expect(
      handleAnnouncementDeliverMessage(baseMessage())
    ).rejects.toThrow("gRPC outage");
    expect(repo.markFailed).not.toHaveBeenCalled();

    redisMock.incr.mockResolvedValueOnce(3);
    await handleAnnouncementDeliverMessage(baseMessage());
    expect(repo.markFailed).toHaveBeenCalledWith(AID, "gRPC outage");
  });
  it("cancelled between pages: stops the fan-out instead of delivering the rest", async () => {
    repo.getStatus.mockResolvedValue("CANCELLED");

    await handleAnnouncementDeliverMessage(baseMessage({ cursor: 100 }));

    expect(publishBatch).not.toHaveBeenCalled();
    expect(publishCursor).not.toHaveBeenCalled();
    expect(repo.markSent).not.toHaveBeenCalled();
  });
});
