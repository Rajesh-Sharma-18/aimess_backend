/**
 * Integration tests — the catalogue endpoint.
 *   GET /api/chat/notifications/categories?platform=android|ios|web
 *
 * ONE response backs the chip row on all three clients, so what is asserted
 * here is the contract, not a rendering: authentication, platform filtering,
 * priority ordering, the version/updatedAt a client revalidates against, and
 * the absence of `ALL` — which is a client-side no-filter state, never a
 * category the server publishes.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import {
  bearer,
  makeAccessToken,
  makeExpiredAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";
import { NOTIFICATION_CATEGORY_SEED } from "../../src/lib/notification-category.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const AT = new Date("2026-09-09T10:00:00Z");

/** The catalogue as the collection holds it after the seed. */
const seededRows = (
  overrides: Record<string, string[]> = {},
  priorities: Record<string, number> = {}
) =>
  NOTIFICATION_CATEGORY_SEED.map((category) => ({
    id: category.id,
    priority: priorities[category.id] ?? category.priority,
    defaultLabel: category.defaultLabel,
    iconKey: category.iconKey,
    enabledPlatforms:
      overrides[category.id] ?? [...category.enabledPlatforms],
    updatedBy: null,
    createdAt: AT,
    updatedAt: AT,
  }));

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.notificationCategoryRepo.listAll.mockResolvedValue(seededRows());
});

const URL = "/api/chat/notifications/categories";

describe("GET /api/chat/notifications/categories", () => {
  it("returns the six seeded categories in priority order", async () => {
    const res = await request(app)
      .get(`${URL}?platform=web`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.categories.map((c: { id: string }) => c.id)).toEqual([
      "FRIEND_REQUEST",
      "COMMUNITY",
      "MENTION",
      "CALLS",
      "SYSTEM",
      "LIVE_NOW",
    ]);
  });

  it("carries id, priority, defaultLabel and iconKey on every entry", async () => {
    const res = await request(app)
      .get(`${URL}?platform=android`)
      .set(bearer(makeAccessToken()));

    expect(res.body.data.categories[0]).toEqual({
      id: "FRIEND_REQUEST",
      priority: 1,
      defaultLabel: "Friend Request",
      iconKey: "person_add",
    });
  });

  it("never includes ALL", async () => {
    const res = await request(app)
      .get(`${URL}?platform=ios`)
      .set(bearer(makeAccessToken()));

    expect(
      res.body.data.categories.some((c: { id: string }) => c.id === "ALL")
    ).toBe(false);
  });

  it("omits a category disabled for the requested platform only", async () => {
    mocks.notificationCategoryRepo.listAll.mockResolvedValue(
      seededRows({ CALLS: ["ANDROID", "IOS"] })
    );

    const [web, android, ios] = await Promise.all([
      request(app).get(`${URL}?platform=web`).set(bearer(makeAccessToken())),
      request(app).get(`${URL}?platform=android`).set(bearer(makeAccessToken())),
      request(app).get(`${URL}?platform=ios`).set(bearer(makeAccessToken())),
    ]);

    const ids = (res: { body: { data: { categories: { id: string }[] } } }) =>
      res.body.data.categories.map((c) => c.id);

    expect(ids(web)).not.toContain("CALLS");
    expect(ids(android)).toContain("CALLS");
    expect(ids(ios)).toContain("CALLS");
  });

  it("reorders when an administrator changes a priority", async () => {
    mocks.notificationCategoryRepo.listAll.mockResolvedValue(
      seededRows({}, { CALLS: 1, FRIEND_REQUEST: 2 })
    );

    const res = await request(app)
      .get(`${URL}?platform=web`)
      .set(bearer(makeAccessToken()));

    expect(res.body.data.categories[0].id).toBe("CALLS");
  });

  it("exposes version + updatedAt for offline revalidation", async () => {
    const first = await request(app)
      .get(`${URL}?platform=web`)
      .set(bearer(makeAccessToken()));

    expect(typeof first.body.data.version).toBe("string");
    expect(first.body.data.version.length).toBeGreaterThan(0);
    expect(first.body.data.updatedAt).toBe(AT.toISOString());
  });

  it("echoes the platform it answered for", async () => {
    const res = await request(app)
      .get(`${URL}?platform=ANDROID`)
      .set(bearer(makeAccessToken()));

    expect(res.body.data.platform).toBe("ANDROID");
  });

  it("falls back to web for a missing or unrecognised platform", async () => {
    // A typo in a query string must not cost a client its entire chip row.
    for (const query of ["", "?platform=", "?platform=desktop"]) {
      const res = await request(app)
        .get(`${URL}${query}`)
        .set(bearer(makeAccessToken()));

      expect(res.status).toBe(200);
      expect(res.body.data.platform).toBe("WEB");
    }
  });

  it("serves the seeded defaults when the collection is empty", async () => {
    mocks.notificationCategoryRepo.listAll.mockResolvedValue([]);

    const res = await request(app)
      .get(`${URL}?platform=web`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.categories).toHaveLength(6);
  });

  describe("authentication", () => {
    it("rejects a request with no token", async () => {
      expect((await request(app).get(URL)).status).toBe(401);
    });

    it("rejects an expired token", async () => {
      const res = await request(app)
        .get(URL)
        .set(bearer(makeExpiredAccessToken()));
      expect(res.status).toBe(401);
    });

    it("rejects a forged token", async () => {
      const res = await request(app)
        .get(URL)
        .set(bearer(makeForgedAccessToken()));
      expect(res.status).toBe(401);
    });
  });

  it("is not shadowed by the notification-id routes", async () => {
    // `categories` must never be read as a notification id — the id routes are
    // DELETE/PATCH, and this one has to stay a GET on its own path.
    const res = await request(app)
      .get(`${URL}?platform=web`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.notificationRepo.findByUserId).not.toHaveBeenCalled();
  });
});
