/**
 * Service-layer test for `communityService.createReport()` resolving the
 * reported MESSAGE content from chat-service (the message-level report flow):
 * the client sends only `reportedMessageId`; the backend fetches the message's
 * text / media (RAW object keys) / postedAt via gRPC and snapshots it.
 *
 * Only the I/O boundary is mocked (repository, chat gRPC client, storage).
 */

jest.mock("@aimess/storage", () => ({
  MEDIA_PREFIXES: { community: [], userAvatars: [] },
  parseObjectKeyFromStored: jest.fn(() => null),
  toMediaObject: jest.fn(
    async (input: {
      stored: string | null;
      contentType?: string | null;
      fileName?: string | null;
      size?: number | null;
    }) => ({
      fileId: null,
      objectKey: input.stored ?? null,
      fileName: input.fileName ?? null,
      contentType: input.contentType ?? null,
      size: input.size ?? null,
      downloadUrl: input.stored ? `https://signed/${input.stored}` : null,
      downloadUrlExpiresIn: input.stored ? 900 : null,
      uploadUrl: null,
      uploadUrlExpiresIn: null,
    })
  ),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findMemberByUserId: jest.fn(),
    findOpenReportByReporterAndTarget: jest.fn(),
    createReport: jest.fn(),
    findActiveMemberIdsByRoles: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { getChatClient } from "../../src/grpc/chat.client.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const chat = getChatClient as unknown as jest.Mock;

const CID = "a".repeat(24);
const SELF = "edcfb732-4617-4b19-aa7a-575ca43c24cc";
const TARGET = "15c8a2c9-e759-413d-878c-842dc3066d94";
const MSG = "6a3a737f236c483508914d0c";
const POSTED_MS = Date.parse("2026-02-02T10:00:00.000Z");

const setChatSnapshot = (snap: unknown) => {
  chat.mockReturnValue({ getCommunityMessageById: jest.fn(async () => snap) });
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue({ id: CID, name: "C", status: "ACTIVE" });
  repo.findMembership.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" });
  repo.findMemberByUserId.mockResolvedValue({
    userId: TARGET,
    status: "ACTIVE",
  });
  repo.findOpenReportByReporterAndTarget.mockResolvedValue(null);
  repo.findActiveMemberIdsByRoles.mockResolvedValue([]);
  repo.createAuditLog.mockResolvedValue(undefined);
  // Echo the create payload back as the persisted row.
  repo.createReport.mockImplementation(
    async (data: Record<string, unknown>) => ({
      id: MSG,
      status: "OPEN",
      reviewedBy: null,
      reviewedAt: null,
      resolution: null,
      createdAt: new Date("2026-02-02T11:00:00.000Z"),
      updatedAt: new Date("2026-02-02T11:00:00.000Z"),
      ...data,
    })
  );
});

describe("createReport — resolve reported content from chat-service", () => {
  it("snapshots text + RAW media keys + postedAt when the message resolves", async () => {
    setChatSnapshot({
      found: true,
      message: "buy now!!!",
      contentType: "IMAGE",
      postedAt: POSTED_MS,
      senderId: TARGET,
      media: [
        {
          objectKey: "community-chat/abc.jpg",
          contentType: "image/jpeg",
          fileName: "abc.jpg",
          size: 1234,
        },
      ],
    });

    const dto = await communityService.createReport(CID, SELF, {
      targetUserId: TARGET,
      reason: "SPAM",
      reportedMessageId: MSG,
    });

    expect(repo.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportedMessageId: MSG,
        reportedContentText: "buy now!!!",
        reportedContentType: "IMAGE",
        reportedContentPostedAt: new Date(POSTED_MS),
        reportedContentMedia: [
          {
            objectKey: "community-chat/abc.jpg",
            contentType: "image/jpeg",
            fileName: "abc.jpg",
            size: 1234,
          },
        ],
      })
    );

    // The returned DTO resolves the RAW key to a presigned URL on read.
    expect(dto.reportedContentText).toBe("buy now!!!");
    expect(dto.reportedContentMedia).toHaveLength(1);
    expect(dto.reportedContentMedia[0]!.downloadUrl).toBe(
      "https://signed/community-chat/abc.jpg"
    );
    expect(dto.reportedContentPostedAt).toBe("2026-02-02T10:00:00.000Z");
  });

  it("stores the message id with NULL content when the message is gone (found:false)", async () => {
    setChatSnapshot({
      found: false,
      message: "",
      contentType: "",
      postedAt: 0,
      senderId: "",
      media: [],
    });

    await communityService.createReport(CID, SELF, {
      targetUserId: TARGET,
      reason: "SPAM",
      reportedMessageId: MSG,
    });

    expect(repo.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportedMessageId: MSG,
        reportedContentText: null,
        reportedContentType: null,
        reportedContentPostedAt: null,
        reportedContentMedia: null,
      })
    );
  });

  it("does not resolve when no reportedMessageId is given (pure user-level report)", async () => {
    const spy = jest.fn();
    chat.mockReturnValue({ getCommunityMessageById: spy });

    await communityService.createReport(CID, SELF, {
      targetUserId: TARGET,
      reason: "SPAM",
    });

    expect(spy).not.toHaveBeenCalled();
    expect(repo.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportedMessageId: null,
        reportedContentMedia: null,
      })
    );
  });
});
