/**
 * Admin livestream list/detail must derive `viewerCount` from status:
 * LIVE -> live viewerCount, ENDED -> lifetime totalViews (there is no
 * separate totalViewerCount column), everything else -> stored viewerCount.
 */
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    report: {
      findMany: jest.fn(async () => []),
      groupBy: jest.fn(async () => []),
    },
  },
}));

import { streamClient } from "../../src/grpc/stream.client.js";
import { livestreamRepository } from "../../src/repositories/livestream.repository.js";

const adminGetStream = streamClient.adminGetStream as jest.Mock;
const adminListStreams = streamClient.adminListStreams as jest.Mock;

function baseStream(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "LS-1",
    communityId: "C-1",
    creatorId: "U-1",
    title: "Test stream",
    description: "",
    thumbnail: "",
    sourceType: "PHONE_CAMERA",
    hlsUrl: "",
    flvUrl: "",
    viewerCount: 42,
    peakViewers: 100,
    totalViews: 777,
    totalComments: 0,
    durationSeconds: 60,
    livedAt: 1000,
    endedAt: 0,
    createdAt: 1000,
    ...overrides,
  };
}

describe("admin livestream viewerCount derivation", () => {
  beforeEach(() => {
    adminGetStream.mockReset();
    adminListStreams.mockReset();
  });

  it("detail: LIVE uses live viewerCount", async () => {
    adminGetStream.mockResolvedValueOnce(baseStream({ status: "LIVE" }));
    const detail = await livestreamRepository.getById("LS-1");
    expect(detail?.status).toBe("LIVE");
    expect(detail?.viewerCount).toBe(42);
  });

  it("detail: ENDED uses totalViews as the lifetime total", async () => {
    adminGetStream.mockResolvedValueOnce(
      baseStream({ status: "ENDED", endedAt: 5000 })
    );
    const detail = await livestreamRepository.getById("LS-1");
    expect(detail?.status).toBe("ENDED");
    expect(detail?.viewerCount).toBe(777);
  });

  it("detail: SCHEDULED preserves the stored viewerCount", async () => {
    adminGetStream.mockResolvedValueOnce(
      baseStream({ status: "PENDING", livedAt: 0 })
    );
    const detail = await livestreamRepository.getById("LS-1");
    expect(detail?.status).toBe("SCHEDULED");
    expect(detail?.viewerCount).toBe(42);
  });

  it("list: LIVE and ENDED rows resolve independently within the same page", async () => {
    adminListStreams.mockResolvedValueOnce({
      streams: [
        baseStream({ id: "LS-1", status: "LIVE" }),
        baseStream({
          id: "LS-2",
          status: "ENDED",
          endedAt: 5000,
          totalViews: 999,
        }),
      ],
      total: 2,
    });

    const page = await livestreamRepository.list({
      sort: "createdAt:desc",
      page: 1,
      limit: 20,
    });

    const live = page.data.find((r) => r.livestreamId === "LS-1");
    const ended = page.data.find((r) => r.livestreamId === "LS-2");
    expect(live?.viewerCount).toBe(42);
    expect(ended?.viewerCount).toBe(999);
  });
});
