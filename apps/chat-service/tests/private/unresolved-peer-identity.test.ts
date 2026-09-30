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

const ONE_ROOM = [
  {
    roomId: "prv_1",
    participants: [TEST_USER_ID, "peer-1"],
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
      ["peer-1"],
      cacheRepo as never
    );

    expect(isUnresolvedSnapshot(map.get("peer-1"))).toBe(true);
  });

  it("flags nothing when both lookups ANSWERED and the user simply is not there", async () => {
    bothAnswerEmpty();

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      ["ghost"],
      cacheRepo as never
    );

    expect(isUnresolvedSnapshot(map.get("ghost"))).toBe(false);
    // The intended deleted/missing-user rendering is untouched.
    expect(resolveDisplayName(map.get("ghost"))).toBe("Unknown User");
  });

  it("does not flag a user the auth-service fallback resolved", async () => {
    usersBatch.mockResolvedValue([]);
    accountsBatch.mockResolvedValue([
      { userId: "peer-1", account: "neelsheth" },
    ]);

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      ["peer-1"],
      cacheRepo as never
    );

    expect(isUnresolvedSnapshot(map.get("peer-1"))).toBe(false);
    expect(resolveDisplayName(map.get("peer-1"))).toBe("neelsheth");
  });

  it("flags every id when the snapshot cache read itself fails", async () => {
    cacheRepo.getUserSnapshots.mockRejectedValue(new Error("redis down"));

    const map = await new UserSnapshotService().getUserSnapshotsMap(
      ["peer-1", "peer-2"],
      cacheRepo as never
    );

    expect(isUnresolvedSnapshot(map.get("peer-1"))).toBe(true);
    expect(isUnresolvedSnapshot(map.get("peer-2"))).toBe(true);
  });

  it("NEVER caches an unresolved placeholder — an outage must not outlive itself", async () => {
    bothFail();

    await new UserSnapshotService().getUserSnapshotsMap(
      ["peer-1"],
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
        userId: "peer-1",
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
