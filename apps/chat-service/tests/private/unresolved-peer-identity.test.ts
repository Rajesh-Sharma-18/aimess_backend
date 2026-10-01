/**
 * "Unknown User" must mean "this user does not exist", never "I could not ask".
 *
 * The conversation list and the chat header are the SAME serializer
 * (`PrivateRoomService.enrichConversations`) called at two different moments.
 * When the identity lookup behind it failed, it used to fall through to the
 * shared `resolveDisplayName` placeholder and ship the literal "Unknown User"
 * on a row whose peer is perfectly real — a terminal value the client caches
 * with nothing to make it ask again, which is why the row stayed wrong until a
 * hard reload while opening the same conversation showed the real name.
 *
 * A failed lookup now refuses with a retryable 503; a genuinely missing user
 * keeps rendering exactly as designed.
 */
import request from "supertest";

// The real `user-service-client` is exercised below (timeout classification);
// its auth client loads a proto via import.meta, which CJS Jest cannot parse.
jest.mock("../../src/grpc/auth.client.js", () => ({
  authGrpcClient: { bulkGetAccounts: jest.fn(async () => []) },
}));

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import {
  fetchAccountsBatch,
  fetchUsersBatch,
} from "../../src/lib/user-service-client.js";
import {
  UserSnapshotService,
  isUnresolvedSnapshot,
  resolveDisplayName,
} from "../../src/services/user-snapshot.service.js";

const usersBatch = fetchUsersBatch as jest.Mock;
const accountsBatch = fetchAccountsBatch as jest.Mock;

let app: import("express").Express;
let mocks: BuiltMocks;

const PEER_1 = "22222222-2222-4222-8222-222222222222";
const PEER_2 = "33333333-3333-4333-8333-333333333333";
const GHOST = "44444444-4444-4444-8444-444444444444";

const ONE_ROOM = [
  {
    roomId: "prv_1",
    participants: [TEST_USER_ID, PEER_1],
    lastMessageAt: new Date(1000),
    lastMessage: null,
    unreadCountByUser: { [TEST_USER_ID]: 0 },
    mutedBy: {},
    pinnedCount: 0,
  },
];

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.privateRoomRepo.getInboxConversations.mockResolvedValue(ONE_ROOM);
  mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
  mocks.groupMemberRepo.getInboxMemberships.mockResolvedValue([]);
  mocks.groupRoomRepo.getInboxGroups.mockResolvedValue([]);
  mocks.groupRoomRepo.countUserGroups.mockResolvedValue(0);
});

/** Both lookups answered; neither holds the id. A genuinely missing user. */
const bothAnswerEmpty = () => {
  usersBatch.mockResolvedValue([]);
  accountsBatch.mockResolvedValue([]);
};

/** Transport failure / open circuit breaker on BOTH identity sources. */
const bothFail = () => {
  usersBatch.mockResolvedValue(null);
  accountsBatch.mockResolvedValue(null);
};

