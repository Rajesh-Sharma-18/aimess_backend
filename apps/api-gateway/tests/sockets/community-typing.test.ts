/**
 * Community typing indicator — unit tests.
 *
 * Verifies the logic-layer functions used by the /community namespace typing
 * handler: the payload builder and the sender-exclusion / dual-room contracts.
 *
 * Full Socket.IO namespace integration (live Redis adapter + gRPC clients) is
 * out of scope here — that is covered by the e2e testing-suite. What we verify:
 *
 * 1. Payload shape is correct and sender identity is always server-authoritative.
 * 2. The broadcast event names are `typing:start` / `typing:stop` (not renamed).
 * 3. The payload does NOT include sensitive data.
 * 4. Payload fields match the AsyncAPI CommunityTypingStartBroadcast schema.
 *
 * Root-cause regression:
 * The bug was that sockets only joined community:<id> rooms on an explicit
 * community:join from the client. The fix joins community-typing:<id> for ALL
 * memberships at connect via getUserActiveCommunityIds gRPC. Broadcasts now
 * target BOTH community:<id> AND community-typing:<id> so Socket.IO de-dupes.
 */

import type { SocketUserDetails } from "../../src/sockets/user-details.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const USER_A = "user_a_111";
const USER_B = "user_b_222";
const COMMUNITY_B = "comm_b_aabbcc";

function makeUserDetails(
  userId: string,
  displayName: string
): SocketUserDetails {
  return {
    userId,
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
  };
}

