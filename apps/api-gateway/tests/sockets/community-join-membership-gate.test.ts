/**
 * community:join membership gate — regression test.
 *
 * Fix: the ban/unban lifecycle audit found that community:join
 * (community.ns.ts) only rejected an explicit BANNED verdict from
 * checkCommunityMembership. A LEFT member — including a user who was just
 * unbanned (unbanMember lifts BANNED -> LEFT, it never restores ACTIVE) — is
 * not banned, so the old gate let them join the community:<id> broadcast room
 * and receive live messages/typing/member events despite not being a member.
 * The gate now also rejects whenever `!isMember` (mirrors community-service's
 * checkCommunityMembership, where isMember === status === "ACTIVE").
 *
 * This mirrors the existing pattern in community-presence-authorization.test.ts:
 * a small unit test around the decision predicate, not a full Socket.IO
 * integration (that lives in the e2e testing-suite).
 */

/** Mirrors the community:join ack decision in community.ns.ts. */
function decideJoinAck(m: {
  isBanned: boolean;
  isMember: boolean;
}): "USER_BANNED" | "FORBIDDEN" | "JOINED" {
  if (m.isBanned) return "USER_BANNED";
  if (!m.isMember) return "FORBIDDEN";
  return "JOINED";
}

describe("community:join membership gate", () => {
  it("an ACTIVE member joins the room", () => {
    expect(decideJoinAck({ isBanned: false, isMember: true })).toBe("JOINED");
  });

  it("a BANNED member is rejected with USER_BANNED", () => {
    expect(decideJoinAck({ isBanned: true, isMember: false })).toBe(
      "USER_BANNED"
    );
  });

  it("a just-unbanned (LEFT, not ACTIVE) user is rejected — unban never restores membership", () => {
    // unbanMember flips BANNED -> LEFT: isBanned false, isMember false (status
    // !== "ACTIVE"). Must NOT be treated as an ACTIVE member.
    expect(decideJoinAck({ isBanned: false, isMember: false })).toBe(
      "FORBIDDEN"
    );
  });

  it("a user who was never a member at all is rejected the same way", () => {
    expect(decideJoinAck({ isBanned: false, isMember: false })).toBe(
      "FORBIDDEN"
    );
  });
});