describe("UserSnapshotService — failed lookup vs missing user", () => {
  const cacheRepo = {
    getUserSnapshots: jest.fn(),
    setUserSnapshot: jest.fn(async () => undefined),
  };

  beforeEach(() => {
    cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
    cacheRepo.setUserSnapshot.mockResolvedValue(undefined);
  });

  it("flags the snapshot as unresolved when the user lookup FAILED", async () => {
    usersBatch.mockResolvedValue(null);
    accountsBatch.mockResolvedValue([]);

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      [PEER_1],
      cacheRepo as never
    );

    expect(isUnresolvedSnapshot(map.get(PEER_1))).toBe(true);
  });

  it("flags nothing when both lookups ANSWERED and the user simply is not there", async () => {
    bothAnswerEmpty();

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      [GHOST],
      cacheRepo as never
    );

    expect(isUnresolvedSnapshot(map.get(GHOST))).toBe(false);
    // The intended deleted/missing-user rendering is untouched.
    expect(resolveDisplayName(map.get(GHOST))).toBe("Unknown User");
  });

  it("does not flag a user the auth-service fallback resolved", async () => {
    usersBatch.mockResolvedValue([]);
    accountsBatch.mockResolvedValue([
      { userId: PEER_1, account: "neelsheth" },
    ]);

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      [PEER_1],
      cacheRepo as never
    );

    expect(isUnresolvedSnapshot(map.get(PEER_1))).toBe(false);
    expect(resolveDisplayName(map.get(PEER_1))).toBe("neelsheth");
  });

  it("a snapshot-cache failure is a MISS: user-service still resolves every peer", async () => {
    cacheRepo.getUserSnapshots.mockRejectedValue(new Error("redis down"));
    usersBatch.mockResolvedValue([
      { userId: PEER_1, displayName: "Neel Sheth", username: "neel", avatar: "", isOnline: false, isDeleted: false },
      { userId: PEER_2, displayName: "Asha Rao", username: "asha", avatar: "", isOnline: false, isDeleted: false },
    ]);
    accountsBatch.mockResolvedValue([]);

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      [PEER_1, PEER_2],
      cacheRepo as never
    );

    expect(usersBatch).toHaveBeenLastCalledWith([PEER_1, PEER_2]);
    expect(isUnresolvedSnapshot(map.get(PEER_1))).toBe(false);
    expect(resolveDisplayName(map.get(PEER_1))).toBe("Neel Sheth");
    expect(resolveDisplayName(map.get(PEER_2))).toBe("Asha Rao");
  });

  it("flags every id when the cache AND both identity sources fail", async () => {
    cacheRepo.getUserSnapshots.mockRejectedValue(new Error("redis down"));
    bothFail();

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      [PEER_1, PEER_2],
      cacheRepo as never
    );

    expect(isUnresolvedSnapshot(map.get(PEER_1))).toBe(true);
    expect(isUnresolvedSnapshot(map.get(PEER_2))).toBe(true);
  });

  it("partial cache hit: only the misses go upstream, and both halves resolve", async () => {
    cacheRepo.getUserSnapshots.mockResolvedValue(
      new Map([[PEER_1, { userId: PEER_1, displayName: "Neel Sheth", avatar: "", memberId: "neel", isDeletedUser: false, isOnline: false }]])
    );
    usersBatch.mockResolvedValue([
      { userId: PEER_2, displayName: "Asha Rao", username: "asha", avatar: "", isOnline: false, isDeleted: false },
    ]);
    accountsBatch.mockResolvedValue([]);

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      [PEER_1, PEER_2],
      cacheRepo as never
    );

    expect(usersBatch).toHaveBeenLastCalledWith([PEER_2]);
    expect(resolveDisplayName(map.get(PEER_1))).toBe("Neel Sheth");
    expect(resolveDisplayName(map.get(PEER_2))).toBe("Asha Rao");
  });

  it("partial batch: one id neither source holds is MISSING, not an outage — the rest resolve", async () => {
    usersBatch.mockResolvedValue([
      { userId: PEER_1, displayName: "Neel Sheth", username: "neel", avatar: "", isOnline: false, isDeleted: false },
    ]);
    accountsBatch.mockResolvedValue([]);

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      [PEER_1, GHOST],
      cacheRepo as never
    );

    expect(resolveDisplayName(map.get(PEER_1))).toBe("Neel Sheth");
    expect(isUnresolvedSnapshot(map.get(GHOST))).toBe(false);
  });

  it("NEVER caches an unresolved placeholder — an outage must not outlive itself", async () => {
    bothFail();

    await new UserSnapshotService().getUserSnapshotsMap(
      [PEER_1],
      cacheRepo as never
    );

    expect(cacheRepo.setUserSnapshot).not.toHaveBeenCalled();
  });
});

describe("conversation list — a failed identity lookup refuses instead of naming the peer", () => {
  it("503 CHAT_IDENTITY_UNAVAILABLE rather than a cacheable 'Unknown User' row", async () => {
    bothFail();

    const res = await request(app)
      .get("/api/chat/private/conversations")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain("CHAT_IDENTITY_UNAVAILABLE");
  });

  it("the unified inbox refuses on the same condition", async () => {
    bothFail();

    const res = await request(app)
      .get("/api/chat/inbox")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(503);
  });

  it("REGRESSION: a genuinely missing user still lists as 'Unknown User'", async () => {
    bothAnswerEmpty();

    const res = await request(app)
      .get("/api/chat/private/conversations")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].displayName).toBe("Unknown User");
  });

  it("REGRESSION: a resolvable peer lists under its real name", async () => {
    usersBatch.mockResolvedValue([
      {
        userId: PEER_1,
        displayName: "Neel Sheth",
        username: "neel",
        avatar: "",
        isOnline: false,
        isDeleted: false,
      },
      {
        userId: TEST_USER_ID,
        displayName: "Me",
        username: "me",
        avatar: "",
        isOnline: false,
        isDeleted: false,
      },
    ]);
    accountsBatch.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/chat/private/conversations")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.data[0].displayName).toBe("Neel Sheth");
  });
});

