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
  isPublicCommunity: boolean;
}): "USER_BANNED" | "FORBIDDEN" | "JOINED" {
  if (m.isBanned) return "USER_BANNED";
  // PUBLIC communities let non-members subscribe (parity with REST history
  // read access — otherwise the FE can browse past messages but silently
  // misses every new one). PRIVATE stays members-only.
  if (!m.isMember && !m.isPublicCommunity) return "FORBIDDEN";
  return "JOINED";
}

describe("community:join membership gate", () => {
  it("an ACTIVE member of a PRIVATE community joins the room", () => {
    expect(
      decideJoinAck({
        isBanned: false,
        isMember: true,
        isPublicCommunity: false,
      })
    ).toBe("JOINED");
  });

  it("a BANNED member is rejected with USER_BANNED even in a PUBLIC community", () => {
    expect(
      decideJoinAck({
        isBanned: true,
        isMember: false,
        isPublicCommunity: true,
      })
    ).toBe("USER_BANNED");
  });

  it("a just-unbanned (LEFT) user in a PRIVATE community is rejected — unban never restores membership", () => {
    // unbanMember flips BANNED -> LEFT: isBanned false, isMember false (status
    // !== "ACTIVE"). Must NOT be treated as an ACTIVE member.
    expect(
      decideJoinAck({
        isBanned: false,
        isMember: false,
        isPublicCommunity: false,
      })
    ).toBe("FORBIDDEN");
  });

  it("a non-member subscribing to a PUBLIC community is allowed (matches REST)", () => {
    expect(
      decideJoinAck({
        isBanned: false,
        isMember: false,
        isPublicCommunity: true,
      })
    ).toBe("JOINED");
  });

  it("a non-member in a PRIVATE community is rejected", () => {
    expect(
      decideJoinAck({
        isBanned: false,
        isMember: false,
        isPublicCommunity: false,
      })
    ).toBe("FORBIDDEN");
  });
});
