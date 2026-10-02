/**
 * `checkFriendships` gRPC body — malformed candidate ids.
 *
 * requesterId/addresseeId are Postgres `uuid` columns. chat-service sent ids
 * read off corrupt private rooms — a `grp_` room id, a community ObjectId — and
 * ONE of them failed the whole `IN (…)` with "invalid input syntax for type
 * uuid": every valid candidate lost its relationship (the inbox then rendered
 * real friends as NONE) and the caller's breaker counted an outage. The
 * repository mocks below fail exactly like Postgres does on such an id.
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuids(ids: string[]) {
  const bad = ids.find((id) => !UUID.test(id));
  if (bad) throw new Error(`invalid input syntax for type uuid: "${bad}"`);
}

type Row = {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: string;
};
let rows: Row[] = [];

const findAcceptedFriendIdsForUser = jest.fn(
  async (callerId: string, ids: string[]) => {
    assertUuids([callerId, ...ids]);
    return rows
      .filter((r) => r.status === "ACCEPTED")
      .map((r) => (r.requesterId === callerId ? r.addresseeId : r.requesterId))
      .filter((id) => ids.includes(id));
  }
);
const findRelationshipsForUser = jest.fn(
  async (callerId: string, ids: string[]) => {
    assertUuids([callerId, ...ids]);
    return {
      rows: rows.filter(
        (r) =>
          (r.requesterId === callerId && ids.includes(r.addresseeId)) ||
          (r.addresseeId === callerId && ids.includes(r.requesterId))
      ),
      blockedIds: new Set<string>(),
      blockedByIds: new Set<string>(),
    };
  }
);
const findFriendRequestScopes = jest.fn(async (ids: string[]) => {
  assertUuids(ids);
  return new Map<string, string>();
});

jest.mock("../../src/repositories/friendship.repository.js", () => ({
  friendshipRepository: {
    findAcceptedFriendIdsForUser: (c: string, i: string[]) =>
      findAcceptedFriendIdsForUser(c, i),
    findRelationshipsForUser: (c: string, i: string[]) =>
      findRelationshipsForUser(c, i),
    resolveViewerGraph: async () => ({ friendIds: [], friendOfFriendIds: [] }),
  },
}));
jest.mock("../../src/repositories/user-settings.repository.js", () => ({
  userSettingsRepository: {
    findFriendRequestScopes: (i: string[]) => findFriendRequestScopes(i),
  },
}));

import { resolveFriendshipRelationships } from "../../src/grpc/check-friendships.js";

const KHILAN = "5b5e8d2f-b77b-4e44-bd8b-bf263595a22b";
const NEEL = "d3f98fba-a6a8-4b1e-a8c7-ab75e494b6a8";
const OTHER = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "grp_pdIiPX3BpLo5WUA5";
const COMMUNITY_ID = "6a7bf9214d6c5b8b86a11aa8";

const statusOf = (
  r: Awaited<ReturnType<typeof resolveFriendshipRelationships>>,
  id: string
) => r.relationships.find((x) => x.userId === id)?.status;

beforeEach(() => {
  rows = [
    {
      id: "86aabd9c-5e64-4ba6-84fa-83f40d27d448",
      requesterId: NEEL,
      addresseeId: KHILAN,
      status: "ACCEPTED",
    },
  ];
  jest.clearAllMocks();
});

describe("resolveFriendshipRelationships (checkFriendships RPC)", () => {
  it("valid UUIDs: normal results", async () => {
    const r = await resolveFriendshipRelationships(KHILAN, [NEEL, OTHER]);
    expect(statusOf(r, NEEL)).toBe("FRIEND");
    expect(statusOf(r, OTHER)).toBe("NONE");
    expect(r.friendIds).toEqual([NEEL]);
  });

  it.each([
    ["a group room id", GROUP_ID],
    ["a community ObjectId", COMMUNITY_ID],
  ])("valid UUID + %s: the valid one is still processed", async (_l, bad) => {
    const r = await resolveFriendshipRelationships(KHILAN, [NEEL, bad]);

    expect(statusOf(r, NEEL)).toBe("FRIEND");
    // No fabricated entry for the malformed id.
    expect(r.relationships.map((x) => x.userId)).toEqual([NEEL]);
    expect(findRelationshipsForUser).toHaveBeenCalledWith(KHILAN, [NEEL]);
  });

  it("all invalid: empty answer, no query at all", async () => {
    const r = await resolveFriendshipRelationships(KHILAN, [
      GROUP_ID,
      COMMUNITY_ID,
    ]);
    expect(r).toEqual({ friendIds: [], relationships: [] });
    expect(findRelationshipsForUser).not.toHaveBeenCalled();
    expect(findAcceptedFriendIdsForUser).not.toHaveBeenCalled();
  });

  it("duplicate valid UUIDs: one entry each", async () => {
    const r = await resolveFriendshipRelationships(KHILAN, [NEEL, NEEL, NEEL]);
    expect(r.relationships).toHaveLength(1);
    expect(findRelationshipsForUser).toHaveBeenCalledWith(KHILAN, [NEEL]);
  });

  it.each([
    ["missing candidateIds", KHILAN, undefined],
    ["empty strings", KHILAN, ["", ""]],
    ["missing callerId", undefined, [NEEL]],
    ["a malformed callerId", GROUP_ID, [NEEL]],
  ])("%s: controlled empty answer, never a uuid error", async (_l, c, ids) => {
    await expect(
      resolveFriendshipRelationships(c as string | undefined, ids)
    ).resolves.toEqual({ friendIds: [], relationships: [] });
  });

  it("ACCEPTED is FRIEND from both sides (requester and addressee)", async () => {
    const asAddressee = await resolveFriendshipRelationships(KHILAN, [NEEL]);
    const asRequester = await resolveFriendshipRelationships(NEEL, [KHILAN]);

    expect(statusOf(asAddressee, NEEL)).toBe("FRIEND");
    expect(statusOf(asRequester, KHILAN)).toBe("FRIEND");
  });

  it("PENDING: the requester id rides only on pending rows, direction per side", async () => {
    rows = [
      { id: "p1", requesterId: OTHER, addresseeId: KHILAN, status: "PENDING" },
    ];
    const incoming = await resolveFriendshipRelationships(KHILAN, [OTHER]);
    const outgoing = await resolveFriendshipRelationships(OTHER, [KHILAN]);

    expect(incoming.relationships[0]).toMatchObject({
      status: "PENDING",
      direction: "INCOMING",
      requesterId: OTHER,
      canAccept: true,
      canReject: true,
      canCancel: false,
    });
    expect(outgoing.relationships[0]).toMatchObject({
      status: "PENDING",
      direction: "OUTGOING",
      canCancel: true,
      canAccept: false,
    });
  });
});
