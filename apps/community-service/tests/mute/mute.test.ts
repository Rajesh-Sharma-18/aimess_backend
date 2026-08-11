/**
 * Per-community mute settings, bulk mute/read, notification preferences, and
 * liked/favorite communities:
 *   GET    /:id/mute
 *   PUT    /:id/mute
 *   DELETE /:id/mute
 *   POST   /mute/bulk
 *   POST   /read/bulk
 *   GET    /:id/notification-preferences
 *   PUT    /:id/notification-preferences
 *   GET    /liked
 *   POST   /:id/like
 *   DELETE /:id/like
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    getMute: jest.fn(),
    setMute: jest.fn(),
    clearMute: jest.fn(),
    bulkMute: jest.fn(),
    bulkUnmute: jest.fn(),
    bulkMarkRead: jest.fn(),
    getNotificationPreferences: jest.fn(),
    setNotificationPreferences: jest.fn(),
    likeCommunity: jest.fn(),
    unlikeCommunity: jest.fn(),
    listFavoriteCommunities: jest.fn(),
  },
}));

import request from "supertest";

import { NotFoundError } from "@aimess/errors";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const svc = communityService as unknown as Record<string, jest.Mock>;
const auth = () => bearer(makeAccessToken());

const CID = "a".repeat(24);
const CID2 = "b".repeat(24);
const SELF = "11111111-1111-4111-8111-111111111111";

describe("per-community mute settings", () => {
  it("GET /:id/mute → 200", async () => {
    svc.getMute.mockResolvedValue({ isMuted: false, muteUntil: null });
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/mute`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(svc.getMute).toHaveBeenCalledWith(CID, SELF);
  });

  it("PUT /:id/mute with a duration → 200", async () => {
    svc.setMute.mockResolvedValue({ isMuted: true, muteUntil: "2026-01-01" });
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/mute`)
      .set(auth())
      .send({ durationMinutes: 120 });
    expect(res.status).toBe(200);
    expect(svc.setMute).toHaveBeenCalledWith(CID, SELF, 120);
  });

  it("PUT /:id/mute with an empty body (indefinite) → 200 forwards null", async () => {
    svc.setMute.mockResolvedValue({ isMuted: true, muteUntil: null });
    await request(app)
      .put(`/api/v1/communities/${CID}/mute`)
      .set(auth())
      .send({});
    expect(svc.setMute).toHaveBeenCalledWith(CID, SELF, null);
  });

  it("PUT /:id/mute 400 for a non-integer duration", async () => {
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/mute`)
      .set(auth())
      .send({ durationMinutes: 1.5 });
    expect(res.status).toBe(400);
    expect(svc.setMute).not.toHaveBeenCalled();
  });

  it("DELETE /:id/mute → 200 null data", async () => {
    svc.clearMute.mockResolvedValue(undefined);
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/mute`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it("GET /:id/mute 404 when the caller is not a member", async () => {
    svc.getMute.mockRejectedValue(
      new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND")
    );
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/mute`)
      .set(auth());
    expect(res.status).toBe(404);
  });
});

describe("bulk mute / unmute / mark-read", () => {
  it("POST /mute/bulk action=mute → 200, calls bulkMute", async () => {
    svc.bulkMute.mockResolvedValue({ updated: 2 });
    const res = await request(app)
      .post("/api/v1/communities/mute/bulk")
      .set(auth())
      .send({ action: "mute", communityIds: [CID, CID2], durationMinutes: 30 });
    expect(res.status).toBe(200);
    expect(svc.bulkMute).toHaveBeenCalledWith(SELF, [CID, CID2], 30);
    expect(svc.bulkUnmute).not.toHaveBeenCalled();
  });

  it("POST /mute/bulk action=unmute → 200, calls bulkUnmute", async () => {
    svc.bulkUnmute.mockResolvedValue({ updated: 2 });
    const res = await request(app)
      .post("/api/v1/communities/mute/bulk")
      .set(auth())
      .send({ action: "unmute", communityIds: [CID] });
    expect(res.status).toBe(200);
    expect(svc.bulkUnmute).toHaveBeenCalledWith(SELF, [CID]);
    expect(svc.bulkMute).not.toHaveBeenCalled();
  });

  it("POST /mute/bulk 400 for an invalid action enum", async () => {
    const res = await request(app)
      .post("/api/v1/communities/mute/bulk")
      .set(auth())
      .send({ action: "silence", communityIds: [CID] });
    expect(res.status).toBe(400);
  });

  it("POST /mute/bulk 400 with an empty communityIds list", async () => {
    const res = await request(app)
      .post("/api/v1/communities/mute/bulk")
      .set(auth())
      .send({ action: "mute", communityIds: [] });
    expect(res.status).toBe(400);
  });

  it("POST /mute/bulk 400 when a communityId is not an ObjectId", async () => {
    const res = await request(app)
      .post("/api/v1/communities/mute/bulk")
      .set(auth())
      .send({ action: "mute", communityIds: ["not-an-objectid"] });
    expect(res.status).toBe(400);
  });

  it("POST /read/bulk → 200", async () => {
    svc.bulkMarkRead.mockResolvedValue({ marked: 1 });
    const res = await request(app)
      .post("/api/v1/communities/read/bulk")
      .set(auth())
      .send({ communityIds: [CID] });
    expect(res.status).toBe(200);
    expect(svc.bulkMarkRead).toHaveBeenCalledWith(SELF, [CID]);
  });

  // The mobile clients serialize snake_case; both spellings must reach the
  // service identically. camelCase stays canonical.
  it("POST /mute/bulk accepts community_ids / duration_minutes", async () => {
    svc.bulkMute.mockResolvedValue({ muted: [CID], skipped: [] });
    const res = await request(app)
      .post("/api/v1/communities/mute/bulk")
      .set(auth())
      .send({ action: "mute", community_ids: [CID], duration_minutes: 10 });
    expect(res.status).toBe(200);
    expect(svc.bulkMute).toHaveBeenCalledWith(SELF, [CID], 10);
  });

  it("POST /read/bulk accepts community_ids", async () => {
    svc.bulkMarkRead.mockResolvedValue({ updatedCount: 1 });
    const res = await request(app)
      .post("/api/v1/communities/read/bulk")
      .set(auth())
      .send({ community_ids: [CID], action: "read" });
    expect(res.status).toBe(200);
    expect(svc.bulkMarkRead).toHaveBeenCalledWith(SELF, [CID]);
  });

  it("POST /read/bulk 400 when more than 50 ids are sent", async () => {
    const ids = Array.from({ length: 51 }, () => "a".repeat(24));
    const res = await request(app)
      .post("/api/v1/communities/read/bulk")
      .set(auth())
      .send({ communityIds: ids });
    expect(res.status).toBe(400);
  });
});

describe("notification preferences", () => {
  it("GET → 200", async () => {
    svc.getNotificationPreferences.mockResolvedValue({
      streamEnabled: true,
      chatEnabled: true,
      announcementEnabled: true,
    });
    const res = await request(app)
      .get(`/api/v1/communities/${CID}/notification-preferences`)
      .set(auth());
    expect(res.status).toBe(200);
  });

  it("PUT updates a subset → 200", async () => {
    svc.setNotificationPreferences.mockResolvedValue({
      streamEnabled: false,
      chatEnabled: true,
      announcementEnabled: true,
    });
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/notification-preferences`)
      .set(auth())
      .send({ streamEnabled: false });
    expect(res.status).toBe(200);
    expect(svc.setNotificationPreferences).toHaveBeenCalledTimes(1);
  });

  it("PUT 400 with an empty body (refine requires ≥1 field)", async () => {
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/notification-preferences`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(svc.setNotificationPreferences).not.toHaveBeenCalled();
  });

  it("PUT 400 for a non-boolean field", async () => {
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/notification-preferences`)
      .set(auth())
      .send({ chatEnabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("PUT 404 when the caller is not a member", async () => {
    svc.setNotificationPreferences.mockRejectedValue(
      new NotFoundError("COMMUNITY_MEMBER_NOT_FOUND")
    );
    const res = await request(app)
      .put(`/api/v1/communities/${CID}/notification-preferences`)
      .set(auth())
      .send({ chatEnabled: false });
    expect(res.status).toBe(404);
  });
});

describe("liked / favorite communities", () => {
  it("GET /liked → 200", async () => {
    svc.listFavoriteCommunities.mockResolvedValue({
      data: [],
      nextCursor: null,
    });
    const res = await request(app).get("/api/v1/communities/liked").set(auth());
    expect(res.status).toBe(200);
    expect(svc.listFavoriteCommunities).toHaveBeenCalledTimes(1);
  });

  it("POST /:id/like → 201", async () => {
    svc.likeCommunity.mockResolvedValue({ liked: true });
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/like`)
      .set(auth());
    expect(res.status).toBe(201);
    expect(svc.likeCommunity).toHaveBeenCalledWith(CID, SELF);
  });

  it("DELETE /:id/like → 200 null data", async () => {
    svc.unlikeCommunity.mockResolvedValue(undefined);
    const res = await request(app)
      .delete(`/api/v1/communities/${CID}/like`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it("POST /:id/like 404 when the community is gone", async () => {
    svc.likeCommunity.mockRejectedValue(
      new NotFoundError("COMMUNITY_NOT_FOUND")
    );
    const res = await request(app)
      .post(`/api/v1/communities/${CID}/like`)
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("POST /:id/like 400 for an invalid community id", async () => {
    const res = await request(app)
      .post("/api/v1/communities/bad-id/like")
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.likeCommunity).not.toHaveBeenCalled();
  });
});
