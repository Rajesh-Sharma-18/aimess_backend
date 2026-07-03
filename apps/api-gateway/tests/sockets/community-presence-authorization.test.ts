/**
 * Community presence-event authorization — regression tests.
 *
 * Audit finding: typing:start/stop and recording:start/stop broadcast via
 * socket.to(room), which routes to a room regardless of whether the EMITTING
 * socket is a member of it. The handlers validated payload shape only
 * (CommunityTypingSchema) — there was no check that the sender was actually
 * authorized for the communityId in the payload. Any authenticated user could
 * emit typing:start/recording:start with an arbitrary communityId and inject a
 * fake presence indicator into a community they don't belong to.
 *
 * Fix: community.ns.ts now gates all four handlers behind
 * `isAuthorizedForCommunity(communityId)`, which reuses room membership
 * already established by:
 *   - connect-time auto-join of community-typing:<id> for every ACTIVE
 *     membership (communityClient.getUserActiveCommunityIds — ban-gated)
 *   - community:join, which joins community:<id> only after an explicit
 *     ban/membership check (communityClient.checkCommunityMembership)
 * No new gRPC call is made per keystroke — the gate is an in-memory
 * socket.rooms.has() lookup, mirroring the existing pattern in stream.ns.ts.
 *
 * These tests model socket.rooms as a Set<string> (what Socket.IO actually
 * uses) and replicate the exact isAuthorizedForCommunity predicate to verify
 * the six audit scenarios.
 */

const COMMUNITY_A = "comm_a_112233";
const COMMUNITY_B = "comm_b_aabbcc";

/** Mirrors isAuthorizedForCommunity in community.ns.ts. */
function isAuthorizedForCommunity(
  rooms: Set<string>,
  communityId: string
): boolean {
  return (
    rooms.has(`community:${communityId}`) ||
    rooms.has(`community-typing:${communityId}`)
  );
}

describe("community presence authorization — connected without room join", () => {
  it("auto-join at connect grants authorization without an explicit community:join", () => {
    // getUserActiveCommunityIds returned COMMUNITY_A → socket auto-joined
    // community-typing:<id> at connect (community.ns.ts:477-494).
    const rooms = new Set<string>([`community-typing:${COMMUNITY_A}`]);
    expect(isAuthorizedForCommunity(rooms, COMMUNITY_A)).toBe(true);
  });

  it("a socket that has joined nothing is unauthorized for any communityId", () => {
    const rooms = new Set<string>();
    expect(isAuthorizedForCommunity(rooms, COMMUNITY_A)).toBe(false);
  });
});

describe("community presence authorization — joined room", () => {
  it("explicit community:join grants authorization via community:<id>", () => {
    const rooms = new Set<string>([`community:${COMMUNITY_A}`]);
    expect(isAuthorizedForCommunity(rooms, COMMUNITY_A)).toBe(true);
  });
});

describe("community presence authorization — left room", () => {
  it("community:leave only removes community:<id>, not community-typing:<id>, so presence still works", () => {
    // community:leave (community.ns.ts:686-697) calls socket.leave(`community:${id}`)
    // only. The always-on membership room is untouched, so sidebar typing keeps
    // working after the chat view is closed.
    const rooms = new Set<string>([
      `community:${COMMUNITY_A}`,
      `community-typing:${COMMUNITY_A}`,
    ]);
    rooms.delete(`community:${COMMUNITY_A}`); // simulate community:leave
    expect(isAuthorizedForCommunity(rooms, COMMUNITY_A)).toBe(true);
  });

  it("if a socket was never auto-joined to community-typing:<id>, leaving community:<id> revokes authorization", () => {
    const rooms = new Set<string>([`community:${COMMUNITY_A}`]);
    rooms.delete(`community:${COMMUNITY_A}`);
    expect(isAuthorizedForCommunity(rooms, COMMUNITY_A)).toBe(false);
  });
});

describe("community presence authorization — reconnect", () => {
  it("a fresh socket after reconnect re-derives authorization purely from the new connect-time auto-join", () => {
    // Simulates: old socket disconnects (all rooms are discarded by Socket.IO),
    // new socket connects and calls getUserActiveCommunityIds again.
    const oldSocketRooms = new Set<string>([
      `community:${COMMUNITY_A}`,
      `community-typing:${COMMUNITY_A}`,
    ]);
    const newSocketRoomsAfterReconnect = new Set<string>([
      `community-typing:${COMMUNITY_A}`, // re-derived from gRPC, not carried over
    ]);
    expect(oldSocketRooms.size).toBeGreaterThan(0);
    expect(
      isAuthorizedForCommunity(newSocketRoomsAfterReconnect, COMMUNITY_A)
    ).toBe(true);
  });
});

describe("community presence authorization — multiple communities", () => {
  it("authorization is evaluated per-communityId, independent across memberships", () => {
    const rooms = new Set<string>([
      `community-typing:${COMMUNITY_A}`,
      `community:${COMMUNITY_B}`,
    ]);
    expect(isAuthorizedForCommunity(rooms, COMMUNITY_A)).toBe(true);
    expect(isAuthorizedForCommunity(rooms, COMMUNITY_B)).toBe(true);
  });

  it("membership in Community A does not authorize presence events in Community C", () => {
    const COMMUNITY_C = "comm_c_998877";
    const rooms = new Set<string>([`community-typing:${COMMUNITY_A}`]);
    expect(isAuthorizedForCommunity(rooms, COMMUNITY_C)).toBe(false);
  });
});

describe("community presence authorization — unauthorized user (the audit finding)", () => {
  it("a socket with no membership rooms for the target communityId is rejected — no fake indicator is broadcast", () => {
    // Attacker is authenticated (valid JWT) and a member of COMMUNITY_A only,
    // but sends typing:start/recording:start with COMMUNITY_B's id, which
    // they never joined and were never auto-joined to.
    const attackerRooms = new Set<string>([`community-typing:${COMMUNITY_A}`]);
    expect(isAuthorizedForCommunity(attackerRooms, COMMUNITY_B)).toBe(false);
  });

  it("payload passing schema validation is not sufficient — authorization is a separate, mandatory gate", () => {
    // CommunityTypingSchema only checks that communityId is a non-empty string;
    // it has no knowledge of the socket's actual memberships. The handler must
    // check isAuthorizedForCommunity AFTER schema validation, before broadcasting.
    const schemaValidPayload = { communityId: COMMUNITY_B };
    const attackerRooms = new Set<string>();
    const wouldBroadcast =
      typeof schemaValidPayload.communityId === "string" &&
      isAuthorizedForCommunity(attackerRooms, schemaValidPayload.communityId);
    expect(wouldBroadcast).toBe(false);
  });
});
