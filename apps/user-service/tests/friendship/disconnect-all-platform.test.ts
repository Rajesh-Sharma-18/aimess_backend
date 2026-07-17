/**
 * friendshipService.disconnectAllPlatform — the PLATFORM-WIDE unfriend sweep
 * behind `UserService.AdminDisconnectAllFriendships` (gRPC-only, no HTTP
 * route — see backoffice-service's `system-maintenance` module for the only
 * caller). Mirrors the mock-setup pattern from auto-disconnect.test.ts, but
 * exercises the service function directly since there is no REST endpoint to
 * hit with supertest.
 */

jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    disconnectAllAcceptedBatch: jest.fn(async () => []),
  },
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    invalidateProfile: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/messaging/publish-friendship.js", () => ({
  publishFriendRequestedSafe: jest.fn(),
  publishFriendAcceptedSafe: jest.fn(),
  publishFriendUnfriendedSafe: jest.fn(),
  publishFriendshipBlockedSafe: jest.fn(),
  publishFriendshipCreatedSafe: jest.fn(),
  publishFriendshipDeletedSafe: jest.fn(),
}));
jest.mock("../../src/lib/friend-socket.js", () => ({
  emitFriendEventSafe: jest.fn(),
  emitFriendEventToPairSafe: jest.fn(),
}));

import { friendshipService } from "../../src/services/friendship.service.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { userCache } from "../../src/lib/user-cache.js";
import {
  publishFriendUnfriendedSafe,
  publishFriendshipDeletedSafe,
} from "../../src/messaging/publish-friendship.js";
import { emitFriendEventToPairSafe } from "../../src/lib/friend-socket.js";

const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const cache = userCache as unknown as Record<string, jest.Mock>;
const unfriended = publishFriendUnfriendedSafe as unknown as jest.Mock;
const friendshipDeleted = publishFriendshipDeletedSafe as unknown as jest.Mock;
const emitToPair = emitFriendEventToPairSafe as unknown as jest.Mock;

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function row(id: string, requesterId: string, addresseeId: string) {
  return { id, requesterId, addresseeId };
}

describe("friendshipService.disconnectAllPlatform", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fRepo.disconnectAllAcceptedBatch.mockResolvedValue([]);
  });

  it("1. confirm: false → throws BadRequestError, repository never touched", async () => {
    await expect(
      friendshipService.disconnectAllPlatform({ confirm: false })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fRepo.disconnectAllAcceptedBatch).not.toHaveBeenCalled();
  });

  it("2. Nothing to disconnect → zero counts, no events, no cache invalidation", async () => {
    const result = await friendshipService.disconnectAllPlatform({
      confirm: true,
    });

    expect(result).toEqual({ friendshipsDisconnected: 0, usersAffected: 0 });
    expect(unfriended).not.toHaveBeenCalled();
    expect(friendshipDeleted).not.toHaveBeenCalled();
    expect(cache.invalidateProfile).not.toHaveBeenCalled();
  });

  it("3. One batch, 2 friendships → disconnects both, publishes events per pair, invalidates every unique user once", async () => {
    fRepo.disconnectAllAcceptedBatch
      .mockResolvedValueOnce([
        row("f-a", USER_A, USER_B),
        row("f-b", USER_B, USER_C),
      ])
      .mockResolvedValueOnce([]);

    const result = await friendshipService.disconnectAllPlatform({
      confirm: true,
    });

    expect(result).toEqual({ friendshipsDisconnected: 2, usersAffected: 3 });
    expect(unfriended).toHaveBeenCalledTimes(2);
    expect(unfriended).toHaveBeenCalledWith(
      expect.objectContaining({ friendshipId: "f-a", otherUserId: USER_B })
    );
    expect(friendshipDeleted).toHaveBeenCalledWith(USER_A, USER_B);
    expect(friendshipDeleted).toHaveBeenCalledWith(USER_B, USER_C);
    expect(emitToPair).toHaveBeenCalledTimes(2);

    const invalidated = new Set(
      cache.invalidateProfile.mock.calls.map((c: unknown[]) => c[0])
    );
    expect(invalidated).toEqual(new Set([USER_A, USER_B, USER_C]));
    expect(cache.invalidateProfile).toHaveBeenCalledTimes(3);
  });

  it("4. Drains MULTIPLE batches until the repository returns empty", async () => {
    fRepo.disconnectAllAcceptedBatch
      .mockResolvedValueOnce([row("f-1", USER_A, USER_B)])
      .mockResolvedValueOnce([row("f-2", USER_B, USER_C)])
      .mockResolvedValueOnce([]);

    const result = await friendshipService.disconnectAllPlatform({
      confirm: true,
    });

    expect(fRepo.disconnectAllAcceptedBatch).toHaveBeenCalledTimes(3);
    expect(result.friendshipsDisconnected).toBe(2);
    expect(result.usersAffected).toBe(3);
  });

  it("5. Emits the socket event to both sides of the pair", async () => {
    fRepo.disconnectAllAcceptedBatch
      .mockResolvedValueOnce([row("f-a", USER_A, USER_B)])
      .mockResolvedValueOnce([]);

    await friendshipService.disconnectAllPlatform({ confirm: true });

    expect(emitToPair).toHaveBeenCalledWith(
      USER_A,
      USER_B,
      expect.any(String),
      expect.any(Function)
    );
  });
});