/**
 * The reported ai5dev outage: an inbox page holding ONE private room whose
 * stored peer is not a user id at all — "undefined" or a `grp_` room id, both
 * written by `POST /rooms/:peerId` before participants were validated.
 *
 * Both identity columns upstream are Postgres `uuid`, so sending that id in the
 * batch failed the WHOLE lookup with INTERNAL. Every peer on the page then came
 * back unresolved and the inbox answered 503 CHAT_IDENTITY_UNAVAILABLE on every
 * request, forever — a permanent data condition reported as a retryable outage.
 */
describe("malformed stored peer id — a permanent gap, not an outage", () => {
  const cacheRepo = {
    getUserSnapshots: jest.fn(),
    setUserSnapshot: jest.fn(async () => undefined),
  };
  const realPeer = {
    userId: PEER_1,
    displayName: "Neel Sheth",
    username: "neel",
    avatar: "",
    isOnline: false,
    isDeleted: false,
  };

  /**
   * What both real upstreams do: `IN (…)` over a uuid column fails the whole
   * batch (gRPC INTERNAL → client `null`) if ANY id is not a uuid.
   */
  const asPostgres = () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    usersBatch.mockImplementation(async (ids: string[]) =>
      ids.every((id) => uuid.test(id)) ? [realPeer] : null
    );
  };

  beforeEach(() => {
    cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  });

  it("never sends a non-UUID id upstream, and never flags it unresolved", async () => {
    usersBatch.mockResolvedValue([realPeer]);
    accountsBatch.mockResolvedValue([]);

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      [PEER_1, "undefined", "grp_PWSESsGxqhS3kUDh"],
      cacheRepo as never
    );

    expect(usersBatch).toHaveBeenLastCalledWith([PEER_1]);
    expect(resolveDisplayName(map.get(PEER_1))).toBe("Neel Sheth");
    for (const bad of ["undefined", "grp_PWSESsGxqhS3kUDh"]) {
      expect(isUnresolvedSnapshot(map.get(bad))).toBe(false);
      expect(resolveDisplayName(map.get(bad))).toBe("Unknown User");
    }
  });

  it("a REAL outage still flags the real peers — and only them", async () => {
    bothFail();

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      [PEER_1, "undefined"],
      cacheRepo as never
    );

    expect(isUnresolvedSnapshot(map.get(PEER_1))).toBe(true);
    expect(isUnresolvedSnapshot(map.get("undefined"))).toBe(false);
  });

  it("cache + upstream failure flags only ids that could be users", async () => {
    cacheRepo.getUserSnapshots.mockRejectedValue(new Error("redis down"));
    bothFail();

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      [PEER_1, "undefined"],
      cacheRepo as never
    );

    expect(isUnresolvedSnapshot(map.get(PEER_1))).toBe(true);
    expect(isUnresolvedSnapshot(map.get("undefined"))).toBe(false);
  });

  const MALFORMED_ROOM = {
    roomId: "prv_OrqmmJAT8sHO8Ds5",
    participants: [TEST_USER_ID, "undefined"],
    lastMessageAt: new Date(900),
    lastMessage: null,
    unreadCountByUser: { [TEST_USER_ID]: 0 },
    mutedBy: {},
    pinnedCount: 0,
  };

  it("REGRESSION: the inbox loads (200) with the real peer named and the malformed row as a missing user", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      ...ONE_ROOM,
      MALFORMED_ROOM,
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(2);
    asPostgres();
    accountsBatch.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/chat/private/conversations")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const byRoom = Object.fromEntries(
      res.body.data.data.map((r: { roomId: string; displayName: string }) => [
        r.roomId,
        r.displayName,
      ])
    );
    expect(byRoom.prv_1).toBe("Neel Sheth");
    expect(byRoom.prv_OrqmmJAT8sHO8Ds5).toBe("Unknown User");
    for (const [ids] of usersBatch.mock.calls) {
      expect(ids).not.toContain("undefined");
    }
  });

  it("the unified inbox answers 200 for the same page", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      ...ONE_ROOM,
      MALFORMED_ROOM,
    ]);
    asPostgres();
    accountsBatch.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/chat/inbox")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
  });

  it("a genuine user-service outage on that page is still a retryable 503", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      ...ONE_ROOM,
      MALFORMED_ROOM,
    ]);
    bothFail();

    const res = await request(app)
      .get("/api/chat/inbox")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: "CHAT_IDENTITY_UNAVAILABLE",
      retryable: true,
    });
  });
});

