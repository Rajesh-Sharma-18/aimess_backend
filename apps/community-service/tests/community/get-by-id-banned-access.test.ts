/**
 * Restricted-access model: a BANNED member keeps read-only access to
 * `getById` (community-details view) instead of a 403 — the community stays
 * openable, `isBanned:true` is surfaced so clients render a read-only banner
 * and hide write affordances (including the Join button), and `role`/`isJoined`
 * stay null/false since a banned member has no active permissions.
 */
jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findMuteByUserAndCommunity: jest.fn(async () => null),
    findJoinRequestByCommunityAndUser: jest.fn(async () => null),
    findActiveMemberMute: jest.fn(async () => null),
  },
}));

jest.mock("../../src/services/community-image.service.js", () => ({
  communityImageService: {
    resolveViewUrlForClient: jest.fn(async () => ({
      url: null,
      expiresIn: null,
    })),
  },
}));

jest.mock("../../src/grpc/stream.client.js", () => ({
  getStreamClient: jest.fn(() => ({
    getLiveStreamsByCommunity: jest.fn(async () => []),
    checkCreatorHasActiveStream: jest.fn(async () => false),
  })),
}));

import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;

const CID = "c".repeat(24);
const CALLER = "99999999-9999-4999-8999-999999999999";

const community = {
  id: CID,
  name: "Backend Devs",
  handle: "backend_devs",
  description: "All things backend",
  type: "PUBLIC",
  category: { id: "cat1", name: "Tech" },
  creatorId: CALLER,
  adminId: CALLER,
  memberCount: 42,
  avatarUrl: null,
  coverUrl: null,
  moderationStatus: "ACTIVE",
  status: "ACTIVE",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("communityService.getById — banned read-only access", () => {
  it("returns the community (no throw) for a BANNED caller, with isBanned:true and no role/join-request lookup", async () => {
    repo.findById.mockResolvedValue(community);
    repo.findMembership.mockResolvedValue({
      status: "BANNED",
      role: "MEMBER",
    });

    const res = await communityService.getById(CID, CALLER);

    expect(res.id).toBe(CID);
    expect(res.isBanned).toBe(true);
    expect(res.role).toBeNull();
    expect(res.isJoined).toBe(false);
    // A banned user has no live join request to surface — the lookup is
    // skipped entirely rather than returning a stale pre-ban row.
    expect(repo.findJoinRequestByCommunityAndUser).not.toHaveBeenCalled();
  });

  it("still returns isBanned:false + the role for an ACTIVE member", async () => {
    repo.findById.mockResolvedValue(community);
    repo.findMembership.mockResolvedValue({
      status: "ACTIVE",
      role: "ADMIN",
    });

    const res = await communityService.getById(CID, CALLER);

    expect(res.isBanned).toBe(false);
    expect(res.role).toBe("ADMIN");
    expect(res.isJoined).toBe(true);
  });
});
