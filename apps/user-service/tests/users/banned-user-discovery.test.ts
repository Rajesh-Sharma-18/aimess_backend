/**
 * A Super-Admin-banned account must not be discoverable by normal users.
 *
 * Bug: every people-discovery query filtered on `deletedAt` alone and ignored
 * `UserProfile.status` — the ban/suspend mirror backoffice writes over
 * `AdminSetProfileStatus`. So banning a user in the admin panel changed nothing
 * for `GET /api/v1/users/search`, `GET /api/v1/users` or the unified
 * `GET /api/v1/search?filter=people` leg that proxies to them: the banned row
 * kept coming back under "Other People", by full name, partial name and exact
 * handle alike.
 *
 * The exclusion lives in the WHERE of each query, never in a pass over an
 * already-fetched page: `count`, `hasMore` and the `[firstName, userId]` keyset
 * are all computed by Postgres over the same row set, so a post-filter would
 * hand back short pages and over-report totals.
 *
 * SUSPENDED is deliberately still discoverable — see
 * `DISCOVERABLE_ACCOUNT_WHERE`. Nothing in user-service expires a suspension,
 * so excluding it would make a time-boxed restriction permanent.
 */
const findMany = jest.fn().mockResolvedValue([]);
const findFirst = jest.fn().mockResolvedValue(null);
const findUnique = jest.fn().mockResolvedValue(null);
const count = jest.fn().mockResolvedValue(0);

jest.mock("../../src/config/prisma.js", () => ({
  prisma: { userProfile: { findMany, findFirst, findUnique, count } },
}));

import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";

const VIEWER = { friendIds: ["friend-1"], friendOfFriendIds: ["fof-1"] };
const IDS = ["a", "b"];

/** The account-state clause every discovery query must carry. */
const BANNED_EXCLUDED = { status: { not: "BANNED" } };

/** `where` of the single call the spy recorded. */
function whereOf(spy: jest.Mock): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0][0] as { where: Record<string, unknown> }).where;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("people search — the paged 'Other People' bucket", () => {
  it("excludes banned accounts in the query, not after the page is built", async () => {
    await userProfileRepository.findUsersNotInList(
      ["self"],
      "mind",
      0,
      21,
      VIEWER
    );

    const where = whereOf(findMany);
    expect(where).toMatchObject(BANNED_EXCLUDED);
    expect(where.deletedAt).toBeNull();
  });

  it("applies the same exclusion on a keyset (cursor) page", async () => {
    await userProfileRepository.findUsersNotInList(
      ["self"],
      "mind",
      0,
      21,
      VIEWER,
      { firstName: "Mind", userId: "u-1" }
    );

    expect(whereOf(findMany)).toMatchObject(BANNED_EXCLUDED);
  });

  it("excludes them from the count too, so totalCount/hasMore stay correct", async () => {
    await userProfileRepository.countUsersNotInList(["self"], "mind", VIEWER);

    expect(whereOf(count)).toMatchObject(BANNED_EXCLUDED);
  });

  it("keeps excluding them for a viewer who already has a private room with them", async () => {
    // `alwaysVisibleIds` widens the whoCanFindMe PRIVACY gate for peers the
    // caller already authorized. It must not become a back door around the ban.
    await userProfileRepository.findUsersNotInList(
      ["self"],
      "mind",
      0,
      21,
      VIEWER,
      undefined,
      ["peer-1"]
    );

    expect(whereOf(findMany)).toMatchObject(BANNED_EXCLUDED);
  });
});

describe("the exact-@handle head", () => {
  it("does not resurrect a banned account when searched by exact username", async () => {
    await userProfileRepository.findDiscoverableByNormalizedUsername(
      "mindflayer",
      VIEWER
    );

    const where = whereOf(findFirst);
    expect(where).toMatchObject(BANNED_EXCLUDED);
    expect(where.deletedAt).toBeNull();
  });

  it("holds even with the private-room carve-out applied", async () => {
    await userProfileRepository.findDiscoverableByNormalizedUsername(
      "mindflayer",
      VIEWER,
      ["peer-1"]
    );

    expect(whereOf(findFirst)).toMatchObject(BANNED_EXCLUDED);
  });
});

describe("the friends / 'Add Members' bucket", () => {
  it("excludes a banned friend from the picker and from search's chat head", async () => {
    // A banned account cannot log in, so it can neither accept an invite nor
    // be added to a group — offering it in a picker is an action that fails.
    await userProfileRepository.findUsersInList(IDS, "mind", 0, 10);

    expect(whereOf(findMany)).toMatchObject(BANNED_EXCLUDED);
  });

  it("excludes them from that bucket's count as well", async () => {
    await userProfileRepository.countUsersInList(IDS, "mind");

    expect(whereOf(count)).toMatchObject(BANNED_EXCLUDED);
  });
});

describe("recent searches", () => {
  it("drops a target that has been banned since it was last viewed", async () => {
    await userProfileRepository.findDiscoverableByUserIds(IDS, VIEWER);

    expect(whereOf(findMany)).toMatchObject(BANNED_EXCLUDED);
  });
});

describe("surfaces the ban must NOT hide anyone from", () => {
  it("leaves the admin panel's profile lookup unfiltered", async () => {
    await userProfileRepository.adminGetProfile("banned-user");

    expect(JSON.stringify(whereOf(findUnique))).not.toContain("BANNED");
  });

  it("leaves the admin panel's id search unfiltered", async () => {
    await userProfileRepository.adminSearchProfileIds("Mind Flayer");

    expect(JSON.stringify(whereOf(findMany))).not.toContain("BANNED");
  });

  it("leaves the admin panel's bulk profile enrichment unfiltered", async () => {
    await userProfileRepository.adminGetProfilesByIds(IDS);

    expect(JSON.stringify(whereOf(findMany))).not.toContain("BANNED");
  });

  it("leaves BulkGetUserSnapshots unfiltered so history still renders the name", async () => {
    // Every service resolves identity through this RPC. Filtering here would
    // not hide the banned user — it would blank their name on old messages.
    await userProfileRepository.findManyByUserIds(IDS);

    expect(JSON.stringify(whereOf(findMany))).not.toContain("BANNED");
  });
});

describe("the exclusion is BANNED-only", () => {
  it("is expressed as `not: BANNED`, so ACTIVE and SUSPENDED both still match", async () => {
    // Asserted as the shape rather than as behaviour because the predicate is
    // evaluated by Postgres: `status = ACTIVE` would silently have hidden every
    // suspended account, and nothing in this service ever lifts a suspension.
    await userProfileRepository.findUsersNotInList(
      [],
      undefined,
      0,
      10,
      VIEWER
    );

    expect(whereOf(findMany).status).toEqual({ not: "BANNED" });
  });
});
