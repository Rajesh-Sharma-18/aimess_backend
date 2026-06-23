/**
 * Public deep-link resolver:
 *   GET /api/v1/communities/by-handle/:handle
 *
 * Routing, Zod param validation, real JWT verify and error→HTTP mapping run for
 * real; `communityService.getByHandle` is mocked per-test to drive each branch.
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    getByHandle: jest.fn(),
  },
}));

import request from "supertest";

import { ForbiddenError, NotFoundError } from "@aimess/errors";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

const svc = communityService as unknown as Record<string, jest.Mock>;
const auth = () => bearer(makeAccessToken());

const publicDto = (over: Record<string, unknown> = {}) => ({
  communityId: "a".repeat(24),
  handle: "backend_devs",
  name: "Backend Devs",
  description: "All things backend",
  avatarUrl: null,
  bannerUrl: null,
  memberCount: 42,
  type: "PUBLIC",
  isJoined: false,
  role: null,
  isBanned: false,
  ...over,
});

describe("GET /api/v1/communities/by-handle/:handle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("401 without a token", async () => {
    const res = await request(app).get(
      "/api/v1/communities/by-handle/backend_devs"
    );
    expect(res.status).toBe(401);
    expect(svc.getByHandle).not.toHaveBeenCalled();
  });

  it("200 with PublicCommunityResponse for a public handle", async () => {
    svc.getByHandle.mockResolvedValue(publicDto());
    const res = await request(app)
      .get("/api/v1/communities/by-handle/backend_devs")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe("PUBLIC");
    expect(res.body.data.isJoined).toBe(false);
    expect(res.body.data.role).toBeNull();
    expect(svc.getByHandle).toHaveBeenCalledWith(
      "backend_devs",
      expect.any(String)
    );
  });

  it("200 with isJoined:true + role for an active member", async () => {
    svc.getByHandle.mockResolvedValue(
      publicDto({ isJoined: true, role: "MEMBER" })
    );
    const res = await request(app)
      .get("/api/v1/communities/by-handle/backend_devs")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.isJoined).toBe(true);
    expect(res.body.data.role).toBe("MEMBER");
  });

  it("404 when the handle is private/missing/suspended", async () => {
    svc.getByHandle.mockRejectedValue(new NotFoundError("COMMUNITY_NOT_FOUND"));
    const res = await request(app)
      .get("/api/v1/communities/by-handle/secret_room")
      .set(auth());
    expect(res.status).toBe(404);
  });

  it("403 when the caller is banned", async () => {
    svc.getByHandle.mockRejectedValue(
      new ForbiddenError("COMMUNITY_JOIN_BANNED")
    );
    const res = await request(app)
      .get("/api/v1/communities/by-handle/backend_devs")
      .set(auth());
    expect(res.status).toBe(403);
  });

  it("400 for a malformed handle (validator, service not called)", async () => {
    const res = await request(app)
      .get("/api/v1/communities/by-handle/ab") // too short (<3)
      .set(auth());
    expect(res.status).toBe(400);
    expect(svc.getByHandle).not.toHaveBeenCalled();
  });
});
