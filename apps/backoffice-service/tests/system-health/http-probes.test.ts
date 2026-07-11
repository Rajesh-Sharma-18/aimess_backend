/**
 * HTTP-probe path for probeServices. Every non-gRPC service (user, media,
 * notification, stream) is health-checked via its `/health` HTTP endpoint —
 * this asserts each is included, `fetch` is called against the configured URL,
 * and 2xx/non-2xx/timeout responses map to healthy/down as expected.
 */

// Mock every gRPC client the health probe touches so we don't attempt real
// connections; each ping rejects so the gRPC rows are just `down` and out of
// the way — we only care about the HTTP rows here.
jest.mock("../../src/grpc/auth.client.js", () => ({
  authClient: { getUserCounts: jest.fn(() => Promise.reject(new Error("x"))) },
  getUserCountsBreaker: {},
  getActiveUserCountsBreaker: {},
}));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: {
    getCommunityCount: jest.fn(() => Promise.reject(new Error("x"))),
  },
  getCommunityCountBreaker: {},
}));
jest.mock("../../src/grpc/chat.client.js", () => ({
  chatClient: {
    getGroupCount: jest.fn(() => Promise.reject(new Error("x"))),
  },
  getGroupCountBreaker: {},
}));

import { probeServices } from "../../src/lib/health-probes.js";

const HTTP_KEYS = ["user", "media", "notification", "stream"];

describe("probeServices — HTTP-probed services", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("hits GET /health on every HTTP-monitored service and returns healthy on 2xx", async () => {
    const calls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    const rows = await probeServices();
    const httpRows = rows.filter((r) => HTTP_KEYS.includes(r.key));
    expect(httpRows).toHaveLength(4);
    for (const r of httpRows) {
      expect(r.status).toBe("healthy");
      expect(r.monitored).toBe(true);
      expect(typeof r.latencyMs).toBe("number");
      expect(r.breaker).toBeNull();
      expect(r.uptimePercent).toBe(100);
    }
    // One /health call per HTTP-monitored service.
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c).toMatch(/\/health$/);
  });

  it("marks a service `down` when its /health returns a non-2xx", async () => {
    global.fetch = jest.fn(
      async () => new Response("nope", { status: 503 })
    ) as unknown as typeof fetch;

    const rows = await probeServices();
    const media = rows.find((r) => r.key === "media");
    expect(media?.status).toBe("down");
    expect(media?.note).toContain("503");
  });

  it("marks a service `down` when the probe rejects (network error)", async () => {
    global.fetch = jest.fn(async () =>
      Promise.reject(new Error("connect ECONNREFUSED"))
    ) as unknown as typeof fetch;

    const rows = await probeServices();
    const stream = rows.find((r) => r.key === "stream");
    expect(stream?.status).toBe("down");
    expect(stream?.monitored).toBe(true);
    expect(stream?.note).toContain("ECONNREFUSED");
  });
});
