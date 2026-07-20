/**
 * "My Communities" list visibility (business rules):
 *  - ACTIVE  → visible.
 *  - BANNED  → visible UNTIL the caller dismisses it (dismissedAt set) — the
 *    community stays in the list even though every action on it is denied
 *    with USER_BANNED.
 *  - LEFT, unbannedAt set (an admin just lifted a ban) → visible UNTIL the
 *    caller dismisses it (dismissedAt set) — an unban must never itself evict
 *    the community from the list, same restricted-access-until-dismissed
 *    model as a ban, just without the ban.
 *  - LEFT, unbannedAt unset (an ordinary voluntary leave or admin kick,
 *    removedAt is an audit-only marker) → never visible — rejoin via the
 *    normal flow.
 * listMineByActivity (and its V2 keyset counterpart) encode this as:
 *   status=ACTIVE
 *   OR (status=BANNED AND dismissedAt unset)
 *   OR (status=LEFT AND unbannedAt set AND dismissedAt unset)
 */
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));
jest.unmock("../../src/repositories/community.repository.js");

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { deriveMembershipState } from "../../src/lib/community-authz.js";
import { CommunityMemberStatus } from "../../src/generated/prisma/index.js";

const db = prisma.community as unknown as {
  findMany: jest.Mock;
  count: jest.Mock;
};

const EXPECTED_MEMBER_FILTER = {
  some: {
    userId: "user-1",
    OR: [
      { status: "ACTIVE" },
      { status: "BANNED", dismissedAt: { isSet: false } },
      {
        status: "LEFT",
        unbannedAt: { isSet: true },
        dismissedAt: { isSet: false },
      },
    ],
  },
};

describe("communityRepository.listMineByActivity — visibility filter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.findMany.mockResolvedValue([]);
    db.count.mockResolvedValue(0);
  });

  it("matches ACTIVE, or BANNED not yet dismissed — LEFT (voluntary OR kicked) and dismissed-BANNED never match", async () => {
    await communityRepository.listMineByActivity({
      userId: "user-1",
      direction: "before",
      ts: new Date("2026-07-01T00:00:00.000Z"),
      limit: 20,
    });

    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: EXPECTED_MEMBER_FILTER,
        }),
      })
    );
  });

  it("also applies the same filter to the total count query", async () => {
    await communityRepository.listMineByActivity({
      userId: "user-1",
      direction: "before",
      ts: new Date("2026-07-01T00:00:00.000Z"),
      limit: 20,
    });

    expect(db.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: EXPECTED_MEMBER_FILTER,
        }),
      })
    );
  });

  it("V2 keyset variant uses the identical membership filter", async () => {
    await communityRepository.listMineByActivityKeyset({
      userId: "user-1",
      cursor: null,
      limit: 20,
    });

    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: EXPECTED_MEMBER_FILTER,
        }),
      })
    );
  });
});

/**
 * Membership state on the wire. Visibility (above) and membership (here) are
 * SEPARATE axes: a row being LISTED never implies the caller is a member.
 *
 * This is the real shared helper — the same one the community detail API, the
 * community list API, and the personal `community:membership:restricted`
 * socket events all emit, so a realtime update leaves the client in exactly
 * the state a fresh GET (or a hard reload) would produce.
 */
describe("deriveMembershipState — one shape for REST and realtime", () => {
  it("ACTIVE → a real member: isJoined, not banned", () => {
    expect(
      deriveMembershipState({ status: CommunityMemberStatus.ACTIVE })
    ).toEqual({
      isJoined: true,
      isBanned: false,
      membershipStatus: "ACTIVE",
    });
  });

  it("BANNED → listed but NOT joined: access revoked, isBanned drives the banner", () => {
    expect(
      deriveMembershipState({ status: CommunityMemberStatus.BANNED })
    ).toEqual({
      isJoined: false,
      isBanned: true,
      membershipStatus: "BANNED",
    });
  });

  it("post-unban LEFT → NOT a member: ban cleared but membership never restored, so the client renders Join Community", () => {
    // The exact regression: unban must not leave the caller looking like an
    // active member. isJoined false + membershipStatus NONE + isBanned false
    // is what tells the FE to drop the banner, hide the composer, and show
    // the join screen — without a refetch, identical to a hard reload.
    expect(
      deriveMembershipState({ status: CommunityMemberStatus.LEFT })
    ).toEqual({
      isJoined: false,
      isBanned: false,
      membershipStatus: "NONE",
    });
  });

  it("no membership row at all → same non-member shape as post-unban", () => {
    expect(deriveMembershipState(null)).toEqual({
      isJoined: false,
      isBanned: false,
      membershipStatus: "NONE",
    });
  });
});
