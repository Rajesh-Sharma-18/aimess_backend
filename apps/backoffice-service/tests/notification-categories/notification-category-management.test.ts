/**
 * Super Admin notification-category configuration (self-prefixed at
 * /v1/notification-categories/*).
 *
 * The screen is configuration-only, and that is what these assertions are
 * about: the catalogue can be read and two fields can be changed, and every
 * other verb — create, delete, rename — has no route to reach. Both routes are
 * gated on `settings.manage`, which only SUPER_ADMIN holds.
 */
jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: { findById: jest.fn() },
}));
jest.mock("../../src/lib/admin-perms-cache.js", () => ({
  getCachedAdminPermissions: jest.fn(async () => [] as string[]),
  invalidateAdminPermissions: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/index.js", () => {
  const actual = jest.requireActual("../../src/services/index.js");
  return {
    __esModule: true,
    ...actual,
    notificationCategoryService: {
      listCategories: jest.fn(),
      updateCategory: jest.fn(),
      updateCategories: jest.fn(),
    },
  };
});

import { BadRequestError, NotFoundError } from "@aimess/errors";
import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { notificationCategoryService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = notificationCategoryService as unknown as Record<string, jest.Mock>;

const ALL_PLATFORMS = ["ANDROID", "IOS", "WEB"];

const catalogue = () => [
  {
    id: "FRIEND_REQUEST",
    priority: 1,
    defaultLabel: "Friend Request",
    iconKey: "person_add",
    enabledPlatforms: ALL_PLATFORMS,
    updatedAt: 1757404800000,
  },
  {
    id: "CALLS",
    priority: 4,
    defaultLabel: "Calls",
    iconKey: "call",
    enabledPlatforms: ALL_PLATFORMS,
    updatedAt: 1757404800000,
  },
];

const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  jest.clearAllMocks();
  configureActiveAdmin(findById);
  grantPermissions(perms, [PERMISSIONS.SETTINGS_MANAGE]);
  svc.listCategories.mockResolvedValue(catalogue());
  svc.updateCategory.mockResolvedValue({
    ...catalogue()[1],
    enabledPlatforms: ["ANDROID", "IOS"],
  });
  svc.updateCategories.mockResolvedValue(catalogue());
});

describe("GET /v1/notification-categories", () => {
  it("returns the catalogue with its stable ids and platform state", async () => {
    const res = await request(app)
      .get("/v1/notification-categories")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual([
      "FRIEND_REQUEST",
      "CALLS",
    ]);
    expect(res.body.data[0].enabledPlatforms).toEqual(ALL_PLATFORMS);
  });

  it.each([
    ["zero", 0],
    ["a negative", -1],
    ["past the catalogue size", 7],
    ["a fraction", 1.5],
    ["a string", "abc"],
    ["null", null],
  ])("rejects %s priority before it reaches the service", async (_label, priority) => {
    const res = await request(app)
      .patch("/v1/notification-categories/CALLS")
      .set(auth())
      .send({ priority });

    expect(res.status).toBe(400);
    expect(svc.updateCategory).not.toHaveBeenCalled();
  });

  it.each([1, 6])("accepts priority %p", async (priority) => {
    svc.updateCategory.mockResolvedValue({ ...catalogue()[1], priority });

    const res = await request(app)
      .patch("/v1/notification-categories/CALLS")
      .set(auth())
      .send({ priority });

    expect(res.status).toBe(200);
  });

  it("surfaces a priority chat-service refused as a 400, not a 404", async () => {
    svc.updateCategory.mockRejectedValue(
      new BadRequestError("NOTIFICATION_CATEGORY_PRIORITY_INVALID")
    );

    const res = await request(app)
      .patch("/v1/notification-categories/CALLS")
      .set(auth())
      .send({ priority: 1 });

    expect(res.status).toBe(400);
  });

  it("rejects an admin without settings.manage", async () => {
    grantPermissions(perms, [PERMISSIONS.CATEGORIES_MANAGE]);

    const res = await request(app)
      .get("/v1/notification-categories")
      .set(auth());

    expect(res.status).toBe(403);
    expect(svc.listCategories).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await request(app).get("/v1/notification-categories");

    expect(res.status).toBe(401);
    expect(svc.listCategories).not.toHaveBeenCalled();
  });
});

