/**
 * Suite: community-meta-realtime
 *
 * Pins the real-time metadata + roster sync added to community.service.ts:
 *   - update()           → `community:meta:updated` to the community room AND to
 *                          every active member's user channel (list rows), with a
 *                          `changes` map reflecting ONLY the genuinely-changed
 *                          fields; nothing emitted on a no-op save.
 *   - updateMemberRole() → `community:member:updated` carrying the new role.
 *   - transferAdmin()    → TWO `community:member:updated` (incoming admin +
 *                          outgoing admin demoted to member).
 *
 * Pattern mirrors community-realtime-events.test.ts:
 *   - Real communityService with only I/O boundaries mocked.
 *   - publishCommunityRoomEvent / publishChatUserEvent are the assertion targets.
 */

// ---------------------------------------------------------------------------
// Mock overrides — must appear before any import (Jest hoists jest.mock calls).
// ---------------------------------------------------------------------------

jest.mock("@aimess/redis", () => ({
  publishCommunityRoomEvent: jest.fn(async () => 1),
  publishChatUserEvent: jest.fn(async () => 1),
}));

jest.mock("../../src/repositories/community.repository.js", () => ({
  communityRepository: {
    findById: jest.fn(),
    findMembership: jest.fn(),
    findMemberByUserId: jest.fn(),
    updateCommunity: jest.fn(),
    updateMemberRole: jest.fn(),
    setCommunityAdmin: jest.fn(),
    findActiveMemberIds: jest.fn(),
    findActiveCategoryById: jest.fn(),
    createAuditLog: jest.fn(),
  },
}));

