/**
 * Integration tests — peer presence.
 * Route: GET /api/chat/private/presence/:userId  (authenticate)
 *
 * The controller reads presence + last-seen via the cache repo (mocked).
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import {
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  ({ app, mocks } = buildApp());
});

describe("GET /api/chat/private/presence/:userId", () => {
  it("POSITIVE: returns online + lastSeen for a peer", async () => {
    mocks.cacheRepo.getUserPresence.mockResolvedValue("online");
    mocks.cacheRepo.getLastSeen.mockResolvedValue(1717000000000);

    const res = await request(app)
      .get("/api/chat/private/presence/peer-42")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      userId: "peer-42",
      isOnline: true,
      lastSeen: 1717000000000,
    });
  });

  it("EDGE: offline peer with no last-seen → isOnline false, lastSeen null", async () => {
    mocks.cacheRepo.getUserPresence.mockResolvedValue("offline");
    mocks.cacheRepo.getLastSeen.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/chat/private/presence/peer-99")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.isOnline).toBe(false);
    expect(res.body.data.lastSeen).toBeNull();
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).get("/api/chat/private/presence/peer-1");
    expect(res.status).toBe(401);
  });

  it("SECURITY: 401 for a forged token", async () => {
    const res = await request(app)
      .get("/api/chat/private/presence/peer-1")
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });
});
