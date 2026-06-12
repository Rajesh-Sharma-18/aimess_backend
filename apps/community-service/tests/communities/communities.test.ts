/**
 * Community CRUD + availability checks:
 *   POST   /api/v1/communities
 *   GET    /api/v1/communities/:id
 *   PATCH  /api/v1/communities/:id
 *   DELETE /api/v1/communities/:id
 *   GET    /api/v1/communities/name-available
 *   GET    /api/v1/communities/handle-available
 *
 * Routing, validation (Zod), auth (real JWT verify) and error→HTTP mapping all
 * run for real; the `communityService` seam is mocked per-test to drive each
 * branch. Errors thrown by the service are the shared `@aimess/errors` classes,
 * which the error-handler maps to their statusCode (404/409/403/400) + the
 * `{ success:false, message }` envelope.
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    create: jest.fn(),
    getById: jest.fn(),
    update: jest.fn(),
    deleteCommunity: jest.fn(),
    checkNameAvailability: jest.fn(),
    checkHandleAvailability: jest.fn(),
  },
}));

import request from "supertest";

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@aimess/errors";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const svc = communityService as unknown as Record<string, jest.Mock>;

const VALID_ID = "a".repeat(24); // 24-hex Mongo ObjectId
const auth = () => bearer(makeAccessToken());

const communityDto = (over: Record<string, unknown> = {}) => ({
  id: VALID_ID,
  name: "My Community",
  handle: "mycommunity",
  description: null,
  type: "PUBLIC",
  category: { id: "b".repeat(24), name: "Tech" },
  creatorId: "11111111-1111-4111-8111-111111111111",
  adminId: "11111111-1111-4111-8111-111111111111",
  memberCount: 1,
  role: "ADMIN",
  isJoined: true,
  ...over,
});

describe("POST /api/v1/communities (create)", () => {
  const validBody = {
    name: "My Community",
    handle: "my_community",
    type: "PUBLIC",
    categoryId: "b".repeat(24),
  };

  beforeEach(() => {
    svc.create.mockResolvedValue(communityDto());
  });

  it("creates a community → 201 with envelope + data", async () => {
    const res = await request(app)
      .post("/api/v1/communities")
      .set(auth())
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(VALID_ID);
    expect(res.body.data.handle).toBe("mycommunity");
    expect(svc.create).toHaveBeenCalledTimes(1);
    // The caller's userId from the JWT is forwarded as creatorId.
    expect(svc.create.mock.calls[0][0]).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).post("/api/v1/communities").send(validBody);
    expect(res.status).toBe(401);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("returns 409 when the handle/name is taken", async () => {
    svc.create.mockRejectedValue(new ConflictError("COMMUNITY_HANDLE_TAKEN"));
    const res = await request(app)
      .post("/api/v1/communities")
      .set(auth())
      .send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when the category is invalid (service guard)", async () => {
    svc.create.mockRejectedValue(
      new BadRequestError("COMMUNITY_CATEGORY_INVALID")
    );
    const res = await request(app)
      .post("/api/v1/communities")
      .set(auth())
      .send(validBody);
    expect(res.status).toBe(400);
  });

  it.each([
    ["empty body", {}],
    [
      "missing name",
      { handle: "abc_def", type: "PUBLIC", categoryId: "b".repeat(24) },
    ],
    ["name too short", { ...validBody, name: "ab" }],
    ["name too long", { ...validBody, name: "x".repeat(51) }],
    ["handle too short", { ...validBody, handle: "ab" }],
    ["handle illegal chars", { ...validBody, handle: "Bad Handle!" }],
    ["invalid type enum", { ...validBody, type: "SECRET" }],
    [
      "invalid categoryId (not ObjectId)",
      { ...validBody, categoryId: "not-an-id" },
    ],
    ["description too long", { ...validBody, description: "x".repeat(501) }],
    ["memberIds not uuid", { ...validBody, memberIds: ["nope"] }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/v1/communities")
      .set(auth())
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("ignores mass-assignment of privileged fields (creatorId/adminId in body)", async () => {
    const res = await request(app)
      .post("/api/v1/communities")
      .set(auth())
      .send({
        ...validBody,
        creatorId: "99999999-9999-4999-8999-999999999999",
        adminId: "99999999-9999-4999-8999-999999999999",
        memberCount: 9999,
      });
    expect(res.status).toBe(201);
    // creatorId passed to the service comes from the token, not the body.
    expect(svc.create.mock.calls[0][0]).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    const forwardedBody = svc.create.mock.calls[0][1];
    expect(forwardedBody.creatorId).toBeUndefined();
    expect(forwardedBody.adminId).toBeUndefined();
    expect(forwardedBody.memberCount).toBeUndefined();
  });

  it("rejects a NoSQL-injection-shaped handle as a validation failure", async () => {
    const res = await request(app)
      .post("/api/v1/communities")
      .set(auth())
      .send({ ...validBody, handle: { $ne: null } });
    expect(res.status).toBe(400);
    expect(svc.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/communities/:id", () => {
  beforeEach(() => {
    svc.getById.mockResolvedValue(communityDto());
  });

  it("returns 200 with the community", async () => {
    const res = await request(app)
      .get(`/api/v1/communities/${VALID_ID}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(VALID_ID);
    expect(svc.getById).toHaveBeenCalledWith(
      VALID_ID,
      "11111111-1111-4111-8111-111111111111"
    );
  });

  it("returns 404 when the community does not exist", async () => {
    svc.getById.mockRejectedValue(new NotFoundError("COMMUNITY_NOT_FOUND"));
    const res = await request(app)
      .get(`/api/v1/communities/${VALID_ID}`)
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid (non-ObjectId) id", async () => {
    const res = await request(app)
      .get("/api/v1/communities/not-a-valid-id")
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.getById).not.toHaveBeenCalled();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get(`/api/v1/communities/${VALID_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/v1/communities/:id (update)", () => {
  beforeEach(() => {
    svc.update.mockResolvedValue(communityDto({ name: "Renamed" }));
  });

  it("updates → 200", async () => {
    const res = await request(app)
      .patch(`/api/v1/communities/${VALID_ID}`)
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Renamed");
    expect(svc.update).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when the caller is not an admin", async () => {
    svc.update.mockRejectedValue(new ForbiddenError("COMMUNITY_FORBIDDEN"));
    const res = await request(app)
      .patch(`/api/v1/communities/${VALID_ID}`)
      .set(auth())
      .send({ name: "Renamed" });
    expect(res.status).toBe(403);
  });

  it("returns 409 on a handle conflict", async () => {
    svc.update.mockRejectedValue(new ConflictError("COMMUNITY_HANDLE_TAKEN"));
    const res = await request(app)
      .patch(`/api/v1/communities/${VALID_ID}`)
      .set(auth())
      .send({ handle: "taken_handle" });
    expect(res.status).toBe(409);
  });

  it("returns 400 with an empty update body (schema requires ≥1 field)", async () => {
    const res = await request(app)
      .patch(`/api/v1/communities/${VALID_ID}`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
    expect(svc.update).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid type enum", async () => {
    const res = await request(app)
      .patch(`/api/v1/communities/${VALID_ID}`)
      .set(auth())
      .send({ type: "NOPE" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/v1/communities/:id", () => {
  it("returns 200 with a null data envelope", async () => {
    svc.deleteCommunity.mockResolvedValue(undefined);
    const res = await request(app)
      .delete(`/api/v1/communities/${VALID_ID}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeNull();
    expect(svc.deleteCommunity).toHaveBeenCalledWith(
      VALID_ID,
      "11111111-1111-4111-8111-111111111111"
    );
  });

  it("returns 403 when the caller is not the admin", async () => {
    svc.deleteCommunity.mockRejectedValue(
      new ForbiddenError("COMMUNITY_FORBIDDEN")
    );
    const res = await request(app)
      .delete(`/api/v1/communities/${VALID_ID}`)
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("returns 404 when the community is gone", async () => {
    svc.deleteCommunity.mockRejectedValue(
      new NotFoundError("COMMUNITY_NOT_FOUND")
    );
    const res = await request(app)
      .delete(`/api/v1/communities/${VALID_ID}`)
      .set(auth());
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/communities/name-available & handle-available", () => {
  it("returns available=true for a free name", async () => {
    svc.checkNameAvailability.mockResolvedValue({
      name: "freename",
      available: true,
    });
    const res = await request(app)
      .get("/api/v1/communities/name-available")
      .query({ name: "Free Name" })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
  });

  it("returns available=false for a taken handle", async () => {
    svc.checkHandleAvailability.mockResolvedValue({
      handle: "taken",
      available: false,
    });
    const res = await request(app)
      .get("/api/v1/communities/handle-available")
      .query({ handle: "taken" })
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(false);
  });

  it("returns 400 when the name query param is missing", async () => {
    const res = await request(app)
      .get("/api/v1/communities/name-available")
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.checkNameAvailability).not.toHaveBeenCalled();
  });

  it("returns 400 when the handle is too short", async () => {
    const res = await request(app)
      .get("/api/v1/communities/handle-available")
      .query({ handle: "ab" })
      .set(auth());
    expect(res.status).toBe(400);
  });
});