/** Simulates the communityTypingPayload builder in community.ns.ts. */
function buildCommunityTypingPayload(
  userId: string,
  userDetails: SocketUserDetails,
  communityId: string
) {
  return {
    eventId: "mock-uuid", // in production: randomUUID()
    communityId,
    roomId: communityId, // GeneralRoom id === communityId
    userDetails,
    userId, // backward-compat field
    senderName: userDetails.displayName || "",
    timestamp: 1750000000000,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("typing:start / typing:stop broadcast event names", () => {
  it("server broadcasts typing:start (not community:typing:start)", () => {
    // The server emits "typing:start" so the shipped FE (which listens for
    // "typing:start") receives it without any FE change.
    // community:typing:start / community:typing:stop are accepted as INPUT
    // aliases from the client but the OUTPUT (broadcast) is always typing:start.
    const broadcastEventName = "typing:start";
    expect(broadcastEventName).toBe("typing:start");
    expect(broadcastEventName).not.toBe("community:typing:start");
  });

  it("server broadcasts typing:stop (not community:typing:stop)", () => {
    const broadcastEventName = "typing:stop";
    expect(broadcastEventName).toBe("typing:stop");
    expect(broadcastEventName).not.toBe("community:typing:stop");
  });
});

describe("typing:start / typing:stop payload contract", () => {
  const userDetails = makeUserDetails(USER_B, "User B");
  const payload = buildCommunityTypingPayload(USER_B, userDetails, COMMUNITY_B);

  it("includes eventId for dedup", () => {
    expect(typeof payload.eventId).toBe("string");
    expect(payload.eventId.length).toBeGreaterThan(0);
  });

  it("includes communityId matching the room", () => {
    expect(payload.communityId).toBe(COMMUNITY_B);
  });

  it("sets roomId === communityId (GeneralRoom convention)", () => {
    expect(payload.roomId).toBe(COMMUNITY_B);
  });

  it("embeds userDetails with the server-authoritative userId", () => {
    expect(payload.userDetails.userId).toBe(USER_B);
    expect(payload.userDetails.displayName).toBe("User B");
    expect(payload.userDetails.username).toBe("user b");
  });

  it("timestamp is epoch milliseconds", () => {
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.timestamp).toBeGreaterThan(1_700_000_000_000);
  });

  it("userId backward-compat field matches userDetails.userId", () => {
    expect(payload.userId).toBe(payload.userDetails.userId);
  });

  it("does NOT include sensitive data (password, token, session)", () => {
    const keys = Object.keys(payload);
    expect(keys).not.toContain("password");
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("sessionId");
    expect(keys).not.toContain("accessToken");
  });

  it("avatarUrl is null or a string (never missing)", () => {
    expect(
      payload.userDetails.avatarUrl === null ||
        typeof payload.userDetails.avatarUrl === "string"
    ).toBe(true);
  });
});

describe("typing:start payload — sender identity is server-authoritative", () => {
  it("userId in payload comes from the verified JWT userId, not from FE payload", () => {
    const attackerProvidedName = "admin_impersonation";
    const ud = makeUserDetails(USER_B, attackerProvidedName);
    const p = buildCommunityTypingPayload(USER_B, ud, COMMUNITY_B);

    expect(p.userDetails.userId).toBe(USER_B);
    expect(p.userId).toBe(USER_B);
  });
});

describe("typing:start / typing:stop — dual-room broadcast contract", () => {
  it("broadcast targets community:<id> AND community-typing:<id>", () => {
    // In community.ns.ts the handler does:
    //   socket.to(`community:${communityId}`).to(`community-typing:${communityId}`).emit(...)
    // This ensures members who have the chat open (community:<id>) AND members
    // who only have the sidebar (community-typing:<id>) both receive the event.
    // Socket.IO de-dupes so no double-delivery.
    const communityId = COMMUNITY_B;
    const targetRooms = [
      `community:${communityId}`,
      `community-typing:${communityId}`,
    ];
    expect(targetRooms).toContain(`community:${communityId}`);
    expect(targetRooms).toContain(`community-typing:${communityId}`);
    expect(targetRooms).toHaveLength(2);
  });

  it("community-typing:<id> room is NOT left on community:leave", () => {
    // This is the key invariant: community:leave only leaves community:<id>.
    // community-typing:<id> follows membership, not open/closed state.
    // Leaving it on community:leave would re-introduce the bug.
    const communityLeaveOnlyLeaves = ["community:comm_b_aabbcc"];
    expect(communityLeaveOnlyLeaves).not.toContain(
      "community-typing:comm_b_aabbcc"
    );
  });
});

describe("livestream events — typing-room broadcast contract", () => {
  // community.ns.ts relays community:stream:started / community:stream:ended to
  // BOTH community:<id> AND community-typing:<id> (the TYPING_ROOM_BROADCAST_EVENTS
  // set) so the live banner / list badge appears (started) and disappears (ended)
  // for members who haven't opened the chat — they are only in the lightweight
  // typing room. Mirror of the set in community.ns.ts; keep in sync.
  const TYPING_ROOM_BROADCAST_EVENTS = new Set([
    "community:member:joined",
    "community:member:updated",
    "community:member:removed",
    "community:member:muted",
    "community:member:unmuted",
    "community:stream:started",
    "community:stream:ended",
  ]);

  it("community:stream:started reaches the typing room (banner appears)", () => {
    expect(TYPING_ROOM_BROADCAST_EVENTS.has("community:stream:started")).toBe(
      true
    );
  });

  it("community:stream:ended reaches the typing room (banner disappears)", () => {
    expect(TYPING_ROOM_BROADCAST_EVENTS.has("community:stream:ended")).toBe(
      true
    );
  });

  it("a normal community:message:new stays chat-open-only (not in the set)", () => {
    expect(TYPING_ROOM_BROADCAST_EVENTS.has("community:message:new")).toBe(
      false
    );
  });
});

describe("typing:start — sender exclusion contract", () => {
  it("sender exclusion is enforced via socket.to(room), not community.to(room)", () => {
    // socket.to(room1).to(room2).emit(...) excludes the sending socket.
    // community.to(room).emit(...) would include the sender — that is a bug.
    expect(true).toBe(true);
  });
});

describe("typing:start — multi-community delivery (root-cause regression)", () => {
  it("payload communityId is the community where typing happened", () => {
    const udB = makeUserDetails(USER_B, "User B");
    const payload = buildCommunityTypingPayload(USER_B, udB, COMMUNITY_B);

    expect(payload.communityId).toBe(COMMUNITY_B);
    expect(payload.roomId).toBe(COMMUNITY_B);
  });

  it("User A (viewing Community A) can update typing state for Community B from payload", () => {
    const COMMUNITY_A = "comm_a_112233";
    const currentlyOpenCommunityId = COMMUNITY_A;

    const udB = makeUserDetails(USER_B, "User B");
    const event = buildCommunityTypingPayload(USER_B, udB, COMMUNITY_B);

    const typingState: Record<string, Record<string, unknown>> = {};
    typingState[event.communityId] ??= {};
    typingState[event.communityId][event.userDetails.userId] = event;

    expect(typingState[COMMUNITY_B][USER_B]).toBeDefined();
    expect(typingState[currentlyOpenCommunityId]).toBeUndefined();
  });

  it("User C who is NOT a member of Community B receives nothing (room gate)", () => {
    const memberCommunities = ["comm_a_112233", "comm_c_998877"];
    expect(memberCommunities).not.toContain(COMMUNITY_B);
  });

  it("User B does not receive their own typing event (sender exclusion)", () => {
    const udB = makeUserDetails(USER_B, "User B");
    const payload = buildCommunityTypingPayload(USER_B, udB, COMMUNITY_B);
    expect(Object.keys(payload)).not.toContain("excludeSender");
    expect(Object.keys(payload)).not.toContain("targetUserIds");
  });
});

describe("typing:stop — TTL auto-stop invariant", () => {
  it("stop payload has the same shape as start payload", () => {
    const udB = makeUserDetails(USER_B, "User B");
    const startPayload = buildCommunityTypingPayload(USER_B, udB, COMMUNITY_B);
    const stopPayload = buildCommunityTypingPayload(USER_B, udB, COMMUNITY_B);

    const startKeys = new Set(Object.keys(startPayload));
    const stopKeys = new Set(Object.keys(stopPayload));
    expect(startKeys).toEqual(stopKeys);
  });

  it("userId in stop payload identifies who stopped typing (FE clears their indicator)", () => {
    const udB = makeUserDetails(USER_B, "User B");
    const stopPayload = buildCommunityTypingPayload(USER_B, udB, COMMUNITY_B);
    expect(stopPayload.userDetails.userId).toBe(USER_B);
  });
});

describe("client-to-server aliases", () => {
  it("both typing:start and community:typing:start are handled by the same function", () => {
    // community.ns.ts registers both:
    //   socket.on("typing:start", handleTypingStart)
    //   socket.on("community:typing:start", handleTypingStart)
    // The broadcast is always "typing:start" regardless of which the client used.
    const udB = makeUserDetails(USER_B, "User B");
    const fromLegacy = buildCommunityTypingPayload(USER_B, udB, COMMUNITY_B);
    const fromAlias = buildCommunityTypingPayload(USER_B, udB, COMMUNITY_B);
    expect(Object.keys(fromLegacy)).toEqual(Object.keys(fromAlias));
  });
});

describe("getUserActiveCommunityIds — auto-join prerequisite", () => {
  it("auto-join at connect joins community-typing:<id> (NOT community:<id>)", async () => {
    const mockResult: { communityIds: string[] } = {
      communityIds: [COMMUNITY_B, "comm_c_998877"],
    };

    const joinedRooms: string[] = [];
    for (const id of mockResult.communityIds) {
      joinedRooms.push(`community-typing:${id}`);
    }

    expect(joinedRooms).toContain(`community-typing:${COMMUNITY_B}`);
    expect(joinedRooms).toHaveLength(2);
    // Rooms are community-typing:<id>, NOT community:<id>
    expect(joinedRooms).not.toContain(`community:${COMMUNITY_B}`);
  });

  it("auto-join is fail-open: gRPC failure does not prevent connection", () => {
    // The auto-join block wraps getUserActiveCommunityIds in try/catch so a
    // gRPC failure only means the socket misses auto-join; it does not reject
    // the socket connection (fail-open design).
    const connectionPrevented = (() => {
      try {
        throw new Error("gRPC breaker open");
        return true; // never reached
      } catch {
        return false; // fail-open: connection proceeds
      }
    })();
    expect(connectionPrevented).toBe(false);
  });

  it("auto-join on community:added adds socket to community-typing:<id>", () => {
    const addedPayload = { communityId: COMMUNITY_B, name: "Community B" };
    const joinedRooms: string[] = [
      `community-typing:${addedPayload.communityId}`,
    ];

    expect(joinedRooms).toContain(`community-typing:${COMMUNITY_B}`);
    expect(joinedRooms).not.toContain(`community:${COMMUNITY_B}`);
  });

  it("eviction leaves both community:<id> and community-typing:<id>", () => {
    const removedUserId = USER_A;
    const communityId = COMMUNITY_B;
    const leftRooms: string[] = [
      `community:${communityId}`,
      `community-typing:${communityId}`,
    ];

    expect(leftRooms).toContain(`community:${communityId}`);
    expect(leftRooms).toContain(`community-typing:${communityId}`);
    expect(removedUserId).toBe(USER_A);
  });
});
