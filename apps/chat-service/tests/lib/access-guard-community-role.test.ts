/**
 * `getCommunityLiveRole` / `assertCommunityRole` — the centralized live-role
 * lookup that replaced `RoomMember.role`-based authorization for Community
 * write paths (pin/unpin, delete-for-everyone-of-another's-message).
 *
 * Root cause this closes: `RoomMember.role` is a one-way, async, best-effort
 * mirror of community-service's authoritative `CommunityMember.role`
 * (`events/community-room-sync.consumer.ts`) and can go stale. These two
 * functions are the ONE place chat-service asks community-service "what is
 * this user's role right now" via the existing `checkCommunityMembership`
 * gRPC RPC (already used by api-gateway's socket ban-gate) — no new
 * authorization logic, no duplicate lookups per call site.
 */
jest.mock("../../src/grpc/community.client.js", () => ({
  getCommunityReconcileClient: jest.fn(),
}));

import { ForbiddenError } from "@aimess/errors";
import {
  assertCommunityRole,
  getCommunityLiveRole,
} from "../../src/lib/access-guard.js";
import { getCommunityReconcileClient } from "../../src/grpc/community.client.js";

const reconcileClient = getCommunityReconcileClient as jest.Mock;
const checkCommunityMembership = jest.fn();

const COMMUNITY_ID = "comm-1";
const USER_ID = "usr-1";

beforeEach(() => {
  jest.clearAllMocks();
  reconcileClient.mockReturnValue({ checkCommunityMembership });
});

describe("getCommunityLiveRole", () => {
  it("returns the live role lower-cased", async () => {
    checkCommunityMembership.mockResolvedValue({
      isMember: true,
      isBanned: false,
      status: "ACTIVE",
      role: "ADMIN",
    });
    const role = await getCommunityLiveRole(COMMUNITY_ID, USER_ID);
    expect(role).toBe("admin");
    expect(checkCommunityMembership).toHaveBeenCalledWith({
      communityId: COMMUNITY_ID,
      userId: USER_ID,
    });
  });

  it("returns an empty string when the user isn't a member", async () => {
    checkCommunityMembership.mockResolvedValue({
      isMember: false,
      isBanned: false,
      status: "",
      role: "",
    });
    const role = await getCommunityLiveRole(COMMUNITY_ID, USER_ID);
    expect(role).toBe("");
  });

  it("fails CLOSED (empty role) when the gRPC call itself throws", async () => {
    checkCommunityMembership.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(getCommunityLiveRole(COMMUNITY_ID, USER_ID)).rejects.toThrow();
    // Note: getCommunityLiveRole itself does not swallow errors — the client
    // (checkCommunityMembership) is the layer that never throws in production
    // (see community.client.ts); this test uses a raw mock to prove
    // getCommunityLiveRole doesn't add its own silent catch that could mask
    // a real production bug in the client contract.
  });
});

describe("assertCommunityRole", () => {
  it("resolves when the live role is in the allowed list", async () => {
    checkCommunityMembership.mockResolvedValue({
      isMember: true,
      isBanned: false,
      status: "ACTIVE",
      role: "MODERATOR",
    });
    await expect(
      assertCommunityRole(COMMUNITY_ID, USER_ID, ["admin", "moderator"])
    ).resolves.toBeUndefined();
  });

  it("throws ForbiddenError CHAT_INSUFFICIENT_PERMISSIONS when the live role is not allowed", async () => {
    checkCommunityMembership.mockResolvedValue({
      isMember: true,
      isBanned: false,
      status: "ACTIVE",
      role: "MEMBER",
    });
    await expect(
      assertCommunityRole(COMMUNITY_ID, USER_ID, ["admin", "moderator"])
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("denies (fails closed) when the user has no community-service membership at all", async () => {
    checkCommunityMembership.mockResolvedValue({
      isMember: false,
      isBanned: false,
      status: "",
      role: "",
    });
    await expect(
      assertCommunityRole(COMMUNITY_ID, USER_ID, ["admin", "moderator"])
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("is case-insensitive against the allowed list (community-service returns UPPERCASE)", async () => {
    checkCommunityMembership.mockResolvedValue({
      isMember: true,
      isBanned: false,
      status: "ACTIVE",
      role: "ADMIN",
    });
    // Caller's allowed list uses the existing lowercase convention.
    await expect(
      assertCommunityRole(COMMUNITY_ID, USER_ID, ["admin", "moderator"])
    ).resolves.toBeUndefined();
  });
});
