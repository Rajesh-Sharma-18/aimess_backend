/**
 * announcementService unit tests — repository, gRPC community client, the
 * delivery publisher, and audit logging are all mocked so we can assert the
 * service's orchestration in isolation (immediate vs scheduled, invalid
 * community, community-target success).
 */
jest.mock("../../src/repositories/index.js", () => ({
  announcementRepository: {
    create: jest.fn(),
    getById: jest.fn(),
  },
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: {
    adminGetCommunity: jest.fn(),
  },
}));
jest.mock("../../src/messaging/publish-announcement-delivery.js", () => ({
  enqueueAnnouncementDeliverySafe: jest.fn(),
}));
jest.mock("../../src/services/audit.service.js", () => ({
  auditService: { record: jest.fn(async () => undefined) },
}));

import { NotFoundError } from "@aimess/errors";

import { announcementService } from "../../src/services/announcement.service.js";
import { announcementRepository } from "../../src/repositories/index.js";
import { communityClient } from "../../src/grpc/community.client.js";
import { enqueueAnnouncementDeliverySafe } from "../../src/messaging/publish-announcement-delivery.js";

const repo = announcementRepository as unknown as Record<string, jest.Mock>;
const community = communityClient as unknown as Record<string, jest.Mock>;
const enqueue = enqueueAnnouncementDeliverySafe as jest.Mock;

const CREATED_BY = "admin-1";
const AID = "3f2b6c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
const COMMUNITY_ID = "8b1e2c3d-4f5a-4b6c-9d0e-1f2a3b4c5d6e";

function baseRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: AID,
    title: "Title",
    description: "Body",
    target: "ALL",
    communityId: null,
    status: "PROCESSING",
    scheduledAt: null,
    recipientCount: 0,
    failureReason: null,
    createdById: CREATED_BY,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    sentAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("announcementService.createAnnouncement", () => {
  it("immediate announcement: persists PROCESSING and enqueues delivery once", async () => {
    const row = baseRow();
    repo.create.mockResolvedValue(row);
    repo.getById.mockResolvedValue({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });

    await announcementService.createAnnouncement(
      { title: "Title", description: "Body", target: "ALL" },
      CREATED_BY
    );

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ target: "ALL" }),
      CREATED_BY,
      "PROCESSING"
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      announcementId: AID,
      cursor: 0,
      batchId: `ann:${AID}:cursor:0`,
    });
  });

  it("scheduled announcement: persists SCHEDULED and does NOT enqueue delivery at create time", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const row = baseRow({ status: "SCHEDULED", scheduledAt: new Date(future) });
    repo.create.mockResolvedValue(row);
    repo.getById.mockResolvedValue({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      scheduledAt: future,
    });

    await announcementService.createAnnouncement(
      {
        title: "Title",
        description: "Body",
        target: "ALL",
        scheduledAt: future,
      },
      CREATED_BY
    );

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: future }),
      CREATED_BY,
      "SCHEDULED"
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("invalid community: throws and never persists the row", async () => {
    community.adminGetCommunity.mockResolvedValue({ found: false });

    await expect(
      announcementService.createAnnouncement(
        {
          title: "Title",
          description: "Body",
          target: "COMMUNITY",
          communityId: COMMUNITY_ID,
        },
        CREATED_BY
      )
    ).rejects.toThrow(NotFoundError);

    expect(repo.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("community target success: validates via gRPC and persists with communityId", async () => {
    community.adminGetCommunity.mockResolvedValue({
      found: true,
      membersTotal: 42,
    });
    const row = baseRow({ target: "COMMUNITY", communityId: COMMUNITY_ID });
    repo.create.mockResolvedValue(row);
    repo.getById.mockResolvedValue({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });

    const result = await announcementService.createAnnouncement(
      {
        title: "Title",
        description: "Body",
        target: "COMMUNITY",
        communityId: COMMUNITY_ID,
      },
      CREATED_BY
    );

    expect(community.adminGetCommunity).toHaveBeenCalledWith(COMMUNITY_ID);
    expect(result.communityId).toBe(COMMUNITY_ID);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