describe("user-service-client — a timeout is a FAILED lookup, never 'not found'", () => {
  const actual = jest.requireActual(
    "../../src/lib/user-service-client.js"
  ) as typeof import("../../src/lib/user-service-client.js");
  const { userGrpcClient } = jest.requireMock(
    "../../src/grpc/user-snapshot.client.js"
  ) as { userGrpcClient: { bulkGetUserSnapshots: jest.Mock } };

  it("returns null (lookup failed) when the call times out", async () => {
    userGrpcClient.bulkGetUserSnapshots.mockRejectedValueOnce(
      Object.assign(new Error("Timed out after 2000ms"), { code: "ETIMEDOUT" })
    );

    await expect(actual.fetchUsersBatch([PEER_1])).resolves.toBeNull();
  });

  it("returns [] (answered, nobody there) when the service holds none of the ids", async () => {
    userGrpcClient.bulkGetUserSnapshots.mockResolvedValueOnce([]);

    await expect(actual.fetchUsersBatch([PEER_1])).resolves.toEqual([]);
  });

  // gRPC status → classification. NOT_FOUND is an answer (permanent, never
  // retryable); every transport/infra status is a failed lookup (retryable 503).
  it.each([
    [5, "NOT_FOUND", []],
    [14, "UNAVAILABLE", null],
    [4, "DEADLINE_EXCEEDED", null],
    [16, "UNAUTHENTICATED", null],
    [7, "PERMISSION_DENIED", null],
    [13, "INTERNAL", null],
  ])("gRPC %i %s → %p", async (code, name, expected) => {
    userGrpcClient.bulkGetUserSnapshots.mockRejectedValueOnce(
      Object.assign(new Error(`${code} ${name}: x`), { code })
    );

    await expect(actual.fetchUsersBatch([PEER_1])).resolves.toEqual(expected);
  });

  it("auth-service NOT_FOUND is an answer too, not an outage", async () => {
    const { authGrpcClient } = jest.requireMock(
      "../../src/grpc/auth.client.js"
    ) as { authGrpcClient: { bulkGetAccounts: jest.Mock } };
    authGrpcClient.bulkGetAccounts.mockRejectedValueOnce(
      Object.assign(new Error("5 NOT_FOUND"), { code: 5 })
    );

    await expect(actual.fetchAccountsBatch([PEER_1])).resolves.toEqual([]);
  });
});

/**
 * Valid historical identities on one inbox page: a live peer, a system-banned
 * peer (user-service returns the row, name intact) and a deleted peer
 * (user-service returns the anonymized row). None of them is an outage, and
 * none of them may degrade the live peer to "Unknown User".
 */
describe("inbox — mixed live / banned / deleted / missing peers load together", () => {
  const BANNED = "55555555-5555-4555-8555-555555555555";
  const DELETED = "66666666-6666-4666-8666-666666666666";
  const room = (roomId: string, peer: string, at: number) => ({
    roomId,
    participants: [TEST_USER_ID, peer],
    lastMessageAt: new Date(at),
    lastMessage: null,
    unreadCountByUser: { [TEST_USER_ID]: 0 },
    mutedBy: {},
    pinnedCount: 0,
  });

  it("200, every row present, each peer rendered by product rule", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([
      room("prv_live", PEER_1, 4000),
      room("prv_banned", BANNED, 3000),
      room("prv_deleted", DELETED, 2000),
      room("prv_ghost", GHOST, 1000),
    ]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(4);
    usersBatch.mockResolvedValue([
      { userId: PEER_1, displayName: "Neel Sheth", username: "neel", avatar: "", isOnline: false, isDeleted: false },
      // A ban does not anonymize — history keeps the real name.
      { userId: BANNED, displayName: "Banned Person", username: "banned", avatar: "", isOnline: false, isDeleted: false },
      { userId: DELETED, displayName: "Deleted Account", username: "", avatar: "", isOnline: false, isDeleted: true },
    ]);
    accountsBatch.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/chat/private/conversations")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const byRoom = Object.fromEntries(
      res.body.data.data.map((r: { roomId: string; displayName: string }) => [
        r.roomId,
        r.displayName,
      ])
    );
    expect(byRoom).toEqual({
      prv_live: "Neel Sheth",
      prv_banned: "Banned Person",
      prv_deleted: "Deleted Account",
      prv_ghost: "Unknown User",
    });

    const inbox = await request(app)
      .get("/api/chat/inbox")
      .set(bearer(makeAccessToken()));
    expect(inbox.status).toBe(200);
  });

  it("a gRPC NOT_FOUND from the identity source does not 503 the inbox", async () => {
    usersBatch.mockResolvedValue([]); // what fetchUsersBatch now returns on NOT_FOUND
    accountsBatch.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/chat/inbox")
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
  });
});
