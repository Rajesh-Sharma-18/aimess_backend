/**
 * Admin livestream list/detail `viewerCount` = TOTAL unique users who joined
 * this stream at least once during its lifetime, regardless of status.
 *
 * Sourced from `LivestreamViewerSession` (stream-service surfaces this as
 * `AdminStreamRow.uniqueViewerCount`) — the same distinct-user count the
 * admin viewer list (`GET /livestreams/:id/users`) paginates. Reconnects and
 * rejoins dedupe by userId; the host, co-hosts, speakers, and viewers all
 * count once each; users who already left still count. NOT the Redis live
 * presence count, NOT `totalViews`, NOT the stored `viewerCount` column.
 */
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    report: {
      findMany: jest.fn(async () => []),
    },
  },
}));

import { streamClient } from "../../src/grpc/stream.client.js";
import { livestreamRepository } from "../../src/repositories/livestream.repository.js";

const adminGetStream = streamClient.adminGetStream as jest.Mock;
const adminListStreams = streamClient.adminListStreams as jest.Mock;
const adminGetLivestreamReportCounts =
  streamClient.adminGetLivestreamReportCounts as jest.Mock;

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
    // Redis live-presence overlay (currently watching). Must NOT drive viewerCount.
    viewerCount: 42,
    peakViewers: 100,
    // Raw checkAccess counter (over-counts join attempts). Must NOT drive viewerCount.
    totalViews: 777,
    // The one true source: distinct users from LivestreamViewerSession.
    uniqueViewerCount: 3,
    totalComments: 0,
    durationSeconds: 60,
    livedAt: 1000,
    endedAt: 0,
    createdAt: 1000,
    ...overrides,
  };
}

describe("admin livestream viewerCount (total unique users, all statuses)", () => {
  beforeEach(() => {
    adminGetStream.mockReset();
    adminListStreams.mockReset();
    adminGetLivestreamReportCounts.mockReset();
    adminGetLivestreamReportCounts.mockResolvedValue([]);
  });

  it("detail: LIVE returns the total unique viewers (NOT the Redis current-watchers count)", async () => {
    adminGetStream.mockResolvedValueOnce(baseStream({ status: "LIVE" }));
    const detail = await livestreamRepository.getById("LS-1");
    expect(detail?.status).toBe("LIVE");
    expect(detail?.viewerCount).toBe(3);
    // Current-watchers signal is preserved on the separate viewerStats block.
    expect(detail?.viewerStats.currentViewers).toBe(42);
  });

  it("detail: ENDED returns the total unique viewers", async () => {
    adminGetStream.mockResolvedValueOnce(
      baseStream({ status: "ENDED", endedAt: 5000 })
    );
    const detail = await livestreamRepository.getById("LS-1");
    expect(detail?.status).toBe("ENDED");
    expect(detail?.viewerCount).toBe(3);
  });

  it("detail: SCHEDULED returns the total unique viewers (0 for a fresh stream)", async () => {
    adminGetStream.mockResolvedValueOnce(
      baseStream({ status: "PENDING", livedAt: 0, uniqueViewerCount: 0 })
    );
    const detail = await livestreamRepository.getById("LS-1");
    expect(detail?.status).toBe("SCHEDULED");
    expect(detail?.viewerCount).toBe(0);
  });

  it("list: every row's viewerCount reflects total unique viewers regardless of status", async () => {
    adminListStreams.mockResolvedValueOnce({
      streams: [
        // LIVE with a large presence count and modest total-unique count.
        baseStream({
          id: "LS-1",
          status: "LIVE",
          viewerCount: 100,
          uniqueViewerCount: 4,
        }),
        // ENDED with a much larger totalViews than actual unique users.
        baseStream({
          id: "LS-2",
          status: "ENDED",
          endedAt: 5000,
          totalViews: 999,
          uniqueViewerCount: 7,
        }),
        // SCHEDULED with no viewers yet.
        baseStream({
          id: "LS-3",
          status: "PENDING",
          livedAt: 0,
          uniqueViewerCount: 0,
        }),
      ],
      total: 3,
    });

    const page = await livestreamRepository.list({
      sort: "createdAt:desc",
      page: 1,
      limit: 20,
    });

    const byId = new Map(page.data.map((r) => [r.livestreamId, r]));
    expect(byId.get("LS-1")?.viewerCount).toBe(4);
    expect(byId.get("LS-2")?.viewerCount).toBe(7);
    expect(byId.get("LS-3")?.viewerCount).toBe(0);
  });
});
