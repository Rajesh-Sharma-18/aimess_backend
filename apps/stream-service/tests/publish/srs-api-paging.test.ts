/**
 * SRS's clients/streams list endpoints return only 10 entries unless `count`
 * is given. Viewers and ABR rendition publishers fill that page, so an unpaged
 * scan misses the camera publisher, reconcileWithSrs never refreshes its
 * lastHeartbeatAt, and the sweeper ends a healthy broadcast after 5 minutes.
 */
import { SrsService } from "../../src/services/srs.service.js";

describe("SrsService list calls request a full page", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ clients: [], streams: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("pages clients and streams on every scan", async () => {
    const srs = new SrsService();

    await srs.listPublishers();
    await srs.kickStream("pb1", "PHONE_CAMERA");
    await srs.hasFrames("pb1");
    await srs.getStreamStats("pb1");

    const getUrls = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "GET")
      .map(([url]) => String(url));

    expect(getUrls.length).toBeGreaterThanOrEqual(4);
    expect(getUrls.some((u) => u.includes("/api/v1/clients/"))).toBe(true);
    expect(getUrls.some((u) => u.includes("/api/v1/streams/"))).toBe(true);
    for (const url of getUrls) {
      expect(url.endsWith("?count=10000")).toBe(true);
    }
  });
});