jest.mock("../../src/services/community-image.service.js", () => ({
  communityImageService: {
    resolveViewUrlForClient: jest.fn(async () => ({
      url: null,
      expiresIn: null,
    })),
    resolveObjectKeyForCommunity: jest.fn(async () => "community/img/new.png"),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after all jest.mock declarations)
// ---------------------------------------------------------------------------

import { publishCommunityRoomEvent, publishChatUserEvent } from "@aimess/redis";
import { communityService } from "../../src/services/community.service.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

// ---------------------------------------------------------------------------
// Typed aliases
// ---------------------------------------------------------------------------

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const pubRoom = publishCommunityRoomEvent as jest.Mock;
const pubUser = publishChatUserEvent as jest.Mock;

/** Flush the fire-and-forget `void broadcastCommunityMetaUpdated(...)` chain. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CID = "c".repeat(24);
const ADMIN = "11111111-1111-4111-8111-111111111111";
const TARGET = "99999999-9999-4999-8999-999999999999";
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const baseCommunity = {
  id: CID,
  name: "Test Community",
  handle: "test-community",
  description: "old desc",
  type: "PUBLIC",
  category: { id: "cat-1", name: "Tech" },
  categoryId: "cat-1",
  creatorId: ADMIN,
  adminId: ADMIN,
  memberCount: 10,
  moderationStatus: "ACTIVE",
  avatarUrl: "community/img/old.png",
  coverUrl: null,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-10T00:00:00.000Z"),
  lastActivityAt: new Date("2026-06-10T00:00:00.000Z"),
  lastActivityType: null,
  lastActivityPreview: null,
  lastActivityUsername: null,
  lastActivityUserId: null,
};

const activeTarget = {
  userId: TARGET,
  role: "MEMBER",
  status: "ACTIVE",
  joinedAt: new Date("2026-06-01T00:00:00.000Z"),
  snapshotUsername: "target_user",
  snapshotDisplayName: "Target User",
  snapshotAvatarKey: null,
  bannedAt: null,
  bannedBy: null,
  banReason: null,
};

beforeEach(() => {
  pubRoom.mockClear();
  pubUser.mockClear();
  Object.values(repo).forEach((fn) => fn.mockReset());
});

// ---------------------------------------------------------------------------
// Suite 1 — update() emits community:meta:updated
// ---------------------------------------------------------------------------

describe("update() — community:meta:updated fan-out", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(baseCommunity);
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findActiveMemberIds.mockResolvedValue([M1, M2]);
  });

  it("fans out to the community room AND every active member's user channel on an avatar change", async () => {
    repo.updateCommunity.mockResolvedValue({
      ...baseCommunity,
      avatarUrl: null,
    });

    // avatarObjectKey: null clears the avatar (genuine change vs the stored key).
    await communityService.update(CID, ADMIN, { avatarObjectKey: null });
    await flush();

    const roomCall = pubRoom.mock.calls.find(
      ([, , evt]) => evt === "community:meta:updated"
    );
    expect(roomCall).toBeDefined();
    const [, roomCommunityId, , payload] = roomCall!;
    expect(roomCommunityId).toBe(CID);
    expect(payload.communityId).toBe(CID);
    expect(payload.changes).toEqual({ avatar: true });
    expect(payload.community.communityId).toBe(CID);
    expect(typeof payload.updatedAt).toBe("number");

    // Every active member's list row gets the same payload on user:<id>.
    const userTargets = pubUser.mock.calls
      .filter(([, , evt]) => evt === "community:meta:updated")
      .map(([, userId]) => userId);
    expect(userTargets).toEqual(expect.arrayContaining([M1, M2]));
    expect(userTargets).toHaveLength(2);
  });

  it("sets changes.name on a genuine name change", async () => {
    // checkNameAvailability is a method on communityService; stub it so the
    // name path doesn't hit the cache/repo availability lookup.
    const spy = jest
      .spyOn(communityService, "checkNameAvailability")
      .mockResolvedValue({ name: "new name", available: true });
    repo.updateCommunity.mockResolvedValue({
      ...baseCommunity,
      name: "new name",
    });

    await communityService.update(CID, ADMIN, { name: "new name" });
    await flush();

    const roomCall = pubRoom.mock.calls.find(
      ([, , evt]) => evt === "community:meta:updated"
    );
    expect(roomCall).toBeDefined();
    expect(roomCall![3].changes).toEqual({ name: true });
    expect(roomCall![3].community.name).toBe("new name");
    spy.mockRestore();
  });

  it("emits NOTHING on a no-op save (no field genuinely changed)", async () => {
    repo.updateCommunity.mockResolvedValue(baseCommunity);

    // Resubmitting the identical description is not a change.
    await communityService.update(CID, ADMIN, { description: "old desc" });
    await flush();

    expect(
      pubRoom.mock.calls.find(([, , evt]) => evt === "community:meta:updated")
    ).toBeUndefined();
    expect(
      pubUser.mock.calls.filter(([, , evt]) => evt === "community:meta:updated")
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — updateMemberRole() emits community:member:updated
// ---------------------------------------------------------------------------

describe("updateMemberRole() — community:member:updated", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(baseCommunity);
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findMemberByUserId.mockResolvedValue(activeTarget);
    repo.updateMemberRole.mockResolvedValue({
      ...activeTarget,
      role: "MODERATOR",
    });
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("broadcasts the new role into the community room", async () => {
    await communityService.updateMemberRole(
      CID,
      ADMIN,
      TARGET,
      "MODERATOR" as never
    );

    const call = pubRoom.mock.calls.find(
      ([, , evt]) => evt === "community:member:updated"
    );
    expect(call).toBeDefined();
    const [, roomCommunityId, , payload] = call!;
    expect(roomCommunityId).toBe(CID);
    expect(payload).toMatchObject({
      communityId: CID,
      userId: TARGET,
      role: "MODERATOR",
    });
    expect(typeof payload.updatedAt).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — transferAdmin() emits two community:member:updated events
// ---------------------------------------------------------------------------

describe("transferAdmin() — dual community:member:updated", () => {
  beforeEach(() => {
    repo.findById.mockResolvedValue(baseCommunity);
    repo.findMembership.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
    repo.findMemberByUserId.mockResolvedValue(activeTarget);
    repo.updateMemberRole.mockResolvedValue(undefined);
    repo.setCommunityAdmin.mockResolvedValue(undefined);
    repo.createAuditLog.mockResolvedValue(undefined);
  });

  it("promotes the target to ADMIN and demotes the caller to MEMBER on the roster", async () => {
    await communityService.transferAdmin(CID, ADMIN, TARGET);

    const memberCalls = pubRoom.mock.calls.filter(
      ([, , evt]) => evt === "community:member:updated"
    );
    expect(memberCalls).toHaveLength(2);

    const byUser = new Map(
      memberCalls.map(([, , , payload]) => [payload.userId, payload.role])
    );
    expect(byUser.get(TARGET)).toBe("ADMIN");
    expect(byUser.get(ADMIN)).toBe("MEMBER");
  });
});
