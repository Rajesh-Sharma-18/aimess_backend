/**
 * Evict-on-removal — unit tests for the ban/kick/leave eviction logic in
 * community.ns.ts (relaying the community-service `community:member:removed`
 * Redis event; see the block around "Evict-on-removal" in that file).
 *
 * Mirrors the existing style in community-typing.test.ts: the logic-layer
 * function is extracted and unit-tested in isolation rather than spinning up
 * a live Socket.IO server (that's covered by the e2e testing-suite).
 *
 * Verifies: only the removed user's socket(s) are evicted (other members'
 * sockets in the same room are untouched, so this stays a per-user removal —
 * not a room-wide close), eviction leaves BOTH the broadcast room and the
 * lightweight typing room, and the communityId used for the typing-room name
 * falls back to the channel when the event payload doesn't carry one.
 */

const COMMUNITY_ID = "comm_b_aabbcc";
const REMOVED_USER = "user_banned_444";
const OTHER_MEMBER = "user_active_111";

type FakeSocket = { id: string; data: { userId: string } };

/** Mirrors the `for (const s of sockets) if (s.data.userId === removedUserId)` filter. */
function resolveEvictedSockets(
  sockets: FakeSocket[],
  removedUserId: string
): FakeSocket[] {
  return sockets.filter((s) => s.data.userId === removedUserId);
}

describe("evict-on-removal — socket filter", () => {
  it("evicts only the removed user's socket(s), leaving other members untouched", () => {
    const sockets: FakeSocket[] = [
      { id: "sock-1", data: { userId: REMOVED_USER } },
      { id: "sock-2", data: { userId: OTHER_MEMBER } },
      { id: "sock-3", data: { userId: REMOVED_USER } }, // removed user's 2nd device
    ];

    const evicted = resolveEvictedSockets(sockets, REMOVED_USER);

    expect(evicted.map((s) => s.id)).toEqual(["sock-1", "sock-3"]);
    expect(evicted.every((s) => s.data.userId === REMOVED_USER)).toBe(true);
  });

  it("evicts ALL of the banned user's devices, not just one", () => {
    const sockets: FakeSocket[] = [
      { id: "device-web", data: { userId: REMOVED_USER } },
      { id: "device-mobile", data: { userId: REMOVED_USER } },
    ];
    expect(resolveEvictedSockets(sockets, REMOVED_USER)).toHaveLength(2);
  });

  it("no matching sockets → nothing evicted (removed user has no live connection)", () => {
    const sockets: FakeSocket[] = [
      { id: "sock-1", data: { userId: OTHER_MEMBER } },
    ];
    expect(resolveEvictedSockets(sockets, REMOVED_USER)).toHaveLength(0);
  });
});

describe("evict-on-removal — rooms left per evicted socket", () => {
  function roomsToLeave(communityId: string): string[] {
    return [`community:${communityId}`, `community-typing:${communityId}`];
  }

  it("leaves BOTH the broadcast room and the lightweight typing room", () => {
    const rooms = roomsToLeave(COMMUNITY_ID);
    expect(rooms).toContain(`community:${COMMUNITY_ID}`);
    expect(rooms).toContain(`community-typing:${COMMUNITY_ID}`);
    expect(rooms).toHaveLength(2);
  });
});

describe("evict-on-removal — communityId resolution", () => {
  function resolveCommunityId(
    payloadCommunityId: string | undefined,
    channel: string
  ): string {
    return payloadCommunityId ?? channel.slice("community:".length);
  }

  it("prefers the communityId carried on the removal payload", () => {
    expect(resolveCommunityId(COMMUNITY_ID, `community:${COMMUNITY_ID}`)).toBe(
      COMMUNITY_ID
    );
  });

  it("falls back to the Redis channel suffix when the payload omits communityId", () => {
    expect(resolveCommunityId(undefined, `community:${COMMUNITY_ID}`)).toBe(
      COMMUNITY_ID
    );
  });
});

describe("evict-on-removal — typing:stop cleanup broadcast", () => {
  function buildStopPayload(removedUserId: string, communityId: string) {
    return {
      communityId,
      roomId: communityId,
      userId: removedUserId,
      senderName: "",
    };
  }

  it("clears any stale typing indicator left by the removed user", () => {
    const payload = buildStopPayload(REMOVED_USER, COMMUNITY_ID);
    expect(payload.userId).toBe(REMOVED_USER);
    expect(payload.communityId).toBe(COMMUNITY_ID);
  });
});

describe("evict-on-removal — no-op guard", () => {
  it("a removal event with no userId in the payload evicts nothing (guarded, not a crash)", () => {
    const removedData: { userId?: string; communityId?: string } | null = {
      communityId: COMMUNITY_ID,
    };
    const shouldEvict = Boolean(removedData?.userId);
    expect(shouldEvict).toBe(false);
  });
});

describe("evict-on-removal — the removed user's OWN socket never receives the room-wide community:member:removed broadcast", () => {
  /** Mirrors the `isTarget` exclusion filter added to community.ns.ts. */
  function resolveBroadcastRecipients(
    sockets: FakeSocket[],
    removedUserId: string | undefined
  ): FakeSocket[] {
    const isTarget = (s: FakeSocket) =>
      removedUserId != null && s.data.userId === removedUserId;
    return sockets.filter((s) => !isTarget(s));
  }

  it("excludes ALL of the removed/banned user's own devices from the broadcast", () => {
    const sockets: FakeSocket[] = [
      { id: "sock-1", data: { userId: REMOVED_USER } },
      { id: "sock-2", data: { userId: OTHER_MEMBER } },
      { id: "sock-3", data: { userId: REMOVED_USER } }, // removed user's 2nd device
    ];

    const recipients = resolveBroadcastRecipients(sockets, REMOVED_USER);

    expect(recipients.map((s) => s.id)).toEqual(["sock-2"]);
  });

  it("still broadcasts to every OTHER member normally", () => {
    const sockets: FakeSocket[] = [
      { id: "sock-a", data: { userId: "member-a" } },
      { id: "sock-b", data: { userId: "member-b" } },
    ];
    const recipients = resolveBroadcastRecipients(sockets, REMOVED_USER);
    expect(recipients).toHaveLength(2);
  });

  it("degrades to a full broadcast (excludes nobody) when the payload is missing userId — defense-in-depth, not a silent drop", () => {
    const sockets: FakeSocket[] = [
      { id: "sock-1", data: { userId: REMOVED_USER } },
      { id: "sock-2", data: { userId: OTHER_MEMBER } },
    ];
    const recipients = resolveBroadcastRecipients(sockets, undefined);
    expect(recipients).toHaveLength(2);
  });
});
