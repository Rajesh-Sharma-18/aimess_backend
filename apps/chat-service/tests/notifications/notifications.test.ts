/**
 * Integration tests — notifications module.
 * Routes (apps/chat-service/src/api/routes/notification.routes.ts):
 *   GET  /api/chat/notifications              (list, paginated)
 *   POST /api/chat/notifications/read         (mark one read)
 *   POST /api/chat/notifications/read-all     (mark all read)
 *   GET  /api/chat/notifications/unread-count (unread count)
 *   DELETE /api/chat/notifications/:id        (soft-delete one)
 * All require the shared access-token middleware.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import {
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
  TEST_USER_ID,
} from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  ({ app, mocks } = buildApp());
});

const BASE = "/api/chat/notifications";

describe("GET /api/chat/notifications (list)", () => {
  it("POSITIVE: returns 200 with paginated envelope and forwards userId to repo", async () => {
    const rows = [
      {
        id: "n1",
        userId: TEST_USER_ID,
        type: "REACTION",
        createdAt: new Date(1000),
      },
      {
        id: "n2",
        userId: TEST_USER_ID,
        type: "MENTION",
        createdAt: new Date(900),
      },
    ];
    mocks.notificationRepo.findByUserId.mockResolvedValue(rows);
    mocks.notificationRepo.countByCategories.mockResolvedValue({
      all: 2,
      friends: 0,
      communities: 0,
      mentions: 0,
      system: 0,
    });
    // Total rows in the tab — NOT the unread count, which is what drives the
    // header badges and what `countByCategories` returns.
    mocks.notificationRepo.countByUserId.mockResolvedValue(2);

    const res = await request(app).get(BASE).set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.data).toHaveLength(2);
    expect(res.body.data.pagination.totalData).toBe(2);
    // Dates serialized to epoch ms.
    expect(res.body.data.data[0].createdAt).toBe(1000);
    // repo is queried for THIS user only (no IDOR via query).
    expect(mocks.notificationRepo.findByUserId).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ limit: 20 })
    );
  });

  it("EDGE: empty list still returns 200 with empty data array", async () => {
    mocks.notificationRepo.findByUserId.mockResolvedValue([]);
    mocks.notificationRepo.countByUserId.mockResolvedValue(0);

    const res = await request(app).get(BASE).set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
    expect(res.body.data.pagination.totalData).toBe(0);
  });

  it("EDGE: honours custom limit + page query params", async () => {
    mocks.notificationRepo.findByUserId.mockResolvedValue([]);
    mocks.notificationRepo.countByUserId.mockResolvedValue(0);

    await request(app)
      .get(`${BASE}?limit=5&page=3`)
      .set(bearer(makeAccessToken()));

    expect(mocks.notificationRepo.findByUserId).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ limit: 5 })
    );
  });

  it("NEGATIVE/SECURITY: 401 when Authorization header is missing", async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("SECURITY: 401 for a forged (wrong-secret) token", async () => {
    const res = await request(app)
      .get(BASE)
      .set(bearer(makeForgedAccessToken()));
    expect(res.status).toBe(401);
  });

  it("SECURITY: 401 for an expired token", async () => {
    const res = await request(app)
      .get(BASE)
      .set(bearer(makeExpiredAccessToken()));
    expect(res.status).toBe(401);
  });

  it("SECURITY: 401 for a malformed bearer value", async () => {
    const res = await request(app)
      .get(BASE)
      .set({ Authorization: "Bearer not-a-real-jwt" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/chat/notifications/read", () => {
  it("POSITIVE: marks a notification read, scoped to the caller", async () => {
    mocks.notificationRepo.markManyRead.mockResolvedValue(1);
    mocks.notificationRepo.getUnreadCount.mockResolvedValue(3);

    const res = await request(app)
      .post(`${BASE}/read`)
      .set(bearer(makeAccessToken()))
      .send({ notificationId: "notif-1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ updatedCount: 1, unreadCount: 3 });
    // AUDIT H6 — repo update MUST be scoped to (ids, callerUserId), not ids alone.
    expect(mocks.notificationRepo.markManyRead).toHaveBeenCalledWith(
      ["notif-1"],
      TEST_USER_ID
    );
  });

  // AUDIT H6 — another user's notification id can't be flipped: scoped to userId,
  // so the repo matches 0 rows and returns null (no mutation, no leak).
  it("SECURITY: IDOR — marking a foreign notification is scoped out (null result)", async () => {
    mocks.notificationRepo.markManyRead.mockResolvedValue(0);
    mocks.notificationRepo.getUnreadCount.mockResolvedValue(3);

    const res = await request(app)
      .post(`${BASE}/read`)
      .set(bearer(makeAccessToken()))
      .send({ notificationId: "someone-elses-id" });

    expect(res.status).toBe(200);
    // Scoped to userId, so the repo matches 0 rows — no mutation, no leak.
    expect(res.body.data.updatedCount).toBe(0);
    expect(mocks.notificationRepo.markManyRead).toHaveBeenCalledWith(
      ["someone-elses-id"],
      TEST_USER_ID
    );
  });

  // AUDIT H6 — validateBody(markReadSchema) is now wired on the route.
  it("NEGATIVE: 400 when notificationId is missing (validation wired)", async () => {
    const res = await request(app)
      .post(`${BASE}/read`)
      .set(bearer(makeAccessToken()))
      .send({});
    expect(res.status).toBe(400);
    expect(mocks.notificationRepo.markManyRead).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 when notificationId is too short (<5 chars)", async () => {
    const res = await request(app)
      .post(`${BASE}/read`)
      .set(bearer(makeAccessToken()))
      .send({ notificationId: "n1" });
    expect(res.status).toBe(400);
  });

  it("NEGATIVE: 401 without a token", async () => {
    const res = await request(app)
      .post(`${BASE}/read`)
      .send({ notificationId: "notif-1" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/chat/notifications/read-all", () => {
  it("POSITIVE: marks all read for the caller and returns 200 with null data", async () => {
    mocks.notificationRepo.markAllRead.mockResolvedValue(undefined);

    const res = await request(app)
      .post(`${BASE}/read-all`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mocks.notificationRepo.markAllRead).toHaveBeenCalledWith(
      TEST_USER_ID,
      undefined,
      null
    );
  });

  it("NEGATIVE: 401 without a token", async () => {
    const res = await request(app).post(`${BASE}/read-all`);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/chat/notifications/:id", () => {
  it("POSITIVE: soft-deletes the row and returns the recomputed unread count", async () => {
    mocks.notificationRepo.deleteById.mockResolvedValue({ count: 1 });
    mocks.notificationRepo.getUnreadCount.mockResolvedValue(4);

    const res = await request(app)
      .delete(`${BASE}/notif-1`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deleted: true, unreadCount: 4 });
    // Owner-scoped: (id, callerUserId), never id alone.
    expect(mocks.notificationRepo.deleteById).toHaveBeenCalledWith(
      "notif-1",
      TEST_USER_ID
    );
  });

  // The Delete button on an incoming friend-request card dismisses the CARD.
  // It must never reach the friendship: no accept, no reject, no state change.
  it("POSITIVE: dismissing a friend-request card touches no friendship state", async () => {
    mocks.notificationRepo.deleteById.mockResolvedValue({ count: 1 });
    mocks.notificationRepo.getUnreadCount.mockResolvedValue(0);

    await request(app)
      .delete(`${BASE}/friend-req-notif`)
      .set(bearer(makeAccessToken()));

    // The friendship itself lives in user-service and this route has no path to
    // it. What it COULD still do wrong is rewrite the row into a resolved
    // "declined" card — the three writes that would do that stay untouched, so
    // the request is left PENDING and re-renders with Accept if it comes back.
    expect(mocks.notificationRepo.recordAction).not.toHaveBeenCalled();
    expect(mocks.notificationRepo.applyStateTransition).not.toHaveBeenCalled();
    expect(mocks.notificationRepo.updatePayloadAndType).not.toHaveBeenCalled();
  });

  it("EDGE: re-deleting is idempotent — 200 with deleted:false", async () => {
    mocks.notificationRepo.deleteById.mockResolvedValue({ count: 0 });
    mocks.notificationRepo.getUnreadCount.mockResolvedValue(4);

    const res = await request(app)
      .delete(`${BASE}/notif-1`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(false);
  });

  it("SECURITY: IDOR — a foreign id is scoped out, mutating nothing", async () => {
    mocks.notificationRepo.deleteById.mockResolvedValue({ count: 0 });
    mocks.notificationRepo.getUnreadCount.mockResolvedValue(4);

    const res = await request(app)
      .delete(`${BASE}/someone-elses-id`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(false);
    expect(mocks.notificationRepo.deleteById).toHaveBeenCalledWith(
      "someone-elses-id",
      TEST_USER_ID
    );
  });

  it("NEGATIVE: 401 without a token", async () => {
    const res = await request(app).delete(`${BASE}/notif-1`);
    expect(res.status).toBe(401);
    expect(mocks.notificationRepo.deleteById).not.toHaveBeenCalled();
  });
});

describe("GET /api/chat/notifications/unread-count", () => {
  it("POSITIVE: returns the unread count for the caller", async () => {
    mocks.notificationRepo.getUnreadCount.mockResolvedValue(7);

    const res = await request(app)
      .get(`${BASE}/unread-count`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.unreadCount).toBe(7);
    expect(mocks.notificationRepo.getUnreadCount).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.anything()
    );
  });

  it("NEGATIVE: 401 without a token", async () => {
    const res = await request(app).get(`${BASE}/unread-count`);
    expect(res.status).toBe(401);
  });
});
