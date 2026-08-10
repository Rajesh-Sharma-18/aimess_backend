/**
 * /api/v1/users/friends — friendship lifecycle (send / accept / reject /
 * cancel / unfriend). The service runs for real; we mock the two repositories
 * it touches (friendship + user-profile), the user-cache, and the RabbitMQ
 * publishers (so we can assert side-effects without a broker).
 */
jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    resolveViewerGraph: jest.fn(async () => ({
      friendIds: [],
      friendOfFriendIds: [],
    })),
    hasMutualFriend: jest.fn(async () => false),
    findByPair: jest.fn(),
    findById: jest.fn(),
    findActivePair: jest.fn(),
    findAllBlocks: jest.fn(async () => []),
    findBlock: jest.fn(async () => null),
    createBlock: jest.fn(),
    deleteBlock: jest.fn(),
    create: jest.fn(),
    resetToPending: jest.fn(),
    acceptWithCounters: jest.fn(),
    reject: jest.fn(),
    cancel: jest.fn(),
    unfriendWithCounters: jest.fn(),
  },
}));
// `whoCanSendFriendRequests` gate. null → no settings row → EVERYONE, which is
// the pre-privacy behaviour every existing case in this file assumes.
jest.mock("../../src/repositories/user-settings.repository.js", () => ({
  userSettingsRepository: {
    findFriendRequestPrivacy: jest.fn(async () => null),
  },
}));
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserId: jest.fn(),
    findManyByUserIds: jest.fn(async () => []),
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
  publishFriendRejectedSafe: jest.fn(),
  publishFriendCancelledSafe: jest.fn(),
  publishFriendUnfriendedSafe: jest.fn(),
  publishFriendshipBlockedSafe: jest.fn(),
  publishFriendshipCreatedSafe: jest.fn(),
  publishFriendshipDeletedSafe: jest.fn(),
}));
jest.mock("../../src/lib/friend-socket.js", () => ({
  emitFriendEventSafe: jest.fn(),
  emitFriendEventToPairSafe: jest.fn(),
}));

import request from "supertest";
import { ConversationSocketEvents } from "@aimess/shared-types";

import { app } from "../../src/app.js";
import { friendshipRepository } from "../../src/repositories/friendship.repository.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { userSettingsRepository } from "../../src/repositories/user-settings.repository.js";
import {
  publishFriendRequestedSafe,
  publishFriendAcceptedSafe,
  publishFriendUnfriendedSafe,
} from "../../src/messaging/publish-friendship.js";
import { emitFriendEventSafe } from "../../src/lib/friend-socket.js";
import { messagingGrpcClient } from "../../src/grpc/messaging.client.js";
import {
  TEST_USER_ID,
  bearer,
  makeAccessToken,
  makeForgedAccessToken,
} from "../helpers/auth.js";

const fRepo = friendshipRepository as unknown as Record<string, jest.Mock>;
const pRepo = userProfileRepository as unknown as { findByUserId: jest.Mock };
const settingsRepo = userSettingsRepository as unknown as {
  findFriendRequestPrivacy: jest.Mock;
};
const requested = publishFriendRequestedSafe as unknown as jest.Mock;
const accepted = publishFriendAcceptedSafe as unknown as jest.Mock;
const unfriended = publishFriendUnfriendedSafe as unknown as jest.Mock;
const emitSafe = emitFriendEventSafe as unknown as jest.Mock;
const grpc = messagingGrpcClient as unknown as {
  getOrCreatePrivateRooms: jest.Mock;
};

/** Find every emitFriendEventSafe(...) call for a given conversation:* event name. */
function conversationEmits(event: string) {
  return emitSafe.mock.calls.filter(([, e]) => e === event);
}

const ME = TEST_USER_ID;
const OTHER = "33333333-3333-4333-8333-333333333333";
const FRIENDSHIP_ID = "44444444-4444-4444-8444-444444444444";

const auth = () => bearer(makeAccessToken());

function liveProfile(userId: string) {
  return {
    userId,
    username: `u_${userId.slice(0, 4)}`,
    firstName: userId === ME ? "John" : "Alex",
    lastName: "Doe",
    deletedAt: null,
  };
}

function friendshipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FRIENDSHIP_ID,
    requesterId: ME,
    addresseeId: OTHER,
    status: "PENDING",
    acceptedAt: null,
    rejectedAt: null,
    cancelledAt: null,
    unfriendedAt: null,
    unfriendedBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("POST /api/v1/users/friends/requests", () => {
  beforeEach(() => {
    pRepo.findByUserId.mockImplementation(async (id: string) =>
      liveProfile(id)
    );
    fRepo.findAllBlocks.mockResolvedValue([]);
    fRepo.findByPair.mockResolvedValue(null);
    fRepo.create.mockResolvedValue(friendshipRow());
    settingsRepo.findFriendRequestPrivacy.mockResolvedValue(null); // EVERYONE
  });

  it("sends a friend request → 201 and publishes friend.requested", async () => {
    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(FRIENDSHIP_ID);
    expect(res.body.data.status).toBe("PENDING");
    expect(fRepo.create).toHaveBeenCalledWith(ME, OTHER);
    expect(requested).toHaveBeenCalledTimes(1);
    // Display name is resolved inline from the already-loaded profile —
    // notifications-service uses it for "{name} sent you a friend request."
    expect(requested).toHaveBeenCalledWith(
      expect.objectContaining({ requesterName: "John Doe" })
    );

    // Pending-conversation row: delivered ONLY to the addressee, carrying a
    // full synthetic PRIVATE_PENDING conversation the FE can render with no
    // follow-up fetch.
    const pendingEmits = conversationEmits(
      ConversationSocketEvents.PENDING_FRIEND_REQUEST
    );
    expect(pendingEmits).toHaveLength(1);
    const [targetUserId, , payload] = pendingEmits[0];
    expect(targetUserId).toBe(OTHER);
    expect(payload).toMatchObject({
      conversation: {
        id: `pending:${FRIENDSHIP_ID}`,
        type: "PRIVATE_PENDING",
        pendingRequest: true,
        friendRequestId: FRIENDSHIP_ID,
        requester: { id: ME, displayName: "John Doe", username: "u_1111" },
        lastActivity: { type: "FRIEND_REQUEST", text: "Friend Request" },
      },
      friendRequest: { id: FRIENDSHIP_ID, status: "PENDING" },
    });
  });

  it("rejects the request when the addressee's whoCanSendFriendRequests is NO_ONE", async () => {
    settingsRepo.findFriendRequestPrivacy.mockResolvedValue("NO_ONE");

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(400);
    // Nothing is written and nothing is announced — a request that was never
    // allowed must not leave a row or a notification behind.
    expect(fRepo.create).not.toHaveBeenCalled();
    expect(requested).not.toHaveBeenCalled();
  });

  it("rejects a non-friend under FRIENDS but still allows a friend's request", async () => {
    settingsRepo.findFriendRequestPrivacy.mockResolvedValue("FRIENDS");

    const denied = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });
    expect(denied.status).toBe(400);

    // An ACCEPTED row means they ARE friends — the scope admits them (the
    // already-friends conflict is a separate, later check).
    fRepo.findByPair.mockResolvedValue(friendshipRow({ status: "ACCEPTED" }));
    const allowed = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });
    expect(allowed.status).not.toBe(400);
  });

  it("auto-accepts a mutual pending request (they already requested me)", async () => {
    fRepo.findByPair.mockResolvedValue(
      friendshipRow({ requesterId: OTHER, addresseeId: ME, status: "PENDING" })
    );
    fRepo.acceptWithCounters.mockResolvedValue([
      friendshipRow({
        requesterId: OTHER,
        addresseeId: ME,
        status: "ACCEPTED",
        acceptedAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ]);

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("ACCEPTED");
    expect(accepted).toHaveBeenCalledTimes(1);

    // Mutual auto-accept must eagerly create the room (not lazily on first
    // open) and tell both sides' other devices to drop the pending row.
    expect(grpc.getOrCreatePrivateRooms).toHaveBeenCalledWith(OTHER, [ME]);
    expect(
      conversationEmits(ConversationSocketEvents.FRIEND_REQUEST_ACCEPTED)
    ).toHaveLength(2);
  });

  it("returns 400 when adding yourself", async () => {
    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: ME });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(fRepo.create).not.toHaveBeenCalled();
  });

  it("returns 404 when the addressee profile does not exist", async () => {
    pRepo.findByUserId.mockImplementation(async (id: string) =>
      id === ME ? liveProfile(ME) : null
    );

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(404);
  });

  it("returns 400 when either party has blocked the other", async () => {
    fRepo.findAllBlocks.mockResolvedValue([
      { blockerId: OTHER, blockedId: ME },
    ]);

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(400);
    expect(fRepo.create).not.toHaveBeenCalled();
  });

  it("returns 409 when already friends", async () => {
    fRepo.findByPair.mockResolvedValue(friendshipRow({ status: "ACCEPTED" }));

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(409);
  });

  it("returns 409 when a request was already sent by me", async () => {
    fRepo.findByPair.mockResolvedValue(
      friendshipRow({ requesterId: ME, addresseeId: OTHER, status: "PENDING" })
    );

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(409);
  });

  it("recycles a previously REJECTED row back to PENDING", async () => {
    fRepo.findByPair.mockResolvedValue(friendshipRow({ status: "REJECTED" }));
    fRepo.resetToPending.mockResolvedValue(
      friendshipRow({ status: "PENDING" })
    );

    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(201);
    expect(fRepo.resetToPending).toHaveBeenCalledWith(FRIENDSHIP_ID, ME, OTHER);
    expect(requested).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing addresseeId", {}],
    ["non-uuid addresseeId", { addresseeId: "not-a-uuid" }],
    ["numeric addresseeId", { addresseeId: 123 }],
  ])("returns 400 on validation failure: %s", async (_label, body) => {
    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .set(auth())
      .send(body);

    expect(res.status).toBe(400);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/v1/users/friends/requests")
      .send({ addresseeId: OTHER });

    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/users/friends/requests/:id/accept", () => {
  it("accepts an incoming pending request → 200, publishing both display names", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({ requesterId: OTHER, addresseeId: ME, status: "PENDING" })
    );
    fRepo.acceptWithCounters.mockResolvedValue([
      friendshipRow({
        requesterId: OTHER,
        addresseeId: ME,
        status: "ACCEPTED",
        acceptedAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ]);
    (
      userProfileRepository.findManyByUserIds as jest.Mock
    ).mockResolvedValueOnce([
      { userId: OTHER, username: "alex", firstName: "Alex", lastName: "Doe" },
      { userId: ME, username: "john", firstName: "John", lastName: "Doe" },
    ]);
    grpc.getOrCreatePrivateRooms.mockResolvedValueOnce([
      { peerUserId: ME, roomId: "prv_abc123" },
    ]);

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/accept`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ACCEPTED");
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterName: "Alex Doe",
        addresseeName: "John Doe",
      })
    );

    // Eager room creation (so the pending row swaps for a real, composable
    // conversation the instant Accept succeeds) + the accepted event reaching
    // both parties, carrying the freshly created roomId.
    expect(grpc.getOrCreatePrivateRooms).toHaveBeenCalledWith(OTHER, [ME]);
    const acceptedEmits = conversationEmits(
      ConversationSocketEvents.FRIEND_REQUEST_ACCEPTED
    );
    expect(acceptedEmits).toHaveLength(2);
    for (const [, , payload] of acceptedEmits) {
      expect(payload).toMatchObject({ roomId: "prv_abc123" });
    }
  });

  // `isRefriend` decides whether chat-service posts the "You and X are now
  // friends" SYSTEM row. It must come from `firstAcceptedAt` on the row as it
  // was BEFORE this accept — `acceptedAt` is nulled every time the row is
  // recycled for a new request, so it cannot tell first-time from re-friend.
  it("publishes friendship.created with isRefriend=false for a first-ever friendship", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({
        requesterId: OTHER,
        addresseeId: ME,
        status: "PENDING",
        firstAcceptedAt: null,
      })
    );
    fRepo.acceptWithCounters.mockResolvedValue([
      friendshipRow({
        requesterId: OTHER,
        addresseeId: ME,
        status: "ACCEPTED",
        acceptedAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ]);

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/accept`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(created).toHaveBeenCalledWith(OTHER, ME, false);
  });

  it("publishes friendship.created with isRefriend=true when the pair was friends before", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({
        requesterId: OTHER,
        addresseeId: ME,
        status: "PENDING",
        // Unfriended, then re-requested: `resetToPending` cleared acceptedAt
        // but deliberately kept this stamp from the first friendship.
        firstAcceptedAt: new Date("2025-12-01T00:00:00.000Z"),
        acceptedAt: null,
      })
    );
    fRepo.acceptWithCounters.mockResolvedValue([
      friendshipRow({
        requesterId: OTHER,
        addresseeId: ME,
        status: "ACCEPTED",
        acceptedAt: new Date("2026-02-01T00:00:00.000Z"),
        firstAcceptedAt: new Date("2025-12-01T00:00:00.000Z"),
      }),
    ]);

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/accept`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(created).toHaveBeenCalledWith(OTHER, ME, true);
  });

  it("returns 404 when the request is not addressed to me (IDOR guard)", async () => {
    // I am neither requester nor addressee — addressed to someone else.
    fRepo.findById.mockResolvedValue(
      friendshipRow({
        requesterId: OTHER,
        addresseeId: "99999999-9999-4999-8999-999999999999",
        status: "PENDING",
      })
    );

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/accept`)
      .set(auth());

    expect(res.status).toBe(404);
    expect(fRepo.acceptWithCounters).not.toHaveBeenCalled();
  });

  it("returns 404 when the friendship does not exist", async () => {
    fRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/accept`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  it("returns 400 on a non-uuid id param", async () => {
    const res = await request(app)
      .post(`/api/v1/users/friends/requests/not-a-uuid/accept`)
      .set(auth());

    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/users/friends/requests/:id/reject", () => {
  it("rejects an incoming pending request → 200", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({ requesterId: OTHER, addresseeId: ME, status: "PENDING" })
    );
    fRepo.reject.mockResolvedValue(
      friendshipRow({ status: "REJECTED", rejectedAt: new Date() })
    );

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/reject`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.reject).toHaveBeenCalledWith(FRIENDSHIP_ID);

    const rejectedEmits = conversationEmits(
      ConversationSocketEvents.FRIEND_REQUEST_REJECTED
    );
    expect(rejectedEmits).toHaveLength(2);
    for (const [, , payload] of rejectedEmits) {
      expect(payload).toMatchObject({
        friendRequest: { id: FRIENDSHIP_ID, status: "REJECTED" },
      });
    }
  });

  it("returns 404 when I am the requester, not the addressee", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({ requesterId: ME, addresseeId: OTHER, status: "PENDING" })
    );

    const res = await request(app)
      .post(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}/reject`)
      .set(auth());

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/users/friends/requests/:id (cancel)", () => {
  it("cancels my own outgoing pending request → 200", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({ requesterId: ME, addresseeId: OTHER, status: "PENDING" })
    );
    fRepo.cancel.mockResolvedValue(
      friendshipRow({ status: "CANCELLED", cancelledAt: new Date() })
    );

    const res = await request(app)
      .delete(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.cancel).toHaveBeenCalledWith(FRIENDSHIP_ID);
  });

  it("returns 404 when cancelling a request I did not send (IDOR guard)", async () => {
    fRepo.findById.mockResolvedValue(
      friendshipRow({ requesterId: OTHER, addresseeId: ME, status: "PENDING" })
    );

    const res = await request(app)
      .delete(`/api/v1/users/friends/requests/${FRIENDSHIP_ID}`)
      .set(auth());

    expect(res.status).toBe(404);
    expect(fRepo.cancel).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/users/friends/:userId (unfriend)", () => {
  it("unfriends an active friend → 200 and publishes friend.unfriended", async () => {
    fRepo.findActivePair.mockResolvedValue(
      friendshipRow({ status: "ACCEPTED" })
    );
    fRepo.unfriendWithCounters.mockResolvedValue([
      friendshipRow({ status: "UNFRIENDED" }),
    ]);

    const res = await request(app)
      .delete(`/api/v1/users/friends/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(unfriended).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when trying to unfriend yourself", async () => {
    const res = await request(app)
      .delete(`/api/v1/users/friends/${ME}`)
      .set(auth());

    expect(res.status).toBe(400);
  });

  it("returns 404 when no active friendship exists", async () => {
    fRepo.findActivePair.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/v1/users/friends/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  it("returns 400 on a non-uuid userId param", async () => {
    const res = await request(app)
      .delete(`/api/v1/users/friends/not-a-uuid`)
      .set(auth());

    expect(res.status).toBe(400);
  });

  it("returns 401 with a forged token", async () => {
    const res = await request(app)
      .delete(`/api/v1/users/friends/${OTHER}`)
      .set(bearer(makeForgedAccessToken()));

    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/users/friends/block/:userId", () => {
  beforeEach(() => {
    pRepo.findByUserId.mockImplementation(async (id: string) =>
      liveProfile(id)
    );
    fRepo.findBlock.mockResolvedValue(null);
    fRepo.findByPair.mockResolvedValue(null);
  });

  it("blocks a stranger (no existing friendship row) → 200", async () => {
    const res = await request(app)
      .post(`/api/v1/users/friends/block/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.createBlock).toHaveBeenCalledWith(ME, OTHER);
    expect(fRepo.unfriendWithCounters).not.toHaveBeenCalled();
  });

  it("unfriends first when blocking an ACCEPTED friend", async () => {
    fRepo.findByPair.mockResolvedValue(friendshipRow({ status: "ACCEPTED" }));
    fRepo.unfriendWithCounters.mockResolvedValue([
      friendshipRow({ status: "UNFRIENDED" }),
    ]);

    const res = await request(app)
      .post(`/api/v1/users/friends/block/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.unfriendWithCounters).toHaveBeenCalledTimes(1);
    expect(fRepo.createBlock).toHaveBeenCalledWith(ME, OTHER);
  });

  it("cancels a PENDING request I sent before blocking", async () => {
    fRepo.findByPair.mockResolvedValue(
      friendshipRow({ requesterId: ME, addresseeId: OTHER, status: "PENDING" })
    );
    fRepo.cancel.mockResolvedValue(friendshipRow({ status: "CANCELLED" }));

    const res = await request(app)
      .post(`/api/v1/users/friends/block/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.cancel).toHaveBeenCalledWith(FRIENDSHIP_ID);
    expect(fRepo.reject).not.toHaveBeenCalled();
  });

  it("returns 409 when already blocked", async () => {
    fRepo.findBlock.mockResolvedValue({
      id: "block-1",
      blockerId: ME,
      blockedId: OTHER,
      createdAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/v1/users/friends/block/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(409);
    expect(fRepo.createBlock).not.toHaveBeenCalled();
  });

  it("returns 400 when blocking yourself", async () => {
    const res = await request(app)
      .post(`/api/v1/users/friends/block/${ME}`)
      .set(auth());

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/v1/users/friends/block/:userId", () => {
  it("unblocks → 200", async () => {
    fRepo.findBlock.mockResolvedValue({
      id: "block-1",
      blockerId: ME,
      blockedId: OTHER,
      createdAt: new Date(),
    });
    fRepo.findByPair.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/v1/users/friends/block/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(fRepo.deleteBlock).toHaveBeenCalledWith(ME, OTHER);
  });

  it("returns 404 when not blocked", async () => {
    fRepo.findBlock.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/v1/users/friends/block/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(404);
    expect(fRepo.deleteBlock).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/users/friends/status/:userId", () => {
  it("returns NONE for a stranger", async () => {
    fRepo.findByPair.mockResolvedValue(null);
    fRepo.findBlock.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/users/friends/status/${OTHER}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      friendshipId: null,
      status: "NONE",
      direction: null,
      canAccept: false,
      canReject: false,
      canCancel: false,
    });
  });

  it("returns PENDING/OUTGOING when I sent the request", async () => {
    fRepo.findByPair.mockResolvedValue(
      friendshipRow({ requesterId: ME, addresseeId: OTHER, status: "PENDING" })
    );
    fRepo.findBlock.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/users/friends/status/${OTHER}`)
      .set(auth());

    expect(res.body.data).toMatchObject({
      status: "PENDING",
      direction: "OUTGOING",
      canCancel: true,
      canAccept: false,
    });
  });

  it("returns BLOCKED when I have blocked them, regardless of the friendship row", async () => {
    fRepo.findByPair.mockResolvedValue(friendshipRow({ status: "ACCEPTED" }));
    fRepo.findBlock.mockResolvedValue({
      id: "block-1",
      blockerId: ME,
      blockedId: OTHER,
      createdAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/users/friends/status/${OTHER}`)
      .set(auth());

    expect(res.body.data.status).toBe("BLOCKED");
  });
});
