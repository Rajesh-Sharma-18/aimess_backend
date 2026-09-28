/**
 * The unread badge and the notification list must never disagree.
 *
 * They can, because they answered to two different rules: the list, the per-tab
 * counts and `/unread-count` all hide a login-detected row from the device that
 * login created, while every count a mutation handed back — or broadcast — was
 * the account-wide number. So a device that had just signed in was told it had
 * one unread notification and then shown an inbox with nothing unread in it,
 * and nothing but a refetch of `/unread-count` ever corrected it.
 *
 * One rule now: `getUnreadFanout` returns the account-wide count plus the
 * sessions it over-counts for, responses resolve it for the caller and socket
 * frames carry both so the gateway can resolve it per device.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import {
  bearer,
  makeAccessToken,
  TEST_SESSION_ID,
  TEST_USER_ID,
} from "../helpers/auth.js";
import { NotificationService } from "../../src/services/notification.service.js";
import { unreadCountForSession } from "../../src/repositories/notification.repository.js";

const BASE = "/api/chat/notifications";

/** The session the phantom badge belonged to: this device's own login alert. */
const OWN_LOGIN = TEST_SESSION_ID;

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  ({ app, mocks } = buildApp());
});

describe("unreadCountForSession", () => {
  it("is the account count when this session hides nothing", () => {
    expect(
      unreadCountForSession({ unreadCount: 3, selfHiddenSessions: [] }, "s-1")
    ).toBe(3);
    expect(
      unreadCountForSession(
        { unreadCount: 3, selfHiddenSessions: ["s-2"] },
        "s-1"
      )
    ).toBe(3);
  });

  it("subtracts one per row hidden from this session, never below zero", () => {
    expect(
      unreadCountForSession(
        { unreadCount: 1, selfHiddenSessions: ["s-1"] },
        "s-1"
      )
    ).toBe(0);
    expect(
      unreadCountForSession(
        { unreadCount: 3, selfHiddenSessions: ["s-1", "s-1"] },
        "s-1"
      )
    ).toBe(1);
    expect(
      unreadCountForSession(
        { unreadCount: 1, selfHiddenSessions: ["s-1", "s-1"] },
        "s-1"
      )
    ).toBe(0);
  });

  it("keeps the account count for a caller with no session", () => {
    expect(
      unreadCountForSession({ unreadCount: 2, selfHiddenSessions: ["s-1"] }, "")
    ).toBe(2);
  });
});

describe("REST responses answer with the CALLER's count", () => {
  it("POST /read: the screenshot case — nothing unread left to show, so no badge", async () => {
    // One unread row remains account-wide: this device's own Login Detected
    // alert, which its list refuses to show it. Its badge must read 0.
    mocks.notificationRepo.markManyRead.mockResolvedValue(1);
    mocks.notificationRepo.getUnreadFanout.mockResolvedValue({
      unreadCount: 1,
      selfHiddenSessions: [OWN_LOGIN],
    });

    const res = await request(app)
      .post(`${BASE}/read`)
      .set(bearer(makeAccessToken()))
      .send({ notificationId: "notif-1" });

    expect(res.status).toBe(200);
    expect(res.body.data.unreadCount).toBe(0);
  });

  it("POST /read: another device's login alert still counts here", async () => {
    mocks.notificationRepo.markManyRead.mockResolvedValue(1);
    mocks.notificationRepo.getUnreadFanout.mockResolvedValue({
      unreadCount: 1,
      selfHiddenSessions: ["some-other-session"],
    });

    const res = await request(app)
      .post(`${BASE}/read`)
      .set(bearer(makeAccessToken()))
      .send({ notificationId: "notif-1" });

    expect(res.body.data.unreadCount).toBe(1);
  });

  it("POST /read-all: opening and reading the inbox leaves no badge behind", async () => {
    mocks.notificationRepo.getUnreadFanout.mockResolvedValue({
      unreadCount: 1,
      selfHiddenSessions: [OWN_LOGIN],
    });

    const res = await request(app)
      .post(`${BASE}/read-all`)
      .set(bearer(makeAccessToken()))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.unreadCount).toBe(0);
  });

  it("DELETE /:id: a removed row decrements the caller's count, phantom-free", async () => {
    mocks.notificationRepo.deleteById.mockResolvedValue({ count: 1 });
    mocks.notificationRepo.getUnreadFanout.mockResolvedValue({
      unreadCount: 2,
      selfHiddenSessions: [OWN_LOGIN],
    });

    const res = await request(app)
      .delete(`${BASE}/n1`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
    expect(res.body.data.unreadCount).toBe(1);
  });

  it("GET /unread-count stays the same answer the mutations now give", async () => {
    // This endpoint was always session-scoped — it is the rule the rest of the
    // module was brought in line with, so it must keep passing the session on.
    mocks.notificationRepo.getUnreadCount.mockResolvedValue(0);

    const res = await request(app)
      .get(`${BASE}/unread-count`)
      .set(bearer(makeAccessToken()));

    expect(res.body.data.unreadCount).toBe(0);
    expect(mocks.notificationRepo.getUnreadCount).toHaveBeenCalledWith(
      TEST_USER_ID,
      TEST_SESSION_ID
    );
  });
});

