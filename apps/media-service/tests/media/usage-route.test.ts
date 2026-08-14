/**
 * GET /api/v1/media/usage/me — route wiring, auth scoping, and response shape.
 *
 * The calculation itself is covered by data-usage.test.ts; this file exists to
 * prove the three things that only show up over HTTP: the endpoint is behind
 * authentication, it reads the caller's id from the token rather than any
 * client-supplied value, and Date fields leave as epoch ms.
 */

import request from "supertest";

import { app } from "../../src/app.js";
import { mediaFileRepository } from "../../src/repositories/media-file.repository.js";
import {
  TEST_USER_ID,
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

const auth = () => bearer(makeAccessToken());
const mockedSum = jest.mocked(mediaFileRepository.sumVerifiedBytesByMime);

const MB = 1024 * 1024;

beforeEach(() => {
  mockedSum.mockReset();
  mockedSum.mockResolvedValue([]);
});

describe("GET /api/v1/media/usage/me", () => {
  it("requires authentication", async () => {
    await request(app).get("/api/v1/media/usage/me").expect(401);
    await request(app)
      .get("/api/v1/media/usage/me")
      .set(bearer(makeExpiredAccessToken()))
      .expect(401);
    await request(app)
      .get("/api/v1/media/usage/me")
      .set(bearer(makeForgedAccessToken()))
      .expect(401);

    expect(mockedSum).not.toHaveBeenCalled();
  });

  it("scopes the query to the token's user, not to anything in the request", async () => {
    // A userId in the query string must not reach the repository — usage is
    // private and this endpoint deliberately has no by-id variant.
    await request(app)
      .get("/api/v1/media/usage/me?userId=someone-else")
      .set(auth())
      .expect(200);

    expect(mockedSum).toHaveBeenCalledTimes(1);
    expect(mockedSum.mock.calls[0]![0]).toBe(TEST_USER_ID);
  });

  it("queries from the start of the current UTC month", async () => {
    await request(app).get("/api/v1/media/usage/me").set(auth()).expect(200);

    const since = mockedSum.mock.calls[0]![1];
    const now = new Date();
    expect(since.toISOString()).toBe(
      new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
      ).toISOString()
    );
  });

  it("returns totals, integer percentages summing to 100, and an epoch-ms period", async () => {
    mockedSum.mockResolvedValue([
      { contentType: "video/mp4", bytes: 30 * MB },
      { contentType: "image/png", bytes: 12 * MB },
      { contentType: "image/gif", bytes: 3 * MB },
      { contentType: "audio/ogg", bytes: 2 * MB },
      { contentType: "application/pdf", bytes: 3 * MB },
    ]);

    const res = await request(app)
      .get("/api/v1/media/usage/me")
      .set(auth())
      .expect(200);

    const data = res.body.data;
    expect(data.measured).toBe("UPLOAD");
    expect(data.totalBytes).toBe(50 * MB);

    // Serialized by ApiResponse — a Date must not leak out as an ISO string.
    expect(typeof data.periodStart).toBe("number");

    const sumBytes = data.categories.reduce(
      (s: number, c: { bytes: number }) => s + c.bytes,
      0
    );
    const sumPct = data.categories.reduce(
      (s: number, c: { percentage: number }) => s + c.percentage,
      0
    );
    expect(sumBytes).toBe(data.totalBytes);
    expect(sumPct).toBe(100);

    // GIF folded into IMAGE; sorted by bytes descending.
    expect(data.categories.map((c: { type: string }) => c.type)).toEqual([
      "VIDEO",
      "IMAGE",
      "DOCUMENT",
      "AUDIO",
    ]);
  });

  it("a user with no uploads gets an empty breakdown, not a zeroed chart", async () => {
    const res = await request(app)
      .get("/api/v1/media/usage/me")
      .set(auth())
      .expect(200);

    expect(res.body.data.totalBytes).toBe(0);
    expect(res.body.data.categories).toEqual([]);
  });
});
