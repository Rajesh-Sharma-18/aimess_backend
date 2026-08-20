/**
 * Unauthenticated link-preview card:
 *   GET /api/v1/communities/by-handle/:handle/card
 *
 * The one community route with no token. Guards that it stays reachable without
 * auth (the preview page has no user), that it is not swallowed by the `/:id`
 * param route, and that an unresolvable handle 404s instead of leaking a shape.
 */
jest.mock("../../src/services/community.service.js", () => ({
  communityService: {
    getPublicCard: jest.fn(),
  },
}));

import request from "supertest";

import { NotFoundError } from "@aimess/errors";

import { app } from "../../src/app.js";
import { communityService } from "../../src/services/community.service.js";

const svc = communityService as unknown as Record<string, jest.Mock>;

const card = {
  communityId: "a".repeat(24),
  name: "Backend Devs",
  description: "All things backend",
  avatarUrl: null,
  bannerUrl: null,
  memberCount: 42,
};

beforeEach(() => jest.clearAllMocks());

describe("GET /api/v1/communities/by-handle/:handle/card", () => {
  it("serves the card with NO Authorization header", async () => {
    svc.getPublicCard.mockResolvedValue(card);

    const res = await request(app).get(
      "/api/v1/communities/by-handle/backend_devs/card"
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(card);
    expect(svc.getPublicCard).toHaveBeenCalledWith("backend_devs");
  });

  it("404s a private / closed / missing community", async () => {
    svc.getPublicCard.mockRejectedValue(
      new NotFoundError("COMMUNITY_NOT_FOUND")
    );

    const res = await request(app).get(
      "/api/v1/communities/by-handle/secret_club/card"
    );

    expect(res.status).toBe(404);
  });

  it("rejects a handle outside the grammar before hitting the service", async () => {
    const res = await request(app).get(
      "/api/v1/communities/by-handle/no!/card"
    );

    expect(res.status).toBe(400);
    expect(svc.getPublicCard).not.toHaveBeenCalled();
  });
});
