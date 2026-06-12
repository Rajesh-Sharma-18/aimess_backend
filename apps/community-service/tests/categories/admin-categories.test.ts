/**
 * Admin category CRUD:
 *   GET    /categories/admin
 *   POST   /categories
 *   PATCH  /categories/:categoryId
 *   DELETE /categories/:categoryId
 *
 * NOTE: these admin routes are gated by a platform-admin role check (GlobalRole
 * ADMIN, carried on the access token) in addition to the access-token
 * middleware, so the positive paths use an admin token. A non-admin token is
 * rejected with 403 before reaching the service (see the "platform-admin gate"
 * block). Conflict / not-found / in-use branches come from the service.
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    listCategoriesAdmin: jest.fn(),
    createCategory: jest.fn(),
    updateCategory: jest.fn(),
    deleteCategory: jest.fn(),
  },
}));

import request from "supertest";

import { ConflictError, NotFoundError } from "@aimess/errors";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";
import {
  bearer,
  makeAccessToken,
  makeAdminAccessToken,
} from "../helpers/auth.js";

const svc = communityService as unknown as Record<string, jest.Mock>;
const auth = () => bearer(makeAdminAccessToken());

const CAT = "a".repeat(24);

const catDto = (over: Record<string, unknown> = {}) => ({
  id: CAT,
  name: "Tech",
  slug: "tech",
  visible: true,
  order: 0,
  ...over,
});

describe("GET /categories/admin", () => {
  beforeEach(() => {
    svc.listCategoriesAdmin.mockResolvedValue({
      categories: [catDto()],
      pagination: {
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    });
  });

  it("returns 200 with categories + pagination", async () => {
    const res = await request(app)
      .get("/api/v1/communities/categories/admin")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.categories).toHaveLength(1);
  });

  it("forwards search + status filters", async () => {
    await request(app)
      .get("/api/v1/communities/categories/admin")
      .query({ search: "te", status: "hidden" })
      .set(auth());
    expect(svc.listCategoriesAdmin.mock.calls[0][0]).toMatchObject({
      search: "te",
      status: "hidden",
    });
  });

  it("returns 400 for an invalid status enum", async () => {
    const res = await request(app)
      .get("/api/v1/communities/categories/admin")
      .query({ status: "deleted" })
      .set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/communities/categories/admin");
    expect(res.status).toBe(401);
  });
});

describe("POST /categories (create)", () => {
  beforeEach(() => {
    svc.createCategory.mockResolvedValue(catDto());
  });

  it("creates → 201", async () => {
    const res = await request(app)
      .post("/api/v1/communities/categories")
      .set(auth())
      .send({ name: "Technology" });
    expect(res.status).toBe(201);
    expect(svc.createCategory).toHaveBeenCalledWith({ name: "Technology" });
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/v1/communities/categories")
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(svc.createCategory).not.toHaveBeenCalled();
  });

  it("returns 400 when name is too short (<2)", async () => {
    const res = await request(app)
      .post("/api/v1/communities/categories")
      .set(auth())
      .send({ name: "a" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name is too long (>80)", async () => {
    const res = await request(app)
      .post("/api/v1/communities/categories")
      .set(auth())
      .send({ name: "x".repeat(81) });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the name is taken", async () => {
    svc.createCategory.mockRejectedValue(
      new ConflictError("CATEGORY_NAME_TAKEN")
    );
    const res = await request(app)
      .post("/api/v1/communities/categories")
      .set(auth())
      .send({ name: "Technology" });
    expect(res.status).toBe(409);
  });
});

describe("PATCH /categories/:categoryId", () => {
  beforeEach(() => {
    svc.updateCategory.mockResolvedValue(catDto({ name: "Renamed" }));
  });

  it("updates name → 200", async () => {
    const res = await request(app)
      .patch(`/api/v1/communities/categories/${CAT}`)
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(svc.updateCategory).toHaveBeenCalledWith(CAT, { name: "Renamed" });
  });

  it("toggles visibility → 200", async () => {
    const res = await request(app)
      .patch(`/api/v1/communities/categories/${CAT}`)
      .set(auth())
      .send({ visible: false });
    expect(res.status).toBe(200);
  });

  it("returns 400 with an empty body (refine requires name or visible)", async () => {
    const res = await request(app)
      .patch(`/api/v1/communities/categories/${CAT}`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(svc.updateCategory).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid categoryId param", async () => {
    const res = await request(app)
      .patch("/api/v1/communities/categories/bad-id")
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the category does not exist", async () => {
    svc.updateCategory.mockRejectedValue(
      new NotFoundError("CATEGORY_NOT_FOUND")
    );
    const res = await request(app)
      .patch(`/api/v1/communities/categories/${CAT}`)
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(404);
  });

  it("returns 409 on a duplicate name", async () => {
    svc.updateCategory.mockRejectedValue(
      new ConflictError("CATEGORY_NAME_TAKEN")
    );
    const res = await request(app)
      .patch(`/api/v1/communities/categories/${CAT}`)
      .set(auth())
      .send({ name: "Dup" });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /categories/:categoryId", () => {
  it("deletes → 200 null data", async () => {
    svc.deleteCategory.mockResolvedValue(undefined);
    const res = await request(app)
      .delete(`/api/v1/communities/categories/${CAT}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(svc.deleteCategory).toHaveBeenCalledWith(CAT);
  });

  it("returns 404 when the category is gone", async () => {
    svc.deleteCategory.mockRejectedValue(
      new NotFoundError("CATEGORY_NOT_FOUND")
    );
    const res = await request(app)
      .delete(`/api/v1/communities/categories/${CAT}`)
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 409 when the category is in use", async () => {
    svc.deleteCategory.mockRejectedValue(new ConflictError("CATEGORY_IN_USE"));
    const res = await request(app)
      .delete(`/api/v1/communities/categories/${CAT}`)
      .set(auth());
    expect(res.status).toBe(409);
  });

  it("returns 400 for an invalid categoryId", async () => {
    const res = await request(app)
      .delete("/api/v1/communities/categories/nope")
      .set(auth());
    expect(res.status).toBe(400);
  });
});

describe("platform-admin gate", () => {
  // A default token carries role USER, which the route guard must reject before
  // the request ever reaches the underlying service method.
  const userAuth = () => bearer(makeAccessToken());

  it("rejects GET /categories/admin for a non-admin → 403", async () => {
    const res = await request(app)
      .get("/api/v1/communities/categories/admin")
      .set(userAuth());
    expect(res.status).toBe(403);
    expect(svc.listCategoriesAdmin).not.toHaveBeenCalled();
  });

  it("rejects POST /categories for a non-admin → 403", async () => {
    const res = await request(app)
      .post("/api/v1/communities/categories")
      .set(userAuth())
      .send({ name: "Technology" });
    expect(res.status).toBe(403);
    expect(svc.createCategory).not.toHaveBeenCalled();
  });

  it("rejects PATCH /categories/:categoryId for a non-admin → 403", async () => {
    const res = await request(app)
      .patch(`/api/v1/communities/categories/${CAT}`)
      .set(userAuth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(403);
    expect(svc.updateCategory).not.toHaveBeenCalled();
  });

  it("rejects DELETE /categories/:categoryId for a non-admin → 403", async () => {
    const res = await request(app)
      .delete(`/api/v1/communities/categories/${CAT}`)
      .set(userAuth());
    expect(res.status).toBe(403);
    expect(svc.deleteCategory).not.toHaveBeenCalled();
  });
});
