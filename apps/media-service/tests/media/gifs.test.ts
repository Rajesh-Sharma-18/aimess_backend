import request from "supertest";

import { app } from "../../src/app.js";
import { getBackofficeClient } from "../../src/grpc/clients/backoffice.client.js";
import { bearer, makeAccessToken, makeForgedAccessToken } from "../helpers/auth.js";

const API_KEY = "giphy-server-side-key-0001";
const getCredential = getBackofficeClient().getCustomCredential as jest.Mock;
const fetchMock = jest.fn();
const auth = () => bearer(makeAccessToken());

const giphyBody = {
  data: [{ id: "abc", images: { original: { url: "https://media.giphy.com/media/abc/giphy.gif" } } }],
  pagination: { total_count: 1, count: 1, offset: 0 },
  meta: { status: 200, msg: "OK", response_id: "r1" },
};

let clock = 1_000_000;

beforeEach(() => {
  clock += 10 * 60_000;
  jest.spyOn(Date, "now").mockReturnValue(clock);
  getCredential.mockReset();
  getCredential.mockResolvedValue({ configured: true, value: API_KEY });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => giphyBody });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

const calledUrl = (call = 0) => new URL(String(fetchMock.mock.calls[call][0]));

describe("GET /api/v1/media/gifs", () => {
  it("requires authentication", async () => {
    await request(app).get("/api/v1/media/gifs").expect(401);
    await request(app).get("/api/v1/media/gifs").set(bearer(makeForgedAccessToken())).expect(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns trending GIFs without exposing the API key", async () => {
    const res = await request(app).get("/api/v1/media/gifs").set(auth()).expect(200);

    expect(res.body.data).toEqual(giphyBody);
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
    const url = calledUrl();
    expect(url.origin + url.pathname).toBe("https://api.giphy.com/v1/gifs/trending");
    expect(url.searchParams.get("api_key")).toBe(API_KEY);
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("offset")).toBe("0");
  });

  it("searches stickers with the given term and paging", async () => {
    await request(app)
      .get("/api/v1/media/gifs")
      .query({ q: " happy cat ", type: "stickers", offset: 24, limit: 12 })
      .set(auth())
      .expect(200);

    const url = calledUrl();
    expect(url.pathname).toBe("/v1/stickers/search");
    expect(url.searchParams.get("q")).toBe("happy cat");
    expect(url.searchParams.get("offset")).toBe("24");
    expect(url.searchParams.get("limit")).toBe("12");
  });

  it.each([
    ["an unknown type", { type: "videos" }],
    ["a limit above 50", { limit: 51 }],
    ["a negative offset", { offset: -1 }],
    ["a term longer than 50 characters", { q: "x".repeat(51) }],
  ])("rejects %s", async (_label, query) => {
    await request(app).get("/api/v1/media/gifs").query(query).set(auth()).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers GIPHY_NOT_CONFIGURED when no credential is stored or it is disabled", async () => {
    getCredential.mockResolvedValue({ configured: false, value: "" });

    const res = await request(app).get("/api/v1/media/gifs").set(auth()).expect(503);

    expect(res.body.code).toBe("GIPHY_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers GIPHY_UNAVAILABLE when the credential store is unreachable", async () => {
    getCredential.mockRejectedValue(new Error("breaker open"));

    const res = await request(app).get("/api/v1/media/gifs").set(auth()).expect(503);

    expect(res.body.code).toBe("GIPHY_UNAVAILABLE");
  });

  it("answers GIPHY_UNAVAILABLE when GIPHY fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const res = await request(app).get("/api/v1/media/gifs").set(auth()).expect(503);

    expect(res.body.code).toBe("GIPHY_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
  });

  it.each([
    ["android", "ANDROID"],
    ["iOS", "IOS"],
    ["web", "WEB"],
    ["windows", "WEB"],
    [undefined, "WEB"],
  ])("uses the %s platform's key (%s)", async (header, platform) => {
    const req = request(app).get("/api/v1/media/gifs").set(auth());
    if (header) req.set("X-Platform", header);
    await req.expect(200);
    expect(getCredential).toHaveBeenCalledWith("GIPHY_API_KEY", platform);
  });

  it("keeps a separate cached key per platform", async () => {
    getCredential.mockImplementation(async (_name: string, platform: string) => ({
      configured: true,
      value: `${platform}-key-000`,
    }));
    await request(app).get("/api/v1/media/gifs").set(auth()).set("X-Platform", "android").expect(200);
    await request(app).get("/api/v1/media/gifs").set(auth()).set("X-Platform", "ios").expect(200);
    await request(app).get("/api/v1/media/gifs").set(auth()).set("X-Platform", "android").expect(200);

    expect(getCredential).toHaveBeenCalledTimes(2);
    expect(calledUrl(0).searchParams.get("api_key")).toBe("ANDROID-key-000");
    expect(calledUrl(1).searchParams.get("api_key")).toBe("IOS-key-000");
    expect(calledUrl(2).searchParams.get("api_key")).toBe("ANDROID-key-000");
  });

  it("caches the credential between requests and drops it when GIPHY rejects it", async () => {
    await request(app).get("/api/v1/media/gifs").set(auth()).expect(200);
    await request(app).get("/api/v1/media/gifs").set(auth()).expect(200);
    expect(getCredential).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    await request(app).get("/api/v1/media/gifs").set(auth()).expect(503);
    await request(app).get("/api/v1/media/gifs").set(auth()).expect(200);
    expect(getCredential).toHaveBeenCalledTimes(2);
  });
});
