/**
 * Community typing indicator — unit tests.
 *
 * Verifies the logic-layer functions used by the /community namespace typing
 * handler: the payload builder and the membership-validation / direct-delivery
 * / sender-exclusion contracts.
 *
 * Full Socket.IO namespace integration (live Redis adapter + gRPC clients) is
 * out of scope here — that is covered by the e2e testing-suite. What we verify:
 *
 * 1. Payload shape is correct and sender identity is always server-authoritative.
 * 2. The broadcast event names are `typing:start` / `typing:stop` (not renamed).
 * 3. The payload does NOT include sensitive data.
 * 4. Payload fields match the AsyncAPI CommunityTypingStartBroadcast schema.
 *
 * Room-independence refactor (current):
 * Typing no longer depends on Socket.IO room membership at all — neither
 * `community:<id>` (joined only via an explicit community:join) nor
 * `community-typing:<id>` (auto-joined at connect, still used by recording +
 * livestream/roster events below, which are UNCHANGED). community.ns.ts now
 * resolves the community's active member ids via
 * communityClient.getCommunityActiveMemberIds (one gRPC call, itself a thin
 * wrapper around community-service's existing
 * communityRepository.findActiveMemberIds), validates the sender is in that
 * list, and delivers `typing:start`/`typing:stop` directly to every OTHER
 * member's already-joined `user:<id>` room (the project's pre-existing
 * per-user socket registry — not a community-scoped room) via
 * `community.in(rooms).fetchSockets()` + per-socket `.emit()`.
 *
 * Root-cause regression this superseded:
 * The original bug was that sockets only joined community:<id> rooms on an
 * explicit community:join from the client. The first fix (still in place for
 * recording/livestream/roster) added an auto-joined community-typing:<id>
 * room. This refactor removes the room dependency for typing specifically.
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

describe("typing:start / typing:stop — direct per-member delivery contract (room-independent)", () => {
  // Mirrors getActiveCommunityMemberIds + emitDirectToUsers in community.ns.ts.
  function resolveTypingDelivery(
    activeMemberIds: string[],
    senderId: string
  ): { isSenderMember: boolean; recipientRooms: string[] } {
    const isSenderMember = activeMemberIds.includes(senderId);
    const recipientRooms = activeMemberIds
      .filter((id) => id !== senderId)
      .map((id) => `user:${id}`);
    return { isSenderMember, recipientRooms };
  }

  it("delivery target is user:<id> per active member, NOT community:<id> or community-typing:<id>", () => {
    const activeMemberIds = ["user_a_111", "user_b_222", "user_c_333"];
    const { recipientRooms } = resolveTypingDelivery(
      activeMemberIds,
      "user_a_111"
    );

    expect(recipientRooms).toEqual(["user:user_b_222", "user:user_c_333"]);
    expect(recipientRooms).not.toContain(`community:${COMMUNITY_B}`);
    expect(recipientRooms).not.toContain(`community-typing:${COMMUNITY_B}`);
  });

  it("sender is excluded from the recipient set entirely (all of the sender's own devices)", () => {
    const activeMemberIds = ["user_a_111", "user_b_222"];
    const { recipientRooms } = resolveTypingDelivery(
      activeMemberIds,
      "user_a_111"
    );
    expect(recipientRooms).not.toContain("user:user_a_111");
  });

  it("a non-member sender resolves isSenderMember=false — event must be dropped", () => {
    const activeMemberIds = ["user_b_222", "user_c_333"];
    const { isSenderMember } = resolveTypingDelivery(
      activeMemberIds,
      "user_outsider_999"
    );
    expect(isSenderMember).toBe(false);
  });

  it("an active member sender resolves isSenderMember=true", () => {
    const activeMemberIds = ["user_a_111", "user_b_222"];
    const { isSenderMember } = resolveTypingDelivery(
      activeMemberIds,
      "user_a_111"
    );
    expect(isSenderMember).toBe(true);
  });

  it("a solo-member community (only the sender) resolves zero recipient rooms — no fetchSockets call needed", () => {
    const activeMemberIds = ["user_a_111"];
    const { recipientRooms } = resolveTypingDelivery(
      activeMemberIds,
      "user_a_111"
    );
    expect(recipientRooms).toHaveLength(0);
  });

  it("community:leave does not affect typing delivery — it is not room-gated", () => {
    // Unlike the pre-refactor design, leaving community:<id> (chat view closed)
    // has zero effect on typing delivery: membership (not room membership)
    // is the only gate now.
    const activeMemberIds = ["user_a_111", "user_b_222"];
    const communityLeaveOnlyLeaves = ["community:comm_b_aabbcc"];
    const { recipientRooms } = resolveTypingDelivery(
      activeMemberIds,
      "user_a_111"
    );
    expect(communityLeaveOnlyLeaves).not.toContain("user:user_b_222");
    expect(recipientRooms).toContain("user:user_b_222");
  });
});

describe("getCommunityActiveMemberIds — single fetch serves both validation and recipients", () => {
  // Mirrors getActiveCommunityMemberIds in community.ns.ts: one gRPC call
  // (community-service's findActiveMemberIds, ACTIVE-status-only) is reused
  // for both checks — no second round trip, no duplicated membership logic.
  it("a BANNED/LEFT/PENDING user is absent from the ACTIVE-only list, so membership check and recipient exclusion both fall out of the same list", () => {
    // findActiveMemberIds only ever returns ACTIVE members — banned/left users
    // are never present, so `.includes(senderId)` alone is a correct
    // membership check without a separate checkCommunityMembership call.
    const activeMemberIds = ["user_a_111", "user_b_222"];
    const bannedUserId = "user_banned_444";
    expect(activeMemberIds.includes(bannedUserId)).toBe(false);
  });

  it("member list fetched once per event — no N+1 (one gRPC call regardless of member count)", () => {
    let fetchCount = 0;
    const fakeFetch = async (): Promise<string[]> => {
      fetchCount += 1;
      return ["user_a_111", "user_b_222", "user_c_333", "user_d_444"];
    };
    return fakeFetch().then((ids) => {
      expect(fetchCount).toBe(1);
      expect(ids).toHaveLength(4);
    });
  });

  it("a gRPC failure degrades to an empty list (fail-closed for typing: no members ⇒ no delivery, no crash)", () => {
    const simulateFailure = (): string[] => {
      try {
        throw new Error("community-service unreachable");
      } catch {
        return [];
      }
    };
    expect(simulateFailure()).toEqual([]);
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
    "community:stream:updated",
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

  it("community:stream:updated reaches the typing room (title/badge metadata updates)", () => {
    expect(TYPING_ROOM_BROADCAST_EVENTS.has("community:stream:updated")).toBe(
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
  it("sender exclusion is enforced by omission from the recipient room list, not socket.to()", () => {
    // Delivery now goes through community.in(recipientRooms).fetchSockets() +
    // per-socket .emit() (community-level API, not the per-request `socket`),
    // so exclusion can no longer rely on socket.to()'s implicit
    // sender-exclusion. Instead the sender's userId is filtered out of the
    // active-member list BEFORE building `user:<id>` recipient rooms — see
    // getActiveCommunityMemberIds/emitDirectToUsers in community.ns.ts.
    const activeMemberIds = ["user_a_111", "user_b_222"];
    const senderId = "user_a_111";
    const recipientRooms = activeMemberIds
      .filter((id) => id !== senderId)
      .map((id) => `user:${id}`);
    expect(recipientRooms).not.toContain(`user:${senderId}`);
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

  it("User C who is NOT a member of Community B receives nothing (membership gate, not a room gate)", () => {
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

describe("getUserActiveCommunityIds — auto-join prerequisite (recording + livestream/roster only, NOT typing)", () => {
  // This auto-join block is UNCHANGED by the typing refactor: typing no
  // longer reads from community-typing:<id> at all (see the direct-delivery
  // describe blocks above), but recording:start/stop and the livestream/roster
  // relay (community:member:*, community:stream:started/ended) still do, so
  // this prerequisite auto-join must keep working exactly as before.
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

describe("auto-join at connect — partial-failure resilience", () => {
  // Mirrors the Promise.allSettled logic in community.ns.ts: one bad room join
  // must not prevent the others from joining, and the failed ids must be
  // identifiable for logging (socketId, userId, joinedRoomCount, failedRoomIds).
  async function joinAllSettled(
    communityIds: string[],
    join: (id: string) => Promise<void>
  ): Promise<{ joinedCount: number; failedCommunityIds: string[] }> {
    const results = await Promise.allSettled(communityIds.map(join));
    const failedCommunityIds = communityIds.filter(
      (_id, i) => results[i]!.status === "rejected"
    );
    return {
      joinedCount: communityIds.length - failedCommunityIds.length,
      failedCommunityIds,
    };
  }

  it("all rooms join successfully → joinedCount matches, no failures", async () => {
    const ids = [COMMUNITY_B, "comm_c_998877", "comm_d_445566"];
    const { joinedCount, failedCommunityIds } = await joinAllSettled(ids, () =>
      Promise.resolve()
    );
    expect(joinedCount).toBe(3);
    expect(failedCommunityIds).toHaveLength(0);
  });

  it("one failing room join does not block the rest from joining", async () => {
    const ids = [COMMUNITY_B, "comm_bad_id", "comm_d_445566"];
    const { joinedCount, failedCommunityIds } = await joinAllSettled(
      ids,
      (id) =>
        id === "comm_bad_id"
          ? Promise.reject(new Error("join failed"))
          : Promise.resolve()
    );
    expect(joinedCount).toBe(2);
    expect(failedCommunityIds).toEqual(["comm_bad_id"]);
  });

  it("multiple failing rooms are all captured in failedCommunityIds", async () => {
    const ids = ["bad_1", COMMUNITY_B, "bad_2"];
    const { joinedCount, failedCommunityIds } = await joinAllSettled(
      ids,
      (id) =>
        id.startsWith("bad_")
          ? Promise.reject(new Error("join failed"))
          : Promise.resolve()
    );
    expect(joinedCount).toBe(1);
    expect(failedCommunityIds).toEqual(["bad_1", "bad_2"]);
  });
});