describe("PATCH /v1/notification-categories/:categoryId", () => {
  it("disables one category for one platform, leaving the others alone", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories/CALLS")
      .set(auth())
      .send({ enabledPlatforms: ["ANDROID", "IOS"] });

    expect(res.status).toBe(200);
    expect(svc.updateCategory).toHaveBeenCalledWith(
      "CALLS",
      { enabledPlatforms: ["ANDROID", "IOS"] },
      expect.any(String)
    );
    expect(res.body.data.enabledPlatforms).toEqual(["ANDROID", "IOS"]);
  });

  it("changes a priority", async () => {
    svc.updateCategory.mockResolvedValue({ ...catalogue()[1], priority: 1 });

    const res = await request(app)
      .patch("/v1/notification-categories/CALLS")
      .set(auth())
      .send({ priority: 1 });

    expect(res.status).toBe(200);
    expect(svc.updateCategory).toHaveBeenCalledWith(
      "CALLS",
      { priority: 1 },
      expect.any(String)
    );
  });

  it("accepts an empty platform list — hidden everywhere is a valid state", async () => {
    svc.updateCategory.mockResolvedValue({
      ...catalogue()[1],
      enabledPlatforms: [],
    });

    const res = await request(app)
      .patch("/v1/notification-categories/CALLS")
      .set(auth())
      .send({ enabledPlatforms: [] });

    expect(res.status).toBe(200);
  });

  it("rejects a body that changes nothing", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories/CALLS")
      .set(auth())
      .send({});

    expect(res.status).toBe(400);
    expect(svc.updateCategory).not.toHaveBeenCalled();
  });

  it("rejects an unknown platform", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories/CALLS")
      .set(auth())
      .send({ enabledPlatforms: ["DESKTOP"] });

    expect(res.status).toBe(400);
    expect(svc.updateCategory).not.toHaveBeenCalled();
  });

  it("ignores an id sent in the body — the id is the path, and is never writable", async () => {
    await request(app)
      .patch("/v1/notification-categories/CALLS")
      .set(auth())
      .send({ id: "RENAMED", priority: 2 });

    expect(svc.updateCategory).toHaveBeenCalledWith(
      "CALLS",
      { priority: 2 },
      expect.any(String)
    );
  });

  it("reports an id outside the seeded catalogue as not found", async () => {
    svc.updateCategory.mockRejectedValue(
      new NotFoundError("NOTIFICATION_CATEGORY_NOT_FOUND")
    );

    const res = await request(app)
      .patch("/v1/notification-categories/PROMOTIONS")
      .set(auth())
      .send({ priority: 1 });

    expect(res.status).toBe(404);
  });

  it("rejects an admin without settings.manage", async () => {
    grantPermissions(perms, [PERMISSIONS.CATEGORIES_MANAGE]);

    const res = await request(app)
      .patch("/v1/notification-categories/CALLS")
      .set(auth())
      .send({ priority: 1 });

    expect(res.status).toBe(403);
    expect(svc.updateCategory).not.toHaveBeenCalled();
  });
});

/**
 * The grid's Save — the administrator's whole draft in one atomic request.
 *
 * The route exists so the catalogue-wide priority rule can be decided at all: a
 * valid swap and a collision differ only in what the OTHER rows are doing, and
 * a sequence of per-row writes never shows the backend both at once.
 */
