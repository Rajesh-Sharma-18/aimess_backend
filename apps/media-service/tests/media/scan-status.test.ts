/**
 * GET /api/v1/media/scan-status?objectKey=&category=
 *
 * Polls the async AV scan status. scanStatusStore.get is globally mocked
 * (tests/setup/global-mocks.ts, default → "CLEAN"); each test overrides it.
 * Authz mirrors download-url: CHAT_ATTACHMENT → ownership; COMMUNITY/GROUP →
 * prefix. assertObjectKeyOwnedBy runs for real (imported from @aimess/storage).
 *
 * Key invariant: a missing/null Redis record reports PENDING — never CLEAN.
 */
import request from "supertest";
import { app } from "../../src/app.js";
import { scanStatusStore } from "../../src/lib/scanner.js";
import {
  TEST_USER_ID,
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
} from "../helpers/auth.js";

const auth = () => bearer(makeAccessToken());
const ownKey = `chat-uploads/${TEST_USER_ID}/file.png`;
const mockedGet = jest.mocked(scanStatusStore.get);

describe("GET /api/v1/media/scan-status", () => {
  it("200: reflects scanStatusStore.get (PENDING)", async () => {
    mockedGet.mockResolvedValueOnce("PENDING");

    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({ objectKey: ownKey, category: "CHAT_ATTACHMENT" })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.objectKey).toBe(ownKey);
    expect(res.body.data.scanStatus).toBe("PENDING");
  });

  it("200: reflects scanStatusStore.get (CLEAN)", async () => {
    mockedGet.mockResolvedValueOnce("CLEAN");

    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({ objectKey: ownKey, category: "CHAT_ATTACHMENT" })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("CLEAN");
  });

  it("200: null Redis record → PENDING (never false-clean)", async () => {
    mockedGet.mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({ objectKey: ownKey, category: "CHAT_ATTACHMENT" })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("PENDING");
  });

  it("200: COMMUNITY_CHAT_ATTACHMENT with valid prefix", async () => {
    mockedGet.mockResolvedValueOnce("CLEAN");

    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({
        objectKey: "community-chat-uploads/alice/img.png",
        category: "COMMUNITY_CHAT_ATTACHMENT",
      })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("CLEAN");
  });

  it("403: CHAT_ATTACHMENT key owned by a different user (IDOR)", async () => {
    const otherKey =
      "chat-uploads/99999999-9999-4999-8999-999999999999/file.png";

    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({ objectKey: otherKey, category: "CHAT_ATTACHMENT" })
      .set(auth());

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("200: declared category mismatch self-heals from the objectKey prefix", async () => {
    // Mirror of the download-url fix: a community-chat key polled with the wrong
    // declared category resolves by its own prefix instead of erroring.
    mockedGet.mockResolvedValueOnce("CLEAN");

    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({
        objectKey: `community-chat-uploads/${TEST_USER_ID}/file.png`,
        category: "CHAT_ATTACHMENT",
      })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.scanStatus).toBe("CLEAN");
  });

  it("403: objectKey prefix governs over a mismatched declared category (IDOR)", async () => {
    // chat-uploads key owned by another user, declared as COMMUNITY/GROUP →
    // resolved as CHAT_ATTACHMENT and rejected by the owner check.
    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({
        objectKey: "chat-uploads/some-user/file.png",
        category: "COMMUNITY_CHAT_ATTACHMENT",
      })
      .set(auth());

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("400: missing objectKey query param", async () => {
    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({ category: "CHAT_ATTACHMENT" })
      .set(auth());

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("400: missing category query param", async () => {
    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({ objectKey: ownKey })
      .set(auth());

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("400: invalid category value", async () => {
    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({ objectKey: ownKey, category: "NOPE" })
      .set(auth());

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("401: no token", async () => {
    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({ objectKey: ownKey, category: "CHAT_ATTACHMENT" });

    expect(res.status).toBe(401);
  });

  it("401: expired token", async () => {
    const res = await request(app)
      .get("/api/v1/media/scan-status")
      .query({ objectKey: ownKey, category: "CHAT_ATTACHMENT" })
      .set(bearer(makeExpiredAccessToken()));

    expect(res.status).toBe(401);
  });
});