describe("realtime frames carry what the gateway needs to scope them", () => {
  const fanout = { unreadCount: 2, selfHiddenSessions: [OWN_LOGIN] };

  function build() {
    const repo = {
      markManyRead: jest.fn().mockResolvedValue(1),
      markAllRead: jest.fn().mockResolvedValue(undefined),
      deleteById: jest.fn().mockResolvedValue({ count: 1 }),
      getUnreadFanout: jest.fn().mockResolvedValue(fanout),
      findById: jest.fn().mockResolvedValue(null),
      recordAction: jest.fn(),
      findExpiredPendingLogins: jest.fn().mockResolvedValue([]),
    };
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    const service = new NotificationService(repo as never, redis as never);
    return { repo, redis, service };
  }

  /** Every `{event, data}` envelope published to this user's notify channel. */
  const framesOf = (redis: { publish: jest.Mock }) =>
    redis.publish.mock.calls.map(
      ([, body]: [string, string]) =>
        JSON.parse(body) as { event: string; data: Record<string, unknown> }
    );

  it("mark-read publishes the account count plus the sessions it over-counts", async () => {
    const { redis, service } = build();

    const result = await service.markManyRead(["n1"], TEST_USER_ID, OWN_LOGIN);

    // The caller is answered in its own terms…
    expect(result.unreadCount).toBe(1);
    // …while the broadcast stays account-wide, with the scoping rule attached.
    const frames = framesOf(redis);
    expect(frames.map((f) => f.event)).toEqual([
      "notification:read",
      "notification:count_update",
    ]);
    for (const frame of frames) {
      expect(frame.data.unreadCount).toBe(2);
      expect(frame.data.selfHiddenSessions).toEqual([OWN_LOGIN]);
    }
    expect(frames[0].data.notificationIds).toEqual(["n1"]);
  });

  it("mark-all-read publishes the same pair", async () => {
    const { redis, service } = build();

    await service.markAllRead(TEST_USER_ID, "ALL", null, OWN_LOGIN);

    expect(framesOf(redis).map((f) => f.event)).toEqual([
      "notification:all-read",
      "notification:count_update",
    ]);
    expect(framesOf(redis)[0].data.selfHiddenSessions).toEqual([OWN_LOGIN]);
  });

  it("delete publishes a scoped count, and publishes nothing when it removed nothing", async () => {
    const { repo, redis, service } = build();

    await service.deleteNotification("n1", TEST_USER_ID, OWN_LOGIN);
    expect(framesOf(redis).map((f) => f.event)).toEqual([
      "notification:deleted",
      "notification:count_update",
    ]);
    expect(framesOf(redis)[0].data.notificationId).toBe("n1");

    redis.publish.mockClear();
    repo.deleteById.mockResolvedValue({ count: 0 });
    const result = await service.deleteNotification(
      "n1",
      TEST_USER_ID,
      OWN_LOGIN
    );
    expect(result.deleted).toBe(false);
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("acting on a Login Detected card moves the badge without a refetch", async () => {
    // `recordAction` marks the row read, so the count changed — but the frame
    // it publishes (`notification:updated`) carries no count. Without the
    // alias, tapping "It's Me" left the old number on screen.
    const { repo, redis, service } = build();
    repo.findById.mockResolvedValue(null);
    repo.recordAction.mockResolvedValue({
      id: "n1",
      type: "auth.security_new_login",
      loginSessionId: "other-session",
      version: 2,
      createdAt: new Date(1000),
      payload: {
        title: "Login Detected",
        body: "New login detected",
        data: {},
      },
    });

    await service.recordAction("n1", TEST_USER_ID, "This was you.", "TRUSTED");

    const frames = framesOf(redis);
    expect(frames.map((f) => f.event)).toEqual([
      "notification:updated",
      "notification:count_update",
    ]);
    expect(frames[1].data.unreadCount).toBe(2);
    expect(frames[1].data.selfHiddenSessions).toEqual([OWN_LOGIN]);
  });

  it("the expiry sweep moves the badge too — same transition, same events", async () => {
    const { repo, redis, service } = build();
    repo.findExpiredPendingLogins.mockResolvedValue([
      { id: "n1", userId: TEST_USER_ID },
    ]);
    repo.recordAction.mockResolvedValue({
      id: "n1",
      type: "auth.security_new_login",
      loginSessionId: "other-session",
      version: 2,
      createdAt: new Date(1000),
      payload: {
        title: "Login Detected",
        body: "New login detected",
        data: {},
      },
    });

    const resolved = await service.sweepExpiredLoginNotifications(
      new Date(),
      10
    );

    expect(resolved).toBe(1);
    expect(framesOf(redis).map((f) => f.event)).toContain(
      "notification:count_update"
    );
  });
});