describe("PATCH /v1/notification-categories (bulk save)", () => {
  it("saves several rows — platforms and priority — in one call", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({
        categories: [
          { id: "FRIEND_REQUEST", priority: 2 },
          { id: "CALLS", priority: 1, enabledPlatforms: ["ANDROID", "IOS"] },
        ],
      });

    expect(res.status).toBe(200);
    expect(svc.updateCategories).toHaveBeenCalledWith(
      {
        categories: [
          { id: "FRIEND_REQUEST", priority: 2 },
          { id: "CALLS", priority: 1, enabledPlatforms: ["ANDROID", "IOS"] },
        ],
      },
      expect.any(String)
    );
    // The WHOLE catalogue comes back, so the panel reconciles against what was
    // persisted rather than against the draft it just sent.
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual([
      "FRIEND_REQUEST",
      "CALLS",
    ]);
  });

  it("accepts a 1<->2 swap: the final state is what is judged, not the halfway point", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({
        categories: [
          { id: "FRIEND_REQUEST", priority: 2 },
          { id: "CALLS", priority: 1 },
        ],
      });

    expect(res.status).toBe(200);
    expect(svc.updateCategories).toHaveBeenCalled();
  });

  it("reports a conflicting priority as a 400 carrying the stable code — never a success", async () => {
    svc.updateCategories.mockRejectedValue(
      new BadRequestError("NOTIFICATION_CATEGORY_PRIORITY_CONFLICT")
    );

    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({ categories: [{ id: "COMMUNITY", priority: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("NOTIFICATION_CATEGORY_PRIORITY_CONFLICT");
    expect(res.body.error.code).toBe("NOTIFICATION_CATEGORY_PRIORITY_CONFLICT");
  });

  it("rejects two rows in one draft claiming the same priority before the service runs", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({
        categories: [
          { id: "CALLS", priority: 3 },
          { id: "MENTION", priority: 3 },
        ],
      });

    expect(res.status).toBe(400);
    expect(svc.updateCategories).not.toHaveBeenCalled();
  });

  it("rejects the same category twice in one draft", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({
        categories: [
          { id: "CALLS", priority: 3 },
          { id: "CALLS", enabledPlatforms: ["WEB"] },
        ],
      });

    expect(res.status).toBe(400);
    expect(svc.updateCategories).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["a negative", -1],
    ["past the catalogue size", 7],
    ["a fraction", 1.5],
    ["a string", "abc"],
    ["null", null],
  ])("rejects %s priority before it reaches the service", async (_label, priority) => {
    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({ categories: [{ id: "CALLS", priority }] });

    expect(res.status).toBe(400);
    expect(svc.updateCategories).not.toHaveBeenCalled();
  });

  it("rejects an empty draft — a save that changes nothing is not a save", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({ categories: [] });

    expect(res.status).toBe(400);
    expect(svc.updateCategories).not.toHaveBeenCalled();
  });

  it("rejects a row that carries neither priority nor platforms", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({ categories: [{ id: "CALLS" }] });

    expect(res.status).toBe(400);
    expect(svc.updateCategories).not.toHaveBeenCalled();
  });

  it("rejects an unknown platform", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({ categories: [{ id: "CALLS", enabledPlatforms: ["DESKTOP"] }] });

    expect(res.status).toBe(400);
    expect(svc.updateCategories).not.toHaveBeenCalled();
  });

  it("accepts an empty platform list — hidden everywhere is a valid state", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({ categories: [{ id: "CALLS", enabledPlatforms: [] }] });

    expect(res.status).toBe(200);
  });

  it("reports an id outside the seeded catalogue as not found", async () => {
    svc.updateCategories.mockRejectedValue(
      new NotFoundError("NOTIFICATION_CATEGORY_NOT_FOUND")
    );

    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({ categories: [{ id: "PROMOTIONS", priority: 1 }] });

    expect(res.status).toBe(404);
  });

  it("rejects an admin without settings.manage", async () => {
    grantPermissions(perms, [PERMISSIONS.CATEGORIES_MANAGE]);

    const res = await request(app)
      .patch("/v1/notification-categories")
      .set(auth())
      .send({ categories: [{ id: "CALLS", priority: 1 }] });

    expect(res.status).toBe(403);
    expect(svc.updateCategories).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await request(app)
      .patch("/v1/notification-categories")
      .send({ categories: [{ id: "CALLS", priority: 1 }] });

    expect(res.status).toBe(401);
    expect(svc.updateCategories).not.toHaveBeenCalled();
  });
});

describe("the catalogue is fixed", () => {
  it("has no create route", async () => {
    const res = await request(app)
      .post("/v1/notification-categories")
      .set(auth())
      .send({ id: "PROMOTIONS", priority: 7 });

    expect(res.status).toBe(404);
  });

  it("has no delete route", async () => {
    const res = await request(app)
      .delete("/v1/notification-categories/CALLS")
      .set(auth());

    expect(res.status).toBe(404);
  });

  it("exposes no service method that could create or delete one", () => {
    const actual = jest.requireActual(
      "../../src/services/notification-category.service.js"
    ) as { notificationCategoryService: Record<string, unknown> };

    expect(Object.keys(actual.notificationCategoryService).sort()).toEqual([
      "listCategories",
      "updateCategories",
      "updateCategory",
    ]);
  });
});
