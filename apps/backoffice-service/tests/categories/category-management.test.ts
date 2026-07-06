/**
 * Category Management admin API (self-prefixed at /v1/categories/*). Requires
 * `categories.manage`. Covers create (uniqueness/validation), update
 * (duplicate name / not-found), delete (soft vs hard, not-found), list
 * (pagination/search/sort/empty), and concurrent duplicate creation.
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
    categoryService: {
      listCategories: jest.fn(),
      createCategory: jest.fn(),
      updateCategory: jest.fn(),
      updateCategoryVisibility: jest.fn(),
      deleteCategory: jest.fn(),
    },
  };
});

import { ConflictError, NotFoundError } from "@aimess/errors";
import request from "supertest";

import { app } from "../../src/app.js";
import { adminUserRepository } from "../../src/repositories/index.js";
import { getCachedAdminPermissions } from "../../src/lib/admin-perms-cache.js";
import { categoryService } from "../../src/services/index.js";
import { PERMISSIONS } from "../../src/constants/index.js";
import { bearer, makeAdminAccessToken } from "../helpers/auth.js";
import { configureActiveAdmin, grantPermissions } from "../helpers/admin.js";

const findById = adminUserRepository.findById as jest.Mock;
const perms = getCachedAdminPermissions as jest.Mock;
const svc = categoryService as unknown as Record<string, jest.Mock>;

const CAT = "a".repeat(24);

const catDetail = (over: Record<string, unknown> = {}) => ({
  id: CAT,
  name: "Technology",
  slug: "technology",
  visible: true,
  order: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

const PAGE = {
  data: [catDetail()],
  pagination: {
    mode: "offset",
    page: 1,
    limit: 20,
    total: 1,
    totalApprox: 1,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
    nextCursor: null,
  },
};

const auth = () => bearer(makeAdminAccessToken());

beforeEach(() => {
  jest.clearAllMocks();
  configureActiveAdmin(findById);
  grantPermissions(perms, [PERMISSIONS.CATEGORIES_MANAGE]);
  svc.listCategories.mockResolvedValue(PAGE);
  svc.createCategory.mockResolvedValue(catDetail());
  svc.updateCategory.mockResolvedValue(catDetail({ name: "Renamed" }));
  svc.updateCategoryVisibility.mockResolvedValue(catDetail({ visible: false }));
  svc.deleteCategory.mockResolvedValue(undefined);
});

describe("GET /v1/categories", () => {
  it("returns 200 with the list + pagination", async () => {
    const res = await request(app).get("/v1/categories").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("returns 200 with an empty result set", async () => {
    svc.listCategories.mockResolvedValueOnce({
      data: [],
      pagination: {
        mode: "offset",
        page: 1,
        limit: 20,
        total: 0,
        totalApprox: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
        nextCursor: null,
      },
    });
    const res = await request(app).get("/v1/categories").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it("forwards search/status/sort/pagination to the service", async () => {
    await request(app)
      .get(
        "/v1/categories?search=tech&status=visible&sort=name:desc&page=2&limit=10"
      )
      .set(auth());
    const arg = svc.listCategories.mock.calls[0][0];
    expect(arg.search).toBe("tech");
    expect(arg.status).toBe("visible");
    expect(arg.sort).toBe("name:desc");
    expect(arg.page).toBe(2);
    expect(arg.limit).toBe(10);
  });

  it("defaults status to 'all' and sort to 'order:asc'", async () => {
    await request(app).get("/v1/categories").set(auth());
    const arg = svc.listCategories.mock.calls[0][0];
    expect(arg.status).toBe("all");
    expect(arg.sort).toBe("order:asc");
  });

  it("returns 400 for an invalid sort token", async () => {
    const res = await request(app)
      .get("/v1/categories?sort=recipients:asc")
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid status enum", async () => {
    const res = await request(app)
      .get("/v1/categories?status=deleted")
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 400 for limit over max", async () => {
    const res = await request(app).get("/v1/categories?limit=500").set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/v1/categories");
    expect(res.status).toBe(401);
  });

  it("returns 403 without categories.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app).get("/v1/categories").set(auth());
    expect(res.status).toBe(403);
    expect(svc.listCategories).not.toHaveBeenCalled();
  });
});

describe("POST /v1/categories (create)", () => {
  it("creates → 201", async () => {
    const res = await request(app)
      .post("/v1/categories")
      .set(auth())
      .send({ name: "Technology" });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(CAT);
    expect(svc.createCategory).toHaveBeenCalledTimes(1);
  });

  it("trims whitespace before validation/persistence", async () => {
    await request(app)
      .post("/v1/categories")
      .set(auth())
      .send({ name: "  Technology  " });
    const [input] = svc.createCategory.mock.calls[0];
    expect(input.name).toBe("Technology");
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post("/v1/categories").set(auth()).send({});
    expect(res.status).toBe(400);
    expect(svc.createCategory).not.toHaveBeenCalled();
  });

  it("returns 400 when name is too short (<2)", async () => {
    const res = await request(app)
      .post("/v1/categories")
      .set(auth())
      .send({ name: "a" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name is too long (>80)", async () => {
    const res = await request(app)
      .post("/v1/categories")
      .set(auth())
      .send({ name: "x".repeat(81) });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the name is already taken (case-insensitive)", async () => {
    svc.createCategory.mockRejectedValue(
      new ConflictError("CATEGORY_NAME_TAKEN")
    );
    const res = await request(app)
      .post("/v1/categories")
      .set(auth())
      .send({ name: "technology" });
    expect(res.status).toBe(409);
  });

  it("handles a concurrent duplicate create as a 409 (unique-constraint race)", async () => {
    svc.createCategory
      .mockResolvedValueOnce(catDetail())
      .mockRejectedValueOnce(new ConflictError("CATEGORY_NAME_TAKEN"));

    const [first, second] = await Promise.all([
      request(app)
        .post("/v1/categories")
        .set(auth())
        .send({ name: "Technology" }),
      request(app)
        .post("/v1/categories")
        .set(auth())
        .send({ name: "Technology" }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/v1/categories")
      .send({ name: "Technology" });
    expect(res.status).toBe(401);
  });

  it("returns 403 without categories.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .post("/v1/categories")
      .set(auth())
      .send({ name: "Technology" });
    expect(res.status).toBe(403);
    expect(svc.createCategory).not.toHaveBeenCalled();
  });
});

describe("PATCH /v1/categories/:categoryId (update)", () => {
  it("updates name → 200", async () => {
    const res = await request(app)
      .patch(`/v1/categories/${CAT}`)
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Renamed");
    expect(svc.updateCategory).toHaveBeenCalledWith(
      CAT,
      { name: "Renamed" },
      expect.any(String)
    );
  });

  it("toggles visibility → 200", async () => {
    const res = await request(app)
      .patch(`/v1/categories/${CAT}`)
      .set(auth())
      .send({ visible: false });
    expect(res.status).toBe(200);
  });

  it("returns 400 with an empty body (refine requires name or visible)", async () => {
    const res = await request(app)
      .patch(`/v1/categories/${CAT}`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(svc.updateCategory).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid categoryId param", async () => {
    const res = await request(app)
      .patch("/v1/categories/not-an-id")
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the category does not exist", async () => {
    svc.updateCategory.mockRejectedValue(
      new NotFoundError("CATEGORY_NOT_FOUND")
    );
    const res = await request(app)
      .patch(`/v1/categories/${CAT}`)
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(404);
  });

  it("returns 409 on a duplicate name", async () => {
    svc.updateCategory.mockRejectedValue(
      new ConflictError("CATEGORY_NAME_TAKEN")
    );
    const res = await request(app)
      .patch(`/v1/categories/${CAT}`)
      .set(auth())
      .send({ name: "Dup" });
    expect(res.status).toBe(409);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .patch(`/v1/categories/${CAT}`)
      .send({ name: "Renamed" });
    expect(res.status).toBe(401);
  });

  it("returns 403 without categories.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .patch(`/v1/categories/${CAT}`)
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(403);
    expect(svc.updateCategory).not.toHaveBeenCalled();
  });
});

describe("PATCH /v1/categories/:categoryId/visibility", () => {
  it("sets HIDDEN → 200", async () => {
    const res = await request(app)
      .patch(`/v1/categories/${CAT}/visibility`)
      .set(auth())
      .send({ status: "HIDDEN" });
    expect(res.status).toBe(200);
    expect(svc.updateCategoryVisibility).toHaveBeenCalledWith(
      CAT,
      "HIDDEN",
      expect.any(String)
    );
  });

  it("sets VISIBLE → 200", async () => {
    const res = await request(app)
      .patch(`/v1/categories/${CAT}/visibility`)
      .set(auth())
      .send({ status: "VISIBLE" });
    expect(res.status).toBe(200);
    expect(svc.updateCategoryVisibility).toHaveBeenCalledWith(
      CAT,
      "VISIBLE",
      expect.any(String)
    );
  });

  it("returns 400 for an invalid status value", async () => {
    const res = await request(app)
      .patch(`/v1/categories/${CAT}/visibility`)
      .set(auth())
      .send({ status: "hidden" });
    expect(res.status).toBe(400);
    expect(svc.updateCategoryVisibility).not.toHaveBeenCalled();
  });

  it("returns 400 when status is missing", async () => {
    const res = await request(app)
      .patch(`/v1/categories/${CAT}/visibility`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid categoryId param", async () => {
    const res = await request(app)
      .patch("/v1/categories/not-an-id/visibility")
      .set(auth())
      .send({ status: "HIDDEN" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the category does not exist", async () => {
    svc.updateCategoryVisibility.mockRejectedValue(
      new NotFoundError("CATEGORY_NOT_FOUND")
    );
    const res = await request(app)
      .patch(`/v1/categories/${CAT}/visibility`)
      .set(auth())
      .send({ status: "HIDDEN" });
    expect(res.status).toBe(404);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .patch(`/v1/categories/${CAT}/visibility`)
      .send({ status: "HIDDEN" });
    expect(res.status).toBe(401);
  });

  it("returns 403 without categories.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app)
      .patch(`/v1/categories/${CAT}/visibility`)
      .set(auth())
      .send({ status: "HIDDEN" });
    expect(res.status).toBe(403);
    expect(svc.updateCategoryVisibility).not.toHaveBeenCalled();
  });
});

describe("DELETE /v1/categories/:categoryId", () => {
  it("hard-deletes when unreferenced → 200 null data", async () => {
    svc.deleteCategory.mockResolvedValue(undefined);
    const res = await request(app).delete(`/v1/categories/${CAT}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(svc.deleteCategory).toHaveBeenCalledWith(CAT, expect.any(String));
  });

  it("soft-deletes when referenced by communities → still 200", async () => {
    svc.deleteCategory.mockResolvedValue(undefined);
    const res = await request(app).delete(`/v1/categories/${CAT}`).set(auth());
    expect(res.status).toBe(200);
  });

  it("returns 404 when the category does not exist", async () => {
    svc.deleteCategory.mockRejectedValue(
      new NotFoundError("CATEGORY_NOT_FOUND")
    );
    const res = await request(app).delete(`/v1/categories/${CAT}`).set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 409 when the category is assigned to active communities", async () => {
    svc.deleteCategory.mockRejectedValue(
      new ConflictError("CATEGORY_HAS_ACTIVE_COMMUNITIES")
    );
    const res = await request(app).delete(`/v1/categories/${CAT}`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(
      "Category cannot be deleted because it is assigned to active communities."
    );
  });

  it("returns 400 for an invalid categoryId", async () => {
    const res = await request(app)
      .delete("/v1/categories/not-an-id")
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).delete(`/v1/categories/${CAT}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 without categories.manage", async () => {
    grantPermissions(perms, []);
    const res = await request(app).delete(`/v1/categories/${CAT}`).set(auth());
    expect(res.status).toBe(403);
    expect(svc.deleteCategory).not.toHaveBeenCalled();
  });
});
